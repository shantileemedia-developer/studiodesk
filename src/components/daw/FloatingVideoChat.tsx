import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Video, Mic, MicOff, VideoOff, Minimize2, X, PhoneCall, MessageSquare, MonitorPlay, MonitorX, Smile } from 'lucide-react';

const EMOJIS: Record<string, string[]> = {
  '😀': ['😀','😂','🤣','😍','🥹','😎','🤔','😅','🥺','😭','😤','🤯','🥳','😴','🤩','😬','🙄','😏','😒','🤗','😇','🫡','🤫','😶','🤐'],
  '👍': ['👍','👎','👌','🤌','✌️','🤞','🤟','🤘','👏','🙌','🤜','🤛','💪','🙏','🫶','❤️','🔥','💯','✅','🎉','🚀','💀','👀','🫠','💅'],
  '🎵': ['🎵','🎶','🎸','🥁','🎹','🎤','🎧','🎼','🎷','🎺','🎻','🪗','🎙️','📻','🔊','🔇','🎚️','🎛️','💿','🎬'],
};
import { useWebRTC } from '../../hooks/useWebRTC';
import type { RemoteInputEvent } from '../../types/remote';
import './FloatingVideoChat.css';

interface FloatingVideoChatProps {
  userRole: 'artist' | 'engineer';
  userId: string;
  roomCode: string;
  onInputEvent?: (event: RemoteInputEvent) => void;
  /** active, sendFn, remoteScreenStream, viewOnly */
  onRcStateChange?: (active: boolean, sendFn: ((e: RemoteInputEvent) => void) | null, screenStream: MediaStream | null, viewOnly: boolean) => void;
  /** Stable refs from DawContext — passed as props to avoid context subscription inside this component */
  masterStreamRef: React.MutableRefObject<MediaStreamAudioDestinationNode | null>;
  audioCtxRef: React.MutableRefObject<AudioContext | null>;
}

// ── Ringtone synthesized via Web Audio ───────────────────────────────────────
function useRingtone(isIncoming: boolean, isOutgoing: boolean) {
  const ctxRef      = useRef<AudioContext | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isRinging   = isIncoming || isOutgoing;

  useEffect(() => {
    if (!isRinging) {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
      ctxRef.current?.close().catch(() => {});
      ctxRef.current = null;
      return;
    }

    const ctx = new AudioContext();
    ctxRef.current = ctx;

    // Classic PSTN dual-tone (440 Hz + 480 Hz)
    const playDualTone = (startTime: number, duration: number, amp: number) => {
      [440, 480].forEach(freq => {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, startTime);
        gain.gain.linearRampToValueAtTime(amp, startTime + 0.02);
        gain.gain.setValueAtTime(amp, startTime + duration - 0.04);
        gain.gain.linearRampToValueAtTime(0, startTime + duration);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(startTime);
        osc.stop(startTime + duration);
      });
    };

    if (isIncoming) {
      // "Ring ring" — two 400 ms bursts with 150 ms gap, then 2.5 s silence (~3 s total)
      const playPattern = () => {
        if (!ctxRef.current || ctxRef.current.state === 'closed') return;
        const now = ctx.currentTime;
        playDualTone(now, 0.4, 0.32);
        playDualTone(now + 0.55, 0.4, 0.32);
      };
      playPattern();
      intervalRef.current = setInterval(playPattern, 3000);
    } else {
      // Outgoing ringback: softer, single 1.8 s tone every ~5.8 s
      const playRingback = () => {
        if (!ctxRef.current || ctxRef.current.state === 'closed') return;
        playDualTone(ctx.currentTime, 1.8, 0.15);
      };
      playRingback();
      intervalRef.current = setInterval(playRingback, 5800);
    }

    return () => {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
      ctx.close().catch(() => {});
    };
  }, [isRinging, isIncoming]);
}

// ─────────────────────────────────────────────────────────────────────────────

