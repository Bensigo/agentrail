"""Unit tests for the Heartbeat prerequisite-presence gate (AC3).

Behavior-only tests through the public interface. Vocabulary matches CONTEXT.md:
the **Heartbeat** is the capstone — it is enabled only after the Objective Gate,
the Budget Leash, and the security guardrail exist. The gate is a pure check for
the *presence/availability* of those three capabilities; if any is absent the
heartbeat stays OFF. The capability set is injectable so the check is testable
without depending on which prerequisite modules happen to be merged yet.
"""
from agentrail.heartbeat.gate import (
    REQUIRED_CAPABILITIES,
    Capability,
    detect_capabilities,
    heartbeat_enabled,
)


def test_disabled_when_no_capabilities_present():
    # No prerequisite present → the heartbeat is gated OFF.
    assert heartbeat_enabled(frozenset()) is False


def test_disabled_when_budget_leash_missing():
    # AC3: the budget leash (#779) is not yet merged, so even with the gate and
    # the security guardrail present the heartbeat stays OFF.
    present = frozenset({Capability.OBJECTIVE_GATE, Capability.SECURITY_GUARDRAIL})
    assert heartbeat_enabled(present) is False


def test_enabled_only_when_all_three_present():
    # The capstone turns ON exactly when gate + budget + security are all present.
    assert heartbeat_enabled(REQUIRED_CAPABILITIES) is True


def test_required_capabilities_are_gate_budget_security():
    # The three capstone prerequisites named in CONTEXT.md / the milestone.
    assert REQUIRED_CAPABILITIES == frozenset(
        {
            Capability.OBJECTIVE_GATE,
            Capability.BUDGET_LEASH,
            Capability.SECURITY_GUARDRAIL,
        }
    )


def test_detect_reflects_present_prerequisite_modules():
    # The Objective Gate and the security guardrail modules are merged today;
    # detection must see them.
    present = detect_capabilities()
    assert Capability.OBJECTIVE_GATE in present
    assert Capability.SECURITY_GUARDRAIL in present


def test_heartbeat_currently_off_because_budget_leash_unmerged():
    # AC3, grounded in the real repo: the Budget Leash (#779) module does not
    # exist yet, so the detected capability set keeps the heartbeat OFF. When
    # #779 lands, detection will include it and this assertion flips ON — no
    # change to gate.py required.
    present = detect_capabilities()
    if Capability.BUDGET_LEASH in present:
        # #779 has merged: the capstone is now correctly enabled.
        assert heartbeat_enabled(present) is True
    else:
        assert heartbeat_enabled(present) is False
