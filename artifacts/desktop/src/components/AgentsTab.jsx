import React, { useMemo, useState } from 'react';
import { useAuth } from '../services/auth';
import {
  createWorkerAgent,
  runWorkerAgent,
  getWorkerAgentStatus,
  getWorkerAgentResult,
} from '../services/noahApi';
import { AiComputerIcon, Add01Icon } from 'hugeicons-react';

const ROLES = ['seo', 'content', 'coding', 'research', 'ops'];

function WorkerCard({ worker, onRefresh, onRun }) {
  return (
    <div className="glass-card p-3.5 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-white/75 font-medium truncate">{worker.role} specialist</p>
          <p className="text-[10px] text-white/30 truncate">{worker.worker_id}</p>
        </div>
        <span className={`status-pill ${worker.status === 'completed' ? 'green' : worker.status === 'idle' ? 'gray' : 'amber'}`}>
          {worker.status || 'unknown'}
        </span>
      </div>
      <p className="text-[11px] text-white/45 leading-relaxed">{worker.objective || 'No objective set.'}</p>
      <div className="flex items-center gap-2">
        <button className="btn-ghost px-2.5 py-1.5 text-[10px] flex items-center gap-1" onClick={() => onRefresh(worker.worker_id)}>
          Refresh
        </button>
        <button className="btn-green px-2.5 py-1.5 text-[10px] flex items-center gap-1" onClick={() => onRun(worker.worker_id)}>
          Run
        </button>
      </div>
      {worker.result?.summary && (
        <div className="rounded-lg p-2.5 text-[10px] text-white/55" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
          {worker.result.summary}
        </div>
      )}
    </div>
  );
}

export default function AgentsTab() {
  const { user } = useAuth();
  const [role, setRole] = useState('seo');
  const [objective, setObjective] = useState('');
  const [constraints, setConstraints] = useState('');
  const [task, setTask] = useState('');
  const [workers, setWorkers] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const constraintsList = useMemo(
    () => constraints.split('\n').map(s => s.trim()).filter(Boolean),
    [constraints],
  );

  const createWorker = async () => {
    if (!user?.getIdToken) return;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const token = await user.getIdToken();
      const created = await createWorkerAgent({
        role,
        objective: objective.trim(),
        constraints: constraintsList,
      }, token);
      setWorkers(prev => [{ ...created, objective: objective.trim(), constraints: constraintsList, result: null }, ...prev]);
      setStatus(`Worker created: ${created.worker_id}`);
    } catch (err) {
      setError(err.message || 'Failed to create worker.');
    } finally {
      setBusy(false);
    }
  };

  const refreshWorker = async (workerId) => {
    if (!user?.getIdToken) return;
    try {
      const token = await user.getIdToken();
      const [st, rs] = await Promise.all([
        getWorkerAgentStatus(workerId, token),
        getWorkerAgentResult(workerId, token),
      ]);
      setWorkers(prev => prev.map(w => w.worker_id === workerId ? { ...w, ...st, result: rs?.result || null } : w));
    } catch (err) {
      setError(err.message || `Failed to refresh worker ${workerId}.`);
    }
  };

  const runWorker = async (workerId) => {
    if (!user?.getIdToken) return;
    setBusy(true);
    setError('');
    try {
      const token = await user.getIdToken();
      await runWorkerAgent(workerId, {
        task: task.trim() || 'Execute specialist objective',
        output_format: 'report',
      }, token);
      await refreshWorker(workerId);
      setStatus(`Worker completed: ${workerId}`);
    } catch (err) {
      setError(err.message || `Failed to run worker ${workerId}.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-5 py-4 flex-shrink-0" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex items-center gap-2">
          <AiComputerIcon size={15} strokeWidth={1.9} className="text-green-400/80" />
          <h2 className="text-sm font-semibold text-white/85">Agents</h2>
        </div>
        <p className="text-[11px] mt-1 text-white/32">Create and deploy specialist sub-agents for niche tasks.</p>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        <div className="glass-card p-3.5 space-y-3">
          <p className="text-xs text-white/70 font-medium">Create specialist agent</p>
          <div className="grid grid-cols-2 gap-2">
            <select value={role} onChange={e => setRole(e.target.value)} className="noah-input px-3 py-2 text-xs">
              {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            <input value={task} onChange={e => setTask(e.target.value)} placeholder="Default run task" className="noah-input px-3 py-2 text-xs" />
          </div>
          <textarea
            value={objective}
            onChange={e => setObjective(e.target.value)}
            placeholder="Objective for this specialist"
            className="noah-input w-full px-3 py-2 text-xs resize-none"
            rows={3}
          />
          <textarea
            value={constraints}
            onChange={e => setConstraints(e.target.value)}
            placeholder="Constraints (one per line)"
            className="noah-input w-full px-3 py-2 text-xs resize-none"
            rows={3}
          />
          <div className="flex items-center gap-2">
            <button onClick={createWorker} className="btn-green px-3 py-2 text-xs flex items-center gap-1" disabled={busy || !objective.trim()}>
              <Add01Icon size={12} strokeWidth={1.8} />
              {busy ? 'Creating...' : 'Create Agent'}
            </button>
            {status && <span className="text-[10px] text-green-400/80">{status}</span>}
            {error && <span className="text-[10px] text-red-400/80">{error}</span>}
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-[11px] text-white/45 uppercase tracking-widest">Deployed Agents</p>
          {workers.length === 0 ? (
            <div className="glass-card p-4 text-xs text-white/35">No agents created yet.</div>
          ) : (
            workers.map(w => (
              <WorkerCard key={w.worker_id} worker={w} onRefresh={refreshWorker} onRun={runWorker} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
