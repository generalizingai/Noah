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
import shlex
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_IS_MACOS = platform.system() == "Darwin"

_BACKEND_DIR = Path(__file__).parent.parent
_todo_lock = threading.Lock()
_todo_store: Dict[str, List[Dict[str, Any]]] = {}
_cron_lock = threading.Lock()
_cron_store: Dict[str, List[Dict[str, Any]]] = {}


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
                "If this did not run, the realtime desktop channel may be disconnected. "
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


def _higgsfield_generate(
    model: str,
    prompt: str,
    wait: bool = True,
    output_json: bool = True,
    extra_flags: Optional[List[str]] = None,
    reason: str = "",
) -> Dict[str, Any]:
    """
    Generate content through Higgsfield CLI with a structured command.

    This provides a safer and automation-friendly wrapper than free-form shell.
    """
    base_cmd = ["higgsfield", "generate", "create", model, "--prompt", prompt]
    if wait:
        base_cmd.append("--wait")
    if output_json:
        base_cmd.append("--json")
    for flag in (extra_flags or []):
        if not isinstance(flag, str) or not flag.strip():
            continue
        base_cmd.extend(shlex.split(flag))

    # On remote/shared backend, return a proxy instruction for desktop runtime.
    if not os.environ.get("NOAH_DESKTOP_LOCAL"):
        return {
            "note": (
                "higgsfield_generate is executed by the Noah desktop app on your Mac. "
                "Ensure Higgsfield CLI is installed and authenticated there."
            ),
            "desktop_proxy": True,
            "command": " ".join(shlex.quote(part) for part in base_cmd),
            "install_hint": "npm install -g @higgsfield/cli",
            "auth_hint": "higgsfield auth login",
        }

    try:
        check = subprocess.run(
            ["higgsfield", "version"],
            capture_output=True,
            text=True,
            timeout=10,
            env={**os.environ},
        )
        if check.returncode != 0:
            return {
                "error": "Higgsfield CLI appears unavailable on this machine.",
                "install_hint": "npm install -g @higgsfield/cli",
                "auth_hint": "higgsfield auth login",
                "stderr": (check.stderr or "")[:800],
            }

        result = subprocess.run(
            base_cmd,
            capture_output=True,
            text=True,
            timeout=1800,
            env={**os.environ},
        )
        payload: Dict[str, Any] = {
            "success": result.returncode == 0,
            "command": " ".join(shlex.quote(part) for part in base_cmd),
            "stdout": result.stdout[:16000],
            "stderr": result.stderr[:4000],
            "returncode": result.returncode,
        }
        if not payload["success"] and (
            "auth" in (result.stderr or "").lower() or "login" in (result.stderr or "").lower()
        ):
            payload["auth_hint"] = "higgsfield auth login"
        return payload
    except subprocess.TimeoutExpired:
        return {"error": "Higgsfield generation timed out after 30 minutes."}
    except Exception as exc:
        return {"error": str(exc)}


def _heygen_generate(
    prompt: str,
    wait: bool = True,
    timeout: str = "20m",
    reason: str = "",
) -> Dict[str, Any]:
    """
    Generate a video through HeyGen CLI (video-agent path).
    """
    base_cmd = ["heygen", "video-agent", "create", "--prompt", prompt]
    if wait:
        base_cmd.extend(["--wait", "--timeout", timeout])

    if not os.environ.get("NOAH_DESKTOP_LOCAL"):
        return {
            "note": (
                "heygen_generate is executed by the Noah desktop app on your Mac. "
                "Ensure HeyGen CLI is installed and authenticated there."
            ),
            "desktop_proxy": True,
            "command": " ".join(shlex.quote(part) for part in base_cmd),
            "install_hint": "curl -fsSL https://static.heygen.ai/cli/install.sh | bash",
            "auth_hint": "heygen auth login",
        }

    try:
        check = subprocess.run(
            ["heygen", "--version"],
            capture_output=True,
            text=True,
            timeout=10,
            env={**os.environ},
        )
        if check.returncode != 0:
            return {
                "error": "HeyGen CLI appears unavailable on this machine.",
                "install_hint": "curl -fsSL https://static.heygen.ai/cli/install.sh | bash",
                "auth_hint": "heygen auth login",
                "stderr": (check.stderr or "")[:800],
            }

        result = subprocess.run(
            base_cmd,
            capture_output=True,
            text=True,
            timeout=1800,
            env={**os.environ},
        )
        payload: Dict[str, Any] = {
            "success": result.returncode == 0,
            "command": " ".join(shlex.quote(part) for part in base_cmd),
            "stdout": result.stdout[:16000],
            "stderr": result.stderr[:4000],
            "returncode": result.returncode,
        }
        if not payload["success"] and (
            "auth" in (result.stderr or "").lower() or "login" in (result.stderr or "").lower()
        ):
            payload["auth_hint"] = "heygen auth login"
        return payload
    except subprocess.TimeoutExpired:
        return {"error": "HeyGen generation timed out after 30 minutes."}
    except Exception as exc:
        return {"error": str(exc)}


def _run_applescript(script: str, reason: str = "") -> Dict[str, Any]:
    """Execute AppleScript on macOS."""
    if not _IS_MACOS:
        return {
            "error": (
                "AppleScript executes through Noah desktop on your Mac. "
                "If Noah is already open, reconnect Hermes so the realtime desktop channel is active."
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
                "show_notification executes through Noah desktop on your Mac. "
                "If Noah is already open, reconnect Hermes so the realtime desktop channel is active."
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
                "open_url executes through Noah desktop on your Mac. "
                "If Noah is already open, reconnect Hermes so the realtime desktop channel is active."
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
                "open_path executes through Noah desktop on your Mac. "
                "If Noah is already open, reconnect Hermes so the realtime desktop channel is active."
            ),
            "desktop_proxy_required": True,
            "path": path,
        }
    result = _run_shell(f'open "{path}"', reason=reason)
    return {"success": result.get("success", False), "path": path}

