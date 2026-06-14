import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Video, Mic, MicOff, VideoOff, Minimize2, X, PhoneCall, MessageSquare, MonitorPlay, MonitorX } from 'lucide-react';
import { useWebRTC } from '../../hooks/useWebRTC';
import { useDaw } from '../../context/DawContext';
import { useAudioEngine } from '../../hooks/useAudioEngine';
import type { RemoteInputEvent } from '../../types/remote';
import './FloatingVideoChat.css';

interface FloatingVideoChatProps {
  userRole: 'artist' | 'engineer';
  userId: string;
  roomCode: string;
  onInputEvent?: (event: RemoteInputEvent) => void;
  /** active, sendFn, remoteScreenStream */
  onRcStateChange?: (active: boolean, sendFn: ((e: RemoteInputEvent) => void) | null, screenStream: MediaStream | null) => void;
}

// ── Ringtone synthesized via Web Audio ───────────────────────────────────────
function useRingtone(isRinging: boolean) {
  const ctxRef = useRef<AudioContext | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isRinging) {
      // Stop ringing
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
      ctxRef.current?.close().catch(() => {});
      ctxRef.current = null;
      return;
    }

    const ctx = new AudioContext();
    ctxRef.current = ctx;

    const playChirp = () => {
      if (!ctxRef.current || ctxRef.current.state === 'closed') return;
      const now = ctx.currentTime;
      [0, 0.18].forEach((offset, i) => {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(i === 0 ? 880 : 1100, now + offset);
        osc.frequency.exponentialRampToValueAtTime(i === 0 ? 660 : 880, now + offset + 0.15);
        gain.gain.setValueAtTime(0, now + offset);
        gain.gain.linearRampToValueAtTime(0.35, now + offset + 0.02);
        gain.gain.linearRampToValueAtTime(0, now + offset + 0.15);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + offset);
        osc.stop(now + offset + 0.16);
      });
    };

    playChirp();
    intervalRef.current = setInterval(playChirp, 2000);

    return () => {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
      ctx.close().catch(() => {});
    };
  }, [isRinging]);
}

// ─────────────────────────────────────────────────────────────────────────────

