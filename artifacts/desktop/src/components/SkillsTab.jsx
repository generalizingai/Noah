import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../services/auth';
import { listSkills, installSkill, deleteSkill, getSkill } from '../services/noahApi';
import {
  FlashIcon, Add01Icon, Delete02Icon, Search01Icon, EyeIcon,
  ArrowLeft01Icon, Download02Icon,
} from 'hugeicons-react';

const CATEGORY_COLORS = {
  marketing:   { bg: 'rgba(168,85,247,0.12)',  border: 'rgba(168,85,247,0.25)', text: '#c084fc' },
  seo:         { bg: 'rgba(59,130,246,0.12)',   border: 'rgba(59,130,246,0.25)',  text: '#60a5fa' },
  writing:     { bg: 'rgba(34,197,94,0.12)',    border: 'rgba(34,197,94,0.25)',   text: '#4ade80' },
  research:    { bg: 'rgba(234,179,8,0.12)',    border: 'rgba(234,179,8,0.25)',   text: '#facc15' },
  productivity:{ bg: 'rgba(249,115,22,0.12)',   border: 'rgba(249,115,22,0.25)',  text: '#fb923c' },
  coding:      { bg: 'rgba(20,184,166,0.12)',   border: 'rgba(20,184,166,0.25)',  text: '#2dd4bf' },
  finance:     { bg: 'rgba(16,185,129,0.12)',   border: 'rgba(16,185,129,0.25)',  text: '#34d399' },
  default:     { bg: 'rgba(255,255,255,0.06)',  border: 'rgba(255,255,255,0.10)', text: 'rgba(255,255,255,0.4)' },
};

function CategoryBadge({ category }) {
  if (!category) return null;
  const key = category.toLowerCase();
  const c = CATEGORY_COLORS[key] || CATEGORY_COLORS.default;
  return (
    <span className="text-[9px] px-1.5 py-0.5 rounded-md font-medium uppercase tracking-wide flex-shrink-0"
      style={{ background: c.bg, border: `1px solid ${c.border}`, color: c.text }}>
      {category}
    </span>
  );
}

function ScopeBadge({ scope }) {
  if (scope === 'shared') {
    return (
      <span className="text-[9px] px-1.5 py-0.5 rounded-md font-medium uppercase tracking-wide"
        style={{ background: 'rgba(22,163,74,0.1)', border: '1px solid rgba(22,163,74,0.2)', color: '#4ade80' }}>
        built-in
      </span>
    );
  }
  return (
    <span className="text-[9px] px-1.5 py-0.5 rounded-md font-medium uppercase tracking-wide"
      style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.3)' }}>
      mine
    </span>
  );
}

function SkillCard({ skill, onDelete, onView }) {
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async (e) => {
    e.stopPropagation();
    if (!confirm(`Remove skill "${skill.name}"?`)) return;
    setDeleting(true);
    try { await onDelete(skill.slug); } finally { setDeleting(false); }
  };

  return (
    <div className="rounded-xl p-3.5 flex flex-col gap-2 cursor-pointer group transition-all duration-150"
      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}
      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)'; }}
      onClick={() => onView(skill)}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 flex-wrap min-w-0">
          <span className="text-[11px] font-semibold text-white/80 truncate">{skill.name || skill.slug}</span>
          <ScopeBadge scope={skill.scope} />
          {skill.category && <CategoryBadge category={skill.category} />}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          <button className="btn-icon w-6 h-6" title="View skill" onClick={e => { e.stopPropagation(); onView(skill); }}>
            <EyeIcon size={10} strokeWidth={1.8} />
          </button>
          {skill.scope === 'user' && (
            <button className="btn-icon w-6 h-6" title="Remove"
              style={{ borderColor: 'rgba(239,68,68,0.2)', color: 'rgba(248,113,113,0.6)' }}
              onClick={handleDelete} disabled={deleting}>
              <Delete02Icon size={10} strokeWidth={1.8} />
            </button>
          )}
        </div>
      </div>
      {skill.description && (
        <p className="text-[10px] text-white/35 leading-relaxed line-clamp-2">{skill.description}</p>
      )}
      {(skill.author || skill.version) && (
        <div className="flex items-center gap-2 text-[9px] text-white/20">
          {skill.author && <span>by {skill.author}</span>}
          {skill.version && <span>v{skill.version}</span>}
        </div>
      )}
    </div>
  );
}

