"""Guardrail policies.

Importing this subpackage imports every policy module, which registers each
guardrail into :mod:`agentrail.guardrails.registry` as a side effect.  Add new
policies here (issue #921 migrates secrets/push, input_contract, red_green,
approval_gate, sandbox, check_runner) so a single import populates the registry.
"""
from __future__ import annotations

from agentrail.guardrails.policies import output_enforcer  # noqa: F401  (registers on import)
from agentrail.guardrails.policies import proof_required  # noqa: F401  (registers on import)

__all__ = ["output_enforcer", "proof_required"]
