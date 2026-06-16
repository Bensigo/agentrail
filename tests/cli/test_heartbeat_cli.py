"""Tests for ``agentrail heartbeat run`` CLI (agentrail/cli/commands/heartbeat.py).

The CLI is the only place real adapters are constructed, so the tests inject a
fake runtime factory and assert the loop control flow (``--once`` = one cycle,
gate-disabled refusal) without constructing Postgres / Docker / GitHub clients.
"""
from __future__ import annotations

from io import StringIO
from unittest.mock import patch

from agentrail.cli.commands.heartbeat import run_heartbeat
from agentrail.heartbeat.runtime import CycleReport


class FakeRuntime:
    def __init__(self, reports):
        self._reports = list(reports)
        self.cycles = 0

    def poll_and_dispatch(self, workspace_id):
        self.cycles += 1
        if self._reports:
            return self._reports.pop(0)
        return CycleReport(polled=0, enqueued=0, dispatched=0)


def test_help_returns_zero():
    with patch("sys.stdout", new=StringIO()):
        assert run_heartbeat(["-h"]) == 0


def test_once_runs_a_single_cycle_with_injected_runtime():
    fake = FakeRuntime([CycleReport(polled=1, enqueued=1, dispatched=1, green=1)])
    out = StringIO()
    with patch("sys.stdout", new=out):
        rc = run_heartbeat(
            ["run", "--workspace", "ws-1", "--once"],
            runtime_factory=lambda **_: fake,
        )
    assert rc == 0
    assert fake.cycles == 1
    text = out.getvalue()
    assert "dispatched=1" in text or "dispatched 1" in text


def test_once_gate_disabled_reports_off_and_exits_clean():
    fake = FakeRuntime([CycleReport.disabled()])
    out = StringIO()
    with patch("sys.stdout", new=out):
        rc = run_heartbeat(
            ["run", "--workspace", "ws-1", "--once"],
            runtime_factory=lambda **_: fake,
        )
    assert rc == 0
    assert fake.cycles == 1
    assert "disabled" in out.getvalue().lower() or "off" in out.getvalue().lower()


def test_missing_workspace_is_usage_error():
    err = StringIO()
    with patch("sys.stderr", new=err):
        rc = run_heartbeat(["run", "--once"], runtime_factory=lambda **_: FakeRuntime([]))
    assert rc == 2


def test_run_subcommand_required():
    err = StringIO()
    with patch("sys.stderr", new=err):
        rc = run_heartbeat(["bogus"], runtime_factory=lambda **_: FakeRuntime([]))
    assert rc == 2


def test_factory_receives_connector_kwargs_defaulting_to_none():
    # Without override flags, the daemon configures itself from the connector:
    # the factory is called with repos/trigger_label/interval = None so
    # _build_runtime sources them from list_active_connectors.
    seen = {}

    def factory(**kw):
        seen.update(kw)
        return FakeRuntime([CycleReport(polled=0, enqueued=0, dispatched=0)])

    with patch("sys.stdout", new=StringIO()):
        rc = run_heartbeat(
            ["run", "--workspace", "ws-1", "--once"], runtime_factory=factory
        )
    assert rc == 0
    assert seen["repos"] is None
    assert seen["trigger_label"] is None
    assert seen["interval"] is None


def test_override_flags_are_passed_to_factory():
    seen = {}

    def factory(**kw):
        seen.update(kw)
        return FakeRuntime([CycleReport(polled=0, enqueued=0, dispatched=0)])

    with patch("sys.stdout", new=StringIO()):
        run_heartbeat(
            [
                "run",
                "--workspace",
                "ws-1",
                "--once",
                "--repos",
                "o/r,a/b",
                "--trigger-label",
                "afk",
                "--interval",
                "300",
            ],
            runtime_factory=factory,
        )
    assert seen["repos"] == ["o/r", "a/b"]
    assert seen["trigger_label"] == "afk"
    assert seen["interval"] == 300


def test_loop_sleeps_on_connector_derived_interval():
    # When the factory returns (runtime, interval) — as the real one does after
    # reading the connector — the loop sleeps on that interval, not the CLI default.
    fake = FakeRuntime([CycleReport(polled=0, enqueued=0, dispatched=0)])
    slept: list = []

    def boom(_):
        slept.append(_)
        raise KeyboardInterrupt

    with patch("sys.stdout", new=StringIO()), patch("sys.stderr", new=StringIO()):
        rc = run_heartbeat(
            ["run", "--workspace", "ws-1"],
            runtime_factory=lambda **_: (fake, 222),
            sleep=boom,
        )
    assert rc == 0
    assert slept == [222]
