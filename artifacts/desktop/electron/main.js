const {
  app, BrowserWindow, ipcMain, screen,
  systemPreferences, desktopCapturer, shell,
  Tray, Menu, nativeImage, globalShortcut, Notification, session
} = require('electron');
const path = require('path');
const fs   = require('fs');
const http  = require('http');
const https = require('https');
const { exec } = require('child_process');
const os   = require('os');

// ─── Auto-updater (electron-updater via GitHub Releases) ──────────────────────
// In dev / unsigned builds this is a no-op; it activates once the app is
// packaged and published to GitHub Releases with a valid latest-mac.yml.
let autoUpdater = null;
try {
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.logger = null;                    // silence updater noise in console
  autoUpdater.autoDownload = false;             // ask first, don't silently replace
  autoUpdater.autoInstallOnAppQuit = true;
} catch { /* electron-updater not bundled in dev */ }

// ── uiohook-napi: OS-level keyboard hook (fn key, bare modifiers, true keyup) ─
// Ships prebuilt binaries — just `npm install` in the desktop dir.
// Requires macOS Accessibility permission (prompted at startup if missing).
let uIOhook    = null;
let UiohookKey = {};
try {
  const mod  = require('uiohook-napi');
  uIOhook    = mod.uIOhook;
  UiohookKey = mod.UiohookKey || {};
  console.log('[Noah] uiohook-napi loaded ✓');
} catch (e) {
  console.warn('[Noah] uiohook-napi unavailable — falling back to globalShortcut:', e.message);
}

// Build keycode → label map
function buildKeycodeLabels(uiohookKeyEnum) {
  const labels = {
    // macOS-specific (Apple keyboard scan codes as seen by uiohook)
    63:   'fn',
    56:   '⌥',   3640: '⌥',   // Option left / right
    55:   '⌘',   3675: '⌘',   // Cmd left / right
    29:   '⌃',   3613: '⌃',   // Ctrl left / right
    42:   '⇧',   3633: '⇧',   // Shift left / right
    57:   'Space',
    58:   '⇪ CapsLock',
    1:    'Escape',
    14:   '⌫',
    28:   '↵ Enter',
  };
  // Supplement from the exported UiohookKey enum (F1–F12, arrows, …)
  for (const [name, code] of Object.entries(uiohookKeyEnum || {})) {
    if (!(code in labels)) labels[code] = name;
  }
  return labels;
}
let KEYCODE_LABELS = buildKeycodeLabels(UiohookKey);

// Ensure macOS always identifies this app as "Noah" in dialogs and permission prompts
app.setName('Noah');

const isDev = !app.isPackaged;

// ── Determine UI URL ──────────────────────────────────────────────────────────
// Priority: NOAH_UI_URL env var → ~/.noahrc file → localhost:5173 default
// Set NOAH_UI_URL to the Replit preview URL to always load the latest UI
// without re-downloading the source. Example ~/.noahrc:
//   { "uiUrl": "https://YOUR-REPLIT-DOMAIN/desktop" }
function resolveUIUrl() {
  if (process.env.NOAH_UI_URL) return process.env.NOAH_UI_URL.replace(/\/$/, '');
  try {
    const rc = path.join(os.homedir(), '.noahrc');
    if (fs.existsSync(rc)) {
      const cfg = JSON.parse(fs.readFileSync(rc, 'utf8'));
      if (cfg.uiUrl) return cfg.uiUrl.replace(/\/$/, '');
    }
  } catch {}
  return 'http://localhost:5173';
}
const VITE_URL = resolveUIUrl();

// Backend URL: env var → ~/.noahrc backendUrl → API server proxy fallback
// The API server proxy runs alongside the desktop UI and forwards requests
// to the Python backend (local dev) or a deployed Railway instance.
const PRODUCTION_BACKEND_URL = 'https://noah-production-0ef2.up.railway.app';

function resolveBackendUrl() {
  if (process.env.NOAH_BACKEND_URL) return process.env.NOAH_BACKEND_URL.replace(/\/$/, '');
  try {
    const rc = path.join(os.homedir(), '.noahrc');
    if (fs.existsSync(rc)) {
      const cfg = JSON.parse(fs.readFileSync(rc, 'utf8'));
      if (cfg.backendUrl) return cfg.backendUrl.replace(/\/$/, '');
    }
  } catch {}
  return PRODUCTION_BACKEND_URL;
}
const NOAH_BACKEND_URL = resolveBackendUrl();

