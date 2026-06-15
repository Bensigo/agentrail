"""Tests for ``agentrail cost`` CLI command (agentrail/cli/commands/cost.py).

Uses a fixture journal written to a temp directory. capture_usage is
monkeypatched so dollar math is deterministic without real transcripts.
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from agentrail.run.usage_capture import Usage

# Fixture journal events — two sessions, one issue each.
SESSION_A = "20260101-120000"
SESSION_B = "20260102-120000"

_EVENTS = [
    # Session A — init
    {
        "v": 1, "session": SESSION_A, "seq": 0,
        "ts": "2026-01-01T12:00:00+00:00", "kind": "init",
        "state": {}, "digest": "aaa000",
    },
    # Session A — ClaimIssue #42
    {
        "v": 1, "session": SESSION_A, "seq": 1,
        "ts": "2026-01-01T12:01:00+00:00", "kind": "action",
        "action": {"type": "ClaimIssue", "number": 42, "slot": 0},
        "digest": "aaa001",
    },
    # Session B — init
    {
        "v": 1, "session": SESSION_B, "seq": 0,
        "ts": "2026-01-02T12:00:00+00:00", "kind": "init",
        "state": {}, "digest": "bbb000",
    },
    # Session B — ClaimIssue #99
    {
        "v": 1, "session": SESSION_B, "seq": 1,
        "ts": "2026-01-02T12:01:00+00:00", "kind": "action",
        "action": {"type": "ClaimIssue", "number": 99, "slot": 0},
        "digest": "bbb001",
    },
]

# Controlled usage: 1000 input + 200 output + 100 cache on claude-sonnet-4-6.
# Rates: input=3.00, output=15.00, cache=0.30 ($/MTok)
# Cost = (1000*3 + 200*15 + 100*0.30) / 1_000_000 = (3000+3000+30)/1_000_000 = 6030/1_000_000
_FIXED_USAGE = Usage(
    model="claude-sonnet-4-6",
    input_tokens=1000,
    output_tokens=200,
    cache_tokens=100,
)
_EXPECTED_COST_PER_ISSUE = (1000 * 3.00 + 200 * 15.00 + 100 * 0.30) / 1_000_000


def _write_journal(tmp_dir: Path, events: list) -> None:
    journal_path = tmp_dir / ".agentrail" / "afk" / "events.jsonl"
    journal_path.parent.mkdir(parents=True, exist_ok=True)
    with journal_path.open("w") as f:
        for ev in events:
            f.write(json.dumps(ev) + "\n")


class TestCostAggregation(unittest.TestCase):
    """AC1 + AC5a: per-run dollar aggregation from a fixture journal."""

    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory()
        self._target = Path(self._td.name)
        _write_journal(self._target, _EVENTS)

    def tearDown(self) -> None:
        self._td.cleanup()

    def test_per_issue_rows_and_total(self) -> None:
        from agentrail.cli.commands import cost as cost_mod

        with patch.object(cost_mod, "capture_usage", return_value=_FIXED_USAGE), \
             patch.object(cost_mod, "resolve_agent_name", return_value="claude"):
            captured = StringIO()
            with patch("sys.stdout", captured):
                rc = cost_mod.run_cost(["--target", str(self._target)])

        self.assertEqual(rc, 0)
        output = captured.getvalue()
        # Both issues appear
        self.assertIn("42", output)
        self.assertIn("99", output)
        # Total is sum of two issues
        expected_total = _EXPECTED_COST_PER_ISSUE * 2
        self.assertIn(f"${expected_total:.6f}", output)

    def test_total_equals_sum_of_rows(self) -> None:
        """The total row must equal the arithmetic sum of per-issue costs."""
        from agentrail.cli.commands import cost as cost_mod

        with patch.object(cost_mod, "capture_usage", return_value=_FIXED_USAGE), \
             patch.object(cost_mod, "resolve_agent_name", return_value="claude"):
            captured = StringIO()
            with patch("sys.stdout", captured):
                cost_mod.run_cost(["--target", str(self._target)])

        output = captured.getvalue()
        expected_total = _EXPECTED_COST_PER_ISSUE * 2
        self.assertIn(f"${expected_total:.6f}", output)


class TestJsonSchema(unittest.TestCase):
    """AC2 + AC5b: --json output schema and total_usd reconciliation."""

    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory()
        self._target = Path(self._td.name)
        _write_journal(self._target, _EVENTS)

    def tearDown(self) -> None:
        self._td.cleanup()

    def test_json_schema_required_keys(self) -> None:
        from agentrail.cli.commands import cost as cost_mod

        with patch.object(cost_mod, "capture_usage", return_value=_FIXED_USAGE), \
             patch.object(cost_mod, "resolve_agent_name", return_value="claude"):
            captured = StringIO()
            with patch("sys.stdout", captured):
                rc = cost_mod.run_cost(["--target", str(self._target), "--json"])

        self.assertEqual(rc, 0)
        data = json.loads(captured.getvalue())
        self.assertIn("runs", data)
        self.assertIn("total_usd", data)

        # Each run row must have required fields
        for run in data["runs"]:
            for key in ("session", "issue", "model", "input_tokens",
                        "output_tokens", "cache_tokens", "cost_usd"):
                self.assertIn(key, run, f"missing key {key!r} in run row")

    def test_total_usd_reconciles_with_sum(self) -> None:
        from agentrail.cli.commands import cost as cost_mod

        with patch.object(cost_mod, "capture_usage", return_value=_FIXED_USAGE), \
             patch.object(cost_mod, "resolve_agent_name", return_value="claude"):
            captured = StringIO()
            with patch("sys.stdout", captured):
                cost_mod.run_cost(["--target", str(self._target), "--json"])

        data = json.loads(captured.getvalue())
        computed_total = sum(r["cost_usd"] for r in data["runs"])
        self.assertAlmostEqual(data["total_usd"], computed_total, places=9)


class TestRunScoping(unittest.TestCase):
    """AC3 + AC5c: --run scopes to one session; unknown ID exits non-zero."""

    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory()
        self._target = Path(self._td.name)
        _write_journal(self._target, _EVENTS)

    def tearDown(self) -> None:
        self._td.cleanup()

    def test_run_scopes_to_one_session(self) -> None:
        from agentrail.cli.commands import cost as cost_mod

        with patch.object(cost_mod, "capture_usage", return_value=_FIXED_USAGE), \
             patch.object(cost_mod, "resolve_agent_name", return_value="claude"):
            captured = StringIO()
            with patch("sys.stdout", captured):
                rc = cost_mod.run_cost(
                    ["--target", str(self._target), "--run", SESSION_A, "--json"]
                )

        self.assertEqual(rc, 0)
        data = json.loads(captured.getvalue())
        # Only session A's issue (42) should appear
        self.assertEqual(len(data["runs"]), 1)
        self.assertEqual(data["runs"][0]["issue"], 42)
        self.assertEqual(data["runs"][0]["session"], SESSION_A)

    def test_unknown_run_id_exits_nonzero(self) -> None:
        from agentrail.cli.commands import cost as cost_mod

        with patch.object(cost_mod, "capture_usage", return_value=_FIXED_USAGE), \
             patch.object(cost_mod, "resolve_agent_name", return_value="claude"):
            err = StringIO()
            with patch("sys.stderr", err):
                rc = cost_mod.run_cost(
                    ["--target", str(self._target), "--run", "no-such-session"]
                )

        self.assertNotEqual(rc, 0)
        self.assertIn("no-such-session", err.getvalue())


class TestSinceFilter(unittest.TestCase):
    """AC4 + AC5d: --since filters by session init timestamp."""

    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory()
        self._target = Path(self._td.name)
        _write_journal(self._target, _EVENTS)

    def tearDown(self) -> None:
        self._td.cleanup()

    def test_since_date_excludes_older_sessions(self) -> None:
        """Sessions whose init ts is before --since are excluded."""
        from agentrail.cli.commands import cost as cost_mod

        # 2026-01-02 excludes session A (2026-01-01); only session B remains
        with patch.object(cost_mod, "capture_usage", return_value=_FIXED_USAGE), \
             patch.object(cost_mod, "resolve_agent_name", return_value="claude"):
            captured = StringIO()
            with patch("sys.stdout", captured):
                rc = cost_mod.run_cost(
                    ["--target", str(self._target), "--since", "2026-01-02", "--json"]
                )

        self.assertEqual(rc, 0)
        data = json.loads(captured.getvalue())
        sessions_in_output = {r["session"] for r in data["runs"]}
        self.assertNotIn(SESSION_A, sessions_in_output)
        self.assertIn(SESSION_B, sessions_in_output)

    def test_since_iso_timestamp_accepted(self) -> None:
        """--since also accepts a full ISO timestamp."""
        from agentrail.cli.commands import cost as cost_mod

        # Exclude everything before 2026-01-01T13:00:00 (after session A's init)
        with patch.object(cost_mod, "capture_usage", return_value=_FIXED_USAGE), \
             patch.object(cost_mod, "resolve_agent_name", return_value="claude"):
            captured = StringIO()
            with patch("sys.stdout", captured):
                rc = cost_mod.run_cost([
                    "--target", str(self._target),
                    "--since", "2026-01-01T13:00:00+00:00",
                    "--json",
                ])

        self.assertEqual(rc, 0)
        data = json.loads(captured.getvalue())
        sessions_in_output = {r["session"] for r in data["runs"]}
        self.assertNotIn(SESSION_A, sessions_in_output)
        self.assertIn(SESSION_B, sessions_in_output)

    def test_since_total_reflects_only_included(self) -> None:
        """total_usd reflects only sessions after --since cutoff."""
        from agentrail.cli.commands import cost as cost_mod

        with patch.object(cost_mod, "capture_usage", return_value=_FIXED_USAGE), \
             patch.object(cost_mod, "resolve_agent_name", return_value="claude"):
            captured = StringIO()
            with patch("sys.stdout", captured):
                cost_mod.run_cost(
                    ["--target", str(self._target), "--since", "2026-01-02", "--json"]
                )

        data = json.loads(captured.getvalue())
        # Only one issue (session B) after the cutoff
        self.assertAlmostEqual(data["total_usd"], _EXPECTED_COST_PER_ISSUE, places=9)


class TestMissingJournal(unittest.TestCase):
    """AC5e: missing journal exits 0 with a helpful message."""

    def test_no_journal_exits_zero(self) -> None:
        from agentrail.cli.commands import cost as cost_mod

        with tempfile.TemporaryDirectory() as td:
            captured = StringIO()
            with patch("sys.stdout", captured):
                rc = cost_mod.run_cost(["--target", td])

        self.assertEqual(rc, 0)
        self.assertIn("No AFK flight recorder", captured.getvalue())


if __name__ == "__main__":
    unittest.main()
