"""Output-format enforcement guardrail — PURE policy (no file/network I/O).

Migrated verbatim (decision semantics unchanged) from
``agentrail/run/output_enforcer.py`` for issue #918.  Rejects full-file rewrites
of existing files; accepts diff/patch edits and any content for new files or
renames.

What lives here (pure)
----------------------
* :func:`enforce` — the pure predicate: ``content`` + ``is_new_or_rename`` →
  :class:`Accepted` / :class:`Rejected`.  No I/O.
* :class:`Accepted` / :class:`Rejected` — the original result types, preserved
  byte-for-byte so every existing caller (and the back-compat shim) keeps its
  ``isinstance`` checks.
* :func:`all_changes_new_or_rename` — pure classifier over
  ``git status --porcelain`` *text* (the caller runs git; this only parses).
* :class:`OutputEnforcerGuardrail` — the seam adapter: wraps :func:`enforce`
  behind the :class:`~agentrail.guardrails.base.Guardrail` protocol, mapping
  ``Accepted -> Verdict.PASS`` and ``Rejected -> Verdict.FAIL`` (blocking).

What deliberately does NOT live here
------------------------------------
``push_format_rejection_event`` performs network I/O (event push).  Per AC3 the
policy must be pure, so that function stays in ``agentrail/run/output_enforcer.py``
(the I/O layer).  Importing this module pulls in no ``subprocess``/``gh``/``git``/
``pytest`` and no networking.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Union

from agentrail.guardrails.base import Verdict
from agentrail.guardrails.registry import register

# Matches the hunk header of a unified diff, e.g. "@@ -1,20 +1,21 @@"
_HUNK_HEADER_RE = re.compile(r"^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@", re.MULTILINE)


# ---------------------------------------------------------------------------
# Result types (unchanged from the original module)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Accepted:
    """The content passed enforcement (diff/patch, or new-file/rename)."""


@dataclass(frozen=True)
class Rejected:
    """The content failed enforcement (full-file rewrite of an existing file)."""
    reason: str


EnforceResult = Union[Accepted, Rejected]


# ---------------------------------------------------------------------------
# Core enforcer (pure — no I/O)
# ---------------------------------------------------------------------------

def enforce(content: str, *, is_new_or_rename: bool = False) -> EnforceResult:
    """Return ``Accepted`` or ``Rejected`` for *content*.

    Parameters
    ----------
    content:
        The text to inspect — typically the agent's output for a single edit
        or the full phase output file.
    is_new_or_rename:
        ``True`` when the target file did not exist before (``git status A``) or
        is a rename (``git status R``).  Full content is always allowed for these.
    """
    if is_new_or_rename:
        return Accepted()

    if _HUNK_HEADER_RE.search(content):
        return Accepted()

    return Rejected(
        reason=(
            "Full-file rewrite of an existing file detected: no unified-diff hunk "
            "headers (@@ ... @@) found in the content.  Edit existing files with a "
            "diff/patch instead.  Full content is only accepted for new files or renames."
        )
    )


# ---------------------------------------------------------------------------
# Change classification (pure — parses `git status --porcelain` text)
# ---------------------------------------------------------------------------

def all_changes_new_or_rename(porcelain: str) -> bool:
    """Return ``True`` when *every* change in ``git status --porcelain`` output is a
    newly-added, renamed, copied, or untracked file — i.e. there is no edit to a
    pre-existing file for a diff to apply against.

    Drives ``enforce(..., is_new_or_rename=...)`` from real worktree state instead
    of a hardcoded flag, so AC3 (new files / renames accepted) actually fires and a
    new-files-only phase is not a false-positive rejection.  Empty input
    (no changes) → ``False``.
    """
    lines = [ln for ln in porcelain.splitlines() if ln.strip()]
    if not lines:
        return False
    for ln in lines:
        code = ln[:2]
        # ?? untracked; A added; R renamed; C copied (either index or worktree column)
        if code == "??" or code[0] in ("A", "R", "C") or code[1] in ("A", "R", "C"):
            continue
        return False  # an existing-file edit (M/D/T/U) is present → enforce diff
    return True


# ---------------------------------------------------------------------------
# Guardrail seam adapter (pure)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class OutputEnforcerGuardrail:
    """Adapts :func:`enforce` to the :class:`Guardrail` protocol.

    Blocking guardrail: a full-file rewrite of an existing file is a ``FAIL``.
    ``evaluate`` accepts the same inputs as :func:`enforce` and maps the result
    1:1 — ``Accepted -> PASS`` (no reasons), ``Rejected -> FAIL`` (its reason).
    """

    name: str = "output_enforcer"
    description: str = (
        "Rejects full-file rewrites of existing files; accepts diff/patch edits "
        "and any content for new files or renames."
    )
    blocking: bool = True

    def evaluate(self, **kwargs: object) -> Verdict:
        content = kwargs.get("content", "")
        is_new_or_rename = bool(kwargs.get("is_new_or_rename", False))
        result = enforce(str(content), is_new_or_rename=is_new_or_rename)
        if isinstance(result, Rejected):
            return Verdict.failing(result.reason)
        return Verdict.passing()


# Register the singleton instance at import time so `list_guardrails()` sees it.
OUTPUT_ENFORCER_GUARDRAIL = register(OutputEnforcerGuardrail())
