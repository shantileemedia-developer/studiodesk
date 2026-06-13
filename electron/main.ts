import { app, BrowserWindow, dialog, ipcMain, desktopCapturer, screen as electronScreen } from 'electron';
import { autoUpdater } from 'electron-updater';
import path from 'path';
import fs from 'fs';

const isDev = !!process.env.VITE_DEV_SERVER_URL;

let mainWindow: BrowserWindow | null = null;

// ── Persist window bounds across relaunches ───────────────────────────────────

const boundsFile = path.join(app.getPath('userData'), 'window-bounds.json');

function loadBounds(): Electron.Rectangle | null {
  try {
    const raw = fs.readFileSync(boundsFile, 'utf-8');
    const b = JSON.parse(raw);
    if (typeof b.x === 'number' && typeof b.y === 'number' &&
        typeof b.width === 'number' && typeof b.height === 'number') {
      return b as Electron.Rectangle;
    }
  } catch { /* first launch — no file yet */ }
  return null;
}

function saveBounds(win: BrowserWindow) {
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

  // ── Crash recovery — auto-reload on renderer crash ───────────────────────
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[crash] Renderer process gone:', details.reason);
    if (mainWindow && details.reason !== 'clean-exit') {
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'StudioDESK — Unexpected Error',
        message: 'The app window crashed unexpectedly.',
        detail: 'StudioDESK will reload automatically.',
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
      message: 'A new version of StudioDESK is ready to install.',
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

async function loadNut() {
  if (!nutMouse) {
    try {
      const nut = await import('@nut-tree-fork/nut-js');
      nutMouse    = nut.mouse;
      nutKeyboard = nut.keyboard;
      nutKey      = nut.Key;
      nutButton   = nut.Button;
      // Speed settings — lower = faster
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
  if (!nutMouse || !nutKeyboard) return;

  try {
    const { Point } = await import('@nut-tree-fork/nut-js');

    switch (event.type) {
      case 'mouse-move':
        await nutMouse.move([new Point(event.x, event.y)]);
        break;

      case 'mouse-down': {
        await nutMouse.move([new Point(event.x, event.y)]);
        const btn = toNutButton(event.button);
        if (btn !== null) await nutMouse.pressButton(btn);
        break;
      }

      case 'mouse-up': {
        await nutMouse.move([new Point(event.x, event.y)]);
        const btn = toNutButton(event.button);
        if (btn !== null) await nutMouse.releaseButton(btn);
        break;
      }

      case 'mouse-click': {
        await nutMouse.move([new Point(event.x, event.y)]);
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
        await nutMouse.move([new Point(event.x, event.y)]);
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
    // Don't let a failed injection crash anything
    console.error('[RC] inject-input error:', err);
  }
});

// rc:get-screen-size — primary display resolution for coordinate mapping
ipcMain.handle('rc:get-screen-size', () => {
  const { width, height } = electronScreen.getPrimaryDisplay().bounds;
  return { width, height };
});

// rc:get-sources — enumerate desktop / window sources for full-desktop share
ipcMain.handle('rc:get-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 320, height: 180 },
  });
  return sources.map(s => ({
    id:               s.id,
    name:             s.name,
    thumbnailDataUrl: s.thumbnail.toDataURL(),
  }));
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
