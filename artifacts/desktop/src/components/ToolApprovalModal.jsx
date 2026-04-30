import React from 'react';
import { ShieldKeyIcon, CheckmarkCircle01Icon, Cancel01Icon } from 'hugeicons-react';

const TOOL_META = {
  terminal: {
    label: 'Run Shell Command',
    color: '#f59e0b',
    description: (args) => args.command || '',
    secondaryLabel: (args) => args.reason || '',
  },
  write_file: {
    label: 'Write File',
    color: '#f87171',
    description: (args) => args.path || '',
    secondaryLabel: (args) => args.content ? `${args.content.slice(0, 120)}${args.content.length > 120 ? '…' : ''}` : '',
  },
  run_applescript: {
    label: 'Run AppleScript',
    color: '#a78bfa',
    description: (args) => args.reason || '',
    secondaryLabel: (args) => args.script ? `${args.script.slice(0, 160)}${args.script.length > 160 ? '…' : ''}` : '',
  },
};

export default function ToolApprovalModal({ request, onApprove, onCancel }) {
  if (!request) return null;

  const { toolName, args } = request;
  const meta = TOOL_META[toolName] || {
    label: toolName,
    color: '#6b7280',
    description: () => JSON.stringify(args),
    secondaryLabel: () => '',
  };

  const primary   = meta.description(args);
  const secondary = meta.secondaryLabel(args);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
      }}
    >
      <div
        style={{
          width: 440,
          maxWidth: 'calc(100vw - 32px)',
          background: 'rgba(10,20,12,0.97)',
          border: '1px solid rgba(255,255,255,0.09)',
          borderRadius: 16,
          boxShadow: '0 24px 64px rgba(0,0,0,0.7)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: `${meta.color}20`,
              border: `1px solid ${meta.color}40`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <ShieldKeyIcon size={15} strokeWidth={2} style={{ color: meta.color }} />
          </div>
          <div>
            <p style={{ fontSize: 13, fontWeight: 600, color: 'rgba(228,240,232,0.92)', margin: 0 }}>
              Allow {meta.label}?
            </p>
            <p style={{ fontSize: 10, color: 'rgba(228,240,232,0.38)', margin: '2px 0 0' }}>
              Hermes wants to run an operation on your Mac
            </p>
          </div>
        </div>

        {/* Body */}
        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {primary && (
            <div
              style={{
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.07)',
                borderRadius: 8,
                padding: '10px 12px',
              }}
            >
              <p
                style={{
                  fontSize: 11,
                  fontFamily: 'monospace',
                  color: meta.color,
                  margin: 0,
                  wordBreak: 'break-all',
                  whiteSpace: 'pre-wrap',
                  lineHeight: 1.5,
                }}
              >
                {primary}
              </p>
            </div>
          )}

          {secondary && (
            <div
              style={{
                background: 'rgba(255,255,255,0.02)',
                border: '1px solid rgba(255,255,255,0.05)',
                borderRadius: 8,
                padding: '8px 12px',
              }}
            >
              <p
                style={{
                  fontSize: 10,
                  fontFamily: 'monospace',
                  color: 'rgba(228,240,232,0.45)',
                  margin: 0,
                  wordBreak: 'break-all',
                  whiteSpace: 'pre-wrap',
                  lineHeight: 1.5,
                }}
              >
                {secondary}
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '12px 20px',
            borderTop: '1px solid rgba(255,255,255,0.06)',
            display: 'flex',
            gap: 8,
            justifyContent: 'flex-end',
          }}
        >
          <button
            onClick={onCancel}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              padding: '7px 14px',
              borderRadius: 8,
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.09)',
              color: 'rgba(228,240,232,0.55)',
              fontSize: 12,
              fontWeight: 500,
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.09)'; e.currentTarget.style.color = 'rgba(228,240,232,0.8)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = 'rgba(228,240,232,0.55)'; }}
          >
            <Cancel01Icon size={12} strokeWidth={2} />
            Cancel
          </button>
          <button
            onClick={onApprove}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              padding: '7px 16px',
              borderRadius: 8,
              background: `${meta.color}22`,
              border: `1px solid ${meta.color}50`,
              color: meta.color,
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = `${meta.color}35`; }}
            onMouseLeave={e => { e.currentTarget.style.background = `${meta.color}22`; }}
          >
            <CheckmarkCircle01Icon size={12} strokeWidth={2} />
            Run
          </button>
        </div>
      </div>
    </div>
  );
}
