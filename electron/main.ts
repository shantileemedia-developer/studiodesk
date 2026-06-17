import { app, BrowserWindow, dialog, ipcMain, desktopCapturer, screen as electronScreen, safeStorage } from 'electron';
import nodemailer from 'nodemailer';
import { autoUpdater } from 'electron-updater';
import path from 'path';
import fs from 'fs';
import { NativeAudioEngine, nativeAudioAvailable } from './audioEngine';

const isDev = !!process.env.VITE_DEV_SERVER_URL;

let mainWindow: BrowserWindow | null = null;
// Last known non-maximized bounds — used to restore correctly after unmaximize
// on Windows, where calling setBounds() inside the 'maximize' handler clears
// the OS-level restore point.
let lastNormalBounds: Electron.Rectangle | null = null;

// ── Persist window bounds across relaunches ───────────────────────────────────

const boundsFile = path.join(app.getPath('userData'), 'window-bounds.json');

/**
 * Clamp a rectangle so it fits inside the work area of the display it's on.
 * Prevents the window from appearing behind the taskbar or off-screen after
 * display configuration changes (disconnected monitor, DPI changes, etc.).
 * Must only be called after app.whenReady() so electronScreen is available.
 */
function clampToWorkArea(b: Electron.Rectangle): Electron.Rectangle {
  const { workArea } = electronScreen.getDisplayMatching(b);
  const width  = Math.min(b.width,  workArea.width);
  const height = Math.min(b.height, workArea.height);
  const x = Math.max(workArea.x, Math.min(b.x, workArea.x + workArea.width  - width));
  const y = Math.max(workArea.y, Math.min(b.y, workArea.y + workArea.height - height));
  return { x, y, width, height };
}

function loadBounds(): Electron.Rectangle | null {
  try {
    const raw = fs.readFileSync(boundsFile, 'utf-8');
    const b = JSON.parse(raw);
    if (typeof b.x === 'number' && typeof b.y === 'number' &&
        typeof b.width === 'number' && typeof b.height === 'number') {
      // Clamp to work area so stale/bad saved bounds never hide the taskbar
      return clampToWorkArea(b as Electron.Rectangle);
    }
  } catch { /* first launch — no file yet */ }
  return null;
}

function saveBounds(win: BrowserWindow) {
  // Never persist bounds while maximized or minimized — those dimensions
  // are the maximized/minimized state, not the restore size.
  if (win.isMaximized() || win.isMinimized()) return;
  try {
    fs.writeFileSync(boundsFile, JSON.stringify(win.getBounds()));
  } catch { /* non-fatal */ }
}

const createWindow = () => {
  const savedBounds = loadBounds();

  mainWindow = new BrowserWindow({
    width: savedBounds?.width ?? 1280,
    height: savedBounds?.height ?? 820,
    x: savedBounds?.x,           // undefined → Electron centers automatically
    y: savedBounds?.y,
    center: !savedBounds,        // center only on very first launch
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#121212',
    titleBarStyle: 'hidden',
  });

  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL!);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  // Persist bounds whenever the user moves or resizes
  mainWindow.on('moved',   () => mainWindow && saveBounds(mainWindow));
  mainWindow.on('resized', () => mainWindow && saveBounds(mainWindow));

  // ── Windows taskbar fix ───────────────────────────────────────────────────
  // With titleBarStyle:'hidden', maximize() can extend the window behind the
  // taskbar. We track the last windowed bounds and clamp the maximized window
  // to the display's work area so the taskbar is always visible.
  if (process.platform === 'win32') {
    mainWindow.on('resize', () => {
      if (mainWindow && !mainWindow.isMaximized() && !mainWindow.isMinimized()) {
        lastNormalBounds = mainWindow.getBounds();
      }
    });
    mainWindow.on('move', () => {
      if (mainWindow && !mainWindow.isMaximized() && !mainWindow.isMinimized()) {
        lastNormalBounds = mainWindow.getBounds();
      }
    });
    mainWindow.on('maximize', () => {
      if (!mainWindow) return;
      const { workArea } = electronScreen.getDisplayMatching(mainWindow.getBounds());
      mainWindow.setBounds(workArea);
    });
    mainWindow.on('unmaximize', () => {
      if (mainWindow && lastNormalBounds) {
        mainWindow.setBounds(lastNormalBounds);
      }
    });
  }

  // ── Crash recovery — auto-reload on renderer crash ───────────────────────
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[crash] Renderer process gone:', details.reason);
    if (mainWindow && details.reason !== 'clean-exit') {
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'RiddimSync — Unexpected Error',
        message: 'The app window crashed unexpectedly.',
        detail: 'RiddimSync will reload automatically.',
        buttons: ['OK'],
      }).then(() => {
        if (mainWindow) {
          if (isDev) {
            mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL!);
          } else {
            mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
          }
        }
      });
    }
  });

  // Grant camera and microphone permissions — required in packaged Electron builds
  // where the default permission handler blocks getUserMedia requests.
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ['media', 'camera', 'microphone', 'display-capture', 'audioCapture', 'videoCapture'];
    callback(allowed.includes(permission));
  });

  mainWindow.on('closed', () => { mainWindow = null; });
};

