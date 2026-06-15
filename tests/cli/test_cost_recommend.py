"""Tests for ``agentrail cost --recommend`` (issue #708, M026).

Covers AC6 (a-d):
  a) fixture run with low cache-hit → cache recommendation fires with correct $
  b) fixture run with routing overspend → routing recommendation fires
  c) fixture run with all signals optimal → no-recommendation message
  d) JSON output schema validation

Also covers:
  AC1 – each recommendation has saving_usd and actionable instruction
  AC2 – sorted descending by estimated_saving_usd
  AC3 – all-optimal → explicit no-rec message
  AC4 – --json emits correct schema
  AC5 – unknown model → "estimate unavailable", run not silently skipped
"""
from __future__ import annotations

import json
import tempfile
import unittest
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from agentrail.run.cost_recommend import recommend, ESTIMATE_UNAVAILABLE
from agentrail.run.pricing import PRICES
from agentrail.run.usage_capture import Usage


# ---------------------------------------------------------------------------
# Helpers shared with test_cost.py conventions
# ---------------------------------------------------------------------------

SESSION_A = "20260601-100000"

_INIT_EVENT = {
    "v": 1, "session": SESSION_A, "seq": 0,
    "ts": "2026-06-01T10:00:00+00:00", "kind": "init",
    "state": {}, "digest": "aaa000",
}
_CLAIM_EVENT = {
    "v": 1, "session": SESSION_A, "seq": 1,
    "ts": "2026-06-01T10:01:00+00:00", "kind": "action",
    "action": {"type": "ClaimIssue", "number": 1, "slot": 0},
    "digest": "aaa001",
}

# Controlled usage (same model as test_cost.py for consistency).
_FIXED_USAGE = Usage(
    model="claude-sonnet-4-6",
    input_tokens=10_000,
    output_tokens=1_000,
    cache_tokens=200,
)


def _write_journal(tmp_dir: Path, events: list) -> None:
    journal_path = tmp_dir / ".agentrail" / "afk" / "events.jsonl"
    journal_path.parent.mkdir(parents=True, exist_ok=True)
    with journal_path.open("w") as f:
        for ev in events:
            f.write(json.dumps(ev) + "\n")


def _run_recommend(target: Path, extra_args: list[str] | None = None) -> tuple[str, int]:
    """Call run_cost with --recommend, return (stdout, rc)."""
    from agentrail.cli.commands import cost as cost_mod

    args = ["--target", str(target), SESSION_A, "--recommend"]
    if extra_args:
        args.extend(extra_args)

    with patch.object(cost_mod, "capture_usage", return_value=_FIXED_USAGE), \
         patch.object(cost_mod, "resolve_agent_name", return_value="claude"), \
         patch.object(cost_mod, "resolve_default_budget", return_value=0.0):
        captured = StringIO()
        with patch("sys.stdout", captured):
            rc = cost_mod.run_cost(args)
    return captured.getvalue(), rc


# ---------------------------------------------------------------------------
# AC6a: low cache-hit rate → cache recommendation fires with correct $
# ---------------------------------------------------------------------------

class TestCacheRecommendation(unittest.TestCase):
    """AC6a — engine rule 1: cache_hit_rate < 0.5 fires cache rec."""

    def test_cache_rec_fires_with_correct_saving(self) -> None:
        """Cache recommendation fires and saving equals eligible × (input−cache)/1e6."""
        model = "claude-opus-4-6"
        rates = PRICES[model]
        eligible_tokens = 50_000
        expected_saving = eligible_tokens * (rates.input - rates.cache) / 1_000_000

        record = {
            "model": model,
            "cache_hit_rate": 0.10,          # well below 0.5 threshold
            "cache_eligible_tokens": eligible_tokens,
        }
        recs = recommend(record)

        self.assertEqual(len(recs), 1)
        rec = recs[0]
        self.assertEqual(rec["technique"], "prompt_caching")
        self.assertIn("cache_enabled", rec["action"])
        self.assertAlmostEqual(rec["estimated_saving_usd"], expected_saving, places=9)

    def test_cache_rec_not_fire_when_rate_above_threshold(self) -> None:
        """cache_hit_rate >= 0.5 → no cache recommendation."""
        record = {
            "model": "claude-sonnet-4-6",
            "cache_hit_rate": 0.75,
            "cache_eligible_tokens": 50_000,
        }
        recs = recommend(record)
        cache_recs = [r for r in recs if r["technique"] == "prompt_caching"]
        self.assertEqual(len(cache_recs), 0)

    def test_cache_rec_fires_at_zero_hit_rate(self) -> None:
        """0% cache hit rate is the worst case; rec still fires."""
        model = "claude-sonnet-4-6"
        rates = PRICES[model]
        eligible = 20_000
        record = {"model": model, "cache_hit_rate": 0.0, "cache_eligible_tokens": eligible}
        recs = recommend(record)
        self.assertEqual(len(recs), 1)
        self.assertAlmostEqual(
            recs[0]["estimated_saving_usd"],
            eligible * (rates.input - rates.cache) / 1_000_000,
            places=9,
        )


