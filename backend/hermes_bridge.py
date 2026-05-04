"""
hermes_bridge.py — Top-level singleton bridge for Noah's Hermes engine.

Creates AIAgent instances with Noah's full tool suite and provides
a clean async-friendly interface for the FastAPI router (noah_hermes.py).

Uses the vendored upstream hermes_state.SessionDB (NousResearch/hermes-agent, MIT)
for persistent session storage with SQLite + FTS5 full-text search.

Design:
  - One SessionDB instance is shared across all requests (thread-safe).
  - One AIAgent instance per user-uid is cached (singleton per user).
    This matches the task spec requirement for a "persistent singleton AIAgent"
    while keeping concurrent multi-user access safe via per-user isolation.
  - History is persisted in SQLite and replayed into each agent's context.
  - Tool registration happens once per agent instance via register_noah_tools().
"""

import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from hermes.agent import AIAgent
from hermes.hermes_state import SessionDB
from hermes.tools import register_noah_tools

logger = logging.getLogger(__name__)

# Directory containing this file (backend/)
_BACKEND_DIR = Path(__file__).parent

# ── Shared SQLite session DB (thread-safe, upstream vendored) ────────────────

_db_lock = threading.Lock()
_shared_db: Optional[SessionDB] = None


def _get_shared_db() -> SessionDB:
    global _shared_db
    if _shared_db is None:
        with _db_lock:
            if _shared_db is None:
                db_path = Path(
                    os.environ.get(
                        "NOAH_HERMES_DB_PATH",
                        str(_BACKEND_DIR / "data" / "hermes_sessions.db"),
                    )
                )
                db_path.parent.mkdir(parents=True, exist_ok=True)
                _shared_db = SessionDB(db_path)
                logger.info("Hermes SessionDB initialized at %s", db_path)
                _schedule_session_cleanup(_shared_db)
    return _shared_db


# ── Session cleanup (remove sessions older than 30 days) ─────────────────────

_SESSION_RETENTION_DAYS = int(os.environ.get("NOAH_HERMES_RETENTION_DAYS", "30"))
_CLEANUP_INTERVAL_SECONDS = 24 * 60 * 60  # run once per day


def _run_cleanup(db: SessionDB) -> None:
    """Background thread: prune old sessions once on startup, then daily."""
    while True:
        try:
            removed = db.prune_sessions(older_than_days=_SESSION_RETENTION_DAYS)
            if removed:
                logger.info(
                    "Hermes session cleanup: removed %d sessions older than %d days",
                    removed,
                    _SESSION_RETENTION_DAYS,
                )
        except Exception as exc:
            logger.warning("Hermes session cleanup error: %s", exc)
        time.sleep(_CLEANUP_INTERVAL_SECONDS)


def _schedule_session_cleanup(db: SessionDB) -> None:
    """Start the background cleanup thread (daemon so it doesn't block shutdown)."""
    t = threading.Thread(target=_run_cleanup, args=(db,), daemon=True, name="hermes-session-cleanup")
    t.start()
    logger.debug("Hermes session cleanup thread started (retention=%d days)", _SESSION_RETENTION_DAYS)


# ── Singleton agent cache (one persistent AIAgent per user-uid) ──────────────
#
# The task spec requires a "persistent singleton AIAgent" so it preserves
# Hermes-internal memory across requests.  We implement this as a per-uid
# cache so concurrent users don't share state.
#
# Agents in the cache keep their registered tools and any in-process Hermes
# state.  Conversation history is also written to the shared SQLite SessionDB
# so it survives process restarts.

_agent_lock = threading.Lock()
_agent_cache: Dict[tuple, AIAgent] = {}  # (uid, session_id) → AIAgent
_MAX_ITERATIONS = int(os.environ.get("NOAH_HERMES_MAX_ITERATIONS", "12"))


def _key_fingerprint(value: Optional[str]) -> str:
    """Non-reversible short fingerprint for cache-change detection."""
    if not value:
        return ""
    # Keep it simple and deterministic without exposing the full key.
    return f"{len(value)}:{value[:6]}:{value[-4:]}"


