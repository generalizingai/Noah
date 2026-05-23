const LS_TASKS = 'noah_tasks_v2';
const LS_LOGS = 'noah_logs_v1';
const MAX_TASKS = 250;
const MAX_LOGS = 500;

const TASK_STATUSES = new Set(['draft', 'delegated', 'active', 'completed', 'failed', 'blocked']);
const TASK_EVENT_TYPES = new Set([
  'delegate_task',
  'delegation',
  'worker',
  'worker_spawned',
  'worker_running',
  'worker_done',
  'worker_completed',
  'worker_failed',
  'task',
  'task_created',
  'task_updated',
  'task_status',
  'workflow_task',
  'workflow_status',
]);

function nowIso() {
  return new Date().toISOString();
}

function safeParse(raw, fallback) {
  try {
    const val = JSON.parse(raw);
    return val ?? fallback;
  } catch {
    return fallback;
  }
}

function normalizeTaskStatus(status) {
  const s = String(status || '').toLowerCase();
  if (TASK_STATUSES.has(s)) return s;
  if (['done', 'success', 'succeeded'].includes(s)) return 'completed';
  if (['error', 'failed', 'failure'].includes(s)) return 'failed';
  if (['queued', 'pending'].includes(s)) return 'delegated';
  if (['processing', 'running', 'in_progress'].includes(s)) return 'active';
  return 'draft';
}

function emit(channel, rows) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(channel, { detail: rows }));
}

function loadTasks() {
  if (typeof window === 'undefined') return [];
  return safeParse(localStorage.getItem(LS_TASKS) || '[]', []);
}

function saveTasks(rows) {
  if (typeof window === 'undefined') return;
  const next = Array.isArray(rows) ? rows.slice(0, MAX_TASKS) : [];
  localStorage.setItem(LS_TASKS, JSON.stringify(next));
  emit('noah:tasks-updated', next);
}

function loadLogs() {
  if (typeof window === 'undefined') return [];
  return safeParse(localStorage.getItem(LS_LOGS) || '[]', []);
}

function saveLogs(rows) {
  if (typeof window === 'undefined') return;
  const next = Array.isArray(rows) ? rows.slice(0, MAX_LOGS) : [];
  localStorage.setItem(LS_LOGS, JSON.stringify(next));
  emit('noah:logs-updated', next);
}

export function listTasks() {
  return loadTasks();
}

export function clearTasks() {
  saveTasks([]);
}

export function listLogs() {
  return loadLogs();
}

export function clearLogs() {
  saveLogs([]);
}

