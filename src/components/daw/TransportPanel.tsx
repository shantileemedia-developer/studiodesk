import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Play, Square, Circle, SkipBack, SkipForward, Repeat,
  Activity, LayoutPanelLeft, LayoutPanelTop, Radio, ChevronUp, ChevronDown,
} from 'lucide-react';
import { useDaw } from '../../context/DawContext';
import './TransportPanel.css';

const SIG_NUMERATORS   = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16];
const SIG_DENOMINATORS = [1,2,4,8,16,32];
const TEMPO_PRESETS    = [60,70,80,90,100,110,120,128,140,150,160,170,180];

// ── Tempo Popover ────────────────────────────────────────────────────────────
const TempoPopover: React.FC<{ tempo: number; onClose: () => void; onCommit: (v: number) => void; onMouseEnter: () => void; onMouseLeave: () => void }> = ({ tempo, onClose, onCommit, onMouseEnter, onMouseLeave }) => {
  const [raw, setRaw] = useState(tempo.toFixed(1));
  const inputRef = useRef<HTMLInputElement>(null);
  const popRef   = useRef<HTMLDivElement>(null);
  const tapTimesRef = useRef<number[]>([]);

  useEffect(() => { inputRef.current?.select(); }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const commit = (val: string) => {
    const n = parseFloat(val);
    if (!isNaN(n) && n >= 20 && n <= 400) { onCommit(Math.round(n * 10) / 10); onClose(); }
  };

  const nudge = (delta: number) => {
    const n = parseFloat(raw);
    const next = Math.min(400, Math.max(20, (isNaN(n) ? tempo : n) + delta));
    const s = (Math.round(next * 10) / 10).toFixed(1);
    setRaw(s);
    onCommit(parseFloat(s));
  };

  const tap = () => {
    const now = performance.now();
    const times = tapTimesRef.current;
    if (times.length && now - times[times.length - 1] > 2500) times.length = 0;
    times.push(now);
    if (times.length >= 2) {
      const avg = (times[times.length - 1] - times[0]) / (times.length - 1);
      const bpm = Math.round((60000 / avg) * 10) / 10;
      const clamped = Math.min(400, Math.max(20, bpm));
      setRaw(clamped.toFixed(1));
      onCommit(clamped);
    }
  };

  return (
    <div ref={popRef} className="tp-popover tempo-popover" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      <div className="tpp-label">TEMPO</div>
      <div className="tpp-input-row">
        <button className="tpp-nudge" onClick={() => nudge(-1)} title="-1 BPM"><ChevronDown size={14}/></button>
        <input
          ref={inputRef}
          className="tpp-input"
          value={raw}
          onChange={e => setRaw(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') commit(raw);
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowUp')   { e.preventDefault(); nudge(e.shiftKey ? 0.1 : 1); }
            if (e.key === 'ArrowDown') { e.preventDefault(); nudge(e.shiftKey ? -0.1 : -1); }
            e.stopPropagation();
          }}
          onWheel={e => { e.preventDefault(); nudge(e.deltaY < 0 ? 1 : -1); }}
        />
        <button className="tpp-nudge" onClick={() => nudge(1)} title="+1 BPM"><ChevronUp size={14}/></button>
      </div>
      <div className="tpp-fine-row">
        <button className="tpp-fine-btn" onClick={() => nudge(-0.1)}>−0.1</button>
        <button className="tpp-tap-btn" onClick={tap}>TAP</button>
        <button className="tpp-fine-btn" onClick={() => nudge(0.1)}>+0.1</button>
      </div>
      <div className="tpp-presets">
        {TEMPO_PRESETS.map(p => (
          <button key={p} className={`tpp-preset ${Math.round(tempo) === p ? 'active' : ''}`}
            onClick={() => { onCommit(p); setRaw(p.toFixed(1)); onClose(); }}>
            {p}
          </button>
        ))}
      </div>
    </div>
  );
};

// ── Time Signature Popover ────────────────────────────────────────────────────
const SigPopover: React.FC<{ sig: [number,number]; onClose: () => void; onCommit: (s: [number,number]) => void; onMouseEnter: () => void; onMouseLeave: () => void }> = ({ sig, onClose, onCommit, onMouseEnter, onMouseLeave }) => {
  const [num, setNum] = useState(sig[0]);
  const [den, setDen] = useState(sig[1]);
  const popRef = useRef<HTMLDivElement>(null);
  const numRefs = useRef<Record<number, HTMLButtonElement | null>>({});
  const denRefs = useRef<Record<number, HTMLButtonElement | null>>({});

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        onCommit([num, den]); onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose, onCommit, num, den]);

  useEffect(() => { numRefs.current[num]?.scrollIntoView({ block: 'center' }); }, []);
  useEffect(() => { denRefs.current[den]?.scrollIntoView({ block: 'center' }); }, []);

  const apply = (n: number, d: number) => { setNum(n); setDen(d); onCommit([n, d]); };

  return (
    <div ref={popRef} className="tp-popover sig-popover" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      <div className="tpp-label">TIME SIGNATURE</div>
      <div className="sig-lists">
        <div className="sig-list-col">
          <div className="sig-list-header">Beats</div>
          <div className="sig-list-scroll">
            {SIG_NUMERATORS.map(n => (
              <button key={n}
                ref={el => { numRefs.current[n] = el; }}
                className={`sig-list-item ${num === n ? 'active' : ''}`}
                onClick={() => apply(n, den)}>
                {n}
              </button>
            ))}
          </div>
        </div>
        <div className="sig-list-divider" />
        <div className="sig-list-col">
          <div className="sig-list-header">Division</div>
          <div className="sig-list-scroll">
            {SIG_DENOMINATORS.map(d => (
              <button key={d}
                ref={el => { denRefs.current[d] = el; }}
                className={`sig-list-item ${den === d ? 'active' : ''}`}
                onClick={() => apply(num, d)}>
                {d}
              </button>
            ))}
          </div>
        </div>
      </div>
      <button className="sig-ok-btn" onClick={() => { onCommit([num, den]); onClose(); }}>OK</button>
    </div>
  );
};

