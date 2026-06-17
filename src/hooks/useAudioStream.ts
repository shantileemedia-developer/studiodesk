import { useRef, useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import type { RealtimeChannel } from '@supabase/supabase-js';

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const CHANNEL = (roomCode: string) => `studiolink_stream_${roomCode}`;

export type MonitorQuality = 'recording' | 'review';
export type MonitorConnectionState = 'idle' | 'connecting' | 'connected' | 'failed';

// Recording mode: low latency, 128 kbps stereo Opus
// Review mode:    high quality, 510 kbps stereo Opus
const SDP_BITRATE: Record<MonitorQuality, number> = { recording: 128000, review: 510000 };

const patchSdp = (sdp: string, quality: MonitorQuality) =>
  sdp.replace(
    'useinbandfec=1',
    `useinbandfec=1; stereo=1; sprop-stereo=1; maxaveragebitrate=${SDP_BITRATE[quality]}`,
  );

interface UseAudioStreamOptions {
  roomCode: string;
  userId: string;
  userRole: 'artist' | 'engineer';
  getMasterStream: () => MediaStream | null;
  quality?: MonitorQuality;
}

const buildPc = (onCandidate: (c: RTCIceCandidate) => void): RTCPeerConnection => {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  pc.onicecandidate = ({ candidate }) => { if (candidate) onCandidate(candidate); };
  return pc;
};

export const useAudioStream = ({
  roomCode, userId, userRole, getMasterStream, quality = 'review',
}: UseAudioStreamOptions) => {
  const [isStreaming,      setIsStreaming]      = useState(false);
  const [isReceiving,      setIsReceiving]      = useState(false);
  const [remoteStream,     setRemoteStream]     = useState<MediaStream | null>(null);
  const [connectionState,  setConnectionState]  = useState<MonitorConnectionState>('idle');

  const pcRef          = useRef<RTCPeerConnection | null>(null);
  const channelRef     = useRef<RealtimeChannel | null>(null);
  const isStreamingRef = useRef(false);
  const qualityRef     = useRef(quality);
  const pendingRef     = useRef<RTCIceCandidateInit[]>([]);

  // Keep qualityRef in sync so event handlers always use the latest value
  useEffect(() => { qualityRef.current = quality; }, [quality]);

  // ── Artist: build and send an offer with current quality SDP ───────────────
  const sendOffer = useCallback(async (channel: RealtimeChannel) => {
    const masterStream = getMasterStream();
    if (!masterStream || masterStream.getAudioTracks().length === 0) return;

    if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }

    const pc = buildPc((candidate) => {
      channel.send({ type: 'broadcast', event: 'stream-ice', payload: { candidate, from: userId } });
    });
    pcRef.current = pc;

    masterStream.getAudioTracks().forEach(track => pc.addTrack(track, masterStream));

    const offer = await pc.createOffer();
    if (offer.sdp) offer.sdp = patchSdp(offer.sdp, qualityRef.current);
    await pc.setLocalDescription(offer);

    channel.send({ type: 'broadcast', event: 'stream-offer', payload: { offer, from: userId } });
  }, [getMasterStream, userId]);

  // ── Artist: start streaming master bus ─────────────────────────────────────
  const startStream = useCallback(async () => {
    if (userRole !== 'artist') return;
    const masterStream = getMasterStream();
    if (!masterStream) {
      console.error('[monitor] AudioContext not ready — play something first');
      return;
    }

    const channel = supabase.channel(CHANNEL(roomCode), {
      config: { broadcast: { self: false } },
    });
    channelRef.current = channel;

    channel.on('broadcast', { event: 'stream-answer' }, async ({ payload }) => {
      if (payload.from === userId) return;
      if (pcRef.current) {
        await pcRef.current.setRemoteDescription(new RTCSessionDescription(payload.answer));
      }
    });

    channel.on('broadcast', { event: 'stream-ice' }, async ({ payload }) => {
      if (payload.from === userId) return;
      if (pcRef.current?.remoteDescription) {
        await pcRef.current.addIceCandidate(new RTCIceCandidate(payload.candidate));
      }
    });

    // Engineer re-connected or joined late — re-send offer so they get the stream
    channel.on('broadcast', { event: 'stream-request' }, () => {
      if (isStreamingRef.current) sendOffer(channel);
    });

    // Engineer requested a quality change — re-offer with new bitrate
    channel.on('broadcast', { event: 'stream-quality-request' }, async ({ payload }) => {
      if (!isStreamingRef.current || payload.from === userId) return;
      qualityRef.current = payload.quality as MonitorQuality;
      await sendOffer(channel);
    });

    await channel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await sendOffer(channel);
      }
    });

    isStreamingRef.current = true;
    setIsStreaming(true);
  }, [userRole, roomCode, userId, getMasterStream, sendOffer]);

  const stopStream = useCallback(() => {
    if (userRole !== 'artist') return;
    isStreamingRef.current = false;
    if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }
    if (channelRef.current) {
      channelRef.current.send({ type: 'broadcast', event: 'stream-stop', payload: { from: userId } });
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }
    setIsStreaming(false);
  }, [userRole, userId]);

  // ── Artist: re-offer when quality prop changes externally ──────────────────
  useEffect(() => {
    if (userRole === 'artist' && isStreamingRef.current && channelRef.current) {
      sendOffer(channelRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quality]);

  // ── Engineer: auto-connect, receive stream ─────────────────────────────────
  useEffect(() => {
    if (userRole !== 'engineer') return;

    const channel = supabase.channel(CHANNEL(roomCode), {
      config: { broadcast: { self: false } },
    });
    channelRef.current = channel;

    channel.on('broadcast', { event: 'stream-offer' }, async ({ payload }) => {
      if (payload.from === userId) return;

      if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }
      pendingRef.current = [];
      setConnectionState('connecting');

      const pc = buildPc((candidate) => {
        channel.send({ type: 'broadcast', event: 'stream-ice', payload: { candidate, from: userId } });
      });
      pcRef.current = pc;

      pc.ontrack = (e) => {
        const stream = e.streams[0];
        if (stream) { setRemoteStream(stream); setIsReceiving(true); }
      };

      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === 'connected')                          setConnectionState('connected');
        else if (s === 'connecting' || s === 'new')    setConnectionState('connecting');
        else if (s === 'disconnected' || s === 'failed') {
          setConnectionState('failed');
          setIsReceiving(false);
        }
      };

      await pc.setRemoteDescription(new RTCSessionDescription(payload.offer));
      for (const c of pendingRef.current) await pc.addIceCandidate(new RTCIceCandidate(c));
      pendingRef.current = [];

      const answer = await pc.createAnswer();
      // Engineer echoes same bitrate in answer — some browsers honour this
      if (answer.sdp) answer.sdp = patchSdp(answer.sdp, qualityRef.current);
      await pc.setLocalDescription(answer);

      channel.send({ type: 'broadcast', event: 'stream-answer', payload: { answer, from: userId } });
    });

    channel.on('broadcast', { event: 'stream-ice' }, async ({ payload }) => {
      if (payload.from === userId) return;
      if (pcRef.current?.remoteDescription) {
        await pcRef.current.addIceCandidate(new RTCIceCandidate(payload.candidate));
      } else {
        pendingRef.current.push(payload.candidate);
      }
    });

    channel.on('broadcast', { event: 'stream-stop' }, () => {
      setIsReceiving(false);
      setRemoteStream(null);
      setConnectionState('idle');
      if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }
    });

    // On connect, ask Artist to re-send offer in case they're already streaming
    channel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        channel.send({ type: 'broadcast', event: 'stream-request', payload: { from: userId } });
      }
    });

    return () => {
      supabase.removeChannel(channel);
      if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }
      setConnectionState('idle');
      setIsReceiving(false);
      setRemoteStream(null);
    };
  }, [roomCode, userId, userRole]);

  // ── Engineer: request quality change — artist re-offers with new bitrate ───
  const requestQuality = useCallback((q: MonitorQuality) => {
    if (userRole !== 'engineer' || !channelRef.current) return;
    channelRef.current.send({
      type: 'broadcast', event: 'stream-quality-request',
      payload: { quality: q, from: userId },
    });
  }, [userRole, userId]);

  return {
    isStreaming, isReceiving, remoteStream, connectionState,
    startStream, stopStream, requestQuality,
  };
};
