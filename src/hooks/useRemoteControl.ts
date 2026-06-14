import { useRef, useCallback, useEffect } from 'react';
import type { RemoteInputEvent } from '../types/remote';

const isElectron = typeof window !== 'undefined' && !!window.studioRC;

// ── Artist-side: receive and execute input from engineer ─────────────────────

export const useRemoteControlReplay = (isActive: boolean) => {
  const capturedElementRef = useRef<Element | null>(null);
  const screenSizeRef      = useRef<{ width: number; height: number } | null>(null);

  // Pre-fetch screen size once when RC activates (Electron only)
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

    // ── Electron path: OS-level injection via nut-js ──────────────────────
    if (isElectron && screenSizeRef.current) {
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

      // Pointer events — map normalized coords → real screen pixels
      const pe  = event as Extract<RemoteInputEvent, { nx: number }>;
      const x   = Math.round(pe.nx * width);
      const y   = Math.round(pe.ny * height);
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

    if (event.type === 'pointerdown') capturedElementRef.current = target;
    else if (event.type === 'pointerup') capturedElementRef.current = null;

    const origSet     = Element.prototype.setPointerCapture;
    const origRelease = Element.prototype.releasePointerCapture;
    Element.prototype.setPointerCapture     = function () {};
    Element.prototype.releasePointerCapture = function () {};

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
        target.dispatchEvent(new PointerEvent(pe.type, {
          bubbles: true, cancelable: true,
          clientX: cssX, clientY: cssY,
          button: a.button, buttons: a.buttons,
          pointerId: 999, isPrimary: true,
        }));
      }
    } finally {
      Element.prototype.setPointerCapture     = origSet;
      Element.prototype.releasePointerCapture = origRelease;
    }
  }, [isActive]);

  return { replayEvent };
};
