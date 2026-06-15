import { supabase } from '../lib/supabaseClient';

// ── Peak extraction (off-thread via Web Worker) ──────────────────────────────

let peakWorker: Worker | null = null;
let peakWorkerIdCounter = 0;
const peakWorkerCallbacks = new Map<number, (left: number[], right: number[] | null) => void>();

function getPeakWorker(): Worker {
  if (!peakWorker) {
    peakWorker = new Worker(new URL('../audio/peak-worker.ts', import.meta.url), { type: 'module' });
    peakWorker.onmessage = (e) => {
      const { id, left, right } = e.data;
      const cb = peakWorkerCallbacks.get(id);
      if (cb) { peakWorkerCallbacks.delete(id); cb(left, right); }
    };
  }
  return peakWorker;
}

export const generatePeaks = (audioBuffer: AudioBuffer, count = 800): Promise<number[]> =>
  generatePeaksStereo(audioBuffer, count).then(r => r.left);

export function generatePeaksStereo(
  audioBuffer: AudioBuffer,
  count = 800,
): Promise<{ left: number[]; right: number[] | null }> {
  return new Promise((resolve) => {
    const id  = ++peakWorkerIdCounter;
    const ch0 = audioBuffer.getChannelData(0);
    const ch1 = audioBuffer.numberOfChannels >= 2 ? audioBuffer.getChannelData(1) : null;

    // Transfer ownership of copies so the worker can use them without blocking
    const ch0copy = ch0.slice();
    const ch1copy = ch1 ? ch1.slice() : null;

    peakWorkerCallbacks.set(id, (left, right) => resolve({ left, right }));

    const transferList: Transferable[] = [ch0copy.buffer];
    if (ch1copy) transferList.push(ch1copy.buffer);

    getPeakWorker().postMessage({ id, ch0: ch0copy, ch1: ch1copy, count }, transferList);
  });
}

/** Extract peaks inline from raw Float32 arrays (used during recording where no AudioBuffer exists). */
export function extractPeaksFromFloat32(ch0: Float32Array, ch1: Float32Array | null, count = 800): { left: number[]; right: number[] | null } {
  const extract = (data: Float32Array): number[] => {
    const blockSize = Math.max(1, Math.floor(data.length / count));
    const peaks: number[] = [];
    for (let i = 0; i < count; i++) {
      let max = 0;
      const end = Math.min((i + 1) * blockSize, data.length);
      for (let j = i * blockSize; j < end; j++) {
        const v = Math.abs(data[j]);
        if (v > max) max = v;
      }
      peaks.push(max);
    }
    return peaks;
  };
  return { left: extract(ch0), right: ch1 ? extract(ch1) : null };
}

// ── Streaming WAV writer helpers (for continuous recording) ──────────────────

/**
 * Build a 44-byte WAV RIFF header with placeholder sizes (filled in on stop).
 * Format: 24-bit PCM, little-endian.
 */
export function createWavHeader(sampleRate: number, numChannels: number): ArrayBuffer {
  const bitDepth       = 24;
  const bytesPerSample = bitDepth / 8;
  const blockAlign     = numChannels * bytesPerSample;
  const ab  = new ArrayBuffer(44);
  const dv  = new DataView(ab);
  const b   = new Uint8Array(ab);
  const str = (o: number, s: string) => s.split('').forEach((c, i) => { b[o + i] = c.charCodeAt(0); });

  str(0,  'RIFF'); dv.setUint32(4,  0, true);   // RIFF size — filled on stop
  str(8,  'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);                    // PCM
  dv.setUint16(22, numChannels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * blockAlign, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bitDepth, true);
  str(36, 'data'); dv.setUint32(40, 0, true);   // data size — filled on stop
  return ab;
}

/**
 * Encode interleaved Float32 channel arrays to 24-bit PCM.
 * Returns an ArrayBuffer ready to append to a streaming WAV file.
 */
export function floatsToPcm24(channels: Float32Array[]): ArrayBuffer {
  const numChannels = channels.length;
  const numSamples  = channels[0]?.length ?? 0;
  const buf = new ArrayBuffer(numSamples * numChannels * 3);
  const b   = new Uint8Array(buf);
  let off   = 0;
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const s = channels[ch][i] ?? 0;
      const v = Math.round(Math.max(-1, Math.min(1, s)) * (s < 0 ? 0x800000 : 0x7FFFFF));
      b[off]     =  v        & 0xFF;
      b[off + 1] = (v >> 8)  & 0xFF;
      b[off + 2] = (v >> 16) & 0xFF;
      off += 3;
    }
  }
  return buf;
}

