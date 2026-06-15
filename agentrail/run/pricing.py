"""Per-model pricing table and cost computation.

PRICES is the single source of truth for token rates. Rates are in USD per
million tokens ($/MTok). Each entry has three fields: input, output, cache.

Cache rate covers input-cache-read tokens uniformly (per PRD #451 §2).
"""
from __future__ import annotations

import warnings
from typing import Any, Dict, NamedTuple, Union


class _Rates(NamedTuple):
    input: float   # $/MTok
    output: float  # $/MTok
    cache: float   # $/MTok  (cache-read rate)


# ---------------------------------------------------------------------------
# Rate table — update when provider changes pricing.
# Source: public Anthropic and OpenAI pricing pages (as of 2026-06).
# ---------------------------------------------------------------------------
PRICES: dict[str, _Rates] = {
    # Claude — current generation (cache = ~0.1x input, the cache-read rate)
    "claude-fable-5":               _Rates(input=10.00, output=50.00, cache=1.00),
    "claude-opus-4-8":              _Rates(input=5.00,  output=25.00, cache=0.50),
    "claude-opus-4-7":              _Rates(input=5.00,  output=25.00, cache=0.50),
    "claude-opus-4-6":              _Rates(input=5.00,  output=25.00, cache=0.50),
    "claude-opus-4-5":              _Rates(input=5.00,  output=25.00, cache=0.50),
    "claude-sonnet-4-6":            _Rates(input=3.00,  output=15.00, cache=0.30),
    "claude-sonnet-4-5":            _Rates(input=3.00,  output=15.00, cache=0.30),
    "claude-haiku-4-5":             _Rates(input=1.00,  output=5.00,  cache=0.10),
    "claude-haiku-4-5-20251001":    _Rates(input=1.00,  output=5.00,  cache=0.10),
    # Claude 3.x family (still in use)
    "claude-opus-3-5":              _Rates(input=15.00, output=75.00, cache=1.50),
    "claude-sonnet-3-7":            _Rates(input=3.00,  output=15.00, cache=0.30),
    "claude-sonnet-3-5":            _Rates(input=3.00,  output=15.00, cache=0.30),
    "claude-haiku-3-5":             _Rates(input=0.80,  output=4.00,  cache=0.08),
    # OpenAI / Codex models
    "gpt-5.5":                      _Rates(input=2.00,  output=8.00,  cache=1.00),
    "gpt-5":                        _Rates(input=10.00, output=40.00, cache=2.50),
    "gpt-5-codex":                  _Rates(input=15.00, output=60.00, cache=3.75),
    "gpt-4o":                       _Rates(input=2.50,  output=10.00, cache=1.25),
    "gpt-4o-mini":                  _Rates(input=0.15,  output=0.60,  cache=0.075),
    "o3":                           _Rates(input=10.00, output=40.00, cache=2.50),
    "o4-mini":                      _Rates(input=1.10,  output=4.40,  cache=0.275),
}


def cost_usd(usage: object) -> float:
    """Return cost in USD for *usage*.

    *usage* must expose ``.model``, ``.input_tokens``, ``.output_tokens``,
    and ``.cache_tokens`` attributes (compatible with the ``Usage`` dataclass
    from ``usage_capture.py``).

    Unknown model → emits ``UserWarning`` and returns ``0.0`` so the calling
    pipeline is never blocked.
    """
    model: str = usage.model  # type: ignore[attr-defined]
    rates = PRICES.get(model)
    if rates is None:
        warnings.warn(
            f"pricing: unknown model {model!r} — cost_usd returning 0.0",
            UserWarning,
            stacklevel=2,
        )
        return 0.0

    input_tokens: int = usage.input_tokens    # type: ignore[attr-defined]
    output_tokens: int = usage.output_tokens  # type: ignore[attr-defined]
    cache_tokens: int = usage.cache_tokens    # type: ignore[attr-defined]

    return (
        input_tokens * rates.input
        + output_tokens * rates.output
        + cache_tokens * rates.cache
    ) / 1_000_000


def cache_savings(usage: object) -> Dict[str, Any]:
    """Compute prompt-cache hit metrics for *usage*.

    Returns a dict with three auditable fields:

    - ``cache_hit_rate``: ``cache_tokens / (input_tokens + cache_tokens)``
      as a float in [0, 1].  Always present.
    - ``cached_usd_saved``: dollars saved by the cache — the difference between
      pricing cache_tokens at the full input rate vs the (cheaper) cache rate:
      ``cache_tokens * (rates.input - rates.cache) / 1_000_000``.
      Set to ``"estimate unavailable"`` when the model is not in PRICES.
    - ``baseline_uncached_usd``: what the run would have cost with no cache hits
      (all cache_tokens charged at input rate instead).
      Set to ``"estimate unavailable"`` when the model is not in PRICES.

    Divide-by-zero: when ``input_tokens + cache_tokens == 0``,
    ``cache_hit_rate`` is 0.0 (never raises).
    """
    model: str = usage.model  # type: ignore[attr-defined]
    input_tokens: int = usage.input_tokens  # type: ignore[attr-defined]
    output_tokens: int = usage.output_tokens  # type: ignore[attr-defined]
    cache_tokens: int = usage.cache_tokens  # type: ignore[attr-defined]

    total_prompt_tokens = input_tokens + cache_tokens
    cache_hit_rate = cache_tokens / total_prompt_tokens if total_prompt_tokens > 0 else 0.0

    rates = PRICES.get(model)
    if rates is None:
        return {
            "cache_hit_rate": cache_hit_rate,
            "cached_usd_saved": "estimate unavailable",
            "baseline_uncached_usd": "estimate unavailable",
        }

    cached_usd_saved = cache_tokens * (rates.input - rates.cache) / 1_000_000
    baseline_uncached_usd = (
        total_prompt_tokens * rates.input + output_tokens * rates.output
    ) / 1_000_000

    return {
        "cache_hit_rate": cache_hit_rate,
        "cached_usd_saved": cached_usd_saved,
        "baseline_uncached_usd": baseline_uncached_usd,
    }
