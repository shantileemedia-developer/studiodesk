import React, { useRef, useEffect, useCallback, useState } from 'react';
import { ZoomIn, ZoomOut, MousePointer2, Crosshair, Scissors, Combine, Eraser, VolumeX, Pencil } from 'lucide-react';
import { useDaw } from '../../context/DawContext';
import type { ActiveTool, Region, PoolItem } from '../../context/DawContext';
import WaveformDisplay from './WaveformDisplay';
import { generatePeaksStereo, uploadAudioToSupabase, saveToAudioFolder } from '../../utils/audioUtils';
import './ArrangeWindow.css';

const BASE_PX_PER_SEC = 100;
const MIN_ZOOM        = 0.1;
const MAX_ZOOM        = 8;
const ZOOM_STEP       = 1.25;

// ── Custom SVG cursors ───────────────────────────────────────────────
const svgCursor = (svg: string, hx: number, hy: number) =>
  `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hx} ${hy}, auto`;

const TOOL_CURSORS: Record<ActiveTool, string> = {
  select: 'default',
  range:  'crosshair',
  draw: svgCursor(
    `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`,
    2, 18
  ),
  erase: svgCursor(
    `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg>`,
    4, 16
  ),
  split: svgCursor(
    `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>`,
    6, 6
  ),
  render: svgCursor(
    `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 3a3 3 0 0 1 0 6h-6a3 3 0 0 1 0-6z"/><path d="M6 9H4a2 2 0 0 0-2 2v10c0 1.1.9 2 2 2h10a2 2 0 0 0 2-2v-2"/></svg>`,
    4, 4
  ),
  mute: svgCursor(
    `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>`,
    10, 10
  ),
  zoom: 'zoom-in',
};

const MINI_TOOLS: { id: ActiveTool; label: string; icon: React.ReactNode }[] = [
  { id: 'select', label: 'Select [1]',  icon: <MousePointer2 size={15} /> },
  { id: 'range',  label: 'Range [2]',   icon: <Crosshair size={15} /> },
  { id: 'split',  label: 'Split [3]',   icon: <Scissors size={15} /> },
  { id: 'render', label: 'Render [4]',  icon: <Combine size={15} /> },
  { id: 'erase',  label: 'Erase [5]',   icon: <Eraser size={15} /> },
  { id: 'zoom',   label: 'Zoom [6]',    icon: <ZoomIn size={15} /> },
  { id: 'mute',   label: 'Mute [7]',    icon: <VolumeX size={15} /> },
  { id: 'draw',   label: 'Draw [8]',    icon: <Pencil size={15} /> },
];

function toBars(seconds: number, tempo: number) {
  const beats = seconds * (tempo / 60);
  const bar   = Math.floor(beats / 4) + 1;
  const beat  = Math.floor(beats % 4) + 1;
  return `${bar}.${beat}`;
}