// ── Auto-updater ────────────────────────────────────────────────────────────

function setupAutoUpdater() {
  // Only run in packaged app, not in dev
  if (isDev) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', () => {
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: 'A new version of RiddimSync is ready to install.',
      detail: 'Click "Restart & Update" to apply it now, or "Later" to install on next launch.',
      buttons: ['Restart & Update', 'Later'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  });

  autoUpdater.on('error', (err) => {
    // Silent — don't nag the user if there's no internet
    console.error('[updater]', err?.message ?? err);
  });

  // Check on launch, then every 4 hours
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
}

// ── IPC: updater ────────────────────────────────────────────────────────────
ipcMain.handle('updater:check', () => {
  if (!isDev) autoUpdater.checkForUpdates().catch(() => {});
});

// ── IPC: window controls ─────────────────────────────────────────────────────
ipcMain.handle('window:minimize',  () => mainWindow?.minimize());
ipcMain.handle('window:maximize',  () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.handle('window:close', () => mainWindow?.close());

// ── IPC: OS-level Remote Control (AnyDesk-style) ────────────────────────────
// Lazy-load nut-js so it doesn't slow down startup if RC is never used
let nutMouse: any = null;
let nutKeyboard: any = null;
let nutKey: any = null;
let nutButton: any = null;
let nutPoint: any = null;

async function loadNut() {
  if (!nutMouse) {
    try {
      const nut = await import('@nut-tree-fork/nut-js');
      nutMouse    = nut.mouse;
      nutKeyboard = nut.keyboard;
      nutKey      = nut.Key;
      nutButton   = nut.Button;
      nutPoint    = nut.Point;
      nutMouse.config.mouseSpeed    = 10000;
      nutKeyboard.config.autoDelayMs = 0;
    } catch (err) {
      console.error('[RC] Failed to load @nut-tree-fork/nut-js:', err);
    }
  }
}

/** Map a browser button index (0=left,1=middle,2=right) to nut-js Button */
const toNutButton = (btn: 'left' | 'right' | 'middle') => {
  if (!nutButton) return null;
  if (btn === 'right')  return nutButton.RIGHT;
  if (btn === 'middle') return nutButton.MIDDLE;
  return nutButton.LEFT;
};

/** Map a KeyboardEvent.code string to nut-js Key enum value */
const codeToNutKey = (code: string) => {
  if (!nutKey) return null;
  // Letters
  const letterMatch = code.match(/^Key([A-Z])$/);
  if (letterMatch) {
    const letter = letterMatch[1];
    return nutKey[letter as keyof typeof nutKey] ?? null;
  }
  // Digits
  const digitMatch = code.match(/^Digit(\d)$/);
  if (digitMatch) return nutKey[`Num${digitMatch[1]}` as keyof typeof nutKey] ?? null;
  // Special keys
  const map: Record<string, any> = {
    Space: nutKey.Space,   Enter: nutKey.Return,    Escape: nutKey.Escape,
    Tab:   nutKey.Tab,     Backspace: nutKey.Backspace, Delete: nutKey.Delete,
    ArrowLeft: nutKey.Left, ArrowRight: nutKey.Right, ArrowUp: nutKey.Up, ArrowDown: nutKey.Down,
    Home: nutKey.Home, End: nutKey.End, PageUp: nutKey.PageUp, PageDown: nutKey.PageDown,
    F1:  nutKey.F1,  F2:  nutKey.F2,  F3:  nutKey.F3,  F4:  nutKey.F4,
    F5:  nutKey.F5,  F6:  nutKey.F6,  F7:  nutKey.F7,  F8:  nutKey.F8,
    F9:  nutKey.F9,  F10: nutKey.F10, F11: nutKey.F11, F12: nutKey.F12,
    ControlLeft:  nutKey.LeftControl,  ControlRight: nutKey.RightControl,
    ShiftLeft:    nutKey.LeftShift,    ShiftRight:   nutKey.RightShift,
    AltLeft:      nutKey.LeftAlt,      AltRight:     nutKey.RightAlt,
    MetaLeft:     nutKey.LeftSuper,    MetaRight:    nutKey.RightSuper,
    Minus: nutKey.Minus, Equal: nutKey.Equal, BracketLeft: nutKey.LeftBracket,
    BracketRight: nutKey.RightBracket, Backslash: nutKey.Backslash,
    Semicolon: nutKey.Semicolon, Quote: nutKey.Quote, Comma: nutKey.Comma,
    Period: nutKey.Period, Slash: nutKey.Slash, Backquote: nutKey.Grave,
  };
  return map[code] ?? null;
};

// rc:inject-input — translate RemoteInputEvent → nut-js OS call
ipcMain.handle('rc:inject-input', async (_e, event: any) => {
  await loadNut();
  if (!nutMouse || !nutKeyboard || !nutPoint) return;

  // setPosition() snaps the cursor instantly (no interpolation).
  // move() animates along a path — unusable for real-time remote control.
  const pos = (x: number, y: number) => nutMouse.setPosition(new nutPoint(x, y));

  try {
    switch (event.type) {
      case 'mouse-move':
        await pos(event.x, event.y);
        break;

      case 'mouse-down': {
        await pos(event.x, event.y);
        const btn = toNutButton(event.button);
        if (btn !== null) await nutMouse.pressButton(btn);
        break;
      }

      case 'mouse-up': {
        await pos(event.x, event.y);
        const btn = toNutButton(event.button);
        if (btn !== null) await nutMouse.releaseButton(btn);
        break;
      }

      case 'mouse-click': {
        await pos(event.x, event.y);
        const btn = toNutButton(event.button);
        if (btn !== null) {
          if (event.double) {
            await nutMouse.doubleClick(btn);
          } else {
            await nutMouse.click(btn);
          }
        }
        break;
      }

      case 'scroll': {
        await pos(event.x, event.y);
        if (event.deltaY !== 0) await nutMouse.scrollDown(Math.round(event.deltaY / 100));
        if (event.deltaX !== 0) await nutMouse.scrollRight(Math.round(event.deltaX / 100));
        break;
      }

      case 'key-down': {
        const nutK = codeToNutKey(event.code);
        if (nutK !== null) await nutKeyboard.pressKey(nutK);
        break;
      }

      case 'key-up': {
        const nutK = codeToNutKey(event.code);
        if (nutK !== null) await nutKeyboard.releaseKey(nutK);
        break;
      }
    }
  } catch (err) {
    console.error('[RC] inject-input error:', err);
    throw err;
  }
});

// rc:get-screen-size — primary display bounds + scale factor.
// bounds are logical (DIP) pixels; scaleFactor converts to physical pixels,
// which is what nut-js's Win32 backend expects (SendInput absolute coords).
ipcMain.handle('rc:get-screen-size', () => {
  const display = electronScreen.getPrimaryDisplay();
  const { x, y, width, height } = display.bounds;
  return { x, y, width, height, scaleFactor: display.scaleFactor };
});

// rc:get-sources — enumerate desktop capture sources for full-desktop share.
// Returns each source with its thumbnail size so the renderer can filter out
// combined virtual-desktop sources (too wide = multiple monitors in one image).
ipcMain.handle('rc:get-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 320, height: 180 },
  });
  return sources.map(s => ({
    id:               s.id,
    name:             s.name,
    thumbnailDataUrl: s.thumbnail.toDataURL(),
    thumbnailSize:    s.thumbnail.getSize(),   // { width, height } of the actual capture
  }));
});

