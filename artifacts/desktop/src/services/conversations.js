// Local conversation history stored in localStorage.
// Each session is one conversation entry.

const LS_KEY    = 'noah_conversations';
const MAX_CONVS = 100;

export function getAllConversations() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export function saveConversation(messages) {
  if (!messages?.length) return;
  // filter to only real messages (not the initial greeting)
  const turns = messages.filter(m => m.role === 'user' || (m.role === 'assistant' && messages.some(mm => mm.role === 'user')));
  if (turns.length < 2) return; // nothing worth saving

  const id      = Date.now().toString(36);
  const preview = turns.find(m => m.role === 'user')?.content?.slice(0, 80) || 'Conversation';

  const conv = {
    id,
    preview,
    created_at: Date.now(),
    messages:   messages.map(m => ({
      role:    m.role,
      content: m.content,
      time:    m.time instanceof Date ? m.time.getTime() : m.time,
    })),
  };

  const existing = getAllConversations();
  const updated  = [conv, ...existing].slice(0, MAX_CONVS);
  localStorage.setItem(LS_KEY, JSON.stringify(updated));
  return id;
}

export function deleteConversation(id) {
  const updated = getAllConversations().filter(c => c.id !== id);
  localStorage.setItem(LS_KEY, JSON.stringify(updated));
}

export function clearAllConversations() {
  localStorage.removeItem(LS_KEY);
}
