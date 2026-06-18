import React, { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Video, Mic, MicOff, VideoOff, Minimize2, X, PhoneCall, MessageSquare, MonitorPlay, Smile, SendHorizonal } from 'lucide-react';

const EMOJIS: Record<string, string[]> = {
  '😀': ['😀','😂','🤣','😍','🥹','😎','🤔','😅','🥺','😭','😤','🤯','🥳','😴','🤩','😬','🙄','😏','😒','🤗','😇','🫡','🤫','😶','🤐'],
  '👍': ['👍','👎','👌','🤌','✌️','🤞','🤟','🤘','👏','🙌','🤜','🤛','💪','🙏','🫶','❤️','🔥','💯','✅','🎉','🚀','💀','👀','🫠','💅'],
  '🎵': ['🎵','🎶','🎸','🥁','🎹','🎤','🎧','🎼','🎷','🎺','🎻','🪗','🎙️','📻','🔊','🔇','🎚️','🎛️','💿','🎬'],
};
import { useWebRTC } from '../../hooks/useWebRTC';
import type { RemoteInputEvent, RcPermissionGrant } from '../../types/remote';
import './FloatingVideoChat.css';

export interface FloatingVideoChatHandle {
  revokeDawControl: () => void;
  revokeDesktopControl: () => void;
}

interface FloatingVideoChatProps {
  userRole: 'artist' | 'engineer';
  userId: string;
  roomCode: string;
  onInputEvent?: (event: RemoteInputEvent, source: 'app' | 'desktop') => void;
  onRcStateChange?: (active: boolean, sendFn: ((e: RemoteInputEvent) => void) | null, viewOnly: boolean) => void;
  /** App RC: called when the App RC session activates/deactivates; sendFn is the channel send function */
  onAppRcChange?: (active: boolean, sendFn: ((e: RemoteInputEvent) => void) | null) => void;
  /** When true the engineer's App RC connection starts automatically */
  dawControlActive?: boolean;
  /** Called on artist side after they grant DAW control via the unified consent modal */
  onDawControlGranted?: () => void;
  /** Called on both sides when DAW control is revoked */
  onDawControlRevoked?: () => void;
  /** When true, mutes the incoming call audio (artist voice) — used for MIX-only monitor mode */
  muteCallAudio?: boolean;
  /** Stable refs from DawContext — passed as props to avoid context subscription inside this component */
  masterStreamRef: React.MutableRefObject<MediaStreamAudioDestinationNode | null>;
  nativeStreamRef: React.MutableRefObject<MediaStream | null>;
  audioCtxRef: React.MutableRefObject<AudioContext | null>;
  /** Override mic device for getUserMedia (defaults to system default) */
  audioInputDeviceId?: string;
  /** Override playback sink for incoming call audio (setSinkId) */
  audioOutputDeviceId?: string;
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
  muteCallAudio?: boolean;
  audioOutputDeviceId?: string;
}

