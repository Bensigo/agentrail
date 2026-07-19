"""run_afk's hosted-repo quarantine guard (#1271).

AFK can auto-merge once its review gate passes (opt-in, `--auto-merge`,
#1278, default OFF), so it must refuse to even START against a repo
connected to a hosted customer workspace other than the operator's own —
regardless of `--auto-merge`, since this guard is about which repo AFK may
touch at all, a separate question from whether a merge is permitted once
it's running. These tests exercise the guard entirely through run_afk: git's
`origin` remote lookup and the dirty-tree check both go through the same
patched `subprocess.run` seam (routed by inspecting argv, since both git
subcommands share it); the hosted-workspace DB lookup is patched at
`hosted_repo_guard.resolve_foreign_workspaces` so no real Postgres is ever
touched.
"""
from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch


def _sp_side_effect(*, remote_stdout: str, remote_rc: int = 0, dirty_stdout: str = ""):
    """A subprocess.run side_effect that routes on argv: `git remote get-url
    origin` gets (remote_rc, remote_stdout); `git status --porcelain` (or
    anything else, e.g. `gh ...`) gets a clean-tree/empty-stdout result.
    """

    def _run(args, **kwargs):
        if "remote" in args and "get-url" in args:
            return MagicMock(returncode=remote_rc, stdout=remote_stdout)
        return MagicMock(returncode=0, stdout=dirty_stdout)

    return _run


