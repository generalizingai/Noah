// Noah's local long-term memory system.
// Learns facts about the user from every conversation and stores them in localStorage.
// Facts are injected into every system prompt so Noah always remembers.

import { getOpenAIKey } from './keys';

const LS_KEY  = 'noah_user_memories';
const MAX_MEM = 120; // max number of memory entries

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export function getAllMemories() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export function addMemory(text) {
  if (!text?.trim()) return;
  const existing = getAllMemories();
  // Deduplicate by checking similarity (simple substring check)
  const lower = text.toLowerCase().trim();
  const alreadyKnown = existing.some(m => {
    const ml = m.text.toLowerCase();
    return ml === lower || ml.includes(lower) || lower.includes(ml);
  });
  if (alreadyKnown) return;

  const newMem = {
    id:         Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    text:       text.trim(),
    created_at: Date.now(),
  };
  const updated = [newMem, ...existing].slice(0, MAX_MEM);
  localStorage.setItem(LS_KEY, JSON.stringify(updated));
}

export function deleteMemory(id) {
  const updated = getAllMemories().filter(m => m.id !== id);
  localStorage.setItem(LS_KEY, JSON.stringify(updated));
}

export function clearAllMemories() {
  localStorage.removeItem(LS_KEY);
}

export function updateMemory(id, newText) {
  const updated = getAllMemories().map(m => m.id === id ? { ...m, text: newText, updated_at: Date.now() } : m);
  localStorage.setItem(LS_KEY, JSON.stringify(updated));
}

// ─── Format for system prompt ─────────────────────────────────────────────────

export function buildMemoryContext() {
  const mems = getAllMemories();
  if (mems.length === 0) return '';
  const lines = mems.slice(0, 60).map(m => `- ${m.text}`).join('\n');
  return `# What I know about you\n${lines}`;
}

// ─── AI extraction ─────────────────────────────────────────────────────────────
// After each conversation turn, silently extract new user facts.

export async function extractAndSaveMemories(userMessage, assistantResponse) {
  const key = getOpenAIKey();
  if (!key) return;

  const combined = `User: ${userMessage}\nNoah: ${assistantResponse}`;
  if (combined.length < 40) return; // too short to extract anything

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You extract personal facts about the USER (not the AI) from conversation snippets.
Return a JSON array of short factual strings (max 25 words each).
Focus on: preferences, habits, dislikes, work style, personality traits, technical skills, goals, relationships, context.
Examples: "Prefers dark mode and minimal UI", "Works in software engineering", "Dislikes verbose explanations", "Based in San Francisco".
If nothing notable, return [].
Never include: what the AI said, generic statements, or things about the AI. ONLY JSON array.`,
          },
          { role: 'user', content: combined.slice(0, 1200) },
        ],
        max_tokens:  250,
        temperature: 0.1,
      }),
    });

    if (!res.ok) return;
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content?.trim() || '[]';
    // Find JSON array in response
    const match = content.match(/\[[\s\S]*\]/);
    if (!match) return;
    const facts = JSON.parse(match[0]);
    if (!Array.isArray(facts)) return;
    facts.forEach(f => { if (typeof f === 'string' && f.trim()) addMemory(f.trim()); });
  } catch {
    // Silent fail — memory extraction should never break the main flow
  }
}
