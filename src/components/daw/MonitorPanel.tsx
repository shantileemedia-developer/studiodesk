import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { MonitorConnectionState, MonitorQuality } from '../../hooks/useAudioStream';
import './MonitorPanel.css';

export type MonitorSource = 'both' | 'mix' | 'mic';

interface MonitorPanelProps {
  remoteStream: MediaStream | null;
  isReceiving: boolean;
  connectionState: MonitorConnectionState;
  quality: MonitorQuality;
  onQualityChange: (q: MonitorQuality) => void;
  source: MonitorSource;
  onSourceChange: (s: MonitorSource) => void;
}

// dBFS → bar fill fraction (non-linear: more room in the hot zone)
const dbToFraction = (db: number): number => {
  if (db <= -60) return 0;
  if (db <= -12) return ((db + 60) / 48) * 0.75;         // green: -60 to -12 dBFS
  if (db <= -3)  return 0.75 + ((db + 12) / 9) * 0.18;  // yellow: -12 to -3 dBFS
  return 0.93 + ((db + 3) / 3) * 0.07;                  // red: -3 to 0 dBFS
};

const PEAK_HOLD_MS  = 1800;
const PEAK_DECAY    = 0.94;

const MonitorPanel: React.FC<MonitorPanelProps> = ({
  remoteStream, isReceiving, connectionState, quality, onQualityChange, source, onSourceChange,
}) => {
  const [volume,  setVolume]  = useState(0.8);
  const [isMuted, setIsMuted] = useState(false);

  // ── Web Audio refs ─────────────────────────────────────────────────────────
  const ctxRef       = useRef<AudioContext | null>(null);
  const gainRef      = useRef<GainNode | null>(null);
  const analyserLRef = useRef<AnalyserNode | null>(null);
  const analyserRRef = useRef<AnalyserNode | null>(null);

  // ── Meter DOM refs (direct DOM manipulation — no React re-renders per frame) ─
  const barLRef    = useRef<HTMLDivElement>(null);
  const barRRef    = useRef<HTMLDivElement>(null);
  const peakLRef   = useRef<HTMLDivElement>(null);
  const peakRRef   = useRef<HTMLDivElement>(null);
  const rafRef     = useRef<number | null>(null);
  const peakLVal   = useRef(0);
  const peakRVal   = useRef(0);
  const peakLTime  = useRef(0);
  const peakRTime  = useRef(0);

  // Volume/source values needed inside RAF without stale closures
  const volumeRef  = useRef(volume);
  const mutedRef   = useRef(isMuted);
  const sourceRef  = useRef(source);
  useEffect(() => { volumeRef.current = volume; },  [volume]);
  useEffect(() => { mutedRef.current  = isMuted; }, [isMuted]);
  useEffect(() => { sourceRef.current = source; },  [source]);

  // ── Build/tear-down audio graph when stream changes ────────────────────────
  useEffect(() => {
    // Tear down previous graph
    if (ctxRef.current) {
      gainRef.current?.disconnect();
      analyserLRef.current?.disconnect();
      analyserRRef.current?.disconnect();
      ctxRef.current.close().catch(() => {});
      ctxRef.current      = null;
      gainRef.current     = null;
      analyserLRef.current = null;
      analyserRRef.current = null;
    }

    if (!remoteStream) return;

    const ctx = new AudioContext({ sampleRate: 48000 });
    ctxRef.current = ctx;

    const src     = ctx.createMediaStreamSource(remoteStream);
    const gain    = ctx.createGain();
    gainRef.current = gain;

    // Pre-gain splitter feeds the metre — levels are visible even when muted
    const meterSplitter = ctx.createChannelSplitter(2);
    const aL = ctx.createAnalyser(); aL.fftSize = 1024; analyserLRef.current = aL;
    const aR = ctx.createAnalyser(); aR.fftSize = 1024; analyserRRef.current = aR;
    src.connect(meterSplitter);
    meterSplitter.connect(aL, 0);
    meterSplitter.connect(aR, 1);
    // aL / aR are analysis-only — not connected to destination

    // Post-gain output (volume-controlled)
    src.connect(gain);
    gain.connect(ctx.destination);

    // Set initial values
    const targetGain = sourceRef.current === 'mic' ? 0 : (mutedRef.current ? 0 : volumeRef.current);
    gain.gain.value = targetGain;

    if (ctx.state === 'suspended') ctx.resume().catch(() => {});

    return () => {
      src.disconnect();
      gain.disconnect();
      aL.disconnect();
      aR.disconnect();
      ctx.close().catch(() => {});
      ctxRef.current       = null;
      gainRef.current      = null;
      analyserLRef.current = null;
      analyserRRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteStream]);

  // ── Apply gain when volume/mute/source changes ─────────────────────────────
  const applyGain = useCallback(() => {
    if (!gainRef.current || !ctxRef.current) return;
    const targetGain = sourceRef.current === 'mic' ? 0 : (mutedRef.current ? 0 : volumeRef.current);
    gainRef.current.gain.setTargetAtTime(targetGain, ctxRef.current.currentTime, 0.015);
  }, []);

  useEffect(() => { applyGain(); }, [volume, isMuted, source, applyGain]);

  // ── Meter animation loop ───────────────────────────────────────────────────
  useEffect(() => {
    const bufL = new Float32Array(1024);
    const bufR = new Float32Array(1024);

    const setPeakBar = (
      barEl: HTMLDivElement | null,
      pkEl:  HTMLDivElement | null,
      level: number,
      pkVal: React.MutableRefObject<number>,
      pkTime: React.MutableRefObject<number>,
    ) => {
      const now = performance.now();
      const db  = 20 * Math.log10(Math.max(level, 1e-7));
      const frac = dbToFraction(db);

      // Peak hold / decay
      if (level >= pkVal.current || now - pkTime.current > PEAK_HOLD_MS) {
        pkVal.current  = level;
        pkTime.current = now;
      } else {
        pkVal.current *= PEAK_DECAY;
      }
      const pkDb   = 20 * Math.log10(Math.max(pkVal.current, 1e-7));
      const pkFrac = dbToFraction(pkDb);

      if (barEl) barEl.style.width = `${frac * 100}%`;
      if (pkEl)  pkEl.style.left   = `${pkFrac * 100}%`;
    };

    const tick = () => {
      rafRef.current = requestAnimationFrame(tick);
      if (!analyserLRef.current || !analyserRRef.current) return;

      analyserLRef.current.getFloatTimeDomainData(bufL);
      analyserRRef.current.getFloatTimeDomainData(bufR);

      let peakL = 0, peakR = 0;
      for (let i = 0; i < bufL.length; i++) peakL = Math.max(peakL, Math.abs(bufL[i]));
      for (let i = 0; i < bufR.length; i++) peakR = Math.max(peakR, Math.abs(bufR[i]));

      setPeakBar(barLRef.current, peakLRef.current, peakL, peakLVal, peakLTime);
      setPeakBar(barRRef.current, peakRRef.current, peakR, peakRVal, peakRTime);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, []);

  // ── Connection badge text / class ──────────────────────────────────────────
  const connLabel = connectionState === 'connected'  ? 'LIVE' :
                    connectionState === 'connecting' ? 'CONNECTING…' :
                    connectionState === 'failed'     ? 'FAILED' : 'NO SIGNAL';

  const connCls = connectionState === 'connected'  ? 'live' :
                  connectionState === 'connecting' ? 'connecting' :
                  connectionState === 'failed'     ? 'failed' : '';

  const bitrateLabel = quality === 'recording' ? '128 kbps · low latency' : '510 kbps · stereo';

  return (
    <div className={`monitor-panel ${isReceiving ? 'receiving' : ''}`}>

      {/* ── Status column ── */}
      <div className="monitor-info">
        <span className="monitor-title">MONITOR</span>
        <div className={`monitor-conn-badge ${connCls}`}>
          <span className="monitor-conn-dot" />
          <span className="monitor-conn-label">{connLabel}</span>
        </div>
        {isReceiving && (
          <span className="monitor-bitrate">{bitrateLabel}</span>
        )}
      </div>

      {/* ── Stereo meters ── */}
      <div className="monitor-meters">
        <div className="monitor-meter-row">
          <span className="monitor-ch">L</span>
          <div className="monitor-meter-track">
            <div className="monitor-meter-bar" ref={barLRef} />
            <div className="monitor-meter-peak" ref={peakLRef} />
          </div>
        </div>
        <div className="monitor-meter-row">
          <span className="monitor-ch">R</span>
          <div className="monitor-meter-track">
            <div className="monitor-meter-bar" ref={barRRef} />
            <div className="monitor-meter-peak" ref={peakRRef} />
          </div>
        </div>
      </div>

      {/* ── Volume + Mute ── */}
      <div className="monitor-vol-group">
        <input
          type="range"
          className="monitor-vol-slider"
          min={0} max={1} step={0.01}
          value={volume}
          onChange={e => setVolume(parseFloat(e.target.value))}
          title={`Monitor volume: ${Math.round(volume * 100)}%`}
        />
        <span className="monitor-vol-pct">{Math.round(volume * 100)}%</span>
        <button
          className={`monitor-mute-btn ${isMuted ? 'muted' : ''}`}
          onClick={() => setIsMuted(v => !v)}
          title={isMuted ? 'Unmute monitor' : 'Mute monitor'}
        >
          {isMuted ? '✕' : '◼'}
        </button>
      </div>

      {/* ── Source selector ── */}
      <div className="monitor-src-group">
        <span className="monitor-src-label">SRC</span>
        {(['both', 'mix', 'mic'] as MonitorSource[]).map(s => (
          <button
            key={s}
            className={`monitor-src-btn ${source === s ? 'active' : ''}`}
            onClick={() => onSourceChange(s)}
            title={
              s === 'both' ? 'Hear mic + master mix'
              : s === 'mix' ? 'Master mix only (mutes call voice)'
              : 'Artist mic only (mutes master mix)'
            }
          >
            {s.toUpperCase()}
          </button>
        ))}
      </div>

      {/* ── Quality selector ── */}
      <div className="monitor-quality-group">
        <span className="monitor-quality-label">QUALITY</span>
        <button
          className={`monitor-quality-btn ${quality === 'recording' ? 'active' : ''}`}
          onClick={() => onQualityChange('recording')}
          title="Recording mode: low latency, 128 kbps"
        >
          REC
        </button>
        <button
          className={`monitor-quality-btn ${quality === 'review' ? 'active' : ''}`}
          onClick={() => onQualityChange('review')}
          title="Review mode: high quality, 510 kbps"
        >
          REVIEW
        </button>
      </div>
    </div>
  );
};

export default MonitorPanel;
