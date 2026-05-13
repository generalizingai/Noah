import React, { useState, useEffect } from 'react';
import { useAuth } from '../services/auth';
import { getBackendMemories, createBackendMemory, deleteBackendMemory } from '../services/noahApi';
import { Brain01Icon, Search01Icon, Archive01Icon, Delete02Icon, Add01Icon } from 'hugeicons-react';

export default function MemoriesTab() {
  const { user } = useAuth();
  const [memories, setMemories] = useState([]);
  const [search,   setSearch]   = useState('');
  const [newText,  setNewText]  = useState('');
  const [adding,   setAdding]   = useState(false);
  const [error,    setError]    = useState('');
  const [loading,  setLoading]  = useState(false);

  const reload = async () => {
    if (!user?.getIdToken) return;
    setLoading(true);
    setError('');
    try {
      const token = await user.getIdToken();
      const rows = await getBackendMemories(token, { limit: 5000, offset: 0 });
      setMemories(Array.isArray(rows) ? rows : []);
    } catch (err) {
      setError(err.message || 'Failed to load memories.');
      setMemories([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
    // Poll every 3s so newly saved backend memories appear automatically.
    const interval = setInterval(reload, 3000);
    return () => clearInterval(interval);
  }, [user]);

  const handleDelete = async (id) => {
    if (!user?.getIdToken) return;
    try {
      const token = await user.getIdToken();
      await deleteBackendMemory(id, token);
      await reload();
    } catch (err) {
      setError(err.message || 'Failed to delete memory.');
    }
  };
  const handleAdd    = async () => {
    if (!newText.trim()) return;
    if (!user?.getIdToken) return;
    try {
      const token = await user.getIdToken();
      await createBackendMemory(newText.trim(), token);
      setNewText('');
      setAdding(false);
      await reload();
    } catch (err) {
      setError(err.message || 'Failed to save memory.');
    }
  };

  const filtered = memories.filter(m =>
    !search || String(m.content || '').toLowerCase().includes(search.toLowerCase())
  );

  const fmt = (ts) => new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-5 py-4 flex-shrink-0 flex items-center justify-between"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <div>
          <h2 className="text-sm font-semibold text-white/85">Memories</h2>
          <p className="text-[11px] mt-0.5 text-white/30">{memories.length} things Noah knows about you</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setAdding(v => !v)}
            className="btn-icon" title="Add memory manually">
            <Add01Icon size={13} strokeWidth={1.8} />
          </button>
          <button onClick={reload} className="btn-icon" title="Refresh memories">
            <Archive01Icon size={13} strokeWidth={1.8} />
          </button>
        </div>
      </div>

      {/* Add memory manually */}
      {adding && (
        <div className="px-4 py-3 flex-shrink-0" style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', background: 'rgba(22,163,74,0.04)' }}>
          <p className="text-[10px] text-white/35 mb-2">Add something Noah should remember about you:</p>
          <div className="flex gap-2">
            <input
              type="text"
              value={newText}
              onChange={e => setNewText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleAdd(); if (e.key === 'Escape') setAdding(false); }}
              placeholder="e.g. I prefer dark mode, I'm based in London…"
              autoFocus
              className="noah-input flex-1 px-3 py-2 text-xs"
            />
            <button onClick={handleAdd} disabled={!newText.trim()} className="btn-green px-4 py-2 text-xs">Save</button>
            <button onClick={() => setAdding(false)} className="btn-ghost px-3 py-2 text-xs">Cancel</button>
          </div>
        </div>
      )}

      {/* Search */}
      <div className="px-4 py-3 flex-shrink-0" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
        <div className="relative">
          <Search01Icon size={12} strokeWidth={1.8} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/25 pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search memories…"
            className="noah-input w-full pl-8 pr-4 py-2 text-xs"
          />
        </div>
      </div>

      {/* Explanation banner */}
      {memories.length === 0 && !search && (
        <div className="mx-4 mt-4 p-3.5 rounded-xl flex-shrink-0"
          style={{ background: 'rgba(22,163,74,0.05)', border: '1px solid rgba(22,163,74,0.1)' }}>
          <p className="text-[11px] text-white/45 leading-relaxed">
            Noah automatically learns about you from every conversation: your preferences, working style, interests, and habits.
            These memories are injected into every response so Noah always remembers who you are.
          </p>
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {loading && (
          <p className="text-xs text-white/35 py-2">Loading memories...</p>
        )}
        {error && (
          <p className="text-xs text-red-400 py-2">{error}</p>
        )}
        {!search && filtered.length === 0 && (
          <div className="text-center py-14">
            <div className="w-14 h-14 rounded-2xl mx-auto mb-4 flex items-center justify-center"
              style={{ background: 'rgba(22,163,74,0.06)', border: '1px solid rgba(255,255,255,0.07)' }}>
              <Brain01Icon size={22} strokeWidth={1.4} className="text-white/25" />
            </div>
            <p className="text-sm font-medium text-white/50">No memories yet</p>
            <p className="text-xs mt-1 text-white/25">Have a conversation with Noah and it will start learning about you.</p>
          </div>
        )}
        {search && filtered.length === 0 && (
          <p className="text-xs py-8 text-center text-white/30">No memories match "{search}"</p>
        )}
        {filtered.map((m) => (
          <div key={m.id} className="glass-card p-3.5 flex items-start gap-3 group">
            <div className="flex-1 min-w-0">
              <p className="text-xs leading-relaxed text-white/70">{m.content}</p>
              <p className="text-[10px] mt-1.5 text-white/25">{fmt(m.created_at)}</p>
            </div>
            <button
              onClick={() => handleDelete(m.id)}
              className="opacity-0 group-hover:opacity-100 transition-opacity text-white/25 hover:text-red-400 flex-shrink-0 mt-0.5"
              title="Delete this memory"
            >
              <Delete02Icon size={12} strokeWidth={1.8} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
