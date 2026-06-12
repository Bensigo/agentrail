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
    caller. ``render_state_summary`` returns ``""`` when ``.agentrail/state.json``
    is absent; mirroring the legacy ``prompt_common_header``, this function then
    emits the ``- AgentRail state: not found at .agentrail/state.json`` line so the
    prompt always announces whether state was found.

    The returned string ends with the state block + ``"\\n"`` mirroring the legacy
    ``echo`` that follows the state summary block.
    """
    # Legacy parity (prompt_common_header): print the state summary when present,
    # otherwise the explicit not-found line. A blank summary means no state.json.
    state_block = state_summary if state_summary else (
        "- AgentRail state: not found at .agentrail/state.json"
    )
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
        f"{state_block}\n"
    )


def format_skill_resolution(
    resolution: dict[str, Any],
    mode: str = "prompt",
    engine: str = "codex",
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

    When *engine* is ``"claude"`` and skills are resolved, returns a single-line
    block instructing the model to invoke installed Claude Code skills rather than
    reading SKILL.md files in full (lazy-loading token win).  All other cases use
    the legacy "Read these SKILL.md files" block.

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
    elif engine == "claude":
        # Claude Code lazy-loads skills from .claude/skills/; no need to read files.
        lines.append(
            "Project skills are installed and load on demand — "
            "invoke them; do not paste their contents"
        )
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


# ---------------------------------------------------------------------------
# Task 2b — issue prompt builders
# ---------------------------------------------------------------------------

_CODEX_TASK_BLOCK = """\
Run one bounded AgentRail issue execution for exactly one GitHub issue: #{issue}.

Use these local instructions:
- templates/docs/agents/ralph-loop.md when running from the AgentRail source repo
- docs/agents/ralph-loop.md when running from an installed target repo
- repo-local implementation skills such as tdd when they match the work

Hard limits:
- Handle only issue #{issue}.
- Read the issue body, comments, labels, and linked PRD or milestone before editing.
- Read CONTEXT.md, TASTE.md if present, and relevant project memory.
- Run agentrail memory recall for the issue title and key terms when available.
- If starting or resuming execution yourself, use agentrail run issue {issue}; AgentRail invokes Ralph internally during the execute phase.
- Implement the smallest coherent change that satisfies the issue acceptance criteria.
- Run relevant verification.
- Open or update one PR linked to #{issue}.
- Include summary, acceptance criteria coverage, verification, visual evidence, memory updates, and risks in the PR body.
- Stop when the PR is ready or when blocked.
"""

_CLAUDE_TASK_BLOCK = """\
Use Claude Code through AgentRail to run one bounded implementation loop for exactly one GitHub issue: #{issue}.

Use these local instructions when present:
- templates/docs/agents/ralph-loop.md or docs/agents/ralph-loop.md
- repo-local TDD and workflow docs under skills/ and docs/agents/

Hard limits:
- Handle only issue #{issue}.
- Read the issue body, comments, labels, and linked PRD or milestone before editing.
- Read CONTEXT.md, TASTE.md if present, and relevant project memory.
- Run agentrail memory recall for the issue title and key terms when available.
- If starting or resuming execution yourself, use agentrail run issue {issue}; AgentRail invokes Ralph internally during the execute phase.
- Implement the smallest coherent change that satisfies the issue acceptance criteria.
- Run relevant verification.
- Open or update one PR linked to #{issue}.
- Include summary, acceptance criteria coverage, verification, visual evidence, memory updates, and risks in the PR body.
- Stop when the PR is ready or when blocked.
"""


def issue_base_prompt(
    agent: str,
    issue: int,
    *,
    header: str,
    skill_block: str,
    context_summary: str,
    context_snippets: str,
) -> str:
    """Assemble the issue base prompt (legacy prompt_issue:4985-5046).

    header = common_header(...), skill_block = format_skill_resolution(...).
    """
    if agent == "codex":
        task_block = _CODEX_TASK_BLOCK.format(issue=issue)
    else:
        task_block = _CLAUDE_TASK_BLOCK.format(issue=issue)

    return (
        header
        + skill_block
        + context_summary
        + "\n\n"
        + context_snippets
        + "\n\n"
        + task_block
    )


_CODEX_GRILL_TASK_BLOCK = """\
Use the repo-local skill 'grill-with-docs'.

