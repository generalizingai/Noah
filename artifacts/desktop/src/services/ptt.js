// Hold-to-talk (PTT) manager
// Primary:  uiohook-napi (OS-level, keycode-based) — supports fn, bare modifiers
// Fallback: globalShortcut (accelerator-based) — combos only

// ── uiohook keycode storage (primary) ─────────────────────────────────────────
const KEYCODE_KEY       = 'noah_ptt_keycode';       // integer keycode
const KEYCODE_LABEL_KEY = 'noah_ptt_keycode_label'; // human-readable label
const DEFAULT_KEYCODE   = 56;                        // Option (⌥)
const DEFAULT_KC_LABEL  = '⌥';

export function getPTTKeycode() {
  try {
    const raw = localStorage.getItem(KEYCODE_KEY);
    return raw !== null ? Number(raw) : DEFAULT_KEYCODE;
  } catch { return DEFAULT_KEYCODE; }
}

export function setPTTKeycode(keycode, label) {
  try {
    localStorage.setItem(KEYCODE_KEY, String(keycode));
    localStorage.setItem(KEYCODE_LABEL_KEY, label || String(keycode));
  } catch {}
}

// ── globalShortcut storage (fallback) ─────────────────────────────────────────
const STORAGE_KEY = 'noah_ptt_key_code';
const DEFAULT_KEY_CODE = 'CmdOrCtrl+Shift+Space';
const DEFAULT_KEY_LABEL = '⌘⇧Space';

export function getPTTKeyCode() {
  try { return localStorage.getItem(STORAGE_KEY) || DEFAULT_KEY_CODE; }
  catch { return DEFAULT_KEY_CODE; }
}

// Prefer uiohook label if set, fall back to accelerator label
export function getPTTKeyLabel() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return DEFAULT_KEY_LABEL;
    const kc = localStorage.getItem(KEYCODE_LABEL_KEY);
    if (kc) return kc;
    return localStorage.getItem(STORAGE_KEY + '_label') || DEFAULT_KEY_LABEL;
  } catch { return DEFAULT_KEY_LABEL; }
}

export function setPTTKey(code, label) {
  try {
    localStorage.setItem(STORAGE_KEY, code);
    localStorage.setItem(STORAGE_KEY + '_label', label || code);
  } catch {}
}

export function resetPTTKey() {
  try {
    localStorage.removeItem(KEYCODE_KEY);
    localStorage.removeItem(KEYCODE_LABEL_KEY);
    localStorage.setItem(STORAGE_KEY, DEFAULT_KEY_CODE);
    localStorage.setItem(STORAGE_KEY + '_label', DEFAULT_KEY_LABEL);
  } catch {}
}

export class PTTManager {
  constructor(onStart, onStop) {
    this.onStart = onStart;
    this.onStop = onStop;
    this.isHeld = false;
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
  }

  getKeyCode() {
    return getPTTKeyCode();
  }

  start() {
    // Use window + capture:true so events fire even when a child element (input, button) has focus
    window.addEventListener('keydown', this._onKeyDown, { capture: true });
    window.addEventListener('keyup',   this._onKeyUp,   { capture: true });
  }

  stop() {
    window.removeEventListener('keydown', this._onKeyDown, { capture: true });
    window.removeEventListener('keyup',   this._onKeyUp,   { capture: true });
    if (this.isHeld) {
      this.isHeld = false;
      this.onStop?.();
    }
  }

  _onKeyDown(e) {
    if (e.repeat) return;
    if (e.code !== this.getKeyCode()) return;
    // Prevent browser shortcuts from firing
    e.preventDefault();
    if (!this.isHeld) {
      this.isHeld = true;
      this.onStart?.();
    }
  }

  _onKeyUp(e) {
    if (e.code !== this.getKeyCode()) return;
    e.preventDefault();
    if (this.isHeld) {
      this.isHeld = false;
      this.onStop?.();
    }
  }
}
