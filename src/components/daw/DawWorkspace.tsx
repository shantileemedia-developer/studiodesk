import { useState, useEffect, useRef, useCallback } from 'react';
import './DawWorkspace.css';
import { useAudioEngine } from '../../hooks/useAudioEngine';
import { useNativeAudioEngine } from '../../hooks/useNativeAudioEngine';
import { useDawSync } from '../../hooks/useDawSync';
import { useDaw } from '../../context/DawContext';
import { useRemoteControlReplay } from '../../hooks/useRemoteControl';
import { useAudioStream } from '../../hooks/useAudioStream';
import type { RemoteInputEvent } from '../../types/remote';
import TransportPanel from './TransportPanel';
import InspectorPanel from './InspectorPanel';
import TrackList from './TrackList';
import ArrangeWindow, { type ArrangeWindowHandle } from './ArrangeWindow';
import MediaPoolPanel from './MediaPoolPanel';
import TopToolbar from './TopToolbar';
import MenuBar from './MenuBar';
import PreferencesDialog from './PreferencesDialog';
import FloatingVideoChat, { type FloatingVideoChatHandle } from './FloatingVideoChat';
import MonitorPanel, { type MonitorSource } from './MonitorPanel';
import RemoteControlOverlay, { type RemoteControlOverlayHandle } from './RemoteControlOverlay';
import MixerPanel from './MixerPanel';
import AudioMIDIPreferencesDialog from './AudioMIDIPreferencesDialog';
import LyricsPanel from './LyricsPanel';
import { supabase } from '../../lib/supabaseClient';
import type { MonitorQuality } from '../../hooks/useAudioStream';
import { generatePeaksStereo, uploadAudioToSupabase } from '../../utils/audioUtils';
import type { PoolItem } from '../../context/DawContext';

interface DawWorkspaceProps {
  userRole: 'artist' | 'engineer';
  userId: string;
  roomCode: string;
  isAdmin?: boolean;
  onOpenAdmin?: () => void;
  onArtistLeft?: () => void;
  onExitDawControl?: () => void;
  artistName?: string;
}

