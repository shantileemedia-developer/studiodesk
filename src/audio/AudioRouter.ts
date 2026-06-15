/**
 * AudioRouter — client-side audio bus manager (renderer singleton).
 *
 * The DAW engine (main process) exposes named audio buses:
 *   'mic-input'    — raw microphone capture, interleaved Float32 stereo
 *   'playback-mix' — rendered mix of all timeline tracks
 *   'master-output'— alias for playback-mix (master gain is in Web Audio)
 *
 * Any part of the application (WebRTC, monitor panels, meters) calls:
 *   const stream = AudioRouter.getInstance().getStream('mic-input');
 *   // later:
 *   AudioRouter.getInstance().releaseStream('mic-input');
 *
 * The router holds a single IPC listener for all buses and dispatches
 * chunks to the appropriate AudioContext → MediaStreamDestination.
 * Reference counting ensures the IPC subscription and AudioContext are
 * torn down as soon as the last consumer releases a bus.
 */

export type AudioBusId = 'mic-input' | 'playback-mix' | 'master-output';

const SR             = 48_000;
const INIT_LATENCY_S = 0.06;   // 60 ms startup buffer
const JITTER_PAD_S   = 0.02;   // schedule reset when behind real-time

interface BusState {
  ctx:      AudioContext;
  dest:     MediaStreamAudioDestinationNode;
  nextTime: number;
  refCount: number;
}

export class AudioRouter {
  private static _inst: AudioRouter | null = null;

  static getInstance(): AudioRouter {
    if (!AudioRouter._inst) AudioRouter._inst = new AudioRouter();
    return AudioRouter._inst;
  }

  private buses          = new Map<string, BusState>();
  private offGlobalChunk: (() => void) | null = null;

  // ── Global IPC chunk listener ─────────────────────────────────────────────
  // One listener covers all buses — dispatches by busId.

  private _startListener() {
    if (this.offGlobalChunk || !window.audioEngine) return;
    this.offGlobalChunk = window.audioEngine.onBusChunk((busId, data) => {
      // 'master-output' is aliased to 'playback-mix' bus state
      const key = busId === 'master-output' ? 'playback-mix' : busId;
      const bus = this.buses.get(key);
      if (!bus || bus.ctx.state === 'closed') return;

      const f32       = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
      const numFrames = f32.length / 2; // interleaved stereo

      const audioBuf = bus.ctx.createBuffer(2, numFrames, SR);
      const L = audioBuf.getChannelData(0);
      const R = audioBuf.getChannelData(1);
      for (let i = 0; i < numFrames; i++) { L[i] = f32[i * 2]; R[i] = f32[i * 2 + 1]; }

      const src = bus.ctx.createBufferSource();
      src.buffer = audioBuf;
      src.connect(bus.dest);

      const now = bus.ctx.currentTime;
      if (bus.nextTime < now) bus.nextTime = now + JITTER_PAD_S;
      src.start(bus.nextTime);
      bus.nextTime += numFrames / SR;
    });
  }

  private _stopListener() {
    this.offGlobalChunk?.();
    this.offGlobalChunk = null;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Returns a MediaStream that carries audio from the named DAW bus.
   * Each call increments a reference count; call releaseStream() when done.
   * Returns null when the native engine is not available (browser / fallback).
   */
  getStream(busId: AudioBusId): MediaStream | null {
    if (!window.audioEngine) return null;

    // master-output shares state with playback-mix
    const key = busId === 'master-output' ? 'playback-mix' : busId;

    let bus = this.buses.get(key);
    if (!bus) {
      const ctx  = new AudioContext({ sampleRate: SR, latencyHint: 'interactive' });
      const dest = ctx.createMediaStreamDestination();
      bus = { ctx, dest, nextTime: ctx.currentTime + INIT_LATENCY_S, refCount: 0 };
      this.buses.set(key, bus);

      // Start the global listener on first bus creation
      this._startListener();
      // Tell the DAW engine to start emitting this bus
      window.audioEngine.subscribeBus(busId).catch(() => {});
    }

    bus.refCount++;
    return bus.dest.stream;
  }

  /**
   * Release a previously acquired stream.  When reference count drops to zero
   * the bus subscription is cancelled and the AudioContext closed.
   */
  releaseStream(busId: AudioBusId) {
    const key = busId === 'master-output' ? 'playback-mix' : busId;
    const bus = this.buses.get(key);
    if (!bus) return;

    bus.refCount--;
    if (bus.refCount > 0) return;

    this.buses.delete(key);
    bus.ctx.close().catch(() => {});
    window.audioEngine?.unsubscribeBus(busId).catch(() => {});

    if (this.buses.size === 0) this._stopListener();
  }

  /** Tear down all buses — called on app unload. */
  dispose() {
    this._stopListener();
    for (const [, bus] of this.buses) bus.ctx.close().catch(() => {});
    this.buses.clear();
  }
}
