import React, { useState, useEffect, useRef } from 'react';
import { useDaw } from '../../context/DawContext';
import type { AudioDevice, AudioHostAPI } from '../../types/audioEngine';
import './AudioMIDIPreferencesDialog.css';

// ── Persisted preferences ───────────────────────────────────────────────────────
export type DriverType = 'ASIO' | 'Windows' | 'all';

export interface AudioPrefs {
  inputDeviceId: string;
  outputDeviceId: string;
  sampleRate: number;
  bufferSize: number;
  inputChannel1: string;
  inputChannel2: string;
  outputChannel1: string;
  outputChannel2: string;
  nativeInputDeviceId:  number;
  nativeOutputDeviceId: number;
  driverType: DriverType;
}

const PREFS_KEY = 'riddimSync_audio_prefs';

export const DEFAULT_AUDIO_PREFS: AudioPrefs = {
  inputDeviceId:        'default',
  outputDeviceId:       'default',
  sampleRate:           48000,
  bufferSize:           256,
  inputChannel1:        'Input 1',
  inputChannel2:        'Input 2',
  outputChannel1:       'Output 1',
  outputChannel2:       'Output 2',
  nativeInputDeviceId:  -1,
  nativeOutputDeviceId: -1,
  driverType:           'all',
};

export function loadAudioPrefs(): AudioPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return { ...DEFAULT_AUDIO_PREFS, ...JSON.parse(raw) };
  } catch {}
  return { ...DEFAULT_AUDIO_PREFS };
}

function saveAudioPrefs(p: AudioPrefs) {
  localStorage.setItem(PREFS_KEY, JSON.stringify(p));
}

// ── Constants ───────────────────────────────────────────────────────────────────
const SAMPLE_RATES = [44100, 48000, 88200, 96000];
const BUFFER_SIZES = [64, 128, 256, 512, 1024, 2048];

// ── Driver type options ─────────────────────────────────────────────────────────
const DRIVER_LABELS: Record<DriverType, string> = {
  ASIO:    'ASIO',
  Windows: 'Windows (WASAPI / MME)',
  all:     'All Drivers',
};

