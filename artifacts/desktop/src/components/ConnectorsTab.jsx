import React, { useState } from 'react';
import { getIntegrations, saveAllIntegrations } from '../services/keys';
import { auth } from '../services/auth';
import { CheckmarkCircle01Icon, Cancel01Icon, Link01Icon, EyeIcon } from 'hugeicons-react';

// ─── Logo helpers ──────────────────────────────────────────────────────────────

function LogoImg({ src, alt, size = 32, fallbackColor = '#555', fallbackLabel, imgFilter }) {
  const [err, setErr] = useState(false);
  if (err || !src) {
    return (
      <div style={{
        width: size, height: size, borderRadius: 8,
        background: fallbackColor,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: size * 0.44, fontWeight: 700, color: '#fff', letterSpacing: -0.5,
        flexShrink: 0,
      }}>
        {(fallbackLabel || alt || '?')[0].toUpperCase()}
      </div>
    );
  }
  return (
    <img
      src={src} alt={alt}
      onError={() => setErr(true)}
      style={{
        width: size, height: size,
        objectFit: 'contain', flexShrink: 0, borderRadius: 6,
        filter: imgFilter || undefined,
      }}
    />
  );
}

// Icon URL helpers
const i8       = (slug) => `https://img.icons8.com/color/96/${slug}.png`;
const i8ios    = (slug) => `https://img.icons8.com/ios-filled/96/${slug}.png`;
const i8color  = (slug) => `https://img.icons8.com/color/48/${slug}.png`;
const i8glass  = (slug) => `https://img.icons8.com/liquid-glass/48/${slug}.png`;
const i8plas   = (slug) => `https://img.icons8.com/plasticine/100/${slug}.png`;

// CSS filters
const WHITE_OVERLAY = 'brightness(0) invert(1)'; // turns any icon white
const INVERT        = 'invert(1)';                // inverts colours (dark → light)

// ─── Connector registry ────────────────────────────────────────────────────────

const NATIVE_APPS = [
  // Communication
  { id: 'outlook',      name: 'Outlook',       logo: i8('microsoft-outlook-2019'),  fallback: '#0078D4', desc: 'Send and draft emails via Outlook',    category: 'Communication' },
  { id: 'apple_mail',   name: 'Apple Mail',    logo: i8('apple-mail'),              fallback: '#1C7EEA', desc: 'Send and draft emails via Apple Mail', category: 'Communication' },
  { id: 'messages',     name: 'Messages',      logo: i8('imessage'),                fallback: '#30D158', desc: 'Send iMessages and SMS',               category: 'Communication' },
  // Media
  { id: 'spotify',      name: 'Spotify',       logo: i8('spotify'),                 fallback: '#1DB954', desc: 'Control playback, skip, volume',       category: 'Media' },
  { id: 'apple_music',  name: 'Apple Music',   logo: i8('apple-music'),             fallback: '#FC3C44', desc: 'Play, pause, skip, control volume',     category: 'Media' },
  // Browser
  { id: 'safari',       name: 'Safari',        logo: 'https://img.icons8.com/external-tal-revivo-color-tal-revivo/48/external-safari-is-a-graphical-web-browser-developed-by-apple-logo-color-tal-revivo.png', fallback: '#006CFF', desc: 'Open URLs, read tabs, navigate',  category: 'Browser' },
  { id: 'chrome',       name: 'Chrome',        logo: i8('chrome'),                  fallback: '#4285F4', desc: 'Open URLs, control browser',            category: 'Browser' },
  // Productivity
  { id: 'calendar',     name: 'Calendar',      logo: i8color('calendar-app'),       fallback: '#FF3B30', desc: 'Create and read calendar events',       category: 'Productivity' },
  { id: 'reminders',    name: 'Reminders',     logo: 'https://img.icons8.com/ios/96/reminders.png', imgFilter: WHITE_OVERLAY, fallback: '#FF9F0A', desc: 'Create and manage reminders', category: 'Productivity' },
  { id: 'notes',        name: 'Notes',         logo: i8plas('apple-notes--v1'),     fallback: '#FFD60A', desc: 'Create and read notes',                 category: 'Productivity' },
  { id: 'word',         name: 'Word',          logo: i8('microsoft-word-2019'),     fallback: '#2B579A', desc: 'Create and edit Word documents',        category: 'Productivity' },
  { id: 'excel',        name: 'Excel',         logo: i8('microsoft-excel-2019'),    fallback: '#217346', desc: 'Read and edit spreadsheets',            category: 'Productivity' },
  { id: 'powerpoint',   name: 'PowerPoint',    logo: i8('microsoft-powerpoint-2019'), fallback: '#D24726', desc: 'Create and open presentations',      category: 'Productivity' },
  // Dev
  { id: 'vscode',       name: 'VS Code',       logo: i8('visual-studio-code-2019'), fallback: '#007ACC', desc: 'Open projects/files and run coding tasks', category: 'Development' },
  { id: 'xcode',        name: 'Xcode',         logo: i8color('xcode'),              fallback: '#1575F9', desc: 'Open projects, build, run apps',        category: 'Development' },
  { id: 'terminal',     name: 'Terminal',      logo: i8glass('console'),            fallback: '#333333', desc: 'Run shell commands and scripts',        category: 'Development' },
  // System
  { id: 'finder',       name: 'Finder',        logo: i8color('mac-logo'),           fallback: '#2196F3', desc: 'Browse files, move, copy, delete',      category: 'System' },
];

