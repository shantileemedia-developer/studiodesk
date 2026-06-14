import { useRef, useCallback, useEffect } from 'react';
import { useDaw } from '../context/DawContext';
import type { Region, PoolItem } from '../context/DawContext';
import { generatePeaksStereo, uploadAudioToSupabase, saveToAudioFolder } from '../utils/audioUtils';
import { loadAudioPrefs } from '../components/daw/AudioMIDIPreferencesDialog';

const CLICK_LOOKAHEAD_S = 0.15;  // schedule this many seconds ahead
const CLICK_INTERVAL_MS = 25;    // scheduler polling interval (ms)

export const useAudioEngine = () => {
  const { state, dispatch, currentTimeRef, audioCtxRef, recordingStartTimeRef, livePeaksRef, trackAnalysersRef, trackGainsRef, trackPannersRef, userRole, masterStreamRef, audioDirHandle } = useDaw();

  const animFrameRef = useRef<number | null>(null);
  const playStartAudioTimeRef = useRef<number>(0);
  const playStartDawTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingStartDawTimeRef = useRef<number>(0);
  const armedTrackIdRef = useRef<string | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  // Track last dispatch time to avoid 60fps React state updates
  const lastDispatchTimeRef = useRef<number>(0);
  // Incremented by stop/pause to cancel any in-progress play() after its decode phase
  const playIdRef = useRef(0);
  // Cache decoded AudioBuffers so 2nd+ plays are instant
  const bufferCacheRef = useRef<Map<string, AudioBuffer>>(new Map());
  const clickSourcesRef  = useRef<any[]>([]);
  const nextClickTimeRef = useRef(0);
  const clickBeatRef     = useRef(0);
  const clickIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tempoRef         = useRef(state.transport.tempo);
  const timeSigRef       = useRef<[number, number]>(state.transport.timeSignature as [number, number]);

  const getAudioCtx = useCallback(() => {
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      try {
        const prefs = loadAudioPrefs();
        const ctx = new AudioContext({ sampleRate: prefs.sampleRate });
        audioCtxRef.current = ctx;
        if (prefs.outputDeviceId !== 'default' && 'setSinkId' in ctx) {
          (ctx as any).setSinkId(prefs.outputDeviceId).catch(() => {});
        }
        if (userRole === 'artist') {
          masterStreamRef.current = ctx.createMediaStreamDestination();
        }
      } catch (err) {
        console.error('[AudioCtx] Failed to create AudioContext:', err);
      }
    }
    return audioCtxRef.current!;
  }, [audioCtxRef, masterStreamRef, userRole]);

  // Keep refs current so the live metronome scheduler reads the latest values
  useEffect(() => { tempoRef.current = state.transport.tempo; }, [state.transport.tempo]);
  useEffect(() => { timeSigRef.current = state.transport.timeSignature as [number, number]; }, [state.transport.timeSignature]);

  const scheduleClick = useCallback((ctx: AudioContext, time: number, isAccent: boolean) => {
    const DUR = 0.022;
    // Noise burst — sharp transient attack of a wood block
    const smpCt = Math.floor(ctx.sampleRate * DUR);
    const nBuf  = ctx.createBuffer(1, smpCt, ctx.sampleRate);
    const nData = nBuf.getChannelData(0);
    for (let i = 0; i < smpCt; i++) nData[i] = Math.random() * 2 - 1;
    const nSrc = ctx.createBufferSource();
    nSrc.buffer = nBuf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = isAccent ? 2000 : 1100;
    hp.Q.value = 1;
    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(0, time);
    nGain.gain.linearRampToValueAtTime(isAccent ? 1.1 : 0.65, time + 0.001);
    nGain.gain.exponentialRampToValueAtTime(0.001, time + DUR);
    nSrc.connect(hp); hp.connect(nGain);
    nGain.connect(ctx.destination);
    if (masterStreamRef.current) nGain.connect(masterStreamRef.current);
    nSrc.start(time); nSrc.stop(time + DUR + 0.002);
    clickSourcesRef.current.push(nSrc);
    // Pitched tone — resonant body of the wood block
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(isAccent ? 1800 : 900, time);
    osc.frequency.exponentialRampToValueAtTime(isAccent ? 700 : 380, time + DUR);
    const oGain = ctx.createGain();
    oGain.gain.setValueAtTime(isAccent ? 0.45 : 0.28, time);
    oGain.gain.exponentialRampToValueAtTime(0.001, time + DUR);
    osc.connect(oGain);
    oGain.connect(ctx.destination);
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

  const startMetronome = useCallback((ctx: AudioContext) => {
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
  }, [scheduleClick]);


  const stopAnimLoop = useCallback(() => {
    if (animFrameRef.current !== null) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
  }, []);

  const startAnimLoop = useCallback((ctx: AudioContext) => {
    stopAnimLoop();
    const tick = () => {
      // Clamp to 0 so the transport cursor doesn't run ahead during the lookahead window
      const elapsed = Math.max(0, ctx.currentTime - playStartAudioTimeRef.current);
      let dawTime = playStartDawTimeRef.current + elapsed;

      // Handle looping
      if (state.transport.isLooping && state.transport.loopEnd > state.transport.loopStart) {
        if (dawTime >= state.transport.loopEnd) {
          // Simple visual loop - audio nodes would actually need rescheduling for seamless loop
          // But for this prototype, we'll just snap the playhead back
          const loopLen = state.transport.loopEnd - state.transport.loopStart;
          dawTime = state.transport.loopStart + ((dawTime - state.transport.loopStart) % loopLen);
          playStartAudioTimeRef.current = ctx.currentTime;
          playStartDawTimeRef.current = dawTime;
          // Note: Seamless audio looping requires look-ahead scheduling, omitted for brevity
        }
      }

      currentTimeRef.current = dawTime;
      // Only push to React state ~10fps to avoid flooding renders
      if (ctx.currentTime - lastDispatchTimeRef.current > 0.1) {
        dispatch({ type: 'SET_CURRENT_TIME', payload: dawTime });
        lastDispatchTimeRef.current = ctx.currentTime;
      }
      animFrameRef.current = requestAnimationFrame(tick);
    };
    animFrameRef.current = requestAnimationFrame(tick);
  }, [stopAnimLoop, currentTimeRef, dispatch]);

  const play = useCallback(async () => {
    try {
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') await ctx.resume();

    // Capture a generation ID so stop()/pause() can abort an in-progress decode
    const playId = ++playIdRef.current;
    const offset = currentTimeRef.current;

    dispatch({ type: 'SET_PLAYING', payload: true });

    // Build per-track mix buses synchronously before any awaits
    const hasSolo = state.tracks.some(t => t.isSolo);
    const playableTracks = new Set(
      state.tracks
        .filter(t => !t.isMuted && (!hasSolo || t.isSolo))
        .map(t => t.id)
    );

    const trackBusses: Record<string, { gain: GainNode; analyser: AnalyserNode }> = {};
    trackGainsRef.current   = {};
    trackPannersRef.current = {};
    for (const track of state.tracks) {
      const gain = ctx.createGain();
      gain.gain.value = isFinite(track.volume) ? track.volume : 0.8;

      const panner = ctx.createStereoPanner();
      panner.pan.value = isFinite(track.pan) ? Math.max(-1, Math.min(1, track.pan)) : 0;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.75;

      gain.connect(panner);
      panner.connect(analyser);
      analyser.connect(ctx.destination);
      if (masterStreamRef.current) analyser.connect(masterStreamRef.current);

      trackBusses[track.id] = { gain, analyser };
      trackAnalysersRef.current[track.id] = analyser;
      trackGainsRef.current[track.id]     = gain;
      trackPannersRef.current[track.id]   = panner;
    }

    const playableRegions = state.regions.filter(region =>
      playableTracks.has(region.trackId) &&
      !region.isMuted &&
      region.audioUrl &&
      region.startTime + region.duration > offset
    );

    // Decode ALL audio first — before locking in the schedule time.
    // This ensures the playhead and audio always start in sync, even for large files.
    // Decoded buffers are cached by URL so 2nd+ plays are instant.
    const decoded = await Promise.all(playableRegions.map(async (region) => {
      try {
        let audioBuffer = bufferCacheRef.current.get(region.audioUrl);
        if (!audioBuffer) {
          const response = await fetch(region.audioUrl);
          const arrayBuffer = await response.arrayBuffer();
          audioBuffer = await ctx.decodeAudioData(arrayBuffer);
          bufferCacheRef.current.set(region.audioUrl, audioBuffer);
        }
        return { region, audioBuffer };
      } catch {
        return null;
      }
    }));

    // If stop() or pause() was called during decode, bail out — don't start audio
    if (playId !== playIdRef.current) return;

    // Detect crossfades: when two clips on the same track overlap, the overlapping
    // portion fades out clip A and fades in clip B automatically.
    const effectiveFades = new Map<string, { fadeIn: number; fadeOut: number }>();
    const byTrack = new Map<string, typeof decoded>();
    for (const item of decoded) {
      if (!item) continue;
      const arr = byTrack.get(item.region.trackId) ?? [];
      arr.push(item);
      byTrack.set(item.region.trackId, arr);
    }
    for (const clips of byTrack.values()) {
      clips.sort((a, b) => a!.region.startTime - b!.region.startTime);
      for (let i = 0; i + 1 < clips.length; i++) {
        const a = clips[i]!;
        const b = clips[i + 1]!;
        const overlap = (a.region.startTime + a.region.duration) - b.region.startTime;
        if (overlap > 0.01) {
          const af = effectiveFades.get(a.region.id) ?? { fadeIn: a.region.fadeIn ?? 0, fadeOut: a.region.fadeOut ?? 0 };
          af.fadeOut = Math.max(af.fadeOut, overlap);
          effectiveFades.set(a.region.id, af);
          const bf = effectiveFades.get(b.region.id) ?? { fadeIn: b.region.fadeIn ?? 0, fadeOut: b.region.fadeOut ?? 0 };
          bf.fadeIn = Math.max(bf.fadeIn, overlap);
          effectiveFades.set(b.region.id, bf);
        }
      }
    }

    // Lock in the schedule time NOW — everything below is synchronous,
    // so the gap between scheduleStart and source.start() is negligible
    const LOOKAHEAD = 0.05;
    const scheduleStart = ctx.currentTime + LOOKAHEAD;
    playStartAudioTimeRef.current = scheduleStart;
    playStartDawTimeRef.current = offset;
    startAnimLoop(ctx);

    for (const item of decoded) {
      if (!item) continue;
      const { region, audioBuffer } = item;

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;

      const whenInAudio    = scheduleStart + Math.max(0, region.startTime - offset);
      const timeIntoRegion = Math.max(0, offset - region.startTime);
      const fileOffset     = (region.audioOffset ?? 0) + timeIntoRegion;
      const playDuration   = region.duration - timeIntoRegion;

      const bus = trackBusses[region.trackId];
      if (bus) {
        const ef = effectiveFades.get(region.id);
        const fi = ef ? ef.fadeIn  : (region.fadeIn  ?? 0);
        const fo = ef ? ef.fadeOut : (region.fadeOut ?? 0);
        if (fi > 0 || fo > 0) {
          const fg = ctx.createGain();
          if (fi > 0) {
            if (timeIntoRegion >= fi) {
              fg.gain.setValueAtTime(1, whenInAudio);
            } else {
              const startGain = timeIntoRegion / fi;
              fg.gain.setValueAtTime(startGain, whenInAudio);
              fg.gain.linearRampToValueAtTime(1, whenInAudio + (fi - timeIntoRegion));
            }
          } else {
            fg.gain.setValueAtTime(1, whenInAudio);
          }
          if (fo > 0) {
            const foStart = whenInAudio + Math.max(0, region.duration - fo - timeIntoRegion);
            fg.gain.setValueAtTime(1, foStart);
            fg.gain.linearRampToValueAtTime(0, whenInAudio + playDuration);
          }
          source.connect(fg);
          fg.connect(bus.gain);
        } else {
          source.connect(bus.gain);
        }
      }

      source.start(whenInAudio, fileOffset, playDuration);
      activeSourcesRef.current.push(source);
    }

    if (state.transport.metronomeOn) {
      const bps = state.transport.tempo / 60;
      clickBeatRef.current = Math.ceil(playStartDawTimeRef.current * bps);
      nextClickTimeRef.current = playStartAudioTimeRef.current +
        (clickBeatRef.current / bps - playStartDawTimeRef.current);
      startMetronome(ctx);
    }

  } catch (err) {
    console.error('[AudioEngine] play() error:', err);
  }
  }, [state, dispatch, currentTimeRef, getAudioCtx, startAnimLoop, startMetronome, masterStreamRef]);

  const stopSources = useCallback(() => {
    activeSourcesRef.current.forEach(s => { try { s.stop(); } catch { /* already stopped */ } });
    activeSourcesRef.current = [];
    trackAnalysersRef.current = {};
    trackGainsRef.current   = {};
    trackPannersRef.current = {};
  }, [trackAnalysersRef, trackGainsRef, trackPannersRef]);

  // Live fader/mute/pan — push track changes to active audio nodes immediately
  useEffect(() => {
    const hasSolo = state.tracks.some(t => t.isSolo);
    const now = audioCtxRef.current?.currentTime ?? 0;
    for (const track of state.tracks) {
      const gain   = trackGainsRef.current[track.id];
      const panner = trackPannersRef.current[track.id];
      if (!gain) continue;
      const muted  = track.isMuted || (hasSolo && !track.isSolo);
      const target = muted ? 0 : (isFinite(track.volume) ? track.volume : 0.8);
      gain.gain.setTargetAtTime(target, now, 0.015);
      if (panner) {
        const panVal = isFinite(track.pan) ? Math.max(-1, Math.min(1, track.pan)) : 0;
        panner.pan.setTargetAtTime(panVal, now, 0.015);
      }
    }
  }, [state.tracks, trackGainsRef, trackPannersRef, audioCtxRef]);

  const stopRecordingSession = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    dispatch({ type: 'SET_RECORDING', payload: false });
  }, [dispatch]);

  // Pause: halt playback but keep the playhead position
  const pause = useCallback(() => {
    ++playIdRef.current;
    stopAnimLoop();
    stopSources();
    stopMetronome();
    stopRecordingSession();
    dispatch({ type: 'SET_PLAYING', payload: false });
  }, [stopAnimLoop, stopSources, stopMetronome, stopRecordingSession, dispatch]);

  // Stop: halt playback AND return to zero
  const stop = useCallback(() => {
    ++playIdRef.current;
    stopAnimLoop();
    stopSources();
    stopMetronome();
    stopRecordingSession();
    currentTimeRef.current = 0;
    lastDispatchTimeRef.current = 0;
    dispatch({ type: 'SET_PLAYING', payload: false });
    dispatch({ type: 'SET_CURRENT_TIME', payload: 0 });
  }, [stopAnimLoop, stopSources, stopMetronome, stopRecordingSession, dispatch, currentTimeRef]);

  const record = useCallback(async () => {
    if (userRole === 'engineer') {
      // Engineer's local playhead just starts moving, but audio capture happens on Artist side.
      const ctx = getAudioCtx();
      playStartAudioTimeRef.current = ctx.currentTime;
      playStartDawTimeRef.current = currentTimeRef.current;
      dispatch({ type: 'SET_RECORDING', payload: true });
      dispatch({ type: 'SET_PLAYING', payload: true });
      startAnimLoop(ctx);
      return;
    }

    const armedTrack = state.tracks.find(t => t.isArmed);
    if (!armedTrack) {
      alert('Arm a track first — click the R button on a track.');
      return;
    }

    let stream: MediaStream;
    try {
      const prefs = loadAudioPrefs();
      const audioConstraint: MediaTrackConstraints | boolean =
        prefs.inputDeviceId !== 'default'
          ? { deviceId: { exact: prefs.inputDeviceId } }
          : true;
      stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint, video: false });
    } catch (err: any) {
      const msg = err?.name === 'NotAllowedError'
        ? 'Microphone access denied. Allow microphone access and try again.'
        : `Microphone error: ${err?.message ?? err}`;
      alert(msg);
      dispatch({ type: 'SET_RECORDING', payload: false });
      return;
    }

    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') await ctx.resume();

    armedTrackIdRef.current = armedTrack.id;
    recordingStartDawTimeRef.current = currentTimeRef.current;
    recordingStartTimeRef.current = currentTimeRef.current;
    recordingChunksRef.current = [];
    livePeaksRef.current = [];

    // Tap the mic through the track's monitoring chain (volume + pan)
    const micSource = ctx.createMediaStreamSource(stream);
    const monGain   = ctx.createGain();
    const monPanner = ctx.createStereoPanner();
    const analyser  = ctx.createAnalyser();
    analyser.fftSize = 256;
    monGain.gain.value   = isFinite(armedTrack.volume) ? armedTrack.volume : 0.8;
    monPanner.pan.value  = isFinite(armedTrack.pan)    ? Math.max(-1, Math.min(1, armedTrack.pan)) : 0;
    micSource.connect(monGain);
    monGain.connect(monPanner);
    monPanner.connect(analyser);
    if (masterStreamRef.current) monPanner.connect(masterStreamRef.current);
    // Store in refs so live fader/pan moves affect monitoring during recording
    trackGainsRef.current[armedTrack.id]   = monGain;
    trackPannersRef.current[armedTrack.id] = monPanner;
    micSourceRef.current = micSource;
    analyserRef.current  = analyser;

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    const mediaRecorder = new MediaRecorder(stream, { mimeType });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        recordingChunksRef.current.push(e.data);
        // Sample analyser for live waveform (~10 peaks/sec at 100ms chunks)
        if (analyserRef.current) {
          const data = new Uint8Array(analyserRef.current.fftSize);
          analyserRef.current.getByteTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) {
            const v = (data[i] / 128) - 1;
            sum += v * v;
          }
          livePeaksRef.current.push(Math.sqrt(sum / data.length));
        }
      }
    };

    mediaRecorder.onstop = async () => {
      if (micSourceRef.current) { micSourceRef.current.disconnect(); micSourceRef.current = null; }
      analyserRef.current = null;
      delete trackGainsRef.current[armedTrack.id];
      delete trackPannersRef.current[armedTrack.id];
      stream.getTracks().forEach(t => t.stop());

      const blob = new Blob(recordingChunksRef.current, { type: mimeType });

      let peaks: number[] = [];
      let peaksR: number[] | null = null;
      let duration = 0;
      let decodedBuffer: AudioBuffer | null = null;
      try {
        const ab = await blob.arrayBuffer();
        decodedBuffer = await ctx.decodeAudioData(ab);
        const stereo = await generatePeaksStereo(decodedBuffer);
        peaks = stereo.left;
        // Only carry stereo peaks if the armed track is a stereo track
        const armedTrack = state.tracks.find(t => t.id === armedTrackIdRef.current);
        peaksR = armedTrack?.type === 'stereo' ? stereo.right : null;
        duration = decodedBuffer.duration;
      } catch {
        duration = currentTimeRef.current - recordingStartDawTimeRef.current;
      }

      const currentTrackId = armedTrackIdRef.current!;
      const trackName = state.tracks.find(t => t.id === currentTrackId)?.name ?? 'Track';
      const takeNum = state.poolItems.filter(p => p.name.startsWith(trackName)).length + 1;
      const name = `${trackName}_Take_${takeNum}`;

      // PRIMARY: blob URL — works instantly, no network dependency
      const audioUrl = URL.createObjectURL(blob);

      // Save as 24-bit WAV into the project's Audio/ folder
      if (audioDirHandle && decodedBuffer) {
        saveToAudioFolder(audioDirHandle, name, decodedBuffer).catch(err =>
          console.error(`Audio/ WAV save failed for ${name}:`, err)
        );
      }

      const poolItemId = `pool_${Date.now()}`;

      // BACKGROUND: Supabase cloud backup — once done, update URLs so project.json gets a shareable link
      uploadAudioToSupabase(blob, `${name}.wav`).then(supabaseUrl => {
        if (supabaseUrl && supabaseUrl !== audioUrl) {
          dispatch({ type: 'UPDATE_AUDIO_URLS', payload: { poolItemId, audioUrl: supabaseUrl } });
        }
      }).catch(() => {});

      const poolItem: PoolItem = {
        id: poolItemId,
        name,
        audioUrl,
        localFileName: `${name}.wav`,
        duration,
        createdAt: new Date(),
        waveformPeaks: peaks,
        waveformPeaksR: peaksR,
      };

      const armedTrackObj = state.tracks.find(t => t.id === currentTrackId);
      const region: Region = {
        id: `region_${Date.now()}`,
        poolItemId,
        trackId: currentTrackId,
        versionId: armedTrackObj?.activeVersionId ?? 'default',
        startTime: recordingStartDawTimeRef.current,
        duration,
        name,
        audioUrl,
        waveformPeaks: peaks,
        waveformPeaksR: peaksR,
        sourceDuration: duration,
        sourcePeaks:  peaks,
        sourcePeaksR: peaksR,
      };

      dispatch({ type: 'ADD_POOL_ITEM', payload: poolItem });
      dispatch({ type: 'ADD_REGION', payload: region });
    };

    const startRecordingSession = () => {
      // Capture a generation ID so stop() can abort in-flight overdub decodes
      const recId = ++playIdRef.current;
      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start(100);

      playStartAudioTimeRef.current = ctx.currentTime;
      playStartDawTimeRef.current = currentTimeRef.current;
      dispatch({ type: 'SET_RECORDING', payload: true });
      dispatch({ type: 'SET_PLAYING', payload: true });
      startAnimLoop(ctx);

      // ── Overdub: schedule existing region sources so they play back
      // alongside the new recording (same logic as play(), but after
      // the record start position is locked in).
      const hasSolo = state.tracks.some(t => t.isSolo);
      const playableTracks = new Set(
        state.tracks
          .filter(t => !t.isMuted && (!hasSolo || t.isSolo) && !t.isArmed)
          .map(t => t.id)
      );

      const trackBusses: Record<string, { gain: GainNode; analyser: AnalyserNode }> = {};
      trackGainsRef.current = {};
      for (const track of state.tracks) {
        if (!playableTracks.has(track.id)) continue;
        const gain = ctx.createGain();
        gain.gain.value = isFinite(track.volume) ? track.volume : 0.8;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.75;
        gain.connect(analyser);
        analyser.connect(ctx.destination);
        if (masterStreamRef.current) analyser.connect(masterStreamRef.current);
        trackBusses[track.id] = { gain, analyser };
        trackAnalysersRef.current[track.id] = analyser;
        trackGainsRef.current[track.id]     = gain;
      }

      const offset = currentTimeRef.current;
      for (const region of state.regions) {
        if (!playableTracks.has(region.trackId)) continue;
        if (region.isMuted) continue;
        if (!region.audioUrl) continue;
        if (region.startTime + region.duration <= offset) continue;

        // Fetch + schedule asynchronously — OK since these are pre-recorded clips
        const cachedBuf = bufferCacheRef.current.get(region.audioUrl);
        (cachedBuf
          ? Promise.resolve(cachedBuf)
          : fetch(region.audioUrl)
              .then(r => r.arrayBuffer())
              .then(ab => ctx.decodeAudioData(ab))
              .then(buf => { bufferCacheRef.current.set(region.audioUrl, buf); return buf; })
        ).then(audioBuffer => {
            if (recId !== playIdRef.current) return; // stop was pressed
            const source = ctx.createBufferSource();
            source.buffer = audioBuffer;
            const bus = trackBusses[region.trackId];
            if (bus) source.connect(bus.gain);
            const whenInAudio  = playStartAudioTimeRef.current + Math.max(0, region.startTime - offset);
            const fileOffset   = (region.audioOffset ?? 0) + Math.max(0, offset - region.startTime);
            const playDuration = region.duration - Math.max(0, offset - region.startTime);
            source.start(whenInAudio, fileOffset, playDuration);
            activeSourcesRef.current.push(source);
          })
          .catch(() => { /* skip undecodable */ });
      }

      if (state.transport.metronomeOn) {
        const bps = state.transport.tempo / 60;
        clickBeatRef.current = Math.ceil(playStartDawTimeRef.current * bps);
        nextClickTimeRef.current = playStartAudioTimeRef.current +
          (clickBeatRef.current / bps - playStartDawTimeRef.current);
        startMetronome(ctx);
      }
    };

    const countInBars = state.transport.countInBars;
    if (countInBars > 0) {
      const bps = state.transport.tempo / 60;
      const beatDuration = 1 / bps;
      for (let i = 0; i < countInBars * 4; i++) {
        scheduleClick(ctx, ctx.currentTime + (i * beatDuration), i % 4 === 0);
      }
      setTimeout(startRecordingSession, (countInBars * 4 * beatDuration) * 1000);
    } else {
      startRecordingSession();
    }
  }, [state, dispatch, currentTimeRef, getAudioCtx, startAnimLoop, scheduleClick, startMetronome, userRole, masterStreamRef]);

  // Restart click scheduler immediately when tempo or time signature changes during playback
  useEffect(() => {
    if (!state.transport.isPlaying || !state.transport.metronomeOn) return;
    const ctx = audioCtxRef.current;
    if (!ctx || ctx.state !== 'running') return;
    stopMetronome();
    const bps = state.transport.tempo / 60;
    clickBeatRef.current = Math.round(currentTimeRef.current * bps);
    nextClickTimeRef.current = ctx.currentTime + 0.02;
    startMetronome(ctx);
  // Only react to tempo/sig changes; isPlaying/metronomeOn are guards checked inside
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.transport.tempo, state.transport.timeSignature]);

  return { play, pause, stop, record, stopRecordingSession, initAudioCtx: getAudioCtx };
};
