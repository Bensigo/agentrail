"""Issue Input-Contract validator — the GATE on entry to the Issue Queue.

This is a **deep module** (verification-contract-architecture.md): pure logic, no
I/O, deterministic, unit-tested in isolation. It decides one falsifiable
question — *does this issue carry machine-checkable acceptance criteria?* — and
nothing else. It imports nothing from the pipeline, network, DB, or even
``queue_state``; the orchestrator wires this validator in front of
``queue_state.admit`` so an issue lacking machine-checkable AC never becomes a
``QueueEntry`` (CONTEXT.md: "an issue cannot enter the queue without
machine-checkable acceptance criteria").

What "machine-checkable" means here mirrors the ``verify``/check model in
``agentrail/run/check_runner.py``: an acceptance criterion is machine-checkable
when it can be turned into an objective, runnable check rather than a human
judgement call. In an issue body that means a **checkbox acceptance criterion**
(``- [ ] ...`` / ``- [x] ...``) under the issue's Acceptance-criteria section —
the same checkbox AC shape the house issue template produces. Prose alone ("it
should feel fast", "works well") is not machine-checkable: there is no objective
check the Objective Gate could run to falsify it, so the issue is rejected.

Interface (verification-contract-architecture.md):
``validate(issue_body) -> Validated | Rejected(missing_ac)``.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import FrozenSet, List, Union

from agentrail.afk.queue_state import QueueEntry, Tier


# The Acceptance-criteria section of an issue body (house template + this issue
# both use ``## Acceptance criteria``). Case-insensitive; tolerates 1–6 ``#`` and
# a trailing ``(...)``. Captures until the next heading or end of body.
_AC_SECTION = re.compile(
    r"(?im)^\#{1,6}\s*acceptance\s+criteria\b.*?\n(.*?)(?=^\#{1,6}\s|\Z)",
    re.S,
)

# A markdown checkbox line: ``- [ ] ...`` or ``- [x] ...`` (also ``*``/``+``).
_CHECKBOX = re.compile(r"(?im)^\s*[-*+]\s*\[[ xX]\]\s*(.+?)\s*$")


@dataclass(frozen=True)
class Validated:
    """The issue carries machine-checkable acceptance criteria → admit it.

    ``criteria`` is the list of checkbox AC texts found, in document order, so the
    orchestrator can echo what it accepted (and later map each to a check).
    """

    criteria: List[str] = field(default_factory=list)


@dataclass(frozen=True)
class Rejected:
    """The issue lacks machine-checkable acceptance criteria → keep it out.

    ``missing_ac`` is a human-readable reason for the rejection, suitable for a
    queue-admission audit line or a console rejection notice.
    """

    missing_ac: str


Result = Union[Validated, Rejected]


def _acceptance_section(body: str) -> str:
    """Return the issue body's Acceptance-criteria section text, or ``""``.

    Pure. Only the named section counts; checkboxes elsewhere in the body (e.g. a
    task list under "What to build") are not acceptance criteria.
    """
    match = _AC_SECTION.search(body or "")
    return match.group(1) if match else ""


def validate(issue_body: str) -> Result:
    """Decide whether an issue may enter the Issue Queue (pure).

    Returns :class:`Validated` when the issue's Acceptance-criteria section
    contains at least one machine-checkable (checkbox) criterion, else
    :class:`Rejected` with the reason. Pure: takes the issue body text, returns a
    plain result; the orchestrator does the I/O (fetching the body) and the queue
    wiring (only a Validated issue is handed to ``queue_state.admit``).
    """
    section = _acceptance_section(issue_body)
    if not section:
        return Rejected(
            missing_ac="no 'Acceptance criteria' section in the issue body"
        )
    criteria = [m.group(1).strip() for m in _CHECKBOX.finditer(section)]
    criteria = [c for c in criteria if c]
    if not criteria:
        return Rejected(
            missing_ac=(
                "Acceptance criteria are not machine-checkable: no checkbox "
                "criteria the Objective Gate could turn into runnable checks"
            )
        )
    return Validated(criteria=criteria)


def admit_to_queue(
    *,
    number: int,
    issue_body: str,
    tier: Tier = Tier.CHEAP,
    remaining_budget: int = 2,
    blocked_by: FrozenSet[int] = frozenset(),
) -> Union[QueueEntry, Rejected]:
    """The GATE: turn a validated issue into a fresh :class:`QueueEntry`.

    This is the single seam that enforces CONTEXT.md's rule — *an issue cannot
    enter the queue without machine-checkable acceptance criteria*. It runs the
    pure :func:`validate` and, only on :class:`Validated`, mints a ``QueueEntry``
    on the queue_state machine (it never duplicates that machine; the entry's
    initial state defaults to QUEUED, and the orchestrator then calls
    ``queue_state.admit`` to park it if blocked). A :class:`Rejected` issue gets
    no entry at all — the reason is returned so the caller can record why it was
    kept out.

    Pure: no I/O. The orchestrator fetches the body and the ``blocked_by`` set
    (e.g. via ``afk/github.parse_blocked_by``) and persists the result.
    """
    result = validate(issue_body)
    if isinstance(result, Rejected):
        return result
    return QueueEntry(
        number=number,
        tier=tier,
        remaining_budget=remaining_budget,
        blocked_by=blocked_by,
    )
