import React, { useEffect, useState } from 'react';
import { clearLogs, listLogs, subscribeLogs } from '../services/tasks';

function badge(status) {
  const s = String(status || '').toLowerCase();
  if (['completed', 'done', 'success'].includes(s)) return 'status-pill green';
  if (['failed', 'error'].includes(s)) return 'status-pill red';
  if (['delegated', 'active', 'running'].includes(s)) return 'status-pill amber';
  return 'status-pill';
}

export default function LogsTab() {
  const [logs, setLogs] = useState(() => listLogs());

  useEffect(() => {
    setLogs(listLogs());
    return subscribeLogs((rows) => setLogs(Array.isArray(rows) ? rows : listLogs()));
  }, []);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-6 py-4 flex items-center justify-between" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <div>
          <h2 className="text-sm font-semibold text-white/90">Logs</h2>
          <p className="text-[11px] mt-0.5 text-white/35">Execution timeline and worker/task events</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setLogs(listLogs())} className="btn-ghost px-3 py-1.5 text-xs">Refresh</button>
          <button onClick={() => { clearLogs(); setLogs([]); }} className="btn-ghost px-3 py-1.5 text-xs">Clear</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {logs.length === 0 ? (
          <div className="glass-card p-4 text-xs text-white/35">No logs yet.</div>
        ) : (
          <div className="space-y-2">
            {logs.map((log) => (
              <div key={log.id} className="glass-card p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm text-white/88">{log.message}</p>
                    {log.detail ? <p className="text-xs mt-1 text-white/45">{log.detail}</p> : null}
                    <p className="text-[10px] mt-1 text-white/35">
                      {new Date(log.createdAt).toLocaleString()} · {log.source}
                      {log.plane ? ` · ${log.plane}` : ''}
                      {log.tool ? ` · ${log.tool}` : ''}
                      {log.workerId ? ` · worker:${log.workerId}` : ''}
                    </p>
                  </div>
                  <span className={badge(log.status)}>{log.status || 'info'}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
