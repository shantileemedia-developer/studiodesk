import React, { useState, useRef, useEffect } from 'react';
import {
  FileAudio, FolderOpen, Play, Pause, Search,
  Download, Trash2, Mic, Upload, Loader, Archive, CheckCircle, XCircle,
} from 'lucide-react';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { useDaw } from '../../context/DawContext';
import type { PoolItem } from '../../context/DawContext';
import WaveformDisplay from './WaveformDisplay';
import { exportAudioBlob } from '../../utils/audioExporter';
import './MediaPoolPanel.css';

const WORKUPLOAD_URL = 'https://workupload.com/';

const formatDuration = (secs: number): string => {
  if (!secs) return '—';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

const formatDate = (date: Date | string): string => {
  // createdAt arrives as an ISO string when hydrated from the network or DB
  const d   = date instanceof Date ? date : new Date(date);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60000)    return 'Just now';
  if (diff < 3600000)  return `${Math.floor(diff / 60000)}m ago`;
  if (d.toDateString() === now.toDateString())
    return `Today ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  return d.toLocaleDateString();
};

const MediaPoolPanel = ({ onClose }: { onClose?: () => void }) => {
  const { state, dispatch, audioDirHandle, retryUploadRef, userRole } = useDaw();
  const { poolItems, regions } = state;

  const [search,         setSearch]         = useState('');
  const [selectedIds,    setSelectedIds]    = useState<Set<string>>(new Set());
  const [previewingId,   setPreviewingId]   = useState<string | null>(null);
  const [expandedId,     setExpandedId]     = useState<string | null>(null);
  const [exporting,      setExporting]      = useState(false);
  const [exportLabel,    setExportLabel]    = useState('');
  const [workUploadOver, setWorkUploadOver] = useState(false);
  const [lassoStart,     setLassoStart]     = useState<{ x: number, y: number } | null>(null);
  const [lassoCurrent,   setLassoCurrent]   = useState<{ x: number, y: number } | null>(null);
  const [ctxMenu,        setCtxMenu]        = useState<{ id: string; x: number; y: number } | null>(null);

  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const listContainerRef = useRef<HTMLDivElement>(null);

  const filtered = poolItems.filter(p =>
    p.name.toLowerCase().includes(search.toLowerCase())
  );

  // Pool items not referenced by any region (archives excluded from "unused" count)
  const usedUrls    = new Set(regions.map(r => r.audioUrl).filter(Boolean));
  const unusedCount = poolItems.filter(p => !p.isArchive && !usedUrls.has(p.audioUrl)).length;

  // Usage count per audioUrl (for "Used" column)
  const useCount: Record<string, number> = {};
  regions.forEach(r => { if (r.audioUrl) useCount[r.audioUrl] = (useCount[r.audioUrl] ?? 0) + 1; });

  // ── Delete from PC (Supabase Storage + local disk) ───────────────
  const handleDeleteFromPc = async (item: PoolItem) => {
    setCtxMenu(null);
    if (!confirm(`Permanently delete "${item.name}" from disk? This cannot be undone.`)) return;
    dispatch({ type: 'REMOVE_POOL_ITEM', payload: item.id });
    setSelectedIds(prev => { const n = new Set(prev); n.delete(item.id); return n; });
    if (previewingId === item.id) { audioElRef.current?.pause(); setPreviewingId(null); }
    // Remove from Supabase Storage if the URL points to it
    if (item.audioUrl.includes('supabase')) {
      try {
        const url  = new URL(item.audioUrl);
        const path = decodeURIComponent(url.pathname.split('/object/public/audio/')[1] ?? '');
        if (path) {
          const { supabase } = await import('../../lib/supabaseClient');
          await supabase.storage.from('audio').remove([path]);
        }
      } catch (err) { console.warn('Failed to remove from Supabase storage:', err); }
    }
    if (audioDirHandle) {
      try { await (audioDirHandle as any).removeEntry(`${item.name}.webm`); } catch { /* ignore */ }
    }
  };

  const handleItemClick = (e: React.MouseEvent, id: string) => {
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      const next = new Set(selectedIds);
      next.has(id) ? next.delete(id) : next.add(id);
      setSelectedIds(next);
    } else {
      setSelectedIds(new Set([id]));
    }
  };

  const handleLassoDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.pool-item')) return; // let items handle their own clicks
    const rect = listContainerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setLassoStart({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    setLassoCurrent({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
      setSelectedIds(new Set());
    }
  };

  const handleLassoMove = (e: React.MouseEvent) => {
    if (!lassoStart) return;
    const rect = listContainerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    setLassoCurrent(current);

    const minY = Math.min(lassoStart.y, current.y);
    const maxY = Math.max(lassoStart.y, current.y);

    const items = listContainerRef.current?.querySelectorAll('.pool-item') || [];
    const newSelection = new Set<string>();
    items.forEach((item) => {
      const itemRect = item.getBoundingClientRect();
      const relativeTop = itemRect.top - rect.top;
      const relativeBottom = itemRect.bottom - rect.top;
      if (relativeTop < maxY && relativeBottom > minY) {
        const id = item.getAttribute('data-id');
        if (id) newSelection.add(id);
      }
    });

    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      const combined = new Set(selectedIds);
      newSelection.forEach(id => combined.add(id));
      setSelectedIds(combined);
    } else {
      setSelectedIds(newSelection);
    }
  };

  const handleLassoUp = () => {
    setLassoStart(null);
    setLassoCurrent(null);
  };

  const selectAll = () =>
    setSelectedIds(new Set(filtered.filter(p => !p.isArchive).map(p => p.id)));

  // ── Remove Unused ─────────────────────────────────────────────────
  const handleRemoveUnused = async () => {
    const toRemove = poolItems.filter(p => !p.isArchive && !usedUrls.has(p.audioUrl));
    toRemove.forEach(p => dispatch({ type: 'REMOVE_POOL_ITEM', payload: p.id }));
    setSelectedIds(prev => {
      const next = new Set(prev);
      toRemove.forEach(p => next.delete(p.id));
      return next;
    });

    if (audioDirHandle) {
      for (const p of toRemove) {
        try {
          // @ts-ignore
          await audioDirHandle.removeEntry(`${p.name}.webm`);
          console.log(`Deleted ${p.name}.webm from local Audio folder.`);
        } catch (err) {
          console.warn(`Failed to delete ${p.name}.webm locally:`, err);
        }
      }
    }
  };

  // ── Preview ───────────────────────────────────────────────────────
  const handlePreview = (e: React.MouseEvent, id: string, audioUrl: string) => {
    e.stopPropagation();
    if (previewingId === id) {
      audioElRef.current?.pause();
      setPreviewingId(null);
      return;
    }
    if (audioElRef.current) audioElRef.current.pause();
    const audio = new Audio(audioUrl);
    audio.onended = () => setPreviewingId(null);
    audio.play();
    audioElRef.current = audio;
    setPreviewingId(id);
  };

  useEffect(() => () => { audioElRef.current?.pause(); }, []);

  // Close context menu on outside click
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const tid = setTimeout(() => document.addEventListener('mousedown', close), 50);
    return () => { clearTimeout(tid); document.removeEventListener('mousedown', close); };
  }, [ctxMenu]);

  // ── Delete ────────────────────────────────────────────────────────
  const handleDelete = async (e: React.MouseEvent, item: PoolItem) => {
    e.stopPropagation();
    dispatch({ type: 'REMOVE_POOL_ITEM', payload: item.id });
    setSelectedIds(prev => { const n = new Set(prev); n.delete(item.id); return n; });
    if (previewingId === item.id) { audioElRef.current?.pause(); setPreviewingId(null); }

    if (audioDirHandle && !item.isArchive) {
      try {
        // @ts-ignore
        await audioDirHandle.removeEntry(`${item.name}.webm`);
        console.log(`Deleted ${item.name}.webm from local Audio folder.`);
      } catch (err) {
        console.warn(`Failed to delete ${item.name}.webm locally:`, err);
      }
    }
  };

  // ── Export FLAC → ZIP → add to Pool (no auto-download) ────────────
  const handleExport = async () => {
    const toExport = poolItems.filter(p => selectedIds.has(p.id) && !p.isArchive);
    if (!toExport.length) return;

    setExporting(true);
    const zip    = new JSZip();
    const folder = zip.folder('RiddimSync_Export')!;
    let   fmt    = 'flac';

    for (let i = 0; i < toExport.length; i++) {
      const item = toExport[i];
      setExportLabel(`Encoding ${i + 1} / ${toExport.length}  •  ${item.name}`);
      try {
        const res           = await fetch(item.audioUrl);
        const sourceBlob    = await res.blob();
        const { blob, ext } = await exportAudioBlob(sourceBlob);
        fmt = ext;
        folder.file(`${item.name}.${ext}`, blob);
      } catch (err) {
        console.warn('Export failed for', item.name, err);
      }
    }

    setExportLabel('Creating ZIP…');
    const zipBlob = await zip.generateAsync({
      type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 5 },
    });

    // Add ZIP to the pool — user drags it to the WorkUpload button to send
    const zipUrl  = URL.createObjectURL(zipBlob);
    const zipName = `Export_${fmt.toUpperCase()}_${new Date()
      .toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false })
      .replace(':', 'h')}`;

    dispatch({
      type: 'ADD_POOL_ITEM',
      payload: {
        id:            `zip_${Date.now()}`,
        name:          zipName,
        audioUrl:      zipUrl,
        duration:      0,
        createdAt:     new Date(),
        waveformPeaks: [],
        isArchive:     true,
      },
    });

    setExporting(false);
    setExportLabel('');
    setSelectedIds(new Set());
  };

  // ── Direct WAV download — fetches the Supabase public URL as-is ──────────────
  const handleDownloadItem = async (e: React.MouseEvent, item: PoolItem) => {
    e.stopPropagation();
    try {
      const resp = await fetch(item.audioUrl);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      saveAs(blob, `${item.name}.wav`);
    } catch (err) {
      console.error('Download failed:', err);
    }
  };

  // ── Pool item drag ────────────────────────────────────────────────
  const handleItemDragStart = (e: React.DragEvent, id: string) => {
    e.dataTransfer.setData('application/pool-item-id', id);
    e.dataTransfer.effectAllowed = 'copy';
  };

  // ── WorkUpload button drag-drop target ────────────────────────────
  const handleWorkUploadDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('application/pool-item-id')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setWorkUploadOver(true);
  };

  const handleWorkUploadDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setWorkUploadOver(false);
    const id   = e.dataTransfer.getData('application/pool-item-id');
    const item = poolItems.find(p => p.id === id);
    if (!item) return;
    // Save to disk then open WorkUpload
    fetch(item.audioUrl)
      .then(r => r.blob())
      .then(blob => {
        saveAs(blob, item.isArchive ? `${item.name}.zip` : item.name);
        window.open(WORKUPLOAD_URL, '_blank');
      });
  };

  const openWorkUpload = () => window.open(WORKUPLOAD_URL, '_blank');

  const selectedCount = selectedIds.size;
  const totalCount    = poolItems.length;

  return (
    <div className="daw-panel media-pool-panel">
      {/* Header */}
      <div className="daw-panel-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Mic size={12} color="#00ffcc" />
          <span>Media Pool</span>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {selectedCount > 0 && (
            <button
              className="pool-action-btn"
              onClick={handleExport}
              disabled={exporting}
              title={`Export ${selectedCount} file${selectedCount !== 1 ? 's' : ''} as FLAC + ZIP`}
            >
              {exporting ? <Loader size={12} className="spin" /> : <Download size={12} />}
            </button>
          )}
          <FolderOpen size={13} className="pool-icon" />
          {onClose && (
            <button className="panel-close-btn" onClick={onClose} title="Close Media Pool">×</button>
          )}
        </div>
      </div>

      {/* Toolbar */}
      <div className="pool-toolbar">
        <div className="search-bar">
          <Search size={12} color="#808080" />
          <input
            type="text"
            className="search-input"
            placeholder="Search recordings…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        {totalCount > 0 && (
          <button className="select-all-btn" onClick={selectAll} title="Select All">All</button>
        )}
        {unusedCount > 0 && (
          <button
            className="select-all-btn remove-unused-btn"
            onClick={handleRemoveUnused}
            title={`Remove ${unusedCount} unused file${unusedCount !== 1 ? 's' : ''}`}
          >
            -{unusedCount}
          </button>
        )}
      </div>

      {/* Export progress */}
      {exporting && (
        <div className="export-progress">
          <Loader size={11} className="spin" />
          <span>{exportLabel}</span>
        </div>
      )}

      {/* Pool list */}
      <div className="pool-content">
        <div className="pool-list-header">
          <div className="col-name">File Name</div>
          <div className="col-dur">Dur</div>
          <div className="col-date">Time</div>
          <div className="col-used" title="Times used in project">Used</div>
        </div>

        <div 
          className="pool-list-container"
          ref={listContainerRef}
          onMouseDown={handleLassoDown}
          onMouseMove={handleLassoMove}
          onMouseUp={handleLassoUp}
          onMouseLeave={handleLassoUp}
        >
          {lassoStart && lassoCurrent && (
            <div 
              className="lasso-selection-box"
              style={{
                left: Math.min(lassoStart.x, lassoCurrent.x),
                top: Math.min(lassoStart.y, lassoCurrent.y),
                width: Math.abs(lassoCurrent.x - lassoStart.x),
                height: Math.abs(lassoCurrent.y - lassoStart.y),
              }}
            />
          )}
          {filtered.length === 0 ? (
            <div className="pool-empty">
              <Mic size={32} color="#333" />
              <p>No recordings yet</p>
              <p className="pool-empty-hint">Arm a track, then press Record</p>
            </div>
          ) : (
            <div className="pool-list">
              {filtered.map(item => (
                <div key={item.id}>
                  <div
                    className={`pool-item ${selectedIds.has(item.id) ? 'selected' : ''} ${item.isArchive ? 'pool-item-archive' : ''}`}
                    data-id={item.id}
                    draggable
                    onDragStart={e => handleItemDragStart(e, item.id)}
                    onClick={e => { if (!item.isArchive) handleItemClick(e, item.id); }}
                    onDoubleClick={() => {
                      if (item.isArchive) {
                        fetch(item.audioUrl).then(r => r.blob()).then(b => saveAs(b, `${item.name}.zip`));
                      } else {
                        setExpandedId(expandedId === item.id ? null : item.id);
                      }
                    }}
                    onContextMenu={e => { e.preventDefault(); e.stopPropagation(); if (!item.isArchive) setCtxMenu({ id: item.id, x: e.clientX, y: e.clientY }); }}
                    title={item.isArchive
                      ? 'Drag to WorkUpload button · Double-click to save ZIP'
                      : item.name}
                  >
                    <div className="col-name">
                      {item.isArchive
                        ? <Archive size={12} color={selectedIds.has(item.id) ? '#000' : '#ffb84d'} />
                        : <FileAudio size={12} color={selectedIds.has(item.id) ? '#000' : '#00ffcc'} />
                      }
                      <span className="file-name-text">{item.name}</span>
                      {/* Upload status badge */}
                      {!item.isArchive && item.uploadStatus === 'uploading' && (
                        <span title="Uploading…"><Loader size={10} className="spin" style={{ marginLeft: 4, color: '#00ffcc', flexShrink: 0 }} /></span>
                      )}
                      {!item.isArchive && item.uploadStatus === 'done' && (
                        <span title="Uploaded"><CheckCircle size={10} style={{ marginLeft: 4, color: '#4ade80', flexShrink: 0 }} /></span>
                      )}
                      {!item.isArchive && item.uploadStatus === 'failed' && (
                        <span title="Upload failed — use Retry in right-click menu"><XCircle size={10} style={{ marginLeft: 4, color: '#f87171', flexShrink: 0 }} /></span>
                      )}
                    </div>
                    <div className="col-dur">{formatDuration(item.duration)}</div>
                    <div className="col-date">{formatDate(item.createdAt)}</div>
                    <div className="col-used">{!item.isArchive && (useCount[item.audioUrl] ?? 0) > 0 ? useCount[item.audioUrl] : ''}</div>
                    <div className="item-actions">
                      {!item.isArchive && (
                        <button
                          className={`preview-btn ${previewingId === item.id ? 'playing' : ''}`}
                          onClick={e => handlePreview(e, item.id, item.audioUrl)}
                          title={previewingId === item.id ? 'Pause' : 'Preview'}
                        >
                          {previewingId === item.id
                            ? <Pause size={10} fill="currentColor" />
                            : <Play  size={10} fill="currentColor" />}
                        </button>
                      )}
                      {/* Direct WAV download — visible once the Supabase URL is available */}
                      {!item.isArchive && item.uploadStatus === 'done' && (
                        <button
                          className="preview-btn"
                          onClick={e => handleDownloadItem(e, item)}
                          title="Download WAV"
                        >
                          <Download size={10} />
                        </button>
                      )}
                      <button
                        className="delete-btn"
                        onClick={e => handleDelete(e, item)}
                        title="Delete from pool"
                      >
                        <Trash2 size={10} />
                      </button>
                    </div>
                  </div>

                  {!item.isArchive && expandedId === item.id && item.waveformPeaks.length > 0 && (
                    <div className="pool-waveform-row">
                      <WaveformDisplay peaks={item.waveformPeaks} color="#00ffcc" height={40} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Footer stats */}
      <div className="pool-footer">
        <span>{totalCount} file{totalCount !== 1 ? 's' : ''}</span>
        <span>{selectedCount > 0 ? `${selectedCount} selected` : ''}</span>
      </div>

      {/* Right-click context menu */}
      {ctxMenu && (() => {
        const item = poolItems.find(p => p.id === ctxMenu.id);
        if (!item) return null;
        return (
          <div
            className="pool-ctx-menu"
            style={{ left: ctxMenu.x, top: ctxMenu.y }}
            onMouseDown={e => e.stopPropagation()}
          >
            <button className="pool-ctx-item" onClick={e => handlePreview(e, item.id, item.audioUrl)}>
              {previewingId === item.id ? 'Pause Preview' : 'Preview'}
            </button>
            {item.uploadStatus === 'done' && (
              <button className="pool-ctx-item" onClick={e => { handleDownloadItem(e, item); setCtxMenu(null); }}>
                Download WAV
              </button>
            )}
            {item.uploadStatus === 'failed' && userRole === 'artist' && (
              <button className="pool-ctx-item" onClick={() => { retryUploadRef.current?.(item.id); setCtxMenu(null); }}>
                Retry Upload
              </button>
            )}
            <div className="pool-ctx-separator" />
            <button className="pool-ctx-item" onClick={e => { handleDelete(e, item); setCtxMenu(null); }}>
              Delete from Pool
            </button>
            {userRole === 'artist' && (
              <button className="pool-ctx-item danger" onClick={() => handleDeleteFromPc(item)}>
                Delete from PC
              </button>
            )}
          </div>
        );
      })()}

      {/* WorkUpload send button — also a drag-drop target for ZIP pool items */}
      <button
        className={`workupload-btn ${workUploadOver ? 'workupload-drag-over' : ''}`}
        onClick={openWorkUpload}
        onDragOver={handleWorkUploadDragOver}
        onDragLeave={() => setWorkUploadOver(false)}
        onDrop={handleWorkUploadDrop}
        title="Drag a ZIP from pool here to save it and open WorkUpload"
      >
        <Upload size={13} />
        <span>{workUploadOver ? 'Drop to save + open WorkUpload' : 'Send via WorkUpload'}</span>
      </button>
    </div>
  );
};

export default MediaPoolPanel;
