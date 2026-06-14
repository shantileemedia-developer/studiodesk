import React, { useRef, useEffect, useLayoutEffect, useState } from 'react';
import ReactDOM from 'react-dom';
import { useDaw } from '../../context/DawContext';
import type { Track } from '../../context/DawContext';
import './MixerPanel.css';

/* ── dB / fader math ─────────────────────────────────────────────────────────── */
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

/* ── Color helper ────────────────────────────────────────────────────────────── */
const scaleHex = (hex: string, factor: number): string => {
  const c = hex.replace('#', '');
  if (c.length !== 6) return '#2a2a2a';
  const r = Math.round(Math.min(255, parseInt(c.slice(0, 2), 16) * factor));
  const g = Math.round(Math.min(255, parseInt(c.slice(2, 4), 16) * factor));
  const b = Math.round(Math.min(255, parseInt(c.slice(4, 6), 16) * factor));
  return `rgb(${r},${g},${b})`;
};

/* ── Color palette (same as TopToolbar) ─────────────────────────────────────── */
const MIXER_PALETTE = [
  '#ff2222','#ff4d4d','#ff7755','#ff9933',
  '#ffb84d','#ffd700','#e8ff00','#b8ff4d',
  '#66ff66','#00ff88','#00ffcc','#00ffff',
  '#00ccff','#4db8ff','#4d9fff','#4d6fff',
  '#7b68ff','#9955ff','#cc4dff','#ee44cc',
  '#ff4dcf','#ff4499','#ff2266','#cc1144',
  '#994422','#775533','#556633','#336655',
  '#7072a0','#5a5c78','#88aa50','#6a8040',
  '#8850aa','#6a4080','#353858','#3e5228',
  '#ffffff','#d0d0d0','#808080','#1a1a1a',
];

/* ── Scale marks ─────────────────────────────────────────────────────────────── */
const DB_SCALE_MARKS = [
  { db: 12,  pct: 2    },
  { db: 6,   pct: 9    },
  { db: 3,   pct: 14   },
  { db: 0,   pct: 21   },
  { db: -6,  pct: 34   },
  { db: -12, pct: 47   },
  { db: -15, pct: 54   },
  { db: -20, pct: 63   },
  { db: -35, pct: 79   },
  { db: -40, pct: 86   },
  { db: -60, pct: 96   },
];

/* ── Pan LCD text helpers ────────────────────────────────────────────────────── */
const panLcdLeft = (pan: number): string => {
  if (!isFinite(pan) || Math.abs(pan) < 0.01) return 'pan.';
  const v = Math.round(Math.abs(pan) * 100);
  return pan < 0 ? `-${v}` : `+${v}`;
};
const panLcdRight = (pan: number): string => {
  if (!isFinite(pan) || Math.abs(pan) < 0.01) return '0   R';
  const v = Math.round(Math.abs(pan) * 100);
  return pan < 0 ? `${v} L` : `${v} R`;
};

/* ── Single-column VU meter ──────────────────────────────────────────────────── */
interface SingleMeterProps {
  analyserRef: React.MutableRefObject<Record<string, AnalyserNode>>;
  trackId: string;
  channel: 'L' | 'R';
}

