"""Pipeline pushes an index snapshot once per run (first phase only).

Keeps the dashboard repos health view fresh on every run instead of only
after a manual `agentrail context index`. The push is non-fatal: a failure
never affects the run exit code. With the plan phase removed (MVP), the first
phase is now ``test-author``.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from agentrail.run.pipeline import run_issue

from agentrail.tests.run.test_budget_guardrail import (
    _apply_common_patches,
    _make_target,
    _stub_run_with_timeout,
)


class TestIndexSnapshotPushFromPipeline(unittest.TestCase):

    def _run(self, tmp: str, build_index_mock, push_mock) -> int:
        target = _make_target(tmp)
        _apply_common_patches(self, target)
        stub = _stub_run_with_timeout(0, sentinel=target / "impl_done")
        with patch("agentrail.run.pipeline.run_with_timeout", stub), \
             patch("agentrail.run.pipeline.capture_usage", return_value=None), \
             patch("agentrail.context.index.build_index", build_index_mock), \
             patch("agentrail.context.snapshot_push.push_index_snapshot", push_mock):
            rc = run_issue(
                target, 7,
                agent="claude", command="claude -p",
                repo_dir=target,
                log_dir=Path(tmp) / "runs",
            )
        self._stub = stub
        return rc

    def test_snapshot_pushed_once_for_first_phase_only(self):
        """A multi-phase run pushes exactly one snapshot, built from build_index."""
        build_result = {"cacheHit": True}
        build_index_mock = MagicMock(return_value=build_result)
        push_mock = MagicMock(return_value=True)
        with tempfile.TemporaryDirectory() as tmp:
            rc = self._run(tmp, build_index_mock, push_mock)
        self.assertEqual(rc, 0)
        # More than one phase ran, but the snapshot was pushed exactly once.
        self.assertGreater(len(self._stub.calls), 1)
        push_mock.assert_called_once()
        self.assertIs(push_mock.call_args[0][1], build_result)

    def test_snapshot_push_failure_is_non_fatal(self):
        """build_index blowing up must not affect the run exit code."""
        build_index_mock = MagicMock(side_effect=RuntimeError("index exploded"))
        push_mock = MagicMock()
        with tempfile.TemporaryDirectory() as tmp:
            rc = self._run(tmp, build_index_mock, push_mock)
        self.assertEqual(rc, 0)
        push_mock.assert_not_called()


if __name__ == "__main__":
    unittest.main()
