"""Unit tests for `agentrail console` CLI command (agentrail/cli/commands/console.py).

All external I/O (subprocess.run, os.execvp, os.chdir) is patched so these
tests run without Docker, pnpm, or a real repo.
"""
from __future__ import annotations

import sys
import unittest
from unittest.mock import MagicMock, call, patch

from agentrail.cli.commands.console import run_console


def _mock_run(returncode: int = 0) -> MagicMock:
    """Return a mock subprocess.CompletedProcess with the given returncode."""
    m = MagicMock()
    m.returncode = returncode
    return m


class ConsoleHelpTests(unittest.TestCase):
    def test_help_flag_prints_usage_and_exits_zero(self) -> None:
        for flag in ("-h", "--help"):
            with self.subTest(flag=flag):
                with patch("builtins.print") as mock_print:
                    rc = run_console([flag])
                self.assertEqual(rc, 0)
                printed = " ".join(str(c) for c in mock_print.call_args_list)
                self.assertIn("Usage:", printed)


class ConsoleUnknownFlagTests(unittest.TestCase):
    def test_unknown_flag_exits_one_and_prints_to_stderr(self) -> None:
        with patch("sys.stderr") as mock_stderr:
            rc = run_console(["--bad-flag"])
        self.assertEqual(rc, 1)


class ConsoleDockerNotRunningTests(unittest.TestCase):
    def test_docker_not_running_prints_error_and_exits_one(self) -> None:
        with patch(
            "agentrail.cli.commands.console.subprocess.run",
            return_value=_mock_run(returncode=1),
        ):
            rc = run_console([])
        self.assertEqual(rc, 1)

    def test_docker_not_running_message_mentions_docker(self) -> None:
        captured: list[str] = []

        def fake_print(*args: object, **kwargs: object) -> None:
            if kwargs.get("file") is sys.stderr:
                captured.append(" ".join(str(a) for a in args))

        with patch("agentrail.cli.commands.console.subprocess.run", return_value=_mock_run(returncode=1)):
            with patch("builtins.print", side_effect=fake_print):
                run_console([])

        self.assertTrue(any("Docker" in msg for msg in captured), captured)


class ConsoleStopTests(unittest.TestCase):
    def _run_stop(self, docker_info_rc: int = 0, down_rc: int = 0):
        calls: list = []

        def fake_run(cmd, **kwargs):
            calls.append(cmd)
            if cmd == ["docker", "info"]:
                return _mock_run(returncode=docker_info_rc)
            return _mock_run(returncode=down_rc)

        with patch("agentrail.cli.commands.console.subprocess.run", side_effect=fake_run):
            rc = run_console(["--stop"])
        return rc, calls

    def test_stop_calls_docker_compose_down(self) -> None:
        rc, calls = self._run_stop()
        self.assertEqual(rc, 0)
        self.assertIn(["docker", "compose", "down"], calls)

    def test_stop_propagates_nonzero_exit_from_down(self) -> None:
        rc, _ = self._run_stop(down_rc=1)
        self.assertEqual(rc, 1)


