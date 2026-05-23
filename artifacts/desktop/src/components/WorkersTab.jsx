import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../services/auth';
import {
  createWorkerAgent,
  updateWorkerAgent,
  deleteWorkerAgent,
  runWorkerAgent,
  listWorkerAgents,
  getWorkerAgentStatus,
  getWorkerAgentResult,
  getWorkerMemories,
  addWorkerMemory,
} from '../services/noahApi';
import {
  AiComputerIcon,
  Add01Icon,
  PlayIcon,
  Delete02Icon,
  SaveEnergy01Icon,
  RefreshIcon,
  SparklesIcon,
  Shield01Icon,
} from 'hugeicons-react';

const ROLE_OPTIONS = [
  { value: '', label: 'Select category' },
  { value: 'general', label: 'General Assistant' },
  { value: 'seo', label: 'SEO & Growth' },
  { value: 'content', label: 'Content & Copywriting' },
  { value: 'coding', label: 'Software Engineering' },
  { value: 'research', label: 'Research Analyst' },
  { value: 'ops', label: 'Operations' },
  { value: 'sales', label: 'Sales & Outreach' },
  { value: 'support', label: 'Customer Support' },
  { value: 'design', label: 'Design & UX' },
  { value: 'product', label: 'Product Management' },
  { value: 'marketing', label: 'Marketing' },
  { value: 'finance', label: 'Finance' },
  { value: 'legal', label: 'Legal & Compliance' },
  { value: 'hr', label: 'People & Hiring' },
];

const MEMORY_OPTIONS = [
  { value: 'shared', label: 'Shared memory' },
  { value: 'isolated', label: 'Isolated memory' },
  { value: 'none', label: 'No memory' },
];

function toLines(v) {
  return (v || '').split('\n').map(s => s.trim()).filter(Boolean);
}

function fromList(v) {
  return Array.isArray(v) ? v.join('\n') : '';
}

const EMPTY_FORM = {
  name: '',
  role: '',
  objective: '',
  personality: 'professional',
  instructions: '',
  constraintsText: '',
  skillsText: '',
  connectorsText: '',
  toolsText: '',
  memory_scope: 'shared',
  storage_namespace: 'default',
  storage_quota_mb: 256,
};

function normalizeWorker(w) {
  return {
    ...w,
    name: w?.name || 'Worker',
    role: w?.role || '',
    objective: w?.objective || '',
    personality: w?.personality || 'professional',
    instructions: w?.instructions || '',
    constraints: Array.isArray(w?.constraints) ? w.constraints : [],
    skills: Array.isArray(w?.skills) ? w.skills : [],
    connectors: Array.isArray(w?.connectors) ? w.connectors : [],
    tools: Array.isArray(w?.tools) ? w.tools : [],
    memory_scope: w?.memory_scope || 'shared',
    storage_namespace: w?.storage_namespace || 'default',
    storage_quota_mb: Number(w?.storage_quota_mb || 256),
    status: w?.status || 'idle',
  };
}

function roleLabel(value) {
  return ROLE_OPTIONS.find(r => r.value === value)?.label || (value || 'Uncategorized');
}

