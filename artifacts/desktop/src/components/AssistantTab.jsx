import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../services/auth';
import { analyzeScreenshot, sendVoiceQuery, getHermesSessions, getHermesSessionHistory, getHermesBrainMode } from '../services/noahApi';
import { VoiceRecorder } from '../services/voiceRecorder';
import { speak, stopSpeaking, isTTSAvailable } from '../services/tts';
import { PTTManager, getPTTKeyLabel } from '../services/ptt';
import { extractAndSaveMemories } from '../services/memory';
import { saveConversation } from '../services/conversations';
import { NoahLogo } from '../App';
import {
  Mic01Icon, MicOff01Icon, EyeIcon, SentIcon,
  VolumeHighIcon, VolumeLowIcon, FlashIcon, GlobeIcon,
  CommandLineIcon, Archive01Icon, Add01Icon, Clock01Icon, ArrowLeft01Icon,
} from 'hugeicons-react';

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

// ─── Action badge ──────────────────────────────────────────────────────────────
const ACTION_ICONS = {
  save_memory:       <Archive01Icon size={12} strokeWidth={1.8} />,
  get_memories:      <Archive01Icon size={12} strokeWidth={1.8} />,
  list_skills:       <FlashIcon size={12} strokeWidth={1.8} />,
  view_skill:        <FlashIcon size={12} strokeWidth={1.8} />,
  save_skill:        <FlashIcon size={12} strokeWidth={1.8} />,
  search_history:    <Clock01Icon size={12} strokeWidth={1.8} />,
  terminal:          <CommandLineIcon size={12} strokeWidth={1.8} />,
  run_applescript:   <CommandLineIcon size={12} strokeWidth={1.8} />,
  open_url:          <GlobeIcon size={12} strokeWidth={1.8} />,
  search_web:        <GlobeIcon size={12} strokeWidth={1.8} />,
  fetch_webpage:     <GlobeIcon size={12} strokeWidth={1.8} />,
  api_call:          <FlashIcon size={12} strokeWidth={1.8} />,
  read_file:         <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>,
  write_file:        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
  list_directory:    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>,
  show_notification: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0"/></svg>,
};

