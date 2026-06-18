import { useState, useEffect } from 'react';
import { Settings2, Target, SlidersHorizontal, ChevronDown, Power } from 'lucide-react';
import { useDaw } from '../../context/DawContext';
import './InspectorPanel.css';

const gainToDb = (g: number) => g <= 0 ? '-∞' : `${(20 * Math.log10(g)).toFixed(1)} dB`;

const InspectorPanel = ({ onClose }: { onClose?: () => void }) => {
  const { state, dispatch } = useDaw();
  const track = state.tracks.find(t => t.id === state.selectedTrackId);
  const selectedRegion = state.regions.find(r => r.id === state.selectedRegionId);

  const [routingOpen, setRoutingOpen] = useState(true);
  const [insertsOpen, setInsertsOpen] = useState(true);
  const [sendsOpen, setSendsOpen]     = useState(false);
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);

  // Enumerate audio inputs — re-run when devices change (e.g. USB mic plugged in)
  useEffect(() => {
    const enumerate = () =>
      navigator.mediaDevices.enumerateDevices()
        .then(devices => setInputDevices(devices.filter(d => d.kind === 'audioinput')))
        .catch(() => {});
    enumerate();
    navigator.mediaDevices.addEventListener('devicechange', enumerate);
    return () => navigator.mediaDevices.removeEventListener('devicechange', enumerate);
  }, []);

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
        {/* Routing */}
        <div className="inspector-section">
          <div className="section-header" onClick={() => setRoutingOpen(v => !v)}>
            <Settings2 size={14} />
            <span>Routing</span>
            <ChevronDown size={14} className={`ml-auto chevron${routingOpen ? ' open' : ''}`} />
          </div>
          {routingOpen && (
            <div className="section-body routing-body">
              {/* Input device */}
              <div className="routing-row">
                <span className="routing-label">IN</span>
                <select
                  className="routing-select"
                  value={track.inputDeviceId ?? 'default'}
                  onChange={e => dispatch({
                    type: 'UPDATE_TRACK',
                    payload: { id: track.id, updates: { inputDeviceId: e.target.value } },
                  })}
                  title="Audio input device for this track"
                >
                  <option value="default">Default Input</option>
                  {inputDevices.map(d => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Input ${d.deviceId.slice(0, 6)}…`}
                    </option>
                  ))}
                </select>
              </div>

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