const SingleMeter: React.FC<SingleMeterProps> = ({ analyserRef, trackId, channel }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef  = useRef({ display: -60, peakHold: -60, peakAt: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;

    const draw = () => {
      const W = canvas.width, H = canvas.height;
      const s = stateRef.current;
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
      if (channel === 'R') rawDb -= Math.random() * 0.6;

      s.display = rawDb > s.display
        ? 0.55 * s.display + 0.45 * rawDb
        : 0.975 * s.display + 0.025 * rawDb;

      const now = performance.now();
      if (s.display > s.peakHold) { s.peakHold = s.display; s.peakAt = now + 1800; }
      else if (now > s.peakAt) s.peakHold = Math.max(-60, s.peakHold - 0.15);

      ctx.fillStyle = '#080a10';
      ctx.fillRect(0, 0, W, H);

      const segs = 40, sh = H / segs, gap = 0.8;
      for (let i = 0; i < segs; i++) {
        const y   = H - (i + 1) * sh;
        const rel = i / segs;
        const db  = yToDb(y + sh / 2, H);
        const lit = db <= s.display;
        let color: string;
        if (lit) {
          if (rel > 0.85)       color = '#ff2200';
          else if (rel > 0.72)  color = '#cc9900';
          else if (rel > 0.55)  color = '#88bb00';
          else                  color = '#00aa00';
        } else {
          color = '#071209'; // all unlit segments: uniform dark green
        }
        ctx.fillStyle = color;
        ctx.fillRect(1, y + gap, W - 2, sh - gap);
      }

      if (s.peakHold > -58) {
        const py   = dbToY(s.peakHold, H);
        const fade = Math.max(0, Math.min(1, (s.peakAt - now) / 400));
        ctx.globalAlpha = fade;
        ctx.fillStyle = s.peakHold > 0 ? '#ff3b30' : s.peakHold > -6 ? '#ffd600' : '#00e5a0';
        ctx.fillRect(0, py, W, 2);
        ctx.globalAlpha = 1;
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [analyserRef, trackId, channel]);

  return <canvas ref={canvasRef} width={9} height={290} className="mixer-vu-canvas" />;
};

/* ── Peak dB display (RAF-driven, no React state) ────────────────────────────── */
interface PeakDisplayProps {
  analyserRef: React.MutableRefObject<Record<string, AnalyserNode>>;
  trackId: string;
}

const PeakDisplay: React.FC<PeakDisplayProps> = ({ analyserRef, trackId }) => {
  const lRef = useRef<HTMLSpanElement>(null);
  const rRef = useRef<HTMLSpanElement>(null);
  const peakL = useRef(-60), peakR = useRef(-60);
  const peakLat = useRef(0), peakRat = useRef(0);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const an = analyserRef.current[trackId];
      const now = performance.now();
      let db = -60;
      if (an) {
        const buf = new Float32Array(an.fftSize);
        an.getFloatTimeDomainData(buf);
        let sq = 0;
        for (let i = 0; i < buf.length; i++) sq += buf[i] * buf[i];
        const rms = Math.sqrt(sq / buf.length);
        db = rms > 0.00001 ? Math.max(-60, 20 * Math.log10(rms)) : -60;
      }
      const dbL = db, dbR = db - Math.random() * 0.8;

      if (dbL > peakL.current) { peakL.current = dbL; peakLat.current = now + 2000; }
      else if (now > peakLat.current) peakL.current = Math.max(-60, peakL.current - 0.15);
      if (dbR > peakR.current) { peakR.current = dbR; peakRat.current = now + 2000; }
      else if (now > peakRat.current) peakR.current = Math.max(-60, peakR.current - 0.15);

      const fmtPeak = (v: number) => v <= -60 ? '-∞' : (v > 0 ? '+' : '') + v.toFixed(1);
      const colorFor = (v: number) => v >= 0 ? '#ff3300' : v > -3 ? '#ddcc00' : '#22cc22';

      if (lRef.current) {
        lRef.current.textContent  = fmtPeak(peakL.current);
        lRef.current.style.color  = colorFor(peakL.current);
      }
      if (rRef.current) {
        rRef.current.textContent  = fmtPeak(peakR.current);
        rRef.current.style.color  = colorFor(peakR.current);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [analyserRef, trackId]);

  return (
    <div className="mch-peak-box">
      <span className="mch-pv" ref={lRef}>-∞</span>
      <span className="mch-pv" ref={rRef}>-∞</span>
    </div>
  );
};

/* ── Vertical Fader ──────────────────────────────────────────────────────────── */
interface VerticalFaderProps {
  value: number;
  onChange: (v: number) => void;
  isMaster?: boolean;
  capColor?: string;
}

const VerticalFader: React.FC<VerticalFaderProps> = ({ value, onChange, isMaster = false, capColor }) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [tH, setTH] = useState(160);
  const cbRef = useRef(onChange); cbRef.current = onChange;

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => { const h = el.getBoundingClientRect().height; if (h > 0) setTH(h); };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const CAP_H   = 20;
  const travelH = Math.max(0, tH - CAP_H);
  const capY    = Math.round(Math.max(0, Math.min(travelH, volToFaderY(value, travelH))));

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault(); e.stopPropagation();
    const startY = e.clientY, startCapY = capY;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const onMove = (me: PointerEvent) => {
      const newY = Math.max(0, Math.min(travelH, startCapY + (me.clientY - startY)));
      cbRef.current(Math.max(0, Math.min(3.0, faderYToVol(newY, travelH))));
    };
    const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  /* Fader cap colors */
  const capBg   = capColor
    ? `linear-gradient(180deg,${scaleHex(capColor, 0.55)} 0%,${scaleHex(capColor, 0.32)} 100%)`
    : isMaster
      ? 'linear-gradient(180deg,#703030 0%,#3c1818 100%)'
      : 'linear-gradient(180deg,#5a5c78 0%,#30324a 100%)';
  const capLine = capColor
    ? scaleHex(capColor, 0.85)
    : isMaster ? '#b06060' : '#7072a0';

  return (
    <div className={`vfader-wrap${isMaster ? ' vfader-master' : ''}`} ref={wrapRef}>
      <div className="vfader-track" onDoubleClick={() => cbRef.current(0.8)} title="Double-click: unity (0 dB)" />
      <div
        className="vfader-cap"
        style={{
          top: capY,
          background: capBg,
          borderTop: `1px solid ${capLine}`,
          borderLeft: `1px solid ${capLine}`,
          borderBottom: '1px solid #111',
          borderRight: '1px solid #111',
        }}
        onPointerDown={onPointerDown}
      >
        <div className="vfader-grip" style={{ background: `${capLine}66` }} />
        <div className="vfader-grip" style={{ background: 'rgba(255,255,255,0.2)' }} />
        <div className="vfader-grip" style={{ background: `${capLine}66` }} />
      </div>
    </div>
  );
};

/* ── Pan Knob — canvas, matches reference HTML drawKnob() exactly ────────────── */
const PanKnob: React.FC<{ pan: number; onChange: (v: number) => void }> = ({ pan: rawPan, onChange }) => {
  const pan    = isFinite(rawPan) ? rawPan : 0;
  const cvRef  = useRef<HTMLCanvasElement>(null);
  const drag   = useRef(false), sy = useRef(0), sv = useRef(0);
  const cbRef  = useRef(onChange); cbRef.current = onChange;

  useEffect(() => {
    const canvas = cvRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const s = canvas.width, r = s / 2;
    ctx.clearRect(0, 0, s, s);

    // Body gradient
    const g = ctx.createRadialGradient(r - 3, r - 4, 1, r, r, r - 0.5);
    g.addColorStop(0, '#3a3a3a'); g.addColorStop(0.5, '#1a1a1a'); g.addColorStop(1, '#080808');
    ctx.beginPath(); ctx.arc(r, r, r - 0.5, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill();

    // Outer ring
    ctx.beginPath(); ctx.arc(r, r, r - 0.5, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.beginPath(); ctx.arc(r, r, r - 4,   0, Math.PI * 2); ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 1; ctx.stroke();

    // Rotating white indicator — center at 12 o'clock, ±135° range
    const angle = -Math.PI / 2 + pan * (3 * Math.PI / 4);
    const ix = r + Math.cos(angle) * (r - 5);
    const iy = r + Math.sin(angle) * (r - 5);
    ctx.beginPath(); ctx.moveTo(r, r); ctx.lineTo(ix, iy);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.stroke();
    ctx.beginPath(); ctx.arc(ix, iy, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fill();

    // Shine overlay
    const shine = ctx.createRadialGradient(r - 4, r - 5, 0, r - 2, r - 3, 8);
    shine.addColorStop(0, 'rgba(255,255,255,0.12)'); shine.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.beginPath(); ctx.arc(r, r, r - 1, 0, Math.PI * 2); ctx.fillStyle = shine; ctx.fill();
  }, [pan]);

  useEffect(() => {
    const mm = (e: MouseEvent) => {
      if (!drag.current) return;
      cbRef.current(Math.max(-1, Math.min(1, sv.current + (sy.current - e.clientY) / 60)));
    };
    const mu = () => { drag.current = false; };
    document.addEventListener('mousemove', mm);
    document.addEventListener('mouseup',   mu);
    return () => { document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); };
  }, []);

  return (
    <div className="pan-wrap" title="Pan (drag ↕ · double-click centers)">
      <canvas
        ref={cvRef}
        width={34}
        height={34}
        style={{ display: 'block', cursor: 'ns-resize' }}
        onMouseDown={e => { e.preventDefault(); drag.current = true; sy.current = e.clientY; sv.current = pan; }}
        onDoubleClick={() => cbRef.current(0)}
      />
    </div>
  );
};

/* ── Channel Strip ───────────────────────────────────────────────────────────── */
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

  const sp = (e: React.MouseEvent) => e.stopPropagation();
  const toggleMute = (e: React.MouseEvent) => {
    e.stopPropagation();
    dispatch({ type: 'UPDATE_TRACK', payload: { id: track.id, updates: { isMuted: !track.isMuted } } });
  };
  const toggleSolo = (e: React.MouseEvent) => {
    e.stopPropagation();
    dispatch({ type: 'UPDATE_TRACK', payload: { id: track.id, updates: { isSolo: !track.isSolo } } });
  };
  const toggleArm = (e: React.MouseEvent) => {
    e.stopPropagation();
    dispatch({ type: 'UPDATE_TRACK', payload: { id: track.id, updates: { isArmed: !track.isArmed } } });
  };

  const bg     = isSelected
    ? `linear-gradient(180deg, ${scaleHex(track.color, 0.32)} 0%, ${scaleHex(track.color, 0.22)} 100%)`
    : `linear-gradient(180deg, ${scaleHex(track.color, 0.18)} 0%, ${scaleHex(track.color, 0.12)} 100%)`;
  const border = isSelected
    ? `1px solid ${scaleHex(track.color, 0.6)}`
    : `1px solid ${scaleHex(track.color, 0.35)}`;

  return (
    <div className="mixer-ch" style={{ background: bg, border }} onClick={onClick}>
      {/* Group */}
      <div className="mch-group-bar">
        <div className="mch-group-select" onClick={sp}>No Group</div>
      </div>

      {/* LED */}
      <div
        className="mch-led"
        style={{ background: track.isArmed ? '#ff4d4d' : track.isMuted ? '#333' : '#00e000',
                 boxShadow: track.isArmed ? '0 0 4px #ff4d4d' : track.isMuted ? 'none' : '0 0 4px #00dd00,0 0 8px rgba(0,220,0,0.4)' }}
      />

      {/* Pan LCD (above knob — matches reference layout) */}
      <div className="mch-pan-lcd" onClick={sp}>
        <span className="mch-pan-seg left">{panLcdLeft(track.pan)}</span>
        <span className="mch-pan-seg right">{panLcdRight(track.pan)}</span>
      </div>

      {/* Knob row */}
      <div className="mch-knob-row" onClick={sp}>
        <span className="mch-lr-label">L</span>
        <PanKnob pan={track.pan} onChange={setPan} />
        <span className="mch-lr-label">R</span>
      </div>

      {/* I + REC */}
      <div className="mch-btn-row">
        <button className="mch-btn mch-input-btn" onClick={sp}>I</button>
        <button className={`mch-btn mch-rec-btn${track.isArmed ? ' on' : ''}`} onClick={toggleArm}>
          <span className="mch-rec-dot" />
        </button>
      </div>

      {/* S + M */}
      <div className="mch-btn-row">
        <button className={`mch-btn mch-solo-btn${track.isSolo ? ' on' : ''}`} onClick={toggleSolo}>S</button>
        <button className={`mch-btn mch-mute-btn${track.isMuted ? ' on' : ''}`} onClick={toggleMute}>M</button>
      </div>

      {/* Strip: left-scale | L-meter | fader | R-meter | right-scale */}
      <div className="mch-fader-area">
        <div className="mch-db-scale">
          {DB_SCALE_MARKS.map(m => (
            <span key={m.db} className="mch-scale-mark" style={{ top: `${m.pct}%` }}>
              {m.db > 0 ? m.db : m.db}
            </span>
          ))}
        </div>
        <div className="mch-meter-col">
          <SingleMeter analyserRef={trackAnalysersRef} trackId={track.id} channel="L" />
        </div>
        <div className="mch-fader-col">
          <VerticalFader value={isFinite(track.volume) ? track.volume : 0.8} onChange={setVolume} />
        </div>
        <div className="mch-meter-col">
          <SingleMeter analyserRef={trackAnalysersRef} trackId={track.id} channel="R" />
        </div>
        <div className="mch-meter-scale">
          {DB_SCALE_MARKS.map(m => (
            <span key={m.db} className="mch-meter-mark" style={{ top: `${m.pct}%` }}>
              {m.db > 0 ? m.db : m.db}
            </span>
          ))}
        </div>
      </div>

      {/* Peak readout */}
      <PeakDisplay analyserRef={trackAnalysersRef} trackId={track.id} />

      {/* Routing / din row */}
      <div className="mch-routing-row">
        <button className="mch-route-arrow" onClick={sp}>◄</button>
        <span className="mch-route-label">din.</span>
        <button className="mch-route-arrow" onClick={sp}>►</button>
      </div>

      {/* Track name */}
      <div className="mch-name-bar" style={{ borderTopColor: track.color }}>
        <input
          className="mch-name-input"
          value={track.name}
          onChange={e => setName(e.target.value)}
          onClick={sp}
        />
      </div>
    </div>
  );
};

/* ── Master Strip ────────────────────────────────────────────────────────────── */
const MasterStrip: React.FC<{
  vol: number; pan: number;
  onVol: (v: number) => void; onPan: (v: number) => void;
  analyserRef: React.MutableRefObject<Record<string, AnalyserNode>>;
  color: string;
  onColorChange: (c: string) => void;
}> = ({ vol, pan, onVol, onPan, analyserRef, color, onColorChange }) => {
  const firstKey = Object.keys(analyserRef.current)[0] ?? '__none__';
  const [showPicker, setShowPicker] = useState(false);
  const [pickerPos, setPickerPos] = useState({ x: 0, y: 0 });
  const swatchRef   = useRef<HTMLDivElement>(null);
  const popupRef    = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showPicker) return;
    const handler = (e: MouseEvent) => {
      if (
        popupRef.current  && !popupRef.current.contains(e.target as Node) &&
        swatchRef.current && !swatchRef.current.contains(e.target as Node)
      ) setShowPicker(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showPicker]);

  const openPicker = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (showPicker) { setShowPicker(false); return; }
    const rect = swatchRef.current!.getBoundingClientRect();
    setPickerPos({ x: rect.left + rect.width / 2, y: rect.top });
    setShowPicker(true);
  };

  const bg          = `linear-gradient(180deg,${scaleHex(color, 0.38)} 0%,${scaleHex(color, 0.25)} 100%)`;
  const borderColor = scaleHex(color, 0.6);

  return (
    <div className="mixer-ch mixer-master" style={{ background: bg, border: `1px solid ${borderColor}` }}>
      <div className="mch-group-bar">
        <div className="mch-group-select">Master</div>
      </div>

      <div className="mch-led" style={{ background: '#00e000', boxShadow: '0 0 4px #00dd00,0 0 8px rgba(0,220,0,0.4)' }} />

      <div className="mch-pan-lcd">
        <span className="mch-pan-seg left">{panLcdLeft(pan)}</span>
        <span className="mch-pan-seg right">{panLcdRight(pan)}</span>
      </div>

      <div className="mch-knob-row">
        <span className="mch-lr-label">L</span>
        <PanKnob pan={pan} onChange={onPan} />
        <span className="mch-lr-label">R</span>
      </div>

      <div className="mch-btn-row">
        <button className="mch-btn mch-input-btn" style={{ opacity: 0.35 }}>I</button>
        <button className="mch-btn mch-rec-btn" style={{ opacity: 0.35 }}><span className="mch-rec-dot" /></button>
      </div>
      <div className="mch-btn-row">
        <button className="mch-btn mch-solo-btn" style={{ opacity: 0.35 }}>S</button>
        <button className="mch-btn mch-mute-btn" style={{ opacity: 0.35 }}>M</button>
      </div>

      <div className="mch-fader-area">
        <div className="mch-db-scale">
          {DB_SCALE_MARKS.map(m => (
            <span key={m.db} className="mch-scale-mark" style={{ top: `${m.pct}%` }}>
              {m.db > 0 ? m.db : m.db}
            </span>
          ))}
        </div>
        <div className="mch-meter-col">
          <SingleMeter analyserRef={analyserRef} trackId={firstKey} channel="L" />
        </div>
        <div className="mch-fader-col">
          <VerticalFader value={isFinite(vol) ? vol : 0.8} onChange={onVol} isMaster capColor={color} />
        </div>
        <div className="mch-meter-col">
          <SingleMeter analyserRef={analyserRef} trackId={firstKey} channel="R" />
        </div>
        <div className="mch-meter-scale">
          {DB_SCALE_MARKS.map(m => (
            <span key={m.db} className="mch-meter-mark" style={{ top: `${m.pct}%` }}>
              {m.db > 0 ? m.db : m.db}
            </span>
          ))}
        </div>
      </div>

      <PeakDisplay analyserRef={analyserRef} trackId={firstKey} />

      <div className="mch-routing-row">
        <button className="mch-route-arrow">◄</button>
        <span className="mch-route-label">Main Out</span>
        <button className="mch-route-arrow">►</button>
      </div>

      <div className="mch-name-bar" style={{ borderTopColor: color }}>
        <div className="mch-name-input" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px' }}>
          <div
            ref={swatchRef}
            className="master-color-swatch"
            style={{ backgroundColor: color }}
            title="Change master color"
            onClick={openPicker}
          />
          <span>Master</span>
        </div>
      </div>

      {showPicker && ReactDOM.createPortal(
        <div
          ref={popupRef}
          className="master-color-picker"
          style={{ position: 'fixed', top: pickerPos.y - 8, left: pickerPos.x, transform: 'translate(-50%, -100%)' }}
          onClick={e => e.stopPropagation()}
        >
          <div className="master-picker-title">Master Color</div>
          <div className="master-palette-grid">
            {MIXER_PALETTE.map(c => (
              <button
                key={c}
                className={`master-palette-cell${color === c ? ' active' : ''}`}
                style={{ backgroundColor: c }}
                onClick={() => { onColorChange(c); setShowPicker(false); }}
                title={c}
              />
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

/* ── Mixer Panel ─────────────────────────────────────────────────────────────── */
const MixerPanel: React.FC = () => {
  const { state, dispatch, trackAnalysersRef } = useDaw();
  const [masterVol,   setMasterVol]   = useState(0.8);
  const [masterPan,   setMasterPan]   = useState(0);
  const [masterColor, setMasterColor] = useState('#7072a0');

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
          color={masterColor}
          onColorChange={setMasterColor}
        />
      </div>
    </div>
  );
};

export default MixerPanel;
