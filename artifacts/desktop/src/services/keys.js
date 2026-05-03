// Resolves API keys from:
// 1. localStorage (user-configured via Settings UI)
// 2. Electron IPC (main process env / Replit secrets)
// 3. Vite env vars (injected from .env)

const LS_OPENAI        = 'noah_openai_key';
const LS_DEEPGRAM      = 'noah_deepgram_key';
const LS_OPENROUTER    = 'noah_openrouter_key';
const LS_VOICE         = 'noah_voice_model';
const LS_SYSTEM_PROMPT = 'noah_system_instructions';

// Integration tokens
const LS_INTEGRATIONS  = 'noah_integrations'; // JSON object

let _openai      = null;
let _deepgram    = null;
let _openrouter  = null;
let _loaded      = false;

async function loadKeys() {
  if (_loaded) return;
  _loaded = true;

  try {
    const lsOpenai     = localStorage.getItem(LS_OPENAI)?.trim();
    const lsDeepgram   = localStorage.getItem(LS_DEEPGRAM)?.trim();
    const lsOpenrouter = localStorage.getItem(LS_OPENROUTER)?.trim();
    if (lsOpenai)     _openai     = lsOpenai;
    if (lsDeepgram)   _deepgram   = lsDeepgram;
    if (lsOpenrouter) _openrouter = lsOpenrouter;
  } catch {}

  if (typeof window !== 'undefined' && window.electronAPI?.getApiKeys) {
    try {
      const keys = await window.electronAPI.getApiKeys();
      if (!_openai   && keys.openai)   _openai   = keys.openai;
      if (!_deepgram && keys.deepgram) _deepgram = keys.deepgram;
    } catch (e) {
      console.warn('Could not load keys from Electron IPC:', e);
    }
  }

  if (!_openai)     _openai     = import.meta.env.VITE_OPENAI_API_KEY   || '';
  if (!_deepgram)   _deepgram   = import.meta.env.VITE_DEEPGRAM_API_KEY || '';
  if (!_openrouter) _openrouter = import.meta.env.VITE_OPENROUTER_API_KEY || '';
}

loadKeys();

export function getOpenAIKey() {
  try { const k = localStorage.getItem(LS_OPENAI)?.trim(); if (k) return k; } catch {}
  return _openai || import.meta.env.VITE_OPENAI_API_KEY || '';
}

export function getDeepgramKey() {
  try { const k = localStorage.getItem(LS_DEEPGRAM)?.trim(); if (k) return k; } catch {}
  return _deepgram || import.meta.env.VITE_DEEPGRAM_API_KEY || '';
}

export function getVoiceModel() {
  try { return localStorage.getItem(LS_VOICE) || 'aura-asteria-en'; } catch {}
  return 'aura-asteria-en';
}

export function saveVoiceModel(model) {
  try { localStorage.setItem(LS_VOICE, model); } catch {}
}

export function getSystemInstructions() {
  try { return localStorage.getItem(LS_SYSTEM_PROMPT) || ''; } catch {}
  return '';
}

export function saveSystemInstructions(text) {
  try { localStorage.setItem(LS_SYSTEM_PROMPT, text); } catch {}
}

export function getOpenRouterKey() {
  try { const k = localStorage.getItem(LS_OPENROUTER)?.trim(); if (k) return k; } catch {}
  return _openrouter || import.meta.env.VITE_OPENROUTER_API_KEY || '';
}

export function hasOpenAIKey()      { return !!getOpenAIKey(); }
export function hasDeepgramKey()    { return !!getDeepgramKey(); }
export function hasOpenRouterKey()  { return !!getOpenRouterKey(); }

export function saveOpenAIKey(key) {
  try { localStorage.setItem(LS_OPENAI, key.trim()); _openai = key.trim(); _loaded = false; loadKeys(); } catch {}
}

export function saveDeepgramKey(key) {
  try { localStorage.setItem(LS_DEEPGRAM, key.trim()); _deepgram = key.trim(); _loaded = false; loadKeys(); } catch {}
}

export function saveOpenRouterKey(key) {
  try { localStorage.setItem(LS_OPENROUTER, key.trim()); _openrouter = key.trim(); _loaded = false; loadKeys(); } catch {}
}

// ─── Integration tokens ────────────────────────────────────────────────────────

export function getIntegrations() {
  try {
    const raw = localStorage.getItem(LS_INTEGRATIONS);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

export function getIntegrationToken(service) {
  const integrations = getIntegrations();
  const token = integrations[service] || '';
  console.log('[Noah Keys] getIntegrationToken:', service, 'available:', !!token, 'prefix:', token ? token.substring(0, 8) + '...' : 'none');
  return token;
}

export function saveIntegrationToken(service, value) {
  try {
    const current = getIntegrations();
    current[service] = value;
    localStorage.setItem(LS_INTEGRATIONS, JSON.stringify(current));
  } catch {}
}

export function saveAllIntegrations(obj) {
  try { localStorage.setItem(LS_INTEGRATIONS, JSON.stringify(obj)); } catch {}
}