export default function WorkersTab() {
  const { user } = useAuth();
  const [workers, setWorkers] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);
  const [runTask, setRunTask] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [workerMemories, setWorkerMemories] = useState([]);
  const [memoryDraft, setMemoryDraft] = useState('');

  const selectedWorker = useMemo(
    () => workers.find(w => w.worker_id === selectedId) || null,
    [workers, selectedId],
  );

  const loadWorkers = async () => {
    if (!user?.getIdToken) return;
    try {
      const token = await user.getIdToken();
      const data = await listWorkerAgents(token);
      const list = Array.isArray(data?.workers) ? data.workers.map(normalizeWorker) : [];
      setWorkers(list);
      if (!selectedId && list.length) setSelectedId(list[0].worker_id);
    } catch (err) {
      setError(err.message || 'Failed to load workers.');
    }
  };

  useEffect(() => {
    loadWorkers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid]);

  useEffect(() => {
    if (!selectedWorker) {
      setForm(EMPTY_FORM);
      setWorkerMemories([]);
      return;
    }
    setForm({
      name: selectedWorker.name || '',
      role: selectedWorker.role || '',
      objective: selectedWorker.objective || '',
      personality: selectedWorker.personality || 'professional',
      instructions: selectedWorker.instructions || '',
      constraintsText: fromList(selectedWorker.constraints),
      skillsText: fromList(selectedWorker.skills),
      connectorsText: fromList(selectedWorker.connectors),
      toolsText: fromList(selectedWorker.tools),
      memory_scope: selectedWorker.memory_scope || 'shared',
      storage_namespace: selectedWorker.storage_namespace || 'default',
      storage_quota_mb: selectedWorker.storage_quota_mb || 256,
    });
    refreshMemories(selectedWorker.worker_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWorker]);

  const refreshMemories = async (workerIdOverride = '') => {
    const workerId = workerIdOverride || selectedWorker?.worker_id;
    if (!workerId || !user?.getIdToken) return;
    try {
      const token = await user.getIdToken();
      const data = await getWorkerMemories(workerId, token);
      setWorkerMemories(Array.isArray(data?.memories) ? data.memories : []);
    } catch {
      setWorkerMemories([]);
    }
  };

  const buildPayload = () => ({
    name: form.name.trim(),
    role: form.role || 'general',
    objective: form.objective.trim(),
    personality: form.personality.trim() || 'professional',
    instructions: form.instructions.trim(),
    constraints: toLines(form.constraintsText),
    skills: toLines(form.skillsText),
    connectors: toLines(form.connectorsText),
    tools: toLines(form.toolsText),
    memory_scope: form.memory_scope,
    storage_namespace: form.storage_namespace.trim() || 'default',
    storage_quota_mb: Number(form.storage_quota_mb || 256),
    tool_policy: {},
  });

  const createWorker = async () => {
    if (!user?.getIdToken) return;
    setBusy(true); setError(''); setStatus('');
    try {
      const token = await user.getIdToken();
      const payload = buildPayload();
      if (!payload.name || !payload.objective) throw new Error('Name and objective are required.');
      if (!form.role) throw new Error('Please select a category before creating this worker.');
      await createWorkerAgent(payload, token);
      await loadWorkers();
      setStatus('Worker created.');
    } catch (err) {
      setError(err.message || 'Failed to create worker.');
    } finally {
      setBusy(false);
    }
  };

  const saveWorker = async () => {
    if (!selectedWorker || !user?.getIdToken) return;
    setBusy(true); setError(''); setStatus('');
    try {
      const token = await user.getIdToken();
      await updateWorkerAgent(selectedWorker.worker_id, buildPayload(), token);
      await loadWorkers();
      setStatus('Worker updated.');
    } catch (err) {
      setError(err.message || 'Failed to update worker.');
    } finally {
      setBusy(false);
    }
  };

  const removeWorker = async () => {
    if (!selectedWorker || !user?.getIdToken) return;
    setBusy(true); setError(''); setStatus('');
    try {
      const token = await user.getIdToken();
      await deleteWorkerAgent(selectedWorker.worker_id, token);
      setSelectedId('');
      await loadWorkers();
      setStatus('Worker deleted.');
    } catch (err) {
      setError(err.message || 'Failed to delete worker.');
    } finally {
      setBusy(false);
    }
  };

  const runWorker = async () => {
    if (!selectedWorker || !user?.getIdToken) return;
    setBusy(true); setError(''); setStatus('');
    try {
      const token = await user.getIdToken();
      await runWorkerAgent(selectedWorker.worker_id, {
        task: runTask.trim() || selectedWorker.objective || 'Execute objective',
        output_format: 'report',
        tools: toLines(form.toolsText),
        connectors: toLines(form.connectorsText),
      }, token);
      const [st, rs] = await Promise.all([
        getWorkerAgentStatus(selectedWorker.worker_id, token),
        getWorkerAgentResult(selectedWorker.worker_id, token),
      ]);
      setWorkers(prev => prev.map(w => (
        w.worker_id === selectedWorker.worker_id ? normalizeWorker({ ...w, ...st, result: rs?.result || null }) : w
      )));
      if (rs?.result?.success === false) {
        throw new Error(rs?.result?.message || 'Worker policy denied this run.');
      }
      await refreshMemories(selectedWorker.worker_id);
      setStatus('Worker run completed.');
    } catch (err) {
      setError(err.message || 'Failed to run worker.');
    } finally {
      setBusy(false);
    }
  };

  const saveMemoryNote = async () => {
    if (!selectedWorker || !memoryDraft.trim() || !user?.getIdToken) return;
    try {
      const token = await user.getIdToken();
      await addWorkerMemory(selectedWorker.worker_id, { content: memoryDraft.trim(), kind: 'note' }, token);
      setMemoryDraft('');
      await refreshMemories(selectedWorker.worker_id);
      setStatus('Worker memory saved.');
    } catch (err) {
      setError(err.message || 'Failed to save worker memory.');
    }
  };

  const inputCls = 'noah-input px-3 py-2 text-xs';
  const selectCls = `${inputCls} noah-select pr-9`;

  return (
    <div className="flex h-full">
      <div className="w-[320px] border-r border-white/10 p-4 overflow-y-auto">
        <div className="glass-card p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AiComputerIcon size={16} strokeWidth={2} className="text-green-400/85" />
              <h2 className="text-sm font-semibold text-white/90">Workers</h2>
            </div>
            <button className="btn-ghost px-2.5 py-1.5 text-[11px] flex items-center gap-1" onClick={loadWorkers}>
              <RefreshIcon size={12} strokeWidth={1.8} />
              Refresh
            </button>
          </div>
          <p className="text-[11px] mt-2 text-white/45 leading-relaxed">
            Build specialist workers with custom skills, connectors, memory, tools, and behavior policies.
          </p>
        </div>

        <div className="mt-3 space-y-2">
          {workers.length === 0 ? (
            <div className="glass-card p-3 text-xs text-white/45">No workers yet.</div>
          ) : workers.map(w => (
            <button
              key={w.worker_id}
              onClick={() => setSelectedId(w.worker_id)}
              className={`w-full text-left glass-card p-3 transition-all ${selectedId === w.worker_id ? 'ring-1 ring-green-500/60 bg-green-500/10' : ''}`}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-white/85 font-medium truncate">{w.name}</p>
                <span className="status-pill gray text-[9px] uppercase tracking-wide">{w.status}</span>
              </div>
              <p className="text-[10px] text-white/55 truncate mt-1">{roleLabel(w.role)}</p>
              <p className="text-[10px] text-white/33 truncate mt-1">{w.worker_id}</p>
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        <div className="glass-card p-4 mb-4">
          <div className="flex items-center gap-2 mb-1">
            <SparklesIcon size={14} strokeWidth={1.9} className="text-green-400/85" />
            <h3 className="text-sm font-semibold text-white/90">Worker Profile</h3>
          </div>
          <p className="text-[11px] text-white/45">Configure worker identity, mission, and operating policy.</p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Worker name" className={inputCls} />
          <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))} className={selectCls}>
            {ROLE_OPTIONS.map(r => <option key={r.value || 'placeholder'} value={r.value}>{r.label}</option>)}
          </select>
        </div>

        <textarea value={form.objective} onChange={e => setForm(f => ({ ...f, objective: e.target.value }))} placeholder="Primary objective" className={`${inputCls} w-full resize-none mt-3`} rows={3} />
        <textarea value={form.instructions} onChange={e => setForm(f => ({ ...f, instructions: e.target.value }))} placeholder="Custom instructions" className={`${inputCls} w-full resize-none mt-3`} rows={3} />

        <div className="grid grid-cols-2 gap-3 mt-3">
          <input value={form.personality} onChange={e => setForm(f => ({ ...f, personality: e.target.value }))} placeholder="Personality (eg concise, strategic)" className={inputCls} />
          <select value={form.memory_scope} onChange={e => setForm(f => ({ ...f, memory_scope: e.target.value }))} className={selectCls}>
            {MEMORY_OPTIONS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3 mt-3">
          <input value={form.storage_namespace} onChange={e => setForm(f => ({ ...f, storage_namespace: e.target.value }))} placeholder="Storage namespace" className={inputCls} />
          <input type="number" min={64} max={8192} value={form.storage_quota_mb} onChange={e => setForm(f => ({ ...f, storage_quota_mb: e.target.value }))} placeholder="Storage quota MB" className={inputCls} />
        </div>

        <div className="glass-card p-4 my-4">
          <div className="flex items-center gap-2 mb-1">
            <Shield01Icon size={14} strokeWidth={1.9} className="text-green-400/85" />
            <h3 className="text-sm font-semibold text-white/90">Execution Scope</h3>
          </div>
          <p className="text-[11px] text-white/45">Assign exact skills, connectors, tools, and constraints for safe execution.</p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <textarea value={form.skillsText} onChange={e => setForm(f => ({ ...f, skillsText: e.target.value }))} placeholder="Skills (one per line)" className={`${inputCls} w-full resize-none`} rows={4} />
          <textarea value={form.connectorsText} onChange={e => setForm(f => ({ ...f, connectorsText: e.target.value }))} placeholder="Connectors (one per line)" className={`${inputCls} w-full resize-none`} rows={4} />
        </div>

        <div className="grid grid-cols-2 gap-3 mt-3">
          <textarea value={form.toolsText} onChange={e => setForm(f => ({ ...f, toolsText: e.target.value }))} placeholder="Allowed tools (one per line)" className={`${inputCls} w-full resize-none`} rows={4} />
          <textarea value={form.constraintsText} onChange={e => setForm(f => ({ ...f, constraintsText: e.target.value }))} placeholder="Constraints (one per line)" className={`${inputCls} w-full resize-none`} rows={4} />
        </div>

        <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2 items-center mt-4">
          <input value={runTask} onChange={e => setRunTask(e.target.value)} placeholder="Run task override (optional)" className={inputCls} />
          <button onClick={createWorker} disabled={busy} className="btn-green px-3 py-2 text-xs flex items-center gap-1">
            <Add01Icon size={12} strokeWidth={1.8} /> Create
          </button>
          <button onClick={saveWorker} disabled={busy || !selectedWorker} className="btn-ghost px-3 py-2 text-xs flex items-center gap-1">
            <SaveEnergy01Icon size={12} strokeWidth={1.8} /> Save
          </button>
          <button onClick={runWorker} disabled={busy || !selectedWorker} className="btn-ghost px-3 py-2 text-xs flex items-center gap-1">
            <PlayIcon size={12} strokeWidth={1.8} /> Run
          </button>
        </div>

        <div className="flex items-center justify-between mt-3">
          <div className="text-[11px] text-white/45">{selectedWorker ? `Selected: ${selectedWorker.name}` : 'No worker selected'}</div>
          <button onClick={removeWorker} disabled={busy || !selectedWorker} className="btn-ghost px-3 py-2 text-xs text-red-300 flex items-center gap-1">
            <Delete02Icon size={12} strokeWidth={1.8} /> Delete
          </button>
        </div>

        {status && <div className="text-[11px] text-green-400/85 mt-2">{status}</div>}
        {error && <div className="text-[11px] text-red-400/85 mt-2">{error}</div>}

        {selectedWorker?.result?.summary && (
          <div className="glass-card p-3 mt-3 text-[11px] text-white/70 whitespace-pre-wrap">{selectedWorker.result.summary}</div>
        )}

        {selectedWorker && (
          <div className="glass-card p-3 mt-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs text-white/75 font-medium">Worker Memory ({selectedWorker.storage_namespace})</p>
              <button className="btn-ghost px-2 py-1 text-[10px]" onClick={() => refreshMemories(selectedWorker.worker_id)}>Refresh</button>
            </div>
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <input value={memoryDraft} onChange={e => setMemoryDraft(e.target.value)} className={inputCls} placeholder="Add memory note" />
              <button className="btn-green px-3 py-2 text-xs" onClick={saveMemoryNote}>Save</button>
            </div>
            <div className="max-h-36 overflow-y-auto space-y-1">
              {workerMemories.length === 0 ? (
                <p className="text-[11px] text-white/35">No memory records yet.</p>
              ) : workerMemories.slice(0, 20).map(m => (
                <div key={m.id} className="text-[10px] text-white/55 border border-white/10 rounded px-2 py-1">
                  <p className="truncate">{m.content}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