def _computer_open_application(app_name: str, reason: str = "") -> Dict[str, Any]:
    """Open and focus a desktop application by name (desktop-proxied by default)."""
    if not os.environ.get("NOAH_DESKTOP_LOCAL"):
        return {
            "note": (
                "computer_open_application is executed by the Noah desktop app on your Mac. "
                f"app_name={app_name!r}"
            ),
            "desktop_proxy": True,
            "app_name": app_name,
        }
    if not _IS_MACOS:
        return {"error": "computer_open_application local execution is currently implemented for macOS only."}
    result = _run_shell(f'open -a "{app_name}"', reason=reason)
    return {"success": bool(result.get("success")), "app_name": app_name, "raw": result}


def _computer_click(x: int, y: int, button: str = "left", click_count: int = 1, reason: str = "") -> Dict[str, Any]:
    """Click at absolute screen coordinates (desktop-proxied by default)."""
    if not os.environ.get("NOAH_DESKTOP_LOCAL"):
        return {
            "note": "computer_click is executed by the Noah desktop app on your Mac.",
            "desktop_proxy": True,
            "x": x,
            "y": y,
            "button": button,
            "click_count": click_count,
        }
    return {"error": "computer_click should be proxied to desktop runtime."}


def _computer_type(text: str, submit: bool = False, reason: str = "") -> Dict[str, Any]:
    """Type text into the currently focused control (desktop-proxied by default)."""
    if not os.environ.get("NOAH_DESKTOP_LOCAL"):
        return {
            "note": "computer_type is executed by the Noah desktop app on your Mac.",
            "desktop_proxy": True,
            "chars": len(text or ""),
            "submit": bool(submit),
        }
    return {"error": "computer_type should be proxied to desktop runtime."}


def _computer_hotkey(keys: List[str], reason: str = "") -> Dict[str, Any]:
    """Press a key combination like command+n or command+shift+p (desktop-proxied)."""
    if not os.environ.get("NOAH_DESKTOP_LOCAL"):
        return {
            "note": "computer_hotkey is executed by the Noah desktop app on your Mac.",
            "desktop_proxy": True,
            "keys": keys,
        }
    return {"error": "computer_hotkey should be proxied to desktop runtime."}


def _computer_wait_for_app(app_name: str, timeout_sec: int = 10, reason: str = "") -> Dict[str, Any]:
    """Wait until an app process is running (desktop-proxied)."""
    if not os.environ.get("NOAH_DESKTOP_LOCAL"):
        return {
            "note": "computer_wait_for_app is executed by the Noah desktop app on your Mac.",
            "desktop_proxy": True,
            "app_name": app_name,
            "timeout_sec": timeout_sec,
        }
    return {"error": "computer_wait_for_app should be proxied to desktop runtime."}


def _computer_claude_create_thread(prompt: str, submit: bool = True, reason: str = "") -> Dict[str, Any]:
    """Open Claude app and create a new thread with a prompt (desktop-proxied)."""
    if not os.environ.get("NOAH_DESKTOP_LOCAL"):
        return {
            "note": "computer_claude_create_thread is executed by the Noah desktop app on your Mac.",
            "desktop_proxy": True,
            "submit": bool(submit),
            "prompt_chars": len(prompt or ""),
        }
    return {"error": "computer_claude_create_thread should be proxied to desktop runtime."}


def _computer_observe(reason: str = "", include_ui_tree: bool = False) -> Dict[str, Any]:
    """Capture current frontmost app/window context (desktop-proxied)."""
    if not os.environ.get("NOAH_DESKTOP_LOCAL"):
        return {
            "note": "computer_observe is executed by the Noah desktop app on your Mac.",
            "desktop_proxy": True,
            "include_ui_tree": bool(include_ui_tree),
        }
    return {"error": "computer_observe should be proxied to desktop runtime."}


def _computer_click_text(text: str, exact: bool = False, timeout_sec: int = 8, reason: str = "") -> Dict[str, Any]:
    """Click a visible UI element by text/label match (desktop-proxied)."""
    if not os.environ.get("NOAH_DESKTOP_LOCAL"):
        return {
            "note": "computer_click_text is executed by the Noah desktop app on your Mac.",
            "desktop_proxy": True,
            "text": text,
            "exact": bool(exact),
            "timeout_sec": timeout_sec,
        }
    return {"error": "computer_click_text should be proxied to desktop runtime."}


def _computer_type_in_field(field_hint: str, text: str, submit: bool = False, reason: str = "") -> Dict[str, Any]:
    """Focus a field by label/hint then type text (desktop-proxied)."""
    if not os.environ.get("NOAH_DESKTOP_LOCAL"):
        return {
            "note": "computer_type_in_field is executed by the Noah desktop app on your Mac.",
            "desktop_proxy": True,
            "field_hint": field_hint,
            "submit": bool(submit),
            "chars": len(text or ""),
        }
    return {"error": "computer_type_in_field should be proxied to desktop runtime."}


def _computer_verify_text(text: str, exact: bool = False, reason: str = "") -> Dict[str, Any]:
    """Verify whether a text is visible in the current frontmost window (desktop-proxied)."""
    if not os.environ.get("NOAH_DESKTOP_LOCAL"):
        return {
            "note": "computer_verify_text is executed by the Noah desktop app on your Mac.",
            "desktop_proxy": True,
            "text": text,
            "exact": bool(exact),
        }
    return {"error": "computer_verify_text should be proxied to desktop runtime."}

def _computer_vscode_open_project(project_path: str, reason: str = "") -> Dict[str, Any]:
    """Open a folder/workspace in VS Code (desktop-proxied)."""
    if not os.environ.get("NOAH_DESKTOP_LOCAL"):
        return {
            "note": "computer_vscode_open_project is executed by the Noah desktop app on your Mac.",
            "desktop_proxy": True,
            "project_path": project_path,
        }
    return {"error": "computer_vscode_open_project should be proxied to desktop runtime."}


def _computer_vscode_open_file(file_path: str, line: int = 1, reason: str = "") -> Dict[str, Any]:
    """Open a specific file in VS Code, optionally at a line (desktop-proxied)."""
    if not os.environ.get("NOAH_DESKTOP_LOCAL"):
        return {
            "note": "computer_vscode_open_file is executed by the Noah desktop app on your Mac.",
            "desktop_proxy": True,
            "file_path": file_path,
            "line": int(line or 1),
        }
    return {"error": "computer_vscode_open_file should be proxied to desktop runtime."}