interface TransportPanelProps {
  toggleInspector: () => void;
  toggleMixer: () => void;
  onPlay: () => void;
  onStop: () => void;
  onReturnToZero: () => void;
  onRecord: () => void;
  userRole?: 'artist' | 'engineer';
  isStreaming?: boolean;
  isReceiving?: boolean;
  onToggleStream?: () => void;
}

const formatTime = (s: number): string => {
  const h  = Math.floor(s / 3600);
  const m  = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const ms = Math.floor((s % 1) * 1000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}.${String(ms).padStart(3,'0')}`;
};

const toBarsBeats = (seconds: number, tempo: number): string => {
  const totalBeats = seconds * (tempo / 60);
  const bar   = Math.floor(totalBeats / 4) + 1;
  const beat  = Math.floor(totalBeats % 4) + 1;
  const tick  = Math.floor((totalBeats % 1) * 240);
  return `${String(bar).padStart(3,' ')}.${beat}.1.${String(tick).padStart(3,'0')}`;
};

const TransportPanel: React.FC<TransportPanelProps> = ({
  toggleInspector, toggleMixer, onPlay, onStop, onReturnToZero, onRecord,
  userRole, isStreaming = false, isReceiving = false, onToggleStream,
}) => {
  const { state, dispatch, currentTimeRef } = useDaw();
  const { isPlaying, isRecording, currentTime, tempo, timeSignature, isLooping } = state.transport;

  const timeDisplayRef = useRef<HTMLDivElement>(null);
  const barsDisplayRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);

  const [showTempoPop, setShowTempoPop] = useState(false);
  const [showSigPop,   setShowSigPop]   = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = () => {
    if (closeTimerRef.current !== null) { clearTimeout(closeTimerRef.current); closeTimerRef.current = null; }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimerRef.current = setTimeout(() => { setShowTempoPop(false); setShowSigPop(false); }, 200);
  };
  const openTempo = () => { cancelClose(); setShowSigPop(false); setShowTempoPop(true); };
  const openSig   = () => { cancelClose(); setShowTempoPop(false); setShowSigPop(true); };

  const commitTempo = useCallback((v: number) => dispatch({ type: 'SET_TEMPO', payload: v }), [dispatch]);
  const commitSig   = useCallback((s: [number,number]) => dispatch({ type: 'SET_TIME_SIGNATURE', payload: s }), [dispatch]);

  // Update time display at 60fps via direct DOM — no React re-renders
  useEffect(() => {
    const tick = () => {
      if (timeDisplayRef.current)
        timeDisplayRef.current.textContent = formatTime(currentTimeRef.current);
      if (barsDisplayRef.current)
        barsDisplayRef.current.textContent = toBarsBeats(currentTimeRef.current, tempo);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [currentTimeRef, tempo]);

  return (
    <div className="transport-panel">
      {/* Left spacer — mirrors right group width so main controls stay truly centered */}
      <div className="transport-spacer" />

      {/* Center: all main transport controls */}
      <div className="transport-main-controls">
        {/* Layout toggles */}
        <div className="transport-section">
          <button className="transport-btn layout-btn" onClick={toggleInspector} title="Toggle Inspector">
            <LayoutPanelLeft size={18} />
          </button>
          <button className="transport-btn layout-btn" onClick={toggleMixer} title="Toggle Mixer">
            <LayoutPanelTop size={18} />
          </button>
        </div>

        {/* Playback buttons */}
        <div className="transport-section transport-main">
          <button className="transport-btn" onClick={onReturnToZero} title="Return to Zero">
            <SkipBack size={20} fill="currentColor" />
          </button>
          <button className="transport-btn" onClick={() => {
            const end = state.regions.length > 0
              ? Math.max(...state.regions.map(r => r.startTime + r.duration))
              : 0;
            currentTimeRef.current = end;
            dispatch({ type: 'SET_CURRENT_TIME', payload: end });
          }} title="Go to End">
            <SkipForward size={20} fill="currentColor" />
          </button>
          <button className="transport-btn stop-btn" onClick={onStop} title="Stop">
            <Square size={18} fill="currentColor" />
          </button>
          <button
            className={`transport-btn play-btn ${isPlaying && !isRecording ? 'active' : ''}`}
            onClick={() => { if (!isPlaying) onPlay(); }}
            title="Play"
          >
            <Play size={20} fill="currentColor" />
          </button>
          <button
            className={`transport-btn record-btn ${isRecording ? 'active' : ''}`}
            onClick={isRecording ? onStop : onRecord}
            title={isRecording ? 'Stop Recording' : 'Record'}
          >
            <Circle size={16} fill="currentColor" />
          </button>
          <button
            className={`transport-btn loop-btn ${isLooping ? 'active' : ''}`}
            onClick={() => dispatch({ type: 'TOGGLE_LOOP' })}
            title="Toggle Loop"
          >
            <Repeat size={18} />
          </button>
        </div>

        {/* Time display — direct DOM updates at 60fps */}
        <div className="transport-section time-display">
          <div className="time-primary" ref={timeDisplayRef}>{formatTime(currentTime)}</div>
          <div className="time-secondary" ref={barsDisplayRef}>{toBarsBeats(currentTime, tempo)}</div>
        </div>

        {/* Tempo & Signature */}
        <div className="transport-section tempo-section" style={{ position: 'relative' }}>
          <div
            className={`tempo-box ${showTempoPop ? 'active-pop' : ''}`}
            title="Hover to edit tempo"
            onMouseEnter={openTempo}
            onMouseLeave={scheduleClose}
            onWheel={e => {
              e.preventDefault();
              const delta = e.shiftKey ? 0.1 : 1;
              const next = Math.min(400, Math.max(20, tempo + (e.deltaY < 0 ? delta : -delta)));
              commitTempo(Math.round(next * 10) / 10);
            }}
          >
            <span className="label">TEMPO</span>
            <span className="value">{tempo.toFixed(1)}</span>
          </div>
          {showTempoPop && (
            <TempoPopover tempo={tempo} onClose={() => setShowTempoPop(false)} onCommit={commitTempo} onMouseEnter={cancelClose} onMouseLeave={scheduleClose} />
          )}
          <div
            className={`tempo-box ${showSigPop ? 'active-pop' : ''}`}
            title="Hover to edit time signature"
            onMouseEnter={openSig}
            onMouseLeave={scheduleClose}
          >
            <span className="label">SIGNATURE</span>
            <span className="value">{timeSignature[0]}/{timeSignature[1]}</span>
          </div>
          {showSigPop && (
            <SigPopover sig={timeSignature} onClose={() => setShowSigPop(false)} onCommit={commitSig} onMouseEnter={cancelClose} onMouseLeave={scheduleClose} />
          )}
          <div className={`tempo-box click-box ${state.transport.metronomeOn ? 'active' : ''}`} onClick={() => dispatch({ type: 'TOGGLE_METRONOME' })} style={{ cursor: 'pointer' }}>
            <span className="label">CLICK</span>
            <span className="value" style={{ color: state.transport.metronomeOn ? '#ff4d4d' : undefined }}>
              {state.transport.metronomeOn ? 'ON' : 'OFF'}
            </span>
          </div>
          <div className={`tempo-box click-box ${state.transport.countInBars > 0 ? 'active' : ''}`} onClick={() => dispatch({ type: 'SET_COUNT_IN', payload: state.transport.countInBars === 0 ? 1 : 0 })} style={{ cursor: 'pointer' }}>
            <span className="label">COUNT</span>
            <span className="value">
              {state.transport.countInBars > 0 ? `${state.transport.countInBars}B` : 'OFF'}
            </span>
          </div>
        </div>

        {/* Perf meter */}
        <div className="transport-section perf-meter">
          <Activity size={14} color="#a0a0a0" />
          <div className="meter-bar">
            <div className="meter-fill" style={{ width: isPlaying ? '35%' : '5%' }} />
          </div>
        </div>
      </div>

      {/* Right group: video pill slot + stream indicator — pill is leftmost so it clips first */}
      <div className="transport-right-group">
        <div id="transport-chat-slot" />
        <div className={`transport-section stream-section ${isStreaming ? 'streaming' : ''} ${isReceiving ? 'receiving' : ''}`}>
          {userRole === 'artist' ? (
            <button
              className={`stream-btn ${isStreaming ? 'active' : ''}`}
              onClick={onToggleStream}
              title={isStreaming ? 'Stop streaming output' : 'Stream stereo output live'}
            >
              <Radio size={13} />
              <span className="stream-label">{isStreaming ? 'LIVE' : 'STREAM'}</span>
              {isStreaming && <span className="stream-live-dot" />}
            </button>
          ) : (
            <div className={`stream-rx-indicator ${isReceiving ? 'active' : ''}`}>
              <span className={`stream-live-dot ${isReceiving ? 'active' : ''}`} />
              <span className="stream-label">{isReceiving ? 'ARTIST LIVE' : 'NO STREAM'}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default TransportPanel;
