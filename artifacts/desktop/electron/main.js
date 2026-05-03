const {
  app, BrowserWindow, ipcMain, screen,
  systemPreferences, desktopCapturer, shell,
  Tray, Menu, nativeImage, globalShortcut, Notification, session,
  net,
} = require('electron');

// Import protocol if available (newer Electron versions)
let protocol;
try {
  protocol = require('electron').protocol;
} catch (err) {
  console.warn('[Noah] Could not import protocol module:', err.message);
}

// ── Custom app:// protocol ─────────────────────────────────────────────────────
// MUST be called synchronously before app.ready (before app.whenReady resolves).
// This registers "app" as a standard secure scheme, giving windows loaded from
// app://localhost a real origin so Firebase Google sign-in works correctly.
// (file:// has a null origin that Firebase and OAuth providers reject.)
if (protocol.registerSchemesAsPrivileged) {
  protocol.registerSchemesAsPrivileged([{
    scheme: 'app',
    privileges: {
      standard: true,       // behaves like https (relative URLs, cookies, storage)
      secure: true,         // treated as secure context (getUserMedia, etc.)
      supportFetchAPI: true,
      corsEnabled: false,   // no CORS preflight — all same-origin locally
    },
  }]);
} else {
  console.warn('[Noah] protocol.registerSchemesAsPrivileged not available - using fallback');
  if (protocol.registerServiceWorkerSchemes) {
    protocol.registerServiceWorkerSchemes(['app']);
  }
}
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

// ── Diagnostic logger → ~/noah-debug.log ─────────────────────────────────────
function noahLog(...args) {
  const msg = args.join(' ');
  console.log('[Noah]', msg);
  try {
    fs.appendFileSync(
      path.join(os.homedir(), 'noah-debug.log'),
      `[${new Date().toISOString()}] ${msg}\n`
    );
  } catch {}
}

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
const LOCAL_BACKEND_URL = 'http://localhost:8001';

