import React, { useState, useEffect, useRef } from 'react';
import { useDaw } from '../../context/DawContext';
import './AudioMIDIPreferencesDialog.css';

// ── Persisted preferences ───────────────────────────────────────────────────────
export interface AudioPrefs {
  inputDeviceId: string;
  outputDeviceId: string;
  sampleRate: number;
  bufferSize: number;
  inputChannel1: string;
  inputChannel2: string;
  outputChannel1: string;
  outputChannel2: string;
  // Native engine device IDs (integers from naudiodon; -1 = system default)
  nativeInputDeviceId:  number;
  nativeOutputDeviceId: number;
}

const PREFS_KEY = 'studiodesk_audio_prefs';

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

// ── Dialog ──────────────────────────────────────────────────────────────────────
const AudioMIDIPreferencesDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { state, dispatch, audioCtxRef } = useDaw();

  const [prefs,   setPrefs]   = useState<AudioPrefs>(loadAudioPrefs);

  const [inputDevices,  setInputDevices]  = useState<MediaDeviceInfo[]>([]);
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [nativeDevices, setNativeDevices] = useState<import('../../types/audioEngine').AudioDevice[]>([]);

  const [engineRunning, setEngineRunning] = useState(false);
  const [latency,       setLatency]       = useState<number | null>(null);

  // Test Input state
  const [testLevel,  setTestLevel]  = useState(0);     // 0–1 VU meter fill
  const [isTesting,  setIsTesting]  = useState(false);
  const testCleanupRef = useRef<(() => void) | null>(null);

  // Enumerate audio devices (needs mic permission for labels)
  useEffect(() => {
    const enumerate = async () => {
      try { await navigator.mediaDevices.getUserMedia({ audio: true }); } catch {}
      const devices = await navigator.mediaDevices.enumerateDevices();
      setInputDevices(devices.filter(d => d.kind === 'audioinput'));
      setOutputDevices(devices.filter(d => d.kind === 'audiooutput'));
    };
    enumerate();
    // Native devices (naudiodon — only in Electron with native engine compiled)
    window.audioEngine?.getDevices().then(setNativeDevices).catch(() => {});

    navigator.mediaDevices.addEventListener?.('devicechange', enumerate);
    return () => navigator.mediaDevices.removeEventListener?.('devicechange', enumerate);
  }, []);

  // Read AudioContext state & latency
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

  // ── Test Input ───────────────────────────────────────────────
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
      alert('Could not open the selected input device. Check browser/system permissions.');
      return;
    }

    const ctx      = new AudioContext();
    const source   = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    // NOT connected to ctx.destination — silent monitor, no feedback risk

    const data = new Uint8Array(analyser.frequencyBinCount);
    let rafId: number;
    const tick = () => {
      analyser.getByteFrequencyData(data);
      const peak = Math.max(...Array.from(data)) / 255;
      setTestLevel(peak);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    setIsTesting(true);

    // Auto-stop after 6 seconds
    const timer = setTimeout(() => {
      testCleanupRef.current?.();
      testCleanupRef.current = null;
    }, 6000);

    testCleanupRef.current = () => {
      cancelAnimationFrame(rafId);
      clearTimeout(timer);
      stream.getTracks().forEach(t => t.stop());
      ctx.close();
      setIsTesting(false);
      setTestLevel(0);
    };
  };

  // Clean up test stream on unmount
  useEffect(() => () => { testCleanupRef.current?.(); }, []);

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
    saveAudioPrefs(prefs);
    onClose();
  };

  const ts = state.transport.timeSignature;

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

              {/* Test Input button + live VU meter */}
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

              {/* Native ASIO/WASAPI/CoreAudio device selection */}
              {nativeDevices.length > 0 && (<>
                <div className="apd-separator" />
                <div className="apd-row" style={{ marginBottom: 2 }}>
                  <label style={{ fontWeight: 600 }}>Native Engine (ASIO/WASAPI/CoreAudio)</label>
                </div>
                <div className="apd-row">
                  <label>Native Input:</label>
                  <select
                    className="apd-select apd-select-wide"
                    value={prefs.nativeInputDeviceId}
                    onChange={e => set('nativeInputDeviceId', Number(e.target.value))}
                  >
                    <option value={-1}>Default Input</option>
                    {nativeDevices.filter(d => d.maxInputChannels > 0).map(d => (
                      <option key={d.id} value={d.id}>
                        [{d.hostApi}] {d.name}
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
                    {nativeDevices.filter(d => d.maxOutputChannels > 0).map(d => (
                      <option key={d.id} value={d.id}>
                        [{d.hostApi}] {d.name}
                      </option>
                    ))}
                  </select>
                </div>
              </>)}

              <div className="apd-separator" />

              {/* Channel routing */}
              <div className="apd-routing">
                <div className="apd-routing-col">
                  <div className="apd-routing-header">Audio Inputs</div>
                  {['inputChannel1', 'inputChannel2'].map((key, i) => (
                    <div key={key} className="apd-routing-row">
                      <span className="apd-ch-num">{String(i + 1).padStart(2, '0')}.</span>
                      <select
                        className="apd-select apd-select-ch"
                        value={prefs[key as keyof AudioPrefs] as string}
                        onChange={e => set(key as keyof AudioPrefs, e.target.value)}
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
                  {['outputChannel1', 'outputChannel2'].map((key, i) => (
                    <div key={key} className="apd-routing-row">
                      <span className="apd-ch-num">{String(i + 1).padStart(2, '0')}.</span>
                      <select
                        className="apd-select apd-select-ch"
                        value={prefs[key as keyof AudioPrefs] as string}
                        onChange={e => set(key as keyof AudioPrefs, e.target.value)}
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

              {/* Tempo & time signature */}
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
                    value={ts[0]}
                    min={1} max={32}
                    onChange={e => dispatch({ type: 'SET_TIME_SIGNATURE', payload: [Number(e.target.value), ts[1]] })}
                  />
                  <span className="apd-unit">/</span>
                  <input
                    type="number"
                    className="apd-num-input apd-num-small"
                    value={ts[1]}
                    min={1} max={32}
                    onChange={e => dispatch({ type: 'SET_TIME_SIGNATURE', payload: [ts[0], Number(e.target.value)] })}
                  />
                </div>
              </div>

              <div className="apd-row">
                <label />
                <button className="apd-btn-secondary">Tap Tempo Setup…</button>
              </div>

              <div className="apd-separator" />

              {/* Engine status */}
              <div className="apd-engine-row">
                <span className={`apd-status-dot${engineRunning ? ' on' : ''}`} />
                <span className="apd-status-label">
                  {engineRunning ? 'Audio Engine Is Running' : 'Audio Engine Stopped'}
                </span>
              </div>
              {latency !== null && (
                <div className="apd-latency">Estimated I/O Latency: {latency} ms</div>
              )}
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
