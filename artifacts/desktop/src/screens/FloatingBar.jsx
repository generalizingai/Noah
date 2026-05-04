import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useAuth } from '../services/auth';
import { sendVoiceQuery } from '../services/noahApi';
import { VoiceRecorder } from '../services/voiceRecorder';
import { PTTManager, getPTTKeyLabel, getPTTKeyCode } from '../services/ptt';
import { speak, stopSpeaking, isTTSAvailable, onSpeakingStateChange } from '../services/tts';
import { NoahLogo } from '../App';

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

function broadcastQA(question, answer) {
  const id = Date.now();
  if (isElectron) {
    try { window.electronAPI.relayFloatingQA?.({ question, answer, id }); } catch {}
  }
  try {
    localStorage.setItem('noah_floating_qa_latest', JSON.stringify({ question, answer, id }));
  } catch {}
  try {
    const bc = new BroadcastChannel('noah_floating_qa');
    bc.postMessage({ question, answer, id });
    setTimeout(() => { try { bc.close(); } catch {} }, 500);
  } catch {}
}

// Animated waveform — Dynamic Island style green bars
function Waveform() {
  const heights = [30, 60, 100, 70, 45, 85, 40, 65, 50, 32];
  return (
    <div className="flex items-center gap-[2px]" style={{ height: 16 }}>
      {heights.map((pct, i) => (
        <div key={i} className="rounded-full" style={{
          width: 2.5,
          height: `${pct}%`,
          background: '#4ade80',
          opacity: 0.85,
          animation: `islandWave ${0.42 + i * 0.07}s ease-in-out infinite alternate`,
          animationDelay: `${i * 0.05}s`,
        }} />
      ))}
    </div>
  );
}

// Minimal spinner
function Spinner() {
  return (
    <div style={{
      width: 12, height: 12, borderRadius: '50%',
      border: '1.5px solid rgba(255,255,255,0.1)',
      borderTopColor: 'rgba(255,255,255,0.7)',
      animation: 'spin 0.7s linear infinite',
      flexShrink: 0,
    }} />
  );
}

// Content fades + springs in on each phase change
function PhaseContent({ phaseKey, children }) {
  return (
    <div key={phaseKey} style={{
      display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0,
      animation: 'islandContentIn 0.2s cubic-bezier(0.34,1.56,0.64,1) both',
    }}>
      {children}
    </div>
  );
}

