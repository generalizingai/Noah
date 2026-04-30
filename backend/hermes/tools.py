"""
Noah tool registrations for the Hermes engine.

Maps Noah's capabilities into Hermes-callable Python functions using the same
interface as NousResearch/hermes-agent tools/*.py (registry.register() pattern):
  - handler function
  - availability check
  - JSON schema (OpenAI function-calling format)

Server-compatible tools (run on Linux/Replit):
  search_web, fetch_webpage, terminal,
  read_file, write_file, list_directory, api_call,
  get_memories, search_history, list_skills, view_skill, save_skill

macOS-only tools (return graceful error on non-Darwin systems):
  run_applescript, show_notification, open_url, open_path
"""

import json
import logging
import os
import platform
import re
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_IS_MACOS = platform.system() == "Darwin"

_BACKEND_DIR = Path(__file__).parent.parent


# ── Handlers ────────────────────────────────────────────────────────────────

def _run_shell(command: str, reason: str = "") -> Dict[str, Any]:
    """
    Execute a shell command.

    On the backend server this is stubbed — arbitrary shell execution on a shared
    host creates RCE risk.  The Electron desktop app intercepts this tool call via
    IPC and runs the command on the user's own Mac instead.  When running locally
    (NOAH_DESKTOP_LOCAL=1) or in a sandboxed dev environment the command is
    executed directly.
    """
    if not os.environ.get("NOAH_DESKTOP_LOCAL"):
        return {
            "note": (
                "terminal is executed by the Noah desktop app on your Mac. "
                "The command has been queued; ensure the desktop app is running. "
                f"command={command!r}"
            ),
            "desktop_proxy": True,
            "command": command,
        }
    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=30,
            env={**os.environ},
        )
        return {
            "success": result.returncode == 0,
            "stdout": result.stdout[:4000],
            "stderr": result.stderr[:1000],
            "returncode": result.returncode,
        }
    except subprocess.TimeoutExpired:
        return {"error": "Command timed out after 30 seconds"}
    except Exception as exc:
        return {"error": str(exc)}


def _run_applescript(script: str, reason: str = "") -> Dict[str, Any]:
    """Execute AppleScript on macOS."""
    if not _IS_MACOS:
        return {
            "error": (
                "AppleScript requires the Noah desktop app to be running on your Mac. "
                "Please open the Noah desktop app so this tool can execute on your machine."
            ),
            "desktop_proxy_required": True,
        }
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True,
            text=True,
            timeout=20,
        )
        return {
            "success": result.returncode == 0,
            "output": result.stdout.strip(),
            "error": result.stderr.strip() if result.returncode != 0 else None,
        }
    except subprocess.TimeoutExpired:
        return {"error": "AppleScript timed out after 20 seconds"}
    except Exception as exc:
        return {"error": str(exc)}