function InstallModal({ onClose, onInstalled, getToken }) {
  const [content, setContent] = useState('');
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState('');

  const handleInstall = async () => {
    if (!content.trim()) return;
    setInstalling(true);
    setError('');
    try {
      const token = await getToken();
      const result = await installSkill(content.trim(), 'user', token);
      onInstalled(result);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-[420px] max-h-[80vh] flex flex-col rounded-2xl overflow-hidden"
        style={{ background: '#151515', border: '1px solid rgba(255,255,255,0.1)' }}>
        <div className="px-5 py-4 flex items-center justify-between flex-shrink-0"
          style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <div>
            <h3 className="text-sm font-semibold text-white/85">Install Skill</h3>
            <p className="text-[10px] text-white/30 mt-0.5">Paste a .md skill file below</p>
          </div>
          <button className="btn-icon" onClick={onClose}><ArrowLeft01Icon size={13} strokeWidth={1.8} /></button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4">
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            placeholder={`---\nname: "my-skill"\ndescription: "What this skill does"\nmetadata:\n  category: productivity\n  author: You\n---\n\n# My Skill\n\nYour skill instructions here...`}
            className="noah-input w-full text-xs font-mono leading-relaxed resize-none"
            style={{ minHeight: '280px', padding: '12px', background: 'rgba(0,0,0,0.3)' }}
            autoFocus
          />
          {error && <p className="mt-2 text-[10px] text-red-400">{error}</p>}
          <p className="mt-2 text-[10px] text-white/25 leading-relaxed">
            Supports Claude skill format with YAML frontmatter. The name, description, category, and author fields are read automatically.
          </p>
        </div>

        <div className="px-5 py-3 flex justify-end gap-2 flex-shrink-0"
          style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
          <button className="btn-ghost px-4 py-2 text-xs" onClick={onClose}>Cancel</button>
          <button className="btn-green px-4 py-2 text-xs flex items-center gap-1.5"
            onClick={handleInstall} disabled={!content.trim() || installing}>
            <Download02Icon size={11} strokeWidth={1.8} />
            {installing ? 'Installing…' : 'Install Skill'}
          </button>
        </div>
      </div>
    </div>
  );
}

function SkillViewer({ skill, getToken, onClose, onDeleted }) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getToken().then(tok => getSkill(skill.slug, tok))
      .then(r => setContent(r.content))
      .catch(() => setContent('Failed to load skill content.'))
      .finally(() => setLoading(false));
  }, [skill.slug]);

  const handleDelete = async () => {
    if (!confirm(`Remove skill "${skill.name}"?`)) return;
    try {
      const tok = await getToken();
      await deleteSkill(skill.slug, tok);
      onDeleted(skill.slug);
      onClose();
    } catch (err) {
      alert(err.message);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-5 py-4 flex items-center justify-between flex-shrink-0"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex items-center gap-2 min-w-0">
          <button className="btn-icon flex-shrink-0" onClick={onClose}>
            <ArrowLeft01Icon size={13} strokeWidth={1.8} />
          </button>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-white/85 truncate">{skill.name || skill.slug}</h2>
            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
              <ScopeBadge scope={skill.scope} />
              {skill.category && <CategoryBadge category={skill.category} />}
              {skill.author && <span className="text-[9px] text-white/25">by {skill.author}</span>}
            </div>
          </div>
        </div>
        {skill.scope === 'user' && (
          <button className="btn-icon flex-shrink-0"
            style={{ borderColor: 'rgba(239,68,68,0.2)', color: 'rgba(248,113,113,0.6)' }}
            title="Remove skill" onClick={handleDelete}>
            <Delete02Icon size={13} strokeWidth={1.8} />
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <div className="w-4 h-4 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
          </div>
        ) : (
          <pre className="text-[10px] text-white/50 font-mono leading-relaxed whitespace-pre-wrap break-words">{content}</pre>
        )}
      </div>
    </div>
  );
}

