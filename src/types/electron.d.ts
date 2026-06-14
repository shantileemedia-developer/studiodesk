// Type declarations for the Electron IPC bridge exposed via preload.ts
// Allows renderer (React) code to call OS-level functions safely.

export {};

declare global {
  const __APP_VERSION__: string;
  interface Window {
    electronWindow?: {
      minimize: () => Promise<void>;
      maximize: () => Promise<void>;
      close:    () => Promise<void>;
    };
    studioRC: {
      /**
       * Inject an OS-level mouse or keyboard event via @nut-tree-fork/nut-js.
       * Only available in Electron. Injected at real screen coordinates.
       */
      injectInput: (event: OsInputEvent) => Promise<void>;

      /**
       * Get the primary display's pixel dimensions so we can map
       * normalized (0-1) coordinates → real screen pixels.
       */
      getScreenSize: () => Promise<{ width: number; height: number }>;

      /**
       * Get available desktop capture sources (fullscreen, windows) via
       * Electron's desktopCapturer API. Returns an array of sources with
       * id, name, and thumbnailDataUrl.
       */
      getScreenSources: () => Promise<Array<{
        id: string;
        name: string;
        thumbnailDataUrl: string;
      }>>;
    };
  }

  /** OS-level input event sent from engineer → artist IPC */
  type OsInputEvent =
    | { type: 'mouse-move';  x: number; y: number }
    | { type: 'mouse-down';  x: number; y: number; button: 'left' | 'right' | 'middle' }
    | { type: 'mouse-up';    x: number; y: number; button: 'left' | 'right' | 'middle' }
    | { type: 'mouse-click'; x: number; y: number; button: 'left' | 'right' | 'middle'; double?: boolean }
    | { type: 'scroll';      x: number; y: number; deltaX: number; deltaY: number }
    | { type: 'key-down';    key: string; code: string; modifiers: OsKeyModifiers }
    | { type: 'key-up';      key: string; code: string; modifiers: OsKeyModifiers };

  interface OsKeyModifiers {
    ctrl: boolean;
    shift: boolean;
    alt: boolean;
    meta: boolean;
  }
}
