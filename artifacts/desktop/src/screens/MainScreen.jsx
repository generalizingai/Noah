import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../services/auth';
import ConversationsTab from '../components/ConversationsTab';
import MemoriesTab from '../components/MemoriesTab';
import SkillsTab from '../components/SkillsTab';
import WorkersTab from '../components/WorkersTab';
import TasksTab from '../components/TasksTab';
import LogsTab from '../components/LogsTab';
import SettingsTab from '../components/SettingsTab';
import AssistantTab from '../components/AssistantTab';
import ConnectorsTab from '../components/ConnectorsTab';
import ToolApprovalModal from '../components/ToolApprovalModal';
import { registerApprovalRequester, unregisterApprovalRequester } from '../services/noahApi';
import { NoahLogo } from '../App';
import {
  AiComputerIcon, Message01Icon, Brain01Icon, Setting06Icon, Link01Icon, FlashIcon, GearsIcon, Clock01Icon,
} from 'hugeicons-react';

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;
const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '');

const TABS = [
  { id: 'assistant',     label: 'Assistant',     Icon: AiComputerIcon },
  { id: 'conversations', label: 'Conversations', Icon: Message01Icon },
  { id: 'memories',      label: 'Memories',      Icon: Brain01Icon },
  { id: 'skills',        label: 'Skills',        Icon: FlashIcon },
  { id: 'workers',       label: 'Workers',       Icon: GearsIcon },
  { id: 'tasks',         label: 'Tasks',         Icon: Clock01Icon },
  { id: 'logs',          label: 'Logs',          Icon: Message01Icon },
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
    <div className="flex h-screen app-bg overflow-hidden">
      {/* Sidebar */}
      <aside
        className="flex flex-col flex-shrink-0"
        style={{
          width: 228,
          borderRight: '1px solid rgba(255,255,255,0.06)',
          background: 'rgba(6,14,9,0.92)',
          backdropFilter: 'blur(24px)',
          WebkitBackdropFilter: 'blur(24px)',
          WebkitAppRegion: isElectron ? 'drag' : undefined,
        }}
      >
        <div
          className="flex items-center gap-2"
          style={{
            paddingLeft: isElectron && isMac ? 22 : 16,
            paddingRight: 16,
            paddingTop: isElectron && isMac ? 64 : 16,
            paddingBottom: isElectron && isMac ? 16 : 14,
            marginBottom: isElectron && isMac ? 14 : 8,
            WebkitAppRegion: isElectron ? 'drag' : undefined,
          }}
        >
          <NoahLogo size={22} />
          <span className="text-sm font-semibold tracking-tight text-white/75">Noah</span>
        </div>
        <div className="px-3 pb-3 space-y-1 overflow-y-auto" style={{ WebkitAppRegion: 'no-drag' }}>
          {TABS.map(({ id, label, Icon }) => {
            const active = activeTab === id;
            return (
              <button key={id} onClick={() => setActiveTab(id)} className={`nav-item ${active ? 'active' : ''}`}>
                <Icon size={14} strokeWidth={1.8} />
                <span>{label}</span>
              </button>
            );
          })}
        </div>
        <div className="mt-auto px-4 py-3" style={{ WebkitAppRegion: 'no-drag', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <div
            className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-semibold text-green-400"
            style={{ background: 'rgba(22,163,74,0.18)', border: '1px solid rgba(22,163,74,0.28)' }}
            title={user?.email}
          >
            {initials}
          </div>
        </div>
      </aside>

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

        <div style={{ display: activeTab === 'workers' ? 'block' : 'none', height: '100%', overflow: 'hidden' }}>
          <WorkersTab />
        </div>

        <div style={{ display: activeTab === 'tasks' ? 'block' : 'none', height: '100%', overflow: 'hidden' }}>
          <TasksTab />
        </div>

        <div style={{ display: activeTab === 'logs' ? 'block' : 'none', height: '100%', overflow: 'hidden' }}>
          <LogsTab />
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
