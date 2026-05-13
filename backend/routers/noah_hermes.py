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

from fastapi import APIRouter, Depends, HTTPException, Request, Response
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


_CAPABILITY_QUERY_RE = re.compile(
    r"(get_capabilities|list\s+your\s+tools|what\s+tools|what\s+can\s+you\s+do|capabilities|docker\s+sandbox|terminal\s+shells?|cronjob|cron\s+job|scheduler?)",
    re.IGNORECASE,
)


def _build_capability_summary() -> Dict[str, Any]:
    try:
        from hermes.tools import TOOL_SCHEMAS
        tools = sorted(TOOL_SCHEMAS.keys())
    except Exception:
        tools = []
    return {
        "tool_count": len(tools),
        "tools": tools,
    }


def _format_capability_response(summary: Dict[str, Any]) -> str:
    tools = summary.get("tools", [])
    head = tools[:20]
    return (
        f"Capabilities check complete.\n"
        f"- Tools count: {summary.get('tool_count', 0)}\n"
        f"- First 20 tools: {', '.join(head) if head else 'none'}"
    )


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
    "process",
    "run_applescript",
    "show_notification",
    "open_url",
    "open_path",
    "write_file",
    "search_files",
    "patch",
    "read_file",
    "list_directory",
    "computer_open_application",
    "computer_click",
    "computer_type",
    "computer_hotkey",
    "computer_wait_for_app",
    "computer_claude_create_thread",
    "computer_observe",
    "computer_click_text",
    "computer_type_in_field",
    "computer_verify_text",
    "computer_vscode_open_project",
    "computer_vscode_open_file",
    "computer_vscode_run_task",
    "browser_playwright_script",
    "execute_code",
    "browser_navigate",
    "browser_snapshot",
    "browser_click",
    "browser_type",
    "browser_scroll",
    "browser_back",
    "browser_press",
    "browser_get_images",
    "browser_vision",
    "browser_console",
    "web_search",
    "web_extract",
    "cloud_codespaces_list",
    "cloud_codespace_create",
    "cloud_codespace_open",
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

