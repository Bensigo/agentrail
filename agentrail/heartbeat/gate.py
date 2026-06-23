"""Heartbeat prerequisite-presence gate (AC3) — the capstone enablement check.

CONTEXT.md: the **Heartbeat** must not be "enabled before the Objective Gate,
budget cap, and accept-rate metric exist." This module answers one falsifiable
question — *are all three capstone prerequisites present?* — and nothing else.

It is a **deep module**: pure, no I/O, deterministic, unit-tested in isolation.
The check is over a *capability set* (the prerequisites that are present), which
is injectable so the heartbeat can be tested as ON or OFF without depending on
which prerequisite modules happen to be merged yet. The orchestrator builds the
real set by probing for the prerequisite modules via :func:`detect_capabilities`.

Today the **Budget Leash** (#779) is not yet merged, so the real capability set
is missing :attr:`Capability.BUDGET_LEASH` and the heartbeat is correctly OFF;
it auto-enables once that module lands — no code change here required.
"""
from __future__ import annotations

import importlib.util
from enum import Enum
from typing import FrozenSet


class Capability(str, Enum):
    """A capstone prerequisite the **Heartbeat** depends on (CONTEXT.md, ADR 0010)."""

    OBJECTIVE_GATE = "objective_gate"        # agentrail/run/objective_gate.py (shim → guardrails/policies/objective.py, #920)
    BUDGET_LEASH = "budget_leash"            # agentrail/run/budget_leash.py (#779)
    SECURITY_GUARDRAIL = "security_guardrail"  # agentrail/run/push_guardrail.py (#795)


# All three must be present for the capstone to turn ON.
REQUIRED_CAPABILITIES: FrozenSet[Capability] = frozenset(
    {
        Capability.OBJECTIVE_GATE,
        Capability.BUDGET_LEASH,
        Capability.SECURITY_GUARDRAIL,
    }
)


# Which importable module backs each capability. Used only by the impure
# :func:`detect_capabilities`; the pure :func:`heartbeat_enabled` never imports.
_CAPABILITY_MODULES = {
    Capability.OBJECTIVE_GATE: "agentrail.run.objective_gate",
    Capability.BUDGET_LEASH: "agentrail.run.budget_leash",
    Capability.SECURITY_GUARDRAIL: "agentrail.run.push_guardrail",
}


def heartbeat_enabled(present: FrozenSet[Capability]) -> bool:
    """Return whether the **Heartbeat** capstone is enabled (AC3). Pure.

    Enabled exactly when every prerequisite in :data:`REQUIRED_CAPABILITIES` is in
    the injected ``present`` set; if any (e.g. the Budget Leash) is absent the
    heartbeat stays OFF.
    """
    return REQUIRED_CAPABILITIES.issubset(present)


def detect_capabilities() -> FrozenSet[Capability]:
    """Probe for the prerequisite modules and return the ones that are present.

    Impure (touches the import system) but side-effect-free: it only asks whether
    each backing module is importable, never imports it. This is the edge that
    feeds the pure :func:`heartbeat_enabled`; tests inject a set directly instead.
    """
    return frozenset(
        cap
        for cap, module in _CAPABILITY_MODULES.items()
        if importlib.util.find_spec(module) is not None
    )
