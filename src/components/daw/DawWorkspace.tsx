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
import FloatingVideoChat from './FloatingVideoChat';
import RemoteControlOverlay, { type RemoteControlOverlayHandle } from './RemoteControlOverlay';
import MixerPanel from './MixerPanel';
import AudioMIDIPreferencesDialog from './AudioMIDIPreferencesDialog';
import LyricsPanel from './LyricsPanel';
import { supabase } from '../../lib/supabaseClient';

interface DawWorkspaceProps {
  userRole: 'artist' | 'engineer';
  userId: string;
  roomCode: string;
  isAdmin?: boolean;
  onOpenAdmin?: () => void;
}

const DawWorkspace: React.FC<DawWorkspaceProps> = ({ userRole, userId, roomCode, isAdmin, onOpenAdmin }) => {
  const [showInspector, setShowInspector] = useState(true);
  const [showMixer, setShowMixer] = useState(true);
  const [showPreferences, setShowPreferences] = useState(false);
  const [showAudioPrefs, setShowAudioPrefs] = useState(false);
  const [showLyrics, setShowLyrics] = useState(false);
  const [onlineCount, setOnlineCount] = useState(1);
  const [toast, setToast] = useState<{ msg: string; id: number } | null>(null);
  const [appRcActive, setAppRcActive] = useState(false);
  const [rcActive, setRcActive] = useState(false);
  const [rcViewOnly, setRcViewOnly] = useState(false);
  const sendRcInputRef    = useRef<((e: RemoteInputEvent) => void) | null>(null);
  const appRcSendFnRef    = useRef<((e: RemoteInputEvent) => void) | null>(null);
  const rcOverlayRef     = useRef<RemoteControlOverlayHandle>(null);
  const arrangeRef       = useRef<ArrangeWindowHandle>(null);
  const appRcActiveRef   = useRef(false);
  const rcActiveRef      = useRef(false);
  const lastViewSyncRef  = useRef(0);
  // Stable callback — never recreated, so engineer's window listeners are never torn down
  const onSendRcInput    = useCallback((e: RemoteInputEvent) => sendRcInputRef.current?.(e), []);

  const webAudio   = useAudioEngine();
  const nativeAudio = useNativeAudioEngine();
  // Use native engine when available; fall back to Web Audio API
  const { play, pause, stop, record, seek } = nativeAudio.nativeAvailable ? nativeAudio : webAudio;
  const { state, dispatch, masterStreamRef, audioCtxRef, currentTimeRef } = useDaw();

  // Stable ref to engine functions — declared early so transport-sync callbacks can use it
  // without ordering issues. Updated whenever the engine functions change identity.
  const actionsRef = useRef({ play, pause, stop, record, seek });
  useEffect(() => {
    actionsRef.current = { play, pause, stop, record, seek };
  }, [play, pause, stop, record, seek]);

  // ── Live stream (ListenTo-style) ────────────────────────────
  const getMasterStream = useCallback(() => {
    // Initialise AudioContext on first call (must be inside a user-gesture callsite)
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') return null;
    if (!masterStreamRef.current) return null;
    return masterStreamRef.current.stream;
  }, [audioCtxRef, masterStreamRef]);

  const {
    isStreaming, isReceiving, remoteStream: liveRemoteStream,
    startStream, stopStream,
  } = useAudioStream({ roomCode, userId, userRole, getMasterStream });

  const liveAudioRef = useRef<HTMLAudioElement>(null);

  // Transport sync callback: when SET_PLAYING arrives from the network (peer clicked play/stop),
  // drive the LOCAL audio engine so both sides stay in sync without coordinate-based RC clicks.
  // The `actionsRef` is stable so this callback never needs to be recreated.
  const onTransportSync = useCallback((playing: boolean) => {
    if (playing) {
      actionsRef.current.play();
    } else {
      actionsRef.current.pause();
    }
  }, []);

  useDawSync(roomCode, onTransportSync);

  // Keep OS window title in sync with project name
  useEffect(() => {
    document.title = `${state.projectName ?? 'Untitled Project'} — StudioDESK`;
  }, [state.projectName]);

  // Play received live stream in a hidden audio element
  useEffect(() => {
    if (liveAudioRef.current && liveRemoteStream) {
      liveAudioRef.current.srcObject = liveRemoteStream;
    }
  }, [liveRemoteStream]);

  // Artist: replay remote input events when any RC mode is active
  const { replayEvent } = useRemoteControlReplay(
    (appRcActive || rcActive) && userRole === 'artist',
    rcActive ? 'desktop' : 'app',
  );

  // Hide artist's own cursor while RC active so only the engineer's dot is visible
  useEffect(() => {
    if (userRole !== 'artist') return;
    document.body.classList.toggle('rc-artist-active', appRcActive || rcActive);
    return () => { document.body.classList.remove('rc-artist-active'); };
  }, [appRcActive, rcActive, userRole]);

  // Stream toggle — artist must have played once so AudioContext is alive
  const handleToggleStream = useCallback(() => {
    if (isStreaming) {
      stopStream();
    } else {
      // Ensure AudioContext is initialised (requires prior user gesture — play/record)
      if (!audioCtxRef.current) {
        alert('Press Play at least once to initialise the audio engine, then start streaming.');
        return;
      }
      startStream();
    }
  }, [isStreaming, startStream, stopStream, audioCtxRef]);

  const handleAppRcChange = useCallback((
    active: boolean,
    sendFn: ((e: RemoteInputEvent) => void) | null,
  ) => {
    setAppRcActive(active);
    appRcActiveRef.current = active;
    appRcSendFnRef.current = active ? sendFn : null;
    // Only update the active send fn from App RC if Desktop RC isn't currently overriding it
    if (!rcActiveRef.current) sendRcInputRef.current = appRcSendFnRef.current;
  }, []);

  const handleRcStateChange = useCallback((
    active: boolean,
    sendFn: ((e: RemoteInputEvent) => void) | null,
    viewOnly: boolean,
  ) => {
    setRcActive(active);
    rcActiveRef.current = active;
    setRcViewOnly(viewOnly);
    if (active) {
      sendRcInputRef.current = sendFn;
    } else {
      // Desktop RC ended — restore App RC send fn (sendFn is null here, use stored ref)
      sendRcInputRef.current = appRcActiveRef.current ? appRcSendFnRef.current : null;
    }
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

  const handleSeek = useCallback((t: number) => {
    prePlayPosRef.current = t; // Stop returns to seeked position, not original play start
    actionsRef.current.seek(t);
  }, []);

  const handleInputEvent = useCallback((event: RemoteInputEvent) => {
    // Engineer receives view-sync from artist → mirror their view
    if (userRole === 'engineer') {
      if (event.type === 'view-sync') {
        arrangeRef.current?.applyViewSync(event.zoom, event.scrollLeft, event.scrollTop);
      }
      return;
    }
    // Artist receives input events from engineer → replay them
    if (event.type === 'pointermove') rcOverlayRef.current?.moveCursor(event.nx, event.ny);
    if (event.type !== 'view-sync') replayEvent(event);
  }, [userRole, replayEvent]);

  // Artist → engineer: broadcast view state changes when any RC is active (max 30fps)
  const handleViewChange = useCallback((zoom: number, scrollLeft: number, scrollTop: number) => {
    if ((!rcActiveRef.current && !appRcActiveRef.current) || userRole !== 'artist') return;
    const now = Date.now();
    if (now - lastViewSyncRef.current < 33) return;
    lastViewSyncRef.current = now;
    sendRcInputRef.current?.({ type: 'view-sync', zoom, scrollLeft, scrollTop });
  }, [userRole]);

  const handlePlay = () => {
    prePlayPosRef.current = currentTimeRef.current;
    actionsRef.current.play();
  };
  // Stop and return to where play started (spacebar, transport Stop button)
  const handleStop = () => {
    actionsRef.current.pause();
    currentTimeRef.current = prePlayPosRef.current;
    dispatch({ type: 'SET_CURRENT_TIME', payload: prePlayPosRef.current });
  };
  // Return to absolute zero — only triggered by Numpad 0 / Enter
  const handleReturnToZero = () => {
    actionsRef.current.stop();
    prePlayPosRef.current = 0;
  };
  const handleRecord = () => {
    actionsRef.current.record();
  };

  useEffect(() => {
    const channel = supabase.channel(`daw-workspace-${roomCode}`, {
      config: { broadcast: { self: false } },
    });

    channel.on('presence', { event: 'sync' }, () => {
      const presenceState = channel.presenceState();
      setOnlineCount(Object.keys(presenceState).length);
    });

    channel.on('presence', { event: 'join' }, ({ newPresences }) => {
      const others = newPresences.filter(p => p.user_id !== userId);
      if (others.length > 0) {
        const joinedRole = others[0].role || 'user';
        setToast({ msg: `${joinedRole.charAt(0).toUpperCase() + joinedRole.slice(1)} joined the session!`, id: Date.now() });
      }
    });

    channel.on('presence', { event: 'leave' }, ({ leftPresences }) => {
      const others = leftPresences.filter(p => p.user_id !== userId);
      if (others.length > 0) {
        const leftRole = others[0].role || 'user';
        setToast({ msg: `${leftRole.charAt(0).toUpperCase() + leftRole.slice(1)} left the session.`, id: Date.now() });
      }
    });

    channel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await channel.track({ user_id: userId, role: userRole });
      }
    });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [roomCode, userRole, userId]);

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

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
      className={`daw-workspace density-${state.uiDensity}`}
      style={{
        position: 'relative',
        ...({
          '--inspector-w': showInspector ? `${state.panelSizes.inspectorWidth}px` : '0px',
          '--tracklist-w': `${state.panelSizes.trackListWidth}px`,
          '--mixer-h': showMixer ? `${state.panelSizes.mixerHeight}px` : '0px',
        } as React.CSSProperties),
      }}
    >
      {/* Hidden audio output for received live stream (Engineer side) */}
      {userRole === 'engineer' && <audio ref={liveAudioRef} autoPlay style={{ display: 'none' }} />}
      <MenuBar
        onOpenAudioPrefs={() => setShowAudioPrefs(true)}
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

      {toast && (
        <div key={toast.id} className="daw-toast-notification">
          {toast.msg}
        </div>
      )}

      <div className="daw-main-area">
        {showInspector && (
          <>
            <InspectorPanel onClose={() => setShowInspector(false)} />
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
          {showMixer && (
            <>
              <div
                className="panel-resize-handle panel-resize-v"
                onPointerDown={e => startResize(e, 'mixer')}
                title="Drag to resize mixer"
              />
              <MixerPanel onClose={() => setShowMixer(false)} />
            </>
          )}
        </div>

        <MediaPoolPanel />
      </div>

      <TransportPanel
        toggleInspector={() => setShowInspector(v => !v)}
        toggleMixer={() => setShowMixer(v => !v)}
        onPlay={handlePlay}
        onStop={handleStop}
        onReturnToZero={handleReturnToZero}
        onRecord={handleRecord}
        userRole={userRole}
        isStreaming={isStreaming}
        isReceiving={isReceiving}
        onToggleStream={handleToggleStream}
      />

      <FloatingVideoChat
        userRole={userRole}
        userId={userId}
        roomCode={roomCode}
        masterStreamRef={masterStreamRef}
        audioCtxRef={audioCtxRef}
        onInputEvent={handleInputEvent}
        onRcStateChange={handleRcStateChange}
        onAppRcChange={handleAppRcChange}
      />

      {/* App RC — automatic, no permission; hidden when Desktop RC takes over */}
      {appRcActive && !rcActive && userRole === 'engineer' && (
        <RemoteControlOverlay
          userRole="engineer"
          onSendInput={onSendRcInput}
          mode="app"
        />
      )}
      {appRcActive && !rcActive && userRole === 'artist' && (
        <RemoteControlOverlay
          ref={rcOverlayRef}
          userRole="artist"
          mode="app"
        />
      )}

      {/* Desktop RC — permission-gated, supersedes App RC overlay */}
      {rcActive && userRole === 'engineer' && (
        <RemoteControlOverlay
          userRole="engineer"
          onSendInput={onSendRcInput}
          onExit={() => setRcActive(false)}
          viewOnly={rcViewOnly}
          mode="desktop"
        />
      )}
      {rcActive && userRole === 'artist' && (
        <RemoteControlOverlay
          ref={rcOverlayRef}
          userRole="artist"
          onRevoke={() => setRcActive(false)}
          viewOnly={rcViewOnly}
          mode="desktop"
        />
      )}
    </div>
  );
};

export default DawWorkspace;
