import { useRef, useCallback, useEffect } from 'react';
import { useDaw } from '../context/DawContext';
import type { Region, PoolItem, MeterValue } from '../context/DawContext';
import { generatePeaksStereo, uploadAudioToSupabase, saveToAudioFolder, createWavHeader, floatsToPcm24, extractPeaksFromFloat32 } from '../utils/audioUtils';
import { loadAudioPrefs } from '../components/daw/AudioMIDIPreferencesDialog';

const CLICK_LOOKAHEAD_S = 0.15;  // schedule this many seconds ahead
const CLICK_INTERVAL_MS = 25;    // scheduler polling interval (ms)

// Module-level map so blobs survive re-renders and can be retried after a failed upload
const pendingRetryBlobs = new Map<string, Blob>();


export const useAudioEngine = (opts?: { enabled?: boolean }) => {
  const enabled = opts?.enabled !== false;
  const { state, dispatch, currentTimeRef, audioCtxRef, recordingStartTimeRef, livePeaksRef, trackAnalysersRef, trackGainsRef, trackPannersRef, masterGainRef, masterAnalyserRef, userRole, masterStreamRef, audioDirHandle, retryUploadRef, meterValuesRef } = useDaw();

  const animFrameRef = useRef<number | null>(null);
  const trackAnalyserPairsRef = useRef<Record<string, [AnalyserNode, AnalyserNode]>>({});
  const masterAnalyserPairRef = useRef<[AnalyserNode, AnalyserNode] | null>(null);
  const meterRafRef = useRef(0);
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

  // ── Continuous recording refs ────────────────────────────────────────────────
  const recordWorkletRef     = useRef<AudioWorkletNode | null>(null);
  const recordStreamRef      = useRef<any>(null);           // FileSystemWritableFileStream
  const recordFileHandleRef  = useRef<any>(null);           // FileSystemFileHandle
  const recordPcmBytesRef    = useRef(0);
  const recordNumChRef       = useRef(2);
  const recordSrRef          = useRef(48000);
  const workletLoadedRef     = useRef(false);
  const micStreamRef         = useRef<MediaStream | null>(null);
  const monitorGainRef       = useRef<GainNode | null>(null);
  const takeNameRef          = useRef('Take');
  // Punch mode refs
  const punchArmedRef        = useRef(false);    // mic is set up, waiting for punchIn
  const punchWritingRef      = useRef(false);    // currently writing PCM (between punch in/out)
  const punchInRef           = useRef<number | null>(state.transport.punchIn);
  const punchOutRef          = useRef<number | null>(state.transport.punchOut);
  const isRecordingRef       = useRef(false);    // mirrors state.transport.isRecording for the tick
  const clickSourcesRef  = useRef<any[]>([]);
  const nextClickTimeRef = useRef(0);
  const clickBeatRef     = useRef(0);
  const clickIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tempoRef         = useRef(state.transport.tempo);
  const timeSigRef       = useRef<[number, number]>(state.transport.timeSignature as [number, number]);
  const projectEndTimeRef = useRef<number>(Infinity); // updated in play() to the last region's end time

  // Live transport refs — kept in sync so the anim loop tick always reads current values
  const isLoopingRef  = useRef(state.transport.isLooping);
  const loopStartRef  = useRef(state.transport.loopStart);
  const loopEndRef    = useRef(state.transport.loopEnd);
  // Function refs — updated after each useCallback definition so the tick can call them
  const playFnRef                = useRef<(() => Promise<void>) | null>(null);
  const stopSrcRef               = useRef<(() => void) | null>(null);
  const stopMetroRef             = useRef<(() => void) | null>(null);
  const openPunchStreamRef       = useRef<(() => void) | null>(null);
  const stopRecordingSessionRef  = useRef<(() => void) | null>(null);

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
  stopMetroRef.current = stopMetronome;

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

  // Keep transport refs current so the anim loop tick never reads stale closure values
  useEffect(() => { isLoopingRef.current  = state.transport.isLooping;  }, [state.transport.isLooping]);
  useEffect(() => { loopStartRef.current  = state.transport.loopStart;  }, [state.transport.loopStart]);
  useEffect(() => { loopEndRef.current    = state.transport.loopEnd;    }, [state.transport.loopEnd]);
  useEffect(() => { punchInRef.current    = state.transport.punchIn;    }, [state.transport.punchIn]);
  useEffect(() => { punchOutRef.current   = state.transport.punchOut;   }, [state.transport.punchOut]);
  useEffect(() => { isRecordingRef.current = state.transport.isRecording; }, [state.transport.isRecording]);

  const startAnimLoop = useCallback((ctx: AudioContext) => {
    stopAnimLoop();
    const tick = () => {
      const elapsed = Math.max(0, ctx.currentTime - playStartAudioTimeRef.current);
      let dawTime = playStartDawTimeRef.current + elapsed;

      // Proper audio loop restart — stops old sources and replays from loopStart
      if (isLoopingRef.current && loopEndRef.current > loopStartRef.current && dawTime >= loopEndRef.current) {
        ++playIdRef.current;
        stopSrcRef.current?.();
        stopMetroRef.current?.();
        currentTimeRef.current = loopStartRef.current;
        dispatch({ type: 'SET_CURRENT_TIME', payload: loopStartRef.current });
        playFnRef.current?.(); // restarts audio + new anim loop from loopStart
        return;
      }

      currentTimeRef.current = dawTime;

      // Punch-in: start writing when playhead crosses punchIn
      if (punchArmedRef.current && !punchWritingRef.current && punchInRef.current !== null && dawTime >= punchInRef.current) {
        punchWritingRef.current = true;
        // Open the FSAA stream now (worklet is already capturing; we just start writing)
        openPunchStreamRef.current?.();
      }

      // Punch-out: stop writing when playhead crosses punchOut
      if (punchWritingRef.current && punchOutRef.current !== null && dawTime >= punchOutRef.current) {
        punchArmedRef.current  = false;
        punchWritingRef.current = false;
        stopRecordingSessionRef.current?.();
        return;
      }

      // Auto-stop when playhead reaches project end (not looping)
      if (!isLoopingRef.current && dawTime >= projectEndTimeRef.current) {
        stopAnimLoop();
        dispatch({ type: 'SET_PLAYING', payload: false });
        dispatch({ type: 'SET_CURRENT_TIME', payload: projectEndTimeRef.current });
        currentTimeRef.current = projectEndTimeRef.current;
        return;
      }

      // Only push to React state ~10fps to avoid flooding renders
      if (ctx.currentTime - lastDispatchTimeRef.current > 0.1) {
        dispatch({ type: 'SET_CURRENT_TIME', payload: dawTime });
        lastDispatchTimeRef.current = ctx.currentTime;
      }
      animFrameRef.current = requestAnimationFrame(tick);
    };
    animFrameRef.current = requestAnimationFrame(tick);
  }, [stopAnimLoop, currentTimeRef, dispatch]);

  const startMeterLoop = useCallback(() => {
    if (meterRafRef.current) return;
    const FLOOR = -90;
    const HOLD_MS = 2000;
    const DECAY_PER_FRAME = 0.4; // dB per frame (~60fps)

    const readPeakDb = (an: AnalyserNode): number => {
      const buf = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) {
        const abs = Math.abs(buf[i]);
        if (abs > peak) peak = abs;
      }
      return peak > 0 ? Math.max(FLOOR, 20 * Math.log10(peak)) : FLOOR;
    };

    const tick = () => {
      const now = performance.now();
      const vals = meterValuesRef.current;

      // Per-track
      const pairs = trackAnalyserPairsRef.current;
      for (const trackId of Object.keys(pairs)) {
        const [anL, anR] = pairs[trackId];
        const dbL = readPeakDb(anL);
        const dbR = readPeakDb(anR);
        const v: MeterValue = vals[trackId] ?? { L: FLOOR, R: FLOOR, peakL: FLOOR, peakR: FLOOR, peakLAt: 0, peakRAt: 0, clipL: false, clipR: false };
        v.L = dbL;
        v.R = dbR;
        if (dbL >= v.peakL) { v.peakL = dbL; v.peakLAt = now + HOLD_MS; }
        else if (now > v.peakLAt) v.peakL = Math.max(FLOOR, v.peakL - DECAY_PER_FRAME);
        if (dbR >= v.peakR) { v.peakR = dbR; v.peakRAt = now + HOLD_MS; }
        else if (now > v.peakRAt) v.peakR = Math.max(FLOOR, v.peakR - DECAY_PER_FRAME);
        if (dbL >= 0) v.clipL = true;
        if (dbR >= 0) v.clipR = true;
        vals[trackId] = v;
      }
      // Decay tracks that are stopped (not in pairs anymore)
      for (const id of Object.keys(vals)) {
        if (id === 'master' || pairs[id]) continue;
        const v = vals[id];
        v.L = FLOOR; v.R = FLOOR;
        v.peakL = Math.max(FLOOR, v.peakL - DECAY_PER_FRAME);
        v.peakR = Math.max(FLOOR, v.peakR - DECAY_PER_FRAME);
      }

      // Master
      const mp = masterAnalyserPairRef.current;
      if (mp) {
        const dbL = readPeakDb(mp[0]);
        const dbR = readPeakDb(mp[1]);
        const v: MeterValue = vals['master'] ?? { L: FLOOR, R: FLOOR, peakL: FLOOR, peakR: FLOOR, peakLAt: 0, peakRAt: 0, clipL: false, clipR: false };
        v.L = dbL; v.R = dbR;
        if (dbL >= v.peakL) { v.peakL = dbL; v.peakLAt = now + HOLD_MS; }
        else if (now > v.peakLAt) v.peakL = Math.max(FLOOR, v.peakL - DECAY_PER_FRAME);
        if (dbR >= v.peakR) { v.peakR = dbR; v.peakRAt = now + HOLD_MS; }
        else if (now > v.peakRAt) v.peakR = Math.max(FLOOR, v.peakR - DECAY_PER_FRAME);
        if (dbL >= 0) v.clipL = true;
        if (dbR >= 0) v.clipR = true;
        vals['master'] = v;
      } else {
        const v = vals['master'];
        if (v) { v.L = FLOOR; v.R = FLOOR; v.peakL = Math.max(FLOOR, v.peakL - DECAY_PER_FRAME); v.peakR = Math.max(FLOOR, v.peakR - DECAY_PER_FRAME); }
      }

      meterRafRef.current = requestAnimationFrame(tick);
    };
    meterRafRef.current = requestAnimationFrame(tick);
  }, [meterValuesRef]);

  const play = useCallback(async () => {
    if (!enabled) return;
    try {
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') await ctx.resume();

    // Capture a generation ID so stop()/pause() can abort an in-progress decode
    const playId = ++playIdRef.current;
    const offset = currentTimeRef.current;

    dispatch({ type: 'SET_PLAYING', payload: true });

    // Build master bus (gain + analyser) — all tracks route through here
    const masterGain = ctx.createGain();
    masterGain.gain.value = isFinite(masterGainRef.current?.gain.value ?? 1) ? (masterGainRef.current?.gain.value ?? 1) : 1;
    const masterAnalyser = ctx.createAnalyser();
    masterAnalyser.fftSize = 2048;
    masterAnalyser.smoothingTimeConstant = 0.75;
    masterGain.connect(masterAnalyser);
    masterAnalyser.connect(ctx.destination);
    if (masterStreamRef.current) masterAnalyser.connect(masterStreamRef.current);
    masterGainRef.current     = masterGain;
    masterAnalyserRef.current = masterAnalyser;

    // Master L/R meter tap
    const masterMeterSplitter = ctx.createChannelSplitter(2);
    const masterMeterL = ctx.createAnalyser();
    const masterMeterR = ctx.createAnalyser();
    masterMeterL.fftSize = 1024; masterMeterL.smoothingTimeConstant = 0;
    masterMeterR.fftSize = 1024; masterMeterR.smoothingTimeConstant = 0;
    masterAnalyser.connect(masterMeterSplitter);
    masterMeterSplitter.connect(masterMeterL, 0, 0);
    masterMeterSplitter.connect(masterMeterR, 1, 0);
    masterAnalyserPairRef.current = [masterMeterL, masterMeterR];

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
      analyser.connect(masterGain); // route through master bus

      trackBusses[track.id] = { gain, analyser };
      trackAnalysersRef.current[track.id] = analyser;
      trackGainsRef.current[track.id]     = gain;
      trackPannersRef.current[track.id]   = panner;

      // L/R meter tap — splitter fans out from panner without affecting signal path
      const meterSplitter = ctx.createChannelSplitter(2);
      const meterAnalyserL = ctx.createAnalyser();
      const meterAnalyserR = ctx.createAnalyser();
      meterAnalyserL.fftSize = 1024; meterAnalyserL.smoothingTimeConstant = 0;
      meterAnalyserR.fftSize = 1024; meterAnalyserR.smoothingTimeConstant = 0;
      panner.connect(meterSplitter);
      meterSplitter.connect(meterAnalyserL, 0, 0);
      meterSplitter.connect(meterAnalyserR, 1, 0);
      trackAnalyserPairsRef.current[track.id] = [meterAnalyserL, meterAnalyserR];
    }

    const playableRegions = state.regions.filter(region =>
      playableTracks.has(region.trackId) &&
      !region.isMuted &&
      region.audioUrl &&
      region.startTime + region.duration > offset
    );

    // Set project end so the anim loop can auto-stop there
    projectEndTimeRef.current = playableRegions.length > 0
      ? Math.max(...playableRegions.map(r => r.startTime + r.duration))
      : Infinity;

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

    // The browser may have re-suspended the AudioContext during the async decode phase.
    // Re-check and resume before scheduling so sources actually play.
    if (ctx.state === 'suspended') await ctx.resume();
    if (playId !== playIdRef.current) return; // bail if stopped during resume

    // Apply crossfades from explicit state.crossfades entries (non-destructive, user-controlled via X key).
    // Duration is computed live from the current overlap — moves automatically as clips are repositioned.
    const effectiveFades = new Map<string, { fadeIn: number; fadeOut: number }>();
    for (const cf of state.crossfades) {
      const itemA = decoded.find(d => d?.region.id === cf.regionA);
      const itemB = decoded.find(d => d?.region.id === cf.regionB);
      if (!itemA || !itemB) continue;
      const [first, second] = itemA.region.startTime <= itemB.region.startTime
        ? [itemA.region, itemB.region]
        : [itemB.region, itemA.region];
      const overlap = (first.startTime + first.duration) - second.startTime;
      if (overlap > 0.01) {
        const af = effectiveFades.get(first.id) ?? { fadeIn: first.fadeIn ?? 0, fadeOut: first.fadeOut ?? 0 };
        af.fadeOut = Math.max(af.fadeOut, overlap);
        effectiveFades.set(first.id, af);
        const bf = effectiveFades.get(second.id) ?? { fadeIn: second.fadeIn ?? 0, fadeOut: second.fadeOut ?? 0 };
        bf.fadeIn = Math.max(bf.fadeIn, overlap);
        effectiveFades.set(second.id, bf);
      }
    }

    // Auto-crossfade: detect overlapping clips on the same track without user action
    const byTrack = new Map<string, NonNullable<(typeof decoded)[0]>[]>();
    for (const item of decoded) {
      if (!item) continue;
      const list = byTrack.get(item.region.trackId) ?? [];
      list.push(item);
      byTrack.set(item.region.trackId, list);
    }
    for (const items of byTrack.values()) {
      items.sort((a, b) => a.region.startTime - b.region.startTime);
      for (let i = 0; i < items.length - 1; i++) {
        const cur = items[i]!;
        const nxt = items[i + 1]!;
        // Skip pairs already covered by explicit user-defined crossfade
        const alreadyExplicit = state.crossfades.some(
          cf => (cf.regionA === cur.region.id && cf.regionB === nxt.region.id) ||
                (cf.regionA === nxt.region.id && cf.regionB === cur.region.id)
        );
        if (alreadyExplicit) continue;
        const overlap = (cur.region.startTime + cur.region.duration) - nxt.region.startTime;
        if (overlap > 0.01) {
          const af = effectiveFades.get(cur.region.id) ?? { fadeIn: cur.region.fadeIn ?? 0, fadeOut: cur.region.fadeOut ?? 0 };
          af.fadeOut = Math.max(af.fadeOut, overlap);
          effectiveFades.set(cur.region.id, af);
          const bf = effectiveFades.get(nxt.region.id) ?? { fadeIn: nxt.region.fadeIn ?? 0, fadeOut: nxt.region.fadeOut ?? 0 };
          bf.fadeIn = Math.max(bf.fadeIn, overlap);
          effectiveFades.set(nxt.region.id, bf);
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
        const clipGainVal = (region.gain ?? 1);
        const ef = effectiveFades.get(region.id);
        const fi = ef ? ef.fadeIn  : (region.fadeIn  ?? 0);
        const fo = ef ? ef.fadeOut : (region.fadeOut ?? 0);

        // Chain: source → [fadeGain] → [clipGain] → bus.gain
        let dest: AudioNode = bus.gain;
        if (clipGainVal !== 1) {
          const cg = ctx.createGain();
          cg.gain.value = Math.max(0, clipGainVal);
          cg.connect(bus.gain);
          dest = cg;
        }

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
          fg.connect(dest);
        } else {
          source.connect(dest);
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

    startMeterLoop();

  } catch (err) {
    console.error('[AudioEngine] play() error:', err);
  }
  }, [state, dispatch, currentTimeRef, getAudioCtx, startAnimLoop, startMetronome, masterStreamRef, startMeterLoop]);
  playFnRef.current = play;

  const stopSources = useCallback(() => {
    activeSourcesRef.current.forEach(s => { try { s.stop(); } catch { /* already stopped */ } });
    activeSourcesRef.current = [];
    trackAnalysersRef.current  = {};
    trackGainsRef.current      = {};
    trackPannersRef.current    = {};
    masterGainRef.current      = null;
    masterAnalyserRef.current  = null;
    trackAnalyserPairsRef.current = {};
    masterAnalyserPairRef.current = null;
    // Don't stop the meter RAF — let it decay naturally
  }, [trackAnalysersRef, trackGainsRef, trackPannersRef, masterGainRef, masterAnalyserRef]);
  stopSrcRef.current = stopSources;

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
    dispatch({ type: 'SET_RECORDING', payload: false });
    isRecordingRef.current = false;
    punchArmedRef.current  = false;
    punchWritingRef.current = false;

    // ── AudioWorklet + FSAA path ──────────────────────────────────────────────
    if (recordWorkletRef.current) {
      recordWorkletRef.current.port.postMessage('stop');
      recordWorkletRef.current = null;
      // WAV finalisation happens in the worklet onmessage handler (final: true)
      return;
    }

    // ── Legacy MediaRecorder fallback ─────────────────────────────────────────
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
  }, [dispatch]);
  stopRecordingSessionRef.current = stopRecordingSession;

  // Pause: halt playback but keep the playhead position
  const pause = useCallback(() => {
    if (!enabled) return;
    ++playIdRef.current;
    stopAnimLoop();
    stopSources();
    stopMetronome();
    stopRecordingSession();
    dispatch({ type: 'SET_PLAYING', payload: false });
  }, [stopAnimLoop, stopSources, stopMetronome, stopRecordingSession, dispatch]);

  // Stop: halt playback AND return to zero
  const stop = useCallback(() => {
    if (!enabled) return;
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
    if (!enabled) return;
    if (userRole === 'engineer') {
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
      // Per-track input takes priority over the global Audio Preferences device
      const deviceId = armedTrack.inputDeviceId ?? prefs.inputDeviceId;
      const audioConstraint: MediaTrackConstraints =
        deviceId !== 'default'
          ? { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: false }
          : { echoCancellation: true, noiseSuppression: true, autoGainControl: false };
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
    recordingStartTimeRef.current    = currentTimeRef.current;
    livePeaksRef.current = [];
    micStreamRef.current = stream;

    // ── Mic routing chain: source → track gain/pan → analyser → destination ──
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
    trackGainsRef.current[armedTrack.id]   = monGain;
    trackPannersRef.current[armedTrack.id] = monPanner;
    micSourceRef.current = micSource;
    analyserRef.current  = analyser;

    // ── Input monitoring: route mic to speakers when isMonitoring is on ───────
    const monitorOut = ctx.createGain();
    monitorOut.gain.value = armedTrack.isMonitoring ? 1 : 0;
    monPanner.connect(monitorOut);
    monitorOut.connect(ctx.destination);
    monitorGainRef.current = monitorOut;

    // ── Determine take name before async work ──────────────────────────────────
    const trackName = armedTrack.name;
    const takeNum   = state.poolItems.filter(p => p.name.startsWith(trackName)).length + 1;
    const takeName  = `${trackName}_Take_${takeNum}`;
    takeNameRef.current = takeName;

    // ── Helper: commit finalised PCM bytes as a WAV Region ────────────────────
    const commitRecording = async (wavBytes: number, getBlob: () => Promise<Blob>) => {
      if (micSourceRef.current) { micSourceRef.current.disconnect(); micSourceRef.current = null; }
      analyserRef.current = null;
      monitorGainRef.current = null;
      delete trackGainsRef.current[armedTrack.id];
      delete trackPannersRef.current[armedTrack.id];
      stream.getTracks().forEach(t => t.stop());
      micStreamRef.current = null;

      let blob: Blob;
      try { blob = await getBlob(); } catch { return; }
      if (blob.size < 100) return; // guard against empty takes

      const poolItemId = `pool_${Date.now()}`;
      const audioUrl   = URL.createObjectURL(blob);

      let peaks: number[]   = [];
      let peaksR: number[] | null = null;
      let duration           = 0;
      let decodedBuffer: AudioBuffer | null = null;
      try {
        const ab = await blob.arrayBuffer();
        decodedBuffer = await ctx.decodeAudioData(ab.slice(0));
        const stereo = await generatePeaksStereo(decodedBuffer);
        peaks  = stereo.left;
        peaksR = armedTrack.type === 'stereo' ? stereo.right : null;
        duration = decodedBuffer.duration;
      } catch {
        duration = Math.max(0.1, wavBytes / (recordNumChRef.current * recordSrRef.current * 3));
      }

      if (audioDirHandle && decodedBuffer) {
        saveToAudioFolder(audioDirHandle, takeName, decodedBuffer).catch(console.error);
      }

      const poolItem: PoolItem = {
        id: poolItemId,
        name: takeName,
        audioUrl,
        localFileName: `${takeName}.wav`,
        duration,
        createdAt: new Date(),
        waveformPeaks: peaks,
        waveformPeaksR: peaksR,
        uploadStatus: 'uploading',
      };
      const armedTrackObj = state.tracks.find(t => t.id === armedTrack.id);
      const region: Region = {
        id: `region_${Date.now()}`,
        poolItemId,
        trackId: armedTrack.id,
        versionId: armedTrackObj?.activeVersionId ?? 'default',
        startTime: recordingStartDawTimeRef.current,
        duration,
        name: takeName,
        audioUrl,
        waveformPeaks: peaks,
        waveformPeaksR: peaksR,
        sourceDuration: duration,
        sourcePeaks: peaks,
        sourcePeaksR: peaksR,
      };
      dispatch({ type: 'ADD_POOL_ITEM', payload: poolItem });
      dispatch({ type: 'ADD_REGION', payload: region });

      // Keep blob in memory for retry if upload fails
      pendingRetryBlobs.set(poolItemId, blob);

      uploadAudioToSupabase(blob, `${takeName}.wav`)
        .then(({ publicUrl, storagePath }) => {
          pendingRetryBlobs.delete(poolItemId);
          dispatch({ type: 'SET_POOL_ITEM_UPLOAD_STATUS', payload: { id: poolItemId, status: 'done', storagePath } });
          if (publicUrl !== audioUrl) {
            dispatch({ type: 'UPDATE_AUDIO_URLS', payload: { poolItemId, audioUrl: publicUrl } });
          }
        })
        .catch(() => {
          dispatch({ type: 'SET_POOL_ITEM_UPLOAD_STATUS', payload: { id: poolItemId, status: 'failed' } });
        });
    };

    // ── Try AudioWorklet + FSAA (crash-safe streaming) ────────────────────────
    const hasWorklet = typeof AudioWorkletNode !== 'undefined';
    const hasFsaa    = typeof (window as any).showSaveFilePicker === 'function';

    if (hasWorklet && hasFsaa) {
      try {
        if (!workletLoadedRef.current) {
          await ctx.audioWorklet.addModule(new URL('../audio/recorder-processor.js', import.meta.url));
          workletLoadedRef.current = true;
        }

        const numChannels = stream.getAudioTracks()[0]?.getSettings().channelCount ?? 2;
        recordNumChRef.current = numChannels;
        recordSrRef.current    = ctx.sampleRate;
        recordPcmBytesRef.current = 0;

        const workletNode = new AudioWorkletNode(ctx, 'recorder-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          channelCount: numChannels,
          channelCountMode: 'explicit',
        });
        micSource.connect(workletNode);
        recordWorkletRef.current = workletNode;

        // Determine if this is a punch recording
        const isPunch = punchInRef.current !== null;

        // FSAA: pick a save location
        let fileHandle: any;
        try {
          fileHandle = await (window as any).showSaveFilePicker({
            suggestedName: `${takeName}.wav`,
            types: [{ description: 'WAV Audio', accept: { 'audio/wav': ['.wav'] } }],
          });
        } catch {
          // User cancelled the picker — fall through to MediaRecorder
          workletNode.disconnect();
          recordWorkletRef.current = null;
          throw new Error('picker-cancelled');
        }
        recordFileHandleRef.current = fileHandle;

        // Open write stream and write placeholder WAV header
        const writableStream = await fileHandle.createWritable();
        recordStreamRef.current = writableStream;
        const header = createWavHeader(ctx.sampleRate, numChannels);
        await writableStream.write(header);

        // openPunchStream: called by the tick when dawTime >= punchIn
        const openPunchStream = () => { /* stream is already open; just gate writing */ };
        openPunchStreamRef.current = isPunch ? openPunchStream : null;

        if (isPunch) {
          punchArmedRef.current   = true;
          punchWritingRef.current = false;
        }

        // Worklet message handler — receives PCM blocks from the audio thread
        workletNode.port.onmessage = async (e: MessageEvent) => {
          const { channels, final } = e.data as { channels: Float32Array[]; final?: boolean };
          // Only write during punch window (or always if not a punch recording)
          const shouldWrite = !isPunch || punchWritingRef.current;
          if (shouldWrite) {
            const pcm = floatsToPcm24(channels);
            recordPcmBytesRef.current += pcm.byteLength;
            // accumulate live peaks
            const { left: peakBlock } = extractPeaksFromFloat32(channels[0], channels[1] ?? null, 8);
            livePeaksRef.current.push(...peakBlock);
            try {
              await recordStreamRef.current?.write(pcm);
            } catch { /* disk full or stream closed */ }
          }

          if (final) {
            // Update RIFF and data chunk sizes now that we know total bytes
            const dataBytes = recordPcmBytesRef.current;
            try {
              const ws = recordStreamRef.current;
              const riffSizeBuf = new ArrayBuffer(4);
              new DataView(riffSizeBuf).setUint32(0, 36 + dataBytes, true);
              await ws.seek(4);
              await ws.write(riffSizeBuf);

              const dataSizeBuf = new ArrayBuffer(4);
              new DataView(dataSizeBuf).setUint32(0, dataBytes, true);
              await ws.seek(40);
              await ws.write(dataSizeBuf);

              await ws.close();
            } catch { /* best effort */ }
            recordStreamRef.current   = null;
            recordWorkletRef.current  = null;

            // Materialise blob from the saved file for pool/peaks
            const file     = await recordFileHandleRef.current?.getFile();
            const finalBlob = file ? new Blob([await file.arrayBuffer()], { type: 'audio/wav' }) : null;
            recordFileHandleRef.current = null;

            await commitRecording(dataBytes, async () => finalBlob ?? new Blob([], { type: 'audio/wav' }));
          }
        };

        // Fall through to startRecordingSession (overdub scheduling + anim loop)
      } catch (err: any) {
        if (err?.message !== 'picker-cancelled') {
          console.warn('AudioWorklet/FSAA unavailable, falling back to MediaRecorder:', err);
        }
        // Fall through to MediaRecorder path below
        recordWorkletRef.current = null;
        recordStreamRef.current  = null;
      }
    }

    // ── MediaRecorder fallback (or continuing after worklet setup) ────────────
    // If worklet setup succeeded, mediaRecorder is still used for overdub scheduling
    // but we skip attaching it to the mic stream.
    const useWorklet = recordWorkletRef.current !== null;

    if (!useWorklet) {
      // Pure MediaRecorder path
      recordingChunksRef.current = [];
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const mediaRecorder = new MediaRecorder(stream, { mimeType });

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          recordingChunksRef.current.push(e.data);
          if (analyserRef.current) {
            const data = new Uint8Array(analyserRef.current.fftSize);
            analyserRef.current.getByteTimeDomainData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) {
              const v = (data[i] / 128) - 1; sum += v * v;
            }
            livePeaksRef.current.push(Math.sqrt(sum / data.length));
          }
        }
      };

      mediaRecorder.onstop = async () => {
        const blob = new Blob(recordingChunksRef.current, { type: mimeType });
        await commitRecording(blob.size, async () => blob);
      };

      mediaRecorderRef.current = mediaRecorder;
    }

    const startRecordingSession = () => {
      const recId = ++playIdRef.current;
      if (!useWorklet && mediaRecorderRef.current) {
        mediaRecorderRef.current.start(100);
      }

      playStartAudioTimeRef.current = ctx.currentTime;
      playStartDawTimeRef.current   = currentTimeRef.current;
      isRecordingRef.current        = true;
      dispatch({ type: 'SET_RECORDING', payload: true });
      dispatch({ type: 'SET_PLAYING', payload: true });
      startAnimLoop(ctx);

      // ── Overdub: schedule existing clips alongside new recording ──────────
      const hasSolo = state.tracks.some(t => t.isSolo);
      const playableTracks = new Set(
        state.tracks
          .filter(t => !t.isMuted && (!hasSolo || t.isSolo) && !t.isArmed)
          .map(t => t.id)
      );

      if (!masterGainRef.current) {
        const mg = ctx.createGain();
        mg.gain.value = 1;
        const ma = ctx.createAnalyser();
        ma.fftSize = 2048; ma.smoothingTimeConstant = 0.75;
        mg.connect(ma); ma.connect(ctx.destination);
        if (masterStreamRef.current) ma.connect(masterStreamRef.current);
        masterGainRef.current   = mg;
        masterAnalyserRef.current = ma;
      }
      const trackBusses: Record<string, { gain: GainNode; analyser: AnalyserNode }> = {};
      trackGainsRef.current = {};
      for (const track of state.tracks) {
        if (!playableTracks.has(track.id)) continue;
        const gain = ctx.createGain();
        gain.gain.value = isFinite(track.volume) ? track.volume : 0.8;
        const an = ctx.createAnalyser();
        an.fftSize = 2048; an.smoothingTimeConstant = 0.75;
        gain.connect(an);
        an.connect(masterGainRef.current);
        trackBusses[track.id]               = { gain, analyser: an };
        trackAnalysersRef.current[track.id] = an;
        trackGainsRef.current[track.id]     = gain;
      }

      const offset = currentTimeRef.current;
      for (const region of state.regions) {
        if (!playableTracks.has(region.trackId)) continue;
        if (region.isMuted || !region.audioUrl) continue;
        if (region.startTime + region.duration <= offset) continue;
        const cachedBuf = bufferCacheRef.current.get(region.audioUrl);
        (cachedBuf
          ? Promise.resolve(cachedBuf)
          : fetch(region.audioUrl)
              .then(r => r.arrayBuffer())
              .then(ab => ctx.decodeAudioData(ab))
              .then(buf => { bufferCacheRef.current.set(region.audioUrl, buf); return buf; })
        ).then(audioBuffer => {
            if (recId !== playIdRef.current) return;
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
          .catch(() => {});
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

  // Input monitoring: toggle mic-to-speakers whenever track.isMonitoring changes
  useEffect(() => {
    if (!monitorGainRef.current) return;
    const armedTrack = state.tracks.find(t => t.isArmed);
    monitorGainRef.current.gain.setTargetAtTime(
      armedTrack?.isMonitoring ? 1 : 0,
      audioCtxRef.current?.currentTime ?? 0,
      0.01,
    );
  }, [state.tracks, audioCtxRef]);

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

  // Seek during playback: tear down current sources and restart from new position
  const seek = useCallback(async (t: number) => {
    if (!enabled) return;
    const wasPlaying = state.transport.isPlaying;
    currentTimeRef.current = Math.max(0, t);
    dispatch({ type: 'SET_CURRENT_TIME', payload: Math.max(0, t) });
    if (wasPlaying) {
      ++playIdRef.current;
      stopAnimLoop();
      stopSources();
      stopMetronome();
      // play() reads currentTimeRef.current as the offset
      await play();
    }
  }, [state.transport.isPlaying, currentTimeRef, dispatch, stopAnimLoop, stopSources, stopMetronome, play]);

  // Pre-warm the decode cache whenever regions change so the first play is instant.
  // Runs in the background — never blocks the UI or delays play().
  useEffect(() => {
    if (!enabled) return;
    const urls = [...new Set(
      state.regions
        .filter(r => r.audioUrl && !bufferCacheRef.current.has(r.audioUrl))
        .map(r => r.audioUrl)
    )];
    if (urls.length === 0) return;
    const ctx = getAudioCtx();
    if (!ctx) return;
    let cancelled = false;
    (async () => {
      for (const url of urls) {
        if (cancelled || bufferCacheRef.current.has(url)) continue;
        try {
          const resp = await fetch(url);
          const ab   = await resp.arrayBuffer();
          if (cancelled) break;
          const buf  = await ctx.decodeAudioData(ab);
          bufferCacheRef.current.set(url, buf);
        } catch { /* non-fatal — play() will retry */ }
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.regions]);

  const retryUpload = useCallback((poolItemId: string) => {
    const blob = pendingRetryBlobs.get(poolItemId);
    const item = state.poolItems.find(p => p.id === poolItemId);
    if (!blob || !item) return;
    dispatch({ type: 'SET_POOL_ITEM_UPLOAD_STATUS', payload: { id: poolItemId, status: 'uploading' } });
    uploadAudioToSupabase(blob, item.localFileName ?? `${item.name}.wav`)
      .then(({ publicUrl, storagePath }) => {
        pendingRetryBlobs.delete(poolItemId);
        dispatch({ type: 'SET_POOL_ITEM_UPLOAD_STATUS', payload: { id: poolItemId, status: 'done', storagePath } });
        const localUrl = item.audioUrl;
        if (publicUrl !== localUrl) {
          dispatch({ type: 'UPDATE_AUDIO_URLS', payload: { poolItemId, audioUrl: publicUrl } });
        }
      })
      .catch(() => {
        dispatch({ type: 'SET_POOL_ITEM_UPLOAD_STATUS', payload: { id: poolItemId, status: 'failed' } });
      });
  }, [state.poolItems, dispatch]);

  // Register so any component can call retryUpload via context
  retryUploadRef.current = retryUpload;

  // Stop meter RAF on unmount
  useEffect(() => {
    return () => {
      cancelAnimationFrame(meterRafRef.current);
      meterRafRef.current = 0;
    };
  }, []);

  return { play, pause, stop, record, seek, stopRecordingSession, initAudioCtx: getAudioCtx };
};
