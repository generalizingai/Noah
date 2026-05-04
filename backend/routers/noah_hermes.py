"""
FastAPI router: /hermes/*

Exposes Noah's Hermes AI engine over HTTP.
  - GET  /hermes/status               → always public (returns mode + availability info)
  - POST /hermes/chat                 → requires Firebase auth; 503 unless NOAH_BRAIN_MODE=hermes
  - GET  /hermes/sessions             → requires Firebase auth; 503 unless NOAH_BRAIN_MODE=hermes
  - POST /hermes/tool_result/{call_id}→ requires Firebase auth; called by the desktop app to
                                        return results from locally-executed proxy tool calls

The desktop app checks /hermes/status on startup and routes queries
to /hermes/chat when the user has selected "Hermes" brain mode in Settings.

Remote tool proxy
─────────────────
macOS-only tools (run_applescript, show_notification, open_url, open_path,
run_shell, write_file) cannot run on the Linux backend server.  When the
desktop Electron app is connected via an SSE stream, these tools are
intercepted and delegated back to the user's Mac:

  1. The backend emits a `tool_call` SSE event with a unique call_id.
  2. The desktop app executes the tool via Electron IPC.
  3. The desktop app POSTs the result to /hermes/tool_result/{call_id}.
  4. The backend resumes the tool-calling loop with the real result.

When no Electron proxy is connected (non-streaming or non-Electron client)
the tools return a helpful error message instead of silently failing.
"""

import asyncio
import json
import logging
import os
import queue
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from utils.other import endpoints as auth

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/hermes", tags=["hermes"])


def _brain_mode() -> str:
    """Read NOAH_BRAIN_MODE at request time (allows runtime env changes)."""
    return os.environ.get("NOAH_BRAIN_MODE", "classic").lower()


def _require_hermes_mode() -> None:
    """Raise HTTP 503 if Hermes mode is not active on this server."""
    mode = _brain_mode()
    if mode != "hermes":
        raise HTTPException(
            status_code=503,
            detail=(
                f"Hermes mode is not active (current mode: '{mode}'). "
                "Set NOAH_BRAIN_MODE=hermes on the backend to enable."
            ),
        )


def _resolve_provider_and_key(request: Request, model_used: str) -> tuple[Optional[str], Optional[str]]:
    """Resolve provider/api key from BYOK headers for thread-safe Hermes execution."""
    h = request.headers
    byok_openrouter = h.get("x-byok-openrouter") or h.get("X-BYOK-OpenRouter")
    byok_openai = h.get("x-byok-openai") or h.get("X-BYOK-OpenAI")
    byok_anthropic = h.get("x-byok-anthropic") or h.get("X-BYOK-Anthropic")

    m = (model_used or "").lower().strip()
    logger.info(
        "Hermes BYOK headers model=%s openrouter=%s openai=%s anthropic=%s",
        model_used,
        bool(byok_openrouter and byok_openrouter.strip()),
        bool(byok_openai and byok_openai.strip()),
        bool(byok_anthropic and byok_anthropic.strip()),
    )

    # OpenRouter-format model IDs typically include provider/model (contains slash).
    if "/" in m and byok_openrouter:
        return "openrouter", byok_openrouter
    if "/" in m:
        return "openrouter", None

    if any(k in m for k in ("gpt", "openai", "o1", "o3", "o4")):
        return "openai", byok_openai
    if any(k in m for k in ("claude", "anthropic")):
        return "anthropic", (byok_anthropic or byok_openai)

    # Fallback preference.
    if byok_openrouter:
        return "openrouter", byok_openrouter
    if byok_openai:
        return "openai", byok_openai
    if byok_anthropic:
        return "anthropic", byok_anthropic

    return None, None


# ── Remote tool proxy store ──────────────────────────────────────────────────

# Maps call_id → {"event": threading.Event, "result": Any, "uid": str}
# Storing uid prevents a malicious client from injecting results into another
# user's tool call even if they somehow guess the UUID4 call_id.
_pending_tool_calls: Dict[str, dict] = {}
_pending_calls_lock = threading.Lock()

