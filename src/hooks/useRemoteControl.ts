import { useRef, useCallback, useEffect } from 'react';
import type { RemoteInputEvent } from '../types/remote';

const isElectron = typeof window !== 'undefined' && !!window.studioRC;

// ── Artist-side: receive and execute input from engineer ─────────────────────

export const useRemoteControlReplay = (
  isActive: boolean,
  mode: 'app' | 'desktop' = 'desktop',
  onInjectionError?: (err: unknown) => void,
) => {
  const capturedElementRef  = useRef<Element | null>(null);
  const screenSizeRef       = useRef<{ x: number; y: number; width: number; height: number; scaleFactor: number } | null>(null);
  const hasDraggedRef       = useRef(false);
  const prevHoverTargetRef  = useRef<Element | null>(null);
  const onInjectionErrorRef = useRef(onInjectionError);
  useEffect(() => { onInjectionErrorRef.current = onInjectionError; }, [onInjectionError]);

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
    if (!isActive) {
      capturedElementRef.current = null;
      prevHoverTargetRef.current = null;
    }
  }, [isActive]);

  const replayEvent = useCallback((event: RemoteInputEvent) => {
    if (!isActive) return;

    // ── Electron + Desktop Control: OS-level injection via nut-js ───────
    // App Control uses DOM dispatch (below) so coords map to app viewport, not screen.
    if (isElectron && screenSizeRef.current && mode === 'desktop') {
      const { width, height, x: screenX, y: screenY, scaleFactor = 1 } = screenSizeRef.current;
      const eventType = event.type;

      // Unified inject: logs success/failure so silent drops are visible.
      const inject = (payload: OsInputEvent) => {
        window.studioRC.injectInput(payload)
          .then(() => {
            if (eventType !== 'pointermove') console.log('[OS_INPUT_INJECTED]', eventType);
          })
          .catch((err: unknown) => {
            console.log('[OS_INPUT_FAILED]', eventType, err);
            onInjectionErrorRef.current?.(err);
          });
      };

      if (event.type === 'keydown') {
        inject({
          type: 'key-down',
          key:  event.key,
          code: event.code,
          modifiers: { ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey, meta: event.metaKey },
        });
        return;
      }

      if (event.type === 'keyup') {
        inject({
          type: 'key-up',
          key:  event.key,
          code: event.code,
          modifiers: { ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey, meta: event.metaKey },
        });
        return;
      }

      // Pointer events — map normalized coords → real screen pixels.
      // Add the display's virtual-screen offset (x, y) so clicks land on the
      // correct monitor when the primary display is not the leftmost one.
      const pe  = event as Extract<RemoteInputEvent, { nx: number }>;
      // nut-js Win32 backend uses physical pixel coordinates (SendInput ABSOLUTE mode).
      // Multiply logical bounds by scaleFactor to convert logical → physical pixels.
      const x   = Math.round(pe.nx * width  * scaleFactor + screenX * scaleFactor);
      const y   = Math.round(pe.ny * height * scaleFactor + screenY * scaleFactor);
      const btn = 'button' in pe ? (pe.button === 2 ? 'right' : pe.button === 1 ? 'middle' : 'left') : 'left';

      switch (pe.type) {
        case 'pointermove':
          inject({ type: 'mouse-move', x, y });
          break;
        case 'pointerdown':
          inject({ type: 'mouse-down', x, y, button: btn });
          break;
        case 'pointerup':
          inject({ type: 'mouse-up', x, y, button: btn });
          break;
        case 'click':
          inject({ type: 'mouse-click', x, y, button: btn });
          break;
        case 'dblclick':
          inject({ type: 'mouse-click', x, y, button: btn, double: true });
          break;
        case 'contextmenu':
          inject({ type: 'mouse-click', x, y, button: 'right' });
          break;
        case 'wheel':
          inject({
            type: 'scroll', x, y,
            deltaX: (pe as any).deltaX,
            deltaY: (pe as any).deltaY,
          });
          break;
      }
      return;
    }

    // ── Browser fallback: DOM event replay (original implementation) ──────
    if (event.type === 'keydown' || event.type === 'keyup') {
      // Target the focused element (e.g. tempo input) so React's onKeyDown fires
      // there. Falls back to document when no input is focused (global shortcuts).
      const ae = document.activeElement;
      const kbTarget = (ae && ae !== document.body && ae !== document.documentElement)
        ? ae
        : document;
      kbTarget.dispatchEvent(new KeyboardEvent(event.type, {
        bubbles: true, cancelable: true,
        key: event.key, code: event.code,
        ctrlKey: event.ctrlKey, shiftKey: event.shiftKey,
        altKey: event.altKey, metaKey: event.metaKey,
        repeat: event.repeat,
      }));
      return;
    }

    // ── Input value sync: set React controlled input value directly ──────────
    if (event.type === 'input-value') {
      const iv = event as Extract<RemoteInputEvent, { type: 'input-value' }>;
      const el = document.elementFromPoint(iv.nx * window.innerWidth, iv.ny * window.innerHeight);
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        nativeSetter?.call(el, iv.value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
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

    // Hover tracking: dispatch mouseover/mouseout when the pointer enters a new
    // element so React's onMouseEnter/Leave fires for hover-triggered UI like the
    // tempo and time-signature popovers. Skip during captured drags (target won't
    // change while capturedElementRef is set anyway).
    if (pe.type === 'pointermove') {
      const prev = prevHoverTargetRef.current;
      if (prev !== target) {
        if (prev) {
          prev.dispatchEvent(new MouseEvent('mouseout', {
            bubbles: true, cancelable: true,
            clientX: cssX, clientY: cssY,
            relatedTarget: target,
          }));
        }
        target.dispatchEvent(new MouseEvent('mouseover', {
          bubbles: true, cancelable: true,
          clientX: cssX, clientY: cssY,
          relatedTarget: prev,
        }));
        prevHoverTargetRef.current = target;
      }
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
          // Focus inputs/textareas so forwarded keystrokes land in the right element.
          // dispatchEvent('click') alone does not trigger browser-native focus.
          if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
            (target as HTMLInputElement | HTMLTextAreaElement).focus();
          }
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
