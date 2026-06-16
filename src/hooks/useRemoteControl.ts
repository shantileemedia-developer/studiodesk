import { useRef, useCallback, useEffect } from 'react';
import type { RemoteInputEvent } from '../types/remote';

const isElectron = typeof window !== 'undefined' && !!window.studioRC;

// ── Artist-side: receive and execute input from engineer ─────────────────────

export const useRemoteControlReplay = (isActive: boolean, mode: 'app' | 'desktop' = 'desktop') => {
  const capturedElementRef = useRef<Element | null>(null);
  const screenSizeRef      = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const hasDraggedRef      = useRef(false);

  // Fetch screen size eagerly on mount so it's ready before the first RC event arrives.
  // Also re-fetch whenever RC activates in case the display changed.
  useEffect(() => {
    if (!isElectron) return;
    window.studioRC.getScreenSize()
      .then(size => { screenSizeRef.current = size; })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!isActive || !isElectron) return;
    window.studioRC.getScreenSize()
      .then(size => { screenSizeRef.current = size; })
      .catch(() => {});
  }, [isActive]);

  useEffect(() => {
    if (!isActive) capturedElementRef.current = null;
  }, [isActive]);

  const replayEvent = useCallback((event: RemoteInputEvent) => {
    if (!isActive) return;

    // ── Electron + Desktop Control: OS-level injection via nut-js ───────
    // App Control uses DOM dispatch (below) so coords map to app viewport, not screen.
    if (isElectron && screenSizeRef.current && mode === 'desktop') {
      const { width, height } = screenSizeRef.current;

      if (event.type === 'keydown') {
        window.studioRC.injectInput({
          type: 'key-down',
          key:  event.key,
          code: event.code,
          modifiers: { ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey, meta: event.metaKey },
        }).catch(() => {});
        return;
      }

      if (event.type === 'keyup') {
        window.studioRC.injectInput({
          type: 'key-up',
          key:  event.key,
          code: event.code,
          modifiers: { ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey, meta: event.metaKey },
        }).catch(() => {});
        return;
      }

      // Pointer events — map normalized coords → real screen pixels.
      // Add the display's virtual-screen offset (x, y) so clicks land on the
      // correct monitor when the primary display is not the leftmost one.
      const pe  = event as Extract<RemoteInputEvent, { nx: number }>;
      const x   = Math.round(pe.nx * width  + (screenSizeRef.current?.x ?? 0));
      const y   = Math.round(pe.ny * height + (screenSizeRef.current?.y ?? 0));
      const btn = 'button' in pe ? (pe.button === 2 ? 'right' : pe.button === 1 ? 'middle' : 'left') : 'left';

      switch (pe.type) {
        case 'pointermove':
          window.studioRC.injectInput({ type: 'mouse-move', x, y }).catch(() => {});
          break;
        case 'pointerdown':
          window.studioRC.injectInput({ type: 'mouse-down', x, y, button: btn }).catch(() => {});
          break;
        case 'pointerup':
          window.studioRC.injectInput({ type: 'mouse-up', x, y, button: btn }).catch(() => {});
          break;
        case 'click':
          window.studioRC.injectInput({ type: 'mouse-click', x, y, button: btn }).catch(() => {});
          break;
        case 'dblclick':
          window.studioRC.injectInput({ type: 'mouse-click', x, y, button: btn, double: true }).catch(() => {});
          break;
        case 'contextmenu':
          window.studioRC.injectInput({ type: 'mouse-click', x, y, button: 'right' }).catch(() => {});
          break;
        case 'wheel':
          window.studioRC.injectInput({
            type: 'scroll', x, y,
            deltaX: (pe as any).deltaX,
            deltaY: (pe as any).deltaY,
          }).catch(() => {});
          break;
      }
      return;
    }

    // ── Browser fallback: DOM event replay (original implementation) ──────
    if (event.type === 'keydown' || event.type === 'keyup') {
      document.dispatchEvent(new KeyboardEvent(event.type, {
        bubbles: true, cancelable: true,
        key: event.key, code: event.code,
        ctrlKey: event.ctrlKey, shiftKey: event.shiftKey,
        altKey: event.altKey, metaKey: event.metaKey,
        repeat: event.repeat,
      }));
      return;
    }

    const pe   = event as Extract<RemoteInputEvent, { nx: number }>;
    const cssX = pe.nx * window.innerWidth;
    const cssY = pe.ny * window.innerHeight;

    let target: Element | null;
    if ((event.type === 'pointermove' || event.type === 'pointerup') && capturedElementRef.current) {
      target = capturedElementRef.current;
    } else {
      target = document.elementFromPoint(cssX, cssY);
    }
    if (!target) return;

    if (event.type === 'pointerdown') {
      capturedElementRef.current = target;
      hasDraggedRef.current = false;
    } else if (event.type === 'pointermove') {
      hasDraggedRef.current = true;
    } else if (event.type === 'pointerup') {
      capturedElementRef.current = null;
    }

    const origSet     = Element.prototype.setPointerCapture;
    const origRelease = Element.prototype.releasePointerCapture;
    Element.prototype.setPointerCapture     = function () {};
    Element.prototype.releasePointerCapture = function () {};

    // Map pointer event types to their mouse equivalents
    const MOUSE_MAP: Record<string, string> = {
      pointerdown: 'mousedown',
      pointermove: 'mousemove',
      pointerup:   'mouseup',
    };

    try {
      const a = pe as any;
      if (pe.type === 'wheel') {
        target.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true, cancelable: true,
          clientX: cssX, clientY: cssY,
          deltaX: a.deltaX, deltaY: a.deltaY,
          deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        }));
      } else if (pe.type === 'click' || pe.type === 'dblclick' || pe.type === 'contextmenu') {
        target.dispatchEvent(new MouseEvent(pe.type, {
          bubbles: true, cancelable: true,
          clientX: cssX, clientY: cssY,
          button: a.button,
        }));
      } else {
        // Dispatch PointerEvent (for onPointerDown handlers like the timeline ruler)
        target.dispatchEvent(new PointerEvent(pe.type, {
          bubbles: true, cancelable: true,
          clientX: cssX, clientY: cssY,
          button: a.button, buttons: a.buttons,
          pointerId: 999, isPrimary: true,
        }));
        // Also dispatch MouseEvent (for onMouseDown handlers and window/document listeners)
        const mouseType = MOUSE_MAP[pe.type];
        if (mouseType) {
          target.dispatchEvent(new MouseEvent(mouseType, {
            bubbles: true, cancelable: true,
            clientX: cssX, clientY: cssY,
            button: a.button, buttons: a.buttons,
          }));
        }
        // On pointerup without a preceding pointermove, dispatch a synthetic click so React
        // onClick handlers fire. The browser does this automatically on real input but not
        // on programmatic dispatchEvent. Skip if the engineer dragged — otherwise region
        // moves, timeline scrubs, and slider drags would spuriously trigger onClick targets.
        if (pe.type === 'pointerup' && !hasDraggedRef.current) {
          target.dispatchEvent(new MouseEvent('click', {
            bubbles: true, cancelable: true,
            clientX: cssX, clientY: cssY,
            button: a.button,
          }));
        }
        if (pe.type === 'pointerup') hasDraggedRef.current = false;
      }
    } finally {
      Element.prototype.setPointerCapture     = origSet;
      Element.prototype.releasePointerCapture = origRelease;
    }
  }, [isActive]);

  return { replayEvent };
};