function ActionBadge({ action }) {
  if (!action) return null;
  const icon = ACTION_ICONS[action.type] || <FlashIcon size={12} strokeWidth={1.8} />;
  return (
    <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs max-w-[90%]"
      style={{ background: 'rgba(22,163,74,0.08)', border: '1px solid rgba(22,163,74,0.15)' }}>
      <span className={action.status === 'error' ? 'text-red-400' : 'text-green-400'}>{icon}</span>
      {action.status === 'running' && <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse flex-shrink-0" />}
      <span className="truncate text-white/55">{action.label}</span>
      {action.status === 'done'  && <span className="text-green-400 flex-shrink-0 text-[10px]">✓</span>}
      {action.status === 'error' && <span className="text-red-400  flex-shrink-0 text-[10px]">✗</span>}
    </div>
  );
}

// ─── Listening bars ─────────────────────────────────────────────────────────────
function ListeningBars({ active }) {
  if (!active) return null;
  const heights = [35, 65, 100, 80, 55, 90, 45, 70, 55, 40];
  return (
    <div className="flex items-center gap-3 slide-up">
      <div className="flex items-center gap-[3px]" style={{ height: 28 }}>
        {heights.map((h, i) => (
          <div key={i} className="rounded-full"
            style={{
              width: 3, height: `${h}%`,
              background: 'linear-gradient(to top, #16a34a, #4ade80)',
              animation: `waveform ${0.6 + i * 0.07}s ease-in-out infinite alternate`,
              animationDelay: `${i * 0.06}s`,
              transformOrigin: 'bottom',
            }}
          />
        ))}
      </div>
      <span className="text-xs font-medium text-green-400">Listening…</span>
      <span className="text-[10px] text-white/30">Release to send</span>
    </div>
  );
}

// ─── Streaming cursor ────────────────────────────────────────────────────────────
function StreamingCursor() {
  return (
    <span
      className="inline-block w-[2px] h-[1em] ml-0.5 align-middle rounded-full bg-white/60"
      style={{ animation: 'blink-cursor 0.8s step-end infinite' }}
    />
  );
}

// ─── Message bubble ─────────────────────────────────────────────────────────────
function Message({ msg, isLast, isSpeaking }) {
  const isAssistant = msg.role === 'assistant';
  const fmt = (d) => (d instanceof Date ? d : new Date(d)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <div className={`flex gap-3 slide-up ${isAssistant ? 'justify-start' : 'justify-end'}`}>
      {isAssistant && (
        <NoahLogo size={26} className={`flex-shrink-0 mt-0.5 ${isSpeaking && isLast ? 'glow-pulse' : ''}`} />
      )}
      <div className={`max-w-[78%] flex flex-col gap-1 ${isAssistant ? 'items-start' : 'items-end'}`}>
        <div
          className={`px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${isAssistant ? 'msg-noah' : 'msg-user'}`}
          style={isAssistant ? { borderTopLeftRadius: 4 } : { borderTopRightRadius: 4 }}
        >
          {msg.content}
          {msg.streaming && <StreamingCursor />}
        </div>
        <span className="text-[10px] text-white/22">{fmt(msg.time)}</span>
      </div>
    </div>
  );
}

// ─── Screen watch badge ─────────────────────────────────────────────────────────
function ScreenWatchBadge({ active, onClick }) {
  return (
    <button onClick={onClick}
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all"
      style={active ? {
        background: 'rgba(22,163,74,0.15)', border: '1px solid rgba(22,163,74,0.35)', color: '#4ade80',
      } : {
        background: 'transparent', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(228,240,232,0.35)',
      }}>
      <span className="relative flex-shrink-0">
        {active && <span className="absolute inset-0 rounded-full bg-green-400/30 animate-ping" style={{ scale: '1.8' }} />}
        <EyeIcon size={12} strokeWidth={active ? 2 : 1.6} />
      </span>
      {active ? 'Screen watch on' : 'Screen watch'}
    </button>
  );
}

// ─── INITIAL WELCOME ────────────────────────────────────────────────────────────
const WELCOME = {
  role: 'assistant',
  content: "Hi! I'm Noah, your personal AI assistant. I learn from our conversations and adapt to you over time. Hold your configured key to talk, or type below.",
  time: new Date(),
};

// ─── Main component ─────────────────────────────────────────────────────────────
// messages + setMessages are lifted to MainScreen so they survive tab switches
export default function AssistantTab({ messages, setMessages }) {
  const { user, getToken }                = useAuth();
  const [input,          setInput]        = useState('');
  const [micStatus,      setMicStatus]    = useState('idle');
  const [isLoading,      setIsLoading]    = useState(false);
  const [isSpeakingState,setIsSpeakingState] = useState(false);
  const [speakerOn,      setSpeakerOn]    = useState(isTTSAvailable());
  const [currentAction,  setCurrentAction] = useState(null);
  const [screenWatchOn,  setScreenWatchOn] = useState(false);
  const [pttKeyLabel,    setPttKeyLabel]  = useState('');
  const [savedFlash,     setSavedFlash]   = useState(false);
  const [showHistory,    setShowHistory]  = useState(false);
  const [isHermesMode,   setIsHermesMode]  = useState(false);
  const [historySessions, setHistorySessions] = useState([]);
  const [historyLoading, setHistoryLoading]   = useState(false);
  const [historyError,   setHistoryError]     = useState(null);
  const [restoringId,    setRestoringId]      = useState(null);

  const recorderRef    = useRef(null);
  const pttRef         = useRef(null);
  const watchScreenRef = useRef(null);
  const watchTimerRef  = useRef(null);
  const bottomRef      = useRef(null);
  const lastUserMsgRef = useRef('');
  const handleSendRef  = useRef(null); // always points to latest handleSend (avoids stale closures)
  const sendingRef     = useRef(false); // mutex — prevents double-send from concurrent PTT/IPC events
  const streamingRef   = useRef(false); // true while SSE streaming is in progress

  const scrollToBottom = () => bottomRef.current?.scrollIntoView({ behavior: 'smooth' });

  const addMessage = useCallback((role, content) => {
    setMessages(prev => [...prev, { role, content, time: new Date() }]);
    setTimeout(scrollToBottom, 80);
  }, [setMessages]);

  // Receive Q&A pairs from the floating bar.
  // Uses a dedup set so the same exchange never appears twice even if multiple channels fire.
  useEffect(() => {
    const seen = new Set();

    const append = ({ question, answer, id } = {}) => {
      if (!question) return;
      const key = id ? String(id) : `${question}::${answer}`;
      if (seen.has(key)) return;
      seen.add(key);
      setMessages(prev => [
        ...prev,
        { role: 'user',      content: question, time: new Date() },
        { role: 'assistant', content: answer,   time: new Date() },
      ]);
      setTimeout(scrollToBottom, 80);
    };

    // 1. Electron IPC — drain any Q&A that arrived before this component mounted
    //    then subscribe to live events
    let ipcUnsub;
    if (isElectron) {
      window.electronAPI.drainFloatingQA?.().then(items => {
        (items || []).forEach(append);
      }).catch(() => {});
      try { ipcUnsub = window.electronAPI.onFloatingQA?.(append); } catch {}
    }

    // 2. localStorage storage event (fires in other windows when floating bar writes)
    const onStorage = (e) => {
      if (e.key === 'noah_floating_qa_latest' && e.newValue) {
        try { append(JSON.parse(e.newValue)); } catch {}
      }
    };
    window.addEventListener('storage', onStorage);

    // 3. BroadcastChannel fallback (web preview)
    let bc;
    try {
      bc = new BroadcastChannel('noah_floating_qa');
      bc.onmessage = (e) => append(e.data || {});
    } catch {}

    return () => {
      if (typeof ipcUnsub === 'function') ipcUnsub();
      window.removeEventListener('storage', onStorage);
      try { bc?.close(); } catch {}
    };
  }, [setMessages]);

  const speakResponse = useCallback(async (text) => {
    if (!speakerOn || !isTTSAvailable()) return;
    setIsSpeakingState(true);
    await speak(text, () => setIsSpeakingState(true), () => setIsSpeakingState(false));
  }, [speakerOn]);

  // ── Voice recorder ──────────────────────────────────────────────────────────
  const getRecorder = useCallback(() => {
    if (!recorderRef.current) {
      recorderRef.current = new VoiceRecorder(
        // Use handleSendRef so this closure always calls the latest handleSend,
        // even after messages have changed (avoids stale conversation history)
        async (transcript) => { setMicStatus('idle'); await handleSendRef.current?.(transcript, true); },
        (err) => { setMicStatus('idle'); addMessage('assistant', `🎤 ${err}`); },
        (s) => setMicStatus(s)
      );
    }
    return recorderRef.current;
  }, [addMessage]);

  const startListening = useCallback(() => { stopSpeaking(); setIsSpeakingState(false); getRecorder().start(); }, [getRecorder]);
  const stopListening  = useCallback(() => { recorderRef.current?.stop(); }, []);
  const toggleListening = useCallback(() => {
    if (micStatus === 'listening') stopListening();
    else if (micStatus === 'idle') startListening();
  }, [micStatus, startListening, stopListening]);

  // ── PTT ──────────────────────────────────────────────────────────────────────
  useEffect(() => {
    try {
      setPttKeyLabel(getPTTKeyLabel());
      const mgr = new PTTManager(startListening, stopListening);
      mgr.start();
      pttRef.current = mgr;
      return () => mgr.stop();
    } catch (err) {
      console.error('[Noah] PTT initialization failed:', err);
      // Don't crash the app if PTT fails to initialize
    }
  }, [startListening, stopListening]);

  // Load Hermes brain mode on component mount
  useEffect(() => {
    const loadBrainMode = async () => {
      const mode = await getHermesBrainMode();
      setIsHermesMode(mode === 'hermes');
    };
    loadBrainMode();
  }, []);

  useEffect(() => {
    if (!isElectron) return;
    const unsub = window.electronAPI.onPTTToggle?.((active) => {
      if (active) startListening(); else stopListening();
    });
    return () => { if (typeof unsub === 'function') unsub(); };
  }, [startListening, stopListening]);

  // ── Screen watch ────────────────────────────────────────────────────────────
  const captureScreen = async () => isElectron ? window.electronAPI.captureScreen() : null;

  useEffect(() => {
    if (screenWatchOn) {
      const capture = async () => { const s = await captureScreen(); if (s) watchScreenRef.current = s; };
      capture();
      watchTimerRef.current = setInterval(capture, 3000);
    } else {
      clearInterval(watchTimerRef.current);
      watchTimerRef.current = null;
    }
    return () => clearInterval(watchTimerRef.current);
  }, [screenWatchOn]);

  // ── Save chat ───────────────────────────────────────────────────────────────
  const saveChat = useCallback(() => {
    if (messages.length < 2) return;
    saveConversation(messages);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 2000);
  }, [messages]);

  // ── New chat ─────────────────────────────────────────────────────────────────
  const newChat = useCallback(() => {
    if (messages.length > 1) saveConversation(messages);
    setMessages([{ ...WELCOME, time: new Date() }]);
  }, [messages, setMessages]);

  // ── History panel ─────────────────────────────────────────────────────────
  const openHistory = useCallback(async () => {
    setShowHistory(true);
    setHistoryError(null);
    setHistoryLoading(true);
    try {
      const token = user ? await getToken() : null;
      const data = await getHermesSessions(token);
      setHistorySessions(data.sessions || []);
    } catch (err) {
      setHistoryError(err.message);
    } finally {
      setHistoryLoading(false);
    }
  }, [user, getToken]);

  const restoreSession = useCallback(async (session) => {
    setRestoringId(session.session_id);
    try {
      const token = user ? await getToken() : null;
      const data = await getHermesSessionHistory(session.session_id, token);
      const restored = (data.messages || []).map(m => ({
        role: m.role,
        content: m.content,
        time: new Date(),
      }));
      if (restored.length === 0) {
        restored.push({ role: 'assistant', content: 'No messages found in this session.', time: new Date() });
      }
      setMessages(restored);
      try { localStorage.setItem('noah_hermes_session', session.session_id); } catch {}
      setShowHistory(false);
      setTimeout(scrollToBottom, 100);
    } catch (err) {
      setHistoryError(`Could not load session: ${err.message}`);
    } finally {
      setRestoringId(null);
    }
  }, [user, getToken, setMessages]);

  // ── Streaming token helpers ───────────────────────────────────────────────
  const addStreamingMessage = useCallback(() => {
    setMessages(prev => [...prev, { role: 'assistant', content: '', time: new Date(), streaming: true }]);
    setTimeout(scrollToBottom, 50);
  }, [setMessages]);

  const updateStreamingMessage = useCallback((content) => {
    setMessages(prev => {
      const last = prev[prev.length - 1];
      if (!last || !last.streaming) return prev;
      return [...prev.slice(0, -1), { ...last, content }];
    });
    setTimeout(scrollToBottom, 50);
  }, [setMessages]);

  const finalizeStreamingMessage = useCallback((finalContent) => {
    setMessages(prev => {
      const last = prev[prev.length - 1];
      if (!last || !last.streaming) return prev;
      return [...prev.slice(0, -1), { ...last, content: finalContent, streaming: false }];
    });
    setTimeout(scrollToBottom, 80);
  }, [setMessages]);

  // ── Send ────────────────────────────────────────────────────────────────────
  const handleSend = useCallback(async (text, voiceTriggered = false) => {
    if (!text?.trim() || isLoading || sendingRef.current) return;
    sendingRef.current = true;
    stopSpeaking(); setIsSpeakingState(false);
    lastUserMsgRef.current = text;
    addMessage('user', text);
    setInput('');
    setIsLoading(true);
    setCurrentAction(null);
    streamingRef.current = false;

    const onAction = (action) => {
      if (action.type === 'hermes_token') {
        if (!streamingRef.current) {
          streamingRef.current = true;
          addStreamingMessage();
        }
        updateStreamingMessage(action.content);
      } else {
        setCurrentAction(action);
      }
    };

    try {
      const token  = user ? await getToken() : null;
      // Only pass screen when Screen Watch is explicitly toggled ON by the user.
      // Never silently capture for voice queries — it causes Noah to confuse the
      // Noah app itself as "a screenshot" in the conversation context.
      const screen = screenWatchOn ? (watchScreenRef.current || await captureScreen()) : null;

      // Build history from current messages (exclude the welcome message, include real turns)
      const history = messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .filter(m => m.content && m.content !== WELCOME.content)
        .map(m => ({ role: m.role, content: m.content }));

      const answer = await sendVoiceQuery(text, screen, token, onAction, history);
      setCurrentAction(null);

      if (streamingRef.current) {
        streamingRef.current = false;
        finalizeStreamingMessage(answer);
      } else {
        addMessage('assistant', answer);
      }

      speakResponse(answer);

      // Extract and save memories in background (non-blocking)
      extractAndSaveMemories(text, answer).catch(() => {});
    } catch (err) {
      setCurrentAction(null);
      if (streamingRef.current) {
        streamingRef.current = false;
        finalizeStreamingMessage(`Something went wrong: ${err.message}`);
      } else {
        addMessage('assistant', `Something went wrong: ${err.message}`);
      }
    } finally { setIsLoading(false); sendingRef.current = false; }
  }, [isLoading, user, getToken, screenWatchOn, addMessage, addStreamingMessage, updateStreamingMessage, finalizeStreamingMessage, speakResponse, messages]);

  // Keep the ref in sync so VoiceRecorder callbacks always call the latest version
  useEffect(() => { handleSendRef.current = handleSend; }, [handleSend]);

  // Screen analyze
  const handleAnalyzeScreen = async () => {
    stopSpeaking(); setIsLoading(true);
    addMessage('user', 'Analyze my screen');
    try {
      const token  = user ? await getToken() : null;
      const screen = await captureScreen();
      if (!screen) { addMessage('assistant', 'Could not capture screen. Go to System Settings → Privacy & Security → Screen Recording and allow Noah.'); return; }
      watchScreenRef.current = screen;
      const result = await analyzeScreenshot(screen, token, '');
      const answer = result.insight || 'Screen analyzed.';
      addMessage('assistant', answer);
      speakResponse(answer);
    } catch (err) { addMessage('assistant', `Screen analysis failed: ${err.message}`); }
    finally { setIsLoading(false); }
  };

  const toggleSpeaker = () => {
    if (isSpeakingState) { stopSpeaking(); setIsSpeakingState(false); }
    setSpeakerOn(prev => !prev);
  };

  const isListening    = micStatus === 'listening';
  const isTranscribing = micStatus === 'transcribing';
  const hasRealMessages = messages.some(m => m.role === 'user');

  const fmtDate = (ts) => {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d)) return '';
    const now = new Date();
    const diffDays = Math.floor((now - d) / 86400000);
    if (diffDays === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'short' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  return (
    <div className="flex flex-col h-full">
      {/* ── Header ── */}
      <div className="px-5 py-3 flex items-center gap-3 flex-shrink-0"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        {showHistory ? (
          <>
            <button onClick={() => setShowHistory(false)} className="btn-icon" title="Back to chat">
              <ArrowLeft01Icon size={13} strokeWidth={1.8} />
            </button>
            <div className="flex-1">
              <h2 className="text-sm font-semibold text-white/80">Past Conversations</h2>
              <p className="text-[11px] text-white/28">Click a session to restore it</p>
            </div>
          </>
        ) : (
          <>
            <div className="flex-1">
              <h2 className="text-sm font-semibold text-white/80">Assistant</h2>
              <p className="text-[11px] text-white/28">
                Hold <kbd className="px-1 py-0.5 rounded text-[10px] font-mono bg-white/8 text-white/45">{pttKeyLabel}</kbd> to talk
                {screenWatchOn && <span className="ml-2 text-green-400/80">· watching screen</span>}
              </p>
            </div>
            <ScreenWatchBadge active={screenWatchOn} onClick={() => setScreenWatchOn(v => !v)} />
            {/* History (Hermes mode only) */}
            {isHermesMode && (
              <button onClick={openHistory} className="btn-icon" title="Past conversations">
                <Clock01Icon size={13} strokeWidth={1.8} />
              </button>
            )}
            {/* Save chat */}
            {hasRealMessages && (
              <button onClick={saveChat}
                className="flex items-center gap-1.5 btn-ghost px-2.5 py-1 text-[11px]"
                style={savedFlash ? { color: '#4ade80', borderColor: 'rgba(22,163,74,0.3)' } : {}}>
                <Archive01Icon size={11} strokeWidth={1.8} />
                {savedFlash ? 'Saved!' : 'Save'}
              </button>
            )}
            {/* New chat */}
            {hasRealMessages && (
              <button onClick={newChat} className="btn-icon" title="New chat">
                <Add01Icon size={13} strokeWidth={1.8} />
              </button>
            )}
            {/* Speaker toggle */}
            <button onClick={toggleSpeaker} className="btn-icon"
              style={isSpeakingState ? { borderColor: 'rgba(22,163,74,0.5)', color: '#4ade80', background: 'rgba(22,163,74,0.12)' } : {}}>
              {speakerOn ? <VolumeHighIcon size={14} strokeWidth={1.8} /> : <VolumeLowIcon size={14} strokeWidth={1.8} />}
            </button>
          </>
        )}
      </div>

      {/* ── History Panel ── */}
      {showHistory && (
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
          {historyError && (
            <div className="px-4 py-3 rounded-xl text-xs text-red-400"
              style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)' }}>
              {historyError}
            </div>
          )}
          {historyLoading && (
            <div className="flex items-center gap-3 px-4 py-8 justify-center text-white/30 text-xs">
              <div className="w-4 h-4 border-2 border-white/15 border-t-green-400/60 rounded-full animate-spin" />
              Loading sessions…
            </div>
          )}
          {!historyLoading && !historyError && historySessions.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-12 text-white/28 text-xs text-center">
              <Clock01Icon size={28} strokeWidth={1.4} />
              <span>No past conversations yet</span>
              <span className="text-white/18">Hermes saves sessions automatically as you chat</span>
            </div>
          )}
          {!historyLoading && historySessions.map((session) => (
            <button
              key={session.session_id}
              onClick={() => restoreSession(session)}
              disabled={restoringId === session.session_id}
              className="w-full text-left px-4 py-3 rounded-xl transition-all"
              style={{
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.07)',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(22,163,74,0.07)'; e.currentTarget.style.borderColor = 'rgba(22,163,74,0.2)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)'; }}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="text-[13px] font-medium text-white/75 truncate leading-snug">
                  {session.title || 'Untitled session'}
                </span>
                <span className="text-[10px] text-white/28 flex-shrink-0 mt-0.5">
                  {fmtDate(session.started_at)}
                </span>
              </div>
              {session.preview && (
                <p className="text-[11px] text-white/35 mt-1 truncate">{session.preview}</p>
              )}
              <div className="flex items-center gap-3 mt-1.5">
                {session.message_count != null && (
                  <span className="text-[10px] text-white/22">{session.message_count} messages</span>
                )}
                {restoringId === session.session_id && (
                  <div className="w-3 h-3 border border-white/20 border-t-green-400/60 rounded-full animate-spin" />
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* ── Chat view (hidden while history panel is open) ── */}
      {!showHistory && (
        <>
          {/* ── Listening banner ── */}
          {isListening && (
            <div className="mx-4 mt-3 px-5 py-3.5 rounded-2xl flex items-center gap-4 slide-up flex-shrink-0"
              style={{ background: 'rgba(22,163,74,0.08)', border: '1px solid rgba(22,163,74,0.25)', boxShadow: '0 0 24px rgba(22,163,74,0.08) inset' }}>
              <ListeningBars active />
            </div>
          )}

          {/* ── Messages ── */}
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            {messages.map((msg, i) => (
              <Message key={i} msg={msg} isLast={i === messages.length - 1} isSpeaking={isSpeakingState} />
            ))}

            {isLoading && (
              <div className="flex flex-col gap-2">
                <div className="flex gap-3 justify-start">
                  <NoahLogo size={26} className="flex-shrink-0 mt-0.5" />
                  <div className="px-4 py-3 rounded-2xl rounded-tl-sm msg-noah">
                    <div className="flex gap-1 items-center">
                      {[0,1,2].map(i => (
                        <div key={i} className="w-1.5 h-1.5 rounded-full bg-green-400 animate-bounce"
                          style={{ animationDelay: `${i * 0.15}s` }} />
                      ))}
                    </div>
                  </div>
                </div>
                {currentAction && <div className="ml-9"><ActionBadge action={currentAction} /></div>}
              </div>
            )}

            {isSpeakingState && !isLoading && (
              <div className="flex items-center gap-2 px-1">
                <div className="flex gap-0.5 items-end h-4">
                  {[0,1,2,3,4].map(i => (
                    <div key={i} className="w-0.5 rounded-full wave-bar bg-green-400"
                      style={{ height: `${[55,90,70,90,55][i]}%`, animationDelay: `${i*0.12}s` }} />
                  ))}
                </div>
                <span className="text-xs text-green-400">Noah is speaking</span>
                <button onClick={() => { stopSpeaking(); setIsSpeakingState(false); }}
                  className="text-[10px] underline text-white/28 hover:text-white/55 transition-colors">stop</button>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* ── Status strip ── */}
          {(isTranscribing || isLoading) && !isListening && (
            <div className="px-5 py-1.5 flex items-center gap-2 flex-shrink-0"
              style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
              <div className={`w-2 h-2 rounded-full flex-shrink-0 animate-pulse ${isTranscribing ? 'bg-amber-400' : 'bg-green-400'}`} />
              <span className="text-xs text-white/35">{isTranscribing ? 'Transcribing…' : 'Thinking…'}</span>
            </div>
          )}

          {/* ── Input bar ── */}
          <div className="px-4 pb-4 pt-2.5 flex-shrink-0"
            style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
            <div className="flex items-center gap-2">
              <button onClick={handleAnalyzeScreen} disabled={isLoading || micStatus !== 'idle'}
                title="Analyze screen" className="btn-icon flex-shrink-0">
                <EyeIcon size={14} strokeWidth={1.8} />
              </button>
              <input
                type="text"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(input); } }}
                placeholder={
                  isListening    ? 'Release key to send…' :
                  isTranscribing ? 'Transcribing…' :
                  isLoading      ? 'Thinking…' :
                  screenWatchOn  ? 'Ask about your screen…' :
                  'Ask Noah anything…'
                }
                className="noah-input flex-1 px-4 py-2.5 text-sm"
                disabled={micStatus !== 'idle' || isLoading}
              />
              <button onClick={toggleListening} disabled={isTranscribing || isLoading}
                className="btn-icon flex-shrink-0 relative"
                style={isListening ? { background: 'rgba(239,68,68,0.12)', borderColor: 'rgba(239,68,68,0.4)', color: '#f87171' }
                  : isTranscribing ? { background: 'rgba(245,158,11,0.1)', borderColor: 'rgba(245,158,11,0.3)', color: '#fbbf24' } : {}}>
                {isListening && <div className="absolute inset-0 rounded-lg bg-red-500/8 listening-ring" />}
                {isListening ? <MicOff01Icon size={14} strokeWidth={1.8} /> : <Mic01Icon size={14} strokeWidth={1.8} />}
              </button>
              <button onClick={() => handleSend(input)}
                disabled={!input.trim() || isLoading || micStatus !== 'idle'}
                className="btn-green w-9 h-9 flex items-center justify-center flex-shrink-0"
                style={{ borderRadius: 10 }}>
                <SentIcon size={13} strokeWidth={2} />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
