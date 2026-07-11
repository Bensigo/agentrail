"""Acceptance tests for the CLI auth gate (issue #865).

Gate requirement: every ``agentrail`` command except ``login``, ``logout``,
``whoami``, ``--help``, and bare invocation must be blocked when the user
is not authenticated.

Authenticated means: ``load_credentials()`` returns non-None OR the env var
``AGENTRAIL_SERVER_API_KEY`` is set (runner-internal path).

These tests are RED until the auth gate is implemented in main().
"""
from __future__ import annotations

import os
import sys
import unittest
from io import StringIO
from unittest.mock import MagicMock, call, patch

from agentrail.cli.main import main
from agentrail.runner.credentials import Credentials


_FAKE_CREDS = Credentials(
    base_url="https://example.com",
    token="tok-abc",
    workspace_id="ws-123",
)

_NOT_LOGGED_IN_MSG = "Not logged in. Run `agentrail login` first."


class TestAuthGate(unittest.TestCase):
    """Auth-gate acceptance tests covering the four canonical states from AC."""

    # ------------------------------------------------------------------
    # State 1 (RED): gated command blocked when not authenticated
    #
    # AC: "With no credentials and AGENTRAIL_SERVER_API_KEY unset, a gated
    # command prints the error to stderr and exits 1."
    # ------------------------------------------------------------------

    def test_gated_command_blocked_when_not_authenticated(self):
        """main(['run']) exits 1 + prints login message to stderr when unauthenticated."""
        err = StringIO()
        mock_run = MagicMock(return_value=0)
        with patch("agentrail.cli.main.load_credentials", return_value=None, create=True), \
             patch.dict(os.environ, {}, clear=True), \
             patch("agentrail.cli.main.run_run", mock_run), \
             patch("sys.stderr", err):
            rc = main(["run"])

        # Gate must intercept before dispatch: run_run must NOT be called.
        mock_run.assert_not_called()
        self.assertEqual(1, rc)
        self.assertIn(_NOT_LOGGED_IN_MSG, err.getvalue())

    # ------------------------------------------------------------------
    # State 2: exempt commands allowed without credentials
    #
    # AC: "login, logout, whoami, --help, and bare agentrail all succeed
    # WITHOUT credentials."
    # ------------------------------------------------------------------

    def test_exempt_login_allowed_without_credentials(self):
        """agentrail login is exempt from the auth gate."""
        mock_login = MagicMock(return_value=0)
        with patch("agentrail.cli.main.load_credentials", return_value=None, create=True), \
             patch.dict(os.environ, {}, clear=True), \
             patch("agentrail.cli.main.run_login", mock_login):
            rc = main(["login"])
        self.assertEqual(0, rc)
        mock_login.assert_called_once()

    def test_exempt_logout_allowed_without_credentials(self):
        """agentrail logout is exempt from the auth gate."""
        mock_logout = MagicMock(return_value=0)
        with patch("agentrail.cli.main.load_credentials", return_value=None, create=True), \
             patch.dict(os.environ, {}, clear=True), \
             patch("agentrail.cli.main.run_logout", mock_logout):
            rc = main(["logout"])
        self.assertEqual(0, rc)
        mock_logout.assert_called_once()

    def test_exempt_whoami_allowed_without_credentials(self):
        """agentrail whoami is exempt from the auth gate."""
        mock_whoami = MagicMock(return_value=0)
        with patch("agentrail.cli.main.load_credentials", return_value=None, create=True), \
             patch.dict(os.environ, {}, clear=True), \
             patch("agentrail.cli.main.run_whoami", mock_whoami):
            rc = main(["whoami"])
        self.assertEqual(0, rc)
        mock_whoami.assert_called_once()

    def test_exempt_help_flag_allowed_without_credentials(self):
        """agentrail --help is exempt from the auth gate."""
        out = StringIO()
        with patch("agentrail.cli.main.load_credentials", return_value=None, create=True), \
             patch.dict(os.environ, {}, clear=True), \
             patch("sys.stdout", out):
            rc = main(["--help"])
        self.assertEqual(0, rc)
        self.assertIn("Usage:", out.getvalue())

    def test_exempt_no_args_allowed_without_credentials(self):
        """Bare agentrail (no args) is exempt from the auth gate."""
        out = StringIO()
        with patch("agentrail.cli.main.load_credentials", return_value=None, create=True), \
             patch.dict(os.environ, {}, clear=True), \
             patch("sys.stdout", out):
            rc = main([])
        self.assertEqual(0, rc)

    # ------------------------------------------------------------------
    # State 3: gated command allowed when credentials present
    #
    # AC: "When load_credentials() returns credentials, every command
    # dispatches exactly as before (no behavior change, no extra output)."
    # ------------------------------------------------------------------

    def test_gated_command_dispatches_when_credentials_present(self):
        """Gated commands dispatch normally when load_credentials() returns creds."""
        mock_run = MagicMock(return_value=0)
        with patch("agentrail.cli.main.load_credentials", return_value=_FAKE_CREDS, create=True), \
             patch.dict(os.environ, {}, clear=True), \
             patch("agentrail.cli.main.run_run", mock_run):
            rc = main(["run"])
        self.assertEqual(0, rc)
        mock_run.assert_called_once()

    # ------------------------------------------------------------------
    # State 4: gated command allowed when AGENTRAIL_SERVER_API_KEY is set
    #
    # AC: "When AGENTRAIL_SERVER_API_KEY is set (runner-internal path),
    # gated commands dispatch even if ~/.agentrail/credentials.json is absent."
    # ------------------------------------------------------------------

    def test_gated_command_dispatches_when_env_key_present(self):
        """Gated commands dispatch when AGENTRAIL_SERVER_API_KEY is set, even without credentials."""
        mock_run = MagicMock(return_value=0)
        with patch("agentrail.cli.main.load_credentials", return_value=None, create=True), \
             patch.dict(os.environ, {"AGENTRAIL_SERVER_API_KEY": "sk-runner-key"}, clear=True), \
             patch("agentrail.cli.main.run_run", mock_run):
            rc = main(["run"])
        self.assertEqual(0, rc)
        mock_run.assert_called_once()

    # ------------------------------------------------------------------
    # State 5: offline commands are exempt from the gate
    #
    # The gate attributes *usage* to a workspace, so commands that run fully
    # offline (project scaffolding, local health/index/state queries) must work
    # WITHOUT credentials — gating them would block first-run setup.
    # ------------------------------------------------------------------

    def test_offline_commands_allowed_without_credentials(self):
        """init/install/upgrade/doctor/context/memory/cleanup/status/timeline/cost/link/console are not gated."""
        cases = {
            "init": "run_install",  # bare `init` routes to install
            "install": "run_install",
            "upgrade": "run_upgrade",
            "doctor": "run_doctor",
            "context": "run_context",
            "memory": "run_memory",
            "cleanup": "run_cleanup",
            "status": "run_status",
            "timeline": "run_timeline",
            "cost": "run_cost",
            "link": "run_link",
            "console": "run_console",
        }
        for command, target in cases.items():
            with self.subTest(command=command):
                mock_cmd = MagicMock(return_value=0)
                with patch("agentrail.cli.main.load_credentials", return_value=None, create=True), \
                     patch.dict(os.environ, {}, clear=True), \
                     patch(f"agentrail.cli.main.{target}", mock_cmd):
                    rc = main([command])
                self.assertEqual(0, rc, f"{command} should be exempt from the auth gate")
                mock_cmd.assert_called_once()


if __name__ == "__main__":
    unittest.main()
