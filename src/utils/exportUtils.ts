/**
 * exportUtils.ts
 * Pure-browser audio export utilities.
 *
 * WAV encoding: raw PCM → RIFF/WAV container, no external libraries.
 * Mixdown:      OfflineAudioContext renders all unmuted regions to a
 *               stereo AudioBuffer, respecting track volume/pan/mute/solo.
 */

import type { DawState, Region } from '../context/DawContext';

// ── WAV encoder ───────────────────────────────────────────────────────────────

/**
 * Encode an AudioBuffer to a WAV Blob (PCM 32-bit float, little-endian).
 * 32-bit float is used so there is zero clipping headroom loss — any host
 * DAW that imports the file will handle it without a decode-generation hit.
 */
export function encodeWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate  = buffer.sampleRate;
  const numSamples  = buffer.length;
  const bytesPerSample = 4; // 32-bit float
  const dataBytes   = numChannels * numSamples * bytesPerSample;
  const totalBytes  = 44 + dataBytes;

  const arrayBuffer = new ArrayBuffer(totalBytes);
  const view        = new DataView(arrayBuffer);

  // RIFF chunk
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeString(view, 8, 'WAVE');

  // fmt sub-chunk  (IEEE float = format 3)
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);             // sub-chunk size
  view.setUint16(20, 3, true);              // PCM float
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true); // byte rate
  view.setUint16(32, numChannels * bytesPerSample, true);              // block align
  view.setUint16(34, 8 * bytesPerSample, true);                        // bits per sample

  // data sub-chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  // Interleave channel samples
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      view.setFloat32(offset, buffer.getChannelData(ch)[i], true);
      offset += 4;
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

// ── Mixdown renderer ──────────────────────────────────────────────────────────

interface MixdownOptions {
  state: DawState;
  /** Pre-fetched audio blobs keyed by audioUrl, so we don't re-download */
  audioCache?: Map<string, ArrayBuffer>;
  onProgress?: (pct: number) => void;
}

/**
 * Render all unmuted/unsolo-excluded regions to a stereo AudioBuffer using
 * OfflineAudioContext. Returns the rendered buffer.
 *
 * Respects: mute, solo, track volume, track pan, region mute, region audioOffset.
 * Does NOT apply any live plug-in/insert processing (web limitation).
 */
export async function renderMixdown({
  state,
  audioCache,
  onProgress,
}: MixdownOptions): Promise<AudioBuffer> {
  const { tracks, regions } = state;

  if (regions.length === 0) {
    throw new Error('No regions to export. Add some recordings first.');
  }

  // Determine total duration
  const totalDuration = Math.max(...regions.map(r => r.startTime + r.duration));

  // Sample rate from prefs (or 48 kHz default)
  const sampleRate = 48000;

  const ctx = new OfflineAudioContext(2, Math.ceil(totalDuration * sampleRate), sampleRate);

  const hasSolo = tracks.some(t => t.isSolo);
  const playableTracks = new Set(
    tracks
      .filter(t => !t.isMuted && (!hasSolo || t.isSolo))
      .map(t => t.id)
  );

  // Build a stereo bus per track (gain + panner)
  const trackBusses: Record<string, { gain: GainNode; panner: StereoPannerNode }> = {};
  for (const track of tracks) {
    if (!playableTracks.has(track.id)) continue;
    const gain   = ctx.createGain();
    const panner = ctx.createStereoPanner();
    gain.gain.value    = isFinite(track.volume) ? track.volume : 0.8;
    panner.pan.value   = isFinite(track.pan)    ? track.pan    : 0;
    gain.connect(panner);
    panner.connect(ctx.destination);
    trackBusses[track.id] = { gain, panner };
  }

  // Schedule regions
  const playableRegions = regions.filter(r =>
    playableTracks.has(r.trackId) && !r.isMuted && r.audioUrl
  );

  let completed = 0;
  const total = playableRegions.length;

  await Promise.all(playableRegions.map(async (region: Region) => {
    try {
      let ab: ArrayBuffer;
      if (audioCache?.has(region.audioUrl)) {
        ab = audioCache.get(region.audioUrl)!;
      } else {
        const resp = await fetch(region.audioUrl);
        ab = await resp.arrayBuffer();
      }

      // OfflineAudioContext can't reuse the same ArrayBuffer for decode
      const cloned = ab.slice(0);
      const audioBuffer = await ctx.decodeAudioData(cloned);

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;

      const bus = trackBusses[region.trackId];
      if (bus) source.connect(bus.gain);

      const offset    = region.audioOffset ?? 0;
      const duration  = region.duration;
      source.start(region.startTime, offset, duration);
    } catch (err) {
      console.warn(`Skipped region "${region.name}":`, err);
    } finally {
      completed++;
      onProgress?.(completed / total);
    }
  }));

  return ctx.startRendering();
}

// ── Stems exporter ────────────────────────────────────────────────────────────

/**
 * Render each track to its own WAV file starting at time 0, then bundle
 * everything into a ZIP and trigger a browser download.
 * Muted tracks and tracks excluded by solo are skipped.
 */
