/**
 * NativeAudioEngine — runs in the Electron main process.
 * Uses PortAudio (via naudiodon) for ASIO, WASAPI, and CoreAudio support.
 *
 * Requirements to compile naudiodon:
 *   Windows: Visual Studio Build Tools 2022 (C++ workload) + Python 3
 *   macOS:   Xcode Command Line Tools
 *   Linux:   build-essential + libasound2-dev
 * Then run: npx electron-rebuild -f -w naudiodon
 *
 * When naudiodon is not compiled the engine emits 'unavailable' and the renderer
 * falls back to Web Audio API automatically.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

// ── naudiodon lazy-load ───────────────────────────────────────────────────────
// Wrapped so the app loads even when the .node file hasn't been compiled yet.

let naudiodon: any = null;
try {
  naudiodon = require('naudiodon');
} catch {
  console.warn('[AudioEngine] naudiodon not compiled — falling back to Web Audio API in renderer');
}

export const nativeAudioAvailable = !!naudiodon;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AudioDevice {
  id:                 number;
  name:               string;
  maxInputChannels:   number;
  maxOutputChannels:  number;
  defaultSampleRate:  number;
  isDefaultInput:     boolean;
  isDefaultOutput:    boolean;
  hostApi:            string; // 'ASIO' | 'WASAPI' | 'MME' | 'CoreAudio' | 'ALSA' | ...
}

export interface TrackSpec {
  trackId:     string;
  filePath:    string;   // absolute OS path to a WAV file on disk
  startTime:   number;   // seconds from timeline zero
  audioOffset: number;   // seconds into the source file to start reading
  duration:    number;   // seconds to play from this clip
  volume:      number;   // 0–2  (1 = unity)
  pan:         number;   // −1 (L) → +1 (R)
  muted:       boolean;
  fadeIn?:     number;   // seconds
  fadeOut?:    number;   // seconds
}

interface TrackRuntime {
  spec:          TrackSpec;
  left:          Float32Array;  // decoded source audio — left  channel
  right:         Float32Array;  // decoded source audio — right channel (copy of left if mono)
  fileSr:        number;        // native sample rate of the WAV file
  startSample:   number;        // engine timeline sample when clip starts
  endSample:     number;        // engine timeline sample when clip ends
  offsetSamples: number;        // how many source samples to skip at read start
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ENGINE_SR       = 48_000;
const NUM_CHANNELS    = 2;
const BUFFER_SAMPLES  = 512;        // ~10.7 ms per write at 48 kHz
const FILL_INTERVAL   = Math.max(4, Math.floor((BUFFER_SAMPLES / ENGINE_SR) * 1000 * 0.6));
const BYTES_PER_FLOAT = 4;

// ── WAV decoder (handles 8/16/24/32-bit PCM and 32/64-bit float) ─────────────

function decodeWav(buf: Buffer): { left: Float32Array; right: Float32Array; sampleRate: number } | null {
  try {
    if (buf.toString('ascii', 0, 4) !== 'RIFF') return null;
    if (buf.toString('ascii', 8, 12) !== 'WAVE') return null;

    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let pos = 12;
    let audioFormat   = 1;
    let numChannels   = 1;
    let sampleRate    = 44100;
    let bitsPerSample = 16;
    let dataPos       = -1;
    let dataSize      = 0;

    while (pos + 8 <= buf.byteLength) {
      const id        = buf.toString('ascii', pos, pos + 4);
      const chunkSize = dv.getUint32(pos + 4, true);
      pos += 8;
      if (id === 'fmt ') {
        audioFormat   = dv.getUint16(pos,      true);
        numChannels   = dv.getUint16(pos + 2,  true);
        sampleRate    = dv.getUint32(pos + 4,  true);
        bitsPerSample = dv.getUint16(pos + 14, true);
      } else if (id === 'data') {
        dataPos  = pos;
        dataSize = chunkSize;
        break;
      }
      pos += chunkSize + (chunkSize & 1); // word-align
    }

    if (dataPos < 0) return null;

    const bps    = bitsPerSample / 8;
    const frames = Math.floor(dataSize / (numChannels * bps));
    const left   = new Float32Array(frames);
    const right  = new Float32Array(frames);

    for (let i = 0; i < frames; i++) {
      for (let ch = 0; ch < Math.min(numChannels, 2); ch++) {
        const off = dataPos + (i * numChannels + ch) * bps;
        let s = 0;
        if (audioFormat === 3) {
          s = bps === 8 ? dv.getFloat64(off, true) : dv.getFloat32(off, true);
        } else if (bps === 3) {
          const b0 = buf[off], b1 = buf[off + 1], b2 = buf[off + 2];
          let v = b0 | (b1 << 8) | (b2 << 16);
          if (v & 0x800000) v |= ~0xFFFFFF;
          s = v / (v < 0 ? 0x800000 : 0x7FFFFF);
        } else if (bps === 2) {
          s = dv.getInt16(off, true) / 32768;
        } else if (bps === 4) {
          s = dv.getInt32(off, true) / 2147483648;
        } else if (bps === 1) {
          s = buf[off] / 128 - 1;
        }
        if (ch === 0) left[i]  = s;
        else          right[i] = s;
      }
      if (numChannels === 1) right[i] = left[i];
    }

    return { left, right, sampleRate };
  } catch {
    return null;
  }
}

// ── WAV header writer (24-bit PCM, sizes zero-filled for streaming) ───────────

function makeWavHeader(sampleRate: number, numCh: number): Buffer {
  const bps   = 3;
  const align = numCh * bps;
  const buf   = Buffer.alloc(44);
  buf.write('RIFF', 0);      buf.writeUInt32LE(0, 4);           // patched on stop
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);     buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);                                      // PCM
  buf.writeUInt16LE(numCh, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * align, 28);
  buf.writeUInt16LE(align, 32);
  buf.writeUInt16LE(24, 34);
  buf.write('data', 36);     buf.writeUInt32LE(0, 40);          // patched on stop
  return buf;
}

// ── Engine ────────────────────────────────────────────────────────────────────

export class NativeAudioEngine extends EventEmitter {
  // ── Streams
  private outStream:   any = null;
  private inStream:    any = null;
  private recWs:       fs.WriteStream | null = null;

  // ── State flags
  private playing   = false;
  private recording = false;
  private monitoring = false;

  // ── Playback state
  private playPosition  = 0;        // current sample in engine timeline
  private engineSr      = ENGINE_SR;
  private tracks:       TrackRuntime[] = [];
  private fillTimer:    NodeJS.Timeout | null = null;
  // Wall-clock anchor used to gate writes and prevent PortAudio ring-buffer overflow.
  // We track how many samples have been CONSUMED by the device (wall-clock * sr) and
  // refuse to write more than MAX_WRITE_AHEAD_MS milliseconds ahead of consumption.
  private _writeStartWall   = 0;   // Date.now() when the current play session started
  private _writeStartSample = 0;   // playPosition at that moment
  private static readonly MAX_WRITE_AHEAD_MS = 250; // keep ring buffer ≤ 250 ms

  // ── Live track parameters (updated without stopping playback)
  private liveParams = new Map<string, { volume: number; pan: number; muted: boolean }>();

  // ── Recording state
  private recFilePath   = '';
  private recPcmBytes   = 0;
  private recSr         = ENGINE_SR;
  private recNumCh      = NUM_CHANNELS;

  // ── Audit logging ─────────────────────────────────────────────────────────
  private _auditFillCount = 0;  // counts _fill() calls; log every ~500 ms
  private _auditStopRequestedAt = 0; // Date.now() when stopPlayback() is called

  // ── ASIO callback diagnostics ──────────────────────────────────────────────
  // Counters reset on each startPlayback(); per-second window resets each log.
  private _diagCbTotal         = 0;   // total _fill() invocations this session
  private _diagMissedTotal     = 0;   // total missed deadlines (gap > 2× FILL_INTERVAL)
  private _diagUnderrunTotal   = 0;   // total skipped writes (write-ahead gate triggered)
  private _diagOverflowTotal   = 0;   // total write() errors (ring buffer rejected write)
  private _diagLastFillStart   = 0;   // Date.now() at previous _fill() entry
  private _diagLastSecLog      = 0;   // Date.now() at last per-second log
  // Per-second window accumulators (reset each log line)
  private _diagSecCb           = 0;
  private _diagSecMissed       = 0;
  private _diagSecUnderruns    = 0;
  private _diagSecOverflows    = 0;
  private _diagSecMaxDurMs     = 0;   // longest _fill() wall-clock time this second
  private _diagSecMaxIntervalMs = 0;  // longest gap between consecutive _fill() calls
  private _diagLastAheadMs     = 0;   // ring-buffer-ahead estimate at last fill

  // ── Devices
  private outDeviceId   = -1;
  private inDeviceId    = -1;

  // ── Audio Bus system ───────────────────────────────────────────────────────
  // Named buses that any subscriber (DAW or comm engine) can consume.
  // Each bus carries interleaved Float32 stereo at ENGINE_SR.
  // 'mic-input'    — raw capture from the input device
  // 'playback-mix' — rendered mix of all timeline tracks
  // 'master-output' — alias for playback-mix (master gain is in the renderer)
  private _micBusSubs  = 0;
  private _playBusSubs = 0;
  // Dedicated input stream used ONLY when no recording/monitoring stream is open.
  // Avoids opening two exclusive ASIO streams on the same device.
  private _micBusStream: any = null;

  // ── Device enumeration ────────────────────────────────────────────────────

  getDevices(): AudioDevice[] {
    if (!naudiodon) return [];
    try {
      return (naudiodon.getDevices() as any[]).map(d => ({
        id:                d.id,
        name:              d.name,
        maxInputChannels:  d.maxInputChannels,
        maxOutputChannels: d.maxOutputChannels,
        defaultSampleRate: d.defaultSampleRate,
        isDefaultInput:    d.isDefaultInputDevice  ?? false,
        isDefaultOutput:   d.isDefaultOutputDevice ?? false,
        hostApi:           d.hostAPIName ?? '',
      }));
    } catch { return []; }
  }

  // ── Playback ──────────────────────────────────────────────────────────────

  async startPlayback(specs: TrackSpec[], startTimeSecs: number, outDeviceId = -1, sr = ENGINE_SR) {
    this.stopPlayback();
    if (!naudiodon) { this.emit('unavailable'); return; }

    this.engineSr    = sr;
    this.outDeviceId = outDeviceId;
    this.playPosition = Math.round(startTimeSecs * sr);

    // Decode all playable tracks in parallel
    const runtimes: TrackRuntime[] = [];
    await Promise.all(specs.map(async spec => {
      if (spec.muted || !spec.filePath) return;
      try {
        const raw     = await fs.promises.readFile(spec.filePath);
        const decoded = decodeWav(raw);
        if (!decoded) { console.warn(`[AudioEngine] Could not decode ${spec.filePath}`); return; }

        const { left, right, sampleRate: fileSr } = decoded;
        runtimes.push({
          spec,
          left, right, fileSr,
          startSample:   Math.round(spec.startTime   * sr),
          endSample:     Math.round((spec.startTime + spec.duration) * sr),
          offsetSamples: Math.round(spec.audioOffset * fileSr),
        });
      } catch (err) {
        console.warn(`[AudioEngine] Skipped ${spec.filePath}:`, err);
      }
    }));

    this.tracks  = runtimes;
    this.playing = true;

    // Anchor wall-clock so _fill() can rate-limit writes
    this._writeStartWall   = Date.now();
    this._writeStartSample = this.playPosition;

    // Reset diagnostics for new session
    this._diagCbTotal          = 0;
    this._diagMissedTotal      = 0;
    this._diagUnderrunTotal    = 0;
    this._diagOverflowTotal    = 0;
    this._diagLastFillStart    = 0;
    this._diagLastSecLog       = Date.now();
    this._diagSecCb            = 0;
    this._diagSecMissed        = 0;
    this._diagSecUnderruns     = 0;
    this._diagSecOverflows     = 0;
    this._diagSecMaxDurMs      = 0;
    this._diagSecMaxIntervalMs = 0;
    this._diagLastAheadMs      = 0;
    console.log(`[DIAG][ASIO] playback started — FILL_INTERVAL=${FILL_INTERVAL}ms BUFFER_SAMPLES=${BUFFER_SAMPLES} sr=${sr} MAX_WRITE_AHEAD_MS=${NativeAudioEngine.MAX_WRITE_AHEAD_MS}`);

    // Reuse an existing outStream opened by monitoring rather than creating a
    // second one — ASIO uses exclusive device access and rejects a second open.
    // If monitoring pipe is active, unpipe it while _fill() drives the output;
    // stopPlayback() will re-pipe when the fill loop stops.
    if (this.outStream) {
      if (this.monitoring && this.inStream) {
        this.inStream.unpipe(this.outStream);
      }
    } else {
      try {
        this.outStream = new naudiodon.AudioIO({
          outOptions: {
            channelCount: NUM_CHANNELS,
            sampleFormat: naudiodon.SampleFormatFloat32,
            sampleRate:   sr,
            deviceId:     outDeviceId,
            closeOnError: false,
          },
        });
        this.outStream.start();
      } catch (err) {
        this.playing = false;
        this.emit('error', `Output open failed: ${(err as Error).message}`);
        return;
      }
    }

    // Emit start position immediately so the renderer can anchor the cursor
    // before the first fill tick fires (~6 ms later).
    this.emit('position', startTimeSecs);
    this.fillTimer = setInterval(() => this._fill(), FILL_INTERVAL);
  }

  private _fill() {
    if (!this.playing || !this.outStream) return;

    // ── DIAG: record callback entry ──────────────────────────────────────────
    const _cbStart   = Date.now();
    const _interval  = this._diagLastFillStart > 0 ? _cbStart - this._diagLastFillStart : 0;
    this._diagLastFillStart = _cbStart;
    this._diagCbTotal++;
    this._diagSecCb++;
    if (_interval > FILL_INTERVAL * 2 && this._diagCbTotal > 1) {
      this._diagMissedTotal++;
      this._diagSecMissed++;
      console.warn(
        `[DIAG][ASIO] MISSED DEADLINE  cb#${this._diagCbTotal}  interval=${_interval}ms  expected≤${FILL_INTERVAL * 2}ms`,
      );
    }
    if (_interval > this._diagSecMaxIntervalMs) this._diagSecMaxIntervalMs = _interval;

    const n   = BUFFER_SAMPLES;
    const sr  = this.engineSr;
    const outL = new Float32Array(n);
    const outR = new Float32Array(n);

    // Per-track RMS accumulators for mixer meters
    const trackRmsL = new Map<string, number>();
    const trackRmsR = new Map<string, number>();

    for (const rt of this.tracks) {
      const live  = this.liveParams.get(rt.spec.trackId);
      if (live?.muted ?? rt.spec.muted) continue;

      const vol   = live?.volume ?? rt.spec.volume;
      const pan   = live?.pan    ?? rt.spec.pan;
      // Constant-power pan law
      const angle = ((pan + 1) / 2) * (Math.PI / 2);
      const panL  = Math.cos(angle);
      const panR  = Math.sin(angle);

      let tRmsL = 0, tRmsR = 0;

      for (let i = 0; i < n; i++) {
        const pos = this.playPosition + i;
        if (pos < rt.startSample || pos >= rt.endSample) continue;

        // Map engine-timeline sample → source-file sample (nearest-neighbour SRC)
        const srcSample = rt.offsetSamples + Math.round(
          (pos - rt.startSample) * (rt.fileSr / sr)
        );
        if (srcSample >= rt.left.length) continue;

        let l = rt.left[srcSample]  * vol;
        let r = rt.right[srcSample] * vol;

        // Fades
        if (rt.spec.fadeIn) {
          const fs = rt.spec.fadeIn * sr;
          const el = pos - rt.startSample;
          if (el < fs) { const f = el / fs; l *= f; r *= f; }
        }
        if (rt.spec.fadeOut) {
          const fs = rt.spec.fadeOut * sr;
          const rem = rt.endSample - pos;
          if (rem < fs) { const f = rem / fs; l *= f; r *= f; }
        }

        const lOut = l * panL;
        const rOut = r * panR;
        outL[i] += lOut;
        outR[i] += rOut;
        tRmsL   += lOut * lOut;
        tRmsR   += rOut * rOut;
      }

      trackRmsL.set(rt.spec.trackId, (trackRmsL.get(rt.spec.trackId) ?? 0) + tRmsL);
      trackRmsR.set(rt.spec.trackId, (trackRmsR.get(rt.spec.trackId) ?? 0) + tRmsR);
    }

    // Interleave stereo and soft-clip
    const out = new Float32Array(n * 2);
    let rmsL = 0, rmsR = 0;
    for (let i = 0; i < n; i++) {
      const l = Math.max(-1, Math.min(1, outL[i]));
      const r = Math.max(-1, Math.min(1, outR[i]));
      out[i * 2]     = l;
      out[i * 2 + 1] = r;
      rmsL += l * l;
      rmsR += r * r;
    }

    // Emit wall-clock position so the cursor tracks real-time 1:1,
    // independent of how far ahead playPosition has pre-rendered.
    const wallMs      = Date.now() - this._writeStartWall;
    const wallPosSecs = this._writeStartSample / sr + wallMs / 1000;
    this.emit('position', wallPosSecs);
    this.emit('levels', [Math.sqrt(rmsL / n), Math.sqrt(rmsR / n)]);

    // Per-track levels for mixer meters
    const trackLevels: Record<string, [number, number]> = {};
    for (const [id, l] of trackRmsL) {
      trackLevels[id] = [Math.sqrt(l / n), Math.sqrt((trackRmsR.get(id) ?? 0) / n)];
    }
    this.emit('trackLevels', trackLevels);

    // Auto-stop when all clips have finished — use wall-clock, not playPosition,
    // since playPosition only advances on writes (see gate below).
    if (this.tracks.length > 0) {
      const maxEndSecs = this.tracks.reduce((m, t) => Math.max(m, t.endSample / sr), 0);
      if (wallPosSecs >= maxEndSecs) {
        this.stopPlayback();
        this.emit('ended', wallPosSecs);
        return;
      }
    }

    // Write-ahead gate: only write if we haven't pre-filled more than MAX_WRITE_AHEAD_MS
    // beyond real-time device consumption. CRITICAL: playPosition only advances when a
    // write actually occurs. If it advanced unconditionally, writtenSamples would grow at
    // 512/6ms = 85k samples/sec while consumedSamples grows at sr=48k/sec, so aheadSamples
    // would permanently exceed the limit after ~300ms and no further writes would ever fire.
    const consumedSamples  = (wallMs / 1000) * sr;
    const writtenSamples   = this.playPosition - this._writeStartSample;
    const maxAheadSamples  = (NativeAudioEngine.MAX_WRITE_AHEAD_MS / 1000) * sr;
    const aheadSamples     = writtenSamples - consumedSamples;
    const aheadMs          = (aheadSamples / sr) * 1000;
    this._diagLastAheadMs  = aheadMs;

    if (aheadSamples <= maxAheadSamples) {
      try {
        this.outStream.write(Buffer.from(out.buffer));
        // Advance sample pointer ONLY on successful write so the gate stays calibrated.
        this.playPosition += n;
      } catch (err) {
        // write() threw — ring buffer full / stream error = overflow
        this._diagOverflowTotal++;
        this._diagSecOverflows++;
        console.error(
          `[DIAG][ASIO] WRITE ERROR (overflow?)  cb#${this._diagCbTotal}  ahead=${aheadMs.toFixed(1)}ms  err=${(err as Error).message}`,
        );
      }
    } else {
      // Gate throttling — ring buffer is full enough; don't write this tick.
      // playPosition is NOT advanced, so next tick re-renders the same window
      // and re-evaluates. consumedSamples will have grown by then, lowering aheadMs.
      this._diagUnderrunTotal++;
      this._diagSecUnderruns++;
    }

    // ── DIAG: record callback exit and emit per-second summary ───────────────
    const _cbEnd     = Date.now();
    const _cbDurMs   = _cbEnd - _cbStart;
    if (_cbDurMs > this._diagSecMaxDurMs) this._diagSecMaxDurMs = _cbDurMs;

    if (_cbEnd - this._diagLastSecLog >= 1000) {
      const expectedCbs = Math.round(1000 / FILL_INTERVAL);
      console.log(
        `[DIAG][ASIO][1s] ` +
        `cbs=${this._diagSecCb}/${expectedCbs} ` +
        `missed=${this._diagSecMissed} ` +
        `underruns=${this._diagSecUnderruns} ` +
        `overflows=${this._diagSecOverflows} ` +
        `max_fill=${this._diagSecMaxDurMs}ms ` +
        `max_gap=${this._diagSecMaxIntervalMs}ms ` +
        `ring_ahead=${aheadMs.toFixed(1)}ms ` +
        `| totals: cb=${this._diagCbTotal} missed=${this._diagMissedTotal} underrun=${this._diagUnderrunTotal} overflow=${this._diagOverflowTotal}`,
      );
      this._diagLastSecLog       = _cbEnd;
      this._diagSecCb            = 0;
      this._diagSecMissed        = 0;
      this._diagSecUnderruns     = 0;
      this._diagSecOverflows     = 0;
      this._diagSecMaxDurMs      = 0;
      this._diagSecMaxIntervalMs = 0;
    }

    // Emit interleaved F32 mix to playback-mix / master-output buses
    if (this._playBusSubs > 0) {
      this.emit('busChunk', 'playback-mix', Buffer.from(out.buffer));
    }
  }

  stopPlayback() {
    this._auditStopRequestedAt = Date.now();
    console.log(
      `[AUDIT][Engine][stopPlayback] ENTER ` +
      `samplePos=${this.playPosition} ` +
      `time=${(this.playPosition / this.engineSr).toFixed(4)}s ` +
      `playing=${this.playing} ` +
      `t=${this._auditStopRequestedAt}`,
    );

    // Stop the fill loop FIRST so no more position/level events race with our zeros.
    if (this.fillTimer) { clearInterval(this.fillTimer); this.fillTimer = null; }

    // Emit final wall-clock position before tearing down state.
    if (this.playing && this._writeStartWall > 0) {
      const wallMs   = Date.now() - this._writeStartWall;
      const finalPos = this._writeStartSample / this.engineSr + wallMs / 1000;
      this.emit('position', finalPos);
    }

    // Zero all meters so the UI doesn't stay lit after stop/pause.
    const zeroTracks: Record<string, [number, number]> = {};
    for (const rt of this.tracks) {
      zeroTracks[rt.spec.trackId] = [0, 0];
    }
    if (Object.keys(zeroTracks).length > 0) this.emit('trackLevels', zeroTracks);
    this.emit('levels', [0, 0]);
    this.emit('inputLevels', [0, 0]);

    this.playing = false;

    if (this.outStream && !this.monitoring) {
      try { this.outStream.quit(); } catch {}
      this.outStream = null;
    }
    // Re-pipe monitoring passthrough now that _fill() has stopped writing.
    // Skip when recording is active — startRecording already owns the pipe and
    // calling pipe() again here would create a double-pipe during overdub.
    if (this.monitoring && this.inStream && this.outStream && !this.recording) {
      this.inStream.pipe(this.outStream, { end: false });
    }
    this.liveParams.clear();
    console.log(
      `[AUDIT][Engine][stopPlayback] DONE ` +
      `elapsed=${Date.now() - this._auditStopRequestedAt}ms`,
    );
  }

  seek(timeSecs: number) {
    this.playPosition      = Math.max(0, Math.round(timeSecs * this.engineSr));
    this._writeStartWall   = Date.now();
    this._writeStartSample = this.playPosition;
    // Always emit position so the renderer cursor updates even when not playing.
    this.emit('position', Math.max(0, timeSecs));
  }

  setTrackParams(trackId: string, params: Partial<{ volume: number; pan: number; muted: boolean }>) {
    const cur = this.liveParams.get(trackId) ?? { volume: 1, pan: 0, muted: false };
    this.liveParams.set(trackId, { ...cur, ...params });
  }

  getCurrentPosition(): number {
    return this.playPosition / this.engineSr;
  }

  // ── Recording ─────────────────────────────────────────────────────────────

  async startRecording(
    filePath: string,
    inDeviceId  = -1,
    outDeviceId = -1,
    sr          = ENGINE_SR,
    numCh       = NUM_CHANNELS,
  ) {
    if (!naudiodon) { this.emit('unavailable'); return; }
    await this.stopRecording();

    // Close any input stream opened by standalone monitoring before we open
    // the recording stream. Without this, the monitoring inStream is silently
    // leaked and ASIO would reject the second open on the same device.
    if (this.inStream) {
      try { this.inStream.unpipe(); this.inStream.quit(); } catch {}
      this.inStream = null;
    }

    this.recFilePath = filePath;
    this.recPcmBytes = 0;
    this.recSr       = sr;
    this.recNumCh    = numCh;
    this.inDeviceId  = inDeviceId;
    this.recording   = true;

    // Ensure directory exists
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

    // Write placeholder WAV header (sizes patched on stop)
    this.recWs = fs.createWriteStream(filePath);
    this.recWs.write(makeWavHeader(sr, numCh));

    try {
      this.inStream = new naudiodon.AudioIO({
        inOptions: {
          channelCount: numCh,
          sampleFormat: naudiodon.SampleFormatFloat32,
          sampleRate:   sr,
          deviceId:     inDeviceId,
          closeOnError: false,
        },
      });

      this.inStream.on('data', (chunk: Buffer) => {
        if (!this.recording || !this.recWs) return;
        const frames   = chunk.byteLength / (BYTES_PER_FLOAT * numCh);
        const pcm24    = Buffer.alloc(frames * numCh * 3);
        const inView   = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        let off = 0;
        let rmsL = 0, rmsR = 0;

        for (let i = 0; i < frames; i++) {
          for (let ch = 0; ch < numCh; ch++) {
            const s = inView.getFloat32((i * numCh + ch) * BYTES_PER_FLOAT, true);
            const v = Math.round(Math.max(-1, Math.min(1, s)) * (s < 0 ? 0x800000 : 0x7FFFFF));
            pcm24[off]     =  v        & 0xFF;
            pcm24[off + 1] = (v >>  8) & 0xFF;
            pcm24[off + 2] = (v >> 16) & 0xFF;
            off += 3;
            if (ch === 0) rmsL += s * s;
            else          rmsR += s * s;
          }
        }

        this.recPcmBytes += pcm24.byteLength;
        this.recWs.write(pcm24);
        this.emit('inputLevels', [Math.sqrt(rmsL / frames), Math.sqrt(rmsR / frames)]);
        // Emit raw F32 chunk to the mic-input bus (any subscriber gets it here
        // without opening a second exclusive input stream)
        if (this._micBusSubs > 0) this.emit('busChunk', 'mic-input', chunk);
      });

      this.inStream.on('error', (err: Error) => {
        this.emit('error', `Record error: ${err.message}`);
        this.stopRecording();
      });

      this.inStream.start();
      // inStream is now the mic source — close dedicated bus stream if open
      this._closeMicBusStream();

      // If monitoring is also active, open output for passthrough
      if (this.monitoring && !this.outStream) {
        this.outStream = new naudiodon.AudioIO({
          outOptions: {
            channelCount: numCh,
            sampleFormat: naudiodon.SampleFormatFloat32,
            sampleRate:   sr,
            deviceId:     outDeviceId,
            closeOnError: false,
          },
        });
        this.outStream.start();
      }
      if (this.monitoring && this.outStream) {
        this.inStream.pipe(this.outStream, { end: false });
      }

    } catch (err) {
      this.recording = false;
      this.emit('error', `Input open failed: ${(err as Error).message}`);
    }
  }

  async stopRecording(): Promise<{ filePath: string; duration: number } | null> {
    if (!this.recording) return null;
    this.recording = false;

    if (this.inStream) {
      try { this.inStream.quit(); } catch {}
      this.inStream = null;
    }

    if (!this.recWs) return null;
    const dataBytes = this.recPcmBytes;
    await new Promise<void>(res => this.recWs!.end(res));
    this.recWs = null;

    // Patch RIFF and data sizes in the WAV header
    const fd = fs.openSync(this.recFilePath, 'r+');
    const b4 = Buffer.allocUnsafe(4);
    b4.writeUInt32LE(36 + dataBytes, 0); fs.writeSync(fd, b4, 0, 4, 4);
    b4.writeUInt32LE(dataBytes, 0);      fs.writeSync(fd, b4, 0, 4, 40);
    fs.closeSync(fd);

    const duration = dataBytes / (this.recSr * this.recNumCh * 3);
    const result   = { filePath: this.recFilePath, duration };
    this.recFilePath  = '';
    this.recPcmBytes  = 0;

    // If mic-input bus still has subscribers and no monitoring stream is open,
    // reopen a dedicated bus stream so the bus stays live after recording stops.
    if (this._micBusSubs > 0 && !this.inStream) {
      this._openMicBusStream(this.inDeviceId);
    }
    return result;
  }

  // ── Input monitoring ──────────────────────────────────────────────────────

  async startMonitoring(inDeviceId = -1, outDeviceId = -1, sr = ENGINE_SR, numCh = NUM_CHANNELS) {
    if (!naudiodon || this.monitoring) return;
    this.monitoring = true;

    // If already recording, the input stream is open — just tee to output
    if (this.recording && this.inStream) {
      if (!this.outStream) {
        this.outStream = new naudiodon.AudioIO({
          outOptions: { channelCount: numCh, sampleFormat: naudiodon.SampleFormatFloat32, sampleRate: sr, deviceId: outDeviceId, closeOnError: false },
        });
        this.outStream.start();
      }
      this.inStream.pipe(this.outStream, { end: false });
      return;
    }

    // Standalone monitoring (not recording).
    // Use separate in + out streams (not duplex) so this.outStream is always
    // set when monitoring is active. startPlayback() can then safely reuse it
    // without hitting an ASIO exclusive-access conflict.
    try {
      this.inStream = new naudiodon.AudioIO({
        inOptions: { channelCount: numCh, sampleFormat: naudiodon.SampleFormatFloat32, sampleRate: sr, deviceId: inDeviceId, closeOnError: false },
      });
      this.inStream.on('data', (chunk: Buffer) => {
        if (this._micBusSubs > 0) this.emit('busChunk', 'mic-input', chunk);
      });
      if (!this.outStream) {
        this.outStream = new naudiodon.AudioIO({
          outOptions: { channelCount: numCh, sampleFormat: naudiodon.SampleFormatFloat32, sampleRate: sr, deviceId: outDeviceId, closeOnError: false },
        });
        this.outStream.start();
      }
      this.inStream.pipe(this.outStream, { end: false });
      this.inStream.start();
      this._closeMicBusStream(); // inStream takes over
    } catch (err) {
      this.monitoring = false;
      this.emit('error', `Monitor open failed: ${(err as Error).message}`);
    }
  }

  stopMonitoring() {
    if (!this.monitoring) return;
    this.monitoring = false;
    if (!this.recording && this.inStream) {
      try { this.inStream.quit(); } catch {}
      this.inStream = null;
    }
    if (!this.playing && this.outStream) {
      try { this.outStream.quit(); } catch {}
      this.outStream = null;
    }
    // Reopen dedicated bus stream if subscribers are waiting and nothing
    // else is holding inStream open.
    if (this._micBusSubs > 0 && !this.inStream) {
      this._openMicBusStream(this.inDeviceId);
    }
  }

  // ── Audio Bus API ─────────────────────────────────────────────────────────

  subscribeBus(busId: string) {
    if (busId === 'mic-input') {
      this._micBusSubs++;
      // If inStream is already open, the data handler in startRecording /
      // startMonitoring already emits busChunk — nothing extra needed.
      // Only open a dedicated stream when no input is currently running.
      if (this._micBusSubs === 1 && !this.inStream) {
        this._openMicBusStream(this.inDeviceId);
      }
    } else if (busId === 'playback-mix' || busId === 'master-output') {
      this._playBusSubs++;
    }
  }

  unsubscribeBus(busId: string) {
    if (busId === 'mic-input') {
      this._micBusSubs = Math.max(0, this._micBusSubs - 1);
      if (this._micBusSubs === 0) this._closeMicBusStream();
    } else if (busId === 'playback-mix' || busId === 'master-output') {
      this._playBusSubs = Math.max(0, this._playBusSubs - 1);
    }
  }

  // Open a lightweight input-only stream purely for bus emission.
  // Must only be called when this.inStream is null (not recording/monitoring).
  private _openMicBusStream(inDeviceId = -1, sr = ENGINE_SR, numCh = NUM_CHANNELS) {
    if (!naudiodon || this._micBusStream || this.inStream) return;
    try {
      this._micBusStream = new naudiodon.AudioIO({
        inOptions: {
          channelCount: numCh,
          sampleFormat: naudiodon.SampleFormatFloat32,
          sampleRate:   sr,
          deviceId:     inDeviceId,
          closeOnError: false,
        },
      });
      this._micBusStream.on('data', (chunk: Buffer) => {
        this.emit('busChunk', 'mic-input', chunk);
      });
      this._micBusStream.on('error', (err: Error) => {
        this.emit('error', `Mic-bus stream error: ${err.message}`);
      });
      this._micBusStream.start();
    } catch (err) {
      this.emit('error', `Mic-bus open failed: ${(err as Error).message}`);
    }
  }

  private _closeMicBusStream() {
    if (!this._micBusStream) return;
    try { this._micBusStream.quit(); } catch {}
    this._micBusStream = null;
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  async dispose() {
    this._micBusSubs  = 0;
    this._playBusSubs = 0;
    this._closeMicBusStream();
    this.stopPlayback();
    await this.stopRecording();
    this.stopMonitoring();
  }

  // ── Takes / project Audio folder ─────────────────────────────────────────

  private static _audioDir: string | null = null;

  static setAudioDir(dir: string): void {
    NativeAudioEngine._audioDir = dir;
  }

  static getTakesDir(): string {
    return NativeAudioEngine._audioDir ?? path.join(app.getPath('userData'), 'Takes');
  }

  static getTakePath(name: string): string {
    const dir  = NativeAudioEngine.getTakesDir();
    const safe = name.replace(/[^a-zA-Z0-9_\-. ]/g, '_');
    const now  = new Date();
    const date = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    ].join('_');
    let idx = 1;
    while (true) {
      const candidate = path.join(dir, `${safe}_${date}_${String(idx).padStart(3, '0')}.wav`);
      if (!fs.existsSync(candidate)) return candidate;
      idx++;
    }
  }
}