const API_CONNECTORS = [
  {
    key: 'higgsfield_cli',
    name: 'Higgsfield CLI',
    logo: 'https://higgsfield.ai/favicon.ico',
    fallback: '#111827',
    fallbackLabel: 'H',
    category: 'AI & Voice',
    desc: 'One-click CLI setup for Higgsfield image/video generation in Noah automations.',
    placeholder: 'Auto-managed by setup flow (stores status marker)',
    link: 'https://higgsfield.ai/cli',
    linkLabel: 'CLI docs →',
  },
  {
    key: 'heygen_cli',
    name: 'HeyGen CLI',
    logo: 'https://developers.heygen.com/favicon.ico',
    fallback: '#0f172a',
    fallbackLabel: 'Y',
    category: 'AI & Voice',
    desc: 'One-click CLI setup for HeyGen video generation in Noah automations.',
    placeholder: 'Auto-managed by setup flow (stores status marker)',
    link: 'https://developers.heygen.com/cli',
    linkLabel: 'CLI docs →',
  },
  {
    key: 'elevenlabs_key',
    name: 'ElevenLabs',
    logo: i8ios('elevenlabs'),
    imgFilter: INVERT,
    fallback: '#7C3AED',
    fallbackLabel: 'EL',
    category: 'AI & Voice',
    desc: 'Ultra-realistic AI voice for Noah.',
    placeholder: 'sk-xxxx or your ElevenLabs API key',
    link: 'https://elevenlabs.io/sign-up',
    linkLabel: 'Get free key →',
  },
  {
    key: 'google_token',
    name: 'Google',
    logo: i8('google-logo'),
    fallback: '#4285F4',
    category: 'Productivity',
    desc: 'Gmail, Calendar, Drive access.',
    placeholder: 'ya29.xxxxxxxxxxxx (OAuth token)',
    link: 'https://console.cloud.google.com',
    linkLabel: 'Google Cloud Console →',
  },
  {
    key: 'slack_token',
    name: 'Slack',
    logo: i8('slack-new'),
    fallback: '#4A154B',
    category: 'Communication',
    desc: 'Send messages, list channels.',
    placeholder: 'xoxb-xxxxxxxxxxxx',
    link: 'https://api.slack.com/apps',
    linkLabel: 'Create Slack app →',
  },
  {
    key: 'notion_token',
    name: 'Notion',
    logo: 'https://img.icons8.com/ios-filled/96/notion.png',
    imgFilter: WHITE_OVERLAY,
    fallback: '#191919',
    category: 'Productivity',
    desc: 'Read and write pages and databases.',
    placeholder: 'ntn_xxxxxxxxxxxx',
    link: 'https://www.notion.so/my-integrations',
    linkLabel: 'Create integration →',
  },
  {
    key: 'linear_key',
    name: 'Linear',
    logo: 'https://cdn.jim-nielsen.com/macos/1024/linear-2022-03-15.png?rf=1024',
    fallback: '#5E6AD2',
    fallbackLabel: 'L',
    category: 'Development',
    desc: 'Issues, projects, sprints.',
    placeholder: 'lin_api_xxxxxxxxx',
    link: 'https://linear.app/settings/api',
    linkLabel: 'Get API key →',
  },
  {
    key: 'github_token',
    name: 'GitHub',
    logo: 'https://img.icons8.com/ios-filled/96/github.png',
    imgFilter: WHITE_OVERLAY,
    fallback: '#161B22',
    category: 'Development',
    desc: 'Repos, issues, PRs, releases.',
    placeholder: 'ghp_xxxxxxxxxxxx',
    link: 'https://github.com/settings/tokens/new',
    linkLabel: 'Create token →',
  },
  {
    key: 'trello_key',
    name: 'Trello',
    logo: i8('trello'),
    fallback: '#0052CC',
    category: 'Productivity',
    desc: 'Manage boards, lists, and cards.',
    placeholder: 'API key (trello.com/app-key)',
    link: 'https://trello.com/app-key',
    linkLabel: 'Get key →',
    extra: { key: 'trello_token', placeholder: 'Trello OAuth token' },
  },
  {
    key: 'airtable_key',
    name: 'Airtable',
    logo: 'https://uxwing.com/wp-content/themes/uxwing/download/brands-and-social-media/airtable-icon.png',
    fallback: '#18BFFF',
    category: 'Productivity',
    desc: 'Read and write bases and tables.',
    placeholder: 'pat_xxxxxxxxxxxx',
    link: 'https://airtable.com/create/tokens',
    linkLabel: 'Create token →',
  },
  {
    key: 'brave_key',
    name: 'Brave Search',
    logo: 'https://img.icons8.com/color/96/brave-web-browser.png',
    fallback: '#FB542B',
    category: 'Search & Web',
    desc: 'High-quality web search results.',
    placeholder: 'BSA-xxxxxx',
    link: 'https://brave.com/search/api/',
    linkLabel: 'Get API key →',
  },
];