/* ── Video Grid — memoized so typing in chat never re-renders video elements ── */
interface VideoGridProps {
  callActive: boolean;
  remoteStream: MediaStream | null;
  localStream: MediaStream | null;
  previewStream: MediaStream | null;
  isCalling: boolean;
  showLocalCam: boolean;
  setShowLocalCam: (v: boolean) => void;
  userRole: 'artist' | 'engineer';
}

const VideoGrid: React.FC<VideoGridProps> = memo(({
  callActive, remoteStream, localStream, previewStream, isCalling, showLocalCam, setShowLocalCam, userRole,
}) => {
  const remoteVidRef  = useRef<HTMLVideoElement>(null);
  const localVidRef   = useRef<HTMLVideoElement>(null);
  const previewVidRef = useRef<HTMLVideoElement>(null);

  // Sync srcObject synchronously after DOM update so the video never misses a stream,
  // even when WebRTC adds tracks to an existing MediaStream object (same reference).
  useEffect(() => {
    if (remoteVidRef.current)  remoteVidRef.current.srcObject  = remoteStream  ?? null;
  }, [remoteStream]);

  useEffect(() => {
    if (localVidRef.current)   localVidRef.current.srcObject   = localStream   ?? null;
  }, [localStream]);

  useEffect(() => {
    if (previewVidRef.current) previewVidRef.current.srcObject = previewStream ?? null;
  }, [previewStream]);

  return (
    <div className="video-grid">
      <div className="video-feed remote">
        {callActive ? (
          remoteStream ? (
            <video autoPlay playsInline className="video-el" ref={remoteVidRef} />
          ) : (
            <div className="video-placeholder">{isCalling ? 'Ringing…' : 'Connecting…'}</div>
          )
        ) : (
          previewStream ? (
            <video autoPlay playsInline muted className="video-el" ref={previewVidRef} />
          ) : (
            <div className="video-placeholder">{isCalling ? 'Calling…' : 'Camera Preview'}</div>
          )
        )}
        <div className="feed-name">
          {callActive ? (userRole === 'engineer' ? 'Artist' : 'Engineer') : 'You'}
        </div>
      </div>

      {callActive && showLocalCam && (
        <div className="video-feed local">
          {localStream ? (
            <video autoPlay playsInline muted className="video-el" ref={localVidRef} />
          ) : (
            <div className="video-placeholder" style={{ fontSize: 10 }}>Your Cam</div>
          )}
          <div className="feed-name">You</div>
          <button className="pip-hide-btn" onClick={() => setShowLocalCam(false)} title="Hide your camera">
            <VideoOff size={9} />
          </button>
        </div>
      )}

      {callActive && !showLocalCam && (
        <button className="pip-show-btn" onClick={() => setShowLocalCam(true)} title="Show your camera">
          <Video size={11} />
        </button>
      )}
    </div>
  );
});

