"""AFK -> Langfuse session propagation (Task 4, langfuse-tracing-shadow-judge
PRD Phase 1/2 plan).

Task 3 wired ``agentrail/run/pipeline.py``'s ``_run_pipeline`` to read
``AGENTRAIL_LANGFUSE_SESSION_ID`` from the environment at the
``RunTracer.start(...)`` call site, so every phase of one ``agentrail run
issue`` invocation attaches to the same Langfuse session when the env var is
set. This task is the PRODUCER half: ``agentrail/afk/runner.py``'s
``Runner._implement`` launches that CLI as a subprocess (via ``_sh``) once per
queued GitHub issue, and must set that env var before launching it so the
implement phase for one AFK work-item (one issue) is traceable as one
session.

Session id shape: ``afk-<issue>-<runner start iso>`` — computed once in
``Runner.__init__`` (the iso timestamp) and combined with the issue number in
``Runner._langfuse_session_id`` at each ``_implement`` call. This keeps the id
constant across retries of the SAME issue within one ``agentrail afk``
invocation (the iso timestamp never changes for the life of the Runner
instance), while still differing per issue (so two issues processed by the
same run land in different sessions) and per separate `agentrail afk` runs on
the same issue (different start iso).

Fixture pattern copied from ``agentrail/tests/afk/test_afk_options.py``'s
``RunnerForwardsBudgetTests`` (the existing convention for driving
``Runner._implement`` with ``_setup_worktree`` and ``_sh`` mocked out, and
``load_link`` stubbed so no real dashboard-link file is required).
"""
from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from agentrail.afk.runner import Runner
from agentrail.afk.state import AfkState, EnqueueIssue, Store


def _make_runner(tmp_path: Path, *, issues: list) -> Runner:
    """Construct a Runner with `issues` pre-enqueued, without touching git."""
    target = tmp_path / "main"
    target.mkdir(exist_ok=True)
    run_dir = tmp_path / "run"
    run_dir.mkdir(exist_ok=True)
    store = Store(AfkState(
        concurrency=1,
        max_retries=1,
        max_review_rounds=1,
        slots={0: None},
    ))
    for number in issues:
        # _implement dispatches RecordCost(number), which requires the issue
        # to already exist in state — mirrors the real enqueue-before-run flow.
        store.dispatch(EnqueueIssue(number=number, title="t", url=f"http://x/{number}"))
    return Runner(
        target=target,
        engine="claude",
        base="main",
        concurrency=1,
        afk_label="afk",
        queue_labels=["ready"],
        run_dir=run_dir,
        store=store,
    )


def _run_implement(runner: Runner, issue: int) -> dict:
    """Drive `_implement` for `issue` with worktree setup, `_sh`, and the
    dashboard-link lookup all stubbed out. Returns the `env` kwarg `_sh` was
    called with."""
    sh_mock = AsyncMock(return_value=0)
    with patch.object(Runner, "_setup_worktree"), \
            patch("agentrail.afk.runner._sh", sh_mock), \
            patch("agentrail.context.snapshot_push.load_link", return_value=None):
        ok = asyncio.run(runner._implement(0, issue))
    assert ok is True
    return sh_mock.call_args.kwargs["env"]


class SessionEnvPresentTests(unittest.TestCase):
    """The env dict passed to `_sh` for `_implement` carries the session id."""

    def test_session_env_var_present_with_expected_shape(self):
        with tempfile.TemporaryDirectory() as td:
            runner = _make_runner(Path(td), issues=[1])
            env = _run_implement(runner, 1)

        self.assertIn("AGENTRAIL_LANGFUSE_SESSION_ID", env)
        expected = f"afk-1-{runner._start_iso}"
        self.assertEqual(env["AGENTRAIL_LANGFUSE_SESSION_ID"], expected)

    def test_session_env_preserves_rest_of_os_environ(self):
        """Setting the session id must not clobber the inherited environment
        (e.g. the dashboard-link vars set two lines above it in _implement)."""
        with tempfile.TemporaryDirectory() as td:
            runner = _make_runner(Path(td), issues=[1])
            env = _run_implement(runner, 1)

        import os
        self.assertEqual(env.get("PATH"), os.environ.get("PATH"))


class SessionEnvConstantPerItemTests(unittest.TestCase):
    """Constant across retries/phases of the SAME work-item, distinct across
    different work-items processed by the same Runner instance."""

    def test_session_id_identical_across_retries_of_same_issue(self):
        with tempfile.TemporaryDirectory() as td:
            runner = _make_runner(Path(td), issues=[5])
            first = _run_implement(runner, 5)["AGENTRAIL_LANGFUSE_SESSION_ID"]
            second = _run_implement(runner, 5)["AGENTRAIL_LANGFUSE_SESSION_ID"]

        self.assertEqual(first, second)

    def test_session_id_differs_across_issues_same_runner(self):
        with tempfile.TemporaryDirectory() as td:
            runner = _make_runner(Path(td), issues=[1, 2])
            env_1 = _run_implement(runner, 1)
            env_2 = _run_implement(runner, 2)

        sid_1 = env_1["AGENTRAIL_LANGFUSE_SESSION_ID"]
        sid_2 = env_2["AGENTRAIL_LANGFUSE_SESSION_ID"]
        self.assertNotEqual(sid_1, sid_2)
        # Both share the same runner-start suffix (one `agentrail afk` run).
        self.assertTrue(sid_1.endswith(runner._start_iso))
        self.assertTrue(sid_2.endswith(runner._start_iso))

    def test_session_id_differs_across_separate_runner_instances(self):
        """Two separate `agentrail afk` invocations (two Runner instances) on
        the same issue must NOT collide on the same Langfuse session."""
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            runner_a = _make_runner(tmp, issues=[9])
            runner_b = _make_runner(tmp, issues=[9])
            # Force distinct start timestamps even if the two constructions
            # land in the same wall-clock instant on a fast machine.
            runner_a._start_iso = "2026-07-13T00:00:00+00:00"
            runner_b._start_iso = "2026-07-13T00:00:01+00:00"

            env_a = _run_implement(runner_a, 9)
            env_b = _run_implement(runner_b, 9)

        self.assertNotEqual(
            env_a["AGENTRAIL_LANGFUSE_SESSION_ID"],
            env_b["AGENTRAIL_LANGFUSE_SESSION_ID"],
        )


if __name__ == "__main__":
    unittest.main()
