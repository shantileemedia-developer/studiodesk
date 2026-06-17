import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { createPortal } from 'react-dom';
import type { RemoteInputEvent } from '../../types/remote';
import './RemoteControlOverlay.css';

interface Props {
  userRole: 'artist' | 'engineer';
  onSendInput?: (event: RemoteInputEvent) => void;
  onRevoke?: () => void;
  onExit?: () => void;
  viewOnly?: boolean;
  mode?: 'app' | 'desktop';
}

export interface RemoteControlOverlayHandle {
  moveCursor: (nx: number, ny: number) => void;
}

const RemoteControlOverlay = forwardRef<RemoteControlOverlayHandle, Props>((
  { userRole, onSendInput, onRevoke, onExit, viewOnly, mode = 'desktop' },
  ref,
) => {
  const cursorRef = useRef<HTMLDivElement>(null);

  // Stable refs so event listeners never need to be torn down due to prop changes
  const onSendInputRef = useRef(onSendInput);
  const onExitRef      = useRef(onExit);
  const onRevokeRef    = useRef(onRevoke);
  useEffect(() => { onSendInputRef.current = onSendInput; }, [onSendInput]);
  useEffect(() => { onExitRef.current      = onExit;      }, [onExit]);
  useEffect(() => { onRevokeRef.current    = onRevoke;    }, [onRevoke]);

  // Expose direct DOM cursor update — bypasses React state/re-render entirely.
  // We convert normalized screen coordinates → viewport-relative CSS so the dot
  // aligns with nut-js even when the artist's window is not flush with the
  // top-left corner of the display (title bar, taskbar, or multi-monitor offset).
  useImperativeHandle(ref, () => ({
    moveCursor: (nx: number, ny: number) => {
      const el = cursorRef.current;
      if (!el) return;
      // window.screen.width/height = logical dimensions of the display the window is on
      // window.screenX/Y           = window's origin in screen coordinates
      // outerHeight - innerHeight  = title bar + border chrome
      const sw       = window.screen.width;
      const sh       = window.screen.height;
      const chromeH  = window.outerHeight - window.innerHeight;
      const chromeW  = (window.outerWidth  - window.innerWidth) / 2; // symmetric side borders
      const screenX  = nx * sw;
      const screenY  = ny * sh;
      const viewX    = screenX - window.screenX - chromeW;
      const viewY    = screenY - window.screenY - chromeH;
      el.style.left    = `${(viewX / window.innerWidth)  * 100}%`;
      el.style.top     = `${(viewY / window.innerHeight) * 100}%`;
      el.style.display = 'block';
    },
  }));

  // ── Engineer: forward events, rAF-throttle pointermove ───────────────────
  useEffect(() => {
    if (userRole !== 'engineer') return;
    // No onSendInput = badge-only mode (App RC showing label without event capture)
    if (!onSendInputRef.current) return;

    // App RC: capture phase so we see events before any stopPropagation in bubble handlers
    // (e.g. VerticalFader.onPointerDown). Capture-only-forward never calls stopImmediatePropagation
    // so the engineer's own React handlers still fire normally for immediate local feedback.
    // Desktop RC: bubble phase (the overlay's transparent div is on top, so there's no React
    // handler below it to conflict with).
    const isAppRc = mode === 'app';
    const cap = isAppRc;

    const norm = (e: PointerEvent | MouseEvent | WheelEvent) => ({
      nx: e.clientX / window.innerWidth,
      ny: e.clientY / window.innerHeight,
    });

    // Elements marked data-desktop-hud (e.g. FloatingVideoChat widget) work locally —
    // their events are never forwarded to the artist and always reach their own handlers.
    const isOnHud = (e: Event) =>
      !!(e.target as HTMLElement)?.closest('[data-desktop-hud]');

    // Cap pointermove sends to one per animation frame (~60fps)
    let pendingMove: RemoteInputEvent | null = null;
    let rafId: number | null = null;
    const flushMove = () => {
      if (pendingMove) { onSendInputRef.current?.(pendingMove); pendingMove = null; }
      rafId = null;
    };

    const onPointerMove = (e: PointerEvent) => {
      if (isOnHud(e)) return;
      // Pointermove: no stopImmediatePropagation — hover effects on engineer's UI are fine
      const { nx, ny } = norm(e);
      pendingMove = { type: 'pointermove', nx, ny, button: e.button, buttons: e.buttons };
      if (!rafId) rafId = requestAnimationFrame(flushMove);
    };
    const onPointerDown = (e: PointerEvent) => {
      if (isOnHud(e)) return;
      const { nx, ny } = norm(e);
      onSendInputRef.current?.({ type: 'pointerdown', nx, ny, button: e.button, buttons: e.buttons });
    };
    const onPointerUp = (e: PointerEvent) => {
      if (isOnHud(e)) return;
      const { nx, ny } = norm(e);
      onSendInputRef.current?.({ type: 'pointerup', nx, ny, button: e.button, buttons: 0 });
    };
    const onDblClick = (e: MouseEvent) => {
      if (isOnHud(e)) return;
      onSendInputRef.current?.({ type: 'dblclick', ...norm(e), button: e.button });
    };
    const onContextMenu = (e: MouseEvent) => {
      if (isOnHud(e)) return;
      if (!isAppRc) e.preventDefault(); // desktop mode: suppress engineer's own context menu
      onSendInputRef.current?.({ type: 'contextmenu', ...norm(e), button: e.button });
    };
    const onWheel = (e: WheelEvent) => {
      if (isOnHud(e)) return;
      onSendInputRef.current?.({ type: 'wheel', ...norm(e), deltaX: e.deltaX, deltaY: e.deltaY });
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onExitRef.current?.(); return; }
      if (isOnHud(e)) return;
      onSendInputRef.current?.({
        type: 'keydown', key: e.key, code: e.code,
        ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey,
        repeat: e.repeat,
      });
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return;
      if (isOnHud(e)) return;
      onSendInputRef.current?.({
        type: 'keyup', key: e.key, code: e.code,
        ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey,
        repeat: false,
      });
    };

    // In App RC mode, forward input value changes so text typed into controlled
    // React inputs (e.g. the tempo popover) reaches the artist's identical input.
    const onInputEvent = isAppRc ? (e: Event) => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
      if (isOnHud(e)) return;
      const rect = target.getBoundingClientRect();
      if (!rect.width && !rect.height) return;
      onSendInputRef.current?.({
        type: 'input-value',
        nx: (rect.left + rect.width  / 2) / window.innerWidth,
        ny: (rect.top  + rect.height / 2) / window.innerHeight,
        value: target.value,
      });
    } : null;

    window.addEventListener('pointerdown',  onPointerDown, cap);
    window.addEventListener('pointermove',  onPointerMove, cap);
    window.addEventListener('pointerup',    onPointerUp,   cap);
    window.addEventListener('dblclick',     onDblClick,    cap);
    window.addEventListener('contextmenu',  onContextMenu, cap);
    window.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup',   onKeyUp,   true);
    if (onInputEvent) window.addEventListener('input', onInputEvent, true);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener('pointerdown',  onPointerDown, cap);
      window.removeEventListener('pointermove',  onPointerMove, cap);
      window.removeEventListener('pointerup',    onPointerUp,   cap);
      window.removeEventListener('dblclick',     onDblClick,    cap);
      window.removeEventListener('contextmenu',  onContextMenu, cap);
      window.removeEventListener('wheel', onWheel, { passive: true } as EventListenerOptions);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup',   onKeyUp,   true);
      if (onInputEvent) window.removeEventListener('input', onInputEvent, true);
    };
  }, [userRole, mode]);

  // ── Artist: ESC revokes RC ────────────────────────────────────────────────
  useEffect(() => {
    if (userRole !== 'artist') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onRevokeRef.current?.(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [userRole]);

  // ── Engineer view: badge only (they see their own app natively) ───────────
  if (userRole === 'engineer') {
    const label = mode === 'app' ? 'APP CONTROL' : viewOnly ? 'SCREEN VIEW' : 'DESKTOP CONTROL';
    return createPortal(
      <div className="rc-badge-wrap">
        <div className={`rc-badge${viewOnly ? ' rc-badge-view' : ''}`}>
          <span className="rc-badge-dot" />
          <span className="rc-badge-label">{label}</span>
          {onExit && (
            <button className="rc-badge-exit" onClick={onExit} title="Exit Remote Mode (Esc)">✕</button>
          )}
        </div>
      </div>,
      document.body,
    );
  }

  // ── Artist view: badge + cursor dot (DOM-direct, zero React overhead) ─────
  const artistLabel = mode === 'app' ? 'APP CONTROL' : viewOnly ? 'SCREEN VIEW' : 'DESKTOP CONTROL';
  return (
    <>
      {createPortal(
        <div className="rc-badge-wrap">
          <div className={`rc-badge${viewOnly ? ' rc-badge-view' : ''}`}>
            <span className="rc-badge-dot" />
            <span className="rc-badge-label">{artistLabel}</span>
            {onRevoke && (
              <button className="rc-badge-exit" onClick={onRevoke} title="Stop sharing (Esc)">✕</button>
            )}
          </div>
        </div>,
        document.body,
      )}
      {createPortal(
        <div ref={cursorRef} className="rc-remote-cursor" style={{ display: 'none' }} />,
        document.body,
      )}
    </>
  );
});

RemoteControlOverlay.displayName = 'RemoteControlOverlay';
export default RemoteControlOverlay;
