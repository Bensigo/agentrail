"""Human merge-approval gate for irreversible actions (M037, issue #781).

A deep module (pure logic, no I/O) that decides whether an **irreversible
action** — a merge, a deploy, or a push to a protected/production target —
requires human approval before it may proceed, and whether it has been
approved. The decision is gated behind a policy that is **disabled by
default**, so existing runs are unchanged (AC3).

Per ``docs/design/verification-contract-architecture.md`` the decision logic
here is pure and deterministic; reading approval state and emitting the audit
event happen at the edges (the orchestrator / console). On approval the gate's
caller emits one **Audit Event** (CONTEXT.md: "a source-linked event that
records who or what performed a sensitive action, policy decision"). The audit
event uses the SAME envelope as ``push_guardrail.build_audit_event`` — there is
one audit mechanism, not two.

- AC1: policy ENABLED → an irreversible action requires human approval.
- AC2: approval emits an Audit Event recording who approved (built here, POSTed
  via ``push_guardrail.make_server_emitter``).
- AC3: policy DISABLED → behaviour unchanged (no gating); this is the default.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Dict, FrozenSet, Optional

# Reuse the #773 audit envelope helper so approval and guardrail blocks share
# one Audit Event shape / ingest path. Do NOT invent a second mechanism.
from agentrail.run.push_guardrail import _now_iso


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
    current behaviour (AC3). ``irreversible_kinds`` lets a workspace narrow or
    widen which action kinds are gated.
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

    - policy disabled            → allowed, not gated (AC3, unchanged default).
    - kind not irreversible      → allowed, not gated.
    - enabled + irreversible:
        - no/declined approval   → blocked, awaiting human approval (AC1).
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
