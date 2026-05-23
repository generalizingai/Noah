import { getOpenAIKey, getDeepgramKey, getOpenRouterKey, getSystemInstructions, getIntegrations, saveAllIntegrations } from './keys';
import { buildMemoryContext, addMemory, getAllMemories } from './memory';
import { appendLog, createDelegatedTask, markTask } from './tasks';

const BUILT_IN_GOOGLE_WORKSPACE_CLIENT_SECRET =
  import.meta.env.VITE_GOOGLE_WORKSPACE_CLIENT_SECRET ||
  import.meta.env.VITE_GOOGLE_CLIENT_SECRET ||
  '';

function getByokHeaders() {
  const headers = {};
  const openai = getOpenAIKey();
  const deepgram = getDeepgramKey();
  const openrouter = getOpenRouterKey();
  if (openai)     headers['X-BYOK-OpenAI']     = openai;
  if (deepgram)   headers['X-BYOK-Deepgram']   = deepgram;
  if (openrouter) headers['X-BYOK-OpenRouter']  = openrouter;
  return headers;
}

function backendHeaders(token, extra = {}) {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    ...getByokHeaders(),
    ...extra,
  };
}

// ─── Backend URL resolution ───────────────────────────────────────────────────
// Priority (highest to lowest):
//   1. ~/.noahrc backendUrl (Electron IPC) — set this to your Railway URL
//   2. VITE_NOAH_BACKEND_URL build-time env var
//   3. localhost:8001 fallback (local dev)
//
// The IPC call resolves asynchronously at startup and updates the module-level
// variable before any real user request is made.

const LOCAL_BACKEND_URL = 'http://localhost:8001';
const PRODUCTION_BACKEND_URL = 'https://noah-production-0ef2.up.railway.app';
const LS_EXECUTION_MODE = 'noah_execution_mode';
const LS_EXECUTION_PROFILE = 'noah_execution_profile';
const LS_RISK_LEVEL = 'noah_risk_level';
const LS_TRACE = 'noah_orchestration_trace';
const LS_METRICS = 'noah_orchestration_metrics';
let NOAH_BACKEND_URL = import.meta.env.VITE_NOAH_BACKEND_URL || PRODUCTION_BACKEND_URL;

if (typeof window !== 'undefined' && window.electronAPI?.getBackendUrl) {
  window.electronAPI.getBackendUrl().then(url => {
    if (url) NOAH_BACKEND_URL = url;
  }).catch(() => {});
}

function backendCandidates() {
  const set = new Set([
    NOAH_BACKEND_URL,
    import.meta.env.VITE_NOAH_BACKEND_URL || '',
    PRODUCTION_BACKEND_URL,
    LOCAL_BACKEND_URL,
  ].filter(Boolean));
  return [...set];
}

function isRetryableBackendError(err) {
  const msg = String(err?.message || '').toLowerCase();
  if (!msg) return false;
  return (
    msg.includes('timed out') ||
    msg.includes('timeout') ||
    msg.includes('failed to fetch') ||
    msg.includes('network') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('socket hang up') ||
    msg.includes('backend request failed') ||
    msg.includes('request failed')
  );
}

function isScreenInspectionQuestion(text = '') {
  const value = _normalizeIntentText(text);
  return /\b(screen|watch|see|visible|looking at|look at|frontmost|current window|on my screen|what do you see)\b/.test(value);
}

function _normalizeIntentText(text = '') {
  return String(text || '')
    .toLowerCase()
    // normalize common Unicode dashes/slashes to ASCII-ish separators
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[／∕]/g, '/')
    .replace(/[`’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function isDelegationRequest(text = '') {
  const value = _normalizeIntentText(text);
  const directCreatePattern =
    /(?:\b(can you|could you|please|kindly)\b.{0,20})?\b(deploy|spawn|create|launch|start|build)\b.{0,80}\b(worker|sub[-\s_/]?agent|agent|specialist)\b/.test(value);
  const directDelegatePattern =
    /(?:\b(can you|could you|please|kindly)\b.{0,20})?\b(delegate|assign)\b.{0,30}\b(this|it|task|work|job|objective|request)\b.{0,20}\bto\b.{0,25}\b(worker|sub[-\s_/]?agent|agent|specialist)\b/.test(value);
  return directCreatePattern || directDelegatePattern;
}

function isGoogleWorkspaceRequest(text = '') {
  const value = _normalizeIntentText(text);
  return /\b(google\s+drive|drive\s+file|google\s+doc|google\s+docs|google\s+sheet|google\s+sheets|spreadsheet|google\s+calendar|workspace)\b/.test(value);
}

function isGoogleWorkspaceDiagnosticRequest(text = '') {
  const value = _normalizeIntentText(text);
  return isGoogleWorkspaceRequest(value) && /\b(why|diagnos|error|permission|scope|access|not able|can't|cannot|failed|failing)\b/.test(value);
}

function inferGoogleDriveSearchQuery(text = '') {
  const raw = String(text || '').trim();
  const quoted = raw.match(/["“”']([^"“”']{3,})["“”']/);
  if (quoted?.[1]) return quoted[1].trim();
  return raw
    .replace(/\b(can you|could you|please|find|search|look for|open|on|in|my|the|file|sheet|doc|document|google|drive|workspace|account)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160) || raw.slice(0, 160);
}

function inferDelegationRole(text = '') {
  const value = _normalizeIntentText(text);
  if (/\b(seo|backlink|on-page|keyword|serp)\b/.test(value)) return 'seo';
  if (/\b(thread|content|copy|linkedin|twitter|x\b|facebook|post|viral)\b/.test(value)) return 'content';
  if (/\b(code|coding|developer|debug|app|website|build|program)\b/.test(value)) return 'coding';
  if (/\b(research|analy[sz]e|compare|investigate)\b/.test(value)) return 'research';
  return 'ops';
}

function buildDelegationArgsFromTranscript(text = '') {
  const objective = String(text || '').trim().replace(/\s+/g, ' ').slice(0, 1800);
  return {
    role: inferDelegationRole(objective),
    objective,
    constraints: [],
    output_format: 'report',
  };
}

function localMemoryRows() {
  return getAllMemories().map((m) => ({
    id: m.id,
    content: m.text || m.content || '',
    created_at: m.created_at || Date.now(),
    source: 'local_fallback',
    sync_status: 'pending_backend',
  }));
}

function mergeMemoryRows(serverRows = []) {
  const rows = Array.isArray(serverRows) ? serverRows : [];
  const seen = new Set(rows.map((m) => String(m.content || m.text || '').trim().toLowerCase()).filter(Boolean));
  const local = localMemoryRows().filter((m) => {
    const key = String(m.content || '').trim().toLowerCase();
    return key && !seen.has(key);
  });
  return [...local, ...rows];
}

async function callBackendJson(base, path, { method = 'GET', token = null, body = null, includeByok = false, accept = 'application/json', timeoutMs = 20000 } = {}) {
  const perform = async (activeBase) => {
    const url = `${activeBase}${path}`;
    const headers = {
      Accept: accept,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(includeByok ? getByokHeaders() : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    };

    // In Electron, always use main-process HTTP to bypass renderer CORS.
    if (isElectron && window.electronAPI?.httpApiCall) {
      const out = await window.electronAPI.httpApiCall({
        method,
        url,
        headers,
        body,
        timeoutMs,
      });
      if (!out?.success) throw new Error((out?.error || '').trim() || 'Backend request failed');
      if ((out.statusCode || 500) >= 400) {
        const raw =
          typeof out.data === 'string'
            ? out.data.trim()
            : (
                out.data?.detail ||
                out.data?.message ||
                out.data?.error ||
                ''
              );
        const msg = raw || `HTTP ${out.statusCode}${out.statusMessage ? ` ${out.statusMessage}` : ''}`;
        throw new Error(msg);
      }
      return out.data;
    }

    const resp = await fetch(url, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${resp.status}`);
    }
    return resp.json();
  };

  const initialBase = String(base || NOAH_BACKEND_URL || '').trim();
  try {
    return await perform(initialBase);
  } catch (err) {
    // Keep hard auth/validation errors immediate; only fail over on connectivity/timeout issues.
    if (!isRetryableBackendError(err)) throw err;
    for (const candidate of backendCandidates()) {
      if (!candidate || candidate === initialBase) continue;
      try {
        const out = await perform(candidate);
        NOAH_BACKEND_URL = candidate;
        return out;
      } catch (candidateErr) {
        if (!isRetryableBackendError(candidateErr)) throw candidateErr;
      }
    }
    throw err;
  }
}

function _recordTrace(event, data = {}) {
  const row = { at: new Date().toISOString(), event, ...data };
  try {
    const prev = JSON.parse(localStorage.getItem(LS_TRACE) || '[]');
    prev.push(row);
    while (prev.length > 200) prev.shift();
    localStorage.setItem(LS_TRACE, JSON.stringify(prev));
  } catch {}
}

function _metricInc(key) {
  try {
    const prev = JSON.parse(localStorage.getItem(LS_METRICS) || '{}');
    prev[key] = (prev[key] || 0) + 1;
    localStorage.setItem(LS_METRICS, JSON.stringify(prev));
  } catch {}
}

export function getOrchestrationTrace() {
  try { return JSON.parse(localStorage.getItem(LS_TRACE) || '[]'); } catch { return []; }
}

export function getOrchestrationMetrics() {
  try { return JSON.parse(localStorage.getItem(LS_METRICS) || '{}'); } catch { return {}; }
}

async function detectLocalVscode() {
  if (!isElectron || !window.electronAPI?.runShell) return { available: false, reason: 'not-electron' };
  const cli = await window.electronAPI.runShell('command -v code >/dev/null && echo "__ok__" || true');
  if ((cli?.output || '').includes('__ok__')) return { available: true, reason: '' };
  return { available: false, reason: 'code-cli-missing' };
}

async function detectPlaywrightReady() {
  if (!isElectron) return { available: false, reason: 'not-electron' };

  // Prefer main-process resolution so packaged app module paths are handled correctly.
  if (window.electronAPI?.checkPlaywright) {
    try {
      const res = await window.electronAPI.checkPlaywright();
      if (res?.available) return { available: true, reason: '', version: res.version || '', resolved: res.resolved || '' };
    } catch {}
  }

  // Legacy fallback for older desktop builds.
  if (!window.electronAPI?.runShell) return { available: false, reason: 'playwright-missing' };
  const r = await window.electronAPI.runShell('node -e "require(\'playwright\');process.stdout.write(\'__ok__\')" || true');
  return (r?.output || '').includes('__ok__')
    ? { available: true, reason: '' }
    : { available: false, reason: 'playwright-missing' };
}

function _hasGithubToken() {
  return !!(getIntegrations()?.github_token || '').trim();
}

export async function getCapabilitySnapshot(token = null) {
  const localVscode = await detectLocalVscode();
  const playwright = await detectPlaywrightReady();
  const github = { available: _hasGithubToken(), reason: _hasGithubToken() ? '' : 'github-token-missing' };
  let server = { available: false, reason: 'unreachable' };
  let serverCaps = {};
  let parity = null;
  try {
    if (token) {
      const caps = await callBackendJson(NOAH_BACKEND_URL, '/api/v1/hermes/capabilities', {
        method: 'GET',
        token,
        includeByok: true,
        timeoutMs: 10000,
      });
      serverCaps = caps?.capabilities || {};
      try {
        parity = await callBackendJson(NOAH_BACKEND_URL, '/api/v1/hermes/parity', {
          method: 'GET',
          token,
          includeByok: true,
          timeoutMs: 10000,
        });
      } catch {}
      server = {
        available: !!caps?.active,
        reason: caps?.active ? '' : 'mode-not-hermes',
        desktop_bridge: serverCaps?.desktop_bridge || { available: false, streams: 0 },
      };
    }
  } catch {}
  return {
    local_vscode: localVscode,
    local_playwright: playwright,
    github_codespaces_auth: github,
    server_hermes: server,
    skills: serverCaps?.skills || { available: false, count: 0, sample: [] },
    memory: serverCaps?.memory || { backend_available: false },
    delegation: serverCaps?.delegation || { virtual_available: true, worker_available: false },
    parity: parity || { parity_percent: 0, missing_count: 0, missing_tools: [] },
    desktop_bridge: (() => {
      const base = server.desktop_bridge || { available: false, streams: 0 };
      const streams = Number(base.streams || 0);
      const state = base.available
        ? 'connected'
        : (isElectron && server.available ? 'idle' : 'offline');
      return { ...base, streams, state };
    })(),
  };
}

export async function checkHermesStatus() {
  const detail = await getHermesBackendStatus();
  return !!detail.active;
}

export async function getHermesBackendStatus() {
  for (const base of backendCandidates()) {
    try {
      const data = await callBackendJson(base, '/api/v1/hermes/status', { method: 'GET', includeByok: false });
      const reachable = typeof data === 'object';
      if (reachable) {
        NOAH_BACKEND_URL = base;
        return {
          reachable: true,
          active: !!data.active,
          mode: data.mode || 'unknown',
          model: data.model || '',
          base,
        };
      }
    } catch {}
  }
  return {
    reachable: false,
    active: false,
    mode: 'unknown',
    model: '',
    base: NOAH_BACKEND_URL,
    error: 'Could not reach backend',
  };
}

let _hermesWarmupPromise = null;

export async function warmupHermes(token, { voiceMode = false } = {}) {
  if (!token) return null;
  if (_hermesWarmupPromise) return _hermesWarmupPromise;

  const model = voiceMode ? getHermesVoiceModel() : getHermesModel();
  let sessionId;
  try { sessionId = localStorage.getItem('noah_hermes_session') || undefined; } catch {}

  _hermesWarmupPromise = callBackendJson(NOAH_BACKEND_URL, '/api/v1/hermes/warmup', {
    method: 'POST',
    token,
    includeByok: true,
    timeoutMs: 12000,
    body: {
      session_id: sessionId || undefined,
      model,
      latency_mode: voiceMode ? 'realtime' : 'balanced',
    },
  }).then((data) => {
    if (data?.session_id) {
      try { localStorage.setItem('noah_hermes_session', data.session_id); } catch {}
    }
    return data;
  }).catch((err) => {
    _hermesWarmupPromise = null;
    throw err;
  });

  return _hermesWarmupPromise;
}

export async function getHermesBrainMode() {
  try {
    const localMode = localStorage.getItem('noah_brain_mode');

    // Respect explicit user choice first.
    if (localMode === 'classic') return 'classic';

    // If explicitly set to Hermes, verify reachability.
    if (localMode === 'hermes') {
      const isStillOnline = await checkHermesStatus();
      if (isStillOnline) return 'hermes';
      // If Hermes is selected but unavailable, fall back safely.
      localStorage.setItem('noah_brain_mode', 'classic');
      return 'classic';
    }

    // First-run default: classic unless user explicitly selected Hermes.
    return 'classic';
  } catch (err) {
    console.warn('[Noah] Error checking Hermes status:', err.message);
  }
  return 'classic';
}

export function setHermesBrainMode(mode) {
  try { localStorage.setItem('noah_brain_mode', mode); } catch {}
}

const DEFAULT_HERMES_MODEL = 'google/gemma-4-31b-it';

export function getHermesModel() {
  try { return localStorage.getItem('noah_hermes_model') || DEFAULT_HERMES_MODEL; } catch { return DEFAULT_HERMES_MODEL; }
}

export function setHermesModel(model) {
  try { localStorage.setItem('noah_hermes_model', model || DEFAULT_HERMES_MODEL); } catch {}
}

export function getExecutionMode() {
  try {
    const mode = localStorage.getItem(LS_EXECUTION_MODE);
    if (mode === 'coder_terminal_first') return mode;
  } catch {}
  return 'general';
}

export function setExecutionMode(mode) {
  const normalized = mode === 'coder_terminal_first' ? 'coder_terminal_first' : 'general';
  try { localStorage.setItem(LS_EXECUTION_MODE, normalized); } catch {}
}

export function getExecutionProfile() {
  try {
    const profile = localStorage.getItem(LS_EXECUTION_PROFILE);
    if (profile === 'prefer_local' || profile === 'prefer_server') return profile;
  } catch {}
  return 'hybrid_auto';
}

export function setExecutionProfile(profile) {
  const normalized = profile === 'prefer_local' || profile === 'prefer_server' ? profile : 'hybrid_auto';
  try { localStorage.setItem(LS_EXECUTION_PROFILE, normalized); } catch {}
}

export function getRiskLevel() {
  try {
    const level = localStorage.getItem(LS_RISK_LEVEL);
    if (level === 'always_ask' || level === 'power_mode') return level;
  } catch {}
  return 'risk_based';
}

export function setRiskLevel(level) {
  const normalized = level === 'always_ask' || level === 'power_mode' ? level : 'risk_based';
  try { localStorage.setItem(LS_RISK_LEVEL, normalized); } catch {}
}

function getHermesVoiceModel() {
  try {
    return localStorage.getItem('noah_hermes_voice_model') || 'openai/gpt-4o-mini';
  } catch {
    return 'openai/gpt-4o-mini';
  }
}

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

// ─── Persistent desktop bridge SSE (separate from /hermes/chat streaming) ───
let _bridgeStreamId = null;
let _bridgeStreamUnsub = null;
let _bridgeReconnectTimer = null;
let _bridgeToken = null;

function _clearBridgeReconnect() {
  if (_bridgeReconnectTimer) {
    clearTimeout(_bridgeReconnectTimer);
    _bridgeReconnectTimer = null;
  }
}

async function _stopDesktopBridgeInternal() {
  _clearBridgeReconnect();
  try { _bridgeStreamUnsub?.(); } catch {}
  _bridgeStreamUnsub = null;
  if (_bridgeStreamId && window.electronAPI?.httpApiStreamStop) {
    try { await window.electronAPI.httpApiStreamStop({ streamId: _bridgeStreamId }); } catch {}
  }
  _bridgeStreamId = null;
}

function _scheduleBridgeReconnect() {
  if (!_bridgeToken || !isElectron) return;
  if (_bridgeReconnectTimer) return;
  _bridgeReconnectTimer = setTimeout(() => {
    _bridgeReconnectTimer = null;
    ensureDesktopBridge(_bridgeToken).catch(() => {});
  }, 1500);
}

export async function stopDesktopBridge() {
  _bridgeToken = null;
  await _stopDesktopBridgeInternal();
}

