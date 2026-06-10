"""Pure string-builder functions that reproduce legacy agentrail bash prompt text.

No file/network I/O — all inputs are passed by the caller.

Legacy sources:
  bounded_phase_text  → scripts/agentrail-legacy:5887-5908
  common_header       → scripts/agentrail-legacy:4784-4811
  format_skill_resolution (prompt mode) → scripts/agentrail-legacy:976-991
"""
from __future__ import annotations

import os
from typing import Any


def bounded_phase_text(text: str, label: str = "phase text") -> str:
    """Truncate *text* to AGENTRAIL_PHASE_INLINE_MAX_CHARS (default 12000; 24000 if
    the env var is set but not a positive integer).

    Empty text → ''.
    Within limit → text unchanged.
    Over limit → first max_chars chars + a truncation note.
    """
    if not text:
        return ""

    raw = os.environ.get("AGENTRAIL_PHASE_INLINE_MAX_CHARS", "12000")
    max_chars = int(raw) if raw.isdigit() and int(raw) > 0 else 24000

    if len(text) <= max_chars:
        return text

    return (
        text[:max_chars]
        + f"\n\n[AgentRail truncated {label}: shown first {max_chars} of {len(text)} characters. "
        "See the phase output artifact for the full text.]"
    )


def common_header(agent: str, state_summary: str) -> str:
    """Reproduce legacy prompt_common_header text.

    *state_summary* is the already-rendered AgentRail-state block supplied by the
    caller (empty / "not found" handling is done upstream).

    The returned string ends with ``state_summary + "\\n"`` mirroring the legacy
    ``echo`` that follows the state summary block.
    """
    return (
        "You are working in an AgentRail-managed repository.\n"
        "\n"
        f"Agent target: {agent}\n"
        "\n"
        "Read these before acting:\n"
        "- CONTEXT.md\n"
        "- TASTE.md when present\n"
        "- relevant docs under docs/agents/\n"
        "- relevant project memory from agentrail memory recall\n"
        "\n"
        "Start with AgentRail CLI state:\n"
        "- agentrail status\n"
        "- agentrail resume\n"
        "\n"
        "AgentRail state summary:\n"
        f"{state_summary}\n"
    )


def format_skill_resolution(
    resolution: dict[str, Any],
    mode: str = "prompt",
) -> str:
    """Reproduce legacy print_skill_resolution output for mode='prompt'.

    *resolution* is shaped like::

        {
            "autoSkills": bool,
            "resolved": [
                {"name": str, "localPath": str, "reasons": [str, ...]},
                ...
            ],
        }

    Only ``mode='prompt'`` is supported; any other value raises NotImplementedError.
    The returned string always ends with a trailing blank line (``\\n``), mirroring
    the legacy ``console.log("")``.
    """
    if mode != "prompt":
        raise NotImplementedError(f"format_skill_resolution: unsupported mode {mode!r}")

    lines: list[str] = []

    if not resolution["resolved"]:
        lines.append("Resolved AgentRail skills:")
        if not resolution["autoSkills"]:
            lines.append("- Automatic skill resolution disabled.")
        lines.append("- No skills resolved.")
    else:
        lines.append("Resolved AgentRail skills:")
        lines.append(
            "Read these SKILL.md files before editing. "
            "If a resolved skill does not apply after inspection, "
            "report that in the PR or run notes."
        )
        for skill in resolution["resolved"]:
            lines.append(f"- {skill['name']}")
            lines.append(f"  path: {skill['localPath']}")
            for reason in skill["reasons"]:
                lines.append(f"  reason: {reason}")

    # Trailing blank line — mirrors legacy console.log("")
    lines.append("")

    return "\n".join(lines) + "\n"
