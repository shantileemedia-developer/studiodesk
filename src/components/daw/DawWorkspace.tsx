import { useState, useEffect, useRef, useCallback } from 'react';
import './DawWorkspace.css';
import { useAudioEngine } from '../../hooks/useAudioEngine';
import { useDawSync } from '../../hooks/useDawSync';
import { useDaw } from '../../context/DawContext';
import { useRemoteControlReplay } from '../../hooks/useRemoteControl';
import { useAudioStream } from '../../hooks/useAudioStream';
import type { RemoteInputEvent } from '../../types/remote';
import TransportPanel from './TransportPanel';
import InspectorPanel from './InspectorPanel';
import TrackList from './TrackList';
import ArrangeWindow from './ArrangeWindow';
import MediaPoolPanel from './MediaPoolPanel';
import TopToolbar from './TopToolbar';
import MenuBar from './MenuBar';
import PreferencesDialog from './PreferencesDialog';
import FloatingVideoChat from './FloatingVideoChat';
import RemoteControlOverlay from './RemoteControlOverlay';
import MixerPanel from './MixerPanel';
import AudioMIDIPreferencesDialog from './AudioMIDIPreferencesDialog';
import { supabase } from '../../lib/supabaseClient';

interface DawWorkspaceProps {
  userRole: 'artist' | 'engineer';
  userId: string;
  roomCode: string;
}

