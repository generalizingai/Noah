# Noah Desktop Developer Environment

This gives you a repeatable local workflow to validate features before tagging a DMG release.

## Quick Start

Run from repo root:

```bash
cd "/Users/Hamzaa/Documents/Claude Code/Noah AI/artifacts/desktop"
npm run dev:stack
```

What it does:
- Starts local backend on `http://localhost:8001`
- Launches Noah desktop in dev mode
- Forces desktop to prefer local backend (`NOAH_PREFER_LOCAL_BACKEND=1`)

## Smoke Checks (pre-release)

```bash
cd "/Users/Hamzaa/Documents/Claude Code/Noah AI/artifacts/desktop"
npm run smoke
```

Checks included:
- Desktop Vite build compiles
- Backend `/health` responds
- Hermes `/api/v1/hermes/status` responds
- Optional ElevenLabs probe (if `ELEVENLABS_API_KEY` is set)
- Optional Deepgram TTS probe (if `DEEPGRAM_API_KEY` is set)

Optional env vars for probes:
- `ELEVENLABS_API_KEY`
- `ELEVENLABS_VOICE_ID`
- `DEEPGRAM_API_KEY`
- `DEEPGRAM_MODEL`

## Full Release Gate

```bash
cd "/Users/Hamzaa/Documents/Claude Code/Noah AI/artifacts/desktop"
npm run release:check
```

This runs:
1. Smoke checks
2. `npm run build:dmg`
3. Manual QA checklist reminder

## Recommended Manual QA Before Tagging

- Hermes mode shows backend active and chat works end-to-end
- Speaking visualizer appears while Noah is talking
- Stop control interrupts speech immediately
- ElevenLabs preview and response speech work
- Deepgram preview and response speech work
- Assistant formatting shows line breaks/bullets clearly
- Floating bar remains responsive during long responses

## Tag & Release (after QA passes)

```bash
git tag -a noah-vX.Y.Z -m "Noah Desktop vX.Y.Z"
git push origin noah-vX.Y.Z
```

`build-mac.yml` will auto-trigger on `noah-v*` tags.