# Maps session_id → list of emit_fn (event_queue.put)
# A list (not a single fn) means concurrent SSE streams on the same session
# each receive tool_call events — the first client to POST a result wins.
_session_emitters: Dict[str, List[callable]] = {}
_emitters_lock = threading.Lock()

# Tools that are proxied to the Electron desktop app when it is connected.
# These tools are either macOS-only or are safer/more useful running on the
# user's own machine rather than the shared backend server.
_REMOTE_PROXY_TOOLS = frozenset({
    "terminal",
    "run_applescript",
    "show_notification",
    "open_url",
    "open_path",
    "write_file",
    "read_file",
    "list_directory",
})

_REMOTE_CALL_TIMEOUT = 90   # seconds to wait for desktop app to respond
_STALE_ENTRY_MAX_AGE = 120  # seconds before an unresolved entry is purged
_CLEANUP_INTERVAL   = 60    # how often the cleanup thread runs


def _cleanup_stale_tool_calls() -> None:
    """Background daemon: purge _pending_tool_calls entries older than _STALE_ENTRY_MAX_AGE.

    Without this, a client that disconnects mid-tool-call leaves an entry that
    would linger until the 90-second event.wait() timeout fires naturally and
    removes it.  That is fine for a single call, but accumulated stale entries
    (e.g. rapid reconnects) could grow unboundedly.

    For each stale entry we also set the threading.Event so that any thread
    still blocked on event.wait() (possible if _REMOTE_CALL_TIMEOUT was raised
    elsewhere) wakes up and exits cleanly rather than blocking forever.
    """
    while True:
        time.sleep(_CLEANUP_INTERVAL)
        now = time.time()
        with _pending_calls_lock:
            stale_ids = [
                cid
                for cid, entry in _pending_tool_calls.items()
                if now - entry.get("created_at", now) > _STALE_ENTRY_MAX_AGE
            ]
            for cid in stale_ids:
                entry = _pending_tool_calls.pop(cid, {})
                entry.get("event", threading.Event()).set()
                logger.info(
                    "Purged stale tool call %s (age > %ds)", cid, _STALE_ENTRY_MAX_AGE
                )


_cleanup_thread = threading.Thread(
    target=_cleanup_stale_tool_calls,
    name="hermes-tool-cleanup",
    daemon=True,
)
_cleanup_thread.start()


def _register_emitter(session_id: str, fn: callable) -> None:
    """Add an emitter for a session (supports concurrent SSE streams)."""
    with _emitters_lock:
        _session_emitters.setdefault(session_id, []).append(fn)


def _unregister_emitter(session_id: str, fn: callable) -> None:
    """Remove a specific emitter from a session's list."""
    with _emitters_lock:
        fns = _session_emitters.get(session_id, [])
        try:
            fns.remove(fn)
        except ValueError:
            pass
        if not fns:
            _session_emitters.pop(session_id, None)


def _get_emitters(session_id: str) -> List[callable]:
    """Return all active emitters for a session (copy to avoid lock contention)."""
    with _emitters_lock:
        return list(_session_emitters.get(session_id, []))


def _make_remote_proxy_handler(tool_name: str, session_id: str, uid: str):
    """
    Return a synchronous tool handler that delegates execution to the Electron
    desktop app via SSE and blocks until the result is received.

    uid is embedded in the pending call record so /tool_result can verify that
    only the owning user can supply a result for this call.
    """
    def handler(**kwargs):
        call_id = str(uuid.uuid4())
        event = threading.Event()

        with _pending_calls_lock:
            _pending_tool_calls[call_id] = {
                "event": event,
                "result": None,
                "uid": uid,
                "created_at": time.time(),
            }

        emitters = _get_emitters(session_id)
        if not emitters:
            with _pending_calls_lock:
                _pending_tool_calls.pop(call_id, None)
            return {
                "error": (
                    f"{tool_name} requires the Noah desktop app to be connected. "
                    "Please open the Noah desktop app and ensure it is running."
                )
            }

        tool_call_evt = {
            "type": "tool_call",
            "call_id": call_id,
            "tool": tool_name,
            "args": kwargs,
        }

        dispatched = False
        for emit in emitters:
            try:
                emit(tool_call_evt)
                dispatched = True
            except Exception as exc:
                logger.warning("Failed to emit to one SSE stream for %s: %s", tool_name, exc)

        if not dispatched:
            with _pending_calls_lock:
                _pending_tool_calls.pop(call_id, None)
            return {"error": f"Failed to dispatch {tool_name} to any connected desktop client."}

        if not event.wait(timeout=_REMOTE_CALL_TIMEOUT):
            with _pending_calls_lock:
                _pending_tool_calls.pop(call_id, None)
            return {
                "error": (
                    f"{tool_name} timed out after {_REMOTE_CALL_TIMEOUT}s waiting "
                    "for the desktop app to respond. Make sure the Noah desktop app is open."
                )
            }

        with _pending_calls_lock:
            entry = _pending_tool_calls.pop(call_id, {})

        result = entry.get("result")
        if result is None:
            return {"error": "Desktop app returned no result."}
        return result

    handler.__name__ = f"remote_proxy_{tool_name}"
    return handler


