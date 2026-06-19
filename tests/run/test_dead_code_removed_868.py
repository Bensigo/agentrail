"""Acceptance test — issue #868: dead-code removal (Red-Green Proof, ADR 0008).

THIS TEST IS INTENTIONALLY RED BEFORE IMPLEMENTATION.

Two symbols in ``agentrail.run.routing`` are provably unused in production:

- ``escalate_on_failure`` — confirmed 0 production callers via
  ``agentrail context callers escalate_on_failure``.  The heartbeat runner
  (``agentrail/heartbeat/runtime.py``) composes the same logic inline using
  ``budget_leash.check`` + ``routing.next_tier`` + ``compaction.build``
  directly (lines 383–403 of runtime.py); it never delegates to this function.

- ``EscalationOutcome`` — the frozen dataclass return-type for
  ``escalate_on_failure``; with that function dead it has no production
  purpose.  Confirmed 0 production callers via
  ``agentrail context callers EscalationOutcome``.

Both symbols currently exist in ``agentrail.run.routing``, so the assertions
below FAIL today.  After the Implementer removes the dead code and its
companion test file (``tests/run/test_escalate_routing.py``), both assertions
PASS, proving a genuine red→green trail (AC "Every removed symbol/file is
provably unused").

The live parts of ``routing.py`` that MUST remain (the test does not touch
them but removal would break the build):
- ``next_tier`` — imported by ``agentrail/heartbeat/runtime.py:47``
- ``routing_record`` / ``_apply_routing`` / ``classify`` — imported by
  ``agentrail/cli/commands/cost.py:25``
"""
from __future__ import annotations

import importlib
import pytest


def test_escalate_on_failure_and_escalation_outcome_removed():
    """The escalation-composition helpers must be gone after dead-code removal.

    Evidence they are dead:
    - ``agentrail context callers escalate_on_failure`` → []
    - ``agentrail context callers EscalationOutcome`` → []
    - ``agentrail/heartbeat/runtime.py`` does NOT import or call either symbol;
      it calls ``budget_leash.check``, ``routing.next_tier``, and
      ``compaction.build`` directly (runtime.py lines 383-403).
    - Only reference is ``tests/run/test_escalate_routing.py`` — a test-only
      reference, which itself must be removed per the issue AC.

    This test FAILS now (symbols exist); it PASSES once the Implementer
    deletes them (and the companion test file that tested them).
    """
    routing = importlib.import_module("agentrail.run.routing")

    assert not hasattr(routing, "escalate_on_failure"), (
        "escalate_on_failure is dead code (0 production callers; heartbeat/runtime.py "
        "composes the same logic inline). It must be removed as part of issue #868."
    )
    assert not hasattr(routing, "EscalationOutcome"), (
        "EscalationOutcome is the return type for escalate_on_failure; with that function "
        "removed it serves no production purpose. It must be removed as part of issue #868."
    )
