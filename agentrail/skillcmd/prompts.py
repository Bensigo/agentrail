"""Pure seed-prompt builders for the skill-backed agent session.

No file or network I/O — every input is passed by the caller, so these are
trivially unit-testable. ``session.py`` reads the skill body and house-context
files off disk and hands the resolved strings here for framing.
"""
from __future__ import annotations

from typing import List, Tuple


def _section(title: str, body: str) -> str:
    """Render one fenced ``## title`` section. Empty body → ''."""
    body = body.strip()
    if not body:
        return ""
    return f"## {title}\n\n{body}\n"


def build_seed_prompt(
    skill_name: str,
    skill_body: str,
    context_files: List[Tuple[str, str]],
    input_refs: List[Tuple[str, str]],
) -> str:
    """Assemble the seed prompt handed to the agent.

    Layout (stable so tests can assert on it):

      1. A short framing line naming the skill the agent must follow.
      2. The skill body **verbatim** (the single source of truth — AC3).
      3. Each house-context file (``CONTEXT.md`` always, then ``TASTE.md``/ADRs)
         under its own ``## <label>`` section, body inlined verbatim.
      4. Each resolved input ref (plan path/text) under ``## Input: <label>``.

    ``context_files`` / ``input_refs`` are ``(label, body)`` pairs; entries with
    an empty body are skipped so a missing optional file never injects noise.
    """
    parts: List[str] = []
    parts.append(
        f"You are running the AgentRail house skill `{skill_name}`. The skill "
        "procedure below is authoritative — follow it exactly; do not "
        "re-derive or summarise it. The house context and inputs that follow "
        "are the material you apply it to."
    )

    skill_body = skill_body.strip("\n")
    if skill_body:
        parts.append(f"## Skill: {skill_name}\n\n{skill_body}\n")

    for label, body in context_files:
        section = _section(label, body)
        if section:
            parts.append(section)

    for label, body in input_refs:
        section = _section(f"Input: {label}", body)
        if section:
            parts.append(section)

    return "\n".join(parts).rstrip("\n") + "\n"