def _computer_vscode_run_task(command: str, cwd: str = "", reason: str = "") -> Dict[str, Any]:
    """Run a shell task for coding workflows and return output (desktop-proxied)."""
    if not os.environ.get("NOAH_DESKTOP_LOCAL"):
        return {
            "note": "computer_vscode_run_task is executed by the Noah desktop app on your Mac.",
            "desktop_proxy": True,
            "command": command,
            "cwd": cwd or "",
        }
    return {"error": "computer_vscode_run_task should be proxied to desktop runtime."}


def _browser_playwright_script(
    start_url: str = "",
    script: str = "",
    headless: bool = True,
    timeout_sec: int = 30,
    reason: str = "",
) -> Dict[str, Any]:
    """Run a Playwright script snippet on the desktop runtime."""
    if not os.environ.get("NOAH_DESKTOP_LOCAL"):
        return {
            "note": "browser_playwright_script is executed by the Noah desktop app on your Mac.",
            "desktop_proxy": True,
            "start_url": start_url or "",
            "headless": bool(headless),
            "timeout_sec": int(timeout_sec or 30),
            "script_chars": len(script or ""),
        }
    return {"error": "browser_playwright_script should be proxied to desktop runtime."}


def _browser_alias_tool(reason: str = "", **kwargs) -> Dict[str, Any]:
    """
    Upstream Hermes browser_* compatibility shim.
    In NOAH, browser operations are executed via desktop Playwright bridge.
    """
    return {
        "note": (
            "browser_* alias tool requested. Noah routes browser actions through "
            "browser_playwright_script on the desktop runtime."
        ),
        "desktop_proxy": True,
        "alias": True,
        "args": kwargs,
    }

def _cloud_codespaces_list(owner: str, repo: str, reason: str = "") -> Dict[str, Any]:
    """List GitHub Codespaces for a repository (desktop-proxied)."""
    if not os.environ.get("NOAH_DESKTOP_LOCAL"):
        return {
            "note": "cloud_codespaces_list is executed by the Noah desktop app on your Mac.",
            "desktop_proxy": True,
            "owner": owner,
            "repo": repo,
        }
    return {"error": "cloud_codespaces_list should be proxied to desktop runtime."}


def _cloud_codespace_create(owner: str, repo: str, branch: str = "", machine: str = "", reason: str = "") -> Dict[str, Any]:
    """Create a GitHub Codespace for a repository (desktop-proxied)."""
    if not os.environ.get("NOAH_DESKTOP_LOCAL"):
        return {
            "note": "cloud_codespace_create is executed by the Noah desktop app on your Mac.",
            "desktop_proxy": True,
            "owner": owner,
            "repo": repo,
            "branch": branch or "",
            "machine": machine or "",
        }
    return {"error": "cloud_codespace_create should be proxied to desktop runtime."}


def _cloud_codespace_open(codespace_name: str, reason: str = "") -> Dict[str, Any]:
    """Open an existing Codespace in the browser (desktop-proxied)."""
    if not os.environ.get("NOAH_DESKTOP_LOCAL"):
        return {
            "note": "cloud_codespace_open is executed by the Noah desktop app on your Mac.",
            "desktop_proxy": True,
            "codespace_name": codespace_name,
        }
    return {"error": "cloud_codespace_open should be proxied to desktop runtime."}


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


def _delegate_task(
    role: str,
    objective: str,
    constraints: Optional[List[str]] = None,
    output_format: str = "summary",
) -> Dict[str, Any]:
    """Create a virtual specialist delegation plan (phase A)."""
    normalized = (role or "").strip().lower()
    allowed = {"seo", "content", "coding", "research", "ops"}
    if normalized not in allowed:
        return {"error": f"Unknown specialist role '{role}'. Use one of: seo, content, coding, research, ops."}
    constraints = [str(c) for c in (constraints or []) if str(c).strip()]
    return {
        "success": True,
        "plane": "server",
        "role": normalized,
        "objective": objective,
        "constraints": constraints,
        "output_format": output_format or "summary",
        "note": (
            f"Delegation planned for {normalized} specialist. "
            "Proceed with task execution and return merged output with provenance."
        ),
        "provenance": [{
            "role": normalized,
            "status": "planned",
            "objective": objective,
            "constraints": constraints,
        }],
    }


def _process(command: str, reason: str = "") -> Dict[str, Any]:
    """Hermes parity alias for terminal/process execution."""
    return _run_shell(command=command, reason=reason)


def _search_files(pattern: str, path: str = ".", reason: str = "") -> Dict[str, Any]:
    """Search file content using ripgrep for Hermes parity."""
    try:
        expanded = os.path.expanduser(path or ".")
        cmd = f"rg -n --hidden --glob '!.git' {shlex.quote(pattern)} {shlex.quote(expanded)}"
        result = _run_shell(cmd, reason=reason)
        return {
            "success": bool(result.get("success")),
            "pattern": pattern,
            "path": path,
            "matches": (result.get("stdout") or "")[:20000],
            "stderr": (result.get("stderr") or "")[:4000],
        }
    except Exception as exc:
        return {"error": str(exc)}


def _patch(path: str, find: str, replace: str, reason: str = "") -> Dict[str, Any]:
    """Simple text patch compatibility: exact substring replacement."""
    try:
        expanded = os.path.expanduser(path)
        if not os.path.exists(expanded):
            return {"error": f"File not found: {path}"}
        raw = Path(expanded).read_text(encoding="utf-8", errors="replace")
        if find not in raw:
            return {"error": "Patch target text not found."}
        updated = raw.replace(find, replace)
        Path(expanded).write_text(updated, encoding="utf-8")
        return {"success": True, "path": path, "replaced": raw.count(find)}
    except Exception as exc:
        return {"error": str(exc)}


