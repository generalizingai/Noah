#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DESKTOP_DIR="$ROOT_DIR/artifacts/desktop"

if [ -f "$HOME/.noahrc" ]; then
  BACKEND_URL="$(ruby -rjson -e 'p=(ENV["HOME"]+"/.noahrc");j=JSON.parse(File.read(p));puts(j["backendUrl"] || "")' 2>/dev/null || true)"
else
  BACKEND_URL=""
fi

if [ -z "${BACKEND_URL}" ]; then
  BACKEND_URL="${NOAH_BACKEND_URL:-https://noah-production-0ef2.up.railway.app}"
fi

echo "== Noah Smoke Test =="
echo "Backend URL: $BACKEND_URL"

pass() { echo "[PASS] $1"; }
fail() { echo "[FAIL] $1"; exit 1; }
warn() { echo "[WARN] $1"; }

echo ""
echo "1) Desktop build check"
cd "$DESKTOP_DIR"
npx vite build >/dev/null
pass "Vite build succeeded"

echo ""
echo "2) Backend health check"
HEALTH_JSON="$(curl -fsS --max-time 12 "$BACKEND_URL/health" || true)"
if echo "$HEALTH_JSON" | grep -q '"status"'; then
  pass "Backend /health responded"
else
  fail "Backend /health failed for $BACKEND_URL"
fi

echo ""
echo "3) Hermes status check"
HERMES_JSON="$(curl -fsS --max-time 12 "$BACKEND_URL/api/v1/hermes/status" || true)"
if [ -z "$HERMES_JSON" ]; then
  fail "Hermes status endpoint unreachable"
fi
echo "Hermes status: $HERMES_JSON"
if echo "$HERMES_JSON" | grep -q '"active":true'; then
  pass "Hermes mode active on backend"
else
  warn "Hermes is reachable but inactive (set NOAH_BRAIN_MODE=hermes on backend)"
fi

echo ""
echo "4) Optional ElevenLabs direct probe"
if [ -n "${ELEVENLABS_API_KEY:-}" ]; then
  EL_VOICE_ID="${ELEVENLABS_VOICE_ID:-21m00Tcm4TlvDq8ikWAM}"
  EL_BYTES="$(curl -sS --max-time 20 -X POST \
    "https://api.elevenlabs.io/v1/text-to-speech/${EL_VOICE_ID}" \
    -H "xi-api-key: ${ELEVENLABS_API_KEY}" \
    -H "Content-Type: application/json" \
    -H "Accept: audio/mpeg" \
    -d '{"text":"Noah smoke test","model_id":"eleven_turbo_v2_5"}' | wc -c | tr -d ' ')"
  if [ "${EL_BYTES:-0}" -gt 1000 ]; then
    pass "ElevenLabs probe returned audio (${EL_BYTES} bytes)"
  else
    warn "ElevenLabs probe returned too little data (${EL_BYTES} bytes)"
  fi
else
  warn "ELEVENLABS_API_KEY not set; skipping ElevenLabs probe"
fi

echo ""
echo "5) Optional Deepgram TTS probe"
if [ -n "${DEEPGRAM_API_KEY:-}" ]; then
  DG_MODEL="${DEEPGRAM_MODEL:-aura-asteria-en}"
  DG_BYTES="$(curl -sS --max-time 20 -X POST \
    "https://api.deepgram.com/v1/speak?model=${DG_MODEL}" \
    -H "Authorization: Token ${DEEPGRAM_API_KEY}" \
    -H "Content-Type: application/json" \
    -d '{"text":"Noah smoke test"}' | wc -c | tr -d ' ')"
  if [ "${DG_BYTES:-0}" -gt 1000 ]; then
    pass "Deepgram probe returned audio (${DG_BYTES} bytes)"
  else
    warn "Deepgram probe returned too little data (${DG_BYTES} bytes)"
  fi
else
  warn "DEEPGRAM_API_KEY not set; skipping Deepgram probe"
fi

echo ""
pass "Smoke checks completed"
echo "Next: run manual UI checklist in DEV_ENV.md before tagging a release."
