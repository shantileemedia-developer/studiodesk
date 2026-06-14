import React, { useRef, useEffect, useState } from 'react';
import type { RemoteInputEvent } from '../../types/remote';
import './RemoteControlOverlay.css';

interface Props {
  userRole: 'artist' | 'engineer';
  remoteScreenStream?: MediaStream | null;
  onSendInput?: (event: RemoteInputEvent) => void;
  onRevoke?: () => void; // artist
  onExit?: () => void;   // engineer
  /** normalized (0–1) cursor position broadcast by engineer — rendered for the artist */
  remoteCursorPos?: { nx: number; ny: number } | null;
}

const RemoteControlOverlay: React.FC<Props> = ({
  userRole, remoteScreenStream, onSendInput, onRevoke, onExit, remoteCursorPos,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoReady, setVideoReady] = useState(false);
  // Engineer's local cursor position shown as a dot on top of the screen-share video
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);

  // ── Assign stream and handle blank-screen race condition ──────────────────
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !remoteScreenStream) return;

    setVideoReady(false);
    el.srcObject = remoteScreenStream;

    const tryPlay = () => {
      el.play().catch(() => {
        // Auto-play policy: retry after a short delay
        setTimeout(() => el.play().catch(() => {}), 300);
      });
    };

    const onLoadedMetadata = () => { tryPlay(); };
    const onCanPlay = () => { setVideoReady(true); };

    el.addEventListener('loadedmetadata', onLoadedMetadata);
    el.addEventListener('canplay', onCanPlay);

    // Fallback: if events never fire (already ready), start immediately
    if (el.readyState >= 3) { tryPlay(); setVideoReady(true); }

    // Retry stream assignment every 600ms in case the stream wasn't ready
    let retryCount = 0;
    const retry = setInterval(() => {
      if (videoReady || retryCount++ > 8) { clearInterval(retry); return; }
      if (el.readyState < 2) { el.srcObject = null; el.srcObject = remoteScreenStream; }
    }, 600);

    return () => {
      el.removeEventListener('loadedmetadata', onLoadedMetadata);
      el.removeEventListener('canplay', onCanPlay);
      clearInterval(retry);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteScreenStream]);

  // ── Engineer: capture all pointer/keyboard input ──────────────────────────
  useEffect(() => {
    if (userRole !== 'engineer') return;
    const el = videoRef.current;
    if (!el) return;

    const getNorm = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      return {
        nx: (e.clientX - rect.left) / rect.width,
        ny: (e.clientY - rect.top) / rect.height,
      };
    };

    const onPointerDown = (e: PointerEvent) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const { nx, ny } = getNorm(e);
      onSendInput?.({ type: 'pointerdown', nx, ny, button: e.button, buttons: e.buttons });
    };

    const onPointerMove = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      // Update local cursor dot position
      setCursorPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      const { nx, ny } = getNorm(e);
      onSendInput?.({ type: 'pointermove', nx, ny, button: e.button, buttons: e.buttons });
    };

    const onPointerLeave = () => setCursorPos(null);

    const onPointerUp = (e: PointerEvent) => {
      e.preventDefault();
      const { nx, ny } = getNorm(e);
      onSendInput?.({ type: 'pointerup', nx, ny, button: e.button, buttons: 0 });
    };

    const onDblClick = (e: MouseEvent) => {
      e.preventDefault();
      const { nx, ny } = getNorm(e);
      onSendInput?.({ type: 'dblclick', nx, ny, button: e.button });
    };

    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      const { nx, ny } = getNorm(e);
      onSendInput?.({ type: 'contextmenu', nx, ny, button: e.button });
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { nx, ny } = getNorm(e);
      onSendInput?.({ type: 'wheel', nx, ny, deltaX: e.deltaX, deltaY: e.deltaY });
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onExit?.(); return; }
      e.preventDefault();
      onSendInput?.({
        type: 'keydown', key: e.key, code: e.code,
        ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey,
        repeat: e.repeat,
      });
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return;
      onSendInput?.({
        type: 'keyup', key: e.key, code: e.code,
        ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey,
        repeat: false,
      });
    };

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerleave', onPointerLeave);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('dblclick', onDblClick);
    el.addEventListener('contextmenu', onContextMenu);
    el.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerleave', onPointerLeave);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('dblclick', onDblClick);
      el.removeEventListener('contextmenu', onContextMenu);
      el.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [userRole, onSendInput, onExit]);

  if (userRole === 'engineer') {
    return (
      <div className="rc-engineer-overlay">
        <div className="rc-engineer-bar">
          <div className="rc-bar-left">
            <div className="rc-dot" />
            <span>REMOTE CONTROL ACTIVE — Artist&apos;s Session</span>
          </div>
          <button className="rc-exit-btn" onClick={onExit}>Exit Remote Control (Esc)</button>
        </div>
        <div className="rc-video-wrap">
          {/* Loading overlay while stream connects */}
          {!videoReady && (
            <div className="rc-loading-overlay">
              <div className="rc-loading-spinner" />
              <span>Connecting to Artist's screen…</span>
            </div>
          )}
          <video
            ref={videoRef}
            className="rc-screen-video"
            autoPlay
            playsInline
            muted
            style={{ opacity: videoReady ? 1 : 0 }}
          />
          {/* Engineer's cursor dot */}
          {cursorPos && (
            <div
              className="rc-cursor-dot"
              style={{ left: cursorPos.x, top: cursorPos.y }}
            />
          )}
        </div>
      </div>
    );
  }

  // ── Artist view ───────────────────────────────────────────────────────────
  return (
    <div className="rc-artist-overlay">
      <div className="rc-artist-bar">
        <div className="rc-bar-left">
          <div className="rc-dot" />
          <span>REMOTE CONTROL ACTIVE — Engineer is controlling your session</span>
        </div>
        <button className="rc-revoke-btn" onClick={onRevoke}>Revoke Access</button>
      </div>
      {/* Engineer's cursor shown on the artist's screen */}
      {remoteCursorPos && (
        <div
          className="rc-remote-cursor"
          style={{
            left:  `${remoteCursorPos.nx * 100}%`,
            top:   `${remoteCursorPos.ny * 100}%`,
          }}
        />
      )}
    </div>
  );
};

export default RemoteControlOverlay;
