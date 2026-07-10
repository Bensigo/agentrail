"""Tests for the tier-step helper in agentrail/run/routing.py.

``escalate_on_failure`` and ``EscalationOutcome`` were removed in issue #868
(zero production callers — the live escalation loop in
``agentrail/heartbeat/runtime.py`` calls ``budget_leash.check``,
``routing.next_tier``, and ``compaction.build`` directly). Only ``next_tier``
tests remain.
"""
from __future__ import annotations

from agentrail.afk.queue_state import Tier
from agentrail.run.routing import next_tier


# ---------------------------------------------------------------------------
# next_tier — the pure tier step used by the live escalation loop
# ---------------------------------------------------------------------------

def test_next_tier_steps_cheap_to_strong() -> None:
    assert next_tier(Tier.CHEAP) is Tier.STRONG


def test_next_tier_at_max_returns_none() -> None:
    # STRONG is the maximum tier — there is no tier above it to escalate to.
    assert next_tier(Tier.STRONG) is None