let mainWindow = null;
let floatingBar = null;
let tray = null;
let isFloatingBarVisible = true;
let pttActive        = false;
let pttAccelerator   = 'CmdOrCtrl+Shift+Space';  // globalShortcut fallback
let pttReleaseTimer  = null;                       // key-repeat fallback timer

// uiohook PTT state
let currentPTTKeycode = 56;          // default: Option (⌥) — safe, no typing conflict
let currentPTTLabel   = '⌥';
let pttCapturing      = false;       // true while settings "Change" is active

// ─── Local HTTP server for production UI ─────────────────────────────────────
// Serving the bundled app over http://127.0.0.1 instead of file:// avoids every
// known Electron/Chromium file:// quirk: crossorigin module failures, CSP
// restrictions on null-origin, and ES module loading regressions in Electron 31+.

let uiServer   = null;
let uiPort     = 0;

const MIME_TYPES = {
  '.html':  'text/html; charset=utf-8',
  '.js':    'application/javascript; charset=utf-8',
  '.mjs':   'application/javascript; charset=utf-8',
  '.css':   'text/css; charset=utf-8',
  '.json':  'application/json; charset=utf-8',
  '.png':   'image/png',
  '.jpg':   'image/jpeg',
  '.jpeg':  'image/jpeg',
  '.svg':   'image/svg+xml',
  '.ico':   'image/x-icon',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':   'font/ttf',
  '.webp':  'image/webp',
};

function startUIServer() {
  return new Promise((resolve, reject) => {
    const distDir = path.join(__dirname, '../dist');

    uiServer = http.createServer((req, res) => {
      // Strip query string; decode URL-encoded chars
      let pathname;
      try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
      catch { pathname = '/'; }

      // Normalise: root → index.html, strip leading slash
      if (pathname === '/') pathname = '/index.html';
      const relative = pathname.replace(/^\//, '');
      const filePath = path.join(distDir, relative);

      // Security: never escape outside dist/
      if (!filePath.startsWith(distDir)) {
        res.writeHead(403); res.end('Forbidden'); return;
      }

      try {
        const data = fs.readFileSync(filePath);
        const ext  = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          // No caching — the app is local, stale files are confusing
          'Cache-Control': 'no-store',
        });
        res.end(data);
      } catch {
        // SPA fallback: any path that isn't a real file → index.html
        try {
          const html = fs.readFileSync(path.join(distDir, 'index.html'));
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(html);
        } catch (err2) {
          res.writeHead(500); res.end(`Server error: ${err2.message}`);
        }
      }
    });

    // Port 0 → OS picks an available port
    uiServer.listen(0, '127.0.0.1', () => {
      uiPort = uiServer.address().port;
      console.log(`[Noah] UI server listening on http://127.0.0.1:${uiPort}`);
      resolve(uiPort);
    });
    uiServer.on('error', reject);
  });
}

// ─── Window creation ──────────────────────────────────────────────────────────

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 650,
    minWidth: 720,
    minHeight: 500,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#0a0a0a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const isRemoteUI = !VITE_URL.includes('localhost') && !VITE_URL.includes('127.0.0.1');
  if (isDev) {
    // Development: Vite dev server
    mainWindow.loadURL(VITE_URL + '/').catch(() => {
      mainWindow.loadURL(`http://127.0.0.1:${uiPort}/`);
    });
  } else if (isRemoteUI) {
    // Remote URL override (e.g. ~/.noahrc uiUrl)
    mainWindow.loadURL(VITE_URL + '/');
  } else {
    // Production: local HTTP server serving dist/
    mainWindow.loadURL(`http://127.0.0.1:${uiPort}/`);
  }

  // Allow Firebase auth popup windows (Google sign-in)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (
      url.includes('accounts.google.com') ||
      url.includes('firebaseapp.com') ||
      url.includes('firebase.com')
    ) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 500, height: 650,
          webPreferences: { contextIsolation: true, nodeIntegration: false },
        },
      };
    }
    // Open all other external links in the system browser
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