# ---------------------------------------------------------------------------
# AC6b: routing overspend → routing recommendation fires
# ---------------------------------------------------------------------------

class TestRoutingRecommendation(unittest.TestCase):
    """AC6b — engine rule 2: model_routing overspend_usd > 0 fires routing rec."""

    def test_routing_rec_fires_with_overspend(self) -> None:
        record = {
            "model": "claude-opus-4-6",
            "model_routing": [
                {
                    "phase": "execute",
                    "model_used": "claude-opus-4-6",
                    "cheaper_model": "claude-sonnet-4-6",
                    "overspend_usd": 0.05,
                }
            ],
        }
        recs = recommend(record)
        routing_recs = [r for r in recs if r["technique"] == "model_routing"]
        self.assertEqual(len(routing_recs), 1)
        rec = routing_recs[0]
        self.assertAlmostEqual(rec["estimated_saving_usd"], 0.05, places=9)
        self.assertIn("execute", rec["action"])
        self.assertIn("claude-opus-4-6", rec["action"])
        self.assertIn("claude-sonnet-4-6", rec["action"])
        self.assertIn("--routing --apply", rec["action"])

    def test_routing_rec_not_fire_when_no_overspend(self) -> None:
        record = {
            "model": "claude-sonnet-4-6",
            "model_routing": [
                {
                    "phase": "plan",
                    "model_used": "claude-sonnet-4-6",
                    "cheaper_model": "claude-haiku-4-5",
                    "overspend_usd": 0.0,
                }
            ],
        }
        recs = recommend(record)
        routing_recs = [r for r in recs if r["technique"] == "model_routing"]
        self.assertEqual(len(routing_recs), 0)

    def test_multiple_phases_overspend(self) -> None:
        """Multiple phases with overspend each generate their own rec."""
        record = {
            "model": "claude-opus-4-6",
            "model_routing": [
                {"phase": "plan", "model_used": "claude-opus-4-6",
                 "cheaper_model": "claude-sonnet-4-6", "overspend_usd": 0.03},
                {"phase": "execute", "model_used": "claude-opus-4-6",
                 "cheaper_model": "claude-sonnet-4-6", "overspend_usd": 0.07},
            ],
        }
        recs = recommend(record)
        routing_recs = [r for r in recs if r["technique"] == "model_routing"]
        self.assertEqual(len(routing_recs), 2)


# ---------------------------------------------------------------------------
# AC6c: all signals optimal → no-recommendation message
# ---------------------------------------------------------------------------

class TestNoRecommendations(unittest.TestCase):
    """AC6c — when all optimizer signals are optimal, recommend() returns []."""

    def test_empty_record_no_recs(self) -> None:
        """A record with no optimizer signals → empty list."""
        record = {"model": "claude-sonnet-4-6"}
        recs = recommend(record)
        self.assertEqual(recs, [])

    def test_optimal_cache_rate_no_rec(self) -> None:
        record = {
            "model": "claude-sonnet-4-6",
            "cache_hit_rate": 0.80,
            "cache_eligible_tokens": 50_000,
        }
        recs = recommend(record)
        self.assertEqual(recs, [])

    def test_pack_within_budget_no_rec(self) -> None:
        record = {
            "model": "claude-sonnet-4-6",
            "pack_cost_usd": 0.001,
            "budget_usd": 0.01,
        }
        recs = recommend(record)
        self.assertEqual(recs, [])

    def test_cli_prints_no_rec_message(self) -> None:
        """CLI emits 'No cost-saving recommendations…' when list is empty."""
        with tempfile.TemporaryDirectory() as td:
            target = Path(td)
            _write_journal(target, [_INIT_EVENT, _CLAIM_EVENT])
            output, rc = _run_recommend(target)

        self.assertEqual(rc, 0)
        self.assertIn("No cost-saving recommendations for this run.", output)

    def test_cli_json_emits_empty_array(self) -> None:
        """--recommend --json emits [] when no recommendations fire."""
        with tempfile.TemporaryDirectory() as td:
            target = Path(td)
            _write_journal(target, [_INIT_EVENT, _CLAIM_EVENT])
            output, rc = _run_recommend(target, ["--json"])

        self.assertEqual(rc, 0)
        data = json.loads(output)
        self.assertIsInstance(data, list)
        self.assertEqual(data, [])