// ── File-picker & read via main process ──────────────────────────────────────
// Opening a dialog from the renderer via <input type="file"> briefly steals focus
// from the renderer window on Windows, which can terminate active MediaStream tracks
// (screen capture).  Using dialog.showOpenDialog() from the main process avoids this.
ipcMain.handle('dialog:open-audio', async () => {
  return dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{
      name: 'Audio Files',
      extensions: ['wav', 'mp3', 'mp4', 'aiff', 'aif', 'aac', 'ogg', 'flac', 'm4a', 'opus', 'weba'],
    }],
  });
});

ipcMain.handle('fs:read-file', async (_e, filePath: string) => {
  return fs.promises.readFile(filePath);
});

// ── Native Audio Engine ──────────────────────────────────────────────────────

const engine = new NativeAudioEngine();

/** Forward engine events to the focused renderer window. */
function sendToRenderer(channel: string, ...args: any[]) {
  BrowserWindow.getAllWindows().forEach(w => {
    if (!w.isDestroyed()) w.webContents.send(channel, ...args);
  });
}

// Throttle position events to ~20 ms (50 Hz) — enough for smooth scrubbing
let lastPosSend = 0;
engine.on('position',    (t: number) => {
  const now = Date.now();
  if (now - lastPosSend >= 20) { lastPosSend = now; sendToRenderer('audio:position', t); }
});
engine.on('levels',      (l: number[]) => sendToRenderer('audio:levels',      l));
engine.on('inputLevels', (l: number[]) => sendToRenderer('audio:inputLevels', l));
engine.on('ended',       (t: number)   => sendToRenderer('audio:ended',       t));
engine.on('error',       (m: string)   => sendToRenderer('audio:error',       m));
engine.on('unavailable', ()            => sendToRenderer('audio:unavailable'));
// Forward bus chunks to renderer (timing-critical — no throttle)
engine.on('busChunk', (busId: string, chunk: Buffer) =>
  sendToRenderer('audio:busChunk', busId, chunk));

