"""The OBJECTIVE check-runner — back-compat shim (issue #921).

The PURE mapping moved to ``agentrail.guardrails.policies.check_runner``
(``VerifyCheck`` / ``parse_verify_config`` / ``exit_code_to_check_result`` /
``ac_coverage_for``) and the thin subprocess/file I/O moved to
``agentrail.guardrails.adapters.check_runner`` (``load_verify_checks`` /
``red_green_proof_required`` / ``run_objective_checks``).  This module re-exports
both so every existing caller keeps working unchanged::

    from agentrail.run.check_runner import (
        VerifyCheck, parse_verify_config, exit_code_to_check_result,
        ac_coverage_for, load_verify_checks, red_green_proof_required,
        run_objective_checks, DEFAULT_CHECK_TIMEOUT,
    )

The decision semantics are identical — these names ARE the migrated objects
(re-exported, not re-implemented).  No decision logic remains here (AC4).
"""
from __future__ import annotations

# Pure mapping — from the policy.
from agentrail.guardrails.policies.check_runner import (  # noqa: F401
    DEFAULT_CHECK_TIMEOUT,
    VerifyCheck,
    ac_coverage_for,
    exit_code_to_check_result,
    parse_verify_config,
)

# Thin subprocess/file I/O — from the adapter.
from agentrail.guardrails.adapters.check_runner import (  # noqa: F401
    load_verify_checks,
    red_green_proof_required,
    run_objective_checks,
)

__all__ = [
    "DEFAULT_CHECK_TIMEOUT",
    "VerifyCheck",
    "parse_verify_config",
    "exit_code_to_check_result",
    "ac_coverage_for",
    "load_verify_checks",
    "red_green_proof_required",
    "run_objective_checks",
]
