"""
AIAgent — Hermes-compatible agent engine for Noah.

Architectural concepts from NousResearch/hermes-agent (MIT license):
  - Parallel tool execution via ThreadPoolExecutor (run_agent.py:_execute_tool_calls_concurrent)
  - Serial-tool guard for destructive operations (run_agent.py:_SERIAL_TOOL_NAMES)
  - Iteration budget cap to prevent runaway loops (run_agent.py:IterationBudget)
  - Provider-agnostic routing (Anthropic messages API + OpenAI chat completions)

Adapted for Noah's macOS desktop assistant use-case.
"""

import concurrent.futures
import json
import logging
import os
import time
import uuid
from typing import Any, Callable, Dict, List, Optional

from .context import compress_context

logger = logging.getLogger(__name__)

# Maximum concurrent worker threads for parallel tool execution
# Mirrors run_agent.py MAX_PARALLEL_TOOL_WORKERS constant
MAX_PARALLEL_TOOL_WORKERS = 8

# Tools that must never run concurrently (interactive / destructive)
# Mirrors run_agent.py _SERIAL_TOOL_NAMES set
_SERIAL_TOOLS: frozenset = frozenset({
    # terminal: can have side effects that depend on sequential ordering
    "terminal",
    "write_file",
    "show_notification",
    "open_url",
    "open_path",
})


def _should_parallelize(tool_calls: list) -> bool:
    """
    Return True when a tool-call batch is safe to run concurrently.
    Mirrors run_agent.py _should_parallelize_tool_batch().
    Read-only tools (search, fetch, read) always parallelize.
    Destructive/interactive tools always serialize.
    """
    if len(tool_calls) <= 1:
        return False
    names = {tc.get("name", "") for tc in tool_calls}
    return not bool(names & _SERIAL_TOOLS)