// ── Component ────────────────────────────────────────────────────────
const ArrangeWindow = () => {
  const { state, dispatch, currentTimeRef, recordingStartTimeRef, livePeaksRef, audioDirHandle } = useDaw();
  const { tracks, regions, activeTool, selectedRegionId, markers } = state;
  const { tempo, isLooping, loopStart, loopEnd, punchIn, punchOut } = state.transport;

  const [zoom, setZoom]           = useState(1);
  const pxPerSec                  = BASE_PX_PER_SEC * zoom;
  const pxPerSecRef               = useRef(pxPerSec);
  pxPerSecRef.current             = pxPerSec;

  const isPlayingRef              = useRef(state.transport.isPlaying);
  isPlayingRef.current            = state.transport.isPlaying;

  const isRecordingRef            = useRef(state.transport.isRecording);
  isRecordingRef.current          = state.transport.isRecording;

  // Live recording region refs — updated via RAF (no React re-renders)
  const liveRegionRef             = useRef<HTMLDivElement>(null);
  const liveCanvasRef             = useRef<HTMLCanvasElement>(null);
  const lastPeakCountRef          = useRef(0);

  // ── Snap helpers ─────────────────────────────────────────────────
  const snapStateRef = useRef({ on: state.snapOn, value: state.snapValue, tempo });
  snapStateRef.current = { on: state.snapOn, value: state.snapValue, tempo };

  const applySnap = (t: number): number => {
    const { on, value, tempo: bpm } = snapStateRef.current;
    if (!on || value === 'Off') return t;
    const den = parseInt(value.split('/')[1], 10);
    const snapSec = 240 / bpm / den;
    return Math.round(t / snapSec) * snapSec;
  };
  const applySnapRef = useRef(applySnap);
  applySnapRef.current = applySnap;

  // State ref mirrors for use in closures that can't take React deps
  const stateRef  = useRef(state);
  stateRef.current = state;
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const regionsRef = useRef(regions);
  regionsRef.current = regions;

  // Reset live waveform state each time recording starts
  useEffect(() => {
    if (state.transport.isRecording) {
      lastPeakCountRef.current = 0;
    }
  }, [state.transport.isRecording]);

  // ── Pending scroll for anchor-based zoom ─────────────────────────
  const pendingScrollRef = useRef<number | null>(null);

  // Mini toolbox
  const [miniMenu, setMiniMenu]   = useState<{ x: number; y: number } | null>(null);
  const miniMenuRef               = useRef<HTMLDivElement>(null);

  // Split preview
  const [splitPreview, setSplitPreview] = useState<{ regionId: string; x: number } | null>(null);

  // Range selection
  const [rangeBox, setRangeBox]   = useState<{ left: number; width: number } | null>(null);
  const rangeStartRef             = useRef<{ x: number } | null>(null);

  // Drag-to-move (select tool) — extended for axis-constrained + cross-track drag
  type DragState = {
    regionId: string;
    origStart: number;
    origTrackId: string;
    origTrackIdx: number;
    mouseX: number;
    mouseY: number;
    axis: 'h' | 'v' | null;
  };
  const dragRef                         = useRef<DragState | null>(null);
  const dragPosRef                      = useRef(0);
  const [draggingId, setDraggingId]     = useState<string | null>(null);
  const [dragPreviewStart, setDragPreviewStart] = useState(0);
  const [dragTargetTrackId, setDragTargetTrackId] = useState<string | null>(null);
  const dragTargetTrackIdRef            = useRef<string | null>(null);

  // File-drag ghost preview
  const [fileGhost, setFileGhost] = useState<{
    trackIdx: number;
    startTime: number;
    fileName: string;
  } | null>(null);
  const fileGhostRef = useRef(fileGhost);
  fileGhostRef.current = fileGhost;

  const contentScrollRef  = useRef<HTMLDivElement>(null);
  const rulerInnerRef     = useRef<HTMLDivElement>(null);
  const timeRulerInnerRef = useRef<HTMLDivElement>(null);
  const playheadRulerRef  = useRef<HTMLDivElement>(null);
  const playheadLineRef   = useRef<HTMLDivElement>(null);
  const rafRef            = useRef<number | null>(null);
  const zoomRef           = useRef(zoom);
  zoomRef.current         = zoom;

  // Track height helpers
  const getTrackTop = useCallback((idx: number) => {
    let top = 0;
    for (let i = 0; i < idx && i < tracks.length; i++) top += tracks[i].height ?? 80;
    return top;
  }, [tracks]);

  const totalTracksHeight = tracks.reduce((sum, t) => sum + (t.height ?? 80), 0);

  // ── Anchor-based zoom ────────────────────────────────────────────
  const zoomIn = useCallback((anchorTime?: number) => {
    const sl = contentScrollRef.current?.scrollLeft ?? 0;
    setZoom(z => {
      const newZ = Math.min(MAX_ZOOM, z * ZOOM_STEP);
      if (anchorTime !== undefined) {
        const anchorScreenX = anchorTime * z * BASE_PX_PER_SEC - sl;
        pendingScrollRef.current = Math.max(0, anchorTime * newZ * BASE_PX_PER_SEC - anchorScreenX);
      }
      return newZ;
    });
  }, []);

  const zoomOut = useCallback((anchorTime?: number) => {
    const sl = contentScrollRef.current?.scrollLeft ?? 0;
    setZoom(z => {
      const newZ = Math.max(MIN_ZOOM, z / ZOOM_STEP);
      if (anchorTime !== undefined) {
        const anchorScreenX = anchorTime * z * BASE_PX_PER_SEC - sl;
        pendingScrollRef.current = Math.max(0, anchorTime * newZ * BASE_PX_PER_SEC - anchorScreenX);
      }
      return newZ;
    });
  }, []);

  // Apply the pending scroll the frame after zoom state settles
  useEffect(() => {
    if (pendingScrollRef.current !== null && contentScrollRef.current) {
      contentScrollRef.current.scrollLeft = pendingScrollRef.current;
      pendingScrollRef.current = null;
    }
  }, [zoom]);

  const totalDuration = Math.max(180, ...regions.map(r => r.startTime + r.duration + 30));
  const totalWidth    = totalDuration * pxPerSec;
  const secondsPerBar = (60 / tempo) * 4;
  const markerCount   = Math.ceil(totalDuration / secondsPerBar) + 1;

  // ── Time ruler: pick a "nice" interval that keeps ticks ≥60px apart
  const NICE_TIME_INTERVALS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const timeInterval  = NICE_TIME_INTERVALS.find(v => v * pxPerSec >= 60) ?? 600;
  const timeTickCount = Math.ceil(totalDuration / timeInterval) + 1;

  const formatTimeTick = (secs: number): string => {
    if (secs === 0) return '0';
    if (secs < 1)  return `${secs.toFixed(1)}`;
    if (secs < 60) return `${secs}s`;
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return s === 0 ? `${m}m` : `${m}:${String(s).padStart(2, '0')}`;
  };

  const handleContentScroll = useCallback(() => {
    const sl = contentScrollRef.current?.scrollLeft ?? 0;
    if (rulerInnerRef.current)     rulerInnerRef.current.style.transform     = `translateX(-${sl}px)`;
    if (timeRulerInnerRef.current) timeRulerInnerRef.current.style.transform = `translateX(-${sl}px)`;
  }, []);

  // ── Keyboard shortcuts ────────────────────────────────────────────
  // G/H zoom anchored to playhead; Shift+G/H = track height; B = bounce; number keys switch tools
  useEffect(() => {
    const toolMap: Record<string, ActiveTool> = {
      '1':'select','2':'range','3':'split','4':'render','5':'erase','6':'zoom','7':'mute','8':'draw',
    };
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      // Ctrl+A: select all audio clips, prevent browser text-selection
      if ((e.key === 'a' || e.key === 'A') && e.ctrlKey) {
        e.preventDefault();
        const allRegions = stateRef.current.regions;
        if (allRegions.length > 0) {
          dispatch({ type: 'SELECT_REGION', payload: allRegions[0].id });
        }
        return;
      }

      if (e.key === 'h' || e.key === 'H') {
        if (e.shiftKey) {
          const selId = stateRef.current.selectedTrackId;
          if (selId) {
            const t = tracksRef.current.find(tk => tk.id === selId);
            dispatch({ type: 'RESIZE_TRACK', payload: { id: selId, height: Math.min(300, (t?.height ?? 80) + 20) } });
          }
        } else {
          zoomIn(currentTimeRef.current);
        }
        return;
      }
      if (e.key === 'g' || e.key === 'G') {
        if (e.shiftKey) {
          const selId = stateRef.current.selectedTrackId;
          if (selId) {
            const t = tracksRef.current.find(tk => tk.id === selId);
            dispatch({ type: 'RESIZE_TRACK', payload: { id: selId, height: Math.max(40, (t?.height ?? 80) - 20) } });
          }
        } else {
          zoomOut(currentTimeRef.current);
        }
        return;
      }

      // B = Bounce selected region (skip if stereo track — DawWorkspace handles version switch for B there)
      if ((e.key === 'b' || e.key === 'B') && !e.shiftKey) {
        const selTrack = tracksRef.current.find(tk => tk.id === stateRef.current.selectedTrackId);
        if (selTrack?.type !== 'stereo') {
          const regionId = stateRef.current.selectedRegionId;
          const region   = regionsRef.current.find(r => r.id === regionId);
          if (region?.audioUrl) {
            void (async () => {
              try {
                const res   = await fetch(region.audioUrl);
                const ab    = await res.arrayBuffer();
                const ctx2  = new AudioContext();
                const buf   = await ctx2.decodeAudioData(ab.slice(0));
                const { left: peaks, right: peaksR } = await generatePeaksStereo(buf);
                ctx2.close();
                const blobNew     = new Blob([ab], { type: 'audio/webm' });
                const bounceName  = `Bounce_${region.name}`;
                const newUrl      = await uploadAudioToSupabase(blobNew, `${bounceName}_${Date.now()}.webm`);
                const stamp       = Date.now();
                const newPoolItem: PoolItem = { id: `pool_bnc_${stamp}`, name: bounceName, audioUrl: newUrl, duration: region.duration, createdAt: new Date(), waveformPeaks: peaks, waveformPeaksR: peaksR };
                const newRegion: Region = { ...region, id: `region_bnc_${stamp}`, name: bounceName, audioUrl: newUrl, waveformPeaks: peaks, waveformPeaksR: peaksR };
                dispatch({ type: 'BOUNCE_REGIONS', payload: { regionIds: [region.id], newRegion, newPoolItem } });
              } catch (err) { console.error('Bounce failed', err); }
            })();
          }
          return;
        }
      }

      if (toolMap[e.key]) dispatch({ type: 'SET_TOOL', payload: toolMap[e.key] });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomIn, zoomOut, dispatch, currentTimeRef]);

  // Ctrl+Scroll zoom anchored to mouse cursor position
  useEffect(() => {
    const el = contentScrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const anchorTime = (mouseX + el.scrollLeft) / pxPerSecRef.current;
      e.deltaY < 0 ? zoomIn(anchorTime) : zoomOut(anchorTime);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomIn, zoomOut]);

  // Playhead RAF + Cubase-style auto-scroll during playback
  useEffect(() => {
    const drawLivePeaks = (canvas: HTMLCanvasElement, peaks: number[], regionW: number) => {
      const h = 44;
      const w = Math.max(1, Math.ceil(regionW));
      if (canvas.width !== w)  canvas.width  = w;
      if (canvas.height !== h) canvas.height = h;
      const ctx2d = canvas.getContext('2d');
      if (!ctx2d || peaks.length === 0) return;
      ctx2d.clearRect(0, 0, w, h);
      ctx2d.fillStyle = 'rgba(255, 130, 130, 0.9)';
      const pxPerPeak = w / peaks.length;
      const mid = h / 2;
      peaks.forEach((peak, i) => {
        const barH = Math.max(1, peak * h * 0.85);
        ctx2d.fillRect(i * pxPerPeak, mid - barH / 2, Math.max(1, pxPerPeak - 0.5), barH);
      });
    };

    const tick = () => {
      const x = currentTimeRef.current * zoomRef.current * BASE_PX_PER_SEC;
      if (playheadRulerRef.current) playheadRulerRef.current.style.left = `${x}px`;
      if (playheadLineRef.current)  playheadLineRef.current.style.left  = `${x}px`;

      if (isPlayingRef.current && contentScrollRef.current) {
        const el = contentScrollRef.current;
        const sl = el.scrollLeft;
        const vw = el.clientWidth;
        if (x > sl + vw - 80 || x < sl) {
          el.scrollLeft = Math.max(0, x - 60);
        }
      }

      if (isRecordingRef.current && liveRegionRef.current) {
        const duration = Math.max(0, currentTimeRef.current - recordingStartTimeRef.current);
        const regionW = Math.max(4, duration * zoomRef.current * BASE_PX_PER_SEC);
        liveRegionRef.current.style.width = `${regionW}px`;

        const peaks = livePeaksRef.current;
        if (peaks.length !== lastPeakCountRef.current && liveCanvasRef.current) {
          lastPeakCountRef.current = peaks.length;
          drawLivePeaks(liveCanvasRef.current, peaks, regionW);
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [currentTimeRef, recordingStartTimeRef, livePeaksRef]);

  // Return-to-zero: scroll view back to the start when transport stops at 0
  useEffect(() => {
    if (!state.transport.isPlaying && state.transport.currentTime === 0) {
      if (contentScrollRef.current) contentScrollRef.current.scrollLeft = 0;
    }
  }, [state.transport.isPlaying]);

  // Close mini menu on outside click
  useEffect(() => {
    if (!miniMenu) return;
    const h = (e: MouseEvent) => {
      if (miniMenuRef.current && !miniMenuRef.current.contains(e.target as Node))
        setMiniMenu(null);
    };
    const tid = setTimeout(() => document.addEventListener('mousedown', h), 80);
    return () => { clearTimeout(tid); document.removeEventListener('mousedown', h); };
  }, [miniMenu]);

  // ── Axis-constrained drag-to-move ───────────────────────────────
  useEffect(() => {
    if (!draggingId) return;

    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = Math.abs(e.clientX - dragRef.current.mouseX);
      const dy = Math.abs(e.clientY - dragRef.current.mouseY);

      // Lock axis after 5px threshold
      if (!dragRef.current.axis && (dx > 5 || dy > 5)) {
        dragRef.current.axis = dx >= dy ? 'h' : 'v';
      }

      if (dragRef.current.axis === 'h') {
        const rawStart = Math.max(0, dragRef.current.origStart + (e.clientX - dragRef.current.mouseX) / pxPerSecRef.current);
        const newStart = applySnapRef.current(rawStart);
        dragPosRef.current = newStart;
        setDragPreviewStart(newStart);
      } else if (dragRef.current.axis === 'v') {
        const contentEl = contentScrollRef.current;
        if (!contentEl) return;
        const rect = contentEl.getBoundingClientRect();
        const relY  = e.clientY - rect.top;

        let top = 0;
        let targetIdx = tracksRef.current.length; // beyond last = new track
        for (let i = 0; i < tracksRef.current.length; i++) {
          const h = tracksRef.current[i].height ?? 80;
          if (relY >= top && relY < top + h) { targetIdx = i; break; }
          top += h;
        }
        const targetId = targetIdx < tracksRef.current.length
          ? tracksRef.current[targetIdx].id
          : '__new__';
        dragTargetTrackIdRef.current = targetId;
        setDragTargetTrackId(targetId);
      }
    };

    const onUp = () => {
      if (dragRef.current) {
        const { regionId, axis, origTrackId } = dragRef.current;
        if (axis === 'h') {
          dispatch({ type: 'MOVE_REGION', payload: { regionId, startTime: dragPosRef.current } });
        } else if (axis === 'v') {
          const targetId = dragTargetTrackIdRef.current;
          if (targetId && targetId !== origTrackId) {
            if (targetId === '__new__') {
              dispatch({ type: 'ADD_TRACK_AND_MOVE_REGION', payload: { regionId } });
            } else {
              dispatch({ type: 'MOVE_REGION', payload: { regionId, trackId: targetId } });
            }
          }
        }
      }
      dragRef.current = null;
      dragTargetTrackIdRef.current = null;
      setDraggingId(null);
      setDragTargetTrackId(null);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [draggingId, dispatch]);

  // Ruler click → seek
  const handleRulerClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const sl = contentScrollRef.current?.scrollLeft ?? 0;
    const t  = Math.max(0, (e.clientX - rect.left + sl) / pxPerSec);
    currentTimeRef.current = t;
    dispatch({ type: 'SET_CURRENT_TIME', payload: t });
  }, [currentTimeRef, dispatch, pxPerSec]);

  // Right-click → mini toolbox
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setMiniMenu({ x: e.clientX, y: e.clientY });
  };

  // ── Region interactions ──────────────────────────────────────────
  const handleRegionMouseDown = (e: React.MouseEvent, region: Region) => {
    if (e.button !== 0) return;
    e.stopPropagation();

    switch (activeTool) {
      case 'select': {
        e.preventDefault();
        dispatch({ type: 'SELECT_REGION', payload: region.id });
        const regionTrackIdx = tracks.findIndex(t => t.id === region.trackId);
        dragRef.current = {
          regionId: region.id,
          origStart: region.startTime,
          origTrackId: region.trackId,
          origTrackIdx: regionTrackIdx,
          mouseX: e.clientX,
          mouseY: e.clientY,
          axis: null,
        };
        dragPosRef.current = region.startTime;
        setDraggingId(region.id);
        setDragPreviewStart(region.startTime);
        break;
      }
      case 'split': {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const rawTime = region.startTime + (e.clientX - rect.left) / pxPerSec;
        const splitTime = applySnap(rawTime);
        dispatch({ type: 'SPLIT_REGION', payload: { regionId: region.id, splitTime } });
        setSplitPreview(null);
        break;
      }
      case 'erase':
        dispatch({ type: 'REMOVE_REGION', payload: region.id });
        if (selectedRegionId === region.id) dispatch({ type: 'SELECT_REGION', payload: null });
        break;
      case 'mute':
        dispatch({ type: 'TOGGLE_REGION_MUTE', payload: region.id });
        break;
      case 'render':
        dispatch({ type: 'RENDER_REGIONS', payload: region.id });
        break;
      default:
        break;
    }
  };

  // Split preview line tracks the snapped position
  const handleRegionMouseMove = (e: React.MouseEvent, region: Region) => {
    if (activeTool !== 'split') { if (splitPreview) setSplitPreview(null); return; }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const rawTime = region.startTime + (e.clientX - rect.left) / pxPerSec;
    const snappedTime = applySnap(rawTime);
    const snappedX = (snappedTime - region.startTime) * pxPerSec;
    setSplitPreview({ regionId: region.id, x: snappedX });
  };

  // ── Track empty-space click ──────────────────────────────────────
  const handleTrackMouseDown = (e: React.MouseEvent, track: (typeof tracks)[0]) => {
    if (e.button !== 0) return;
    if (activeTool === 'select') dispatch({ type: 'SELECT_REGION', payload: null });
    if (activeTool === 'draw') {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const sl = contentScrollRef.current?.scrollLeft ?? 0;
      const rawTime = Math.max(0, (e.clientX - rect.left + sl) / pxPerSec);
      const startTime = applySnap(rawTime);
      dispatch({
        type: 'ADD_REGION',
        payload: {
          id: `region_draw_${Date.now()}`,
          trackId: track.id,
          versionId: track.activeVersionId,
          startTime,
          duration: secondsPerBar,
          name: 'Empty',
          audioUrl: '',
          waveformPeaks: [],
        },
      });
    }
    if (activeTool === 'zoom') e.shiftKey ? zoomOut(currentTimeRef.current) : zoomIn(currentTimeRef.current);
    if (activeTool === 'range') {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const sl = contentScrollRef.current?.scrollLeft ?? 0;
      rangeStartRef.current = { x: e.clientX - rect.left + sl };
      setRangeBox(null);
    }
  };

  // ── File drag ghost ──────────────────────────────────────────────
  const getDropCoords = (e: React.DragEvent) => {
    const el   = contentScrollRef.current;
    const rect = el?.getBoundingClientRect() ?? { left: 0, top: 0 };
    const sl   = el?.scrollLeft ?? 0;
    const x    = e.clientX - (rect as DOMRect).left + sl;
    const startTime = Math.max(0, x / pxPerSec);

    // Use elementFromPoint so the browser's own hit-test picks the track row,
    // avoiding any rect/coordinate mismatch in Electron.
    const hit  = document.elementFromPoint(e.clientX, e.clientY);
    const row  = hit?.closest?.('.arrange-track');
    if (row && el) {
      const rows = el.querySelectorAll('.arrange-track');
      const idx  = Array.from(rows).indexOf(row as HTMLElement);
      if (idx !== -1) return { trackIdx: idx, startTime };
    }

    // Fallback: clamp to last track
    return { trackIdx: Math.max(0, tracks.length - 1), startTime };
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';

    const { trackIdx, startTime: rawTime } = getDropCoords(e);
    const startTime = applySnap(rawTime);

    let fileName = 'Audio File';
    if (e.dataTransfer.items.length > 0) {
      const item = e.dataTransfer.items[0];
      const f = item.getAsFile?.();
      if (f?.name) fileName = f.name.replace(/\.[^.]+$/, '');
    }

    setFileGhost({ trackIdx, startTime, fileName });
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setFileGhost(null);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const ghost = fileGhostRef.current;
    setFileGhost(null);

    const files = Array.from(e.dataTransfer.files).filter(f =>
      f.type.startsWith('audio/') || /\.(wav|mp3|ogg|flac|aac|m4a|aif{1,2})$/i.test(f.name)
    );
    if (!files.length) return;

    const { trackIdx, startTime } = ghost ?? getDropCoords(e);
    const target = tracks[trackIdx];
    if (!target) return;

    for (const file of files) {
      try {
        const ab       = await file.arrayBuffer();
        const audioCtx = new AudioContext();
        const buf      = await audioCtx.decodeAudioData(ab.slice(0));
        audioCtx.close();
        const { left: peaks, right: peaksR } = await generatePeaksStereo(buf);
        const name     = file.name.replace(/\.[^.]+$/, '');

        // Use blob URL immediately — no network wait
        const audioUrl   = URL.createObjectURL(file);
        const poolItemId = `pool_${Date.now()}`;

        dispatch({ type: 'ADD_POOL_ITEM', payload: { id: poolItemId, name, audioUrl, localFileName: file.name, duration: buf.duration, createdAt: new Date(), waveformPeaks: peaks, waveformPeaksR: peaksR } });
        dispatch({ type: 'ADD_REGION',    payload: { id: `region_${Date.now()}`, trackId: target.id, versionId: target.activeVersionId, startTime, duration: buf.duration, name, audioUrl, waveformPeaks: peaks, waveformPeaksR: peaksR } });

        // Save as 24-bit WAV into the project's Audio/ folder
        if (audioDirHandle) {
          try {
            await saveToAudioFolder(audioDirHandle, name, buf);
          } catch (err) { console.error('Audio folder save failed:', err); }
        }

        // Upload to Supabase in the background and swap in the permanent URL
        uploadAudioToSupabase(file, file.name).then(supabaseUrl => {
          if (supabaseUrl && supabaseUrl !== audioUrl)
            dispatch({ type: 'UPDATE_AUDIO_URLS', payload: { poolItemId, audioUrl: supabaseUrl } });
        }).catch(() => {});
      } catch { /* skip undecodable */ }
    }
  };

  // ── Multi-level grid (Cubase-style: bar > beat > snap subdivision) ──
  const barPx  = secondsPerBar * pxPerSec;
  const beatPx = (60 / tempo) * pxPerSec;
  const snapSec = state.snapOn && state.snapValue !== 'Off'
    ? 240 / tempo / parseInt(state.snapValue.split('/')[1], 10)
    : 0;
  const snapGridPx = snapSec * pxPerSec;

  const gridImages: string[] = [];
  const gridSizes:  string[] = [];
  gridImages.push('linear-gradient(to right, rgba(255,255,255,0.1) 1px, transparent 1px)');
  gridSizes.push(`${barPx}px 100%`);
  if (beatPx < barPx * 0.99 && beatPx >= 4) {
    gridImages.push('linear-gradient(to right, rgba(255,255,255,0.045) 1px, transparent 1px)');
    gridSizes.push(`${beatPx}px 100%`);
  }
  if (snapGridPx > 0 && snapGridPx < beatPx * 0.99 && snapGridPx >= 3) {
    gridImages.push('linear-gradient(to right, rgba(255,255,255,0.022) 1px, transparent 1px)');
    gridSizes.push(`${snapGridPx}px 100%`);
  }
  const gridStyle = {
    backgroundImage: gridImages.join(', '),
    backgroundSize:  gridSizes.join(', '),
    width: totalWidth,
  };

  // The region being dragged (for vertical ghost preview)
  const draggedRegion = draggingId ? regions.find(r => r.id === draggingId) : null;

  return (
    <div className="arrange-window">
      {/* Bar / beat ruler */}
      <div className="timeline-ruler bar-ruler" onClick={handleRulerClick} onDoubleClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const sl = contentScrollRef.current?.scrollLeft ?? 0;
        const rawTime = Math.max(0, (e.clientX - rect.left + sl) / pxPerSec);
        dispatch({ type: 'ADD_MARKER', payload: { id: `marker_${Date.now()}`, time: applySnap(rawTime), name: 'Marker' } });
      }}>
        <div ref={rulerInnerRef} style={{ width: totalWidth, position: 'relative', height: '100%' }}>
          {Array.from({ length: markerCount }, (_, i) => {
            const barX    = i * secondsPerBar * pxPerSec;
            const beatPx2 = (60 / tempo) * pxPerSec;
            const beatsPerBar = 4;
            return (
              <div key={i} className="ruler-bar-group" style={{ left: barX, width: secondsPerBar * pxPerSec }}>
                <div className="ruler-bar-line" />
                <span className="ruler-bar-label">{i + 1}</span>
                {beatPx2 >= 8 && Array.from({ length: beatsPerBar - 1 }, (_, b) => {
                  const beatOffset = (b + 1) * beatPx2;
                  const isHalf     = (b + 1) === beatsPerBar / 2;
                  return (
                    <div
                      key={b}
                      className={`ruler-beat-tick ${isHalf ? 'half' : ''}`}
                      style={{ left: beatOffset }}
                    />
                  );
                })}
              </div>
            );
          })}

          {/* Markers */}
          {markers.map(m => (
            <div key={m.id} className="marker-flag" style={{ left: m.time * pxPerSec, top: 0, position: 'absolute' }}>
              <span className="marker-name" onClick={(e) => {
                e.stopPropagation();
                const newName = prompt('Enter marker name:', m.name);
                if (newName) dispatch({ type: 'RENAME_MARKER', payload: { id: m.id, name: newName } });
              }}>{m.name}</span>
            </div>
          ))}

          <div ref={playheadRulerRef} className="playhead-marker" style={{ left: 0 }}>
            <div className="playhead-triangle" />
          </div>
        </div>
      </div>

      {/* Seconds / Time ruler */}
      <div className="timeline-ruler time-ruler" onClick={handleRulerClick}>
        <div ref={timeRulerInnerRef} style={{ width: totalWidth, position: 'relative', height: '100%' }}>
          {Array.from({ length: timeTickCount }, (_, i) => {
            const timeSec = i * timeInterval;
            const x = timeSec * pxPerSec;
            const isMinute = timeSec > 0 && timeSec % 60 === 0;
            return (
              <div key={i} className={`time-tick ${isMinute ? 'time-tick-minute' : ''}`} style={{ left: x }}>
                <span className="time-tick-label">{formatTimeTick(timeSec)}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Scrollable content */}
      <div
        className="arrange-content"
        ref={contentScrollRef}
        onScroll={handleContentScroll}
        onContextMenu={handleContextMenu}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        style={{ cursor: TOOL_CURSORS[activeTool] }}
      >
        <div style={{ width: totalWidth, position: 'relative', minHeight: totalTracksHeight }}>
          <div ref={playheadLineRef} className="playhead-line" style={{ left: 0 }} />
          <div className="grid-background" style={gridStyle} />

          {/* Range selection box */}
          {rangeBox && (
            <div className="range-selection-box" style={{ left: rangeBox.left, width: rangeBox.width, height: totalTracksHeight }} />
          )}

          {/* Loop / Punch Overlays */}
          {isLooping && (
            <div className="loop-overlay" style={{ left: loopStart * pxPerSec, width: Math.max(2, (loopEnd - loopStart) * pxPerSec), height: totalTracksHeight }}>
              <div className="loop-overlay-header">
                <div className="loop-handle left" onPointerDown={e => {
                  e.stopPropagation();
                  const startX = e.clientX;
                  const initVal = loopStart;
                  const onMove = (moveEv: PointerEvent) => {
                    const diff = (moveEv.clientX - startX) / pxPerSec;
                    dispatch({ type: 'SET_LOOP_RANGE', payload: { start: Math.max(0, applySnap(initVal + diff)), end: loopEnd } });
                  };
                  const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
                  window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
                }} />
                <div className="loop-handle right" onPointerDown={e => {
                  e.stopPropagation();
                  const startX = e.clientX;
                  const initVal = loopEnd;
                  const onMove = (moveEv: PointerEvent) => {
                    const diff = (moveEv.clientX - startX) / pxPerSec;
                    dispatch({ type: 'SET_LOOP_RANGE', payload: { start: loopStart, end: Math.max(loopStart + 0.1, applySnap(initVal + diff)) } });
                  };
                  const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
                  window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
                }} />
              </div>
            </div>
          )}

          {punchIn !== null && punchOut !== null && (
            <div className="punch-overlay" style={{ left: punchIn * pxPerSec, width: Math.max(2, (punchOut - punchIn) * pxPerSec), height: totalTracksHeight }} />
          )}

          {/* File-drag ghost region */}
          {fileGhost && (
            <div
              className="region-drop-ghost"
              style={{
                left:   fileGhost.startTime * pxPerSec,
                top:    getTrackTop(fileGhost.trackIdx) + 5,
                width:  Math.max(60, secondsPerBar * 2 * pxPerSec),
                height: (tracks[fileGhost.trackIdx]?.height ?? 80) - 10,
              }}
            >
              <span className="ghost-name">{fileGhost.fileName}</span>
              <span className="ghost-pos">Bar {toBars(fileGhost.startTime, tempo)}</span>
            </div>
          )}

          <div className="arrange-tracks">
            {tracks.map((track, i) => {
              const trackRegions  = regions.filter(r => r.trackId === track.id && r.versionId === track.activeVersionId);
              const isDropTarget  = fileGhost?.trackIdx === i;
              const isVDragTarget = dragTargetTrackId === track.id;

              return (
                <div
                  key={track.id}
                  className={`arrange-track ${track.isMuted ? 'track-muted' : ''} ${(isDropTarget || isVDragTarget) ? 'track-drop-target' : ''}`}
                  style={{ height: track.height ?? 80 }}
                  onMouseDown={e => handleTrackMouseDown(e, track)}
                >
                  {trackRegions.map(region => {
                    const displayStart = draggingId === region.id && dragRef.current?.axis !== 'v' ? dragPreviewStart : region.startTime;
                    const isSelected   = selectedRegionId === region.id;
                    const isBeingDragged = draggingId === region.id;

                    return (
                      <div
                        key={region.id}
                        className={[
                          'audio-region',
                          region.isMuted    ? 'region-muted'    : '',
                          isBeingDragged    ? 'region-dragging' : '',
                          isSelected        ? 'region-selected'  : '',
                        ].filter(Boolean).join(' ')}
                        style={{
                          left:            displayStart * pxPerSec,
                          width:           Math.max(4, region.duration * pxPerSec),
                          backgroundColor: `${track.color}22`,
                          borderColor:     isSelected ? '#fff' : region.isMuted ? '#555' : track.color,
                          cursor:          activeTool === 'select' ? (isBeingDragged ? 'grabbing' : 'grab') : TOOL_CURSORS[activeTool],
                          opacity:         isBeingDragged && dragRef.current?.axis === 'v' ? 0.4 : undefined,
                        }}
                        draggable={false}
                        onMouseDown={e => handleRegionMouseDown(e, region)}
                        onMouseMove={e => handleRegionMouseMove(e, region)}
                        onMouseLeave={() => { if (activeTool === 'split') setSplitPreview(null); }}
                      >
                        <span className="region-name" style={{ color: region.isMuted ? '#666' : '#fff' }}>
                          {region.isMuted ? '(muted) ' : ''}{region.name}
                        </span>
                        {region.waveformPeaks.length > 0 && (
                          <div className="region-waveform">
                            <WaveformDisplay
                              peaks={region.waveformPeaks}
                              peaksR={region.waveformPeaksR ?? null}
                              color={region.isMuted ? '#555' : track.color}
                              isPlaying={state.transport.isPlaying}
                            />
                          </div>
                        )}
                        {activeTool === 'split' && splitPreview?.regionId === region.id && (
                          <div className="split-preview-line" style={{ left: splitPreview.x }} />
                        )}
                      </div>
                    );
                  })}

                  {/* Vertical-drag ghost preview on target track */}
                  {isVDragTarget && draggedRegion && dragRef.current?.axis !== 'h' && (
                    <div
                      className="audio-region region-v-drag-ghost"
                      style={{
                        left:  draggedRegion.startTime * pxPerSec,
                        width: Math.max(4, draggedRegion.duration * pxPerSec),
                        height: (track.height ?? 80) - 14,
                      }}
                    />
                  )}

                  {/* Live recording region — grows in real-time via RAF */}
                  {state.transport.isRecording && track.isArmed && (
                    <div
                      ref={liveRegionRef}
                      className="audio-region region-recording-live"
                      style={{
                        left: recordingStartTimeRef.current * pxPerSec,
                        width: 4,
                      }}
                    >
                      <span className="region-name recording-live-label">
                        <span className="rec-blink-dot" />REC
                      </span>
                      <div className="region-waveform">
                        <canvas ref={liveCanvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {/* New track drop zone — shows below all tracks during vertical drag */}
            {draggingId && dragTargetTrackId === '__new__' && draggedRegion && (
              <div className="new-track-drop-zone" style={{ top: totalTracksHeight }}>
                <span className="new-track-drop-label">+ New Track</span>
                <div
                  className="audio-region region-v-drag-ghost"
                  style={{
                    left:  draggedRegion.startTime * pxPerSec,
                    width: Math.max(4, draggedRegion.duration * pxPerSec),
                    height: 54,
                  }}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Zoom controls — anchored to playhead */}
      <div className="zoom-controls">
        <button className="zoom-btn" onClick={() => zoomOut(currentTimeRef.current)} title="Zoom Out (G)"><ZoomOut size={12} /></button>
        <span className="zoom-label">{Math.round(zoom * 100)}%</span>
        <button className="zoom-btn" onClick={() => zoomIn(currentTimeRef.current)} title="Zoom In (H)"><ZoomIn size={12} /></button>
      </div>

      {/* Right-click mini toolbox */}
      {miniMenu && (
        <div ref={miniMenuRef} className="mini-toolbox" style={{ left: miniMenu.x, top: miniMenu.y }}>
          {MINI_TOOLS.map(({ id, label, icon }) => (
            <button
              key={id}
              className={`mini-tool-btn ${activeTool === id ? 'active' : ''}`}
              onClick={() => { dispatch({ type: 'SET_TOOL', payload: id }); setMiniMenu(null); }}
              title={label}
            >{icon}</button>
          ))}
        </div>
      )}
    </div>
  );
};

export default ArrangeWindow;