# ── Request / Response models ────────────────────────────────────────────────

class HermesChatRequest(BaseModel):
    message: str
    system_prompt: Optional[str] = None
    session_id: Optional[str] = None
    history: Optional[List[Dict[str, Any]]] = None
    model: Optional[str] = None  # client-selected model; overrides NOAH_HERMES_MODEL env var
    latency_mode: Optional[str] = "balanced"  # balanced | realtime


class HermesChatResponse(BaseModel):
    response: str
    session_id: str
    mode: str = "hermes"
    model: str = ""


class ToolResultRequest(BaseModel):
    result: Dict[str, Any]


def _resolve_max_iterations(latency_mode: Optional[str]) -> int:
    """Per-request iteration budget: faster for voice/realtime traffic."""
    base = int(os.environ.get("NOAH_HERMES_MAX_ITERATIONS", "12"))
    realtime = int(os.environ.get("NOAH_HERMES_MAX_ITERATIONS_REALTIME", "6"))
    return realtime if (latency_mode or "").lower() == "realtime" else base


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/status")
async def hermes_status():
    """
    Report whether Hermes mode is active and which model is configured.
    Always returns 200 — no auth required — so the desktop can check availability.
    """
    mode = _brain_mode()
    return {
        "mode": mode,
        "active": mode == "hermes",
        "model": os.environ.get("NOAH_HERMES_MODEL", "claude-opus-4-20250514"),
        "version": "1.0.0",
    }


