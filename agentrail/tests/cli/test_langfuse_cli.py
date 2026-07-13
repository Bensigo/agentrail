"""CLI tests for ``agentrail langfuse sync-models`` (agentrail/cli/commands/langfuse.py).

Drives the real dispatch (``run_langfuse``). ``sync_models`` itself is
exercised end-to-end in agentrail/tests/observability/test_price_sync.py; here
we only assert the CLI's OWN responsibilities: subcommand dispatch, the
--dry-run flag threading through, and the clean exit-1 error when Langfuse
isn't configured.
"""
from __future__ import annotations

import unittest
from io import StringIO
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


if __name__ == "__main__":
    unittest.main()
