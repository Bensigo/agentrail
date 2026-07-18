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

from agentrail.run.pricing import PRICES, cache_savings, cost_breakdown, cost_usd


@dataclass
class _Usage:
    model: str
    input_tokens: int
    output_tokens: int
    cache_tokens: int
    cache_creation_tokens: int = 0


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


# ---------------------------------------------------------------------------
# Dated model ids — the real ``claude`` agents report ids like
# ``claude-sonnet-4-5-20250929`` that are NOT keyed directly in the price
# table. They must resolve (via base-alias normalization) to a correct
# non-zero cost, not silently price at $0.
# ---------------------------------------------------------------------------

from agentrail.context.pricing import PRICE_TABLE  # noqa: E402


def _expected_cost(rates, *, input_tokens=0, output_tokens=0, cache_tokens=0):
    return (
        input_tokens * rates.input
        + output_tokens * rates.output
        + cache_tokens * rates.cache
    ) / 1_000_000


def test_cost_usd_base_sonnet_4_5_nonzero() -> None:
    """The base ``claude-sonnet-4-5`` alias prices at the sonnet rate, not $0."""
    rates = PRICES["claude-sonnet-4-5"]
    usage = _Usage(
        model="claude-sonnet-4-5",
        input_tokens=1_000_000,
        output_tokens=500_000,
        cache_tokens=0,
    )
    expected = _expected_cost(rates, input_tokens=1_000_000, output_tokens=500_000)
    assert expected > 0.0
    assert cost_usd(usage) == pytest.approx(expected, rel=1e-9)
    # Concrete sanity: 1M input @ $3 + 0.5M output @ $15 = $3 + $7.5 = $10.50
    assert cost_usd(usage) == pytest.approx(10.50, rel=1e-9)


def test_cost_usd_dated_sonnet_4_5_resolves_to_base_rate() -> None:
    """The real agent id ``claude-sonnet-4-5-20250929`` prices at the base rate."""
    base_rates = PRICES["claude-sonnet-4-5"]
    dated = _Usage(
        model="claude-sonnet-4-5-20250929",
        input_tokens=1_000_000,
        output_tokens=500_000,
        cache_tokens=200_000,
    )
    expected = _expected_cost(
        base_rates,
        input_tokens=1_000_000,
        output_tokens=500_000,
        cache_tokens=200_000,
    )
    assert expected > 0.0
    assert cost_usd(dated) == pytest.approx(expected, rel=1e-9)


def test_cost_usd_dated_id_equals_base_id() -> None:
    """A date-suffixed id costs exactly what its base alias costs."""
    fields = dict(input_tokens=123_456, output_tokens=7_890, cache_tokens=42_000)
    base = _Usage(model="claude-sonnet-4-5", **fields)
    dated = _Usage(model="claude-sonnet-4-5-20250929", **fields)
    assert cost_usd(dated) == pytest.approx(cost_usd(base), rel=1e-12)
    assert cost_usd(dated) > 0.0


def test_cost_usd_dated_sonnet_4_5_emits_no_warning() -> None:
    """Resolving a dated id must NOT emit the unknown-model UserWarning."""
    usage = _Usage(
        model="claude-sonnet-4-5-20250929",
        input_tokens=1_000,
        output_tokens=1_000,
        cache_tokens=0,
    )
    with warnings.catch_warnings():
        warnings.simplefilter("error")  # any warning becomes an exception
        result = cost_usd(usage)
    assert result > 0.0


def test_cost_usd_dated_opus_resolves_to_base_rate() -> None:
    """Dated opus snapshots resolve to the opus base alias."""
    base_rates = PRICES["claude-opus-4"]
    usage = _Usage(
        model="claude-opus-4-20250514",
        input_tokens=1_000_000,
        output_tokens=0,
        cache_tokens=0,
    )
    expected = _expected_cost(base_rates, input_tokens=1_000_000)
    assert cost_usd(usage) == pytest.approx(expected, rel=1e-9)


def test_cost_usd_unknown_base_with_date_still_returns_zero() -> None:
    """A dated id whose base alias is unknown still returns 0.0 (conservative)."""
    usage = _Usage(
        model="claude-does-not-exist-20250101",
        input_tokens=1_000,
        output_tokens=1_000,
        cache_tokens=0,
    )
    with warnings.catch_warnings(record=True):
        warnings.simplefilter("always")
        assert cost_usd(usage) == 0.0


