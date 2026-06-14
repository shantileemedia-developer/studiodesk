import React, { useRef, useEffect, useLayoutEffect, useState } from 'react';
import { useDaw } from '../../context/DawContext';
import type { Track } from '../../context/DawContext';
import './MixerPanel.css';

// ── dB / fader math ────────────────────────────────────────────────────────────
const dbToY = (db: number, h: number): number => {
  if (db >= 0)   return (0.50 - (db / 12) * 0.50) * h;
  if (db >= -60) return (0.50 + (db / -60) * 0.45) * h;
  return 0.98 * h;
};

const yToDb = (y: number, h: number): number => {
  const p = y / h;
  if (p <= 0.50) return 12 - (p / 0.50) * 12;
  if (p <= 0.95) return -60 * ((p - 0.50) / 0.45);
  return -60;
};

const volToFaderY = (vol: number, tH: number): number => {
  const v  = isFinite(vol) && vol > 0 ? vol : 0;
  const db = v < 0.00001 ? -60 : Math.max(-60, Math.min(12, 20 * Math.log10(v / 0.8)));
  return dbToY(db, tH);
};
const faderYToVol = (y: number, tH: number): number => {
  const db = yToDb(Math.max(0, Math.min(tH, y)), tH);
  return db <= -60 ? 0 : Math.pow(10, db / 20) * 0.8;
};
const volToDbStr = (vol: number): string => {
  if (!isFinite(vol) || vol < 0.00001) return '-∞';
  const db = 20 * Math.log10(vol / 0.8);
  if (Math.abs(db) < 0.1) return '0.0';
  return (db > 0 ? '+' : '') + db.toFixed(1);
};

// ── Segmented LED Meter ────────────────────────────────────────────────────────
interface MeterProps {
  analyserRef: React.MutableRefObject<Record<string, AnalyserNode>>;
  trackId: string;
  height?: number;
}

