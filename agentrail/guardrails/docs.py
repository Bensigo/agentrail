"""Render the guardrail inventory to markdown — the single source for the doc.

``docs/agents/guardrails.md`` is *generated*, never hand-edited, so it cannot
drift from the code.  Both this generator and ``agentrail guardrails list`` read
the same :func:`~agentrail.guardrails.registry.list_guardrails`, so registering a
new guardrail makes it appear in both with no other change (issue #922, AC2/AC3).

Pure: this module renders text from the registry and computes a path.  It does
*no* filesystem writes itself — the CLI hook (``guardrails docs --write``) owns
the one ``Path.write_text`` so the generator stays testable and side-effect-free.
"""
from __future__ import annotations

from pathlib import Path

from agentrail.guardrails.base import Guardrail
from agentrail.guardrails.registry import list_guardrails

#: Repo-relative location of the generated doc (committed; #922 AC2).
DOC_RELPATH = Path("docs/agents/guardrails.md")

_HEADER = """\
# Guardrails

<!-- GENERATED FILE — do not edit by hand.
     Regenerate with: `agentrail guardrails docs --write`
     Source of truth: agentrail/guardrails/registry.py (list_guardrails()). -->

AgentRail's guardrails implement the **Objective Gate**, **Review Gate**,
**Red-Green Proof**, and **Independent Verification** definitions of "done"
(see `CONTEXT.md`).  Agents operate under **Execution-Only Autonomy** and can
read this inventory to see which rules govern a run.

Every guardrail below is enumerated from the single registry
(`agentrail.guardrails.list_guardrails()`); the same list backs
`agentrail guardrails list`.

| Guardrail | Posture | Framework-neutral | What it checks |
| --- | --- | --- | --- |
"""


def _posture(g: Guardrail) -> str:
    return "blocking" if g.blocking else "advisory"


def _neutral(g: Guardrail) -> str:
    return "yes" if getattr(g, "framework_neutral", False) else "no"


def _escape_cell(text: str) -> str:
    """Make *text* safe for a single markdown table cell."""
    return text.replace("|", "\\|").replace("\n", " ").strip()


def render_doc() -> str:
    """Render the full ``guardrails.md`` body from the registry (deterministic)."""
    rows = []
    for g in list_guardrails():
        rows.append(
            f"| `{_escape_cell(g.name)}` | {_posture(g)} | {_neutral(g)} "
            f"| {_escape_cell(g.description)} |"
        )
    body = _HEADER + "\n".join(rows) + "\n"
    return body


def doc_path(repo_root: Path) -> Path:
    """Absolute path to the committed doc under *repo_root*."""
    return repo_root / DOC_RELPATH


def write_doc(repo_root: Path) -> Path:
    """Write the rendered doc under *repo_root* and return the path written."""
    path = doc_path(repo_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render_doc(), encoding="utf-8")
    return path
