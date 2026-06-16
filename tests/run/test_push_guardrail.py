"""Tests for the secret / prod-push guardrail (M037, issue #773).

The guardrail is a deep module (pure decision + secret detection) in
``agentrail/run/push_guardrail.py``. Every block emits an **Audit Event**
(CONTEXT.md: "a source-linked event that records ... a sensitive action,
policy decision"). These tests are hermetic — no network, no real git — and
exercise the public interface only.

- AC1: a commit/push containing a detected secret is blocked.
- AC2: a push to a protected/production target is blocked.
- AC3: every block emits an audit event.
"""
from __future__ import annotations

import json
import unittest

from agentrail.run.push_guardrail import (
    DEFAULT_PROTECTED_TARGETS,
    build_audit_event,
    detect_secrets,
    evaluate_push,
    guard_push,
)


# ---------------------------------------------------------------------------
# AC1: secret detection blocks the push
# ---------------------------------------------------------------------------

class TestSecretDetectionBlocks(unittest.TestCase):

    def test_aws_access_key_in_content_is_blocked(self) -> None:
        content = "config = {\n  'aws_key': 'AKIAIOSFODNN7EXAMPLE',\n}\n"
        decision = evaluate_push(targets=["feature/x"], content=content)
        self.assertTrue(decision.blocked)
        self.assertEqual(decision.reason, "secret_detected")
        self.assertTrue(decision.findings)

    def test_private_key_block_is_detected(self) -> None:
        content = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKC...\n"
        findings = detect_secrets(content)
        self.assertEqual([f.kind for f in findings], ["private_key"])

    def test_github_token_is_detected(self) -> None:
        content = "token = ghp_" + "a" * 36 + "\n"
        findings = detect_secrets(content)
        self.assertEqual([f.kind for f in findings], ["github_token"])


# ---------------------------------------------------------------------------
# AC2: push to a protected/production target is blocked
# ---------------------------------------------------------------------------

class TestProtectedTargetBlocks(unittest.TestCase):

    def test_push_to_main_is_blocked(self) -> None:
        decision = evaluate_push(targets=["main"], content="ordinary diff\n")
        self.assertTrue(decision.blocked)
        self.assertEqual(decision.reason, "protected_target")

    def test_push_to_production_is_blocked(self) -> None:
        decision = evaluate_push(targets=["origin/production"], content="x\n")
        self.assertTrue(decision.blocked)
        self.assertEqual(decision.reason, "protected_target")

    def test_protected_match_is_case_insensitive(self) -> None:
        decision = evaluate_push(targets=["MASTER"], content="x\n")
        self.assertTrue(decision.blocked)
        self.assertEqual(decision.reason, "protected_target")


# ---------------------------------------------------------------------------
# No false positives: clean content to a normal target is allowed
# ---------------------------------------------------------------------------

class TestCleanPushAllowed(unittest.TestCase):

    def test_ordinary_diff_to_feature_branch_is_allowed(self) -> None:
        content = (
            "def add(a, b):\n"
            "    # AKIA is just a word here, not a key\n"
            "    return a + b\n"
            "\n"
            "API_VERSION = 'v1'\n"
            "uuid = '550e8400-e29b-41d4-a716-446655440000'\n"
        )
        decision = evaluate_push(targets=["feature/add-helper"], content=content)
        self.assertFalse(decision.blocked)
        self.assertEqual(decision.reason, "")
        self.assertEqual(decision.findings, [])

    def test_empty_content_and_no_targets_is_allowed(self) -> None:
        decision = evaluate_push(targets=[], content="")
        self.assertFalse(decision.blocked)


# ---------------------------------------------------------------------------
# AC3: every block emits an audit event
# ---------------------------------------------------------------------------

class TestEveryBlockEmitsAuditEvent(unittest.TestCase):

    def test_secret_block_emits_audit_event(self) -> None:
        emitted = []
        decision = guard_push(
            targets=["feature/x"],
            content="key = 'AKIAIOSFODNN7EXAMPLE'\n",
            emit=emitted.append,
        )
        self.assertTrue(decision.blocked)
        self.assertEqual(len(emitted), 1)
        event = emitted[0]
        self.assertEqual(event["action"]["type"], "security_block")
        self.assertEqual(event["action"]["reason"], "secret_detected")

    def test_protected_target_block_emits_audit_event(self) -> None:
        emitted = []
        decision = guard_push(
            targets=["main"],
            content="ordinary diff\n",
            emit=emitted.append,
        )
        self.assertTrue(decision.blocked)
        self.assertEqual(len(emitted), 1)
        self.assertEqual(emitted[0]["action"]["reason"], "protected_target")

    def test_allowed_push_emits_no_audit_event(self) -> None:
        emitted = []
        decision = guard_push(
            targets=["feature/x"],
            content="ordinary diff\n",
            emit=emitted.append,
        )
        self.assertFalse(decision.blocked)
        self.assertEqual(emitted, [])

    def test_audit_event_does_not_leak_full_secret(self) -> None:
        secret = "AKIAIOSFODNN7EXAMPLE"
        emitted = []
        guard_push(targets=["x"], content=f"k='{secret}'\n", emit=emitted.append)
        serialized = json.dumps(emitted[0])
        self.assertNotIn(secret, serialized)


class TestAuditEventShape(unittest.TestCase):
    """The audit event is a Run Event recording a sensitive/policy action
    (CONTEXT.md Audit Event), following the activity_push action-discriminator
    shape so the existing run-events ingest path accepts it."""

    def test_build_audit_event_has_required_fields(self) -> None:
        decision = evaluate_push(targets=["main"], content="x\n")
        event = build_audit_event(decision, run_id="run-123", target="main")
        self.assertEqual(event["session_id"], "run-123")
        self.assertIn("ts", event)
        self.assertIn("seq", event)
        self.assertEqual(event["kind"], "audit")
        self.assertEqual(event["action"]["type"], "security_block")
        self.assertEqual(event["action"]["reason"], "protected_target")
        self.assertEqual(event["action"]["target"], "main")
        self.assertIn("detail", event["action"])


# ---------------------------------------------------------------------------
# Edge emitter: non-fatal, no network when unlinked (mirrors failure_push)
# ---------------------------------------------------------------------------

class TestServerEmitterIsNonFatal(unittest.TestCase):

    def test_push_audit_event_returns_false_when_unlinked(self) -> None:
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        from agentrail.run.push_guardrail import make_server_emitter

        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)
            # No .agentrail link present → load_link returns None → no network.
            with patch("agentrail.run.push_guardrail.urllib.request.urlopen") as urlopen:
                emit = make_server_emitter(target, run_id="run-1")
                result = emit({"action": {"type": "security_block"}})
            self.assertFalse(result)
            urlopen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
