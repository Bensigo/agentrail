"""Canonical task-family vocabulary (issue #1223).

A task's *family* names what KIND of software change it is — bug fix, new
capability, pure restructuring, test-only change, or build/tooling work.
This is orthogonal to the two axes the eval corpus already carries:

- ``difficulty`` (required-context scatter proxy — how HARD the task is), and
- ``taskKind`` (implement/abstain — whether an agent change is EXPECTED).

Family answers a different question: does a harness change that wins on the
corpus generalize across the *kinds* of work a real repo produces, or does it
only help on (say) bug fixes while quietly regressing on refactors? Without
this axis, family-level generalization is untested — only instance-level
held-out (the ``heldOut`` flag) is.

AgentRail's triage labels (``agentrail/cli/commands/labels.py``) are a
DIFFERENT concept — workflow state (queued/running/done/...) on a live issue
— and are deliberately NOT reused here; conflating the two would make one
label mean two unrelated things depending on where it appears.

Both the eval corpus (``agentrail.evals.corpus.loader``) and live runs
(``agentrail.observability.tracer`` + the ``runs`` Postgres table) tag
against this SAME fixed vocabulary, so a family label never means two
different things depending on where it was applied.
"""
from __future__ import annotations

from typing import Optional

# Fixed, deliberately small vocabulary. Chosen to cover the common SDLC task
# shapes without becoming an unbounded, ever-growing taxonomy:
#   bug      — fixing incorrect existing behavior
#   feature  — adding new capability
#   refactor — restructuring/consolidating existing code, no behavior change
#   test     — test-only changes (coverage, fixtures, harness)
#   infra    — build, CI, deploy, tooling, migrations
TASK_FAMILY_VALUES = ("bug", "feature", "refactor", "test", "infra")


def is_task_family(value: object) -> bool:
    """True iff ``value`` is one of the fixed vocabulary values.

    Deliberately accepts ``object`` (not just ``str``) so callers can probe an
    untrusted/optional value (e.g. ``record.get("family")``, a DB column read
    back as ``None``) without a separate ``isinstance`` guard at every call
    site.
    """
    return isinstance(value, str) and value in TASK_FAMILY_VALUES


def family_langfuse_tag(family: Optional[str]) -> Optional[str]:
    """The Langfuse trace tag for a task family, or ``None`` when unset/invalid.

    Pure function (issue #1223 AC4): given a family value, returns the exact
    tag string a Langfuse trace should carry (``"family:<value>"``), or
    ``None`` when the family is absent or not a recognized vocabulary value —
    callers never emit a malformed tag from a stray/typo'd value. Kept
    trivial and dependency-free so it is unit-testable in complete isolation
    from any real Langfuse client or network call.
    """
    if not is_task_family(family):
        return None
    return f"family:{family}"
