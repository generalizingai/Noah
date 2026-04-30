import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../services/auth';
import { isTTSAvailable, DEEPGRAM_VOICES, ELEVENLABS_VOICES, getActiveTTSProvider, previewVoice } from '../services/tts';
import { getPTTKeyLabel, setPTTKey, getPTTKeycode, setPTTKeycode } from '../services/ptt';
import {
  saveOpenAIKey, saveDeepgramKey, getOpenAIKey, getDeepgramKey,
  getVoiceModel, saveVoiceModel, getSystemInstructions, saveSystemInstructions,
  getIntegrations, saveAllIntegrations, getIntegrationToken,
} from '../services/keys';
import { getHermesBrainMode, setHermesBrainMode, checkHermesStatus, getHermesModel, setHermesModel, getRequireToolApproval, setRequireToolApproval } from '../services/noahApi';
import {
  Setting06Icon, Mic01Icon, GearsIcon, ShieldKeyIcon,
  CheckmarkCircle01Icon, Cancel01Icon, EyeIcon, KeyboardIcon,
  VolumeHighIcon, Brain01Icon, Link01Icon, InternetIcon,
} from 'hugeicons-react';

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

// ─── Generic layout helpers ────────────────────────────────────────────────────

function Section({ icon, title, description, children }) {
  return (
    <section>
      <div className="flex items-start gap-2 mb-2.5 px-1">
        <span className="text-green-400/60 flex-shrink-0 mt-0.5">{icon}</span>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-white/28">{title}</p>
          {description && <p className="text-[10px] text-white/22 mt-0.5 leading-tight">{description}</p>}
        </div>
      </div>
      <div className="glass-card divide-y divide-white/5">
        {children}
      </div>
    </section>
  );
}