@router.post("/chat")
async def hermes_chat(
    request: Request,
    req: HermesChatRequest,
    uid: str = Depends(auth.get_current_user_uid),
):
    """
    Run a query through Noah's Hermes AI engine.

    Requires a valid Firebase ID token (Authorization: Bearer <token>).
    Guarded: returns HTTP 503 if NOAH_BRAIN_MODE != hermes.

    When the client sends Accept: text/event-stream, responses are streamed
    as Server-Sent Events: token / tool_start / tool_call / done events.
    Otherwise a plain JSON HermesChatResponse is returned.

    tool_call events delegate macOS-only tool execution back to the desktop
    app. The desktop POSTs the result to /hermes/tool_result/{call_id}.
    """
    _require_hermes_mode()

    try:
        from hermes_bridge import create_hermes_agent, get_conversation_history
    except ImportError as exc:
        logger.error("Failed to import hermes_bridge: %s", exc)
        raise HTTPException(status_code=500, detail=f"Hermes engine unavailable: {exc}")

    raw_session = req.session_id or str(uuid.uuid4())
    session_id = f"{uid}:{raw_session}"

    history = req.history
    if not history and req.session_id:
        history = get_conversation_history(session_id, limit=20)

    # Client-selected model takes priority; env var is the fallback default
    model_used = req.model or os.environ.get("NOAH_HERMES_MODEL", "google/gemma-4-31b-it")
    provider_override, api_key_override = _resolve_provider_and_key(request, model_used)
    agent = create_hermes_agent(
        system_prompt=req.system_prompt,
        session_id=session_id,
        uid=uid,
        model=model_used,
        provider=provider_override,
        api_key=api_key_override,
    )

    accept = request.headers.get("accept", "")
    wants_sse = "text/event-stream" in accept
    max_iterations = _resolve_max_iterations(req.latency_mode)

    if wants_sse:
        return _hermes_chat_sse(
            agent,
            req,
            raw_session,
            model_used,
            history or [],
            session_id,
            uid,
            max_iterations,
        )

    loop = asyncio.get_event_loop()
    original_iterations = getattr(agent, "max_iterations", max_iterations)
    try:
        agent.max_iterations = max_iterations
        result = await loop.run_in_executor(
            None,
            lambda: agent.run_conversation(
                user_message=req.message,
                system_message=req.system_prompt,
                conversation_history=history or [],
            ),
        )
    except Exception as exc:
        logger.error("Hermes chat error uid=%s: %s", uid, exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Hermes engine error: {exc}")
    finally:
        agent.max_iterations = original_iterations

    return HermesChatResponse(
        response=result["final_response"],
        session_id=raw_session,
        mode="hermes",
        model=model_used,
    )


@router.post("/tool_result/{call_id}")
async def hermes_tool_result(
    call_id: str,
    body: Dict[str, Any],
    uid: str = Depends(auth.get_current_user_uid),
):
    """
    Receive the result of a remotely-proxied tool call from the Electron desktop app.

    The desktop app calls this after executing a tool_call SSE event locally via
    Electron IPC (run_shell, run_applescript, show_notification, etc.). The result
    is stored and the waiting backend thread is unblocked so the Hermes agent can
    continue its tool-calling loop.

    Body: arbitrary JSON object — the tool's return value (e.g. {"success": true, "output": "..."}).
    """
    with _pending_calls_lock:
        entry = _pending_tool_calls.get(call_id)

    if entry is None:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown or expired tool call: {call_id}. It may have already timed out.",
        )

    # Ownership check: only the user who initiated the tool call can supply its result.
    # UUID4 makes guessing unlikely, but this provides defence-in-depth.
    if entry.get("uid") != uid:
        raise HTTPException(
            status_code=403,
            detail="Tool call does not belong to the authenticated user.",
        )

    entry["result"] = body
    entry["event"].set()
    logger.debug("Tool result received for call_id=%s uid=%s", call_id, uid)
    return {"ok": True}


def _hermes_chat_sse(
    agent,
    req: HermesChatRequest,
    raw_session: str,
    model_used: str,
    history: list,
    session_id: str,
    uid: str,
    max_iterations: int,
) -> StreamingResponse:
    """Return a StreamingResponse that yields SSE events from the agent.

    Before starting the agent thread, remote-proxy handlers are installed for
    macOS-only tools so they can delegate to the connected Electron desktop app.
    uid is threaded through so each pending call can be ownership-verified in
    /tool_result/{call_id}.
    """
    event_queue: queue.Queue = queue.Queue()
    _SENTINEL = object()

    # Install remote proxy handlers for macOS-only / desktop-preferred tools.
    # These replace the server-side stubs with handlers that emit tool_call SSE
    # events and block until the desktop app POSTs the result back.
    try:
        from hermes.tools import TOOL_SCHEMAS
        for tool_name in _REMOTE_PROXY_TOOLS:
            if tool_name in TOOL_SCHEMAS:
                proxy_fn = _make_remote_proxy_handler(tool_name, session_id, uid)
                agent.register_tool(tool_name, proxy_fn, TOOL_SCHEMAS[tool_name])
        logger.debug("Remote proxy tools installed for session=%s uid=%s", session_id, uid)
    except Exception as exc:
        logger.warning("Could not install remote proxy tool handlers: %s", exc)

    # Register this session's emitter so proxy handlers can push tool_call events.
    # Using the specific fn reference allows concurrent streams on the same session.
    _register_emitter(session_id, event_queue.put)

    def run_agent():
        original_iterations = getattr(agent, "max_iterations", max_iterations)
        try:
            agent.max_iterations = max_iterations
            agent.run_conversation_streaming(
                user_message=req.message,
                callback=event_queue.put,
                system_message=req.system_prompt,
                conversation_history=history,
            )
        except Exception as exc:
            event_queue.put({"type": "error", "message": str(exc)})
        finally:
            agent.max_iterations = original_iterations
            event_queue.put(_SENTINEL)

    thread = threading.Thread(target=run_agent, daemon=True)
    thread.start()

    async def generate():
        loop = asyncio.get_event_loop()
        authoritative_response: str = ""

        try:
            while True:
                # Poll in short bursts so we can send keepalive pings during
                # long tool runs (prevents proxy / client timeout without blocking
                # the queue for the full 300s maximum per round-trip).
                try:
                    evt = await loop.run_in_executor(
                        None,
                        lambda: event_queue.get(timeout=30),
                    )
                except queue.Empty:
                    # Send SSE keepalive comment; client ignores it but connection stays open
                    yield ": ping\n\n"
                    continue

                if evt is _SENTINEL:
                    break

                if isinstance(evt, dict):
                    etype = evt.get("type")
                    if etype == "_agent_done":
                        # Internal terminal event carrying the authoritative response
                        # (what was persisted); never forwarded to the client.
                        authoritative_response = evt.get("final_response", "")
                        continue

                yield f"data: {json.dumps(evt)}\n\n"

        finally:
            # Always clean up this specific emitter so proxy handlers don't try
            # to emit into a dead queue after the stream is closed.
            # Other concurrent streams on the same session are unaffected.
            _unregister_emitter(session_id, event_queue.put)

        done_evt = {
            "type": "done",
            "session_id": raw_session,
            "model": model_used,
            "response": authoritative_response,
        }
        yield f"data: {json.dumps(done_evt)}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/sessions")
