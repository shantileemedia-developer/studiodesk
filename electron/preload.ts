import { contextBridge, ipcRenderer } from 'electron';

// ── Legacy API (kept for backward compat) ────────────────────────────────────
contextBridge.exposeInMainWorld('api', {
  send: (channel: string, data: any) => {
    const validChannels = ['toMain'];
    if (validChannels.includes(channel)) ipcRenderer.send(channel, data);
  },
  receive: (channel: string, func: (...args: any[]) => void) => {
    const validChannels = ['fromMain'];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => func(...args));
    }
  },
});

// ── Window controls ──────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('electronWindow', {
  minimize:  () => ipcRenderer.invoke('window:minimize'),
  maximize:  () => ipcRenderer.invoke('window:maximize'),
  close:     () => ipcRenderer.invoke('window:close'),
});

// ── StudioRC Bridge — OS-level remote control ────────────────────────────────
contextBridge.exposeInMainWorld('studioRC', {
  /**
   * Inject an OS-level mouse/keyboard event via @nut-tree-fork/nut-js.
   * Coordinates are already in absolute screen pixels.
   */
  injectInput: (event: unknown): Promise<void> =>
    ipcRenderer.invoke('rc:inject-input', event),

  /**
   * Get the primary display's size so the renderer can map
   * normalized (0–1) coords → real screen pixels.
   */
  getScreenSize: (): Promise<{ width: number; height: number }> =>
    ipcRenderer.invoke('rc:get-screen-size'),

  /**
   * Get desktop/window capture sources from desktopCapturer.
   * Used by artist to pick which screen to share (full desktop by default).
   */
  getScreenSources: (): Promise<Array<{ id: string; name: string; thumbnailDataUrl: string }>> =>
    ipcRenderer.invoke('rc:get-sources'),
});
