"""Human merge-approval gate — back-compat shim (issue #921).

The PURE decision logic moved to ``agentrail.guardrails.policies.approval_gate``
(the framework-neutral guardrails package).  This module re-exports it so every
existing caller keeps working unchanged::

    from agentrail.run.approval_gate import (
        ApprovalPolicy, IrreversibleAction, Approval, ApprovalDecision,
        DEFAULT_IRREVERSIBLE_KINDS, evaluate_action, build_approval_audit_event,
    )

The decision semantics are identical — these names ARE the migrated policy's
objects (re-exported, not re-implemented).  No decision logic remains here (AC4).
"""
from __future__ import annotations

from agentrail.guardrails.policies.approval_gate import (  # noqa: F401
    DEFAULT_IRREVERSIBLE_KINDS,
    Approval,
    ApprovalDecision,
    ApprovalPolicy,
    IrreversibleAction,
    build_approval_audit_event,
    evaluate_action,
)

__all__ = [
    "DEFAULT_IRREVERSIBLE_KINDS",
    "ApprovalPolicy",
    "IrreversibleAction",
    "Approval",
    "ApprovalDecision",
    "evaluate_action",
    "build_approval_audit_event",
]