Goal:
Stress-test this idea before any PRD or implementation work:

{idea}

Instructions:
- Read CONTEXT.md first.
- Read TASTE.md if present.
- Run agentrail memory recall for the idea and key terms when available.
- Challenge vague users, outcomes, non-goals, constraints, domain terms, and risky assumptions.
- If a question can be answered from the repo, inspect the repo instead of asking.
- Ask one direct question at a time and include your recommended answer.
- Do not write implementation code.
"""

_CLAUDE_GRILL_TASK_BLOCK = """\
Use Claude Code to run a grill-with-docs style planning pass. If skills/grill-with-docs/SKILL.md exists, read it and follow its workflow as local project instructions.

Goal:
Stress-test this idea before any PRD or implementation work:

{idea}

Instructions:
- Read CONTEXT.md first.
- Read TASTE.md if present.
- Run agentrail memory recall for the idea and key terms when available.
- Challenge vague users, outcomes, non-goals, constraints, domain terms, and risky assumptions.
- If a question can be answered from the repo, inspect the repo instead of asking.
- Ask one direct question at a time and include your recommended answer.
- Do not write implementation code.
"""


def grill_prompt(agent: str, idea: str, *, header: str) -> str:
    """Port of legacy prompt_grill. header = common_header(...). Agent-specific
    grill task block (codex vs claude)."""
    if agent == "codex":
        task_block = _CODEX_GRILL_TASK_BLOCK.format(idea=idea)
    else:
        task_block = _CLAUDE_GRILL_TASK_BLOCK.format(idea=idea)
    return header + task_block


_CODEX_REVIEW_TASK_BLOCK = """\
Review exactly one pull request: #{pr}.

Use these local instructions:
- templates/docs/agents/pr-review.md when running from the AgentRail source repo
- docs/agents/pr-review.md when running from an installed target repo

Hard limits:
- Review only PR #{pr}.
- Compare the PR head branch against its base branch.
- Read the PR body, linked issue, milestone, PRD, CONTEXT.md, TASTE.md if present, and relevant project memory.
- Run agentrail memory recall for the PR title, linked issue, and key terms when available.
- If generating this review prompt outside the current session, use agentrail prompt review {pr}.
- Inspect resolved skill evidence when available in the PR body or AgentRail run logs, including resolved-skills metadata; absence of this evidence does not mean the implementation is invalid.
- Do not edit files, commit, push, close, or merge anything.
- Return findings first, ordered by severity with concrete file and line references.
- Call out missing acceptance criteria coverage, missing verification, and missing visual evidence when relevant.
"""

_CLAUDE_REVIEW_TASK_BLOCK = """\
Use Claude Code to review exactly one pull request: #{pr}.

Use these local instructions when present:
- templates/docs/agents/pr-review.md or docs/agents/pr-review.md
- repo-local review and visual evidence docs under docs/agents/

