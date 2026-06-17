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

  // ── Live track parameters (updated without stopping playback)
  private liveParams = new Map<string, { volume: number; pan: number; muted: boolean }>();

  // ── Recording state
  private recFilePath   = '';
  private recPcmBytes   = 0;
  private recSr         = ENGINE_SR;
  private recNumCh      = NUM_CHANNELS;

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
            sampleFormat: naudiodon.SampleFormat32Bit,
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

    this.fillTimer = setInterval(() => this._fill(), FILL_INTERVAL);
  }

  private _fill() {
    if (!this.playing || !this.outStream) return;

    const n   = BUFFER_SAMPLES;
    const sr  = this.engineSr;
    const outL = new Float32Array(n);
    const outR = new Float32Array(n);

    for (const rt of this.tracks) {
      const live  = this.liveParams.get(rt.spec.trackId);
      if (live?.muted ?? rt.spec.muted) continue;

      const vol   = live?.volume ?? rt.spec.volume;
      const pan   = live?.pan    ?? rt.spec.pan;
      // Constant-power pan law
      const angle = ((pan + 1) / 2) * (Math.PI / 2);
      const panL  = Math.cos(angle);
      const panR  = Math.sin(angle);

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

        outL[i] += l * panL;
        outR[i] += r * panR;
      }
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

    try {
      this.outStream.write(Buffer.from(out.buffer));
    } catch { /* stream closed */ }

    // Emit interleaved F32 mix to playback-mix / master-output buses
    if (this._playBusSubs > 0) {
      this.emit('busChunk', 'playback-mix', Buffer.from(out.buffer));
    }

    this.playPosition += n;

    // Position event (throttled by the caller dispatch)
    this.emit('position', this.playPosition / sr);

    // Level meters
    this.emit('levels', [Math.sqrt(rmsL / n), Math.sqrt(rmsR / n)]);

    // Auto-stop when all clips have finished
    if (this.tracks.length > 0) {
      const maxEnd = this.tracks.reduce((m, t) => Math.max(m, t.endSample), 0);
      if (this.playPosition >= maxEnd) {
        this.stopPlayback();
        this.emit('ended', this.playPosition / sr);
      }
    }
  }

  stopPlayback() {
    this.playing = false;
    if (this.fillTimer) { clearInterval(this.fillTimer); this.fillTimer = null; }
    if (this.outStream && !this.monitoring) {
      try { this.outStream.quit(); } catch {}
      this.outStream = null;
    }
    // Re-pipe monitoring passthrough now that _fill() has stopped writing.
    // (startPlayback unpiped it to prevent two concurrent writers to outStream.)
    if (this.monitoring && this.inStream && this.outStream) {
      this.inStream.pipe(this.outStream, { end: false });
    }
    this.liveParams.clear();
  }

  seek(timeSecs: number) {
    this.playPosition = Math.max(0, Math.round(timeSecs * this.engineSr));
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
          sampleFormat: naudiodon.SampleFormat32Bit,
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
            sampleFormat: naudiodon.SampleFormat32Bit,
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
          outOptions: { channelCount: numCh, sampleFormat: naudiodon.SampleFormat32Bit, sampleRate: sr, deviceId: outDeviceId, closeOnError: false },
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
        inOptions: { channelCount: numCh, sampleFormat: naudiodon.SampleFormat32Bit, sampleRate: sr, deviceId: inDeviceId, closeOnError: false },
      });
      this.inStream.on('data', (chunk: Buffer) => {
        if (this._micBusSubs > 0) this.emit('busChunk', 'mic-input', chunk);
      });
      if (!this.outStream) {
        this.outStream = new naudiodon.AudioIO({
          outOptions: { channelCount: numCh, sampleFormat: naudiodon.SampleFormat32Bit, sampleRate: sr, deviceId: outDeviceId, closeOnError: false },
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
          sampleFormat: naudiodon.SampleFormat32Bit,
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
    const safe = name.replace(/[^a-zA-Z0-9_\-. ]/g, '_');
    return path.join(NativeAudioEngine.getTakesDir(), `${safe}.wav`);
  }
}
