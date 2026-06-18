import { useCallback, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useDaw } from '../context/DawContext';
import type { DawAction, DawState } from '../context/DawContext';

const SYNCABLE_ACTIONS = new Set([
  // ── Track / region / project ───────────────────────────────────────────────
  'ADD_TRACK', 'REMOVE_TRACK', 'UPDATE_TRACK', 'REORDER_TRACKS', 'RENAME_TRACK',
  'DUPLICATE_TRACK', 'RESIZE_TRACK',
  'ADD_VERSION', 'SWITCH_VERSION', 'RENAME_VERSION',
  'ADD_REGION', 'REMOVE_REGION', 'MOVE_REGION', 'SPLIT_REGION', 'TOGGLE_REGION_MUTE',
  'RENDER_REGIONS', 'UPDATE_REGION', 'SET_REGION_GAIN', 'RENAME_REGION', 'TRIM_REGION',
  'ADD_TRACK_AND_MOVE_REGION',
  'ADD_POOL_ITEM', 'REMOVE_POOL_ITEM',
  'BOUNCE_REGIONS',              // engineer-triggered bounce: syncs the consolidated region + pool item
  'UPDATE_AUDIO_URLS',           // CRITICAL: syncs Supabase public URL to engineer after upload
  'SET_POOL_ITEM_UPLOAD_STATUS', // syncs upload progress badge to engineer
  'RENAME_PROJECT', 'SET_PROJECT_LENGTH',
  'ADD_CROSSFADE', 'REMOVE_CROSSFADE',
  'ADD_MARKER', 'REMOVE_MARKER', 'RENAME_MARKER', 'MOVE_MARKER',
  // ── Transport settings (shared, not commands) ──────────────────────────────
  // SET_PLAYING / SET_RECORDING are NOT here — they're dispatched locally only.
  // Transport commands (play/stop/record) are sent as dedicated broadcast events
  // that carry position info so both sides start from the same time.
  // SET_CURRENT_TIME is excluded — it fires every audio frame and would flood
  // the channel. Each side drives its own cursor from its local audio engine clock.
  'SET_TEMPO', 'SET_TIME_SIGNATURE',
  'TOGGLE_LOOP', 'SET_LOOP_RANGE',
  'SET_PUNCH_RANGE',
  'TOGGLE_METRONOME', 'SET_COUNT_IN',
  // ── UI layout (synced so engineer can control artist's panel visibility) ────
  'SET_PANEL_VISIBILITY',
]);

// Downsample a peak array to at most maxPoints values before broadcasting.
// Full peak arrays can be 100 K+ numbers — Supabase Realtime's ~256 KB broadcast
// limit means even a single ADD_REGION would crash the WebSocket connection.
// 200 points is enough resolution for any waveform display width in the UI.
function downsamplePeaks(peaks: number[], maxPoints = 200): number[] {
  if (peaks.length <= maxPoints) return peaks;
  const step = peaks.length / maxPoints;
  return Array.from({ length: maxPoints }, (_, i) => peaks[Math.floor(i * step)]);
}

// Strip blob: and file: URLs — they're ephemeral OS handles, useless on another machine.
function stripLocalUrl(url: string | undefined | null): string {
  if (!url) return '';
  return (url.startsWith('blob:') || url.startsWith('file:')) ? '' : url;
}

