import React, { useRef, useEffect, useCallback, useState } from 'react';
import { ZoomIn, ZoomOut, MousePointer2, Crosshair, Scissors, Eraser, VolumeX, Pencil, FolderPlus } from 'lucide-react';
import { useDaw } from '../../context/DawContext';
import type { ActiveTool, Region, PoolItem } from '../../context/DawContext';
import WaveformDisplay from './WaveformDisplay';
import { generatePeaksStereo, uploadAudioToSupabase, saveToAudioFolder, audioBufferToWav } from '../../utils/audioUtils';
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
    `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 c-2 0-3.5 1.5-3.5 3.5 c0 1 0.4 1.9 1 2.5 L3 14.5 a1 1 0 0 0 0 1.4 l1.4 1.4 a1 1 0 0 0 1.4 0 L12 11 c0.6 0.6 1.5 1 2.5 1 c2 0 3.5-1.5 3.5-3.5 S14 2 12 2z"/><line x1="3" y1="17" x2="2" y2="21"/><circle cx="2.5" cy="22" r="1" fill="white" stroke="none"/></svg>`,
    2, 18
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
  { id: 'split',  label: 'Split [3]',   icon: <Scissors size={15} style={{ transform: 'rotate(-90deg)' }} /> },
  { id: 'render', label: 'Glue [4]',    icon: <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2 c-2 0-3.5 1.5-3.5 3.5 c0 1 0.4 1.9 1 2.5 L3 14.5 a1 1 0 0 0 0 1.4 l1.4 1.4 a1 1 0 0 0 1.4 0 L12 11 c0.6 0.6 1.5 1 2.5 1 c2 0 3.5-1.5 3.5-3.5 S14 2 12 2z"/><line x1="3" y1="17" x2="2" y2="21"/><circle cx="2.5" cy="22" r="1" fill="currentColor" stroke="none"/></svg> },
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

function formatPlayheadTime(secs: number): string {
  const m  = Math.floor(secs / 60);
  const s  = Math.floor(secs % 60);
  const ms = Math.floor((secs % 1) * 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

// ── Component ────────────────────────────────────────────────────────
const ArrangeWindow = () => {
  const { state, dispatch, currentTimeRef, recordingStartTimeRef, livePeaksRef, audioDirHandle } = useDaw();
  const { tracks, regions, activeTool, selectedRegionId, selectedTrackId, markers } = state;
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
    const gridSnapped = Math.round(t / snapSec) * snapSec;

    // Snap to clip edges within 8px
    const thresh = 8 / pxPerSecRef.current;
    for (const region of regionsRef.current) {
      if (Math.abs(t - region.startTime) < thresh) return region.startTime;
      const end = region.startTime + region.duration;
      if (Math.abs(t - end) < thresh) return end;
    }
    return gridSnapped;
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

  // ── Edge trim drag ───────────────────────────────────────────────
  const EDGE_PX = 8; // pixels from edge to activate trim handle
  type TrimState = {
    regionId: string;
    edge: 'left' | 'right';
    origStartTime: number;
    origDuration: number;
    origAudioOffset: number;
    origSourceDuration: number | undefined;
    mouseX: number;
  };
  const trimRef = useRef<TrimState | null>(null);
  const trimPreviewRef = useRef<{ startTime: number; duration: number } | null>(null);
  const [trimmingId, setTrimmingId]     = useState<string | null>(null);
  const [trimPreview, setTrimPreview]   = useState<{ startTime: number; duration: number } | null>(null);
  const [hoverEdge, setHoverEdge]       = useState<{ regionId: string; edge: 'left' | 'right' } | null>(null);
  const hoverEdgeRef = useRef(hoverEdge);
  hoverEdgeRef.current = hoverEdge;

  // ── Slip editing (Alt+drag shifts audioOffset inside fixed clip window) ──
  type SlipState = {
    regionId: string;
    origAudioOffset: number;
    origDuration: number;
    origSourceDuration: number | undefined;
    mouseX: number;
  };
  const slipRef       = useRef<SlipState | null>(null);
  const slipValRef    = useRef<number>(0);
  const [slipId, setSlipId] = useState<string | null>(null);
  const [slipOffsets, setSlipOffsets] = useState<Record<string, number>>({});

  // ── Clip rename inline ───────────────────────────────────────────
  const [renamingRegionId, setRenamingRegionId] = useState<string | null>(null);
  const [renameInput, setRenameInput]           = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  // ── Fade drag ────────────────────────────────────────────────────
  type FadeDragState = {
    regionId: string;
    type: 'fadeIn' | 'fadeOut';
    origFade: number;
    origDuration: number;
    mouseX: number;
  };
  const fadeDragRef  = useRef<FadeDragState | null>(null);
  const [fadingId, setFadingId] = useState<string | null>(null);
  const [fadePreviews, setFadePreviews] = useState<Record<string, { fadeIn?: number; fadeOut?: number }>>({});

  // ── Clip right-click context menu ───────────────────────────────
  const [clipMenu, setClipMenu] = useState<{ x: number; y: number; region: Region } | null>(null);
  const clipMenuRef = useRef<HTMLDivElement>(null);

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
  const playheadRulerRef      = useRef<HTMLDivElement>(null);
  const playheadLineRef       = useRef<HTMLDivElement>(null);
  // Imperative — created in useEffect so React never owns/clears this element
  const playheadTimeDisplayRef = useRef<HTMLDivElement | null>(null);
  const rafRef                = useRef<number | null>(null);
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

      // Ctrl+D = duplicate selected region, placed immediately after
      if ((e.key === 'd' || e.key === 'D') && e.ctrlKey) {
        e.preventDefault();
        const regionId = stateRef.current.selectedRegionId;
        const region   = regionsRef.current.find(r => r.id === regionId);
        if (region) {
          const dup: Region = {
            ...region,
            id:        `region_dup_${Date.now()}`,
            startTime: region.startTime + region.duration,
          };
          dispatch({ type: 'ADD_REGION', payload: dup });
          dispatch({ type: 'SELECT_REGION', payload: dup.id });
        }
        return;
      }

      // X = Split selected region at cursor position (#3 editing reference point)
      if (e.key === 'x' || e.key === 'X') {
        const regionId = stateRef.current.selectedRegionId;
        const region   = regionsRef.current.find(r => r.id === regionId);
        if (region) {
          const splitTime = currentTimeRef.current;
          if (splitTime > region.startTime && splitTime < region.startTime + region.duration) {
            dispatch({ type: 'SPLIT_REGION', payload: { regionId: region.id, splitTime } });
          }
        }
        return;
      }

      // I / O = set loop in / out point at cursor (#4 selection anchor)
      if (e.key === 'i' || e.key === 'I') {
        const cur = currentTimeRef.current;
        const end = stateRef.current.transport.loopEnd;
        dispatch({ type: 'SET_LOOP_RANGE', payload: { start: cur, end: Math.max(cur + 0.5, end) } });
        if (!stateRef.current.transport.isLooping) dispatch({ type: 'TOGGLE_LOOP' });
        return;
      }
      if (e.key === 'o' || e.key === 'O') {
        const cur   = currentTimeRef.current;
        const start = stateRef.current.transport.loopStart;
        dispatch({ type: 'SET_LOOP_RANGE', payload: { start: Math.min(start, Math.max(0, cur - 0.5)), end: cur } });
        if (!stateRef.current.transport.isLooping) dispatch({ type: 'TOGGLE_LOOP' });
        return;
      }

      // B = Bounce selected clip (any track type). Renders visible window + fades to a new WAV.
      // Shift+B = Bounce entire selected track (all clips in loop range, or full track if no loop).
      if (e.key === 'b' || e.key === 'B') {
        if (e.shiftKey) {
          // ── Shift+B: track / range bounce ──────────────────────────
          const selectedTrackId = stateRef.current.selectedTrackId;
          const selTrack = tracksRef.current.find(t => t.id === selectedTrackId);
          if (!selTrack) return;

          const { isLooping, loopStart, loopEnd } = stateRef.current.transport;
          const hasLoop = isLooping && loopEnd > loopStart;

          const trackRegions = regionsRef.current.filter(r =>
            r.trackId === selectedTrackId &&
            r.versionId === selTrack.activeVersionId &&
            r.audioUrl &&
            (!hasLoop || (r.startTime < loopEnd && r.startTime + r.duration > loopStart))
          );
          if (trackRegions.length === 0) return;

          const rangeStart = hasLoop ? loopStart : Math.min(...trackRegions.map(r => r.startTime));
          const rangeEnd   = hasLoop ? loopEnd   : Math.max(...trackRegions.map(r => r.startTime + r.duration));
          const rangeDur   = rangeEnd - rangeStart;

          void (async () => {
            try {
              const SR = 48000;
              const offCtx = new OfflineAudioContext(2, Math.ceil(rangeDur * SR), SR);

              await Promise.all(trackRegions.map(async (region) => {
                const clipRenderStart = Math.max(0, region.startTime - rangeStart);
                const timeInto  = Math.max(0, rangeStart - region.startTime);
                const fileOff   = (region.audioOffset ?? 0) + timeInto;
                const clipDur   = region.duration - timeInto;
                if (clipDur <= 0) return;

                const res = await fetch(region.audioUrl);
                const ab  = await res.arrayBuffer();
                const srcBuf = await offCtx.decodeAudioData(ab);
                const src = offCtx.createBufferSource();
                src.buffer = srcBuf;

                const fg = offCtx.createGain();
                const fi = region.fadeIn  ?? 0;
                const fo = region.fadeOut ?? 0;
                fg.gain.setValueAtTime(fi > 0 ? 0 : 1, clipRenderStart);
                if (fi > 0) fg.gain.linearRampToValueAtTime(1, clipRenderStart + fi);
                if (fo > 0) {
                  fg.gain.setValueAtTime(1, clipRenderStart + clipDur - fo);
                  fg.gain.linearRampToValueAtTime(0, clipRenderStart + clipDur);
                }
                src.connect(fg);
                fg.connect(offCtx.destination);
                src.start(clipRenderStart, fileOff, clipDur);
              }));

              const rendered   = await offCtx.startRendering();
              const { left: peaks, right: peaksR } = await generatePeaksStereo(rendered);
              const wavAb      = audioBufferToWav(rendered);
              const wavBlob    = new Blob([wavAb], { type: 'audio/wav' });
              const blobUrl    = URL.createObjectURL(wavBlob);
              const bounceName = `Bounce_${selTrack.name}`;
              const stamp      = Date.now();
              const newUrl     = await uploadAudioToSupabase(wavBlob, `${bounceName}_${stamp}.wav`) || blobUrl;

              const bncPoolId = `pool_bnc_${stamp}`;
              dispatch({ type: 'BOUNCE_REGIONS', payload: {
                regionIds: trackRegions.map(r => r.id),
                newPoolItem: { id: bncPoolId, name: bounceName, audioUrl: newUrl, duration: rangeDur, createdAt: new Date(), waveformPeaks: peaks, waveformPeaksR: peaksR },
                newRegion: {
                  id: `region_bnc_${stamp}`, poolItemId: bncPoolId,
                  trackId: selectedTrackId, versionId: selTrack.activeVersionId,
                  startTime: rangeStart, duration: rangeDur, name: bounceName,
                  audioUrl: newUrl, waveformPeaks: peaks, waveformPeaksR: peaksR,
                  sourcePeaks: peaks, sourcePeaksR: peaksR,
                  audioOffset: 0, sourceDuration: rangeDur,
                  fadeIn: undefined, fadeOut: undefined,
                },
              }});
            } catch (err) { console.error('[Bounce Track]', err); }
          })();
          return;
        }

        // ── B: single clip bounce ───────────────────────────────────
        const regionId = stateRef.current.selectedRegionId;
        const region   = regionsRef.current.find(r => r.id === regionId);
        if (region?.audioUrl) {
          void (async () => {
            try {
              const SR     = 48000;
              const offCtx = new OfflineAudioContext(2, Math.ceil(region.duration * SR), SR);
              const res    = await fetch(region.audioUrl);
              const ab     = await res.arrayBuffer();
              const srcBuf = await offCtx.decodeAudioData(ab);
              const src    = offCtx.createBufferSource();
              src.buffer   = srcBuf;

              const fg = offCtx.createGain();
              const fi = region.fadeIn  ?? 0;
              const fo = region.fadeOut ?? 0;
              fg.gain.setValueAtTime(fi > 0 ? 0 : 1, 0);
              if (fi > 0) fg.gain.linearRampToValueAtTime(1, fi);
              if (fo > 0) {
                fg.gain.setValueAtTime(1, region.duration - fo);
                fg.gain.linearRampToValueAtTime(0, region.duration);
              }
              src.connect(fg);
              fg.connect(offCtx.destination);
              src.start(0, region.audioOffset ?? 0, region.duration);
              const rendered = await offCtx.startRendering();

              const { left: peaks, right: peaksR } = await generatePeaksStereo(rendered);
              const wavAb      = audioBufferToWav(rendered);
              const wavBlob    = new Blob([wavAb], { type: 'audio/wav' });
              const blobUrl    = URL.createObjectURL(wavBlob);
              const bounceName = `Bounce_${region.name}`;
              const stamp      = Date.now();
              const newUrl     = await uploadAudioToSupabase(wavBlob, `${bounceName}_${stamp}.wav`) || blobUrl;

              const bncPoolId = `pool_bnc_${stamp}`;
              dispatch({ type: 'BOUNCE_REGIONS', payload: {
                regionIds: [region.id],
                newPoolItem: { id: bncPoolId, name: bounceName, audioUrl: newUrl, duration: region.duration, createdAt: new Date(), waveformPeaks: peaks, waveformPeaksR: peaksR },
                newRegion: {
                  ...region, id: `region_bnc_${stamp}`, poolItemId: bncPoolId,
                  name: bounceName, audioUrl: newUrl,
                  waveformPeaks: peaks, waveformPeaksR: peaksR,
                  sourcePeaks: peaks, sourcePeaksR: peaksR,
                  audioOffset: 0, sourceDuration: region.duration,
                  fadeIn: undefined, fadeOut: undefined,
                },
              }});
            } catch (err) { console.error('[Bounce Clip]', err); }
          })();
        }
        return;
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
      
      const mid = h / 2;
      const n = peaks.length;
      
      ctx2d.beginPath();
      ctx2d.moveTo(0, mid);
      // Top envelope
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * w || 0;
        const p = peaks[i];
        ctx2d.lineTo(x, mid - Math.max(0, p) * (h / 2 - 1) * 0.95);
      }
      // Bottom envelope
      for (let i = n - 1; i >= 0; i--) {
        const x = (i / (n - 1)) * w || 0;
        const p = peaks[i];
        ctx2d.lineTo(x, mid + Math.max(0, p) * (h / 2 - 1) * 0.95);
      }
      ctx2d.closePath();

      // Sleek solid red fill for live recording
      ctx2d.fillStyle = 'rgba(255, 100, 100, 0.5)';
      ctx2d.fill();
    };

    const tick = () => {
      const t = currentTimeRef.current;
      const x = t * zoomRef.current * BASE_PX_PER_SEC;
      if (playheadRulerRef.current) playheadRulerRef.current.style.left = `${x}px`;
      if (playheadLineRef.current)  playheadLineRef.current.style.left  = `${x}px`;

      // Time readout on the playhead handle (#6 transport sync / visual component)
      if (playheadTimeDisplayRef.current) {
        playheadTimeDisplayRef.current.textContent = formatPlayheadTime(t);
      }

      // Event highlighting — illuminate regions as cursor passes through (#12)
      document.querySelectorAll<HTMLElement>('.audio-region[data-region-id]').forEach(el => {
        const rId = el.dataset.regionId!;
        const r   = regionsRef.current.find(rg => rg.id === rId);
        const under = r ? (t >= r.startTime && t < r.startTime + r.duration) : false;
        if (under) {
          if (!el.classList.contains('region-under-cursor')) el.classList.add('region-under-cursor');
        } else {
          el.classList.remove('region-under-cursor');
        }
      });

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

  // Create the time readout element imperatively so React never owns or clears it.
  // Any React-managed child would get wiped by reconciliation on every re-render.
  useEffect(() => {
    const ruler = playheadRulerRef.current;
    if (!ruler) return;
    const el = document.createElement('div');
    el.className = 'playhead-time-readout';
    el.textContent = '00:00.000';
    ruler.appendChild(el);
    playheadTimeDisplayRef.current = el;
    return () => {
      el.remove();
      playheadTimeDisplayRef.current = null;
    };
  }, []);

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

  // Close clip context menu on outside click
  useEffect(() => {
    if (!clipMenu) return;
    const h = (e: MouseEvent) => {
      if (clipMenuRef.current && !clipMenuRef.current.contains(e.target as Node))
        setClipMenu(null);
    };
    const tid = setTimeout(() => document.addEventListener('mousedown', h), 80);
    return () => { clearTimeout(tid); document.removeEventListener('mousedown', h); };
  }, [clipMenu]);

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
        // Snap to grid first, then also snap to cursor position (#10 snap reference)
        let newStart = applySnapRef.current(rawStart);
        const phTime      = currentTimeRef.current;
        const snapThresh  = 8 / pxPerSecRef.current; // 8px threshold
        if (Math.abs(rawStart - phTime) < snapThresh) newStart = phTime;
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

  // ── Edge trim drag ───────────────────────────────────────────────
  useEffect(() => {
    if (!trimmingId) return;
    const onMove = (e: MouseEvent) => {
      const tr = trimRef.current;
      if (!tr) return;
      const dx = (e.clientX - tr.mouseX) / pxPerSecRef.current;
      let preview: { startTime: number; duration: number };
      if (tr.edge === 'right') {
        // Cap at remaining source audio (sourceDuration - audioOffset).
        // If sourceDuration is unknown (old clip), fall back to origDuration so we never
        // extend past a boundary we can't verify — the user should re-import or bounce first.
        const maxDur = tr.origSourceDuration != null
          ? tr.origSourceDuration - tr.origAudioOffset
          : tr.origDuration;
        const newDur = Math.min(maxDur, Math.max(0.1, tr.origDuration + dx));
        preview = { startTime: tr.origStartTime, duration: newDur };
      } else {
        // left edge — reveals hidden audio (decreases audioOffset, increases duration)
        // Apply snap first, then clamp so snap can't push us past the source boundary.
        const rawStart  = tr.origStartTime + Math.min(tr.origDuration - 0.1, dx);
        const snapped   = applySnapRef.current(rawStart);
        // Leftmost allowed: startTime - audioOffset (no audio before source file start)
        const minStart  = Math.max(0, tr.origStartTime - tr.origAudioOffset);
        const maxStart  = tr.origStartTime + (tr.origDuration - 0.1);
        const newStart  = Math.max(minStart, Math.min(maxStart, snapped));
        const actual    = newStart - tr.origStartTime;
        preview = { startTime: newStart, duration: tr.origDuration - actual };
      }
      trimPreviewRef.current = preview;
      setTrimPreview({ ...preview });
    };
    const onUp = () => {
      const tr = trimRef.current;
      const pv = trimPreviewRef.current;
      if (tr && pv) {
        dispatch({
          type: 'TRIM_REGION',
          payload: {
            regionId: tr.regionId,
            startTime: pv.startTime,
            duration: pv.duration,
            audioOffset: tr.edge === 'left'
              ? tr.origAudioOffset + (pv.startTime - tr.origStartTime)
              : tr.origAudioOffset,
          },
        });
      }
      trimRef.current        = null;
      trimPreviewRef.current = null;
      setTrimmingId(null);
      setTrimPreview(null);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [trimmingId, dispatch]);

  // ── Fade drag ───────────────────────────────────────────────────
  useEffect(() => {
    if (!fadingId) return;
    const onMove = (e: MouseEvent) => {
      const fd = fadeDragRef.current;
      if (!fd) return;
      const dx = (e.clientX - fd.mouseX) / pxPerSecRef.current;
      const maxFade = fd.origDuration / 2;
      let newFade: number;
      if (fd.type === 'fadeIn') {
        newFade = Math.max(0, Math.min(maxFade, fd.origFade + dx));
      } else {
        newFade = Math.max(0, Math.min(maxFade, fd.origFade - dx));
      }
      setFadePreviews(prev => ({
        ...prev,
        [fd.regionId]: { ...prev[fd.regionId], [fd.type]: newFade },
      }));
    };
    const onUp = () => {
      const fd = fadeDragRef.current;
      if (fd) {
        const preview = fadePreviews[fd.regionId];
        if (preview) {
          dispatch({
            type: 'UPDATE_REGION',
            payload: { id: fd.regionId, updates: { [fd.type]: preview[fd.type] } },
          });
        }
      }
      fadeDragRef.current = null;
      setFadingId(null);
      setFadePreviews({});
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [fadingId, fadePreviews, dispatch]);

  // ── Slip drag ───────────────────────────────────────────────────
  useEffect(() => {
    if (!slipId) return;
    const onMove = (e: MouseEvent) => {
      const sl = slipRef.current;
      if (!sl) return;
      const dx       = (e.clientX - sl.mouseX) / pxPerSecRef.current;
      // When sourceDuration is unknown, only allow slipping left (toward 0) — slipping
      // right would require knowing there's audio past audioOffset+duration, which we don't.
      const maxOff   = sl.origSourceDuration != null
        ? sl.origSourceDuration - sl.origDuration
        : sl.origAudioOffset;
      const newOff   = Math.max(0, Math.min(maxOff, sl.origAudioOffset + dx));
      slipValRef.current = newOff;
      setSlipOffsets(prev => ({ ...prev, [sl.regionId]: newOff }));
    };
    const onUp = () => {
      const sl = slipRef.current;
      if (sl) {
        const region = regionsRef.current.find(r => r.id === sl.regionId);
        if (region) {
          dispatch({
            type: 'TRIM_REGION',
            payload: {
              regionId: sl.regionId,
              startTime: region.startTime,
              duration: region.duration,
              audioOffset: slipValRef.current,
            },
          });
        }
      }
      slipRef.current = null;
      setSlipId(null);
      setSlipOffsets({});
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [slipId, dispatch]);

  // ── Ruler pointer drag (Cubase-style scrub) ──────────────────────
  const rulerDraggingRef = useRef(false);
  const [markerDialog, setMarkerDialog] = useState<{
    id: string | null;
    pendingTime?: number;
    name: string;
  } | null>(null);

  const getTimeFromRulerPointer = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const sl   = contentScrollRef.current?.scrollLeft ?? 0;
    return Math.max(0, (e.clientX - rect.left + sl) / pxPerSec);
  }, [pxPerSec]);

  const handleRulerPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('.marker-flag')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const t = getTimeFromRulerPointer(e);

    // Shift+click: create range selection from cursor to click point (#4 selection anchor)
    if (e.shiftKey) {
      const anchor = currentTimeRef.current;
      const left   = Math.min(anchor, t) * pxPerSec;
      const width  = Math.abs(t - anchor) * pxPerSec;
      setRangeBox({ left, width });
      return;
    }

    rulerDraggingRef.current = true;
    currentTimeRef.current = t;
    dispatch({ type: 'SET_CURRENT_TIME', payload: t });
  }, [getTimeFromRulerPointer, currentTimeRef, dispatch, pxPerSec]);

  const handleRulerPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!rulerDraggingRef.current) return;
    const t = getTimeFromRulerPointer(e);
    currentTimeRef.current = t;
    dispatch({ type: 'SET_CURRENT_TIME', payload: t });
  }, [getTimeFromRulerPointer, currentTimeRef, dispatch]);

  const handleRulerPointerUp = useCallback(() => {
    rulerDraggingRef.current = false;
  }, []);

  const confirmMarkerDialog = useCallback(() => {
    if (!markerDialog) return;
    const name = markerDialog.name.trim() || 'Marker';
    if (markerDialog.id) {
      dispatch({ type: 'RENAME_MARKER', payload: { id: markerDialog.id, name } });
    } else {
      dispatch({ type: 'ADD_MARKER', payload: { id: `marker_${Date.now()}`, time: markerDialog.pendingTime ?? 0, name } });
    }
    setMarkerDialog(null);
  }, [markerDialog, dispatch]);

  // ── Crop: renders visible window to a new WAV; edges can no longer be extended ──
  const handleCrop = useCallback(async (region: Region) => {
    if (!region.audioUrl) return;
    try {
      const res    = await fetch(region.audioUrl);
      const ab     = await res.arrayBuffer();
      const SR     = 48000;
      const decCtx = new AudioContext();
      const srcBuf = await decCtx.decodeAudioData(ab);
      await decCtx.close();

      const offCtx = new OfflineAudioContext(2, Math.ceil(region.duration * SR), SR);
      const src    = offCtx.createBufferSource();
      src.buffer   = srcBuf;
      src.connect(offCtx.destination);
      src.start(0, region.audioOffset ?? 0, region.duration);
      const rendered = await offCtx.startRendering();

      const { left: peaks, right: peaksR } = await generatePeaksStereo(rendered);
      const wavAb   = audioBufferToWav(rendered);
      const wavBlob = new Blob([wavAb], { type: 'audio/wav' });
      const blobUrl = URL.createObjectURL(wavBlob);
      const cropName = `Crop_${region.name}`;
      const stamp    = Date.now();
      const cropPoolId = `pool_crop_${stamp}`;

      dispatch({ type: 'ADD_POOL_ITEM', payload: { id: cropPoolId, name: cropName, audioUrl: blobUrl, duration: region.duration, createdAt: new Date(), waveformPeaks: peaks, waveformPeaksR: peaksR } });

      uploadAudioToSupabase(wavBlob, `${cropName}_${stamp}.wav`).then(supaUrl => {
        if (supaUrl && supaUrl !== blobUrl)
          dispatch({ type: 'UPDATE_AUDIO_URLS', payload: { poolItemId: cropPoolId, audioUrl: supaUrl } });
      }).catch(() => {});

      if (audioDirHandle) saveToAudioFolder(audioDirHandle, cropName, rendered).catch(() => {});

      // Replace the clip with the cropped audio — audioOffset=0, sourceDuration=duration (no expandable edges)
      dispatch({
        type: 'UPDATE_REGION',
        payload: {
          id: region.id,
          updates: {
            poolItemId: cropPoolId, audioUrl: blobUrl, name: cropName,
            audioOffset: 0, sourceDuration: region.duration,
            waveformPeaks: peaks, waveformPeaksR: peaksR,
            sourcePeaks: peaks, sourcePeaksR: peaksR,
            fadeIn: undefined, fadeOut: undefined,
          },
        },
      });
    } catch (err) { console.error('[Crop]', err); }
  }, [dispatch, audioDirHandle]);

  // Right-click → mini toolbox
  const handleImportAudio = useCallback(() => {
    const track = tracks.find(t => t.id === selectedTrackId);
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
        const peaksR = track.type === 'stereo' ? rawPeaksR : null;
        const duration = buf.duration;
        await actx.close();
        const poolItemId = `pool_${Date.now()}`;
        const poolItem: PoolItem = {
          id: poolItemId,
          name: file.name.replace(/\.[^.]+$/, ''),
          audioUrl: url,
          localFileName: file.name,
          duration,
          createdAt: new Date(),
          waveformPeaks: peaks,
          waveformPeaksR: rawPeaksR ?? undefined,
        };
        dispatch({ type: 'ADD_POOL_ITEM', payload: poolItem });
        dispatch({
          type: 'ADD_REGION',
          payload: {
            id: `r_${Date.now()}`,
            poolItemId,
            trackId: track.id,
            versionId: track.activeVersionId,
            startTime: currentTimeRef.current,
            duration,
            name: poolItem.name,
            audioUrl: url,
            waveformPeaks: peaks,
            waveformPeaksR: peaksR ?? undefined,
            sourceDuration: duration,
            sourcePeaks: peaks,
            sourcePeaksR: rawPeaksR ?? undefined,
          },
        });
        if (audioDirHandle) {
          try { await saveToAudioFolder(audioDirHandle, poolItem.name, buf); } catch {}
        }
      } catch { /* decode failed */ }
    };
    input.click();
  }, [tracks, selectedTrackId, dispatch, currentTimeRef, audioDirHandle]);

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
        // Detect edge directly from click coords — don't rely solely on hover state,
        // which may not be set if the user clicked without a preceding mousemove.
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const distL = e.clientX - rect.left;
        const distR = rect.right - e.clientX;
        const edgeAtClick: 'left' | 'right' | null =
          distL <= EDGE_PX ? 'left' : distR <= EDGE_PX ? 'right' : null;
        const edge = edgeAtClick ?? (hoverEdgeRef.current?.regionId === region.id ? hoverEdgeRef.current.edge : null);

        if (e.altKey && !edge) {
          // Alt+drag = slip edit: shift audio content inside the fixed clip window
          slipRef.current = {
            regionId: region.id,
            origAudioOffset: region.audioOffset ?? 0,
            origDuration: region.duration,
            origSourceDuration: region.sourceDuration,
            mouseX: e.clientX,
          };
          slipValRef.current = region.audioOffset ?? 0;
          setSlipId(region.id);
          setSlipOffsets({ [region.id]: region.audioOffset ?? 0 });
        } else if (edge) {
          // Start edge trim
          trimRef.current = {
            regionId: region.id,
            edge,
            origStartTime: region.startTime,
            origDuration: region.duration,
            origAudioOffset: region.audioOffset ?? 0,
            origSourceDuration: region.sourceDuration,
            mouseX: e.clientX,
          };
          trimPreviewRef.current = { startTime: region.startTime, duration: region.duration };
          setTrimmingId(region.id);
          setTrimPreview({ startTime: region.startTime, duration: region.duration });
        } else {
          // Start move drag (existing behaviour)
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
        }
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
        void (async () => {
          // Find the immediately next region on this track/version
          const trackRegions = regionsRef.current
            .filter(r => r.trackId === region.trackId && r.versionId === region.versionId)
            .sort((a, b) => a.startTime - b.startTime);
          const idx  = trackRegions.findIndex(r => r.id === region.id);
          const next = idx >= 0 ? trackRegions[idx + 1] : undefined;
          if (!next) return;

          // If neither piece has audio — pure metadata merge (empty draw regions)
          if (!region.audioUrl && !next.audioUrl) {
            dispatch({ type: 'RENDER_REGIONS', payload: region.id });
            return;
          }

          const mergedStart = region.startTime;
          const mergedEnd   = next.startTime + next.duration;
          const totalDur    = mergedEnd - mergedStart;

          try {
            const SR = 48000;
            const offCtx = new OfflineAudioContext(2, Math.ceil(totalDur * SR), SR);

            const schedule = async (r: Region, offsetInMerge: number) => {
              if (!r.audioUrl) return;
              const res = await fetch(r.audioUrl);
              const ab  = await res.arrayBuffer();
              const buf = await offCtx.decodeAudioData(ab);
              const src = offCtx.createBufferSource();
              src.buffer = buf;
              src.connect(offCtx.destination);
              src.start(Math.max(0, offsetInMerge), r.audioOffset ?? 0, r.duration);
            };

            await schedule(region, 0);
            await schedule(next, next.startTime - mergedStart);

            const rendered  = await offCtx.startRendering();
            const { left: peaks, right: rawPeaksR } = await generatePeaksStereo(rendered);
            // Only keep stereo peaks if the target track is stereo
            const glueTrack = tracks.find(t => t.id === region.trackId);
            const peaksR    = glueTrack?.type === 'stereo' ? rawPeaksR : null;
            const wavAb     = audioBufferToWav(rendered);
            const blobUrl   = URL.createObjectURL(new Blob([wavAb], { type: 'audio/wav' }));
            const stamp     = Date.now();
            const name      = region.name;

            const gluePoolId = `pool_glue_${stamp}`;
            dispatch({
              type: 'BOUNCE_REGIONS',
              payload: {
                regionIds: [region.id, next.id],
                newPoolItem: { id: gluePoolId, name, audioUrl: blobUrl, duration: totalDur, createdAt: new Date(), waveformPeaks: peaks, waveformPeaksR: peaksR },
                newRegion:   { id: `region_glue_${stamp}`, poolItemId: gluePoolId, trackId: region.trackId, versionId: region.versionId, startTime: mergedStart, duration: totalDur, name, audioUrl: blobUrl, waveformPeaks: peaks, waveformPeaksR: peaksR, audioOffset: 0, sourceDuration: totalDur },
              },
            });
          } catch (err) {
            console.error('[glue]', err);
            dispatch({ type: 'RENDER_REGIONS', payload: region.id });
          }
        })();
        break;
      default:
        break;
    }
  };

  // Region mouse move — split preview + edge-trim cursor detection
  const handleRegionMouseMove = (e: React.MouseEvent, region: Region) => {
    if (activeTool === 'split') {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const rawTime = region.startTime + (e.clientX - rect.left) / pxPerSec;
      const snappedTime = applySnap(rawTime);
      setSplitPreview({ regionId: region.id, x: (snappedTime - region.startTime) * pxPerSec });
      return;
    }
    if (splitPreview) setSplitPreview(null);

    if (activeTool === 'select' && !draggingId && !trimmingId) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const distL = e.clientX - rect.left;
      const distR = rect.right - e.clientX;
      if (distL <= EDGE_PX) {
        setHoverEdge({ regionId: region.id, edge: 'left' });
      } else if (distR <= EDGE_PX) {
        setHoverEdge({ regionId: region.id, edge: 'right' });
      } else if (hoverEdge?.regionId === region.id) {
        setHoverEdge(null);
      }
    }
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
        const { left: peaks, right: rawPeaksR } = await generatePeaksStereo(buf);
        // Mono tracks show a single waveform lane; only pass peaksR for stereo tracks
        const peaksR = target.type === 'stereo' ? rawPeaksR : null;
        const name     = file.name.replace(/\.[^.]+$/, '');

        // Use blob URL immediately — no network wait
        const audioUrl   = URL.createObjectURL(file);
        const poolItemId = `pool_${Date.now()}`;

        // Pool stores raw stereo peaks so the file can be reused on any track type later
        dispatch({ type: 'ADD_POOL_ITEM', payload: { id: poolItemId, name, audioUrl, localFileName: file.name, duration: buf.duration, createdAt: new Date(), waveformPeaks: peaks, waveformPeaksR: rawPeaksR } });
        dispatch({ type: 'ADD_REGION',    payload: { id: `region_${Date.now()}`, poolItemId, trackId: target.id, versionId: target.activeVersionId, startTime, duration: buf.duration, name, audioUrl, waveformPeaks: peaks, waveformPeaksR: peaksR, sourceDuration: buf.duration, sourcePeaks: peaks, sourcePeaksR: rawPeaksR } });

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

  // ── Display peaks: slice sourcePeaks by audioOffset/sourceDuration for correct waveform ──
  // liveOffset   overrides audioOffset (slip editing)
  // liveDuration overrides region.duration (live trim preview — shows revealed audio, not a stretch)
  const getDisplayPeaks = (region: Region, liveOffset?: number, liveDuration?: number): number[] => {
    const sp = region.sourcePeaks;
    const sd = region.sourceDuration;
    if (sp && sp.length > 0 && sd && sd > 0) {
      const off = liveOffset ?? (region.audioOffset ?? 0);
      const dur = liveDuration ?? region.duration;
      const n   = sp.length;
      const s   = Math.floor((off / sd) * n);
      const e2  = Math.ceil(((off + dur) / sd) * n);
      const sl  = sp.slice(Math.max(0, s), Math.min(n, e2));
      return sl.length > 0 ? sl : region.waveformPeaks;
    }
    return region.waveformPeaks;
  };

  const getDisplayPeaksR = (region: Region, liveOffset?: number, liveDuration?: number): number[] | null | undefined => {
    const sp = region.sourcePeaksR;
    const sd = region.sourceDuration;
    if (sp && sp.length > 0 && sd && sd > 0) {
      const off = liveOffset ?? (region.audioOffset ?? 0);
      const dur = liveDuration ?? region.duration;
      const n   = sp.length;
      const s   = Math.floor((off / sd) * n);
      const e2  = Math.ceil(((off + dur) / sd) * n);
      const sl  = sp.slice(Math.max(0, s), Math.min(n, e2));
      return sl.length > 0 ? sl : region.waveformPeaksR;
    }
    return region.waveformPeaksR;
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
      <div
        className="timeline-ruler bar-ruler"
        style={{ cursor: 'col-resize', userSelect: 'none' }}
        onPointerDown={handleRulerPointerDown}
        onPointerMove={handleRulerPointerMove}
        onPointerUp={handleRulerPointerUp}
        onPointerCancel={handleRulerPointerUp}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest('.marker-flag')) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const sl = contentScrollRef.current?.scrollLeft ?? 0;
          const rawTime = Math.max(0, (e.clientX - rect.left + sl) / pxPerSec);
          setMarkerDialog({ id: null, pendingTime: applySnap(rawTime), name: '' });
        }}
      >
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
            <div
              key={m.id}
              className="marker-flag"
              style={{ left: m.time * pxPerSec, top: 0, position: 'absolute' }}
              onPointerDown={e => e.stopPropagation()}
            >
              <span
                className="marker-name"
                title="Click to jump • Double-click to rename"
                onClick={(e) => {
                  e.stopPropagation();
                  // Jump cursor to marker position (#15 marker interaction)
                  currentTimeRef.current = m.time;
                  dispatch({ type: 'SET_CURRENT_TIME', payload: m.time });
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setMarkerDialog({ id: m.id, name: m.name });
                }}
              >{m.name}</span>
              <button
                className="marker-delete-btn"
                onClick={(e) => { e.stopPropagation(); dispatch({ type: 'REMOVE_MARKER', payload: m.id }); }}
                title="Remove marker"
              >×</button>
            </div>
          ))}

          <div ref={playheadRulerRef} className="playhead-marker" style={{ left: 0 }}>
            <div className="playhead-triangle" />
          </div>
        </div>
      </div>

      {/* Seconds / Time ruler */}
      <div
        className="timeline-ruler time-ruler"
        style={{ cursor: 'col-resize', userSelect: 'none' }}
        onPointerDown={handleRulerPointerDown}
        onPointerMove={handleRulerPointerMove}
        onPointerUp={handleRulerPointerUp}
        onPointerCancel={handleRulerPointerUp}
      >
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
                    const isTrimming     = trimmingId === region.id;
                    const displayStart   = isTrimming && trimPreview ? trimPreview.startTime
                                        : draggingId === region.id && dragRef.current?.axis !== 'v' ? dragPreviewStart
                                        : region.startTime;
                    const displayDur     = isTrimming && trimPreview ? trimPreview.duration : region.duration;
                    const isSelected     = selectedRegionId === region.id;
                    const isBeingDragged = draggingId === region.id;
                    const isEdgeHovered  = hoverEdge?.regionId === region.id;
                    const isStereo       = region.waveformPeaksR && region.waveformPeaksR.length > 0;

                    return (
                      <div
                        key={region.id}
                        data-region-id={region.id}
                        className={[
                          'audio-region',
                          region.isMuted    ? 'region-muted'    : '',
                          isBeingDragged    ? 'region-dragging' : '',
                          isTrimming        ? 'region-trimming' : '',
                          isSelected        ? 'region-selected'  : '',
                        ].filter(Boolean).join(' ')}
                        style={{
                          left:            displayStart * pxPerSec,
                          width:           Math.max(4, displayDur * pxPerSec),
                          backgroundColor: '#26272b',
                          borderColor:     isSelected ? '#fff' : track.color,
                          borderRadius:    2,
                          cursor:          activeTool === 'select'
                                            ? (isTrimming || isEdgeHovered ? 'ew-resize' : isBeingDragged ? 'grabbing' : 'grab')
                                            : TOOL_CURSORS[activeTool],
                          opacity:         isBeingDragged && dragRef.current?.axis === 'v' ? 0.4 : undefined,
                        }}
                        draggable={false}
                        onMouseDown={e => handleRegionMouseDown(e, region)}
                        onMouseMove={e => handleRegionMouseMove(e, region)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation(); // prevent the arrange-window mini toolbox
                          setClipMenu({ x: e.clientX, y: e.clientY, region });
                        }}
                        onMouseLeave={() => {
                          if (activeTool === 'split') setSplitPreview(null);
                          if (hoverEdge?.regionId === region.id) setHoverEdge(null);
                        }}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          if (activeTool === 'select') {
                            setRenamingRegionId(region.id);
                            setRenameInput(region.name);
                            setTimeout(() => renameInputRef.current?.select(), 30);
                          }
                        }}
                      >
                        {/* Name bar */}
                        <div
                          className="region-name-bar"
                          style={{ backgroundColor: region.isMuted ? 'rgba(60,60,60,0.85)' : `${track.color}dd` }}
                        >
                          {renamingRegionId === region.id ? (
                            <input
                              ref={renameInputRef}
                              className="region-rename-input"
                              value={renameInput}
                              onChange={e => setRenameInput(e.target.value)}
                              onBlur={() => {
                                const name = renameInput.trim() || region.name;
                                dispatch({ type: 'RENAME_REGION', payload: { id: region.id, name } });
                                setRenamingRegionId(null);
                              }}
                              onKeyDown={e => {
                                e.stopPropagation();
                                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                                if (e.key === 'Escape') { setRenamingRegionId(null); }
                              }}
                              onClick={e => e.stopPropagation()}
                              onMouseDown={e => e.stopPropagation()}
                              style={{ height: '100%', fontSize: '10px' }}
                            />
                          ) : (
                            <span className="region-name">
                              {region.isMuted ? '(muted) ' : ''}{region.name}
                            </span>
                          )}
                        </div>

                        {/* Fade-in overlay */}
                        {(() => {
                          const fi = fadePreviews[region.id]?.fadeIn ?? region.fadeIn ?? 0;
                          return fi > 0 ? (
                            <div className="fade-overlay fade-in-overlay" style={{ width: fi * pxPerSec }} />
                          ) : null;
                        })()}

                        {/* Fade-out overlay */}
                        {(() => {
                          const fo = fadePreviews[region.id]?.fadeOut ?? region.fadeOut ?? 0;
                          return fo > 0 ? (
                            <div className="fade-overlay fade-out-overlay" style={{ width: fo * pxPerSec }} />
                          ) : null;
                        })()}

                        {/* Fade-in drag handle */}
                        <div
                          className="fade-handle fade-in-handle"
                          title="Drag to set Fade In"
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            fadeDragRef.current = {
                              regionId: region.id,
                              type: 'fadeIn',
                              origFade: region.fadeIn ?? 0,
                              origDuration: region.duration,
                              mouseX: e.clientX,
                            };
                            setFadingId(region.id);
                            setFadePreviews({ [region.id]: { fadeIn: region.fadeIn ?? 0, fadeOut: region.fadeOut ?? 0 } });
                          }}
                        />

                        {/* Fade-out drag handle */}
                        <div
                          className="fade-handle fade-out-handle"
                          title="Drag to set Fade Out"
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            fadeDragRef.current = {
                              regionId: region.id,
                              type: 'fadeOut',
                              origFade: region.fadeOut ?? 0,
                              origDuration: region.duration,
                              mouseX: e.clientX,
                            };
                            setFadingId(region.id);
                            setFadePreviews({ [region.id]: { fadeIn: region.fadeIn ?? 0, fadeOut: region.fadeOut ?? 0 } });
                          }}
                        />

                        {region.waveformPeaks.length > 0 && (() => {
                          // Compute live offset + duration so the waveform shows the actual
                          // revealed audio as you drag, not a stretched version of existing peaks.
                          const isThisTrimming = trimmingId === region.id && !!trimPreview;
                          const tr = isThisTrimming ? trimRef.current : null;
                          let peakOffset: number | undefined = slipOffsets[region.id];
                          let peakDuration: number | undefined;
                          if (isThisTrimming && tr && trimPreview) {
                            peakDuration = trimPreview.duration;
                            peakOffset = tr.edge === 'left'
                              ? tr.origAudioOffset + (trimPreview.startTime - tr.origStartTime)
                              : tr.origAudioOffset;
                          }
                          return (
                            <div className="region-waveform">
                              <WaveformDisplay
                                peaks={getDisplayPeaks(region, peakOffset, peakDuration)}
                                peaksR={getDisplayPeaksR(region, peakOffset, peakDuration)}
                                color={region.isMuted ? '#555' : (region.color ?? track.color)}
                                isPlaying={state.transport.isPlaying}
                                isSelected={isSelected}
                              />
                            </div>
                          );
                        })()}
                        {activeTool === 'split' && splitPreview?.regionId === region.id && (
                          <div className="split-preview-line" style={{ left: splitPreview.x }} />
                        )}
                      </div>
                    );
                  })}

                  {/* Crossfade overlays — rendered where adjacent clips on this track overlap */}
                  {(() => {
                    const sorted = [...trackRegions].sort((a, b) => a.startTime - b.startTime);
                    const overlays: React.ReactNode[] = [];
                    for (let i = 0; i + 1 < sorted.length; i++) {
                      const a = sorted[i];
                      const b = sorted[i + 1];
                      const overlap = (a.startTime + a.duration) - b.startTime;
                      if (overlap > 0.01) {
                        const xfLeft = b.startTime * pxPerSec;
                        const xfWidth = Math.min(overlap, b.duration) * pxPerSec;
                        overlays.push(
                          <div
                            key={`xfade_${a.id}_${b.id}`}
                            className="crossfade-overlay"
                            style={{ left: xfLeft, width: xfWidth }}
                            title={`Crossfade: ${overlap.toFixed(2)}s`}
                          />
                        );
                      }
                    }
                    return overlays;
                  })()}

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

      {/* Clip right-click context menu */}
      {clipMenu && (
        <div ref={clipMenuRef} className="clip-context-menu" style={{ left: clipMenu.x, top: clipMenu.y }}>
          {[
            {
              label: 'Rename',
              onClick: () => {
                setRenamingRegionId(clipMenu.region.id);
                setRenameInput(clipMenu.region.name);
                setTimeout(() => renameInputRef.current?.select(), 30);
                setClipMenu(null);
              },
            },
            {
              label: 'Duplicate',
              onClick: () => {
                const dup: Region = { ...clipMenu.region, id: `region_dup_${Date.now()}`, startTime: clipMenu.region.startTime + clipMenu.region.duration };
                dispatch({ type: 'ADD_REGION', payload: dup });
                dispatch({ type: 'SELECT_REGION', payload: dup.id });
                setClipMenu(null);
              },
            },
            {
              label: clipMenu.region.isMuted ? 'Unmute' : 'Mute',
              onClick: () => { dispatch({ type: 'TOGGLE_REGION_MUTE', payload: clipMenu.region.id }); setClipMenu(null); },
            },
            {
              label: 'Crop to Visible',
              onClick: () => { void handleCrop(clipMenu.region); setClipMenu(null); },
            },
            {
              label: 'Delete',
              onClick: () => {
                dispatch({ type: 'REMOVE_REGION', payload: clipMenu.region.id });
                if (selectedRegionId === clipMenu.region.id) dispatch({ type: 'SELECT_REGION', payload: null });
                setClipMenu(null);
              },
            },
          ].map(({ label, onClick }) => (
            <button key={label} className="clip-menu-item" onClick={onClick}>{label}</button>
          ))}
        </div>
      )}

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
          <div className="mini-toolbox-divider" />
          <button
            className="mini-tool-btn"
            onClick={() => { setMiniMenu(null); handleImportAudio(); }}
            title={selectedTrackId ? 'Import audio to selected track' : 'Select a track first'}
            disabled={!selectedTrackId}
          >
            <FolderPlus size={15} />
          </button>
        </div>
      )}

      {/* Marker dialog */}
      {markerDialog !== null && (
        <div
          className="marker-dialog-overlay"
          onMouseDown={() => setMarkerDialog(null)}
        >
          <div className="marker-dialog" onMouseDown={e => e.stopPropagation()}>
            <div className="marker-dialog-title">
              {markerDialog.id ? 'Rename Marker' : 'Add Marker'}
            </div>
            <input
              className="marker-dialog-input"
              value={markerDialog.name}
              placeholder="Marker name"
              autoFocus
              onChange={e => setMarkerDialog(d => d ? { ...d, name: e.target.value } : d)}
              onKeyDown={e => {
                if (e.key === 'Enter') confirmMarkerDialog();
                if (e.key === 'Escape') setMarkerDialog(null);
              }}
            />
            <div className="marker-dialog-actions">
              <button className="marker-dialog-btn cancel" onClick={() => setMarkerDialog(null)}>Cancel</button>
              <button className="marker-dialog-btn confirm" onClick={confirmMarkerDialog}>
                {markerDialog.id ? 'Rename' : 'Add'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ArrangeWindow;
