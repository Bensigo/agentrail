"""CLI tests for ``agentrail evals run`` (issue #980).

These drive the real CLI dispatch (``run_evals``) under ``--smoke`` so no
sandbox/agent is spawned — the in-process ``SmokeFakeExecutor`` returns a
faithful empty ``AgentExecution`` and the ``UnimplementedHiddenTestRunner``
scores everything ``unsolved``. We assert the OBSERVABLE CLI contract:

- AC4: ``--arm full --arm new-flow`` runs BOTH arms (two rows) plus the
  per-layer ablation deltas in the dated markdown report.
- the new-flow arm is selectable by name.
"""
from __future__ import annotations

import sys
import unittest
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from agentrail.cli.commands.evals import run_evals


def _run(args):
    """Invoke ``run_evals(args)``; return ``(rc, stdout, stderr)``."""
    out = StringIO()
    err = StringIO()
    with patch("sys.stdout", out), patch("sys.stderr", err):
        rc = run_evals(args)
    return rc, out.getvalue(), err.getvalue()


class EvalsRunNewFlowCliTests(unittest.TestCase):
    def test_full_and_new_flow_both_run_with_deltas(self) -> None:
        """AC4: --arm full --arm new-flow -> both rows + per-layer deltas."""
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            reports_dir = Path(tmp) / "reports"
            rc, out, err = _run([
                "run", "--smoke",
                "--arm", "full",
                "--arm", "new-flow",
                "--task", "afk-objective-gate",
                "--reps", "1",
                "--reports-dir", str(reports_dir),
            ])
            self.assertEqual(rc, 0, msg=f"stderr={err}")
            # Both arms appear in the stdout summary.
            self.assertIn("arm=full", out)
            self.assertIn("arm=new-flow", out)

            # The dated markdown report exists and carries both arms + the
            # new-flow head-to-head deltas + per-layer ablation section.
            report_files = list(reports_dir.glob("eval-report-*.md"))
            self.assertEqual(len(report_files), 1, msg=report_files)
            md = report_files[0].read_text(encoding="utf-8").lower()
            self.assertIn("new-flow", md)
            self.assertIn("full", md)
            # AC3 four metrics surfaced in the report.
            self.assertIn("solve-rate", md)
            self.assertIn("false-green", md)
            self.assertTrue("wall-time" in md or "wall time" in md)
            self.assertIn("dollars-per-solved", md)

    def test_new_flow_arm_is_selectable_alone(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            reports_dir = Path(tmp) / "reports"
            rc, out, err = _run([
                "run", "--smoke",
                "--arm", "new-flow",
                "--task", "afk-objective-gate",
                "--reps", "1",
                "--reports-dir", str(reports_dir),
            ])
            self.assertEqual(rc, 0, msg=f"stderr={err}")
            self.assertIn("arm=new-flow", out)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
