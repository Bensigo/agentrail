"""Tests for agentrail/run/pricing.py.

Covers:
- AC1: cost_usd() returns the correct dollar figure for every model in PRICES.
- AC2: Unknown model emits UserWarning and returns 0.0.
"""
from __future__ import annotations

import warnings
from dataclasses import dataclass

import pytest

from agentrail.run.pricing import PRICES, cost_usd


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