def _search_web(query: str, reason: str = "") -> Dict[str, Any]:
    """Search the web using DuckDuckGo HTML interface, returning real URLs."""
    try:
        url = f"https://html.duckduckgo.com/html/?q={urllib.parse.quote(query)}"
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            content = resp.read().decode("utf-8", errors="replace")

        results = []
        # Extract result blocks
        result_blocks = re.findall(r'<div class="result[^"]*"[^>]*>(.*?)</div>\s*</div>', content, re.DOTALL)
        for block in result_blocks[:10]:
            # Extract the actual href from result title link
            href_match = re.search(r'class="result__a"[^>]*href="([^"]*)"', block)
            title_match = re.search(r'class="result__a"[^>]*>(.*?)</a>', block, re.DOTALL)
            snippet_match = re.search(r'class="result__snippet"[^>]*>(.*?)</(?:a|span)>', block, re.DOTALL)

            if not href_match:
                continue

            raw_href = href_match.group(1)
            # DuckDuckGo wraps links as //duckduckgo.com/l/?uddg=ENCODED_URL
            real_url = raw_href
            if "uddg=" in raw_href:
                try:
                    parsed = urllib.parse.urlparse(raw_href)
                    qs = urllib.parse.parse_qs(parsed.query)
                    if "uddg" in qs:
                        real_url = urllib.parse.unquote(qs["uddg"][0])
                except Exception:
                    pass
            # Ensure absolute URL
            if real_url.startswith("//"):
                real_url = "https:" + real_url

            title = re.sub(r'<[^>]+>', '', title_match.group(1)).strip() if title_match else ""
            snippet = re.sub(r'<[^>]+>', '', snippet_match.group(1)).strip() if snippet_match else ""

            if real_url.startswith("http") and title:
                results.append({
                    "title": title,
                    "url": real_url,
                    "snippet": snippet,
                })

        if not results:
            # Fallback: try simpler extraction
            links = re.findall(r'href="(https?://[^"]+)"[^>]*class="result__a"', content)
            titles = re.findall(r'class="result__a"[^>]*>(.*?)</a>', content, re.DOTALL)
            snippets = re.findall(r'class="result__snippet"[^>]*>(.*?)</(?:a|span)>', content, re.DOTALL)
            for i, link in enumerate(links[:8]):
                results.append({
                    "title": re.sub(r'<[^>]+>', '', titles[i]).strip() if i < len(titles) else "",
                    "url": link,
                    "snippet": re.sub(r'<[^>]+>', '', snippets[i]).strip() if i < len(snippets) else "",
                })

        if not results:
            return {"success": False, "query": query, "results": [], "text": "No results found."}

        text_lines = []
        for r in results:
            line = f"[{r['title']}]({r['url']})"
            if r["snippet"]:
                line += f"\n  {r['snippet']}"
            text_lines.append(line)

        return {
            "success": True,
            "query": query,
            "count": len(results),
            "results": results,
            "text": "\n\n".join(text_lines),
        }
    except Exception as exc:
        return {"success": False, "error": str(exc)}


def _fetch_webpage(url: str, reason: str = "") -> Dict[str, Any]:
    """Fetch and extract the main text content of a URL with smart cleaning."""
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
        }
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=20) as resp:
            content_type = resp.headers.get("Content-Type", "")
            raw = resp.read(800_000).decode("utf-8", errors="replace")

        # If JSON, return raw
        if "application/json" in content_type:
            return {"success": True, "url": url, "content": raw[:12000], "type": "json"}

        # Remove noisy sections before tag stripping
        raw = re.sub(r'<style[^>]*>.*?</style>', '', raw, flags=re.DOTALL | re.IGNORECASE)
        raw = re.sub(r'<script[^>]*>.*?</script>', '', raw, flags=re.DOTALL | re.IGNORECASE)
        raw = re.sub(r'<!--.*?-->', '', raw, flags=re.DOTALL)
        raw = re.sub(r'<nav[^>]*>.*?</nav>', '', raw, flags=re.DOTALL | re.IGNORECASE)
        raw = re.sub(r'<header[^>]*>.*?</header>', '', raw, flags=re.DOTALL | re.IGNORECASE)
        raw = re.sub(r'<footer[^>]*>.*?</footer>', '', raw, flags=re.DOTALL | re.IGNORECASE)
        raw = re.sub(r'<aside[^>]*>.*?</aside>', '', raw, flags=re.DOTALL | re.IGNORECASE)

        # Preserve meaningful block separators
        raw = re.sub(r'<(?:h[1-6]|p|li|tr|div|section|article)[^>]*>', '\n', raw, flags=re.IGNORECASE)
        raw = re.sub(r'<br[^>]*>', '\n', raw, flags=re.IGNORECASE)

        # Strip remaining tags
        text = re.sub(r'<[^>]+>', '', raw)

        # Decode HTML entities
        entities = {
            '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
            '&#39;': "'", '&nbsp;': ' ', '&ndash;': '-', '&mdash;': '—',
            '&rsquo;': "'", '&lsquo;': "'", '&rdquo;': '"', '&ldquo;': '"',
        }
        for ent, char in entities.items():
            text = text.replace(ent, char)
        text = re.sub(r'&#\d+;', '', text)
        text = re.sub(r'&\w+;', ' ', text)

        # Collapse whitespace while preserving paragraph breaks
        text = re.sub(r'[ \t]+', ' ', text)
        text = re.sub(r'\n{3,}', '\n\n', text)
        text = text.strip()

        # Remove lines that are pure noise (single chars, cookie notices, etc.)
        lines = [l.strip() for l in text.split('\n') if len(l.strip()) > 2]
        text = '\n'.join(lines)

        return {"success": True, "url": url, "content": text[:12000]}
    except urllib.error.HTTPError as exc:
        return {"error": f"HTTP {exc.code}: {exc.reason}", "url": url}
    except Exception as exc:
        return {"error": str(exc), "url": url}


