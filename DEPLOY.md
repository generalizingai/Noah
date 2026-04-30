# Noah AI — Deployment Guide

## Part 1: Deploy Python Backend to Railway

### Prerequisites
- [Railway account](https://railway.app) (free tier works)
- GitHub repo containing this codebase
- All required API keys (see `backend/.env.railway.example`)

### Steps

**1. Create a new Railway project**
- Go to [railway.app/new](https://railway.app/new) → "Deploy from GitHub repo"
- Select your repository

**2. Configure the build**
- In Railway → Service Settings → Build:
  - **Root Directory**: `backend`
  - **Dockerfile Path**: `Dockerfile.railway`
- Railway will auto-detect `backend/railway.toml`

**3. Set environment variables**
- Go to Service → Variables
- Copy each entry from `backend/.env.railway.example` and fill in real values
- The minimum required set:
  ```
  NOAH_BRAIN_MODE=hermes
  NOAH_HERMES_PROVIDER=openrouter
  NOAH_HERMES_MODEL=openai/gpt-4.1-mini
  AI_INTEGRATIONS_OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
  AI_INTEGRATIONS_OPENROUTER_API_KEY=<your-openrouter-key>
  FIREBASE_GOOGLE_CREDENTIALS_JSON=<paste full JSON on one line>
  OPENAI_API_KEY=<your-openai-key>
  DEEPGRAM_API_KEY=<your-deepgram-key>
  ```

**4. Add a volume for persistent data (skills, sessions)**
- Railway → Service → Volumes → Add Volume
- Mount path: `/app/data`

**5. Deploy**
- Click Deploy. Railway builds the Docker image and starts the service.
- Note your Railway public URL (e.g. `https://noah-backend-production.up.railway.app`)

**6. Test the deployment**
```bash
curl https://YOUR-RAILWAY-URL/api/v1/hermes/status
```
Expected: `{"status": "ok", "mode": "hermes"}`

---

## Part 2: Build Noah Desktop DMG (macOS)

### Prerequisites
- macOS machine (Apple Silicon or Intel)
- Node.js 18+ and pnpm
- Xcode Command Line Tools: `xcode-select --install`

### Steps

**1. Clone and install dependencies**
```bash
git clone YOUR-REPO && cd YOUR-REPO/artifacts/desktop
npm install
```

**2. Configure your Railway URL**

Create `~/.noahrc` on the target Mac:
```json
{
  "backendUrl": "https://YOUR-RAILWAY-URL.railway.app"
}
```

Optionally, point the UI to always load from Replit instead of the bundled build:
```json
{
  "backendUrl": "https://YOUR-RAILWAY-URL.railway.app",
  "uiUrl":      "https://YOUR-REPLIT-DOMAIN/desktop"
}
```

**3. Build the DMG**
```bash
cd artifacts/desktop
npm run build:dmg
```

Output files appear in `artifacts/desktop/dist/`:
- `Noah-1.0.0.dmg` — drag-to-install for distribution
- `Noah-1.0.0-mac.zip` — auto-update artifact

**4. Install**
- Open `Noah-1.0.0.dmg`
- Drag `Noah.app` to `/Applications`
- On first launch: right-click → Open (bypasses Gatekeeper for unsigned builds)

### How `~/.noahrc` is used at runtime

| Key          | Purpose |
|---|---|
| `backendUrl` | Points Noah Desktop at your Railway backend. Overrides build-time env var and `localhost:8001` default. |
| `uiUrl`      | Loads the UI from a remote URL (e.g. Replit preview) instead of the bundled `dist/`. Useful for hot-updates without re-shipping the DMG. |

### Re-pointing to a different backend (no rebuild required)

Just update `~/.noahrc` and relaunch Noah. No rebuild or re-installation needed.

---

## Environment variable reference

| Variable | Where | Required | Notes |
|---|---|---|---|
| `NOAH_BRAIN_MODE` | Railway | Yes | `hermes` |
| `NOAH_HERMES_PROVIDER` | Railway | Yes | `openrouter` |
| `NOAH_HERMES_MODEL` | Railway | No | Default: `openai/gpt-4.1-mini` |
| `AI_INTEGRATIONS_OPENROUTER_BASE_URL` | Railway | Yes | `https://openrouter.ai/api/v1` |
| `AI_INTEGRATIONS_OPENROUTER_API_KEY` | Railway | Yes | Your OpenRouter API key |
| `FIREBASE_GOOGLE_CREDENTIALS_JSON` | Railway | Yes | Full JSON, single line |
| `OPENAI_API_KEY` | Railway | Yes | For tools and embeddings |
| `DEEPGRAM_API_KEY` | Railway | Yes | For voice transcription |
| `PINECONE_API_KEY` | Railway | No | Disables semantic search if absent |
| `REDIS_DB_HOST` | Railway | No | Session caching |
| `REDIS_DB_PASSWORD` | Railway | No | Redis auth |
| `ADMIN_KEY` | Railway | No | Protects `/admin` endpoints |
| `NOAH_BACKEND_URL` | Desktop env | No | Alternative to `~/.noahrc backendUrl` |
| `NOAH_UI_URL` | Desktop env | No | Alternative to `~/.noahrc uiUrl` |
