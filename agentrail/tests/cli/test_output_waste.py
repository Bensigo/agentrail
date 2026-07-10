"""Tests for output-token waste metrics in ``agentrail cost`` (issue #710).

AC5 covers four sub-cases:
  (a) ratio computation from Usage fields
  (b) flag fires when ratio exceeds threshold
  (c) no flag when ratio is at or below threshold
  (d) output cost priced at output rate, not input rate

Plus estimate-flag for unknown model (AC4).
"""
from __future__ import annotations

import json
import tempfile
import unittest
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from agentrail.run.usage_capture import Usage

# ---------------------------------------------------------------------------
# Shared fixture journal — one session, one issue
# ---------------------------------------------------------------------------

SESSION = "20260101-120000"

_EVENTS = [
    {
        "v": 1, "session": SESSION, "seq": 0,
        "ts": "2026-01-01T12:00:00+00:00", "kind": "init",
        "state": {}, "digest": "aaa000",
    },
    {
        "v": 1, "session": SESSION, "seq": 1,
        "ts": "2026-01-01T12:01:00+00:00", "kind": "action",
        "action": {"type": "ClaimIssue", "number": 10, "slot": 0},
        "digest": "aaa001",
    },
]


def _write_journal(tmp_dir: Path, events: list) -> None:
    journal_path = tmp_dir / ".agentrail" / "afk" / "events.jsonl"
    journal_path.parent.mkdir(parents=True, exist_ok=True)
    with journal_path.open("w") as f:
        for ev in events:
            f.write(json.dumps(ev) + "\n")


def _run_cost_json(target: Path, usage: Usage, extra_args: list | None = None) -> dict:
    """Run `agentrail cost --json` with a monkeypatched usage and return parsed output."""
    from agentrail.cli.commands import cost as cost_mod

    args = ["--target", str(target), "--json"]
    if extra_args:
        args.extend(extra_args)

    with patch.object(cost_mod, "capture_usage", return_value=usage), \
         patch.object(cost_mod, "resolve_agent_name", return_value="claude"):
        captured = StringIO()
        with patch("sys.stdout", captured):
            cost_mod.run_cost(args)

    return json.loads(captured.getvalue())


# ---------------------------------------------------------------------------
# AC5a — ratio computation from Usage fields
# ---------------------------------------------------------------------------

class TestRatioComputation(unittest.TestCase):
    """outputInputRatio = round(output / input, 2); null when input == 0."""

    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory()
        self._target = Path(self._td.name)
        _write_journal(self._target, _EVENTS)

    def tearDown(self) -> None:
        self._td.cleanup()

    def test_ratio_normal(self) -> None:
        usage = Usage(model="claude-sonnet-4-6", input_tokens=1000, output_tokens=3000, cache_tokens=0)
        data = _run_cost_json(self._target, usage)
        row = data["runs"][0]
        self.assertIn("outputTokens", row)
        self.assertIn("outputInputRatio", row)
        self.assertEqual(row["outputTokens"], 3000)
        self.assertEqual(row["outputInputRatio"], 3.00)

    def test_ratio_non_integer(self) -> None:
        usage = Usage(model="claude-sonnet-4-6", input_tokens=300, output_tokens=100, cache_tokens=0)
        data = _run_cost_json(self._target, usage)
        row = data["runs"][0]
        # 100/300 = 0.333... → rounds to 0.33
        self.assertEqual(row["outputInputRatio"], 0.33)

    def test_ratio_null_when_input_zero(self) -> None:
        usage = Usage(model="claude-sonnet-4-6", input_tokens=0, output_tokens=500, cache_tokens=0)
        data = _run_cost_json(self._target, usage)
        row = data["runs"][0]
        self.assertIsNone(row["outputInputRatio"])


# ---------------------------------------------------------------------------
# AC5b — flag fires when ratio exceeds threshold
# ---------------------------------------------------------------------------

class TestFlagAboveThreshold(unittest.TestCase):
    """When outputInputRatio > threshold, 'output-wasteful' appears in flags."""

    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory()
        self._target = Path(self._td.name)
        _write_journal(self._target, _EVENTS)

    def tearDown(self) -> None:
        self._td.cleanup()

    def test_flag_fires_above_threshold(self) -> None:
        # ratio = 3.0 > threshold 2.0 → flag
        usage = Usage(model="claude-sonnet-4-6", input_tokens=1000, output_tokens=3000, cache_tokens=0)
        data = _run_cost_json(self._target, usage, extra_args=["--output-ratio-threshold", "2.0"])
        row = data["runs"][0]
        self.assertIn("flags", row)
        self.assertIn("output-wasteful", row["flags"])

    def test_flag_fires_just_above_threshold(self) -> None:
        # ratio = 2.01 > 2.0 → flag
        usage = Usage(model="claude-sonnet-4-6", input_tokens=100, output_tokens=201, cache_tokens=0)
        data = _run_cost_json(self._target, usage, extra_args=["--output-ratio-threshold", "2.0"])
        row = data["runs"][0]
        # 201/100 = 2.01 > 2.0 → flag
        self.assertIn("output-wasteful", row["flags"])


