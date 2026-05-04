import { getOpenAIKey, getDeepgramKey, getOpenRouterKey, getSystemInstructions, getIntegrations } from './keys';
import { buildMemoryContext, addMemory } from './memory';

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

async function callBackendJson(base, path, { method = 'GET', token = null, body = null, includeByok = false, accept = 'application/json', timeoutMs = 20000 } = {}) {
  const url = `${base}${path}`;
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

function getHermesVoiceModel() {
  try {
    return localStorage.getItem('noah_hermes_voice_model') || 'openai/gpt-4o-mini';
  } catch {
    return 'openai/gpt-4o-mini';
  }
}

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

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
    description: 'Run AppleScript to control macOS apps. Use for: Safari/Chrome (open URLs, click), Mail, Messages, Calendar, Reminders, Notes, Finder, Spotify, Music. This lets you actually DO things in apps — fill forms, send emails, create events.',
    parameters: { type: 'object', properties: {
      script: { type: 'string', description: 'Valid AppleScript code' },
      reason: { type: 'string', description: 'Brief label' },
    }, required: ['script', 'reason'] },
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

async function executeTool(name, args) {
  // save_memory runs client-side in any context — no IPC needed
  if (name === 'save_memory') {
    if (args.fact?.trim()) addMemory(args.fact.trim());
    return { success: true, saved: args.fact };
  }

  if (!isElectron) {
    if (name === 'search_web') return await duckduckgoSearch(args.query);
    return { note: 'Full tool execution requires the desktop Electron app.' };
  }
  try {
    switch (name) {
      case 'terminal':        return await window.electronAPI.runShell(args.command);
      case 'run_applescript': return await window.electronAPI.runApplescript(args.script);
      case 'read_file':       return await window.electronAPI.readFile(args.path);
      case 'write_file':      return await window.electronAPI.writeFile(args.path, args.content);
      case 'list_directory':  return await window.electronAPI.listDirectory(args.path);
      case 'show_notification': await window.electronAPI.showNotification(args.title, args.body); return { success: true };
      case 'fetch_webpage':   return await window.electronAPI.fetchUrl(args.url);
      case 'open_url':        await window.electronAPI.openExternal(args.url); return { success: true, output: `Opened ${args.url}` };
      case 'open_path':       return await window.electronAPI.openPath(args.path);
      case 'search_web':      return await searchWeb(args.query);
      case 'api_call':        return await window.electronAPI.httpApiCall({ method: args.method, url: args.url, headers: args.headers || {}, body: args.body || null });
      default:                return { error: `Unknown tool: ${name}` };
    }
  } catch (err) { return { error: err.message }; }
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
  terminal:    'Terminal (use run_shell for all command-line tasks)',
};

function buildSystemPrompt(hasScreen, sysInfo, integrations) {
  const custom   = getSystemInstructions().trim();
  const memories = buildMemoryContext();

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
  if (integrations.google_token)                 integLines.push(`- Google: api_call to googleapis.com with "Authorization: Bearer ${integrations.google_token}"`);
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
${hasScreen ? '- A screenshot is attached for this turn.' : ''}

Execution policy:
1. If the user asks for facts that may change (prices, flights, weather, news, availability), use search_web, then fetch_webpage before answering.
2. If the user asks you to perform an action, execute it with tools instead of only giving instructions.
3. If the user shares personal preferences/facts, call save_memory with concise facts.
4. Use only the tools that are needed; do not call tools for simple chit-chat.
5. For macOS app tasks, use run_applescript first. If needed, use System Events UI scripting or terminal/osascript for automation.
6. Do not say "I can only open the app". Attempt control steps first, then report what succeeded/failed.

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
const APPROVAL_TOOLS = new Set(['terminal', 'write_file', 'run_applescript']);

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
    if (APPROVAL_TOOLS.has(toolName) && getRequireToolApproval() && _approvalRequester) {
      let approved = false;
      try {
        approved = await _approvalRequester({ toolName, args });
      } catch {
        approved = false;
      }
      if (!approved) {
        result = { error: 'User cancelled — operation was not approved.' };
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
    }
    // ─────────────────────────────────────────────────────────────────────────

    try {
      result = await executeTool(toolName, args);
    } catch (err) {
      result = { error: err.message || String(err) };
    }
  }

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
  if (!token) throw new Error('Hermes requires a signed-in account. Please sign in and try again.');
  const isVoiceMode = !!options.voiceMode;

  const [sysInfo, integrations] = await Promise.all([
    getSystemInfo(),
    Promise.resolve(getIntegrations()),
  ]);
  const system = buildSystemPrompt(!!screenBase64, sysInfo, integrations);

  let sessionId;
  try { sessionId = localStorage.getItem('noah_hermes_session') || undefined; } catch {}

  const payload = {
    message: transcript,
    system_prompt: system,
    session_id: sessionId || undefined,
    model: isVoiceMode ? getHermesVoiceModel() : getHermesModel(),
    latency_mode: isVoiceMode ? 'realtime' : 'balanced',
    history: history
      .slice(isVoiceMode ? -4 : -8)
      .map(h => ({ role: h.role, content: typeof h.content === 'string' ? h.content : JSON.stringify(h.content) })),
  };

  const postHermesJson = (reqBody, timeoutMs = 240000) => callBackendJson(NOAH_BACKEND_URL, '/api/v1/hermes/chat', {
    method: 'POST',
    token,
    body: reqBody,
    includeByok: true,
    timeoutMs,
  });

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
      onAction?.({ type: 'hermes', label: 'Hermes done', status: 'done' });
      if (data?.session_id) {
        try { localStorage.setItem('noah_hermes_session', data.session_id); } catch {}
      }
      return cleanAssistantOutput(data?.response) || 'Done.';
    } catch (fallbackErr) {
      onAction?.({ type: 'hermes', label: 'Hermes error', status: 'error' });
      throw new Error(`Hermes request failed: ${fallbackErr.message || err.message}`);
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
        onAction?.({ type: 'hermes', label: 'Hermes done', status: 'done' });
        return cleanAssistantOutput(data?.response) || 'Done.';
      } catch {}
    }
    onAction?.({ type: 'hermes', label: 'Hermes error', status: 'error' });
    throw new Error(errBody.detail || `Hermes error ${resp.status}`);
  }

  const contentType = resp.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    const data = await resp.json();
    onAction?.({ type: 'hermes', label: 'Hermes done', status: 'done' });
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
            onAction?.({ type: 'hermes', label: evt.label || `Using ${evt.tool}…`, status: 'running' });

          } else if (evt.type === 'tool_call') {
            // The backend is delegating a macOS-specific tool to the desktop app.
            // Execute it locally via Electron IPC and POST the result back so the
            // backend can resume the Hermes tool-calling loop.
            const { call_id, tool, args } = evt;
            const label = tool.replace(/_/g, ' ');
            onAction?.({ type: 'hermes', label: `Running ${label} on Mac…`, status: 'running' });
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
            onAction?.({ type: 'hermes', label: 'Hermes done', status: 'done' });

          } else if (evt.type === 'error') {
            onAction?.({ type: 'hermes', label: 'Hermes error', status: 'error' });
            throw new Error(evt.message || 'Hermes streaming error');
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
        'The connection to Hermes was lost and could not be re-established. ' +
        'Please check your network and try again.'
      );
    }

    // Attempt one reconnect with the same payload.
    reconnectsUsed += 1;
    onAction?.({ type: 'hermes', label: 'Reconnecting…', status: 'running' });
    console.warn('[Noah] Hermes SSE dropped without done event — reconnecting (attempt', reconnectsUsed, ')');

    try {
      currentResp = await fetch(`${NOAH_BACKEND_URL}/api/v1/hermes/chat`, {
        method: 'POST',
        headers: backendHeaders(token, { Accept: 'text/event-stream' }),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(isVoiceMode ? 120000 : 180000),
      });
    } catch (err) {
      onAction?.({ type: 'hermes', label: 'Reconnect failed', status: 'error' });
      throw new Error(`Hermes reconnect failed: ${err.message}`);
    }

    if (!currentResp.ok) {
      const errBody = await currentResp.json().catch(() => ({}));
      onAction?.({ type: 'hermes', label: 'Reconnect failed', status: 'error' });
      throw new Error(errBody.detail || `Hermes reconnect error ${currentResp.status}`);
    }

    // Reset accumulators for the fresh stream; the backend will re-run the agent.
    tokenAccumulator = '';
    finalResponse = '';
  }

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
  // ── Hermes brain mode: route to backend Hermes engine ──────────────────────
  const brainMode = await getHermesBrainMode();
  if (brainMode === 'hermes') {
    try {
      return await sendHermesQuery(transcript, screenBase64, token, onAction, history, options);
    } catch (err) {
      console.error('[Noah] Hermes query failed:', err.message);
      // If Hermes fails, fall back to classic mode with a helpful error message
      onAction?.({ type: 'hermes', label: 'Hermes error', status: 'error' });
      throw new Error(`Hermes unavailable: ${err.message}. Please check your network connection or try switching back to Classic mode.`);
    }
  }

  const key = getOpenAIKey();
  if (!key) throw new Error('OpenAI API key not configured. Go to Settings → API Keys.');

  const [sysInfo, integrations] = await Promise.all([
    getSystemInfo(),
    Promise.resolve(getIntegrations()),
  ]);

  const hasScreen = !!screenBase64;
  const messages  = [{ role: 'system', content: buildSystemPrompt(hasScreen, sysInfo, integrations) }];

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

    messages.push({ role: 'assistant', content: message.content || null, tool_calls: message.tool_calls });

    for (const tc of message.tool_calls) {
      const { name, arguments: argsStr } = tc.function;
      let args;
      try { args = JSON.parse(argsStr); } catch { args = {}; }
      const label = name === 'save_memory'
        ? `Saving: ${args.fact || 'memory'}`
        : (args.reason || args.query || args.url || name.replace(/_/g, ' '));
      onAction?.({ type: name, label, status: 'running' });
      const result = await executeTool(name, args);
      onAction?.({ type: name, label, status: result.error ? 'error' : 'done', result });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 10000) });
    }
  }
  return 'Task complete.';
}