export async function ensureDesktopBridge(token) {
  const bridgeEnabled = (() => {
    try { return localStorage.getItem('noah_enable_desktop_bridge_sse') === 'true'; } catch { return false; }
  })();
  if (!bridgeEnabled) {
    await _stopDesktopBridgeInternal();
    return false;
  }
  if (!isElectron || !window.electronAPI?.httpApiStreamStart || !window.electronAPI?.onHttpApiStreamEvent) return false;
  if (!token) return false;
  _bridgeToken = token;

  if (_bridgeStreamId) return true;

  const streamId = `bridge_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  _bridgeStreamId = streamId;
  const sessionHint = (localStorage.getItem('noah_hermes_session') || 'bridge').trim() || 'bridge';

  _bridgeStreamUnsub = window.electronAPI.onHttpApiStreamEvent((msg) => {
    if (!msg || msg.streamId !== streamId) return;
    if (msg.type === 'http_error' || msg.type === 'error' || msg.type === 'end') {
      _bridgeStreamId = null;
      try { _bridgeStreamUnsub?.(); } catch {}
      _bridgeStreamUnsub = null;
      _scheduleBridgeReconnect();
    }
  });

  try {
    const started = await window.electronAPI.httpApiStreamStart({
      streamId,
      method: 'GET',
      url: `${NOAH_BACKEND_URL}/api/v1/hermes/bridge/sse?session_id=${encodeURIComponent(sessionHint)}`,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'text/event-stream',
      },
      timeoutMs: 86400000,
    });
    if (!started?.ok) {
      await _stopDesktopBridgeInternal();
      _scheduleBridgeReconnect();
      return false;
    }
    return true;
  } catch {
    await _stopDesktopBridgeInternal();
    _scheduleBridgeReconnect();
    return false;
  }
}

// ─── Cached system info ───────────────────────────────────────────────────────

let _systemInfo = null;
async function getSystemInfo() {
  if (_systemInfo) return _systemInfo;
  if (!isElectron) { _systemInfo = { platform: 'web', homedir: '~', username: 'user', hostname: 'localhost', shell: '/bin/zsh' }; return _systemInfo; }
  try { _systemInfo = await window.electronAPI.getSystemInfo(); } catch { _systemInfo = { platform: 'darwin', homedir: '~', username: 'user', hostname: 'mac', shell: '/bin/zsh' }; }
  return _systemInfo;
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const BASE_TOOLS = [
  { type: 'function', function: {
    name: 'save_memory',
    description: 'Save a fact about the user to long-term memory. Call this IMMEDIATELY whenever the user shares personal information: their name, location, preferences, job, relationships, goals, habits — anything they want remembered. Also call proactively when you learn something important. Do not wait to be asked.',
    parameters: { type: 'object', properties: {
      fact: { type: 'string', description: 'A clear, concise fact about the user. e.g. "User is from the United Kingdom", "User\'s name is Hamza", "User prefers dark mode"' },
    }, required: ['fact'] },
  }},
  { type: 'function', function: {
    name: 'save_memory_server',
    description: 'Save a user memory in Noah backend persistent memory store (Firestore). Use when user asks to remember something and confirm with returned memory ID.',
    parameters: { type: 'object', properties: {
      fact: { type: 'string', description: 'The memory/fact to save' },
      content: { type: 'string', description: 'Alias for fact' },
    }, required: [] },
  }},
  { type: 'function', function: {
    name: 'list_memories',
    description: 'List stored memories from Noah backend memory store.',
    parameters: { type: 'object', properties: {
      limit: { type: 'integer', description: 'Maximum records to return (default 100)' },
    }, required: [] },
  }},
  { type: 'function', function: {
    name: 'list_skills',
    description: 'List all installed skills available in Noah skills module.',
    parameters: { type: 'object', properties: {}, required: [] },
  }},
  { type: 'function', function: {
    name: 'view_skill',
    description: 'Read the full content of a specific skill by name/slug.',
    parameters: { type: 'object', properties: {
      name: { type: 'string', description: 'Skill name or slug from list_skills' },
      slug: { type: 'string', description: 'Optional slug alias' },
    }, required: [] },
  }},
  { type: 'function', function: {
    name: 'get_capabilities',
    description: 'Fetch Noah runtime capability map (skills/memory/delegation/tool availability).',
    parameters: { type: 'object', properties: {}, required: [] },
  }},
  { type: 'function', function: {
    name: 'cronjob',
    description: 'Manage scheduled jobs: create/list/pause/resume/remove/run.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', description: 'create | list | pause | resume | remove | run' },
      schedule: { type: 'string', description: 'Cron schedule (for create)' },
      task: { type: 'string', description: 'Shell task to run (for create)' },
      job_id: { type: 'string', description: 'Job ID for pause/resume/remove/run' },
      paused: { type: 'boolean', description: 'Initial paused state for create' },
      reason: { type: 'string', description: 'Why this schedule action is needed' },
    }, required: ['action'] },
  }},
  { type: 'function', function: {
    name: 'delegate_task',
    description: 'Create a specialist sub-agent delegation plan for a niche task (phase A virtual delegation).',
    parameters: { type: 'object', properties: {
      role: { type: 'string', enum: ['seo', 'content', 'coding', 'research', 'ops'] },
      objective: { type: 'string' },
      constraints: { type: 'array', items: { type: 'string' } },
      output_format: { type: 'string', description: 'summary | checklist | report | markdown' },
    }, required: ['role', 'objective'] },
  }},
  { type: 'function', function: {
    name: 'search_web',
    description: 'Search the internet for REAL, current information. Use for: prices, flights, weather, news, people, products, anything that changes over time. NEVER guess or make up facts — always search first. After searching, use fetch_webpage on the top result URLs to get full details.',
    parameters: { type: 'object', properties: {
      query:  { type: 'string', description: 'Search query — be specific, include dates/locations for travel/events' },
      reason: { type: 'string', description: 'Why you are searching' },
    }, required: ['query', 'reason'] },
  }},
  { type: 'function', function: {
    name: 'fetch_webpage',
    description: 'Fetch and READ the actual full text content of any URL. Use AFTER search_web to read actual flight prices, articles, docs, prices. Always use this — never rely on search snippet summaries alone.',
    parameters: { type: 'object', properties: {
      url:    { type: 'string', description: 'Full URL (https://...)' },
      reason: { type: 'string', description: 'What you are reading' },
    }, required: ['url', 'reason'] },
  }},
  { type: 'function', function: {
    name: 'run_applescript',
    description: 'Run AppleScript to control macOS apps. Use for: Safari/Chrome (open URLs, click), Messages, Calendar, Reminders, Notes, Finder, Spotify, Music. Use for Mail/Outlook only when email delivery mode is native app, not Gmail.',
    parameters: { type: 'object', properties: {
      script: { type: 'string', description: 'Valid AppleScript code' },
      reason: { type: 'string', description: 'Brief label' },
    }, required: ['script', 'reason'] },
  }},
  { type: 'function', function: {
    name: 'send_gmail',
    description: 'Send an email through the connected Google Workspace/Gmail account using the Gmail API. Use this for Gmail, Google account, Google Workspace email, or when email delivery mode is Gmail connector.',
    parameters: { type: 'object', properties: {
      to: { type: 'array', items: { type: 'string' }, description: 'Recipient email addresses' },
      cc: { type: 'array', items: { type: 'string' }, description: 'Optional CC email addresses' },
      bcc: { type: 'array', items: { type: 'string' }, description: 'Optional BCC email addresses' },
      subject: { type: 'string' },
      body: { type: 'string' },
      reason: { type: 'string', description: 'Brief label' },
    }, required: ['to', 'subject', 'body', 'reason'] },
  }},
  { type: 'function', function: {
    name: 'google_drive_search',
    description: 'Search the connected Google Drive for files by name or full text. Use this for Google Drive, Google Docs, Google Sheets, and Google Workspace file lookup.',
    parameters: { type: 'object', properties: {
      query: { type: 'string', description: 'Search text, file name, or phrase' },
      mime_type: { type: 'string', description: 'Optional MIME type filter, e.g. application/vnd.google-apps.spreadsheet' },
      limit: { type: 'integer', description: 'Max results, default 10' },
      reason: { type: 'string' },
    }, required: ['query', 'reason'] },
  }},
  { type: 'function', function: {
    name: 'google_drive_read_file',
    description: 'Read a connected Google Drive file. Supports Google Docs text, Google Sheets values, and exported text/CSV for common Drive files.',
    parameters: { type: 'object', properties: {
      file_id: { type: 'string', description: 'Google Drive file ID' },
      range: { type: 'string', description: 'Optional Sheets A1 range, e.g. Sheet1!A1:Z100' },
      reason: { type: 'string' },
    }, required: ['file_id', 'reason'] },
  }},
  { type: 'function', function: {
    name: 'google_sheets_get_values',
    description: 'Read values from a connected Google Sheet by spreadsheet ID and A1 range.',
    parameters: { type: 'object', properties: {
      spreadsheet_id: { type: 'string' },
      range: { type: 'string', description: 'A1 range, e.g. Sheet1!A1:Z100' },
      reason: { type: 'string' },
    }, required: ['spreadsheet_id', 'range', 'reason'] },
  }},
  { type: 'function', function: {
    name: 'google_sheets_update_values',
    description: 'Update values in a connected Google Sheet by spreadsheet ID and A1 range.',
    parameters: { type: 'object', properties: {
      spreadsheet_id: { type: 'string' },
      range: { type: 'string', description: 'A1 range to update' },
      values: { type: 'array', items: { type: 'array', items: {} }, description: '2D array of cell values' },
      reason: { type: 'string' },
    }, required: ['spreadsheet_id', 'range', 'values', 'reason'] },
  }},
  { type: 'function', function: {
    name: 'google_calendar_list_events',
    description: 'List events from the connected Google Calendar.',
    parameters: { type: 'object', properties: {
      calendar_id: { type: 'string', description: 'Calendar ID, default primary' },
      time_min: { type: 'string', description: 'RFC3339 start time' },
      time_max: { type: 'string', description: 'RFC3339 end time' },
      query: { type: 'string', description: 'Optional event text search' },
      reason: { type: 'string' },
    }, required: ['reason'] },
  }},
  { type: 'function', function: {
    name: 'google_calendar_create_event',
    description: 'Create an event in the connected Google Calendar.',
    parameters: { type: 'object', properties: {
      calendar_id: { type: 'string', description: 'Calendar ID, default primary' },
      summary: { type: 'string' },
      description: { type: 'string' },
      start: { type: 'string', description: 'RFC3339 start datetime' },
      end: { type: 'string', description: 'RFC3339 end datetime' },
      timezone: { type: 'string', description: 'IANA timezone, optional' },
      attendees: { type: 'array', items: { type: 'string' }, description: 'Attendee email addresses' },
      reason: { type: 'string' },
    }, required: ['summary', 'start', 'end', 'reason'] },
  }},
  { type: 'function', function: {
    name: 'google_workspace_diagnostics',
    description: 'Diagnose connected Google Workspace access. Checks granted OAuth scopes and probes Drive and Calendar APIs. Use when Google Drive/Docs/Sheets/Calendar access fails or the user asks why Google access is not working.',
    parameters: { type: 'object', properties: {
      reason: { type: 'string' },
    }, required: ['reason'] },
  }},
  { type: 'function', function: {
    name: 'terminal',
    description: 'Run any bash/shell command on the Mac. Can do ANYTHING: install software, manage processes, files, network requests with curl, open apps. Use curl to fetch data if fetch_webpage is insufficient.',
    parameters: { type: 'object', properties: {
      command: { type: 'string', description: 'Full bash command' },
      reason:  { type: 'string', description: 'Brief label' },
    }, required: ['command', 'reason'] },
  }},
  { type: 'function', function: {
    name: 'open_url',
    description: 'Open a URL in the default browser so the user can view it. Use after finding the right URL via search_web + fetch_webpage.',
    parameters: { type: 'object', properties: {
      url: { type: 'string' }, reason: { type: 'string' },
    }, required: ['url', 'reason'] },
  }},
  { type: 'function', function: {
    name: 'open_path',
    description: 'Open a file or application on macOS.',
    parameters: { type: 'object', properties: {
      path:   { type: 'string', description: 'Absolute file path or app path' },
      reason: { type: 'string' },
    }, required: ['path', 'reason'] },
  }},
  { type: 'function', function: {
    name: 'computer_open_application',
    description: 'Open and focus a desktop application by name (e.g. Claude, Safari, Notion).',
    parameters: { type: 'object', properties: {
      app_name: { type: 'string' }, reason: { type: 'string' },
    }, required: ['app_name', 'reason'] },
  }},
  { type: 'function', function: {
    name: 'computer_click',
    description: 'Click at absolute screen coordinates.',
    parameters: { type: 'object', properties: {
      x: { type: 'integer' }, y: { type: 'integer' },
      button: { type: 'string', enum: ['left', 'right'] },
      click_count: { type: 'integer' }, reason: { type: 'string' },
    }, required: ['x', 'y', 'reason'] },
  }},
  { type: 'function', function: {
    name: 'computer_type',
    description: 'Type into the currently focused input.',
    parameters: { type: 'object', properties: {
      text: { type: 'string' }, submit: { type: 'boolean' }, reason: { type: 'string' },
    }, required: ['text', 'reason'] },
  }},
  { type: 'function', function: {
    name: 'computer_hotkey',
    description: 'Press keyboard shortcut keys like command+n or command+shift+p.',
    parameters: { type: 'object', properties: {
      keys: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' },
    }, required: ['keys', 'reason'] },
  }},
  { type: 'function', function: {
    name: 'computer_wait_for_app',
    description: 'Wait until an app process is running.',
    parameters: { type: 'object', properties: {
      app_name: { type: 'string' }, timeout_sec: { type: 'integer' }, reason: { type: 'string' },
    }, required: ['app_name', 'reason'] },
  }},
  { type: 'function', function: {
    name: 'computer_claude_create_thread',
    description: 'Open Claude app, create a new thread, and place prompt text.',
    parameters: { type: 'object', properties: {
      prompt: { type: 'string' }, submit: { type: 'boolean' }, reason: { type: 'string' },
    }, required: ['prompt', 'reason'] },
  }},
  { type: 'function', function: {
    name: 'computer_observe',
    description: 'Observe frontmost app and visible UI text context.',
    parameters: { type: 'object', properties: {
      reason: { type: 'string' }, include_ui_tree: { type: 'boolean' },
    }, required: ['reason'] },
  }},
  { type: 'function', function: {
    name: 'computer_click_text',
    description: 'Find and click an element by visible text.',
    parameters: { type: 'object', properties: {
      text: { type: 'string' }, exact: { type: 'boolean' }, timeout_sec: { type: 'integer' }, reason: { type: 'string' },
    }, required: ['text', 'reason'] },
  }},
  { type: 'function', function: {
    name: 'computer_type_in_field',
    description: 'Focus field by hint text and type value.',
    parameters: { type: 'object', properties: {
      field_hint: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' }, reason: { type: 'string' },
    }, required: ['field_hint', 'text', 'reason'] },
  }},
  { type: 'function', function: {
    name: 'computer_verify_text',
    description: 'Verify whether a text is visible in frontmost window.',
    parameters: { type: 'object', properties: {
      text: { type: 'string' }, exact: { type: 'boolean' }, reason: { type: 'string' },
    }, required: ['text', 'reason'] },
  }},
  { type: 'function', function: {
    name: 'computer_vscode_open_project',
    description: 'Open a folder/workspace in Visual Studio Code.',
    parameters: { type: 'object', properties: {
      project_path: { type: 'string' }, reason: { type: 'string' },
    }, required: ['project_path', 'reason'] },
  }},
  { type: 'function', function: {
    name: 'computer_vscode_open_file',
    description: 'Open a file in Visual Studio Code, optionally at a line.',
    parameters: { type: 'object', properties: {
      file_path: { type: 'string' }, line: { type: 'integer' }, reason: { type: 'string' },
    }, required: ['file_path', 'reason'] },
  }},
  { type: 'function', function: {
    name: 'computer_vscode_run_task',
    description: 'Run a coding/build/test command and return output.',
    parameters: { type: 'object', properties: {
      command: { type: 'string' }, cwd: { type: 'string' }, reason: { type: 'string' },
    }, required: ['command', 'reason'] },
  }},
  { type: 'function', function: {
    name: 'browser_playwright_script',
    description: 'Run a Playwright JavaScript snippet for browser automation.',
    parameters: { type: 'object', properties: {
      start_url: { type: 'string' },
      script: { type: 'string' },
      headless: { type: 'boolean' },
      timeout_sec: { type: 'integer' },
      reason: { type: 'string' },
    }, required: ['reason'] },
  }},
  { type: 'function', function: {
    name: 'cloud_codespaces_list',
    description: 'List existing GitHub Codespaces for a repository.',
    parameters: { type: 'object', properties: {
      owner: { type: 'string' }, repo: { type: 'string' }, reason: { type: 'string' },
    }, required: ['owner', 'repo', 'reason'] },
  }},
  { type: 'function', function: {
    name: 'cloud_codespace_create',
    description: 'Create a GitHub Codespace for a repository and return its web URL.',
    parameters: { type: 'object', properties: {
      owner: { type: 'string' }, repo: { type: 'string' }, branch: { type: 'string' }, machine: { type: 'string' }, reason: { type: 'string' },
    }, required: ['owner', 'repo', 'reason'] },
  }},
  { type: 'function', function: {
    name: 'cloud_codespace_open',
    description: 'Open an existing GitHub Codespace in browser by name.',
    parameters: { type: 'object', properties: {
      codespace_name: { type: 'string' }, reason: { type: 'string' },
    }, required: ['codespace_name', 'reason'] },
  }},
  { type: 'function', function: {
    name: 'read_file',
    description: 'Read a file from the filesystem.',
    parameters: { type: 'object', properties: {
      path: { type: 'string' },
    }, required: ['path'] },
  }},
  { type: 'function', function: {
    name: 'write_file',
    description: 'Create or overwrite a file.',
    parameters: { type: 'object', properties: {
      path: { type: 'string' }, content: { type: 'string' },
    }, required: ['path', 'content'] },
  }},
  { type: 'function', function: {
    name: 'list_directory',
    description: 'List files in a directory.',
    parameters: { type: 'object', properties: {
      path: { type: 'string' },
    }, required: ['path'] },
  }},
  { type: 'function', function: {
    name: 'show_notification',
    description: 'Show a macOS system notification.',
    parameters: { type: 'object', properties: {
      title: { type: 'string' }, body: { type: 'string' },
    }, required: ['title', 'body'] },
  }},
  { type: 'function', function: {
    name: 'api_call',
    description: 'Make any authenticated HTTP API call (GitHub, Slack, Notion, Trello, Google APIs, etc).',
    parameters: { type: 'object', properties: {
      method:  { type: 'string', enum: ['GET','POST','PUT','PATCH','DELETE'] },
      url:     { type: 'string' },
      headers: { type: 'object' },
      body:    { type: 'object' },
      reason:  { type: 'string' },
    }, required: ['method', 'url', 'reason'] },
  }},
];

// ─── Tool execution ───────────────────────────────────────────────────────────

function appleEscape(value = '') {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function shellSingleQuote(value = '') {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function base64UrlEncodeUtf8(value = '') {
  const bytes = new TextEncoder().encode(String(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function encodeMailHeader(value = '') {
  const text = String(value || '');
  if (/^[\x20-\x7E]*$/.test(text)) return text;
  return `=?UTF-8?B?${btoa(unescape(encodeURIComponent(text)))}?=`;
}

function buildRawEmail({ to, cc, bcc, subject, body }) {
  const recipients = Array.isArray(to) ? to : [to];
  const headers = [
    `To: ${recipients.map(String).filter(Boolean).join(', ')}`,
    cc ? `Cc: ${(Array.isArray(cc) ? cc : [cc]).map(String).filter(Boolean).join(', ')}` : '',
    bcc ? `Bcc: ${(Array.isArray(bcc) ? bcc : [bcc]).map(String).filter(Boolean).join(', ')}` : '',
    `Subject: ${encodeMailHeader(subject || '')}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
  ].filter(Boolean);
  return base64UrlEncodeUtf8(`${headers.join('\r\n')}\r\n\r\n${String(body || '')}`);
}

