"""
Noah-native Hermes AI Agent engine.

Source: NousResearch/hermes-agent (MIT License)
  https://github.com/nousresearch/hermes-agent

VENDORED UPSTREAM FILES (copied verbatim or with minimal import adaptations)
-----------------------------------------------------------------------------
  hermes_constants.py      — 295 lines, verbatim
  hermes_state.py          — 2094 lines, 3 adaptations:
                               relative imports, inline sanitize_context,
                               DEFAULT_DB_PATH → ~/.noah/hermes.db
  hermes_logging.py        — 389 lines, 1 adaptation (relative import)
  run_agent.py             — 13,806+ lines, adaptation: relative imports
  model_tools.py           — model/tool routing, adaptation: relative imports
  toolsets.py              — toolset definitions, adaptation: relative imports
  utils.py                 — utility helpers, adaptation: relative imports
  trajectory_compressor.py — context compression, adaptation: relative imports
  agent_upstream/          — full upstream agent/ subdirectory, relative imports

Note: Some upstream functionality requires optional packages not installed in
Noah's backend (exa-py, firecrawl-py, hermes_cli). Features depending on those
packages will raise ImportError when called. Core Hermes orchestration
(run_agent.py:run_conversation, hermes_state.SessionDB) works with installed deps.

NOAH-NATIVE ENGINE (wraps upstream, runs without optional deps)
---------------------------------------------------------------
  agent.py     — AIAgent: Noah-embedded orchestrator using upstream patterns
                 run_agent.py:9186 → agent.py:_run_tools_parallel (ThreadPoolExecutor)
                 run_agent.py:257  → agent.py:max_iterations cap
                 run_agent.py:10089→ agent.py:run_conversation
  context.py   — turn pruning (trajectory_compressor.py pattern)
  tools.py     — 11 Noah tools + save_memory (Firestore bridge)
                 run_shell/write_file: desktop-proxy stubs on server
                 (NOAH_DESKTOP_LOCAL=1 enables local execution)

DEPENDENCIES ADDED FOR HERMES EMBEDDING
-----------------------------------------
  fire>=0.7.0  — required by run_agent.py CLI entry point

Usage:
    from hermes import AIAgent
    agent = AIAgent(model="claude-opus-4-20250514", quiet_mode=True)
    response = agent.run_conversation(user_message="Search for the latest AI news")
"""

from .agent import AIAgent

__all__ = ["AIAgent"]
