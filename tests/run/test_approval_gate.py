"""Tests for the human merge-approval gate (M037, issue #781).

The gate is a deep module (pure decision, no I/O) in
``agentrail/run/approval_gate.py``. It decides whether an **irreversible
action** (merge/deploy/protected-push) requires human approval given a policy,
and whether it is approved. Approval emits an **Audit Event** (CONTEXT.md: "a
source-linked event that records who or what performed a sensitive action,
policy decision") built with the same shape as
``push_guardrail.build_audit_event`` — there is one audit mechanism, not two.

- AC1: policy ENABLED → an irreversible action requires human approval.
- AC2: approval emits an Audit Event recording who approved.
- AC3: policy DISABLED → behaviour unchanged (no gating); this is the default.
"""
from __future__ import annotations

import json
import unittest

from agentrail.run.approval_gate import (
    Approval,
    ApprovalDecision,
    ApprovalPolicy,
    IrreversibleAction,
    build_approval_audit_event,
    evaluate_action,
)


def _merge_action() -> IrreversibleAction:
    return IrreversibleAction(kind="merge", target="PR #42", run_id="run-1")


# ---------------------------------------------------------------------------
# AC1: policy ENABLED → irreversible action requires human approval
# ---------------------------------------------------------------------------

class TestEnabledPolicyRequiresApproval(unittest.TestCase):

    def test_unapproved_merge_is_gated_when_enabled(self) -> None:
        policy = ApprovalPolicy(enabled=True)
        decision = evaluate_action(policy, _merge_action(), approval=None)
        self.assertTrue(decision.requires_approval)
        self.assertFalse(decision.allowed)
        self.assertEqual(decision.reason, "awaiting_human_approval")

    def test_deploy_is_an_irreversible_action(self) -> None:
        policy = ApprovalPolicy(enabled=True)
        action = IrreversibleAction(kind="deploy", target="prod", run_id="run-2")
        decision = evaluate_action(policy, action, approval=None)
        self.assertTrue(decision.requires_approval)
        self.assertFalse(decision.allowed)

    def test_protected_push_is_an_irreversible_action(self) -> None:
        policy = ApprovalPolicy(enabled=True)
        action = IrreversibleAction(kind="protected_push", target="main",
                                    run_id="run-3")
        decision = evaluate_action(policy, action, approval=None)
        self.assertTrue(decision.requires_approval)
        self.assertFalse(decision.allowed)

    def test_approved_merge_proceeds_when_enabled(self) -> None:
        policy = ApprovalPolicy(enabled=True)
        approval = Approval(approved=True, by="alice@example.com")
        decision = evaluate_action(policy, _merge_action(), approval=approval)
        self.assertTrue(decision.requires_approval)
        self.assertTrue(decision.allowed)
        self.assertEqual(decision.reason, "approved")

    def test_unknown_action_kind_not_gated(self) -> None:
        """A non-irreversible action is not gated even when the policy is on."""
        policy = ApprovalPolicy(enabled=True)
        action = IrreversibleAction(kind="comment", target="PR #1", run_id="r")
        decision = evaluate_action(policy, action, approval=None)
        self.assertFalse(decision.requires_approval)
        self.assertTrue(decision.allowed)


# ---------------------------------------------------------------------------
# AC3: policy DISABLED → behaviour unchanged (default off)
# ---------------------------------------------------------------------------

class TestDisabledPolicyIsUnchanged(unittest.TestCase):

    def test_disabled_policy_allows_irreversible_action(self) -> None:
        policy = ApprovalPolicy(enabled=False)
        decision = evaluate_action(policy, _merge_action(), approval=None)
        self.assertFalse(decision.requires_approval)
        self.assertTrue(decision.allowed)
        self.assertEqual(decision.reason, "policy_disabled")

    def test_default_policy_is_disabled(self) -> None:
        """Default-constructed policy must not change existing behaviour."""
        policy = ApprovalPolicy()
        self.assertFalse(policy.enabled)
        decision = evaluate_action(policy, _merge_action(), approval=None)
        self.assertTrue(decision.allowed)


# ---------------------------------------------------------------------------
# AC2: approval emits an Audit Event (same shape as push_guardrail)
# ---------------------------------------------------------------------------

class TestApprovalAuditEvent(unittest.TestCase):

    def test_audit_event_has_required_fields(self) -> None:
        approval = Approval(approved=True, by="bob@example.com")
        event = build_approval_audit_event(_merge_action(), approval)
        # Same envelope as push_guardrail.build_audit_event so the existing
        # run-events ingest path accepts it (session_id/seq/ts/kind/action).
        self.assertEqual(event["session_id"], "run-1")
        self.assertIn("ts", event)
        self.assertIn("seq", event)
        self.assertEqual(event["kind"], "audit")
        self.assertEqual(event["action"]["type"], "approval_granted")
        self.assertEqual(event["action"]["action_kind"], "merge")
        self.assertEqual(event["action"]["target"], "PR #42")
        self.assertEqual(event["action"]["approved_by"], "bob@example.com")

    def test_audit_event_is_json_serializable(self) -> None:
        approval = Approval(approved=True, by="carol@example.com")
        event = build_approval_audit_event(_merge_action(), approval)
        # Must round-trip through JSON for the run-events POST body.
        self.assertIsInstance(json.dumps(event), str)


if __name__ == "__main__":
    unittest.main()
