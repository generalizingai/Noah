# Noah Platform Workspace

## Overview

pnpm workspace monorepo (TypeScript + Python). This is the Noah AI wearable platform — a rebrand of Omi — running fully on Replit.

## Brand

- **Product name**: Noah (formerly Omi)
- **Device name**: Noah Device
- **Logo**: `/noah-logo.webp` (place in `artifacts/omi/public/`)
- **Device images**: `/noah-device-1.webp`, `/noah-device-2.webp`

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5 (Node.js) + FastAPI (Python)
- **Database**: Firebase Firestore (via Firebase Admin SDK)
- **Vector DB**: Pinecone (`memories` index, 3072-dim, cosine)
- **Cache**: Redis (Upstash)
- **AI**: OpenAI GPT-4 / Claude, Deepgram STT, ElevenLabs TTS
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks from OpenAPI spec
- `pnpm --filter @workspace/api-server run dev` — run TS API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Artifacts

### Noah App Store (`artifacts/omi`)
- **Type**: React + Vite (migrated from Next.js)
- **Preview path**: `/`
- **Port**: 26126 (exposed as :80)
- **Description**: Noah AI wearable Apps Marketplace
- **Routes**:
  - `/apps` — main marketplace page with featured & category sections
  - `/apps/category/:category` — filtered apps by category
  - `/apps/:id` — individual app detail page
- **Key files**:
  - `src/pages/AppsPage.tsx` — main marketplace page ("Noah App Store")
  - `src/pages/AppDetailPage.tsx` — individual app detail
  - `src/pages/CategoryPage.tsx` — category browse page
  - `src/lib/api.ts` — API client (fetches via proxy)
  - `src/utils/category.ts` — category metadata + icons
  - `src/types/plugin.ts` — Plugin type definition
  - `src/components/AppHeader.tsx` — Noah branding header
  - `src/components/Footer.tsx` — Noah branded footer
  - `src/components/ProductBanner.tsx` — Noah Device banner
  - `src/constants/envConfig.ts` — app config (APP_NAME=Noah, WEB_URL=window.location.origin)
- **API proxy**: Vite proxies `/api/*` to API server at :8080
- **External data**: 690+ real AI apps from `https://api.omi.me/v1/approved-apps`

### Node.js API Server (`artifacts/api-server`)
- **Type**: Express 5 API
- **Port**: 8080
- **Omi Proxy routes**:
  - `GET /api/omi/apps` — proxies + caches all approved apps (1h TTL)
  - `GET /api/omi/apps/:id` — single app lookup
- **CORS fix**: Frontend cannot directly call api.omi.me; server-side proxy avoids CORS issues

### Python AI Backend (`backend/`)
- **Type**: FastAPI (Python 3.11)
- **Port**: 8001
- **Workflow**: `backend: Python AI Backend`
- **Entry point**: `backend/main.py`
- **Start script**: `backend/start.sh`
- **Source**: Migrated from `.migration-backup/backend/`
- **Key changes from original**:
  - `main.py`: Accepts `FIREBASE_GOOGLE_CREDENTIALS_JSON` env var (in addition to `SERVICE_ACCOUNT_JSON`)
  - `database/_client.py`: Reads `FIREBASE_GOOGLE_CREDENTIALS_JSON` to write creds file
  - `utils/llm/persona.py`: Fixed `langchain.schema` → `langchain_core.messages`
  - `utils/conversations/search.py`: Typesense client made resilient to missing env vars
  - `database/vector_db.py`: Pinecone `memories` index created (3072 dims)
- **Required secrets** (set in Replit):
  - `OPENAI_API_KEY`
  - `DEEPGRAM_API_KEY`
  - `PINECONE_API_KEY`
  - `REDIS_DB_HOST`, `REDIS_DB_PASSWORD`
  - `FIREBASE_GOOGLE_CREDENTIALS_JSON` (full service account JSON)
  - `ADMIN_KEY`
- **Non-sensitive env vars** (set as Replit env vars):
  - `REDIS_DB_PORT=6379`
  - `PINECONE_INDEX_NAME=memories`
  - `BACKEND_PORT=8001`
  - `ENCRYPTION_SECRET=<long string from template>`
  - `NOAH_BRAIN_MODE=hermes` — set to enable Hermes AI engine (default: `classic`)
  - `NOAH_HERMES_MODEL=claude-opus-4-20250514` — override Hermes model (optional)