# ---------------------------------------------------------------------------
# AC6d: JSON output schema validation
# ---------------------------------------------------------------------------

class TestJsonSchema(unittest.TestCase):
    """AC6d — --recommend --json emits valid array with correct schema."""

    def _record_with_cache_signal(self) -> dict:
        return {
            "model": "claude-opus-4-6",
            "cache_hit_rate": 0.1,
            "cache_eligible_tokens": 40_000,
        }

    def test_json_is_list(self) -> None:
        recs = recommend(self._record_with_cache_signal())
        self.assertIsInstance(recs, list)

    def test_json_each_item_has_required_keys(self) -> None:
        recs = recommend(self._record_with_cache_signal())
        self.assertGreater(len(recs), 0)
        for rec in recs:
            self.assertIn("technique", rec)
            self.assertIn("action", rec)
            self.assertIn("estimated_saving_usd", rec)

    def test_json_output_serializable(self) -> None:
        """All recommendation values must be JSON-serialisable."""
        recs = recommend(self._record_with_cache_signal())
        # Should not raise
        serialised = json.dumps(recs)
        parsed = json.loads(serialised)
        self.assertEqual(len(parsed), len(recs))

    def test_cli_json_output_matches_schema(self) -> None:
        """--recommend --json via CLI also matches the schema."""
        with tempfile.TemporaryDirectory() as td:
            target = Path(td)
            # Write journal with a cost_optimizer event so recs fire.
            events = [
                _INIT_EVENT,
                _CLAIM_EVENT,
                {
                    "v": 1, "session": SESSION_A, "seq": 2,
                    "ts": "2026-06-01T10:02:00+00:00", "kind": "cost_optimizer",
                    "payload": {
                        "cache_hit_rate": 0.05,
                        "cache_eligible_tokens": 30_000,
                    },
                    "digest": "aaa002",
                },
            ]
            _write_journal(target, events)
            output, rc = _run_recommend(target, ["--json"])

        self.assertEqual(rc, 0)
        data = json.loads(output)
        self.assertIsInstance(data, list)
        for item in data:
            self.assertIn("technique", item)
            self.assertIn("action", item)
            self.assertIn("estimated_saving_usd", item)


# ---------------------------------------------------------------------------
# AC5: unknown model → "estimate unavailable", not silently skipped
# ---------------------------------------------------------------------------

class TestUnknownModel(unittest.TestCase):
    """AC5 — unknown model emits estimate_unavailable label, not skipped."""

    def test_unknown_model_fires_cache_rec(self) -> None:
        record = {
            "model": "some-unknown-model-v99",
            "cache_hit_rate": 0.1,
            "cache_eligible_tokens": 50_000,
        }
        recs = recommend(record)
        self.assertEqual(len(recs), 1)
        rec = recs[0]
        self.assertEqual(rec["estimated_saving_usd"], ESTIMATE_UNAVAILABLE)
        self.assertIn("unavailable", rec["action"])
        self.assertIn("some-unknown-model-v99", rec["action"])

    def test_unknown_model_json_serializable(self) -> None:
        record = {
            "model": "mystery-model",
            "cache_hit_rate": 0.0,
            "cache_eligible_tokens": 10_000,
        }
        recs = recommend(record)
        # Must not raise
        serialised = json.dumps(recs)
        parsed = json.loads(serialised)
        self.assertEqual(parsed[0]["estimated_saving_usd"], ESTIMATE_UNAVAILABLE)