function getEmailSendMode(integrations = null) {
  const values = integrations || getIntegrations();
  const configured = String(values.email_send_mode || '').trim();
  if (configured) return configured;
  return values.google_token ? 'gmail' : 'native';
}

function appleScriptTargetsMail(script = '') {
  const text = String(script || '').toLowerCase();
  return /\b(mail|apple mail|outlook|microsoft outlook)\b/.test(text) && /\b(send|compose|message|email|mail)\b/.test(text);
}

function normalizedModifiers(keys = []) {
  const set = new Set((keys || []).map(k => String(k).trim().toLowerCase()));
  const mods = [];
  if (set.has('command') || set.has('cmd') || set.has('meta')) mods.push('command down');
  if (set.has('shift')) mods.push('shift down');
  if (set.has('option') || set.has('alt')) mods.push('option down');
  if (set.has('control') || set.has('ctrl')) mods.push('control down');
  return mods;
}

function detectPrimaryKey(keys = []) {
  const norm = (keys || []).map(k => String(k).trim().toLowerCase());
  return norm.find(k => !['command', 'cmd', 'meta', 'shift', 'option', 'alt', 'control', 'ctrl'].includes(k)) || '';
}

async function runDesktopHotkey(keys = []) {
  const mods = normalizedModifiers(keys);
  const key = detectPrimaryKey(keys);
  if (!key) return { error: 'hotkey requires a non-modifier key' };

  const specialKeyCodes = { enter: 36, return: 36, tab: 48, esc: 53, escape: 53, space: 49 };
  let keyStmt;
  if (specialKeyCodes[key]) {
    keyStmt = `key code ${specialKeyCodes[key]}`;
  } else {
    keyStmt = `keystroke "${appleEscape(key.length === 1 ? key : key.toLowerCase())}"`;
  }

  const usingMods = mods.length ? ` using {${mods.join(', ')}}` : '';
  const script = `tell application "System Events" to ${keyStmt}${usingMods}`;
  return await window.electronAPI.runApplescript(script);
}

async function runClaudeThreadWorkflow(prompt, submit = true) {
  const safePrompt = appleEscape(prompt || '');
  const submitScript = submit ? '\n        key code 36' : '';
  const script = `
      tell application "Claude" to activate
      delay 0.8
      tell application "System Events"
        keystroke "n" using {command down}
        delay 0.6
        keystroke "${safePrompt}"
        ${submitScript}
      end tell
    `;
  return await window.electronAPI.runApplescript(script);
}

async function observeFrontmostUI(includeUiTree = false) {
  const script = `
    tell application "System Events"
      set frontProc to first application process whose frontmost is true
      set appName to name of frontProc
      set winTitle to ""
      try
        set winTitle to name of front window of frontProc
      end try
      set valueTexts to {}
      if ${includeUiTree ? 'true' : 'false'} then
        try
          set valueTexts to value of every static text of front window of frontProc
        end try
      end if
      return appName & "||" & winTitle & "||" & (valueTexts as text)
    end tell
  `;
  const out = await window.electronAPI.runApplescript(script);
  const raw = String(out?.output || '');
  const [appName = '', winTitle = '', uiText = ''] = raw.split('||');
  return { success: !!out?.success, app_name: appName.trim(), window_title: winTitle.trim(), ui_text: uiText.trim(), raw };
}

async function clickByVisibleText(text, exact = false) {
  const needle = appleEscape(text || '');
  const exactBool = exact ? 'true' : 'false';
  const script = `
    on matchesText(theText, targetText, isExact)
      if isExact then
        return theText is targetText
      else
        return (offset of targetText in theText) > 0
      end if
    end matchesText
    tell application "System Events"
      set frontProc to first application process whose frontmost is true
      tell front window of frontProc
        set targetText to "${needle}"
        set isExact to ${exactBool}
        set candidates to (buttons as list)
        repeat with b in candidates
          try
            set nm to (name of b as text)
            if my matchesText(nm, targetText, isExact) then
              click b
              return "clicked_button:" & nm
            end if
          end try
        end repeat
        try
          set st to every static text
          repeat with t in st
            try
              set v to (value of t as text)
              if my matchesText(v, targetText, isExact) then
                click t
                return "clicked_text:" & v
              end if
            end try
          end repeat
        end try
      end tell
    end tell
    return "not_found"
  `;
  const out = await window.electronAPI.runApplescript(script);
  return { success: !!out?.success && String(out.output || '').startsWith('clicked_'), output: out?.output || '', raw: out };
}

async function verifyVisibleText(text, exact = false) {
  const obs = await observeFrontmostUI(true);
  const hay = `${obs.window_title}\n${obs.ui_text}`.toLowerCase();
  const needle = String(text || '').toLowerCase();
  const found = exact ? hay.split('\n').includes(needle) : hay.includes(needle);
  return { success: true, found, app_name: obs.app_name, window_title: obs.window_title };
}

async function typeInFieldByHint(fieldHint, text, submit = false) {
  const clickResult = await clickByVisibleText(fieldHint || '', false);
  if (!clickResult.success) return { success: false, error: `Could not focus field hint '${fieldHint}'`, clickResult };
  await new Promise(r => setTimeout(r, 120));
  const typeScript = `tell application "System Events" to keystroke "${appleEscape(text || '')}"`;
  const typed = await window.electronAPI.runApplescript(typeScript);
  if (submit) {
    const submitted = await window.electronAPI.runApplescript('tell application "System Events" to key code 36');
    return { success: !!(typed?.success && submitted?.success), typed, submitted, clickResult };
  }
  return { success: !!typed?.success, typed, clickResult };
}

async function runPlaywrightScript(args = {}) {
  const startUrl = String(args.start_url || '').trim();
  const userScript = String(args.script || '').trim();
  const timeoutSec = Math.max(5, Math.min(180, Number(args.timeout_sec || 30)));
  const headless = args.headless !== false;
  const js = `import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: ${headless ? 'true' : 'false'} });
const context = await browser.newContext();
const page = await context.newPage();
page.setDefaultTimeout(${timeoutSec * 1000});
const logs = [];
const console = { log: (...a) => logs.push(a.map(v => String(v)).join(' ')) };
let result = null;
try {
  ${startUrl ? `await page.goto(${JSON.stringify(startUrl)}, { waitUntil: 'domcontentloaded' });` : ''}
  ${userScript || 'result = { ok: true, note: "No script provided." };'}
  process.stdout.write(JSON.stringify({ success: true, result, logs }, null, 2));
} catch (e) {
  process.stdout.write(JSON.stringify({ success: false, error: String(e), logs }, null, 2));
} finally {
  await browser.close();
}`;
  const tmp = `/tmp/noah_playwright_${Date.now()}_${Math.random().toString(36).slice(2)}.mjs`;
  await window.electronAPI.writeFile(tmp, js);
  const cmd = `node ${shellSingleQuote(tmp)}`;
  const run = await window.electronAPI.runShell(cmd);
  try { await window.electronAPI.runShell(`rm -f ${shellSingleQuote(tmp)}`); } catch {}

  if (!run?.success && !run?.output) return run;
  const out = String(run?.output || '');
  try {
    const parsed = JSON.parse(out);
    return { success: !!parsed.success, ...parsed, command: cmd };
  } catch {
    return { success: false, error: 'Failed to parse Playwright output', raw: out.slice(0, 4000), command: cmd };
  }
}

