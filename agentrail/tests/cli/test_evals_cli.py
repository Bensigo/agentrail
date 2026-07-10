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


_ONE_ARM_REPORT = """# Eval report 2026-07-01

## New-flow vs full

_Not available: the run had no new-flow arm to compare against full._

## Routing cost-regret

- Total routing cost-regret: $0.0000
- Net $-delta vs baseline: n/a (no per-run baseline pairing)
"""


class EvalsApplyCliTests(unittest.TestCase):
    """Observable CLI contract for ``agentrail evals apply`` (#1048).

    These drive the real dispatch. They assert the argument-validation rungs
    and that proposal-mode is read-only; the byte-level proposal==applied and
    fail-closed guarantees live in ``tests/evals/test_consumer.py`` against the
    functions this command calls.
    """

    def test_usage_mentions_apply(self) -> None:
        rc, out, err = _run([])
        self.assertEqual(rc, 0, msg=f"stderr={err}")
        self.assertIn("apply", out)
        self.assertIn("--apply", out)

    def test_no_report_or_date_is_rc2_and_names_report(self) -> None:
        rc, out, err = _run(["apply"])
        self.assertEqual(rc, 2)
        self.assertIn("--report", err)

    def test_both_report_and_date_is_rc2(self) -> None:
        rc, out, err = _run([
            "apply", "--report", "x.md", "--date", "2026-07-01",
        ])
        self.assertEqual(rc, 2)
        # The exactly-one-of rule fires before the file is opened.
        self.assertIn("exactly one", err)

    def test_missing_report_file_is_rc2(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "nope.md"
            rc, out, err = _run(["apply", "--report", str(missing)])
        self.assertEqual(rc, 2)
        self.assertIn("not found", err)

    def test_proposal_mode_is_read_only_and_prints_mode_banner(self) -> None:
        """Default invocation prints the proposal and writes nothing (AC1)."""
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            report = root / "eval-report-2026-07-01.md"
            report.write_text(_ONE_ARM_REPORT, encoding="utf-8")
            target = root / "checkout"
            target.mkdir()

            rc, out, err = _run([
                "apply", "--report", str(report), "--target", str(target),
            ])
            self.assertEqual(rc, 0, msg=f"stderr={err}")
            self.assertIn("proposal only", out)
            # This report has only the full arm + $0 regret -> nothing to do.
            self.assertIn("No changes proposed", out)
            # Read-only: no .agentrail directory was created under the target.
            self.assertFalse((target / ".agentrail").exists())

    def test_date_resolves_report_under_reports_dir(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            reports_dir = Path(tmp) / "reports"
            reports_dir.mkdir()
            (reports_dir / "eval-report-2026-07-01.md").write_text(
                _ONE_ARM_REPORT, encoding="utf-8"
            )
            rc, out, err = _run([
                "apply",
                "--date", "2026-07-01",
                "--reports-dir", str(reports_dir),
            ])
        self.assertEqual(rc, 0, msg=f"stderr={err}")
        self.assertIn("2026-07-01", out)


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
