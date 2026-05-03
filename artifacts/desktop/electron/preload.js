const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,

  // Screen
  captureScreen:      ()          => ipcRenderer.invoke('capture-screen'),
  getScreenPermission: ()         => ipcRenderer.invoke('get-screen-permission'),

  // Window
  openSettings:       ()          => ipcRenderer.invoke('open-settings'),
  openExternal:       (url)       => ipcRenderer.invoke('open-external', url),
  openPath:           (filePath)  => ipcRenderer.invoke('open-path', filePath),
  expandFloatingBar:  ()          => ipcRenderer.send('floating-bar-expand'),
  collapseFloatingBar: ()         => ipcRenderer.send('floating-bar-collapse'),
  dragFloatingBar:    (pos)       => ipcRenderer.send('floating-bar-drag', pos),
  showMainWindow:     ()          => ipcRenderer.send('show-main-window'),
  onNavigate:         (cb)        => ipcRenderer.on('navigate', (_, route) => cb(route)),

  // PTT (uiohook-napi — primary)
  getPTTInfo:            ()               => ipcRenderer.invoke('get-ptt-info'),
  registerPTTKeycode:    (keycode, label) => ipcRenderer.invoke('register-ptt-keycode', { keycode, label }),
  startPTTCapture:       ()               => ipcRenderer.invoke('start-ptt-capture'),
  cancelPTTCapture:      ()               => ipcRenderer.invoke('cancel-ptt-capture'),
  onPTTKeyCaptured:      (cb) => {
    const listener = (_, data) => cb(data);
    ipcRenderer.on('ptt-key-captured', listener);
    return () => ipcRenderer.removeListener('ptt-key-captured', listener);
  },
  // PTT (globalShortcut fallback)
  registerPTT:           (keyCode) => ipcRenderer.invoke('register-ptt', keyCode),
  getPTTState:           ()        => ipcRenderer.invoke('get-ptt-state'),
  getPTTAccelerator:     ()        => ipcRenderer.invoke('get-ptt-accelerator'),
  onPTTToggle:           (cb)      => {
    const listener = (_, active) => cb(active);
    ipcRenderer.on('ptt-toggle', listener);
    return () => ipcRenderer.removeListener('ptt-toggle', listener);
  },
  onPTTAcceleratorChanged: (cb)   => {
    const listener = (_, acc) => cb(acc);
    ipcRenderer.on('ptt-accelerator-changed', listener);
    return () => ipcRenderer.removeListener('ptt-accelerator-changed', listener);
  },

  // API keys
  getApiKeys:         ()          => ipcRenderer.invoke('get-api-keys'),

  // Backend URL (from ~/.noahrc or NOAH_BACKEND_URL env — set to Railway URL after deployment)
  getBackendUrl:      ()          => ipcRenderer.invoke('get-backend-url'),

  // Auto-update controls
  checkForUpdates:    ()          => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate:     ()          => ipcRenderer.invoke('download-update'),
  installUpdate:      ()          => ipcRenderer.invoke('install-update'),

  // Mic ready signal — renderer calls this when window.__noahReacquireMic is set
  notifyMicReady:     ()          => ipcRenderer.send('mic-renderer-ready'),

  // Task execution
  runShell:           (command)   => ipcRenderer.invoke('run-shell', command),
  runApplescript:     (script)    => ipcRenderer.invoke('run-applescript', script),
  readFile:           (filePath)  => ipcRenderer.invoke('read-file', filePath),
  writeFile:          (fp, c)     => ipcRenderer.invoke('write-file', { filePath: fp, content: c }),
  listDirectory:      (dirPath)   => ipcRenderer.invoke('list-directory', dirPath),
  showNotification:   (title, b)  => ipcRenderer.invoke('show-notification', { title, body: b }),
  getSystemInfo:      ()          => ipcRenderer.invoke('get-system-info'),

  // Network (bypasses browser CORS)
  fetchUrl:           (url)       => ipcRenderer.invoke('fetch-url', url),
  httpApiCall:        (opts)      => ipcRenderer.invoke('http-api-call', opts),
  synthesizeTTS:      (opts)      => ipcRenderer.invoke('synthesize-tts', opts),

  // Brain mode IPC signal — notifies main process of Classic/Hermes mode change
  setBrainMode:       (mode)      => ipcRenderer.invoke('set-brain-mode', mode),
  getBrainMode:       ()          => ipcRenderer.invoke('get-brain-mode'),

  // Google sign-in via system browser (avoids Electron popup restrictions)
  startGoogleAuth: (firebaseConfig) => ipcRenderer.invoke('start-google-auth', firebaseConfig),
  onGoogleAuthResult: (cb) => {
    const listener = (_, result) => cb(result);
    ipcRenderer.once('google-auth-result', listener);
    return () => ipcRenderer.removeListener('google-auth-result', listener);
  },

  // Floating bar Q&A relay
  relayFloatingQA:    (data)      => ipcRenderer.send('floating-qa', data),
  // Live event: fires whenever a new Q&A arrives while the window is open
  onFloatingQA:       (cb)        => {
    const listener = (_, data) => cb(data);
    ipcRenderer.on('floating-qa-received', listener);
    return () => ipcRenderer.removeListener('floating-qa-received', listener);
  },
  // Drain: returns all Q&A that accumulated before the main window was ready, then clears the queue
  drainFloatingQA:    ()          => ipcRenderer.invoke('drain-floating-qa'),
});