function githubHeaders() {
  const gh = getIntegrations()?.github_token?.trim();
  if (!gh) return null;
  return {
    Authorization: `Bearer ${gh}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function githubApi(method, url, body = null) {
  const headers = githubHeaders();
  if (!headers) {
    return { success: false, error: 'GitHub token is missing. Add it in Settings > Integrations > GitHub.' };
  }
  return await window.electronAPI.httpApiCall({ method, url, headers, body });
}

async function cloudCodespacesList(owner, repo) {
  const res = await githubApi('GET', 'https://api.github.com/user/codespaces?per_page=100');
  if (!res?.success || (res.statusCode || 500) >= 400) return res;
  const all = Array.isArray(res?.data?.codespaces) ? res.data.codespaces : [];
  const filtered = all.filter(cs => (cs?.repository?.owner?.login || '').toLowerCase() === String(owner || '').toLowerCase()
    && (cs?.repository?.name || '').toLowerCase() === String(repo || '').toLowerCase());
  return {
    success: true,
    count: filtered.length,
    codespaces: filtered.map(cs => ({
      name: cs.name,
      state: cs.state,
      branch: cs.git_status?.ref || '',
      machine: cs.machine?.name || '',
      web_url: cs.web_url || '',
      last_used_at: cs.last_used_at || '',
    })),
  };
}

async function cloudCodespaceCreate(owner, repo, branch = '', machine = '') {
  const payload = {
    repository: `${owner}/${repo}`,
  };
  if (branch) payload.ref = branch;
  if (machine) payload.machine = machine;
  const res = await githubApi('POST', 'https://api.github.com/user/codespaces', payload);
  if (!res?.success || (res.statusCode || 500) >= 400) return res;
  const cs = res.data || {};
  if (cs.web_url) await window.electronAPI.openExternal(cs.web_url);
  return {
    success: true,
    name: cs.name || '',
    state: cs.state || '',
    web_url: cs.web_url || '',
    repository: cs.repository?.full_name || `${owner}/${repo}`,
  };
}

async function cloudCodespaceOpen(name) {
  const res = await githubApi('GET', `https://api.github.com/user/codespaces/${encodeURIComponent(name)}`);
  if (!res?.success || (res.statusCode || 500) >= 400) return res;
  const cs = res.data || {};
  const webUrl = cs.web_url || '';
  if (webUrl) await window.electronAPI.openExternal(webUrl);
  return {
    success: !!webUrl,
    name: cs.name || name,
    state: cs.state || '',
    web_url: webUrl,
    error: webUrl ? undefined : 'Codespace web URL not available.',
  };
}

const TOOL_ERROR_CODES = {
  LOCAL_BRIDGE_DOWN: 'LOCAL_BRIDGE_DOWN',
  LOCAL_PERMISSION_DENIED: 'LOCAL_PERMISSION_DENIED',
  IDE_NOT_INSTALLED: 'IDE_NOT_INSTALLED',
  CLOUD_AUTH_MISSING: 'CLOUD_AUTH_MISSING',
  TOOL_TIMEOUT: 'TOOL_TIMEOUT',
  UPSTREAM_5XX: 'UPSTREAM_5XX',
  UNKNOWN: 'UNKNOWN',
};

const SPECIALIST_ROLES = new Set(['seo', 'content', 'coding', 'research', 'ops']);
const WORKER_ROLE_PROFILES = {
  seo: {
    name: 'SEO Specialist',
    personality: 'analytical',
    instructions:
      'Execute end-to-end SEO work. Use tools directly, cite concrete findings, and return a practical action plan with priorities.',
    skills: ['seo_audit', 'technical_seo', 'on_page_seo', 'keyword_research', 'backlink_analysis'],
    output_format: 'report',
  },
  content: {
    name: 'Content Specialist',
    personality: 'editorial',
    instructions:
      'Produce clear, audience-aware content assets. Validate facts, keep a concise tone, and return publish-ready output.',
    skills: ['content_strategy', 'copywriting', 'editing', 'social_content'],
    output_format: 'report',
  },
  coding: {
    name: 'Coding Specialist',
    personality: 'engineering',
    instructions:
      'Solve implementation tasks with runnable steps, explicit assumptions, and verification guidance.',
    skills: ['software_engineering', 'debugging', 'testing', 'automation'],
    output_format: 'report',
  },
  research: {
    name: 'Research Specialist',
    personality: 'methodical',
    instructions:
      'Run structured research, compare options, and provide sourced, decision-ready output.',
    skills: ['research', 'analysis', 'comparison'],
    output_format: 'report',
  },
  ops: {
    name: 'Operations Specialist',
    personality: 'operator',
    instructions:
      'Drive execution with clear sequencing, risk notes, and measurable completion criteria.',
    skills: ['operations', 'project_management', 'process_design'],
    output_format: 'report',
  },
};

function _normalizeList(values) {
  if (!Array.isArray(values)) return [];
  return values.map((v) => String(v || '').trim()).filter(Boolean);
}

const WORKER_MAX_TOOLS = 20;
const WORKER_ROLE_TOOL_HINTS = {
  seo: ['search', 'web', 'browser', 'fetch', 'crawl', 'scrape', 'analysis', 'research', 'seo'],
  content: ['search', 'web', 'research', 'memory', 'write', 'draft', 'social', 'thread'],
  coding: ['terminal', 'shell', 'file', 'read', 'write', 'code', 'repo', 'git', 'test'],
  research: ['search', 'web', 'fetch', 'browser', 'analysis', 'compare', 'memory'],
  ops: ['terminal', 'shell', 'file', 'search', 'web', 'cron', 'automation', 'memory'],
};

function _rankWorkerTools(role, tools = []) {
  const hints = WORKER_ROLE_TOOL_HINTS[role] || WORKER_ROLE_TOOL_HINTS.ops;
  const scored = tools.map((tool, idx) => {
    const t = String(tool || '').toLowerCase();
    let score = 0;
    for (const hint of hints) {
      if (t.includes(hint)) score += 2;
    }
    if (/\b(read|write|file|terminal|shell|search|web|memory|fetch)\b/.test(t)) score += 1;
    return { tool, idx, score };
  });
  scored.sort((a, b) => (b.score - a.score) || (a.idx - b.idx));
  return scored.map((x) => x.tool);
}

function _buildWorkerPayload(role, args, caps) {
  const profile = WORKER_ROLE_PROFILES[role] || WORKER_ROLE_PROFILES.ops;
  const capabilityTools = _normalizeList(caps?.capabilities?.tools?.all);
  const requestedTools = _normalizeList(args?.tools);
  const requestedSkills = _normalizeList(args?.skills);
  const requestedConnectors = _normalizeList(args?.connectors);
  const requestedConstraints = _normalizeList(args?.constraints);
  const workerObjective = String(args?.objective || '').trim() || `Complete ${role} specialist objective`;
  const toolUniverse = requestedTools.length ? requestedTools : _rankWorkerTools(role, capabilityTools);
  const toolSet = Array.from(new Set(toolUniverse)).slice(0, WORKER_MAX_TOOLS);

  return {
    name: String(args?.worker_name || '').trim() || profile.name,
    role,
    objective: workerObjective,
    personality: String(args?.personality || '').trim() || profile.personality,
    instructions:
      String(args?.worker_instructions || '').trim() ||
      `${profile.instructions}\nAlways execute concrete actions before claiming completion.`,
    constraints: requestedConstraints,
    skills: requestedSkills.length ? requestedSkills : profile.skills,
    connectors: requestedConnectors,
    tools: toolSet,
    memory_scope: String(args?.memory_scope || '').trim() || 'shared',
    storage_namespace: String(args?.storage_namespace || '').trim() || `auto_${role}`,
    storage_quota_mb: Number(args?.storage_quota_mb || 512),
    tool_policy: {},
  };
}

function normalizeToolResult(result, { plane = 'device', fallbackAttempted = false, nextAction = '' } = {}) {
  const isObj = !!result && typeof result === 'object' && !Array.isArray(result);
  const raw = isObj ? result : { value: result };
  const success = typeof raw.success === 'boolean' ? raw.success : !raw.error;
  const out = {
    ...raw,
    success,
    plane: raw.plane || plane,
    error_code: raw.error_code || (success ? '' : TOOL_ERROR_CODES.UNKNOWN),
    recoverable: typeof raw.recoverable === 'boolean' ? raw.recoverable : !success,
    fallback_attempted: typeof raw.fallback_attempted === 'boolean' ? raw.fallback_attempted : fallbackAttempted,
    next_action: raw.next_action || nextAction,
  };
  return out;
}

function failureEnvelope(errorCode, message, { plane = 'device', recoverable = true, fallbackAttempted = false, nextAction = '' } = {}) {
  return {
    success: false,
    plane,
    error_code: errorCode || TOOL_ERROR_CODES.UNKNOWN,
    error: message,
    recoverable,
    fallback_attempted: fallbackAttempted,
    next_action: nextAction,
  };
}

async function listSkillsFromBackend(token) {
  if (!token) {
    return failureEnvelope(TOOL_ERROR_CODES.CLOUD_AUTH_MISSING, 'Authentication required to list skills.', {
      plane: 'server',
      recoverable: true,
      nextAction: 'Sign in and retry.',
    });
  }
  try {
    const data = await callBackendJson(NOAH_BACKEND_URL, '/api/v1/hermes/skills', {
      method: 'GET',
      token,
      includeByok: true,
      timeoutMs: 20000,
    });
    return { success: true, skills: data?.skills || [], count: (data?.skills || []).length };
  } catch (err) {
    return failureEnvelope(TOOL_ERROR_CODES.UNKNOWN, err.message || 'Could not list skills.', {
      plane: 'server',
      recoverable: true,
      nextAction: 'Check backend connectivity and retry.',
    });
  }
}

async function viewSkillFromBackend(name, token) {
  if (!token) {
    return failureEnvelope(TOOL_ERROR_CODES.CLOUD_AUTH_MISSING, 'Authentication required to view skills.', {
      plane: 'server',
      recoverable: true,
      nextAction: 'Sign in and retry.',
    });
  }
  try {
    const slug = String(name || '').trim();
    const data = await callBackendJson(NOAH_BACKEND_URL, `/api/v1/hermes/skills/${encodeURIComponent(slug)}`, {
      method: 'GET',
      token,
      includeByok: true,
      timeoutMs: 20000,
    });
    return { success: true, ...data };
  } catch (err) {
    return failureEnvelope(TOOL_ERROR_CODES.UNKNOWN, err.message || 'Could not load skill.', {
      plane: 'server',
      recoverable: true,
      nextAction: 'Verify skill name via list_skills and retry.',
    });
  }
}

async function listMemoriesFromBackend(token, limit = 100) {
  if (!token) {
    return failureEnvelope(TOOL_ERROR_CODES.CLOUD_AUTH_MISSING, 'Authentication required to list memories.', {
      plane: 'server',
      recoverable: true,
      nextAction: 'Sign in and retry.',
    });
  }
  try {
    const capped = Math.max(1, Math.min(5000, Number(limit || 100)));
    const data = await callBackendJson(NOAH_BACKEND_URL, `/v3/memories?limit=${capped}&offset=0`, {
      method: 'GET',
      token,
      includeByok: true,
      timeoutMs: 25000,
    });
    const memories = mergeMemoryRows(Array.isArray(data) ? data : []);
    return { success: true, memories, count: memories.length };
  } catch (err) {
    const local = localMemoryRows();
    return {
      success: true,
      memories: local,
      count: local.length,
      source: 'local_fallback',
      warning: err.message || 'Backend memory store unavailable.',
    };
  }
}

async function saveMemoryToBackend(fact, token) {
  const trimmed = String(fact || '').trim();
  if (!trimmed) {
    return failureEnvelope(TOOL_ERROR_CODES.UNKNOWN, 'Memory fact is empty.', {
      plane: 'server',
      recoverable: false,
    });
  }
  if (!token) {
    return failureEnvelope(TOOL_ERROR_CODES.CLOUD_AUTH_MISSING, 'Authentication required to save memory.', {
      plane: 'server',
      recoverable: true,
      nextAction: 'Sign in and retry.',
    });
  }
  try {
    const data = await callBackendJson(NOAH_BACKEND_URL, '/v3/memories', {
      method: 'POST',
      token,
      includeByok: true,
      timeoutMs: 25000,
      body: {
        content: trimmed,
        category: 'manual',
        visibility: 'private',
      },
    });
    return {
      success: true,
      id: data?.id || '',
      memory: data || null,
      fact: trimmed,
      category: data?.category || 'manual',
      source: 'backend',
    };
  } catch (err) {
    addMemory(trimmed);
    const local = getAllMemories()[0] || {};
    return {
      success: true,
      id: local.id || `local_${Date.now()}`,
      memory: {
        id: local.id || `local_${Date.now()}`,
        content: trimmed,
        created_at: local.created_at || Date.now(),
        source: 'local_fallback',
        sync_status: 'pending_backend',
      },
      fact: trimmed,
      category: 'manual',
      source: 'local_fallback',
      warning: err.message || 'Backend memory store unavailable; saved locally.',
    };
  }
}

async function getCapabilitiesFromBackend(token) {
  if (!token) {
    return failureEnvelope(TOOL_ERROR_CODES.CLOUD_AUTH_MISSING, 'Authentication required to fetch capabilities.', {
      plane: 'server',
      recoverable: true,
      nextAction: 'Sign in and retry.',
    });
  }
  try {
    const data = await callBackendJson(NOAH_BACKEND_URL, '/api/v1/hermes/capabilities', {
      method: 'GET',
      token,
      includeByok: true,
      timeoutMs: 15000,
    });
    return { success: true, capabilities: data?.capabilities || {}, mode: data?.mode || 'unknown', active: !!data?.active };
  } catch (err) {
    return failureEnvelope(TOOL_ERROR_CODES.UNKNOWN, err.message || 'Could not fetch capabilities.', {
      plane: 'server',
      recoverable: true,
      nextAction: 'Check backend connectivity and retry.',
    });
  }
}

async function runCronjobFromBackend(args, token) {
  if (!token) {
    return failureEnvelope(TOOL_ERROR_CODES.CLOUD_AUTH_MISSING, 'Authentication required to run cronjob tool.', {
      plane: 'server',
      recoverable: true,
      nextAction: 'Sign in and retry.',
    });
  }
  try {
    return await callBackendJson(NOAH_BACKEND_URL, '/api/v1/hermes/cronjob', {
      method: 'POST',
      token,
      includeByok: true,
      body: {
        action: args.action || 'list',
        schedule: args.schedule || '',
        task: args.task || '',
        job_id: args.job_id || '',
        paused: !!args.paused,
        reason: args.reason || '',
      },
    });
  } catch (err) {
    return failureEnvelope(TOOL_ERROR_CODES.UNKNOWN, err.message || 'Cronjob request failed.', {
      plane: 'server',
      recoverable: true,
    });
  }
}

async function runVirtualDelegation(args = {}, token = null) {
  const role = String(args.role || '').trim().toLowerCase();
  const objective = String(args.objective || '').trim();
  const outputFormat = String(args.output_format || 'summary').trim();
  const constraints = _normalizeList(args.constraints);
  if (!SPECIALIST_ROLES.has(role)) {
    return failureEnvelope(TOOL_ERROR_CODES.UNKNOWN, `Unknown specialist role '${role}'.`, {
      plane: 'server',
      recoverable: true,
      nextAction: 'Use one of: seo, content, coding, research, ops.',
    });
  }
  const caps = await getCapabilitiesFromBackend(token);
  const workerAvailable = !!caps?.capabilities?.delegation?.worker_available;
  const taskTitle = objective || `Delegated ${role} task`;
  const task = createDelegatedTask({
    title: taskTitle,
    description: constraints.length ? constraints.join(' | ') : `Specialist role: ${role}`,
    role,
    source: 'assistant',
  });

  if (!workerAvailable || !token) {
    const reason = !token
      ? 'Authentication required to create and run delegated workers.'
      : 'Worker runtime is disabled on backend.';
    markTask(task?.id, { status: 'failed', description: reason });
    appendLog({
      type: 'worker',
      source: 'assistant',
      status: 'failed',
      message: `Delegation failed (${role})`,
      detail: reason,
      role,
      taskId: task?.id || '',
    });
    return {
      ...failureEnvelope(!token ? TOOL_ERROR_CODES.CLOUD_AUTH_MISSING : TOOL_ERROR_CODES.UNKNOWN, reason, {
        plane: 'server',
        recoverable: true,
        nextAction: !token ? 'Sign in and retry.' : 'Enable NOAH_WORKER_AGENTS_ENABLED=true on backend and retry.',
      }),
      task_id: task?.id || '',
      role,
    };
  }

  let workerId = '';
  let workerRun = null;
  let workerStatus = null;
  let workerResult = null;
  try {
    const payload = _buildWorkerPayload(role, args, caps);
    const created = await createWorkerAgent(payload, token);
    workerId = created?.worker_id || created?.id || '';
    if (!workerId) {
      throw new Error('Worker creation did not return a worker_id.');
    }

    markTask(task?.id, {
      assignedWorker: workerId,
      status: 'delegated',
      description: `Worker ${payload.name} assigned for ${role} task.`,
      meta: {
        role,
        skills: payload.skills,
        connectors: payload.connectors,
        tools_count: payload.tools.length,
      },
    });
    appendLog({
      type: 'worker',
      source: 'assistant',
      status: 'delegated',
      message: `Worker spawned (${role})`,
      detail: `${payload.name} · ${workerId}`,
      workerId,
      role,
      taskId: task?.id || '',
    });

    markTask(task?.id, { status: 'active', description: 'Worker is executing delegated task.' });
    appendLog({
      type: 'worker',
      source: 'assistant',
      status: 'active',
      message: `Worker running (${role})`,
      detail: objective || `Complete ${role} objective`,
      workerId,
      role,
      taskId: task?.id || '',
    });

    workerRun = await runWorkerAgent(workerId, {
      task: objective || `Complete ${role} objective`,
      output_format: outputFormat || payload.output_format || 'summary',
      tools: payload.tools,
      connectors: payload.connectors,
    }, token);
    [workerStatus, workerResult] = await Promise.all([
      getWorkerAgentStatus(workerId, token),
      getWorkerAgentResult(workerId, token),
    ]);
  } catch (err) {
    const workerError = err?.message || 'Worker spawn/run failed';
    markTask(task?.id, { status: 'failed', assignedWorker: workerId, description: workerError });
    appendLog({
      type: 'worker',
      source: 'assistant',
      status: 'failed',
      message: `Worker failed (${role})`,
      detail: workerError,
      workerId,
      role,
      taskId: task?.id || '',
    });
    return {
      ...failureEnvelope(TOOL_ERROR_CODES.UNKNOWN, workerError, {
        plane: 'server',
        recoverable: true,
        nextAction: 'Retry with tighter constraints or inspect worker logs.',
      }),
      worker_id: workerId,
      task_id: task?.id || '',
      role,
    };
  }

  const statusRaw = String(workerStatus?.status || workerRun?.status || '').toLowerCase();
  const resultSuccess = workerResult?.result?.success !== false;
  const finalStatus = (statusRaw === 'completed' || (resultSuccess && statusRaw !== 'failed')) ? 'completed' : 'failed';
  const summary =
    String(workerResult?.result?.summary || workerResult?.result?.message || '').trim() ||
    (finalStatus === 'completed' ? 'Worker completed delegated task.' : 'Worker run failed.');

  markTask(task?.id, {
    status: finalStatus,
    assignedWorker: workerId,
    description: summary.slice(0, 400),
    meta: {
      role,
      worker_status: workerStatus?.status || workerRun?.status || '',
      output_format: outputFormat,
    },
  });
  appendLog({
    type: 'worker',
    source: 'assistant',
    status: finalStatus,
    message: `Worker ${finalStatus} (${role})`,
    detail: summary.slice(0, 500),
    workerId,
    role,
    taskId: task?.id || '',
  });

  if (finalStatus !== 'completed') {
    return {
      ...failureEnvelope(
        TOOL_ERROR_CODES.UNKNOWN,
        summary,
        { plane: 'server', recoverable: true, nextAction: 'Inspect worker result and rerun with refined objective.' },
      ),
      worker_id: workerId,
      task_id: task?.id || '',
      role,
    };
  }

  return {
    success: true,
    plane: 'server',
    role,
    objective,
    constraints,
    output_format: outputFormat,
    note: `Delegated to worker ${workerId}. Task lifecycle is tracked in Workers and Tasks modules.`,
    provenance: [{ role, status: 'planned', objective, constraints }],
    worker_available: workerAvailable,
    worker_id: workerId,
    worker_run: workerRun,
    worker_status: workerStatus,
    worker_result: workerResult,
    task_id: task?.id || '',
    summary,
  };
}

async function sendGmail(args = {}) {
  const integrations = await getFreshIntegrations();
  const googleToken = String(integrations.google_token || '').trim();
  if (!googleToken) {
    return failureEnvelope(TOOL_ERROR_CODES.CLOUD_AUTH_MISSING, 'Google Workspace is not connected. Connect Google in Settings > Connectors first.', {
      plane: 'device',
      recoverable: true,
      nextAction: 'Connect Google Workspace and retry.',
    });
  }

  const recipients = Array.isArray(args.to) ? args.to.map(String).map(s => s.trim()).filter(Boolean) : [String(args.to || '').trim()].filter(Boolean);
  if (!recipients.length) {
    return failureEnvelope(TOOL_ERROR_CODES.UNKNOWN, 'send_gmail requires at least one recipient.', {
      plane: 'device',
      recoverable: true,
    });
  }

  const raw = buildRawEmail({
    to: recipients,
    cc: args.cc,
    bcc: args.bcc,
    subject: args.subject || '',
    body: args.body || '',
  });

  const result = await window.electronAPI.httpApiCall({
    method: 'POST',
    url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    headers: {
      Authorization: `Bearer ${googleToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: { raw },
  });

  if (!result?.success || result.statusCode >= 400) {
    const detail = typeof result?.data === 'string'
      ? result.data
      : result?.data?.error?.message || result?.error || `Gmail API failed (${result?.statusCode || 'unknown'})`;
    return failureEnvelope(TOOL_ERROR_CODES.UNKNOWN, detail, {
      plane: 'device',
      recoverable: true,
      nextAction: 'Verify Gmail scope is granted, then reconnect Google Workspace if needed.',
    });
  }

  return {
    success: true,
    provider: 'gmail',
    message_id: result.data?.id || '',
    thread_id: result.data?.threadId || '',
    to: recipients,
  };
}

async function googleWorkspaceRequest({ method = 'GET', url, body = null }) {
  const integrations = await getFreshIntegrations();
  const googleToken = String(integrations.google_token || '').trim();
  if (!googleToken) {
    return failureEnvelope(TOOL_ERROR_CODES.CLOUD_AUTH_MISSING, 'Google Workspace is not connected. Connect Google in Settings > Connectors first.', {
      plane: 'device',
      recoverable: true,
      nextAction: 'Connect Google Workspace and retry.',
    });
  }

  const result = await window.electronAPI.httpApiCall({
    method,
    url,
    headers: {
      Authorization: `Bearer ${googleToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body,
  });

  if (!result?.success || result.statusCode >= 400) {
    const detail = typeof result?.data === 'string'
      ? result.data
      : result?.data?.error?.message || result?.error || `Google API failed (${result?.statusCode || 'unknown'})`;
    return failureEnvelope(TOOL_ERROR_CODES.UNKNOWN, detail, {
      plane: 'device',
      recoverable: true,
      nextAction: 'If this is a permission/scope error, reconnect Google Workspace so Drive, Docs, Sheets, and Calendar scopes are granted.',
    });
  }

  return { success: true, data: result.data, statusCode: result.statusCode };
}

function googleDriveQueryEscape(value = '') {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function googleDriveSearch(args = {}) {
  const query = String(args.query || '').trim();
  if (!query) {
    return failureEnvelope(TOOL_ERROR_CODES.UNKNOWN, 'google_drive_search requires query.', { plane: 'device', recoverable: true });
  }
  const limit = Math.max(1, Math.min(50, Number(args.limit || 10)));
  const clauses = [
    'trashed = false',
    `(name contains '${googleDriveQueryEscape(query)}' or fullText contains '${googleDriveQueryEscape(query)}')`,
  ];
  if (args.mime_type) clauses.push(`mimeType = '${googleDriveQueryEscape(args.mime_type)}'`);
  const params = new URLSearchParams({
    q: clauses.join(' and '),
    pageSize: String(limit),
    fields: 'files(id,name,mimeType,webViewLink,modifiedTime,owners(displayName,emailAddress))',
    includeItemsFromAllDrives: 'true',
    supportsAllDrives: 'true',
  });
  const resp = await googleWorkspaceRequest({ url: `https://www.googleapis.com/drive/v3/files?${params}` });
  if (!resp.success) return resp;
  return { success: true, files: resp.data?.files || [] };
}

function extractGoogleDocText(document = {}) {
  const chunks = [];
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node.textRun?.content) chunks.push(node.textRun.content);
    if (node.paragraph?.elements) walk(node.paragraph.elements);
    if (node.table?.tableRows) walk(node.table.tableRows);
    if (node.tableCells) walk(node.tableCells);
    if (node.content) walk(node.content);
  };
  walk(document.body?.content || []);
  return chunks.join('');
}

async function googleSheetsGetValues(args = {}) {
  const spreadsheetId = String(args.spreadsheet_id || args.file_id || '').trim();
  const range = String(args.range || 'A1:Z100').trim();
  if (!spreadsheetId) {
    return failureEnvelope(TOOL_ERROR_CODES.UNKNOWN, 'google_sheets_get_values requires spreadsheet_id.', { plane: 'device', recoverable: true });
  }
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;
  const resp = await googleWorkspaceRequest({ url });
  if (!resp.success) return resp;
  return { success: true, spreadsheet_id: spreadsheetId, range: resp.data?.range || range, values: resp.data?.values || [] };
}

async function googleSheetsUpdateValues(args = {}) {
  const spreadsheetId = String(args.spreadsheet_id || '').trim();
  const range = String(args.range || '').trim();
  const values = Array.isArray(args.values) ? args.values : [];
  if (!spreadsheetId || !range || !values.length) {
    return failureEnvelope(TOOL_ERROR_CODES.UNKNOWN, 'google_sheets_update_values requires spreadsheet_id, range, and values.', { plane: 'device', recoverable: true });
  }
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  const resp = await googleWorkspaceRequest({ method: 'PUT', url, body: { values } });
  if (!resp.success) return resp;
  return { success: true, updated: resp.data };
}

async function googleDriveReadFile(args = {}) {
  const fileId = String(args.file_id || '').trim();
  if (!fileId) {
    return failureEnvelope(TOOL_ERROR_CODES.UNKNOWN, 'google_drive_read_file requires file_id.', { plane: 'device', recoverable: true });
  }
  const metaResp = await googleWorkspaceRequest({
    url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,webViewLink&supportsAllDrives=true`,
  });
  if (!metaResp.success) return metaResp;
  const file = metaResp.data || {};

  if (file.mimeType === 'application/vnd.google-apps.document') {
    const docResp = await googleWorkspaceRequest({ url: `https://docs.googleapis.com/v1/documents/${encodeURIComponent(fileId)}` });
    if (!docResp.success) return docResp;
    return { success: true, file, text: extractGoogleDocText(docResp.data), document: docResp.data };
  }

  if (file.mimeType === 'application/vnd.google-apps.spreadsheet') {
    const values = await googleSheetsGetValues({ spreadsheet_id: fileId, range: args.range || 'A1:Z100' });
    return { ...values, file };
  }

  const exportMime = file.mimeType === 'application/vnd.google-apps.presentation' ? 'text/plain' : 'text/plain';
  const exportResp = await googleWorkspaceRequest({
    url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportMime)}`,
  });
  if (!exportResp.success) return exportResp;
  return { success: true, file, content: exportResp.data };
}

async function googleCalendarListEvents(args = {}) {
  const calendarId = String(args.calendar_id || 'primary').trim();
  const params = new URLSearchParams({
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: String(Math.max(1, Math.min(50, Number(args.limit || 10)))),
  });
  if (args.time_min) params.set('timeMin', String(args.time_min));
  if (args.time_max) params.set('timeMax', String(args.time_max));
  if (args.query) params.set('q', String(args.query));
  const resp = await googleWorkspaceRequest({ url: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}` });
  if (!resp.success) return resp;
  return { success: true, events: resp.data?.items || [] };
}

async function googleCalendarCreateEvent(args = {}) {
  const calendarId = String(args.calendar_id || 'primary').trim();
  const event = {
    summary: args.summary || '',
    description: args.description || '',
    start: { dateTime: args.start, ...(args.timezone ? { timeZone: args.timezone } : {}) },
    end: { dateTime: args.end, ...(args.timezone ? { timeZone: args.timezone } : {}) },
  };
  if (Array.isArray(args.attendees) && args.attendees.length) {
    event.attendees = args.attendees.map(email => ({ email: String(email).trim() })).filter(a => a.email);
  }
  const resp = await googleWorkspaceRequest({
    method: 'POST',
    url: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    body: event,
  });
  if (!resp.success) return resp;
  return { success: true, event: resp.data };
}

async function googleWorkspaceDiagnostics() {
  const integrations = await getFreshIntegrations();
  const googleToken = String(integrations.google_token || '').trim();
  if (!googleToken) {
    return failureEnvelope(TOOL_ERROR_CODES.CLOUD_AUTH_MISSING, 'Google Workspace is not connected. Connect Google in Settings > Connectors first.', {
      plane: 'device',
      recoverable: true,
      nextAction: 'Connect Google Workspace and retry.',
    });
  }

  const tokenInfo = await window.electronAPI.httpApiCall({
    method: 'GET',
    url: `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(googleToken)}`,
    headers: { Accept: 'application/json' },
  });
  const scopes = String(tokenInfo?.data?.scope || '').split(/\s+/).filter(Boolean);
  const hasScope = (needle) => scopes.some(scope => scope === needle || scope.endsWith(`/${needle}`));

  const driveProbe = await googleWorkspaceRequest({
    url: 'https://www.googleapis.com/drive/v3/files?pageSize=1&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true',
  });
  const calendarProbe = await googleWorkspaceRequest({
    url: 'https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=1',
  });

  return {
    success: true,
    token_info_ok: !!(tokenInfo?.success && tokenInfo.statusCode < 400),
    granted_scopes: scopes,
    expected_scopes: {
      drive: 'https://www.googleapis.com/auth/drive',
      docs: 'https://www.googleapis.com/auth/documents',
      sheets: 'https://www.googleapis.com/auth/spreadsheets',
      calendar: 'https://www.googleapis.com/auth/calendar',
      gmail: 'https://www.googleapis.com/auth/gmail.modify',
    },
    scope_status: {
      drive: hasScope('drive'),
      docs: hasScope('documents'),
      sheets: hasScope('spreadsheets'),
      calendar: hasScope('calendar'),
      gmail: hasScope('gmail.modify'),
    },
    probes: {
      drive: driveProbe.success ? { ok: true } : { ok: false, error: driveProbe.error, next_action: driveProbe.next_action },
      calendar: calendarProbe.success ? { ok: true } : { ok: false, error: calendarProbe.error, next_action: calendarProbe.next_action },
    },
    likely_fix: 'If Drive/Docs/Sheets/Calendar scopes are false or probes return insufficient permissions, reconnect Google Workspace. If probes say the API is disabled, enable that API in Google Cloud for the OAuth project, then reconnect.',
  };
}

function formatDelegationResultText(delegated = {}, fallback = 'Delegated task completed.') {
  const summary = String(delegated.summary || delegated.note || fallback).trim() || fallback;
  const workerId = delegated.worker_id ? `Worker ID: ${delegated.worker_id}` : '';
  const taskId = delegated.task_id ? `Task ID: ${delegated.task_id}` : '';
  return cleanAssistantOutput([summary, workerId, taskId].filter(Boolean).join('\n'));
}

function formatGoogleWorkspaceResult(toolName, result, query = '') {
  if (!result?.success) {
    return cleanAssistantOutput([
      `Google Workspace ${toolName.replace(/^google_/, '').replace(/_/g, ' ')} failed.`,
      result?.error ? `Error: ${result.error}` : '',
      result?.next_action ? `Next action: ${result.next_action}` : '',
    ].filter(Boolean).join('\n'));
  }

  if (toolName === 'google_workspace_diagnostics') {
    const scopeStatus = result.scope_status || {};
    const probes = result.probes || {};
    return cleanAssistantOutput([
      'Google Workspace diagnostics:',
      `Drive scope: ${scopeStatus.drive ? 'granted' : 'missing'}`,
      `Docs scope: ${scopeStatus.docs ? 'granted' : 'missing'}`,
      `Sheets scope: ${scopeStatus.sheets ? 'granted' : 'missing'}`,
      `Calendar scope: ${scopeStatus.calendar ? 'granted' : 'missing'}`,
      `Drive API probe: ${probes.drive?.ok ? 'ok' : `failed - ${probes.drive?.error || 'unknown error'}`}`,
      `Calendar API probe: ${probes.calendar?.ok ? 'ok' : `failed - ${probes.calendar?.error || 'unknown error'}`}`,
      result.likely_fix ? `Likely fix: ${result.likely_fix}` : '',
    ].filter(Boolean).join('\n'));
  }

  const files = result.files || [];
  if (toolName === 'google_drive_search') {
    if (!files.length) {
      return `I searched Google Drive for "${query}" and did not find a matching file visible to the connected Google account.`;
    }
    const lines = files.slice(0, 8).map((file, idx) => {
      const type = String(file.mimeType || '').replace('application/vnd.google-apps.', 'Google ');
      return `${idx + 1}. ${file.name} (${type || 'file'})${file.webViewLink ? `\n${file.webViewLink}` : ''}`;
    });
    return cleanAssistantOutput(`I found ${files.length} matching Google Drive file${files.length === 1 ? '' : 's'} for "${query}":\n${lines.join('\n')}`);
  }

  return cleanAssistantOutput(JSON.stringify(result, null, 2).slice(0, 3000));
}

async function handleDirectGoogleWorkspaceRequest(transcript, onAction) {
  const diagnostic = isGoogleWorkspaceDiagnosticRequest(transcript);
  const sheetLike = /\b(sheet|sheets|spreadsheet)\b/i.test(transcript || '');
  const toolName = diagnostic ? 'google_workspace_diagnostics' : 'google_drive_search';
  const query = inferGoogleDriveSearchQuery(transcript || '');
  const args = diagnostic
    ? { reason: 'Diagnose Google Workspace access' }
    : {
        query,
        limit: 10,
        ...(sheetLike ? { mime_type: 'application/vnd.google-apps.spreadsheet' } : {}),
        reason: 'Search connected Google Drive directly',
      };
  const label = diagnostic ? 'Diagnosing Google Workspace access' : `Searching Google Drive: ${query}`;
  onAction?.({ type: toolName, label, status: 'running', plane: 'device' });
  const result = await executeTool(toolName, args, null);
  onAction?.({ type: toolName, label, status: result?.success ? 'done' : 'error', result, plane: 'device' });
  return formatGoogleWorkspaceResult(toolName, result, query);
}

async function executeTool(name, args, token = null) {
  const toolAliases = {
    web_search: 'search_web',
    web_extract: 'fetch_webpage',
    memory: 'list_memories',
    session_search: 'search_history',
    process: 'terminal',
    skills_list: 'list_skills',
    skill_view: 'view_skill',
    skill_manage: 'save_skill',
  };
  const originalName = name;
  name = toolAliases[name] || name;

  if (originalName !== name) {
    args = { ...(args || {}), _alias_from: originalName };
  }

  // Upstream Hermes browser tool compatibility via Playwright bridge.
  if (originalName === 'browser_navigate') {
    name = 'browser_playwright_script';
    args = { ...args, start_url: args?.url || args?.start_url || '', script: 'result = { ok: true, action: "navigate" };' };
  } else if (originalName === 'browser_snapshot') {
    name = 'browser_playwright_script';
    args = {
      ...args,
      script: 'const bodyText = await page.locator("body").innerText(); result = { snapshot: bodyText.slice(0, 6000) };',
    };
  } else if (originalName === 'browser_click') {
    name = 'browser_playwright_script';
    const sel = String(args?.selector || '').trim();
    args = {
      ...args,
      script: sel
        ? `await page.click(${JSON.stringify(sel)}); result = { clicked: ${JSON.stringify(sel)} };`
        : 'result = { error: "browser_click requires selector in Noah compatibility mode" };',
    };
  } else if (originalName === 'browser_type') {
    name = 'browser_playwright_script';
    const sel = String(args?.selector || '').trim();
    const txt = String(args?.text || '');
    args = {
      ...args,
      script: sel
        ? `await page.fill(${JSON.stringify(sel)}, ${JSON.stringify(txt)}); result = { typed: true, selector: ${JSON.stringify(sel)} };`
        : 'result = { error: "browser_type requires selector in Noah compatibility mode" };',
    };
  } else if (originalName === 'browser_scroll') {
    name = 'browser_playwright_script';
    const amount = Number(args?.amount || 700);
    args = { ...args, script: `await page.mouse.wheel(0, ${Number.isFinite(amount) ? amount : 700}); result = { scrolled: true };` };
  } else if (originalName === 'browser_back') {
    name = 'browser_playwright_script';
    args = { ...args, script: 'await page.goBack(); result = { went_back: true };' };
  } else if (originalName === 'browser_press') {
    name = 'browser_playwright_script';
    const key = String(args?.key || 'Enter');
    args = { ...args, script: `await page.keyboard.press(${JSON.stringify(key)}); result = { pressed: ${JSON.stringify(key)} };` };
  } else if (originalName === 'browser_get_images') {
    name = 'browser_playwright_script';
    args = {
      ...args,
      script: 'const imgs = await page.$$eval("img", els => els.map(e => ({ src: e.src, alt: e.alt || "" })).slice(0, 200)); result = { images: imgs, count: imgs.length };',
    };
  } else if (originalName === 'browser_vision') {
    name = 'browser_playwright_script';
    args = { ...args, script: 'result = { note: "Use browser_snapshot/browser_get_images in Noah compatibility mode." };' };
  } else if (originalName === 'browser_console') {
    name = 'browser_playwright_script';
    args = { ...args, script: 'result = { note: "No persistent page console buffer in compatibility mode." };' };
  } else if (originalName === 'browser_cdp' || originalName === 'browser_dialog') {
    name = 'browser_playwright_script';
    args = { ...args, script: `result = { note: ${JSON.stringify(`${originalName} compatibility mode executed via playwright bridge`)} };` };
  }

  // save_memory runs client-side in any context — no IPC needed
  if (name === 'save_memory') {
    const saved = await saveMemoryToBackend(args.fact, token);
    if (saved.success && args.fact?.trim()) addMemory(args.fact.trim());
    return saved;
  }

  if (!isElectron) {
    if (name === 'search_web') return await duckduckgoSearch(args.query);
    return failureEnvelope(
      TOOL_ERROR_CODES.LOCAL_BRIDGE_DOWN,
      'Full tool execution requires the desktop app runtime.',
      { plane: 'device', recoverable: true, nextAction: 'Open Noah desktop app and retry.' },
    );
  }
  try {
    let raw;
    switch (name) {
      case 'terminal':        raw = await window.electronAPI.runShell(args.command); break;
      case 'search_files': {
        const p = String(args.path || '.');
        const pat = String(args.pattern || '');
        raw = await window.electronAPI.runShell(`rg -n --hidden --glob '!.git' ${shellSingleQuote(pat)} ${shellSingleQuote(p)} || true`);
        break;
      }
      case 'patch': {
        const filePath = String(args.path || '');
        const find = String(args.find || '');
        const replace = String(args.replace || '');
        const fileRead = await window.electronAPI.readFile(filePath);
        if (!fileRead?.success) return normalizeToolResult(fileRead, { plane: 'device' });
        if (!String(fileRead.content || '').includes(find)) {
          return failureEnvelope(TOOL_ERROR_CODES.UNKNOWN, 'Patch target text not found.', { plane: 'device', recoverable: true });
        }
        const updated = String(fileRead.content || '').replaceAll(find, replace);
        raw = await window.electronAPI.writeFile(filePath, updated);
        break;
      }
      case 'execute_code': {
        const code = String(args.code || '');
        const tmp = `/tmp/noah_exec_${Date.now()}_${Math.random().toString(36).slice(2)}.py`;
        await window.electronAPI.writeFile(tmp, code);
        raw = await window.electronAPI.runShell(`python3 ${shellSingleQuote(tmp)}`);
        try { await window.electronAPI.runShell(`rm -f ${shellSingleQuote(tmp)}`); } catch {}
        break;
      }
      case 'run_applescript': {
        const integrations = getIntegrations();
        if (getEmailSendMode(integrations) === 'gmail' && appleScriptTargetsMail(args.script || args.reason || '')) {
          return failureEnvelope(TOOL_ERROR_CODES.UNKNOWN, 'Email delivery mode is Gmail connector. Use send_gmail instead of Apple Mail or Outlook AppleScript.', {
            plane: 'device',
            recoverable: true,
            nextAction: 'Call send_gmail with to, subject, and body.',
          });
        }
        raw = await window.electronAPI.runApplescript(args.script);
        break;
      }
      case 'read_file':       raw = await window.electronAPI.readFile(args.path); break;
      case 'write_file':      raw = await window.electronAPI.writeFile(args.path, args.content); break;
      case 'list_directory':  raw = await window.electronAPI.listDirectory(args.path); break;
      case 'show_notification':
        await window.electronAPI.showNotification(args.title, args.body);
        raw = { success: true };
        break;
      case 'fetch_webpage':   raw = await window.electronAPI.fetchUrl(args.url); break;
      case 'open_url':
        await window.electronAPI.openExternal(args.url);
        raw = { success: true, output: `Opened ${args.url}` };
        break;
      case 'open_path':       raw = await window.electronAPI.openPath(args.path); break;
      case 'computer_open_application':
        raw = await window.electronAPI.runShell(`open -a "${String(args.app_name || '').replace(/"/g, '\\"')}"`);
        break;
      case 'computer_click': {
        const x = Math.max(0, Number(args.x || 0));
        const y = Math.max(0, Number(args.y || 0));
        const count = Math.max(1, Math.min(3, Number(args.click_count || 1)));
        const clickCmd = count > 1 ? `repeat ${count} times\n          click at {${x}, ${y}}\n        end repeat` : `click at {${x}, ${y}}`;
        const clickScript = `tell application "System Events" to ${clickCmd}`;
        raw = await window.electronAPI.runApplescript(clickScript);
        break;
      }
      case 'computer_type': {
        const typeScript = `tell application "System Events" to keystroke "${appleEscape(args.text || '')}"`;
        const typed = await window.electronAPI.runApplescript(typeScript);
        if (args.submit) {
          const submitted = await window.electronAPI.runApplescript('tell application "System Events" to key code 36');
          raw = { success: !!(typed?.success && submitted?.success), typed, submitted };
          break;
        }
        raw = typed;
        break;
      }
      case 'computer_hotkey':
        raw = await runDesktopHotkey(args.keys || []);
        break;
      case 'computer_wait_for_app': {
        const appName = String(args.app_name || '').trim();
        const timeoutSec = Math.max(1, Math.min(60, Number(args.timeout_sec || 10)));
        const started = Date.now();
        while ((Date.now() - started) < timeoutSec * 1000) {
          const check = await window.electronAPI.runShell(`pgrep -x ${JSON.stringify(appName)} >/dev/null && echo "__up__" || true`);
          if ((check?.output || '').includes('__up__')) {
            raw = { success: true, app_name: appName };
            break;
          }
          await new Promise(r => setTimeout(r, 350));
        }
        if (!raw) {
          return failureEnvelope(TOOL_ERROR_CODES.TOOL_TIMEOUT, `Timed out waiting for app '${appName}'`, {
            plane: 'device',
            recoverable: true,
            nextAction: 'Retry or use a different app target.',
          });
        }
        break;
      }
      case 'computer_claude_create_thread':
        raw = await runClaudeThreadWorkflow(args.prompt || '', args.submit !== false);
        break;
      case 'computer_observe':
        raw = await observeFrontmostUI(!!args.include_ui_tree);
        break;
      case 'computer_click_text': {
        const timeoutSec = Math.max(1, Math.min(30, Number(args.timeout_sec || 8)));
        const started = Date.now();
        let last = null;
        while ((Date.now() - started) < timeoutSec * 1000) {
          last = await clickByVisibleText(args.text || '', !!args.exact);
          if (last?.success) {
            raw = last;
            break;
          }
          await new Promise(r => setTimeout(r, 250));
        }
        if (!raw) {
          return failureEnvelope(TOOL_ERROR_CODES.UNKNOWN, `Element text '${args.text}' not found`, {
            plane: 'device',
            recoverable: true,
            nextAction: 'Use computer_observe first, then retry with exact visible text.',
          });
        }
        break;
      }
      case 'computer_type_in_field':
        raw = await typeInFieldByHint(args.field_hint || '', args.text || '', !!args.submit);
        break;
      case 'computer_verify_text':
        raw = await verifyVisibleText(args.text || '', !!args.exact);
        break;
      case 'computer_vscode_open_project': {
        const projectPath = String(args.project_path || '').trim();
        const hasCode = await detectLocalVscode();
        if (!hasCode.available) {
          return failureEnvelope(TOOL_ERROR_CODES.IDE_NOT_INSTALLED, 'VS Code is not installed on this machine.', {
            plane: 'device',
            recoverable: true,
            nextAction: 'Use cloud_codespace_create for cloud IDE fallback.',
          });
        }
        raw = await window.electronAPI.runShell(`code ${shellSingleQuote(projectPath)}`);
        break;
      }
      case 'computer_vscode_open_file': {
        const filePath = String(args.file_path || '').trim();
        const line = Math.max(1, Number(args.line || 1));
        const hasCode = await detectLocalVscode();
        if (!hasCode.available) {
          return failureEnvelope(TOOL_ERROR_CODES.IDE_NOT_INSTALLED, 'VS Code is not installed on this machine.', {
            plane: 'device',
            recoverable: true,
            nextAction: 'Use cloud_codespace_create for cloud IDE fallback.',
          });
        }
        raw = await window.electronAPI.runShell(`code -g ${shellSingleQuote(`${filePath}:${line}`)}`);
        break;
      }
      case 'computer_vscode_run_task': {
        const command = String(args.command || '').trim();
        const cwd = String(args.cwd || '').trim();
        const wrapped = cwd
          ? `cd ${shellSingleQuote(cwd)} && ${command}`
          : command;
        raw = await window.electronAPI.runShell(wrapped);
        break;
      }
      case 'browser_playwright_script': {
        const ready = await detectPlaywrightReady();
        if (!ready.available) {
          return failureEnvelope(TOOL_ERROR_CODES.UNKNOWN, 'Playwright runtime is missing.', {
            plane: 'device',
            recoverable: true,
            nextAction: 'Install Playwright in desktop runtime and retry.',
          });
        }
        raw = await runPlaywrightScript(args);
        break;
      }
      case 'cloud_codespaces_list':
        if (!_hasGithubToken()) {
          return failureEnvelope(TOOL_ERROR_CODES.CLOUD_AUTH_MISSING, 'GitHub token is missing for Codespaces.', {
            plane: 'cloud',
            recoverable: true,
            nextAction: 'Connect GitHub in Connectors, then retry.',
          });
        }
        raw = await cloudCodespacesList(args.owner, args.repo);
        break;
      case 'cloud_codespace_create':
        if (!_hasGithubToken()) {
          return failureEnvelope(TOOL_ERROR_CODES.CLOUD_AUTH_MISSING, 'GitHub token is missing for Codespaces.', {
            plane: 'cloud',
            recoverable: true,
            nextAction: 'Connect GitHub in Connectors, then retry.',
          });
        }
        raw = await cloudCodespaceCreate(args.owner, args.repo, args.branch || '', args.machine || '');
        break;
      case 'cloud_codespace_open':
        if (!_hasGithubToken()) {
          return failureEnvelope(TOOL_ERROR_CODES.CLOUD_AUTH_MISSING, 'GitHub token is missing for Codespaces.', {
            plane: 'cloud',
            recoverable: true,
            nextAction: 'Connect GitHub in Connectors, then retry.',
          });
        }
        raw = await cloudCodespaceOpen(args.codespace_name);
        break;
      case 'search_web':
        raw = await searchWeb(args.query);
        break;
      case 'list_skills':
        raw = await listSkillsFromBackend(token);
        break;
      case 'view_skill':
        raw = await viewSkillFromBackend(args.name || args.slug || '', token);
        break;
      case 'save_skill': {
        const name = String(args.name || '').trim();
        const content = String(args.content || '').trim();
        if (!name || !content) {
          return failureEnvelope(TOOL_ERROR_CODES.UNKNOWN, 'save_skill requires name and content', {
            plane: 'server',
            recoverable: true,
          });
        }
        const formatted = content.startsWith('---')
          ? content
          : `---\nname: ${name}\ndescription: Imported skill\n---\n\n${content}\n`;
        raw = await installSkill(formatted, args.shared ? 'shared' : 'user', token);
        break;
      }
      case 'search_history': {
        // Lightweight compatibility path: reuse backend sessions API for now.
        const q = String(args.query || '').toLowerCase();
        const sessions = await getHermesSessions(token);
        const rows = Array.isArray(sessions?.sessions) ? sessions.sessions : [];
        raw = {
          success: true,
          query: args.query || '',
          matches: rows.filter(r => String(r?.preview || '').toLowerCase().includes(q)).slice(0, Math.max(1, Number(args.limit || 5))),
        };
        break;
      }
      case 'list_memories':
        raw = await listMemoriesFromBackend(token, args.limit || 100);
        break;
      case 'save_memory_server':
        raw = await saveMemoryToBackend(args.fact || args.content || '', token);
        break;
      case 'get_capabilities':
        raw = await getCapabilitiesFromBackend(token);
        break;
      case 'cronjob':
        raw = await runCronjobFromBackend(args, token);
        break;
      case 'delegate_task':
        raw = await runVirtualDelegation(args, token);
        break;
      case 'send_gmail':
        raw = await sendGmail(args);
        break;
      case 'google_drive_search':
        raw = await googleDriveSearch(args);
        break;
      case 'google_drive_read_file':
        raw = await googleDriveReadFile(args);
        break;
      case 'google_sheets_get_values':
        raw = await googleSheetsGetValues(args);
        break;
      case 'google_sheets_update_values':
        raw = await googleSheetsUpdateValues(args);
        break;
      case 'google_calendar_list_events':
        raw = await googleCalendarListEvents(args);
        break;
      case 'google_calendar_create_event':
        raw = await googleCalendarCreateEvent(args);
        break;
      case 'google_workspace_diagnostics':
        raw = await googleWorkspaceDiagnostics(args);
        break;
      case 'api_call':
        raw = await window.electronAPI.httpApiCall({ method: args.method, url: args.url, headers: args.headers || {}, body: args.body || null });
        break;
      default:
        return failureEnvelope(TOOL_ERROR_CODES.UNKNOWN, `Unknown tool: ${name}`, {
          plane: 'server',
          recoverable: false,
        });
    }
    return normalizeToolResult(raw, { plane: name.startsWith('cloud_') ? 'cloud' : 'device' });
  } catch (err) {
    return failureEnvelope(TOOL_ERROR_CODES.UNKNOWN, err.message || String(err), {
      plane: name.startsWith('cloud_') ? 'cloud' : 'device',
      recoverable: true,
    });
  }
}

async function searchWeb(query) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const result = await window.electronAPI.fetchUrl(url);
    if (!result.success) throw new Error(result.error);
    const content = result.content || '';
    const lines = content.split('\n').filter(l => l.trim().length > 20).slice(0, 50);
    return { success: true, query, results: lines.join('\n').slice(0, 8000) };
  } catch (err) { return { success: false, error: err.message }; }
}

