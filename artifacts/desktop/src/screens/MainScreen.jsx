import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../services/auth';
import ConversationsTab from '../components/ConversationsTab';
import MemoriesTab from '../components/MemoriesTab';
import SkillsTab from '../components/SkillsTab';
import SettingsTab from '../components/SettingsTab';
import AssistantTab from '../components/AssistantTab';
import ConnectorsTab from '../components/ConnectorsTab';
import ToolApprovalModal from '../components/ToolApprovalModal';
import { registerApprovalRequester, unregisterApprovalRequester } from '../services/noahApi';
import { NoahLogo } from '../App';
import {
  AiComputerIcon, Message01Icon, Brain01Icon, Setting06Icon, Link01Icon, FlashIcon,
} from 'hugeicons-react';

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

const TABS = [
  { id: 'assistant',     label: 'Assistant',     Icon: AiComputerIcon },
  { id: 'conversations', label: 'Conversations', Icon: Message01Icon },
  { id: 'memories',      label: 'Memories',      Icon: Brain01Icon },
  { id: 'skills',        label: 'Skills',         Icon: FlashIcon },
  { id: 'connectors',    label: 'Connectors',    Icon: Link01Icon },
  { id: 'settings',      label: 'Settings',      Icon: Setting06Icon },
];

// Initial welcome message
const WELCOME = [{
  role: 'assistant',
  content: "Hi! I'm Noah, your personal AI assistant. I learn from our conversations and adapt to you. Hold your configured key to talk, or type below. I can control your Mac, search the web, manage files, run commands, and much more.",
  time: new Date(),
}];

export default function MainScreen() {
  const { user }    = useAuth();
  const [activeTab, setActiveTab] = useState('assistant');

  // ─── Lifted chat state — persists across tab switches ──────────────────────
  const [messages, setMessages] = useState(WELCOME);

  // ─── Tool approval modal state ─────────────────────────────────────────────
  const [approvalRequest, setApprovalRequest] = useState(null);
  const approvalResolverRef = useRef(null);

  const requestApproval = useCallback(({ toolName, args }) => {
    return new Promise((resolve) => {
      approvalResolverRef.current = resolve;
      setApprovalRequest({ toolName, args });
    });
  }, []);

  const handleApprove = useCallback(() => {
    setApprovalRequest(null);
    approvalResolverRef.current?.(true);
    approvalResolverRef.current = null;
  }, []);

  const handleCancel = useCallback(() => {
    setApprovalRequest(null);
    approvalResolverRef.current?.(false);
    approvalResolverRef.current = null;
  }, []);

  useEffect(() => {
    registerApprovalRequester(requestApproval);
    return () => unregisterApprovalRequester();
  }, [requestApproval]);

  const initials    = (user?.displayName || user?.email || 'U')[0].toUpperCase();

  return (
    <div className="flex flex-col h-screen app-bg overflow-hidden">
      {/* ── Top bar (drag region for Electron) ──────────────────────── */}
      <div
        className="flex items-center gap-0 flex-shrink-0"
        style={{
          height: 52,
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          background: 'rgba(6,14,9,0.92)',
          backdropFilter: 'blur(24px)',
          WebkitBackdropFilter: 'blur(24px)',
          paddingLeft:  isElectron ? 88 : 16,
          paddingRight: 16,
          // Makes the whole title bar draggable in Electron (move the window by dragging)
          WebkitAppRegion: isElectron ? 'drag' : undefined,
        }}
      >
        {/* Logo + brand — drag area */}
        <div className="flex items-center gap-2 mr-5 flex-shrink-0" style={{ WebkitAppRegion: 'drag', cursor: isElectron ? 'default' : undefined }}>
          <NoahLogo size={22} />
          <span className="text-sm font-semibold tracking-tight text-white/75">Noah</span>
        </div>

        {/* Tab pills — must be no-drag so clicks register */}
        <div className="flex items-center gap-0.5 flex-1" style={{ WebkitAppRegion: 'no-drag' }}>
          {TABS.map(({ id, label, Icon }) => {
            const active = activeTab === id;
            return (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all"
                style={{
                  background: active ? 'rgba(22,163,74,0.14)' : 'transparent',
                  color:      active ? '#4ade80' : 'rgba(228,240,232,0.38)',
                  border:     active ? '1px solid rgba(22,163,74,0.25)' : '1px solid transparent',
                }}
              >
                <Icon size={13} strokeWidth={active ? 2 : 1.6} />
                {label}
              </button>
            );
          })}
        </div>

        {/* User avatar */}
        <div className="flex items-center gap-2 ml-auto flex-shrink-0" style={{ WebkitAppRegion: 'no-drag' }}>
          <div
            className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-semibold text-green-400"
            style={{ background: 'rgba(22,163,74,0.18)', border: '1px solid rgba(22,163,74,0.28)' }}
            title={user?.email}
          >
            {initials}
          </div>
        </div>
      </div>

      {/* ── Tool approval modal — rendered above everything ── */}
      <ToolApprovalModal
        request={approvalRequest}
        onApprove={handleApprove}
        onCancel={handleCancel}
      />

      {/* ── Content ── Keep all tabs mounted; just toggle visibility ── */}
      <div className="flex-1 overflow-hidden relative">
        {/* AssistantTab: always mounted so PTT / recorder / messages survive */}
        <div style={{ display: activeTab === 'assistant' ? 'flex' : 'none', flexDirection: 'column', height: '100%' }}>
          <AssistantTab messages={messages} setMessages={setMessages} />
        </div>

        <div style={{ display: activeTab === 'conversations' ? 'block' : 'none', height: '100%', overflow: 'hidden' }}>
          <ConversationsTab
            visible={activeTab === 'conversations'}
            currentMessages={messages}
            onRestore={(msgs) => { setMessages(msgs); setActiveTab('assistant'); }}
          />
        </div>

        <div style={{ display: activeTab === 'memories' ? 'block' : 'none', height: '100%', overflow: 'hidden' }}>
          <MemoriesTab />
        </div>

        <div style={{ display: activeTab === 'skills' ? 'block' : 'none', height: '100%', overflow: 'hidden' }}>
          <SkillsTab visible={activeTab === 'skills'} />
        </div>

        <div style={{ display: activeTab === 'connectors' ? 'block' : 'none', height: '100%', overflow: 'hidden' }}>
          <ConnectorsTab />
        </div>

        <div style={{ display: activeTab === 'settings' ? 'block' : 'none', height: '100%', overflow: 'hidden' }}>
          <SettingsTab />
        </div>
      </div>
    </div>
  );
}
