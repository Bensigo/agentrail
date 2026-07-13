"""CLI tests for ``agentrail langfuse`` (agentrail/cli/commands/langfuse.py).

Drives the real dispatch (``run_langfuse``). ``sync_models``/``push_scores``/
``calibration`` themselves are exercised end-to-end in
agentrail/tests/observability/test_price_sync.py,
agentrail/tests/observability/test_score_push.py, and
agentrail/tests/observability/test_calibration.py respectively; here we only
assert the CLI's OWN responsibilities: subcommand dispatch, flag threading
(``--dry-run``, ``--records``, ``--judge``, ``--reports-dir``, ``--date``),
and the clean exit-1 error when Langfuse isn't configured.
"""
from __future__ import annotations

import unittest
from io import StringIO
from pathlib import Path
from unittest.mock import MagicMock, patch

from agentrail.cli.commands.langfuse import run_langfuse


def _run(args):
    out = StringIO()
    err = StringIO()
    with patch("sys.stdout", out), patch("sys.stderr", err):
        rc = run_langfuse(args)
    return rc, out.getvalue(), err.getvalue()


class LangfuseCliTests(unittest.TestCase):
    def test_help_prints_usage(self):
        rc, out, _err = _run(["--help"])
        self.assertEqual(0, rc)
        self.assertIn("sync-models", out)

    def test_no_args_prints_usage(self):
        rc, out, _err = _run([])
        self.assertEqual(0, rc)
        self.assertIn("Usage:", out)

    def test_unknown_subcommand_errors(self):
        rc, _out, err = _run(["bogus"])
        self.assertEqual(2, rc)
        self.assertIn("Unknown langfuse command: bogus", err)

    def test_sync_models_errors_cleanly_when_langfuse_not_configured(self):
        with patch(
            "agentrail.cli.commands.langfuse.LangfuseHTTP.from_env",
            return_value=None,
        ):
            rc, _out, err = _run(["sync-models"])
        self.assertEqual(1, rc)
        # One-line, actionable message; no traceback.
        self.assertEqual(1, len(err.strip().splitlines()))
        self.assertIn("not configured", err)

    def test_sync_models_dry_run_threads_flag_and_reports_result(self):
        fake_client = object()
        mock_sync = MagicMock(return_value={
            "created": ["model-a"],
            "unchanged": ["model-b"],
            "stale": [],
        })
        with patch(
            "agentrail.cli.commands.langfuse.LangfuseHTTP.from_env",
            return_value=fake_client,
        ), patch("agentrail.cli.commands.langfuse.sync_models", mock_sync):
            rc, out, _err = _run(["sync-models", "--dry-run"])

        self.assertEqual(0, rc)
        mock_sync.assert_called_once_with(fake_client, dry_run=True)
        self.assertIn("Would create: 1 (model-a)", out)
        self.assertIn("Unchanged: 1 (model-b)", out)

    def test_sync_models_unknown_option_errors(self):
        with patch(
            "agentrail.cli.commands.langfuse.LangfuseHTTP.from_env",
            return_value=object(),
        ):
            rc, _out, err = _run(["sync-models", "--bogus"])
        self.assertEqual(2, rc)
        self.assertIn("unknown option: --bogus", err)

    # -- push-scores ---------------------------------------------------

    def test_push_scores_errors_cleanly_when_langfuse_not_configured(self):
        with patch(
            "agentrail.cli.commands.langfuse.LangfuseHTTP.from_env",
            return_value=None,
        ):
            rc, _out, err = _run(["push-scores", "--records", "/tmp/whatever"])
        self.assertEqual(1, rc)
        self.assertEqual(1, len(err.strip().splitlines()))
        self.assertIn("not configured", err)

    def test_push_scores_requires_records_flag(self):
        with patch(
            "agentrail.cli.commands.langfuse.LangfuseHTTP.from_env",
            return_value=object(),
        ):
            rc, _out, err = _run(["push-scores"])
        self.assertEqual(2, rc)
        self.assertIn("--records <dir> is required", err)

    def test_push_scores_dry_run_threads_flags_and_reports_result(self):
        fake_client = object()
        mock_push = MagicMock(return_value={
            "pushed": 3,
            "skipped": [{"record": "bad.json", "reason": "unparseable"}],
        })
        with patch(
            "agentrail.cli.commands.langfuse.LangfuseHTTP.from_env",
            return_value=fake_client,
        ), patch("agentrail.cli.commands.langfuse.push_scores", mock_push):
            rc, out, _err = _run([
                "push-scores", "--records", "/tmp/recs", "--judge", "/tmp/j.json", "--dry-run",
            ])

        self.assertEqual(0, rc)
        from pathlib import Path
        mock_push.assert_called_once_with(
            fake_client, Path("/tmp/recs"), Path("/tmp/j.json"), dry_run=True,
        )
        self.assertIn("Would push: 3 score(s)", out)
        self.assertIn("Skipped: 1", out)
        self.assertIn("bad.json: unparseable", out)

    def test_push_scores_without_judge_flag_passes_none(self):
        fake_client = object()
        mock_push = MagicMock(return_value={"pushed": 0, "skipped": []})
        with patch(
            "agentrail.cli.commands.langfuse.LangfuseHTTP.from_env",
            return_value=fake_client,
        ), patch("agentrail.cli.commands.langfuse.push_scores", mock_push):
            rc, out, _err = _run(["push-scores", "--records", "/tmp/recs"])

        self.assertEqual(0, rc)
        from pathlib import Path
        mock_push.assert_called_once_with(fake_client, Path("/tmp/recs"), None, dry_run=False)
        self.assertIn("Pushed: 0 score(s)", out)
        self.assertIn("Skipped: 0", out)

    def test_push_scores_unknown_option_errors(self):
        with patch(
            "agentrail.cli.commands.langfuse.LangfuseHTTP.from_env",
            return_value=object(),
        ):
            rc, _out, err = _run(["push-scores", "--records", "/tmp/recs", "--bogus"])
        self.assertEqual(2, rc)
        self.assertIn("unknown option: --bogus", err)

    # -- calibration-report ---------------------------------------------

    def test_calibration_report_errors_cleanly_when_langfuse_not_configured(self):
        with patch(
            "agentrail.cli.commands.langfuse.LangfuseHTTP.from_env",
            return_value=None,
        ):
            rc, _out, err = _run(["calibration-report"])
        self.assertEqual(1, rc)
        self.assertEqual(1, len(err.strip().splitlines()))
        self.assertIn("not configured", err)

    def test_calibration_report_threads_reports_dir_and_date_and_writes_report(self):
        fake_client = object()
        fake_result = {
            "n": 12,
            "agreement": {"judge_vs_solved": 0.9166666666666666, "judge_vs_verify": None},
            "insufficient": False,
        }
        mock_calibration = MagicMock(return_value=fake_result)
        mock_write = MagicMock(return_value=Path("/tmp/reports/calibration-2026-07-13.md"))
        with patch(
            "agentrail.cli.commands.langfuse.LangfuseHTTP.from_env",
            return_value=fake_client,
        ), patch(
            "agentrail.cli.commands.langfuse.calibration", mock_calibration,
        ), patch(
            "agentrail.cli.commands.langfuse.write_markdown_report", mock_write,
        ):
            rc, out, _err = _run([
                "calibration-report", "--reports-dir", "/tmp/reports", "--date", "2026-07-13",
            ])

        self.assertEqual(0, rc)
        mock_calibration.assert_called_once_with(fake_client)
        mock_write.assert_called_once_with(
            fake_result, reports_dir=Path("/tmp/reports"), date="2026-07-13",
        )
        self.assertIn("Wrote /tmp/reports/calibration-2026-07-13.md", out)
        self.assertIn("n=12", out)
        self.assertIn("insufficient: False", out)

    def test_calibration_report_defaults_reports_dir_and_date(self):
        fake_client = object()
        fake_result = {
            "n": 0,
            "agreement": {"judge_vs_solved": None, "judge_vs_verify": None},
            "insufficient": True,
        }
        mock_calibration = MagicMock(return_value=fake_result)
        mock_write = MagicMock(return_value=Path("/some/default/path.md"))
        with patch(
            "agentrail.cli.commands.langfuse.LangfuseHTTP.from_env",
            return_value=fake_client,
        ), patch(
            "agentrail.cli.commands.langfuse.calibration", mock_calibration,
        ), patch(
            "agentrail.cli.commands.langfuse.write_markdown_report", mock_write,
        ):
            rc, _out, _err = _run(["calibration-report"])

        self.assertEqual(0, rc)
        _args, kwargs = mock_write.call_args
        self.assertIsNone(kwargs["reports_dir"])
        # date defaults to today's ISO date — just assert the shape, not the
        # exact value (avoids a flaky test at midnight boundaries).
        self.assertRegex(kwargs["date"], r"^\d{4}-\d{2}-\d{2}$")

    def test_calibration_report_unknown_option_errors(self):
        with patch(
            "agentrail.cli.commands.langfuse.LangfuseHTTP.from_env",
            return_value=object(),
        ):
            rc, _out, err = _run(["calibration-report", "--bogus"])
        self.assertEqual(2, rc)
        self.assertIn("unknown option: --bogus", err)


if __name__ == "__main__":
    unittest.main()