// Prepare the DAW state for a network sync message — strips history, downsamples peaks,
// and removes blob/file:// URLs that are only valid on the originating machine.
function syncableState(state: DawState) {
  return {
    projectName: state.projectName,
    transport:   state.transport,
    tracks:      state.tracks,
    markers:     state.markers,
    poolItems:   state.poolItems.map(item => ({
      ...item,
      audioUrl:       stripLocalUrl(item.audioUrl),
      waveformPeaks:  item.waveformPeaks  ? downsamplePeaks(item.waveformPeaks)  : item.waveformPeaks,
      waveformPeaksR: item.waveformPeaksR ? downsamplePeaks(item.waveformPeaksR) : item.waveformPeaksR,
    })),
    regions: state.regions.map(r => ({
      ...r,
      audioUrl:       stripLocalUrl(r.audioUrl),
      localFilePath:  undefined,
      waveformPeaks:  r.waveformPeaks  ? downsamplePeaks(r.waveformPeaks)  : r.waveformPeaks,
      waveformPeaksR: r.waveformPeaksR ? downsamplePeaks(r.waveformPeaksR) : r.waveformPeaksR,
      sourcePeaks:    r.sourcePeaks    ? downsamplePeaks(r.sourcePeaks)    : r.sourcePeaks,
      sourcePeaksR:   r.sourcePeaksR   ? downsamplePeaks(r.sourcePeaksR)   : r.sourcePeaksR,
    })),
  };
}

