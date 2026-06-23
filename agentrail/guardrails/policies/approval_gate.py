"""Human merge-approval guardrail — PURE policy (no I/O).

Migrated verbatim (decision semantics unchanged) from
``agentrail/run/approval_gate.py`` for issue #921.  Decides whether an
**irreversible action** — a merge, a deploy, or a push to a protected/production
target — requires human approval before it may proceed, and whether it has been
approved.  The policy is **disabled by default**, so existing runs are unchanged.

What lives here (pure)
----------------------
* :class:`ApprovalPolicy`, :class:`IrreversibleAction`, :class:`Approval`,
  :class:`ApprovalDecision` — the original types.
* :func:`evaluate_action` — the pure decision.
* :func:`build_approval_audit_event` — builds the Audit Event payload (pure data).
* :class:`ApprovalGateGuardrail` — the seam adapter wrapping
  :func:`evaluate_action`.

Purity (AC2)
------------
No ``subprocess``/``git``/``gh``/``pytest`` import.  Reading approval state and
POSTing the audit event happen at the edges (the orchestrator / console / the
``adapters.push`` emitter).  The audit envelope is shared with the push guardrail
policy (one audit mechanism, not two) via its pure ``_now_iso`` helper.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Dict, FrozenSet, Optional

# Reuse the push-guardrail audit envelope helper so approval and guardrail blocks
# share one Audit Event shape / ingest path. Do NOT invent a second mechanism.
# This is a pure sibling policy (no I/O), so importing it keeps the policy pure.
from agentrail.guardrails.base import Verdict
from agentrail.guardrails.policies.push_guardrail import _now_iso
from agentrail.guardrails.registry import register


# Default set of action kinds that are "irreversible" and therefore gateable.
# A merge lands code on the trunk; a deploy ships it; a protected_push is the
# guardrail's protected-target case surfaced as an approvable action.
DEFAULT_IRREVERSIBLE_KINDS: FrozenSet[str] = frozenset(
    {"merge", "deploy", "protected_push"}
)


@dataclass(frozen=True)
class ApprovalPolicy:
    """Whether the human merge-approval gate is active for a workspace/run.

    ``enabled`` defaults to ``False`` so existing runs and tests keep their
    current behaviour. ``irreversible_kinds`` lets a workspace narrow or widen
    which action kinds are gated.
    """
    enabled: bool = False
    irreversible_kinds: FrozenSet[str] = DEFAULT_IRREVERSIBLE_KINDS

    def is_irreversible(self, kind: str) -> bool:
        return kind in self.irreversible_kinds


@dataclass(frozen=True)
class IrreversibleAction:
    """An action a run wants to take that may need human approval.

    ``kind`` is a stable token ("merge" | "deploy" | "protected_push");
    ``target`` is what it acts on ("PR #42", "prod", "main"); ``run_id`` ties
    the action (and its audit event) back to the run.
    """
    kind: str
    target: str
    run_id: str = ""


@dataclass(frozen=True)
class Approval:
    """A recorded human decision on a pending irreversible action."""
    approved: bool
    by: str = ""


@dataclass(frozen=True)
class ApprovalDecision:
    """Pure result of evaluating an action against the policy.

    ``allowed`` is the headline: may the caller proceed? ``requires_approval``
    says whether the gate applies at all. ``reason`` is a stable machine token
    ("policy_disabled" | "awaiting_human_approval" | "approved" |
    "not_irreversible").
    """
    allowed: bool
    requires_approval: bool
    reason: str = ""


def evaluate_action(
    policy: ApprovalPolicy,
    action: IrreversibleAction,
    approval: Optional[Approval] = None,
) -> ApprovalDecision:
    """Decide whether *action* may proceed under *policy* (pure).

    - policy disabled            → allowed, not gated (unchanged default).
    - kind not irreversible      → allowed, not gated.
    - enabled + irreversible:
        - no/declined approval   → blocked, awaiting human approval.
        - approved               → allowed.
    """
    if not policy.enabled:
        return ApprovalDecision(allowed=True, requires_approval=False,
                                reason="policy_disabled")
    if not policy.is_irreversible(action.kind):
        return ApprovalDecision(allowed=True, requires_approval=False,
                                reason="not_irreversible")
    if approval is not None and approval.approved:
        return ApprovalDecision(allowed=True, requires_approval=True,
                                reason="approved")
    return ApprovalDecision(allowed=False, requires_approval=True,
                            reason="awaiting_human_approval")


def build_approval_audit_event(
    action: IrreversibleAction,
    approval: Approval,
) -> Dict[str, Any]:
    """Build the **Audit Event** for a granted approval (pure).

    Mirrors ``push_guardrail.build_audit_event``'s envelope
    (``session_id``/``seq``/``ts``/``kind``/``action``) so the existing
    ``/api/v1/ingest/run-events`` path accepts it without a new endpoint. The
    discriminator is ``approval_granted`` and the event records WHO approved
    (CONTEXT.md Audit Event: "records who or what performed a sensitive
    action").
    """
    return {
        "session_id": action.run_id,
        "seq": int(time.time() * 1000),
        "ts": _now_iso(),
        "kind": "audit",
        "action": {
            "type": "approval_granted",
            "action_kind": action.kind,
            "target": action.target,
            "approved_by": approval.by,
        },
        "digest": f"approval_granted:{action.kind}:{action.target}"[:64],
    }


# ---------------------------------------------------------------------------
# Guardrail seam adapter (pure) — registered so `list_guardrails()` sees it.
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ApprovalGateGuardrail:
    """Adapts :func:`evaluate_action` to the :class:`Guardrail` protocol.

    Blocking guardrail: when the policy is enabled and an irreversible action has
    not been approved, ``evaluate`` returns ``FAIL`` (awaiting human approval);
    otherwise ``PASS``.  ``evaluate(policy=..., action=..., approval=...)``.  With
    the default disabled policy, every action is ``PASS`` — behaviour unchanged.
    """

    name: str = "approval_gate"
    description: str = (
        "Requires human approval before an irreversible action (merge, deploy, "
        "protected push) when the approval policy is enabled; disabled by default."
    )
    blocking: bool = True

    def evaluate(self, **kwargs: object) -> Verdict:
        policy = kwargs.get("policy")
        action = kwargs.get("action")
        approval = kwargs.get("approval")
        if not isinstance(policy, ApprovalPolicy) or not isinstance(
            action, IrreversibleAction
        ):
            raise TypeError(
                "ApprovalGateGuardrail.evaluate requires policy=ApprovalPolicy and "
                "action=IrreversibleAction keyword arguments"
            )
        if approval is not None and not isinstance(approval, Approval):
            raise TypeError("approval= must be an Approval or None")
        decision = evaluate_action(policy, action, approval)
        if decision.allowed:
            return Verdict.passing()
        return Verdict.failing(decision.reason)


# Register the singleton instance at import time so `list_guardrails()` sees it.
APPROVAL_GATE_GUARDRAIL = register(ApprovalGateGuardrail())