class AIAgent:
    """
    Hermes-compatible AI agent for Noah.

    Implements the same public interface as NousResearch/hermes-agent's AIAgent:
      agent.chat(message)               -> str
      agent.run_conversation(message)   -> {"final_response": str, "messages": list}

    Additional Noah-specific features:
      agent.register_tool(name, func, schema)
    """

    def __init__(
        self,
        model: str = "",
        api_key: str = None,
        provider: str = None,
        quiet_mode: bool = False,
        ephemeral_system_prompt: str = None,
        max_iterations: int = 25,
        tool_delay: float = 0.0,
        session_id: str = None,
        session_db=None,
        tool_start_callback: Optional[Callable] = None,
        tool_complete_callback: Optional[Callable] = None,
        status_callback: Optional[Callable] = None,
        **kwargs,
    ):
        """
        Initialize Noah's Hermes-compatible agent.

        Args:
            model:                  LLM model name (e.g. "claude-opus-4-20250514", "gpt-4o")
            api_key:                Override API key (falls back to env vars)
            provider:               "anthropic" | "openai" (auto-detected from model name)
            quiet_mode:             Suppress progress output (True for embedded use)
            ephemeral_system_prompt: System prompt injected per turn (not saved to history)
            max_iterations:         Maximum tool-calling rounds per conversation turn
            tool_delay:             Seconds to wait between tool calls (0 = fastest)
            session_id:             Persistent session identifier for SQLite memory
            session_db:             SessionDB instance (shared across requests)
            tool_start_callback:    Called when a tool starts: (name, args_preview) -> None
            tool_complete_callback: Called when a tool finishes: (name, result) -> None
            status_callback:        Called with status strings: (message) -> None
        """
        self.model = model or os.environ.get("NOAH_HERMES_MODEL", "claude-opus-4-20250514")
        self.quiet_mode = quiet_mode
        self.ephemeral_system_prompt = ephemeral_system_prompt
        self.max_iterations = max_iterations
        self.tool_delay = tool_delay
        self.session_id = session_id or str(uuid.uuid4())
        self.session_db = session_db

        self.tool_start_callback = tool_start_callback
        self.tool_complete_callback = tool_complete_callback
        self.status_callback = status_callback

        # Tool registry: name -> (callable, openai-style schema dict)
        self._tools: Dict[str, tuple] = {}

        # Detect provider
        self._provider = provider or self._detect_provider(self.model)
        self._api_key = api_key

        # Thread pool for parallel tool execution (Hermes pattern)
        self._executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=MAX_PARALLEL_TOOL_WORKERS,
            thread_name_prefix="noah-hermes-tool",
        )

    # ── Provider detection ──────────────────────────────────────────────────

    @staticmethod
    def _detect_provider(model: str) -> str:
        """
        Determine which LLM backend to use.

        Priority order:
          1. NOAH_HERMES_PROVIDER env var (explicit override)
          2. User-provided BYOK OpenRouter key → "openrouter"
          3. OpenRouter integration env vars present → "openrouter"
          4. Model name heuristics
        """
        explicit = os.environ.get("NOAH_HERMES_PROVIDER", "").lower()
        if explicit in ("anthropic", "openai", "openrouter"):
            return explicit

        # If user provided their own OpenRouter key via BYOK, use OpenRouter
        from utils.byok import get_byok_key
        if get_byok_key('openrouter'):
            return "openrouter"

        # If the OpenRouter integration is wired up server-side, use it
        if os.environ.get("AI_INTEGRATIONS_OPENROUTER_BASE_URL"):
            return "openrouter"

        m = model.lower()
        if any(k in m for k in ("claude", "anthropic")):
            return "anthropic"
        if any(k in m for k in ("gpt", "openai", "o1", "o3", "o4")):
            return "openai"
        return "anthropic"

    # ── Tool registration ───────────────────────────────────────────────────

    def register_tool(self, name: str, func: Callable, schema: dict) -> None:
        """
        Register a callable tool with its OpenAI-style JSON schema.
        Mirrors the Hermes registry.register() pattern from tools/registry.py.
        """
        self._tools[name] = (func, schema)

    def _get_tool_schemas(self) -> list:
        """Return the OpenAI-style function-call schema list."""
        return [schema for (_, schema) in self._tools.values()]

    def _get_anthropic_tool_schemas(self) -> list:
        """Convert OpenAI-style schemas to Anthropic tool format."""
        result = []
        for _, schema in self._tools.values():
            fn = schema.get("function", {})
            result.append({
                "name": fn["name"],
                "description": fn.get("description", ""),
                "input_schema": fn.get("parameters", {"type": "object", "properties": {}}),
            })
        return result

    # ── LLM client helpers ──────────────────────────────────────────────────

    def _get_anthropic_client(self):
        import anthropic
        from utils.byok import get_byok_key
        key = self._api_key or get_byok_key('anthropic') or get_byok_key('openai') or os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("OPENAI_API_KEY")
        return anthropic.Anthropic(api_key=key)

    def _get_openai_client(self):
        from openai import OpenAI
        from utils.byok import get_byok_key
        key = self._api_key or get_byok_key('openai') or os.environ.get("OPENAI_API_KEY")
        return OpenAI(api_key=key)

    def _get_openrouter_client(self):
        """OpenAI-compatible client pointed at OpenRouter, using BYOK key if provided."""
        from openai import OpenAI
        from utils.byok import get_byok_key
        # Priority:
        # 1) Explicit per-request key injected by router/hermes_bridge
        # 2) Context BYOK key (same-thread paths)
        # 3) Server env fallback (if operator intentionally sets one)
        key = self._api_key or get_byok_key('openrouter')
        base_url = "https://openrouter.ai/api/v1"
        if key:
            # Force the Authorization header explicitly in addition to api_key.
            # This guards against SDK/provider edge cases where auth headers are
            # not propagated on custom base URLs.
            return OpenAI(
                api_key=key,
                base_url=base_url,
                default_headers={"Authorization": f"Bearer {key}"},
            )
        base_url = os.environ.get("AI_INTEGRATIONS_OPENROUTER_BASE_URL", base_url)
        key = os.environ.get("AI_INTEGRATIONS_OPENROUTER_API_KEY") or os.environ.get("OPENROUTER_API_KEY", "dummy")
        return OpenAI(
            api_key=key,
            base_url=base_url,
            default_headers={"Authorization": f"Bearer {key}"},
        )

    # ── Tool execution ──────────────────────────────────────────────────────

    def _execute_single_tool(self, name: str, args: dict) -> Any:
        """Execute one tool synchronously."""
        if name not in self._tools:
            return {"error": f"Unknown tool: {name}"}
        func, _ = self._tools[name]
        try:
            return func(**args)
        except TypeError as exc:
            # Try calling with just the args that the function accepts
            logger.warning("Tool %s TypeError: %s — retrying with filtered args", name, exc)
            import inspect
            sig = inspect.signature(func)
            filtered = {k: v for k, v in args.items() if k in sig.parameters}
            try:
                return func(**filtered)
            except Exception as exc2:
                return {"error": str(exc2)}
        except Exception as exc:
            logger.warning("Tool %s raised: %s", name, exc)
            return {"error": str(exc)}

    def _parse_args(self, raw_args) -> dict:
        """Parse tool arguments from string or dict."""
        if isinstance(raw_args, dict):
            return raw_args
        if isinstance(raw_args, str):
            try:
                return json.loads(raw_args)
            except Exception:
                return {}
        return {}

    def _run_one_tool(self, tc: dict) -> tuple:
        """Run a single tool call. Returns (tool_call_id, name, result_json)."""
        name = tc.get("name", "")
        args = self._parse_args(tc.get("arguments", tc.get("input", {})))
        call_id = tc.get("id", name)

        if not self.quiet_mode and self.tool_start_callback:
            try:
                self.tool_start_callback(name, str(args)[:120])
            except Exception:
                pass

        if self.tool_delay > 0:
            time.sleep(self.tool_delay)

        result = self._execute_single_tool(name, args)

        if not self.quiet_mode and self.tool_complete_callback:
            try:
                self.tool_complete_callback(name, result)
            except Exception:
                pass

        return (call_id, name, json.dumps(result, default=str)[:8000])

    def _execute_tool_calls(self, tool_calls: list) -> list:
        """
        Execute a batch of tool calls, parallel when safe.
        Mirrors run_agent.py _execute_tool_calls() dispatch logic.
        """
        if _should_parallelize(tool_calls):
            return self._execute_tool_calls_concurrent(tool_calls)
        return [self._run_one_tool(tc) for tc in tool_calls]

    def _execute_tool_calls_concurrent(self, tool_calls: list) -> list:
        """
        Fan out tool calls to the thread pool.
        Mirrors run_agent.py _execute_tool_calls_concurrent().
        """
        tool_names = [tc.get("name", "") for tc in tool_calls]
        if self.status_callback:
            try:
                self.status_callback(f"Running {len(tool_calls)} tools in parallel: {', '.join(tool_names)}")
            except Exception:
                pass

        futures = {
            self._executor.submit(self._run_one_tool, tc): tc
            for tc in tool_calls
        }
        results = []
        for fut in concurrent.futures.as_completed(futures, timeout=60):
            try:
                results.append(fut.result())
            except Exception as exc:
                tc = futures[fut]
                results.append((tc.get("id", tc.get("name", "")), tc.get("name", ""), json.dumps({"error": str(exc)})))
        return results

    # ── Anthropic conversation loop ─────────────────────────────────────────

    def _run_anthropic(self, messages: list, system: str) -> Dict[str, Any]:
        """Full Anthropic tool-calling conversation loop."""
        client = self._get_anthropic_client()
        tools = self._get_anthropic_tool_schemas()
        history = [m for m in messages if m.get("role") != "system"]
        final_response = ""

        for iteration in range(self.max_iterations):
            kwargs: dict = {
                "model": self.model,
                "max_tokens": 4096,
                "messages": history,
            }
            if system:
                kwargs["system"] = system
            if tools:
                kwargs["tools"] = tools

            try:
                resp = client.messages.create(**kwargs)
            except Exception as exc:
                logger.error("Anthropic API error: %s", exc)
                return {"final_response": f"API error: {exc}", "messages": history}

            text_blocks = []
            tool_use_blocks = []
            for block in resp.content:
                if hasattr(block, "text"):
                    text_blocks.append(block.text)
                elif hasattr(block, "type") and block.type == "tool_use":
                    tool_use_blocks.append(block)

            if text_blocks:
                final_response = "\n".join(text_blocks)

            if resp.stop_reason == "end_turn" or not tool_use_blocks:
                break

            # Append assistant response (with tool_use blocks)
            history.append({"role": "assistant", "content": resp.content})

            # Execute tool calls
            tool_calls = [
                {"id": b.id, "name": b.name, "arguments": b.input}
                for b in tool_use_blocks
            ]
            results = self._execute_tool_calls(tool_calls)

            # Append tool results
            history.append({
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": tid, "content": result_json}
                    for tid, _, result_json in results
                ],
            })

        return {"final_response": final_response, "messages": history}

    # ── OpenAI / OpenRouter conversation loops ──────────────────────────────

    def _get_compat_client(self):
        """Return the right OpenAI-compatible client (OpenAI or OpenRouter)."""
        if self._provider == "openrouter":
            return self._get_openrouter_client()
        return self._get_openai_client()

    def _run_openai(self, messages: list, system: str) -> Dict[str, Any]:
        """Full OpenAI-compatible tool-calling conversation loop (OpenAI or OpenRouter)."""
        client = self._get_compat_client()
        tools = self._get_tool_schemas()

        history = list(messages)
        if system and not any(m.get("role") == "system" for m in history):
            history = [{"role": "system", "content": system}] + history

        final_response = ""

        for iteration in range(self.max_iterations):
            kwargs: dict = {
                "model": self.model,
                "messages": history,
            }
            if tools:
                kwargs["tools"] = tools
                kwargs["tool_choice"] = "auto"

            try:
                resp = client.chat.completions.create(**kwargs)
            except Exception as exc:
                logger.error("OpenAI API error: %s", exc)
                return {"final_response": f"API error: {exc}", "messages": history}

            choice = resp.choices[0]
            msg = choice.message

            if msg.content:
                final_response = msg.content

            tool_calls = msg.tool_calls
            if not tool_calls or choice.finish_reason == "stop":
                break

            history.append(msg)

            tc_list = [
                {"id": tc.id, "name": tc.function.name, "arguments": tc.function.arguments}
                for tc in tool_calls
            ]
            results = self._execute_tool_calls(tc_list)

            for tid, name, result_json in results:
                history.append({
                    "role": "tool",
                    "tool_call_id": tid,
                    "name": name,
                    "content": result_json,
                })

        return {"final_response": final_response, "messages": history}

    # ── Public API ──────────────────────────────────────────────────────────

    def run_conversation(
        self,
        user_message: str,
        system_message: str = None,
        conversation_history: List[Dict] = None,
        task_id: str = None,
        stream_callback=None,
        **kwargs,
    ) -> Dict[str, Any]:
        """
        Run a complete conversation turn with tool-calling until completion.
        Mirrors NousResearch/hermes-agent AIAgent.run_conversation() signature.

        Returns:
            {"final_response": str, "messages": list}
        """
        system = system_message or self.ephemeral_system_prompt or ""

        # Build message list: history + current turn
        messages = list(conversation_history or [])
        messages.append({"role": "user", "content": user_message})

        # Context compression: drop old turns when history grows long
        # Mirrors context_compressor.py from hermes-agent
        if len(messages) > 40:
            from .context import compress_context
            messages = compress_context(messages, keep_recent=20)

        try:
            if self._provider == "anthropic":
                result = self._run_anthropic(messages, system)
            else:
                result = self._run_openai(messages, system)
        except Exception as exc:
            logger.error("Hermes agent run_conversation error: %s", exc, exc_info=True)
            result = {
                "final_response": f"I encountered an error: {exc}",
                "messages": messages,
            }

        # Persist turn to SQLite session DB (upstream hermes_state.SessionDB API)
        if self.session_db is not None and self.session_id:
            try:
                self.session_db.append_message(
                    session_id=self.session_id,
                    role="user",
                    content=user_message,
                )
                self.session_db.append_message(
                    session_id=self.session_id,
                    role="assistant",
                    content=result["final_response"],
                )
            except Exception as exc:
                logger.warning("Session DB write failed: %s", exc)

        return result

    def chat(self, message: str, **kwargs) -> str:
        """
        Simple one-shot interface. Returns just the final text response.
        Mirrors NousResearch/hermes-agent AIAgent.chat() signature.
        """
        return self.run_conversation(message, **kwargs)["final_response"]

    # ── Streaming conversation loops ─────────────────────────────────────────

    @staticmethod
    def _tool_label(name: str) -> str:
        """Return a human-readable label for a tool name."""
        labels = {
            "search_web": "Searching the web…",
            "fetch_page": "Fetching page…",
            "read_file": "Reading file…",
            "write_file": "Writing file…",
            "terminal": "Running command…",
            "get_clipboard": "Reading clipboard…",
            "set_clipboard": "Writing to clipboard…",
            "show_notification": "Sending notification…",
            "open_url": "Opening URL…",
            "open_path": "Opening path…",
            "save_memory": "Saving to memory…",
            "get_screen_context": "Reading screen…",
        }
        return labels.get(name, f"Using {name.replace('_', ' ')}…")

    def _run_anthropic_streaming(self, messages: list, system: str, callback) -> Dict[str, Any]:
        """
        Anthropic conversation loop with streaming text tokens.
        Calls callback(event_dict) for each SSE event:
          {"type": "token", "content": "..."}
          {"type": "tool_start", "tool": "...", "label": "..."}
        Returns the final result dict.
        """
        import anthropic
        client = self._get_anthropic_client()
        tools = self._get_anthropic_tool_schemas()
        history = [m for m in messages if m.get("role") != "system"]
        final_response = ""

        for iteration in range(self.max_iterations):
            kwargs: dict = {
                "model": self.model,
                "max_tokens": 4096,
                "messages": history,
            }
            if system:
                kwargs["system"] = system
            if tools:
                kwargs["tools"] = tools

            try:
                with client.messages.stream(**kwargs) as stream:
                    for event in stream:
                        if (
                            hasattr(event, "type")
                            and event.type == "content_block_delta"
                            and hasattr(event, "delta")
                            and hasattr(event.delta, "text")
                        ):
                            callback({"type": "token", "content": event.delta.text})
                    final_msg = stream.get_final_message()
            except anthropic.APIError as exc:
                logger.error("Anthropic streaming API error: %s", exc)
                callback({"type": "error", "message": f"API error: {exc}"})
                return {"final_response": f"API error: {exc}", "messages": history}

            text_blocks = []
            tool_use_blocks = []
            for block in final_msg.content:
                if hasattr(block, "text"):
                    text_blocks.append(block.text)
                elif hasattr(block, "type") and block.type == "tool_use":
                    tool_use_blocks.append(block)

            if text_blocks:
                final_response = "\n".join(text_blocks)

            if final_msg.stop_reason == "end_turn" or not tool_use_blocks:
                break

            history.append({"role": "assistant", "content": final_msg.content})

            tool_calls = [
                {"id": b.id, "name": b.name, "arguments": b.input}
                for b in tool_use_blocks
            ]

            for tc in tool_calls:
                callback({
                    "type": "tool_start",
                    "tool": tc["name"],
                    "label": self._tool_label(tc["name"]),
                })

            results = self._execute_tool_calls(tool_calls)

            history.append({
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": tid, "content": result_json}
                    for tid, _, result_json in results
                ],
            })

        return {"final_response": final_response, "messages": history}

    def _run_openai_streaming(self, messages: list, system: str, callback) -> Dict[str, Any]:
        """
        OpenAI-compatible conversation loop with streaming text tokens (OpenAI or OpenRouter).
        Calls callback(event_dict) for each SSE event.
        Returns the final result dict.
        """
        client = self._get_compat_client()
        tools = self._get_tool_schemas()

        history = list(messages)
        if system and not any(m.get("role") == "system" for m in history):
            history = [{"role": "system", "content": system}] + history

        final_response = ""

        for iteration in range(self.max_iterations):
            kwargs: dict = {
                "model": self.model,
                "messages": history,
                "stream": True,
            }
            if tools:
                kwargs["tools"] = tools
                kwargs["tool_choice"] = "auto"

            try:
                text_buffer = ""
                tool_calls_acc: dict = {}
                finish_reason = None

                stream = client.chat.completions.create(**kwargs)
                for chunk in stream:
                    choice = chunk.choices[0] if chunk.choices else None
                    if not choice:
                        continue
                    finish_reason = choice.finish_reason or finish_reason
                    delta = choice.delta
                    if delta.content:
                        callback({"type": "token", "content": delta.content})
                        text_buffer += delta.content
                    if delta.tool_calls:
                        for tc_delta in delta.tool_calls:
                            idx = tc_delta.index
                            if idx not in tool_calls_acc:
                                tool_calls_acc[idx] = {
                                    "id": tc_delta.id or "",
                                    "name": "",
                                    "arguments": "",
                                }
                            if tc_delta.id:
                                tool_calls_acc[idx]["id"] = tc_delta.id
                            if tc_delta.function:
                                if tc_delta.function.name:
                                    tool_calls_acc[idx]["name"] += tc_delta.function.name
                                if tc_delta.function.arguments:
                                    tool_calls_acc[idx]["arguments"] += tc_delta.function.arguments

            except Exception as exc:
                logger.error("OpenAI streaming error: %s", exc)
                callback({"type": "error", "message": f"API error: {exc}"})
                return {"final_response": f"API error: {exc}", "messages": history}

            if text_buffer:
                final_response = text_buffer

            tool_calls = list(tool_calls_acc.values())

            if not tool_calls or finish_reason == "stop":
                break

            history.append({
                "role": "assistant",
                "content": text_buffer or None,
                "tool_calls": [
                    {
                        "id": tc["id"],
                        "type": "function",
                        "function": {"name": tc["name"], "arguments": tc["arguments"]},
                    }
                    for tc in tool_calls
                ],
            })

            for tc in tool_calls:
                callback({
                    "type": "tool_start",
                    "tool": tc["name"],
                    "label": self._tool_label(tc["name"]),
                })

            results = self._execute_tool_calls(tool_calls)

            for tid, name, result_json in results:
                history.append({
                    "role": "tool",
                    "tool_call_id": tid,
                    "name": name,
                    "content": result_json,
                })

        return {"final_response": final_response, "messages": history}

    def run_conversation_streaming(
        self,
        user_message: str,
        callback,
        system_message: str = None,
        conversation_history: List[Dict] = None,
        **kwargs,
    ) -> Dict[str, Any]:
        """
        Streaming version of run_conversation().
        Calls callback(event_dict) for every event:
          {"type": "token", "content": "..."}      — text token from LLM
          {"type": "tool_start", "tool": "...", "label": "..."} — before tool runs
          {"type": "error", "message": "..."}      — on fatal error

        Returns the same {"final_response": str, "messages": list} dict as
        run_conversation() so callers can persist the session after streaming.
        """
        system = system_message or self.ephemeral_system_prompt or ""

        messages = list(conversation_history or [])
        messages.append({"role": "user", "content": user_message})

        if len(messages) > 40:
            from .context import compress_context
            messages = compress_context(messages, keep_recent=20)

        try:
            if self._provider == "anthropic":
                result = self._run_anthropic_streaming(messages, system, callback)
            else:
                result = self._run_openai_streaming(messages, system, callback)
        except Exception as exc:
            logger.error("Hermes streaming error: %s", exc, exc_info=True)
            callback({"type": "error", "message": str(exc)})
            result = {"final_response": f"I encountered an error: {exc}", "messages": messages}

        if self.session_db is not None and self.session_id:
            try:
                self.session_db.append_message(self.session_id, "user", user_message)
                self.session_db.append_message(self.session_id, "assistant", result["final_response"])
            except Exception as exc:
                logger.warning("Session DB write failed: %s", exc)

        # Emit a terminal event so the router can use the authoritative final
        # response (as persisted) rather than re-assembling it from token shards.
        # This avoids mismatch between pre-tool intermediate tokens and the actual answer.
        callback({"type": "_agent_done", "final_response": result["final_response"]})

        return result

    def __del__(self):
        try:
            self._executor.shutdown(wait=False, cancel_futures=True)
        except Exception:
            pass