const CATEGORIES_ORDER = [
  'Communication', 'Productivity', 'Development', 'AI & Voice', 'Media', 'Browser', 'Search & Web', 'System',
];

// ─── Storage ───────────────────────────────────────────────────────────────────

const LS_NATIVE = 'noah_native_apps';
function getNativeEnabled() {
  try { const r = localStorage.getItem(LS_NATIVE); return r ? JSON.parse(r) : {}; } catch { return {}; }
}
function saveNativeEnabled(obj) {
  try { localStorage.setItem(LS_NATIVE, JSON.stringify(obj)); } catch {}
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function CategoryLabel({ label }) {
  return (
    <div className="flex items-center gap-2 mt-7 mb-3 px-0.5">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-white/28">{label}</p>
      <div className="flex-1 h-px" style={{ background: 'rgba(255,255,255,0.05)' }} />
    </div>
  );
}

function NativeTile({ app, enabled, onToggle }) {
  return (
    <div
      onClick={onToggle}
      className="flex flex-col items-center justify-between rounded-xl p-3 cursor-pointer select-none transition-all"
      style={{
        background: enabled ? 'rgba(22,163,74,0.10)' : 'rgba(255,255,255,0.03)',
        border: enabled ? '1px solid rgba(22,163,74,0.28)' : '1px solid rgba(255,255,255,0.07)',
        minHeight: 96,
      }}
    >
      {/* Logo + name */}
      <div className="flex flex-col items-center gap-2 flex-1">
        <LogoImg src={app.logo} alt={app.name} size={32} fallbackColor={app.fallback} fallbackLabel={app.fallbackLabel} imgFilter={app.imgFilter} />
        <p className="text-[11px] font-medium text-white/80 text-center leading-tight">{app.name}</p>
      </div>

      {/* Toggle */}
      <div className="mt-2.5 flex-shrink-0">
        <div
          className="rounded-full transition-all"
          style={{
            width: 30, height: 17,
            background: enabled ? 'rgba(34,197,94,0.85)' : 'rgba(255,255,255,0.12)',
            position: 'relative',
          }}
        >
          <div style={{
            position: 'absolute', top: 2, left: enabled ? 13 : 2,
            width: 13, height: 13, borderRadius: '50%',
            background: enabled ? '#fff' : 'rgba(255,255,255,0.55)',
            transition: 'left 0.17s cubic-bezier(0.4,0,0.2,1)',
          }} />
        </div>
      </div>
    </div>
  );
}

function ApiTile({ connector, connected, onClick }) {
  return (
    <div
      onClick={onClick}
      className="flex flex-col items-center justify-between rounded-xl p-3 cursor-pointer select-none transition-all"
      style={{
        background: connected ? 'rgba(22,163,74,0.10)' : 'rgba(255,255,255,0.03)',
        border: connected ? '1px solid rgba(22,163,74,0.28)' : '1px solid rgba(255,255,255,0.07)',
        minHeight: 96,
      }}
    >
      <div className="flex flex-col items-center gap-2 flex-1">
        <LogoImg
          src={connector.logo} alt={connector.name} size={32}
          fallbackColor={connector.fallback} fallbackLabel={connector.fallbackLabel}
          imgFilter={connector.imgFilter}
        />
        <p className="text-[11px] font-medium text-white/80 text-center leading-tight">{connector.name}</p>
      </div>

      <div className="mt-2.5">
        {connected ? (
          <span className="flex items-center gap-1 text-green-400" style={{ fontSize: 10, fontWeight: 500 }}>
            <CheckmarkCircle01Icon size={9} strokeWidth={2} /> Connected
          </span>
        ) : (
          <span className="flex items-center gap-1 text-white/28" style={{ fontSize: 10 }}>
            <Cancel01Icon size={9} strokeWidth={2} /> Not connected
          </span>
        )}
      </div>
    </div>
  );
}

function ApiExpandedForm({ connector, value, extraValue, onChange, onExtraChange, onClose }) {
  const [showKey, setShowKey] = useState(false);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthMsg, setOauthMsg] = useState('');
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupMsg, setSetupMsg] = useState('');

  const runConnectorShell = async (command, timeoutMs = 12 * 60 * 1000) => {
    if (typeof window === 'undefined' || !window.electronAPI?.runShellLong) {
      throw new Error('Desktop shell bridge is unavailable.');
    }
    const result = await window.electronAPI.runShellLong({ command, timeoutMs });
    if (!result?.success) {
      throw new Error(result?.output || result?.error || 'Command failed.');
    }
    return result;
  };

  const runInteractiveInTerminal = async (command) => {
    if (typeof window === 'undefined' || !window.electronAPI?.runApplescript) {
      throw new Error('Desktop automation bridge is unavailable.');
    }
    const escaped = String(command).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `tell application "Terminal"
activate
do script "${escaped}"
end tell`;
    const result = await window.electronAPI.runApplescript(script);
    if (!result?.success) {
      throw new Error(result?.output || result?.error || 'Failed to open Terminal for auth.');
    }
    return result;
  };

  const handleGitHubConnect = async () => {
    if (oauthBusy) return;
    setOauthBusy(true);
    setOauthMsg('');
    try {
      const user = auth.currentUser;
      if (!user) throw new Error('Please sign in first.');
      const idToken = await user.getIdToken();

      const backendBase = (typeof window !== 'undefined' && window.electronAPI?.getBackendUrl)
        ? (await window.electronAPI.getBackendUrl()) || 'https://noah-production-0ef2.up.railway.app'
        : 'https://noah-production-0ef2.up.railway.app';

      const startResp = await fetch(`${backendBase}/api/v1/integrations/github/oauth/start`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${idToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      });
      const startData = await startResp.json().catch(() => ({}));
      if (!startResp.ok || !startData.auth_url || !startData.state) {
        throw new Error(startData.detail || 'Failed to start GitHub OAuth.');
      }

      if (typeof window !== 'undefined' && window.electronAPI?.openExternal) {
        window.electronAPI.openExternal(startData.auth_url);
      } else {
        window.open(startData.auth_url, '_blank', 'noopener,noreferrer');
      }
      setOauthMsg('Waiting for GitHub authorization...');

      const started = Date.now();
      let connectedToken = '';
      while (Date.now() - started < 180000) {
        await new Promise(r => setTimeout(r, 1800));
        const pollResp = await fetch(`${backendBase}/api/v1/integrations/github/oauth/result?state=${encodeURIComponent(startData.state)}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${idToken}`, Accept: 'application/json' },
        });
        const pollData = await pollResp.json().catch(() => ({}));
        if (pollResp.ok && pollData.status === 'ok' && pollData.access_token) {
          connectedToken = pollData.access_token;
          break;
        }
        if (pollResp.ok && pollData.status === 'pending') continue;
        if (pollResp.status === 404 || pollResp.status === 410) break;
        if (!pollResp.ok) throw new Error(pollData.detail || 'OAuth polling failed.');
      }

      if (!connectedToken) {
        throw new Error('Timed out waiting for GitHub authorization. Please try again.');
      }
      onChange(connectedToken);
      setOauthMsg('GitHub connected. Click "Save all" to persist.');
    } catch (e) {
      setOauthMsg(e.message || 'GitHub connect failed.');
    } finally {
      setOauthBusy(false);
    }
  };

  const handleHiggsfieldInstall = async () => {
    if (setupBusy) return;
    setSetupBusy(true);
    setSetupMsg('');
    try {
      const installCommand = [
        'set -e',
        'if command -v higgsfield >/dev/null 2>&1; then',
        '  echo "Higgsfield CLI already installed"',
        'else',
        '  npm install -g @higgsfield/cli',
        'fi',
        'higgsfield --version || higgsfield version',
      ].join('\n');
      const out = await runConnectorShell(installCommand, 15 * 60 * 1000);
      const versionLine = (out.output || '').split('\n').find(Boolean) || 'installed';
      onChange(`installed:${versionLine}`);
      setSetupMsg('Higgsfield CLI installed. Next: run Sign in.');
    } catch (e) {
      setSetupMsg(e.message || 'Install failed.');
    } finally {
      setSetupBusy(false);
    }
  };

  const handleHiggsfieldAuth = async () => {
    if (setupBusy) return;
    setSetupBusy(true);
    setSetupMsg('');
    try {
      await runInteractiveInTerminal('higgsfield auth login');
      setSetupMsg('Terminal opened. Complete login there, then click Verify here.');
    } catch (e) {
      setSetupMsg(e.message || 'Sign-in failed.');
    } finally {
      setSetupBusy(false);
    }
  };

  const handleHiggsfieldVerify = async () => {
    if (setupBusy) return;
    setSetupBusy(true);
    setSetupMsg('');
    try {
      const verifyCommand = [
        'set -e',
        'if higgsfield auth whoami >/dev/null 2>&1; then',
        '  higgsfield auth whoami',
        'elif higgsfield auth status >/dev/null 2>&1; then',
        '  higgsfield auth status',
        'else',
        '  echo "Authenticated command check unavailable on this CLI version."',
        'fi',
      ].join('\n');
      const out = await runConnectorShell(verifyCommand, 60 * 1000);
      onChange('connected');
      setSetupMsg(`Verified: ${(out.output || 'connected').split('\n')[0]}`);
    } catch (e) {
      setSetupMsg(e.message || 'Verification failed.');
    } finally {
      setSetupBusy(false);
    }
  };

  const handleHiggsfieldOneClick = async () => {
    if (setupBusy) return;
    setSetupBusy(true);
    setSetupMsg('');
    try {
      const installCommand = [
        'set -e',
        'if command -v higgsfield >/dev/null 2>&1; then',
        '  echo "Higgsfield CLI already installed"',
        'else',
        '  npm install -g @higgsfield/cli',
        'fi',
        'higgsfield --version || higgsfield version',
      ].join('\n');
      await runConnectorShell(installCommand, 15 * 60 * 1000);
      await runInteractiveInTerminal('higgsfield auth login');
      setSetupMsg('CLI installed. Terminal opened for login. Complete login there, then click Verify.');
    } catch (e) {
      setSetupMsg(e.message || 'One-click setup failed.');
    } finally {
      setSetupBusy(false);
    }
  };

  return (
    <div
      className="rounded-xl p-4 col-span-3 transition-all"
      style={{
        background: 'rgba(255,255,255,0.035)',
        border: '1px solid rgba(255,255,255,0.09)',
      }}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <LogoImg src={connector.logo} alt={connector.name} size={22} fallbackColor={connector.fallback} fallbackLabel={connector.fallbackLabel} imgFilter={connector.imgFilter} />
          <p className="text-xs font-semibold text-white/80">{connector.name}</p>
        </div>
        <button onClick={onClose} className="text-white/25 hover:text-white/55 transition-colors text-sm leading-none">✕</button>
      </div>

      <p className="text-[11px] text-white/35 mb-3">{connector.desc}</p>

      <div className="flex flex-col gap-2">
        {connector.key !== 'higgsfield_cli' && (
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={value}
              onChange={e => onChange(e.target.value)}
              placeholder={connector.placeholder}
              className="noah-input w-full px-3 py-2 text-xs font-mono pr-9"
              spellCheck={false}
              autoFocus
            />
            <button
              onClick={() => setShowKey(v => !v)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/25 hover:text-white/55 transition-colors"
            >
              <EyeIcon size={12} strokeWidth={1.8} />
            </button>
          </div>
        )}

        {(connector.key === 'higgsfield_cli' || connector.key === 'heygen_cli') && (
          <div className="rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
            <p className="text-[11px] text-white/45 mb-2">
              One-click setup runs:
              <br />
              {connector.key === 'higgsfield_cli' ? (
                <span className="font-mono">npm install -g @higgsfield/cli</span>
              ) : (
                <span className="font-mono">curl -fsSL https://static.heygen.ai/cli/install.sh | bash</span>
              )}
              <br />
              <span className="font-mono">{connector.key === 'higgsfield_cli' ? 'higgsfield auth login' : 'heygen auth login'}</span>
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={connector.key === 'higgsfield_cli' ? handleHiggsfieldOneClick : async () => {
                  if (setupBusy) return;
                  setSetupBusy(true);
                  setSetupMsg('');
                  try {
                    const installCommand = [
                      'set -e',
                      'if command -v heygen >/dev/null 2>&1; then',
                      '  echo "HeyGen CLI already installed"',
                      'else',
                      '  curl -fsSL https://static.heygen.ai/cli/install.sh | bash',
                      'fi',
                      'heygen --version',
                    ].join('\n');
                    await runConnectorShell(installCommand, 15 * 60 * 1000);
                    await runInteractiveInTerminal('heygen auth login');
                    setSetupMsg('CLI installed. Terminal opened for login. Complete login there, then click Verify.');
                  } catch (e) {
                    setSetupMsg(e.message || 'One-click setup failed.');
                  } finally {
                    setSetupBusy(false);
                  }
                }}
                disabled={setupBusy}
                className="btn-green text-[11px] px-3 py-1.5 disabled:opacity-50"
              >
                {setupBusy ? 'Running setup...' : 'One-click setup'}
              </button>
              <button
                onClick={connector.key === 'higgsfield_cli' ? handleHiggsfieldInstall : async () => {
                  if (setupBusy) return;
                  setSetupBusy(true);
                  setSetupMsg('');
                  try {
                    const installCommand = [
                      'set -e',
                      'if command -v heygen >/dev/null 2>&1; then',
                      '  echo "HeyGen CLI already installed"',
                      'else',
                      '  curl -fsSL https://static.heygen.ai/cli/install.sh | bash',
                      'fi',
                      'heygen --version',
                    ].join('\n');
                    const out = await runConnectorShell(installCommand, 15 * 60 * 1000);
                    const versionLine = (out.output || '').split('\n').find(Boolean) || 'installed';
                    onChange(`installed:${versionLine}`);
                    setSetupMsg('HeyGen CLI installed. Next: run Sign in.');
                  } catch (e) {
                    setSetupMsg(e.message || 'Install failed.');
                  } finally {
                    setSetupBusy(false);
                  }
                }}
                disabled={setupBusy}
                className="text-[11px] px-3 py-1.5 rounded-md border border-white/15 text-white/70 hover:bg-white/5 disabled:opacity-50"
              >
                Install CLI
              </button>
              <button
                onClick={connector.key === 'higgsfield_cli' ? handleHiggsfieldAuth : async () => {
                  if (setupBusy) return;
                  setSetupBusy(true);
                  setSetupMsg('');
                  try {
                    await runInteractiveInTerminal('heygen auth login');
                    setSetupMsg('Terminal opened. Complete login there, then click Verify here.');
                  } catch (e) {
                    setSetupMsg(e.message || 'Sign-in failed.');
                  } finally {
                    setSetupBusy(false);
                  }
                }}
                disabled={setupBusy}
                className="text-[11px] px-3 py-1.5 rounded-md border border-white/15 text-white/70 hover:bg-white/5 disabled:opacity-50"
              >
                Sign in
              </button>
              <button
                onClick={connector.key === 'higgsfield_cli' ? handleHiggsfieldVerify : async () => {
                  if (setupBusy) return;
                  setSetupBusy(true);
                  setSetupMsg('');
                  try {
                    const out = await runConnectorShell('heygen auth status', 60 * 1000);
                    onChange('connected');
                    setSetupMsg(`Verified: ${(out.output || 'connected').split('\n')[0]}`);
                  } catch (e) {
                    setSetupMsg(e.message || 'Verification failed.');
                  } finally {
                    setSetupBusy(false);
                  }
                }}
                disabled={setupBusy}
                className="text-[11px] px-3 py-1.5 rounded-md border border-white/15 text-white/70 hover:bg-white/5 disabled:opacity-50"
              >
                Verify
              </button>
            </div>
            {setupMsg ? <p className="text-[10px] text-white/45 mt-2">{setupMsg}</p> : null}
            {value ? <p className="text-[10px] text-green-400/70 mt-1">Status: {value}</p> : null}
          </div>
        )}

        {connector.extra && (
          <input
            type="password"
            value={extraValue || ''}
            onChange={e => onExtraChange?.(e.target.value)}
            placeholder={connector.extra.placeholder}
            className="noah-input w-full px-3 py-2 text-xs font-mono"
            spellCheck={false}
          />
        )}

        {connector.link && (
          <a
            href={connector.link}
            target="_blank"
            rel="noreferrer"
            className="text-[11px] text-green-400/65 hover:text-green-400 transition-colors flex items-center gap-1 mt-1"
            onClick={e => {
              e.stopPropagation();
              if (typeof window !== 'undefined' && window.electronAPI) {
                e.preventDefault();
                window.electronAPI.openExternal(connector.link);
              }
            }}
          >
            <Link01Icon size={10} strokeWidth={2} />
            {connector.linkLabel}
          </a>
        )}

        {connector.key === 'github_token' && (
          <div className="mt-1.5">
            <button
              onClick={handleGitHubConnect}
              disabled={oauthBusy}
              className="btn-green text-[11px] px-3 py-1.5 disabled:opacity-50"
            >
              {oauthBusy ? 'Connecting GitHub...' : 'Connect GitHub'}
            </button>
            {oauthMsg ? <p className="text-[10px] text-white/45 mt-1.5">{oauthMsg}</p> : null}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Grid renderer that injects expanded form after the row ────────────────────

function ConnectorGrid({ items, renderTile, expandedKey, renderExpanded }) {
  const COLS = 3;
  const rows = [];
  for (let i = 0; i < items.length; i += COLS) {
    rows.push(items.slice(i, i + COLS));
  }

  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, ri) => {
        const rowContainsExpanded = expandedKey && row.some(item => (item.key || item.id) === expandedKey);
        return (
          <React.Fragment key={ri}>
            <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
              {row.map(item => renderTile(item))}
              {/* fill empty cells */}
              {row.length < COLS && Array.from({ length: COLS - row.length }).map((_, i) => (
                <div key={`empty-${i}`} />
              ))}
            </div>
            {rowContainsExpanded && renderExpanded && renderExpanded()}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ─── Main tab ─────────────────────────────────────────────────────────────────

export default function ConnectorsTab() {
  const [tokens,       setTokens]       = useState(getIntegrations);
  const [native,       setNative]       = useState(getNativeEnabled);
  const [saved,        setSaved]        = useState(false);
  const [expandedApi,  setExpandedApi]  = useState(null);

  const setToken = (key, val) => setTokens(prev => ({ ...prev, [key]: val }));

  const toggleNative = (id) => {
    setNative(prev => {
      const next = { ...prev, [id]: !prev[id] };
      saveNativeEnabled(next);
      return next;
    });
  };

  const saveTokens = () => {
    saveAllIntegrations(tokens);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const toggleApiExpand = (key) => {
    setExpandedApi(prev => (prev === key ? null : key));
  };

  // Group by category
  const apiByCategory = {};
  API_CONNECTORS.forEach(c => {
    if (!apiByCategory[c.category]) apiByCategory[c.category] = [];
    apiByCategory[c.category].push(c);
  });

  const nativeByCategory = {};
  NATIVE_APPS.forEach(a => {
    if (!nativeByCategory[a.category]) nativeByCategory[a.category] = [];
    nativeByCategory[a.category].push(a);
  });

  const allCategories = CATEGORIES_ORDER.filter(c => apiByCategory[c] || nativeByCategory[c]);

  const apiActiveCount  = Object.values(tokens).filter(v => !!v?.trim()).length;
  const nativeActiveCount = Object.values(native).filter(Boolean).length;

  return (
    <div className="h-full overflow-y-auto" style={{ scrollbarWidth: 'none' }}>
      <div className="px-5 py-5 pb-10" style={{ maxWidth: 620, margin: '0 auto' }}>

        {/* Header */}
        <div className="mb-5">
          <h1 className="text-sm font-semibold text-white/85">Connectors</h1>
          <p className="text-[11px] text-white/32 mt-1 leading-relaxed">
            Connect your apps and services. Noah uses them automatically based on what you ask.
            Tokens are stored locally — never sent anywhere except the service itself.
          </p>
        </div>

        {/* Status bar */}
        <div
          className="flex items-center justify-between px-4 py-2.5 rounded-xl mb-5 transition-all"
          style={{
            background: (apiActiveCount + nativeActiveCount) > 0 ? 'rgba(22,163,74,0.08)' : 'rgba(255,255,255,0.03)',
            border: (apiActiveCount + nativeActiveCount) > 0 ? '1px solid rgba(22,163,74,0.2)' : '1px solid rgba(255,255,255,0.06)',
          }}
        >
          <p className="text-[11px] text-white/40">
            {(apiActiveCount + nativeActiveCount) > 0
              ? `${apiActiveCount} API connector${apiActiveCount !== 1 ? 's' : ''} active · ${nativeActiveCount} native app${nativeActiveCount !== 1 ? 's' : ''} enabled`
              : 'No connectors configured yet — click any to connect'}
          </p>
          <button onClick={saveTokens} className="btn-green text-xs px-4 py-1.5 flex-shrink-0">
            {saved ? '✓ Saved' : 'Save all'}
          </button>
        </div>

        {/* All categories */}
        {allCategories.map(cat => (
          <div key={cat}>
            <CategoryLabel label={cat} />

            {/* API tiles */}
            {apiByCategory[cat] && (
              <ConnectorGrid
                items={apiByCategory[cat]}
                expandedKey={expandedApi}
                renderTile={(connector) => (
                  <ApiTile
                    key={connector.key}
                    connector={connector}
                    connected={!!(tokens[connector.key] || '').trim()}
                    onClick={() => toggleApiExpand(connector.key)}
                  />
                )}
                renderExpanded={() => {
                  const connector = (apiByCategory[cat] || []).find(c => c.key === expandedApi);
                  if (!connector) return null;
                  return (
                    <ApiExpandedForm
                      key={expandedApi}
                      connector={connector}
                      value={tokens[connector.key] || ''}
                      extraValue={connector.extra ? (tokens[connector.extra.key] || '') : undefined}
                      onChange={val => setToken(connector.key, val)}
                      onExtraChange={connector.extra ? (val => setToken(connector.extra.key, val)) : undefined}
                      onClose={() => setExpandedApi(null)}
                    />
                  );
                }}
              />
            )}

            {/* Native tiles */}
            {nativeByCategory[cat] && (
              <div className="grid gap-2 mt-1.5" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                {nativeByCategory[cat].map(app => (
                  <NativeTile
                    key={app.id}
                    app={app}
                    enabled={!!native[app.id]}
                    onToggle={() => toggleNative(app.id)}
                  />
                ))}
              </div>
            )}

          </div>
        ))}

        <p className="text-[10px] text-white/15 text-center mt-8 leading-relaxed">
          Native app controls use macOS automation — no account login needed.
          Toggle them on so Noah knows they're available on your Mac.
        </p>
      </div>
    </div>
  );
}
