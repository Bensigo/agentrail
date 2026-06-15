"""Tests for agentrail/run/routing.py — model routing / overspend detection.

Covers all issue #707 acceptance criteria:
  AC1: routing_record emits a record with correct fields when cheaper model exists.
  AC2: bottom-of-ladder models return None (no cheaper model).
  AC3: _apply_routing writes config; second call is a no-op (idempotent).
  AC4: no cross-family recommendations.
  AC5: unknown model emits UserWarning, no record.
  AC6: unit tests: (a) Opus→Sonnet overspend math; (b) Haiku→none; (c) unknown→warning;
       (d) --apply idempotency; (e) cross-family input → no recommendation.
"""
from __future__ import annotations

import json
import tempfile
import warnings
from dataclasses import dataclass
from pathlib import Path

import pytest

from agentrail.run.pricing import PRICES
from agentrail.run.routing import (
    _apply_routing,
    cheaper_model,
    classify,
    cost_for_model,
    routing_record,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

@dataclass
class _Usage:
    model: str
    input_tokens: int
    output_tokens: int
    cache_tokens: int


def _make_target(cfg: dict = None) -> Path:
    d = tempfile.mkdtemp()
    p = Path(d)
    if cfg is not None:
        agentrail_dir = p / ".agentrail"
        agentrail_dir.mkdir()
        (agentrail_dir / "config.json").write_text(json.dumps(cfg))
    return p


# ---------------------------------------------------------------------------
# classify()
# ---------------------------------------------------------------------------

class TestClassify:
    def test_claude_fable(self) -> None:
        assert classify("claude-fable-5") == ("claude", 0)

    def test_claude_opus(self) -> None:
        assert classify("claude-opus-4-8") == ("claude", 1)
        assert classify("claude-opus-4-5") == ("claude", 1)
        assert classify("claude-opus-3-5") == ("claude", 1)

    def test_claude_sonnet(self) -> None:
        assert classify("claude-sonnet-4-6") == ("claude", 2)
        assert classify("claude-sonnet-3-7") == ("claude", 2)

    def test_claude_haiku(self) -> None:
        assert classify("claude-haiku-4-5") == ("claude", 3)
        assert classify("claude-haiku-4-5-20251001") == ("claude", 3)
        assert classify("claude-haiku-3-5") == ("claude", 3)

    def test_gpt_top_tier(self) -> None:
        assert classify("gpt-5") == ("gpt", 0)
        assert classify("gpt-5-codex") == ("gpt", 0)
        assert classify("gpt-5.5") == ("gpt", 0)
        assert classify("o3") == ("gpt", 0)

    def test_gpt_mid_tier(self) -> None:
        assert classify("gpt-4o") == ("gpt", 1)

    def test_gpt_cheap_tier(self) -> None:
        assert classify("gpt-4o-mini") == ("gpt", 2)
        assert classify("o4-mini") == ("gpt", 2)

    def test_unknown_model_returns_none(self) -> None:
        assert classify("gpt-99-turbo-ultra") is None
        assert classify("llama-3") is None
        assert classify("") is None


# ---------------------------------------------------------------------------
# cheaper_model()
# ---------------------------------------------------------------------------

class TestCheaperModel:
    def test_fable_yields_opus(self) -> None:
        assert cheaper_model("claude-fable-5") == "claude-opus-4-8"

    def test_opus_yields_sonnet(self) -> None:
        assert cheaper_model("claude-opus-4-8") == "claude-sonnet-4-6"
        assert cheaper_model("claude-opus-4-5") == "claude-sonnet-4-6"

    def test_sonnet_yields_haiku(self) -> None:
        assert cheaper_model("claude-sonnet-4-6") == "claude-haiku-4-5"

    def test_haiku_yields_none(self) -> None:
        assert cheaper_model("claude-haiku-4-5") is None
        assert cheaper_model("claude-haiku-4-5-20251001") is None
        assert cheaper_model("claude-haiku-3-5") is None

    def test_gpt_top_yields_gpt4o(self) -> None:
        assert cheaper_model("gpt-5") == "gpt-4o"
        assert cheaper_model("o3") == "gpt-4o"

    def test_gpt4o_yields_mini(self) -> None:
        assert cheaper_model("gpt-4o") == "gpt-4o-mini"

    def test_gpt4o_mini_yields_none(self) -> None:
        assert cheaper_model("gpt-4o-mini") is None
        assert cheaper_model("o4-mini") is None

    def test_unknown_yields_none(self) -> None:
        assert cheaper_model("llama-3") is None


# ---------------------------------------------------------------------------
# cost_for_model()
# ---------------------------------------------------------------------------

class TestCostForModel:
    def test_opus_pricing(self) -> None:
        rates = PRICES["claude-opus-4-8"]
        expected = (1000 * rates.input + 500 * rates.output + 100 * rates.cache) / 1_000_000
        assert cost_for_model("claude-opus-4-8", 1000, 500, 100) == pytest.approx(expected)

    def test_unknown_model_warns_and_returns_zero(self) -> None:
        with pytest.warns(UserWarning, match="cannot reprice"):
            result = cost_for_model("unknown-x", 1000, 500, 100)
        assert result == 0.0


# ---------------------------------------------------------------------------
# AC6a: routing_record — Opus used → Sonnet recommendation with correct math
# ---------------------------------------------------------------------------

class TestRoutingRecordOpusToSonnet:
    def test_opus_recommends_sonnet_with_correct_math(self) -> None:
        usage = _Usage(
            model="claude-opus-4-8",
            input_tokens=10_000,
            output_tokens=2_000,
            cache_tokens=0,
        )
        rec = routing_record(usage, phase="execute")

        assert rec is not None
        assert rec["phase"] == "execute"
        assert rec["model_used"] == "claude-opus-4-8"
        assert rec["cheaper_model"] == "claude-sonnet-4-6"
        assert rec["tokens"] == 12_000

        opus_rates = PRICES["claude-opus-4-8"]
        sonnet_rates = PRICES["claude-sonnet-4-6"]
        expected_used = (10_000 * opus_rates.input + 2_000 * opus_rates.output) / 1_000_000
        expected_cheaper = (10_000 * sonnet_rates.input + 2_000 * sonnet_rates.output) / 1_000_000
        expected_overspend = expected_used - expected_cheaper

        assert rec["cost_used_usd"] == pytest.approx(expected_used, rel=1e-6)
        assert rec["cost_cheaper_usd"] == pytest.approx(expected_cheaper, rel=1e-6)
        assert rec["overspend_usd"] == pytest.approx(expected_overspend, rel=1e-6)
        assert rec["overspend_usd"] > 0

    def test_returns_none_when_overspend_zero(self) -> None:
        # Hypothetical: if used and cheaper have same rate, no record emitted.
        # We can't easily trigger this from the real table, but test the logic
        # by checking that haiku (cheapest) returns None.
        usage = _Usage(model="claude-haiku-4-5", input_tokens=1000, output_tokens=500, cache_tokens=0)
        assert routing_record(usage) is None


# ---------------------------------------------------------------------------
# AC6b: Haiku → no recommendation
# ---------------------------------------------------------------------------

class TestRoutingRecordHaikuNoRec:
    def test_haiku_returns_none(self) -> None:
        usage = _Usage(model="claude-haiku-4-5", input_tokens=5000, output_tokens=1000, cache_tokens=200)
        rec = routing_record(usage)
        assert rec is None

    def test_gpt4o_mini_returns_none(self) -> None:
        usage = _Usage(model="gpt-4o-mini", input_tokens=5000, output_tokens=1000, cache_tokens=0)
        rec = routing_record(usage)
        assert rec is None

    def test_o4_mini_returns_none(self) -> None:
        usage = _Usage(model="o4-mini", input_tokens=5000, output_tokens=1000, cache_tokens=0)
        rec = routing_record(usage)
        assert rec is None


# ---------------------------------------------------------------------------
# AC6c: Unknown model → warning only, no record
# ---------------------------------------------------------------------------

class TestRoutingRecordUnknownModel:
    def test_unknown_model_emits_warning(self) -> None:
        usage = _Usage(model="gpt-99-turbo-ultra", input_tokens=1000, output_tokens=500, cache_tokens=0)
        with pytest.warns(UserWarning, match="gpt-99-turbo-ultra"):
            rec = routing_record(usage)
        assert rec is None

    def test_unknown_model_names_the_model_in_warning(self) -> None:
        model = "some-future-model-x"
        usage = _Usage(model=model, input_tokens=1000, output_tokens=500, cache_tokens=0)
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            rec = routing_record(usage)
        assert rec is None
        assert any(model in str(w.message) for w in caught)

    def test_empty_model_emits_warning(self) -> None:
        usage = _Usage(model="", input_tokens=1000, output_tokens=500, cache_tokens=0)
        with pytest.warns(UserWarning, match="empty model"):
            rec = routing_record(usage)
        assert rec is None


# ---------------------------------------------------------------------------
# AC4: No cross-family recommendations
# ---------------------------------------------------------------------------

class TestNoCrossFamilyRecommendations:
    def test_opus_recommends_only_sonnet_not_gpt(self) -> None:
        usage = _Usage(model="claude-opus-4-8", input_tokens=1000, output_tokens=500, cache_tokens=0)
        rec = routing_record(usage)
        assert rec is not None
        # Must be a Claude model, not GPT
        assert "claude" in rec["cheaper_model"]
        assert "gpt" not in rec["cheaper_model"]

    def test_gpt5_recommends_only_gpt4o_not_claude(self) -> None:
        usage = _Usage(model="gpt-5", input_tokens=1000, output_tokens=500, cache_tokens=0)
        rec = routing_record(usage)
        assert rec is not None
        assert "gpt" in rec["cheaper_model"]
        assert "claude" not in rec["cheaper_model"]

    def test_gpt4o_mini_no_cross_family(self) -> None:
        # gpt-4o-mini is cheapest in GPT family → no recommendation at all
        usage = _Usage(model="gpt-4o-mini", input_tokens=1000, output_tokens=500, cache_tokens=0)
        rec = routing_record(usage)
        assert rec is None


# ---------------------------------------------------------------------------
# AC6d: --apply idempotency
# ---------------------------------------------------------------------------

class TestApplyRoutingIdempotency:
    def _make_rec(self, phase: str = "execute") -> dict:
        return {
            "phase": phase,
            "model_used": "claude-opus-4-8",
            "cheaper_model": "claude-sonnet-4-6",
            "tokens": 12000,
            "cost_used_usd": 0.06,
            "cost_cheaper_usd": 0.036,
            "overspend_usd": 0.024,
        }

    def test_apply_writes_config(self) -> None:
        target = _make_target()
        rec = self._make_rec()
        updated = _apply_routing(rec, target, "claude")
        assert updated is True
        cfg = json.loads((target / ".agentrail" / "config.json").read_text())
        assert cfg["runners"]["claude"]["models"]["execute"] == "claude-sonnet-4-6"

    def test_apply_is_idempotent_second_call_no_op(self) -> None:
        target = _make_target()
        rec = self._make_rec()
        _apply_routing(rec, target, "claude")
        # Read config after first apply
        content_after_first = (target / ".agentrail" / "config.json").read_text()
        # Second apply
        updated = _apply_routing(rec, target, "claude")
        assert updated is False
        content_after_second = (target / ".agentrail" / "config.json").read_text()
        assert content_after_first == content_after_second

    def test_apply_noop_when_cheaper_model_already_configured(self) -> None:
        # Config already has haiku (cheaper than sonnet) → no-op
        target = _make_target({"runners": {"claude": {"models": {"execute": "claude-haiku-4-5"}}}})
        rec = self._make_rec()  # recommends sonnet
        updated = _apply_routing(rec, target, "claude")
        assert updated is False
        cfg = json.loads((target / ".agentrail" / "config.json").read_text())
        # Should still be haiku
        assert cfg["runners"]["claude"]["models"]["execute"] == "claude-haiku-4-5"

    def test_apply_noop_when_same_model_configured(self) -> None:
        target = _make_target({"runners": {"claude": {"models": {"execute": "claude-sonnet-4-6"}}}})
        rec = self._make_rec()  # recommends sonnet
        updated = _apply_routing(rec, target, "claude")
        assert updated is False

    def test_apply_writes_when_more_expensive_configured(self) -> None:
        # Config has fable (more expensive than sonnet) → should overwrite
        target = _make_target({"runners": {"claude": {"models": {"execute": "claude-fable-5"}}}})
        rec = self._make_rec()  # recommends sonnet
        updated = _apply_routing(rec, target, "claude")
        assert updated is True
        cfg = json.loads((target / ".agentrail" / "config.json").read_text())
        assert cfg["runners"]["claude"]["models"]["execute"] == "claude-sonnet-4-6"

    def test_apply_creates_config_when_missing(self) -> None:
        target = _make_target()  # no .agentrail dir
        rec = self._make_rec()
        updated = _apply_routing(rec, target, "claude")
        assert updated is True
        config_path = target / ".agentrail" / "config.json"
        assert config_path.exists()
        cfg = json.loads(config_path.read_text())
        assert cfg["runners"]["claude"]["models"]["execute"] == "claude-sonnet-4-6"

    def test_apply_preserves_other_config_keys(self) -> None:
        existing = {"budgets": {"per_issue_usd": 1.0}, "runners": {"claude": {"model": "claude-opus-4-8"}}}
        target = _make_target(existing)
        rec = self._make_rec()
        _apply_routing(rec, target, "claude")
        cfg = json.loads((target / ".agentrail" / "config.json").read_text())
        assert cfg["budgets"]["per_issue_usd"] == 1.0
        assert cfg["runners"]["claude"]["model"] == "claude-opus-4-8"
        assert cfg["runners"]["claude"]["models"]["execute"] == "claude-sonnet-4-6"


# ---------------------------------------------------------------------------
# AC2: no_overspend → no record for bottom-of-ladder models (edge cases)
# ---------------------------------------------------------------------------

class TestAC2NoCheaperModel:
    @pytest.mark.parametrize("model", [
        "claude-haiku-4-5",
        "claude-haiku-4-5-20251001",
        "claude-haiku-3-5",
        "gpt-4o-mini",
        "o4-mini",
    ])
    def test_cheapest_models_return_none(self, model: str) -> None:
        usage = _Usage(model=model, input_tokens=10000, output_tokens=2000, cache_tokens=500)
        rec = routing_record(usage)
        assert rec is None, f"Expected None for cheapest model {model!r}, got {rec}"


# ---------------------------------------------------------------------------
# AC1: routing_record fields are complete and correct for all ladder steps
# ---------------------------------------------------------------------------

class TestAC1RoutingRecordFields:
    @pytest.mark.parametrize("model,expected_cheaper", [
        ("claude-fable-5",  "claude-opus-4-8"),
        ("claude-opus-4-8", "claude-sonnet-4-6"),
        ("claude-sonnet-4-6", "claude-haiku-4-5"),
        ("gpt-5",    "gpt-4o"),
        ("gpt-4o",   "gpt-4o-mini"),
    ])
    def test_record_has_required_fields(self, model: str, expected_cheaper: str) -> None:
        usage = _Usage(model=model, input_tokens=5000, output_tokens=1000, cache_tokens=200)
        rec = routing_record(usage, phase="execute")
        assert rec is not None, f"Expected a record for {model!r}"
        assert rec["phase"] == "execute"
        assert rec["model_used"] == model
        assert rec["cheaper_model"] == expected_cheaper
        assert rec["tokens"] == 6200
        assert rec["cost_used_usd"] > 0
        assert rec["cost_cheaper_usd"] > 0
        assert rec["overspend_usd"] > 0
        assert rec["cost_used_usd"] > rec["cost_cheaper_usd"]

    def test_record_includes_cache_in_tokens(self) -> None:
        usage = _Usage(model="claude-opus-4-8", input_tokens=1000, output_tokens=200, cache_tokens=100)
        rec = routing_record(usage)
        assert rec is not None
        assert rec["tokens"] == 1300