ipcMain.handle('audio:isAvailable',  () => nativeAudioAvailable);
ipcMain.handle('audio:getDevices',   () => engine.getDevices());

ipcMain.handle('audio:play', async (_e, specs, startTime, outDeviceId, sr) => {
  await engine.startPlayback(specs, startTime, outDeviceId ?? -1, sr ?? 48000);
});
ipcMain.handle('audio:stop',  () => engine.stopPlayback());
ipcMain.handle('audio:seek',  (_e, t: number) => engine.seek(t));
ipcMain.handle('audio:setTrackParams', (_e, trackId: string, params: any) =>
  engine.setTrackParams(trackId, params));

ipcMain.handle('audio:getTakePath', (_e, name: string) => NativeAudioEngine.getTakePath(name));

ipcMain.handle('audio:startRecording', async (_e, filePath, inId, outId, sr, numCh) => {
  await engine.startRecording(filePath, inId ?? -1, outId ?? -1, sr ?? 48000, numCh ?? 2);
});
ipcMain.handle('audio:stopRecording', () => engine.stopRecording());

ipcMain.handle('audio:startMonitoring', async (_e, inId, outId, sr, numCh) => {
  await engine.startMonitoring(inId ?? -1, outId ?? -1, sr ?? 48000, numCh ?? 2);
});
ipcMain.handle('audio:stopMonitoring', () => engine.stopMonitoring());

