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
    studioProject?: {
      openFolderDialog: () => Promise<{ canceled: boolean; filePaths: string[] }>;
      setup:  (projectDir: string) => Promise<string>;
      save:   (projectDir: string, json: string) => Promise<void>;
      load:   (projectDir: string) => Promise<string>;
    };
    studioClipboard?: {
      write: (text: string) => Promise<void>;
    };
    studioRC: {
      /** Inject an OS-level mouse/keyboard event via nut-js at real screen coordinates. */
      injectInput: (event: OsInputEvent) => Promise<void>;

      /** Primary display logical bounds + DPI scale factor. Multiply width/height by scaleFactor for physical pixels (required by nut-js). */
      getScreenSize: () => Promise<{ x: number; y: number; width: number; height: number; scaleFactor: number }>;

      /** Desktop capture sources with thumbnailSize for aspect-ratio filtering. */
      getScreenSources: () => Promise<Array<{
        id: string;
        name: string;
        thumbnailDataUrl: string;
        thumbnailSize: { width: number; height: number };
      }>>;

      /**
       * Open a native audio-file picker from the main process.
       * Does NOT interrupt the renderer's screen-capture tracks.
       */
      openAudioDialog: () => Promise<{ canceled: boolean; filePaths: string[] }>;

      /**
       * Read a local file as Uint8Array.
       * Used with openAudioDialog() to load the chosen file content.
       */
      readFile: (filePath: string) => Promise<Uint8Array>;
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