const Meter: React.FC<MeterProps> = ({ analyserRef, trackId, height = 180 }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef  = useRef({ display: -60, peakHold: -60, peakAt: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const W = canvas.width, H = canvas.height;
    const SEG = 2, GAP = 1, STEP = SEG + GAP;
    let raf = 0;

    const draw = () => {
      const s  = stateRef.current;
      const an = analyserRef.current[trackId];
      let rawDb = -60;
      if (an) {
        const buf = new Float32Array(an.fftSize);
        an.getFloatTimeDomainData(buf);
        let sq = 0;
        for (let i = 0; i < buf.length; i++) sq += buf[i] * buf[i];
        const rms = Math.sqrt(sq / buf.length);
        rawDb = rms > 0.00001 ? Math.max(-60, 20 * Math.log10(rms)) : -60;
      }

      s.display = rawDb > s.display
        ? 0.55 * s.display + 0.45 * rawDb
        : 0.975 * s.display + 0.025 * rawDb;

      const now = performance.now();
      if (s.display > s.peakHold) {
        s.peakHold = s.display;
        s.peakAt   = now + 1800;
      } else if (now > s.peakAt) {
        s.peakHold = Math.max(-60, s.peakHold - 0.15);
      }

      ctx.fillStyle = '#060806';
      ctx.fillRect(0, 0, W, H);

      const fillY = dbToY(s.display, H);
      for (let y = H - STEP; y >= 0; y -= STEP) {
        const db  = yToDb(y + SEG / 2, H);
        const lit = y + STEP > fillY;
        ctx.fillStyle = lit
          ? (db > 0 ? '#FF3B30' : db > -6 ? '#FFD600' : '#00E5A0')
          : (db > 0 ? '#3A0A08' : db > -6 ? '#2A2000' : '#08200E');
        ctx.fillRect(1, y, W - 2, SEG);
      }

      if (s.peakHold > -58) {
        const py   = dbToY(s.peakHold, H);
        const fade = Math.max(0, Math.min(1, (s.peakAt - now) / 400));
        ctx.globalAlpha = fade;
        ctx.fillStyle   = s.peakHold > 0 ? '#FF3B30' : s.peakHold > -6 ? '#FFD600' : '#00E5A0';
        ctx.fillRect(0, py, W, 2);
        ctx.globalAlpha = 1;
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [analyserRef, trackId]);

  return <canvas ref={canvasRef} width={14} height={height} className="mixer-vu-canvas" />;
};

// ── Vertical Fader ─────────────────────────────────────────────────────────────
interface VerticalFaderProps {
  value: number;
  onChange: (v: number) => void;
  isMaster?: boolean;
}

const VerticalFader: React.FC<VerticalFaderProps> = ({ value, onChange, isMaster = false }) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [tH, setTH] = useState(180);
  const cbRef = useRef(onChange); cbRef.current = onChange;

  // Measure the track wrap height and keep it updated on resize
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const h = el.getBoundingClientRect().height;
      if (h > 0) setTH(h);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const capH    = 28;
  const travelH = Math.max(0, tH - capH);
  const capY    = Math.round(Math.max(0, Math.min(travelH, volToFaderY(value, travelH))));

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const startY    = e.clientY;
    const startCapY = capY;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    const onMove = (me: PointerEvent) => {
      const newY = Math.max(0, Math.min(travelH, startCapY + (me.clientY - startY)));
      cbRef.current(Math.max(0, Math.min(3.0, faderYToVol(newY, travelH))));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div className="vfader-wrap">
      {/* Track groove — ref here so ResizeObserver sees the actual flexible height */}
      <div className={`pt-fader-track-wrap${isMaster ? ' vfader-master' : ''}`} ref={wrapRef}>
        <div
          className="vfader-track"
          onDoubleClick={() => cbRef.current(0.8)}
          title="Double-click: unity (0 dB)"
        />
        <div
          className="vfader-cap"
          style={{ top: capY }}
          onPointerDown={onPointerDown}
        />
      </div>
    </div>
  );
};

// ── Pan Knob ───────────────────────────────────────────────────────────────────
let _panId = 0;
const PanKnob: React.FC<{ pan: number; onChange: (v: number) => void }> = ({ pan: rawPan, onChange }) => {
  const gId   = useRef(`pk${++_panId}`).current;
  const pan   = isFinite(rawPan) ? rawPan : 0;
  const size  = 30;
  const drag  = useRef(false), sy = useRef(0), sv = useRef(0);
  const cbRef = useRef(onChange); cbRef.current = onChange;

  useEffect(() => {
    const mm = (e: MouseEvent) => {
      if (!drag.current) return;
      cbRef.current(Math.max(-1, Math.min(1, sv.current + (sy.current - e.clientY) / 60)));
    };
    const mu = () => { drag.current = false; };
    document.addEventListener('mousemove', mm);
    document.addEventListener('mouseup',   mu);
    return () => {
      document.removeEventListener('mousemove', mm);
      document.removeEventListener('mouseup',   mu);
    };
  }, []);

  const cx = size / 2, cy = size / 2, r = size / 2 - 2;
  const angle = pan * 135;
  const rad   = (angle - 90) * Math.PI / 180;
  const dx = cx + Math.cos(rad) * (r - 2);
  const dy = cy + Math.sin(rad) * (r - 2);

  return (
    <div className="pan-wrap" title="Pan">
      <svg
        width={size}
        height={size}
        onMouseDown={e => { e.preventDefault(); drag.current = true; sy.current = e.clientY; sv.current = pan; }}
        onDoubleClick={() => cbRef.current(0)}
        style={{ display: 'block' }}
      >
        <defs>
          <radialGradient id={gId} cx="35%" cy="30%" r="65%">
            <stop offset="0%"   stopColor="#555" />
            <stop offset="100%" stopColor="#1A1A1A" />
          </radialGradient>
        </defs>
        <circle cx={cx} cy={cy} r={r + 1} fill="#111" />
        <circle cx={cx} cy={cy} r={r} fill={`url(#${gId})`} stroke="#222" strokeWidth={1} />
        <line x1={cx} y1={cy} x2={dx} y2={dy} stroke="#00FF00" strokeWidth={2.5} strokeLinecap="round" />
      </svg>
    </div>
  );
};

// ── Channel Strip ──────────────────────────────────────────────────────────────
interface ChannelStripProps {
  track: Track;
  trackAnalysersRef: React.MutableRefObject<Record<string, AnalyserNode>>;
  isSelected: boolean;
  onClick: () => void;
}

const ChannelStrip: React.FC<ChannelStripProps> = ({ track, trackAnalysersRef, isSelected, onClick }) => {
  const { dispatch } = useDaw();

  const setVolume = (v: number) =>
    dispatch({ type: 'UPDATE_TRACK', payload: { id: track.id, updates: { volume: v } } });
  const setPan = (p: number) =>
    dispatch({ type: 'UPDATE_TRACK', payload: { id: track.id, updates: { pan: p } } });
  const setName = (n: string) =>
    dispatch({ type: 'UPDATE_TRACK', payload: { id: track.id, updates: { name: n } } });

  const stop = (e: React.MouseEvent) => e.stopPropagation();
  const toggleMute = (e: React.MouseEvent) => {
    stop(e);
    dispatch({ type: 'UPDATE_TRACK', payload: { id: track.id, updates: { isMuted: !track.isMuted } } });
  };
  const toggleSolo = (e: React.MouseEvent) => {
    stop(e);
    dispatch({ type: 'UPDATE_TRACK', payload: { id: track.id, updates: { isSolo: !track.isSolo } } });
  };
  const toggleArm = (e: React.MouseEvent) => {
    stop(e);
    dispatch({ type: 'UPDATE_TRACK', payload: { id: track.id, updates: { isArmed: !track.isArmed } } });
  };

  const panVal = Math.round(Math.abs(track.pan) * 100);
  const panStr = track.pan === 0 ? '  0  ' : track.pan < 0 ? `${panVal} ` : ` ${panVal}`;

  return (
    <div className={`mixer-ch${isSelected ? ' sel' : ''}`} onClick={onClick}>
      {/* Pan */}
      <div className="pt-pan-area" style={{ marginTop: '4px' }}>
        <div className="pt-pan-knobs">
          <PanKnob pan={track.pan} onChange={setPan} />
        </div>
        <div className="pt-pan-readout">
          <span className="arr" style={{ opacity: track.pan < 0 ? 1 : 0.2 }}>&lt;</span>
          <span className="val">{panStr}</span>
          <span className="arr" style={{ opacity: track.pan > 0 ? 1 : 0.2 }}>&gt;</span>
        </div>
      </div>

      {/* Buttons: I R S M */}
      <div className="pt-btn-grid">
        <button className="pt-sq-btn">I</button>
        <button className={`pt-sq-btn rec${track.isArmed ? ' on' : ''}`} onClick={toggleArm}>
          <div className="dot" />
        </button>
        <button className={`pt-sq-btn solo${track.isSolo ? ' on' : ''}`} onClick={toggleSolo}>S</button>
        <button className={`pt-sq-btn mute${track.isMuted ? ' on' : ''}`} onClick={toggleMute}>M</button>
      </div>

      {/* Fader + Meter */}
      <div className="pt-fader-area">
        <VerticalFader
          value={isFinite(track.volume) ? track.volume : 0.8}
          onChange={setVolume}
        />
        <div className="pt-meter-wrap">
          <Meter analyserRef={trackAnalysersRef} trackId={track.id} />
        </div>
      </div>

      {/* Volume readout */}
      <div className="pt-vol-readout">
        <span className="vol-val">∆ {volToDbStr(track.volume)}</span>
        <span className="vol-peak">-∞</span>
      </div>

      {/* Track name */}
      <div className="pt-track-name">
        <div className="pt-track-color" style={{ background: track.color }} />
        <input
          className="pt-track-name-input"
          value={track.name}
          onChange={e => setName(e.target.value)}
          onClick={stop}
        />
      </div>
    </div>
  );
};

// ── Master Strip ───────────────────────────────────────────────────────────────
const MasterStrip: React.FC<{
  vol: number; pan: number;
  onVol: (v: number) => void; onPan: (v: number) => void;
  analyserRef: React.MutableRefObject<Record<string, AnalyserNode>>;
}> = ({ vol, pan, onVol, onPan, analyserRef }) => {
  const firstKey = Object.keys(analyserRef.current)[0] ?? '__none__';
  const panVal = Math.round(Math.abs(pan) * 100);
  const panStr = pan === 0 ? '  0  ' : pan < 0 ? `${panVal} ` : ` ${panVal}`;

  return (
    <div className="mixer-ch mixer-master">
      <div className="pt-pan-area" style={{ marginTop: '4px' }}>
        <div className="pt-pan-knobs">
          <PanKnob pan={pan} onChange={onPan} />
        </div>
        <div className="pt-pan-readout">
          <span className="arr" style={{ opacity: pan < 0 ? 1 : 0.2 }}>&lt;</span>
          <span className="val">{panStr}</span>
          <span className="arr" style={{ opacity: pan > 0 ? 1 : 0.2 }}>&gt;</span>
        </div>
      </div>

      <div className="pt-btn-grid">
        <button className="pt-sq-btn" style={{ opacity: 0.4 }}>I</button>
        <button className="pt-sq-btn" style={{ opacity: 0.4 }}><div className="dot" /></button>
        <button className="pt-sq-btn" style={{ opacity: 0.4 }}>S</button>
        <button className="pt-sq-btn" style={{ opacity: 0.4 }}>M</button>
      </div>

      <div className="pt-fader-area">
        <VerticalFader value={isFinite(vol) ? vol : 0.8} onChange={onVol} isMaster />
        <div className="pt-meter-wrap">
          <Meter analyserRef={analyserRef} trackId={firstKey} />
        </div>
      </div>

      <div className="pt-vol-readout">
        <span className="vol-val">∆ {volToDbStr(vol)}</span>
        <span className="vol-peak">-∞</span>
      </div>

      <div className="pt-track-name">
        <div className="pt-track-color" style={{ background: '#A02020' }} />
        <div className="pt-track-name-input" style={{ pointerEvents: 'none' }}>Master</div>
      </div>
    </div>
  );
};

// ── Mixer Panel ────────────────────────────────────────────────────────────────
const MixerPanel: React.FC = () => {
  const { state, dispatch, trackAnalysersRef } = useDaw();
  const [masterVol, setMasterVol] = useState(0.8);
  const [masterPan, setMasterPan] = useState(0);

  return (
    <div className="mixer-panel">
      <div className="mixer-header">
        <span className="mixer-header-label">
          <span className="mixer-header-key">F3</span> MIXER
        </span>
        <span className="mixer-header-info">{state.tracks.length} tracks · Stereo Out</span>
      </div>

      <div className="mixer-body">
        <div className="mixer-channels">
          {state.tracks.map(track => (
            <ChannelStrip
              key={track.id}
              track={track}
              trackAnalysersRef={trackAnalysersRef}
              isSelected={state.selectedTrackId === track.id}
              onClick={() => dispatch({ type: 'SELECT_TRACK', payload: track.id })}
            />
          ))}
        </div>

        <div className="mixer-master-divider" />

        <MasterStrip
          vol={masterVol} pan={masterPan}
          onVol={setMasterVol} onPan={setMasterPan}
          analyserRef={trackAnalysersRef}
        />
      </div>
    </div>
  );
};

export default MixerPanel;