function resolveBackendUrl() {
  if (process.env.NOAH_BACKEND_URL) return process.env.NOAH_BACKEND_URL.replace(/\/$/, '');
  try {
    const rc = path.join(os.homedir(), '.noahrc');
    if (fs.existsSync(rc)) {
      const cfg = JSON.parse(fs.readFileSync(rc, 'utf8'));
      if (cfg.backendUrl) return cfg.backendUrl.replace(/\/$/, '');
    }
  } catch {}
  // Default to hosted backend so packaged desktop builds work out-of-the-box.
  // Set NOAH_PREFER_LOCAL_BACKEND=1 for local backend-first development.
  if (process.env.NOAH_PREFER_LOCAL_BACKEND === '1') return LOCAL_BACKEND_URL;
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
    mainWindow.loadURL(VITE_URL + '/').catch(() => mainWindow.loadURL('app://localhost/'));
  } else if (isRemoteUI) {
    mainWindow.loadURL(VITE_URL + '/');
  } else {
    // Production: app:// protocol serves dist/ with a real origin so Firebase works
    mainWindow.loadURL('app://localhost/');
  }

  // ── Diagnostics: open DevTools + log all renderer events to ~/noah-debug.log ─
  noahLog('main window created, isDev=', isDev);

  mainWindow.webContents.on('did-start-loading', () => noahLog('did-start-loading'));
  mainWindow.webContents.on('did-stop-loading',  () => noahLog('did-stop-loading'));
  mainWindow.webContents.on('did-finish-load',   () => noahLog('did-finish-load'));
  mainWindow.webContents.on('dom-ready',         () => noahLog('dom-ready'));
  let failedOnce = false;
  mainWindow.webContents.on('did-fail-load', (e, code, desc, url) => {
    noahLog(`did-fail-load code=${code} desc=${desc} url=${url}`);
    if (failedOnce) return;
    failedOnce = true;
    // Show a visible error page instead of a black screen
    const html = `<html><body style="background:#111;color:#f44;font:16px monospace;padding:20px">
      <h2>Noah failed to load</h2>
      <p>Error ${code}: ${desc}</p>
      <p>URL: ${url}</p>
      <p>isDev: ${isDev}</p>
      <p>Log: ~/noah-debug.log</p>
    </body></html>`;
    mainWindow.webContents.loadURL('data:text/html,' + encodeURIComponent(html));
  });
  mainWindow.webContents.on('render-process-gone', (e, details) => {
    noahLog(`render-process-gone reason=${details.reason} exitCode=${details.exitCode}`);
  });
  mainWindow.webContents.on('console-message', (e, level, message, line, sourceId) => {
    if (level >= 2) noahLog(`console[${level}] ${message} (${sourceId}:${line})`);
  });


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
    floatingBar.loadURL(VITE_URL + '/floating-bar').catch(() => floatingBar.loadURL('app://localhost/#/floating-bar'));
  } else if (isRemoteUIBar) {
    floatingBar.loadURL(VITE_URL + '/floating-bar');
  } else {
    floatingBar.loadURL('app://localhost/#/floating-bar');
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

// ─── IPC: Google sign-in via system browser ───────────────────────────────────
// Opens a local HTTP server → serves a Firebase auth page → user signs in in
// the real browser → page POSTs the Google credential back → we relay to renderer.
ipcMain.handle('start-google-auth', (event, firebaseConfig) => {
  return new Promise((resolve) => {
    let authWin = null;   // reference shared between server handler and listen callback

    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        // Serve the sign-in page with Firebase config embedded
        const configJson = JSON.stringify(firebaseConfig);
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign in to Noah</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0d0f1a;
      color: #fff;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      background: #151827;
      border: 1px solid #2a2d3e;
      border-radius: 20px;
      padding: 48px 40px;
      width: 380px;
      text-align: center;
    }
    .logo {
      width: 72px;
      height: 72px;
      margin: 0 auto 24px;
      display: block;
    }
    h1 { font-size: 22px; font-weight: 600; margin-bottom: 8px; }
    .subtitle { color: #6b7280; font-size: 14px; margin-bottom: 32px; }
    .btn-google {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      width: 100%;
      padding: 13px 20px;
      background: #fff;
      color: #1f2937;
      border: none;
      border-radius: 10px;
      font-size: 15px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s;
    }
    .btn-google:hover { background: #f3f4f6; }
    .btn-google:disabled { opacity: 0.5; cursor: not-allowed; }
    .status {
      margin-top: 24px;
      font-size: 14px;
      color: #6b7280;
      min-height: 20px;
    }
    .success-icon { font-size: 48px; margin-bottom: 16px; }
    .success-title { font-size: 20px; font-weight: 600; color: #4ade80; margin-bottom: 8px; }
    .success-sub { color: #6b7280; font-size: 14px; line-height: 1.5; }
    #success-view, #error-view { display: none; }
    .error-title { font-size: 18px; font-weight: 600; color: #f87171; margin-bottom: 8px; }
    .error-msg { color: #6b7280; font-size: 13px; margin-bottom: 20px; word-break: break-word; }
    .btn-retry {
      background: transparent;
      border: 1px solid #374151;
      color: #d1d5db;
      padding: 10px 20px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 14px;
    }
    .btn-retry:hover { background: #1f2937; }
  </style>
</head>
<body>
  <div class="card">
    <div id="signin-view">
      <img class="logo" src="/logo.png" alt="Noah" />
      <h1>Sign in to Noah</h1>
      <p class="subtitle">Use your Google account to continue</p>
      <button class="btn-google" id="google-btn" onclick="startSignIn()">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z" fill="#4285F4"/>
          <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
          <path d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z" fill="#FBBC05"/>
          <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.96L3.964 6.292C4.672 4.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
        </svg>
        Continue with Google
      </button>
      <div class="status" id="status"></div>
    </div>
    <div id="success-view">
      <div class="success-icon">✓</div>
      <div class="success-title">You're signed in!</div>
      <p class="success-sub">Return to Noah — you're all set.<br>You can close this tab.</p>
    </div>
    <div id="error-view">
      <div class="error-title">Sign-in failed</div>
      <div class="error-msg" id="error-msg"></div>
      <button class="btn-retry" onclick="resetView()">Try again</button>
    </div>
  </div>

  <script type="importmap">
    { "imports": {
        "firebase/app":  "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js",
        "firebase/auth": "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js"
    } }
  </script>
  <script type="module">
    import { initializeApp }                                          from 'firebase/app';
    import { getAuth, GoogleAuthProvider, signInWithPopup,
             onAuthStateChanged }                                     from 'firebase/auth';

    const config = ${configJson};
    const fbApp  = initializeApp(config);
    const auth   = getAuth(fbApp);

    const btn    = document.getElementById('google-btn');
    const status = document.getElementById('status');

    // ── Wait for the auth SDK to finish its async startup before enabling ──
    // Firebase initialises IndexedDB and restores any persisted session.
    // Until that first onAuthStateChanged fires the SDK isn't safe to use,
    // which is why a too-fast click produces an opaque "Error."
    btn.disabled = true;
    status.textContent = 'Initialising…';

    const unsub = onAuthStateChanged(auth, () => {
      unsub();                          // one-shot
      btn.disabled = false;
      status.textContent = '';
    });

    window.startSignIn = async () => {
      btn.disabled = true;
      status.textContent = 'Opening Google sign-in…';
      try {
        const provider = new GoogleAuthProvider();
        const result   = await signInWithPopup(auth, provider);
        const cred     = GoogleAuthProvider.credentialFromResult(result);
        status.textContent = 'Completing sign-in…';
        await fetch('/credential', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken: cred.idToken, accessToken: cred.accessToken }),
        });
        document.getElementById('signin-view').style.display  = 'none';
        document.getElementById('success-view').style.display = 'block';
      } catch (err) {
        btn.disabled = false;
        status.textContent = '';
        document.getElementById('signin-view').style.display  = 'none';
        document.getElementById('error-view').style.display   = 'block';
        document.getElementById('error-msg').textContent = err.code
          ? err.code + ': ' + err.message
          : (err.message || String(err));
      }
    };

    window.resetView = () => {
      document.getElementById('signin-view').style.display  = 'block';
      document.getElementById('error-view').style.display   = 'none';
      btn.disabled = false;
      status.textContent = '';
    };
  </script>
</body>
</html>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);

      } else if (req.method === 'POST' && req.url === '/credential') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          server.close();

          try {
            const { idToken, accessToken } = JSON.parse(body);

            // Close the auth window — user is signed in
            if (authWin && !authWin.isDestroyed()) { authWin.close(); authWin = null; }

            // Send credential directly to the main window (not floating bar or others)
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('google-auth-result', { idToken, accessToken });
              mainWindow.focus();
            } else {
              // Fallback: try any non-floating window
              const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w !== floatingBar);
              if (win) { win.webContents.send('google-auth-result', { idToken, accessToken }); win.focus(); }
            }
          } catch (e) {
            noahLog('start-google-auth credential parse error:', e.message);
          }
          resolve({ started: true });
        });

      } else if (req.method === 'GET' && req.url === '/logo.png') {
        // Serve Noah logo from the bundled dist directory
        const logoPath = path.join(__dirname, '../dist/noah-logo.png');
        try {
          const logoData = fs.readFileSync(logoPath);
          res.writeHead(200, { 'Content-Type': 'image/png' });
          res.end(logoData);
        } catch (_) {
          res.writeHead(404); res.end();
        }

      } else {
        res.writeHead(404);
        res.end();
      }
    });

    // IMPORTANT: bind to "localhost" not "127.0.0.1".
    // Firebase's authorized domains includes "localhost" by default but NOT "127.0.0.1".
    server.listen(0, 'localhost', () => {
      const { port } = server.address();
      const url = `http://localhost:${port}/`;
      noahLog('Google auth server at', url);

      // ── Open a dedicated Electron window for auth ──────────────────────────
      // Using an Electron BrowserWindow (not shell.openExternal / system browser)
      // means:
      //  • No Safari/Chrome popup blocker — window.open is controlled by our
      //    setWindowOpenHandler below
      //  • window.opener is properly set in the Firebase popup window
      //  • postMessage between Electron windows works without origin restrictions
      //  • signInWithPopup works on first click (no async timing race)
      authWin = new BrowserWindow({
        width: 460,
        height: 600,
        title: 'Sign in to Noah',
        resizable: false,
        minimizable: false,
        fullscreenable: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          // No preload — this window only loads our local auth page
        },
      });

      // Allow Firebase's Google OAuth popup to open inside this window
      authWin.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
        if (
          popupUrl.includes('accounts.google.com') ||
          popupUrl.includes('firebaseapp.com') ||
          popupUrl.includes('google.com/o/oauth2')
        ) {
          return {
            action: 'allow',
            overrideBrowserWindowOptions: {
              width: 500, height: 650,
              resizable: false,
              webPreferences: { contextIsolation: true, nodeIntegration: false },
            },
          };
        }
        return { action: 'deny' };
      });

      authWin.on('closed', () => {
        authWin = null;
        if (server.listening) server.close();
      });

      authWin.loadURL(url);
      resolve({ started: true, port });
    });

    // Auto-close after 5 minutes to avoid stale servers
    setTimeout(() => {
      if (server.listening) {
        server.close();
        const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
        if (win) win.webContents.send('google-auth-result', { error: 'Sign-in timed out. Please try again.' });
        resolve({ started: false, error: 'timeout' });
      }
    }, 5 * 60 * 1000);
  });
});

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

