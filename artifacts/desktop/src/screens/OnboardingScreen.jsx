import React, { useState } from 'react';
import { NoahLogo } from '../App';
import { addMemory } from '../services/memory';

const WORK_ROLES = [
  'Software Engineer', 'Product Manager', 'Designer', 'Founder / CEO',
  'Data Scientist', 'Marketing', 'Sales', 'Finance', 'Student', 'Other',
];

const WORK_STYLES = [
  { id: 'fast',      label: 'Fast & direct',      sub: 'Short answers, get to the point' },
  { id: 'detailed',  label: 'Thorough & detailed', sub: 'Full explanations I can learn from' },
  { id: 'friendly',  label: 'Friendly & casual',   sub: 'Like a smart colleague who chats' },
  { id: 'formal',    label: 'Professional',         sub: 'Formal tone, structured responses' },
];

const TOPICS = [
  'Coding & Development', 'Writing & Communication', 'Research & Analysis',
  'Calendar & Scheduling', 'Email & Messaging', 'File Management',
  'Project Management', 'Music & Entertainment', 'News & Browsing',
];

export default function OnboardingScreen({ onComplete }) {
  const [step,      setStep]      = useState(0);
  const [name,      setName]      = useState('');
  const [role,      setRole]      = useState('');
  const [style,     setStyle]     = useState('');
  const [interests, setInterests] = useState([]);

  const toggleInterest = (t) =>
    setInterests(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]);

  const canNext = () => {
    if (step === 0) return name.trim().length > 0;
    if (step === 1) return !!role;
    if (step === 2) return !!style;
    return true;
  };

  const finish = () => {
    if (name.trim())     addMemory(`User's name is ${name.trim()}.`);
    if (role)            addMemory(`User's work role is: ${role}.`);
    if (style) {
      const s = WORK_STYLES.find(w => w.id === style);
      if (s) addMemory(`User prefers ${s.label} communication style: ${s.sub}.`);
    }
    if (interests.length > 0) addMemory(`User frequently uses Noah for: ${interests.join(', ')}.`);
    localStorage.setItem('noah_onboarding_done', '1');
    onComplete({ name, role, style, interests });
  };

  const STEPS = [
    {
      title:    "What's your name?",
      subtitle: "Noah will use this to address you personally.",
      content: (
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && canNext()) setStep(1); }}
          placeholder="Enter your first name…"
          autoFocus
          className="noah-input w-full px-4 py-2.5 text-sm text-center font-medium mt-3"
          style={{ letterSpacing: '0.01em' }}
        />
      ),
    },
    {
      title:    'What do you do for work?',
      subtitle: "Noah adapts to your role and context.",
      content: (
        <div className="grid grid-cols-2 gap-1.5 mt-3">
          {WORK_ROLES.map(r => (
            <button key={r} onClick={() => setRole(r)}
              className="px-3 py-2 rounded-lg text-xs text-left transition-all"
              style={role === r ? {
                background: 'rgba(22,163,74,0.14)', border: '1px solid rgba(22,163,74,0.38)', color: '#4ade80',
              } : {
                background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', color: 'rgba(228,240,232,0.52)',
              }}>
              {r}
            </button>
          ))}
        </div>
      ),
    },
    {
      title:    'How do you like to communicate?',
      subtitle: "This shapes Noah's personality and response style.",
      content: (
        <div className="flex flex-col gap-1.5 mt-3">
          {WORK_STYLES.map(w => (
            <button key={w.id} onClick={() => setStyle(w.id)}
              className="px-4 py-2.5 rounded-lg text-left transition-all"
              style={style === w.id ? {
                background: 'rgba(22,163,74,0.12)', border: '1px solid rgba(22,163,74,0.35)', color: '#4ade80',
              } : {
                background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', color: 'rgba(228,240,232,0.6)',
              }}>
              <p className="text-xs font-medium">{w.label}</p>
              <p className="text-xs mt-0.5" style={{ color: style === w.id ? 'rgba(134,239,172,0.65)' : 'rgba(228,240,232,0.28)', fontSize: 11 }}>{w.sub}</p>
            </button>
          ))}
        </div>
      ),
    },
    {
      title:    'What will you mostly use Noah for?',
      subtitle: "Select all that apply — you can skip this.",
      content: (
        <div className="grid grid-cols-2 gap-1.5 mt-3">
          {TOPICS.map(t => {
            const on = interests.includes(t);
            return (
              <button key={t} onClick={() => toggleInterest(t)}
                className="px-3 py-2 rounded-lg text-left transition-all"
                style={on ? {
                  background: 'rgba(22,163,74,0.13)', border: '1px solid rgba(22,163,74,0.35)', color: '#4ade80', fontSize: 11,
                } : {
                  background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(228,240,232,0.48)', fontSize: 11,
                }}>
                {on && <span className="mr-1">✓</span>}{t}
              </button>
            );
          })}
        </div>
      ),
    },
  ];

  const current = STEPS[step];

  return (
    <div className="flex items-center justify-center w-full h-screen app-bg px-6" style={{ paddingTop: 60 }}>
      <div className="w-full" style={{ maxWidth: 400 }}>

        {/* Header */}
        <div className="text-center mb-6">
          <NoahLogo size={36} className="mx-auto mb-3" pulse />
          <h1 className="text-lg font-semibold text-white/88 tracking-tight">Let's set up Noah</h1>
          <p className="text-xs text-white/30 mt-1">Step {step + 1} of {STEPS.length}</p>
        </div>

        {/* Progress dots */}
        <div className="flex items-center justify-center gap-1.5 mb-5">
          {STEPS.map((_, i) => (
            <div key={i} className="rounded-full transition-all"
              style={{
                width:      i === step ? 16 : 5,
                height:     5,
                background: i <= step ? '#22c55e' : 'rgba(255,255,255,0.1)',
              }}
            />
          ))}
        </div>

        {/* Card */}
        <div className="glass-card p-5">
          <h2 className="text-sm font-semibold text-white/82">{current.title}</h2>
          <p className="text-xs text-white/30 mt-0.5">{current.subtitle}</p>
          {current.content}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between mt-4">
          {step > 0
            ? <button onClick={() => setStep(s => s - 1)} className="btn-ghost px-3.5 py-1.5 text-xs">← Back</button>
            : <div />}
          <div className="flex items-center gap-2">
            {step === STEPS.length - 1 && (
              <button onClick={finish} className="btn-ghost px-3.5 py-1.5 text-xs">Skip</button>
            )}
            <button
              onClick={() => step < STEPS.length - 1 ? setStep(s => s + 1) : finish()}
              disabled={!canNext() && step < STEPS.length - 1}
              className="btn-green px-5 py-2 text-xs font-medium"
              style={{ opacity: !canNext() && step < STEPS.length - 1 ? 0.45 : 1 }}
            >
              {step === STEPS.length - 1 ? `Let's go, ${name || 'friend'} →` : 'Continue →'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