export const useDawSync = (
  roomCode: string,
  userRole: 'artist' | 'engineer',
  // Artist only: called when engineer plays/stops. position = where to start or stop at.
  onTransportSync?: (playing: boolean, position: number) => void,
  onViewportSync?: (zoom: number, scrollLeft: number, scrollTop: number) => void,
  onRemoteOp?: (command: string) => void,
  // Artist only: called when engineer starts/stops recording. position = cursor position.
  onRecordSync?: (recording: boolean, position: number) => void,
  // Artist only: called when engineer seeks so artist engine jumps to the same position.
  onSeekSync?: (time: number) => void,
) => {
  const { state, originalDispatch, setDispatchMiddleware } = useDaw();
  const channelRef = useRef<any>(null);
  const stateRef = useRef<DawState>(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  // Guard: once we've received a live state-sync from the peer, the stale DB read
  // must not overwrite it. Without this, the DB fetch (1-2s latency) fires AFTER
  // the peer's state-sync and clears all the clips the engineer just saw.
  const receivedLiveSyncRef = useRef(false);

  const onTransportSyncRef = useRef(onTransportSync);
  useEffect(() => { onTransportSyncRef.current = onTransportSync; }, [onTransportSync]);

  const onViewportSyncRef = useRef(onViewportSync);
  useEffect(() => { onViewportSyncRef.current = onViewportSync; }, [onViewportSync]);

  const onRemoteOpRef = useRef(onRemoteOp);
  useEffect(() => { onRemoteOpRef.current = onRemoteOp; }, [onRemoteOp]);

  const onRecordSyncRef = useRef(onRecordSync);
  useEffect(() => { onRecordSyncRef.current = onRecordSync; }, [onRecordSync]);

  const onSeekSyncRef = useRef(onSeekSync);
  useEffect(() => { onSeekSyncRef.current = onSeekSync; }, [onSeekSync]);

  // ── DB load helper (called on mount and on peer-join) ─────────────
  const fetchAndApplyState = (isMountedRef: { current: boolean }) => {
    supabase
      .from('daw_projects')
      .select('state')
      .eq('room_code', roomCode)
      .single()
      .then(({ data, error }) => {
        if (error && error.code !== 'PGRST116') {
          console.error('Failed to load project from DB:', error);
          return;
        }
        if (isMountedRef.current && data?.state && !receivedLiveSyncRef.current) {
          const parsed = data.state as Partial<DawState> & { tempo?: number };
          // Restore the full transport block, not just tempo.
          // Old code only extracted `parsed.tempo` which lost loopStart/End etc.
          const savedTransport = (parsed as any).transport;
          const tempoFallback  = parsed.tempo; // legacy field from older saves
          // JSON round-trip turns Date objects into ISO strings — restore them.
          const poolItems = parsed.poolItems?.map(item => ({
            ...item,
            createdAt: item.createdAt instanceof Date ? item.createdAt : new Date(item.createdAt),
          }));
          originalDispatch({
            type: 'SET_STATE',
            payload: {
              ...(parsed.projectName && { projectName: parsed.projectName }),
              ...(parsed.tracks      && { tracks:     parsed.tracks }),
              ...(parsed.regions     && { regions:    parsed.regions }),
              ...(poolItems          && { poolItems }),
              ...(savedTransport     && { transport:  savedTransport }),
              ...(!savedTransport && tempoFallback && {
                transport: { ...stateRef.current.transport, tempo: tempoFallback },
              }),
            },
            fromSync: true,
          });
        }
      });
  };

  // Initial load
  useEffect(() => {
    if (!roomCode) return;
    const isMountedRef = { current: true };
    fetchAndApplyState(isMountedRef);
    return () => { isMountedRef.current = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode]);

  // ── Realtime channel + middleware ─────────────────────────
  useEffect(() => {
    if (!roomCode) return;

    const channel = supabase.channel(`daw-${roomCode}`, {
      config: { broadcast: { ack: false } }
    });

    // Incoming action from peer (project edits, settings, etc.)
    channel.on('broadcast', { event: 'action' }, ({ payload }) => {
      let action = payload as DawAction;
      // JSON serialization turns Date objects into ISO strings. Restore them so
      // downstream code (MediaPoolPanel, etc.) can call .getTime() without crashing.
      if (action.type === 'ADD_POOL_ITEM') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = action.payload as unknown as Record<string, unknown>;
        if (p.createdAt && !(p.createdAt instanceof Date)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          action = { ...action, payload: { ...p, createdAt: new Date(p.createdAt as string) } as any };
        }
      }
      originalDispatch(action);
    });

    // ── Transport command events ──────────────────────────────────────────────
    // These carry position info so both sides start/stop at the same timeline position.
    // SET_PLAYING / SET_RECORDING are dispatched locally only; these events drive the engine.

    channel.on('broadcast', { event: 'transport-play' }, ({ payload }) => {
      const { startPosition } = payload as { startPosition: number; timestamp: number };
      originalDispatch({ type: 'SET_PLAYING', payload: true, fromSync: true });
      onTransportSyncRef.current?.(true, startPosition);
    });

    channel.on('broadcast', { event: 'transport-stop' }, ({ payload }) => {
      const { stopPosition } = payload as { stopPosition: number };
      console.log('[DawSync] transport-stop received from peer, stopPosition=', stopPosition);
      originalDispatch({ type: 'SET_PLAYING', payload: false, fromSync: true });
      onTransportSyncRef.current?.(false, stopPosition);
    });

    channel.on('broadcast', { event: 'transport-record' }, ({ payload }) => {
      const { startPosition } = payload as { startPosition: number };
      originalDispatch({ type: 'SET_RECORDING', payload: true, fromSync: true });
      originalDispatch({ type: 'SET_PLAYING',   payload: true, fromSync: true });
      onRecordSyncRef.current?.(true, startPosition);
    });

    channel.on('broadcast', { event: 'transport-record-stop' }, ({ payload }) => {
      const { stopPosition } = payload as { stopPosition: number };
      originalDispatch({ type: 'SET_RECORDING', payload: false, fromSync: true });
      originalDispatch({ type: 'SET_PLAYING',   payload: false, fromSync: true });
      onRecordSyncRef.current?.(false, stopPosition);
    });

    // Engineer seek → artist engine jumps to same position
    channel.on('broadcast', { event: 'seek-sync' }, ({ payload }) => {
      onSeekSyncRef.current?.(payload.time as number);
    });

    // Peer sends us a full state-sync blob when they join and already have state
    channel.on('broadcast', { event: 'state-sync' }, ({ payload }) => {
      receivedLiveSyncRef.current = true; // block any in-flight DB fetch from overwriting this
      if (payload.state) {
        const s = payload.state as Partial<DawState>;
        const poolItems = s.poolItems?.map((item: any) => ({
          ...item,
          createdAt: item.createdAt instanceof Date ? item.createdAt : new Date(item.createdAt),
        }));
        originalDispatch({
          type: 'SET_STATE',
          payload: { ...s, ...(poolItems && { poolItems }) },
          fromSync: true,
        });
      }
    });

    // Follow Engineer: engineer broadcasts viewport → artist mirrors it
    channel.on('broadcast', { event: 'viewport-sync' }, ({ payload }) => {
      onViewportSyncRef.current?.(payload.zoom, payload.scrollLeft, payload.scrollTop);
    });

    // Engineer → artist menu commands (open file dialog, open audio settings, etc.)
    channel.on('broadcast', { event: 'remote-op' }, ({ payload }) => {
      onRemoteOpRef.current?.(payload.command as string);
    });

    // Engineer reconnect: peer requests a full snapshot once their channel is ready.
    // Artist responds immediately — no dependency on presence timing.
    channel.on('broadcast', { event: 'request-state-sync' }, () => {
      if (userRole === 'artist') {
        channel.send({
          type: 'broadcast',
          event: 'state-sync',
          payload: { state: syncableState(stateRef.current) },
        }).catch(() => {});
      }
    });

    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.log(`Joined DAW sync channel: daw-${roomCode}`);
        // Engineer: once our channel is confirmed subscribed, ask the artist for their
        // full in-memory state. This fires on first connect AND on every reconnect,
        // guaranteeing the engineer starts with the live project regardless of how long
        // the artist kept working while they were offline.
        if (userRole === 'engineer') {
          channel.send({
            type: 'broadcast',
            event: 'request-state-sync',
            payload: {},
          }).catch(() => {});
        }
      }
    });

    channelRef.current = channel;

    setDispatchMiddleware((action: DawAction) => {
      // 1. Dispatch locally first
      originalDispatch(action);

      // 2. Broadcast if syncable and NOT from the network
      if (!action.fromSync && SYNCABLE_ACTIONS.has(action.type)) {
        // Sanitise ADD_POOL_ITEM / ADD_REGION before broadcasting:
        //   • Strip blob:/file:// audioUrls (only valid on the originating machine).
        //   • Downsample waveform peaks to ≤200 pts — full arrays can be 100 K+ numbers
        //     and will exceed Supabase Realtime's ~256 KB broadcast limit, crashing the
        //     WebSocket connection mid-session.
        let syncAction: DawAction = action;
        if (action.type === 'ADD_POOL_ITEM') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const p = action.payload as unknown as Record<string, unknown>;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          syncAction = { ...action, payload: {
            ...p,
            audioUrl:       typeof p.audioUrl === 'string' && (p.audioUrl.startsWith('blob:') || p.audioUrl.startsWith('file:')) ? '' : p.audioUrl,
            waveformPeaks:  p.waveformPeaks  ? downsamplePeaks(p.waveformPeaks  as number[]) : p.waveformPeaks,
            waveformPeaksR: p.waveformPeaksR ? downsamplePeaks(p.waveformPeaksR as number[]) : p.waveformPeaksR,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any };
        }
        if (action.type === 'ADD_REGION') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const p = action.payload as unknown as Record<string, unknown>;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          syncAction = { ...action, payload: {
            ...p,
            audioUrl:       typeof p.audioUrl === 'string' && (p.audioUrl.startsWith('blob:') || p.audioUrl.startsWith('file:')) ? '' : p.audioUrl,
            localFilePath:  undefined,  // OS path on artist's machine — unusable by engineer
            waveformPeaks:  p.waveformPeaks  ? downsamplePeaks(p.waveformPeaks  as number[]) : p.waveformPeaks,
            waveformPeaksR: p.waveformPeaksR ? downsamplePeaks(p.waveformPeaksR as number[]) : p.waveformPeaksR,
            sourcePeaks:    p.sourcePeaks    ? downsamplePeaks(p.sourcePeaks    as number[]) : p.sourcePeaks,
            sourcePeaksR:   p.sourcePeaksR   ? downsamplePeaks(p.sourcePeaksR   as number[]) : p.sourcePeaksR,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any };
        }
        const broadcastPayload = { ...syncAction, fromSync: true };
        const payloadJson = JSON.stringify(broadcastPayload);
        console.log(`[SYNC 5] Broadcasting ${syncAction.type} — payload size: ${payloadJson.length} bytes`);
        channel.send({
          type: 'broadcast',
          event: 'action',
          payload: broadcastPayload,
        }).catch(err => console.error(`[SYNC ERROR] Broadcast failed for ${syncAction.type}:`, err));
      }
    });

    return () => {
      channel.unsubscribe();
      setDispatchMiddleware(null);
      channelRef.current = null;
    };
  }, [roomCode, originalDispatch, setDispatchMiddleware]);

  // ── Debounced DB Save (saves full transport block now) ──────────
  useEffect(() => {
    if (!roomCode) return;

    const timer = setTimeout(() => {
      const stateToSave = {
        // Use syncableState so peaks are downsampled (200 pts) in the DB too.
        // Avoids bloating the daw_projects row with hundreds of KB of peak data
        // for long sessions.
        ...syncableState(state),
        // Legacy field kept for backwards compat with older saves
        tempo: state.transport.tempo,
      };

      supabase.from('daw_projects').upsert({
        room_code: roomCode,
        state: stateToSave,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'room_code' }).then(({ error }) => {
        if (error) console.error('Failed to save state to DB:', error);
      });
    }, 2000);

    return () => clearTimeout(timer);
  }, [state.projectName, state.tracks, state.regions, state.poolItems, state.transport, roomCode]);

  // Called by DawWorkspace when a peer joins so they receive the live in-memory state
  // immediately rather than waiting for the next DB poll (which can be up to 2s stale).
  const broadcastState = () => {
    channelRef.current?.send({
      type: 'broadcast',
      event: 'state-sync',
      payload: { state: syncableState(stateRef.current) },
    }).catch(() => {});
  };

  const broadcastViewport = useCallback((zoom: number, scrollLeft: number, scrollTop: number) => {
    channelRef.current?.send({
      type: 'broadcast',
      event: 'viewport-sync',
      payload: { zoom, scrollLeft, scrollTop },
    }).catch(() => {});
  }, []);

  const broadcastSeek = useCallback((time: number) => {
    channelRef.current?.send({
      type: 'broadcast',
      event: 'seek-sync',
      payload: { time },
    }).catch(() => {});
  }, []);

  // Transport command broadcasts — each carries position so both sides sync exactly.
  const broadcastPlay = useCallback((startPosition: number) => {
    channelRef.current?.send({
      type: 'broadcast',
      event: 'transport-play',
      payload: { startPosition, timestamp: Date.now() },
    }).catch(() => {});
  }, []);

  const broadcastStop = useCallback((stopPosition: number) => {
    channelRef.current?.send({
      type: 'broadcast',
      event: 'transport-stop',
      payload: { stopPosition },
    }).catch(() => {});
  }, []);

  const broadcastRecord = useCallback((startPosition: number) => {
    channelRef.current?.send({
      type: 'broadcast',
      event: 'transport-record',
      payload: { startPosition, timestamp: Date.now() },
    }).catch(() => {});
  }, []);

  const broadcastStopRecord = useCallback((stopPosition: number) => {
    channelRef.current?.send({
      type: 'broadcast',
      event: 'transport-record-stop',
      payload: { stopPosition },
    }).catch(() => {});
  }, []);

  const broadcastRemoteOp = useCallback((command: string) => {
    channelRef.current?.send({
      type: 'broadcast',
      event: 'remote-op',
      payload: { command },
    }).catch(() => {});
  }, []);

  return { broadcastState, broadcastViewport, broadcastSeek, broadcastPlay, broadcastStop, broadcastRecord, broadcastStopRecord, broadcastRemoteOp };
};