function createFloatingBar() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  const barW = 520;

  floatingBar = new BrowserWindow({
    width: barW,
    height: 52,
    x: Math.round(width / 2 - barW / 2),
    y: 0,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    type: 'panel',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const isRemoteUIBar = !VITE_URL.includes('localhost') && !VITE_URL.includes('127.0.0.1');
  if (isDev) {
    floatingBar.loadURL(VITE_URL + '/floating-bar').catch(() => {
      floatingBar.loadURL(`http://127.0.0.1:${uiPort}/#/floating-bar`);
    });
  } else if (isRemoteUIBar) {
    floatingBar.loadURL(VITE_URL + '/floating-bar');
  } else {
    floatingBar.loadURL(`http://127.0.0.1:${uiPort}/#/floating-bar`);
  }

  floatingBar.setAlwaysOnTop(true, 'screen-saver');
  floatingBar.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  floatingBar.on('closed', () => { floatingBar = null; });
}

function createTray() {
  const iconPath = path.join(__dirname, '../assets/tray-icon.png');
  let trayIcon;
  if (fs.existsSync(iconPath)) {
    trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  } else {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('Noah AI Assistant');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open Noah', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } else { createMainWindow(); } } },
    { label: isFloatingBarVisible ? 'Hide Floating Bar' : 'Show Floating Bar', click: () => toggleFloatingBar() },
    { type: 'separator' },
    { label: 'Quit Noah', click: () => app.quit() },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    }
  });
}

function toggleFloatingBar() {
  if (!floatingBar) return;
  if (isFloatingBarVisible) { floatingBar.hide(); isFloatingBarVisible = false; }
  else { floatingBar.show(); isFloatingBarVisible = true; }
}

// ─── Push-to-talk ─────────────────────────────────────────────────────────────

function broadcastToAll(channel, data) {
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed()) win.webContents.send(channel, data);
  });
}

function firePTT(active) {
  if (floatingBar && !floatingBar.isDestroyed()) {
    // executeJavaScript with userGesture=true gives the renderer a transient user
    // activation — required for getUserMedia to succeed without a real click.
    const code = active
      ? `(function() {
           if (typeof window.__noahReacquireMic === 'function') window.__noahReacquireMic();
           if (typeof window.__noahPTT === 'function') window.__noahPTT(true);
         })()`
      : `if (typeof window.__noahPTT === 'function') window.__noahPTT(false)`;
    floatingBar.webContents.executeJavaScript(code, true)
      .catch(err => console.error('[Noah] PTT js error:', err));
  }
  broadcastToAll('ptt-toggle', active);
}

// ── Primary path: uiohook-napi (OS-level hook) ───────────────────────────────
// Captures ANY key: fn, bare ⌘/⌥/⌃/⇧, F1–F12, and gives true keyup events.
// Requires macOS Accessibility permission (prompted below at app startup).

function startUiohookPTT() {
  if (!uIOhook) return false;

  uIOhook.on('keydown', (e) => {
    // ── Capture mode: next keydown becomes the new PTT key ─────────────────
    if (pttCapturing) {
      pttCapturing = false;
      currentPTTKeycode = e.keycode;
      currentPTTLabel   = KEYCODE_LABELS[e.keycode] || `Key ${e.keycode}`;
      console.log('[Noah] PTT key set via capture:', currentPTTKeycode, currentPTTLabel);
      broadcastToAll('ptt-key-captured', { keycode: currentPTTKeycode, label: currentPTTLabel });
      return;
    }
    // ── Normal hold-to-talk ────────────────────────────────────────────────
    if (e.keycode === currentPTTKeycode && !pttActive) {
      pttActive = true;
      firePTT(true);
    }
  });

  uIOhook.on('keyup', (e) => {
    if (e.keycode === currentPTTKeycode && pttActive) {
      pttActive = false;
      firePTT(false);
    }
  });

  try {
    uIOhook.start();
    console.log('[Noah] uiohook PTT active — key:', currentPTTLabel, '(', currentPTTKeycode, ')');
    return true;
  } catch (err) {
    console.error('[Noah] uiohook.start() failed:', err.message);
    uIOhook = null;
    return false;
  }
}

// ── Fallback path: globalShortcut (key-repeat timer, combos only) ─────────────
// Used when uiohook-napi is not installed or fails to start.
// Hold-to-talk: OS sends repeated keydown events while held; we reset a timer on
// each one. 350 ms of silence → key released → stop recording.
const PTT_RELEASE_MS = 350;

