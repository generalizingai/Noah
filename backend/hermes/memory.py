"""
SessionDB — SQLite-backed persistent conversation memory for Noah's Hermes engine.

Architectural concepts from NousResearch/hermes-agent hermes_state.py (MIT):
  - SQLite with FTS5 full-text search across conversation history
  - Thread-safe writes using a module-level lock
  - Session-scoped turn storage with ISO-8601 timestamps

Simplified for Noah's desktop assistant use-case.
"""

import logging
import os
import sqlite3
import threading
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

_BACKEND_DIR = Path(__file__).parent.parent

_DEFAULT_DB = Path(os.environ.get(
    "NOAH_HERMES_DB_PATH",
    str(_BACKEND_DIR / "data" / "hermes_sessions.db"),
))

_lock = threading.Lock()


class SessionDB:
    """
    Thread-safe SQLite session store for Hermes conversation history.
    Supports FTS5 full-text search across all stored turns.
    """

    def __init__(self, db_path: Optional[Path] = None):
        self.db_path = Path(db_path) if db_path else _DEFAULT_DB
        try:
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
            self._init_db()
        except Exception as exc:
            logger.warning("SessionDB init failed (%s) — memory disabled", exc)
            self._disabled = True
        else:
            self._disabled = False

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), check_same_thread=False, timeout=10)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self):
        with _lock, self._connect() as conn:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS sessions (
                    id          TEXT PRIMARY KEY,
                    created_at  TEXT NOT NULL,
                    updated_at  TEXT NOT NULL,
                    title       TEXT
                );

                CREATE TABLE IF NOT EXISTS turns (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id  TEXT NOT NULL,
                    created_at  TEXT NOT NULL,
                    role        TEXT NOT NULL,
                    content     TEXT NOT NULL,
                    FOREIGN KEY (session_id) REFERENCES sessions(id)
                );

                CREATE INDEX IF NOT EXISTS idx_turns_session
                    ON turns(session_id, id);

                CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts
                    USING fts5(content, session_id UNINDEXED,
                               content='turns', content_rowid='id');
            """)

    def ensure_session(self, session_id: str, title: str = None):
        if self._disabled:
            return
        now = datetime.utcnow().isoformat()
        with _lock, self._connect() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO sessions(id, created_at, updated_at, title) VALUES(?,?,?,?)",
                (session_id, now, now, title or session_id[:12]),
            )

    def add_turn(self, session_id: str, user_message: str, assistant_message: str):
        """Persist a user+assistant exchange to the session."""
        if self._disabled:
            return
        self.ensure_session(session_id)
        now = datetime.utcnow().isoformat()
        try:
            with _lock, self._connect() as conn:
                for role, content in [("user", user_message), ("assistant", assistant_message)]:
                    rowid = conn.execute(
                        "INSERT INTO turns(session_id, created_at, role, content) VALUES(?,?,?,?)",
                        (session_id, now, role, content[:16000]),
                    ).lastrowid
                    conn.execute(
                        "INSERT INTO turns_fts(rowid, content, session_id) VALUES(?,?,?)",
                        (rowid, content[:16000], session_id),
                    )
                conn.execute(
                    "UPDATE sessions SET updated_at=? WHERE id=?",
                    (now, session_id),
                )
        except Exception as exc:
            logger.warning("SessionDB add_turn error: %s", exc)

    def get_history(self, session_id: str, limit: int = 40) -> List[Dict]:
        """Return the most recent `limit` turns for a session, oldest-first."""
        if self._disabled:
            return []
        try:
            with _lock, self._connect() as conn:
                rows = conn.execute(
                    "SELECT role, content FROM turns WHERE session_id=? ORDER BY id DESC LIMIT ?",
                    (session_id, limit),
                ).fetchall()
            return [{"role": r["role"], "content": r["content"]} for r in reversed(rows)]
        except Exception as exc:
            logger.warning("SessionDB get_history error: %s", exc)
            return []

    def search(self, query: str, limit: int = 5) -> List[Dict]:
        """Full-text search across all stored turns."""
        if self._disabled:
            return []
        try:
            with _lock, self._connect() as conn:
                rows = conn.execute(
                    """SELECT t.session_id, t.role, t.content
                       FROM turns_fts f
                       JOIN turns t ON f.rowid = t.id
                       WHERE turns_fts MATCH ?
                       LIMIT ?""",
                    (query, limit),
                ).fetchall()
            return [dict(r) for r in rows]
        except Exception as exc:
            logger.warning("SessionDB search error: %s", exc)
            return []

    def list_sessions(self, limit: int = 20) -> List[Dict]:
        """Return the most recently updated sessions.

        Each entry has keys: session_id, title, created_at, updated_at.
        """
        if self._disabled:
            return []
        try:
            with _lock, self._connect() as conn:
                rows = conn.execute(
                    "SELECT id AS session_id, title, created_at, updated_at FROM sessions ORDER BY updated_at DESC LIMIT ?",
                    (limit,),
                ).fetchall()
            return [dict(r) for r in rows]
        except Exception as exc:
            logger.warning("SessionDB list_sessions error: %s", exc)
            return []