const DawWorkspace: React.FC<DawWorkspaceProps> = ({ userRole, userId, roomCode }) => {
  const [showInspector, setShowInspector] = useState(true);
  const [showMixer, setShowMixer] = useState(true);
  const [showPreferences, setShowPreferences] = useState(false);
  const [showAudioPrefs, setShowAudioPrefs] = useState(false);
  const [onlineCount, setOnlineCount] = useState(1);
  const [toast, setToast] = useState<{ msg: string; id: number } | null>(null);
  const [rcActive, setRcActive] = useState(false);
  const [rcScreenStream, setRcScreenStream] = useState<MediaStream | null>(null);
  const [remoteCursorPos, setRemoteCursorPos] = useState<{ nx: number; ny: number } | null>(null);
  const sendRcInputRef = useRef<((e: RemoteInputEvent) => void) | null>(null);
  // Persistent subscribed channel ref — avoids the silent-drop bug
  // where supabase.channel() called at send-time creates a fresh, unsubscribed handle
  const workspaceChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  const { play, pause, stop, record } = useAudioEngine();
  const { state, dispatch, masterStreamRef, audioCtxRef, currentTimeRef } = useDaw();

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

  useDawSync(roomCode);

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

  // Artist: replay remote input events when RC is active
  const { replayEvent } = useRemoteControlReplay(rcActive && userRole === 'artist');

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

  const handleRcStateChange = useCallback((
    active: boolean,
    sendFn: ((e: RemoteInputEvent) => void) | null,
    screenStream: MediaStream | null,
  ) => {
    setRcActive(active);
    sendRcInputRef.current = sendFn;
    setRcScreenStream(active ? screenStream : null);
    if (!active) setRemoteCursorPos(null);
  }, []);

  // Remembers where playback started so spacebar stop can return there (Cubase behaviour)
  const prePlayPosRef = useRef<number>(0);
  const actionsRef = useRef({ play, pause, stop, record });
  useEffect(() => {
    actionsRef.current = { play, pause, stop, record };
  }, [play, pause, stop, record]);

  // ── Remote Control RPC — with ack + retry ───────────────────
  // sendRemoteCmd uses the already-subscribed workspaceChannelRef so the
  // broadcast actually reaches the Supabase realtime server. A fresh
  // supabase.channel() call (old code) returns an unsubscribed handle whose
  // .send() silently no-ops.
  const sendRemoteCmd = useCallback(
    (action: 'play' | 'stop' | 'record', attempt = 0) => {
      const ch = workspaceChannelRef.current;
      if (!ch) return;

      const ackEvent = `rpc-ack-${action}-${Date.now()}`;
      let ackReceived = false;

      // Listen for ack (Artist side echoes back)
      const unsub = ch.on('broadcast', { event: 'rpc-ack' }, ({ payload }) => {
        if (payload.action === action) {
          ackReceived = true;
        }
      });

      ch.send({ type: 'broadcast', event: 'rpc', payload: { action, ackEvent } })
        .catch(err => console.error('RPC send failed:', err));

      // Retry if no ack within 2 s (max 3 attempts)
      setTimeout(() => {
        // Unsubscribe the one-shot ack listener
        (unsub as unknown as { unsubscribe?: () => void })?.unsubscribe?.();
        if (!ackReceived && attempt < 2) {
          console.warn(`RPC "${action}" no ack — retry ${attempt + 1}`);
          sendRemoteCmd(action, attempt + 1);
        } else if (!ackReceived) {
          setToast({ msg: `Remote command "${action}" may not have reached the Artist.`, id: Date.now() });
        }
      }, 2000);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const handlePlay = () => {
    prePlayPosRef.current = currentTimeRef.current;   // remember cursor position
    actionsRef.current.play();
    if (userRole === 'engineer') sendRemoteCmd('play');
  };
  // Stop and return to where play started (spacebar, transport Stop button)
  const handleStop = () => {
    actionsRef.current.pause();
    currentTimeRef.current = prePlayPosRef.current;
    dispatch({ type: 'SET_CURRENT_TIME', payload: prePlayPosRef.current });
    if (userRole === 'engineer') sendRemoteCmd('stop');
  };
  // Return to absolute zero — only triggered by Numpad 0 / Enter
  const handleReturnToZero = () => {
    actionsRef.current.stop();
    prePlayPosRef.current = 0;
    if (userRole === 'engineer') sendRemoteCmd('stop');
  };
  const handleRecord = () => {
    actionsRef.current.record();
    if (userRole === 'engineer') {
      sendRemoteCmd('record');
      setToast({ msg: '● Record command sent — ensure Artist has a track armed.', id: Date.now() });
    }
  };

  useEffect(() => {
    const channel = supabase.channel(`daw-workspace-${roomCode}`, {
      config: { broadcast: { self: false } },
    });
    workspaceChannelRef.current = channel;

    // Artist: execute incoming RPC and send ack so Engineer's retry logic settles
    channel.on('broadcast', { event: 'rpc' }, ({ payload }) => {
      if (userRole === 'artist') {
        if (payload.action === 'play')   actionsRef.current.play();
        if (payload.action === 'stop')   actionsRef.current.stop();
        if (payload.action === 'record') actionsRef.current.record();
        // Echo ack back
        channel.send({ type: 'broadcast', event: 'rpc-ack', payload: { action: payload.action } })
          .catch(() => {});
      }
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
      workspaceChannelRef.current = null;
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
        if (e.key === 'l') { e.preventDefault(); dispatch({ type: 'TOGGLE_LOOP' }); return; }
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

      if (e.key === 'r' || e.key === 'R') { handleRecord(); return; }

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
  }, [state, dispatch, handlePlay, handleStop, handleReturnToZero, handleRecord]);

  return (
    <div className="daw-workspace" style={{ position: 'relative' }}>
      {/* Hidden audio output for received live stream (Engineer side) */}
      {userRole === 'engineer' && <audio ref={liveAudioRef} autoPlay style={{ display: 'none' }} />}
      <MenuBar
        onOpenAudioPrefs={() => setShowAudioPrefs(true)}
        onCloseProject={() => {
          localStorage.removeItem('sl_room');
          localStorage.removeItem('sl_showApp');
          window.location.reload();
        }}
      />
      {showPreferences && <PreferencesDialog onClose={() => setShowPreferences(false)} />}
      {showAudioPrefs && <AudioMIDIPreferencesDialog onClose={() => setShowAudioPrefs(false)} />}
      <TopToolbar roomCode={roomCode} userRole={userRole} onlineCount={onlineCount} />

      {toast && (
        <div key={toast.id} className="daw-toast-notification">
          {toast.msg}
        </div>
      )}

      <div className="daw-main-area">
        {showInspector && <InspectorPanel />}

        <div className="daw-arrange-section">
          <div className="daw-arrange-container">
            <TrackList />
            <ArrangeWindow />
          </div>
          {showMixer && <MixerPanel />}
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
        onInputEvent={userRole === 'artist'
          ? (event) => {
              // Intercept pointermove to update the cursor position before replaying
              if (event.type === 'pointermove') {
                setRemoteCursorPos({ nx: (event as any).nx, ny: (event as any).ny });
              }
              replayEvent(event);
            }
          : undefined
        }
        onRcStateChange={handleRcStateChange}
      />

      {/* Remote control overlays */}
      {rcActive && userRole === 'engineer' && (
        <RemoteControlOverlay
          userRole="engineer"
          remoteScreenStream={rcScreenStream}
          onSendInput={(e) => sendRcInputRef.current?.(e)}
          onExit={() => setRcActive(false)}
        />
      )}
      {rcActive && userRole === 'artist' && (
        <RemoteControlOverlay
          userRole="artist"
          remoteCursorPos={remoteCursorPos}
          onRevoke={() => setRcActive(false)}
        />
      )}
    </div>
  );
};

export default DawWorkspace;