def _read_file(path: str) -> Dict[str, Any]:
    """Read a file from the filesystem."""
    try:
        expanded = os.path.expanduser(path)
        with open(expanded, "r", encoding="utf-8", errors="replace") as f:
            content = f.read(20000)
        return {"success": True, "path": path, "content": content}
    except Exception as exc:
        return {"error": str(exc)}


def _write_file(path: str, content: str) -> Dict[str, Any]:
    """
    Create or overwrite a file.

    On the backend server this is stubbed — writing arbitrary files on a shared
    host creates data-integrity and path-traversal risks.  The Electron desktop
    app intercepts this tool call via IPC and writes the file on the user's own
    Mac instead.  When NOAH_DESKTOP_LOCAL=1 the file is written directly.
    """
    if not os.environ.get("NOAH_DESKTOP_LOCAL"):
        return {
            "note": (
                "write_file is executed by the Noah desktop app on your Mac. "
                "The write has been queued; ensure the desktop app is running. "
                f"path={path!r} bytes={len(content)}"
            ),
            "desktop_proxy": True,
            "path": path,
        }
    try:
        expanded = os.path.expanduser(path)
        parent = os.path.dirname(expanded)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(expanded, "w", encoding="utf-8") as f:
            f.write(content)
        return {"success": True, "path": path, "bytes_written": len(content)}
    except Exception as exc:
        return {"error": str(exc)}


def _list_directory(path: str) -> Dict[str, Any]:
    """List files in a directory."""
    try:
        expanded = os.path.expanduser(path)
        items = os.listdir(expanded)
        return {"success": True, "path": path, "items": sorted(items)[:300]}
    except Exception as exc:
        return {"error": str(exc)}


def _show_notification(title: str, body: str) -> Dict[str, Any]:
    """Show a system notification (macOS only)."""
    if not _IS_MACOS:
        return {
            "error": (
                "show_notification requires the Noah desktop app to be running on your Mac. "
                "Please open the Noah desktop app so this tool can display notifications."
            ),
            "desktop_proxy_required": True,
            "title": title,
            "body": body,
        }
    script = f'display notification "{body}" with title "{title}"'
    return _run_applescript(script, reason="show_notification")


def _open_url(url: str, reason: str = "") -> Dict[str, Any]:
    """Open a URL in the default browser (macOS only)."""
    if not _IS_MACOS:
        return {
            "error": (
                "open_url requires the Noah desktop app to be running on your Mac. "
                "Please open the Noah desktop app so this tool can open URLs in your browser."
            ),
            "desktop_proxy_required": True,
            "url": url,
        }
    result = _run_shell(f'open "{url}"', reason=reason)
    return {"success": result.get("success", False), "url": url}


def _open_path(path: str, reason: str = "") -> Dict[str, Any]:
    """Open a file or application on macOS (macOS only)."""
    if not _IS_MACOS:
        return {
            "error": (
                "open_path requires the Noah desktop app to be running on your Mac. "
                "Please open the Noah desktop app so this tool can open files."
            ),
            "desktop_proxy_required": True,
            "path": path,
        }
    result = _run_shell(f'open "{path}"', reason=reason)
    return {"success": result.get("success", False), "path": path}