def _get_or_create_agent(
    uid: str,
    model: str = None,
    api_key: str = None,
    provider: str = None,
    system_prompt: str = None,
    session_id: str = None,
    tool_start_callback=None,
    tool_complete_callback=None,
    status_callback=None,
) -> AIAgent:
    """
    Return the cached AIAgent for this (uid, session_id) pair, creating one if needed.

    Keying on (uid, session_id) — not just uid — ensures each conversation session
    has its own isolated agent.  This prevents a user's second session from
    inadvertently reading or corrupting the history of their first session.

    Callbacks are refreshed on every call (they may differ per request).
    """
    global _agent_cache

    resolved_model = model or os.environ.get("NOAH_HERMES_MODEL", "claude-opus-4-20250514")
    cache_key = (uid, session_id)

    with _agent_lock:
        cached = _agent_cache.get(cache_key)
        requested_provider = (provider or "").strip().lower()
        requested_key_fp = _key_fingerprint(api_key)
        cached_provider = (getattr(cached, "_provider", "") or "").strip().lower() if cached else ""
        cached_key_fp = _key_fingerprint(getattr(cached, "_api_key", None)) if cached else ""

        # Evict cached agent if the model has changed so the new model takes effect
        if cached is not None and cached.model != resolved_model:
            logger.info(
                "Hermes model changed for uid=%s session=%s: %s → %s — recreating agent",
                uid, session_id, cached.model, resolved_model,
            )
            try:
                cached._executor.shutdown(wait=False, cancel_futures=True)
            except Exception:
                pass
            del _agent_cache[cache_key]
            cached = None

        # Evict cached agent when BYOK provider/key changed. Some provider clients
        # are initialized during agent construction; mutating attributes later is
        # not always enough to refresh upstream auth headers.
        if cached is not None and (
            (requested_provider and requested_provider != cached_provider)
            or (requested_key_fp and requested_key_fp != cached_key_fp)
        ):
            logger.info(
                "Hermes BYOK changed for uid=%s session=%s: provider %s→%s key_fp %s→%s — recreating agent",
                uid, session_id, cached_provider or "-", requested_provider or "-", cached_key_fp or "-", requested_key_fp or "-",
            )
            try:
                cached._executor.shutdown(wait=False, cancel_futures=True)
            except Exception:
                pass
            del _agent_cache[cache_key]
            cached = None

        if cached is None:
            agent = AIAgent(
                model=resolved_model,
                api_key=api_key,
                provider=provider,
                quiet_mode=True,
                ephemeral_system_prompt=system_prompt,
                max_iterations=_MAX_ITERATIONS,
                session_id=session_id,
                session_db=_get_shared_db(),
                tool_start_callback=tool_start_callback,
                tool_complete_callback=tool_complete_callback,
                status_callback=status_callback,
            )
            register_noah_tools(agent, uid=uid, session_db=_get_shared_db())
            _agent_cache[cache_key] = agent
            logger.info(
                "Hermes singleton agent created: uid=%s session=%s model=%s tools=%d",
                uid, session_id, resolved_model, len(agent._tools),
            )
        else:
            agent = cached
            # Refresh per-request callbacks and system prompt
            if tool_start_callback:
                agent.tool_start_callback = tool_start_callback
            if tool_complete_callback:
                agent.tool_complete_callback = tool_complete_callback
            if status_callback:
                agent.status_callback = status_callback
            if system_prompt and system_prompt != agent.ephemeral_system_prompt:
                agent.ephemeral_system_prompt = system_prompt
            # Refresh per-request auth/provider overrides (important for BYOK in thread pools).
            if api_key:
                agent._api_key = api_key
            if provider:
                agent._provider = provider

    return agent


# ── Public factory (used by the FastAPI router) ────────────────────────────────

def create_hermes_agent(
    system_prompt: str = None,
    session_id: str = None,
    uid: str = None,
    model: str = None,
    api_key: str = None,
    provider: str = None,
    tool_start_callback=None,
    tool_complete_callback=None,
    status_callback=None,
) -> AIAgent:
    """
    Get or create an AIAgent for the given user equipped with Noah's full tool suite.

    When uid is provided a persistent singleton agent is returned from the cache
    (one agent per user, per process lifetime).  When uid is None a fresh
    disposable agent is returned (useful for testing without auth).

    Session history is always persisted to the shared SQLite SessionDB so
    conversations survive process restarts regardless of the agent cache.

    Args:
        system_prompt:          System prompt injected per conversation turn
        session_id:             Persistent session ID for SQLite history
        uid:                    Firebase user UID (enables save_memory + agent caching)
        model:                  Override the default model
        tool_start_callback:    Called when a tool starts running
        tool_complete_callback: Called when a tool finishes
        status_callback:        Called with status strings

    Returns:
        AIAgent configured with Noah's tools (+ save_memory if uid given)
        backed by the shared SessionDB.
    """
    db = _get_shared_db()

    # Ensure session record exists in the upstream SessionDB
    if session_id:
        resolved_model = model or os.environ.get("NOAH_HERMES_MODEL", "claude-opus-4-20250514")
        db.create_session(
            session_id=session_id,
            source="noah",
            model=resolved_model,
            system_prompt=system_prompt,
            user_id=uid,
        )

    if uid:
        # Return the persistent per-user singleton agent
        return _get_or_create_agent(
            uid=uid,
            model=model,
            api_key=api_key,
            provider=provider,
            system_prompt=system_prompt,
            session_id=session_id,
            tool_start_callback=tool_start_callback,
            tool_complete_callback=tool_complete_callback,
            status_callback=status_callback,
        )

    # No uid — create a disposable agent (testing / anonymous mode)
    resolved_model = model or os.environ.get("NOAH_HERMES_MODEL", "claude-opus-4-20250514")
    agent = AIAgent(
        model=resolved_model,
        api_key=api_key,
        provider=provider,
        quiet_mode=True,
        ephemeral_system_prompt=system_prompt,
        max_iterations=_MAX_ITERATIONS,
        session_id=session_id,
        session_db=db,
        tool_start_callback=tool_start_callback,
        tool_complete_callback=tool_complete_callback,
        status_callback=status_callback,
    )
    register_noah_tools(agent, uid=None, session_db=db)
    logger.debug("Hermes disposable agent created (no uid): tools=%d", len(agent._tools))
    return agent


# ── History helpers ────────────────────────────────────────────────────────────

def get_conversation_history(session_id: str, limit: int = 20) -> List[Dict[str, Any]]:
    """Retrieve recent conversation history for a session from the vendored SessionDB."""
    db = _get_shared_db()
    try:
        msgs = db.get_messages(session_id)
        # Return only user/assistant roles, most recent `limit` messages
        history = [
            {"role": m["role"], "content": m["content"]}
            for m in msgs
            if m.get("role") in ("user", "assistant") and m.get("content")
        ]
        return history[-limit:]
    except Exception as exc:
        logger.warning("get_conversation_history error session=%s: %s", session_id, exc)
        return []


def search_conversations(query: str, limit: int = 5) -> List[Dict[str, Any]]:
    """Full-text search across all stored Hermes conversations."""
    db = _get_shared_db()
    try:
        return db.search_messages(query, limit=limit)
    except Exception as exc:
        logger.warning("search_conversations error: %s", exc)
        return []
