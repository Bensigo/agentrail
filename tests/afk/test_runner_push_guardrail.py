"""The #773 secret/prod-push guardrail is wired at the AFK push seam (#781).

#773 delivered ``agentrail/run/push_guardrail.py`` (decision + Audit Event)
but intentionally did NOT hook the live push, to avoid disturbing the
env-sensitive ``*_push`` tests. #781 wires it at the real push seam in
``agentrail/afk/runner.py`` so a secret-bearing or protected-target push is
blocked + audited before ``git push origin`` runs.

These tests are hermetic: ``subprocess.run`` and the diff-gathering helper are
patched, so no real git, no network, and no dependence on AGENTRAIL_SERVER_*.
They exercise the public ``Runner._guarded_push`` seam.
"""
from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from agentrail.afk.runner import Runner
from agentrail.afk.state import AfkState, Store


def _make_runner(tmp: Path) -> Runner:
    target = tmp / "main"
    target.mkdir()
    run_dir = tmp / "run"
    run_dir.mkdir()
    store = Store(AfkState(concurrency=1, max_retries=1, max_review_rounds=1,
                           slots={0: None}))
    return Runner(
        target=target, engine="claude", base="main", concurrency=1,
        afk_label="afk", queue_labels=["ready"], run_dir=run_dir, store=store,
    )


class TestGuardedPushBlocksSecrets(unittest.TestCase):

    def test_secret_bearing_push_is_blocked_and_real_push_not_run(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            runner = _make_runner(Path(td))
            wt = Path(td) / "wt"
            wt.mkdir()
            # Diff contains an obvious secret → guardrail must block.
            with patch.object(runner, "_push_diff_content",
                              return_value="key = 'AKIAIOSFODNN7EXAMPLE'\n"), \
                 patch("agentrail.afk.runner.subprocess.run") as run_mock:
                ok = runner._guarded_push(wt, head="feature/x", run_id="run-1")
            self.assertFalse(ok)
            run_mock.assert_not_called()  # the dangerous push never executed

    def test_protected_target_push_is_blocked(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            runner = _make_runner(Path(td))
            wt = Path(td) / "wt"
            wt.mkdir()
            with patch.object(runner, "_push_diff_content",
                              return_value="ordinary diff\n"), \
                 patch("agentrail.afk.runner.subprocess.run") as run_mock:
                ok = runner._guarded_push(wt, head="main", run_id="run-2")
            self.assertFalse(ok)
            run_mock.assert_not_called()


class TestGuardedPushAllowsCleanPush(unittest.TestCase):

    def test_clean_push_to_feature_branch_runs_real_push(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            runner = _make_runner(Path(td))
            wt = Path(td) / "wt"
            wt.mkdir()
            pushed = MagicMock(spec=subprocess.CompletedProcess)
            pushed.returncode = 0
            with patch.object(runner, "_push_diff_content",
                              return_value="def f():\n    return 1\n"), \
                 patch("agentrail.afk.runner.subprocess.run",
                       return_value=pushed) as run_mock:
                ok = runner._guarded_push(wt, head="feature/y", run_id="run-3")
            self.assertTrue(ok)
            # The real push ran exactly once, to the expected ref.
            run_mock.assert_called_once()
            args = run_mock.call_args[0][0]
            self.assertIn("push", args)
            self.assertIn("HEAD:feature/y", args)

    def test_clean_push_returns_false_when_real_push_fails(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            runner = _make_runner(Path(td))
            wt = Path(td) / "wt"
            wt.mkdir()
            failed = MagicMock(spec=subprocess.CompletedProcess)
            failed.returncode = 1
            with patch.object(runner, "_push_diff_content",
                              return_value="clean\n"), \
                 patch("agentrail.afk.runner.subprocess.run",
                       return_value=failed):
                ok = runner._guarded_push(wt, head="feature/z", run_id="run-4")
            self.assertFalse(ok)


if __name__ == "__main__":
    unittest.main()
