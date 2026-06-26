"""Tests for AFK run-cost capture + reporting.

Covers the two seams this change adds:
- ``_read_run_cost`` sums the pipeline's per-phase cost ledger in the worktree,
  and is best-effort (missing/malformed ledger -> 0.0, never raises).
- ``Runner._register_run`` forwards the issue state's ``cost_usd`` into
  ``register_run`` — so cost reaches ingest even on a failed run (the
  finally-block in ``_process`` re-reads ``final_issue`` from the store first).

No network, subprocess, or agent is launched: ``register_run`` is monkeypatched
to capture its kwargs, and only the module-level helper / a bare Runner are used.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from agentrail.afk import runner as runner_mod
from agentrail.afk.runner import Runner, _read_run_cost
from agentrail.afk.state import AfkState, IssueState, IssueStatus, Store


# ---------------------------------------------------------------------------
# _read_run_cost — ledger parser
# ---------------------------------------------------------------------------


def _write_ledger(wt: Path, lines: list[str]) -> None:
    p = wt / ".agentrail" / "run"
    p.mkdir(parents=True, exist_ok=True)
    (p / "cost-events.jsonl").write_text("\n".join(lines))


def test_read_run_cost_sums_phases(tmp_path: Path) -> None:
    _write_ledger(tmp_path, [
        json.dumps({"phase": "plan", "cost_usd": 0.10}),
        json.dumps({"phase": "execute", "cost_usd": 0.25}),
        json.dumps({"phase": "review", "cost_usd": 0.05}),
    ])
    assert _read_run_cost(tmp_path) == pytest.approx(0.40)


def test_read_run_cost_missing_ledger_is_zero(tmp_path: Path) -> None:
    assert _read_run_cost(tmp_path) == 0.0


def test_read_run_cost_tolerates_blank_and_malformed_lines(tmp_path: Path) -> None:
    _write_ledger(tmp_path, [
        json.dumps({"cost_usd": 0.20}),
        "",
        "not json",
        json.dumps({"cost_usd": None}),  # null coerces to 0.0
        json.dumps({"phase": "x"}),       # missing key -> 0.0
        json.dumps({"cost_usd": 0.30}),
    ])
    assert _read_run_cost(tmp_path) == pytest.approx(0.50)


# ---------------------------------------------------------------------------
# Runner._register_run — forwards state cost into register_run
# ---------------------------------------------------------------------------


def _bare_runner(tmp_path: Path) -> Runner:
    store = Store(AfkState(concurrency=1, slots={0: None}))
    store._session_id = "sess-cost"
    return Runner(
        tmp_path, engine="claude", base="main", concurrency=1,
        afk_label="afk", queue_labels=["afk"], run_dir=tmp_path / "run",
        store=store,
    )


def test_register_run_forwards_state_cost(tmp_path: Path, monkeypatch) -> None:
    captured: dict = {}

    def fake_register_run(target, **kwargs):
        captured.update(kwargs)
        return True

    monkeypatch.setattr(
        "agentrail.afk.run_register.register_run", fake_register_run
    )

    r = _bare_runner(tmp_path)
    issue = IssueState(number=7, title="t", url="u",
                       status=IssueStatus.FAILED, cost_usd=1.23)
    # finished=True is the failure path: cost must still be reported.
    r._register_run(issue, "failed", finished=True)
    assert captured["cost_usd"] == 1.23


def test_register_run_defaults_cost_to_zero_when_unset(tmp_path: Path, monkeypatch) -> None:
    captured: dict = {}

    def fake_register_run(target, **kwargs):
        captured.update(kwargs)
        return True

    monkeypatch.setattr(
        "agentrail.afk.run_register.register_run", fake_register_run
    )

    r = _bare_runner(tmp_path)
    issue = IssueState(number=8, title="t", url="u", status=IssueStatus.RUNNING)
    r._register_run(issue, "running", started=True)
    assert captured["cost_usd"] == 0.0