def _api_call(method: str, url: str, headers: dict = None, body: dict = None, reason: str = "") -> Dict[str, Any]:
    """Make an authenticated HTTP API call to external APIs.

    SSRF protection: blocks requests to loopback, link-local, and private RFC-1918 ranges
    to prevent backend-assisted server-side request forgery.
    """
    import ipaddress
    import socket as _socket
    try:
        parsed = urllib.parse.urlparse(url)
        hostname = parsed.hostname or ""
        _BLOCKED_NAMES = {"localhost", "::1", "0.0.0.0"}
        if hostname.lower() in _BLOCKED_NAMES:
            return {"error": "SSRF protection: requests to loopback addresses are not allowed."}
        try:
            addr = ipaddress.ip_address(_socket.gethostbyname(hostname))
            if addr.is_loopback or addr.is_private or addr.is_link_local or addr.is_reserved:
                return {"error": f"SSRF protection: requests to private/internal IPs are not allowed ({addr})."}
        except Exception:
            pass

        data = json.dumps(body).encode("utf-8") if body else None
        req = urllib.request.Request(url, data=data, method=method.upper())
        req.add_header("Content-Type", "application/json")
        for k, v in (headers or {}).items():
            req.add_header(str(k), str(v))
        with urllib.request.urlopen(req, timeout=20) as resp:
            body_raw = resp.read(32000).decode("utf-8", errors="replace")
            return {"success": True, "status": resp.status, "body": body_raw}
    except urllib.error.HTTPError as exc:
        body_err = exc.read(4000).decode("utf-8", errors="replace")
        return {"error": f"HTTP {exc.code}: {exc.reason}", "body": body_err}
    except Exception as exc:
        return {"error": str(exc)}


# ── Memory tools ─────────────────────────────────────────────────────────────

def _make_save_memory_handler(uid: str):
    """
    Return a save_memory handler bound to a specific user UID.
    Bridges to Noah's existing Firestore memory storage system.
    """
    def _save_memory(fact: str = None, content: str = None, category: str = "interesting") -> Dict[str, Any]:
        """Save a memory fact to Noah's persistent Firestore memory store."""
        text = fact or content
        if not text:
            return {"error": "save_memory requires either 'fact' or 'content' parameter."}
        try:
            import database.memories as memories_db
            from models.memories import Memory, MemoryCategory, MemoryDB

            cat_value = category.lower() if isinstance(category, str) else "interesting"
            try:
                cat_enum = MemoryCategory(cat_value)
            except ValueError:
                cat_enum = MemoryCategory.interesting

            memory = Memory(content=text, category=cat_enum)
            memory_db = MemoryDB.from_memory(memory, uid, None, True)
            memories_db.create_memory(uid, memory_db.dict())
            logger.info("Hermes saved memory uid=%s id=%s", uid, memory_db.id)
            return {"success": True, "id": memory_db.id, "fact": text, "category": cat_enum.value}
        except Exception as exc:
            logger.error("save_memory failed uid=%s: %s", uid, exc)
            return {"error": str(exc)}
    return _save_memory


def _make_get_memories_handler(uid: str):
    """Return a get_memories handler that reads the user's Firestore memories."""
    def _get_memories(category: str = None, limit: int = 50) -> Dict[str, Any]:
        """Retrieve stored memories for this user from Firestore."""
        try:
            import database.memories as memories_db

            cats = [category] if category else []
            memories = memories_db.get_memories(uid, limit=limit, categories=cats)
            if not memories:
                return {"success": True, "count": 0, "memories": [], "text": "No memories stored yet."}

            items = []
            for m in memories:
                items.append({
                    "id": m.get("id", ""),
                    "category": m.get("category", ""),
                    "content": m.get("content", ""),
                    "created_at": str(m.get("created_at", "")),
                })

            text = "\n".join(f"[{m['category']}] {m['content']}" for m in items)
            return {"success": True, "count": len(items), "memories": items, "text": text}
        except Exception as exc:
            logger.error("get_memories failed uid=%s: %s", uid, exc)
            return {"error": str(exc)}
    return _get_memories


# ── Skills / Soul system ──────────────────────────────────────────────────────
#
# Skills are plain-text files stored in a per-user directory on the server.
# Each skill is a named procedure, fact, or piece of knowledge Noah can
# save and recall — forming its persistent "soul" that improves over time.

def _get_skills_dir(uid: Optional[str] = None) -> Path:
    """Return the skills directory for a user, creating it if needed."""
    base = _BACKEND_DIR / "data" / "skills"
    if uid:
        skills_dir = base / uid
    else:
        skills_dir = base / "shared"
    skills_dir.mkdir(parents=True, exist_ok=True)
    return skills_dir


