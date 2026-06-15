import { useState, useRef, useEffect, useCallback } from 'react';
import { AlignLeft, AlignCenter, AlignRight, ZoomIn, ZoomOut, Maximize2, Minimize2, X } from 'lucide-react';
import './LyricsPanel.css';

interface LyricsPanelProps {
  onClose: () => void;
}

interface LyricsUIPrefs {
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  align: 'left' | 'center' | 'right';
  expanded: boolean;
}

const UI_KEY  = 'sd_lyrics_ui';
const TEXT_KEY = 'sd_lyrics';

const DEFAULT_PREFS: LyricsUIPrefs = {
  x: Math.max(0, window.innerWidth - 440),
  y: 60,
  w: 400,
  h: 320,
  fontSize: 16,
  align: 'left',
  expanded: false,
};

function loadPrefs(): LyricsUIPrefs {
  try {
    const raw = localStorage.getItem(UI_KEY);
    if (raw) return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch {}
  return { ...DEFAULT_PREFS };
}

const LyricsPanel = ({ onClose }: LyricsPanelProps) => {
  const saved = useRef(loadPrefs());

  const [text, setText] = useState(
    () => localStorage.getItem(TEXT_KEY) ?? localStorage.getItem('sd_notepad') ?? ''
  );
  const [pos,      setPos]      = useState({ x: saved.current.x, y: saved.current.y });
  const [fontSize, setFontSize] = useState(saved.current.fontSize);
  const [align,    setAlign]    = useState<'left' | 'center' | 'right'>(saved.current.align);
  const [expanded, setExpanded] = useState(saved.current.expanded);

  const panelRef  = useRef<HTMLDivElement>(null);
  const dragRef   = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null);

  // Live refs so ResizeObserver / save callbacks read fresh values without re-subscribing
  const posRef      = useRef(pos);
  const fontSizeRef = useRef(fontSize);
  const alignRef    = useRef(align);
  const expandedRef = useRef(expanded);
  useEffect(() => { posRef.current = pos; },           [pos]);
  useEffect(() => { fontSizeRef.current = fontSize; }, [fontSize]);
  useEffect(() => { alignRef.current = align; },       [align]);
  useEffect(() => { expandedRef.current = expanded; }, [expanded]);

  // ── Persist helpers ──────────────────────────────────────────────────────────
  const savePrefs = useCallback(() => {
    const el = panelRef.current;
    const prefs: LyricsUIPrefs = {
      x: posRef.current.x,
      y: posRef.current.y,
      // Capture actual DOM size (CSS resize may have changed it)
      w: el && !expandedRef.current ? Math.round(el.offsetWidth)  : saved.current.w,
      h: el && !expandedRef.current ? Math.round(el.offsetHeight) : saved.current.h,
      fontSize:  fontSizeRef.current,
      align:     alignRef.current,
      expanded:  expandedRef.current,
    };
    saved.current = prefs;
    localStorage.setItem(UI_KEY, JSON.stringify(prefs));
  }, []);

  useEffect(() => { localStorage.setItem(TEXT_KEY, text); }, [text]);

  // ── Set initial panel size from saved prefs (one-time on mount) ──────────────
  // Must run BEFORE the savePrefs effect so the DOM reflects the restored size
  // when savePrefs first reads el.offsetWidth/Height.
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    el.style.width  = `${saved.current.w}px`;
    el.style.height = `${saved.current.h}px`;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist pos, fontSize, align, expanded whenever they change (skip initial mount)
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) { isFirstRender.current = false; return; }
    savePrefs();
  }, [pos, fontSize, align, expanded, savePrefs]);

  // ── ResizeObserver — capture user-dragged size and persist ──────────────────
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout>;
    const ro = new ResizeObserver(() => {
      if (expandedRef.current) return; // don't save size in full-screen mode
      clearTimeout(timer);
      timer = setTimeout(savePrefs, 250);
    });
    ro.observe(el);
    return () => { ro.disconnect(); clearTimeout(timer); };
  }, [savePrefs]);

  // ── Dragging ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      setPos({
        x: Math.max(0, dragRef.current.px + (e.clientX - dragRef.current.sx)),
        y: Math.max(0, dragRef.current.py + (e.clientY - dragRef.current.sy)),
      });
    };
    const onUp = () => { dragRef.current = null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',  onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',  onUp);
    };
  }, []);

  const handleHeaderMouseDown = (e: React.MouseEvent) => {
    if (expanded) return;
    e.preventDefault();
    dragRef.current = { sx: e.clientX, sy: e.clientY, px: pos.x, py: pos.y };
  };

  const panelStyle: React.CSSProperties = expanded
    ? { position: 'fixed', top: 8, left: 8, right: 8, bottom: 8 }
    : { position: 'fixed', left: pos.x, top: pos.y };

  return (
    <div
      ref={panelRef}
      className={`lyrics-panel${expanded ? ' lyrics-panel--expanded' : ''}`}
      style={panelStyle}
    >
      <div className="lyrics-panel__header" onMouseDown={handleHeaderMouseDown}>
        <span className="lyrics-panel__title">Lyrics</span>
        <div className="lyrics-panel__controls">
          <button title="Align left"   className={align === 'left'   ? 'active' : ''} onClick={() => setAlign('left')}><AlignLeft   size={12} /></button>
          <button title="Align center" className={align === 'center' ? 'active' : ''} onClick={() => setAlign('center')}><AlignCenter size={12} /></button>
          <button title="Align right"  className={align === 'right'  ? 'active' : ''} onClick={() => setAlign('right')}><AlignRight  size={12} /></button>

          <div className="lyrics-panel__divider" />

          <button title="Decrease font size" onClick={() => setFontSize(f => Math.max(10, f - 2))}><ZoomOut size={12} /></button>
          <span className="lyrics-panel__font-size">{fontSize}px</span>
          <button title="Increase font size" onClick={() => setFontSize(f => Math.min(48, f + 2))}><ZoomIn  size={12} /></button>

          <div className="lyrics-panel__divider" />

          <button title={expanded ? 'Restore' : 'Expand to full screen'} onClick={() => setExpanded(v => !v)}>
            {expanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
          <button title="Close lyrics (Alt+N)" onClick={onClose}><X size={12} /></button>
        </div>
      </div>

      <textarea
        className="lyrics-panel__textarea"
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="Paste or type lyrics here…"
        style={{ fontSize, textAlign: align }}
        onMouseDown={e => e.stopPropagation()}
        spellCheck={false}
      />
    </div>
  );
};

export default LyricsPanel;
