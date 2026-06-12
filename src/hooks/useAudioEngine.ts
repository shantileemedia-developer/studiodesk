import { useRef, useCallback, useEffect } from 'react';
import { useDaw } from '../context/DawContext';
import type { Region, PoolItem } from '../context/DawContext';
import { generatePeaksStereo, uploadAudioToSupabase } from '../utils/audioUtils';
import { loadAudioPrefs } from '../components/daw/AudioMIDIPreferencesDialog';

export const useAudioEngine = () => {
  const { state, dispatch, currentTimeRef, audioCtxRef, recordingStartTimeRef, livePeaksRef, trackAnalysersRef, trackGainsRef, userRole, masterStreamRef, audioDirHandle } = useDaw();

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

  const getAudioCtx = useCallback(() => {
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      const prefs = loadAudioPrefs();
      const ctx = new AudioContext({ sampleRate: prefs.sampleRate });
      audioCtxRef.current = ctx;
      if (prefs.outputDeviceId !== 'default' && 'setSinkId' in ctx) {
        (ctx as any).setSinkId(prefs.outputDeviceId).catch(() => {});
      }
      if (userRole === 'artist') {
        masterStreamRef.current = ctx.createMediaStreamDestination();
      }
    }
    return audioCtxRef.current;
  }, [audioCtxRef, masterStreamRef, userRole]);

  const scheduleClick = useCallback((ctx: AudioContext, time: number, isAccent: boolean) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(isAccent ? 1200 : 800, time);
    osc.frequency.exponentialRampToValueAtTime(0.01, time + 0.1);
    gain.gain.setValueAtTime(0.5, time);
    gain.gain.exponentialRampToValueAtTime(0.01, time + 0.1);
    osc.connect(gain);
    gain.connect(ctx.destination);
    if (masterStreamRef.current) gain.connect(masterStreamRef.current);
    osc.start(time);
    osc.stop(time + 0.1);
    activeSourcesRef.current.push(osc as any);
  }, [masterStreamRef]);


  const stopAnimLoop = useCallback(() => {
    if (animFrameRef.current !== null) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
  }, []);

  const startAnimLoop = useCallback((ctx: AudioContext) => {
    stopAnimLoop();
    const tick = () => {
      const elapsed = ctx.currentTime - playStartAudioTimeRef.current;
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
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') await ctx.resume();

    const offset = currentTimeRef.current;
    playStartAudioTimeRef.current = ctx.currentTime;
    playStartDawTimeRef.current = offset;

    dispatch({ type: 'SET_PLAYING', payload: true });
    startAnimLoop(ctx);

    // Load and schedule all non-muted regions that overlap current time
    const hasSolo = state.tracks.some(t => t.isSolo);
    const playableTracks = new Set(
      state.tracks
        .filter(t => !t.isMuted && (!hasSolo || t.isSolo))
        .map(t => t.id)
    );

    const trackBusses: Record<string, { gain: GainNode; analyser: AnalyserNode }> = {};
    trackGainsRef.current = {};
    for (const track of state.tracks) {
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

    for (const region of state.regions) {
      if (!playableTracks.has(region.trackId)) continue;
      if (region.isMuted) continue;
      if (!region.audioUrl) continue;
      if (region.startTime + region.duration <= offset) continue;

      try {
        const response = await fetch(region.audioUrl);
        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;

        const bus = trackBusses[region.trackId];
        if (bus) {
          source.connect(bus.gain);
        }

        const whenInAudio    = playStartAudioTimeRef.current + Math.max(0, region.startTime - offset);
        // audioOffset shifts into the source file for split regions
        const fileOffset     = (region.audioOffset ?? 0) + Math.max(0, offset - region.startTime);
        // limit playback to the region duration so split regions don't bleed
        const playDuration   = region.duration - Math.max(0, offset - region.startTime);

        source.start(whenInAudio, fileOffset, playDuration);
        activeSourcesRef.current.push(source);
      } catch {
        // Skip regions with undecodable audio
      }
    }

    if (state.transport.metronomeOn) {
      const bps = state.transport.tempo / 60;
      const beatDuration = 1 / bps;
      let currentBeat = Math.ceil(playStartDawTimeRef.current * bps);
      for (let i = 0; i < 500; i++) {
        const beatTime = (currentBeat + i) * beatDuration;
        const when = playStartAudioTimeRef.current + (beatTime - playStartDawTimeRef.current);
        if (when >= ctx.currentTime) {
          scheduleClick(ctx, when, (currentBeat + i) % 4 === 0);
        }
      }
    }

  }, [state, dispatch, currentTimeRef, getAudioCtx, startAnimLoop, scheduleClick, userRole, masterStreamRef]);

  const stopSources = useCallback(() => {
    activeSourcesRef.current.forEach(s => { try { s.stop(); } catch { /* already stopped */ } });
    activeSourcesRef.current = [];
    trackAnalysersRef.current = {};
    trackGainsRef.current = {};
  }, [trackAnalysersRef, trackGainsRef]);

  // Live fader/mute — push track volume changes to active GainNodes immediately
  useEffect(() => {
    const hasSolo = state.tracks.some(t => t.isSolo);
    for (const track of state.tracks) {
      const gain = trackGainsRef.current[track.id];
      if (!gain) continue;
      const muted  = track.isMuted || (hasSolo && !track.isSolo);
      const target = muted ? 0 : (isFinite(track.volume) ? track.volume : 0.8);
      gain.gain.setTargetAtTime(target, audioCtxRef.current?.currentTime ?? 0, 0.015);
    }
  }, [state.tracks, trackGainsRef, audioCtxRef]);

  const stopRecordingSession = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    dispatch({ type: 'SET_RECORDING', payload: false });
  }, [dispatch]);

  // Pause: halt playback but keep the playhead position
  const pause = useCallback(() => {
    stopAnimLoop();
    stopSources();
    stopRecordingSession();
    dispatch({ type: 'SET_PLAYING', payload: false });
  }, [stopAnimLoop, stopSources, stopRecordingSession, dispatch]);

  // Stop: halt playback AND return to zero
  const stop = useCallback(() => {
    stopAnimLoop();
    stopSources();
    stopRecordingSession();
    currentTimeRef.current = 0;
    lastDispatchTimeRef.current = 0;
    dispatch({ type: 'SET_PLAYING', payload: false });
    dispatch({ type: 'SET_CURRENT_TIME', payload: 0 });
  }, [stopAnimLoop, stopSources, stopRecordingSession, dispatch, currentTimeRef]);

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
    } catch {
      alert('Microphone access denied. Please allow microphone access in your browser or system settings.');
      return;
    }

    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') await ctx.resume();

    armedTrackIdRef.current = armedTrack.id;
    recordingStartDawTimeRef.current = currentTimeRef.current;
    recordingStartTimeRef.current = currentTimeRef.current;
    recordingChunksRef.current = [];
    livePeaksRef.current = [];

    // Tap the mic for live waveform visualization
    const micSource = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    micSource.connect(analyser);
    // Route mic to masterStream for ListenTo
    if (masterStreamRef.current) micSource.connect(masterStreamRef.current);
    micSourceRef.current = micSource;
    analyserRef.current = analyser;

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
      stream.getTracks().forEach(t => t.stop());

      const blob = new Blob(recordingChunksRef.current, { type: mimeType });

      let peaks: number[] = [];
      let peaksR: number[] | null = null;
      let duration = 0;
      try {
        const ab = await blob.arrayBuffer();
        const audioBuffer = await ctx.decodeAudioData(ab);
        const stereo = await generatePeaksStereo(audioBuffer);
        peaks  = stereo.left;
        peaksR = stereo.right;
        duration = audioBuffer.duration;
      } catch {
        duration = currentTimeRef.current - recordingStartDawTimeRef.current;
      }

      const currentTrackId = armedTrackIdRef.current!;
      const trackName = state.tracks.find(t => t.id === currentTrackId)?.name ?? 'Track';
      const takeNum = state.poolItems.filter(p => p.name.startsWith(trackName)).length + 1;
      const name = `${trackName}_Take_${takeNum}`;
      const localFileName = `${name}.webm`;

      // PRIMARY: blob URL — works instantly, no network dependency
      const audioUrl = URL.createObjectURL(blob);

      // Save to the project's local Audio/ folder (primary on-disk storage)
      if (audioDirHandle) {
        try {
          // @ts-ignore
          const fileHandle = await audioDirHandle.getFileHandle(localFileName, { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(blob);
          await writable.close();
        } catch (err) {
          console.error(`Local Audio/ save failed for ${localFileName}:`, err);
        }
      }

      const poolItemId = `pool_${Date.now()}`;

      // BACKGROUND: Supabase cloud backup — once done, update URLs so project.json gets a shareable link
      uploadAudioToSupabase(blob, localFileName).then(supabaseUrl => {
        if (supabaseUrl && supabaseUrl !== audioUrl) {
          dispatch({ type: 'UPDATE_AUDIO_URLS', payload: { poolItemId, audioUrl: supabaseUrl } });
        }
      }).catch(() => {});

      const poolItem: PoolItem = {
        id: poolItemId,
        name,
        audioUrl,
        localFileName,
        duration,
        createdAt: new Date(),
        waveformPeaks: peaks,
        waveformPeaksR: peaksR,
      };

      const armedTrackObj = state.tracks.find(t => t.id === currentTrackId);
      const region: Region = {
        id: `region_${Date.now()}`,
        trackId: currentTrackId,
        versionId: armedTrackObj?.activeVersionId ?? 'default',
        startTime: recordingStartDawTimeRef.current,
        duration,
        name,
        audioUrl,
        waveformPeaks: peaks,
        waveformPeaksR: peaksR,
      };

      dispatch({ type: 'ADD_POOL_ITEM', payload: poolItem });
      dispatch({ type: 'ADD_REGION', payload: region });
    };

    const startRecordingSession = () => {
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
        fetch(region.audioUrl)
          .then(r => r.arrayBuffer())
          .then(ab => ctx.decodeAudioData(ab))
          .then(audioBuffer => {
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
        const beatDuration = 1 / bps;
        let currentBeat = Math.ceil(playStartDawTimeRef.current * bps);
        for (let i = 0; i < 500; i++) {
          const beatTime = (currentBeat + i) * beatDuration;
          const when = playStartAudioTimeRef.current + (beatTime - playStartDawTimeRef.current);
          if (when >= ctx.currentTime) {
            scheduleClick(ctx, when, (currentBeat + i) % 4 === 0);
          }
        }
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
  }, [state, dispatch, currentTimeRef, getAudioCtx, startAnimLoop, scheduleClick, userRole, masterStreamRef]);

  return { play, pause, stop, record, stopRecordingSession, initAudioCtx: getAudioCtx };
};
