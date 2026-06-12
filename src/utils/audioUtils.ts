import { supabase } from '../lib/supabaseClient';

const extractPeaks = (channelData: Float32Array, count: number): number[] => {
  const blockSize = Math.floor(channelData.length / count);
  const peaks: number[] = [];
  for (let i = 0; i < count; i++) {
    let max = 0;
    for (let j = 0; j < blockSize; j++) {
      const v = Math.abs(channelData[i * blockSize + j] ?? 0);
      if (v > max) max = v;
    }
    peaks.push(max);
  }
  return peaks;
};

export const generatePeaks = async (audioBuffer: AudioBuffer, count = 800): Promise<number[]> =>
  extractPeaks(audioBuffer.getChannelData(0), count);

export const generatePeaksStereo = async (
  audioBuffer: AudioBuffer,
  count = 800,
): Promise<{ left: number[]; right: number[] | null }> => ({
  left:  extractPeaks(audioBuffer.getChannelData(0), count),
  right: audioBuffer.numberOfChannels >= 2
    ? extractPeaks(audioBuffer.getChannelData(1), count)
    : null,
});

/** Encode an AudioBuffer to a 24-bit stereo WAV ArrayBuffer (lossless, DAW-standard). */
export function audioBufferToWav(buffer: AudioBuffer): ArrayBuffer {
  const numChannels = Math.min(2, buffer.numberOfChannels);
  const sampleRate  = buffer.sampleRate;
  const bitDepth    = 24;
  const bytesPerSample = bitDepth / 8;
  const blockAlign  = numChannels * bytesPerSample;
  const dataLength  = buffer.length * blockAlign;
  const ab    = new ArrayBuffer(44 + dataLength);
  const dv    = new DataView(ab);
  const bytes = new Uint8Array(ab);

  const writeStr = (offset: number, s: string) =>
    s.split('').forEach((c, i) => { bytes[offset + i] = c.charCodeAt(0); });

  writeStr(0, 'RIFF');
  dv.setUint32(4, 36 + dataLength, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);            // PCM
  dv.setUint16(22, numChannels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * blockAlign, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bitDepth, true);
  writeStr(36, 'data');
  dv.setUint32(40, dataLength, true);

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
 * Decode any audio blob/file to a 24-bit WAV and write it into the
 * project's local Audio/ folder.  Returns the filename used (e.g. "Take_1.wav").
 */
export async function saveToAudioFolder(
  audioDirHandle: any,
  baseName: string,
  audioBuffer: AudioBuffer,
): Promise<string> {
  const wav      = audioBufferToWav(audioBuffer);
  const safeName = baseName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_\-. ]/g, '_') + '.wav';
  // @ts-ignore
  const fh = await audioDirHandle.getFileHandle(safeName, { create: true });
  const w  = await fh.createWritable();
  await w.write(wav);
  await w.close();
  return safeName;
}

export const uploadAudioToSupabase = async (blob: Blob, fileName: string): Promise<string> => {
  const path = `${Date.now()}_${fileName.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
  const { error } = await supabase.storage
    .from('audio_files')
    .upload(path, blob, { contentType: blob.type || 'audio/wav' });

  if (error) {
    console.error('Supabase upload failed, falling back to local blob:', error);
    return URL.createObjectURL(blob);
  }

  const { data } = supabase.storage.from('audio_files').getPublicUrl(path);
  return data.publicUrl;
};