// ── Audio Bus subscriptions ────────────────────────────────────────────────
// Track which buses each renderer window has subscribed to so we can clean
// up automatically if the renderer crashes — DAW engine keeps running.
const windowBusSubs = new Map<number, Set<string>>();

ipcMain.handle('audio:subscribeBus', (e, busId: string) => {
  const wcId = e.sender.id;
  if (!windowBusSubs.has(wcId)) {
    windowBusSubs.set(wcId, new Set());
    e.sender.once('destroyed', () => {
      // Renderer gone — unsubscribe all its buses so the engine can close
      // streams it no longer needs.  The DAW engine itself keeps running.
      windowBusSubs.get(wcId)?.forEach(id => engine.unsubscribeBus(id));
      windowBusSubs.delete(wcId);
    });
  }
  windowBusSubs.get(wcId)!.add(busId);
  engine.subscribeBus(busId);
});

ipcMain.handle('audio:unsubscribeBus', (e, busId: string) => {
  const wcId = e.sender.id;
  windowBusSubs.get(wcId)?.delete(busId);
  engine.unsubscribeBus(busId);
});

// Write an ArrayBuffer to a temp file and return its OS path.
// Used by the renderer to materialise blob/HTTP audio URLs as local files
// so the native engine (which runs in main) can read them by path.
ipcMain.handle('audio:writeTemp', async (_e, name: string, data: ArrayBuffer) => {
  const dir  = path.join(app.getPath('temp'), 'RiddimSync-audio');
  const file = path.join(dir, name.replace(/[^a-zA-Z0-9_\-. ]/g, '_'));
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(file, Buffer.from(data));
  return file;
});

// ── Project folder I/O (artist-side; Electron native path) ──────────────────

ipcMain.handle('dialog:open-project-folder', async () => {
  return dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: 'Set Project Folder',
  });
});

ipcMain.handle('project:setup', async (_e, projectDir: string) => {
  const audioDir = path.join(projectDir, 'Audio');
  await fs.promises.mkdir(audioDir,                          { recursive: true });
  await fs.promises.mkdir(path.join(projectDir, 'Exports'), { recursive: true });
  await fs.promises.mkdir(path.join(projectDir, 'Renders'), { recursive: true });
  NativeAudioEngine.setAudioDir(audioDir);
  return audioDir;
});

ipcMain.handle('project:save', async (_e, projectDir: string, json: string) => {
  await fs.promises.writeFile(path.join(projectDir, 'project.json'), json, 'utf-8');
});

ipcMain.handle('project:load', async (_e, projectDir: string) => {
  return fs.promises.readFile(path.join(projectDir, 'project.json'), 'utf-8');
});

// ── Email (Gmail SMTP via nodemailer) ────────────────────────────────────────

const emailConfigFile = path.join(app.getPath('userData'), 'email-config.enc');

function loadEmailConfig(): { user: string; pass: string } | null {
  try {
    if (!fs.existsSync(emailConfigFile)) return null;
    const enc = fs.readFileSync(emailConfigFile);
    const json = safeStorage.decryptString(enc);
    return JSON.parse(json);
  } catch { return null; }
}

ipcMain.handle('email:isConfigured', () => loadEmailConfig() !== null);

ipcMain.handle('email:configure', (_e, user: string, pass: string) => {
  const enc = safeStorage.encryptString(JSON.stringify({ user, pass }));
  fs.writeFileSync(emailConfigFile, enc);
});

ipcMain.handle('email:clearConfig', () => {
  if (fs.existsSync(emailConfigFile)) fs.unlinkSync(emailConfigFile);
});

ipcMain.handle('email:send', async (_e, to: string, subject: string, body: string) => {
  const cfg = loadEmailConfig();
  if (!cfg) throw new Error('Email not configured. Enter your Gmail credentials in the Admin panel.');

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: cfg.user, pass: cfg.pass },
  });

  await transporter.sendMail({
    from: `"RiddimSync" <${cfg.user}>`,
    to,
    subject,
    text: body,
  });
});

// ── App lifecycle ───────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  await engine.dispose();
});
