import { useRef, useCallback, useEffect, useState } from 'react';
import { AudioRouter } from '../audio/AudioRouter';
import type { AudioBusId } from '../audio/AudioRouter';
import { supabase } from '../lib/supabaseClient';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { RemoteInputEvent, RcPermissionGrant } from '../types/remote';

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // Free public TURN servers via Open Relay (Metered) — handles symmetric NAT.
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turns:openrelay.metered.ca:443',
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

if (import.meta.env.VITE_TURN_URL) {
  ICE_SERVERS.push({
    urls: import.meta.env.VITE_TURN_URL as string,
    username: import.meta.env.VITE_TURN_USER as string | undefined,
    credential: import.meta.env.VITE_TURN_CREDENTIAL as string | undefined,
  });
}

interface UseWebRTCOptions {
  roomCode: string;
  userId: string;
  isInitiator: boolean; // engineer creates offer; artist waits for it
  getDawStream?: () => MediaStream | null;
  onInputEvent?: (event: RemoteInputEvent, source: 'app' | 'desktop') => void;
  onDawControlGranted?: () => void;
  onDawControlRevoked?: () => void;
}

export const useWebRTC = ({ roomCode, userId, isInitiator, getDawStream, onInputEvent, onDawControlGranted, onDawControlRevoked }: UseWebRTCOptions) => {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [remoteDawStream, setRemoteDawStream] = useState<MediaStream | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [callActive, setCallActive] = useState(false);
  const [isMicOn, setIsMicOn] = useState(true);
  const [isVideoOn, setIsVideoOn] = useState(true);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [remoteDesktopStream, setRemoteDesktopStream] = useState<MediaStream | null>(null);
  const [rcRequested, setRcRequested] = useState(false);
  const [rcActive, setRcActive] = useState(false);
  const [rcEngineerName, setRcEngineerName] = useState('Engineer');
  const [rcViewOnly, setRcViewOnly] = useState(false);

  const [incomingCall, setIncomingCall] = useState(false);
  const [callerId, setCallerId] = useState<string | null>(null);
  const [isCalling, setIsCalling] = useState(false);
  const [messages, setMessages] = useState<Array<{ id: string; sender: string; text: string; timestamp: number }>>([]);

  // ── Audio bus management for this call ───────────────────────────────────
  // Tracks which bus is currently feeding the call's audio track so we can
  // release it cleanly when the call ends.
  const activeBusRef = useRef<AudioBusId | null>(null);

  const acquireCallAudioStream = useCallback((busId: AudioBusId): MediaStream | null => {
    // Release any previously held bus before acquiring a new one
    if (activeBusRef.current) {
      AudioRouter.getInstance().releaseStream(activeBusRef.current);
      activeBusRef.current = null;
    }
    const stream = AudioRouter.getInstance().getStream(busId);
    if (stream) activeBusRef.current = busId;
    return stream;
  }, []);

  const releaseCallAudio = useCallback(() => {
    if (activeBusRef.current) {
      AudioRouter.getInstance().releaseStream(activeBusRef.current);
      activeBusRef.current = null;
    }
  }, []);

  // ── Live bus swap (engineer can switch source without ending the call) ────
  const switchCallAudioBus = useCallback(async (busId: AudioBusId) => {
    const pc = pcRef.current;
    const stream = acquireCallAudioStream(busId);
    if (!stream || !pc) return;

    const newTrack = stream.getAudioTracks()[0];
    if (!newTrack) return;

    const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
    if (sender) {
      await sender.replaceTrack(newTrack);
    }

    // Also update localStream state so preview renders correctly
    if (localStreamRef.current) {
      const old = localStreamRef.current.getAudioTracks();
      old.forEach(t => localStreamRef.current!.removeTrack(t));
      localStreamRef.current.addTrack(newTrack);
      setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
    }
  }, [acquireCallAudioStream]);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const signalChannelRef = useRef<RealtimeChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const callActiveRef = useRef(false);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const onInputEventRef = useRef(onInputEvent);
  const onDawControlGrantedRef = useRef(onDawControlGranted);
  const onDawControlRevokedRef = useRef(onDawControlRevoked);
  // Stable ref to teardownCall so closures (signal channel, onconnectionstatechange) can call it
  const teardownCallRef = useRef<() => void>(() => {});

  // ── Desktop RC — screen-share peer connection (artist permission required) ──
  const rcPcRef = useRef<RTCPeerConnection | null>(null);
  const rcDataChannelRef = useRef<RTCDataChannel | null>(null);
  const pendingRcIceRef = useRef<RTCIceCandidateInit[]>([]);
  // Set by startScreenShare so the rc-offer handler can answer with the captured track
  const handleRcOfferRef = useRef<((offer: RTCSessionDescriptionInit) => Promise<void>) | null>(null);
  const rcViewOnlyRef = useRef(false);

  // ── App RC — DOM-event forwarding, no permission dialog ──────────────────
  const appRcPcRef  = useRef<RTCPeerConnection | null>(null);
  const appRcDcRef  = useRef<RTCDataChannel | null>(null);
  const pendingAppRcIceRef = useRef<RTCIceCandidateInit[]>([]);
  const [appRcActive, setAppRcActive] = useState(false);
  const [signalChannelReady, setSignalChannelReady] = useState(false);

  useEffect(() => { onInputEventRef.current = onInputEvent; }, [onInputEvent]);
  useEffect(() => { onDawControlGrantedRef.current = onDawControlGranted; }, [onDawControlGranted]);
  useEffect(() => { onDawControlRevokedRef.current = onDawControlRevoked; }, [onDawControlRevoked]);
  useEffect(() => { rcViewOnlyRef.current = rcViewOnly; }, [rcViewOnly]);

  const setupDataChannel = useCallback((dc: RTCDataChannel) => {
    dataChannelRef.current = dc;
    dc.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as RemoteInputEvent;
        // Main call channel is only used as a Desktop RC fallback
        if (event.type !== 'pointermove') console.log('[ARTIST_INPUT_RECEIVED] desktop (fallback-dc)', event.type);
        onInputEventRef.current?.(event, 'desktop');
      } catch { /* ignore malformed */ }
    };
  }, []);

  const createPeerConnection = useCallback(() => {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    pc.onicecandidate = ({ candidate }) => {
      if (candidate && channelRef.current) {
        channelRef.current.send({
          type: 'broadcast',
          event: 'ice-candidate',
          payload: { candidate, from: userId },
        });
      }
    };

    // Identify streams using track.kind — avoids the race condition where audio
    // and video ontrack events fire separately (Unified Plan) and stream.getVideoTracks()
    // is empty when the audio track arrives first.
    pc.ontrack = ({ track, streams }) => {
      const stream = streams[0];
      if (!stream) return;
      if (track.kind === 'video') {
        // Any video on the main PC = camera stream.
        setRemoteStream(stream);
        // Fix race: audio may have landed in remoteDawStream when it arrived first
        // with no video in the stream yet — undo that misclassification.
        setRemoteDawStream(prev => (prev?.id === stream.id ? null : prev));
      } else {
        // Audio track: if the stream already has a video track it's the camera mic;
        // otherwise it's the DAW audio bus (no video, audio only).
        if (stream.getVideoTracks().length > 0) {
          setRemoteStream(stream);
        } else {
          setRemoteDawStream(stream);
        }
      }
    };

    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      setIsConnected(s === 'connected');

      if (s === 'connected') {
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        // Encoder: cap video bitrate, prioritise audio
        pc.getSenders().forEach(async sender => {
          if (!sender.track) return;
          try {
            const params = sender.getParameters();
            if (!params.encodings?.length) params.encodings = [{}];
            if (sender.track.kind === 'video') {
              params.encodings[0].maxBitrate      = 1_500_000;
              params.encodings[0].maxFramerate    = 30;
              params.encodings[0].networkPriority = 'high' as RTCPriorityType;
            } else if (sender.track.kind === 'audio') {
              params.encodings[0].maxBitrate      = 128_000;
              params.encodings[0].networkPriority = 'very-high' as RTCPriorityType;
            }
            await sender.setParameters(params);
          } catch { /* browser may not support all params */ }
        });
        // Jitter buffer: minimize buffering delay on audio receivers (Chrome 115+)
        pc.getReceivers().forEach(receiver => {
          if (receiver.track.kind === 'audio') {
            try { (receiver as any).jitterBufferTarget = 0; } catch {}
          }
        });
      } else if (s === 'disconnected') {
        reconnectTimer = setTimeout(() => {
          if (pcRef.current?.connectionState === 'disconnected') {
            pcRef.current.restartIce();
          }
        }, 5000);
      } else if (s === 'failed') {
        // ICE failed (network drop) — unrecoverable, reset both sides
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        if (callActiveRef.current) teardownCallRef.current();
      } else if (s === 'closed') {
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        // Peer closed the PC (race condition / hung up before our hangup arrived)
        if (callActiveRef.current) teardownCallRef.current();
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') pc.restartIce();
    };

    // Renegotiation — only fires after initial connection (e.g. screen share added)
    pc.onnegotiationneeded = async () => {
      if (!channelRef.current) return;
      if (!pc.currentRemoteDescription) return;
      if (pc.signalingState !== 'stable') return;
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        channelRef.current.send({
          type: 'broadcast',
          event: 'offer',
          payload: { offer, from: userId },
        });
      } catch (err) {
        console.error('Renegotiation error:', err);
      }
    };

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        pc.addTrack(track, localStreamRef.current!);
      });
    }

    const dawStream = getDawStream?.();
    if (dawStream) {
      dawStream.getAudioTracks().forEach(track => {
        pc.addTrack(track, dawStream);
      });
    }

    // Engineer creates DataChannel; Artist receives it via ondatachannel
    if (isInitiator) {
      const dc = pc.createDataChannel('rc-input', { ordered: false, maxRetransmits: 0 });
      setupDataChannel(dc);
    } else {
      pc.ondatachannel = (e) => setupDataChannel(e.channel);
    }

    pcRef.current = pc;
    return pc;
  }, [userId, getDawStream, isInitiator, setupDataChannel]);

  // ── Background signaling channel — always active while in the room ─────────
  useEffect(() => {
    const channel = supabase.channel(`studiolink_signal_${roomCode}`, {
      config: { broadcast: { self: false } },
    });
    signalChannelRef.current = channel;

    // ── Video call signaling ─────────────────────────────────────────────────
    channel.on('broadcast', { event: 'ring' }, ({ payload }) => {
      if (!callActiveRef.current) { setIncomingCall(true); setCallerId(payload.from); }
    });
    channel.on('broadcast', { event: 'decline' }, () => setIsCalling(false));
    channel.on('broadcast', { event: 'accept' }, () => {
      setIsCalling(false);
      setTimeout(() => startCallInternal(), 500);
    });
    // Peer hung up — reset immediately (no ICE timeout freeze)
    channel.on('broadcast', { event: 'hangup' }, () => {
      teardownCallRef.current();
    });
    channel.on('broadcast', { event: 'chat' }, ({ payload }) => {
      setMessages(prev => [...prev, payload.message]);
    });

    // ── RC signaling ─────────────────────────────────────────────────────────

    // Artist receives: engineer wants RC
    channel.on('broadcast', { event: 'request-rc' }, ({ payload }) => {
      if (!isInitiator) {
        setRcEngineerName(payload.engineerName ?? 'Engineer');
        setRcRequested(true);
      }
    });

    // Engineer receives: artist's permission decision
    channel.on('broadcast', { event: 'rc-permission-response' }, ({ payload }) => {
      if (!isInitiator || payload.from === userId) return;
      setRcRequested(false);
      // Desktop access activates via the rc-accepted → rc-offer chain that follows
      // DAW control: notify DawWorkspace so it enables App RC and signals EngineerConsole
      if (payload.dawControl) onDawControlGrantedRef.current?.();
    });

    // Engineer receives: artist revoked DAW control
    channel.on('broadcast', { event: 'daw-control-revoked' }, ({ payload }) => {
      if (!isInitiator || payload?.from === userId) return;
      if (appRcDcRef.current) { appRcDcRef.current.close(); appRcDcRef.current = null; }
      if (appRcPcRef.current) { appRcPcRef.current.close(); appRcPcRef.current = null; }
      pendingAppRcIceRef.current = [];
      setAppRcActive(false);
      onDawControlRevokedRef.current?.();
    });

    // Either side: RC session ended
    channel.on('broadcast', { event: 'stop-rc' }, () => {
      setRcActive(false);
      setIsScreenSharing(false);
      setRcRequested(false);
      setRemoteDesktopStream(null);
      handleRcOfferRef.current = null;
      if (rcDataChannelRef.current) { rcDataChannelRef.current.close(); rcDataChannelRef.current = null; }
      if (rcPcRef.current) { rcPcRef.current.close(); rcPcRef.current = null; }
      pendingRcIceRef.current = [];
    });

    // Engineer receives: artist accepted → create RC peer connection (data channel only)
    channel.on('broadcast', { event: 'rc-accepted' }, async () => {
      if (!isInitiator) return;
      if (rcPcRef.current) { rcPcRef.current.close(); rcPcRef.current = null; }
      pendingRcIceRef.current = [];

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

      pc.onicecandidate = ({ candidate }) => {
        if (candidate) channel.send({ type: 'broadcast', event: 'rc-ice', payload: { candidate, from: userId } });
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') { setRcActive(true); setRcRequested(false); }
        if (pc.connectionState === 'failed') pc.restartIce();
        if (pc.connectionState === 'closed') { setRcActive(false); setRemoteDesktopStream(null); }
      };

      // Receive artist's screen capture video track
      pc.ontrack = ({ streams }) => {
        if (streams[0]) setRemoteDesktopStream(streams[0]);
      };

      // Data channel carries input events from engineer → artist
      const dc = pc.createDataChannel('rc-input', { ordered: false, maxRetransmits: 0 });
      dc.onmessage = (e) => {
        // Engineer side — should not normally receive events back on this channel
        try { onInputEventRef.current?.(JSON.parse(e.data), 'desktop'); } catch {}
      };
      rcDataChannelRef.current = dc;

      // Without a recvonly transceiver the offer SDP has no video section,
      // so the artist's screen track is silently dropped when they answer.
      pc.addTransceiver('video', { direction: 'recvonly' });

      rcPcRef.current = pc;

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      channel.send({ type: 'broadcast', event: 'rc-offer', payload: { offer, from: userId } });
    });

    // Artist receives: engineer's RC WebRTC offer → handled via ref (screen captured in startScreenShare)
    channel.on('broadcast', { event: 'rc-offer' }, async ({ payload }) => {
      if (isInitiator || payload.from === userId) return;
      await handleRcOfferRef.current?.(payload.offer);
    });

    // Engineer receives: artist's answer to RC offer
    channel.on('broadcast', { event: 'rc-answer' }, async ({ payload }) => {
      if (!isInitiator || payload.from === userId) return;
      try {
        await rcPcRef.current?.setRemoteDescription(payload.answer);
        for (const c of pendingRcIceRef.current) {
          await rcPcRef.current?.addIceCandidate(c).catch(() => {});
        }
        pendingRcIceRef.current = [];
      } catch (e) { console.error('[RC] rc-answer error', e); }
    });

    // Both sides: trickle ICE candidates for the RC peer connection
    channel.on('broadcast', { event: 'rc-ice' }, async ({ payload }) => {
      if (payload.from === userId) return;
      try {
        if (rcPcRef.current?.remoteDescription) {
          await rcPcRef.current.addIceCandidate(payload.candidate);
        } else {
          pendingRcIceRef.current.push(payload.candidate);
        }
      } catch {}
    });

    // ── App RC signaling (no permission dialog) ──────────────────────────────

    // Artist auto-answers the engineer's App RC offer.
    // A generation counter ensures that if a second offer arrives while the first is
    // still negotiating, the stale async handler aborts before sending a stale answer.
    let appRcGeneration = 0;
    channel.on('broadcast', { event: 'app-rc-offer' }, async ({ payload }) => {
      if (isInitiator || payload.from === userId) return;
      const myGen = ++appRcGeneration;

      if (appRcDcRef.current)  { appRcDcRef.current.close();  appRcDcRef.current  = null; }
      if (appRcPcRef.current)  { appRcPcRef.current.close();  appRcPcRef.current  = null; }
      pendingAppRcIceRef.current = [];

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      appRcPcRef.current = pc;

      pc.onicecandidate = ({ candidate }) => {
        if (candidate && myGen === appRcGeneration)
          channel.send({ type: 'broadcast', event: 'app-rc-ice', payload: { candidate, from: userId } });
      };
      pc.ondatachannel = (e) => {
        appRcDcRef.current = e.channel;
        e.channel.onopen  = () => setAppRcActive(true);
        e.channel.onclose = () => setAppRcActive(false);
        e.channel.onmessage = (msg) => {
          try {
            const evt = JSON.parse(msg.data) as RemoteInputEvent;
            if (evt.type !== 'pointermove') console.log('[ARTIST_INPUT_RECEIVED] app', evt.type);
            onInputEventRef.current?.(evt, 'app');
          } catch {}
        };
      };

      try {
        await pc.setRemoteDescription(payload.offer);
        if (myGen !== appRcGeneration) return; // superseded by a newer offer
        for (const c of pendingAppRcIceRef.current) await pc.addIceCandidate(c).catch(() => {});
        pendingAppRcIceRef.current = [];
        const answer = await pc.createAnswer();
        if (myGen !== appRcGeneration) return;
        await pc.setLocalDescription(answer);
        channel.send({ type: 'broadcast', event: 'app-rc-answer', payload: { answer, from: userId } });
      } catch { /* PC was closed by a newer offer — ignore */ }
    });

    // Engineer receives: artist's App RC answer
    channel.on('broadcast', { event: 'app-rc-answer' }, async ({ payload }) => {
      if (!isInitiator || payload.from === userId) return;
      try {
        await appRcPcRef.current?.setRemoteDescription(payload.answer);
        for (const c of pendingAppRcIceRef.current) {
          await appRcPcRef.current?.addIceCandidate(c).catch(() => {});
        }
        pendingAppRcIceRef.current = [];
      } catch (e) { console.error('[App RC] answer error', e); }
    });

    // Both sides: trickle ICE for App RC
    channel.on('broadcast', { event: 'app-rc-ice' }, async ({ payload }) => {
      if (payload.from === userId) return;
      try {
        if (appRcPcRef.current?.remoteDescription) {
          await appRcPcRef.current.addIceCandidate(payload.candidate);
        } else {
          pendingAppRcIceRef.current.push(payload.candidate);
        }
      } catch {}
    });

    // Either side: App RC stopped
    channel.on('broadcast', { event: 'stop-app-rc' }, () => {
      if (appRcDcRef.current) { appRcDcRef.current.close(); appRcDcRef.current = null; }
      if (appRcPcRef.current) { appRcPcRef.current.close(); appRcPcRef.current = null; }
      pendingAppRcIceRef.current = [];
      setAppRcActive(false);
    });

    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') setSignalChannelReady(true);
    });

    return () => {
      setSignalChannelReady(false);
      supabase.removeChannel(channel);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode]);

  const startCallInternal = useCallback(async () => {
    try {
      let stream: MediaStream;

      // When the native engine owns the audio interface exclusively (ASIO/WASAPI),
      // getUserMedia({audio}) would compete for the device and fail.
      // Instead, subscribe to the 'mic-input' bus via AudioRouter which reuses
      // the engine's already-open input stream.
      const nativeAvail = await window.audioEngine?.isAvailable().catch(() => false);
      // Low-latency audio constraints: both sides use headphones in a studio,
      // so echo cancellation and noise suppression are unnecessary and add latency.
      const LOW_LAT_AUDIO = {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        // Chromium honours this hint to minimise capture buffer size
        latency: 0,
      } as MediaTrackConstraints;

      const VIDEO_CONSTRAINTS = {
        width:     { ideal: 1280 },
        height:    { ideal: 720 },
        frameRate: { ideal: 30, max: 30 },
      } as MediaTrackConstraints;

      if (nativeAvail) {
        const busStream   = acquireCallAudioStream('mic-input');
        const videoStream = await navigator.mediaDevices
          .getUserMedia({ video: VIDEO_CONSTRAINTS, audio: false })
          .catch(() => new MediaStream());

        // If the AudioRouter mic-input bus isn't ready (e.g. no interface configured),
        // fall back to standard getUserMedia so the call still carries mic audio.
        let audioTracks: MediaStreamTrack[] = busStream?.getAudioTracks() ?? [];
        if (audioTracks.length === 0) {
          const fallback = await navigator.mediaDevices
            .getUserMedia({ audio: LOW_LAT_AUDIO })
            .catch(() => null);
          audioTracks = fallback?.getAudioTracks() ?? [];
        }

        stream = new MediaStream([
          ...videoStream.getVideoTracks(),
          ...audioTracks,
        ]);
      } else {
        stream = await navigator.mediaDevices.getUserMedia({
          video: VIDEO_CONSTRAINTS,
          audio: LOW_LAT_AUDIO,
        });
      }

      localStreamRef.current = stream;
      setLocalStream(stream);
      setCallActive(true);
      callActiveRef.current = true;

      const channelName = `studiolink_${roomCode}`;
      const channel = supabase.channel(channelName, {
        config: { broadcast: { self: false } },
      });
      channelRef.current = channel;

      channel.on('broadcast', { event: 'offer' }, async ({ payload }) => {
        if (payload.from === userId) return;
        try {
          const pc = pcRef.current || createPeerConnection();
          await pc.setRemoteDescription(new RTCSessionDescription(payload.offer));
          for (const c of pendingCandidatesRef.current) {
            await pc.addIceCandidate(new RTCIceCandidate(c));
          }
          pendingCandidatesRef.current = [];
          const answer = await pc.createAnswer();
          if (answer.sdp) {
            answer.sdp = answer.sdp.replace('useinbandfec=1', 'useinbandfec=1; stereo=1; sprop-stereo=1; maxaveragebitrate=510000');
          }
          await pc.setLocalDescription(answer);
          channel.send({ type: 'broadcast', event: 'answer', payload: { answer, from: userId } });
        } catch (err) { console.error('[WebRTC] offer handler error:', err); }
      });

      channel.on('broadcast', { event: 'answer' }, async ({ payload }) => {
        if (payload.from === userId) return;
        if (pcRef.current) {
          try {
            await pcRef.current.setRemoteDescription(new RTCSessionDescription(payload.answer));
            for (const c of pendingCandidatesRef.current) {
              await pcRef.current.addIceCandidate(new RTCIceCandidate(c));
            }
            pendingCandidatesRef.current = [];
          } catch (err) { console.error('[WebRTC] answer handler error:', err); }
        }
      });

      channel.on('broadcast', { event: 'ice-candidate' }, async ({ payload }) => {
        if (payload.from === userId) return;
        try {
          if (pcRef.current && pcRef.current.remoteDescription) {
            await pcRef.current.addIceCandidate(new RTCIceCandidate(payload.candidate));
          } else {
            pendingCandidatesRef.current.push(payload.candidate);
          }
        } catch (err) { console.error('[WebRTC] ICE candidate error:', err); }
      });

      channel.on('broadcast', { event: 'ready' }, async ({ payload }) => {
        if (payload.from === userId) return;
        if (isInitiator) {
          const pc = pcRef.current || createPeerConnection();
          const offer = await pc.createOffer();
          if (offer.sdp) {
            offer.sdp = offer.sdp.replace('useinbandfec=1', 'useinbandfec=1; stereo=1; sprop-stereo=1; maxaveragebitrate=510000');
          }
          await pc.setLocalDescription(offer);
          channel.send({ type: 'broadcast', event: 'offer', payload: { offer, from: userId } });
        }
      });

      await channel.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await channel.send({ type: 'broadcast', event: 'ready', payload: { from: userId } });

          if (isInitiator) {
            const pc = pcRef.current || createPeerConnection();
            const offer = await pc.createOffer();
            if (offer.sdp) {
              offer.sdp = offer.sdp.replace('useinbandfec=1', 'useinbandfec=1; stereo=1; sprop-stereo=1; maxaveragebitrate=510000');
            }
            await pc.setLocalDescription(offer);
            channel.send({ type: 'broadcast', event: 'offer', payload: { offer, from: userId } });
          }
        }
      });
    } catch (err) {
      console.error('WebRTC startCall error:', err);
    }
  }, [roomCode, userId, isInitiator, createPeerConnection]);

  // Internal teardown — no broadcast. Called by endCall, hangup listener, and connection failure handler.
  const teardownCall = useCallback(() => {
    releaseCallAudio();
    if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }
    if (localStreamRef.current) { localStreamRef.current.getTracks().forEach(t => t.stop()); localStreamRef.current = null; }
    if (channelRef.current) { supabase.removeChannel(channelRef.current); channelRef.current = null; }
    pendingCandidatesRef.current = [];
    setLocalStream(null); setRemoteStream(null); setRemoteDawStream(null);
    setIsConnected(false); setCallActive(false); callActiveRef.current = false;
    setIsCalling(false); setIncomingCall(false);
    setIsScreenSharing(false);
  }, [releaseCallAudio]);

  // Keep ref current so signal-channel and onconnectionstatechange closures can call it
  useEffect(() => { teardownCallRef.current = teardownCall; }, [teardownCall]);

  const endCall = useCallback(() => {
    // Signal peer before tearing down so they reset immediately
    signalChannelRef.current?.send({ type: 'broadcast', event: 'hangup', payload: { from: userId } });
    teardownCall();
  }, [userId, teardownCall]);

  const ring = useCallback(() => {
    setIsCalling(true);
    signalChannelRef.current?.send({ type: 'broadcast', event: 'ring', payload: { from: userId } });
  }, [userId]);

  const acceptCall = useCallback(() => {
    setIncomingCall(false);
    signalChannelRef.current?.send({ type: 'broadcast', event: 'accept', payload: { from: userId } });
    startCallInternal();
  }, [userId, startCallInternal]);

  const declineCall = useCallback(() => {
    setIncomingCall(false);
    signalChannelRef.current?.send({ type: 'broadcast', event: 'decline', payload: { from: userId } });
  }, [userId]);

  const sendMessage = useCallback((text: string) => {
    const msg = { id: `msg_${Date.now()}`, sender: userId, text, timestamp: Date.now() };
    setMessages(prev => [...prev, msg]);
    signalChannelRef.current?.send({ type: 'broadcast', event: 'chat', payload: { message: msg } });
  }, [userId]);

  const toggleMic = useCallback(() => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (track) { track.enabled = !track.enabled; setIsMicOn(track.enabled); }
  }, []);

  const toggleVideo = useCallback(() => {
    const track = localStreamRef.current?.getVideoTracks()[0];
    if (track) { track.enabled = !track.enabled; setIsVideoOn(track.enabled); }
  }, []);

  // ── Remote Control API ────────────────────────────────────────────────────

  // Engineer: send unified access request (desktop + DAW) — works without an active call
  const requestRemoteControl = useCallback((engineerName = 'Engineer') => {
    if (!isInitiator) return;
    setRcRequested(true); // track pending state for button UI
    signalChannelRef.current?.send({ type: 'broadcast', event: 'request-rc', payload: { from: userId, engineerName } });
  }, [isInitiator, userId]);

  // Artist: accept RC — set up a data-channel-only peer connection (no screen capture).
  // The engineer sees their own identical copy of the app; we just forward their inputs.
  const startScreenShare = useCallback(() => {
    if (isInitiator) return;

    setIsScreenSharing(true);
    setRcRequested(false);

    // One-shot handler: called when engineer's rc-offer arrives.
    handleRcOfferRef.current = async (offer: RTCSessionDescriptionInit) => {
      handleRcOfferRef.current = null;
      try {
        // Capture artist's full desktop — shown to engineer as the Desktop Control video feed.
        // In Electron: use desktopCapturer to grab the primary display without showing a picker.
        // This ensures the engineer sees the FULL screen (can minimize apps, see desktop, etc.)
        // and system dialogs are visible rather than causing a black frame.
        let screenStream: MediaStream | null = null;
        try {
          if (window.studioRC?.getScreenSources) {
            const sources = await window.studioRC.getScreenSources();
            // On Windows, sources[0] may be the combined virtual desktop of ALL monitors
            // (very wide, e.g. 3840×1080 for two 1920×1080 screens side-by-side).
            // Filter those out by aspect ratio — individual screens are ≤ ~2:1 (16:9 = 1.78).
            const singleScreens = sources.filter(s => {
              const { width, height } = s.thumbnailSize ?? { width: 1, height: 1 };
              return height > 0 && (width / height) < 2.5;
            });
            const primary = singleScreens[0] ?? sources[0];
            if (primary) {
              screenStream = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: {
                  mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: primary.id,
                    maxWidth: 3840,
                    maxHeight: 2160,
                    maxFrameRate: 60,
                  },
                } as any,
              });
            }
          }
          if (!screenStream) {
            // Web browser / fallback: show OS picker
            screenStream = await navigator.mediaDevices.getDisplayMedia({
              video: { frameRate: { ideal: 60, max: 60 } },
              audio: false,
            });
          }
        } catch {
          // Artist declined or capture unavailable — continue with data-channel-only control
        }

        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

        pc.onicecandidate = ({ candidate }) => {
          if (candidate) {
            signalChannelRef.current?.send({
              type: 'broadcast', event: 'rc-ice',
              payload: { candidate, from: userId },
            });
          }
        };

        pc.ondatachannel = (e) => {
          rcDataChannelRef.current = e.channel;
          e.channel.onmessage = (msg) => {
            if (rcViewOnlyRef.current) return;
            try {
              const evt = JSON.parse(msg.data) as RemoteInputEvent;
              if (evt.type !== 'pointermove') console.log('[ARTIST_INPUT_RECEIVED] desktop', evt.type);
              onInputEventRef.current?.(evt, 'desktop');
            } catch {}
          };
        };

        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'connected') {
            setRcActive(true);
            // Push maximum bitrate on the screen-share sender for crisp desktop quality
            pc.getSenders().forEach(async sender => {
              if (!sender.track || sender.track.kind !== 'video') return;
              try {
                const params = sender.getParameters();
                if (!params.encodings?.length) params.encodings = [{}];
                params.encodings[0].maxBitrate = 15_000_000; // 15 Mbps
                await sender.setParameters(params);
              } catch { /* browser may not support */ }
            });
          }
          if (pc.connectionState === 'failed') pc.restartIce();
          if (pc.connectionState === 'closed') {
            setRcActive(false);
            setIsScreenSharing(false);
            screenStream?.getTracks().forEach(t => t.stop());
          }
        };

        rcPcRef.current = pc;

        // setRemoteDescription must come before addTrack so the video transceiver
        // created by the engineer's recvonly offer m-line is already in place when
        // we attach the screen track — otherwise a mis-matched sendrecv transceiver
        // is created and the video is silently dropped.
        await pc.setRemoteDescription(offer);
        for (const c of pendingRcIceRef.current) await pc.addIceCandidate(c).catch(() => {});
        pendingRcIceRef.current = [];

        // Add screen video tracks after SRD so they bind to the existing transceiver
        if (screenStream) {
          screenStream.getVideoTracks().forEach(track => {
            pc.addTrack(track, screenStream!);
            // Stop sharing if artist dismisses the OS screen-share picker
            track.onended = () => {
              setIsScreenSharing(false);
              setRcActive(false);
              signalChannelRef.current?.send({ type: 'broadcast', event: 'stop-rc', payload: { from: userId } });
            };
          });
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        signalChannelRef.current?.send({
          type: 'broadcast', event: 'rc-answer',
          payload: { answer, from: userId },
        });

        setRcActive(true);
      } catch (e) {
        console.error('[RC] handleRcOffer error', e);
        setIsScreenSharing(false);
      }
    };

    // Tell engineer we're ready — they'll send an rc-offer
    signalChannelRef.current?.send({ type: 'broadcast', event: 'rc-accepted', payload: { from: userId } });
  }, [isInitiator, userId]);

  // Artist: respond to the engineer's unified permission request
  const respondToRcPermission = useCallback((grant: RcPermissionGrant) => {
    signalChannelRef.current?.send({
      type: 'broadcast', event: 'rc-permission-response',
      payload: { ...grant, from: userId },
    });
    setRcRequested(false);
    if (grant.desktopAccess !== 'none') {
      setRcViewOnly(grant.desktopAccess === 'view');
      rcViewOnlyRef.current = grant.desktopAccess === 'view';
      startScreenShare();
    }
    if (grant.dawControl) {
      onDawControlGrantedRef.current?.();
    }
  }, [userId, startScreenShare]);

  // Artist: revoke DAW control — stops App RC and signals engineer
  const revokeDawControl = useCallback(() => {
    if (appRcDcRef.current) { appRcDcRef.current.close(); appRcDcRef.current = null; }
    if (appRcPcRef.current) { appRcPcRef.current.close(); appRcPcRef.current = null; }
    pendingAppRcIceRef.current = [];
    setAppRcActive(false);
    signalChannelRef.current?.send({ type: 'broadcast', event: 'daw-control-revoked', payload: { from: userId } });
    onDawControlRevokedRef.current?.();
  }, [userId]);

  // Artist: revoke RC / Desktop Control
  const revokeRemoteControl = useCallback(() => {
    // Stop any screen capture tracks on the RC peer connection
    rcPcRef.current?.getSenders().forEach(s => { s.track?.stop(); });
    if (rcDataChannelRef.current) { rcDataChannelRef.current.close(); rcDataChannelRef.current = null; }
    if (rcPcRef.current) { rcPcRef.current.close(); rcPcRef.current = null; }
    pendingRcIceRef.current = [];
    handleRcOfferRef.current = null;
    setIsScreenSharing(false); setRcActive(false); setRcRequested(false);
    signalChannelRef.current?.send({ type: 'broadcast', event: 'stop-rc', payload: { from: userId } });
  }, [userId]);

  // Engineer: stop RC from their side
  const stopRemoteControl = useCallback(() => {
    if (!isInitiator) return;
    if (rcDataChannelRef.current) { rcDataChannelRef.current.close(); rcDataChannelRef.current = null; }
    if (rcPcRef.current) { rcPcRef.current.close(); rcPcRef.current = null; }
    pendingRcIceRef.current = [];
    setRcActive(false);
    signalChannelRef.current?.send({ type: 'broadcast', event: 'stop-rc', payload: { from: userId } });
  }, [isInitiator, userId]);

  // Engineer: send an input event via Desktop RC data channel (or call channel as fallback)
  const sendInputEvent = useCallback((event: RemoteInputEvent) => {
    const dc = rcDataChannelRef.current ?? dataChannelRef.current;
    if (dc?.readyState === 'open') {
      if (event.type !== 'pointermove') console.log('[INPUT_SENT]', event.type);
      dc.send(JSON.stringify(event));
    }
  }, []);

  // Artist: call this after the DAW master-out stream is ready (or any time it
  // changes) to ensure the audio track is in the live peer connection.
  // If the call hadn't started yet when the stream was first available, this
  // adds it now and onnegotiationneeded handles the renegotiation.
  const syncDawStream = useCallback(() => {
    const pc  = pcRef.current;
    const stream = getDawStream?.();
    if (!pc || !stream) return;
    const existing = new Set(pc.getSenders().map(s => s.track?.id));
    stream.getAudioTracks().forEach(track => {
      if (!existing.has(track.id)) pc.addTrack(track, stream);
    });
    // onnegotiationneeded fires automatically when new tracks are added
  }, [getDawStream]);

  // Engineer: open App RC data channel to artist (no permission dialog)
  const startAppRc = useCallback(async () => {
    if (appRcDcRef.current)  { appRcDcRef.current.close();  appRcDcRef.current  = null; }
    if (appRcPcRef.current)  { appRcPcRef.current.close();  appRcPcRef.current  = null; }
    pendingAppRcIceRef.current = [];

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    appRcPcRef.current = pc;
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) signalChannelRef.current?.send({
        type: 'broadcast', event: 'app-rc-ice', payload: { candidate, from: userId },
      });
    };

    const dc = pc.createDataChannel('app-rc', { ordered: false, maxRetransmits: 0 });
    appRcDcRef.current = dc;
    dc.onopen  = () => setAppRcActive(true);
    dc.onclose = () => setAppRcActive(false);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signalChannelRef.current?.send({
      type: 'broadcast', event: 'app-rc-offer', payload: { offer, from: userId },
    });
  }, [userId]);

  // Engineer: close App RC and notify artist
  const stopAppRc = useCallback(() => {
    if (appRcDcRef.current)  { appRcDcRef.current.close();  appRcDcRef.current  = null; }
    if (appRcPcRef.current)  { appRcPcRef.current.close();  appRcPcRef.current  = null; }
    pendingAppRcIceRef.current = [];
    setAppRcActive(false);
    signalChannelRef.current?.send({ type: 'broadcast', event: 'stop-app-rc', payload: { from: userId } });
  }, [userId]);

  // Engineer: forward an input event to artist via App RC data channel
  const sendAppRcInput = useCallback((event: RemoteInputEvent) => {
    const dc = appRcDcRef.current;
    if (dc?.readyState === 'open') dc.send(JSON.stringify(event));
  }, []);

  useEffect(() => { return () => { endCall(); }; }, [endCall]);

  return {
    localStream, remoteStream, remoteDawStream, remoteDesktopStream,
    isConnected, callActive, isMicOn, isVideoOn,
    isScreenSharing, rcRequested, rcActive,
    rcEngineerName, rcViewOnly,
    incomingCall, isCalling, callerId, messages,
    ring, acceptCall, declineCall, sendMessage,
    endCall, toggleMic, toggleVideo,
    requestRemoteControl, startScreenShare, revokeRemoteControl, stopRemoteControl,
    respondToRcPermission, revokeDawControl,
    sendInputEvent, syncDawStream,
    switchCallAudioBus,
    activeCallBus: activeBusRef.current,
    appRcActive, startAppRc, stopAppRc, sendAppRcInput,
    signalChannelReady,
  };
};