# ---------------------------------------------------------------------------
# AC5c — no flag when ratio is at or below threshold
# ---------------------------------------------------------------------------

class TestNoFlagAtOrBelowThreshold(unittest.TestCase):
    """When outputInputRatio <= threshold, no 'output-wasteful' flag."""

    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory()
        self._target = Path(self._td.name)
        _write_journal(self._target, _EVENTS)

    def tearDown(self) -> None:
        self._td.cleanup()

    def test_no_flag_at_threshold(self) -> None:
        # ratio = 2.0, threshold = 2.0 → no flag
        usage = Usage(model="claude-sonnet-4-6", input_tokens=1000, output_tokens=2000, cache_tokens=0)
        data = _run_cost_json(self._target, usage, extra_args=["--output-ratio-threshold", "2.0"])
        row = data["runs"][0]
        flags = row.get("flags", [])
        self.assertNotIn("output-wasteful", flags)

    def test_no_flag_below_threshold(self) -> None:
        # ratio = 0.5, threshold = 2.0 → no flag
        usage = Usage(model="claude-sonnet-4-6", input_tokens=1000, output_tokens=500, cache_tokens=0)
        data = _run_cost_json(self._target, usage, extra_args=["--output-ratio-threshold", "2.0"])
        row = data["runs"][0]
        flags = row.get("flags", [])
        self.assertNotIn("output-wasteful", flags)

    def test_no_flag_when_input_zero(self) -> None:
        # ratio is null → no flag regardless of threshold
        usage = Usage(model="claude-sonnet-4-6", input_tokens=0, output_tokens=5000, cache_tokens=0)
        data = _run_cost_json(self._target, usage, extra_args=["--output-ratio-threshold", "0.1"])
        row = data["runs"][0]
        flags = row.get("flags", [])
        self.assertNotIn("output-wasteful", flags)


# ---------------------------------------------------------------------------
# AC5d — output cost uses output rate, not input rate
# ---------------------------------------------------------------------------

class TestOutputCostUsesOutputRate(unittest.TestCase):
    """outputCostUsd = output_tokens * output_rate / 1e6, not input_rate."""

    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory()
        self._target = Path(self._td.name)
        _write_journal(self._target, _EVENTS)

    def tearDown(self) -> None:
        self._td.cleanup()

    def test_output_cost_at_output_rate(self) -> None:
        # claude-sonnet-4-6: output=15.00 $/Mtok, input=3.00 $/Mtok
        # 1000 output tokens at output rate: 1000 * 15.00 / 1_000_000 = 0.000015
        # At input rate it would be: 1000 * 3.00 / 1_000_000 = 0.000003 → wrong
        usage = Usage(model="claude-sonnet-4-6", input_tokens=1000, output_tokens=1000, cache_tokens=0)
        data = _run_cost_json(self._target, usage)
        row = data["runs"][0]
        self.assertIn("outputCostUsd", row)
        expected = 1000 * 15.00 / 1_000_000  # output rate
        wrong = 1000 * 3.00 / 1_000_000      # input rate
        self.assertAlmostEqual(row["outputCostUsd"], expected, places=9)
        self.assertNotAlmostEqual(row["outputCostUsd"], wrong, places=9)


# ---------------------------------------------------------------------------
# AC4 — estimate flag for unknown model
# ---------------------------------------------------------------------------

class TestEstimateFlagUnknownModel(unittest.TestCase):
    """When model is not in PRICE_TABLE, estimate=True on the row."""

    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory()
        self._target = Path(self._td.name)
        _write_journal(self._target, _EVENTS)

    def tearDown(self) -> None:
        self._td.cleanup()

    def test_estimate_true_for_unknown_model(self) -> None:
        usage = Usage(model="unknown-model-xyz", input_tokens=1000, output_tokens=3000, cache_tokens=0)
        data = _run_cost_json(self._target, usage)
        row = data["runs"][0]
        self.assertIn("estimate", row)
        self.assertTrue(row["estimate"])

    def test_estimate_false_for_known_model(self) -> None:
        usage = Usage(model="claude-sonnet-4-6", input_tokens=1000, output_tokens=3000, cache_tokens=0)
        data = _run_cost_json(self._target, usage)
        row = data["runs"][0]
        self.assertIn("estimate", row)
        self.assertFalse(row["estimate"])


if __name__ == "__main__":
    unittest.main()