def _make_list_skills_handler(uid: Optional[str] = None):
    def _list_skills() -> Dict[str, Any]:
        """List all saved skills (procedures/knowledge files)."""
        try:
            skills_dir = _get_skills_dir(uid)
            shared_dir = _get_skills_dir(None)
            files = []
            for d in [skills_dir, shared_dir]:
                for f in sorted(d.glob("*.md")):
                    if f not in files:
                        rel = f.stem
                        first_line = f.read_text(encoding="utf-8").strip().split("\n")[0]
                        files.append({"name": rel, "summary": first_line[:120]})
            if not files:
                return {"success": True, "count": 0, "skills": [], "text": "No skills saved yet. Use save_skill to teach Noah new procedures or knowledge."}
            text = "\n".join(f"- {s['name']}: {s['summary']}" for s in files)
            return {"success": True, "count": len(files), "skills": files, "text": text}
        except Exception as exc:
            return {"error": str(exc)}
    return _list_skills


def _make_view_skill_handler(uid: Optional[str] = None):
    def _view_skill(name: str) -> Dict[str, Any]:
        """Read the full content of a saved skill."""
        try:
            skills_dir = _get_skills_dir(uid)
            shared_dir = _get_skills_dir(None)
            slug = re.sub(r'[^\w\-]', '_', name.strip().lower())
            for d in [skills_dir, shared_dir]:
                path = d / f"{slug}.md"
                if path.exists():
                    content = path.read_text(encoding="utf-8")
                    return {"success": True, "name": name, "content": content}
            return {"error": f"Skill '{name}' not found. Use list_skills to see available skills."}
        except Exception as exc:
            return {"error": str(exc)}
    return _view_skill


def _make_save_skill_handler(uid: Optional[str] = None):
    def _save_skill(name: str, content: str, shared: bool = False) -> Dict[str, Any]:
        """Save or update a skill (procedure/knowledge) for future recall.

        Use this to build Noah's soul: save how to do things, facts about the user's
        environment, custom workflows, personal preferences, or anything worth remembering
        as a procedure rather than a memory fact.
        """
        try:
            target_dir = _get_skills_dir(None if shared else uid)
            slug = re.sub(r'[^\w\-]', '_', name.strip().lower())
            path = target_dir / f"{slug}.md"
            path.write_text(content, encoding="utf-8")
            logger.info("Hermes saved skill uid=%s name=%s path=%s", uid, name, path)
            return {"success": True, "name": name, "path": str(path), "bytes": len(content)}
        except Exception as exc:
            logger.error("save_skill failed uid=%s: %s", uid, exc)
            return {"error": str(exc)}
    return _save_skill


# ── Session history search ────────────────────────────────────────────────────

def _make_search_history_handler(session_db):
    def _search_history(query: str, limit: int = 5) -> Dict[str, Any]:
        """Search past conversation history using full-text search."""
        try:
            if session_db is None:
                return {"error": "Session database not available."}
            results = session_db.search_messages(query, limit=limit)
            if not results:
                return {"success": True, "count": 0, "results": [], "text": "No matching conversations found."}
            text = "\n\n".join(
                f"[{r.get('created_at', '')[:16]}] {r.get('role', '').upper()}: {str(r.get('content', ''))[:300]}"
                for r in results
            )
            return {"success": True, "count": len(results), "results": results, "text": text}
        except Exception as exc:
            return {"error": str(exc)}
    return _search_history


# ── Schemas (OpenAI function-calling format) ─────────────────────────────────

