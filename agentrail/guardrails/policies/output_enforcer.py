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

import os
import re
from dataclasses import dataclass
from typing import Union

from agentrail.guardrails.base import Verdict
from agentrail.guardrails.registry import register

# Matches the hunk header of a unified diff, e.g. "@@ -1,20 +1,21 @@"
_HUNK_HEADER_RE = re.compile(r"^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@", re.MULTILINE)

# A unified-diff body line: an added (+...) / removed (-...) line, a context line
# (exactly ONE leading space then content — NOT deeper-indented source, which has
# >=2 leading spaces), a blank context line, or a file/hunk/git-diff header.
# Anything else is "full-file" content a real diff-style edit would not emit. Used
# ONLY by the STRICT diff-dominance check (default OFF) to catch a full-file
# rewrite padded with a token hunk. Distinguishing a one-space context line from
# multi-space-indented source is what makes the heuristic discriminate at all.
_DIFF_BODY_LINE_RE = re.compile(
    r"^(?:"
    r"@@|---|\+\+\+|diff |index |new file|deleted file|rename |similarity "  # headers
    r"|[+\-](?![+\-])"   # +added / -removed (but not the ++/-- file headers)
    r"| (?! )"            # context line: exactly one leading space, then non-space
    r")"
)

# STRICT mode is OFF unless the eval harness / an opt-in run sets this to "1".
# Mirrors the DEFAULT-OFF idiom of ``bestofn_testfirst_enabled`` in
# ``agentrail/run/pipeline.py``: ABSENT or any non-"1" value (a typo'd flag
# included) keeps today's "any hunk header anywhere → Accepted" behavior, so
# merging this can NEVER tighten the live autonomous loop unless someone
# explicitly turns it on. The pure policy reads only ``os.environ`` (no
# agent-framework import), preserving the AC3 purity contract above.
_STRICT_FLAG = "AGENTRAIL_EVAL_LAYER_DIFF_ONLY_STRICT"

# When STRICT is on, content is treated as a probable full-file rewrite only when
# BOTH hold:
#   * it is large enough that emitting it whole is what actually costs the output
#     tokens (small files have no meaningful diff savings — never penalize them);
#   * diff body lines are a small fraction of it (a token hunk glued onto a
#     full-file dump rather than a genuine patch).
# Thresholds are deliberately lenient so a real large multi-hunk patch (mostly
# +/-/context lines) is never flagged.
_STRICT_MIN_LINES = 40
_STRICT_MIN_DIFF_RATIO = 0.5


def diff_only_strict_enabled() -> bool:
    """Is the STRICT diff-dominance check ON for this run? DEFAULT OFF.

    Only an explicit ``AGENTRAIL_EVAL_LAYER_DIFF_ONLY_STRICT="1"`` enables it.
    ABSENT or any other value keeps the loose, "any hunk header anywhere"
    behavior, so the live loop is byte-identical to before this change.
    """
    return os.environ.get(_STRICT_FLAG) == "1"


def _is_diff_dominant(content: str) -> bool:
    """Pure heuristic: does *content* read as a genuine patch rather than a
    full-file rewrite with a token hunk stapled on?

    Returns ``True`` ("looks like a real diff — leave it alone") when the content
    is small, or when diff body lines (``+``/``-``/`` ``/headers) make up at least
    :data:`_STRICT_MIN_DIFF_RATIO` of the non-blank lines. Returns ``False`` only
    for a LARGE blob that is mostly non-diff content despite containing a hunk
    header — the loophole this closes.
    """
    nonblank = [ln for ln in content.splitlines() if ln.strip()]
    if len(nonblank) < _STRICT_MIN_LINES:
        # Too small for diff savings to matter; never penalize.
        return True
    diff_lines = sum(1 for ln in nonblank if _DIFF_BODY_LINE_RE.match(ln))
    return (diff_lines / len(nonblank)) >= _STRICT_MIN_DIFF_RATIO


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

    Strict mode (default OFF)
    -------------------------
    When :func:`diff_only_strict_enabled` is on, a hunk header is no longer
    sufficient on its own: a LARGE blob that is mostly non-diff content with a
    token hunk stapled on (a full-file rewrite dressed up as a patch — the real
    cost leak) is also rejected. A genuine large multi-hunk patch still passes.
    With strict mode OFF (the live loop), behavior is unchanged.
    """
    if is_new_or_rename:
        return Accepted()

    if _HUNK_HEADER_RE.search(content):
        # Loose default: any hunk header anywhere accepts (unchanged behavior).
        # Strict (opt-in): also require the content to be diff-DOMINANT, so a
        # full-file dump padded with a token hunk no longer slips through.
        if not diff_only_strict_enabled() or _is_diff_dominant(content):
            return Accepted()
        return Rejected(
            reason=(
                "Full-file rewrite disguised as a diff: a unified-diff hunk header "
                "(@@ ... @@) is present, but the output is mostly full-file content, "
                "not diff (+/-/context) lines.  Emit ONLY the changed hunks as a "
                "unified diff/patch — do not paste the whole file.  Full content is "
                "only accepted for new files or renames."
            )
        )

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
    framework_neutral: bool = True  # pure policy; imports no agent framework

    def evaluate(self, **kwargs: object) -> Verdict:
        content = kwargs.get("content", "")
        is_new_or_rename = bool(kwargs.get("is_new_or_rename", False))
        result = enforce(str(content), is_new_or_rename=is_new_or_rename)
        if isinstance(result, Rejected):
            return Verdict.failing(result.reason)
        return Verdict.passing()


# Register the singleton instance at import time so `list_guardrails()` sees it.
OUTPUT_ENFORCER_GUARDRAIL = register(OutputEnforcerGuardrail())