def test_cache_savings_dated_id_resolves() -> None:
    """cache_savings on a dated id yields real dollar estimates, not 'unavailable'."""
    usage = _Usage(
        model="claude-sonnet-4-5-20250929",
        input_tokens=800_000,
        output_tokens=0,
        cache_tokens=200_000,
    )
    result = cache_savings(usage)
    assert isinstance(result["cached_usd_saved"], float)
    assert isinstance(result["baseline_uncached_usd"], float)


# ---------------------------------------------------------------------------
# AC2 — cache-creation (write) tokens priced at the cached_write rate
# ---------------------------------------------------------------------------


def test_cost_usd_includes_cache_creation_at_write_rate() -> None:
    """cost_usd charges cache_creation_tokens at the canonical cached_write rate."""
    model = "claude-sonnet-4-6"
    rates = PRICES[model]
    write_rate = PRICE_TABLE[model]["cached_write"]
    usage = _Usage(
        model=model,
        input_tokens=1_000_000,
        output_tokens=500_000,
        cache_tokens=200_000,
        cache_creation_tokens=300_000,
    )
    expected = (
        1_000_000 * rates.input
        + 500_000 * rates.output
        + 200_000 * rates.cache
        + 300_000 * write_rate
    ) / 1_000_000
    assert cost_usd(usage) == pytest.approx(expected, rel=1e-9)


def test_cost_usd_cache_creation_costs_more_than_cache_read() -> None:
    """For the same token count, a cache WRITE costs more than a cache READ (1.25x vs 0.1x)."""
    model = "claude-haiku-4-5"  # cached_write 1.25, cached_read 0.1
    write_usage = _Usage(model=model, input_tokens=0, output_tokens=0,
                         cache_tokens=0, cache_creation_tokens=1_000_000)
    read_usage = _Usage(model=model, input_tokens=0, output_tokens=0,
                        cache_tokens=1_000_000, cache_creation_tokens=0)
    assert cost_usd(write_usage) > cost_usd(read_usage)


def test_cost_usd_cache_creation_matches_canonical_table() -> None:
    """AC2 parity: cost_usd equals the canonical cost_for() for a model with all four token kinds."""
    from agentrail.context.pricing import cost_for

    model = "claude-opus-4-6"
    usage = _Usage(
        model=model,
        input_tokens=120_000,
        output_tokens=45_000,
        cache_tokens=33_000,
        cache_creation_tokens=77_000,
    )
    canonical = cost_for(
        model,
        input_tokens=120_000,
        output_tokens=45_000,
        cached_read=33_000,
        cached_write=77_000,
    )["dollars"]
    assert cost_usd(usage) == pytest.approx(canonical, rel=1e-9)


def test_cost_usd_cache_creation_haiku_4_5_explicit_multipliers() -> None:
    """haiku-4-5: input 1.0, cached_read 0.1 (0.1x), cached_write 1.25 (1.25x)."""
    model = "claude-haiku-4-5"
    usage = _Usage(model=model, input_tokens=0, output_tokens=0,
                   cache_tokens=1_000_000, cache_creation_tokens=1_000_000)
    # 1M cache_read * 0.1 + 1M cache_write * 1.25 = 0.1 + 1.25 = 1.35 USD
    assert cost_usd(usage) == pytest.approx(1.35, rel=1e-9)


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


# ---------------------------------------------------------------------------
# cost_breakdown — the four-component split must (a) sum to cost_usd exactly
# (parity invariant), (b) price each component at token×rate/1e6, and (c)
# mirror cost_usd's unknown-model behaviour (warn + all-zeros).
# ---------------------------------------------------------------------------

def test_cost_breakdown_components_sum_to_total_and_match_cost_usd() -> None:
    """The four components sum to total_usd, and total_usd == cost_usd(usage)."""
    model = "claude-sonnet-4-5"
    usage = _Usage(
        model=model,
        input_tokens=1_000_000,
        output_tokens=500_000,
        cache_tokens=200_000,
        cache_creation_tokens=100_000,
    )
    bd = cost_breakdown(usage)
    component_sum = (
        bd["input_usd"]
        + bd["output_usd"]
        + bd["cache_read_usd"]
        + bd["cache_write_usd"]
    )
    assert bd["total_usd"] == pytest.approx(component_sum, rel=1e-12)
    # Parity with the single-source scalar pricer — the breakdown can never
    # disagree with the total the rest of the system computes.
    assert bd["total_usd"] == pytest.approx(cost_usd(usage), rel=1e-12)


