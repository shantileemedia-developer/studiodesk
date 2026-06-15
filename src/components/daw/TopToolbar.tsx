import { useState, useRef, useEffect } from 'react';
import {
  MousePointer2, Scissors, Eraser, VolumeX, Search,
  Pencil, Copy, Palette,
} from 'lucide-react';
import { useDaw } from '../../context/DawContext';
import type { ActiveTool } from '../../context/DawContext';
import './TopToolbar.css';

const GlueIcon = ({ size = 15 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2 c-2 0-3.5 1.5-3.5 3.5 c0 1 0.4 1.9 1 2.5 L3 14.5 a1 1 0 0 0 0 1.4 l1.4 1.4 a1 1 0 0 0 1.4 0 L12 11 c0.6 0.6 1.5 1 2.5 1 c2 0 3.5-1.5 3.5-3.5 S14 2 12 2z" />
    <line x1="3" y1="17" x2="2" y2="21" />
    <circle cx="2.5" cy="22" r="1" fill="currentColor" stroke="none" />
  </svg>
);

const TOOLS: { id: ActiveTool; icon: React.ElementType | (() => React.ReactNode); label: string; key: string; iconStyle?: React.CSSProperties; isCustom?: boolean }[] = [
  { id: 'select', icon: MousePointer2, label: 'Object Selection', key: '1' },
  { id: 'range',  icon: Copy,          label: 'Range Selection',  key: '2' },
  { id: 'split',  icon: Scissors,      label: 'Split',            key: '3', iconStyle: { transform: 'rotate(-90deg)' } },
  { id: 'render', icon: GlueIcon,      label: 'Glue',             key: '4', isCustom: true },
  { id: 'erase',  icon: Eraser,        label: 'Erase',            key: '5' },
  { id: 'zoom',   icon: Search,        label: 'Zoom',             key: '6' },
  { id: 'mute',   icon: VolumeX,       label: 'Mute',             key: '7' },
  { id: 'draw',   icon: Pencil,        label: 'Draw',             key: '8' },
];

const COLOR_PALETTE = [
  '#ff2222', '#ff4d4d', '#ff7755', '#ff9933',
  '#ffb84d', '#ffd700', '#e8ff00', '#b8ff4d',
  '#66ff66', '#00ff88', '#00ffcc', '#00ffff',
  '#00ccff', '#4db8ff', '#4d9fff', '#4d6fff',
  '#7b68ff', '#9955ff', '#cc4dff', '#ee44cc',
  '#ff4dcf', '#ff4499', '#ff2266', '#cc1144',
  '#994422', '#775533', '#556633', '#336655',
  // DAW mixer channel colors (from reference design)
  '#7072a0', '#5a5c78', '#2a2d48', '#353858',
  '#88aa50', '#6a8040', '#2e3a20', '#3e5228',
  '#8850aa', '#6a4080', '#352240', '#5a3870',
  '#ffffff', '#d0d0d0', '#808080', '#1a1a1a',
];

const SNAP_VALUES = ['Off', '1/1', '1/2', '1/4', '1/8', '1/16', '1/32'];

interface TopToolbarProps {
  roomCode?: string;
  userRole?: 'artist' | 'engineer';
  onlineCount?: number;
  desktopActive?: boolean;
}

const TopToolbar: React.FC<TopToolbarProps> = ({ roomCode, userRole, onlineCount, desktopActive }) => {
  const { state, dispatch } = useDaw();
  const { activeTool, selectedTrackId, tracks } = state;

  const [showPalette, setShowPalette] = useState(false);
  const [showSnapMenu, setShowSnapMenu] = useState(false);

  const snapOn  = state.snapOn;
  const snapVal = state.snapValue;

  const paletteRef = useRef<HTMLDivElement>(null);
  const snapRef    = useRef<HTMLDivElement>(null);

  const selectedTrack = tracks.find(t => t.id === selectedTrackId);

  // Close palettes on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (paletteRef.current && !paletteRef.current.contains(e.target as Node)) setShowPalette(false);
      if (snapRef.current    && !snapRef.current.contains(e.target as Node))    setShowSnapMenu(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const applyColor = (color: string) => {
    if (!selectedTrackId) return;
    dispatch({ type: 'UPDATE_TRACK', payload: { id: selectedTrackId, updates: { color } } });
    setShowPalette(false);
  };

  return (
    <div className="top-toolbar">

      {/* ── flex spacer left ────────────────────────── */}
      <div className="toolbar-left" />

      {/* ── CENTER: color | tools | snap (all together) */}
      <div className="toolbar-center">

        {/* Tool buttons */}
        <div className="toolbar-section">
          {TOOLS.map(({ id, icon: Icon, label, key, iconStyle, isCustom }) => (
            <button
              key={id}
              className={`toolbar-btn ${activeTool === id ? 'active' : ''}`}
              onClick={() => dispatch({ type: 'SET_TOOL', payload: id })}
              title={`${label}  [${key}]`}
            >
              {isCustom
                ? <Icon />
                : <Icon size={15} style={iconStyle} />
              }
              <span className="tool-key">{key}</span>
            </button>
          ))}
        </div>

        <div className="toolbar-divider" />

        {/* Color picker */}
        <div className="toolbar-section" ref={paletteRef} style={{ position: 'relative' }}>
          <button
            className={`toolbar-btn color-pick-btn ${showPalette ? 'active' : ''}`}
            title={selectedTrack ? `Color: ${selectedTrack.name}` : 'Select a track first'}
            onClick={() => setShowPalette(v => !v)}
          >
            <Palette size={14} />
            <span className="color-swatch" style={{ backgroundColor: selectedTrack?.color ?? '#555' }} />
          </button>

          {showPalette && (
            <div className="color-palette-popup">
              <div className="palette-title">
                {selectedTrack ? selectedTrack.name : 'No track selected'}
              </div>
              <div className="palette-grid">
                {COLOR_PALETTE.map(c => (
                  <button
                    key={c}
                    className={`palette-cell ${selectedTrack?.color === c ? 'palette-active' : ''}`}
                    style={{ backgroundColor: c }}
                    onClick={() => applyColor(c)}
                    title={c}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="toolbar-divider" />

        {/* Snap / Grid */}
        <div className="toolbar-section grid-settings" ref={snapRef} style={{ position: 'relative' }}>
          <div
            className={`grid-toggle ${snapOn ? 'active' : ''}`}
            onClick={() => dispatch({ type: 'SET_SNAP', payload: { on: !snapOn, value: snapVal } })}
            title="Toggle Snap"
          >Snap</div>
          <div className="grid-type">Grid</div>
          <div
            className="grid-value"
            onClick={() => setShowSnapMenu(v => !v)}
            title="Snap value"
          >{snapVal}</div>

          {showSnapMenu && (
            <div className="snap-dropdown">
              {SNAP_VALUES.map(v => (
                <div
                  key={v}
                  className={`snap-item ${snapVal === v ? 'active' : ''}`}
                  onClick={() => { dispatch({ type: 'SET_SNAP', payload: { on: snapOn, value: v } }); setShowSnapMenu(false); }}
                >{v}</div>
              ))}
            </div>
          )}
        </div>

      </div>

      {/* ── flex spacer right ───────────────────────── */}
      <div className="toolbar-right" style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: '20px', gap: '10px' }}>

        {/* Session + Desktop Control status — shown when in a room */}
        {roomCode && (
          <div className="session-status-chip">
            <div className={`session-dot ${(onlineCount ?? 0) > 1 ? 'connected' : 'solo'}`} />
            <span className="session-status-label">
              {(onlineCount ?? 0) > 1 ? 'Session Connected' : 'Session Solo'}
            </span>
            <div className="session-status-sep" />
            <span className={`desktop-status-label ${desktopActive ? 'active' : ''}`}>
              Desktop: {desktopActive ? 'ACTIVE' : 'OFF'}
            </span>
          </div>
        )}

        {/* Room code badge */}
        {roomCode && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', backgroundColor: '#1a1b1e', padding: '4px 10px', borderRadius: '4px', border: '1px solid #333' }}>
            <span style={{ fontSize: '10px', color: '#888', textTransform: 'uppercase' }}>Session ID:</span>
            <span style={{ fontSize: '12px', fontWeight: 600, color: '#00ffcc', fontFamily: 'monospace', letterSpacing: '1px' }}>{roomCode}</span>
          </div>
        )}

        {/* Role badge */}
        {userRole && (
          <div style={{ fontSize: '11px', color: '#a0a0a0', textTransform: 'uppercase', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '6px' }}>
            <div style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: userRole === 'engineer' ? '#ff4d4d' : '#00ffcc' }} />
            {userRole}
          </div>
        )}
      </div>

    </div>
  );
};

export default TopToolbar;