- **Hermes AI engine** (`backend/hermes/`): Noah-native AIAgent implementing NousResearch/hermes-agent (MIT) architecture
  - `backend/hermes/__init__.py` — package exports
  - `backend/hermes/agent.py` — AIAgent class: parallel tool execution (ThreadPoolExecutor), provider-agnostic (Anthropic/OpenAI), 25-iteration cap
  - `backend/hermes/memory.py` — SQLite-backed session DB with FTS5 search (inspired by hermes_state.py)
  - `backend/hermes/context.py` — context compression (drop old turns, keep recent 20)
  - `backend/hermes/tools.py` — 11 Noah tools registered (shell, AppleScript, web search, file ops, API calls)
  - `backend/hermes_bridge.py` — singleton factory: create_hermes_agent(), get_conversation_history()
  - `backend/routers/noah_hermes.py` — FastAPI router: GET /hermes/status, POST /hermes/chat, GET /hermes/sessions
- **API docs**: http://localhost:8001/docs

### Noah Admin Dashboard (`artifacts/admin`)
- **Type**: Next.js 13 App Router (standalone, npm-managed, excluded from pnpm workspace)
- **Port**: 9000 (internal)
- **URL**: Access via the Omi Apps preview at `/admin` (proxied through Vite at port 26126)
- **Workflow**: `artifacts/admin: Admin Dashboard`
- **Command**: `cd artifacts/admin && PORT=9000 ./node_modules/.bin/next dev --hostname 0.0.0.0`
- **Auth**: Firebase Google Sign-In; user must be in `adminData` Firestore collection
- **Firebase Admin**: Uses `FIREBASE_GOOGLE_CREDENTIALS_JSON` secret (parsed at runtime)
- **Backend URL**: `NEXT_PUBLIC_OMI_API_URL=http://localhost:8001` (configured in `.env.local`)
- **API Key**: `OMI_API_SECRET_KEY=${ADMIN_KEY}` (expanded from ADMIN_KEY secret)
- **Pages**: Dashboard/Analytics, Apps moderation, Fair-use, Subscriptions, Payouts, Announcements, Releases, Notifications, Reviews, Team, Organizations, Distributors, Chat-Lab, Settings
- **Setup required**:
  1. Add Replit dev domain to Firebase Console → Authentication → Authorized Domains
  2. Add your Google account UID to `adminData` Firestore collection to grant admin access
- **Key files**:
  - `app/(protected)/dashboard/` — all dashboard pages
  - `app/login/page.tsx` — Google sign-in login page
  - `lib/firebase/admin.ts` — Firebase Admin SDK (reads FIREBASE_GOOGLE_CREDENTIALS_JSON)
  - `lib/firebase/client.ts` — Firebase client SDK (reads NEXT_PUBLIC_FIREBASE_* env vars)
  - `lib/auth.ts` — Admin auth middleware (verifies Firebase token + adminData check)
  - `.env.local` — non-secret env vars (Firebase project ID, backend URL)

## Migration Backup

- `.migration-backup/` — full original Omi repo
  - `backend/` — Python FastAPI backend (now live at `backend/`)
  - `web/admin/` — Next.js admin dashboard (migrated to `artifacts/admin`)
  - `web/frontend/` — Original Next.js frontend (migrated to `artifacts/omi`)
  - `app/` — Flutter mobile app (not portable to Replit; Expo replacement planned)