const VideoGrid: React.FC<VideoGridProps> = memo(({
  callActive, remoteStream, localStream, previewStream, isCalling, showLocalCam, setShowLocalCam, userRole, muteCallAudio, audioOutputDeviceId,
}) => {
  const remoteVidRef  = useRef<HTMLVideoElement>(null);
  const localVidRef   = useRef<HTMLVideoElement>(null);
  const previewVidRef = useRef<HTMLVideoElement>(null);

  // Sync srcObject synchronously after DOM update so the video never misses a stream,
  // even when WebRTC adds tracks to an existing MediaStream object (same reference).
  useEffect(() => {
    if (remoteVidRef.current)  remoteVidRef.current.srcObject  = remoteStream  ?? null;
  }, [remoteStream]);

  // Route incoming call audio to the selected output device
  useEffect(() => {
    const el = remoteVidRef.current as any;
    if (!el || !audioOutputDeviceId || audioOutputDeviceId === 'default') return;
    el.setSinkId?.(audioOutputDeviceId).catch(() => {});
  }, [audioOutputDeviceId, remoteStream]);

  // MIX-only monitor mode: mute the incoming call voice without ending the call
  useEffect(() => {
    if (remoteVidRef.current) remoteVidRef.current.muted = muteCallAudio ?? false;
  }, [muteCallAudio]);

  useEffect(() => {
    if (localVidRef.current)   localVidRef.current.srcObject   = localStream   ?? null;
  }, [localStream, showLocalCam]);

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

// ── Desktop Control: full-screen overlay on the engineer's side ──────────────
// Captures all pointer + keyboard events locally and normalises coordinates
// relative to the video's visible content area (object-fit: contain with
// letterbox bars). This gives AnyDesk-style 1:1 mapping without distortion.
interface DesktopControlFullscreenProps {
  stream: MediaStream;
  onExit: () => void;
  onStop: () => void;
  onSendInput: (e: RemoteInputEvent) => void;
}
const DesktopControlFullscreen: React.FC<DesktopControlFullscreenProps> = ({ stream, onExit, onStop, onSendInput }) => {
  const vidRef = useRef<HTMLVideoElement>(null);
  const onSendInputRef = useRef(onSendInput);
  const onExitRef = useRef(onExit);
  useEffect(() => { onSendInputRef.current = onSendInput; }, [onSendInput]);
  useEffect(() => { onExitRef.current = onExit; }, [onExit]);

  useEffect(() => {
    if (vidRef.current) vidRef.current.srcObject = stream;
  }, [stream]);

  // Map event clientX/Y to [0,1] normalized relative to the actual video content
  // area (accounting for letterbox/pillarbox bars from object-fit: contain).
  const normCoords = useCallback((clientX: number, clientY: number) => {
    const vid = vidRef.current;
    if (!vid || !vid.videoWidth || !vid.videoHeight) {
      return { nx: clientX / window.innerWidth, ny: clientY / window.innerHeight };
    }
    const elW = vid.clientWidth;
    const elH = vid.clientHeight;
    const videoAspect = vid.videoWidth / vid.videoHeight;
    const elAspect = elW / elH;
    let contentW: number, contentH: number, offsetX: number, offsetY: number;
    if (videoAspect > elAspect) {
      // Wider video: black bars top + bottom
      contentW = elW;
      contentH = elW / videoAspect;
      offsetX = 0;
      offsetY = (elH - contentH) / 2;
    } else {
      // Taller video: black bars left + right
      contentH = elH;
      contentW = elH * videoAspect;
      offsetX = (elW - contentW) / 2;
      offsetY = 0;
    }
    return {
      nx: Math.max(0, Math.min(1, (clientX - offsetX) / contentW)),
      ny: Math.max(0, Math.min(1, (clientY - offsetY) / contentH)),
    };
  }, []);

  // rAF-throttled pointermove
  const pendingMoveRef = useRef<RemoteInputEvent | null>(null);
  const rafIdRef = useRef<number | null>(null);

  const isOnHud = (e: React.SyntheticEvent) =>
    !!(e.target as HTMLElement).closest('[data-desktop-hud]');

  const handlePointerMove = (e: React.PointerEvent) => {
    const { nx, ny } = normCoords(e.clientX, e.clientY);
    pendingMoveRef.current = { type: 'pointermove', nx, ny, button: e.button, buttons: e.buttons };
    if (!rafIdRef.current) {
      rafIdRef.current = requestAnimationFrame(() => {
        if (pendingMoveRef.current) onSendInputRef.current(pendingMoveRef.current);
        pendingMoveRef.current = null;
        rafIdRef.current = null;
      });
    }
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (isOnHud(e)) return;
    e.stopPropagation();
    const { nx, ny } = normCoords(e.clientX, e.clientY);
    console.log('[ENGINEER_INPUT_CAPTURED] pointerdown', { nx: nx.toFixed(3), ny: ny.toFixed(3), button: e.button });
    onSendInputRef.current({ type: 'pointerdown', nx, ny, button: e.button, buttons: e.buttons });
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (isOnHud(e)) return;
    e.stopPropagation();
    const { nx, ny } = normCoords(e.clientX, e.clientY);
    console.log('[ENGINEER_INPUT_CAPTURED] pointerup', { nx: nx.toFixed(3), ny: ny.toFixed(3), button: e.button });
    onSendInputRef.current({ type: 'pointerup', nx, ny, button: e.button, buttons: 0 });
  };

  const handleWheel = (e: React.WheelEvent) => {
    if (isOnHud(e)) return;
    const { nx, ny } = normCoords(e.clientX, e.clientY);
    console.log('[ENGINEER_INPUT_CAPTURED] wheel', { deltaX: e.deltaX.toFixed(1), deltaY: e.deltaY.toFixed(1) });
    onSendInputRef.current({ type: 'wheel', nx, ny, deltaX: e.deltaX, deltaY: e.deltaY });
  };

  const handleDblClick = (e: React.MouseEvent) => {
    if (isOnHud(e)) return;
    e.stopPropagation();
    const { nx, ny } = normCoords(e.clientX, e.clientY);
    console.log('[ENGINEER_INPUT_CAPTURED] dblclick', { nx: nx.toFixed(3), ny: ny.toFixed(3) });
    onSendInputRef.current({ type: 'dblclick', nx, ny, button: e.button });
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    if (isOnHud(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const { nx, ny } = normCoords(e.clientX, e.clientY);
    console.log('[ENGINEER_INPUT_CAPTURED] contextmenu', { nx: nx.toFixed(3), ny: ny.toFixed(3) });
    onSendInputRef.current({ type: 'contextmenu', nx, ny, button: e.button });
  };

  // Keyboard: window capture phase — fires first, stopImmediatePropagation prevents
  // any other capture-phase keyboard listener (e.g. DawWorkspace shortcuts) from firing.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      e.stopImmediatePropagation();
      if (e.key === 'Escape') { onExitRef.current(); return; }
      console.log('[ENGINEER_INPUT_CAPTURED] keydown', e.key);
      onSendInputRef.current({
        type: 'keydown', key: e.key, code: e.code,
        ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey,
        repeat: e.repeat,
      });
    };
    const onKeyUp = (e: KeyboardEvent) => {
      e.stopImmediatePropagation();
      if (e.key === 'Escape') return;
      console.log('[ENGINEER_INPUT_CAPTURED] keyup', e.key);
      onSendInputRef.current({
        type: 'keyup', key: e.key, code: e.code,
        ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey,
        repeat: false,
      });
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      if (rafIdRef.current) { cancelAnimationFrame(rafIdRef.current); rafIdRef.current = null; }
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, []);

  return createPortal(
    <div
      className="desktop-control-fullscreen"
      onPointerMove={handlePointerMove}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onWheel={handleWheel}
      onDoubleClick={handleDblClick}
      onContextMenu={handleContextMenu}
    >
      <video ref={vidRef} autoPlay playsInline muted className="desktop-control-video" />
      <div className="desktop-control-hud" data-desktop-hud="">
        <div className="desktop-control-hud-label">
          <span className="desktop-hud-dot" />
          Desktop Control Active
        </div>
        <button className="desktop-control-exit-btn" onClick={onExit}>
          ⊠ Exit Fullscreen
        </button>
        <button className="desktop-control-stop-btn" onClick={onStop}>
          Stop Control
        </button>
      </div>
    </div>,
    document.body,
  );
};

interface DesktopStreamPreviewProps {
  stream: MediaStream;
  onFullscreen: () => void;
}
const DesktopStreamPreview: React.FC<DesktopStreamPreviewProps> = ({ stream, onFullscreen }) => {
  const vidRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (vidRef.current) vidRef.current.srcObject = stream;
  }, [stream]);
  return (
    <div className="desktop-stream-preview">
      <video ref={vidRef} autoPlay playsInline muted className="desktop-stream-preview-video" />
      <button className="desktop-stream-fullscreen-btn" onClick={onFullscreen} title="Full Screen">
        ⛶ Full Screen
      </button>
    </div>
  );
};

const FloatingVideoChat = forwardRef<FloatingVideoChatHandle, FloatingVideoChatProps>(({
  userRole, userId, roomCode, onInputEvent, onRcStateChange, onAppRcChange,
  dawControlActive, onDawControlGranted, onDawControlRevoked, muteCallAudio,
  masterStreamRef, nativeStreamRef, audioCtxRef,
  audioInputDeviceId, audioOutputDeviceId,
}, ref) => {
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
  const [rcDesktopGrant, setRcDesktopGrant] = useState<'none' | 'view' | 'full'>('full');
  const [rcDawGrant, setRcDawGrant] = useState(true);
  const [desktopFullscreen, setDesktopFullscreen] = useState(false);
  const [showDesktopPanel, setShowDesktopPanel] = useState(false);
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
    localStream, remoteStream, remoteDawStream, remoteDesktopStream, isConnected, callActive,
    isMicOn, isVideoOn,
    incomingCall, isCalling, callerId, messages,
    ring, acceptCall, declineCall, sendMessage,
    endCall, toggleMic, toggleVideo,
    rcRequested, rcActive,
    rcEngineerName, rcViewOnly,
    requestRemoteControl, revokeRemoteControl, stopRemoteControl,
    respondToRcPermission, revokeDawControl,
    sendInputEvent, syncDawStream,
    switchCallAudioBus, activeCallBus,
    appRcActive, startAppRc, stopAppRc, sendAppRcInput, signalChannelReady,
  } = useWebRTC({
    roomCode,
    userId,
    isInitiator: userRole === 'engineer',
    getDawStream: () => {
      if (userRole === 'artist') {
        if (nativeStreamRef.current) return nativeStreamRef.current;
        initAudioCtx();
        return masterStreamRef.current?.stream ?? null;
      }
      return null;
    },
    onInputEvent,
    onDawControlGranted,
    onDawControlRevoked,
    audioInputDeviceId,
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

    // Route monitoring output to the engineer's selected output device (Chrome 110+ / Electron 22+)
    if (audioOutputDeviceId && audioOutputDeviceId !== 'default') {
      (ctx as any).setSinkId?.(audioOutputDeviceId).catch(() => {});
    }

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

  // Expose control functions to parent via ref
  useImperativeHandle(ref, () => ({
    revokeDawControl,
    revokeDesktopControl: revokeRemoteControl,
  }), [revokeDawControl, revokeRemoteControl]);

  // Exit fullscreen and hide desktop panel when RC ends
  useEffect(() => {
    if (!rcActive) {
      setDesktopFullscreen(false);
      setShowDesktopPanel(false);
    }
  }, [rcActive]);

  // Cleanup RC on unmount (engineer session end / phase change).
  // Prevents orphaned RTCPeerConnections and dangling screen-capture tracks.
  useEffect(() => {
    return () => {
      if (rcActive) stopRemoteControl();
      stopAppRc();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Un-minimise the widget when Desktop RC activates so the controls are accessible.
  // Do NOT auto-enter fullscreen — engineer chooses when to open the desktop view.
  useEffect(() => {
    if (rcActive && remoteDesktopStream) {
      setIsMinimized(false);
    }
  }, [rcActive, remoteDesktopStream]);

  useEffect(() => {
    onRcStateChange?.(rcActive, rcActive ? sendInputEvent : null, rcViewOnly);
  }, [rcActive, sendInputEvent, onRcStateChange, rcViewOnly]);

  useEffect(() => {
    onAppRcChange?.(appRcActive, appRcActive ? sendAppRcInput : null);
  }, [appRcActive, sendAppRcInput, onAppRcChange]);

  // App RC lifecycle tied to DAW control.
  // Engineer: start when DAW control is granted AND signal channel is subscribed (avoids the
  //           race where the offer is sent before Supabase has confirmed subscription).
  //           Restarts automatically if the WebRTC connection drops mid-session.
  // Artist:   tear down local side immediately when DAW control ends.
  useEffect(() => {
    if (userRole === 'engineer') {
      if (dawControlActive && !appRcActive && signalChannelReady) {
        startAppRc();
      } else if (!dawControlActive) {
        stopAppRc();
      }
    } else {
      if (!dawControlActive) stopAppRc();
    }
  }, [dawControlActive, appRcActive, signalChannelReady, userRole, startAppRc, stopAppRc]);

  // Artist: push DAW master-out track into the live peer connection.
  // Retries at 2 s, 5 s, and 10 s because the AudioContext + master stream
  // may not be created until the artist first presses Play/Record.
  useEffect(() => {
    if (!callActive || userRole !== 'artist') return;
    syncDawStream();
    const t1 = setTimeout(syncDawStream, 2000);
    const t2 = setTimeout(syncDawStream, 5000);
    const t3 = setTimeout(syncDawStream, 10000);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [callActive, userRole, syncDawStream]);

  // Keep artist's AudioContext alive during a call.
  // Browsers suspend AudioContext after a period of no user interaction, which
  // silences the MediaStreamDestination used for DAW monitoring.
  useEffect(() => {
    if (userRole !== 'artist' || !callActive) return;
    const iv = setInterval(() => {
      const ctx = audioCtxRef.current;
      if (ctx && ctx.state === 'suspended') {
        ctx.resume().catch(() => {}).then(() => syncDawStream());
      }
    }, 8000);
    return () => clearInterval(iv);
  }, [userRole, callActive, audioCtxRef, syncDawStream]);

  // Keep engineer's monitoring AudioContext alive during a call.
  // Suspension on the engineer's side causes the received DAW audio to go silent.
  useEffect(() => {
    if (userRole !== 'engineer' || !callActive) return;
    const iv = setInterval(() => {
      const ctx = audioCtxRef.current;
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    }, 8000);
    return () => clearInterval(iv);
  }, [userRole, callActive, audioCtxRef]);


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
          <button className="control-btn start-call" onClick={() => { acceptCall(); setIsMinimized(false); }} title="Accept">
            <PhoneCall size={20} />
            <span style={{ marginLeft: 6, fontSize: 12 }}>Accept</span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  ) : null;

  // ── Unified access consent dialog — shown to artist when engineer requests access ─
  const rcConsentModal = rcRequested && !rcDenied && userRole === 'artist' ? createPortal(
    <div className="rc-consent-overlay">
      <div className="rc-consent-card">
        <div className="rc-consent-monitor-icon">
          <MonitorPlay size={32} color="#ff7744" />
        </div>
        <h3 className="rc-consent-title">Remote Access Request</h3>
        <p className="rc-consent-body">
          <strong>{rcEngineerName}</strong> is requesting remote session access.
        </p>

        <div className="rc-consent-section">
          <div className="rc-consent-section-label">Desktop Access</div>
          <div className="rc-consent-radio-group">
            <label className="rc-consent-radio-label">
              <input type="radio" name="rc-desktop" value="none"
                checked={rcDesktopGrant === 'none'} onChange={() => setRcDesktopGrant('none')} />
              No desktop access
            </label>
            <label className="rc-consent-radio-label">
              <input type="radio" name="rc-desktop" value="view"
                checked={rcDesktopGrant === 'view'} onChange={() => setRcDesktopGrant('view')} />
              Screen view only
            </label>
            <label className="rc-consent-radio-label">
              <input type="radio" name="rc-desktop" value="full"
                checked={rcDesktopGrant === 'full'} onChange={() => setRcDesktopGrant('full')} />
              Full desktop control
            </label>
          </div>
          {rcDesktopGrant === 'full' && (
            <p className="rc-consent-hint">
              Engineer can see and control your entire screen, including apps outside the DAW.
            </p>
          )}
        </div>

        <div className="rc-consent-section">
          <div className="rc-consent-section-label">DAW Access</div>
          <label className="rc-consent-checkbox-row">
            <input type="checkbox" checked={rcDawGrant}
              onChange={e => setRcDawGrant(e.target.checked)} />
            <span>Allow DAW control</span>
          </label>
        </div>

        <div className="rc-consent-actions">
          <button className="rc-consent-btn decline"
            onClick={() => {
              setRcDenied(true);
              respondToRcPermission({ desktopAccess: 'none', dawControl: false } as RcPermissionGrant);
            }}>
            Cancel
          </button>
          <button className="rc-consent-btn accept"
            onClick={() => respondToRcPermission({ desktopAccess: rcDesktopGrant, dawControl: rcDawGrant })}>
            Grant Access
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
          <div className={`transport-chat-pill pill-${pillStatus}`} data-desktop-hud="" onClick={() => setIsMinimized(false)} title="Open Video Chat">
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
        data-desktop-hud=""
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
          muteCallAudio={muteCallAudio}
          audioOutputDeviceId={audioOutputDeviceId}
        />

        {/* Desktop Control — preview panel, only shown when engineer opens it */}
        {userRole === 'engineer' && rcActive && remoteDesktopStream && showDesktopPanel && !desktopFullscreen && (
          <DesktopStreamPreview
            stream={remoteDesktopStream}
            onFullscreen={() => setDesktopFullscreen(true)}
          />
        )}

        {/* Desktop Control full-screen overlay — handles all event capture directly */}
        {userRole === 'engineer' && rcActive && remoteDesktopStream && desktopFullscreen && (
          <DesktopControlFullscreen
            stream={remoteDesktopStream}
            onExit={() => setDesktopFullscreen(false)}
            onStop={stopRemoteControl}
            onSendInput={sendInputEvent}
          />
        )}

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
              <button
                className="chat-send-btn"
                disabled={!chatInput.trim()}
                onClick={() => {
                  if (!chatInput.trim()) return;
                  sendMessage(chatInput.trim());
                  setChatInput('');
                  setShowEmojiPicker(false);
                  chatInputRef.current?.focus();
                }}
                title="Send"
                type="button"
              >
                <SendHorizonal size={14} />
              </button>
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
            {/* Request Access — unified prompt for Desktop + DAW permissions */}
            {userRole === 'engineer' && (
              rcActive ? (
                <>
                  {remoteDesktopStream && (
                    <button
                      className={`session-ctrl-btn${showDesktopPanel ? ' active' : ''}`}
                      onClick={() => setShowDesktopPanel(v => !v)}
                      title={showDesktopPanel ? 'Hide desktop preview' : 'View artist desktop'}
                    >
                      {showDesktopPanel ? 'Hide Desktop' : 'View Desktop'}
                    </button>
                  )}
                  <button
                    className="session-ctrl-btn desktop active"
                    onClick={stopRemoteControl}
                    title="Stop Desktop Control"
                  >
                    Stop Desktop
                  </button>
                </>
              ) : rcRequested ? (
                <button className="session-ctrl-btn" disabled title="Waiting for artist…">
                  Requesting…
                </button>
              ) : (
                <button
                  className="session-ctrl-btn"
                  onClick={() => requestRemoteControl(userId)}
                  title="Request desktop and DAW access from artist"
                >
                  Request Access
                </button>
              )
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
});

FloatingVideoChat.displayName = 'FloatingVideoChat';
export default FloatingVideoChat;