async def hermes_sessions(
    uid: str = Depends(auth.get_current_user_uid),
):
    """List recent Hermes conversation sessions for the authenticated user.

    Uses the vendored upstream hermes_state.SessionDB.list_sessions_rich()
    which returns: id, source, model, title, started_at, message_count, preview.
    Sessions are filtered to those scoped to this user (user_id == uid).
    """
    _require_hermes_mode()
    try:
        from hermes_bridge import _get_shared_db
        db = _get_shared_db()
        # list_sessions_rich returns dicts with key 'id' (upstream convention)
        all_sessions = db.list_sessions_rich(source="noah", limit=100)
        # Filter to this user's sessions and rename 'id' → 'session_id' for API clarity
        prefix = f"{uid}:"
        user_sessions = []
        for s in all_sessions:
            raw_id = s.get("id", "")
            if raw_id.startswith(prefix):
                user_sessions.append({
                    **s,
                    "session_id": raw_id.removeprefix(prefix),
                })
        return {"sessions": user_sessions[:20]}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/sessions/{session_id}/history")
async def hermes_session_history(
    session_id: str,
    uid: str = Depends(auth.get_current_user_uid),
):
    """Return the full message history for a specific Hermes session.

    The session must belong to the authenticated user.
    """
    _require_hermes_mode()
    try:
        from hermes_bridge import _get_shared_db
        db = _get_shared_db()
        # Ownership is enforced by construction: the full session key is always
        # uid:session_id, so only the authenticated user can access their own sessions.
        full_session_id = f"{uid}:{session_id}"
        # Use a direct message lookup to avoid top-N listing issues.
        # db.get_messages raises if the session key doesn't exist.
        try:
            raw_msgs = db.get_messages(full_session_id)
        except Exception:
            raise HTTPException(status_code=404, detail="Session not found")
        messages = [
            {"role": m["role"], "content": m["content"]}
            for m in raw_msgs
            if m.get("role") in ("user", "assistant") and m.get("content")
        ]
        return {"session_id": session_id, "messages": messages}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ── Skill management ────────────────────────────────────────────────────────

_BACKEND_DIR = Path(__file__).parent.parent


def _skills_dir(uid: str) -> Path:
    p = _BACKEND_DIR / "data" / "skills" / uid
    p.mkdir(parents=True, exist_ok=True)
    return p