def test_cost_breakdown_per_component_math() -> None:
    """Each component equals token_count × rate / 1_000_000."""
    model = "claude-sonnet-4-5"
    rates = PRICES[model]
    usage = _Usage(
        model=model,
        input_tokens=1_000_000,
        output_tokens=500_000,
        cache_tokens=200_000,
        cache_creation_tokens=100_000,
    )
    bd = cost_breakdown(usage)
    assert bd["input_usd"] == pytest.approx(1_000_000 * rates.input / 1_000_000, rel=1e-12)
    assert bd["output_usd"] == pytest.approx(500_000 * rates.output / 1_000_000, rel=1e-12)
    assert bd["cache_read_usd"] == pytest.approx(200_000 * rates.cache / 1_000_000, rel=1e-12)
    assert bd["cache_write_usd"] == pytest.approx(
        100_000 * rates.cache_write / 1_000_000, rel=1e-12
    )


def test_cost_breakdown_rerank_usd_equals_pack_cost_and_preserves_parity() -> None:
    """The ``rerank_usd`` line equals the pack's ``rerankCostUsd`` and the
    components still sum to ``total_usd`` (parity), which is the agent's token
    cost PLUS the rerank layer's spend (#1044 AC3)."""
    from agentrail.context.llm_rerank import llm_rerank_cost_usd

    model = "claude-sonnet-4-5"
    usage = _Usage(
        model=model,
        input_tokens=1_000_000,
        output_tokens=500_000,
        cache_tokens=200_000,
        cache_creation_tokens=100_000,
    )
    # A realistic rerank ``llm`` usage block (as agentrail/context/packs.py builds)
    # priced by the canonical rerank pricer — this is exactly what the pack surfaces
    # as ``rerankCostUsd`` and hands to cost_breakdown.
    rerank_llm = {
        "model": "claude-haiku-4-5-20251001",
        "calls": 2,
        "inputTokens": 4_000,
        "outputTokens": 300,
        "cacheCreationInputTokens": 0,
        "cacheReadInputTokens": 0,
    }
    pack_rerank_cost = llm_rerank_cost_usd(rerank_llm)
    assert pack_rerank_cost > 0.0  # a real, non-zero model-call cost

    bd = cost_breakdown(usage, rerank_usd=pack_rerank_cost)

    # The rerank line IS the pack's rerankCostUsd, verbatim.
    assert bd["rerank_usd"] == pytest.approx(pack_rerank_cost, rel=1e-12)

    # Components-sum-to-total parity holds WITH the rerank line included.
    component_sum = (
        bd["input_usd"]
        + bd["output_usd"]
        + bd["cache_read_usd"]
        + bd["cache_write_usd"]
        + bd["expansion_usd"]
        + bd["rerank_usd"]
    )
    assert bd["total_usd"] == pytest.approx(component_sum, rel=1e-12)

    # The total is the agent token cost PLUS the rerank spend (rerank tokens are
    # NOT part of ``usage``), so it exceeds cost_usd(usage) by exactly the rerank.
    assert bd["total_usd"] == pytest.approx(cost_usd(usage) + pack_rerank_cost, rel=1e-12)


def test_cost_breakdown_default_rerank_usd_is_zero_and_matches_cost_usd() -> None:
    """With no rerank cost supplied the ``rerank_usd`` line is 0.0 and total stays
    byte-identical to ``cost_usd(usage)`` (additive, default-OFF)."""
    model = "claude-sonnet-4-5"
    usage = _Usage(
        model=model,
        input_tokens=1_000_000,
        output_tokens=500_000,
        cache_tokens=200_000,
        cache_creation_tokens=100_000,
    )
    bd = cost_breakdown(usage)
    assert bd["rerank_usd"] == 0.0
    assert bd["total_usd"] == pytest.approx(cost_usd(usage), rel=1e-12)


def test_cost_breakdown_unknown_model_still_surfaces_supplied_rerank_usd() -> None:
    """Unknown agent model zeroes the token components but still reports the
    independently-priced rerank cost (it needs no agent rate table)."""
    usage = _Usage(model="gpt-99-turbo-ultra", input_tokens=100, output_tokens=50, cache_tokens=10)
    with warnings.catch_warnings(record=True):
        bd = cost_breakdown(usage, rerank_usd=0.001234)
    assert bd["input_usd"] == 0.0
    assert bd["rerank_usd"] == pytest.approx(0.001234, rel=1e-12)
    assert bd["total_usd"] == pytest.approx(0.001234, rel=1e-12)