TOOL_SCHEMAS: Dict[str, dict] = {
    "terminal": {"type": "function", "function": {
        "name": "terminal",
        "description": "Run any bash/shell command on the user's Mac. Useful for calculations, file operations, network requests, running scripts, and anything a terminal can do.",
        "parameters": {"type": "object", "properties": {
            "command": {"type": "string", "description": "Full bash command to execute"},
            "reason":  {"type": "string", "description": "Brief description of why"},
        }, "required": ["command", "reason"]},
    }},
    "run_applescript": {"type": "function", "function": {
        "name": "run_applescript",
        "description": "Run AppleScript to control macOS apps: Mail, Safari, Calendar, Spotify, Reminders, Notes, Finder. macOS only.",
        "parameters": {"type": "object", "properties": {
            "script": {"type": "string", "description": "Valid AppleScript code"},
            "reason": {"type": "string", "description": "Brief label"},
        }, "required": ["script", "reason"]},
    }},
    "search_web": {"type": "function", "function": {
        "name": "search_web",
        "description": "Search the internet. Returns real clickable URLs with titles and snippets. Always search before stating any real-world fact, price, or current event. Then call fetch_webpage on the best URL to get full details.",
        "parameters": {"type": "object", "properties": {
            "query":  {"type": "string", "description": "Search query — be specific for best results"},
            "reason": {"type": "string", "description": "Why you are searching"},
        }, "required": ["query", "reason"]},
    }},
    "fetch_webpage": {"type": "function", "function": {
        "name": "fetch_webpage",
        "description": "Fetch and read the full text content of any URL. Use after search_web to get actual prices, details, or data from specific pages.",
        "parameters": {"type": "object", "properties": {
            "url":    {"type": "string", "description": "Full https:// URL to fetch"},
            "reason": {"type": "string", "description": "What you are looking for on this page"},
        }, "required": ["url", "reason"]},
    }},
    "read_file": {"type": "function", "function": {
        "name": "read_file",
        "description": "Read a file from the filesystem.",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string", "description": "Absolute or ~ path to file"},
        }, "required": ["path"]},
    }},
    "write_file": {"type": "function", "function": {
        "name": "write_file",
        "description": "Create or overwrite a file with given content.",
        "parameters": {"type": "object", "properties": {
            "path":    {"type": "string"},
            "content": {"type": "string"},
        }, "required": ["path", "content"]},
    }},
    "list_directory": {"type": "function", "function": {
        "name": "list_directory",
        "description": "List files in a directory.",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string"},
        }, "required": ["path"]},
    }},
    "show_notification": {"type": "function", "function": {
        "name": "show_notification",
        "description": "Show a system notification to the user on macOS.",
        "parameters": {"type": "object", "properties": {
            "title": {"type": "string"},
            "body":  {"type": "string"},
        }, "required": ["title", "body"]},
    }},
    "open_url": {"type": "function", "function": {
        "name": "open_url",
        "description": "Open a URL in the default browser so the user can view/interact with it. macOS desktop only.",
        "parameters": {"type": "object", "properties": {
            "url":    {"type": "string"},
            "reason": {"type": "string"},
        }, "required": ["url", "reason"]},
    }},
    "open_path": {"type": "function", "function": {
        "name": "open_path",
        "description": "Open a file or application on macOS.",
        "parameters": {"type": "object", "properties": {
            "path":   {"type": "string"},
            "reason": {"type": "string"},
        }, "required": ["path", "reason"]},
    }},
    "api_call": {"type": "function", "function": {
        "name": "api_call",
        "description": "Make any authenticated HTTP API call (GitHub, Slack, Notion, Google APIs, weather APIs, etc).",
        "parameters": {"type": "object", "properties": {
            "method":  {"type": "string", "enum": ["GET","POST","PUT","PATCH","DELETE"]},
            "url":     {"type": "string"},
            "headers": {"type": "object", "description": "HTTP headers dict"},
            "body":    {"type": "object", "description": "Request body (JSON)"},
            "reason":  {"type": "string"},
        }, "required": ["method", "url", "reason"]},
    }},
    "save_memory": {"type": "function", "function": {
        "name": "save_memory",
        "description": (
            "Persist an important fact, preference, or observation about the user "
            "into Noah's long-term memory store. Use whenever the user shares something "
            "they'd want Noah to remember in future conversations. "
            "Call this FIRST before answering, whenever the user shares personal info."
        ),
        "parameters": {"type": "object", "properties": {
            "fact": {"type": "string", "description": "One clear fact to save (1-3 concise sentences)."},
            "category": {
                "type": "string",
                "enum": [
                    "interesting", "system", "integration", "knowledge",
                    "reminder", "hobby", "goal", "preference", "contact", "other"
                ],
                "description": "Category that best describes this memory",
            },
        }, "required": ["fact"]},
    }},
    "get_memories": {"type": "function", "function": {
        "name": "get_memories",
        "description": (
            "Retrieve stored memories about the user from long-term memory. "
            "Call this at the start of any conversation where you need context about the user, "
            "or when the user asks 'do you remember...?' or references past information."
        ),
        "parameters": {"type": "object", "properties": {
            "category": {
                "type": "string",
                "enum": [
                    "interesting", "system", "integration", "knowledge",
                    "reminder", "hobby", "goal", "preference", "contact", "other"
                ],
                "description": "Filter by category (omit to get all memories)",
            },
            "limit": {"type": "integer", "description": "Max memories to return (default 50)", "default": 50},
        }, "required": []},
    }},
    "list_skills": {"type": "function", "function": {
        "name": "list_skills",
        "description": (
            "List all saved skills — procedures, workflows, and knowledge Noah has learned. "
            "Skills are how Noah builds its soul and self-improves. Call this when you need "
            "to recall how to do something, or to see what you already know."
        ),
        "parameters": {"type": "object", "properties": {}, "required": []},
    }},
    "view_skill": {"type": "function", "function": {
        "name": "view_skill",
        "description": "Read the full content of a saved skill by name.",
        "parameters": {"type": "object", "properties": {
            "name": {"type": "string", "description": "Name of the skill to read (from list_skills)"},
        }, "required": ["name"]},
    }},
    "save_skill": {"type": "function", "function": {
        "name": "save_skill",
        "description": (
            "Save a new skill or update an existing one. A skill is a named procedure, "
            "workflow, fact set, or piece of knowledge that Noah should remember and reuse. "
            "Use this to self-improve: when you figure out how to do something well, save it as a skill. "
            "When you learn how the user prefers things done, save it. "
            "This builds Noah's soul over time."
        ),
        "parameters": {"type": "object", "properties": {
            "name":    {"type": "string", "description": "Short descriptive name for the skill (e.g. 'find_cheap_flights', 'user_morning_routine')"},
            "content": {"type": "string", "description": "Full skill content in markdown — include the procedure, context, examples, and any important notes"},
            "shared":  {"type": "boolean", "description": "True if this skill should be shared across all users (default false = user-specific)", "default": False},
        }, "required": ["name", "content"]},
    }},
    "search_history": {"type": "function", "function": {
        "name": "search_history",
        "description": (
            "Search past conversation history using full-text search. "
            "Use when the user references something from a past session, or to recall context."
        ),
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string", "description": "What to search for in past conversations"},
            "limit": {"type": "integer", "description": "Max results (default 5)", "default": 5},
        }, "required": ["query"]},
    }},
}