class RunAfkHostedRepoQuarantineTests(unittest.TestCase):
    def _run(self, extra_args=None, *, remote_stdout, remote_rc=0, env=None,
              foreign=None, db_notice=None):
        """Run run_afk with git/gh/Runner/asyncio all mocked; returns
        (rc, stderr_text, gh_mock, runner_mock, resolve_mock).
        """
        import io
        import contextlib

        issues = [{"number": 1, "title": "t", "url": ""}]
        env = env or {}

        with patch("agentrail.cli.commands.afk.gh") as gh_mock, \
                patch("agentrail.cli.commands.afk.subprocess.run",
                      side_effect=_sp_side_effect(
                          remote_stdout=remote_stdout, remote_rc=remote_rc)), \
                patch("agentrail.cli.commands.afk.build_store") as build_store_mock, \
                patch("agentrail.cli.commands.afk.Runner") as runner_mock, \
                patch("agentrail.cli.commands.afk.asyncio.run",
                      return_value=MagicMock(completed=1, failed=0)), \
                patch("agentrail.afk.hosted_repo_guard.resolve_foreign_workspaces",
                      return_value=(foreign or [], db_notice)) as resolve_mock, \
                patch.dict("os.environ", env, clear=False):
            gh_mock.list_queue_issues.return_value = issues
            from agentrail.cli.commands.afk import run_afk

            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                rc = run_afk((extra_args or []) + ["--target", "/tmp/does-not-matter"])
        return rc, stderr.getvalue(), gh_mock, runner_mock, build_store_mock, resolve_mock

    # -- AC1: foreign workspace repo -> refusal ---------------------------- #

    def test_foreign_workspace_refuses_to_start(self) -> None:
        rc, err, gh_mock, runner_mock, build_store_mock, resolve_mock = self._run(
            remote_stdout="https://github.com/acme/widgets.git\n",
            env={"AGENTRAIL_WORKSPACE_ID": "ws-own"},
            foreign=["ws-customer"],
        )
        self.assertEqual(rc, 1)
        self.assertIn("AFK refuses to start", err)
        self.assertIn("acme/widgets", err)
        self.assertIn("#1278", err)
        self.assertIn("--allow-hosted-repo", err)
        gh_mock.list_queue_issues.assert_not_called()
        runner_mock.assert_not_called()
        build_store_mock.assert_not_called()

    def test_foreign_workspace_refusal_names_own_workspace(self) -> None:
        _, err, *_ = self._run(
            remote_stdout="https://github.com/acme/widgets.git\n",
            env={"AGENTRAIL_WORKSPACE_ID": "ws-own"},
            foreign=["ws-customer"],
        )
        self.assertIn("ws-own", err)

    # -- AC2: repo connected ONLY to the operator's own workspace ---------- #

    def test_own_workspace_only_proceeds(self) -> None:
        # resolve_foreign_workspaces already excludes the operator's own
        # workspace internally; simulate that here by returning no foreign
        # matches at all (the same repo IS connected, just not to anyone else).
        rc, err, gh_mock, runner_mock, build_store_mock, resolve_mock = self._run(
            remote_stdout="https://github.com/acme/widgets.git\n",
            env={"AGENTRAIL_WORKSPACE_ID": "ws-own"},
            foreign=[],
        )
        self.assertEqual(rc, 0)
        self.assertNotIn("refuses to start", err)
        gh_mock.list_queue_issues.assert_called_once()
        runner_mock.assert_called_once()

    def test_resolver_receives_parsed_slug_and_own_workspace(self) -> None:
        rc, err, gh_mock, runner_mock, build_store_mock, resolve_mock = self._run(
            remote_stdout="https://github.com/acme/widgets.git\n",
            env={"AGENTRAIL_WORKSPACE_ID": "ws-own"},
            foreign=[],
        )
        args, kwargs = resolve_mock.call_args
        self.assertEqual(args[0], "acme/widgets")
        self.assertEqual(kwargs["own_workspace_id"], "ws-own")

    # -- AC1's override: --allow-hosted-repo -------------------------------- #

    def test_override_flag_proceeds_and_logs(self) -> None:
        rc, err, gh_mock, runner_mock, build_store_mock, resolve_mock = self._run(
            ["--allow-hosted-repo"],
            remote_stdout="https://github.com/acme/widgets.git\n",
            env={"AGENTRAIL_WORKSPACE_ID": "ws-own"},
            foreign=["ws-customer"],
        )
        self.assertEqual(rc, 0)
        self.assertIn("override ACTIVE", err)
        self.assertIn("acme/widgets", err)
        gh_mock.list_queue_issues.assert_called_once()
        runner_mock.assert_called_once()

    def test_override_appears_in_run_banner(self) -> None:
        import io
        import contextlib

        with patch("agentrail.cli.commands.afk.gh") as gh_mock, \
                patch("agentrail.cli.commands.afk.subprocess.run",
                      side_effect=_sp_side_effect(
                          remote_stdout="https://github.com/acme/widgets.git\n")), \
                patch("agentrail.cli.commands.afk.build_store"), \
                patch("agentrail.cli.commands.afk.Runner"), \
                patch("agentrail.cli.commands.afk.asyncio.run",
                      return_value=MagicMock(completed=1, failed=0)), \
                patch("agentrail.afk.hosted_repo_guard.resolve_foreign_workspaces",
                      return_value=(["ws-customer"], None)), \
                patch.dict("os.environ", {"AGENTRAIL_WORKSPACE_ID": "ws-own"}, clear=False):
            gh_mock.list_queue_issues.return_value = [{"number": 1, "title": "t", "url": ""}]
            from agentrail.cli.commands.afk import run_afk

            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                rc = run_afk(["--allow-hosted-repo", "--target", "/tmp/does-not-matter"])
        self.assertEqual(rc, 0)
        self.assertIn("OVERRIDE ACTIVE", stdout.getvalue())

    def test_override_marker_appears_in_dry_run_summary(self) -> None:
        # The override marker previously only reached the final run banner —
        # --dry-run returns before that banner is ever printed, so a dry-run
        # under the override silently dropped the marker entirely.
        import io
        import contextlib

        with patch("agentrail.cli.commands.afk.gh") as gh_mock, \
                patch("agentrail.cli.commands.afk.subprocess.run",
                      side_effect=_sp_side_effect(
                          remote_stdout="https://github.com/acme/widgets.git\n")), \
                patch("agentrail.cli.commands.afk.Runner"), \
                patch("agentrail.afk.hosted_repo_guard.resolve_foreign_workspaces",
                      return_value=(["ws-customer"], None)), \
                patch.dict("os.environ", {"AGENTRAIL_WORKSPACE_ID": "ws-own"}, clear=False):
            gh_mock.list_queue_issues.return_value = [{"number": 1, "title": "t", "url": ""}]
            from agentrail.cli.commands.afk import run_afk

            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                rc = run_afk(["--allow-hosted-repo", "--dry-run",
                              "--target", "/tmp/does-not-matter"])
        self.assertEqual(rc, 0)
        self.assertIn("dry-run", stdout.getvalue())
        self.assertIn("OVERRIDE ACTIVE", stdout.getvalue())

    def test_override_marker_appears_in_no_queued_issues_message(self) -> None:
        # Same gap as the dry-run summary: an empty queue also returns before
        # the final run banner, so the marker needs to be on this message too.
        import io
        import contextlib

        with patch("agentrail.cli.commands.afk.gh") as gh_mock, \
                patch("agentrail.cli.commands.afk.subprocess.run",
                      side_effect=_sp_side_effect(
                          remote_stdout="https://github.com/acme/widgets.git\n")), \
                patch("agentrail.cli.commands.afk.Runner"), \
                patch("agentrail.afk.hosted_repo_guard.resolve_foreign_workspaces",
                      return_value=(["ws-customer"], None)), \
                patch.dict("os.environ", {"AGENTRAIL_WORKSPACE_ID": "ws-own"}, clear=False):
            gh_mock.list_queue_issues.return_value = []
            from agentrail.cli.commands.afk import run_afk

            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                rc = run_afk(["--allow-hosted-repo", "--target", "/tmp/does-not-matter"])
        self.assertEqual(rc, 0)
        self.assertIn("no queued issues", stdout.getvalue())
        self.assertIn("OVERRIDE ACTIVE", stdout.getvalue())

    # -- DB unreachable degrades to proceed --------------------------------- #

    def test_db_unreachable_proceeds_with_notice(self) -> None:
        rc, err, gh_mock, runner_mock, build_store_mock, resolve_mock = self._run(
            remote_stdout="https://github.com/acme/widgets.git\n",
            env={"AGENTRAIL_WORKSPACE_ID": "ws-own"},
            foreign=[],
            db_notice="hosted-repo quarantine check skipped: no database reachable",
        )
        self.assertEqual(rc, 0)
        self.assertIn("no database reachable", err)
        gh_mock.list_queue_issues.assert_called_once()
        runner_mock.assert_called_once()

    # -- ssh vs https origin forms both normalize --------------------------- #

    def test_https_origin_form_triggers_refusal(self) -> None:
        rc, err, *_ = self._run(
            remote_stdout="https://github.com/acme/widgets.git\n",
            env={"AGENTRAIL_WORKSPACE_ID": "ws-own"},
            foreign=["ws-customer"],
        )
        self.assertEqual(rc, 1)
        self.assertIn("acme/widgets", err)

    def test_ssh_origin_form_triggers_refusal(self) -> None:
        rc, err, *_ = self._run(
            remote_stdout="git@github.com:acme/widgets.git\n",
            env={"AGENTRAIL_WORKSPACE_ID": "ws-own"},
            foreign=["ws-customer"],
        )
        self.assertEqual(rc, 1)
        self.assertIn("acme/widgets", err)

    def test_ssh_and_https_forms_resolve_the_same_slug(self) -> None:
        _, _, _, _, _, resolve_https = self._run(
            remote_stdout="https://github.com/acme/widgets.git\n",
            env={"AGENTRAIL_WORKSPACE_ID": "ws-own"}, foreign=[],
        )
        _, _, _, _, _, resolve_ssh = self._run(
            remote_stdout="git@github.com:acme/widgets.git\n",
            env={"AGENTRAIL_WORKSPACE_ID": "ws-own"}, foreign=[],
        )
        self.assertEqual(resolve_https.call_args.args[0], resolve_ssh.call_args.args[0])
        self.assertEqual(resolve_https.call_args.args[0], "acme/widgets")

    # -- unparseable / absent origin: proceeds with a distinct notice ------- #

    def test_no_origin_remote_proceeds_with_notice(self) -> None:
        rc, err, gh_mock, runner_mock, build_store_mock, resolve_mock = self._run(
            remote_stdout="", remote_rc=128,
        )
        self.assertEqual(rc, 0)
        self.assertIn("could not determine a GitHub owner/repo", err)
        resolve_mock.assert_not_called()
        gh_mock.list_queue_issues.assert_called_once()
        runner_mock.assert_called_once()

    def test_non_github_origin_proceeds_with_notice(self) -> None:
        rc, err, gh_mock, runner_mock, build_store_mock, resolve_mock = self._run(
            remote_stdout="https://gitlab.com/acme/widgets.git\n",
        )
        self.assertEqual(rc, 0)
        self.assertIn("origin remote not recognized as github.com", err)
        self.assertIn("https://gitlab.com/acme/widgets.git", err)
        resolve_mock.assert_not_called()
        gh_mock.list_queue_issues.assert_called_once()

    def test_ssh_host_alias_origin_proceeds_with_alias_specific_notice(self) -> None:
        # An SSH remote using a custom Host alias (configured in ~/.ssh/config)
        # instead of the literal "github.com" host — this module deliberately
        # does not read ssh config to resolve it, so it must surface as an
        # unparseable origin, and the notice must say why (rather than the
        # generic "could not determine" message, which gives no hint that the
        # remote actually IS github, just aliased).
        rc, err, gh_mock, runner_mock, build_store_mock, resolve_mock = self._run(
            remote_stdout="git@github-work:acme/widgets.git\n",
        )
        self.assertEqual(rc, 0)
        self.assertIn("SSH host aliases are not resolved", err)
        self.assertIn("git@github-work:acme/widgets.git", err)
        resolve_mock.assert_not_called()
        gh_mock.list_queue_issues.assert_called_once()
        runner_mock.assert_called_once()

    # -- no match anywhere: silent proceed ----------------------------------- #

    def test_unconnected_repo_proceeds_silently(self) -> None:
        rc, err, gh_mock, runner_mock, build_store_mock, resolve_mock = self._run(
            remote_stdout="https://github.com/acme/widgets.git\n",
            env={"AGENTRAIL_WORKSPACE_ID": "ws-own"},
            foreign=[], db_notice=None,
        )
        self.assertEqual(rc, 0)
        self.assertEqual(err, "")
        runner_mock.assert_called_once()


if __name__ == "__main__":
    unittest.main()