function makePTTCallback() {
  return () => {
    if (!pttActive) { pttActive = true; firePTT(true); }
    clearTimeout(pttReleaseTimer);
    pttReleaseTimer = setTimeout(() => {
      if (pttActive) { pttActive = false; firePTT(false); }
    }, PTT_RELEASE_MS);
  };
}

function registerPTTShortcut(shortcutOrKeyCode) {
  if (uIOhook) return { ok: true, uiohook: true }; // uiohook handles it
  clearTimeout(pttReleaseTimer);
  if (pttActive) { pttActive = false; firePTT(false); }
  const acc = (shortcutOrKeyCode && shortcutOrKeyCode.includes('+'))
    ? shortcutOrKeyCode : 'CmdOrCtrl+Shift+Space';
  try {
    globalShortcut.unregisterAll();
    globalShortcut.register(acc, makePTTCallback());
    pttAccelerator = acc;
    broadcastToAll('ptt-accelerator-changed', acc);
    console.log('[Noah] globalShortcut PTT fallback registered:', acc);
    return { ok: true, accelerator: acc };
  } catch (e) {
    console.error('[Noah] Could not register globalShortcut:', acc, e.message);
    return { ok: false, accelerator: acc };
  }
}

// ─── IPC: Screen / System ────────────────────────────────────────────────────

ipcMain.handle('capture-screen', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 },
    });
    if (sources.length === 0) return null;
    return sources[0].thumbnail.toDataURL();
  } catch (err) {
    console.error('Screen capture error:', err);
    return null;
  }
});

ipcMain.handle('get-screen-permission', async () => {
  if (process.platform === 'darwin') {
    return systemPreferences.getMediaAccessStatus('screen');
  }
  return 'granted';
});

ipcMain.handle('open-external', (_, url) => shell.openExternal(url));

// Use macOS's native `open` command to launch files/apps — avoids TCC "(null)" permission errors
ipcMain.handle('open-path', async (_, filePath) => {
  return new Promise((resolve) => {
    const safe = filePath.replace(/'/g, "'\\''");
    exec(`open '${safe}'`, { timeout: 10000 }, (err) => {
      resolve({ success: !err, error: err?.message || null });
    });
  });
});
ipcMain.handle('open-settings', () => {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); mainWindow.webContents.send('navigate', '/settings'); }
});

ipcMain.on('floating-bar-expand',   () => { if (floatingBar) floatingBar.setSize(520, 300); });
ipcMain.on('floating-bar-collapse', () => { if (floatingBar) floatingBar.setSize(520, 52); });
ipcMain.on('floating-bar-drag', (_, { x, y }) => { if (floatingBar) floatingBar.setPosition(Math.round(x), Math.round(y)); });
ipcMain.on('show-main-window', () => {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); } else { createMainWindow(); }
});

// Queue-based Q&A relay: floating bar pushes, main window drains on mount and via live event
let floatingQAQueue = [];
ipcMain.on('floating-qa', (_, data) => {
  floatingQAQueue.push(data);
  // Also try to deliver immediately if main window is open
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('floating-qa-received', data);
  }
});
// Main window polls this on mount to catch anything that arrived before it was ready
ipcMain.handle('drain-floating-qa', () => {
  const items = [...floatingQAQueue];
  floatingQAQueue = [];
  return items;
});

// ─── IPC: Push-to-talk config ─────────────────────────────────────────────────

// PTT IPC ─────────────────────────────────────────────────────────────────────

// Renderer sends saved keycode from localStorage at startup
ipcMain.handle('register-ptt-keycode', (_, { keycode, label }) => {
  if (uIOhook && typeof keycode === 'number') {
    currentPTTKeycode = keycode;
    currentPTTLabel   = label || KEYCODE_LABELS[keycode] || `Key ${keycode}`;
    console.log('[Noah] PTT keycode updated:', currentPTTKeycode, currentPTTLabel);
    return { ok: true, uiohook: true };
  }
  return { ok: false };
});

// Settings "Change" button — next keydown captured as new PTT key
ipcMain.handle('start-ptt-capture', () => {
  if (!uIOhook) return { ok: false, reason: 'uiohook-unavailable' };
  pttCapturing = true;
  return { ok: true };
});
ipcMain.handle('cancel-ptt-capture', () => {
  pttCapturing = false;
  return { ok: true };
});

