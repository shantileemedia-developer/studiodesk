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
  const projectEndRef = useRef(0);
  useEffect(() => {
    projectEndRef.current = state.regions.reduce(
      (max, r) => Math.max(max, r.startTime + r.duration), 0,
    ) + 2; // 2 s tail
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
    // Already an OS path (native recordings)
    if (!url.startsWith('blob:') && !url.startsWith('http')) return url;
    const cached = tempCacheRef.current.get(url);
    if (cached) return cached;
    if (!eng()) return null;
    try {
      const resp = await fetch(url);
      const ab   = await resp.arrayBuffer();
      // Use a stable name derived from the URL
      const name = `audio_${Math.abs(url.split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0))}.wav`;
      const path = await eng()!.writeTemp(name, ab);
      tempCacheRef.current.set(url, path);
      return path;
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

  const getAudioCtx = useCallback((): AudioContext => {
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      audioCtxRef.current = new AudioContext({ sampleRate: 48000 });
    }
    return audioCtxRef.current;
  }, [audioCtxRef]);

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

    const offPos = eng()!.onPosition(async (t: number) => {
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

    const offLevels = eng()!.onLevels((l: number[]) => {
      // Feed master VU meters without going through Web Audio
      nativeMasterLevelsRef.current = [l[0] ?? 0, l[1] ?? l[0] ?? 0];
    });

    const offInputLevels = eng()!.onInputLevels((l: number[]) => {
      // Input levels: update livePeaks for recording indicator
      if (l.length >= 1) livePeaksRef.current = [l[0]];
    });

    const offErr = eng()!.onError((msg: string) => {
      console.error('[NativeAudio]', msg);
    });

    return () => { offPos(); offEnded(); offLevels(); offInputLevels(); offErr(); };
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

    if (state.transport.metronomeOn) {
      const ctx = getAudioCtx();
      if (ctx.state === 'suspended') await ctx.resume();
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
    isPlayingRef.current   = false;
    punchArmedRef.current  = false;
    punchWritingRef.current = false;
    stopAnimLoop();
    stopMetronome();
    if (isRecordingRef.current) await stopRecordingSessionRef.current?.();
    await eng()?.stop();
    dispatch({ type: 'SET_PLAYING', payload: false });
  }, [stopAnimLoop, stopMetronome, dispatch]);

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
    if (isPlayingRef.current) {
      const specs = await buildSpecs(clamped);
      const prefs = loadAudioPrefs();
      if (state.transport.metronomeOn) startMetronome(getAudioCtx(), clamped);
      await eng()!.play(
        specs, clamped,
        prefs.nativeOutputDeviceId !== -1 ? prefs.nativeOutputDeviceId : undefined,
        48000,
      );
    }
  }, [buildSpecs, currentTimeRef, dispatch, getAudioCtx, startMetronome, state.transport.metronomeOn]);

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

    // Count-in before recording
    const countInBars = state.transport.countInBars;
    if (countInBars > 0) {
      const ctx       = getAudioCtx();
      if (ctx.state === 'suspended') await ctx.resume();
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
      const ctx = getAudioCtx();
      if (ctx.state === 'suspended') await ctx.resume();
      startMetronome(ctx, currentTimeRef.current);
    }

    if (armedTrack.isMonitoring) {
      monitoringActiveRef.current = true;
      await eng()!.startMonitoring(inId, outId);
    }

    await eng()!.startRecording(filePath, inId, outId, 48000, 2);

    // Overdub: play existing regions alongside the new recording
    const specs = await buildSpecs(currentTimeRef.current);
    if (specs.length > 0) {
      await eng()!.play(specs, currentTimeRef.current, outId !== -1 ? outId : undefined, 48000);
    }
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
