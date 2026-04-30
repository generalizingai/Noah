"""
Context compression for Noah's Hermes engine.

Architectural concept from NousResearch/hermes-agent agent/context_compressor.py (MIT):
  - Drop the oldest non-system turns when conversation history grows large
  - Always preserve system messages
  - Configurable "keep_recent" window

Simplified for Noah's desktop assistant use-case (no token counting needed
since we cap by turn count, which is fast and deterministic).
"""

from typing import Dict, List


def compress_context(messages: List[Dict], keep_recent: int = 20) -> List[Dict]:
    """
    Trim old conversation turns to stay within context limits.

    Strategy (from hermes context_compressor.py):
      1. Separate system messages (always preserved)
      2. Keep only the most recent `keep_recent` non-system turns
      3. Re-prepend system messages at the front

    Args:
        messages:    Full message history (role/content dicts)
        keep_recent: Number of recent non-system turns to preserve

    Returns:
        Trimmed message list with system messages intact.
    """
    system_msgs = [m for m in messages if m.get("role") == "system"]
    non_system = [m for m in messages if m.get("role") != "system"]

    if len(non_system) <= keep_recent:
        return messages

    dropped = len(non_system) - keep_recent
    trimmed = non_system[-keep_recent:]

    # Prepend a context-note so the model knows history was compressed
    if dropped > 0:
        note = {
            "role": "user",
            "content": f"[{dropped} earlier message(s) were trimmed to fit context limits]",
        }
        return system_msgs + [note] + trimmed

    return system_msgs + trimmed
