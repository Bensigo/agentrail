"""Unit tests for the diff-only REJECT+LOOP decision helpers.

Covers the PURE pieces of the flag-gated, DEFAULT-OFF diff-only output enforcer:

* :func:`plan_enforcement_step` — the pure retry decision after a diff-format
  check (Accepted -> no retry; Rejected with attempts left -> retry with the
  reason as findings; Rejected at/over the cap -> give up gracefully).
* :func:`resolve_diff_only_max_attempts` — defensive cap resolver.
* :func:`diff_only_enforce_enabled` — the DEFAULT-OFF flag (ON only on "1").

These are pure: no subprocess, no agent invocation. The Rejected/Accepted inputs
are built via the real :func:`enforce`, so the tests also pin that a plain
full-file rewrite is Rejected and a unified-diff hunk is Accepted.
"""
from __future__ import annotations

import os
import unittest

from agentrail.guardrails.policies.output_enforcer import (
    Accepted,
    EnforcementStep,
    Rejected,
    enforce,
    plan_enforcement_step,
)
from agentrail.run.pipeline import (
    DIFF_ONLY_DEFAULT_MAX_ATTEMPTS,
    diff_only_enforce_enabled,
    resolve_diff_only_max_attempts,
)

# A full-file rewrite with no unified-diff hunk header -> enforce() Rejects it.
_FULL_REWRITE = "def foo():\n    return 42\n\ndef bar():\n    return 'hello'\n"
# A minimal unified diff -> enforce() Accepts it.
_UNIFIED_DIFF = "@@ -1 +1 @@\n-old\n+new"


class TestPlanEnforcementStep(unittest.TestCase):
    def test_accepted_no_retry(self):
        result = enforce(_UNIFIED_DIFF, is_new_or_rename=False)
        self.assertIsInstance(result, Accepted)
        step = plan_enforcement_step(result, attempt=1, max_attempts=2)
        self.assertEqual(step, EnforcementStep(retry=False, findings=""))

    def test_rejected_attempts_remain_retries_with_reason(self):
        result = enforce(_FULL_REWRITE, is_new_or_rename=False)
        self.assertIsInstance(result, Rejected)
        step = plan_enforcement_step(result, attempt=1, max_attempts=2)
        self.assertTrue(step.retry)
        self.assertEqual(step.findings, result.reason)
        self.assertTrue(step.findings)  # reason is non-empty

    def test_rejected_at_cap_gives_up_gracefully(self):
        result = enforce(_FULL_REWRITE, is_new_or_rename=False)
        self.assertIsInstance(result, Rejected)
        step = plan_enforcement_step(result, attempt=2, max_attempts=2)
        self.assertFalse(step.retry)
        # Reason still carried for telemetry even though we give up.
        self.assertEqual(step.findings, result.reason)

    def test_rejected_over_cap_no_retry(self):
        result = enforce(_FULL_REWRITE, is_new_or_rename=False)
        step = plan_enforcement_step(result, attempt=3, max_attempts=2)
        self.assertFalse(step.retry)


class TestResolveDiffOnlyMaxAttempts(unittest.TestCase):
    _ENV = "AGENTRAIL_DIFF_ONLY_MAX_ATTEMPTS"

    def setUp(self):
        self._saved = os.environ.get(self._ENV)
        os.environ.pop(self._ENV, None)

    def tearDown(self):
        if self._saved is None:
            os.environ.pop(self._ENV, None)
        else:
            os.environ[self._ENV] = self._saved

    def test_default_when_unset(self):
        self.assertEqual(resolve_diff_only_max_attempts(), DIFF_ONLY_DEFAULT_MAX_ATTEMPTS)

    def test_default_when_blank(self):
        os.environ[self._ENV] = "   "
        self.assertEqual(resolve_diff_only_max_attempts(), DIFF_ONLY_DEFAULT_MAX_ATTEMPTS)

    def test_default_when_garbage(self):
        os.environ[self._ENV] = "notanint"
        self.assertEqual(resolve_diff_only_max_attempts(), DIFF_ONLY_DEFAULT_MAX_ATTEMPTS)

    def test_default_when_below_one(self):
        os.environ[self._ENV] = "0"
        self.assertEqual(resolve_diff_only_max_attempts(), DIFF_ONLY_DEFAULT_MAX_ATTEMPTS)
        os.environ[self._ENV] = "-3"
        self.assertEqual(resolve_diff_only_max_attempts(), DIFF_ONLY_DEFAULT_MAX_ATTEMPTS)

    def test_honors_valid_int(self):
        os.environ[self._ENV] = "5"
        self.assertEqual(resolve_diff_only_max_attempts(), 5)


class TestDiffOnlyEnforceEnabled(unittest.TestCase):
    _ENV = "AGENTRAIL_EVAL_LAYER_DIFF_ONLY_ENFORCE"

    def setUp(self):
        self._saved = os.environ.get(self._ENV)
        os.environ.pop(self._ENV, None)

    def tearDown(self):
        if self._saved is None:
            os.environ.pop(self._ENV, None)
        else:
            os.environ[self._ENV] = self._saved

    def test_false_when_absent(self):
        self.assertFalse(diff_only_enforce_enabled())

    def test_false_on_zero(self):
        os.environ[self._ENV] = "0"
        self.assertFalse(diff_only_enforce_enabled())

    def test_false_on_true_string(self):
        os.environ[self._ENV] = "true"
        self.assertFalse(diff_only_enforce_enabled())

    def test_true_only_on_one(self):
        os.environ[self._ENV] = "1"
        self.assertTrue(diff_only_enforce_enabled())


if __name__ == "__main__":
    unittest.main()