const FloatingVideoChat: React.FC<FloatingVideoChatProps> = ({
  userRole, userId, roomCode, onInputEvent, onRcStateChange,
}) => {
  const [isMinimized, setIsMinimized] = useState(true);
  const [showChat, setShowChat] = useState(false);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [monitorVolume, setMonitorVolume] = useState(0.7);
  const [rcDenied, setRcDenied] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; initialX: number; initialY: number } | null>(null);

  const { masterStreamRef, audioCtxRef } = useDaw();
  const { initAudioCtx } = useAudioEngine();

  const monitorGainRef   = useRef<GainNode | null>(null);
  const monitorSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  const {
    localStream, remoteStream, remoteDawStream, remoteScreenStream, isConnected, callActive,
    isMicOn, isVideoOn,
    incomingCall, isCalling, callerId, messages,
    ring, acceptCall, declineCall, sendMessage,
    endCall, toggleMic, toggleVideo,
    rcRequested, rcActive,
    requestRemoteControl, startScreenShare, stopRemoteControl,
    sendInputEvent,
  } = useWebRTC({
    roomCode,
    userId,
    isInitiator: userRole === 'engineer',
    getDawStream: () => {
      if (userRole === 'artist') {
        initAudioCtx();
        return masterStreamRef.current?.stream ?? null;
      }
      return null;
    },
    onInputEvent,
  });

  // ── Video refs — always mounted so srcObject is never lost ───────────────
  const localVideoRef  = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const chatScrollRef  = useRef<HTMLDivElement>(null);

  // Assign streams whenever they change (refs are always in the DOM)
  useEffect(() => {
    if (localVideoRef.current) localVideoRef.current.srcObject = localStream ?? null;
  }, [localStream]);

  useEffect(() => {
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream ?? null;
  }, [remoteStream]);

  // Engineer: monitor Artist DAW through a GainNode
  useEffect(() => {
    if (userRole !== 'engineer' || !remoteDawStream) return;
    let ctx = audioCtxRef.current;
    if (!ctx || ctx.state === 'closed') { ctx = new AudioContext(); audioCtxRef.current = ctx; }
    const resume = ctx.state === 'suspended' ? ctx.resume() : Promise.resolve();
    let gainNode: GainNode, source: MediaStreamAudioSourceNode;
    resume.then(() => {
      if (!ctx) return;
      monitorSourceRef.current?.disconnect();
      monitorGainRef.current?.disconnect();
      source = ctx.createMediaStreamSource(remoteDawStream);
      gainNode = ctx.createGain();
      gainNode.gain.value = monitorVolume;
      source.connect(gainNode);
      gainNode.connect(ctx.destination);
      monitorSourceRef.current = source;
      monitorGainRef.current   = gainNode;
    });
    return () => {
      source?.disconnect();
      gainNode?.disconnect();
      monitorSourceRef.current = null;
      monitorGainRef.current   = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteDawStream, userRole, audioCtxRef]);

  useEffect(() => {
    if (monitorGainRef.current) monitorGainRef.current.gain.setTargetAtTime(monitorVolume, 0, 0.02);
  }, [monitorVolume]);

  useEffect(() => {
    if (chatScrollRef.current) chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
  }, [messages, showChat]);

  useEffect(() => { if (!rcRequested) setRcDenied(false); }, [rcRequested]);

  useEffect(() => {
    onRcStateChange?.(rcActive, rcActive ? sendInputEvent : null, rcActive ? remoteScreenStream : null);
  }, [rcActive, sendInputEvent, onRcStateChange, remoteScreenStream]);

  // ── Ringtone — plays for both the caller (isCalling) and callee (incomingCall) ──
  useRingtone(incomingCall || isCalling);

  // ── Drag Handlers ────────────────────────────────────────────────────────
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const rect = e.currentTarget.parentElement!.getBoundingClientRect();
    dragRef.current = {
      startX: e.clientX, startY: e.clientY,
      initialX: position ? position.x : rect.left,
      initialY: position ? position.y : rect.top,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    setPosition({
      x: dragRef.current.initialX + (e.clientX - dragRef.current.startX),
      y: dragRef.current.initialY + (e.clientY - dragRef.current.startY),
    });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  };

  // ── Always-mounted hidden video elements (prevent srcObject loss on minimize) ──
  const hiddenVideos = (
    <>
      <video ref={remoteVideoRef} autoPlay playsInline style={{ display: 'none' }} />
      <video ref={localVideoRef}  autoPlay playsInline muted style={{ display: 'none' }} />
    </>
  );

  // ── Incoming call — centered fullscreen portal ────────────────────────────
  const incomingCallModal = incomingCall ? createPortal(
    <div className="incoming-call-modal">
      <div className="incoming-call-modal-card">
        <div className="incoming-call-avatar">{callerId?.[0]?.toUpperCase() || '?'}</div>
        <div className="incoming-call-text">Incoming Call…</div>
        <div className="incoming-call-from">{callerId ?? 'Unknown'}</div>
        <div className="incoming-call-actions">
          <button className="control-btn end-call" onClick={declineCall} title="Decline">
            <X size={20} />
            <span style={{ marginLeft: 6, fontSize: 12 }}>Decline</span>
          </button>
          <button className="control-btn start-call" onClick={acceptCall} title="Accept">
            <PhoneCall size={20} />
            <span style={{ marginLeft: 6, fontSize: 12 }}>Accept</span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  ) : null;

  // ── RC consent — fullscreen portal, shows regardless of widget state ────────
  const rcConsentModal = rcRequested && !rcDenied && userRole === 'artist' ? createPortal(
    <div className="rc-consent-overlay">
      <div className="rc-consent-card">
        <div className="rc-consent-monitor-icon">
          <MonitorPlay size={32} color="#00ffcc" />
        </div>
        <h3 className="rc-consent-title">Remote Control Request</h3>
        <p className="rc-consent-body">
          The engineer is requesting full remote control of your session.
        </p>
        <div className="rc-consent-actions">
          <button className="rc-consent-btn decline" onClick={() => setRcDenied(true)}>Deny</button>
          <button className="rc-consent-btn accept" onClick={() => { setRcDenied(false); startScreenShare(); }}>Allow</button>
        </div>
      </div>
    </div>,
    document.body,
  ) : null;

  // ── Minimized pill — portalled into transport bar ─────────────────────────
  if (isMinimized) {
    const slot = document.getElementById('transport-chat-slot');
    const pillStatus = incomingCall ? 'ringing' : callActive && isConnected ? 'connected' : callActive ? 'connecting' : 'idle';
    return (
      <>
        {hiddenVideos}
        {incomingCallModal}
        {rcConsentModal}
        {slot && createPortal(
          <div className={`transport-chat-pill pill-${pillStatus}`} onClick={() => setIsMinimized(false)} title="Open Video Chat">
            <div className="pill-video-icon"><Video size={14} /></div>
            <div className={`live-dot-small ${pillStatus === 'connected' ? 'connected' : pillStatus === 'ringing' ? 'ringing' : ''}`} />
            <span className="transport-chat-label">
              {incomingCall ? 'Incoming Call' : rcActive ? 'Remote Control' : callActive ? (isConnected ? 'In Call' : 'Connecting…') : 'Video Call'}
            </span>
          </div>,
          slot,
        )}
      </>
    );
  }

  return (
    <>
      {hiddenVideos}
      {incomingCallModal}
      {rcConsentModal}

      <div
        className="floating-video-widget"
        style={position ? { left: position.x, top: position.y, right: 'auto', bottom: 'auto', margin: 0 } : undefined}
      >
        <div
          className="widget-header"
          style={{ cursor: 'move', userSelect: 'none' }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          <div className="widget-title">
            <div className={`live-dot ${rcActive ? 'rc' : callActive && isConnected ? 'connected' : ''}`} />
            <span>
              {rcActive ? 'Remote Control' : isCalling ? 'Calling...' : callActive ? (isConnected ? 'Live Session' : 'Connecting…') : 'Video Chat'}
            </span>
          </div>
          <div className="widget-controls">
            <button className="icon-btn" onClick={() => setIsMinimized(true)} title="Minimise to bar">
              <Minimize2 size={14} />
            </button>
          </div>
        </div>

        {/* Video grid — shows live <video> elements instead of the always-hidden refs */}
        <div className="video-grid">
          <div className="video-feed remote">
            {remoteStream ? (
              <video
                autoPlay playsInline className="video-el"
                ref={el => { if (el && remoteStream) el.srcObject = remoteStream; }}
              />
            ) : (
              <div className="video-placeholder">
                {isCalling ? 'Ringing...' : callActive ? 'Connecting...' : userRole === 'artist' ? 'Engineer Cam' : 'Artist Cam'}
              </div>
            )}
            <div className="feed-name">{userRole === 'engineer' ? 'Artist' : 'Engineer'}</div>
          </div>

          {callActive && (
            <div className="video-feed local">
              {localStream ? (
                <video
                  autoPlay playsInline muted className="video-el"
                  ref={el => { if (el && localStream) el.srcObject = localStream; }}
                />
              ) : (
                <div className="video-placeholder">Your Cam</div>
              )}
              <div className="feed-name">You</div>
            </div>
          )}
        </div>

        {showChat && (
          <div className="chat-pane">
            <div className="chat-messages" ref={chatScrollRef}>
              {messages.length === 0 && <div className="chat-empty">No messages yet.</div>}
              {messages.map(m => (
                <div key={m.id} className={`chat-message ${m.sender === userId ? 'self' : 'other'}`}>
                  <span className="msg-text">{m.text}</span>
                </div>
              ))}
            </div>
            <div className="chat-input-row">
              <input
                type="text"
                className="chat-input"
                placeholder="Type a message..."
                onKeyDown={e => {
                  if (e.key === 'Enter' && e.currentTarget.value.trim()) {
                    sendMessage(e.currentTarget.value.trim());
                    e.currentTarget.value = '';
                  }
                }}
              />
            </div>
          </div>
        )}

        <div className="widget-footer">
          <div className="call-controls">
            {callActive ? (
              <>
                <button className={`control-btn ${!isMicOn ? 'off' : ''}`} onClick={toggleMic} title={isMicOn ? 'Mute mic' : 'Unmute mic'}>
                  {isMicOn ? <Mic size={18} /> : <MicOff size={18} />}
                </button>
                <button className={`control-btn ${!isVideoOn ? 'off' : ''}`} onClick={toggleVideo} title={isVideoOn ? 'Turn off camera' : 'Turn on camera'}>
                  {isVideoOn ? <Video size={18} /> : <VideoOff size={18} />}
                </button>
                <button className="control-btn end-call" onClick={endCall} title="End call">
                  <X size={18} />
                </button>
              </>
            ) : !incomingCall && (
              <button className={`control-btn start-call ${isCalling ? 'calling' : ''}`} onClick={isCalling ? endCall : ring} title={isCalling ? 'Cancel Call' : 'Call'}>
                {isCalling ? <X size={18} /> : <PhoneCall size={18} />}
                <span style={{ marginLeft: 6, fontSize: 12 }}>{isCalling ? 'Cancel' : 'Call'}</span>
              </button>
            )}
            {/* RC button — always available for engineer, no call required */}
            {userRole === 'engineer' && (
              <button
                className={`control-btn rc-btn ${rcActive ? 'active' : ''}`}
                onClick={rcActive ? stopRemoteControl : requestRemoteControl}
                title={rcActive ? 'Stop remote control' : 'Request remote control'}
              >
                {rcActive ? <MonitorX size={18} /> : <MonitorPlay size={18} />}
              </button>
            )}
          </div>

          {userRole === 'engineer' && remoteDawStream && (
            <div className="monitor-knob-row">
              <span className="monitor-knob-label">Monitor</span>
              <input
                id="monitor-level-knob"
                type="range"
                className="monitor-knob-slider"
                min={0} max={1} step={0.01}
                value={monitorVolume}
                onChange={e => setMonitorVolume(parseFloat(e.target.value))}
                title={`Monitor level: ${Math.round(monitorVolume * 100)}%`}
              />
              <span className="monitor-knob-value">{Math.round(monitorVolume * 100)}%</span>
            </div>
          )}

          <div className="widget-extra-controls">
            <button className={`chat-toggle-btn ${showChat ? 'active' : ''}`} onClick={() => setShowChat(!showChat)} title="Toggle Chat">
              <MessageSquare size={16} color={showChat ? '#000' : '#fff'} />
              {!showChat && messages.length > 0 && <div className="chat-badge" />}
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

export default FloatingVideoChat;