def _make_todo_handler(uid: str):
    def _todo(action: str = "list", item: str = "", item_id: str = "", done: bool = False, reason: str = "") -> Dict[str, Any]:
        """Persistent TODO list per user."""
        key = uid or "anon"
        act = (action or "list").strip().lower()
        with _todo_lock:
            bucket = _todo_store.setdefault(key, [])
            if act in {"add", "create"}:
                text = (item or "").strip()
                if not text:
                    return {"error": "todo add requires item text"}
                row = {"id": str(uuid.uuid4()), "text": text, "done": False, "created_at": int(time.time() * 1000)}
                bucket.append(row)
                return {"success": True, "action": "add", "item": row, "count": len(bucket)}
            if act in {"done", "complete", "update"}:
                target = item_id or item
                for r in bucket:
                    if r["id"] == target or r["text"] == target:
                        r["done"] = bool(done if act == "update" else True)
                        return {"success": True, "action": "update", "item": r}
                return {"error": "todo item not found"}
            if act in {"remove", "delete"}:
                target = item_id or item
                before = len(bucket)
                bucket[:] = [r for r in bucket if not (r["id"] == target or r["text"] == target)]
                return {"success": True, "action": "remove", "removed": before - len(bucket), "count": len(bucket)}
            if act == "clear":
                n = len(bucket)
                bucket.clear()
                return {"success": True, "action": "clear", "removed": n}
            return {"success": True, "action": "list", "items": bucket, "count": len(bucket)}
    return _todo


def _make_memory_tool_handler(uid: str):
    def _memory(action: str = "list", content: str = "", category: str = "interesting", limit: int = 50, reason: str = "") -> Dict[str, Any]:
        """Real memory bridge compatible with Hermes 'memory' tool semantics."""
        act = (action or "list").strip().lower()
        saver = _make_save_memory_handler(uid)
        getter = _make_get_memories_handler(uid)
        if act in {"add", "save", "create"}:
            return saver(fact=content, category=category)
        if act in {"list", "get", "search"}:
            return getter(category=None if category == "all" else category, limit=limit)
        return {"error": f"Unsupported memory action: {action}"}
    return _memory


def _execute_code(code: str, reason: str = "", language: str = "python") -> Dict[str, Any]:
    """
    Hermes execute_code compatibility shim.
    Executes Python code in a temporary file when desktop-local mode is enabled.
    """
    if (language or "python").lower() not in {"python", "py"}:
        return {"error": "Only Python is supported in Noah execute_code compatibility mode."}
    try:
        import tempfile
        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, encoding="utf-8") as tf:
            tf.write(code or "")
            temp_path = tf.name
        result = subprocess.run(
            ["python3", temp_path],
            capture_output=True,
            text=True,
            timeout=45,
            env={**os.environ},
        )
        _run_shell(f"rm -f {shlex.quote(temp_path)}", reason="cleanup execute_code temp file")
        return {
            "success": result.returncode == 0,
            "stdout": result.stdout[:30000],
            "stderr": result.stderr[:8000],
            "returncode": result.returncode,
        }
    except Exception as exc:
        return {"error": str(exc)}


def _make_cronjob_handler(uid: str):
    def _cronjob(action: str = "list", schedule: str = "", task: str = "", job_id: str = "", paused: bool = False, reason: str = "") -> Dict[str, Any]:
        """
        Functional cron registry with create/list/pause/resume/remove/run actions.
        (Registry-based; actual scheduling remains managed by Noah automation service.)
        """
        key = uid or "anon"
        act = (action or "list").strip().lower()
        with _cron_lock:
            rows = _cron_store.setdefault(key, [])
            if act in {"create", "add"}:
                if not schedule.strip() or not task.strip():
                    return {"error": "cronjob create requires schedule and task"}
                row = {
                    "id": str(uuid.uuid4()),
                    "schedule": schedule.strip(),
                    "task": task.strip(),
                    "paused": bool(paused),
                    "created_at": int(time.time() * 1000),
                }
                rows.append(row)
                return {"success": True, "action": "create", "job": row}
            if act in {"remove", "delete"}:
                before = len(rows)
                rows[:] = [r for r in rows if r["id"] != job_id]
                return {"success": True, "action": "remove", "removed": before - len(rows)}
            if act == "pause":
                for r in rows:
                    if r["id"] == job_id:
                        r["paused"] = True
                        return {"success": True, "action": "pause", "job": r}
                return {"error": "job not found"}
            if act == "resume":
                for r in rows:
                    if r["id"] == job_id:
                        r["paused"] = False
                        return {"success": True, "action": "resume", "job": r}
                return {"error": "job not found"}
            if act in {"run", "trigger"}:
                for r in rows:
                    if r["id"] == job_id:
                        out = _run_shell(r["task"], reason="cronjob run")
                        return {"success": True, "action": "run", "job": r, "run_result": out}
                return {"error": "job not found"}
            return {"success": True, "action": "list", "jobs": rows, "count": len(rows)}
    return _cronjob


def _vision_analyze(image_path: str = "", query: str = "", reason: str = "") -> Dict[str, Any]:
    """Vision compatibility shim."""
    return {
        "success": True,
        "note": "vision_analyze compatibility shim active. Use Noah screen-watch / vision flows for full analysis.",
        "image_path": image_path,
        "query": query,
    }


def _image_generate(prompt: str, model: str = "higgsfield", reason: str = "") -> Dict[str, Any]:
    """Image generation parity wrapper that routes to Higgsfield generation."""
    return _higgsfield_generate(model=model or "higgsfield", prompt=prompt, wait=True, output_json=True, reason=reason)


def _ha_request(path: str, method: str = "GET", body: Optional[dict] = None) -> Dict[str, Any]:
    base = os.environ.get("HASS_URL", "").rstrip("/")
    token = os.environ.get("HASS_TOKEN", "")
    if not base or not token:
        return {"error": "Home Assistant not configured. Set HASS_URL and HASS_TOKEN.", "recoverable": True}
    url = f"{base}{path}"
    try:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, method=method.upper())
        req.add_header("Authorization", f"Bearer {token}")
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=20) as resp:
            payload = resp.read().decode("utf-8", errors="replace")
            try:
                payload = json.loads(payload)
            except Exception:
                pass
            return {"success": True, "status": resp.status, "data": payload}
    except Exception as exc:
        return {"error": str(exc), "recoverable": True}