async function duckduckgoSearch(query) {
  try {
    const res  = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`);
    const data = await res.json();
    const results = [
      data.AbstractText && `${data.AbstractText} (${data.AbstractURL})`,
      ...(data.RelatedTopics || []).slice(0, 6).map(t => t.Text || '').filter(Boolean),
    ].filter(Boolean);
    return { success: true, query, results: results.join('\n') || 'No instant results. Try fetch_webpage.' };
  } catch (err) { return { success: false, error: err.message }; }
}

// ─── System prompt ────────────────────────────────────────────────────────────

function getNativeApps() {
  try { const r = localStorage.getItem('noah_native_apps'); return r ? JSON.parse(r) : {}; } catch { return {}; }
}

const NATIVE_APP_LABELS = {
  outlook:     'Microsoft Outlook (use AppleScript to send/draft emails)',
  apple_mail:  'Apple Mail (use AppleScript to send/draft emails)',
  messages:    'Messages (use AppleScript to send iMessages/SMS)',
  spotify:     'Spotify (use AppleScript to control playback, volume, skip)',
  apple_music: 'Apple Music (use AppleScript to play, pause, skip, volume)',
  safari:      'Safari (use AppleScript to open URLs, read tabs)',
  chrome:      'Chrome (use AppleScript to open URLs, control browser)',
  finder:      'Finder (use AppleScript to browse, move, copy files)',
  calendar:    'Calendar (use AppleScript to create/read events)',
  reminders:   'Reminders (use AppleScript to create/manage reminders)',
  notes:       'Notes (use AppleScript to create/read notes)',
  word:        'Microsoft Word (use AppleScript to create/edit documents)',
  excel:       'Microsoft Excel (use AppleScript to read/edit spreadsheets)',
  powerpoint:  'PowerPoint (use AppleScript to create presentations)',
  xcode:       'Xcode (use shell/AppleScript to build and run projects)',
  vscode:      'Visual Studio Code (use computer_vscode_* tools for coding workflows)',
  terminal:    'Terminal (use run_shell for all command-line tasks)',
};

function buildSystemPrompt(hasScreen, sysInfo, integrations, capabilities = null) {
  const custom   = getSystemInstructions().trim();
  const memories = buildMemoryContext();
  const executionMode = getExecutionMode();
  const isCoderMode = executionMode === 'coder_terminal_first';
  const emailSendMode = getEmailSendMode(integrations);

  const nativeApps = getNativeApps();
  const nativeLines = Object.entries(nativeApps)
    .filter(([, enabled]) => enabled)
    .map(([id]) => `- ${NATIVE_APP_LABELS[id] || id}`)
    .filter(Boolean);

  const integLines = [];
  if (integrations.github_token)                 integLines.push(`- GitHub: api_call to api.github.com with "Authorization: Bearer ${integrations.github_token}"`);
  if (integrations.slack_token)                  integLines.push(`- Slack: api_call to slack.com/api with "Authorization: Bearer ${integrations.slack_token}"`);
  if (integrations.notion_token)                 integLines.push(`- Notion: api_call to api.notion.com/v1 with "Authorization: Bearer ${integrations.notion_token}" + "Notion-Version: 2022-06-28"`);
  if (integrations.trello_key && integrations.trello_token) integLines.push(`- Trello: api.trello.com/1/... ?key=${integrations.trello_key}&token=${integrations.trello_token}`);
  if (integrations.brave_key)                    integLines.push(`- Brave Search: GET api.search.brave.com/res/v1/web/search?q=... with "X-Subscription-Token: ${integrations.brave_key}"`);
  if (integrations.google_token)                 integLines.push(`- Google Workspace connected: use send_gmail for Gmail, google_drive_search/google_drive_read_file for Drive and Docs, google_sheets_get_values/google_sheets_update_values for Sheets, google_calendar_list_events/google_calendar_create_event for Calendar, and api_call to googleapis.com for advanced Google APIs`);
  if (integrations.linear_key)                   integLines.push(`- Linear: POST api.linear.app/graphql with "Authorization: ${integrations.linear_key}"`);
  if (integrations.airtable_key)                 integLines.push(`- Airtable: api_call to api.airtable.com/v0 with "Authorization: Bearer ${integrations.airtable_key}"`);

  return `You are Noah, a personal AI assistant running on the user's Mac.

${memories ? `${memories}\n\n` : ''}${custom ? `User instructions:\n${custom}\n\n` : ''}System context:
- Platform: macOS ${sysInfo?.platform || 'darwin'}
- Home: ${sysInfo?.homedir || '~'}
- Username: ${sysInfo?.username || 'user'}
- Shell: ${sysInfo?.shell || '/bin/zsh'}
- Date: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
- Time: ${new Date().toLocaleTimeString('en-US')}
${hasScreen ? '- A screenshot is attached for this turn. If the user asks what is visible/on screen, answer from the screenshot. Do not claim you cannot watch or inspect the screen. If details are unreadable, say what is visible and what is unclear.' : ''}
${capabilities ? `- Capability snapshot: desktop_bridge=${capabilities.desktop_bridge?.available ? 'online' : (capabilities.desktop_bridge?.state || 'offline')}, local_vscode=${capabilities.local_vscode?.available ? 'yes' : 'no'}, local_playwright=${capabilities.local_playwright?.available ? 'yes' : 'no'}, codespaces_auth=${capabilities.github_codespaces_auth?.available ? 'yes' : 'no'}` : ''}
${capabilities?.skills ? `- Skills installed: ${capabilities.skills.count || 0}${(capabilities.skills.sample || []).length ? ` (sample: ${(capabilities.skills.sample || []).join(', ')})` : ''}` : ''}

Execution policy:
1. If the user asks for facts that may change (prices, flights, weather, news, availability), use search_web, then fetch_webpage before answering.
2. If the user asks you to perform an action, execute it with tools instead of only giving instructions.
3. If the user shares personal preferences/facts or asks "remember this", call save_memory_server (or save_memory in backend mode) and confirm save ID.
4. Use only the tools that are needed; do not call tools for simple chit-chat.
5. For macOS app tasks, use run_applescript/computer_* tools first. If needed, use System Events UI scripting or terminal/osascript for automation.
6. Do not say "I can only open the app". Attempt control steps first, then report what succeeded/failed.
7. For coding tasks, prefer VS Code tools when available. If local VS Code is unavailable, use GitHub Codespaces tools (cloud_codespaces_*) as fallback.
8. If user asks what skills are installed/available, call list_skills before answering.
9. If user asks about capabilities, call get_capabilities and summarize concrete availability.
10. If user asks about cron/scheduling, call cronjob with action="list" before answering, then explain what schedule actions are available.
11. Email delivery mode: ${emailSendMode === 'gmail' ? 'Gmail connector. For sending email, use send_gmail. Do not use Apple Mail, Outlook, browser Gmail, or Mail AppleScript unless the user explicitly asks for a native app.' : 'Native app. For sending email, use the enabled native mail app unless the user explicitly asks for Gmail/Google.'}
12. If the user explicitly says Gmail, Google account, Google Workspace, or connected Google account for an email task, use send_gmail regardless of native app availability.
13. For Google Drive, Docs, Sheets, or Calendar tasks, never say you lack access before trying the matching Google Workspace tool. If a Google tool returns a scope or permission error, report that exact error and ask the user to reconnect Google Workspace.
14. If the user asks why Google Drive/Docs/Sheets/Calendar access failed, call google_workspace_diagnostics before answering and explain the concrete failing scope or API probe.
${isCoderMode ? `15. CODER MODE (TERMINAL-FIRST): For coding/software tasks, prioritize terminal + read_file/write_file/list_directory workflows. Treat GUI app automation as fallback only when terminal/file route is not sufficient.
16. In coder mode, run small verification steps after edits (lint/test/build for changed scope when feasible), and report concrete outputs/errors briefly.
17. In coder mode, prefer deterministic edits over conversational explanations.` : ''}

Available native apps:
${nativeLines.length > 0 ? nativeLines.join('\n') : '- None enabled yet'}

Available API integrations:
${integLines.length > 0 ? integLines.join('\n') : '- None configured yet'}

Response style:
- Sound natural and human.
- For normal chat, keep replies to 1-4 short sentences.
- Use bullets only when listing steps/options.
- Be concise and practical; avoid robotic verbosity.
- Only produce long detail when user explicitly asks for it.`;
}

async function getFreshIntegrations() {
  const integrations = getIntegrations();
  const expiresAt = Number(integrations.google_token_expires_at || 0);
  const shouldRefreshGoogle = integrations.google_refresh_token
    && integrations.google_client_id
    && (!integrations.google_token || !expiresAt || Date.now() > expiresAt - 120000);

  if (!shouldRefreshGoogle || typeof window === 'undefined' || !window.electronAPI?.refreshGoogleWorkspaceToken) {
    return integrations;
  }

  try {
    const result = await window.electronAPI.refreshGoogleWorkspaceToken({
      clientId: integrations.google_client_id,
      clientSecret: integrations.google_client_secret || BUILT_IN_GOOGLE_WORKSPACE_CLIENT_SECRET,
      refreshToken: integrations.google_refresh_token,
    });
    if (!result?.success || !result.accessToken) return integrations;

    const next = {
      ...integrations,
      google_token: result.accessToken,
      google_token_expires_at: String(Date.now() + Math.max(60, Number(result.expiresIn || 3600) - 60) * 1000),
      google_scope: result.scope || integrations.google_scope || '',
    };
    saveAllIntegrations(next);
    return next;
  } catch (e) {
    console.warn('[Noah] Google Workspace token refresh failed:', e);
    return integrations;
  }
}

// ─── Output cleanup (preserve formatting while removing noisy wrappers) ──

function cleanAssistantOutput(text) {
  if (!text) return text;
  return text
    // Remove fenced markers but keep content for readability.
    .replace(/```(\w+)?\n?/g, '')
    // Convert markdown heading markers into plain text headings.
    .replace(/^[\t ]{0,3}#{1,6}\s+/gm, '')
    // Remove markdown emphasis markers while keeping the text.
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    // Convert markdown bullets to Unicode bullets for clean display.
    .replace(/^[\t ]*[-*]\s+/gm, '• ')
    // Normalize numbered markers.
    .replace(/^[\t ]*(\d+)\)\s+/gm, '$1. ')
    // Enforce no em-dash / en-dash in UI copy.
    .replace(/[—–]/g, '-')
    // Collapse 3+ newlines to 2
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── Refusal detection ────────────────────────────────────────────────────────

const REFUSAL_PHRASES = [
  "i can't help", "i cannot help", "i'm unable to", "i am unable to",
  "i don't have access", "i do not have access", "i can't access", "i cannot access",
  "i can't search", "i cannot search", "i can't look", "i cannot look",
  "unfortunately i can't", "unfortunately i cannot", "i'm not able to", "i am not able to",
  "i can't do that", "i cannot do that", "beyond my capabilities", "outside my capabilities",
  "i don't have the ability", "i cannot perform",
];

function isRefusal(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return REFUSAL_PHRASES.some(p => lower.includes(p));
}

// ─── Tool approval gate ───────────────────────────────────────────────────────

/** Tools that require user confirmation before executing */
const APPROVAL_TOOLS = new Set([
  'terminal',
  'write_file',
  'run_applescript',
  'computer_click',
  'computer_type',
  'computer_hotkey',
  'computer_claude_create_thread',
  'computer_click_text',
  'computer_type_in_field',
  'computer_vscode_run_task',
  'browser_playwright_script',
  'cloud_codespace_create',
  'cloud_codespace_open',
]);
const LS_APPROVED_CODESPACE_REPOS = 'noah_codespace_repo_approvals';

function _repoApprovalKey(args = {}) {
  return `${String(args.owner || '').toLowerCase()}/${String(args.repo || '').toLowerCase()}`;
}

function _isCodespaceRepoApproved(args = {}) {
  try {
    const key = _repoApprovalKey(args);
    if (!key || key === '/') return false;
    const map = JSON.parse(localStorage.getItem(LS_APPROVED_CODESPACE_REPOS) || '{}');
    return !!map[key];
  } catch {
    return false;
  }
}

function _markCodespaceRepoApproved(args = {}) {
  try {
    const key = _repoApprovalKey(args);
    if (!key || key === '/') return;
    const map = JSON.parse(localStorage.getItem(LS_APPROVED_CODESPACE_REPOS) || '{}');
    map[key] = true;
    localStorage.setItem(LS_APPROVED_CODESPACE_REPOS, JSON.stringify(map));
  } catch {}
}

function _isReadOnlyTool(toolName = '') {
  return new Set([
    'read_file',
    'list_directory',
    'fetch_webpage',
    'search_web',
    'computer_observe',
    'computer_verify_text',
    'cloud_codespaces_list',
  ]).has(toolName);
}

function _shouldRequireApproval(toolName, args = {}) {
  if (!getRequireToolApproval() || !_approvalRequester) return false;
  if (_isReadOnlyTool(toolName)) return false;
  if (toolName === 'cloud_codespace_create') {
    return !_isCodespaceRepoApproved(args);
  }
  return APPROVAL_TOOLS.has(toolName);
}

/** Registered callback — set by the React layer via registerApprovalRequester() */
let _approvalRequester = null;

/**
 * Register a function that the service will call when it needs the user to
 * approve a tool execution. The function receives `{ toolName, args }` and
 * must return a Promise<boolean> (true = approved, false = cancelled).
 */
export function registerApprovalRequester(fn) {
  _approvalRequester = fn;
}

export function unregisterApprovalRequester() {
  _approvalRequester = null;
}

/** Read the "require approval" preference (on by default). */
export function getRequireToolApproval() {
  try { return localStorage.getItem('noah_require_tool_approval') !== 'false'; } catch { return true; }
}

/** Persist the "require approval" preference. */
export function setRequireToolApproval(value) {
  try { localStorage.setItem('noah_require_tool_approval', value ? 'true' : 'false'); } catch {}
}

// ─── Remote tool proxy ────────────────────────────────────────────────────────

/**
 * Execute a tool locally via Electron IPC and POST the result back to the backend.
 *
 * This is called when the Hermes SSE stream emits a `tool_call` event, meaning
 * the backend is delegating a macOS-specific tool (run_shell, run_applescript,
 * show_notification, open_url, open_path, write_file) to the local machine.
 */
async function executeAndReportTool(callId, toolName, args, token) {
  let result;

  if (!isElectron) {
    result = {
      error: `${toolName} requires the Noah desktop app to be running. ` +
             'Please open the Noah desktop app on your Mac.',
    };
  } else {
    // ── Approval gate ────────────────────────────────────────────────────────
    if (_shouldRequireApproval(toolName, args)) {
      let approved = false;
      try {
        approved = await _approvalRequester({
          toolName,
          args: {
            ...args,
            _approval_reason: toolName === 'cloud_codespace_create'
              ? `First-time cloud workspace creation for ${_repoApprovalKey(args)}`
              : 'System-changing action',
          },
        });
      } catch {
        approved = false;
      }
      if (!approved) {
        result = failureEnvelope(
          TOOL_ERROR_CODES.LOCAL_PERMISSION_DENIED,
          'User cancelled - operation was not approved.',
          { plane: toolName.startsWith('cloud_') ? 'cloud' : 'device', recoverable: true, nextAction: 'Ask user for approval and retry.' },
        );
        try {
          await callBackendJson(NOAH_BACKEND_URL, `/api/v1/hermes/tool_result/${callId}`, {
            method: 'POST',
            token,
            body: result,
            includeByok: true,
            timeoutMs: 15000,
          });
        } catch {}
        return;
      }
      if (toolName === 'cloud_codespace_create') _markCodespaceRepoApproved(args);
    }
    // ─────────────────────────────────────────────────────────────────────────

    try {
      result = await executeTool(toolName, args, token);
    } catch (err) {
      result = failureEnvelope(TOOL_ERROR_CODES.UNKNOWN, err.message || String(err), {
        plane: toolName.startsWith('cloud_') ? 'cloud' : 'device',
        recoverable: true,
      });
    }
  }

  result = normalizeToolResult(result, { plane: toolName.startsWith('cloud_') ? 'cloud' : 'device' });
  _metricInc(`tool_total_${toolName}`);
  _metricInc(result.success ? `tool_success_${toolName}` : `tool_failure_${toolName}`);
  _recordTrace('tool_result', {
    tool: toolName,
    plane: result.plane,
    success: result.success,
    error_code: result.error_code || '',
    fallback_attempted: !!result.fallback_attempted,
  });

  try {
    await callBackendJson(NOAH_BACKEND_URL, `/api/v1/hermes/tool_result/${callId}`, {
      method: 'POST',
      token,
      body: result,
      includeByok: true,
      timeoutMs: 15000,
    });
  } catch (err) {
    console.error('[Noah] Failed to report tool result for', callId, ':', err.message);
  }
}

async function streamHermesViaElectron(payload, token, onAction, isVoiceMode, baseUrl = NOAH_BACKEND_URL) {
  if (!isElectron || !window.electronAPI?.httpApiStreamStart || !window.electronAPI?.onHttpApiStreamEvent) {
    throw new Error('Electron stream bridge unavailable');
  }

  const streamId = `hermes_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  let finalResponse = '';
  let tokenAccumulator = '';
  let gotDoneEvent = false;
  let settled = false;
  let unsubscribe = null;

  const cleanup = () => {
    try { unsubscribe?.(); } catch {}
    window.electronAPI.httpApiStreamStop({ streamId }).catch(() => {});
  };

  return new Promise((resolve, reject) => {
    const finishOk = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const finishErr = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    unsubscribe = window.electronAPI.onHttpApiStreamEvent((msg) => {
      if (!msg || msg.streamId !== streamId || settled) return;

      if (msg.type === 'http_error') {
        onAction?.({ type: 'hermes', label: 'Combat error', status: 'error' });
        finishErr(new Error(msg.body || `Combat error ${msg.statusCode || ''}`.trim()));
        return;
      }
      if (msg.type === 'error') {
        onAction?.({ type: 'hermes', label: 'Combat error', status: 'error' });
        finishErr(new Error(msg.error || 'Combat stream error'));
        return;
      }
      if (msg.type === 'end') {
        if (!gotDoneEvent) {
          onAction?.({ type: 'hermes', label: 'Connection lost', status: 'error' });
          finishErr(new Error(
            'The connection to Combat was lost before completion. Please try again.'
          ));
        } else {
          finishOk(cleanAssistantOutput(finalResponse || tokenAccumulator) || 'Done.');
        }
        return;
      }
      if (msg.type !== 'data' || !msg.data) return;

      let evt;
      try { evt = JSON.parse(msg.data); } catch { return; }

      if (evt.type === 'token') {
        tokenAccumulator += evt.content || '';
        onAction?.({ type: 'hermes_token', content: tokenAccumulator, status: 'streaming' });
      } else if (evt.type === 'tool_start') {
        onAction?.({ type: 'hermes', label: evt.label || `Using ${evt.tool}...`, status: 'running', plane: evt.plane || 'server' });
        _recordTrace('tool_start', { tool: evt.tool || '', plane: evt.plane || 'server' });
      } else if (evt.type === 'tool_call') {
        const { call_id, tool, args } = evt;
        const label = (tool || 'tool').replace(/_/g, ' ');
        onAction?.({ type: 'hermes', label: `Running ${label} on Mac...`, status: 'running', plane: evt.plane || 'device', fallback_from: evt.fallback_from, fallback_to: evt.fallback_to });
        _recordTrace('tool_dispatch', { tool, plane: evt.plane || 'device', fallback_from: evt.fallback_from || '', fallback_to: evt.fallback_to || '' });
        executeAndReportTool(call_id, tool, args, token).then(() => {
          onAction?.({ type: 'hermes', label: `${label} done`, status: 'done' });
        }).catch(() => {});
      } else if (evt.type === 'done') {
        gotDoneEvent = true;
        finalResponse = evt.response || tokenAccumulator;
        if (evt.session_id) {
          try { localStorage.setItem('noah_hermes_session', evt.session_id); } catch {}
        }
        onAction?.({ type: 'hermes', label: 'Combat done', status: 'done', plane: evt.plane || 'server' });
        _recordTrace('query_done', { plane: evt.plane || 'server', execution_profile: evt.execution_profile || '' });
      } else if (evt.type === 'error') {
        onAction?.({ type: 'hermes', label: 'Combat error', status: 'error' });
        finishErr(new Error(evt.message || 'Combat streaming error'));
      }
    });

    window.electronAPI.httpApiStreamStart({
      streamId,
      method: 'POST',
      url: `${baseUrl}/api/v1/hermes/chat`,
      headers: backendHeaders(token, { Accept: 'text/event-stream' }),
      body: payload,
      timeoutMs: isVoiceMode ? 120000 : 180000,
    }).then((started) => {
      if (!started?.ok) {
        finishErr(new Error(started?.error || 'Failed to start Combat stream'));
      }
    }).catch((err) => {
      finishErr(err);
    });
  });
}


// ─── Hermes backend query ─────────────────────────────────────────────────────

/**
 * Send a query to Noah's Hermes AI engine (backend-hosted, server-side tools).
 * Called when localStorage.noah_brain_mode === 'hermes'.
 *
 * The backend runs a full tool-calling loop (web search, shell, file ops, API calls)
 * using the Python Hermes engine and returns the final text response.
 *
 * When the backend needs to run a macOS-only tool (run_shell, run_applescript,
 * show_notification, open_url, open_path, write_file) it emits a `tool_call` SSE
 * event.  This function intercepts those events, executes the tool locally via
 * Electron IPC, and POSTs the result back so the backend can continue.
 */
export async function sendHermesQuery(transcript, screenBase64, token, onAction, history = [], options = {}) {
  if (!token) throw new Error('Combat requires a signed-in account. Please sign in and try again.');
  const isVoiceMode = !!options.voiceMode;

  const [sysInfo, integrations, capabilitySnapshot] = await Promise.all([
    getSystemInfo(),
    getFreshIntegrations(),
    getCapabilitySnapshot(token),
  ]);
  const system = buildSystemPrompt(!!screenBase64, sysInfo, integrations, capabilitySnapshot);

  let sessionId;
  try { sessionId = localStorage.getItem('noah_hermes_session') || undefined; } catch {}

  const payload = {
    message: screenBase64
      ? [
          { type: 'image_url', image_url: { url: screenBase64, detail: 'high' } },
          { type: 'text', text: transcript },
        ]
      : transcript,
    system_prompt: system,
    session_id: sessionId || undefined,
    model: isVoiceMode ? getHermesVoiceModel() : getHermesModel(),
    latency_mode: isVoiceMode ? 'realtime' : 'balanced',
    execution_profile: getExecutionProfile(),
    risk_level: getRiskLevel(),
    capability_snapshot: capabilitySnapshot,
    history: history
      .slice(isVoiceMode ? -4 : -8)
      .map(h => ({ role: h.role, content: typeof h.content === 'string' ? h.content : JSON.stringify(h.content) })),
  };
  const startedAt = Date.now();
  _recordTrace('query_start', {
    mode: 'hermes',
    voice: isVoiceMode,
    execution_profile: payload.execution_profile,
    risk_level: payload.risk_level,
    has_screen: !!screenBase64,
  });

  const postHermesJson = (reqBody, timeoutMs = 240000) => callBackendJson(NOAH_BACKEND_URL, '/api/v1/hermes/chat', {
    method: 'POST',
    token,
    body: reqBody,
    includeByok: true,
    timeoutMs,
  });

  // Packaged app loads on app://localhost. Browser fetch to HTTPS can fail CORS
  // preflight for custom BYOK headers, so prefer the main-process stream bridge.
  if (isElectron && window.electronAPI?.httpApiStreamStart) {
    let lastStreamErr = null;
    for (const candidate of backendCandidates()) {
      try {
        const result = await streamHermesViaElectron(payload, token, onAction, isVoiceMode, candidate);
        NOAH_BACKEND_URL = candidate;
        return result;
      } catch (err) {
        lastStreamErr = err;
        console.warn('[Noah] Electron Combat stream failed for', candidate, ':', err.message);
        if (!isRetryableBackendError(err)) break;
      }
    }
    console.warn('[Noah] Electron Combat stream failed, falling back:', lastStreamErr?.message);
    // Fall through to legacy fetch/json path below.
  }

  let resp;
  try {
    resp = await fetch(`${NOAH_BACKEND_URL}/api/v1/hermes/chat`, {
      method: 'POST',
      headers: backendHeaders(token, { Accept: 'text/event-stream' }),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(isVoiceMode ? 120000 : 180000),
    });
  } catch (err) {
    // Fallback for environments where SSE fetch is unavailable.
    try {
      const data = await postHermesJson(payload, isVoiceMode ? 120000 : 240000);
      onAction?.({ type: 'hermes', label: 'Combat done', status: 'done' });
      if (data?.session_id) {
        try { localStorage.setItem('noah_hermes_session', data.session_id); } catch {}
      }
      _metricInc('query_success_json_fallback');
      _metricInc(`first_response_bucket_${Math.min(60, Math.ceil((Date.now() - startedAt) / 1000))}s`);
      return cleanAssistantOutput(data?.response) || 'Done.';
    } catch (fallbackErr) {
      onAction?.({ type: 'hermes', label: 'Combat error', status: 'error' });
      _metricInc('query_failure');
      throw new Error(`Combat request failed: ${fallbackErr.message || err.message}`);
    }
  }

  if (!resp.ok) {
    const errBody = await resp.json().catch(() => ({}));
    if (resp.status === 504) {
      onAction?.({ type: 'hermes', label: 'Retrying with faster mode…', status: 'running' });
      try {
        const fastPayload = {
          ...payload,
          // Reduce context depth on retry to avoid gateway timeouts.
          history: (payload.history || []).slice(-3),
          // Fast fallback model for voice-like interactions.
          model: 'openai/gpt-4o-mini',
          latency_mode: 'realtime',
        };
        const data = await postHermesJson(fastPayload, 120000);
        if (data?.session_id) {
          try { localStorage.setItem('noah_hermes_session', data.session_id); } catch {}
        }
        onAction?.({ type: 'hermes', label: 'Combat done', status: 'done' });
        _metricInc('query_success_fast_retry');
        _metricInc(`first_response_bucket_${Math.min(60, Math.ceil((Date.now() - startedAt) / 1000))}s`);
        return cleanAssistantOutput(data?.response) || 'Done.';
      } catch {}
    }
    onAction?.({ type: 'hermes', label: 'Combat error', status: 'error' });
    _metricInc('query_failure_http');
    throw new Error(errBody.detail || `Combat error ${resp.status}`);
  }

  const contentType = resp.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    const data = await resp.json();
    onAction?.({ type: 'hermes', label: 'Combat done', status: 'done' });
    if (data.session_id) {
      try { localStorage.setItem('noah_hermes_session', data.session_id); } catch {}
    }
    return cleanAssistantOutput(data.response) || 'Done.';
  }

  // ── SSE reading with one-reconnect fallback ──────────────────────────────
  // If the SSE stream closes before we receive a `done` event (network hiccup,
  // proxy timeout, tab sleep) we attempt one silent reconnect with the same
  // payload. On reconnect the backend starts a fresh agent run for the same
  // session so the user sees a result rather than a silent blank response.
  // If the reconnect stream also drops without `done`, we surface a clear error.

  let finalResponse = '';
  let tokenAccumulator = '';
  const MAX_RECONNECTS = 1;
  let reconnectsUsed = 0;
  let currentResp = resp;

  while (true) {
    const reader = currentResp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let gotDoneEvent = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw) continue;

          let evt;
          try { evt = JSON.parse(raw); } catch { continue; }

          if (evt.type === 'token') {
            tokenAccumulator += evt.content || '';
            onAction?.({ type: 'hermes_token', content: tokenAccumulator, status: 'streaming' });

          } else if (evt.type === 'tool_start') {
            onAction?.({ type: 'hermes', label: evt.label || `Using ${evt.tool}...`, status: 'running', plane: evt.plane || 'server' });
            _recordTrace('tool_start', { tool: evt.tool || '', plane: evt.plane || 'server' });

          } else if (evt.type === 'tool_call') {
            // The backend is delegating a macOS-specific tool to the desktop app.
            // Execute it locally via Electron IPC and POST the result back so the
            // backend can resume the Hermes tool-calling loop.
            const { call_id, tool, args } = evt;
            const label = tool.replace(/_/g, ' ');
            onAction?.({ type: 'hermes', label: `Running ${label} on Mac...`, status: 'running', plane: evt.plane || 'device', fallback_from: evt.fallback_from, fallback_to: evt.fallback_to });
            _recordTrace('tool_dispatch', { tool, plane: evt.plane || 'device', fallback_from: evt.fallback_from || '', fallback_to: evt.fallback_to || '' });
            // Fire-and-forget: do NOT await — we must keep reading the SSE stream
            // while executeAndReportTool runs concurrently.
            executeAndReportTool(call_id, tool, args, token).then(() => {
              onAction?.({ type: 'hermes', label: `${label} done`, status: 'done' });
            }).catch(() => {});

          } else if (evt.type === 'done') {
            gotDoneEvent = true;
            finalResponse = evt.response || tokenAccumulator;
            if (evt.session_id) {
              try { localStorage.setItem('noah_hermes_session', evt.session_id); } catch {}
            }
            onAction?.({ type: 'hermes', label: 'Combat done', status: 'done' });
            _recordTrace('query_done', { plane: evt.plane || 'server', execution_profile: evt.execution_profile || '' });

          } else if (evt.type === 'error') {
            onAction?.({ type: 'hermes', label: 'Combat error', status: 'error' });
            throw new Error(evt.message || 'Combat streaming error');
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Stream closed cleanly with a done event — all good.
    if (gotDoneEvent) break;

    // Stream closed without a done event — the connection was dropped.
    if (reconnectsUsed >= MAX_RECONNECTS) {
      // We have already tried to reconnect once; surface a clear error.
      onAction?.({ type: 'hermes', label: 'Connection lost', status: 'error' });
      throw new Error(
        'The connection to Combat was lost and could not be re-established. ' +
        'Please check your network and try again.'
      );
    }

    // Attempt one reconnect with the same payload.
    reconnectsUsed += 1;
    onAction?.({ type: 'hermes', label: 'Reconnecting…', status: 'running' });
    console.warn('[Noah] Combat SSE dropped without done event — reconnecting (attempt', reconnectsUsed, ')');

    try {
      currentResp = await fetch(`${NOAH_BACKEND_URL}/api/v1/hermes/chat`, {
        method: 'POST',
        headers: backendHeaders(token, { Accept: 'text/event-stream' }),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(isVoiceMode ? 120000 : 180000),
      });
    } catch (err) {
      onAction?.({ type: 'hermes', label: 'Reconnect failed', status: 'error' });
      throw new Error(`Combat reconnect failed: ${err.message}`);
    }

    if (!currentResp.ok) {
      const errBody = await currentResp.json().catch(() => ({}));
      onAction?.({ type: 'hermes', label: 'Reconnect failed', status: 'error' });
      throw new Error(errBody.detail || `Combat reconnect error ${currentResp.status}`);
    }

    // Reset accumulators for the fresh stream; the backend will re-run the agent.
    tokenAccumulator = '';
    finalResponse = '';
  }

  _metricInc('query_success_stream');
  _metricInc(`first_response_bucket_${Math.min(60, Math.ceil((Date.now() - startedAt) / 1000))}s`);
  return cleanAssistantOutput(finalResponse || tokenAccumulator) || 'Done.';
}

// ─── Hermes status check ──────────────────────────────────────────────────────


// ─── Hermes session history ───────────────────────────────────────────────────

/**
 * Fetch the list of past Hermes sessions for the current user.
 * Returns { sessions: [...] } or throws on error.
 */
export async function getHermesSessions(token) {
  if (!token) throw new Error('Authentication required');
  return callBackendJson(NOAH_BACKEND_URL, '/api/v1/hermes/sessions', {
    method: 'GET',
    token,
    includeByok: true,
  });
}

/**
 * Fetch the full message history for a specific Hermes session.
 * Returns { session_id, messages: [{role, content}] } or throws on error.
 */
export async function getHermesSessionHistory(sessionId, token) {
  if (!token) throw new Error('Authentication required');
  return callBackendJson(NOAH_BACKEND_URL, `/api/v1/hermes/sessions/${encodeURIComponent(sessionId)}/history`, {
    method: 'GET',
    token,
    includeByok: true,
  });
}

// ─── Main query ───────────────────────────────────────────────────────────────

// history: array of { role: 'user'|'assistant', content: string } from previous turns
export async function sendVoiceQuery(transcript, screenBase64, token, onAction, history = [], options = {}) {
  if (!screenBase64 && isScreenInspectionQuestion(transcript)) {
    throw new Error('Screen Watch is enabled but no screenshot was captured. Check Screen Recording permission for Noah and try again.');
  }

  if (isDelegationRequest(transcript)) {
    if (!token) throw new Error('Sign in is required to deploy workers.');
    const delegatedArgs = buildDelegationArgsFromTranscript(transcript);
    onAction?.({ type: 'delegate_task', label: `Delegating to ${delegatedArgs.role} worker...`, status: 'running', plane: 'server' });
    const delegated = await runVirtualDelegation(delegatedArgs, token);
    if (!delegated?.success) {
      onAction?.({ type: 'delegate_task', label: 'Worker delegation failed', status: 'error', plane: 'server' });
      throw new Error(delegated?.error || 'Worker delegation failed.');
    }
    onAction?.({ type: 'delegate_task', label: 'Worker delegation completed', status: 'done', plane: 'server' });
    return formatDelegationResultText(delegated, 'Delegated task completed.');
  }

  if (screenBase64 && isScreenInspectionQuestion(transcript)) {
    try {
      onAction?.({ type: 'vision', label: 'Inspecting screen...', status: 'running', plane: 'device' });
      const result = await analyzeScreenshot(screenBase64, token, transcript);
      onAction?.({ type: 'vision', label: 'Screen inspected', status: 'done', plane: 'device' });
      return result.insight;
    } catch (err) {
      console.warn('[Noah] Direct screen inspection failed, falling back to chat path:', err.message);
      onAction?.({ type: 'vision', label: 'Screen inspection fallback', status: 'error', plane: 'device' });
    }
  }

  if (isGoogleWorkspaceRequest(transcript)) {
    return await handleDirectGoogleWorkspaceRequest(transcript, onAction);
  }

  // ── Hermes brain mode: route to backend Hermes engine ──────────────────────
  const brainMode = await getHermesBrainMode();
  if (brainMode === 'hermes') {
    try {
      return await sendHermesQuery(transcript, screenBase64, token, onAction, history, options);
    } catch (err) {
      console.error('[Noah] Combat query failed:', err.message);
      // If Hermes fails, fall back to classic mode with a helpful error message
      onAction?.({ type: 'hermes', label: 'Combat error', status: 'error' });
      throw new Error(`Combat unavailable: ${err.message}. Please check your network connection or try switching back to Classic mode.`);
    }
  }

  const key = getOpenAIKey();
  if (!key) throw new Error('OpenAI API key not configured. Go to Settings → API Keys.');

  const [sysInfo, integrations] = await Promise.all([
    getSystemInfo(),
    getFreshIntegrations(),
  ]);

  const hasScreen = !!screenBase64;
  const messages  = [{ role: 'system', content: buildSystemPrompt(hasScreen, sysInfo, integrations, null) }];

  // Inject recent conversation history (last 20 turns max) so Noah has multi-turn context
  const recentHistory = history.slice(-20);
  for (const h of recentHistory) {
    // History entries may have string or array content — pass as-is
    messages.push({ role: h.role, content: h.content });
  }

  // Current user message (with optional screenshot)
  if (hasScreen) {
    messages.push({ role: 'user', content: [
      { type: 'image_url', image_url: { url: screenBase64, detail: 'high' } },
      { type: 'text', text: transcript },
    ]});
  } else {
    messages.push({ role: 'user', content: transcript });
  }

  let iterations  = 0;
  let refusalRetry = false; // allow one retry after a refusal
  let skillsRetry = false;  // force skill inventory tool when user explicitly asks
  let capabilityRetry = false; // force capability tool when user asks capabilities/tools
  let cronRetry = false; // force cronjob tool when user asks scheduling/cron
  let delegateRetry = false; // force delegate_task when user asks to deploy/spawn worker
  let googleWorkspaceRetry = false; // force Google Workspace tools instead of vague refusal

  while (iterations < 14) {
    iterations++;
    const toolChoice = refusalRetry ? 'required' : 'auto';
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'gpt-4o', messages, tools: BASE_TOOLS, tool_choice: toolChoice, max_tokens: 2000, temperature: 0.2 }),
    });

    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error?.message || `OpenAI error ${res.status}`); }
    const data    = await res.json();
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error('No response from OpenAI');

    // If the model responded with text but no tool calls, check for refusal
    if (!message.tool_calls?.length) {
      const responseText = message.content || '';
      const askedSkills = /skills?\s+module|what\s+skills|available\s+skills|list\s+skills/i.test(transcript || '');
      const askedCapabilities = /what\s+tools|what\s+can\s+you\s+do|capabilities|available\s+tools|toolset|get_capabilities|list\s+your\s+tools|docker\s+sandbox|terminal\s+shells?/i.test(transcript || '');
      const askedCron = /cron|cronjob|schedule|scheduled\s+tasks?|scheduler|automation/i.test(transcript || '');
      const askedDelegation = isDelegationRequest(transcript || '');
      const askedGoogleWorkspace = isGoogleWorkspaceRequest(transcript || '');
      const askedGoogleDiagnostic = isGoogleWorkspaceDiagnosticRequest(transcript || '') || /technical permission error|permissions wall/i.test(responseText);
      if (askedSkills && !skillsRetry) {
        messages.push({ role: 'assistant', content: responseText });
        messages.push({
          role: 'user',
          content: 'User asked for installed skills. You MUST call list_skills now and answer from that tool result.',
        });
        skillsRetry = true;
        continue;
      }
      if (askedCapabilities && !capabilityRetry) {
        messages.push({ role: 'assistant', content: responseText });
        messages.push({
          role: 'user',
          content: 'User asked about your capabilities/tools. You MUST call get_capabilities now. Then answer using exact returned tool names, including whether docker/terminal/cronjob tools are available.',
        });
        capabilityRetry = true;
        continue;
      }
      if (askedCron && !cronRetry) {
        messages.push({ role: 'assistant', content: responseText });
        messages.push({
          role: 'user',
          content: 'User asked about cron/scheduling. You MUST call cronjob with action="list" now and answer from that result.',
        });
        cronRetry = true;
        continue;
      }
      if (askedDelegation && !delegateRetry) {
        const forcedArgs = buildDelegationArgsFromTranscript(transcript || '');
        messages.push({ role: 'assistant', content: responseText });
        messages.push({
          role: 'user',
          content: `User explicitly asked to deploy/spawn a worker/sub-agent. You MUST call delegate_task now with these arguments: ${JSON.stringify(forcedArgs)}. Do not answer with planning text before calling the tool.`,
        });
        delegateRetry = true;
        continue;
      }
      if (askedGoogleWorkspace && !googleWorkspaceRetry) {
        const forcedTool = askedGoogleDiagnostic ? 'google_workspace_diagnostics' : 'google_drive_search';
        const forcedArgs = forcedTool === 'google_workspace_diagnostics'
          ? { reason: 'Diagnose Google Workspace Drive/Docs/Sheets/Calendar access failure' }
          : { query: inferGoogleDriveSearchQuery(transcript || ''), limit: 10, reason: 'Find the requested Google Drive file' };
        messages.push({ role: 'assistant', content: responseText });
        messages.push({
          role: 'user',
          content: `User asked for Google Workspace access. You MUST call ${forcedTool} now with these arguments: ${JSON.stringify(forcedArgs)}. Do not claim missing access before the tool result. If the tool fails, report the exact tool error and next_action.`,
        });
        googleWorkspaceRetry = true;
        continue;
      }
      if (askedDelegation && delegateRetry) {
        if (!token) throw new Error('Sign in is required to deploy workers.');
        const delegatedArgs = buildDelegationArgsFromTranscript(transcript || '');
        onAction?.({ type: 'delegate_task', label: `Delegating to ${delegatedArgs.role} worker...`, status: 'running', plane: 'server' });
        const delegated = await runVirtualDelegation(delegatedArgs, token);
        if (!delegated?.success) {
          onAction?.({ type: 'delegate_task', label: 'Worker delegation failed', status: 'error', plane: 'server' });
          throw new Error(delegated?.error || 'Worker delegation failed.');
        }
        onAction?.({ type: 'delegate_task', label: 'Worker delegation completed', status: 'done', plane: 'server' });
        return formatDelegationResultText(delegated, 'Delegated task completed.');
      }
      if (!refusalRetry && isRefusal(responseText)) {
        // Push the refusal response then inject a correction before retrying
        messages.push({ role: 'assistant', content: responseText });
        messages.push({ role: 'user', content: 'You refused to help but that is not allowed. You have search_web and fetch_webpage tools. Use them NOW to find the answer. Do not explain — just call the tools.' });
        refusalRetry = true;
        continue;
      }
      return cleanAssistantOutput(responseText) || 'Done.';
    }

    refusalRetry = false; // successfully calling tools, reset
    skillsRetry = false;
    capabilityRetry = false;
    cronRetry = false;
    delegateRetry = false;
    googleWorkspaceRetry = false;

    messages.push({ role: 'assistant', content: message.content || null, tool_calls: message.tool_calls });

    for (const tc of message.tool_calls) {
      const { name, arguments: argsStr } = tc.function;
      let args;
      try { args = JSON.parse(argsStr); } catch { args = {}; }
      if (name === 'delegate_task' && !isDelegationRequest(transcript || '')) {
        const result = failureEnvelope(TOOL_ERROR_CODES.UNKNOWN, 'Worker deployment is allowed only when explicitly requested by the user.', {
          plane: 'server',
          recoverable: true,
          nextAction: 'Ask the user to explicitly request deploy/spawn/create worker.',
        });
        onAction?.({ type: name, label: 'Blocked implicit worker deployment', status: 'error', result });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 10000) });
        continue;
      }
      const label = name === 'save_memory'
        ? `Saving: ${args.fact || 'memory'}`
        : (args.reason || args.query || args.url || name.replace(/_/g, ' '));
      onAction?.({ type: name, label, status: 'running' });
      const result = await executeTool(name, args, token);
      onAction?.({ type: name, label, status: result.error ? 'error' : 'done', result });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 10000) });
      if ((name.startsWith('google_') || name === 'api_call') && result?.success === false) {
        messages.push({
          role: 'user',
          content: `The Google tool failed. You MUST tell the user this exact error and next action, without vague wording: ${JSON.stringify({
            tool: name,
            error: result.error,
            error_code: result.error_code,
            next_action: result.next_action,
          })}`,
        });
      }
    }
  }
  return 'Task complete.';
}

// ─── Skill management ─────────────────────────────────────────────────────────

export async function listSkills(token) {
  return callBackendJson(NOAH_BACKEND_URL, '/api/v1/hermes/skills', {
    method: 'GET',
    token,
    includeByok: true,
    timeoutMs: 60000,
  });
}

export async function getSkill(slug, token) {
  return callBackendJson(NOAH_BACKEND_URL, `/api/v1/hermes/skills/${encodeURIComponent(slug)}`, {
    method: 'GET',
    token,
    includeByok: true,
    timeoutMs: 60000,
  });
}

export async function installSkill(content, scope = 'user', token) {
  return callBackendJson(NOAH_BACKEND_URL, '/api/v1/hermes/skills/install', {
    method: 'POST',
    token,
    includeByok: true,
    timeoutMs: 60000,
    body: { content, scope },
  });
}

export async function deleteSkill(slug, token) {
  return callBackendJson(NOAH_BACKEND_URL, `/api/v1/hermes/skills/${encodeURIComponent(slug)}`, {
    method: 'DELETE',
    token,
    includeByok: true,
    timeoutMs: 60000,
  });
}

export async function getBackendMemories(token, { limit = 5000, offset = 0 } = {}) {
  try {
    const rows = await callBackendJson(NOAH_BACKEND_URL, `/v3/memories?limit=${Math.max(1, Math.min(5000, Number(limit || 5000)))}&offset=${Math.max(0, Number(offset || 0))}`, {
      method: 'GET',
      token,
      includeByok: true,
      timeoutMs: 60000,
    });
    return mergeMemoryRows(rows);
  } catch (err) {
    return localMemoryRows();
  }
}

export async function createBackendMemory(content, token) {
  const trimmed = String(content || '').trim();
  try {
    return await callBackendJson(NOAH_BACKEND_URL, '/v3/memories', {
      method: 'POST',
      token,
      includeByok: true,
      timeoutMs: 60000,
      body: { content: trimmed, category: 'manual', visibility: 'private' },
    });
  } catch (err) {
    addMemory(trimmed);
    const local = getAllMemories()[0] || {};
    return {
      id: local.id || `local_${Date.now()}`,
      content: trimmed,
      created_at: local.created_at || Date.now(),
      source: 'local_fallback',
      sync_status: 'pending_backend',
    };
  }
}

export async function deleteBackendMemory(memoryId, token) {
  return callBackendJson(NOAH_BACKEND_URL, `/v3/memories/${encodeURIComponent(memoryId)}`, {
    method: 'DELETE',
    token,
    includeByok: true,
    timeoutMs: 60000,
  });
}

export async function updateBackendMemory(memoryId, value, token) {
  return callBackendJson(NOAH_BACKEND_URL, `/v3/memories/${encodeURIComponent(memoryId)}?value=${encodeURIComponent(value)}`, {
    method: 'PATCH',
    token,
    includeByok: true,
    timeoutMs: 60000,
  });
}

export async function createWorkerAgent(payload, token) {
  return callBackendJson(NOAH_BACKEND_URL, '/api/v1/hermes/workers', {
    method: 'POST',
    token,
    includeByok: true,
    timeoutMs: 60000,
    body: payload,
  });
}

export async function listWorkerAgents(token) {
  return callBackendJson(NOAH_BACKEND_URL, '/api/v1/hermes/workers', {
    method: 'GET',
    token,
    includeByok: true,
    timeoutMs: 60000,
  });
}

export async function getWorkerAgent(workerId, token) {
  return callBackendJson(NOAH_BACKEND_URL, `/api/v1/hermes/workers/${encodeURIComponent(workerId)}`, {
    method: 'GET',
    token,
    includeByok: true,
    timeoutMs: 60000,
  });
}

export async function updateWorkerAgent(workerId, payload, token) {
  return callBackendJson(NOAH_BACKEND_URL, `/api/v1/hermes/workers/${encodeURIComponent(workerId)}`, {
    method: 'PATCH',
    token,
    includeByok: true,
    timeoutMs: 60000,
    body: payload,
  });
}

export async function deleteWorkerAgent(workerId, token) {
  return callBackendJson(NOAH_BACKEND_URL, `/api/v1/hermes/workers/${encodeURIComponent(workerId)}`, {
    method: 'DELETE',
    token,
    includeByok: true,
    timeoutMs: 60000,
  });
}

export async function runWorkerAgent(workerId, payload, token) {
  return callBackendJson(NOAH_BACKEND_URL, `/api/v1/hermes/workers/${encodeURIComponent(workerId)}/run`, {
    method: 'POST',
    token,
    includeByok: true,
    timeoutMs: 120000,
    body: payload,
  });
}

export async function getWorkerAgentStatus(workerId, token) {
  return callBackendJson(NOAH_BACKEND_URL, `/api/v1/hermes/workers/${encodeURIComponent(workerId)}/status`, {
    method: 'GET',
    token,
    includeByok: true,
    timeoutMs: 60000,
  });
}

export async function getWorkerAgentResult(workerId, token) {
  return callBackendJson(NOAH_BACKEND_URL, `/api/v1/hermes/workers/${encodeURIComponent(workerId)}/result`, {
    method: 'GET',
    token,
    includeByok: true,
    timeoutMs: 60000,
  });
}

export async function getWorkerMemories(workerId, token) {
  return callBackendJson(NOAH_BACKEND_URL, `/api/v1/hermes/workers/${encodeURIComponent(workerId)}/memories`, {
    method: 'GET',
    token,
    includeByok: true,
    timeoutMs: 60000,
  });
}

export async function addWorkerMemory(workerId, payload, token) {
  return callBackendJson(NOAH_BACKEND_URL, `/api/v1/hermes/workers/${encodeURIComponent(workerId)}/memories`, {
    method: 'POST',
    token,
    includeByok: true,
    timeoutMs: 60000,
    body: payload,
  });
}

// ─── Screen analysis ──────────────────────────────────────────────────────────

export async function analyzeScreenshot(base64Image, token, userContext = '') {
  const key    = getOpenAIKey();
  if (!key) throw new Error('OpenAI API key not configured');
  const custom   = getSystemInstructions().trim();
  const memories = buildMemoryContext();

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: `You are Noah, a deeply personal AI desktop assistant with vision. ${memories ? memories + '\n\n' : ''}${custom ? `User instructions: ${custom}. ` : ''}You are looking at the user's actual screen. Describe what you see accurately and offer a helpful next step. Keep it to 2-3 natural spoken sentences. Never use markdown. No asterisks, no bullet points, no hashtags. Speak plainly like a real person.` },
        { role: 'user', content: [
          { type: 'image_url', image_url: { url: base64Image, detail: 'high' } },
          { type: 'text', text: userContext || 'What do you see on my screen?' },
        ]},
      ],
      max_tokens: 400,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data?.error?.message || data?.detail || `Vision request failed (${res.status})`;
    throw new Error(detail);
  }
  const insight = cleanAssistantOutput(data?.choices?.[0]?.message?.content || '');
  if (!insight) {
    throw new Error('Vision returned empty response');
  }
  return { insight };
}
