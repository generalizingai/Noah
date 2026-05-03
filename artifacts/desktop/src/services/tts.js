import { getDeepgramKey, getIntegrationToken, getVoiceModel } from './keys';

let currentAudio = null;

// ─── Provider detection ───────────────────────────────────────────────────────

export function getActiveTTSProvider() {
  const elKey = getIntegrationToken('elevenlabs_key');
  const dgKey = getDeepgramKey();
  console.log('[Noah TTS] Provider check:', { elKey: !!elKey, dgKey: !!dgKey });
  if (elKey) return 'elevenlabs';
  if (dgKey) return 'deepgram';
  return null;
}

export function isTTSAvailable() {
  const available = !!getActiveTTSProvider();
  console.log('[Noah TTS] isTTSAvailable:', available, 'Provider:', getActiveTTSProvider());
  return available;
}

export function stopSpeaking() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = '';
    currentAudio = null;
  }
}

export function isSpeaking() {
  return !!(currentAudio && !currentAudio.paused);
}

// ─── ElevenLabs TTS ───────────────────────────────────────────────────────────

async function speakElevenLabs(text, voiceId, apiKey, onStart, onEnd) {
  const vid = voiceId || '21m00Tcm4TlvDq8ikWAM'; // Rachel (default)

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}`, {
    method: 'POST',
    headers: {
      'xi-api-key':   apiKey,
      'Content-Type': 'application/json',
      'Accept':       'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_turbo_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.35, use_speaker_boost: true },
    }),
  });

  if (!res.ok) throw new Error(`ElevenLabs TTS error ${res.status}`);

  const blob  = await res.blob();
  const url   = URL.createObjectURL(blob);
  const audio = new Audio(url);
  currentAudio = audio;

  audio.onplay  = () => onStart?.();
  audio.onended = () => { URL.revokeObjectURL(url); currentAudio = null; onEnd?.(); };
  audio.onerror = () => { URL.revokeObjectURL(url); currentAudio = null; onEnd?.(); };
  await audio.play();
}

// ─── Deepgram TTS ─────────────────────────────────────────────────────────────

async function speakDeepgram(text, voice, apiKey, onStart, onEnd) {
  const res = await fetch(`https://api.deepgram.com/v1/speak?model=${voice}`, {
    method: 'POST',
    headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) throw new Error(`Deepgram TTS error ${res.status}`);

  const blob  = await res.blob();
  const url   = URL.createObjectURL(blob);
  const audio = new Audio(url);
  currentAudio = audio;

  audio.onplay  = () => onStart?.();
  audio.onended = () => { URL.revokeObjectURL(url); currentAudio = null; onEnd?.(); };
  audio.onerror = () => { URL.revokeObjectURL(url); currentAudio = null; onEnd?.(); };
  await audio.play();
}

// ─── Main speak function ─────────────────────────────────────────────────────

export async function speak(text, onStart, onEnd) {
  if (!text?.trim()) { onEnd?.(); return; }
  stopSpeaking();

  const elKey   = getIntegrationToken('elevenlabs_key');
  const dgKey   = getDeepgramKey();
  const voice   = getVoiceModel(); // either a DG model or EL voice ID

  try {
    if (elKey) {
      await speakElevenLabs(text, voice, elKey, onStart, onEnd);
    } else if (dgKey) {
      await speakDeepgram(text, voice || 'aura-asteria-en', dgKey, onStart, onEnd);
    } else {
      console.warn('No TTS provider configured');
      onEnd?.();
    }
  } catch (err) {
    console.error('TTS failed:', err);
    onEnd?.();
  }
}

// Preview a voice with a short sample
export async function previewVoice(voiceId, provider, apiKey) {
  const sample = 'Hey there! I\'m Noah, your personal AI assistant. How can I help you today?';
  stopSpeaking();
  if (provider === 'elevenlabs') {
    await speakElevenLabs(sample, voiceId, apiKey, null, null);
  } else {
    await speakDeepgram(sample, voiceId, apiKey, null, null);
  }
}

// ─── Voice catalogues ─────────────────────────────────────────────────────────

