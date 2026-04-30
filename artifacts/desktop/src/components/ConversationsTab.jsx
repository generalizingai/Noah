import React, { useState, useEffect } from 'react';
import { getAllConversations, deleteConversation, clearAllConversations } from '../services/conversations';
import { Message01Icon, Delete02Icon, Archive01Icon, ArrowRight01Icon } from 'hugeicons-react';

export default function ConversationsTab({ onRestore, visible }) {
  const [conversations, setConversations] = useState([]);
  const [selected, setSelected] = useState(null);

  const reload = () => setConversations(getAllConversations());

  // Reload every time the tab becomes visible (it stays mounted with display:none)
  useEffect(() => { if (visible !== false) reload(); }, [visible]);

  const handleDelete = (e, id) => {
    e.stopPropagation();
    deleteConversation(id);
    if (selected?.id === id) setSelected(null);
    reload();
  };

  const handleClear = () => {
    if (confirm('Delete all saved conversations?')) { clearAllConversations(); setSelected(null); reload(); }
  };

  const fmt = (ts) => {
    const d = new Date(ts);
    const now = new Date();
    const diffH = (now - d) / 3600000;
    if (diffH < 24) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (diffH < 48) return 'Yesterday';
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  // ── Detail view ──────────────────────────────────────────────────────────────
  if (selected) {
    const msgs = selected.messages || [];
    return (
      <div className="flex flex-col h-full">
        <div className="px-5 py-4 flex-shrink-0 flex items-center gap-3"
          style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <button onClick={() => setSelected(null)} className="btn-ghost px-3 py-1.5 text-xs">← Back</button>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-white/80 truncate">{selected.preview}</p>
            <p className="text-[10px] text-white/30">{fmt(selected.created_at)} · {msgs.length} messages</p>
          </div>
          {onRestore && (
            <button
              onClick={() => {
                const restored = msgs.map(m => ({ ...m, time: new Date(m.time) }));
                onRestore(restored);
              }}
              className="btn-green px-3 py-1.5 text-xs flex items-center gap-1.5"
            >
              Restore <ArrowRight01Icon size={11} strokeWidth={2} />
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {msgs.map((m, i) => (
            <div key={i} className={`flex gap-3 ${m.role === 'assistant' ? 'justify-start' : 'justify-end'}`}>
              <div
                className={`max-w-[78%] px-4 py-2.5 rounded-2xl text-xs leading-relaxed ${m.role === 'assistant' ? 'msg-noah' : 'msg-user'}`}
                style={m.role === 'assistant' ? { borderTopLeftRadius: 4 } : { borderTopRightRadius: 4 }}
              >
                {m.content}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── List view ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">
      <div className="px-5 py-4 flex-shrink-0 flex items-center justify-between"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <div>
          <h2 className="text-sm font-semibold text-white/85">Conversations</h2>
          <p className="text-[11px] mt-0.5 text-white/30">{conversations.length} saved locally</p>
        </div>
        {conversations.length > 0 && (
          <button onClick={handleClear} className="btn-icon"
            style={{ borderColor: 'rgba(239,68,68,0.2)', color: 'rgba(248,113,113,0.65)' }} title="Clear all">
            <Delete02Icon size={13} strokeWidth={1.8} />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {conversations.length === 0 && (
          <div className="text-center py-14">
            <div className="w-14 h-14 rounded-2xl mx-auto mb-4 flex items-center justify-center"
              style={{ background: 'rgba(22,163,74,0.06)', border: '1px solid rgba(255,255,255,0.07)' }}>
              <Archive01Icon size={22} strokeWidth={1.4} className="text-white/25" />
            </div>
            <p className="text-sm font-medium text-white/50">No saved conversations</p>
            <p className="text-xs mt-1 text-white/25">Use "Save chat" in the assistant tab to save a conversation</p>
          </div>
        )}
        {conversations.map((conv) => (
          <button key={conv.id} onClick={() => setSelected(conv)}
            className="w-full glass-card px-4 py-3.5 text-left flex items-start gap-3 group hover:border-green-500/20 transition-all">
            <Message01Icon size={14} strokeWidth={1.6} className="text-green-400/40 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-white/70 truncate">{conv.preview}</p>
              <p className="text-[10px] text-white/28 mt-0.5">
                {conv.messages?.length || 0} messages · {fmt(conv.created_at)}
              </p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button onClick={e => handleDelete(e, conv.id)}
                className="opacity-0 group-hover:opacity-100 transition-opacity text-white/25 hover:text-red-400">
                <Delete02Icon size={12} strokeWidth={1.8} />
              </button>
              <ArrowRight01Icon size={12} strokeWidth={1.8} className="text-white/18" />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