const FloatingVideoChat: React.FC<FloatingVideoChatProps> = ({
  userRole, userId, roomCode, onInputEvent, onRcStateChange, masterStreamRef, audioCtxRef,
}) => {
  const [isMinimized, setIsMinimized] = useState(true);
  const [showChat, setShowChat] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [emojiTab, setEmojiTab] = useState<string>('😀');
  const [mounted, setMounted] = useState(false);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 320, height: 0 });
  const [monitorVolume, setMonitorVolume] = useState(0.7);
  const [rcDenied, setRcDenied] = useState(false);
  const [rcAudioDeviceConsent, setRcAudioDeviceConsent] = useState(false);
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [showLocalCam, setShowLocalCam] = useState(true);
  const previewStreamRef = useRef<MediaStream | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; initialX: number; initialY: number } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; initW: number; initH: number; el: HTMLElement } | null>(null);
  const widgetRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLInputElement>(null);
  const emojiPickerRef = useRef<HTMLDivElement>(null);

  const initAudioCtx = () => {
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      audioCtxRef.current = new AudioContext({ sampleRate: 48000 });
    }
    return audioCtxRef.current;
  };

  const monitorGainRef   = useRef<GainNode | null>(null);
  const monitorSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  const {
    localStream, remoteStream, remoteDawStream, remoteScreenStream, isConnected, callActive,
    isMicOn, isVideoOn,
    incomingCall, isCalling, callerId, messages,
    ring, acceptCall, declineCall, sendMessage,
    endCall, toggleMic, toggleVideo,
    rcRequested, rcActive,
    rcEngineerName, rcViewOnly,
    requestRemoteControl, stopRemoteControl,
    respondToRcPermission,
    sendInputEvent,
    switchCallAudioBus, activeCallBus,
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

  // Ensure portal slot is found after TransportPanel commits to DOM
  useEffect(() => { setMounted(true); }, []);

  // Close emoji picker on outside click
  useEffect(() => {
    if (!showEmojiPicker) return;
    const handler = (e: MouseEvent) => {
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(e.target as Node)) {
        setShowEmojiPicker(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showEmojiPicker]);

  const insertEmoji = useCallback((emoji: string) => {
    const el = chatInputRef.current;
    if (!el) { setChatInput(v => v + emoji); return; }
    const start = el.selectionStart ?? chatInput.length;
    const end = el.selectionEnd ?? chatInput.length;
    const next = chatInput.slice(0, start) + emoji + chatInput.slice(end);
    setChatInput(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + emoji.length;
      el.setSelectionRange(pos, pos);
    });
  }, [chatInput]);

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
    onRcStateChange?.(rcActive, rcActive ? sendInputEvent : null, rcActive ? remoteScreenStream : null, rcViewOnly);
  }, [rcActive, sendInputEvent, onRcStateChange, remoteScreenStream, rcViewOnly]);

  // Artist: broadcast cursor position to engineer while RC is active (~30 fps)
  useEffect(() => {
    if (!rcActive || userRole !== 'artist') return;
    let lastSent = 0;
    const onMouseMove = (e: MouseEvent) => {
      const now = Date.now();
      if (now - lastSent < 33) return;
      lastSent = now;
      sendInputEvent({
        type: 'artist-cursor',
        nx: e.clientX / window.innerWidth,
        ny: e.clientY / window.innerHeight,
      });
    };
    window.addEventListener('mousemove', onMouseMove);
    return () => window.removeEventListener('mousemove', onMouseMove);
  }, [rcActive, userRole, sendInputEvent]);

  // ── Camera preview — starts when widget opens, releases when call goes active ──
  useEffect(() => {
    if (isMinimized || callActive) {
      previewStreamRef.current?.getTracks().forEach(t => t.stop());
      previewStreamRef.current = null;
      setPreviewStream(null);
      return;
    }
    let cancelled = false;
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false })
      .then(stream => {
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        previewStreamRef.current = stream;
        setPreviewStream(stream);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      previewStreamRef.current?.getTracks().forEach(t => t.stop());
      previewStreamRef.current = null;
      setPreviewStream(null);
    };
  }, [isMinimized, callActive]);

  // ── Ringtone — different sound for incoming vs outgoing ──────────────────
  useRingtone(incomingCall, isCalling);

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

  const handleResizeDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const el = widgetRef.current;
    if (!el) return;
    resizeRef.current = {
      startX: e.clientX, startY: e.clientY,
      initW: el.offsetWidth, initH: el.offsetHeight,
      el,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handleResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current) return;
    const { startX, startY, initW, initH } = resizeRef.current;
    setSize({
      width: Math.max(240, initW + (e.clientX - startX)),
      height: Math.max(180, initH + (e.clientY - startY)),
    });
  };

  const handleResizeUp = (e: React.PointerEvent<HTMLDivElement>) => {
    resizeRef.current = null;
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

  // ── RC permission dialog — fullscreen portal, shown to artist on RC request ─
  const rcConsentModal = rcRequested && !rcDenied && userRole === 'artist' ? createPortal(
    <div className="rc-consent-overlay">
      <div className="rc-consent-card">
        <div className="rc-consent-monitor-icon">
          <MonitorPlay size={32} color="#00ffcc" />
        </div>
        <h3 className="rc-consent-title">Remote Control Request</h3>
        <p className="rc-consent-body">
          <strong>{rcEngineerName}</strong> is requesting control of your session.
        </p>
        <label className="rc-audio-consent-row">
          <input
            type="checkbox"
            checked={rcAudioDeviceConsent}
            onChange={e => setRcAudioDeviceConsent(e.target.checked)}
          />
          <span>Allow engineer to modify audio settings</span>
        </label>
        <div className="rc-consent-actions">
          <button className="rc-consent-btn decline"
            onClick={() => { setRcDenied(true); respondToRcPermission('denied', false); }}>
            Cancel
          </button>
          <button className="rc-consent-btn view-only"
            onClick={() => { respondToRcPermission('view', rcAudioDeviceConsent); }}>
            View Only
          </button>
          <button className="rc-consent-btn accept"
            onClick={() => { respondToRcPermission('full', rcAudioDeviceConsent); }}>
            Allow Full Control
          </button>
        </div>
      </div>
    </div>,
    document.body,
  ) : null;

  // ── Minimized pill — portalled into transport bar ─────────────────────────
  if (isMinimized) {
    const slot = mounted ? document.getElementById('transport-chat-slot') : null;
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
        ref={widgetRef}
        className="floating-video-widget"
        style={{
          ...(position ? { left: position.x, top: position.y, right: 'auto', bottom: 'auto', margin: 0 } : undefined),
          width: size.width,
          ...(size.height > 0 ? { height: size.height } : undefined),
        }}
      >
        <div className="widget-inner-clip">
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

        {/* Video grid — memoized, isolated from chat input state */}
        <VideoGrid
          callActive={callActive}
          remoteStream={remoteStream}
          localStream={localStream}
          previewStream={previewStream}
          isCalling={isCalling}
          showLocalCam={showLocalCam}
          setShowLocalCam={setShowLocalCam}
          userRole={userRole}
        />

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
            <div className="chat-input-row" style={{ position: 'relative' }}>
              {showEmojiPicker && (
                <div className="emoji-picker" ref={emojiPickerRef}>
                  <div className="emoji-tabs">
                    {Object.keys(EMOJIS).map(tab => (
                      <button
                        key={tab}
                        className={`emoji-tab ${emojiTab === tab ? 'active' : ''}`}
                        onClick={() => setEmojiTab(tab)}
                      >{tab}</button>
                    ))}
                  </div>
                  <div className="emoji-grid">
                    {(EMOJIS[emojiTab] ?? []).map(e => (
                      <button key={e} className="emoji-btn" onClick={() => insertEmoji(e)}>{e}</button>
                    ))}
                  </div>
                </div>
              )}
              <button
                className={`emoji-toggle-btn ${showEmojiPicker ? 'active' : ''}`}
                onClick={() => setShowEmojiPicker(v => !v)}
                title="Emoji"
                type="button"
              >
                <Smile size={14} />
              </button>
              <input
                ref={chatInputRef}
                type="text"
                className="chat-input"
                placeholder="Type a message…"
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && chatInput.trim()) {
                    sendMessage(chatInput.trim());
                    setChatInput('');
                    setShowEmojiPicker(false);
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
            {/* Engineer: monitor source selector — which DAW bus feeds the call */}
            {userRole === 'engineer' && callActive && window.audioEngine && (
              <select
                className="control-btn monitor-bus-select"
                value={activeCallBus ?? 'mic-input'}
                onChange={e => switchCallAudioBus(e.target.value as any)}
                title="Call audio source"
                style={{ fontSize: 11, padding: '2px 4px', height: 32, cursor: 'pointer' }}
              >
                <option value="mic-input">Mic Input</option>
                <option value="playback-mix">Playback Mix</option>
                <option value="master-output">Master Out</option>
              </select>
            )}
            {/* RC button — always available for engineer, no call required */}
            {userRole === 'engineer' && (
              <button
                className={`control-btn rc-btn ${rcActive ? 'active' : ''}`}
                onClick={rcActive ? stopRemoteControl : () => requestRemoteControl(userId)}
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

        <div
          className="widget-resize-handle"
          onPointerDown={handleResizeDown}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeUp}
        />
      </div>
    </>
  );
};

export default memo(FloatingVideoChat);