export function appendLog(entry = {}) {
  const rows = loadLogs();
  const next = {
    id: entry.id || `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: entry.type || 'event',
    source: entry.source || 'assistant',
    status: String(entry.status || '').toLowerCase() || 'info',
    message: String(entry.message || entry.label || '').trim() || 'Event',
    detail: String(entry.detail || '').trim(),
    plane: String(entry.plane || '').trim(),
    tool: String(entry.tool || '').trim(),
    taskId: entry.taskId || '',
    workerId: entry.workerId || '',
    role: entry.role || '',
    createdAt: entry.createdAt || nowIso(),
    meta: entry.meta || {},
  };
  rows.unshift(next);
  saveLogs(rows);
  return next;
}

export function upsertTask(task = {}) {
  if (!task.id) return null;
  const rows = loadTasks();
  const idx = rows.findIndex((t) => t.id === task.id);
  const current = idx >= 0 ? rows[idx] : {};
  const next = {
    id: task.id,
    title: String(task.title || current.title || 'Untitled task').trim(),
    description: String(task.description ?? current.description ?? '').trim(),
    status: normalizeTaskStatus(task.status || current.status),
    source: String(task.source || current.source || 'assistant'),
    assignedWorker: String(task.assignedWorker || current.assignedWorker || ''),
    assignedDate: task.assignedDate || current.assignedDate || nowIso(),
    deadline: task.deadline || current.deadline || '',
    createdAt: current.createdAt || task.createdAt || nowIso(),
    updatedAt: nowIso(),
    meta: { ...(current.meta || {}), ...(task.meta || {}) },
  };

  if (idx >= 0) rows[idx] = next;
  else rows.unshift(next);

  saveTasks(rows);
  return next;
}

export function deleteTask(taskId) {
  const rows = loadTasks();
  const next = rows.filter((t) => t.id !== taskId);
  saveTasks(next);
}

export function markTask(taskId, patch = {}) {
  if (!taskId) return null;
  return upsertTask({ id: taskId, ...patch });
}

export function findTaskByTitle(title) {
  const norm = String(title || '').trim().toLowerCase();
  if (!norm) return null;
  const rows = loadTasks();
  return rows.find((t) => String(t.title || '').trim().toLowerCase() === norm) || null;
}

export function createDelegatedTask({ title, description = '', role = '', assignedWorker = '', source = 'assistant', deadline = '' }) {
  const existing = findTaskByTitle(title);
  const id = existing?.id || `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const task = upsertTask({
    id,
    title,
    description,
    status: 'delegated',
    source,
    assignedWorker,
    assignedDate: nowIso(),
    deadline,
    meta: { role },
  });
  appendLog({
    type: 'delegation',
    source,
    status: 'delegated',
    message: `Delegated: ${title}`,
    detail: description,
    role,
    workerId: assignedWorker,
    taskId: task?.id || '',
  });
  return task;
}

export function trackActionTask(action, source = 'assistant') {
  if (!action || !action.label) return null;

  const mappedStatus = normalizeTaskStatus(action.status || 'active');
  const title = String(action.label || '').trim();
  const workerId = String(action.worker_id || action.workerId || '').trim();
  const explicitTaskId = String(action.taskId || '').trim();
  const actionType = String(action.type || '').trim().toLowerCase();
  const materializeTask =
    Boolean(explicitTaskId) ||
    Boolean(workerId) ||
    TASK_EVENT_TYPES.has(actionType) ||
    /delegate|worker|task/.test(title.toLowerCase());

  let task = null;
  let taskId = explicitTaskId;
  if (!taskId && materializeTask && workerId) taskId = `task_worker_${workerId}`;
  if (!taskId && materializeTask) {
    const existing = findTaskByTitle(title);
    taskId = existing?.id || `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  if (materializeTask) {
    task = upsertTask({
      id: taskId,
      title,
      status: mappedStatus,
      source,
      assignedWorker: workerId,
      description: action.type ? `type: ${action.type}` : '',
      meta: {
        plane: action.plane || '',
        tool: action.tool || action.type || '',
        fallback_from: action.fallback_from || '',
        fallback_to: action.fallback_to || '',
        role: action.role || '',
      },
    });
  }

  appendLog({
    type: action.type || 'action',
    source,
    status: mappedStatus,
    message: title,
    detail: action.type ? `type: ${action.type}` : '',
    plane: action.plane || '',
    tool: action.tool || action.type || '',
    taskId: task?.id || taskId || '',
    workerId,
    role: action.role || '',
    meta: {
      fallback_from: action.fallback_from || '',
      fallback_to: action.fallback_to || '',
    },
  });

  return task;
}

export function trackAsyncResultFromText(text, source = 'assistant') {
  const body = String(text || '');
  if (!body) return null;

  const workerMatch = body.match(/\bworker\s*id\s*:\s*([a-z0-9-]{8,})\b/i);
  const taskMatch = body.match(/\btask\s*id\s*:\s*([a-z0-9_-]{6,})\b/i);
  const roleMatch = body.match(/\brole\s*:\s*([a-z0-9_-]{2,})\b/i);
  const delegationHint = /\b(delegat|sub[- ]?agent|worker)\b/i.test(body);
  const statusHint = /\b(completed|done|succeeded|finished)\b/i.test(body)
    ? 'completed'
    : /\b(failed|error|could not|unable)\b/i.test(body)
      ? 'failed'
      : delegationHint
        ? 'active'
        : 'draft';

  if (workerMatch || taskMatch || delegationHint) {
    const workerId = workerMatch?.[1] || '';
    const inferredTitle =
      body
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line && !/^worker\s*id\s*:/i.test(line) && !/^task\s*id\s*:/i.test(line))
        ?.slice(0, 140) || 'Delegated worker task';

    const taskId = taskMatch?.[1] || (workerId ? `task_worker_${workerId}` : `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    upsertTask({
      id: taskId,
      title: inferredTitle,
      description: body.slice(0, 400),
      status: statusHint,
      source,
      assignedWorker: workerId,
      assignedDate: nowIso(),
      meta: {
        role: roleMatch?.[1] || '',
        inferred_from_text: true,
      },
    });
  }

  appendLog({
    type: 'assistant_text',
    source,
    status: 'info',
    message: body.slice(0, 160),
    detail: body.slice(0, 500),
  });

  return null;
}

export function subscribeTasks(listener) {
  if (typeof window === 'undefined') return () => {};
  const onCustom = (e) => listener(e?.detail || listTasks());
  const onStorage = (e) => {
    if (e.key === LS_TASKS) listener(listTasks());
  };
  window.addEventListener('noah:tasks-updated', onCustom);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener('noah:tasks-updated', onCustom);
    window.removeEventListener('storage', onStorage);
  };
}

export function subscribeLogs(listener) {
  if (typeof window === 'undefined') return () => {};
  const onCustom = (e) => listener(e?.detail || listLogs());
  const onStorage = (e) => {
    if (e.key === LS_LOGS) listener(listLogs());
  };
  window.addEventListener('noah:logs-updated', onCustom);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener('noah:logs-updated', onCustom);
    window.removeEventListener('storage', onStorage);
  };
}
