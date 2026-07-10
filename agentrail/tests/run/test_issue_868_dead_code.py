"""Acceptance test for issue #868 — dead-code removal (Red-Green Proof).

This test is authored by the TEST-AUTHOR role (ADR 0008) and must remain
RED before the Implementer acts.

## What it tests

`escalate_on_failure` and `EscalationOutcome` in `agentrail.run.routing`
have zero production callers:

  $ agentrail context callers escalate_on_failure   # → (empty)
  $ agentrail context callers EscalationOutcome     # → only routing.py itself

`agentrail/heartbeat/runtime.py` — the only production code that does the
cheap→strong escalation — calls `budget_leash.check`, `next_tier`, and
`compaction.build` **directly**, never through `escalate_on_failure`.
The composed helper was built in M036 but the live caller was written inline.

## Acceptance criteria encoded (issue #868 AC #1)

Every removed symbol is provably unused: no importers, no test references,
not a CLI dispatch target, not an API route, and not referenced dynamically.

## Red-Green proof

RED  (before implementation): both symbols exist in routing.py → assertions fail.
GREEN (after implementation): Implementer removes `escalate_on_failure` and
`EscalationOutcome` from routing.py, removes their test coverage from
`tests/run/test_escalate_routing.py`, and verifies the suite is green.
"""
from __future__ import annotations

import importlib

import pytest


def test_dead_escalate_on_failure_and_outcome_removed() -> None:
    """escalate_on_failure and EscalationOutcome must not exist in routing.

    Evidence of zero production callers (issue #868 AC #1):
      - `agentrail context callers escalate_on_failure` returns nothing.
      - `agentrail context callers EscalationOutcome` returns only lines
        inside routing.py itself (within the dead function body).
      - `agentrail/heartbeat/runtime.py` calls budget_leash.check,
        next_tier, and compaction.build directly — never escalate_on_failure.

    This test is RED right now (both symbols exist) and must stay RED until
    the Implementer removes them. A passing test before removal would be
    tautological and is rejected per ADR 0008.
    """
    routing = importlib.import_module("agentrail.run.routing")

    assert not hasattr(routing, "escalate_on_failure"), (
        "escalate_on_failure has zero production callers "
        "(`context callers escalate_on_failure` → empty); "
        "the heartbeat runtime duplicates this logic inline. "
        "Remove it from agentrail/run/routing.py."
    )
    assert not hasattr(routing, "EscalationOutcome"), (
        "EscalationOutcome is only constructed inside escalate_on_failure, "
        "which itself has zero production callers. "
        "Remove it from agentrail/run/routing.py."
    )
