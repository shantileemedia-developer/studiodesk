/**
 * useNativeAudioEngine
 *
 * Full-featured drop-in for useAudioEngine when the native Electron audio
 * engine (naudiodon/PortAudio) is available.  Communicates with the
 * NativeAudioEngine class in the main process via IPC (window.audioEngine).
 *
 * Retains the Web Audio API only for:
 *   - Metronome / count-in clicks (Web Audio scheduling is simpler here)
 *   - OfflineAudioContext used by export/bounce/crop utils
 *
 * Falls back gracefully when window.audioEngine is absent or reports
 * 'unavailable' (naudiodon not compiled).
 */

import { useRef, useCallback, useEffect, useState } from 'react';
import { useDaw } from '../context/DawContext';
import type { Region, PoolItem } from '../context/DawContext';
import { generatePeaksStereo, uploadAudioToSupabase } from '../utils/audioUtils';
import { loadAudioPrefs } from '../components/daw/AudioMIDIPreferencesDialog';
import type { NativeTrackSpec } from '../types/audioEngine';

const eng = () => window.audioEngine;

// Metronome scheduler constants (matches useAudioEngine)
const CLICK_LOOKAHEAD_S  = 0.12;
const CLICK_INTERVAL_MS  = 25;

// Decode any browser-supported audio format and re-encode as IEEE float 32-bit
// stereo WAV so the native engine's WAV-only decoder can play it.
async function decodeToWavBuffer(ab: ArrayBuffer): Promise<ArrayBuffer> {
  const tmp = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await tmp.decodeAudioData(ab.slice(0)); // slice so detach doesn't affect original
  } catch {
    await tmp.close().catch(() => {});
    return ab; // return original if we can't decode (will fail gracefully in native engine)
  }
  await tmp.close().catch(() => {});

  const sr     = decoded.sampleRate;
  const frames = decoded.length;
  const L      = decoded.getChannelData(0);
  const R      = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : L;

  // IEEE float 32-bit stereo WAV header
  const wav = new ArrayBuffer(44 + frames * 8);
  const dv  = new DataView(wav);
  const ws  = (off: number, str: string) =>
    str.split('').forEach((c, i) => dv.setUint8(off + i, c.charCodeAt(0)));

  ws(0, 'RIFF'); dv.setUint32(4, 36 + frames * 8, true);
  ws(8, 'WAVE');
  ws(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 3, true);           // IEEE float
  dv.setUint16(22, 2, true);           // stereo
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * 8, true);      // byte rate (sr × 2ch × 4B)
  dv.setUint16(32, 8, true);           // block align (2ch × 4B)
  dv.setUint16(34, 32, true);          // bits per sample
  ws(36, 'data'); dv.setUint32(40, frames * 8, true);

  const f32 = new Float32Array(wav, 44);
  for (let i = 0; i < frames; i++) {
    f32[i * 2]     = L[i];
    f32[i * 2 + 1] = R[i];
  }
  return wav;
}

// ── Hook ───────────────────────────────────────────────────────────────────────