def _ha_list_entities() -> Dict[str, Any]:
    return _ha_request("/api/states")


def _ha_get_state(entity_id: str) -> Dict[str, Any]:
    return _ha_request(f"/api/states/{urllib.parse.quote(entity_id, safe='')}")


def _ha_list_services() -> Dict[str, Any]:
    return _ha_request("/api/services")


def _ha_call_service(domain: str, service: str, data: Optional[dict] = None) -> Dict[str, Any]:
    return _ha_request(f"/api/services/{urllib.parse.quote(domain, safe='')}/{urllib.parse.quote(service, safe='')}", method="POST", body=data or {})


def _get_capabilities_tool() -> Dict[str, Any]:
    """Return explicit backend tool capability snapshot for model grounding."""
    try:
        from hermes.tools import TOOL_SCHEMAS  # self-import safe at runtime
        tool_names = sorted(TOOL_SCHEMAS.keys())
    except Exception:
        tool_names = sorted(list(TOOL_FUNCTIONS.keys()))
    return {
        "success": True,
        "mode": "hermes",
        "tool_count": len(tool_names),
        "tools": tool_names,
        "notes": {
            "execute_code": "available (python compatibility mode)",
            "cronjob": "available (create/list/pause/resume/remove/run)",
            "desktop_proxy_required_for": [
                "computer_*", "browser_playwright_script", "cloud_codespace_*", "run_applescript", "open_url", "open_path",
            ],
        },
    }


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
    "higgsfield_generate": {"type": "function", "function": {
        "name": "higgsfield_generate",
        "description": (
            "Generate image/video content using Higgsfield CLI for automation workflows. "
            "Requires local Higgsfield CLI login (`higgsfield auth login`)."
        ),
        "parameters": {"type": "object", "properties": {
            "model": {"type": "string", "description": "Higgsfield model/job set type (e.g. nano_banana_2, kling3_0)"},
            "prompt": {"type": "string", "description": "Generation prompt"},
            "wait": {"type": "boolean", "default": True, "description": "Wait for completion before returning"},
            "output_json": {"type": "boolean", "default": True, "description": "Request machine-readable JSON output"},
            "extra_flags": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Optional extra CLI flags chunks, e.g. ['--aspect_ratio 16:9', '--resolution 2k']",
            },
            "reason": {"type": "string", "description": "Why this generation is being run"},
        }, "required": ["model", "prompt", "reason"]},
    }},
    "heygen_generate": {"type": "function", "function": {
        "name": "heygen_generate",
        "description": (
            "Generate videos using HeyGen CLI (video-agent create). "
            "Requires local HeyGen CLI login (`heygen auth login`)."
        ),
        "parameters": {"type": "object", "properties": {
            "prompt": {"type": "string", "description": "Video generation prompt for HeyGen video-agent"},
            "wait": {"type": "boolean", "default": True, "description": "Wait for completion before returning"},
            "timeout": {"type": "string", "default": "20m", "description": "HeyGen wait timeout (for example: 20m, 30m)"},
            "reason": {"type": "string", "description": "Why this generation is being run"},
        }, "required": ["prompt", "reason"]},
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
    "computer_open_application": {"type": "function", "function": {
        "name": "computer_open_application",
        "description": "Open and focus a desktop application by name (for example 'Claude', 'Safari', 'Notion').",
        "parameters": {"type": "object", "properties": {
            "app_name": {"type": "string", "description": "Visible app name in macOS Applications"},
            "reason": {"type": "string", "description": "Why this app is being opened"},
        }, "required": ["app_name", "reason"]},
    }},
    "computer_click": {"type": "function", "function": {
        "name": "computer_click",
        "description": "Click at absolute screen coordinates on the user's desktop.",
        "parameters": {"type": "object", "properties": {
            "x": {"type": "integer"},
            "y": {"type": "integer"},
            "button": {"type": "string", "enum": ["left", "right"], "default": "left"},
            "click_count": {"type": "integer", "default": 1},
            "reason": {"type": "string"},
        }, "required": ["x", "y", "reason"]},
    }},
    "computer_type": {"type": "function", "function": {
        "name": "computer_type",
        "description": "Type text into the currently focused input area.",
        "parameters": {"type": "object", "properties": {
            "text": {"type": "string"},
            "submit": {"type": "boolean", "default": False, "description": "Press Enter after typing when true"},
            "reason": {"type": "string"},
        }, "required": ["text", "reason"]},
    }},
    "computer_hotkey": {"type": "function", "function": {
        "name": "computer_hotkey",
        "description": "Press a keyboard shortcut (e.g. ['command','n'] or ['command','shift','p']).",
        "parameters": {"type": "object", "properties": {
            "keys": {"type": "array", "items": {"type": "string"}},
            "reason": {"type": "string"},
        }, "required": ["keys", "reason"]},
    }},
    "computer_wait_for_app": {"type": "function", "function": {
        "name": "computer_wait_for_app",
        "description": "Wait until the given application is running and frontmost.",
        "parameters": {"type": "object", "properties": {
            "app_name": {"type": "string"},
            "timeout_sec": {"type": "integer", "default": 10},
            "reason": {"type": "string"},
        }, "required": ["app_name", "reason"]},
    }},
    "computer_claude_create_thread": {"type": "function", "function": {
        "name": "computer_claude_create_thread",
        "description": "Open Claude desktop app, create a new thread, place prompt text, and optionally submit.",
        "parameters": {"type": "object", "properties": {
            "prompt": {"type": "string"},
            "submit": {"type": "boolean", "default": True},
            "reason": {"type": "string"},
        }, "required": ["prompt", "reason"]},
    }},
    "computer_observe": {"type": "function", "function": {
        "name": "computer_observe",
        "description": "Observe current desktop state: frontmost app/window and optionally a compact UI text tree.",
        "parameters": {"type": "object", "properties": {
            "reason": {"type": "string"},
            "include_ui_tree": {"type": "boolean", "default": False},
        }, "required": ["reason"]},
    }},
    "computer_click_text": {"type": "function", "function": {
        "name": "computer_click_text",
        "description": "Find and click a visible element by text/label in the frontmost app.",
        "parameters": {"type": "object", "properties": {
            "text": {"type": "string"},
            "exact": {"type": "boolean", "default": False},
            "timeout_sec": {"type": "integer", "default": 8},
            "reason": {"type": "string"},
        }, "required": ["text", "reason"]},
    }},
    "computer_type_in_field": {"type": "function", "function": {
        "name": "computer_type_in_field",
        "description": "Focus a UI field by hint/label and type text into it.",
        "parameters": {"type": "object", "properties": {
            "field_hint": {"type": "string"},
            "text": {"type": "string"},
            "submit": {"type": "boolean", "default": False},
            "reason": {"type": "string"},
        }, "required": ["field_hint", "text", "reason"]},
    }},
    "computer_verify_text": {"type": "function", "function": {
        "name": "computer_verify_text",
        "description": "Verify whether specific text is visible in the frontmost window.",
        "parameters": {"type": "object", "properties": {
            "text": {"type": "string"},
            "exact": {"type": "boolean", "default": False},
            "reason": {"type": "string"},
        }, "required": ["text", "reason"]},
    }},
    "computer_vscode_open_project": {"type": "function", "function": {
        "name": "computer_vscode_open_project",
        "description": "Open a folder/workspace in Visual Studio Code.",
        "parameters": {"type": "object", "properties": {
            "project_path": {"type": "string", "description": "Absolute folder path to open in VS Code"},
            "reason": {"type": "string"},
        }, "required": ["project_path", "reason"]},
    }},
    "computer_vscode_open_file": {"type": "function", "function": {
        "name": "computer_vscode_open_file",
        "description": "Open a file in Visual Studio Code, optionally jumping to a line.",
        "parameters": {"type": "object", "properties": {
            "file_path": {"type": "string", "description": "Absolute file path"},
            "line": {"type": "integer", "default": 1},
            "reason": {"type": "string"},
        }, "required": ["file_path", "reason"]},
    }},
    "computer_vscode_run_task": {"type": "function", "function": {
        "name": "computer_vscode_run_task",
        "description": "Run a coding/build/test command in the user's workspace and return stdout/stderr.",
        "parameters": {"type": "object", "properties": {
            "command": {"type": "string", "description": "Shell command to execute"},
            "cwd": {"type": "string", "description": "Optional working directory path"},
            "reason": {"type": "string"},
        }, "required": ["command", "reason"]},
    }},
    "browser_playwright_script": {"type": "function", "function": {
        "name": "browser_playwright_script",
        "description": "Execute a Playwright JavaScript snippet for interactive browser automation and testing.",
        "parameters": {"type": "object", "properties": {
            "start_url": {"type": "string", "description": "Optional URL to open before executing script"},
            "script": {"type": "string", "description": "JavaScript snippet with access to: page, browser, context, console, result"},
            "headless": {"type": "boolean", "default": True},
            "timeout_sec": {"type": "integer", "default": 30},
            "reason": {"type": "string"},
        }, "required": ["reason"]},
    }},
    "web_search": {"type": "function", "function": {
        "name": "web_search",
        "description": "Upstream Hermes alias for web search (routes to Noah search).",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string"},
            "reason": {"type": "string"},
        }, "required": ["query"]},
    }},
    "web_extract": {"type": "function", "function": {
        "name": "web_extract",
        "description": "Upstream Hermes alias for extracting webpage content.",
        "parameters": {"type": "object", "properties": {
            "url": {"type": "string"},
            "reason": {"type": "string"},
        }, "required": ["url"]},
    }},
    "browser_navigate": {"type": "function", "function": {
        "name": "browser_navigate",
        "description": "Navigate to URL in browser automation session (compat alias).",
        "parameters": {"type": "object", "properties": {
            "url": {"type": "string"},
            "reason": {"type": "string"},
        }, "required": ["url"]},
    }},
    "browser_snapshot": {"type": "function", "function": {
        "name": "browser_snapshot",
        "description": "Capture browser page snapshot / accessibility tree (compat alias).",
        "parameters": {"type": "object", "properties": {
            "full": {"type": "boolean", "default": False},
            "reason": {"type": "string"},
        }, "required": []},
    }},
    "browser_click": {"type": "function", "function": {
        "name": "browser_click",
        "description": "Click browser element by selector/ref (compat alias).",
        "parameters": {"type": "object", "properties": {
            "selector": {"type": "string"},
            "ref": {"type": "string"},
            "reason": {"type": "string"},
        }, "required": []},
    }},
    "browser_type": {"type": "function", "function": {
        "name": "browser_type",
        "description": "Type text into browser field (compat alias).",
        "parameters": {"type": "object", "properties": {
            "selector": {"type": "string"},
            "ref": {"type": "string"},
            "text": {"type": "string"},
            "reason": {"type": "string"},
        }, "required": ["text"]},
    }},
    "browser_scroll": {"type": "function", "function": {
        "name": "browser_scroll",
        "description": "Scroll browser view (compat alias).",
        "parameters": {"type": "object", "properties": {
            "direction": {"type": "string"},
            "amount": {"type": "integer"},
            "reason": {"type": "string"},
        }, "required": []},
    }},
    "browser_back": {"type": "function", "function": {
        "name": "browser_back",
        "description": "Navigate browser history back (compat alias).",
        "parameters": {"type": "object", "properties": {
            "reason": {"type": "string"},
        }, "required": []},
    }},
    "browser_press": {"type": "function", "function": {
        "name": "browser_press",
        "description": "Press key in browser context (compat alias).",
        "parameters": {"type": "object", "properties": {
            "key": {"type": "string"},
            "reason": {"type": "string"},
        }, "required": ["key"]},
    }},
    "browser_get_images": {"type": "function", "function": {
        "name": "browser_get_images",
        "description": "List images from current browser page (compat alias).",
        "parameters": {"type": "object", "properties": {
            "reason": {"type": "string"},
        }, "required": []},
    }},
    "browser_vision": {"type": "function", "function": {
        "name": "browser_vision",
        "description": "Analyze browser screenshot via vision (compat alias).",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string"},
            "reason": {"type": "string"},
        }, "required": []},
    }},
    "browser_console": {"type": "function", "function": {
        "name": "browser_console",
        "description": "Get browser console logs (compat alias).",
        "parameters": {"type": "object", "properties": {
            "reason": {"type": "string"},
        }, "required": []},
    }},
    "browser_cdp": {"type": "function", "function": {
        "name": "browser_cdp",
        "description": "Browser CDP compatibility alias in Noah.",
        "parameters": {"type": "object", "properties": {
            "command": {"type": "string"},
            "params": {"type": "object"},
            "reason": {"type": "string"},
        }, "required": []},
    }},
    "browser_dialog": {"type": "function", "function": {
        "name": "browser_dialog",
        "description": "Browser dialog compatibility alias in Noah.",
        "parameters": {"type": "object", "properties": {
            "action": {"type": "string"},
            "value": {"type": "string"},
            "reason": {"type": "string"},
        }, "required": []},
    }},
    "cloud_codespaces_list": {"type": "function", "function": {
        "name": "cloud_codespaces_list",
        "description": "List existing GitHub Codespaces for a repository.",
        "parameters": {"type": "object", "properties": {
            "owner": {"type": "string", "description": "GitHub owner/org name"},
            "repo": {"type": "string", "description": "Repository name"},
            "reason": {"type": "string"},
        }, "required": ["owner", "repo", "reason"]},
    }},
    "cloud_codespace_create": {"type": "function", "function": {
        "name": "cloud_codespace_create",
        "description": "Create a GitHub Codespace for a repository and return its web URL.",
        "parameters": {"type": "object", "properties": {
            "owner": {"type": "string", "description": "GitHub owner/org name"},
            "repo": {"type": "string", "description": "Repository name"},
            "branch": {"type": "string", "description": "Optional branch name"},
            "machine": {"type": "string", "description": "Optional machine type, e.g. standardLinux32gb"},
            "reason": {"type": "string"},
        }, "required": ["owner", "repo", "reason"]},
    }},
    "cloud_codespace_open": {"type": "function", "function": {
        "name": "cloud_codespace_open",
        "description": "Open an existing GitHub Codespace in browser by codespace name.",
        "parameters": {"type": "object", "properties": {
            "codespace_name": {"type": "string", "description": "Codespace name from cloud_codespaces_list/create"},
            "reason": {"type": "string"},
        }, "required": ["codespace_name", "reason"]},
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
    "process": {"type": "function", "function": {
        "name": "process",
        "description": "Hermes parity alias for running shell commands.",
        "parameters": {"type": "object", "properties": {
            "command": {"type": "string"},
            "reason": {"type": "string"},
        }, "required": ["command"]},
    }},
    "search_files": {"type": "function", "function": {
        "name": "search_files",
        "description": "Search files by content pattern.",
        "parameters": {"type": "object", "properties": {
            "pattern": {"type": "string"},
            "path": {"type": "string", "default": "."},
            "reason": {"type": "string"},
        }, "required": ["pattern"]},
    }},
    "patch": {"type": "function", "function": {
        "name": "patch",
        "description": "Apply a simple text replacement patch in a file.",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string"},
            "find": {"type": "string"},
            "replace": {"type": "string"},
            "reason": {"type": "string"},
        }, "required": ["path", "find", "replace"]},
    }},
    "todo": {"type": "function", "function": {
        "name": "todo",
        "description": "Task planning shim for parity.",
        "parameters": {"type": "object", "properties": {
            "action": {"type": "string"},
            "item": {"type": "string"},
            "reason": {"type": "string"},
        }, "required": []},
    }},
    "memory": {"type": "function", "function": {
        "name": "memory",
        "description": "Memory compatibility shim.",
        "parameters": {"type": "object", "properties": {
            "action": {"type": "string"},
            "content": {"type": "string"},
            "reason": {"type": "string"},
        }, "required": []},
    }},
    "execute_code": {"type": "function", "function": {
        "name": "execute_code",
        "description": "Execute Python code in compatibility mode.",
        "parameters": {"type": "object", "properties": {
            "code": {"type": "string"},
            "language": {"type": "string", "default": "python"},
            "reason": {"type": "string"},
        }, "required": ["code"]},
    }},
    "cronjob": {"type": "function", "function": {
        "name": "cronjob",
        "description": "Cron scheduler compatibility shim.",
        "parameters": {"type": "object", "properties": {
            "action": {"type": "string"},
            "schedule": {"type": "string"},
            "task": {"type": "string"},
            "reason": {"type": "string"},
        }, "required": []},
    }},
    "vision_analyze": {"type": "function", "function": {
        "name": "vision_analyze",
        "description": "Vision analysis compatibility shim.",
        "parameters": {"type": "object", "properties": {
            "image_path": {"type": "string"},
            "query": {"type": "string"},
            "reason": {"type": "string"},
        }, "required": []},
    }},
    "image_generate": {"type": "function", "function": {
        "name": "image_generate",
        "description": "Generate image content.",
        "parameters": {"type": "object", "properties": {
            "prompt": {"type": "string"},
            "model": {"type": "string"},
            "reason": {"type": "string"},
        }, "required": ["prompt"]},
    }},
    "ha_list_entities": {"type": "function", "function": {"name": "ha_list_entities", "description": "List Home Assistant entities.", "parameters": {"type": "object", "properties": {}, "required": []}}},
    "ha_get_state": {"type": "function", "function": {"name": "ha_get_state", "description": "Get Home Assistant entity state.", "parameters": {"type": "object", "properties": {"entity_id": {"type": "string"}}, "required": ["entity_id"]}}},
    "ha_list_services": {"type": "function", "function": {"name": "ha_list_services", "description": "List Home Assistant services.", "parameters": {"type": "object", "properties": {}, "required": []}}},
    "ha_call_service": {"type": "function", "function": {"name": "ha_call_service", "description": "Call Home Assistant service.", "parameters": {"type": "object", "properties": {"domain": {"type": "string"}, "service": {"type": "string"}, "data": {"type": "object"}}, "required": ["domain", "service"]}}},
    "get_capabilities": {"type": "function", "function": {
        "name": "get_capabilities",
        "description": "Return Noah/Hermes runtime capability map and exposed tool names. Call before answering capability questions.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    }},
    "delegate_task": {"type": "function", "function": {
        "name": "delegate_task",
        "description": (
            "Create a specialist sub-agent delegation plan for a niche task. "
            "Use for SEO/content/coding/research/ops specialist execution."
        ),
        "parameters": {"type": "object", "properties": {
            "role": {"type": "string", "enum": ["seo", "content", "coding", "research", "ops"]},
            "objective": {"type": "string", "description": "Specialist objective"},
            "constraints": {"type": "array", "items": {"type": "string"}, "description": "Constraints to follow"},
            "output_format": {"type": "string", "description": "summary | checklist | report | markdown"},
        }, "required": ["role", "objective"]},
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
    "skills_list": {"type": "function", "function": {
        "name": "skills_list",
        "description": "Hermes parity alias for listing skills.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    }},
    "view_skill": {"type": "function", "function": {
        "name": "view_skill",
        "description": "Read the full content of a saved skill by name.",
        "parameters": {"type": "object", "properties": {
            "name": {"type": "string", "description": "Name of the skill to read (from list_skills)"},
        }, "required": ["name"]},
    }},
    "skill_view": {"type": "function", "function": {
        "name": "skill_view",
        "description": "Hermes parity alias for viewing a skill.",
        "parameters": {"type": "object", "properties": {
            "name": {"type": "string"},
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
    "skill_manage": {"type": "function", "function": {
        "name": "skill_manage",
        "description": "Hermes parity alias for saving/updating a skill.",
        "parameters": {"type": "object", "properties": {
            "name": {"type": "string"},
            "content": {"type": "string"},
            "shared": {"type": "boolean", "default": False},
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
    "session_search": {"type": "function", "function": {
        "name": "session_search",
        "description": "Hermes parity alias for searching prior session history.",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string"},
            "limit": {"type": "integer", "default": 5},
        }, "required": ["query"]},
    }},
}


# Mapping: tool name → handler function.
# save_memory, get_memories, list_skills, view_skill, save_skill, search_history
# are registered separately in register_noah_tools() because they require
# per-user uid/session_db closures.
TOOL_FUNCTIONS = {
    "terminal":          _run_shell,
    "higgsfield_generate": _higgsfield_generate,
    "heygen_generate": _heygen_generate,
    "run_applescript":   _run_applescript,
    "search_web":        _search_web,
    "fetch_webpage":     _fetch_webpage,
    "read_file":         _read_file,
    "write_file":        _write_file,
    "list_directory":    _list_directory,
    "show_notification": _show_notification,
    "open_url":          _open_url,
    "open_path":         _open_path,
    "computer_open_application": _computer_open_application,
    "computer_click": _computer_click,
    "computer_type": _computer_type,
    "computer_hotkey": _computer_hotkey,
    "computer_wait_for_app": _computer_wait_for_app,
    "computer_claude_create_thread": _computer_claude_create_thread,
    "computer_observe": _computer_observe,
    "computer_click_text": _computer_click_text,
    "computer_type_in_field": _computer_type_in_field,
    "computer_verify_text": _computer_verify_text,
    "computer_vscode_open_project": _computer_vscode_open_project,
    "computer_vscode_open_file": _computer_vscode_open_file,
    "computer_vscode_run_task": _computer_vscode_run_task,
    "browser_playwright_script": _browser_playwright_script,
    "web_search": _search_web,
    "web_extract": _fetch_webpage,
    "browser_navigate": _browser_alias_tool,
    "browser_snapshot": _browser_alias_tool,
    "browser_click": _browser_alias_tool,
    "browser_type": _browser_alias_tool,
    "browser_scroll": _browser_alias_tool,
    "browser_back": _browser_alias_tool,
    "browser_press": _browser_alias_tool,
    "browser_get_images": _browser_alias_tool,
    "browser_vision": _browser_alias_tool,
    "browser_console": _browser_alias_tool,
    "browser_cdp": _browser_alias_tool,
    "browser_dialog": _browser_alias_tool,
    "process": _process,
    "search_files": _search_files,
    "patch": _patch,
    "execute_code": _execute_code,
    "vision_analyze": _vision_analyze,
    "image_generate": _image_generate,
    "ha_list_entities": _ha_list_entities,
    "ha_get_state": _ha_get_state,
    "ha_list_services": _ha_list_services,
    "ha_call_service": _ha_call_service,
    "get_capabilities": _get_capabilities_tool,
    "cloud_codespaces_list": _cloud_codespaces_list,
    "cloud_codespace_create": _cloud_codespace_create,
    "cloud_codespace_open": _cloud_codespace_open,
    "api_call":          _api_call,
    "delegate_task":     _delegate_task,
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
        agent.register_tool("memory",       _make_memory_tool_handler(uid),    TOOL_SCHEMAS["memory"])
        agent.register_tool("list_skills",  _make_list_skills_handler(uid),   TOOL_SCHEMAS["list_skills"])
        agent.register_tool("skills_list",  _make_list_skills_handler(uid),   TOOL_SCHEMAS["skills_list"])
        agent.register_tool("view_skill",   _make_view_skill_handler(uid),    TOOL_SCHEMAS["view_skill"])
        agent.register_tool("skill_view",   _make_view_skill_handler(uid),    TOOL_SCHEMAS["skill_view"])
        agent.register_tool("save_skill",   _make_save_skill_handler(uid),    TOOL_SCHEMAS["save_skill"])
        agent.register_tool("skill_manage", _make_save_skill_handler(uid),    TOOL_SCHEMAS["skill_manage"])
        agent.register_tool("todo",         _make_todo_handler(uid),          TOOL_SCHEMAS["todo"])
        agent.register_tool("cronjob",      _make_cronjob_handler(uid),       TOOL_SCHEMAS["cronjob"])
        logger.debug("Registered user tools for uid=%s", uid)

    # session_db may come from the agent itself if not passed explicitly
    db = session_db or getattr(agent, "session_db", None)
    if db:
        agent.register_tool("search_history", _make_search_history_handler(db), TOOL_SCHEMAS["search_history"])
        agent.register_tool("session_search", _make_search_history_handler(db), TOOL_SCHEMAS["session_search"])
        logger.debug("Registered search_history tool")