// Current PTT info (for UI display on load)
ipcMain.handle('get-ptt-info', () => ({
  uiohook:    !!uIOhook,
  keycode:    currentPTTKeycode,
  label:      currentPTTLabel,
  fallback:   pttAccelerator,
  appDir:     path.join(__dirname, '..'),   // artifacts/desktop root — for npm install hint
}));

// Legacy / fallback: globalShortcut registration (used when uiohook is unavailable)
ipcMain.handle('register-ptt', (_, shortcut) => registerPTTShortcut(shortcut));
ipcMain.handle('get-ptt-state', () => pttActive);
ipcMain.handle('get-ptt-accelerator', () => pttAccelerator);

// ─── IPC: API Keys (pass Replit/system env vars to renderer) ─────────────────

ipcMain.handle('get-api-keys', () => ({
  openai:   process.env.OPENAI_API_KEY   || process.env.VITE_OPENAI_API_KEY   || '',
  deepgram: process.env.DEEPGRAM_API_KEY || process.env.VITE_DEEPGRAM_API_KEY || '',
}));

// ─── IPC: Backend URL (from ~/.noahrc backendUrl or NOAH_BACKEND_URL env) ────

ipcMain.handle('get-backend-url', () => NOAH_BACKEND_URL || '');

// ─── IPC: Auto-update controls (triggered from Settings → About) ──────────────