export const useNativeAudioEngine = () => {
  const {
    state, dispatch,
    currentTimeRef, audioCtxRef,
    livePeaksRef,
    masterGainRef,
    masterStreamRef,
    recordingStartTimeRef,
    nativeMasterLevelsRef,
    meterValuesRef,
    userRole,
  } = useDaw();

  // ── Availability ────────────────────────────────────────────────────────────

  const [nativeAvailable, setNativeAvailable] = useState(false);
  const nativeAvailableRef = useRef(false);

  useEffect(() => {
    if (!eng()) return;
    eng()!.isAvailable().then(ok => {
      nativeAvailableRef.current = ok;
      setNativeAvailable(ok);
    });
    const off = eng()!.onUnavailable(() => {
      nativeAvailableRef.current = false;
      setNativeAvailable(false);
    });
    return off;
  }, []);

  // ── Transport refs (kept in sync with state so closures read current values)

  const isLoopingRef  = useRef(state.transport.isLooping);
  const loopStartRef  = useRef(state.transport.loopStart);
  const loopEndRef    = useRef(state.transport.loopEnd);
  const tempoRef      = useRef(state.transport.tempo);
  const timeSigRef    = useRef(state.transport.timeSignature);
  const isPlayingRef  = useRef(false);
  const isRecordingRef = useRef(false);

  useEffect(() => { isLoopingRef.current = state.transport.isLooping; }, [state.transport.isLooping]);
  useEffect(() => { loopStartRef.current = state.transport.loopStart; }, [state.transport.loopStart]);
  useEffect(() => { loopEndRef.current   = state.transport.loopEnd;   }, [state.transport.loopEnd]);
  useEffect(() => { tempoRef.current     = state.transport.tempo;     }, [state.transport.tempo]);
  useEffect(() => { timeSigRef.current   = state.transport.timeSignature; }, [state.transport.timeSignature]);

  // Project end time — recalculate whenever regions change
  const projectEndRef = useRef(Infinity);
  useEffect(() => {
    // With no regions there is no "end" — play indefinitely until stopped.
    // With regions, stop 2 s after the last clip finishes.
    projectEndRef.current = state.regions.length === 0
      ? Infinity
      : state.regions.reduce((max, r) => Math.max(max, r.startTime + r.duration), 0) + 2;
  }, [state.regions]);

  // Punch state
  const punchArmedRef   = useRef(false);   // punch-in armed but not yet recording
  const punchWritingRef = useRef(false);   // currently writing punch region

  useEffect(() => {
    punchArmedRef.current = state.transport.punchIn != null && !isRecordingRef.current;
  }, [state.transport.punchIn]);

  // ── Temp-file cache: blob/http → OS path via audio:writeTemp ───────────────

  const tempCacheRef = useRef<Map<string, string>>(new Map());

  const resolveFilePath = useCallback(async (url: string): Promise<string | null> => {
    if (!url) return null;
    // Bare OS path (native WAV recordings) — pass directly to the engine
    if (!url.startsWith('blob:') && !url.startsWith('http') && !url.startsWith('file:')) {
      return url;
    }
    const cached = tempCacheRef.current.get(url);
    if (cached) return cached;
    if (!eng()) return null;
    try {
      const resp  = await fetch(url);
      const ab    = await resp.arrayBuffer();
      // Convert any format (MP3, AAC, OGG, WAV…) to IEEE float WAV so the
      // native engine's WAV-only decoder can always play it.
      const wavAb = await decodeToWavBuffer(ab);
      const hash  = url.split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0);
      const name  = `audio_${Math.abs(hash)}.wav`;
      const filePath = await eng()!.writeTemp(name, wavAb);
      tempCacheRef.current.set(url, filePath);
      return filePath;
    } catch {
      return null;
    }
  }, []);

  // ── Build TrackSpecs, resolving all audio URLs to OS paths ─────────────────

  const buildSpecs = useCallback(async (offsetSecs: number): Promise<NativeTrackSpec[]> => {
    const hasSolo = state.tracks.some(t => t.isSolo);
    const playableIds = new Set(
      state.tracks
        .filter(t => !t.isMuted && (!hasSolo || t.isSolo))
        .map(t => t.id),
    );

    const specs: NativeTrackSpec[] = [];
    await Promise.all(
      state.regions.map(async region => {
        if (!playableIds.has(region.trackId)) return;
        if (region.isMuted || !region.audioUrl) return;
        if (region.startTime + region.duration <= offsetSecs) return;

        const filePath = await resolveFilePath(
          (region as any).localFilePath ?? region.audioUrl,
        );
        if (!filePath) return;

        const track = state.tracks.find(t => t.id === region.trackId);
        specs.push({
          trackId:     region.trackId,
          filePath,
          startTime:   region.startTime,
          audioOffset: region.audioOffset ?? 0,
          duration:    region.duration,
          volume:      isFinite(track?.volume ?? 1) ? (track?.volume ?? 1) : 0.8,
          pan:         isFinite(track?.pan ?? 0)    ? Math.max(-1, Math.min(1, track?.pan ?? 0)) : 0,
          muted:       track?.isMuted ?? false,
          fadeIn:      region.fadeIn,
          fadeOut:     region.fadeOut,
        });
      }),
    );
    return specs;
  }, [state.regions, state.tracks, resolveFilePath]);

  // ── Metronome (Web Audio — low overhead, precise scheduling) ───────────────

  const clickSourcesRef    = useRef<AudioScheduledSourceNode[]>([]);
  const clickBeatRef       = useRef(0);
  const clickIntervalRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const nextClickTimeRef   = useRef(0);

  const playbackBusNextTimeRef = useRef(0);

  const getAudioCtx = useCallback((): AudioContext => {
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      audioCtxRef.current = new AudioContext({ sampleRate: 48000 });
      if (userRole === 'artist') {
        masterStreamRef.current = audioCtxRef.current.createMediaStreamDestination();
      }
      playbackBusNextTimeRef.current = audioCtxRef.current.currentTime + 0.06;
    }
    return audioCtxRef.current;
  }, [audioCtxRef, masterStreamRef, userRole]);

  const scheduleClick = useCallback((ctx: AudioContext, time: number, accent: boolean) => {
    const DUR = 0.022;
    const smpCt = Math.floor(ctx.sampleRate * DUR);
    const nBuf  = ctx.createBuffer(1, smpCt, ctx.sampleRate);
    const nData = nBuf.getChannelData(0);
    for (let i = 0; i < smpCt; i++) nData[i] = Math.random() * 2 - 1;
    const nSrc  = ctx.createBufferSource();
    nSrc.buffer = nBuf;
    const hp    = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = accent ? 2000 : 1100; hp.Q.value = 1;
    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(0, time);
    nGain.gain.linearRampToValueAtTime(accent ? 1.1 : 0.65, time + 0.001);
    nGain.gain.exponentialRampToValueAtTime(0.001, time + DUR);
    nSrc.connect(hp); hp.connect(nGain); nGain.connect(ctx.destination);
    if (masterStreamRef.current) nGain.connect(masterStreamRef.current);
    nSrc.start(time); nSrc.stop(time + DUR + 0.002);
    clickSourcesRef.current.push(nSrc);

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(accent ? 1800 : 900, time);
    osc.frequency.exponentialRampToValueAtTime(accent ? 700 : 380, time + DUR);
    const oGain = ctx.createGain();
    oGain.gain.setValueAtTime(accent ? 0.45 : 0.28, time);
    oGain.gain.exponentialRampToValueAtTime(0.001, time + DUR);
    osc.connect(oGain); oGain.connect(ctx.destination);
    if (masterStreamRef.current) oGain.connect(masterStreamRef.current);
    osc.start(time); osc.stop(time + DUR + 0.002);
    clickSourcesRef.current.push(osc);
  }, [masterStreamRef]);

  const stopMetronome = useCallback(() => {
    if (clickIntervalRef.current !== null) {
      clearInterval(clickIntervalRef.current);
      clickIntervalRef.current = null;
    }
    const now = audioCtxRef.current?.currentTime ?? 0;
    clickSourcesRef.current.forEach(n => { try { n.stop(now); } catch {} });
    clickSourcesRef.current = [];
  }, [audioCtxRef]);

  const startMetronome = useCallback((ctx: AudioContext, startDawTime: number) => {
    stopMetronome();
    const bps = tempoRef.current / 60;
    clickBeatRef.current    = Math.ceil(startDawTime * bps);
    nextClickTimeRef.current = ctx.currentTime +
      (clickBeatRef.current / bps - startDawTime);

    const schedule = () => {
      const now = ctx.currentTime;
      while (nextClickTimeRef.current < now + CLICK_LOOKAHEAD_S) {
        const beatInBar = clickBeatRef.current % timeSigRef.current[0];
        scheduleClick(ctx, nextClickTimeRef.current, beatInBar === 0);
        nextClickTimeRef.current += 60 / tempoRef.current;
        clickBeatRef.current++;
      }
    };
    schedule();
    clickIntervalRef.current = setInterval(schedule, CLICK_INTERVAL_MS);
  }, [stopMetronome, scheduleClick]);

  // Restart metronome on tempo/time-sig change during playback
  useEffect(() => {
    if (!isPlayingRef.current || !state.transport.metronomeOn) return;
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    startMetronome(ctx, currentTimeRef.current);
  }, [state.transport.tempo, state.transport.timeSignature]); // eslint-disable-line

  // ── Bus → masterStreamRef (DAW monitoring stream) ──────────────────────────
  // Pipe both 'playback-mix' (DAW track output) and 'mic-input' (live input
  // monitoring) into the Web Audio master stream destination so the engineer
  // hears both playback and the artist's live input via the monitoring WebRTC track.
  useEffect(() => {
    if (!eng() || userRole !== 'artist') return;

    // Eagerly init AudioContext so masterStreamRef.current is ready before any
    // getDawStream() call, then immediately resume so it's running without
    // waiting for a video call to trigger a user-gesture unlock.
    const ctx0 = getAudioCtx();
    ctx0.resume().catch(() => {});

    // Keep the context running — Chromium can re-suspend it without a call active.
    const keepAlive = setInterval(() => {
      const c = audioCtxRef.current;
      if (c && c.state === 'suspended') c.resume().catch(() => {});
    }, 2000);

    window.audioEngine!.subscribeBus('playback-mix').catch(() => {});
    window.audioEngine!.subscribeBus('mic-input').catch(() => {});

    const INIT_LATENCY_S = 0.06;
    const JITTER_PAD_S   = 0.04;
    let   micNextTime    = 0; // separate scheduling timeline for mic-input

    const off = window.audioEngine!.onBusChunk((busId, data) => {
      const isPlayback = busId === 'playback-mix';
      const isMic      = busId === 'mic-input';
      if (!isPlayback && !isMic) return;

      const ctx  = audioCtxRef.current;
      const dest = masterStreamRef.current;
      if (!ctx || ctx.state === 'closed' || !dest) return;
      // Skip scheduling while suspended — stale timestamps cause the chunk to
      // be dropped on resume. The keep-alive interval will resume the context
      // within 2 s and the next chunk will schedule correctly.
      if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); return; }

      const f32       = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
      const numFrames = f32.length / 2; // interleaved stereo

      const buf = ctx.createBuffer(2, numFrames, ctx.sampleRate);
      const L   = buf.getChannelData(0);
      const R   = buf.getChannelData(1);
      for (let i = 0; i < numFrames; i++) { L[i] = f32[i * 2]; R[i] = f32[i * 2 + 1]; }

      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(dest);

      const now = ctx.currentTime;
      if (isPlayback) {
        if (playbackBusNextTimeRef.current < now + JITTER_PAD_S) {
          playbackBusNextTimeRef.current = now + INIT_LATENCY_S;
        }
        src.start(playbackBusNextTimeRef.current);
        playbackBusNextTimeRef.current += numFrames / ctx.sampleRate;
      } else {
        // mic-input uses its own scheduling timeline so it doesn't interfere
        // with playback-mix scheduling during simultaneous record + overdub.
        if (micNextTime < now + JITTER_PAD_S) {
          micNextTime = now + INIT_LATENCY_S;
        }
        src.start(micNextTime);
        micNextTime += numFrames / ctx.sampleRate;
      }
    });

    return () => {
      clearInterval(keepAlive);
      off();
      window.audioEngine?.unsubscribeBus('playback-mix').catch(() => {});
      window.audioEngine?.unsubscribeBus('mic-input').catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Animation / IPC listener loop ──────────────────────────────────────────

  const animFrameRef        = useRef<number | null>(null);
  const lastDispatchTimeRef = useRef(0);

  const stopAnimLoop = useCallback(() => {
    if (animFrameRef.current) { cancelAnimationFrame(animFrameRef.current); animFrameRef.current = null; }
  }, []);

  const startAnimLoop = useCallback(() => {
    stopAnimLoop();
    const tick = () => {
      animFrameRef.current = requestAnimationFrame(tick);
      const now = performance.now();
      if (now - lastDispatchTimeRef.current > 100) {
        dispatch({ type: 'SET_CURRENT_TIME', payload: currentTimeRef.current });
        lastDispatchTimeRef.current = now;
      }
    };
    animFrameRef.current = requestAnimationFrame(tick);
  }, [stopAnimLoop, dispatch, currentTimeRef]);

  // ── IPC event listeners ─────────────────────────────────────────────────────

  // Keep a ref to play so the position handler can restart (loop / punch)
  const playFnRef = useRef<(() => Promise<void>) | null>(null);
  const stopRecordingSessionRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    if (!eng()) return;

    let _auditPosCnt = 0;
    const offPos = eng()!.onPosition(async (t: number) => {
      // Ignore position events that arrive after stop has been initiated.
      // Without this guard, the engine keeps emitting positions for ~20ms while
      // the IPC stop is in-flight and overwrites the cursor position that
      // handleStop already set (e.g. pre-play bar 3).
      if (!isPlayingRef.current) {
        console.log(`[AUDIT][Hook][onPosition] DROPPED (not playing) t=${t.toFixed(4)}s`);
        return;
      }
      _auditPosCnt++;
      if (_auditPosCnt % 50 === 0) {
        console.log(`[AUDIT][Hook][onPosition] t=${t.toFixed(4)}s currentTimeRef=${currentTimeRef.current.toFixed(4)}s`);
      }
      currentTimeRef.current = t;

      // ── Auto-stop at project end ──────────────────────────────────────────
      if (!isLoopingRef.current && t >= projectEndRef.current && isPlayingRef.current) {
        isPlayingRef.current = false;
        stopAnimLoop();
        stopMetronome();
        await eng()?.stop();
        dispatch({ type: 'SET_PLAYING', payload: false });
        dispatch({ type: 'SET_CURRENT_TIME', payload: t });
        return;
      }

      // ── Loop ─────────────────────────────────────────────────────────────
      if (
        isLoopingRef.current &&
        loopEndRef.current > loopStartRef.current &&
        t >= loopEndRef.current &&
        isPlayingRef.current
      ) {
        currentTimeRef.current = loopStartRef.current;
        dispatch({ type: 'SET_CURRENT_TIME', payload: loopStartRef.current });
        playFnRef.current?.();
        return;
      }

      // ── Punch in ─────────────────────────────────────────────────────────
      const punchIn  = state.transport.punchIn;
      const punchOut = state.transport.punchOut;

      if (punchArmedRef.current && punchIn != null && t >= punchIn && isPlayingRef.current) {
        punchArmedRef.current  = false;
        punchWritingRef.current = true;
        // Delegate to the full record logic via the ref
        stopRecordingSessionRef.current && stopRecordingSessionRef.current()
          .catch(() => {}).finally(() => { /* already handled */ });
      }

      // ── Punch out ────────────────────────────────────────────────────────
      if (punchWritingRef.current && punchOut != null && t >= punchOut && isRecordingRef.current) {
        punchWritingRef.current = false;
        stopRecordingSessionRef.current?.().catch(() => {});
      }
    });

    const offEnded = eng()!.onEnded((t: number) => {
      currentTimeRef.current = t;
      isPlayingRef.current   = false;
      stopAnimLoop();
      stopMetronome();
      dispatch({ type: 'SET_PLAYING', payload: false });
      dispatch({ type: 'SET_CURRENT_TIME', payload: t });
    });

    const PEAK_HOLD_MS = 2000;

    const rmsToDb = (rms: number) =>
      rms < 0.000001 ? -90 : Math.max(-90, 20 * Math.log10(rms));

    const offLevels = eng()!.onLevels((l: number[]) => {
      const rmsL = l[0] ?? 0;
      const rmsR = l[1] ?? rmsL;
      nativeMasterLevelsRef.current = [rmsL, rmsR];
      const dbL = rmsToDb(rmsL);
      const dbR = rmsToDb(rmsR);
      const now = performance.now();
      const prev = meterValuesRef.current['master'];
      meterValuesRef.current['master'] = {
        L: dbL, R: dbR,
        peakL: prev && prev.peakL > dbL && now < prev.peakLAt ? prev.peakL : dbL,
        peakR: prev && prev.peakR > dbR && now < prev.peakRAt ? prev.peakR : dbR,
        peakLAt: prev && prev.peakL > dbL && now < prev.peakLAt ? prev.peakLAt : now + PEAK_HOLD_MS,
        peakRAt: prev && prev.peakR > dbR && now < prev.peakRAt ? prev.peakRAt : now + PEAK_HOLD_MS,
        clipL: dbL >= 0 || (prev?.clipL ?? false),
        clipR: dbR >= 0 || (prev?.clipR ?? false),
      };
    });

    const offTrackLevels = eng()!.onTrackLevels((levels: Record<string, [number, number]>) => {
      const now = performance.now();
      for (const [trackId, [rmsL, rmsR]] of Object.entries(levels)) {
        const dbL = rmsToDb(rmsL);
        const dbR = rmsToDb(rmsR);
        const prev = meterValuesRef.current[trackId];
        meterValuesRef.current[trackId] = {
          L: dbL, R: dbR,
          peakL: prev && prev.peakL > dbL && now < prev.peakLAt ? prev.peakL : dbL,
          peakR: prev && prev.peakR > dbR && now < prev.peakRAt ? prev.peakR : dbR,
          peakLAt: prev && prev.peakL > dbL && now < prev.peakLAt ? prev.peakLAt : now + PEAK_HOLD_MS,
          peakRAt: prev && prev.peakR > dbR && now < prev.peakRAt ? prev.peakRAt : now + PEAK_HOLD_MS,
          clipL: dbL >= 0 || (prev?.clipL ?? false),
          clipR: dbR >= 0 || (prev?.clipR ?? false),
        };
      }
    });

    const offInputLevels = eng()!.onInputLevels((l: number[]) => {
      // Input levels: update livePeaks for recording indicator
      if (l.length >= 1) livePeaksRef.current = [l[0]];
    });

    const offErr = eng()!.onError((msg: string) => {
      console.error('[NativeAudio]', msg);
    });

    return () => { offPos(); offEnded(); offLevels(); offTrackLevels(); offInputLevels(); offErr(); };
  }, [
    currentTimeRef, dispatch, nativeMasterLevelsRef, livePeaksRef,
    stopAnimLoop, stopMetronome,
    // NOTE: state.transport.punchIn / punchOut intentionally NOT in deps —
    // those are read from the closure via the state captured at mount;
    // punchArmedRef / punchWritingRef refs carry live values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ]);

  // Keep native track params in sync during playback (volume/pan/mute changes)
  useEffect(() => {
    if (!nativeAvailableRef.current || !eng()) return;
    for (const track of state.tracks) {
      eng()!.setTrackParams(track.id, {
        volume: isFinite(track.volume) ? track.volume : 0.8,
        pan:    isFinite(track.pan)    ? Math.max(-1, Math.min(1, track.pan)) : 0,
        muted:  track.isMuted,
      });
    }
  }, [state.tracks]);

  // ── Monitoring: watch isMonitoring flag per track ──────────────────────────

  const monitoringActiveRef = useRef(false);

  useEffect(() => {
    if (!nativeAvailableRef.current || !eng()) return;
    const hasMonitorTrack = state.tracks.some(t => t.isMonitoring);
    if (hasMonitorTrack && !monitoringActiveRef.current) {
      monitoringActiveRef.current = true;
      const prefs = loadAudioPrefs();
      eng()!.startMonitoring(prefs.nativeInputDeviceId, prefs.nativeOutputDeviceId).catch(() => {});
    } else if (!hasMonitorTrack && monitoringActiveRef.current) {
      monitoringActiveRef.current = false;
      eng()!.stopMonitoring().catch(() => {});
    }
  }, [state.tracks]);

  // ── Transport ──────────────────────────────────────────────────────────────

  const play = useCallback(async () => {
    if (!nativeAvailableRef.current || !eng()) return;
    const prefs  = loadAudioPrefs();
    const offset = currentTimeRef.current;
    const specs  = await buildSpecs(offset);

    dispatch({ type: 'SET_PLAYING', payload: true });
    isPlayingRef.current   = true;
    punchArmedRef.current  = state.transport.punchIn != null;
    punchWritingRef.current = false;
    startAnimLoop();

    // Always ensure the Web Audio context is running so bus chunks can flow
    // into masterStreamRef (the WebRTC monitoring stream). Without this, a
    // suspended context silently drops all audio and the engineer hears nothing.
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') await ctx.resume();

    if (state.transport.metronomeOn) {
      startMetronome(ctx, offset);
    }

    await eng()!.play(
      specs, offset,
      prefs.nativeOutputDeviceId !== -1 ? prefs.nativeOutputDeviceId : undefined,
      48000,
    );
  }, [
    buildSpecs, currentTimeRef, dispatch, startAnimLoop, getAudioCtx, startMetronome,
    state.transport.metronomeOn, state.transport.punchIn,
  ]);

  // store play in ref so the position handler (loop) can restart without stale closure
  playFnRef.current = play;

  const pause = useCallback(async () => {
    const _t0 = performance.now();
    console.log(`[AUDIT][Hook][pause] ENTER isPlaying=${isPlayingRef.current} currentTime=${currentTimeRef.current.toFixed(4)}s`);
    isPlayingRef.current   = false;
    punchArmedRef.current  = false;
    punchWritingRef.current = false;
    stopAnimLoop();
    stopMetronome();
    if (isRecordingRef.current) await stopRecordingSessionRef.current?.();
    console.log(`[AUDIT][Hook][pause] sending IPC stop t=${performance.now().toFixed(1)}ms`);
    await eng()?.stop();
    console.log(`[AUDIT][Hook][pause] IPC stop resolved elapsed=${(performance.now() - _t0).toFixed(1)}ms`);
    dispatch({ type: 'SET_PLAYING', payload: false });
  }, [stopAnimLoop, stopMetronome, dispatch, currentTimeRef]);

  const stop = useCallback(async () => {
    isPlayingRef.current   = false;
    punchArmedRef.current  = false;
    punchWritingRef.current = false;
    stopAnimLoop();
    stopMetronome();
    if (isRecordingRef.current) await stopRecordingSessionRef.current?.();
    await eng()?.stop();
    currentTimeRef.current = 0;
    dispatch({ type: 'SET_PLAYING', payload: false });
    dispatch({ type: 'SET_CURRENT_TIME', payload: 0 });
  }, [stopAnimLoop, stopMetronome, currentTimeRef, dispatch]);

  const seek = useCallback(async (t: number) => {
    const clamped = Math.max(0, t);
    currentTimeRef.current = clamped;
    dispatch({ type: 'SET_CURRENT_TIME', payload: clamped });
    await eng()?.seek(clamped);
    // Do NOT call play() — audioEngine.seek() stores seekTarget atomically and
    // paCallback picks it up on the next buffer without restarting the stream.
    // Only restart the metronome scheduler from the new position.
    if (isPlayingRef.current && state.transport.metronomeOn) {
      startMetronome(getAudioCtx(), clamped);
    }
  }, [currentTimeRef, dispatch, getAudioCtx, startMetronome, state.transport.metronomeOn]);

  // ── Recording ──────────────────────────────────────────────────────────────

  const recordingStartDawTimeRef = useRef(0);
  const armedTrackIdRef          = useRef<string | null>(null);

  const stopRecordingSession = useCallback(async () => {
    if (!isRecordingRef.current) return;
    isRecordingRef.current = false;
    console.log('[REC 1] stopRecordingSession — stopping native engine');
    dispatch({ type: 'SET_RECORDING', payload: false });

    await eng()?.stopMonitoring();
    const result = await eng()?.stopRecording();
    if (!result) { console.log('[REC ERROR] stopRecording returned no result'); return; }

    const { filePath, duration } = result;
    console.log('[REC 2] Native engine stopped — filePath:', filePath, 'duration:', duration);
    const trackId     = armedTrackIdRef.current!;
    const trackObj    = state.tracks.find(t => t.id === trackId);
    const trackName   = trackObj?.name ?? 'Track';
    const takeNum     = state.poolItems.filter(p => p.name.startsWith(trackName)).length + 1;
    const takeName    = `${trackName}_Take_${takeNum}`;
    const audioUrl    = `file://${filePath}`;
    const poolItemId  = `pool_${Date.now()}`;

    let peaks:      number[] = [];
    let peaksR:     number[] | null = null;
    let uploadBlob: Blob | null = null;
    try {
      console.log('[REC 3] Fetching recorded file for decode + peaks');
      const resp   = await fetch(audioUrl);
      const ab     = await resp.arrayBuffer();
      console.log('[REC 4] File fetched — bytes:', ab.byteLength);
      uploadBlob   = new Blob([ab]);  // capture before decodeAudioData may detach ab
      const tmpCtx = new AudioContext();
      const buf    = await tmpCtx.decodeAudioData(ab);
      await tmpCtx.close();
      console.log('[REC 5] Audio decoded — channels:', buf.numberOfChannels, 'samples:', buf.length);
      const stereo = await generatePeaksStereo(buf);
      peaks  = stereo.left;
      peaksR = trackObj?.type === 'stereo' ? stereo.right : null;
      console.log('[REC 6] Waveform generated — left:', peaks.length, 'right:', peaksR?.length ?? 0);
    } catch (err) { console.error('[REC ERROR] Decode/peaks failed:', err); }

    console.log('[REC 7] Starting Supabase upload — blob size:', uploadBlob?.size ?? 'fallback fetch');
    const blobForUpload: Blob = uploadBlob !== null ? uploadBlob : await fetch(audioUrl).then(r => r.blob());
    uploadAudioToSupabase(blobForUpload, `${takeName}.wav`).then(({ publicUrl }) => {
      console.log('[REC 11] Upload complete — dispatching UPDATE_AUDIO_URLS');
      if (publicUrl !== audioUrl)
        dispatch({ type: 'UPDATE_AUDIO_URLS', payload: { poolItemId, audioUrl: publicUrl } });
    }).catch((err) => { console.error('[REC ERROR] Upload failed:', err); });

    const poolItem: PoolItem = {
      id: poolItemId, name: takeName, audioUrl,
      localFileName: `${takeName}.wav`,
      duration, createdAt: new Date(),
      waveformPeaks: peaks, waveformPeaksR: peaksR,
    };
    const region: Region = {
      id: `region_${Date.now()}`,
      poolItemId, trackId,
      versionId:     trackObj?.activeVersionId ?? 'default',
      startTime:     recordingStartDawTimeRef.current,
      duration,      name: takeName, audioUrl,
      waveformPeaks:  peaks,
      waveformPeaksR: peaksR,
      sourceDuration: duration,
      sourcePeaks:    peaks,
      sourcePeaksR:   peaksR,
      ...(({ localFilePath: filePath }) as any),
    };

    console.log('[REC 8] Dispatching ADD_POOL_ITEM — id:', poolItemId);
    dispatch({ type: 'ADD_POOL_ITEM', payload: poolItem });
    console.log('[REC 9] ADD_POOL_ITEM dispatched — dispatching ADD_REGION');
    dispatch({ type: 'ADD_REGION',    payload: region });
    console.log('[REC 10] ADD_REGION dispatched — stopRecordingSession complete');
  }, [state.tracks, state.poolItems, dispatch]);

  stopRecordingSessionRef.current = stopRecordingSession;

  const record = useCallback(async () => {
    if (!nativeAvailableRef.current || !eng()) return;
    if (isRecordingRef.current) return;

    const armedTrack = state.tracks.find(t => t.isArmed);
    if (!armedTrack) { alert('Arm a track first.'); return; }

    armedTrackIdRef.current          = armedTrack.id;
    recordingStartDawTimeRef.current = currentTimeRef.current;
    recordingStartTimeRef.current    = currentTimeRef.current;
    livePeaksRef.current             = [];

    const trackName = armedTrack.name;
    const takeNum   = state.poolItems.filter(p => p.name.startsWith(trackName)).length + 1;
    const takeName  = `${trackName}_Take_${takeNum}`;
    const prefs     = loadAudioPrefs();
    const inId      = prefs.nativeInputDeviceId;
    const outId     = prefs.nativeOutputDeviceId;

    // Ensure Web Audio context is running before count-in or metronome scheduling.
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') await ctx.resume();

    // Count-in before recording
    const countInBars = state.transport.countInBars;
    if (countInBars > 0) {
      const beatDur   = 60 / state.transport.tempo;
      for (let i = 0; i < countInBars * state.transport.timeSignature[0]; i++) {
        scheduleClick(ctx, ctx.currentTime + i * beatDur, i % state.transport.timeSignature[0] === 0);
      }
      await new Promise<void>(res => setTimeout(res, countInBars * state.transport.timeSignature[0] * beatDur * 1000));
    }

    const filePath = await eng()!.getTakePath(takeName);

    dispatch({ type: 'SET_RECORDING', payload: true });
    dispatch({ type: 'SET_PLAYING',   payload: true });
    isPlayingRef.current   = true;
    isRecordingRef.current = true;
    startAnimLoop();

    if (state.transport.metronomeOn) {
      startMetronome(ctx, currentTimeRef.current);
    }

    if (armedTrack.isMonitoring) {
      monitoringActiveRef.current = true;
      await eng()!.startMonitoring(inId, outId);
    }

    const inputChOffset = Math.max(0, (armedTrack.inputChannel ?? 1) - 1);
    await eng()!.startRecording(filePath, inId, outId, 48000, 2, currentTimeRef.current, inputChOffset);

    // Always call play so the position clock runs and the live waveform draws,
    // even on an empty timeline (specs can be [] for a first-take recording).
    const specs = await buildSpecs(currentTimeRef.current);
    await eng()!.play(specs, currentTimeRef.current, outId !== -1 ? outId : undefined, 48000);
  }, [
    state.tracks, state.poolItems, state.transport,
    currentTimeRef, recordingStartTimeRef, livePeaksRef,
    dispatch, buildSpecs, startAnimLoop, getAudioCtx, startMetronome, scheduleClick,
  ]);

  // ── Cleanup ────────────────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      stopAnimLoop();
      stopMetronome();
      eng()?.stop().catch(() => {});
      eng()?.stopMonitoring().catch(() => {});
    };
  }, [stopAnimLoop, stopMetronome]);

  // ── Expose masterGainRef for OfflineAudioContext callers ───────────────────
  // The Web Audio master gain node is still wired up by DawContext; we just
  // ensure the AudioContext is alive so export utils can use OfflineAudioContext.
  useEffect(() => {
    const gain = masterGainRef.current;
    if (!gain) return;
    // no-op: masterGainRef is managed by DawContext
  }, [masterGainRef]);

  return {
    play,
    pause,
    stop,
    record,
    seek,
    stopRecordingSession,
    initAudioCtx: getAudioCtx,
    nativeAvailable,
  };
};
