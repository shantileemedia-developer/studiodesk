import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

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

// ── Native Audio Engine Bridge ───────────────────────────────────────────────
contextBridge.exposeInMainWorld('audioEngine', {
  // Capability check
  isAvailable: (): Promise<boolean> => ipcRenderer.invoke('audio:isAvailable'),

  // Device enumeration
  getDevices: (): Promise<any[]> => ipcRenderer.invoke('audio:getDevices'),

  // Transport
  play: (specs: any[], startTime: number, outDeviceId?: number, sr?: number): Promise<void> =>
    ipcRenderer.invoke('audio:play', specs, startTime, outDeviceId, sr),
  stop: (): Promise<void>        => ipcRenderer.invoke('audio:stop'),
  seek: (t: number): Promise<void> => ipcRenderer.invoke('audio:seek', t),
  setTrackParams: (trackId: string, params: any): Promise<void> =>
    ipcRenderer.invoke('audio:setTrackParams', trackId, params),

  // Recording
  getTakePath: (name: string): Promise<string> => ipcRenderer.invoke('audio:getTakePath', name),
  startRecording: (filePath: string, inId?: number, outId?: number, sr?: number, numCh?: number): Promise<void> =>
    ipcRenderer.invoke('audio:startRecording', filePath, inId, outId, sr, numCh),
  stopRecording: (): Promise<{ filePath: string; duration: number } | null> =>
    ipcRenderer.invoke('audio:stopRecording'),

  // Monitoring
  startMonitoring: (inId?: number, outId?: number, sr?: number, numCh?: number): Promise<void> =>
    ipcRenderer.invoke('audio:startMonitoring', inId, outId, sr, numCh),
  stopMonitoring: (): Promise<void> => ipcRenderer.invoke('audio:stopMonitoring'),

  writeTemp: (name: string, data: ArrayBuffer): Promise<string> =>
    ipcRenderer.invoke('audio:writeTemp', name, data),

  // ── Audio Bus API ─────────────────────────────────────────────────────────
  // Subscribe/unsubscribe to named buses ('mic-input', 'playback-mix', …).
  // The DAW engine forwards the interleaved-Float32 chunks via busChunk events.
  subscribeBus:   (busId: string): Promise<void> =>
    ipcRenderer.invoke('audio:subscribeBus', busId),
  unsubscribeBus: (busId: string): Promise<void> =>
    ipcRenderer.invoke('audio:unsubscribeBus', busId),

  // Event subscriptions — return an unsubscribe function
  onBusChunk: (cb: (busId: string, data: Uint8Array) => void) => {
    const h = (_: IpcRendererEvent, busId: string, data: Buffer) => cb(busId, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    ipcRenderer.on('audio:busChunk', h);
    return () => ipcRenderer.off('audio:busChunk', h);
  },
  onPosition:    (cb: (t: number) => void)    => { const h = (_: IpcRendererEvent, t: number)    => cb(t);    ipcRenderer.on('audio:position',    h); return () => ipcRenderer.off('audio:position',    h); },
  onLevels:      (cb: (l: number[]) => void)  => { const h = (_: IpcRendererEvent, l: number[])  => cb(l);    ipcRenderer.on('audio:levels',      h); return () => ipcRenderer.off('audio:levels',      h); },
  onInputLevels: (cb: (l: number[]) => void)  => { const h = (_: IpcRendererEvent, l: number[])  => cb(l);    ipcRenderer.on('audio:inputLevels', h); return () => ipcRenderer.off('audio:inputLevels', h); },
  onEnded:       (cb: (t: number) => void)    => { const h = (_: IpcRendererEvent, t: number)    => cb(t);    ipcRenderer.on('audio:ended',       h); return () => ipcRenderer.off('audio:ended',       h); },
  onError:       (cb: (m: string) => void)    => { const h = (_: IpcRendererEvent, m: string)    => cb(m);    ipcRenderer.on('audio:error',       h); return () => ipcRenderer.off('audio:error',       h); },
  onUnavailable: (cb: () => void)             => { const h = () => cb();                                       ipcRenderer.on('audio:unavailable', h); return () => ipcRenderer.off('audio:unavailable', h); },
});

// ── Email Bridge ─────────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('studioEmail', {
  isConfigured: (): Promise<boolean>              => ipcRenderer.invoke('email:isConfigured'),
  configure:    (user: string, pass: string): Promise<void> => ipcRenderer.invoke('email:configure', user, pass),
  clearConfig:  (): Promise<void>                 => ipcRenderer.invoke('email:clearConfig'),
  send:         (to: string, subject: string, body: string): Promise<void> => ipcRenderer.invoke('email:send', to, subject, body),
});

// ── Project Bridge — artist-side local file management ───────────────────────
contextBridge.exposeInMainWorld('studioProject', {
  openFolderDialog: (): Promise<{ canceled: boolean; filePaths: string[] }> =>
    ipcRenderer.invoke('dialog:open-project-folder'),
  setup: (projectDir: string): Promise<string> =>
    ipcRenderer.invoke('project:setup', projectDir),
  save:  (projectDir: string, json: string): Promise<void> =>
    ipcRenderer.invoke('project:save', projectDir, json),
  load:  (projectDir: string): Promise<string> =>
    ipcRenderer.invoke('project:load', projectDir),
});

// ── StudioRC Bridge — OS-level remote control ────────────────────────────────
contextBridge.exposeInMainWorld('studioRC', {
  /** Inject an OS-level mouse/keyboard event via @nut-tree-fork/nut-js. */
  injectInput: (event: unknown): Promise<void> =>
    ipcRenderer.invoke('rc:inject-input', event),

  /** Primary display logical bounds (x/y are virtual-screen offsets on multi-monitor). */
  getScreenSize: (): Promise<{ x: number; y: number; width: number; height: number }> =>
    ipcRenderer.invoke('rc:get-screen-size'),

  /** Desktop capture sources — includes thumbnailSize for aspect-ratio filtering. */
  getScreenSources: (): Promise<Array<{
    id: string; name: string; thumbnailDataUrl: string;
    thumbnailSize: { width: number; height: number };
  }>> =>
    ipcRenderer.invoke('rc:get-sources'),

  /**
   * Open a native audio-file picker via the main process.
   * Avoids interrupting the renderer (which would end active screen-capture tracks).
   */
  openAudioDialog: (): Promise<{ canceled: boolean; filePaths: string[] }> =>
    ipcRenderer.invoke('dialog:open-audio'),

  /**
   * Read a local file as a Uint8Array.
   * Used after openAudioDialog() to load the chosen audio file without another dialog.
   */
  readFile: (filePath: string): Promise<Uint8Array> =>
    ipcRenderer.invoke('fs:read-file', filePath),
});

// ── Clipboard Bridge — routes through main process for guaranteed access ──────
contextBridge.exposeInMainWorld('studioClipboard', {
  write: (text: string) => ipcRenderer.invoke('clipboard:write', text),
});
