"""Tests for agentrail/run/pricing.py.

Covers:
- AC1: cost_usd() returns the correct dollar figure for every model in PRICES.
- AC2: Unknown model emits UserWarning and returns 0.0.
- AC4(b): cache_hit_rate and cached_usd_saved math against a fixed Usage fixture.
- AC4(c): estimate-unavailable path for unknown model.
"""
from __future__ import annotations

import warnings
from dataclasses import dataclass

import pytest

from agentrail.run.pricing import PRICES, cache_savings, cost_usd


@dataclass
class _Usage:
    model: str
    input_tokens: int
    output_tokens: int
    cache_tokens: int


# ---------------------------------------------------------------------------
# AC1 — parametric over the full rate table
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("model", list(PRICES.keys()))
def test_cost_usd_known_model(model: str) -> None:
    """cost_usd returns the expected dollar figure for every table entry."""
    rates = PRICES[model]
    usage = _Usage(
        model=model,
        input_tokens=1_000_000,
        output_tokens=500_000,
        cache_tokens=200_000,
    )
    expected = (
        1_000_000 * rates.input
        + 500_000 * rates.output
        + 200_000 * rates.cache
    ) / 1_000_000
    assert cost_usd(usage) == pytest.approx(expected, rel=1e-9)


def test_cost_usd_zero_tokens() -> None:
    """Zero-token usage always costs $0.00."""
    model = next(iter(PRICES))
    usage = _Usage(model=model, input_tokens=0, output_tokens=0, cache_tokens=0)
    assert cost_usd(usage) == 0.0


def test_cost_usd_only_input_tokens() -> None:
    """Only input tokens incur the input rate."""
    model = "claude-sonnet-4-6"
    rates = PRICES[model]
    usage = _Usage(model=model, input_tokens=2_000_000, output_tokens=0, cache_tokens=0)
    expected = 2_000_000 * rates.input / 1_000_000
    assert cost_usd(usage) == pytest.approx(expected)


def test_cost_usd_small_fractions() -> None:
    """Single-token usage returns a very small but non-zero cost."""
    model = "claude-haiku-4-5"
    usage = _Usage(model=model, input_tokens=1, output_tokens=1, cache_tokens=1)
    result = cost_usd(usage)
    assert result > 0.0


# ---------------------------------------------------------------------------
# AC2 — unknown model emits warning and returns 0.0
# ---------------------------------------------------------------------------

def test_cost_usd_unknown_model_returns_zero() -> None:
    """cost_usd returns 0.0 for an unrecognised model."""
    usage = _Usage(model="gpt-99-turbo-ultra", input_tokens=100, output_tokens=50, cache_tokens=0)
    with warnings.catch_warnings(record=True):
        result = cost_usd(usage)
    assert result == 0.0


def test_cost_usd_unknown_model_emits_warning() -> None:
    """cost_usd emits a UserWarning naming the unknown model."""
    model_name = "gpt-99-turbo-ultra"
    usage = _Usage(model=model_name, input_tokens=100, output_tokens=50, cache_tokens=0)
    with pytest.warns(UserWarning, match=model_name):
        cost_usd(usage)


# ---------------------------------------------------------------------------
# AC4(b) — cache_savings math against a fixed Usage fixture
# ---------------------------------------------------------------------------

def test_cache_savings_hit_rate_math() -> None:
    """cache_hit_rate = cache_tokens / (input_tokens + cache_tokens)."""
    # 200k cached out of 1M prompt tokens → 20 %
    usage = _Usage(model="claude-sonnet-4-6", input_tokens=800_000, output_tokens=50_000, cache_tokens=200_000)
    result = cache_savings(usage)
    assert result["cache_hit_rate"] == pytest.approx(200_000 / 1_000_000)


def test_cache_savings_cached_usd_saved_math() -> None:
    """cached_usd_saved = cache_tokens * (input_rate - cache_rate) / 1_000_000."""
    model = "claude-sonnet-4-6"
    rates = PRICES[model]
    usage = _Usage(model=model, input_tokens=800_000, output_tokens=50_000, cache_tokens=200_000)
    result = cache_savings(usage)
    expected_saved = 200_000 * (rates.input - rates.cache) / 1_000_000
    assert isinstance(result["cached_usd_saved"], float)
    assert result["cached_usd_saved"] == pytest.approx(expected_saved, rel=1e-9)


def test_cache_savings_baseline_uncached_usd_math() -> None:
    """baseline_uncached_usd = (input+cache) * input_rate + output * output_rate / 1_000_000."""
    model = "claude-sonnet-4-6"
    rates = PRICES[model]
    usage = _Usage(model=model, input_tokens=800_000, output_tokens=50_000, cache_tokens=200_000)
    result = cache_savings(usage)
    expected_baseline = (1_000_000 * rates.input + 50_000 * rates.output) / 1_000_000
    assert isinstance(result["baseline_uncached_usd"], float)
    assert result["baseline_uncached_usd"] == pytest.approx(expected_baseline, rel=1e-9)


def test_cache_savings_saved_is_positive_when_cache_rate_below_input() -> None:
    """For every model in PRICES with cache < input, saved dollars are positive."""
    usage = _Usage(model="claude-sonnet-4-6", input_tokens=0, output_tokens=0, cache_tokens=1_000_000)
    result = cache_savings(usage)
    rates = PRICES["claude-sonnet-4-6"]
    if rates.cache < rates.input:
        assert isinstance(result["cached_usd_saved"], float)
        assert result["cached_usd_saved"] > 0.0


def test_cache_savings_zero_tokens_gives_zero_hit_rate() -> None:
    """No divide-by-zero when both input_tokens and cache_tokens are 0."""
    usage = _Usage(model="claude-sonnet-4-6", input_tokens=0, output_tokens=0, cache_tokens=0)
    result = cache_savings(usage)
    assert result["cache_hit_rate"] == 0.0


def test_cache_savings_no_cache_tokens_gives_zero_hit_rate() -> None:
    usage = _Usage(model="claude-sonnet-4-6", input_tokens=500_000, output_tokens=0, cache_tokens=0)
    result = cache_savings(usage)
    assert result["cache_hit_rate"] == 0.0


# ---------------------------------------------------------------------------
# AC4(c) — estimate-unavailable path for unknown model
# ---------------------------------------------------------------------------

def test_cache_savings_unknown_model_returns_estimate_unavailable() -> None:
    """Unknown model → cached_usd_saved and baseline_uncached_usd are 'estimate unavailable'."""
    usage = _Usage(model="nonexistent-xyz", input_tokens=500_000, output_tokens=0, cache_tokens=100_000)
    result = cache_savings(usage)
    assert result["cached_usd_saved"] == "estimate unavailable"
    assert result["baseline_uncached_usd"] == "estimate unavailable"


def test_cache_savings_unknown_model_still_has_hit_rate() -> None:
    """Hit rate is always computable (token counts only, no pricing needed)."""
    usage = _Usage(model="nonexistent-xyz", input_tokens=400_000, output_tokens=0, cache_tokens=100_000)
    result = cache_savings(usage)
    assert result["cache_hit_rate"] == pytest.approx(100_000 / 500_000)


def test_cache_savings_unknown_model_does_not_raise() -> None:
    """No exception on unknown model — non-fatal like cost_usd."""
    usage = _Usage(model="nonexistent-xyz", input_tokens=100, output_tokens=50, cache_tokens=10)
    result = cache_savings(usage)  # must not raise
    assert isinstance(result, dict)
    assert "cache_hit_rate" in result