Hard limits:
- Review only PR #{pr}.
- Compare the PR head branch against its base branch.
- Read the PR body, linked issue, milestone, PRD, CONTEXT.md, TASTE.md if present, and relevant project memory.
- Run agentrail memory recall for the PR title, linked issue, and key terms when available.
- If generating this review prompt outside the current session, use agentrail prompt review {pr}.
- Inspect resolved skill evidence when available in the PR body or AgentRail run logs, including resolved-skills metadata; absence of this evidence does not mean the implementation is invalid.
- Do not edit files, commit, push, close, or merge anything.
- Return findings first, ordered by severity with concrete file and line references.
- Call out missing acceptance criteria coverage, missing verification, and missing visual evidence when relevant.
"""


def review_prompt(
    agent: str,
    pr: int,
    *,
    header: str,
    context_summary: str,
    context_snippets: str,
) -> str:
    """Port of legacy prompt_review. Assembles header + context_summary + '\\n\\n' +
    context_snippets + '\\n\\n' + agent-specific review task block (codex vs claude)."""
    if agent == "codex":
        task_block = _CODEX_REVIEW_TASK_BLOCK.format(pr=pr)
    else:
        task_block = _CLAUDE_REVIEW_TASK_BLOCK.format(pr=pr)
    return (
        header
        + context_summary
        + "\n\n"
        + context_snippets
        + "\n\n"
        + task_block
    )


def issue_run_phase_prompt(
    phase: str,
    issue: int,
    *,
    issue_context: str,
    base_prompt: str,
    context_summary: str,
    plan_output: str = "",
    verifier_findings_text: str = "",
    execution_attempt: int = 1,
    max_execution_attempts: int = 5,
) -> str:
    """Plan/execute phase prompt (legacy issue_run_phase_prompt:5910-5989).

    Raises ValueError for unknown phase.
    """
    if phase == "plan":
        return (
            "This is phase 1 of 2: plan.\n"
            "\n"
            "Issue context:\n"
            f"{issue_context}\n"
            "\n"
            "Phase context pack:\n"
            f"{context_summary}\n"
            "\n"
            "Base Ralph instructions:\n"
            f"{base_prompt}\n"
            "\n"
            "Produce a durable implementation plan before code changes. Include these headings exactly:\n"
            "- Goal\n"
            "- Non-goals\n"
            "- Acceptance criteria mapping\n"
            "- Expected files/areas\n"
            "- Required skills\n"
            "- Verification commands\n"
            "- Risks\n"
            "\n"
            "Do not edit files in this phase."
        )

    if phase == "execute":
        bounded_plan = bounded_phase_text(plan_output, "approved plan output")

        # Build the optional findings block — mirrors legacy $(if ... fi) in the heredoc.
        # When non-empty, inserts the findings text between the surrounding blank lines.
        if verifier_findings_text:
            findings_segment = (
                "Verifier findings from previous failed verify attempt:\n"
                f"{verifier_findings_text}\n"
                "\n"
                "Use these findings as focused input for this execute attempt. "
                "Address only the issue-scoped gaps needed to make verification pass."
            )
        else:
            findings_segment = ""

        # Ralph one-issue execution limits — folded in from the legacy
        # templates/scripts/ralph-loop heredoc preamble. Only the framing that
        # is NOT already carried by the base task block (_CLAUDE_TASK_BLOCK /
        # _CODEX_TASK_BLOCK) or the execute tail is included here, to avoid
        # duplicating hard limits the base prompt already states.
        ralph_preamble = (
            "Ralph one-issue execution limits:\n"
            f"- Handle exactly one issue: #{issue}. Do not continue into unrelated issues.\n"
            "- Read CONTEXT.md and docs/agents/ralph-loop.md before editing.\n"
            "- Run memory recall for the issue title and key terms before editing when available.\n"
            "- Treat project memory as advisory; verify it against current code, docs, issue, PRD, and ADRs.\n"
            "- Preserve existing user changes.\n"
            "- Implement the smallest coherent change that satisfies the issue, then run relevant verification.\n"
            "- In the PR body, map every acceptance criterion to implementation and verification evidence.\n"
            "- Stop when the PR is ready or when blocked.\n"
            "\n"
        )

        # Core body up through base_prompt
        body = (
            ralph_preamble
            + "This is phase 2 of 2: execute.\n"
            f"Execution attempt: {execution_attempt} of {max_execution_attempts}.\n"
            "\n"
            "Issue context:\n"
            f"{issue_context}\n"
            "\n"
            "Phase context pack:\n"
            f"{context_summary}\n"
            "\n"
            "Approved plan from the plan phase:\n"
            f"{bounded_plan}\n"
            "\n"
            "Base Ralph instructions:\n"
            f"{base_prompt}\n"
            "\n"
        )

        # The legacy heredoc has: blank line, then $(if ... fi), then blank line.
        # When findings is non-empty the $() expands to findings text (no surrounding
        # extra newlines beyond what's in the FINDINGS heredoc itself).
        # When findings is empty the $() expands to "" leaving the blank line before
        # plus the blank line after — but we need to add extra blank lines to match
        # the legacy empty $() slot expansion which leaves 3 blank lines total.
        if findings_segment:
            body += findings_segment + "\n\n"
        else:
            # Legacy empty $(if...fi) slot → 3 blank lines between base_prompt and AgentRail
            body += "\n\n"

        body += (
            "AgentRail will invoke the Ralph one-issue executor for this phase and capture its output under this run directory.\n"
            f"Ralph must implement the approved plan only, keep the work scoped to issue #{issue}, and run relevant verification when implementation is ready."
        )

        return body

    raise ValueError(f"unknown issue run phase: {phase}")
