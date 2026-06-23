"""Guardrail policies.

Importing this subpackage imports every policy module, which registers each
guardrail into :mod:`agentrail.guardrails.registry` as a side effect.  A single
import therefore populates the registry with the full shipped set:

* ``output_enforcer``      (#918)
* ``proof_required``       (#919)
* ``push_guardrail``       (#921 — secret-scan / protected-branch)
* ``input_contract``       (#921 — AC-checkbox admission gate)
* ``red_green``            (#921 — Red-Green Proof trail)
* ``approval_gate``        (#921 — human merge-approval)
* ``sandbox_enforcement``  (#921 — in-sandbox context enforcement)
* ``check_runner``         (#921 — objective verification commands)
"""
from __future__ import annotations

from agentrail.guardrails.policies import output_enforcer  # noqa: F401  (registers on import)
from agentrail.guardrails.policies import proof_required  # noqa: F401  (registers on import)

# Order matters only for shared pure helpers: approval_gate imports push_guardrail's
# pure `_now_iso`, so push_guardrail is imported (and registered) first.
from agentrail.guardrails.policies import push_guardrail  # noqa: F401  (registers on import)
from agentrail.guardrails.policies import approval_gate  # noqa: F401  (registers on import)
from agentrail.guardrails.policies import input_contract  # noqa: F401  (registers on import)
from agentrail.guardrails.policies import red_green  # noqa: F401  (registers on import)
from agentrail.guardrails.policies import sandbox_enforcement  # noqa: F401  (registers on import)
from agentrail.guardrails.policies import check_runner  # noqa: F401  (registers on import)

__all__ = [
    "output_enforcer",
    "proof_required",
    "push_guardrail",
    "approval_gate",
    "input_contract",
    "red_green",
    "sandbox_enforcement",
    "check_runner",
]