# Mapping: tool name → handler function.
# save_memory, get_memories, list_skills, view_skill, save_skill, search_history
# are registered separately in register_noah_tools() because they require
# per-user uid/session_db closures.
TOOL_FUNCTIONS = {
    "terminal":          _run_shell,
    "run_applescript":   _run_applescript,
    "search_web":        _search_web,
    "fetch_webpage":     _fetch_webpage,
    "read_file":         _read_file,
    "write_file":        _write_file,
    "list_directory":    _list_directory,
    "show_notification": _show_notification,
    "open_url":          _open_url,
    "open_path":         _open_path,
    "api_call":          _api_call,
}


def register_noah_tools(agent, uid: str = None, session_db=None) -> None:
    """
    Register all Noah tools onto the given AIAgent instance.
    Mirrors the Hermes pattern of auto-registering tools at startup.

    If uid is provided, registers user-specific tools:
      - save_memory / get_memories (Firestore-backed)
      - list_skills / view_skill / save_skill (skills/soul system)
      - search_history (SQLite FTS5 session search)
    """
    for name, func in TOOL_FUNCTIONS.items():
        agent.register_tool(name, func, TOOL_SCHEMAS[name])

    if uid:
        agent.register_tool("save_memory",  _make_save_memory_handler(uid),  TOOL_SCHEMAS["save_memory"])
        agent.register_tool("get_memories", _make_get_memories_handler(uid),  TOOL_SCHEMAS["get_memories"])
        agent.register_tool("list_skills",  _make_list_skills_handler(uid),   TOOL_SCHEMAS["list_skills"])
        agent.register_tool("view_skill",   _make_view_skill_handler(uid),    TOOL_SCHEMAS["view_skill"])
        agent.register_tool("save_skill",   _make_save_skill_handler(uid),    TOOL_SCHEMAS["save_skill"])
        logger.debug("Registered user tools for uid=%s", uid)

    # session_db may come from the agent itself if not passed explicitly
    db = session_db or getattr(agent, "session_db", None)
    if db:
        agent.register_tool("search_history", _make_search_history_handler(db), TOOL_SCHEMAS["search_history"])
        logger.debug("Registered search_history tool")
