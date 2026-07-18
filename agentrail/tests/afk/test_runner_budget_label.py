"""Tests for AFK's budget check-in failure labeling (#1269 PR2b item 1).

Covers the seams this change adds:
- ``_run_json_path`` locates an issue's run.json inside a worktree, either
  deterministically (session id known) or by globbing a fresh worktree's
  single run dir (no session id).
- ``_budget_stop_reason`` reads run.json's ``blockedReason`` verbatim — the
  EXACT source-aware check-in string ``agentrail/run/pipeline.py`` already
  composed — never re-deriving or pasting a copy of it.
- ``Runner._process`` labels an implement-failure distinctly when the budget
  leash tripped, and stays byte-identical to the generic "implementation
  failed" reason otherwise (regression-pin).

No network, subprocess, or agent is launched.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from agentrail.afk.run_register import run_uuid
from agentrail.afk.runner import Runner, _budget_stop_reason, _run_json_path
from agentrail.afk.state import AfkState, IssueState, IssueStatus, Store

SID = "sess-budget"
ISSUE = 42


# ---------------------------------------------------------------------------
# _run_json_path
# ---------------------------------------------------------------------------


def test_run_json_path_with_session_id_is_deterministic(tmp_path: Path) -> None:
    path = _run_json_path(tmp_path, SID, ISSUE)
    assert path == tmp_path / ".agentrail" / "runs" / run_uuid(SID, ISSUE) / "run.json"


def test_run_json_path_without_session_id_and_no_runs_dir_is_none(tmp_path: Path) -> None:
    assert _run_json_path(tmp_path, None, ISSUE) is None


def test_run_json_path_without_session_id_globs_single_run_dir(tmp_path: Path) -> None:
    run_dir = tmp_path / ".agentrail" / "runs" / "20260718-000000-1234"
    run_dir.mkdir(parents=True)
    (run_dir / "run.json").write_text("{}")

    assert _run_json_path(tmp_path, None, ISSUE) == run_dir / "run.json"


def test_run_json_path_without_session_id_is_none_when_ambiguous(tmp_path: Path) -> None:
    for name in ("run-a", "run-b"):
        d = tmp_path / ".agentrail" / "runs" / name
        d.mkdir(parents=True)
        (d / "run.json").write_text("{}")

    assert _run_json_path(tmp_path, None, ISSUE) is None


# ---------------------------------------------------------------------------
# _budget_stop_reason
# ---------------------------------------------------------------------------


def _write_run_json(worktree: Path, sid: str, issue: int, data: dict) -> Path:
    path = worktree / ".agentrail" / "runs" / run_uuid(sid, issue) / "run.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data))
    return path


def test_budget_stop_reason_returns_blocked_reason_verbatim(tmp_path: Path) -> None:
    reason = (
        "budget exceeded after execute phase: $3.02 spent of $3.00 budget; "
        "this run hit the estimate-absent backstop, not a hard limit — it can "
        "resume with a real budget: re-run with --budget-usd <n>, set "
        "budgets.per_issue_usd, or let the alignment brief estimate it (#1274/#1275)"
    )
    _write_run_json(tmp_path, SID, ISSUE, {"blockedReason": reason, "budgetCeilingCrossed": True})

    assert _budget_stop_reason(tmp_path, SID, ISSUE) == reason


def test_budget_stop_reason_none_when_key_absent(tmp_path: Path) -> None:
    _write_run_json(tmp_path, SID, ISSUE, {"executionAttempt": 1})
    assert _budget_stop_reason(tmp_path, SID, ISSUE) is None


def test_budget_stop_reason_none_when_key_empty_string(tmp_path: Path) -> None:
    _write_run_json(tmp_path, SID, ISSUE, {"blockedReason": ""})
    assert _budget_stop_reason(tmp_path, SID, ISSUE) is None


def test_budget_stop_reason_none_when_file_missing(tmp_path: Path) -> None:
    assert _budget_stop_reason(tmp_path, SID, ISSUE) is None


def test_budget_stop_reason_none_when_file_malformed(tmp_path: Path) -> None:
    path = tmp_path / ".agentrail" / "runs" / run_uuid(SID, ISSUE) / "run.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("not json")
    assert _budget_stop_reason(tmp_path, SID, ISSUE) is None


def test_budget_stop_reason_none_without_session_id_and_no_runs_dir(tmp_path: Path) -> None:
    assert _budget_stop_reason(tmp_path, None, ISSUE) is None


# ---------------------------------------------------------------------------
# Runner._process — the integration seam: which reason string reaches _fail
# ---------------------------------------------------------------------------


def _runner(tmp_path: Path, session_id: str = SID) -> Runner:
    store = Store(AfkState(
        issues={ISSUE: IssueState(number=ISSUE, title="t", url="u",
                                  status=IssueStatus.QUEUED, slot=0)},
        slots={0: ISSUE},
    ))
    store._session_id = session_id
    return Runner(
        tmp_path, engine="claude", base="main", concurrency=1,
        afk_label="afk", queue_labels=["afk"], run_dir=tmp_path / "run",
        store=store,
    )


def _run_process(runner: Runner) -> MagicMock:
    """Drive Runner._process for ISSUE with _implement forced to fail, and
    gh/label side effects neutralized. Returns the mocked _fail so callers can
    assert on the reason string it received."""
    issue_state = runner.store.state.issues[ISSUE]
    with patch.object(runner, "_implement", AsyncMock(return_value=False)), \
         patch.object(runner, "_fail") as mock_fail, \
         patch("agentrail.afk.runner.gh.add_issue_label"), \
         patch("agentrail.afk.runner.gh.detect_pr_for_issue", return_value=None):
        asyncio.run(runner._process(0, issue_state))
    return mock_fail


def test_process_labels_budget_stop_with_the_exact_pipeline_reason(tmp_path: Path) -> None:
    runner = _runner(tmp_path)
    reason = (
        "budget exceeded after execute phase: $3.02 spent of $3.00 budget; "
        "this run hit the estimate-absent backstop, not a hard limit — it can "
        "resume with a real budget: re-run with --budget-usd <n>, set "
        "budgets.per_issue_usd, or let the alignment brief estimate it (#1274/#1275)"
    )
    wt = runner._worktree(0, ISSUE)
    _write_run_json(wt, SID, ISSUE, {"blockedReason": reason, "budgetCeilingCrossed": True})

    mock_fail = _run_process(runner)

    mock_fail.assert_called_once_with(ISSUE, reason)


def test_process_falls_back_to_generic_reason_when_no_budget_marker(tmp_path: Path) -> None:
    """Regression-pin: a run.json with no blockedReason (or none at all) must
    leave the failure reason byte-identical to today's generic message."""
    runner = _runner(tmp_path)
    # No run.json written at all — _budget_stop_reason must return None.

    mock_fail = _run_process(runner)

    mock_fail.assert_called_once_with(ISSUE, "implementation failed")


def test_process_falls_back_to_generic_reason_when_run_json_has_no_blocked_key(
    tmp_path: Path,
) -> None:
    runner = _runner(tmp_path)
    wt = runner._worktree(0, ISSUE)
    _write_run_json(wt, SID, ISSUE, {"executionAttempt": 2})  # no budget stop

    mock_fail = _run_process(runner)

    mock_fail.assert_called_once_with(ISSUE, "implementation failed")
