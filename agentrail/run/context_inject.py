"""Forced-context injection (Finding 2: "Forced context").

Retrieved context today is plain text concatenated onto the agent prompt on
stdin (see ``agentrail/run/pipeline.py`` and ``agentrail/run/prompts.py``): the
agent is *free to ignore it* and nothing re-asserts it every turn. This module
keeps that ONE context engine but additionally emits a per-engine **artifact**
into the run workdir that the agent's own machinery is forced to read every
turn / every session. The stdin prompt injection is unchanged and remains the
universal fallback — this artifact is strictly ADDITIVE.

The artifact written is agent-agnostic by dispatch on the engine string:

  * ``claude``  → a ``UserPromptSubmit`` hook in ``.claude/settings.json`` whose
    command echoes the context as ``hookSpecificOutput.additionalContext`` on
    every user turn (the docs-blessed per-turn injection point for headless
    ``claude -p``). The context body lives in ``.agentrail/context.md`` and a
    tiny shell shim ``.agentrail/hooks/forced-context.sh`` cats it into the JSON
    envelope, so the hook command stays robust to multi-line / quoted context.
    Refs: https://code.claude.com/docs/en/hooks ,
          https://code.claude.com/docs/en/settings

  * ``codex``   → ``AGENTS.md`` at the workdir (Git-root) — the file Codex CLI
    auto-reads before every task; there is no per-turn hook lever.
    Ref:  https://developers.openai.com/codex/guides/agents-md

  * ``cursor``  → ``.cursor/rules/agentrail-context.mdc`` with frontmatter
    ``alwaysApply: true`` (the current Project Rules format; legacy
    ``.cursorrules`` is superseded), so the rule is injected every session.
    Ref:  https://cursor.com/docs/rules

  * anything else → no-op (the stdin prompt injection remains the universal
    fallback and is never removed).

This whole module is gated behind a feature flag that DEFAULTS ON
(:func:`forced_context_enabled`). Eval data confirms the improvement is ready.
To disable, set ``AGENTRAIL_FORCED_CONTEXT="0"`` (env override) or set
``runners.forcedContext`` to ``false`` in ``.agentrail/config.json``.
When the flag is off, :func:`emit_forced_context` is a no-op and returns ``[]``.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, List

# Managed-block markers so AGENTS.md edits are idempotent and never clobber a
# user's own steering content (mirrors the .codex/config.toml managed block in
# agentrail/cli/commands/init_agent.py).
_AGENTS_START = "<!-- agentrail:forced-context:start -->"
_AGENTS_END = "<!-- agentrail:forced-context:end -->"

# Relative artifact paths (POSIX, relative to the run workdir).
CONTEXT_MD = ".agentrail/context.md"
CLAUDE_SETTINGS = ".claude/settings.json"
CLAUDE_HOOK_SCRIPT = ".agentrail/hooks/forced-context.sh"
AGENTS_MD = "AGENTS.md"
CURSOR_RULE = ".cursor/rules/agentrail-context.mdc"


def _read_run_config(workdir: Path) -> Dict[str, Any]:
    """Best-effort read of ``<workdir>/.agentrail/config.json`` (never raises)."""
    path = workdir / ".agentrail" / "config.json"
    if not path.exists():
        return {}
    try:
        loaded = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return False


def forced_context_enabled(workdir: Path) -> bool:
    """Is forced-context injection ON for this run? DEFAULT ON.

    Resolution order (first decisive wins):

    1. ``AGENTRAIL_FORCED_CONTEXT`` env var — an explicit override the eval
       harness / a developer can set. ``"1"``/``"true"``/``"on"`` → ON,
       ``"0"``/``"false"``/``"off"`` → OFF.
    2. ``runners.forcedContext`` in ``<workdir>/.agentrail/config.json`` — when
       present and non-null, its boolean value is used directly.
    3. Absent everywhere → ``True`` (ON). Eval data confirms this improvement is
       ready; every eval run benefits without manual flag-setting.
    """
    env = os.environ.get("AGENTRAIL_FORCED_CONTEXT")
    if env is not None and env.strip() != "":
        return _truthy(env)
    cfg = _read_run_config(workdir)
    runners = cfg.get("runners") if isinstance(cfg.get("runners"), dict) else {}
    fc = runners.get("forcedContext")
    if fc is None:
        return True  # DEFAULT ON
    return _truthy(fc)


def _normalise_engine(engine: str) -> str:
    """Map an engine/runner string to a known engine token, or "" if unknown.

    Accepts a bare name ("claude") or anything that *starts with* a known token
    (e.g. a full command string). Unknown → "" (caller treats as no-op).
    """
    name = (engine or "").strip().lower()
    for known in ("claude", "codex", "cursor"):
        if name == known or name.startswith(known):
            return known
    return ""


def _write_context_md(workdir: Path, context_text: str) -> Path:
    dest = workdir / CONTEXT_MD
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(context_text if context_text.endswith("\n") else context_text + "\n")
    return dest


def _context_body(context_text: str) -> str:
    """The human-readable context block embedded in AGENTS.md / .mdc artifacts."""
    return (
        "# AgentRail retrieved context (forced)\n\n"
        "The following context was retrieved by AgentRail's context engine for "
        "the current task. Treat it as authoritative grounding and consult it on "
        "every turn before acting.\n\n"
        f"{context_text.rstrip()}\n"
    )


def _emit_claude(workdir: Path, context_text: str) -> List[str]:
    """UserPromptSubmit hook → additionalContext, every turn (headless-valid)."""
    written: List[str] = []
    _write_context_md(workdir, context_text)
    written.append(CONTEXT_MD)

    # Tiny shim that emits the per-turn JSON envelope. Using a script (rather
    # than an inline command) keeps the settings.json command robust regardless
    # of how the context text is quoted/escaped. $CLAUDE_PROJECT_DIR is set by
    # Claude Code when running hooks, so the path is cwd-independent.
    script_dest = workdir / CLAUDE_HOOK_SCRIPT
    script_dest.parent.mkdir(parents=True, exist_ok=True)
    script_dest.write_text(
        "#!/usr/bin/env bash\n"
        "# AgentRail forced-context hook (UserPromptSubmit). Emits the retrieved\n"
        "# context as additionalContext on every user turn. Auto-generated; do\n"
        "# not edit — regenerated each run when forcedContext is enabled.\n"
        "set -euo pipefail\n"
        'ctx_file="${CLAUDE_PROJECT_DIR:-.}/.agentrail/context.md"\n'
        'if [ ! -f "$ctx_file" ]; then exit 0; fi\n'
        'ctx="$(cat "$ctx_file")"\n'
        "python3 - \"$ctx\" <<'PY'\n"
        "import json, sys\n"
        "ctx = sys.argv[1]\n"
        "print(json.dumps({\n"
        '    "hookSpecificOutput": {\n'
        '        "hookEventName": "UserPromptSubmit",\n'
        '        "additionalContext": ctx,\n'
        "    }\n"
        "}))\n"
        "PY\n"
    )
    script_dest.chmod(0o755)
    written.append(CLAUDE_HOOK_SCRIPT)

    settings_path = workdir / CLAUDE_SETTINGS
    settings: Dict[str, Any] = {}
    if settings_path.exists():
        try:
            loaded = json.loads(settings_path.read_text())
            if isinstance(loaded, dict):
                settings = loaded
        except (OSError, ValueError):
            settings = {}

    command = "$CLAUDE_PROJECT_DIR/.agentrail/hooks/forced-context.sh"
    hooks = settings.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        hooks = {}
        settings["hooks"] = hooks
    ups = hooks.setdefault("UserPromptSubmit", [])
    if not isinstance(ups, list):
        ups = []
        hooks["UserPromptSubmit"] = ups

    known_commands = {command, ".agentrail/hooks/forced-context.sh"}
    already_wired = any(
        isinstance(entry, dict)
        and isinstance(entry.get("hooks"), list)
        and any(
            isinstance(h, dict) and h.get("command") in known_commands
            for h in entry["hooks"]
        )
        for entry in ups
    )
    if not already_wired:
        ups.append({"hooks": [{"type": "command", "command": command}]})

    settings_path.parent.mkdir(parents=True, exist_ok=True)
    settings_path.write_text(json.dumps(settings, indent=2) + "\n")
    written.append(CLAUDE_SETTINGS)
    return written


def _emit_codex(workdir: Path, context_text: str) -> List[str]:
    """AGENTS.md managed block — the file Codex auto-reads before every task."""
    dest = workdir / AGENTS_MD
    block = f"{_AGENTS_START}\n{_context_body(context_text)}{_AGENTS_END}\n"

    existing = ""
    if dest.exists():
        try:
            existing = dest.read_text()
        except OSError:
            existing = ""

    if _AGENTS_START in existing and _AGENTS_END in existing:
        head, _, rest = existing.partition(_AGENTS_START)
        _, _, tail = rest.partition(_AGENTS_END)
        # Strip a single leading newline left on the tail after the end marker.
        tail = tail[1:] if tail.startswith("\n") else tail
        new_text = head + block + tail
    elif existing.strip():
        sep = "" if existing.endswith("\n") else "\n"
        new_text = existing + sep + "\n" + block
    else:
        new_text = block

    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(new_text)
    return [AGENTS_MD]


def _emit_cursor(workdir: Path, context_text: str) -> List[str]:
    """.cursor/rules/*.mdc with alwaysApply: true — injected every session."""
    dest = workdir / CURSOR_RULE
    dest.parent.mkdir(parents=True, exist_ok=True)
    frontmatter = (
        "---\n"
        "description: AgentRail retrieved context (forced into every turn)\n"
        "globs: \n"
        "alwaysApply: true\n"
        "---\n\n"
    )
    dest.write_text(frontmatter + _context_body(context_text))
    return [CURSOR_RULE]


def emit_forced_context(engine: str, workdir: Path, context_text: str) -> List[str]:
    """Emit the per-engine forced-context artifact into *workdir*.

    Returns the list of POSIX-relative artifact paths written (empty when the
    flag is off, the engine is unknown, or there is no context to inject).

    The caller is responsible only for the flag gate at the seam; this function
    re-checks the flag defensively so it is always safe to call.
    """
    workdir = Path(workdir)
    if not (context_text or "").strip():
        return []
    if not forced_context_enabled(workdir):
        return []

    known = _normalise_engine(engine)
    if known == "claude":
        return _emit_claude(workdir, context_text)
    if known == "codex":
        return _emit_codex(workdir, context_text)
    if known == "cursor":
        return _emit_cursor(workdir, context_text)
    # Unknown engine → no-op; the stdin prompt injection remains the fallback.
    return []
