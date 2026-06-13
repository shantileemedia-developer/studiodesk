import { useState } from 'react';
import { Settings2, Volume2, Target, SlidersHorizontal, ChevronDown, Power } from 'lucide-react';
import { useDaw } from '../../context/DawContext';
import './InspectorPanel.css';

const InspectorPanel = () => {
  const { state, dispatch } = useDaw();
  const track = state.tracks.find(t => t.id === state.selectedTrackId);

  const [routingOpen, setRoutingOpen] = useState(true);
  const [insertsOpen, setInsertsOpen] = useState(true);
  const [sendsOpen, setSendsOpen]     = useState(false);

  if (!track) {
    return (
      <div className="daw-panel inspector-panel">
        <div className="daw-panel-header">INSPECTOR</div>
        <div className="inspector-content" style={{ padding: 20, color: '#666', textAlign: 'center' }}>
          No track selected
        </div>
      </div>
    );
  }

  const panLabel = Math.abs(track.pan) < 0.03
    ? 'C'
    : `${track.pan > 0 ? 'R' : 'L'}${Math.round(Math.abs(track.pan) * 100)}`;

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
            <div className="section-body">
              <div className="routing-box">{track.type === 'stereo' ? 'Stereo In' : 'Mono In'}</div>
              <div className="routing-box">Stereo Out</div>
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
            <div className="section-body" style={{ color: '#555', fontSize: 11 }}>
              No sends configured
            </div>
          )}
        </div>

        {/* Fader + Pan */}
        <div className="inspector-fader-area">
          <Volume2 size={16} color={track.color} />

          {/* Volume */}
          <div className="inspector-control-row">
            <span className="inspector-label">VOL</span>
            <input
              type="range"
              min="0"
              max="1.5"
              step="0.01"
              value={track.volume}
              onChange={e => dispatch({
                type: 'UPDATE_TRACK',
                payload: { id: track.id, updates: { volume: parseFloat(e.target.value) } },
              })}
              className="inspector-volume-slider"
              style={{ width: 120 }}
            />
            <span className="fader-value">{(track.volume * 100).toFixed(0)}%</span>
          </div>

          {/* Pan */}
          <div className="inspector-control-row">
            <span className="inspector-label">PAN</span>
            <input
              type="range"
              min="-1"
              max="1"
              step="0.01"
              value={track.pan}
              onChange={e => dispatch({
                type: 'UPDATE_TRACK',
                payload: { id: track.id, updates: { pan: parseFloat(e.target.value) } },
              })}
              onDoubleClick={() => dispatch({
                type: 'UPDATE_TRACK',
                payload: { id: track.id, updates: { pan: 0 } },
              })}
              className="inspector-pan-slider"
              style={{ width: 120 }}
            />
            <span className="fader-value" style={{ minWidth: 28 }}>{panLabel}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default InspectorPanel;