def _shared_skills_dir() -> Path:
    p = _BACKEND_DIR / "data" / "skills" / "shared"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _parse_skill_meta(content: str) -> Dict[str, Any]:
    """Extract YAML frontmatter + body from a skill .md file."""
    try:
        import yaml
        m = re.match(r'^---\s*\n(.*?)\n---\s*\n', content, re.DOTALL)
        if m:
            fm = yaml.safe_load(m.group(1)) or {}
            body = content[m.end():]
        else:
            fm = {}
            body = content
        meta = fm.get("metadata", {}) or {}
        return {
            "name":        fm.get("name", ""),
            "description": fm.get("description", ""),
            "license":     fm.get("license", ""),
            "version":     meta.get("version", ""),
            "author":      meta.get("author", ""),
            "category":    meta.get("category", ""),
            "updated":     str(meta.get("updated", "")),
            "body_preview": body.strip()[:200],
        }
    except Exception:
        return {}


def _slug(name: str) -> str:
    return re.sub(r'[^\w\-]', '_', name.strip().lower())


def _skill_info(path: Path, scope: str) -> Dict[str, Any]:
    content = path.read_text(encoding="utf-8")
    meta = _parse_skill_meta(content)
    return {
        "slug":        path.stem,
        "scope":       scope,
        "name":        meta.get("name") or path.stem,
        "description": meta.get("description", ""),
        "category":    meta.get("category", ""),
        "author":      meta.get("author", ""),
        "version":     meta.get("version", ""),
        "updated":     meta.get("updated", ""),
        "license":     meta.get("license", ""),
    }


class SkillInstallRequest(BaseModel):
    content: str
    scope: str = "user"


@router.get("/skills")
async def list_skills(uid: str = Depends(auth.get_current_user_uid)):
    """List all skills available to this user (shared + personal)."""
    skills = []
    seen = set()
    for path in sorted(_skills_dir(uid).glob("*.md")):
        skills.append(_skill_info(path, "user"))
        seen.add(path.stem)
    for path in sorted(_shared_skills_dir().glob("*.md")):
        if path.stem not in seen:
            skills.append(_skill_info(path, "shared"))
    return {"skills": skills}


@router.get("/skills/{slug}")
async def get_skill(slug: str, uid: str = Depends(auth.get_current_user_uid)):
    """Return the full content of a skill."""
    for d, scope in [(_skills_dir(uid), "user"), (_shared_skills_dir(), "shared")]:
        path = d / f"{_slug(slug)}.md"
        if path.exists():
            return {"slug": path.stem, "scope": scope, "content": path.read_text(encoding="utf-8")}
    raise HTTPException(status_code=404, detail=f"Skill '{slug}' not found")


@router.post("/skills/install")
async def install_skill(
    req: SkillInstallRequest,
    uid: str = Depends(auth.get_current_user_uid),
):
    """Install a skill from raw .md content."""
    content = req.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="Content is empty")

    meta = _parse_skill_meta(content)
    name = meta.get("name") or ""
    if not name:
        # Try to infer from first heading
        m = re.search(r'^#\s+(.+)', content, re.MULTILINE)
        name = m.group(1).strip() if m else "untitled"

    slug = _slug(name)
    if not slug:
        raise HTTPException(status_code=400, detail="Could not determine skill name")

    target_dir = _shared_skills_dir() if req.scope == "shared" else _skills_dir(uid)
    path = target_dir / f"{slug}.md"
    path.write_text(content, encoding="utf-8")

    return {
        "success": True,
        "slug": slug,
        "scope": req.scope,
        "name": meta.get("name") or name,
        "description": meta.get("description", ""),
        "category": meta.get("category", ""),
    }


@router.delete("/skills/{slug}")
async def delete_skill(slug: str, uid: str = Depends(auth.get_current_user_uid)):
    """Delete a skill (user-owned only; shared skills are protected)."""
    path = _skills_dir(uid) / f"{_slug(slug)}.md"
    if path.exists():
        path.unlink()
        return {"success": True, "slug": slug}
    shared = _shared_skills_dir() / f"{_slug(slug)}.md"
    if shared.exists():
        raise HTTPException(status_code=403, detail="Cannot delete shared skills. Contact admin.")
    raise HTTPException(status_code=404, detail=f"Skill '{slug}' not found")
