import React, { useRef, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
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
  /** normalized (0–1) cursor position broadcast by artist — rendered for the engineer */
  artistCursorPos?: { nx: number; ny: number } | null;
  viewOnly?: boolean;
}

const RemoteControlOverlay: React.FC<Props> = ({
  userRole, remoteScreenStream, onSendInput, onRevoke, onExit, remoteCursorPos, artistCursorPos, viewOnly,
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

  // ── Artist: ESC key immediately revokes RC ────────────────────────────────
  useEffect(() => {
    if (userRole !== 'artist') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onRevoke?.(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [userRole, onRevoke]);

  if (userRole === 'engineer') {
    return (
      <div className="rc-engineer-overlay">
        <div className={`rc-engineer-bar${viewOnly ? ' rc-mode-view' : ''}`}>
          <div className="rc-bar-left">
            <div className="rc-dot" />
            <span>
              {viewOnly ? 'VIEW ONLY — Artist\'s Session' : 'FULL CONTROL — Artist\'s Session'}
            </span>
          </div>
          <div className="rc-bar-right">
            <span className={`rc-mode-badge${viewOnly ? ' rc-mode-badge-view' : ' rc-mode-badge-full'}`}>
              {viewOnly ? 'View Only' : 'Full Control'}
            </span>
            <button className="rc-exit-btn" onClick={onExit}>Exit (Esc)</button>
          </div>
        </div>
        <div className="rc-video-wrap">
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
          {/* Engineer cursor — blue dot (local pointer over screen-share video) */}
          {cursorPos && (
            <div
              className="rc-cursor-dot rc-cursor-engineer"
              style={{ left: cursorPos.x, top: cursorPos.y }}
            />
          )}
          {/* Artist cursor — teal dot showing where the artist's mouse is */}
          {artistCursorPos && (
            <div
              className="rc-cursor-dot rc-cursor-artist"
              style={{
                left: `${artistCursorPos.nx * 100}%`,
                top:  `${artistCursorPos.ny * 100}%`,
              }}
            />
          )}
        </div>
      </div>
    );
  }

  // ── Artist view ───────────────────────────────────────────────────────────
  return (
    <>
      <div className={`rc-artist-overlay${viewOnly ? ' rc-mode-view' : ''}`}>
        <div className={`rc-artist-bar${viewOnly ? ' rc-mode-view' : ''}`}>
          <div className="rc-bar-left">
            <div className="rc-dot" />
            <span>
              {viewOnly
                ? 'Engineer is watching your session'
                : 'Engineer has full control of your session (Press ESC to stop)'}
            </span>
          </div>
          <div className="rc-bar-right">
            <span className={`rc-mode-badge${viewOnly ? ' rc-mode-badge-view' : ' rc-mode-badge-full'}`}>
              {viewOnly ? 'View Only' : 'Full Control'}
            </span>
            <button className="rc-revoke-btn" onClick={onRevoke}>Stop Sharing</button>
          </div>
        </div>
      </div>
      {/* Engineer cursor — rendered at document.body level to escape all stacking contexts */}
      {remoteCursorPos && createPortal(
        <div
          className="rc-remote-cursor rc-cursor-engineer"
          style={{
            left: `${remoteCursorPos.nx * 100}%`,
            top:  `${remoteCursorPos.ny * 100}%`,
          }}
        />,
        document.body,
      )}
    </>
  );
};

export default RemoteControlOverlay;
