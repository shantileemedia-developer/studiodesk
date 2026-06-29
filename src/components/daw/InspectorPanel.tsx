import { useState, useEffect } from 'react';
import { Settings2, Target, SlidersHorizontal, ChevronDown, Power } from 'lucide-react';
import { useDaw } from '../../context/DawContext';
import { loadAudioPrefs } from './AudioMIDIPreferencesDialog';
import type { AudioDevice } from '../../types/audioEngine';
import './InspectorPanel.css';

const gainToDb = (g: number) => g <= 0 ? '-∞' : `${(20 * Math.log10(g)).toFixed(1)} dB`;

const InspectorPanel = ({ onClose }: { onClose?: () => void }) => {
  const { state, dispatch } = useDaw();
  const track = state.tracks.find(t => t.id === state.selectedTrackId);
  const selectedRegion = state.regions.find(r => r.id === state.selectedRegionId);

  const [routingOpen, setRoutingOpen] = useState(true);
  const [insertsOpen, setInsertsOpen] = useState(true);
  const [sendsOpen, setSendsOpen]     = useState(false);
  const [nativeDevices, setNativeDevices] = useState<AudioDevice[]>([]);

  // Load native devices once so we know how many channels the interface has.
  useEffect(() => {
    if (window.audioEngine) {
      window.audioEngine.getDevices()
        .then(devs => setNativeDevices(devs))
        .catch(() => {});
    }
  }, []);

  // Derive channel count from the saved audio prefs + native device list.
  const prefs = loadAudioPrefs();
  const activeInDevId = prefs.nativeInputDeviceId;
  const activeDevice  = nativeDevices.find(d => d.id === activeInDevId);
  // Fallback: 16 channels so the picker is always useful even before device list loads.
  const maxInputCh = activeDevice ? activeDevice.maxInputChannels : (nativeDevices.length > 0 ? 2 : 16);

  const panToLabel = (p: number) => {
    if (Math.abs(p) < 0.02) return 'C';
    const pct = Math.round(Math.abs(p) * 100);
    return p < 0 ? `L${pct}` : `R${pct}`;
  };

  if (!track) {
    return (
      <div className="daw-panel inspector-panel">
        <div className="daw-panel-header">
          INSPECTOR
          {onClose && (
            <button className="panel-close-btn" onClick={onClose} title="Close Inspector">×</button>
          )}
        </div>
        <div className="inspector-content" style={{ padding: 20, color: '#666', textAlign: 'center' }}>
          No track selected
        </div>
      </div>
    );
  }

  return (
    <div className="daw-panel inspector-panel">
      <div className="daw-panel-header">INSPECTOR</div>

      <div className="inspector-track-header">
        <div className="color-strip" style={{ backgroundColor: track.color }} />
        <span className="track-name">{track.name}</span>
      </div>

      <div className="inspector-content">
        {/* Volume & Pan */}
        <div className="inspector-section" style={{ paddingBottom: 4 }}>
          <div className="inspector-control-row">
            <span className="inspector-label">VOL</span>
            <input
              type="range"
              min="0"
              max="2"
              step="0.01"
              value={track.volume ?? 0.8}
              onChange={e => dispatch({
                type: 'UPDATE_TRACK',
                payload: { id: track.id, updates: { volume: parseFloat(e.target.value) } },
              })}
              onDoubleClick={() => dispatch({
                type: 'UPDATE_TRACK',
                payload: { id: track.id, updates: { volume: 0.8 } },
              })}
              className="inspector-volume-slider"
              style={{ width: 100 }}
            />
            <span className="fader-value" style={{ minWidth: 52, fontSize: 10 }}>
              {gainToDb(track.volume ?? 0.8)}
            </span>
          </div>
          <div className="inspector-control-row">
            <span className="inspector-label">PAN</span>
            <input
              type="range"
              min="-1"
              max="1"
              step="0.01"
              value={track.pan ?? 0}
              onChange={e => dispatch({
                type: 'UPDATE_TRACK',
                payload: { id: track.id, updates: { pan: parseFloat(e.target.value) } },
              })}
              onDoubleClick={() => dispatch({
                type: 'UPDATE_TRACK',
                payload: { id: track.id, updates: { pan: 0 } },
              })}
              className="inspector-volume-slider"
              style={{ width: 100 }}
            />
            <span className="fader-value" style={{ minWidth: 52, fontSize: 10 }}>
              {panToLabel(track.pan ?? 0)}
            </span>
          </div>
          <div style={{ fontSize: 10, color: '#555', paddingLeft: 4, paddingBottom: 2 }}>
            Double-click to reset
          </div>
        </div>

        {/* Routing */}
        <div className="inspector-section">
          <div className="section-header" onClick={() => setRoutingOpen(v => !v)}>
            <Settings2 size={14} />
            <span>Routing</span>
            <ChevronDown size={14} className={`ml-auto chevron${routingOpen ? ' open' : ''}`} />
          </div>
          {routingOpen && (
            <div className="section-body routing-body">
              {/* Input channel — individual channel on the audio interface */}
              <div className="routing-row">
                <span className="routing-label">IN</span>
                {track.type === 'stereo' ? (
                  <select
                    className="routing-select"
                    value={track.inputChannel ?? 1}
                    onChange={e => dispatch({
                      type: 'UPDATE_TRACK',
                      payload: { id: track.id, updates: { inputChannel: Number(e.target.value) } },
                    })}
                    title="Stereo input pair from audio interface"
                  >
                    {Array.from({ length: Math.floor(maxInputCh / 2) || 1 }, (_, i) => (
                      <option key={i} value={i * 2 + 1}>Ch {i * 2 + 1}–{i * 2 + 2}</option>
                    ))}
                  </select>
                ) : (
                  <select
                    className="routing-select"
                    value={track.inputChannel ?? 1}
                    onChange={e => dispatch({
                      type: 'UPDATE_TRACK',
                      payload: { id: track.id, updates: { inputChannel: Number(e.target.value) } },
                    })}
                    title="Mono input channel from audio interface"
                  >
                    {Array.from({ length: maxInputCh || 1 }, (_, i) => (
                      <option key={i} value={i + 1}>Ch {i + 1}</option>
                    ))}
                  </select>
                )}
              </div>
              {activeDevice && (
                <div style={{ fontSize: 10, color: '#555', paddingLeft: 4, paddingBottom: 2 }}>
                  {activeDevice.name}
                </div>
              )}

              {/* Mono / Stereo */}
              <div className="routing-row routing-type-row">
                <span className="routing-label">CH</span>
                <label className="routing-radio">
                  <input
                    type="radio"
                    name={`track-ch-${track.id}`}
                    checked={track.type === 'mono'}
                    onChange={() => dispatch({
                      type: 'UPDATE_TRACK',
                      payload: { id: track.id, updates: { type: 'mono' } },
                    })}
                  />
                  Mono
                </label>
                <label className="routing-radio">
                  <input
                    type="radio"
                    name={`track-ch-${track.id}`}
                    checked={track.type === 'stereo'}
                    onChange={() => dispatch({
                      type: 'UPDATE_TRACK',
                      payload: { id: track.id, updates: { type: 'stereo' } },
                    })}
                  />
                  Stereo
                </label>
              </div>

              {/* Output — fixed to master in Web Audio */}
              <div className="routing-row">
                <span className="routing-label">OUT</span>
                <select className="routing-select" disabled title="Output routing (Stereo Master)">
                  <option>Stereo Master</option>
                </select>
              </div>
            </div>
          )}
        </div>

        {/* Inserts */}
        <div className="inspector-section">
          <div className="section-header" onClick={() => setInsertsOpen(v => !v)}>
            <SlidersHorizontal size={14} />
            <span>Inserts</span>
            <ChevronDown size={14} className={`ml-auto chevron${insertsOpen ? ' open' : ''}`} />
          </div>
          {insertsOpen && (
            <div className="section-body p-0">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <div
                  key={i}
                  className="insert-slot"
                  title="VST3 plug-in support coming in a future update"
                  style={{ cursor: 'not-allowed', opacity: 0.5 }}
                >
                  <Power size={12} className="power-off" />
                  <span className="slot-name" style={{ color: '#555', fontSize: 11 }}>— empty —</span>
                  <ChevronDown size={12} className="dropdown-icon" />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Sends */}
        <div className="inspector-section">
          <div className="section-header" onClick={() => setSendsOpen(v => !v)}>
            <Target size={14} />
            <span>Sends</span>
            <ChevronDown size={14} className={`ml-auto chevron${sendsOpen ? ' open' : ''}`} />
          </div>
          {sendsOpen && (
            <div className="section-body p-0">
              {[1, 2, 3, 4].map((i) => (
                <div
                  key={i}
                  className="insert-slot"
                  title="Send routing coming in a future update"
                  style={{ cursor: 'not-allowed', opacity: 0.5 }}
                >
                  <Power size={12} className="power-off" />
                  <span className="slot-name" style={{ color: '#555', fontSize: 11 }}>Send {i} — empty</span>
                  <ChevronDown size={12} className="dropdown-icon" />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Clip Gain — visible when a region is selected */}
        {selectedRegion && (
          <div className="inspector-section" style={{ marginTop: 8 }}>
            <div className="section-header" style={{ cursor: 'default', userSelect: 'none' }}>
              <SlidersHorizontal size={14} />
              <span>Clip: {selectedRegion.name}</span>
            </div>
            <div className="section-body">
              <div className="inspector-control-row">
                <span className="inspector-label">GAIN</span>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.01"
                  value={selectedRegion.gain ?? 1}
                  onChange={e => dispatch({
                    type: 'SET_REGION_GAIN',
                    payload: { id: selectedRegion.id, gain: parseFloat(e.target.value) },
                  })}
                  onDoubleClick={() => dispatch({
                    type: 'SET_REGION_GAIN',
                    payload: { id: selectedRegion.id, gain: 1 },
                  })}
                  className="inspector-volume-slider"
                  style={{ width: 100 }}
                />
                <span className="fader-value" style={{ minWidth: 52, fontSize: 10 }}>
                  {gainToDb(selectedRegion.gain ?? 1)}
                </span>
              </div>
              <div style={{ fontSize: 10, color: '#555', paddingLeft: 4, paddingBottom: 4 }}>
                Double-click to reset · 0 dB = unity
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default InspectorPanel;