// ─── IPC: Binary TTS synthesis (bypasses renderer CORS for audio endpoints) ──
ipcMain.handle('synthesize-tts', async (_, { url, method = 'POST', headers = {}, body = null }) => {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const lib = parsed.protocol === 'https:' ? https : http;
      const bodyStr = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;

      const reqHeaders = {
        'User-Agent': 'Noah-AI-Assistant/1.0',
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
        method,
        headers: reqHeaders,
        timeout: 25000,
      };

      const req = lib.request(options, (res) => {
        const chunks = [];
        let total = 0;
        res.on('data', (chunk) => {
          total += chunk.length;
          // Guardrail: cap at 15MB audio payload
          if (total <= 15 * 1024 * 1024) chunks.push(chunk);
        });
        res.on('end', () => {
          const contentType = res.headers['content-type'] || 'audio/mpeg';
          const raw = Buffer.concat(chunks);
          if ((res.statusCode || 500) >= 400) {
            resolve({
              success: false,
              statusCode: res.statusCode,
              error: raw.toString('utf-8').slice(0, 1000) || `TTS request failed (${res.statusCode})`,
              contentType,
            });
            return;
          }
          resolve({
            success: true,
            statusCode: res.statusCode,
            contentType,
            audioBase64: raw.toString('base64'),
          });
        });
      });

      req.on('error', (err) => resolve({ success: false, error: err.message }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ success: false, error: 'Request timed out' });
      });
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

  noahLog(`app ready, isDev=${isDev}, isPackaged=${app.isPackaged}`);

  // ── Register app:// protocol handler (production) ─────────────────────────
  // Serves the bundled dist/ directory over app://localhost/, giving the
  // renderer a real origin so Firebase Google sign-in works correctly.
  if (!isDev) {
    const distDir = path.join(__dirname, '../dist');
    protocol.handle('app', (request) => {
      const { pathname } = new URL(request.url);
      // Root → index.html; strip leading slash for path.join
      const relative = (pathname === '/' || pathname === '') ? 'index.html' : pathname.replace(/^\//, '');
      const filePath = path.join(distDir, relative);
      noahLog(`app:// serving ${pathname} → ${filePath}`);
      // net.fetch with file:// reads directly from the asar archive
      return net.fetch('file://' + filePath);
    });
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
});
