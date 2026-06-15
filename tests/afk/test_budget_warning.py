"""Tests for budget threshold warnings in ``agentrail cost`` (issue #698).

AC5: covers (a) warning fires when cost > threshold, (b) journal event written
with correct fields, (c) silent when cost <= threshold, (d) silent when
threshold is 0 or absent.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from agentrail.run.usage_capture import Usage

SESSION_A = "20260101-120000"
SESSION_B = "20260102-120000"

_EVENTS = [
    {
        "v": 1, "session": SESSION_A, "seq": 0,
        "ts": "2026-01-01T12:00:00+00:00", "kind": "init",
        "state": {}, "digest": "aaa000",
    },
    {
        "v": 1, "session": SESSION_A, "seq": 1,
        "ts": "2026-01-01T12:01:00+00:00", "kind": "action",
        "action": {"type": "ClaimIssue", "number": 42, "slot": 0},
        "digest": "aaa001",
    },
    {
        "v": 1, "session": SESSION_B, "seq": 0,
        "ts": "2026-01-02T12:00:00+00:00", "kind": "init",
        "state": {}, "digest": "bbb000",
    },
    {
        "v": 1, "session": SESSION_B, "seq": 1,
        "ts": "2026-01-02T12:01:00+00:00", "kind": "action",
        "action": {"type": "ClaimIssue", "number": 99, "slot": 0},
        "digest": "bbb001",
    },
]

# Cost per issue: (1000*3.00 + 200*15.00 + 100*0.30) / 1_000_000 = 0.00603
_FIXED_USAGE = Usage(
    model="claude-sonnet-4-6",
    input_tokens=1000,
    output_tokens=200,
    cache_tokens=100,
)
_EXPECTED_COST = (1000 * 3.00 + 200 * 15.00 + 100 * 0.30) / 1_000_000  # ~0.00603


def _write_journal(tmp_dir: Path, events: list) -> None:
    path = tmp_dir / ".agentrail" / "afk" / "events.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w") as f:
        for ev in events:
            f.write(json.dumps(ev) + "\n")


def _write_config(tmp_dir: Path, cfg: dict) -> None:
    path = tmp_dir / ".agentrail" / "config.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cfg))


class TestBudgetWarningFires(unittest.TestCase):
    """AC1 + AC5a: warning printed to stderr when cost exceeds threshold."""

    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory()
        self._target = Path(self._td.name)
        _write_journal(self._target, _EVENTS)
        # Set threshold well below the per-issue cost (~0.00603)
        _write_config(self._target, {"budgets": {"per_issue_usd": 0.001}})

    def tearDown(self) -> None:
        self._td.cleanup()

    def test_warning_printed_to_stderr(self) -> None:
        from agentrail.cli.commands import cost as cost_mod

        with patch.object(cost_mod, "capture_usage", return_value=_FIXED_USAGE), \
             patch.object(cost_mod, "resolve_agent_name", return_value="claude"):
            err = StringIO()
            with patch("sys.stderr", err):
                rc = cost_mod.run_cost(["--target", str(self._target)])

        self.assertEqual(rc, 0)
        msg = err.getvalue()
        self.assertIn("WARNING budget exceeded", msg)
        # Must name session and issue
        self.assertIn(SESSION_A, msg)
        self.assertIn("42", msg)
        self.assertIn(SESSION_B, msg)
        self.assertIn("99", msg)
        # Must name threshold and actual spend
        self.assertIn("0.001", msg)

    def test_warning_json_has_warnings_key(self) -> None:
        """--json output gains a 'warnings' key listing violations."""
        from agentrail.cli.commands import cost as cost_mod

        with patch.object(cost_mod, "capture_usage", return_value=_FIXED_USAGE), \
             patch.object(cost_mod, "resolve_agent_name", return_value="claude"):
            out = StringIO()
            with patch("sys.stdout", out), patch("sys.stderr", StringIO()):
                rc = cost_mod.run_cost(["--target", str(self._target), "--json"])

        self.assertEqual(rc, 0)
        data = json.loads(out.getvalue())
        self.assertIn("warnings", data)
        self.assertEqual(len(data["warnings"]), 2)  # both issues exceed threshold


class TestBudgetWarningJournalEvent(unittest.TestCase):
    """AC2 + AC5b: budget_warning event appended to events.jsonl with correct fields."""

    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory()
        self._target = Path(self._td.name)
        _write_journal(self._target, _EVENTS)
        _write_config(self._target, {"budgets": {"per_issue_usd": 0.001}})

    def tearDown(self) -> None:
        self._td.cleanup()

    def test_journal_event_written_with_correct_fields(self) -> None:
        from agentrail.cli.commands import cost as cost_mod

        with patch.object(cost_mod, "capture_usage", return_value=_FIXED_USAGE), \
             patch.object(cost_mod, "resolve_agent_name", return_value="claude"):
            with patch("sys.stderr", StringIO()):
                cost_mod.run_cost(["--target", str(self._target)])

        events_path = self._target / ".agentrail" / "afk" / "events.jsonl"
        lines = events_path.read_text().splitlines()
        budget_events = [
            json.loads(l) for l in lines if "budget_warning" in l
        ]
        self.assertEqual(len(budget_events), 2, "one event per over-threshold issue")

        for ev in budget_events:
            self.assertEqual(ev["v"], 1)
            self.assertEqual(ev["kind"], "budget_warning")
            self.assertIn("session", ev)
            self.assertIn("issue", ev)
            self.assertIn("cost_usd", ev)
            self.assertIn("threshold_usd", ev)
            self.assertIn("ts", ev)
            self.assertAlmostEqual(ev["threshold_usd"], 0.001, places=6)
            self.assertGreater(ev["cost_usd"], 0.001)

    def test_budget_warning_not_in_action_types(self) -> None:
        """budget_warning must NOT appear in journal._ACTION_TYPES (not replayable)."""
        from agentrail.afk import journal as _journal

        self.assertNotIn("budget_warning", _journal._ACTION_TYPES)


class TestBudgetWarningSilentBelowThreshold(unittest.TestCase):
    """AC3 + AC5c: no warning when all costs are at or below the threshold."""

    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory()
        self._target = Path(self._td.name)
        _write_journal(self._target, _EVENTS)
        # Set threshold above the per-issue cost (~0.00603) — no violation
        _write_config(self._target, {"budgets": {"per_issue_usd": 1.00}})

    def tearDown(self) -> None:
        self._td.cleanup()

    def test_no_warning_when_below_threshold(self) -> None:
        from agentrail.cli.commands import cost as cost_mod

        with patch.object(cost_mod, "capture_usage", return_value=_FIXED_USAGE), \
             patch.object(cost_mod, "resolve_agent_name", return_value="claude"):
            err = StringIO()
            with patch("sys.stderr", err):
                rc = cost_mod.run_cost(["--target", str(self._target)])

        self.assertEqual(rc, 0)
        self.assertNotIn("WARNING budget exceeded", err.getvalue())

    def test_no_warning_key_in_json_when_no_violations(self) -> None:
        """'warnings' key absent from --json output when no violations."""
        from agentrail.cli.commands import cost as cost_mod

        with patch.object(cost_mod, "capture_usage", return_value=_FIXED_USAGE), \
             patch.object(cost_mod, "resolve_agent_name", return_value="claude"):
            out = StringIO()
            with patch("sys.stdout", out), patch("sys.stderr", StringIO()):
                cost_mod.run_cost(["--target", str(self._target), "--json"])

        data = json.loads(out.getvalue())
        self.assertNotIn("warnings", data)

    def test_equal_to_threshold_is_silent(self) -> None:
        """Cost exactly equal to threshold must not trigger a warning."""
        from agentrail.cli.commands import cost as cost_mod

        # Set threshold exactly equal to expected cost
        _write_config(self._target, {"budgets": {"per_issue_usd": _EXPECTED_COST}})

        with patch.object(cost_mod, "capture_usage", return_value=_FIXED_USAGE), \
             patch.object(cost_mod, "resolve_agent_name", return_value="claude"):
            err = StringIO()
            with patch("sys.stderr", err):
                cost_mod.run_cost(["--target", str(self._target)])

        self.assertNotIn("WARNING budget exceeded", err.getvalue())


class TestBudgetWarningSilentWhenZeroOrAbsent(unittest.TestCase):
    """AC3 + AC5d: no warning when threshold is 0 or absent from config."""

    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory()
        self._target = Path(self._td.name)
        _write_journal(self._target, _EVENTS)

    def tearDown(self) -> None:
        self._td.cleanup()

    def test_no_warning_when_threshold_zero(self) -> None:
        _write_config(self._target, {"budgets": {"per_issue_usd": 0}})

        from agentrail.cli.commands import cost as cost_mod

        with patch.object(cost_mod, "capture_usage", return_value=_FIXED_USAGE), \
             patch.object(cost_mod, "resolve_agent_name", return_value="claude"):
            err = StringIO()
            with patch("sys.stderr", err):
                cost_mod.run_cost(["--target", str(self._target)])

        self.assertNotIn("WARNING budget exceeded", err.getvalue())

    def test_no_warning_when_budget_key_absent(self) -> None:
        """No 'budgets' key in config — uncapped, no warning."""
        _write_config(self._target, {"runner": {"name": "claude"}})

        from agentrail.cli.commands import cost as cost_mod

        with patch.object(cost_mod, "capture_usage", return_value=_FIXED_USAGE), \
             patch.object(cost_mod, "resolve_agent_name", return_value="claude"):
            err = StringIO()
            with patch("sys.stderr", err):
                cost_mod.run_cost(["--target", str(self._target)])

        self.assertNotIn("WARNING budget exceeded", err.getvalue())

    def test_no_warning_when_no_config_file(self) -> None:
        """Completely absent config — uncapped, no warning."""
        from agentrail.cli.commands import cost as cost_mod

        with patch.object(cost_mod, "capture_usage", return_value=_FIXED_USAGE), \
             patch.object(cost_mod, "resolve_agent_name", return_value="claude"):
            err = StringIO()
            with patch("sys.stderr", err):
                cost_mod.run_cost(["--target", str(self._target)])

        self.assertNotIn("WARNING budget exceeded", err.getvalue())


if __name__ == "__main__":
    unittest.main()
