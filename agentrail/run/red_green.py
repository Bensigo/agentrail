"""The Red-Green Proof recorder — back-compat shim (issue #921).

The PURE policy moved to ``agentrail.guardrails.policies.red_green`` (the
framework-neutral guardrails package).  This module re-exports it so every
existing caller keeps working unchanged::

    from agentrail.run.red_green import Observation, Trail, verify_trail, gate_evidence

The decision semantics are identical — these names ARE the migrated policy's
objects (re-exported, not re-implemented), so ``isinstance`` checks across the old
and new import paths line up exactly.  No decision logic remains here (AC4).
"""
from __future__ import annotations

from agentrail.guardrails.policies.red_green import (  # noqa: F401
    Observation,
    Trail,
    gate_evidence,
    verify_trail,
)

__all__ = ["Observation", "Trail", "verify_trail", "gate_evidence"]