### Noah Desktop App (`artifacts/desktop`)
- **Type**: Electron + React + Vite + Tailwind (standalone, npm-managed, excluded from pnpm workspace)
- **Port**: 3001 (Vite browser preview in Replit)
- **Workflow**: `artifacts/desktop: Desktop UI Preview`
- **Command**: `cd artifacts/desktop && node_modules/.bin/vite --host 0.0.0.0`
- **Electron build**: Run `npm run build:dmg` locally on macOS to produce a `.dmg`
- **Auth**: Firebase Google Sign-In (same project: noah-5163f)
- **Features**:
  - Main window (900×650) — tabbed interface: Assistant, Conversations, Memories, Settings
  - Floating bar (always-on-top pill, 560×56 → expands to 560×360 on AI response)
  - System tray icon for quick access
  - Screen capture via Electron's desktopCapturer API → GPT-4 Vision analysis
  - Voice recording via Web MediaRecorder → OpenAI Whisper STT
  - Falls back to direct OpenAI API if Noah backend is unreachable
  - **Hermes AI Brain** (opt-in): routes queries to backend's Python engine with parallel tool execution, SQLite session memory, context compression — enable with `NOAH_BRAIN_MODE=hermes` on backend + toggle in Settings → AI Brain
- **Key files**:
  - `electron/main.js` — Electron main process (windows, IPC, tray)
  - `electron/preload.js` — contextBridge API exposed to renderer
  - `src/App.jsx` — root component (detects floating bar route)
  - `src/screens/SignInScreen.jsx` — Firebase Google Sign-In
  - `src/screens/MainScreen.jsx` — sidebar nav + tab routing
  - `src/screens/FloatingBar.jsx` — always-on-top assistant pill
  - `src/components/AssistantTab.jsx` — chat + screen vision + voice
  - `src/components/ConversationsTab.jsx` — conversation history
  - `src/components/MemoriesTab.jsx` — memory retrieval
  - `src/components/SettingsTab.jsx` — account, permissions, about, AI Brain toggle
  - `src/services/auth.jsx` — Firebase auth context
  - `src/services/noahApi.js` — screen analysis + voice query API + Hermes routing
  - `src/services/voiceRecorder.js` — MediaRecorder wrapper
- **Environment** (`.env`):
  - `VITE_FIREBASE_*` — Firebase project credentials (auto-filled from Replit secrets)
  - `VITE_NOAH_BACKEND_URL` — Noah backend URL (default: http://localhost:8001)
  - `VITE_OPENAI_API_KEY` — Direct OpenAI fallback key
- **macOS setup** (run locally):
  1. Clone repo on Mac
  2. `cd artifacts/desktop && npm install`
  3. Create `~/.noahrc` with `{ "backendUrl": "https://YOUR-RAILWAY-URL.railway.app" }`
  4. Run `npm run dev` to launch Electron
  5. Run `npm run build:dmg` to package a distributable `.dmg`
- **Runtime backend URL** (no rebuild needed):
  - `~/.noahrc` `backendUrl` → `NOAH_BACKEND_URL` env var → `VITE_NOAH_BACKEND_URL` → `localhost:8001`
  - `~/.noahrc` `uiUrl` → loads the UI from a remote URL instead of bundled `dist/`
  - Electron IPC `get-backend-url` exposes `backendUrl` to the renderer via `window.electronAPI.getBackendUrl()`
- **Entitlements**: `build/entitlements.mac.plist` — microphone, screen recording, network access
- **`type: "module"`**: package.json uses ESM

## Backend Railway Deployment

- **Dockerfile**: `backend/Dockerfile.railway` — standalone (uses `backend/` as build context)
- **Config**: `backend/railway.toml` — sets build + health check + restart policy
- **Port**: Railway injects `$PORT`; CMD uses it directly
- **Env vars**: see `backend/.env.railway.example` for full list; key vars:
  - `NOAH_BRAIN_MODE=hermes`
  - `AI_INTEGRATIONS_OPENROUTER_API_KEY` + `AI_INTEGRATIONS_OPENROUTER_BASE_URL=https://openrouter.ai/api/v1`
  - `FIREBASE_GOOGLE_CREDENTIALS_JSON` (full JSON single line)
  - `OPENAI_API_KEY`, `DEEPGRAM_API_KEY`, `PINECONE_API_KEY`
- **Volumes**: mount `/app/data` for persistent skills + session DB
- **Full guide**: `DEPLOY.md`

## Next Steps

1. **Expo Mobile App** — build Expo replacement for Flutter app
2. **Logo assets** — supply `/noah-device-1.webp`, `/noah-device-2.webp`
3. **Admin access** — add Google account UID to `adminData` Firestore collection
4. **Desktop distribution** — sign with Apple Developer cert for notarization