export async function exportStems(
  state: DawState,
  projectName: string,
  onProgress?: (message: string) => void
): Promise<void> {
  const { tracks, regions } = state;

  if (regions.length === 0) throw new Error('No regions to export.');

  const totalDuration = Math.max(...regions.map(r => r.startTime + r.duration), 1);
  const sampleRate    = 48000;
  const hasSolo       = tracks.some(t => t.isSolo);
  const playable      = tracks.filter(t => !t.isMuted && (!hasSolo || t.isSolo));

  const JSZip = (await import('jszip')).default;
  const zip   = new JSZip();

  for (const track of playable) {
    const trackRegions = regions.filter(
      r => r.trackId === track.id && r.versionId === track.activeVersionId && !r.isMuted && r.audioUrl
    );
    if (trackRegions.length === 0) continue;

    onProgress?.(`Rendering ${track.name}…`);

    try {
      const offCtx = new OfflineAudioContext(2, Math.ceil(totalDuration * sampleRate), sampleRate);
      const gain   = offCtx.createGain();
      const panner = offCtx.createStereoPanner();
      gain.gain.value  = isFinite(track.volume) ? track.volume : 0.8;
      panner.pan.value = isFinite(track.pan)    ? Math.max(-1, Math.min(1, track.pan)) : 0;
      gain.connect(panner);
      panner.connect(offCtx.destination);

      await Promise.all(trackRegions.map(async (region) => {
        try {
          const resp = await fetch(region.audioUrl);
          const ab   = await resp.arrayBuffer();
          const buf  = await offCtx.decodeAudioData(ab);
          const src  = offCtx.createBufferSource();
          src.buffer = buf;

          // Apply fade-in / fade-out via automation
          if (region.fadeIn || region.fadeOut) {
            const fg = offCtx.createGain();
            fg.gain.setValueAtTime(region.fadeIn ? 0 : 1, region.startTime);
            if (region.fadeIn) {
              fg.gain.linearRampToValueAtTime(1, region.startTime + region.fadeIn);
            }
            if (region.fadeOut) {
              const foStart = region.startTime + region.duration - region.fadeOut;
              fg.gain.setValueAtTime(1, foStart);
              fg.gain.linearRampToValueAtTime(0, region.startTime + region.duration);
            }
            src.connect(fg);
            fg.connect(gain);
          } else {
            src.connect(gain);
          }

          src.start(region.startTime, region.audioOffset ?? 0, region.duration);
        } catch { /* skip undecodable */ }
      }));

      const rendered = await offCtx.startRendering();
      const wavBlob  = encodeWav(rendered);
      zip.file(`${track.name}.wav`, await wavBlob.arrayBuffer());
    } catch (err) {
      console.error(`Stem render failed for "${track.name}":`, err);
    }
  }

  onProgress?.('Compressing…');
  const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  triggerDownload(zipBlob, `${projectName}_Stems.zip`);
}

// ── Consolidate track ─────────────────────────────────────────────────────────

/**
 * Render all clips on a single track into one continuous WAV starting at t=0.
 * Returns the WAV blob — caller decides what to do with it.
 */
export async function consolidateTrack(
  state: DawState,
  trackId: string,
  onProgress?: (message: string) => void
): Promise<{ blob: Blob; name: string } | null> {
  const track   = state.tracks.find(t => t.id === trackId);
  if (!track) return null;

  const trackRegions = state.regions.filter(
    r => r.trackId === trackId && r.versionId === track.activeVersionId && !r.isMuted && r.audioUrl
  );
  if (trackRegions.length === 0) return null;

  const totalDuration = Math.max(...trackRegions.map(r => r.startTime + r.duration));
  const sampleRate    = 48000;

  onProgress?.(`Consolidating ${track.name}…`);

  const offCtx = new OfflineAudioContext(2, Math.ceil(totalDuration * sampleRate), sampleRate);
  const gain   = offCtx.createGain();
  gain.gain.value = 1; // full gain — preserve original levels
  gain.connect(offCtx.destination);

  await Promise.all(trackRegions.map(async (region) => {
    try {
      const resp = await fetch(region.audioUrl);
      const ab   = await resp.arrayBuffer();
      const buf  = await offCtx.decodeAudioData(ab);
      const src  = offCtx.createBufferSource();
      src.buffer = buf;
      src.connect(gain);
      src.start(region.startTime, region.audioOffset ?? 0, region.duration);
    } catch { /* skip */ }
  }));

  const rendered = await offCtx.startRendering();
  const blob     = encodeWav(rendered);
  return { blob, name: `${track.name}_consolidated` };
}

// ── Public export function ────────────────────────────────────────────────────

/**
 * Full pipeline: render mixdown → encode WAV → trigger browser download.
 * Shows a simple progress toast via console (caller can wrap with UI).
 */
export async function exportToWav(
  state: DawState,
  filename = 'Mixdown',
  onProgress?: (pct: number) => void
): Promise<void> {
  const audioBuffer = await renderMixdown({ state, onProgress });
  const wav         = encodeWav(audioBuffer);
  triggerDownload(wav, `${filename}.wav`);
}

/**
 * Export a single audio URL (e.g. a pool item or region take) as WAV.
 * Useful for the "Download" button on individual pool items.
 */
export async function exportUrlToWav(audioUrl: string, filename = 'Take'): Promise<void> {
  const resp = await fetch(audioUrl);
  const ab   = await resp.arrayBuffer();

  // Decode through a throwaway AudioContext for sample-rate info
  const ctx    = new AudioContext();
  const buffer = await ctx.decodeAudioData(ab);
  await ctx.close();

  const wav = encodeWav(buffer);
  triggerDownload(wav, `${filename}.wav`);
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
