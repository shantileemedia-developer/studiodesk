import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Mic, Volume2, Plus, GripVertical, ChevronDown, Layers } from 'lucide-react';
import { useDaw } from '../../context/DawContext';
import type { PoolItem } from '../../context/DawContext';
import ContextMenu from '../ui/ContextMenu';
import type { ContextMenuItem } from '../ui/ContextMenu';
import { saveToAudioFolder, generatePeaksStereo } from '../../utils/audioUtils';
import './TrackList.css';

interface CtxState { x: number; y: number; trackId: string | null }

const TrackList = () => {
  const { state, dispatch, trackAnalysersRef, audioDirHandle, currentTimeRef } = useDaw();
  const { tracks } = state;

  const selectedId = state.selectedTrackId;
  const setSelectedId = (id: string | null) => dispatch({ type: 'SELECT_TRACK', payload: id });
  const [editingId, setEditingId]       = useState<string | null>(null);
  const [editName, setEditName]         = useState('');
  const [ctx, setCtx]                   = useState<CtxState | null>(null);
  const [openVersionId, setOpenVersionId] = useState<string | null>(null);
  const [editingVersionId, setEditingVersionId] = useState<string | null>(null);
  const [editingVersionTrackId, setEditingVersionTrackId] = useState<string | null>(null);
  const [editVersionName, setEditVersionName] = useState('');

  // Drag state
  const [draggedId, setDraggedId]   = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [dropPosition, setDropPosition] = useState<'above' | 'below'>('below');

  const inputRef = useRef<HTMLInputElement>(null);

  /* ── rename ─────────────────────────────────────────────── */
  const startEdit = useCallback((id: string, name: string) => {
    setEditingId(id);
    setEditName(name);
    setTimeout(() => inputRef.current?.select(), 30);
  }, []);

  const commitEdit = useCallback((id: string) => {
    const trimmed = editName.trim();
    if (trimmed) dispatch({ type: 'RENAME_TRACK', payload: { id, name: trimmed } });
    setEditingId(null);
  }, [editName, dispatch]);

  /* ── toggle M / S / R / Mon ─────────────────────────────── */
  const toggle = (id: string, key: 'isMuted' | 'isSolo' | 'isArmed' | 'isMonitoring') => {
    const track = tracks.find(t => t.id === id);
    if (!track) return;
    dispatch({ type: 'UPDATE_TRACK', payload: { id, updates: { [key]: !track[key] } } });
  };

  /* ── import audio ────────────────────────────────────────── */
  const handleImportToTrack = useCallback((trackId: string) => {
    const track = tracks.find(t => t.id === trackId);
    if (!track) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const url = URL.createObjectURL(file);
      try {
        const actx = new AudioContext();
        const buf = await actx.decodeAudioData(await file.arrayBuffer());
        const { left: peaks, right: rawPeaksR } = await generatePeaksStereo(buf);
        // Mono tracks show a single waveform lane; only pass peaksR for stereo tracks
        const peaksR = track.type === 'stereo' ? rawPeaksR : null;
        const duration = buf.duration;
        await actx.close();
        const poolItem: PoolItem = {
          id: `pool_${Date.now()}`,
          name: file.name.replace(/\.[^.]+$/, ''),
          audioUrl: url,
          localFileName: file.name,
          duration,
          createdAt: new Date(),
          waveformPeaks: peaks,
          waveformPeaksR: peaksR ?? undefined,
        };
        dispatch({ type: 'ADD_POOL_ITEM', payload: poolItem });
        dispatch({
          type: 'ADD_REGION',
          payload: {
            id: `r_${Date.now()}`,
            trackId: track.id,
            versionId: track.activeVersionId,
            startTime: currentTimeRef.current,
            duration,
            name: poolItem.name,
            audioUrl: url,
            waveformPeaks: peaks,
            waveformPeaksR: peaksR ?? undefined,
            sourceDuration: duration,
          },
        });
        if (audioDirHandle) {
          try { await saveToAudioFolder(audioDirHandle, poolItem.name, buf); } catch {}
        }
      } catch { /* decode failed */ }
    };
    input.click();
  }, [tracks, dispatch, audioDirHandle, currentTimeRef]);

  /* ── context menu ────────────────────────────────────────── */
  const openCtx = useCallback((e: React.MouseEvent, trackId: string | null) => {
    e.preventDefault();
    setCtx({ x: e.clientX, y: e.clientY, trackId });
  }, []);

  const buildMenuItems = (trackId: string | null): ContextMenuItem[] => {
    const addItems: ContextMenuItem[] = [
      { label: '＋  Add Mono Audio Track',      onClick: () => dispatch({ type: 'ADD_TRACK', payload: { trackType: 'mono' } }) },
      { label: '＋  Add Playback Track',        onClick: () => dispatch({ type: 'ADD_TRACK', payload: { trackType: 'stereo' } }) },
    ];
    if (!trackId) return addItems;
    const track = tracks.find(t => t.id === trackId);
    if (!track) return addItems;
    const versionItems: ContextMenuItem[] = track.type === 'stereo' ? [
      { label: `＋  New Version  (${track.versions.length})`, onClick: () => dispatch({ type: 'ADD_VERSION', payload: { trackId: track.id } }) },
      { label: '✏  Rename Version', onClick: () => {
        const v = track.versions.find(v => v.id === track.activeVersionId);
        if (v) { setEditingVersionId(v.id); setEditingVersionTrackId(track.id); setEditVersionName(v.name); }
      }},
      { separator: true },
    ] : [];
    return [
      { label: '✏  Rename Track',        onClick: () => startEdit(track.id, track.name) },
      { label: '⬇  Import Audio File…',  onClick: () => handleImportToTrack(track.id) },
      ...versionItems,
      ...addItems,
      { separator: true },
      { label: '✕  Delete Track', danger: true, disabled: tracks.length <= 1,
        onClick: () => dispatch({ type: 'REMOVE_TRACK', payload: track.id }) },
    ];
  };

  /* ── drag-and-drop ───────────────────────────────────────── */
  const handleDragStart = (e: React.DragEvent, id: string) => {
    setDraggedId(id);
    e.dataTransfer.effectAllowed = 'move';
    // Transparent drag image
    const ghost = document.createElement('div');
    ghost.style.cssText = 'position:fixed;top:-200px;opacity:0;';
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 0, 0);
    setTimeout(() => document.body.removeChild(ghost), 0);
  };

  const handleDragOver = (e: React.DragEvent, id: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (id === draggedId) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    setDropTargetId(id);
    setDropPosition(e.clientY < midY ? 'above' : 'below');
  };

  const handleDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (!draggedId || draggedId === targetId) { resetDrag(); return; }

    const arr = [...tracks];
    const fromIdx = arr.findIndex(t => t.id === draggedId);
    const toIdx   = arr.findIndex(t => t.id === targetId);
    if (fromIdx === -1 || toIdx === -1) { resetDrag(); return; }

    const [item] = arr.splice(fromIdx, 1);
    const insertAt = dropPosition === 'above' ? toIdx : toIdx + 1;
    arr.splice(Math.min(insertAt, arr.length), 0, item);

    dispatch({ type: 'REORDER_TRACKS', payload: arr });
    resetDrag();
  };

  const resetDrag = () => {
    setDraggedId(null);
    setDropTargetId(null);
  };

  /* ── live meters ─────────────────────────────────────────── */
  const requestRef = useRef<number>(0);

  useEffect(() => {
    const updateMeters = () => {
      if (!state.transport.isPlaying) {
        state.tracks.forEach(track => {
          const el = document.getElementById(`vol-slider-${track.id}`);
          if (el) {
            // Gradually decay meter to 0
            const current = parseFloat(el.style.getPropertyValue('--meter-level') || '0');
            if (current > 0) {
              el.style.setProperty('--meter-level', `${Math.max(0, current - 5)}%`);
            }
          }
        });
        requestRef.current = requestAnimationFrame(updateMeters);
        return;
      }

      state.tracks.forEach(track => {
        const analyser = trackAnalysersRef.current[track.id];
        let level = 0;
        if (analyser) {
          const data = new Uint8Array(analyser.fftSize);
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) {
            const v = (data[i] / 128) - 1;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / data.length);
          // Scale RMS to 0-100% range, making it visible
          level = Math.min(1, rms * 5) * 100;
        }
        
        const el = document.getElementById(`vol-slider-${track.id}`);
        if (el) {
          // Smooth the meter visually by not letting it drop instantly
          const current = parseFloat(el.style.getPropertyValue('--meter-level') || '0');
          const next = level > current ? level : current - 5;
          el.style.setProperty('--meter-level', `${Math.max(0, next)}%`);
        }
      });
      requestRef.current = requestAnimationFrame(updateMeters);
    };

    requestRef.current = requestAnimationFrame(updateMeters);
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [state.tracks, state.transport.isPlaying, trackAnalysersRef]);

  /* ── render ──────────────────────────────────────────────── */
  return (
    <>
      <div
        className="track-list"
        onContextMenu={e => {
          if (!(e.target as HTMLElement).closest('.track-header')) openCtx(e, null);
        }}
      >
        {/* Ruler spacer — single unified header spanning bar-ruler (36px) + time-ruler (22px) */}
        <div className="track-ruler-spacer">
          <div className="track-ruler-header">
            <span>TRACK LIST</span>
            <button
              className="add-track-btn"
              onClick={() => dispatch({ type: 'ADD_TRACK', payload: { trackType: 'mono' } })}
              title="Add Mono Track"
            ><Plus size={14} /></button>
          </div>
        </div>

        <div className="track-list-content">
          {tracks.map((track, i) => {
            const isDragging   = draggedId === track.id;
            const isDropTarget = dropTargetId === track.id;

            return (
              <div
                key={track.id}
                onDragOver={e => handleDragOver(e, track.id)}
                onDrop={e => handleDrop(e, track.id)}
                onDragEnd={resetDrag}
                className={[
                  'track-header',
                  selectedId === track.id ? 'selected' : '',
                  track.isMuted ? 'is-muted' : '',
                  isDragging ? 'dragging' : '',
                  isDropTarget && dropPosition === 'above' ? 'drop-above' : '',
                  isDropTarget && dropPosition === 'below' ? 'drop-below' : '',
                ].filter(Boolean).join(' ')}
                style={{ height: track.height ?? 80 }}
                onClick={() => { setSelectedId(track.id); setOpenVersionId(null); }}
                onContextMenu={e => { e.stopPropagation(); openCtx(e, track.id); }}
              >
                {/* Drag handle */}
                <div 
                  className="drag-handle" 
                  title="Drag to reorder"
                  draggable
                  onDragStart={e => handleDragStart(e, track.id)}
                >
                  <GripVertical size={12} />
                </div>

                <div className="track-color" style={{ backgroundColor: track.color }} />

                <div className="track-header-main">
                  <div className="track-name-row">
                    <span className="track-number">{i + 1}</span>
                    <span className={`track-type-badge ${track.type}`}>
                      {track.type === 'stereo' ? 'S' : 'M'}
                    </span>

                    {editingId === track.id ? (
                      <input
                        ref={inputRef}
                        className="track-name-input"
                        value={editName}
                        onChange={e => setEditName(e.target.value)}
                        onBlur={() => commitEdit(track.id)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') commitEdit(track.id);
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                        onClick={e => e.stopPropagation()}
                      />
                    ) : (
                      <span
                        className="track-name"
                        title="Click to rename"
                        onClick={e => { e.stopPropagation(); startEdit(track.id, track.name); }}
                      >
                        {track.name}
                      </span>
                    )}
                  </div>

                  <div className="track-controls-row">
                    <button className={`track-btn btn-m ${track.isMuted ? 'active' : ''}`}
                      onClick={e => { e.stopPropagation(); toggle(track.id, 'isMuted'); }} title="Mute">M</button>
                    <button className={`track-btn btn-s ${track.isSolo ? 'active' : ''}`}
                      onClick={e => { e.stopPropagation(); toggle(track.id, 'isSolo'); }} title="Solo">S</button>
                    <button className={`track-btn btn-r ${track.isArmed ? 'active' : ''}`}
                      onClick={e => { e.stopPropagation(); toggle(track.id, 'isArmed'); }} title="Arm">
                      <Mic size={12} /></button>
                    <button className={`track-btn btn-mon ${track.isMonitoring ? 'active' : ''}`}
                      onClick={e => { e.stopPropagation(); toggle(track.id, 'isMonitoring'); }} title="Monitor">
                      <Volume2 size={12} /></button>

                    {/* Version pill — stereo tracks only */}
                    {track.type === 'stereo' && (
                      <div
                        className="track-version-btn"
                        onClick={e => { e.stopPropagation(); setOpenVersionId(openVersionId === track.id ? null : track.id); }}
                        title="Track Versions"
                      >
                        <Layers size={9} />
                        <span>{track.versions.find(v => v.id === track.activeVersionId)?.name.replace('Version ', 'V') ?? 'V1'}</span>
                        <ChevronDown size={9} />
                      </div>
                    )}
                  </div>

                  <div className="track-volume-row" onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
                    <input
                      id={`vol-slider-${track.id}`}
                      type="range"
                      min="0"
                      max="1.5"
                      step="0.01"
                      value={track.volume}
                      onChange={e => dispatch({ type: 'UPDATE_TRACK', payload: { id: track.id, updates: { volume: parseFloat(e.target.value) } } })}
                      className="track-volume-slider"
                      title={`Volume: ${Math.round(track.volume * 100)}%`}
                    />
                  </div>

                  {/* Version dropdown — stereo tracks only */}
                  {track.type === 'stereo' && openVersionId === track.id && (
                    <div className="version-dropdown" onClick={e => e.stopPropagation()}>
                      <div className="version-dropdown-header">Track Versions</div>
                      {track.versions.map(v => (
                        <div
                          key={v.id}
                          className={`version-item ${v.id === track.activeVersionId ? 'active' : ''}`}
                          onClick={() => { dispatch({ type: 'SWITCH_VERSION', payload: { trackId: track.id, versionId: v.id } }); setOpenVersionId(null); }}
                        >
                          <span className="version-item-dot" />
                          {editingVersionId === v.id && editingVersionTrackId === track.id ? (
                            <input
                              autoFocus
                              className="version-rename-input"
                              value={editVersionName}
                              onChange={e => setEditVersionName(e.target.value)}
                              onBlur={() => {
                                const n = editVersionName.trim();
                                if (n) dispatch({ type: 'RENAME_VERSION', payload: { trackId: track.id, versionId: v.id, name: n } });
                                setEditingVersionId(null);
                              }}
                              onKeyDown={e => {
                                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                                if (e.key === 'Escape') { setEditingVersionId(null); }
                                e.stopPropagation();
                              }}
                              onClick={e => e.stopPropagation()}
                            />
                          ) : v.name}
                        </div>
                      ))}
                      <div className="version-item add-version"
                        onClick={() => { dispatch({ type: 'ADD_VERSION', payload: { trackId: track.id } }); setOpenVersionId(null); }}>
                        + New Version
                      </div>
                    </div>
                  )}
                </div>

                {/* Resize Handle */}
                <div 
                  className="track-resize-handle" 
                  onPointerDown={e => {
                    e.preventDefault();
                    e.stopPropagation();
                    const startY = e.clientY;
                    const startHeight = track.height ?? 80;
                    
                    const onPointerMove = (moveEv: PointerEvent) => {
                      const newHeight = Math.max(60, startHeight + (moveEv.clientY - startY));
                      dispatch({ type: 'RESIZE_TRACK', payload: { id: track.id, height: newHeight } });
                    };
                    const onPointerUp = () => {
                      window.removeEventListener('pointermove', onPointerMove);
                      window.removeEventListener('pointerup', onPointerUp);
                    };
                    window.addEventListener('pointermove', onPointerMove);
                    window.addEventListener('pointerup', onPointerUp);
                  }}
                />
              </div>
            );
          })}

          {/* Empty area — right-click to add tracks */}
          <div
            className="track-list-empty"
            onDragOver={e => e.preventDefault()}
            onDrop={e => {
              e.preventDefault();
              if (!draggedId) return;
              const arr = [...tracks];
              const fromIdx = arr.findIndex(t => t.id === draggedId);
              const [item] = arr.splice(fromIdx, 1);
              arr.push(item);
              dispatch({ type: 'REORDER_TRACKS', payload: arr });
              resetDrag();
            }}
            onContextMenu={e => openCtx(e, null)}
          />
        </div>
      </div>

      {ctx && (
        <ContextMenu
          x={ctx.x} y={ctx.y}
          items={buildMenuItems(ctx.trackId)}
          onClose={() => setCtx(null)}
        />
      )}
    </>
  );
};

export default TrackList;