# ---------------------------------------------------------------------------
# AC2: sorted descending by estimated_saving_usd
# ---------------------------------------------------------------------------

class TestSortOrder(unittest.TestCase):
    """AC2 — recommendations sorted descending by estimated_saving_usd."""

    def test_higher_saving_first(self) -> None:
        """Routing overspend > cache saving → routing comes first."""
        model = "claude-sonnet-4-6"
        rates = PRICES[model]
        eligible = 10_000
        cache_saving = eligible * (rates.input - rates.cache) / 1_000_000
        routing_saving = cache_saving * 10  # deliberately larger

        record = {
            "model": model,
            "cache_hit_rate": 0.1,
            "cache_eligible_tokens": eligible,
            "model_routing": [
                {
                    "phase": "execute",
                    "model_used": "claude-opus-4-6",
                    "cheaper_model": model,
                    "overspend_usd": routing_saving,
                }
            ],
        }
        recs = recommend(record)
        self.assertGreater(len(recs), 1)
        # First rec must be the one with the larger saving
        for i in range(len(recs) - 1):
            a = recs[i]["estimated_saving_usd"]
            b = recs[i + 1]["estimated_saving_usd"]
            if isinstance(a, (int, float)) and isinstance(b, (int, float)):
                self.assertGreaterEqual(a, b)

    def test_estimate_unavailable_sorts_last(self) -> None:
        """'estimate unavailable' always sorts after quantified savings."""
        record = {
            "model": "unknown-model",
            "cache_hit_rate": 0.05,
            "cache_eligible_tokens": 50_000,
            "model_routing": [
                {
                    "phase": "review",
                    "model_used": "claude-opus-4-6",
                    "cheaper_model": "claude-sonnet-4-6",
                    "overspend_usd": 0.001,
                }
            ],
        }
        recs = recommend(record)
        # Find the unknown-model cache rec (estimate unavailable)
        unavailable = [r for r in recs if r["estimated_saving_usd"] == ESTIMATE_UNAVAILABLE]
        quantified = [r for r in recs if isinstance(r["estimated_saving_usd"], (int, float))]
        if unavailable and quantified:
            last_quantified_idx = max(recs.index(r) for r in quantified)
            first_unavailable_idx = min(recs.index(r) for r in unavailable)
            self.assertGreater(first_unavailable_idx, last_quantified_idx)


# ---------------------------------------------------------------------------
# AC1: pack recommendation fires when pack cost exceeds budget
# ---------------------------------------------------------------------------

class TestPackRecommendation(unittest.TestCase):
    """AC1 — pack_cost_usd > budget_usd fires pack recommendation."""

    def test_pack_over_budget_fires(self) -> None:
        record = {
            "model": "claude-sonnet-4-6",
            "pack_cost_usd": 0.050,
            "budget_usd": 0.020,
        }
        recs = recommend(record)
        pack_recs = [r for r in recs if r["technique"] == "context_budget"]
        self.assertEqual(len(pack_recs), 1)
        rec = pack_recs[0]
        self.assertAlmostEqual(rec["estimated_saving_usd"], 0.030, places=9)
        self.assertIn("contextBudgetUsd", rec["action"])

    def test_pack_over_threshold_fires_when_no_items_dropped(self) -> None:
        record = {
            "model": "claude-sonnet-4-6",
            "pack_cost_usd": 0.040,
            "pack_threshold_usd": 0.010,
            "items_dropped": 0,
        }
        recs = recommend(record)
        pack_recs = [r for r in recs if r["technique"] == "context_budget"]
        self.assertEqual(len(pack_recs), 1)
        self.assertAlmostEqual(pack_recs[0]["estimated_saving_usd"], 0.030, places=9)

    def test_pack_threshold_not_fire_when_items_dropped(self) -> None:
        """If items were already dropped, the threshold rule doesn't fire."""
        record = {
            "model": "claude-sonnet-4-6",
            "pack_cost_usd": 0.040,
            "pack_threshold_usd": 0.010,
            "items_dropped": 5,  # items were trimmed
        }
        recs = recommend(record)
        pack_recs = [r for r in recs if r["technique"] == "context_budget"]
        self.assertEqual(len(pack_recs), 0)


if __name__ == "__main__":
    unittest.main()