const DawWorkspace: React.FC<DawWorkspaceProps> = ({ userRole, userId, roomCode, isAdmin, onOpenAdmin, onArtistLeft, onExitDawControl, artistName }) => {
  const [showPreferences, setShowPreferences] = useState(false);
  const [showAudioPrefs, setShowAudioPrefs] = useState(false);
  const [showLyrics, setShowLyrics] = useState(false);
  const [onlineCount, setOnlineCount] = useState(1);
  const [toast, setToast] = useState<{ msg: string; id: number } | null>(null);
  const dawControlChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const floatingChatRef = useRef<FloatingVideoChatHandle>(null);
  // App RC: engineer controls the artist DAW via forwarded events; results sync back via useDawSync
  const [appRcActive, setAppRcActive] = useState(false);
  const appRcActiveRef  = useRef(false);
  const appRcSendFnRef  = useRef<((e: RemoteInputEvent) => void) | null>(null);

  // DAW Control status — true when DAW control has been granted this session
  // Engineer: restored from localStorage so entering DawWorkspace mid-session picks up prior grant
  const [dawControlActive, setDawControlActive] = useState(() =>
    userRole === 'engineer' ? !!localStorage.getItem('sl_ec_granted') : false
  );
  // Artist: whether to mirror the engineer's arrange viewport
  const [followEngineer, setFollowEngineer] = useState(true);
  const followEngineerRef = useRef(true);
  useEffect(() => { followEngineerRef.current = followEngineer; }, [followEngineer]);

  // Monitor stream controls (engineer only)
  const [monitorQuality, setMonitorQuality] = useState<MonitorQuality>('review');
  const [monitorSource,  setMonitorSource]  = useState<MonitorSource>('both');

  // Desktop RC: OS-level control via nut-js + screen capture (artist permission required)
  const [rcActive, setRcActive] = useState(false);
  const [rcViewOnly, setRcViewOnly] = useState(false);

  // Permission error feedback — shown once per RC session when nut-js injection fails
  const permissionErrorShownRef = useRef(false);
  useEffect(() => { if (!rcActive) permissionErrorShownRef.current = false; }, [rcActive]);
  const handleInjectionError = useCallback((err: unknown) => {
    if (permissionErrorShownRef.current) return;
    permissionErrorShownRef.current = true;
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    const isPermission = msg.includes('accessibility') || msg.includes('permission')
      || msg.includes('access denied') || msg.includes('not authorized') || msg.includes('uiaccessi');
    setToast({
      msg: isPermission
        ? 'Desktop Control needs Accessibility permission to move the mouse and type. Grant it in System Settings → Privacy → Accessibility.'
        : 'Desktop Control: input injection failed. Check system permissions.',
      id: Date.now(),
    });
  }, []);
  const sendRcInputRef   = useRef<((e: RemoteInputEvent) => void) | null>(null);
  const rcOverlayRef     = useRef<RemoteControlOverlayHandle>(null);
  const arrangeRef       = useRef<ArrangeWindowHandle>(null);
  const rcActiveRef      = useRef(false);
  const lastViewSyncRef  = useRef(0);
  const webAudio   = useAudioEngine();
  const nativeAudio = useNativeAudioEngine();
  // Use native engine when available; fall back to Web Audio API
  const { play, pause, stop, record, seek } = nativeAudio.nativeAvailable ? nativeAudio : webAudio;
  const { state, dispatch, masterStreamRef, audioCtxRef, currentTimeRef } = useDaw();

  // Extracted so onRecordSync can call it without referencing handleStopRecording
  const stopRecording = useCallback(async () => {
    if (nativeAudio.nativeAvailable) await nativeAudio.stopRecordingSession();
    else webAudio.stopRecordingSession();
  }, [nativeAudio, webAudio]);

  // Stable ref to engine functions — declared early so transport-sync callbacks can use it
  // without ordering issues. Updated whenever the engine functions change identity.
  const actionsRef = useRef({ play, pause, stop, record, seek, stopRecording });
  useEffect(() => {
    actionsRef.current = { play, pause, stop, record, seek, stopRecording };
  }, [play, pause, stop, record, seek, stopRecording]);

  // ── Live stream (ListenTo-style) ────────────────────────────
  const getMasterStream = useCallback(() => {
    // Initialise AudioContext on first call (must be inside a user-gesture callsite)
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') return null;
    if (!masterStreamRef.current) return null;
    return masterStreamRef.current.stream;
  }, [audioCtxRef, masterStreamRef]);

  const {
    isStreaming, isReceiving, remoteStream: liveRemoteStream,
    connectionState: monitorConnectionState, startStream, stopStream, requestQuality,
  } = useAudioStream({ roomCode, userId, userRole, getMasterStream, quality: monitorQuality });

  // Transport sync callback: when a transport-play or transport-stop arrives from the engineer,
  // snap the local cursor to the given position then drive the local audio engine.
  // Position comes from the engineer's cursor at the moment they pressed play/stop, ensuring
  // both sides start from the same timeline point regardless of where the artist's cursor was.
  const onTransportSync = useCallback((playing: boolean, position: number) => {
    if (playing) {
      currentTimeRef.current = position;
      dispatch({ type: 'SET_CURRENT_TIME', payload: position });
      actionsRef.current.play();
    } else {
      actionsRef.current.pause();
      currentTimeRef.current = position;
      dispatch({ type: 'SET_CURRENT_TIME', payload: position });
    }
  }, [dispatch, currentTimeRef]);

  const onViewportSync = useCallback((zoom: number, scrollLeft: number, scrollTop: number) => {
    if (userRole === 'artist' && followEngineerRef.current)
      arrangeRef.current?.applyViewSync(zoom, scrollLeft, scrollTop);
  }, [userRole]);

  // Artist-side handler for remote-op commands sent by the engineer's menu bar.
  // We use a ref so the stable closure passed to useDawSync always calls the latest version.
  const remoteOpHandlerRef = useRef<((cmd: string) => void) | null>(null);

  // Artist: drive local audio engine when engineer triggers record/stop via transport event.
  // position = cursor location at the moment the engineer pressed record/stop-record.
  const onRecordSync = useCallback(async (recording: boolean, position: number) => {
    if (recording) {
      currentTimeRef.current = position;
      dispatch({ type: 'SET_CURRENT_TIME', payload: position });
      actionsRef.current.record();
    } else {
      await actionsRef.current.stopRecording();
      // pause() calls stopRecordingSession internally but isRecordingRef is already false
      // by the time stopRecording resolves, so it is safe to call and will cleanly halt audio.
      await actionsRef.current.pause();
      currentTimeRef.current = position;
      dispatch({ type: 'SET_CURRENT_TIME', payload: position });
    }
  }, [dispatch, currentTimeRef]);

  // Artist: jump to the position the engineer seeked to
  const onSeekSync = useCallback((time: number) => {
    actionsRef.current.seek(time);
    dispatch({ type: 'SET_CURRENT_TIME', payload: time });
  }, [dispatch]);

  const { broadcastState, broadcastViewport, broadcastSeek, broadcastPlay, broadcastStop, broadcastRecord, broadcastStopRecord, broadcastRemoteOp } = useDawSync(
    roomCode, userRole,
    // Engineer is the transport master — never let a bounced SET_PLAYING from the artist
    // restart the engineer's engine. Artist-only: reacts to network transport commands.
    userRole === 'artist' ? onTransportSync : undefined,
    onViewportSync,
    userRole === 'artist' ? (cmd) => remoteOpHandlerRef.current?.(cmd) : undefined,
    userRole === 'artist' ? onRecordSync : undefined,
    userRole === 'artist' ? onSeekSync   : undefined,
  );

  // Keep OS window title in sync with project name
  useEffect(() => {
    document.title = `${state.projectName ?? 'Untitled Project'} — RiddimSync`;
  }, [state.projectName]);

  // Monitor stream audio is handled by MonitorPanel (Web Audio API — no hidden element needed)

  // Artist: replay events for Desktop RC (OS-level via nut-js)
  const { replayEvent }    = useRemoteControlReplay(rcActive    && userRole === 'artist', 'desktop', userRole === 'artist' ? handleInjectionError : undefined);
  // Artist: replay events for App RC (DOM-level, no permission dialog)
  const { replayEvent: replayAppEvent } = useRemoteControlReplay(appRcActive && userRole === 'artist', 'app');

  // Hide artist's own cursor only during Desktop RC so the engineer's dot is visible
  useEffect(() => {
    if (userRole !== 'artist') return;
    document.body.classList.toggle('rc-artist-active', rcActive);
    return () => { document.body.classList.remove('rc-artist-active'); };
  }, [rcActive, userRole]);

  // Stream toggle — artist must have played once so AudioContext is alive
  const handleToggleStream = useCallback(() => {
    if (isStreaming) {
      stopStream();
    } else {
      if (!audioCtxRef.current) {
        alert('Press Play at least once to initialise the audio engine, then start streaming.');
        return;
      }
      startStream();
    }
  }, [isStreaming, startStream, stopStream, audioCtxRef]);

  // Called by FloatingVideoChat when the App RC WebRTC data channel opens or closes.
  const handleAppRcChange = useCallback((active: boolean, sendFn: ((e: RemoteInputEvent) => void) | null) => {
    setAppRcActive(active);
    appRcActiveRef.current  = active;
    appRcSendFnRef.current  = active ? sendFn : null;
  }, []);

  // Artist-side: engineer triggered an import via the Desktop Control HUD.
  // Opens a native file dialog on the artist's machine, decodes and adds the file to the pool.
  const handleRemoteImport = useCallback(async () => {
    if (!window.studioRC?.openAudioDialog) return;
    const { canceled, filePaths } = await window.studioRC.openAudioDialog();
    if (canceled || !filePaths[0]) return;
    const bytes = await window.studioRC.readFile(filePaths[0]);
    const rawBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const fileName = filePaths[0].replace(/.*[\\/]/, '');
    try {
      const importBlob = new Blob([rawBuffer]);
      const actx = new AudioContext();
      const buf = await actx.decodeAudioData(rawBuffer.slice(0));
      const { left: peaks, right: rawPeaksR } = await generatePeaksStereo(buf);
      await actx.close();
      const poolItem: PoolItem = {
        id: `pool_${Date.now()}`,
        name: fileName.replace(/\.[^.]+$/, ''),
        audioUrl: URL.createObjectURL(importBlob),
        localFileName: fileName,
        duration: buf.duration,
        createdAt: new Date(),
        waveformPeaks: peaks,
        waveformPeaksR: rawPeaksR ?? undefined,
      };
      dispatch({ type: 'ADD_POOL_ITEM', payload: poolItem });
      // Upload to Supabase in background so the engineer can also access the audio.
      uploadAudioToSupabase(importBlob, fileName)
        .then(({ publicUrl }) => dispatch({ type: 'UPDATE_AUDIO_URLS', payload: { poolItemId: poolItem.id, audioUrl: publicUrl } }))
        .catch(err => console.error('[remote-import] Supabase upload failed:', err));
    } catch { /* decode failed — unsupported format */ }
  }, [dispatch]);

  // Keep the artist-side remote-op handler up-to-date with the latest callbacks.
  remoteOpHandlerRef.current = (command: string) => {
    if (command === 'open-audio-dialog') handleRemoteImport();
    if (command === 'open-audio-settings') setShowAudioPrefs(true);
  };

  const handleRcStateChange = useCallback((
    active: boolean,
    sendFn: ((e: RemoteInputEvent) => void) | null,
    viewOnly: boolean,
  ) => {
    setRcActive(active);
    rcActiveRef.current = active;
    setRcViewOnly(viewOnly);
    sendRcInputRef.current = active ? sendFn : null;
  }, []);

  // Always-current snapshot of panelSizes for use in closure callbacks
  const panelSizesRef = useRef(state.panelSizes);
  useEffect(() => { panelSizesRef.current = state.panelSizes; }, [state.panelSizes]);

  const startResize = useCallback((
    e: React.PointerEvent,
    panel: 'inspector' | 'tracklist' | 'mixer',
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const { inspectorWidth, trackListWidth, mixerHeight } = panelSizesRef.current;

    const onMove = (ev: PointerEvent) => {
      if (panel === 'mixer') {
        const h = Math.max(180, Math.min(480, mixerHeight + (startY - ev.clientY)));
        dispatch({ type: 'SET_PANEL_SIZE', payload: { mixerHeight: h } });
      } else if (panel === 'inspector') {
        const w = Math.max(160, Math.min(400, inspectorWidth + (ev.clientX - startX)));
        dispatch({ type: 'SET_PANEL_SIZE', payload: { inspectorWidth: w } });
      } else {
        const w = Math.max(160, Math.min(320, trackListWidth + (ev.clientX - startX)));
        dispatch({ type: 'SET_PANEL_SIZE', payload: { trackListWidth: w } });
      }
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [dispatch]);

  // Remembers where playback started so spacebar stop can return there (Cubase behaviour)
  const prePlayPosRef = useRef<number>(0);
  // Saved when engineer presses Record — Stop Recording returns cursor here
  const recordingStartRef = useRef<number>(0);

  const handleSeek = useCallback((t: number) => {
    prePlayPosRef.current = t; // Stop returns to seeked position, not original play start
    actionsRef.current.seek(t);
    if (userRole === 'engineer') broadcastSeek(t);
  }, [userRole, broadcastSeek]);

  // Route incoming input events from Desktop RC and App RC data channels.
  // source is tagged at the channel level in useWebRTC — never infer from active-state booleans,
  // because both channels can be open simultaneously when the artist grants both permissions.
  const handleInputEvent = useCallback((event: RemoteInputEvent, source: 'app' | 'desktop') => {
    if (event.type === 'view-sync') {
      if (userRole === 'engineer' && rcActiveRef.current)
        arrangeRef.current?.applyViewSync(event.zoom, event.scrollLeft, event.scrollTop);
      return;
    }
    // Remote commands: engineer triggers operations on artist's machine via Desktop Control HUD
    if (event.type === 'remote-command' && userRole === 'artist') {
      if (event.command === 'open-audio-dialog') { handleRemoteImport(); }
      if (event.command === 'open-audio-settings') { setShowAudioPrefs(true); }
      return;
    }
    if (userRole === 'artist') {
      if (source === 'app') {
        replayAppEvent(event);
        return;
      }
      if (source === 'desktop') {
        if (event.type === 'pointermove') rcOverlayRef.current?.moveCursor(event.nx, event.ny);
        replayEvent(event);
      }
    }
  }, [userRole, replayEvent, replayAppEvent, handleRemoteImport]);

  // Engineer: always broadcast arrange viewport — artist mirrors it when Follow Engineer is on.
  // Artist: forward viewport to engineer during Desktop RC so they see what they're controlling.
  const handleViewChange = useCallback((zoom: number, scrollLeft: number, scrollTop: number) => {
    const now = Date.now();
    if (now - lastViewSyncRef.current < 33) return; // ~30 fps throttle
    lastViewSyncRef.current = now;
    if (userRole === 'engineer') {
      broadcastViewport(zoom, scrollLeft, scrollTop);
    } else if (userRole === 'artist' && rcActiveRef.current) {
      sendRcInputRef.current?.({ type: 'view-sync', zoom, scrollLeft, scrollTop });
    }
  }, [userRole, broadcastViewport]);

  const handlePlay = () => {
    prePlayPosRef.current = currentTimeRef.current;
    actionsRef.current.play();
    if (userRole === 'engineer') broadcastPlay(currentTimeRef.current);
  };
  // Stop and return to where play started (spacebar, transport Stop button)
  const handleStop = () => {
    actionsRef.current.pause();
    currentTimeRef.current = prePlayPosRef.current;
    dispatch({ type: 'SET_CURRENT_TIME', payload: prePlayPosRef.current });
    if (userRole === 'engineer') broadcastStop(prePlayPosRef.current);
  };
  // Return to absolute zero — only triggered by Numpad 0 / Enter
  const handleReturnToZero = () => {
    actionsRef.current.stop();
    prePlayPosRef.current = 0;
    if (userRole === 'engineer') broadcastStop(0);
  };
  const handleRecord = () => {
    if (userRole === 'engineer') {
      // Save the cursor position so Stop Recording can return here (Pro Tools / Cubase style)
      recordingStartRef.current = currentTimeRef.current;
      dispatch({ type: 'SET_RECORDING', payload: true });
      broadcastRecord(currentTimeRef.current);
      return;
    }
    actionsRef.current.record();
  };
  // Stop recording, halt playback, and return cursor to where recording started
  const handleStopRecording = useCallback(async () => {
    if (userRole === 'engineer') {
      const recStart = recordingStartRef.current;
      dispatch({ type: 'SET_RECORDING', payload: false });
      await actionsRef.current.pause();
      currentTimeRef.current = recStart;
      prePlayPosRef.current  = recStart;
      dispatch({ type: 'SET_CURRENT_TIME', payload: recStart });
      broadcastStopRecord(recStart);
      return;
    }
    await actionsRef.current.stopRecording();
  }, [userRole, dispatch, broadcastStopRecord]);

  useEffect(() => {
    const channel = supabase.channel(`daw-workspace-${roomCode}`, {
      // presence.key deduplicates by userId so a WebSocket reconnect (e.g. token
      // refresh during recording upload) doesn't fire a spurious 'leave' event.
      config: { broadcast: { self: false }, presence: { key: userId } },
    });

    // Debounce timer: guards against spurious 'leave' events fired when the
    // artist's WebSocket briefly reconnects (e.g. auth-token refresh during upload).
    // If presence 'sync' shows the artist is back within 3 s, the timer is cancelled.
    let artistLeftTimer: ReturnType<typeof setTimeout> | null = null;

    channel.on('presence', { event: 'sync' }, () => {
      const ps  = channel.presenceState();
      const all = Object.values(ps).flat() as any[];
      setOnlineCount(Object.keys(ps).length);
      // If a pending artist-left timer is running, cancel it — the artist is still here
      if (artistLeftTimer) {
        const artistStillPresent = all.some(p => p.role === 'artist' && p.user_id !== userId);
        if (artistStillPresent) {
          clearTimeout(artistLeftTimer);
          artistLeftTimer = null;
        }
      }
    });

    channel.on('presence', { event: 'join' }, ({ newPresences }) => {
      const others = newPresences.filter(p => p.user_id !== userId);
      if (others.length > 0) {
        const joinedRole = others[0].role || 'user';
        // Cancel pending artist-left if the artist just rejoined (reconnect case)
        if (joinedRole === 'artist' && artistLeftTimer) {
          clearTimeout(artistLeftTimer);
          artistLeftTimer = null;
        }
        setToast({ msg: `${joinedRole.charAt(0).toUpperCase() + joinedRole.slice(1)} joined the session!`, id: Date.now() });
        // Push live in-memory state to the rejoining peer so they sync instantly
        broadcastState();
      }
    });

    channel.on('presence', { event: 'leave' }, ({ leftPresences }) => {
      const others = leftPresences.filter(p => p.user_id !== userId);
      if (others.length > 0) {
        const leftRole = others[0].role || 'user';
        if (leftRole === 'engineer') {
          setDawControlActive(false);
          setToast({ msg: 'Engineer disconnected. Project is safe.', id: Date.now() });
        } else {
          setToast({ msg: `${leftRole.charAt(0).toUpperCase() + leftRole.slice(1)} left the session.`, id: Date.now() });
          if (leftRole === 'artist') {
            // Wait 3 s before acting — a WebSocket reconnect fires leave then sync,
            // and the sync handler will cancel this timer if the artist reappears.
            if (artistLeftTimer) clearTimeout(artistLeftTimer);
            artistLeftTimer = setTimeout(() => {
              artistLeftTimer = null;
              onArtistLeft?.();
            }, 3000);
          }
        }
      }
    });

    channel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await channel.track({ user_id: userId, role: userRole });
      }
    });

    return () => {
      if (artistLeftTimer) clearTimeout(artistLeftTimer);
      supabase.removeChannel(channel);
    };
  }, [roomCode, userRole, userId]);

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  // Artist: subscribe to ec-session channel to send/receive DAW control lifecycle events.
  // Sends: daw-control-granted, daw-control-revoked (to EngineerConsole)
  // Receives: daw-control-revoked (engineer exiting DAW voluntarily)
  useEffect(() => {
    if (userRole !== 'artist' || !roomCode) return;

    const ch = supabase.channel(`ec-session-${roomCode}`, {
      config: { broadcast: { ack: false } },
    });
    dawControlChannelRef.current = ch;

    ch.on('broadcast', { event: 'daw-control-revoked' }, () => {
      // Engineer exited DAW voluntarily — clear the status bar
      setDawControlActive(false);
    });

    ch.subscribe();

    return () => {
      supabase.removeChannel(ch);
      dawControlChannelRef.current = null;
    };
  }, [userRole, roomCode]);

  // Called (on both sides) when the unified consent modal grants DAW control
  const handleDawControlGranted = useCallback(() => {
    setDawControlActive(true);
    if (userRole === 'artist') {
      // Tell EngineerConsole the grant happened so it can set sl_ec_granted and transition phase
      dawControlChannelRef.current?.send({
        type: 'broadcast', event: 'daw-control-granted', payload: {},
      }).catch(() => {});
    }
  }, [userRole]);

  // Called (on both sides) when DAW control is revoked
  const handleDawControlRevoked = useCallback(() => {
    setDawControlActive(false);
    if (userRole === 'artist') {
      dawControlChannelRef.current?.send({
        type: 'broadcast', event: 'daw-control-revoked', payload: {},
      }).catch(() => {});
    }
  }, [userRole]);

  // Engineer: monitor source change — MIX mode mutes incoming call audio
  const handleMonitorSourceChange = useCallback((s: MonitorSource) => {
    setMonitorSource(s);
  }, []);

  // Artist: revoke DAW control — triggers the full teardown chain via FloatingVideoChat
  const handleArtistRevokeDawControl = useCallback(() => {
    floatingChatRef.current?.revokeDawControl();
    // revokeDawControl → stops App RC → sends signal → fires onDawControlRevoked
    // → handleDawControlRevoked → setDawControlActive(false) + broadcasts on ec-session
  }, []);


  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Alt+N: toggle Lyrics View (works even when a textarea is focused)
      if (e.altKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        setShowLyrics(v => !v);
        return;
      }

      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if (e.key === 'a' || e.key === 'A' || e.key === 'b' || e.key === 'B') {
        const { tracks, selectedTrackId } = state;
        const track = tracks.find(t => t.id === selectedTrackId && t.type === 'stereo');
        if (track) {
          const wantIdx = (e.key === 'a' || e.key === 'A') ? 0 : 1;
          if (wantIdx < track.versions.length) {
            dispatch({ type: 'SWITCH_VERSION', payload: { trackId: track.id, versionId: track.versions[wantIdx].id } });
          } else {
            dispatch({ type: 'ADD_VERSION', payload: { trackId: track.id } });
          }
          return;
        }
      }

      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'z') {
          e.preventDefault();
          dispatch({ type: e.shiftKey ? 'REDO' : 'UNDO' });
          return;
        }
        if (e.key === 'm') { e.preventDefault(); dispatch({ type: 'TOGGLE_METRONOME' }); return; }
        if (e.key === ',') { e.preventDefault(); setShowPreferences(true); return; }
      }

      if (e.key === 'Backspace' || e.key === 'Delete') {
        if (state.selectedRegionId) {
          dispatch({ type: 'REMOVE_REGION', payload: state.selectedRegionId });
          dispatch({ type: 'SELECT_REGION', payload: null });
        }
        return;
      }

      if (e.key === 'y' || e.key === 'Y') { e.preventDefault(); dispatch({ type: 'TOGGLE_LOOP' }); return; }
      if (e.key === 'r' || e.key === 'R') { handleRecord(); return; }

      if (e.key === 'd' || e.key === 'D') {
        if (state.selectedRegionId) {
          dispatch({ type: 'TOGGLE_REGION_MUTE', payload: state.selectedRegionId });
        }
        return;
      }

      // Numpad 0 / Enter → hard return to bar 1 (position 0)
      if (e.code === 'Numpad0' || e.code === 'Enter' || e.code === 'NumpadEnter') {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        e.preventDefault();
        handleReturnToZero();
        return;
      }

      if (e.code !== 'Space') return;
      if (e.repeat) return; // ignore key-repeat — only the initial press acts
      e.preventDefault();

      // Spacebar: play from cursor / stop and return to where play started
      if (state.transport.isPlaying) {
        handleStop();
      } else {
        handlePlay();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [state, dispatch, handlePlay, handleStop, handleReturnToZero, handleRecord, setShowLyrics]);

  return (
    <div
      className={[
        'daw-workspace',
        `density-${state.uiDensity}`,
        userRole === 'artist' && rcActive && !rcViewOnly ? 'rc-desktop-active' : '',
        userRole === 'artist' && rcActive && rcViewOnly  ? 'rc-screen-view-active' : '',
      ].filter(Boolean).join(' ')}
      style={{
        position: 'relative',
        ...({
          '--inspector-w': state.panelVisibility.inspector ? `${state.panelSizes.inspectorWidth}px` : '0px',
          '--tracklist-w': `${state.panelSizes.trackListWidth}px`,
          '--mixer-h': state.panelVisibility.mixer ? `${state.panelSizes.mixerHeight}px` : '0px',
        } as React.CSSProperties),
      }}
    >
      <MenuBar
        userRole={userRole}
        onSendRemoteCommand={userRole === 'engineer' ? broadcastRemoteOp : undefined}
        onOpenAudioPrefs={() => {
          if (userRole === 'engineer') broadcastRemoteOp('open-audio-settings');
          else setShowAudioPrefs(true);
        }}
        onLeaveSession={() => {
          localStorage.removeItem('sl_room');
          localStorage.removeItem('sl_showApp');
          localStorage.removeItem('sl_role');
          window.location.reload();
        }}
        onCloseProject={async () => {
          await supabase.auth.signOut();
          localStorage.removeItem('sl_room');
          localStorage.removeItem('sl_showApp');
          localStorage.removeItem('sl_role');
          window.location.reload();
        }}
        onToggleLyrics={() => setShowLyrics(v => !v)}
        isAdmin={isAdmin}
        onOpenAdmin={onOpenAdmin}
      />
      {showPreferences && <PreferencesDialog onClose={() => setShowPreferences(false)} />}
      {showAudioPrefs && <AudioMIDIPreferencesDialog onClose={() => setShowAudioPrefs(false)} />}
      {showLyrics && <LyricsPanel onClose={() => setShowLyrics(false)} />}
      <TopToolbar roomCode={roomCode} userRole={userRole} onlineCount={onlineCount} desktopActive={rcActive} />

      {/* ── Artist: persistent control status bar — one row per active permission ── */}
      {userRole === 'artist' && (dawControlActive || rcActive) && (
        <div className="daw-engineer-control-bar">
          {dawControlActive && (
            <div className="daw-ec-row">
              <span className="daw-ec-dot" />
              <span className="daw-ec-label">DAW Control: Active</span>
              <label className="daw-ec-follow">
                <input
                  type="checkbox"
                  checked={followEngineer}
                  onChange={e => setFollowEngineer(e.target.checked)}
                />
                Follow Engineer
              </label>
              <button className="daw-ec-revoke-btn" onClick={handleArtistRevokeDawControl}>
                Revoke
              </button>
            </div>
          )}
          {rcActive && (
            <div className="daw-ec-row">
              <span className={`daw-ec-dot ${rcViewOnly ? 'view' : 'desktop'}`} />
              <span className={`daw-ec-label ${rcViewOnly ? 'view' : 'desktop'}`}>
                {rcViewOnly ? 'Screen View: Active' : 'Desktop Control: Full'}
              </span>
              <button
                className="daw-ec-revoke-btn"
                onClick={() => floatingChatRef.current?.revokeDesktopControl()}
              >
                {rcViewOnly ? 'Stop Sharing' : 'Revoke'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Engineer: Monitor Stream panel (master bus, always visible) ── */}
      {userRole === 'engineer' && (
        <MonitorPanel
          remoteStream={liveRemoteStream}
          isReceiving={isReceiving}
          connectionState={monitorConnectionState}
          quality={monitorQuality}
          onQualityChange={(q) => { setMonitorQuality(q); requestQuality(q); }}
          source={monitorSource}
          onSourceChange={handleMonitorSourceChange}
        />
      )}

      {/* ── Engineer: Remote Session header ── */}
      {userRole === 'engineer' && (
        <div className="daw-remote-studio-bar">
          <span className="daw-rs-dot" />
          <span className="daw-rs-label">REMOTE SESSION</span>
          <span className="daw-rs-sep" />
          {artistName && <span className="daw-rs-chip">Artist: {artistName}</span>}
          <span className={`daw-rs-chip ${dawControlActive ? 'active' : 'off'}`}>
            DAW Control: {dawControlActive ? 'Active' : 'Off'}
          </span>
          <span className={`daw-rs-chip ${rcActive ? 'active' : 'off'}`}>
            Desktop Control: {rcActive ? 'Active' : 'Off'}
          </span>
          <span className="daw-rs-chip active">Video: Connected</span>
          {onExitDawControl && (
            <button className="daw-rs-exit-btn" onClick={onExitDawControl}>
              Exit Remote View
            </button>
          )}
        </div>
      )}

      {toast && (
        <div key={toast.id} className="daw-toast-notification">
          {toast.msg}
        </div>
      )}


      <div className="daw-main-area">
        {state.panelVisibility.inspector && (
          <>
            <InspectorPanel onClose={() => dispatch({ type: 'SET_PANEL_VISIBILITY', payload: { inspector: false } })} />
            <div
              className="panel-resize-handle panel-resize-h"
              onPointerDown={e => startResize(e, 'inspector')}
              title="Drag to resize inspector"
            />
          </>
        )}

        <div className="daw-arrange-section">
          <div className="daw-arrange-container">
            <TrackList />
            <div
              className="panel-resize-handle panel-resize-h"
              onPointerDown={e => startResize(e, 'tracklist')}
              title="Drag to resize track list"
            />
            <ArrangeWindow
              ref={arrangeRef}
              onSeek={handleSeek}
              onViewChange={handleViewChange}
            />
          </div>
          {state.panelVisibility.mixer && (
            <>
              <div
                className="panel-resize-handle panel-resize-v"
                onPointerDown={e => startResize(e, 'mixer')}
                title="Drag to resize mixer"
              />
              <MixerPanel onClose={() => dispatch({ type: 'SET_PANEL_VISIBILITY', payload: { mixer: false } })} />
            </>
          )}
        </div>

        {state.panelVisibility.mediaPool && <MediaPoolPanel onClose={() => dispatch({ type: 'SET_PANEL_VISIBILITY', payload: { mediaPool: false } })} />}
      </div>

      <TransportPanel
        toggleInspector={() => dispatch({ type: 'SET_PANEL_VISIBILITY', payload: { inspector: !state.panelVisibility.inspector } })}
        toggleMixer={() => dispatch({ type: 'SET_PANEL_VISIBILITY', payload: { mixer: !state.panelVisibility.mixer } })}
        toggleMediaPool={() => dispatch({ type: 'SET_PANEL_VISIBILITY', payload: { mediaPool: !state.panelVisibility.mediaPool } })}
        onPlay={handlePlay}
        onStop={handleStop}
        onReturnToZero={handleReturnToZero}
        onRecord={handleRecord}
        onStopRecording={handleStopRecording}
        userRole={userRole}
        isStreaming={isStreaming}
        isReceiving={isReceiving}
        onToggleStream={handleToggleStream}
      />

      <FloatingVideoChat
        ref={floatingChatRef}
        userRole={userRole}
        userId={userId}
        roomCode={roomCode}
        masterStreamRef={masterStreamRef}
        audioCtxRef={audioCtxRef}
        onInputEvent={handleInputEvent}
        onRcStateChange={handleRcStateChange}
        onAppRcChange={handleAppRcChange}
        dawControlActive={dawControlActive}
        onDawControlGranted={handleDawControlGranted}
        onDawControlRevoked={handleDawControlRevoked}
        muteCallAudio={monitorSource === 'mix'}
      />

      {/* Desktop RC — DesktopControlFullscreen handles event capture; badge shown here */}
      {rcActive && userRole === 'engineer' && (
        <RemoteControlOverlay
          userRole="engineer"
          viewOnly={rcViewOnly}
          mode="desktop"
        />
      )}
      {rcActive && userRole === 'artist' && (
        <RemoteControlOverlay
          ref={rcOverlayRef}
          userRole="artist"
          onRevoke={() => floatingChatRef.current?.revokeDesktopControl()}
          viewOnly={rcViewOnly}
          mode="desktop"
        />
      )}
    </div>
  );
};

export default DawWorkspace;