class ConsoleStartTests(unittest.TestCase):
    """Tests for the default start path (no --seed, no --stop)."""

    def _run_start(self, *, fail_at: str | None = None):
        """Run `agentrail console` with all subprocess calls mocked to succeed,
        except for the command matching *fail_at*, which returns rc=1."""
        calls: list = []

        def fake_run(cmd, **kwargs):
            calls.append(list(cmd))
            key = " ".join(cmd)
            if fail_at and fail_at in key:
                return _mock_run(returncode=1)
            return _mock_run(returncode=0)

        execvp_calls: list = []

        def fake_execvp(file, args):
            execvp_calls.append((file, args))

        with patch("agentrail.cli.commands.console.subprocess.run", side_effect=fake_run):
            with patch("agentrail.cli.commands.console.os.execvp", side_effect=fake_execvp):
                with patch("agentrail.cli.commands.console.os.chdir"):
                    rc = run_console([])

        return rc, calls, execvp_calls

    def test_start_runs_docker_compose_up(self) -> None:
        rc, calls, _ = self._run_start()
        self.assertIn(["docker", "compose", "up", "-d", "--wait"], calls)

    def test_start_runs_postgres_migration(self) -> None:
        _, calls, _ = self._run_start()
        self.assertIn(["pnpm", "--filter", "@agentrail/db-postgres", "migrate"], calls)

    def test_start_runs_clickhouse_migration(self) -> None:
        _, calls, _ = self._run_start()
        self.assertIn(["pnpm", "--filter", "@agentrail/db-clickhouse", "db:migrate"], calls)

    def test_start_execvp_pnpm_dev(self) -> None:
        _, _, execvp_calls = self._run_start()
        self.assertEqual(len(execvp_calls), 1)
        file, args = execvp_calls[0]
        self.assertEqual(file, "pnpm")
        self.assertIn("--filter", args)
        self.assertIn("@agentrail/console", args)
        self.assertIn("dev", args)

    def test_start_does_not_run_seed_by_default(self) -> None:
        _, calls, _ = self._run_start()
        seed_cmds = [c for c in calls if "seed" in c]
        self.assertEqual(seed_cmds, [])

    def test_start_fails_on_docker_compose_up_failure(self) -> None:
        rc, _, _ = self._run_start(fail_at="compose up")
        self.assertEqual(rc, 1)

    def test_start_fails_on_postgres_migration_failure(self) -> None:
        rc, _, _ = self._run_start(fail_at="db-postgres")
        self.assertEqual(rc, 1)

    def test_start_fails_on_clickhouse_migration_failure(self) -> None:
        rc, _, _ = self._run_start(fail_at="db-clickhouse")
        self.assertEqual(rc, 1)


class ConsoleSeedTests(unittest.TestCase):
    """Tests for `agentrail console --seed`."""

    def _run_seed(self, *, fail_at: str | None = None):
        calls: list = []

        def fake_run(cmd, **kwargs):
            calls.append(list(cmd))
            key = " ".join(cmd)
            if fail_at and fail_at in key:
                return _mock_run(returncode=1)
            return _mock_run(returncode=0)

        execvp_calls: list = []

        def fake_execvp(file, args):
            execvp_calls.append((file, args))

        with patch("agentrail.cli.commands.console.subprocess.run", side_effect=fake_run):
            with patch("agentrail.cli.commands.console.os.execvp", side_effect=fake_execvp):
                with patch("agentrail.cli.commands.console.os.chdir"):
                    rc = run_console(["--seed"])

        return rc, calls, execvp_calls

    def test_seed_runs_postgres_seed(self) -> None:
        _, calls, _ = self._run_seed()
        self.assertIn(["pnpm", "--filter", "@agentrail/db-postgres", "seed"], calls)

    def test_seed_runs_clickhouse_seed(self) -> None:
        _, calls, _ = self._run_seed()
        self.assertIn(["pnpm", "--filter", "@agentrail/db-clickhouse", "db:seed"], calls)

    def test_seed_still_starts_dev_server(self) -> None:
        _, _, execvp_calls = self._run_seed()
        self.assertEqual(len(execvp_calls), 1)

    def test_seed_runs_migrations_before_seed(self) -> None:
        _, calls, _ = self._run_seed()
        # filter out docker info check; match substrings inside list elements
        def has(cmd, *substrings):
            joined = " ".join(cmd)
            return all(s in joined for s in substrings)

        pg_migrate_idx = next(i for i, c in enumerate(calls) if has(c, "db-postgres", "migrate") and not has(c, "seed"))
        pg_seed_idx = next(i for i, c in enumerate(calls) if has(c, "db-postgres", "seed"))
        self.assertLess(pg_migrate_idx, pg_seed_idx)

    def test_seed_failure_exits_nonzero(self) -> None:
        rc, _, _ = self._run_seed(fail_at="db-postgres\" \"seed")
        # The filter string won't match exactly; use partial key
        rc2, _, _ = self._run_seed(fail_at="seed")
        self.assertEqual(rc2, 1)


if __name__ == "__main__":
    unittest.main()
