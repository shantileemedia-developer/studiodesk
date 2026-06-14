import React, { useEffect, useRef } from 'react';
import {
  Play, Square, Circle, SkipBack, SkipForward, Repeat,
  Activity, LayoutPanelLeft, Radio,
} from 'lucide-react';
import { useDaw } from '../../context/DawContext';
import './TransportPanel.css';

interface TransportPanelProps {
  toggleInspector: () => void;
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
  toggleInspector, onPlay, onStop, onReturnToZero, onRecord,
  userRole, isStreaming = false, isReceiving = false, onToggleStream,
}) => {
  const { state, dispatch, currentTimeRef } = useDaw();
  const { isPlaying, isRecording, currentTime, tempo, timeSignature, isLooping } = state.transport;

  const timeDisplayRef = useRef<HTMLDivElement>(null);
  const barsDisplayRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);

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
        {/* Layout toggle */}
        <div className="transport-section">
          <button className="transport-btn layout-btn" onClick={toggleInspector} title="Toggle Inspector">
            <LayoutPanelLeft size={18} />
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
        <div className="transport-section tempo-section">
          <div className="tempo-box">
            <span className="label">TEMPO</span>
            <span className="value">{tempo.toFixed(1)}</span>
          </div>
          <div className="tempo-box">
            <span className="label">SIGNATURE</span>
            <span className="value">{timeSignature[0]}/{timeSignature[1]}</span>
          </div>
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