export const ELEVENLABS_VOICES = [
  // Female
  { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel',   gender: 'Female', tone: 'Calm & conversational' },
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella',    gender: 'Female', tone: 'Soft & expressive' },
  { id: 'AZnzlk1XvdvUeBnXmlld', name: 'Domi',     gender: 'Female', tone: 'Strong & confident' },
  { id: 'LcfcDJNUP1GQjkzn1xUU', name: 'Emily',    gender: 'Female', tone: 'Calm & pleasant' },
  { id: 'ThT5KcBeYPX3keUQqHPh', name: 'Dorothy',  gender: 'Female', tone: 'British & pleasant' },
  { id: 'MF3mGyEYCl7XYWbV9V6O', name: 'Elli',     gender: 'Female', tone: 'Emotional & young' },
  { id: 'XrExE9yKIg1WjnnlVkGX', name: 'Matilda',  gender: 'Female', tone: 'Warm & confident' },
  { id: 'Xb7hH8MSUJpSbSDYk0k2', name: 'Alice',    gender: 'Female', tone: 'Confident & upbeat' },
  { id: 'cgSgspJ2msm6clMCkdW9', name: 'Jessica',  gender: 'Female', tone: 'Expressive & emotive' },
  { id: 'oWAxZDx7w5VEj9dCyTzz', name: 'Grace',    gender: 'Female', tone: 'Southern American' },
  { id: 'g5CIjZEefAph4nQFvHAz', name: 'Serena',   gender: 'Female', tone: 'Pleasant & clear' },
  { id: 'z9fAnlkpzviPz146aGWa', name: 'Glinda',   gender: 'Female', tone: 'Unique & dramatic' },
  { id: 'XB0fDUnXU5powFXDhCwa', name: 'Charlotte', gender: 'Female', tone: 'Seductive & Swedish' },
  { id: 'jBpfuIE2acCO8z3wKNLl', name: 'Freya',    gender: 'Female', tone: 'Casual & American' },
  { id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily',     gender: 'Female', tone: 'Raspy & warm' },
  { id: 'EkK5I0T9Oig0j3j6I2e7', name: 'Sarah',    gender: 'Female', tone: 'Soft & natural' },
  { id: 'FGY2WhTYpPnrIDTdsKH5', name: 'Laura',    gender: 'Female', tone: 'Upbeat & clear' },
  // Male
  { id: 'ErXwobaYiN019PkySvjV', name: 'Antoni',   gender: 'Male',   tone: 'Well-rounded & refined' },
  { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam',     gender: 'Male',   tone: 'Deep & professional' },
  { id: 'TxGEqnHWrfWFTfGW9XjX', name: 'Josh',     gender: 'Male',   tone: 'Deep & warm' },
  { id: 'VR6AewLTigWG4xSOukaG', name: 'Arnold',   gender: 'Male',   tone: 'Crisp & clear' },
  { id: 'yoZ06aMxZJJ28mfd3POQ', name: 'Sam',      gender: 'Male',   tone: 'Raspy & intense' },
  { id: 'D38z5RcWu1voky8WS1ja', name: 'Fin',      gender: 'Male',   tone: 'Irish & warm' },
  { id: 'N2lVS1w4EtoT3dr4eOWO', name: 'Callum',   gender: 'Male',   tone: 'Intense & transatlantic' },
  { id: 'TX3LPaxmHKxFdv7VOFE1', name: 'Liam',     gender: 'Male',   tone: 'Articulate & American' },
  { id: 'nPczCjzI2devNBz1zQrb', name: 'Brian',    gender: 'Male',   tone: 'Deep & authoritative' },
  { id: 'GBv7mTt0atIp3Br8iCZE', name: 'Thomas',   gender: 'Male',   tone: 'Calm & meditative' },
  { id: 'ODq5zmih8GrVes37Dx0d', name: 'Patrick',  gender: 'Male',   tone: 'Strong & confident' },
  { id: 'SOYHLrjzK2X1ezoPC6cr', name: 'Harry',    gender: 'Male',   tone: 'Anxious & young adult' },
  { id: 'ZQe5CZNOzWyzPSCn5a3c', name: 'James',    gender: 'Male',   tone: 'Calm & rich' },
  { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel',   gender: 'Male',   tone: 'Deep & British' },
  { id: 'flq6f7yk4E4fJM5XTYuZ', name: 'Michael',  gender: 'Male',   tone: 'Old US accent' },
  { id: 'IKne3meq5aSn9XLyUdCD', name: 'Charlie',  gender: 'Male',   tone: 'Casual & natural' },
  { id: 'cjVigY5qzO86Huf0OWal', name: 'Eric',     gender: 'Male',   tone: 'Friendly & dependable' },
  { id: 'iP95p4xoKVk53GoZ742B', name: 'Chris',    gender: 'Male',   tone: 'Casual & real' },
];

export const DEEPGRAM_VOICES = [
  { model: 'aura-asteria-en',  name: 'Asteria',  gender: 'Female', tone: 'Warm & clear' },
  { model: 'aura-luna-en',     name: 'Luna',     gender: 'Female', tone: 'Soft & calm' },
  { model: 'aura-stella-en',   name: 'Stella',   gender: 'Female', tone: 'Bright & upbeat' },
  { model: 'aura-athena-en',   name: 'Athena',   gender: 'Female', tone: 'Mature & articulate' },
  { model: 'aura-hera-en',     name: 'Hera',     gender: 'Female', tone: 'Authoritative' },
  { model: 'aura-orion-en',    name: 'Orion',    gender: 'Male',   tone: 'Natural & friendly' },
  { model: 'aura-arcas-en',    name: 'Arcas',    gender: 'Male',   tone: 'Casual & warm' },
  { model: 'aura-perseus-en',  name: 'Perseus',  gender: 'Male',   tone: 'Deep & confident' },
  { model: 'aura-angus-en',    name: 'Angus',    gender: 'Male',   tone: 'Warm & expressive' },
  { model: 'aura-orpheus-en',  name: 'Orpheus',  gender: 'Male',   tone: 'Refined & polished' },
  { model: 'aura-helios-en',   name: 'Helios',   gender: 'Male',   tone: 'Clear & crisp' },
  { model: 'aura-zeus-en',     name: 'Zeus',     gender: 'Male',   tone: 'Deep & powerful' },
];