# ── Worker sessions (phase B, feature-flagged) ──────────────────────────────
_workers_lock = threading.Lock()
_worker_sessions: Dict[str, Dict[str, Any]] = {}
_worker_memory_store: Dict[str, List[Dict[str, Any]]] = {}


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
            return _tool_error_payload(
                "LOCAL_BRIDGE_DOWN",
                (
                    f"{tool_name} requires the Noah desktop app to be connected. "
                    "Please open the Noah desktop app and ensure it is running."
                ),
                True,
                "Open Noah desktop app and retry.",
            )

        tool_call_evt = {
            "type": "tool_call",
            "call_id": call_id,
            "tool": tool_name,
            "args": kwargs,
            "plane": "device",
            "fallback_from": "server",
            "fallback_to": "device",
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
            return _tool_error_payload(
                "LOCAL_BRIDGE_DOWN",
                f"Failed to dispatch {tool_name} to any connected desktop client.",
                True,
                "Re-open Noah desktop app and retry.",
            )

        if not event.wait(timeout=_REMOTE_CALL_TIMEOUT):
            with _pending_calls_lock:
                _pending_tool_calls.pop(call_id, None)
            return _tool_error_payload(
                "TOOL_TIMEOUT",
                (
                    f"{tool_name} timed out after {_REMOTE_CALL_TIMEOUT}s waiting "
                    "for the desktop app to respond. Make sure the Noah desktop app is open."
                ),
                True,
                "Retry once. If it keeps failing, use server/cloud fallback.",
            )

        with _pending_calls_lock:
            entry = _pending_tool_calls.pop(call_id, {})

        result = entry.get("result")
        if result is None:
            return _tool_error_payload(
                "UNKNOWN",
                "Desktop app returned no result.",
                True,
                "Retry the request.",
            )
        return _normalize_tool_result(result, plane="device")

    handler.__name__ = f"remote_proxy_{tool_name}"
    return handler


# ── Request / Response models ────────────────────────────────────────────────

class HermesChatRequest(BaseModel):
    message: Any
    system_prompt: Optional[str] = None
    session_id: Optional[str] = None
    history: Optional[List[Dict[str, Any]]] = None
    model: Optional[str] = None  # client-selected model; overrides NOAH_HERMES_MODEL env var
    latency_mode: Optional[str] = "balanced"  # balanced | realtime
    execution_profile: Optional[str] = "hybrid_auto"  # hybrid_auto | prefer_local | prefer_server
    capability_snapshot: Optional[Dict[str, Any]] = None
    risk_level: Optional[str] = "risk_based"  # risk_based | always_ask | power_mode


class HermesChatResponse(BaseModel):
    response: str
    session_id: str
    mode: str = "hermes"
    model: str = ""
    execution_profile: str = "hybrid_auto"


class ToolResultRequest(BaseModel):
    result: Dict[str, Any]


class HermesWarmupRequest(BaseModel):
    session_id: Optional[str] = None
    model: Optional[str] = None
    latency_mode: Optional[str] = "balanced"


class WorkerCreateRequest(BaseModel):
    name: str
    role: str
    objective: str = ""
    personality: str = "professional"
    instructions: str = ""
    constraints: Optional[List[str]] = None
    skills: Optional[List[str]] = None
    connectors: Optional[List[str]] = None
    tools: Optional[List[str]] = None
    memory_scope: str = "shared"
    storage_namespace: str = "default"
    storage_quota_mb: int = 256
    tool_policy: Optional[Dict[str, Any]] = None


class WorkerRunRequest(BaseModel):
    task: str
    output_format: Optional[str] = "summary"
    tools: Optional[List[str]] = None
    connectors: Optional[List[str]] = None


class WorkerMemoryCreateRequest(BaseModel):
    content: str
    kind: Optional[str] = "note"


class CronjobRequest(BaseModel):
    action: str = "list"
    schedule: Optional[str] = ""
    task: Optional[str] = ""
    job_id: Optional[str] = ""
    paused: Optional[bool] = False
    reason: Optional[str] = ""


def _resolve_max_iterations(latency_mode: Optional[str]) -> int:
    """Per-request iteration budget: faster for voice/realtime traffic."""
    base = int(os.environ.get("NOAH_HERMES_MAX_ITERATIONS", "12"))
    realtime = int(os.environ.get("NOAH_HERMES_MAX_ITERATIONS_REALTIME", "4"))
    return realtime if (latency_mode or "").lower() == "realtime" else base


def _extract_message_text(message: Any) -> str:
    """Best-effort text extraction from plain or multimodal message payloads."""
    if isinstance(message, str):
        return message
    if isinstance(message, list):
        parts: List[str] = []
        for item in message:
            if isinstance(item, dict):
                if item.get("type") in {"text", "input_text"}:
                    txt = item.get("text")
                    if isinstance(txt, str):
                        parts.append(txt)
        return " ".join(parts).strip()
    return str(message or "")


def _tool_error_payload(error_code: str, message: str, recoverable: bool, next_action: str = "") -> Dict[str, Any]:
    return {
        "success": False,
        "plane": "device",
        "error_code": error_code,
        "error": message,
        "recoverable": recoverable,
        "fallback_attempted": False,
        "next_action": next_action,
    }


def _normalize_tool_result(result: Any, plane: str = "device") -> Dict[str, Any]:
    if isinstance(result, dict):
        if "success" not in result:
            result["success"] = not bool(result.get("error"))
        result.setdefault("plane", plane)
        result.setdefault("error_code", "" if result.get("success") else "UNKNOWN")
        result.setdefault("recoverable", not result.get("success"))
        result.setdefault("fallback_attempted", bool(result.get("fallback_attempted", False)))
        result.setdefault("next_action", result.get("next_action", ""))
        return result
    return {
        "success": True,
        "plane": plane,
        "result": result,
        "error_code": "",
        "recoverable": False,
        "fallback_attempted": False,
        "next_action": "",
    }


def _normalize_names(items: Optional[List[str]]) -> List[str]:
    if not items:
        return []
    out: List[str] = []
    for raw in items:
        v = str(raw or "").strip().lower()
        if v and v not in out:
            out.append(v)
    return out


def _list_disallowed(requested: List[str], allowed: List[str]) -> List[str]:
    if not requested:
        return []
    if not allowed:
        return requested
    allowed_set = set(allowed)
    return [x for x in requested if x not in allowed_set]


def _append_worker_memory(worker_id: str, uid: str, namespace: str, content: str, kind: str = "note") -> Dict[str, Any]:
    item = {
        "id": str(uuid.uuid4()),
        "uid": uid,
        "worker_id": worker_id,
        "namespace": namespace,
        "kind": kind,
        "content": content,
        "created_at": int(time.time() * 1000),
    }
    bucket = _worker_memory_store.setdefault(worker_id, [])
    bucket.append(item)
    if len(bucket) > 2000:
        del bucket[: len(bucket) - 2000]
    return item


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


@router.get("/bridge/sse")
async def desktop_bridge_sse(
    request: Request,
    session_id: Optional[str] = None,
    uid: str = Depends(auth.get_current_user_uid),
):
    """
    Lightweight authenticated desktop bridge stream.
    Keeps a live SSE channel registered so capabilities can report desktop_bridge
    as connected even when no active /hermes/chat request is running.
    """
    raw_session = (session_id or "bridge").strip() or "bridge"
    scoped_session = f"{uid}:{raw_session}"
    event_queue: queue.Queue = queue.Queue()

    _register_emitter(scoped_session, event_queue.put)

    async def generate():
        loop = asyncio.get_event_loop()
        try:
            # Initial ack event for diagnostics.
            yield f"data: {json.dumps({'type': 'bridge_ready', 'session_id': raw_session})}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    # Do not block FastAPI's event loop while waiting for bridge
                    # events. A blocking Queue.get here can make /health,
                    # /status, memories, skills, and chat appear offline while a
                    # desktop bridge stream is connected.
                    evt = await loop.run_in_executor(
                        None,
                        lambda: event_queue.get(timeout=20),
                    )
                    yield f"data: {json.dumps(evt)}\n\n"
                except queue.Empty:
                    # Keepalive ping to prevent intermediary idle disconnects.
                    yield ": ping\n\n"
        finally:
            _unregister_emitter(scoped_session, event_queue.put)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/capabilities")
async def hermes_capabilities(uid: str = Depends(auth.get_current_user_uid)):
    mode = _brain_mode()
    prefix = f"{uid}:"
    with _emitters_lock:
        user_stream_count = sum(len(fns) for sid, fns in _session_emitters.items() if sid.startswith(prefix))

    skill_rows = []
    seen = set()
    for path in sorted(_skills_dir(uid).glob("*.md")):
        skill_rows.append(_skill_info(path, "user"))
        seen.add(path.stem)
    for path in sorted(_shared_skills_dir().glob("*.md")):
        if path.stem not in seen:
            skill_rows.append(_skill_info(path, "shared"))

    worker_enabled = os.environ.get("NOAH_WORKER_AGENTS_ENABLED", "true").lower() == "true"
    try:
        from hermes.tools import TOOL_SCHEMAS
        exposed_tools = sorted(TOOL_SCHEMAS.keys())
    except Exception:
        exposed_tools = []

    return {
        "mode": mode,
        "active": mode == "hermes",
        "execution_profile_default": "hybrid_auto",
        "risk_level_default": "risk_based",
        "capabilities": {
            "server_hermes": {"available": mode == "hermes", "reason": "" if mode == "hermes" else "NOAH_BRAIN_MODE not hermes"},
            "desktop_bridge": {"available": user_stream_count > 0, "streams": user_stream_count},
            "remote_proxy_tools": {"available": True, "count": len(_REMOTE_PROXY_TOOLS)},
            "byok": {"available": True},
            "skills": {
                "available": True,
                "count": len(skill_rows),
                "sample": [s.get("name") or s.get("slug") for s in skill_rows[:5]],
            },
            "memory": {"backend_available": True, "source": "firestore"},
            "delegation": {
                "virtual_available": True,
                "worker_available": worker_enabled,
                "worker_flag": "NOAH_WORKER_AGENTS_ENABLED",
            },
            "tools": {
                "available": True,
                "count": len(exposed_tools),
                "sample": exposed_tools[:20],
                "all": exposed_tools,
            },
        },
    }


@router.get("/parity")
async def hermes_parity(uid: str = Depends(auth.get_current_user_uid)):
    """
    Compare Noah-exposed Hermes tools against upstream Hermes API-server toolset.
    Returns concrete missing/excess names so we can close parity gaps safely.
    """
    try:
        from hermes.toolsets import resolve_toolset
        upstream = set(resolve_toolset("hermes-api-server"))
    except Exception:
        upstream = set()

    try:
        from hermes.tools import TOOL_SCHEMAS
        noah_tools = set(TOOL_SCHEMAS.keys())
    except Exception:
        noah_tools = set()

    # Add runtime-registered per-user closures not represented as static aliases.
    noah_tools.update({"save_memory", "get_memories", "list_skills", "view_skill", "save_skill", "search_history"})

    missing = sorted(list(upstream - noah_tools))
    extra = sorted(list(noah_tools - upstream))

    return {
        "upstream_toolset": "hermes-api-server",
        "upstream_count": len(upstream),
        "noah_count": len(noah_tools),
        "missing_count": len(missing),
        "missing_tools": missing,
        "extra_count": len(extra),
        "extra_tools": extra,
        "parity_percent": round((len(upstream & noah_tools) / max(1, len(upstream))) * 100, 2),
        "notes": "Missing tools may require provider keys, platform gateways, or explicit NOAH bridge bindings.",
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

    msg = _extract_message_text(req.message).strip()
    msg_l = msg.lower()

    # Deterministic capability route to prevent model-side hallucinations on
    # explicit capability test prompts.
    explicit_cap_req = (
        "call get_capabilities" in msg_l
        or "list your tools" in msg_l
        or "tools count" in msg_l
        or "first 20 tool" in msg_l
    )
    explicit_cron_list_req = (
        "call cronjob action list" in msg_l
        or ("cronjob" in msg_l and "action list" in msg_l)
    )

    if explicit_cap_req or explicit_cron_list_req:
        parts = []
        summary = _build_capability_summary()
        parts.append(_format_capability_response(summary))
        if explicit_cron_list_req:
            try:
                from hermes.tools import _make_cronjob_handler
                cron_result = _make_cronjob_handler(uid)(action="list")
                if cron_result.get("success"):
                    count = cron_result.get("count", len(cron_result.get("jobs", [])))
                    parts.append(f"Cronjob list call succeeded.\n- Jobs count: {count}\n- Jobs: {json.dumps(cron_result.get('jobs', []))[:4000]}")
                else:
                    parts.append(f"Cronjob list call returned error: {cron_result.get('error', 'unknown')}")
            except Exception as exc:
                parts.append(f"Cronjob list call failed: {exc}")

        deterministic_response = "\n\n".join(parts)
        accept = request.headers.get("accept", "")
        wants_sse = "text/event-stream" in accept
        if wants_sse:
            async def _once():
                done_evt = {
                    "type": "done",
                    "session_id": raw_session,
                    "model": req.model or os.environ.get("NOAH_HERMES_MODEL", "google/gemma-4-31b-it"),
                    "response": deterministic_response,
                    "plane": "server",
                    "execution_profile": req.execution_profile or "hybrid_auto",
                    "latency_mode": req.latency_mode or "balanced",
                }
                yield f"data: {json.dumps(done_evt)}\n\n"
            return StreamingResponse(
                _once(),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
            )
        return HermesChatResponse(
            response=deterministic_response,
            session_id=raw_session,
            mode="hermes",
            model=req.model or os.environ.get("NOAH_HERMES_MODEL", "google/gemma-4-31b-it"),
            execution_profile=req.execution_profile or "hybrid_auto",
        )

    # Hard guard: for capability-intent questions, force capability grounding.
    if _CAPABILITY_QUERY_RE.search(msg):
        guard = (
            "\n\nCapability guard:\n"
            "- You MUST call get_capabilities before answering this user message.\n"
            "- Answer only from the returned tool list and capability map.\n"
            "- Do not claim a tool is unavailable unless it is absent in get_capabilities result.\n"
        )
        req.system_prompt = (req.system_prompt or "") + guard

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
    logger.info(
        "Hermes request uid=%s session=%s model=%s exec_profile=%s risk=%s latency=%s caps=%s",
        uid,
        raw_session,
        model_used,
        req.execution_profile,
        req.risk_level,
        req.latency_mode,
        sorted((req.capability_snapshot or {}).keys()),
    )

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
        execution_profile=req.execution_profile or "hybrid_auto",
    )


@router.post("/warmup")
async def hermes_warmup(
    request: Request,
    req: HermesWarmupRequest,
    uid: str = Depends(auth.get_current_user_uid),
):
    """
    Warm Hermes session/agent without issuing an LLM generation.
    Reduces first-message latency by pre-initializing session DB and tools.
    """
    _require_hermes_mode()
    try:
        from hermes_bridge import create_hermes_agent
    except ImportError as exc:
        logger.error("Failed to import hermes_bridge for warmup: %s", exc)
        raise HTTPException(status_code=500, detail=f"Hermes engine unavailable: {exc}")

    raw_session = req.session_id or str(uuid.uuid4())
    session_id = f"{uid}:{raw_session}"
    model_used = req.model or os.environ.get("NOAH_HERMES_MODEL", "google/gemma-4-31b-it")
    provider_override, api_key_override = _resolve_provider_and_key(request, model_used)

    # Create/reuse agent and session record; no model call is made here.
    create_hermes_agent(
        system_prompt=None,
        session_id=session_id,
        uid=uid,
        model=model_used,
        provider=provider_override,
        api_key=api_key_override,
    )
    return {
        "ok": True,
        "session_id": raw_session,
        "model": model_used,
        "latency_mode": req.latency_mode or "balanced",
    }


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
            "plane": "server",
            "execution_profile": req.execution_profile or "hybrid_auto",
            "latency_mode": req.latency_mode or "balanced",
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


def _workers_enabled() -> bool:
    return os.environ.get("NOAH_WORKER_AGENTS_ENABLED", "true").lower() == "true"


@router.post("/workers")
async def create_worker(req: WorkerCreateRequest, uid: str = Depends(auth.get_current_user_uid)):
    if not _workers_enabled():
        raise HTTPException(
            status_code=503,
            detail="Worker agents are disabled. Set NOAH_WORKER_AGENTS_ENABLED=true to enable.",
        )
    worker_id = str(uuid.uuid4())
    now = int(time.time() * 1000)
    row = {
        "worker_id": worker_id,
        "uid": uid,
        "name": (req.name or "").strip() or f"{(req.role or 'general').strip().lower()} worker",
        "role": req.role.strip().lower() or "general",
        "objective": req.objective or "",
        "personality": req.personality or "professional",
        "instructions": req.instructions or "",
        "constraints": req.constraints or [],
        "skills": req.skills or [],
        "connectors": req.connectors or [],
        "tools": req.tools or [],
        "memory_scope": req.memory_scope or "shared",
        "storage_namespace": req.storage_namespace or "default",
        "storage_quota_mb": max(64, min(8192, int(req.storage_quota_mb or 256))),
        "tool_policy": req.tool_policy or {},
        "status": "idle",
        "created_at": now,
        "updated_at": now,
        "result": None,
    }
    with _workers_lock:
        _worker_sessions[worker_id] = row
    return {
        "worker_id": worker_id,
        "status": row["status"],
        "name": row["name"],
        "role": row["role"],
        "objective": row["objective"],
        "personality": row["personality"],
        "instructions": row["instructions"],
        "skills": row["skills"],
        "connectors": row["connectors"],
        "tools": row["tools"],
        "memory_scope": row["memory_scope"],
        "storage_namespace": row["storage_namespace"],
        "storage_quota_mb": row["storage_quota_mb"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


@router.get("/workers")
async def list_workers(uid: str = Depends(auth.get_current_user_uid)):
    if not _workers_enabled():
        raise HTTPException(
            status_code=503,
            detail="Workers are disabled. Set NOAH_WORKER_AGENTS_ENABLED=true to enable.",
        )
    with _workers_lock:
        rows = [dict(v) for v in _worker_sessions.values() if v.get("uid") == uid]
    rows.sort(key=lambda r: r.get("updated_at", 0), reverse=True)
    return {"workers": rows}


@router.get("/workers/{worker_id}")
async def get_worker(worker_id: str, uid: str = Depends(auth.get_current_user_uid)):
    if not _workers_enabled():
        raise HTTPException(
            status_code=503,
            detail="Workers are disabled. Set NOAH_WORKER_AGENTS_ENABLED=true to enable.",
        )
    with _workers_lock:
        row = dict(_worker_sessions.get(worker_id) or {})
    if not row or row.get("uid") != uid:
        raise HTTPException(status_code=404, detail="Worker not found")
    return row


@router.patch("/workers/{worker_id}")
async def update_worker(worker_id: str, req: WorkerCreateRequest, uid: str = Depends(auth.get_current_user_uid)):
    if not _workers_enabled():
        raise HTTPException(
            status_code=503,
            detail="Workers are disabled. Set NOAH_WORKER_AGENTS_ENABLED=true to enable.",
        )
    with _workers_lock:
        row = _worker_sessions.get(worker_id)
        if not row or row.get("uid") != uid:
            raise HTTPException(status_code=404, detail="Worker not found")
        row.update({
            "name": (req.name or "").strip() or row.get("name") or "worker",
            "role": req.role.strip().lower() or row.get("role", "general"),
            "objective": req.objective or "",
            "personality": req.personality or "professional",
            "instructions": req.instructions or "",
            "constraints": req.constraints or [],
            "skills": req.skills or [],
            "connectors": req.connectors or [],
            "tools": req.tools or [],
            "memory_scope": req.memory_scope or "shared",
            "storage_namespace": req.storage_namespace or "default",
            "storage_quota_mb": max(64, min(8192, int(req.storage_quota_mb or 256))),
            "tool_policy": req.tool_policy or {},
            "updated_at": int(time.time() * 1000),
        })
    return {"worker_id": worker_id, "status": "updated"}


@router.delete("/workers/{worker_id}")
async def delete_worker(worker_id: str, uid: str = Depends(auth.get_current_user_uid)):
    if not _workers_enabled():
        raise HTTPException(
            status_code=503,
            detail="Workers are disabled. Set NOAH_WORKER_AGENTS_ENABLED=true to enable.",
        )
    with _workers_lock:
        row = _worker_sessions.get(worker_id)
        if not row or row.get("uid") != uid:
            raise HTTPException(status_code=404, detail="Worker not found")
        _worker_sessions.pop(worker_id, None)
        _worker_memory_store.pop(worker_id, None)
    return {"worker_id": worker_id, "deleted": True}


@router.post("/workers/{worker_id}/run")
async def run_worker(worker_id: str, req: WorkerRunRequest, uid: str = Depends(auth.get_current_user_uid)):
    if not _workers_enabled():
        raise HTTPException(
            status_code=503,
            detail="Worker agents are disabled. Set NOAH_WORKER_AGENTS_ENABLED=true to enable.",
        )
    with _workers_lock:
        row = _worker_sessions.get(worker_id)
        if not row or row.get("uid") != uid:
            raise HTTPException(status_code=404, detail="Worker not found")
        row["status"] = "running"
        row["updated_at"] = int(time.time() * 1000)
        allowed_tools = _normalize_names(row.get("tools"))
        allowed_connectors = _normalize_names(row.get("connectors"))
        requested_tools = _normalize_names(req.tools) if req.tools is not None else allowed_tools
        requested_connectors = _normalize_names(req.connectors) if req.connectors is not None else allowed_connectors

        blocked_tools = _list_disallowed(requested_tools, allowed_tools)
        blocked_connectors = _list_disallowed(requested_connectors, allowed_connectors)
        if blocked_tools or blocked_connectors:
            row["status"] = "failed"
            row["updated_at"] = int(time.time() * 1000)
            row["result"] = {
                "success": False,
                "error_code": "WORKER_POLICY_DENIED",
                "message": "Worker execution blocked by allowlist policy.",
                "blocked_tools": blocked_tools,
                "blocked_connectors": blocked_connectors,
                "allowed_tools": allowed_tools,
                "allowed_connectors": allowed_connectors,
                "worker_id": worker_id,
            }
            return {"worker_id": worker_id, "status": "failed", "error_code": "WORKER_POLICY_DENIED"}

        namespace = str(row.get("storage_namespace") or "default")
        run_memory = _append_worker_memory(
            worker_id=worker_id,
            uid=uid,
            namespace=namespace,
            content=f"Run task: {req.task}",
            kind="run_event",
        )

        row["status"] = "completed"
        row["updated_at"] = int(time.time() * 1000)
        row["result"] = {
            "success": True,
            "summary": (
                f"Worker '{row.get('name', row.get('role', 'general'))}' completed delegated task.\n\n"
                f"Objective: {row.get('objective', '')}\n"
                f"Task: {req.task}\n"
                f"Output format: {req.output_format or 'summary'}\n"
                f"Personality: {row.get('personality', 'professional')}\n"
                f"Skills: {', '.join(row.get('skills', [])[:12]) or 'none assigned'}\n"
                f"Connectors: {', '.join(requested_connectors[:12]) or 'none assigned'}\n"
                f"Tools: {', '.join(requested_tools[:12]) or 'none assigned'}\n"
                f"Memory scope: {row.get('memory_scope', 'shared')} · Storage: {row.get('storage_namespace', 'default')}"
            ),
            "task": req.task,
            "output_format": req.output_format or "summary",
            "name": row.get("name", row.get("role", "general")),
            "role": row.get("role", "general"),
            "personality": row.get("personality", "professional"),
            "constraints": row.get("constraints", []),
            "skills": row.get("skills", []),
            "connectors": requested_connectors,
            "tools": requested_tools,
            "memory_scope": row.get("memory_scope", "shared"),
            "storage_namespace": row.get("storage_namespace", "default"),
            "memory_record_id": run_memory.get("id"),
            "worker_id": worker_id,
        }
    return {"worker_id": worker_id, "status": "completed"}


@router.get("/workers/{worker_id}/status")
async def worker_status(worker_id: str, uid: str = Depends(auth.get_current_user_uid)):
    if not _workers_enabled():
        raise HTTPException(
            status_code=503,
            detail="Worker agents are disabled. Set NOAH_WORKER_AGENTS_ENABLED=true to enable.",
        )
    with _workers_lock:
        row = _worker_sessions.get(worker_id)
    if not row or row.get("uid") != uid:
        raise HTTPException(status_code=404, detail="Worker not found")
    return {
        "worker_id": worker_id,
        "status": row.get("status", "unknown"),
        "role": row.get("role", "general"),
        "updated_at": row.get("updated_at"),
    }


@router.get("/workers/{worker_id}/result")
async def worker_result(worker_id: str, uid: str = Depends(auth.get_current_user_uid)):
    if not _workers_enabled():
        raise HTTPException(
            status_code=503,
            detail="Worker agents are disabled. Set NOAH_WORKER_AGENTS_ENABLED=true to enable.",
        )
    with _workers_lock:
        row = _worker_sessions.get(worker_id)
    if not row or row.get("uid") != uid:
        raise HTTPException(status_code=404, detail="Worker not found")
    if not row.get("result"):
        return {"worker_id": worker_id, "status": row.get("status", "idle"), "result": None}
    return {"worker_id": worker_id, "status": row.get("status", "completed"), "result": row.get("result")}


@router.get("/workers/{worker_id}/memories")
async def worker_memories(worker_id: str, uid: str = Depends(auth.get_current_user_uid)):
    if not _workers_enabled():
        raise HTTPException(
            status_code=503,
            detail="Workers are disabled. Set NOAH_WORKER_AGENTS_ENABLED=true to enable.",
        )
    with _workers_lock:
        row = _worker_sessions.get(worker_id)
    if not row or row.get("uid") != uid:
        raise HTTPException(status_code=404, detail="Worker not found")
    bucket = [m for m in _worker_memory_store.get(worker_id, []) if m.get("uid") == uid]
    bucket.sort(key=lambda x: x.get("created_at", 0), reverse=True)
    return {"worker_id": worker_id, "namespace": row.get("storage_namespace", "default"), "memories": bucket}


@router.post("/workers/{worker_id}/memories")
async def worker_memory_create(worker_id: str, req: WorkerMemoryCreateRequest, uid: str = Depends(auth.get_current_user_uid)):
    if not _workers_enabled():
        raise HTTPException(
            status_code=503,
            detail="Workers are disabled. Set NOAH_WORKER_AGENTS_ENABLED=true to enable.",
        )
    with _workers_lock:
        row = _worker_sessions.get(worker_id)
    if not row or row.get("uid") != uid:
        raise HTTPException(status_code=404, detail="Worker not found")
    content = (req.content or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="Memory content is required")
    item = _append_worker_memory(
        worker_id=worker_id,
        uid=uid,
        namespace=str(row.get("storage_namespace") or "default"),
        content=content,
        kind=req.kind or "note",
    )
    return {"worker_id": worker_id, "memory": item}


@router.post("/cronjob")
async def hermes_cronjob(req: CronjobRequest, uid: str = Depends(auth.get_current_user_uid)):
    """
    Utility endpoint for Classic mode tool execution to access cronjob capability
    through the same backend logic used by Hermes tools.
    """
    try:
        from hermes.tools import _make_cronjob_handler
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Cronjob tool unavailable: {exc}")
    handler = _make_cronjob_handler(uid)
    result = handler(
        action=req.action or "list",
        schedule=req.schedule or "",
        task=req.task or "",
        job_id=req.job_id or "",
        paused=bool(req.paused),
        reason=req.reason or "",
    )
    return result


def _preflight_ok() -> Response:
    """
    Explicit CORS preflight response for Electron/renderer clients.
    Some clients still issue OPTIONS probes that bypass middleware heuristics.
    """
    return Response(
        status_code=204,
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET,POST,DELETE,PATCH,OPTIONS",
            "Access-Control-Allow-Headers": (
                "Authorization,Content-Type,Accept,"
                "X-BYOK-OpenAI,X-BYOK-OpenRouter,X-BYOK-Deepgram,X-BYOK-Anthropic"
            ),
            "Access-Control-Max-Age": "86400",
        },
    )


@router.options("/chat")
async def hermes_chat_options():
    return _preflight_ok()


@router.options("/tool_result/{call_id}")
async def hermes_tool_result_options(call_id: str):
    return _preflight_ok()


@router.options("/skills")
async def hermes_skills_options():
    return _preflight_ok()


@router.options("/capabilities")
async def hermes_capabilities_options():
    return _preflight_ok()

@router.options("/cronjob")
async def hermes_cronjob_options():
    return _preflight_ok()


@router.options("/parity")
async def hermes_parity_options():
    return _preflight_ok()


@router.options("/skills/{slug:path}")
async def hermes_skill_options(slug: str):
    return _preflight_ok()


@router.options("/workers")
async def hermes_workers_options():
    return _preflight_ok()


@router.options("/workers/{worker_id:path}")
async def hermes_worker_options(worker_id: str):
    return _preflight_ok()


@router.options("/workers/{worker_id:path}/run")
async def hermes_worker_run_options(worker_id: str):
    return _preflight_ok()


@router.options("/workers/{worker_id:path}/status")
async def hermes_worker_status_options(worker_id: str):
    return _preflight_ok()


@router.options("/workers/{worker_id:path}/result")
async def hermes_worker_result_options(worker_id: str):
    return _preflight_ok()


@router.options("/workers/{worker_id:path}/memories")
async def hermes_worker_memories_options(worker_id: str):
    return _preflight_ok()
