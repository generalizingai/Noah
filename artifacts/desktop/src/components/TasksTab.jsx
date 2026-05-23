import React, { useEffect, useMemo, useState } from 'react';
import { clearTasks, deleteTask, listTasks, subscribeTasks, upsertTask } from '../services/tasks';

const COLUMNS = [
  { id: 'draft', label: 'Draft' },
  { id: 'delegated', label: 'Delegated' },
  { id: 'active', label: 'Active' },
  { id: 'completed', label: 'Completed' },
  { id: 'failed', label: 'Failed' },
];

function fmtDate(value) {
  if (!value) return 'Not set';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function TaskCard({ task, onStatusChange, onDelete }) {
  return (
    <div className="rounded-xl p-3" style={{ border: '1px solid rgba(255,255,255,0.09)', background: 'rgba(255,255,255,0.03)' }}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm text-white/90 leading-snug font-medium">{task.title}</p>
        <button className="text-[10px] text-white/45 hover:text-red-300" onClick={() => onDelete(task.id)}>Delete</button>
      </div>
      {task.description ? <p className="text-xs mt-1 text-white/50">{task.description}</p> : null}

      <div className="mt-2 space-y-1">
        <p className="text-[10px] text-white/40">Worker: <span className="text-white/65">{task.assignedWorker || 'Unassigned'}</span></p>
        <p className="text-[10px] text-white/40">Assigned: <span className="text-white/65">{fmtDate(task.assignedDate || task.createdAt)}</span></p>
        <p className="text-[10px] text-white/40">Deadline: <span className="text-white/65">{task.deadline ? fmtDate(task.deadline) : 'Not set'}</span></p>
      </div>

      <div className="mt-2">
        <select
          className="noah-input noah-select text-[11px] px-2 py-1.5 pr-8 w-full"
          value={task.status}
          onChange={(e) => onStatusChange(task.id, e.target.value)}
        >
          {COLUMNS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          <option value="blocked">Blocked</option>
        </select>
      </div>
    </div>
  );
}

export default function TasksTab() {
  const [tasks, setTasks] = useState(() => listTasks());
  const [draftTitle, setDraftTitle] = useState('');
  const [draftDetail, setDraftDetail] = useState('');
  const [draftDeadline, setDraftDeadline] = useState('');

  useEffect(() => {
    setTasks(listTasks());
    return subscribeTasks((rows) => setTasks(Array.isArray(rows) ? rows : listTasks()));
  }, []);

  const grouped = useMemo(() => {
    const m = new Map(COLUMNS.map((c) => [c.id, []]));
    for (const t of tasks) {
      const col = m.get(t.status) ? t.status : 'draft';
      m.get(col).push(t);
    }
    return m;
  }, [tasks]);

  const onStatusChange = (taskId, status) => {
    upsertTask({ id: taskId, status });
  };

  const onCreateDraft = () => {
    const title = draftTitle.trim();
    if (!title) return;
    upsertTask({
      id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      title,
      description: draftDetail.trim(),
      status: 'draft',
      source: 'manual',
      deadline: draftDeadline || '',
      assignedDate: new Date().toISOString(),
    });
    setDraftTitle('');
    setDraftDetail('');
    setDraftDeadline('');
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-6 py-4 flex items-center justify-between" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <div>
          <h2 className="text-sm font-semibold text-white/90">Tasks</h2>
          <p className="text-[11px] mt-0.5 text-white/35">Kanban board for planned and delegated work</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setTasks(listTasks())} className="btn-ghost px-3 py-1.5 text-xs">Refresh</button>
          <button onClick={() => { clearTasks(); setTasks([]); }} className="btn-ghost px-3 py-1.5 text-xs">Clear</button>
        </div>
      </div>

      <div className="px-5 pt-4">
        <div className="glass-card p-3 grid grid-cols-1 md:grid-cols-4 gap-2">
          <input className="noah-input px-3 py-2 text-xs" placeholder="Task title" value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} />
          <input className="noah-input px-3 py-2 text-xs" placeholder="Details" value={draftDetail} onChange={(e) => setDraftDetail(e.target.value)} />
          <input className="noah-input px-3 py-2 text-xs" type="datetime-local" value={draftDeadline} onChange={(e) => setDraftDeadline(e.target.value)} />
          <button className="btn-primary px-3 py-2 text-xs" onClick={onCreateDraft}>+ Create task</button>
        </div>
      </div>

      <div className="flex-1 overflow-x-auto overflow-y-hidden px-5 py-4">
        <div className="grid h-full gap-3" style={{ gridTemplateColumns: 'repeat(5, minmax(260px, 1fr))' }}>
          {COLUMNS.map((col) => {
            const rows = grouped.get(col.id) || [];
            return (
              <div key={col.id} className="glass-card p-3 flex flex-col min-h-0">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-semibold text-white/80 uppercase tracking-wide">{col.label}</h3>
                  <span className="text-[11px] text-white/35">{rows.length}</span>
                </div>
                <div className="flex-1 overflow-y-auto space-y-2 pr-1">
                  {rows.length === 0 ? <p className="text-xs text-white/30">No tasks</p> : rows.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      onStatusChange={onStatusChange}
                      onDelete={deleteTask}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