ipcMain.handle('check-for-updates', async () => {
  if (!autoUpdater || !app.isPackaged) return { status: 'dev' };
  try {
    const result = await autoUpdater.checkForUpdates();
    return { status: 'checked', version: result?.updateInfo?.version };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
});

ipcMain.handle('download-update', async () => {
  if (!autoUpdater || !app.isPackaged) return;
  await autoUpdater.downloadUpdate();
});

ipcMain.handle('install-update', () => {
  if (!autoUpdater || !app.isPackaged) return;
  autoUpdater.quitAndInstall();
});

// ─── IPC: Brain mode (Classic / Hermes) ──────────────────────────────────────
// Persists brain mode to an in-process variable so the main process can gate
// certain IPC paths (e.g., routing voice queries) to the correct backend.

let _brainMode = 'classic';

ipcMain.handle('set-brain-mode', (_, mode) => {
  _brainMode = (mode === 'hermes') ? 'hermes' : 'classic';
  return { ok: true, mode: _brainMode };
});

ipcMain.handle('get-brain-mode', () => _brainMode);

// ─── IPC: Task execution ──────────────────────────────────────────────────────

ipcMain.handle('run-shell', async (_, command) => {
  return new Promise((resolve) => {
    exec(command, { timeout: 30000, cwd: os.homedir(), shell: '/bin/bash' }, (err, stdout, stderr) => {
      resolve({
        success: !err,
        output: (stdout + stderr).trim() || '(no output)',
        error: err?.message || null,
        exitCode: err?.code || 0,
      });
    });
  });
});

ipcMain.handle('run-applescript', async (_, script) => {
  return new Promise((resolve) => {
    const tmpFile = path.join(os.tmpdir(), `noah_${Date.now()}.scpt`);
    fs.writeFileSync(tmpFile, script, 'utf-8');
    exec(`osascript "${tmpFile}"`, { timeout: 15000 }, (err, stdout, stderr) => {
      fs.unlink(tmpFile, () => {});
      resolve({
        success: !err,
        output: (stdout + stderr).trim() || '(done)',
        error: err?.message || null,
      });
    });
  });
});

ipcMain.handle('read-file', async (_, filePath) => {
  try {
    const resolved = filePath.startsWith('~')
      ? path.join(os.homedir(), filePath.slice(1))
      : filePath;
    const content = fs.readFileSync(resolved, 'utf-8');
    return { success: true, content: content.slice(0, 12000) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('write-file', async (_, { filePath, content }) => {
  try {
    const resolved = filePath.startsWith('~')
      ? path.join(os.homedir(), filePath.slice(1))
      : filePath;
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, 'utf-8');
    return { success: true, path: resolved };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('list-directory', async (_, dirPath) => {
  try {
    const resolved = (dirPath || '~').startsWith('~')
      ? path.join(os.homedir(), (dirPath || '~').slice(1))
      : dirPath;
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    return {
      success: true,
      path: resolved,
      entries: entries.slice(0, 200).map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'directory' : 'file',
      })),
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('show-notification', (_, { title, body }) => {
  if (Notification.isSupported()) {
    const iconPath = path.join(__dirname, '../assets/tray-icon.png');
    const opts = { title, body, silent: false };
    if (fs.existsSync(iconPath)) opts.icon = iconPath;
    new Notification(opts).show();
  }
});

// ─── Notification helper (main-process use) ────────────────────────────────
function showNoahNotification(title, body, silent = true) {
  if (!Notification.isSupported()) return;
  const iconPath = path.join(__dirname, '../assets/tray-icon.png');
  const opts = { title, body, silent };
  if (fs.existsSync(iconPath)) opts.icon = iconPath;
  new Notification(opts).show();
}

ipcMain.handle('get-system-info', () => ({
  platform:  process.platform,
  homedir:   os.homedir(),
  username:  os.userInfo().username,
  hostname:  os.hostname(),
  arch:      os.arch(),
  shell:     process.env.SHELL || '/bin/zsh',
  node:      process.version,
}));

// ─── IPC: Web fetch (bypasses renderer CORS) ─────────────────────────────────

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

ipcMain.handle('fetch-url', async (_, url) => {
  return new Promise((resolve) => {
    try {
      const lib = url.startsWith('https') ? https : http;
      const req = lib.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/json,*/*',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: 15000,
      }, (res) => {
        // Follow redirect
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve({ success: false, redirect: res.headers.location, error: 'Redirect — retry with new URL' });
          return;
        }
        let data = '';
        res.on('data', chunk => { if (data.length < 500000) data += chunk; });
        res.on('end', () => {
          const contentType = res.headers['content-type'] || '';
          const isJson = contentType.includes('application/json');
          const text = isJson ? data.slice(0, 12000) : htmlToText(data).slice(0, 12000);
          resolve({ success: true, url, content: text, statusCode: res.statusCode, contentType });
        });
      });
      req.on('error', err => resolve({ success: false, url, error: err.message }));
      req.on('timeout', () => { req.destroy(); resolve({ success: false, url, error: 'Request timed out' }); });
    } catch (err) {
      resolve({ success: false, url, error: err.message });
    }
  });
});

// ─── IPC: Generic HTTP API call (for integrations) ───────────────────────────

ipcMain.handle('http-api-call', async (_, { method, url, headers, body }) => {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const lib = parsed.protocol === 'https:' ? https : http;
      const bodyStr = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;

      const reqHeaders = {
        'User-Agent': 'Noah-AI-Assistant/1.0',
        'Accept': 'application/json',
        ...headers,
      };
      if (bodyStr) {
        reqHeaders['Content-Length'] = Buffer.byteLength(bodyStr);
        if (!reqHeaders['Content-Type']) reqHeaders['Content-Type'] = 'application/json';
      }

      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: method || 'GET',
        headers: reqHeaders,
        timeout: 20000,
      };

      const req = lib.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { if (data.length < 100000) data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve({ success: true, statusCode: res.statusCode, data: parsed });
          } catch {
            resolve({ success: true, statusCode: res.statusCode, data: data.slice(0, 8000) });
          }
        });
      });

      req.on('error', err => resolve({ success: false, error: err.message }));
      req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'Request timed out' }); });
      if (bodyStr) req.write(bodyStr);
      req.end();
    } catch (err) {
      resolve({ success: false, error: err.message });
    }
  });
});

// ─── App lifecycle ────────────────────────────────────────────────────────────

// ─── Microphone permission ─────────────────────────────────────────────────────
// Request macOS TCC mic access before any window opens so the stream pre-warm
// in FloatingBar can succeed without requiring a click inside the window first.
// This triggers the system dialog on first run; on subsequent runs it resolves
// instantly because macOS remembers the grant.
async function ensureMicPermission() {
  if (process.platform !== 'darwin') return true;
  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'granted') return true;
  if (status === 'denied' || status === 'restricted') return false;
  // 'not-determined' → ask
  try { return await systemPreferences.askForMediaAccess('microphone'); }
  catch { return false; }
}

app.whenReady().then(async () => {
  // ── Chromium-level: auto-approve all mic/media permission requests ─────────
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(['microphone', 'media', 'audioCapture', 'mediakeysystem'].includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return ['microphone', 'media', 'audioCapture', 'mediakeysystem'].includes(permission);
  });

  // ── Start local UI server for production (serves dist/ over HTTP) ──────────
  if (!isDev) {
    try {
      await startUIServer();
    } catch (err) {
      console.error('[Noah] UI server failed to start:', err);
      // Fall back: try a fixed port
      uiPort = 14159;
    }
  }

  createMainWindow();
  createFloatingBar();
  createTray();

  // ── Request macOS notification permission ─────────────────────────────────
  // On first launch macOS shows the "Noah would like to send you notifications"
  // dialog (identical to the Docker Desktop / any other app prompt).
  // Calling Notification.show() once is all it takes — macOS handles the prompt.
  // We delay by 2 s so the app UI is visible before the system dialog appears.
  if (Notification.isSupported()) {
    setTimeout(() => {
      showNoahNotification(
        'Noah is ready',
        'Your AI assistant is running. Hold the shortcut key to talk.',
        true // silent — no sound on this welcome ping
      );
    }, 2000);
  }

  // ── Auto-update: check GitHub Releases 5 s after launch ─────────────────────
  if (autoUpdater && app.isPackaged) {
    autoUpdater.on('update-available', (info) => {
      showNoahNotification(
        `Noah ${info.version} is available`,
        'A new version is ready to download. Open Settings → About to update.',
        false
      );
    });
    autoUpdater.on('update-downloaded', () => {
      showNoahNotification(
        'Noah update downloaded',
        'Quit and relaunch Noah to install the latest version.',
        false
      );
    });
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5000);
  }

  // ── PTT: start uiohook (preferred) or fall back to globalShortcut ────────────
  if (uIOhook) {
    // On macOS, global key capture requires Accessibility permission.
    // isTrustedAccessibilityClient(true) shows the system prompt if not yet granted.
    if (process.platform === 'darwin') {
      const trusted = systemPreferences.isTrustedAccessibilityClient(false);
      if (!trusted) {
        console.warn('[Noah] Accessibility not granted — prompting...');
        // Open the Accessibility preference pane and show the system dialog
        systemPreferences.isTrustedAccessibilityClient(true);
      }
    }
    const started = startUiohookPTT();
    if (!started) {
      // uiohook failed to start (e.g. permission denied) — fall back
      registerPTTShortcut('CmdOrCtrl+Shift+Space');
    }
  } else {
    registerPTTShortcut('CmdOrCtrl+Shift+Space');
  }

  // ── macOS TCC: request mic permission, then warm the stream via IPC signal ──
  // The renderer (FloatingBar) calls notifyMicReady() via IPC the moment
  // window.__noahReacquireMic is defined (i.e. after React mounts its effect).
  // We respond by calling executeJavaScript(..., true) — userGesture=true — which
  // creates a synthetic transient user activation, satisfying Chromium's requirement
  // for getUserMedia without any real click from the user.
  //
  // The retry fallback (setInterval) handles edge cases where the IPC signal fires
  // before TCC permission is confirmed.

  let micReady = false;

  function triggerMicAcquire(webContents) {
    if (!webContents || webContents.isDestroyed()) return;
    webContents.executeJavaScript(
      'typeof window.__noahReacquireMic === "function" && window.__noahReacquireMic()',
      true
    ).catch(() => {});
  }

  // Renderer signals us the moment window.__noahReacquireMic is set
  ipcMain.once('mic-renderer-ready', (event) => {
    console.log('[Noah] Renderer mic hook ready — triggering acquisition');
    micReady = true;
    ensureMicPermission().then(granted => {
      console.log('[Noah] Mic TCC permission:', granted ? 'granted' : 'denied');
      if (granted) triggerMicAcquire(event.sender);
    });
  });

  // Fallback: poll every 600 ms for up to 20 s in case the IPC signal was missed
  ensureMicPermission().then(granted => {
    if (!granted) return;
    let attempts = 0;
    const iv = setInterval(() => {
      attempts++;
      if (micReady || attempts > 33) { clearInterval(iv); return; }
      if (floatingBar && !floatingBar.isDestroyed()) {
        triggerMicAcquire(floatingBar.webContents);
      }
    }, 600);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (pttActive) { pttActive = false; try { firePTT(false); } catch {} }
  if (uIOhook)  { try { uIOhook.stop(); } catch {} }
  globalShortcut.unregisterAll();
  if (tray) tray.destroy();
  if (uiServer) { try { uiServer.close(); } catch {} }
});