export default function SkillsTab({ visible }) {
  const { user } = useAuth();
  const [skills, setSkills]           = useState([]);
  const [loading, setLoading]         = useState(false);
  const [search, setSearch]           = useState('');
  const [showInstall, setShowInstall] = useState(false);
  const [viewSkill, setViewSkill]     = useState(null);
  const [error, setError]             = useState('');

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError('');
    try {
      const token = await user.getIdToken();
      const data = await listSkills(token);
      setSkills(data.skills || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (visible) load();
  }, [visible, load]);

  const getToken = useCallback(() => user.getIdToken(), [user]);

  const handleDelete = async (slug) => {
    const token = await getToken();
    await deleteSkill(slug, token);
    setSkills(prev => prev.filter(s => s.slug !== slug));
  };

  const handleInstalled = () => { load(); };

  const handleDeleted = (slug) => {
    setSkills(prev => prev.filter(s => s.slug !== slug));
  };

  const filtered = skills.filter(s => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      (s.name || '').toLowerCase().includes(q) ||
      (s.description || '').toLowerCase().includes(q) ||
      (s.category || '').toLowerCase().includes(q) ||
      (s.author || '').toLowerCase().includes(q)
    );
  });

  const byCategory = filtered.reduce((acc, s) => {
    const cat = s.category || 'other';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(s);
    return acc;
  }, {});

  if (viewSkill) {
    return (
      <SkillViewer
        skill={viewSkill}
        getToken={getToken}
        onClose={() => setViewSkill(null)}
        onDeleted={handleDeleted}
      />
    );
  }

  return (
    <div className="flex flex-col h-full">
      {showInstall && user && (
        <InstallModal
          onClose={() => setShowInstall(false)}
          onInstalled={handleInstalled}
          getToken={getToken}
        />
      )}

      <div className="px-5 py-4 flex-shrink-0 flex items-center justify-between"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <div>
          <h2 className="text-sm font-semibold text-white/85">Skills</h2>
          <p className="text-[11px] mt-0.5 text-white/30">{skills.length} skill{skills.length !== 1 ? 's' : ''} installed</p>
        </div>
        <button className="btn-icon" title="Install a skill" onClick={() => setShowInstall(true)}>
          <Add01Icon size={13} strokeWidth={1.8} />
        </button>
      </div>

      <div className="px-4 py-3 flex-shrink-0" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
        <div className="relative">
          <Search01Icon size={12} strokeWidth={1.8} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/25 pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search skills…"
            className="noah-input w-full pl-8 pr-4 py-2 text-xs"
          />
        </div>
      </div>

      {error && (
        <div className="mx-4 mt-3 p-3 rounded-xl text-[10px] text-red-400"
          style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)' }}>
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {loading && skills.length === 0 && (
          <div className="flex items-center justify-center h-32">
            <div className="w-4 h-4 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
          </div>
        )}

        {!loading && skills.length === 0 && (
          <div className="text-center py-14">
            <div className="w-14 h-14 rounded-2xl mx-auto mb-4 flex items-center justify-center"
              style={{ background: 'rgba(22,163,74,0.06)', border: '1px solid rgba(255,255,255,0.07)' }}>
              <FlashIcon size={22} strokeWidth={1.4} className="text-white/20" />
            </div>
            <p className="text-xs text-white/30 font-medium mb-1">No skills installed</p>
            <p className="text-[10px] text-white/20 mb-4">Install skills to give Noah specialised knowledge and procedures.</p>
            <button className="btn-green px-4 py-2 text-xs flex items-center gap-1.5 mx-auto"
              onClick={() => setShowInstall(true)}>
              <Add01Icon size={11} strokeWidth={1.8} />
              Install your first skill
            </button>
          </div>
        )}

        {Object.entries(byCategory).sort(([a], [b]) => a.localeCompare(b)).map(([cat, items]) => (
          <div key={cat} className="mb-5">
            <div className="flex items-center gap-2 mb-2">
              <CategoryBadge category={cat} />
              <span className="text-[9px] text-white/20">{items.length}</span>
            </div>
            <div className="space-y-2">
              {items.map(skill => (
                <SkillCard
                  key={skill.slug}
                  skill={skill}
                  onDelete={handleDelete}
                  onView={setViewSkill}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