def test_cost_breakdown_unknown_model_returns_zeros() -> None:
    """Unknown model → all-zeros dict (mirrors cost_usd's non-fatal $0)."""
    usage = _Usage(model="gpt-99-turbo-ultra", input_tokens=100, output_tokens=50, cache_tokens=10)
    with warnings.catch_warnings(record=True):
        bd = cost_breakdown(usage)
    assert bd == {
        "input_usd": 0.0,
        "output_usd": 0.0,
        "cache_read_usd": 0.0,
        "cache_write_usd": 0.0,
        "expansion_usd": 0.0,
        "rerank_usd": 0.0,
        "total_usd": 0.0,
    }


def test_cost_breakdown_unknown_model_emits_warning() -> None:
    """cost_breakdown emits a UserWarning naming the unknown model."""
    model_name = "gpt-99-turbo-ultra"
    usage = _Usage(model=model_name, input_tokens=100, output_tokens=50, cache_tokens=0)
    with pytest.warns(UserWarning, match=model_name):
        cost_breakdown(usage)


# ---------------------------------------------------------------------------
# AI-gateway slug resolution (fix/fleet-model-pricing): the hosted fleet passes
# OpenRouter slugs ("anthropic/claude-sonnet-5", "z-ai/glm-5.2",
# "anthropic/claude-haiku-4.5") — before the provider-prefix + dot-to-dash
# normalization steps, every one of these priced as $0 with only a warning,
# silently zeroing hosted-run cost metering.
# ---------------------------------------------------------------------------


def test_cost_usd_openrouter_anthropic_prefix_resolves() -> None:
    """"anthropic/claude-sonnet-5" prices identically to "claude-sonnet-5"."""
    bare = _Usage(model="claude-sonnet-5", input_tokens=1_000_000, output_tokens=1_000_000, cache_tokens=0)
    slug = _Usage(model="anthropic/claude-sonnet-5", input_tokens=1_000_000, output_tokens=1_000_000, cache_tokens=0)
    assert cost_usd(bare) == cost_usd(slug)
    assert cost_usd(slug) == pytest.approx(3.0 + 15.0)


def test_cost_usd_openrouter_dotted_version_resolves() -> None:
    """"anthropic/claude-haiku-4.5" (OpenRouter dots) → canonical claude-haiku-4-5."""
    slug = _Usage(model="anthropic/claude-haiku-4.5", input_tokens=1_000_000, output_tokens=0, cache_tokens=0)
    assert cost_usd(slug) == pytest.approx(1.0)


def test_cost_usd_glm_verify_seat_resolves_nonzero() -> None:
    """"z-ai/glm-5.2" — the hosted verify seat — must never price as $0."""
    slug = _Usage(model="z-ai/glm-5.2", input_tokens=1_000_000, output_tokens=1_000_000, cache_tokens=0)
    assert cost_usd(slug) == pytest.approx(0.30 + 0.94)


def test_cost_usd_unknown_prefixed_model_still_zero_with_warning() -> None:
    """Normalization must not invent rates: unknown slugs still warn + $0."""
    usage = _Usage(model="acme/unknown-model-9", input_tokens=100, output_tokens=50, cache_tokens=0)
    with pytest.warns(UserWarning, match="acme/unknown-model-9"):
        assert cost_usd(usage) == 0.0


def test_hosted_config_template_models_all_price_nonzero() -> None:
    """Every model in the SHIPPED hosted config resolves to real rates.

    Coupling test between deploy/runner/agentrail-config.hosted.json and the
    canonical price table: a template slug the resolver can't price means every
    hosted run on that seat records $0 cost (the exact false green this branch
    fixes — the old critic slug "~anthropic/claude-haiku-latest" was both an
    invalid OpenRouter model AND unpriceable). Parses the real shipped file so
    template edits that break pricing fail CI here.
    """
    import json
    from pathlib import Path

    template = Path(__file__).resolve().parents[3] / "deploy" / "runner" / "agentrail-config.hosted.json"
    config = json.loads(template.read_text())
    models = config["runners"]["claude"]["models"]
    assert set(models) >= {"execute", "verify", "critic"}
    for seat, slug in models.items():
        usage = _Usage(model=slug, input_tokens=1_000_000, output_tokens=1_000_000, cache_tokens=0)
        with warnings.catch_warnings():
            warnings.simplefilter("error")  # any unknown-model warning fails the test
            assert cost_usd(usage) > 0.0, f"hosted config {seat} seat {slug!r} prices as $0"