// ── Dialog ──────────────────────────────────────────────────────────────────────
const AudioMIDIPreferencesDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { state, dispatch, audioCtxRef } = useDaw();

  const [prefs, setPrefs] = useState<AudioPrefs>(loadAudioPrefs);

  const [inputDevices,  setInputDevices]  = useState<MediaDeviceInfo[]>([]);
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [nativeDevices, setNativeDevices] = useState<AudioDevice[]>([]);
  const [hostAPIs,      setHostAPIs]      = useState<AudioHostAPI[]>([]);

  const [engineRunning, setEngineRunning] = useState(false);
  const [latency,       setLatency]       = useState<number | null>(null);

  // Test Input
  const [testLevel, setTestLevel] = useState(0);
  const [isTesting, setIsTesting] = useState(false);
  const testCleanupRef = useRef<(() => void) | null>(null);

  // ── Device enumeration ──────────────────────────────────────────────────────
  useEffect(() => {
    const enumerate = async () => {
      try { await navigator.mediaDevices.getUserMedia({ audio: true }); } catch {}
      const devices = await navigator.mediaDevices.enumerateDevices();
      setInputDevices(devices.filter(d => d.kind === 'audioinput'));
      setOutputDevices(devices.filter(d => d.kind === 'audiooutput'));
    };
    enumerate();
    navigator.mediaDevices.addEventListener?.('devicechange', enumerate);

    // Native: devices + host APIs
    if (window.audioEngine) {
      window.audioEngine.getDevices().then(devs => {
        console.log('[AudioSetup] Native devices:', devs.map(d => `[${d.hostApi}] ${d.name}`));
        setNativeDevices(devs);
      }).catch(e => console.error('[AudioSetup] getDevices error:', e));

      window.audioEngine.getHostAPIs().then(result => {
        console.log('[AudioSetup] Host APIs:', result.HostAPIs);
        setHostAPIs(result.HostAPIs);
      }).catch(e => console.error('[AudioSetup] getHostAPIs error:', e));
    }

    return () => navigator.mediaDevices.removeEventListener?.('devicechange', enumerate);
  }, []);

  // ── Engine status ───────────────────────────────────────────────────────────
  useEffect(() => {
    const ctx = audioCtxRef.current;
    if (ctx && ctx.state !== 'closed') {
      setEngineRunning(ctx.state === 'running' || ctx.state === 'suspended');
      const ms = ((ctx.baseLatency ?? 0) + (ctx.outputLatency ?? 0)) * 1000;
      setLatency(Math.round(ms * 10) / 10);
    } else {
      setEngineRunning(false);
      setLatency(null);
    }
  }, [audioCtxRef]);

  const set = <K extends keyof AudioPrefs>(k: K, v: AudioPrefs[K]) =>
    setPrefs(p => ({ ...p, [k]: v }));

  // ── ASIO detection ─────────────────────────────────────────────────────────
  // Primary: check host API type (paASIO enum — doesn't depend on string name)
  // Fallback: check device hostApi string
  const hasAsio =
    hostAPIs.some(h => h.type === 'ASIO') ||
    nativeDevices.some(d => d.hostApi === 'ASIO');

  const asioDevices   = nativeDevices.filter(d => d.hostApi === 'ASIO');
  const windowsDevIn  = nativeDevices.filter(d => d.maxInputChannels  > 0 && d.hostApi !== 'ASIO');
  const windowsDevOut = nativeDevices.filter(d => d.maxOutputChannels > 0 && d.hostApi !== 'ASIO');
  const allDevIn      = nativeDevices.filter(d => d.maxInputChannels  > 0);
  const allDevOut     = nativeDevices.filter(d => d.maxOutputChannels > 0);

  // Available driver type options
  const driverOptions: DriverType[] = hasAsio
    ? ['ASIO', 'Windows', 'all']
    : ['Windows', 'all'];

  // Auto-fix: if ASIO was saved but isn't available, fall back to Windows
  const effectiveDriver: DriverType = (!hasAsio && prefs.driverType === 'ASIO') ? 'Windows' : prefs.driverType;

  const isAsioMode = effectiveDriver === 'ASIO';

  // For ASIO: single device controls both in/out
  const asioDeviceId = prefs.nativeInputDeviceId;

  const handleAsioDeviceChange = (id: number) => {
    setPrefs(p => ({ ...p, nativeInputDeviceId: id, nativeOutputDeviceId: id }));
  };

  // Estimated native latency: bufferSize / sampleRate (round-trip = ×2)
  const nativeLatencyMs = Math.round((prefs.bufferSize / prefs.sampleRate) * 2 * 1000 * 10) / 10;

  // ── Test Input ──────────────────────────────────────────────────────────────
  const handleTestInput = async () => {
    if (isTesting) {
      testCleanupRef.current?.();
      testCleanupRef.current = null;
      return;
    }
    let stream: MediaStream;
    try {
      const constraint: MediaTrackConstraints | boolean =
        prefs.inputDeviceId !== 'default'
          ? { deviceId: { exact: prefs.inputDeviceId } }
          : true;
      stream = await navigator.mediaDevices.getUserMedia({ audio: constraint, video: false });
    } catch {
      alert('Could not open the selected input device.');
      return;
    }
    const ctx      = new AudioContext();
    const source   = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    let rafId: number;
    const tick = () => {
      analyser.getByteFrequencyData(data);
      setTestLevel(Math.max(...Array.from(data)) / 255);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    setIsTesting(true);
    const timer = setTimeout(() => { testCleanupRef.current?.(); testCleanupRef.current = null; }, 6000);
    testCleanupRef.current = () => {
      cancelAnimationFrame(rafId);
      clearTimeout(timer);
      stream.getTracks().forEach(t => t.stop());
      ctx.close();
      setIsTesting(false);
      setTestLevel(0);
    };
  };
  useEffect(() => () => { testCleanupRef.current?.(); }, []);

  // ── Restart Engine ──────────────────────────────────────────────────────────
  const handleRestartEngine = async () => {
    if (audioCtxRef.current) {
      try { await audioCtxRef.current.close(); } catch {}
      (audioCtxRef as any).current = null;
    }
    try {
      const ctx = new AudioContext({ sampleRate: prefs.sampleRate });
      audioCtxRef.current = ctx;
      if ('setSinkId' in ctx && prefs.outputDeviceId !== 'default') {
        try { await (ctx as any).setSinkId(prefs.outputDeviceId); } catch {}
      }
      setEngineRunning(ctx.state !== 'closed');
      const ms = ((ctx.baseLatency ?? 0) + (ctx.outputLatency ?? 0)) * 1000;
      setLatency(Math.round(ms * 10) / 10);
    } catch (err) {
      console.error('Audio engine restart failed:', err);
    }
  };

  const handleOk = () => {
    saveAudioPrefs({ ...prefs, driverType: effectiveDriver });
    onClose();
  };

  const ts = state.transport.timeSignature;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="apd-overlay" onClick={onClose}>
      <div className="apd-dialog" onClick={e => e.stopPropagation()}>

        {/* Title bar */}
        <div className="apd-titlebar">
          <span className="apd-title">Audio Setup</span>
          <button className="apd-close" onClick={onClose}>✕</button>
        </div>

        <div className="apd-body">
          <div className="apd-general">

            {/* ── Configuration ── */}
            <div className="apd-row">
              <label>Configuration:</label>
              <select className="apd-select apd-select-wide" value="stereo-2-2" onChange={() => {}}>
                <option value="stereo-2-2">Stereo (2 in-2 out)</option>
              </select>
            </div>

            {/* ── Driver Type ── */}
            <div className="apd-row">
              <label>Driver Type:</label>
              <select
                className="apd-select"
                value={effectiveDriver}
                onChange={e => setPrefs(p => ({
                  ...p,
                  driverType:           e.target.value as DriverType,
                  nativeInputDeviceId:  -1,
                  nativeOutputDeviceId: -1,
                }))}
              >
                {driverOptions.map(t => (
                  <option key={t} value={t}>{DRIVER_LABELS[t]}</option>
                ))}
              </select>
              {!hasAsio && (
                <span className="apd-asio-note" style={{ marginLeft: 10 }}>
                  ASIO not detected
                </span>
              )}
            </div>

            {/* ── Audio Device — ASIO mode: single combined device ── */}
            {isAsioMode ? (
              <div className="apd-row">
                <label>Audio Device:</label>
                <div className="apd-row-inner">
                  <select
                    className="apd-select apd-select-wide"
                    value={asioDeviceId}
                    onChange={e => handleAsioDeviceChange(Number(e.target.value))}
                  >
                    <option value={-1}>Default ASIO Device</option>
                    {asioDevices.map(d => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </select>
                  <button
                    className="apd-btn-secondary apd-asio-panel-btn"
                    title="Open ASIO Control Panel"
                    onClick={() => alert('Open the ASIO control panel from your audio interface software (e.g. Focusrite Control).')}
                  >…</button>
                </div>
              </div>
            ) : (
              <>
                {/* Web Audio In/Out */}
                <div className="apd-row">
                  <label>Audio Device (In):</label>
                  <select
                    className="apd-select apd-select-wide"
                    value={prefs.inputDeviceId}
                    onChange={e => set('inputDeviceId', e.target.value)}
                  >
                    <option value="default">Default Input</option>
                    {inputDevices.map(d => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || `Input ${d.deviceId.slice(0, 10)}…`}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Test Input */}
                <div className="apd-row">
                  <label />
                  <div className="apd-row-inner" style={{ flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
                    <button
                      className={`apd-btn-secondary${isTesting ? ' apd-btn-active' : ''}`}
                      onClick={handleTestInput}
                      style={{ minWidth: 120 }}
                    >
                      {isTesting ? 'Stop Test' : 'Test Input'}
                    </button>
                    {isTesting && (
                      <div className="apd-vu-row">
                        <span className="apd-vu-label">Level</span>
                        <div className="apd-vu-track">
                          <div
                            className="apd-vu-fill"
                            style={{
                              width: `${Math.round(testLevel * 100)}%`,
                              background: testLevel > 0.85 ? '#ff4d4d' : testLevel > 0.6 ? '#ffb84d' : '#00ffcc',
                              transition: 'width 0.05s linear, background 0.1s',
                            }}
                          />
                        </div>
                        <span className="apd-vu-pct">{Math.round(testLevel * 100)}%</span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="apd-row">
                  <label>Audio Device (Out):</label>
                  <select
                    className="apd-select apd-select-wide"
                    value={prefs.outputDeviceId}
                    onChange={e => set('outputDeviceId', e.target.value)}
                  >
                    <option value="default">Default Output</option>
                    {outputDevices.map(d => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || `Output ${d.deviceId.slice(0, 10)}…`}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Native In/Out when Windows/All mode */}
                {nativeDevices.length > 0 && (<>
                  <div className="apd-row">
                    <label>Native Input:</label>
                    <select
                      className="apd-select apd-select-wide"
                      value={prefs.nativeInputDeviceId}
                      onChange={e => set('nativeInputDeviceId', Number(e.target.value))}
                    >
                      <option value={-1}>Default Input</option>
                      {(effectiveDriver === 'all' ? allDevIn : windowsDevIn).map(d => (
                        <option key={d.id} value={d.id}>
                          {effectiveDriver === 'all' ? `[${d.hostApi}] ` : ''}{d.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="apd-row">
                    <label>Native Output:</label>
                    <select
                      className="apd-select apd-select-wide"
                      value={prefs.nativeOutputDeviceId}
                      onChange={e => set('nativeOutputDeviceId', Number(e.target.value))}
                    >
                      <option value={-1}>Default Output</option>
                      {(effectiveDriver === 'all' ? allDevOut : windowsDevOut).map(d => (
                        <option key={d.id} value={d.id}>
                          {effectiveDriver === 'all' ? `[${d.hostApi}] ` : ''}{d.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </>)}
              </>
            )}

            {/* ── Sample Rate ── */}
            <div className="apd-row">
              <label>Sample Rate:</label>
              <select
                className="apd-select"
                value={prefs.sampleRate}
                onChange={e => set('sampleRate', Number(e.target.value))}
              >
                {SAMPLE_RATES.map(r => (
                  <option key={r} value={r}>{r.toLocaleString()} Hz</option>
                ))}
              </select>
            </div>

            {/* ── Buffer Size ── */}
            <div className="apd-row">
              <label>Buffer Size:</label>
              <div className="apd-row-inner">
                <select
                  className="apd-select"
                  value={prefs.bufferSize}
                  onChange={e => set('bufferSize', Number(e.target.value))}
                >
                  {BUFFER_SIZES.map(b => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
                <span className="apd-unit">samples</span>
              </div>
            </div>

            <div className="apd-separator" />

            {/* ── Channel routing ── */}
            <div className="apd-routing">
              <div className="apd-routing-col">
                <div className="apd-routing-header">Audio Inputs</div>
                {(['inputChannel1', 'inputChannel2'] as const).map((key, i) => (
                  <div key={key} className="apd-routing-row">
                    <span className="apd-ch-num">{String(i + 1).padStart(2, '0')}.</span>
                    <select
                      className="apd-select apd-select-ch"
                      value={prefs[key]}
                      onChange={e => set(key, e.target.value)}
                    >
                      {(inputDevices.length > 0
                        ? Array.from({ length: Math.max(2, inputDevices.length) }, (_, k) => `Input ${k + 1}`)
                        : ['Input 1', 'Input 2']
                      ).map(ch => <option key={ch}>{ch}</option>)}
                    </select>
                  </div>
                ))}
              </div>

              <div className="apd-routing-col">
                <div className="apd-routing-header">Audio Outputs</div>
                {(['outputChannel1', 'outputChannel2'] as const).map((key, i) => (
                  <div key={key} className="apd-routing-row">
                    <span className="apd-ch-num">{String(i + 1).padStart(2, '0')}.</span>
                    <select
                      className="apd-select apd-select-ch"
                      value={prefs[key]}
                      onChange={e => set(key, e.target.value)}
                    >
                      {(outputDevices.length > 0
                        ? Array.from({ length: Math.max(2, outputDevices.length) }, (_, k) => `Output ${k + 1}`)
                        : ['Output 1', 'Output 2']
                      ).map(ch => <option key={ch}>{ch}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            </div>

            <div className="apd-separator" />

            {/* ── Tempo & time signature ── */}
            <div className="apd-row">
              <label>Tempo:</label>
              <div className="apd-row-inner">
                <input
                  type="number"
                  className="apd-num-input"
                  value={state.transport.tempo}
                  min={20} max={300} step={0.1}
                  onChange={e => dispatch({ type: 'SET_TEMPO', payload: parseFloat(e.target.value) || 120 })}
                />
                <span className="apd-unit">bpm</span>
              </div>
            </div>

            <div className="apd-row">
              <label>Time Signature:</label>
              <div className="apd-row-inner">
                <input
                  type="number"
                  className="apd-num-input apd-num-small"
                  value={ts[0]} min={1} max={32}
                  onChange={e => dispatch({ type: 'SET_TIME_SIGNATURE', payload: [Number(e.target.value), ts[1]] })}
                />
                <span className="apd-unit">/</span>
                <input
                  type="number"
                  className="apd-num-input apd-num-small"
                  value={ts[1]} min={1} max={32}
                  onChange={e => dispatch({ type: 'SET_TIME_SIGNATURE', payload: [ts[0], Number(e.target.value)] })}
                />
              </div>
            </div>

            <div className="apd-row">
              <label />
              <button className="apd-btn-secondary">Tap Tempo Setup…</button>
            </div>

            <div className="apd-separator" />

            {/* ── Engine status ── */}
            <div className="apd-engine-row">
              <span className={`apd-status-dot${engineRunning ? ' on' : ''}`} />
              <span className="apd-status-label">
                {engineRunning ? 'Audio Engine Is Running' : 'Audio Engine Stopped'}
              </span>
            </div>
            <div className="apd-latency">
              {isAsioMode
                ? `Estimated I/O Latency: ${nativeLatencyMs} ms`
                : latency !== null
                  ? `Estimated I/O Latency: ${latency} ms`
                  : null
              }
            </div>
            <button className="apd-btn-secondary apd-restart" onClick={handleRestartEngine}>
              Restart Audio Engine
            </button>

          </div>
        </div>

        {/* Footer */}
        <div className="apd-footer">
          <button className="apd-btn-primary" onClick={handleOk}>Ok</button>
        </div>
      </div>
    </div>
  );
};

export default AudioMIDIPreferencesDialog;