function Row({ label, sub, right, children }) {
  return (
    <div className="px-4 py-3.5">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-medium text-white/80">{label}</p>
          {sub && <p className="text-[11px] mt-0.5 text-white/32 leading-tight">{sub}</p>}
        </div>
        {right && <div className="flex-shrink-0">{right}</div>}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}

function StatusBadge({ ok, warn, label }) {
  const cls  = ok ? 'green' : warn ? 'amber' : 'red';
  const Icon = ok ? CheckmarkCircle01Icon : Cancel01Icon;
  return (
    <span className={`status-pill ${cls} flex items-center gap-1`}>
      <Icon size={10} strokeWidth={2} />
      {label}
    </span>
  );
}

// ─── API key input ─────────────────────────────────────────────────────────────

function ApiKeyInput({ label, sub, value, onChange, onSave, placeholder, saved }) {
  const [show, setShow] = useState(false);
  return (
    <Row label={label} sub={sub}>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            type={show ? 'text' : 'password'}
            value={value}
            onChange={e => onChange(e.target.value)}
            placeholder={placeholder}
            className="noah-input w-full px-3 py-2 text-xs pr-9 font-mono"
            spellCheck={false}
          />
          <button
            onClick={() => setShow(v => !v)}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/25 hover:text-white/55 transition-colors"
          >
            <EyeIcon size={12} strokeWidth={1.8} />
          </button>
        </div>
        <button onClick={onSave} className="btn-green px-3.5 py-2 text-xs flex-shrink-0" style={{ minWidth: 52 }}>
          {saved ? '✓ Saved' : 'Save'}
        </button>
      </div>
      {saved && <p className="text-[11px] mt-1.5 text-green-400/70">Saved. Active immediately.</p>}
    </Row>
  );
}

// ─── PTT key capture ───────────────────────────────────────────────────────────

function PTTKeyRow() {
  const [currentLabel, setCurrentLabel] = useState(getPTTKeyLabel);
  const [capturing,    setCapturing]    = useState(false);
  const [hint,         setHint]         = useState('');
  const [hintMsg,      setHintMsg]      = useState('');
  const [uiohookMode,  setUiohookMode]  = useState(false);
  const [appDir,       setAppDir]       = useState('');
  const captureRef = useRef(null); // DOM fallback only

  // On mount: load PTT info and register saved keycode with main process
  useEffect(() => {
    if (!isElectron) return;
    window.electronAPI.getPTTInfo?.().then(info => {
      if (!info) return;
      setUiohookMode(!!info.uiohook);
      setAppDir(info.appDir || '');
      if (info.uiohook && info.label) setCurrentLabel(info.label);
      // If renderer has a saved keycode, push it to main process
      const savedKc = getPTTKeycode();
      const savedLbl = getPTTKeyLabel();
      if (info.uiohook && savedKc) {
        window.electronAPI.registerPTTKeycode?.(savedKc, savedLbl).catch(() => {});
      }
    }).catch(() => {});

    // Listen for capture result from main process
    const unsub = window.electronAPI.onPTTKeyCaptured?.((data) => {
      setCapturing(false);
      setHint(''); setHintMsg('');
      setPTTKeycode(data.keycode, data.label);
      setCurrentLabel(data.label);
    });
    return () => { unsub?.(); cleanupDomCapture(); };
  }, []);

  // ── uiohook capture (primary) ──────────────────────────────────────────────
  const startUiohookCapture = async () => {
    setCapturing(true);
    setHint(''); setHintMsg('');
    try {
      const res = await window.electronAPI.startPTTCapture();
      if (!res?.ok) {
        setCapturing(false);
        setHint('error');
        setHintMsg(res?.reason === 'uiohook-unavailable'
          ? 'Advanced key capture unavailable — Noah needs Accessibility permission in System Settings.'
          : 'Could not start capture. Try restarting Noah.');
      }
      // Success: wait for onPTTKeyCaptured event (registered in useEffect)
    } catch {
      setCapturing(false);
      setHint('error');
      setHintMsg('Could not start capture. Try restarting Noah.');
    }
  };

  const cancelUiohookCapture = async () => {
    setCapturing(false);
    setHint(''); setHintMsg('');
    await window.electronAPI.cancelPTTCapture?.().catch(() => {});
  };

  const [showSetup,    setShowSetup]    = useState(false);

  // ── DOM-based capture (globalShortcut fallback) ────────────────────────────
  const cleanupDomCapture = () => {
    if (captureRef.current) {
      document.removeEventListener('keydown', captureRef.current, true);
      captureRef.current = null;
    }
  };

  const startDomCapture = () => {
    setCapturing(true);
    setShowSetup(false);
    setHint(''); setHintMsg('');
    captureRef.current = async (e) => {
      e.preventDefault(); e.stopPropagation();
      const mods = ['Meta','Control','Alt','Shift'];

      // Bare modifier → stop capture and show setup card
      if (mods.includes(e.key)) {
        setCapturing(false);
        cleanupDomCapture();
        setShowSetup(true);
        return;
      }

      const fKey = /^F([1-9]|1[0-2])$/.test(e.key);
      const parts = [];
      if (e.metaKey)  parts.push('Command');
      if (e.ctrlKey)  parts.push('Control');
      if (e.altKey)   parts.push('Alt');
      if (e.shiftKey) parts.push('Shift');
      const key = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : (fKey ? e.key : e.code);
      parts.push(key);
      const acc   = parts.join('+');
      const label = parts.map(p => ({Command:'⌘',Control:'⌃',Alt:'⌥',Shift:'⇧'}[p] || p)).join('');
      setCapturing(false);
      cleanupDomCapture();
      setShowSetup(false);
      setHint(''); setHintMsg('');
      setPTTKey(acc, label);
      setCurrentLabel(label);
      try {
        const res = await window.electronAPI.registerPTT?.(acc);
        if (!res?.ok) {
          setHint('error');
          setHintMsg(`Couldn't register "${label}" — it may be in use. Try another.`);
        } else if (!fKey && parts.length === 1) {
          setHint('warn');
          setHintMsg(`"${label}" will conflict with typing. F1–F12 or a combo is safer.`);
        }
      } catch { setHint('error'); setHintMsg('Failed to register shortcut.'); }
    };
    document.addEventListener('keydown', captureRef.current, true);
  };

  const cancelDomCapture = () => {
    setCapturing(false);
    setShowSetup(false);
    setHint(''); setHintMsg('');
    cleanupDomCapture();
  };

  const startCapture  = () => isElectron && uiohookMode ? startUiohookCapture()  : startDomCapture();
  const cancelCapture = () => isElectron && uiohookMode ? cancelUiohookCapture() : cancelDomCapture();

  const copyCmd = () => {
    const cmd = appDir ? `cd "${appDir}" && npm install` : 'npm install';
    navigator.clipboard.writeText(cmd).catch(() => {});
  };

  const openAccessibility = () => {
    window.electronAPI?.runShell?.(
      'open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"'
    ).catch(() => {});
  };

  const hintColor =
    hint === 'error' ? 'text-red-400/80' :
    hint === 'warn'  ? 'text-yellow-400/70' :
    hint === 'mod'   ? 'text-sky-400/70' : 'text-white/22';

  const capturePrompt = uiohookMode
    ? 'Press any key — fn, ⌥, ⌘, F1, anything…'
    : 'Press a combo (e.g. ⌥Space) or F1–F12…';

  return (
    <Row label="Global Hold-to-Talk Key" sub="Hold to record, release to send. Works from any app.">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <div className="flex-1 px-3 py-2 rounded-lg text-xs font-mono text-white/70 flex items-center gap-2"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
            <KeyboardIcon size={12} strokeWidth={1.6} className="text-white/30" />
            <span className={capturing ? 'text-green-400 animate-pulse' : ''}>
              {capturing ? capturePrompt : currentLabel}
            </span>
          </div>
          {capturing
            ? <button onClick={cancelCapture} className="btn-ghost px-3 py-2 text-xs">Cancel</button>
            : <button onClick={startCapture}  className="btn-green px-3.5 py-2 text-xs">Change</button>}
        </div>

        {/* ── One-time setup card (shown when user tries a bare modifier) ─── */}
        {showSetup && !uiohookMode && (
          <div className="rounded-xl p-3 flex flex-col gap-2"
            style={{ background: 'rgba(99,102,241,0.10)', border: '1px solid rgba(99,102,241,0.25)' }}>
            <p className="text-[11px] font-medium text-indigo-300">Enable fn / modifier key support</p>
            <p className="text-[10px] text-white/50 leading-relaxed">
              Bare keys like <span className="font-mono text-white/70">fn</span>,
              {' '}<span className="font-mono text-white/70">⌘</span>,
              {' '}<span className="font-mono text-white/70">⌥</span> need a one-time setup.
            </p>
            <ol className="text-[10px] text-white/50 leading-relaxed list-decimal list-inside space-y-1">
              <li>
                In Terminal, run:{' '}
                <code className="px-1 py-0.5 rounded text-[9px] font-mono text-indigo-300"
                  style={{ background: 'rgba(99,102,241,0.15)' }}>
                  npm install
                </code>{' '}
                inside your Noah desktop folder.
                {' '}<button onClick={copyCmd}
                  className="text-indigo-400/80 underline underline-offset-2 hover:text-indigo-300 transition-colors">
                  Copy command
                </button>
              </li>
              <li>
                Restart Noah, then grant{' '}
                <button onClick={openAccessibility}
                  className="text-indigo-400/80 underline underline-offset-2 hover:text-indigo-300 transition-colors">
                  Accessibility permission
                </button>{' '}
                in System Settings.
              </li>
              <li>Come back here and press any key — fn will work.</li>
            </ol>
            <div className="flex gap-2 mt-1">
              <button onClick={() => setShowSetup(false)}
                className="text-[10px] text-white/30 hover:text-white/50 transition-colors">
                Dismiss
              </button>
              <span className="text-white/15">·</span>
              <button onClick={startCapture}
                className="text-[10px] text-indigo-400/70 hover:text-indigo-300 transition-colors">
                Use a combo instead →
              </button>
            </div>
          </div>
        )}

        {/* ── Inline hint ──────────────────────────────────────────────────── */}
        {!showSetup && hintMsg && (
          <p className={`text-[10px] leading-snug ${hintColor}`}>{hintMsg}</p>
        )}
        {!showSetup && !hintMsg && !capturing && (
          <p className="text-[10px] text-white/22">
            {uiohookMode
              ? 'Any key works: fn, ⌥ Option, ⌘ Command, F1–F12, or any combo.'
              : 'Use ⌥Space, ⌘Space, or F1–F12. For fn/modifier-only: see setup above.'}
          </p>
        )}
      </div>
    </Row>
  );
}

// ─── Custom Voice ID Modal ─────────────────────────────────────────────────────

function CustomVoiceModal({ onApply, onClose }) {
  const [id, setId] = useState('');
  const apply = () => { if (id.trim()) { onApply(id.trim()); onClose(); } };
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(8px)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rounded-2xl p-6 w-80" style={{
        background: 'rgba(8,18,11,0.98)',
        border: '1px solid rgba(255,255,255,0.1)',
        boxShadow: '0 24px 60px rgba(0,0,0,0.7)',
      }}>
        <h3 className="text-sm font-semibold text-white/85 mb-1">Add Custom Voice</h3>
        <p className="text-xs text-white/35 mb-4 leading-relaxed">
          Paste any ElevenLabs Voice ID to use it directly. Find IDs in your{' '}
          <span className="text-green-400/70">ElevenLabs Voice Lab</span>.
        </p>
        <input
          autoFocus
          value={id}
          onChange={e => setId(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') apply(); if (e.key === 'Escape') onClose(); }}
          placeholder="e.g. 21m00Tcm4TlvDq8ikWAM"
          className="noah-input w-full px-3 py-2.5 text-xs font-mono mb-4"
          spellCheck={false}
        />
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="btn-ghost px-4 py-2 text-xs">Cancel</button>
          <button onClick={apply} disabled={!id.trim()} className="btn-green px-4 py-2 text-xs"
            style={{ opacity: id.trim() ? 1 : 0.45 }}>
            Use this voice
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Voice picker ──────────────────────────────────────────────────────────────

function VoicePickerRow() {
  const [selected,      setSelected]      = useState(getVoiceModel);
  const [saved,         setSaved]         = useState(false);
  const [previewing,    setPreviewing]    = useState(null);
  const [previewError,  setPreviewError]  = useState('');
  const [open,          setOpen]          = useState(false);
  const [search,        setSearch]        = useState('');
  const [showCustom,    setShowCustom]    = useState(false);
  const dropRef = useRef(null);
  const provider = getActiveTTSProvider();

  const builtinVoices = provider === 'elevenlabs' ? ELEVENLABS_VOICES : DEEPGRAM_VOICES;
  const getId  = (v) => v.id || v.model;

  const selectedVoice = builtinVoices.find(v => getId(v) === selected);
  const selectedLabel = selectedVoice
    ? `${selectedVoice.name} (${selectedVoice.tone})`
    : (selected ? `Custom ID (${selected.slice(0, 12)}…)` : 'Choose a voice…');

  const filtered = builtinVoices.filter(v =>
    v.name.toLowerCase().includes(search.toLowerCase()) ||
    v.tone.toLowerCase().includes(search.toLowerCase())
  );

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e) => {
      if (dropRef.current && !dropRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const save = () => { saveVoiceModel(selected); setSaved(true); setTimeout(() => setSaved(false), 2500); };

  // Preview — use mousedown so it fires before any click-based close handlers
  const handlePreviewMouseDown = async (e, vid) => {
    e.stopPropagation();
    e.preventDefault();
    if (previewing) return;
    setPreviewError('');
    setPreviewing(vid);
    const apiKey = provider === 'elevenlabs' ? getIntegrationToken('elevenlabs_key') : getDeepgramKey();
    if (!apiKey) {
      setPreviewError('No API key found. Save your key in Integrations first.');
      setPreviewing(null);
      return;
    }
    try {
      await previewVoice(vid, provider, apiKey);
    } catch (err) {
      setPreviewError(`Preview failed: ${err.message}`);
    } finally {
      setPreviewing(null);
    }
  };

  const female = filtered.filter(v => v.gender === 'Female');
  const male   = filtered.filter(v => v.gender === 'Male');

  return (
    <>
      {showCustom && (
        <CustomVoiceModal
          onApply={(id) => { setSelected(id); setOpen(false); }}
          onClose={() => setShowCustom(false)}
        />
      )}
      <Row
        label="Noah's Voice"
        sub={provider === 'elevenlabs'
          ? `ElevenLabs - ${builtinVoices.length} built-in voices`
          : provider === 'deepgram'
            ? 'Deepgram Aura voices'
            : 'Add an ElevenLabs or Deepgram key in Integrations below'}
      >
        {!provider ? (
          <p className="text-xs text-white/35 py-1">Add an API key to enable voice output.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {/* Dropdown trigger */}
            <div ref={dropRef} className="relative">
              <button
                onClick={() => { setOpen(o => !o); setSearch(''); setPreviewError(''); }}
                className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-xs text-left transition-all focus:outline-none"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(228,240,232,0.75)' }}>
                <span className="font-medium truncate">{selectedLabel}</span>
                <span className="text-white/30 flex-shrink-0 ml-2">{open ? '▲' : '▼'}</span>
              </button>

              {open && (
                <div
                  className="absolute z-50 left-0 right-0 mt-1 rounded-xl"
                  style={{
                    background: 'rgba(8,18,11,0.99)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    boxShadow: '0 20px 60px rgba(0,0,0,0.7)',
                    maxHeight: 300,
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                  }}>
                  {/* Search bar */}
                  <div className="px-3 pt-2.5 pb-1.5 flex-shrink-0"
                    style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                    <input
                      autoFocus
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                      placeholder="Search voices…"
                      className="w-full bg-transparent text-xs text-white/70 placeholder:text-white/25 focus:outline-none"
                    />
                  </div>

                  {/* List */}
                  <div className="overflow-y-auto flex-1 py-1">
                    {(['Female', 'Male']).map(gender => {
                      const group = gender === 'Female' ? female : male;
                      if (!group.length) return null;
                      return (
                        <div key={gender}>
                          <p className="px-3 pt-2 pb-1 text-[9px] text-white/22 uppercase tracking-widest">{gender}</p>
                          {group.map(v => {
                            const vid = getId(v);
                            const active = selected === vid;
                            const loading = previewing === vid;
                            return (
                              <div key={vid}
                                className="flex items-center gap-1.5 px-3 py-1.5 cursor-pointer"
                                style={active ? { background: 'rgba(22,163,74,0.12)', color: '#4ade80' } : { color: 'rgba(228,240,232,0.68)' }}
                                onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
                                onMouseLeave={e => { if (!active) e.currentTarget.style.background = ''; }}
                                onMouseDown={e => {
                                  // Only select if NOT clicking the play button
                                  if (!e.target.closest('[data-play]')) {
                                    setSelected(vid);
                                    setOpen(false);
                                  }
                                }}>
                                <span className="flex-1 text-xs font-medium">{v.name}</span>
                                <span className="text-[10px] opacity-45 flex-shrink-0">{v.tone}</span>
                                {/* Play button — mousedown to avoid dropdown-close interference */}
                                <span
                                  data-play="true"
                                  onMouseDown={e => handlePreviewMouseDown(e, vid)}
                                  title="Preview voice"
                                  className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded cursor-pointer"
                                  style={{ opacity: loading ? 1 : 0.5, color: loading ? '#4ade80' : 'inherit' }}>
                                  {loading
                                    ? <div className="w-2.5 h-2.5 border border-current border-t-transparent rounded-full animate-spin" />
                                    : <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Error from preview */}
            {previewError && (
              <p className="text-[10px] text-red-400/80 -mt-1">{previewError}</p>
            )}

            {/* Row: custom voice + apply */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowCustom(true)}
                className="btn-ghost px-3 py-1.5 text-xs flex items-center gap-1.5">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
                Custom Voice ID
              </button>
              {previewing && (
                <span className="text-[10px] text-green-400/70 flex items-center gap-1.5">
                  <div className="w-2 h-2 border border-current border-t-transparent rounded-full animate-spin" />
                  Playing preview…
                </span>
              )}
              <button onClick={save} className="btn-green px-4 py-1.5 text-xs ml-auto">
                {saved ? '✓ Applied' : 'Apply voice'}
              </button>
            </div>
            <p className="text-[10px] text-white/18">Click ▶ next to any voice to hear it before applying.</p>
          </div>
        )}
      </Row>
    </>
  );
}

// ─── System instructions ───────────────────────────────────────────────────────

function SystemInstructionsRow() {
  const [text, setText]   = useState(getSystemInstructions);
  const [saved, setSaved] = useState(false);

  const save = () => { saveSystemInstructions(text); setSaved(true); setTimeout(() => setSaved(false), 2500); };

  return (
    <Row label="System Instructions" sub="Noah's personality, tone and priorities. Injected into every conversation.">
      <div className="flex flex-col gap-2">
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder={'Examples:\n"Always respond concisely and clearly."\n"You are a productivity-focused assistant."\n"Speak like a friendly, knowledgeable colleague."'}
          rows={5}
          className="noah-input w-full px-3 py-2.5 text-xs resize-none leading-relaxed"
          style={{ fontFamily: 'inherit' }}
          spellCheck={false}
        />
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-white/22">{text.length} characters</span>
          <button onClick={save} className="btn-green px-4 py-2 text-xs">
            {saved ? '✓ Saved' : 'Save instructions'}
          </button>
        </div>
      </div>
    </Row>
  );
}

// ─── Integrations section ─────────────────────────────────────────────────────

const INTEGRATIONS = [
  {
    key: 'elevenlabs_key',
    name: 'ElevenLabs',
    description: 'Human-like, expressive voices. Much more natural than default TTS. Get API key at elevenlabs.io',
    placeholder: 'Your ElevenLabs API key…',
    link: 'https://elevenlabs.io/sign-up',
    linkLabel: 'Get free key',
  },
  {
    key: 'github_token',
    name: 'GitHub',
    description: 'Manage repos, issues, PRs, gists. Get token at github.com/settings/tokens (scopes: repo)',
    placeholder: 'ghp_xxxxxxxxxxxx',
    link: 'https://github.com/settings/tokens/new',
    linkLabel: 'Create token',
  },
  {
    key: 'slack_token',
    name: 'Slack',
    description: 'Send messages, list channels, read conversations. Create a bot at api.slack.com/apps',
    placeholder: 'xoxb-xxxxxxxxxxxx',
    link: 'https://api.slack.com/apps',
    linkLabel: 'Create app',
  },
  {
    key: 'notion_token',
    name: 'Notion',
    description: 'Read and write Notion pages, databases. Get token at notion.so/my-integrations',
    placeholder: 'ntn_xxxxxxxxxxxx',
    link: 'https://www.notion.so/my-integrations',
    linkLabel: 'Create integration',
  },
  {
    key: 'brave_key',
    name: 'Brave Search',
    description: 'Deep internet search with real results (much better than DuckDuckGo fallback). Get key at brave.com/search/api',
    placeholder: 'BSA-xxxxxx',
    link: 'https://brave.com/search/api/',
    linkLabel: 'Get API key',
  },
  {
    key: 'google_token',
    name: 'Google',
    description: 'Gmail, Calendar, Drive access. Generate an OAuth token via Google Cloud Console.',
    placeholder: 'ya29.xxxxxxxxxxxx',
    link: 'https://console.cloud.google.com',
    linkLabel: 'Console',
  },
  {
    key: 'linear_key',
    name: 'Linear',
    description: 'Create and manage Linear issues and projects. Get API key at linear.app/settings/api',
    placeholder: 'lin_api_xxxxxxxxx',
    link: 'https://linear.app/settings/api',
    linkLabel: 'Get key',
  },
  {
    key: 'trello_key',
    name: 'Trello (Key)',
    description: 'Access Trello boards, cards and lists. Get key at trello.com/app-key',
    placeholder: 'API key',
    link: 'https://trello.com/app-key',
    linkLabel: 'Get key',
    paired: 'trello_token',
  },
  {
    key: 'trello_token',
    name: 'Trello (Token)',
    description: 'Also required alongside the Trello API key',
    placeholder: 'Token',
    link: null,
  },
  {
    key: 'airtable_key',
    name: 'Airtable',
    description: 'Read and write Airtable bases. Create a Personal Access Token at airtable.com/create/tokens',
    placeholder: 'pat_xxxxxxxxxxxx',
    link: 'https://airtable.com/create/tokens',
    linkLabel: 'Create token',
  },
];

function IntegrationsSection() {
  const [tokens, setTokens] = useState(getIntegrations);
  const [saved,  setSaved]  = useState(false);
  const [show,   setShow]   = useState({});

  const set = (key, val) => setTokens(prev => ({ ...prev, [key]: val }));

  const saveAll = () => {
    saveAllIntegrations(tokens);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const toggleShow = (key) => setShow(prev => ({ ...prev, [key]: !prev[key] }));

  return (
    <div className="px-4 py-3.5 flex flex-col gap-3">
      <p className="text-[11px] text-white/40 leading-relaxed">
        Add API tokens for each service. Noah uses them automatically when you ask it to perform tasks.
        All tokens are stored locally on your device.
      </p>

      <div className="space-y-2">
        {INTEGRATIONS.map(({ key, name, description, placeholder, link, linkLabel }) => {
          const val       = tokens[key] || '';
          const isSet     = !!val;
          const showPlain = show[key];

          return (
            <div key={key} className="rounded-xl p-3" style={{
              background: isSet ? 'rgba(22,163,74,0.06)' : 'rgba(255,255,255,0.025)',
              border: isSet ? '1px solid rgba(22,163,74,0.2)' : '1px solid rgba(255,255,255,0.06)',
            }}>
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-white/80">{name}</span>
                  {isSet && (
                    <span className="status-pill green flex items-center gap-1" style={{ fontSize: 10 }}>
                      <CheckmarkCircle01Icon size={9} strokeWidth={2} /> Connected
                    </span>
                  )}
                </div>
                {link && (
                  <a
                    href="#"
                    onClick={e => { e.preventDefault(); isElectron && window.electronAPI.openExternal(link); }}
                    className="text-[10px] text-green-400/60 hover:text-green-400 transition-colors"
                  >
                    {linkLabel} →
                  </a>
                )}
              </div>
              <p className="text-[10px] text-white/28 mb-2 leading-tight">{description}</p>
              <div className="relative">
                <input
                  type={showPlain ? 'text' : 'password'}
                  value={val}
                  onChange={e => set(key, e.target.value)}
                  placeholder={placeholder}
                  className="noah-input w-full px-3 py-1.5 text-[11px] pr-8 font-mono"
                  spellCheck={false}
                />
                <button
                  onClick={() => toggleShow(key)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/25 hover:text-white/50 transition-colors"
                >
                  <EyeIcon size={11} strokeWidth={1.8} />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <button onClick={saveAll} className="btn-green px-4 py-2 text-xs self-end mt-1">
        {saved ? '✓ All saved' : 'Save all tokens'}
      </button>
      {saved && <p className="text-[11px] text-green-400/70">Integration tokens saved. Noah will use them from the next message.</p>}
    </div>
  );
}

// ─── Tool approval toggle ──────────────────────────────────────────────────────

function ToolApprovalToggleRow() {
  const [enabled, setEnabled] = useState(getRequireToolApproval);

  const toggle = () => {
    const next = !enabled;
    setEnabled(next);
    setRequireToolApproval(next);
  };

  return (
    <Row
      label="Confirm before running commands"
      sub="Show an approval dialog before Hermes runs shell commands, writes files, or executes AppleScript"
      right={
        <button
          onClick={toggle}
          style={{
            width: 36,
            height: 20,
            borderRadius: 10,
            background: enabled ? 'rgba(22,163,74,0.75)' : 'rgba(255,255,255,0.12)',
            border: enabled ? '1px solid rgba(22,163,74,0.5)' : '1px solid rgba(255,255,255,0.12)',
            position: 'relative',
            cursor: 'pointer',
            transition: 'all 0.2s',
            flexShrink: 0,
          }}
          title={enabled ? 'Click to disable approval prompts' : 'Click to enable approval prompts'}
        >
          <span
            style={{
              display: 'block',
              width: 14,
              height: 14,
              borderRadius: '50%',
              background: 'white',
              position: 'absolute',
              top: 2,
              left: enabled ? 19 : 2,
              transition: 'left 0.2s',
              boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
            }}
          />
        </button>
      }
    />
  );
}

// ─── AI Brain mode picker ──────────────────────────────────────────────────────

function BrainModeRow() {
  const [mode,         setMode]         = useState(getHermesBrainMode);
  const [status,       setStatus]       = useState(null);
  const [checking,     setChecking]     = useState(false);
  const [saved,        setSaved]        = useState(false);
  const [model,        setModel]        = useState(getHermesModel);
  const [modelSaved,   setModelSaved]   = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [search,       setSearch]       = useState('');
  const [orModels,     setOrModels]     = useState([]);
  const [orLoading,    setOrLoading]    = useState(false);
  const [orError,      setOrError]      = useState(null);
  const [customInput,  setCustomInput]  = useState('');
  const dropdownRef = useRef(null);

  const check = async () => {
    setChecking(true);
    const s = await checkHermesStatus();
    setStatus(s);
    setChecking(false);
  };

  useEffect(() => { check(); }, []);

  useEffect(() => {
    if (!dropdownOpen || orModels.length > 0) return;
    setOrLoading(true);
    setOrError(null);
    fetch('https://openrouter.ai/api/v1/models')
      .then(r => r.json())
      .then(json => {
        const list = (json.data || [])
          .filter(m => m.id && m.name)
          .sort((a, b) => a.name.localeCompare(b.name));
        setOrModels(list);
        setOrLoading(false);
      })
      .catch(() => { setOrError('Could not load models.'); setOrLoading(false); });
  }, [dropdownOpen, orModels.length]);

  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdownOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropdownOpen]);

  const apply = (newMode) => {
    setMode(newMode);
    setHermesBrainMode(newMode);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    if (isElectron && window.electronAPI?.setBrainMode) {
      window.electronAPI.setBrainMode(newMode).catch(() => {});
    }
  };

  const applyModel = (newModel) => {
    if (!newModel?.trim()) return;
    setModel(newModel);
    setHermesModel(newModel);
    setModelSaved(true);
    setDropdownOpen(false);
    setSearch('');
    setTimeout(() => setModelSaved(false), 2500);
  };

  const filteredModels = orModels.filter(m => {
    const q = search.toLowerCase();
    return !q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q);
  });

  const modelDisplayName = (id) => {
    const found = orModels.find(m => m.id === id);
    return found ? found.name : id;
  };

  const fmtPrice = (m) => {
    const p = parseFloat(m.pricing?.prompt || 0) * 1_000_000;
    if (!p) return 'free';
    return `$${p < 1 ? p.toFixed(3) : p.toFixed(2)}/M`;
  };

  const hermesBadge = status?.active
    ? <span className="status-pill green flex items-center gap-1" style={{ fontSize: 10 }}><CheckmarkCircle01Icon size={9} strokeWidth={2} /> Active</span>
    : checking
      ? <span className="status-pill flex items-center gap-1" style={{ fontSize: 10, background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.4)' }}>Checking…</span>
      : status === null
        ? <span className="status-pill flex items-center gap-1" style={{ fontSize: 10, background: 'rgba(239,68,68,0.08)', color: '#f87171' }}><Cancel01Icon size={9} strokeWidth={2} /> Offline</span>
        : <span className="status-pill flex items-center gap-1" style={{ fontSize: 10, background: 'rgba(251,191,36,0.08)', color: '#fbbf24' }}>Inactive</span>;

  return (
    <Row
      label="AI Brain"
      sub="Classic uses your OpenAI key directly. Hermes routes through Noah's backend engine with server-side tools."
    >
      <div className="flex flex-col gap-3">
        {/* Pill toggle — inset shadow only (no external box-shadow) */}
        <div className="flex items-center gap-1.5 p-1 rounded-xl"
          style={{ background: 'rgba(255,255,255,0.05)', boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.3)' }}>
          {[
            { id: 'classic', label: 'Classic', sub: 'GPT-4o direct' },
            { id: 'hermes',  label: 'Hermes',  sub: 'Backend engine' },
          ].map(({ id, label, sub: sub2 }) => {
            const active = mode === id;
            return (
              <button
                key={id}
                onClick={() => apply(id)}
                className="flex-1 flex flex-col items-center gap-0.5 py-2 rounded-lg transition-all text-center"
                style={active ? {
                  background: id === 'hermes'
                    ? 'linear-gradient(135deg, rgba(99,102,241,0.25), rgba(139,92,246,0.18))'
                    : 'rgba(22,163,74,0.18)',
                  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08)',
                  color: id === 'hermes' ? '#a78bfa' : '#4ade80',
                } : { color: 'rgba(255,255,255,0.35)' }}
              >
                <span className="text-xs font-semibold">{label}</span>
                <span className="text-[9px] opacity-60">{sub2}</span>
              </button>
            );
          })}
        </div>

        {/* Mode descriptions */}
        {mode === 'classic' && (
          <p className="text-[10px] text-white/35 leading-relaxed">
            Classic mode: queries go directly to OpenAI GPT-4o using your API key.
            All macOS tools (AppleScript, shell, notifications) run locally on your Mac.
          </p>
        )}
        {mode === 'hermes' && (
          <div className="flex flex-col gap-2">
            <p className="text-[10px] text-white/35 leading-relaxed">
              Hermes mode: queries route to Noah's backend AI engine.
              Uses parallel tool execution, persistent session memory, and context compression.
              No OpenAI key required — runs on Noah's servers.
            </p>

            {/* ── Model picker ────────────────────────── */}
            <div className="flex flex-col gap-1.5" ref={dropdownRef}>
              <span className="text-[10px] text-white/45 font-medium">AI Model</span>

              {/* Trigger button */}
              <button
                onClick={() => { setDropdownOpen(o => !o); setSearch(''); }}
                className="flex items-center justify-between w-full px-3 py-2 rounded-xl text-[11px] transition-all text-left"
                style={{
                  background: dropdownOpen
                    ? 'rgba(99,102,241,0.12)'
                    : 'rgba(255,255,255,0.05)',
                  border: dropdownOpen
                    ? '1px solid rgba(99,102,241,0.35)'
                    : '1px solid rgba(255,255,255,0.08)',
                  color: 'rgba(255,255,255,0.8)',
                }}
              >
                <span className="truncate font-medium">{modelDisplayName(model) || model}</span>
                <span className="text-[9px] ml-2 opacity-40 flex-shrink-0">{dropdownOpen ? '▲' : '▼'}</span>
              </button>

              {/* Dropdown panel */}
              {dropdownOpen && (
                <div className="flex flex-col rounded-xl overflow-hidden"
                  style={{ border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(15,15,20,0.97)', boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}>

                  {/* Search */}
                  <div className="px-2 pt-2 pb-1">
                    <input
                      autoFocus
                      type="text"
                      placeholder="Search models…"
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Escape') { setDropdownOpen(false); setSearch(''); } }}
                      className="w-full text-[11px] px-2.5 py-1.5 rounded-lg outline-none"
                      style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.8)' }}
                    />
                  </div>

                  {/* Custom ID row */}
                  <div className="px-2 pb-1 flex gap-1.5">
                    <input
                      type="text"
                      placeholder="Paste any OpenRouter model ID…"
                      value={customInput}
                      onChange={e => setCustomInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && customInput.trim()) applyModel(customInput.trim()); }}
                      className="flex-1 text-[10px] font-mono px-2 py-1 rounded-lg outline-none"
                      style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.6)' }}
                    />
                    <button
                      onClick={() => { if (customInput.trim()) applyModel(customInput.trim()); }}
                      className="text-[10px] px-2.5 py-1 rounded-lg flex-shrink-0"
                      style={{ background: 'rgba(99,102,241,0.2)', color: '#a78bfa' }}
                    >Use</button>
                  </div>

                  <div className="mx-2 mb-1" style={{ height: 1, background: 'rgba(255,255,255,0.06)' }} />

                  {/* List */}
                  <div className="overflow-y-auto" style={{ maxHeight: 240 }}>
                    {orLoading && (
                      <p className="text-[10px] text-white/30 text-center py-4">Loading models…</p>
                    )}
                    {orError && !orLoading && (
                      <p className="text-[10px] text-red-400/70 text-center py-3">{orError}</p>
                    )}
                    {!orLoading && !orError && filteredModels.length === 0 && (
                      <p className="text-[10px] text-white/30 text-center py-3">No models match</p>
                    )}
                    {filteredModels.map(m => {
                      const active = m.id === model;
                      const price  = fmtPrice(m);
                      return (
                        <button
                          key={m.id}
                          onClick={() => applyModel(m.id)}
                          className="w-full flex items-center justify-between px-3 py-1.5 text-left transition-colors"
                          style={active ? {
                            background: 'rgba(99,102,241,0.15)',
                            color: '#a78bfa',
                          } : {
                            color: 'rgba(255,255,255,0.6)',
                          }}
                          onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
                          onMouseLeave={e => { if (!active) e.currentTarget.style.background = ''; }}
                        >
                          <span className="text-[11px] font-medium truncate">{m.name}</span>
                          <span className="text-[9px] ml-2 flex-shrink-0 opacity-50"
                            style={{ color: price === 'free' ? '#4ade80' : 'inherit' }}>{price}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Current model ID in mono */}
              <p className="text-[9px] font-mono opacity-30 truncate">{model}</p>

              {modelSaved && (
                <p className="text-[10px] text-green-400/70">✓ Saved — next message uses this model.</p>
              )}
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-white/40">Backend status:</span>
                {hermesBadge}
                <span className="text-[10px] font-mono text-indigo-300/60">{model}</span>
              </div>
              <button
                onClick={check}
                disabled={checking}
                className="text-[10px] text-indigo-400/70 hover:text-indigo-300 transition-colors"
              >
                {checking ? 'Checking…' : 'Refresh'}
              </button>
            </div>
          </div>
        )}

        {saved && (
          <p className="text-[11px] text-green-400/70">
            {mode === 'hermes' ? 'Hermes mode enabled. Next query routes to backend.' : 'Classic mode restored.'}
          </p>
        )}
      </div>
    </Row>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function SettingsTab() {
  const { user, signOut }   = useAuth();
  const ttsAvailable        = isTTSAvailable();

  const [openaiKey,    setOpenaiKey]    = useState(getOpenAIKey);
  const [deepgramKey,  setDeepgramKey]  = useState(getDeepgramKey);
  const [openaiSaved,  setOpenaiSaved]  = useState(false);
  const [deepgramSaved, setDeepgramSaved] = useState(false);
  const [screenPerm,   setScreenPerm]   = useState(null);
  const [checkingPerm, setCheckingPerm] = useState(false);

  const displayName = user?.displayName || user?.email?.split('@')[0] || 'User';

  const handleSaveOpenAI  = () => { saveOpenAIKey(openaiKey);   setOpenaiSaved(true);   setTimeout(() => setOpenaiSaved(false),  3000); };
  const handleSaveDeepgram = () => { saveDeepgramKey(deepgramKey); setDeepgramSaved(true); setTimeout(() => setDeepgramSaved(false), 3000); };

  const checkScreenPermission = async () => {
    if (!isElectron) return;
    setCheckingPerm(true);
    try { setScreenPerm(await window.electronAPI.getScreenPermission()); }
    catch { setScreenPerm('error'); }
    finally { setCheckingPerm(false); }
  };

  const openPrivacySettings = () => {
    if (isElectron) window.electronAPI.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="px-6 py-4 flex-shrink-0" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <h2 className="text-sm font-semibold text-white/85">Settings</h2>
        <p className="text-[11px] mt-0.5 text-white/30">Configure Noah to your preferences</p>
      </div>

      <div className="px-5 py-5 space-y-6 pb-10">

        {/* Account */}
        <Section icon={<Setting06Icon size={12} strokeWidth={1.8} />} title="Account">
          <Row label={displayName} sub={user?.email}
            right={
              <button onClick={signOut} className="btn-ghost px-3 py-1.5 text-xs"
                style={{ color: '#f87171', borderColor: 'rgba(239,68,68,0.2)', background: 'rgba(239,68,68,0.05)' }}>
                Sign out
              </button>
            }
          />
        </Section>

        {/* API Keys */}
        <Section icon={<ShieldKeyIcon size={12} strokeWidth={1.8} />} title="API Keys">
          <ApiKeyInput label="OpenAI API Key" sub="Required for AI responses and speech-to-text"
            value={openaiKey} onChange={setOpenaiKey} onSave={handleSaveOpenAI} placeholder="sk-..." saved={openaiSaved} />
          <ApiKeyInput label="Deepgram API Key" sub="Required for voice output (text-to-speech)"
            value={deepgramKey} onChange={setDeepgramKey} onSave={handleSaveDeepgram} placeholder="Your Deepgram key…" saved={deepgramSaved} />
          <Row label="Firebase" sub="Authentication configured via environment variables">
            <StatusBadge ok label="Configured" />
          </Row>
        </Section>

        {/* Noah's Soul */}
        <Section icon={<Brain01Icon size={12} strokeWidth={1.8} />} title="Noah's Soul"
          description="Define Noah's personality, priorities, and working style">
          <SystemInstructionsRow />
        </Section>

        {/* AI Brain */}
        <Section icon={<Brain01Icon size={12} strokeWidth={1.8} />} title="AI Brain"
          description="Choose which AI engine powers Noah's responses">
          <BrainModeRow />
          <ToolApprovalToggleRow />
        </Section>

        {/* Integrations */}
        <Section
          icon={<Link01Icon size={12} strokeWidth={1.8} />}
          title="Integrations"
          description="Connect services so Noah can take actions on your behalf: GitHub, Slack, Notion, Google, Trello, and more"
        >
          <IntegrationsSection />
        </Section>

        {/* Voice */}
        <Section icon={<VolumeHighIcon size={12} strokeWidth={1.8} />} title="Voice">
          <PTTKeyRow />
          <VoicePickerRow />
          <Row label="Voice Input (STT)" sub="MediaRecorder → OpenAI Whisper" right={<StatusBadge ok label="Ready" />} />
          <Row label="Voice Output (TTS)" sub="Deepgram Aura"
            right={<StatusBadge ok={ttsAvailable} warn={!ttsAvailable} label={ttsAvailable ? 'Ready' : 'Missing key'} />} />
        </Section>

        {/* Capabilities */}
        <Section icon={<GearsIcon size={12} strokeWidth={1.8} />} title="Capabilities">
          {[
            ['Shell Commands',    'Run any terminal command, install apps, manage processes'],
            ['AppleScript',       'Control any macOS app: Safari, Finder, Music, Mail, Calendar'],
            ['File System',       'Read, write, and browse any file on your Mac'],
            ['Web Fetch',         'Read actual content from any webpage (not just open it)'],
            ['Internet Search',   'Search the web and get real results with snippets'],
            ['REST API Gateway',  'Call any API: GitHub, Slack, Notion, Google, and more'],
            ['Screen Vision',     'See and describe your screen in real time'],
            ['Notifications',     'Show macOS system notifications'],
          ].map(([lbl, sub]) => (
            <Row key={lbl} label={lbl} sub={sub}
              right={<StatusBadge ok={isElectron} warn={!isElectron} label={isElectron ? 'Enabled' : 'Desktop only'} />} />
          ))}
        </Section>

        {/* Permissions */}
        <Section icon={<ShieldKeyIcon size={12} strokeWidth={1.8} />} title="Permissions">
          <Row label="Screen Recording" sub="Required for screen watch and analysis"
            right={
              <div className="flex items-center gap-2">
                {screenPerm && <StatusBadge ok={screenPerm === 'granted'} warn={screenPerm !== 'granted'} label={screenPerm} />}
                <button onClick={checkScreenPermission} disabled={checkingPerm} className="btn-ghost px-3 py-1.5 text-[11px]">
                  {checkingPerm ? '…' : 'Check'}
                </button>
                {isElectron && (
                  <button onClick={openPrivacySettings} className="btn-ghost px-3 py-1.5 text-[11px]"
                    style={{ borderColor: 'rgba(22,163,74,0.25)', color: '#4ade80', background: 'rgba(22,163,74,0.05)' }}>
                    Open
                  </button>
                )}
              </div>
            }
          />
          <Row label="Microphone" sub="For voice input" right={<StatusBadge ok label="Enabled" />} />
        </Section>

        {/* About */}
        <Section icon={<InternetIcon size={12} strokeWidth={1.8} />} title="About">
          {[
            ['Version',   '1.0.0'],
            ['Platform',  isElectron ? 'Desktop (Electron)' : 'Web Preview'],
            ['AI Brain',  getHermesBrainMode() === 'hermes' ? 'Hermes (Backend)' : 'Classic (GPT-4o)'],
            ['STT',       'OpenAI Whisper'],
            ['TTS',       'Deepgram Aura'],
          ].map(([k, v]) => (
            <Row key={k} label={k} right={<span className="text-xs text-white/50 font-mono">{v}</span>} />
          ))}
        </Section>

      </div>
    </div>
  );
}