// ─── Skill management ─────────────────────────────────────────────────────────

export async function listSkills(token) {
  const resp = await fetch(`${NOAH_BACKEND_URL}/api/v1/hermes/skills`, {
    headers: backendHeaders(token),
  });
  if (!resp.ok) throw new Error(`Failed to list skills: ${resp.status}`);
  return resp.json();
}

export async function getSkill(slug, token) {
  const resp = await fetch(`${NOAH_BACKEND_URL}/api/v1/hermes/skills/${encodeURIComponent(slug)}`, {
    headers: backendHeaders(token),
  });
  if (!resp.ok) throw new Error(`Failed to get skill: ${resp.status}`);
  return resp.json();
}

export async function installSkill(content, scope = 'user', token) {
  const resp = await fetch(`${NOAH_BACKEND_URL}/api/v1/hermes/skills/install`, {
    method: 'POST',
    headers: backendHeaders(token),
    body: JSON.stringify({ content, scope }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.detail || `Install failed: ${resp.status}`);
  }
  return resp.json();
}

export async function deleteSkill(slug, token) {
  const resp = await fetch(`${NOAH_BACKEND_URL}/api/v1/hermes/skills/${encodeURIComponent(slug)}`, {
    method: 'DELETE',
    headers: backendHeaders(token),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.detail || `Delete failed: ${resp.status}`);
  }
  return resp.json();
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
  const data = await res.json();
  return { insight: cleanAssistantOutput(data.choices?.[0]?.message?.content) || 'Could not analyze screen.' };
}