// ── Full-buffer WAV encoder (for export / bounce) ────────────────────────────

/** Encode an AudioBuffer to a 24-bit stereo WAV ArrayBuffer (lossless, DAW-standard). */
export function audioBufferToWav(buffer: AudioBuffer): ArrayBuffer {
  const numChannels    = Math.min(2, buffer.numberOfChannels);
  const sampleRate     = buffer.sampleRate;
  const bitDepth       = 24;
  const bytesPerSample = bitDepth / 8;
  const blockAlign     = numChannels * bytesPerSample;
  const dataLength     = buffer.length * blockAlign;
  const ab    = new ArrayBuffer(44 + dataLength);
  const dv    = new DataView(ab);
  const bytes = new Uint8Array(ab);

  const writeStr = (offset: number, s: string) =>
    s.split('').forEach((c, i) => { bytes[offset + i] = c.charCodeAt(0); });

  writeStr(0,  'RIFF'); dv.setUint32(4,  36 + dataLength, true);
  writeStr(8,  'WAVE');
  writeStr(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, numChannels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * blockAlign, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bitDepth, true);
  writeStr(36, 'data'); dv.setUint32(40, dataLength, true);

  let off = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let c = 0; c < numChannels; c++) {
      const s   = buffer.getChannelData(c)[i];
      const val = Math.round(Math.max(-1, Math.min(1, s)) * (s < 0 ? 0x800000 : 0x7FFFFF));
      bytes[off]     =  val        & 0xFF;
      bytes[off + 1] = (val >> 8)  & 0xFF;
      bytes[off + 2] = (val >> 16) & 0xFF;
      off += 3;
    }
  }
  return ab;
}

/**
 * Write a 24-bit WAV into the project's local Audio/ folder.
 * Returns the filename used (e.g. "Take_1.wav").
 */
export async function saveToAudioFolder(
  audioDirHandle: any,
  baseName: string,
  audioBuffer: AudioBuffer,
): Promise<string> {
  const wav      = audioBufferToWav(audioBuffer);
  const safeName = baseName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_\-. ]/g, '_') + '.wav';
  const fh = await audioDirHandle.getFileHandle(safeName, { create: true });
  const w  = await fh.createWritable();
  await w.write(wav);
  await w.close();
  return safeName;
}

/**
 * Upload a recording to Supabase Storage with:
 * - Room-scoped paths for version safety (no collisions between sessions)
 * - Up to 3 retries with exponential backoff
 * Returns { publicUrl, storagePath } on success, throws on all retries exhausted.
 */
export const uploadAudioToSupabase = async (
  blob: Blob,
  fileName: string,
): Promise<{ publicUrl: string; storagePath: string }> => {
  const roomCode = localStorage.getItem('sl_room') ?? 'unknown';
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  // Path: room/timestamp_filename  — timestamp guarantees uniqueness within the room
  const storagePath = `${roomCode}/${Date.now()}_${safeName}`;

  const MAX_RETRIES = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { error } = await supabase.storage
        .from('audio_files')
        .upload(storagePath, blob, { contentType: blob.type || 'audio/wav', upsert: false });

      if (error) throw error;

      const { data } = supabase.storage.from('audio_files').getPublicUrl(storagePath);
      return { publicUrl: data.publicUrl, storagePath };
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 800 * attempt)); // 0.8s, 1.6s backoff
      }
    }
  }

  throw lastError;
};
