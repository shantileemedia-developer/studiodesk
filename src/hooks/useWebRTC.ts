import { useRef, useCallback, useEffect, useState } from 'react';
import { AudioRouter } from '../audio/AudioRouter';
import type { AudioBusId } from '../audio/AudioRouter';
import { supabase } from '../lib/supabaseClient';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { RemoteInputEvent } from '../types/remote';

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
  onInputEvent?: (event: RemoteInputEvent) => void;
}

export const useWebRTC = ({ roomCode, userId, isInitiator, getDawStream, onInputEvent }: UseWebRTCOptions) => {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [remoteDawStream, setRemoteDawStream] = useState<MediaStream | null>(null);
  const [remoteScreenStream, setRemoteScreenStream] = useState<MediaStream | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [callActive, setCallActive] = useState(false);
  const [isMicOn, setIsMicOn] = useState(true);
  const [isVideoOn, setIsVideoOn] = useState(true);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [rcRequested, setRcRequested] = useState(false);
  const [rcActive, setRcActive] = useState(false);
  const [rcEngineerName, setRcEngineerName] = useState('Engineer');
  const [rcViewOnly, setRcViewOnly] = useState(false);
  const [audioDeviceControlAllowed, setAudioDeviceControlAllowed] = useState(false);

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
  const screenTrackRef = useRef<MediaStreamTrack | null>(null);
  const onInputEventRef = useRef(onInputEvent);

  // ── RC-only peer connection refs (independent of the video call) ──────────
  const rcPcRef = useRef<RTCPeerConnection | null>(null);
  const rcDataChannelRef = useRef<RTCDataChannel | null>(null);
  const pendingRcIceRef = useRef<RTCIceCandidateInit[]>([]);
  // Set by startScreenShare so the rc-offer handler can answer with the captured track
  const handleRcOfferRef = useRef<((offer: RTCSessionDescriptionInit) => Promise<void>) | null>(null);
  const rcViewOnlyRef = useRef(false);

  useEffect(() => { onInputEventRef.current = onInputEvent; }, [onInputEvent]);
  useEffect(() => { rcViewOnlyRef.current = rcViewOnly; }, [rcViewOnly]);

  const setupDataChannel = useCallback((dc: RTCDataChannel) => {
    dataChannelRef.current = dc;
    dc.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as RemoteInputEvent;
        onInputEventRef.current?.(event);
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

    // Identify streams by track composition to handle camera, DAW audio, and screen share
    pc.ontrack = (event) => {
      const stream = event.streams[0];
      if (!stream) return;
      const hasVideo = stream.getVideoTracks().length > 0;
      const hasAudio = stream.getAudioTracks().length > 0;
      if (hasVideo && hasAudio) setRemoteStream(stream);
      else if (hasAudio && !hasVideo) setRemoteDawStream(stream);
      else if (hasVideo && !hasAudio) setRemoteScreenStream(stream);
    };

    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      setIsConnected(s === 'connected');

      if (s === 'disconnected') {
        reconnectTimer = setTimeout(() => {
          if (pcRef.current?.connectionState === 'disconnected') {
            pcRef.current.restartIce();
          }
        }, 5000);
      } else if (s === 'connected' || s === 'closed') {
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
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
      if (payload.level === 'denied') { setRcRequested(false); return; }
      setAudioDeviceControlAllowed(payload.audioDeviceControl ?? false);
    });

    // Either side: RC session ended
    channel.on('broadcast', { event: 'stop-rc' }, () => {
      setRcActive(false);
      setRemoteScreenStream(null);
      setIsScreenSharing(false);
      setRcRequested(false);
      handleRcOfferRef.current = null;
      if (rcDataChannelRef.current) { rcDataChannelRef.current.close(); rcDataChannelRef.current = null; }
      if (rcPcRef.current) { rcPcRef.current.close(); rcPcRef.current = null; }
      pendingRcIceRef.current = [];
    });

    // Engineer receives: artist accepted → create RC peer connection + offer
    channel.on('broadcast', { event: 'rc-accepted' }, async () => {
      if (!isInitiator) return;
      if (rcPcRef.current) { rcPcRef.current.close(); rcPcRef.current = null; }
      pendingRcIceRef.current = [];

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

      pc.onicecandidate = ({ candidate }) => {
        if (candidate) channel.send({ type: 'broadcast', event: 'rc-ice', payload: { candidate, from: userId } });
      };

      pc.ontrack = ({ streams }) => {
        if (streams[0]) setRemoteScreenStream(streams[0]);
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') { setRcActive(true); setRcRequested(false); }
        if (pc.connectionState === 'failed') pc.restartIce();
        if (pc.connectionState === 'closed') { setRcActive(false); setRemoteScreenStream(null); }
      };

      // Engineer creates the data channel for sending input events to artist
      const dc = pc.createDataChannel('rc-input', { ordered: false, maxRetransmits: 0 });
      dc.onmessage = (e) => {
        try { onInputEventRef.current?.(JSON.parse(e.data)); } catch {}
      };
      rcDataChannelRef.current = dc;
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

    channel.subscribe();
    return () => { supabase.removeChannel(channel); };
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
      if (nativeAvail) {
        const busStream  = acquireCallAudioStream('mic-input');
        const videoStream = await navigator.mediaDevices
          .getUserMedia({ video: true, audio: false })
          .catch(() => new MediaStream());
        stream = new MediaStream([
          ...videoStream.getVideoTracks(),
          ...(busStream ? busStream.getAudioTracks() : []),
        ]);
      } else {
        stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
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

  const endCall = useCallback(() => {
    releaseCallAudio();
    if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }
    if (localStreamRef.current) { localStreamRef.current.getTracks().forEach(t => t.stop()); localStreamRef.current = null; }
    if (channelRef.current) { supabase.removeChannel(channelRef.current); channelRef.current = null; }
    if (screenTrackRef.current) { screenTrackRef.current.stop(); screenTrackRef.current = null; }
    pendingCandidatesRef.current = [];
    setLocalStream(null); setRemoteStream(null); setRemoteDawStream(null); setRemoteScreenStream(null);
    setIsConnected(false); setCallActive(false); callActiveRef.current = false;
    setIsCalling(false); setIncomingCall(false);
    setIsScreenSharing(false);
  }, []);

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

  // Engineer: send RC request — works without an active call
  const requestRemoteControl = useCallback((engineerName = 'Engineer') => {
    if (!isInitiator) return;
    signalChannelRef.current?.send({ type: 'broadcast', event: 'request-rc', payload: { from: userId, engineerName } });
  }, [isInitiator, userId]);

  // Artist: capture screen and set up the RC answer handler, then signal engineer
  const startScreenShare = useCallback(async () => {
    if (isInitiator) return;
    try {
      let stream: MediaStream;

      if (typeof window !== 'undefined' && window.studioRC) {
        const sources = await window.studioRC.getScreenSources();
        if (!sources?.length) throw new Error('No screen sources found');
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: sources[0].id,
              minFrameRate: 30,
              maxFrameRate: 30,
            }
          } as any,
        });
      } else {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: 30 } as MediaTrackConstraints,
          audio: false,
        });
      }

      const track = stream.getVideoTracks()[0];
      screenTrackRef.current = track;
      setIsScreenSharing(true);
      setRcRequested(false);

      // Wire up the one-shot offer handler. When rc-offer arrives (from engineer
      // after receiving rc-accepted), this creates the RC peer connection and answers.
      handleRcOfferRef.current = async (offer: RTCSessionDescriptionInit) => {
        if (!screenTrackRef.current) return;
        handleRcOfferRef.current = null; // one-shot

        try {
          const trackStream = new MediaStream([screenTrackRef.current]);
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
              try { onInputEventRef.current?.(JSON.parse(msg.data)); } catch {}
            };
          };

          pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'connected') setRcActive(true);
            if (pc.connectionState === 'failed') pc.restartIce();
            if (pc.connectionState === 'closed') { setRcActive(false); setIsScreenSharing(false); }
          };

          pc.addTrack(screenTrackRef.current, trackStream);
          rcPcRef.current = pc;

          await pc.setRemoteDescription(offer);
          for (const c of pendingRcIceRef.current) await pc.addIceCandidate(c).catch(() => {});
          pendingRcIceRef.current = [];

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

      track.onended = () => revokeRemoteControl();

      // Tell engineer we accepted — they'll send back an rc-offer
      signalChannelRef.current?.send({ type: 'broadcast', event: 'rc-accepted', payload: { from: userId } });

    } catch (err) {
      console.error('[RC] Failed to start screen share', err);
      setRcRequested(false);
      setIsScreenSharing(false);
    }
  // revokeRemoteControl defined below — ref avoids circular dep
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isInitiator, userId]);

  // Artist: respond to the engineer's permission request
  const respondToRcPermission = useCallback((level: 'full' | 'view' | 'denied', audioDevice: boolean) => {
    signalChannelRef.current?.send({
      type: 'broadcast', event: 'rc-permission-response',
      payload: { level, audioDeviceControl: audioDevice, from: userId },
    });
    if (level === 'denied') {
      setRcRequested(false);
      return;
    }
    setRcViewOnly(level === 'view');
    rcViewOnlyRef.current = level === 'view';
    startScreenShare();
  }, [userId, startScreenShare]);

  // Artist: stop sharing and revoke RC
  const revokeRemoteControl = useCallback(() => {
    if (screenTrackRef.current) { screenTrackRef.current.stop(); screenTrackRef.current = null; }
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
    setRcActive(false); setRemoteScreenStream(null);
    signalChannelRef.current?.send({ type: 'broadcast', event: 'stop-rc', payload: { from: userId } });
  }, [isInitiator, userId]);

  // Engineer: send an input event over the RC DataChannel to Artist
  const sendInputEvent = useCallback((event: RemoteInputEvent) => {
    const dc = rcDataChannelRef.current ?? dataChannelRef.current;
    if (dc?.readyState === 'open') {
      dc.send(JSON.stringify(event));
    }
  }, []);

  useEffect(() => { return () => { endCall(); }; }, [endCall]);

  return {
    localStream, remoteStream, remoteDawStream, remoteScreenStream,
    isConnected, callActive, isMicOn, isVideoOn,
    isScreenSharing, rcRequested, rcActive,
    rcEngineerName, rcViewOnly, audioDeviceControlAllowed,
    incomingCall, isCalling, callerId, messages,
    ring, acceptCall, declineCall, sendMessage,
    endCall, toggleMic, toggleVideo,
    requestRemoteControl, startScreenShare, revokeRemoteControl, stopRemoteControl,
    respondToRcPermission,
    sendInputEvent,
    // Communication ↔ DAW bridge: lets engineer switch which bus feeds the call
    switchCallAudioBus,
    activeCallBus: activeBusRef.current,
  };
};