export default function FloatingBar() {
  const { user, getToken } = useAuth();

  const [micStatus,  setMicStatus]  = useState('idle');
  const [sending,    setSending]    = useState(false);
  const [phase,      setPhase]      = useState('idle');
  const [response,   setResponse]   = useState('');
  const [lastQ,      setLastQ]      = useState('');
  const [pttKey,     setPttKey]     = useState(getPTTKeyLabel());
  const [globalKey,  setGlobalKey]  = useState('Option+Space');
  const [inputMode,  setInputMode]  = useState(false);
  const [inputText,  setInputText]  = useState('');
  const [isSpeakingState, setIsSpeakingState] = useState(false);

  const recRef        = useRef(null);
  const pttRef        = useRef(null);
  const handleSendRef = useRef(null);
  const sendingRef    = useRef(false);
  const dismissTimer  = useRef(null);
  const inputRef      = useRef(null);
  const liveStreamRef = useRef(null); // persistent mic stream — keeps getUserMedia permission "warm"

  const isListening    = micStatus === 'listening';
  const isTranscribing = micStatus === 'transcribing';

  // ── Keep a live mic stream from mount ───────────────────────────────────────
  // Acquire the mic stream once at component mount and keep it alive.
  // If the OS reclaims the tracks (readyState → 'ended'), re-acquire automatically.
  // Also exposed as window.__noahReacquireMic so the main process can trigger a
  // re-acquisition after macOS TCC mic permission is granted at startup.
  const acquireStreamRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    let retries    = 0;
    const MAX_RETRIES = 12;
    let acquiring  = false; // prevent concurrent getUserMedia calls

    const acquireStream = () => {
      // Skip if a stream is already live and healthy
      const existing = liveStreamRef.current;
      if (existing && existing.getTracks().every(t => t.readyState === 'live')) return;
      // Skip if we're already mid-acquisition
      if (acquiring) return;
      acquiring = true;

      navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 },
      }).then(stream => {
        acquiring = false;
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        retries = 0;
        // Stop old stream if any
        if (liveStreamRef.current) {
          try { liveStreamRef.current.getTracks().forEach(t => t.stop()); } catch {}
        }
        liveStreamRef.current = stream;
        // Re-acquire if the OS later reclaims the tracks
        stream.getTracks().forEach(track => {
          track.addEventListener('ended', () => { if (!cancelled) { acquiring = false; acquireStream(); } });
        });
        console.log('[Noah] ✓ Mic stream live');
      }).catch(err => {
        acquiring = false;
        liveStreamRef.current = null;
        retries++;
        console.warn('[Noah] getUserMedia failed (attempt', retries, '):', err.name);
        if (retries <= MAX_RETRIES && !cancelled) {
          setTimeout(() => { if (!cancelled) acquireStream(); }, Math.min(800 * retries, 5000));
        }
      });
    };

    acquireStreamRef.current = acquireStream;

    // Expose for main process: called via executeJavaScript (userGesture=true) to acquire mic
    window.__noahReacquireMic = () => acquireStream();

    // Tell the main process we are ready — it will call window.__noahReacquireMic
    // immediately via executeJavaScript(code, true) so getUserMedia has a real user gesture.
    // This eliminates the 800ms fixed-delay race condition.
    if (typeof window.electronAPI?.notifyMicReady === 'function') {
      window.electronAPI.notifyMicReady();
    }

    // Also attempt a direct acquire (succeeds if Chromium allows it without gesture)
    acquireStream();

    return () => {
      cancelled = true;
      delete window.__noahReacquireMic;
      acquireStreamRef.current = null;
      if (liveStreamRef.current) {
        liveStreamRef.current.getTracks().forEach(t => t.stop());
        liveStreamRef.current = null;
      }
    };
  }, []);

  // Force the page/root fully transparent so only the pill is visible
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const root = document.getElementById('root');
    [html, body, root].forEach(el => { if (el) el.style.background = 'transparent'; });
    return () => {
      [html, body, root].forEach(el => { if (el) el.style.background = ''; });
    };
  }, []);

  // Sync global PTT key label — use the human-readable label from localStorage,
  // falling back to the raw accelerator if nothing is stored yet.
  // Also re-register any previously saved custom shortcut on every app launch.
  useEffect(() => {
    if (!isElectron) return;
    const stored = getPTTKeyLabel();
    if (stored) setGlobalKey(stored);

    // Re-apply the saved shortcut so a custom key survives app restarts
    const savedAccelerator = getPTTKeyCode();
    if (savedAccelerator && savedAccelerator !== 'CmdOrCtrl+Shift+Space') {
      window.electronAPI.registerPTT?.(savedAccelerator).catch(() => {});
    }
    const unsub = window.electronAPI.onPTTAcceleratorChanged?.(() => {
      // Re-read the label from localStorage — Settings writes it right before
      // calling registerPTT, so by the time this event fires it's already saved.
      setGlobalKey(getPTTKeyLabel());
    });
    return () => { if (typeof unsub === 'function') unsub(); };
  }, []);

  const scheduleIdle = useCallback((delay = 10000) => {
    clearTimeout(dismissTimer.current);
    dismissTimer.current = setTimeout(() => {
      setPhase('idle');
      setResponse('');
      setLastQ('');
    }, delay);
  }, []);

  const handleSend = useCallback(async (text) => {
    const t = (typeof text === 'string' ? text : '').trim() || inputText.trim();
    if (!t || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setInputMode(false);
    setInputText('');
    setLastQ(t);
    setPhase('thinking');
    clearTimeout(dismissTimer.current);

    try {
      const token  = user ? await getToken() : null;
      const screen = null; // Keep voice path low-latency; no automatic screenshot capture.
      const answer = await sendVoiceQuery(t, screen, token, () => {});
      setResponse(answer);
      setPhase('response');
      broadcastQA(t, answer);

      // Retract the pill only after Noah FINISHES speaking.
      // If TTS is configured, onEnd fires when audio ends → give a 3 s reading
      // grace period before collapsing. If no TTS, onEnd fires immediately →
      // keep the response visible for 12 s so the user can read it.
      const hasTTS = isTTSAvailable();
      speak(answer, null, () => scheduleIdle(hasTTS ? 3000 : 12000));
    } catch (err) {
      setResponse(err.message);
      setPhase('error');
      scheduleIdle(7000);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [inputText, user, getToken, scheduleIdle]);

  useEffect(() => { handleSendRef.current = handleSend; }, [handleSend]);

  const getRecorder = useCallback(() => {
    if (!recRef.current) {
      recRef.current = new VoiceRecorder(
        async (transcript) => {
          setMicStatus('idle');
          setPhase('thinking');
          await handleSendRef.current?.(transcript);
        },
        (err) => {
          setMicStatus('idle');
          setResponse(err);
          setPhase('error');
          scheduleIdle(6000);
        },
        (s) => {
          setMicStatus(s);
          if (s === 'listening')    setPhase('listening');
          if (s === 'transcribing') setPhase('thinking');
          if (s === 'idle' && !sendingRef.current) setPhase(p => p === 'listening' || p === 'thinking' ? 'idle' : p);
        }
      );
    }
    return recRef.current;
  }, [scheduleIdle]);

  const startListening = useCallback(() => {
    stopSpeaking();
    clearTimeout(dismissTimer.current);
    // Use the pre-warmed stream if its tracks are still live.
    // If any track has ended (OS reclaimed it), pass null so VoiceRecorder acquires a
    // fresh stream — this works because startListening is called from window.__noahPTT,
    // which runs via executeJavaScript(code, true), giving us a real user gesture.
    const stream = liveStreamRef.current;
    const allLive = stream && stream.getTracks().every(t => t.readyState === 'live');
    getRecorder().start(allLive ? stream : null);
  }, [getRecorder]);

  const stopListening = useCallback(() => {
    recRef.current?.stop();
  }, []);

  useEffect(() => {
    setPttKey(getPTTKeyLabel());
    const mgr = new PTTManager(startListening, stopListening);
    mgr.start();
    pttRef.current = mgr;
    return () => mgr.stop();
  }, [startListening, stopListening]);

  // ── window.__noahPTT — called by main.js via executeJavaScript(code, true) ──
  // executeJavaScript with userGesture=true makes Chromium treat this as a real
  // user interaction, satisfying the transient-activation requirement for
  // getUserMedia. This is the primary PTT trigger path for global shortcuts.
  useEffect(() => {
    window.__noahPTT = (active) => {
      if (active) startListening();
      else        stopListening();
    };
    return () => { try { delete window.__noahPTT; } catch {} };
  }, [startListening, stopListening]);

  // ── IPC fallback (main window / secondary windows) ────────────────────────
  useEffect(() => {
    if (!isElectron) return;
    const unsub = window.electronAPI.onPTTToggle?.((active) => {
      if (active) startListening(); else stopListening();
    });
    return () => { if (typeof unsub === 'function') unsub(); };
  }, [startListening, stopListening]);

  useEffect(() => {
    if (inputMode) setTimeout(() => inputRef.current?.focus(), 50);
  }, [inputMode]);

  const isActive    = phase !== 'idle' || inputMode;
  const hasResponse = phase === 'response' || phase === 'error' || isSpeakingState;

  useEffect(() => {
    const unsubscribe = onSpeakingStateChange((speaking) => {
      setIsSpeakingState(!!speaking);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!isElectron) return;
    if (hasResponse) window.electronAPI?.expandFloatingBar?.();
    else             window.electronAPI?.collapseFloatingBar?.();
  }, [hasResponse]);

  // ── Dynamic Island geometry ────────────────────────────────────────────────
  // Width springs to content; border-radius collapses from pill → rounded rect
  const pillWidth = phase === 'listening' ? 300
    : phase === 'thinking'               ? 200
    : inputMode                          ? 340
    : hasResponse                        ? 400
    : 178;

  const pillRadius = hasResponse ? 18 : 99;

  // Listening: green inner ring; error: red inner ring
  const ringColor = phase === 'listening'
    ? 'inset 0 0 0 1.5px rgba(74,222,128,0.55), inset 0 1px 0 rgba(255,255,255,0.08)'
    : phase === 'error'
      ? 'inset 0 0 0 1.5px rgba(239,68,68,0.45), inset 0 1px 0 rgba(255,255,255,0.06)'
      : 'inset 0 1px 0 rgba(255,255,255,0.07)';

  return (
    <div style={{
      position: 'fixed', top: 0, left: '50%',
      transform: 'translateX(-50%)',
      zIndex: 9999,
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      pointerEvents: 'none',
    }}>
      {/* ── The pill ──────────────────────────────────────────────────────── */}
      <div
        onClick={() => {
          if (phase === 'idle' && !inputMode) setInputMode(true);
          else if (hasResponse) { setPhase('idle'); clearTimeout(dismissTimer.current); }
        }}
        style={{
          pointerEvents: 'all',
          display: 'flex',
          flexDirection: 'column',
          width: pillWidth,
          minHeight: 36,
          maxHeight: hasResponse ? 320 : 36,
          borderRadius: pillRadius,

          /* ── Solid black — exactly like the Dynamic Island hardware ──────
             No transparency, no backdropFilter. The pill is always opaque.  */
          background: '#0d0d0d',
          border: '1px solid rgba(255,255,255,0.06)',
          boxShadow: ringColor,

          overflow: 'hidden',
          cursor: hasResponse ? 'pointer' : 'default',

          /* ── Spring transitions matching Dynamic Island behaviour ─────────
             width snaps with overshoot (spring bezier)
             max-height eases open after width settles
             border-radius morphs pill ↔ rounded rect                        */
          transition: [
            'width 0.45s cubic-bezier(0.34,1.56,0.64,1)',
            'max-height 0.4s cubic-bezier(0.4,0,0.2,1) 0.06s',
            'border-radius 0.35s cubic-bezier(0.4,0,0.2,1)',
            'box-shadow 0.2s ease',
          ].join(', '),
          willChange: 'width, max-height',
        }}
      >
        {/* ── Top row — always 36 px tall ─────────────────────────────── */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '0 11px', height: 36, flexShrink: 0,
        }}>
          <NoahLogo size={15} pulse={isActive} />

          <PhaseContent phaseKey={phase + String(inputMode)}>
            {phase === 'listening' && (
              <>
                <Waveform />
                <span style={{ fontSize: 10.5, color: '#4ade80', fontWeight: 500, whiteSpace: 'nowrap', letterSpacing: '0.01em' }}>
                  Listening
                </span>
              </>
            )}

            {phase === 'thinking' && (
              <>
                <Spinner />
                <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.4)', whiteSpace: 'nowrap' }}>
                  {isTranscribing ? 'Transcribing…' : 'Thinking…'}
                </span>
              </>
            )}

            {isSpeakingState && (
              <>
                <Waveform />
                <button
                  onMouseDown={e => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); stopSpeaking(); setIsSpeakingState(false); }}
                  title="Stop voice"
                  style={{
                    border: '1px solid rgba(239,68,68,0.35)',
                    background: 'rgba(239,68,68,0.12)',
                    color: '#fca5a5',
                    borderRadius: 8,
                    fontSize: 10,
                    padding: '2px 7px',
                    lineHeight: 1.4,
                    cursor: 'pointer',
                    pointerEvents: 'all',
                  }}
                >
                  Stop
                </button>
              </>
            )}

            {phase === 'response' && (
              <span style={{
                fontSize: 11, fontWeight: 500,
                color: 'rgba(255,255,255,0.8)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {response.split('\n')[0].slice(0, 50)}{response.split('\n')[0].length > 50 ? '…' : ''}
              </span>
            )}

            {phase === 'error' && (
              <span style={{ fontSize: 10.5, color: 'rgba(248,113,113,0.9)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {response.slice(0, 46)}
              </span>
            )}

            {inputMode && (
              <input
                ref={inputRef}
                value={inputText}
                onChange={e => setInputText(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleSend(inputText);
                  if (e.key === 'Escape') { setInputMode(false); setInputText(''); }
                }}
                onMouseDown={e => e.stopPropagation()}
                onClick={e => e.stopPropagation()}
                placeholder={`Ask Noah… or ${pttKey}`}
                style={{
                  flex: 1, background: 'none', border: 'none', outline: 'none',
                  fontSize: 11.5, color: 'rgba(255,255,255,0.88)', caretColor: '#4ade80',
                }}
              />
            )}

            {phase === 'idle' && !inputMode && (
              <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.22)', whiteSpace: 'nowrap', letterSpacing: '0.01em' }}>
                Noah · {globalKey}
              </span>
            )}
          </PhaseContent>

          {/* Open main window button */}
          <button
            onMouseDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); isElectron && window.electronAPI?.showMainWindow?.(); }}
            title="Open Noah"
            style={{
              outline: 'none', border: 'none', background: 'none',
              cursor: 'pointer', padding: 3, flexShrink: 0,
              color: 'rgba(255,255,255,0.18)',
              transition: 'color 0.15s',
              pointerEvents: 'all',
            }}
            onMouseEnter={e => e.currentTarget.style.color = 'rgba(255,255,255,0.6)'}
            onMouseLeave={e => e.currentTarget.style.color = 'rgba(255,255,255,0.18)'}
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          </button>
        </div>

        {/* ── Response card — slides in below the top row ───────────────── */}
        {hasResponse && (
          <div style={{
            padding: '10px 14px 12px',
            borderTop: '1px solid rgba(255,255,255,0.055)',
            animation: 'islandResponseIn 0.28s cubic-bezier(0.4,0,0.2,1) 0.09s both',
          }}>
            {lastQ && (
              <p style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.25)', marginBottom: 6, fontWeight: 500, letterSpacing: '0.01em' }}>
                You: {lastQ.slice(0, 80)}{lastQ.length > 80 ? '…' : ''}
              </p>
            )}
            <p style={{
              fontSize: 12,
              color: phase === 'error' ? 'rgba(248,113,113,0.88)' : 'rgba(255,255,255,0.82)',
              lineHeight: 1.55, maxHeight: 170, overflowY: 'auto', whiteSpace: 'pre-wrap',
            }}>
              {response}
            </p>
            <p style={{ fontSize: 9, color: 'rgba(255,255,255,0.12)', marginTop: 8, textAlign: 'right', letterSpacing: '0.02em' }}>
              tap to dismiss
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
