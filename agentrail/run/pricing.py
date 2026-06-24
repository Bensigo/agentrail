"""Per-model pricing table and cost computation.

PRICES is the single source of truth for token rates. Rates are in USD per
million tokens ($/MTok). Each entry has three fields: input, output, cache.

Cache rate covers input-cache-read tokens uniformly (per PRD #451 §2).
"""
from __future__ import annotations

import re
import warnings
from typing import Any, Dict, NamedTuple, Optional, Union

from agentrail.context.pricing import PRICE_TABLE as _PRICE_TABLE


class _Rates(NamedTuple):
    input: float        # $/MTok
    output: float       # $/MTok
    cache: float        # $/MTok  (cache-READ rate, canonical ``cached_read``)
    cache_write: float  # $/MTok  (cache-WRITE rate, canonical ``cached_write``)


# ---------------------------------------------------------------------------
# Rate table — DERIVED from the single canonical table in
# ``agentrail.context.pricing.PRICE_TABLE`` (#715). Do not hardcode a second
# table here. ``cache`` maps to the canonical ``cached_read`` rate and
# ``cache_write`` to ``cached_write`` (cache-creation; ~1.25x input for Claude).
# ---------------------------------------------------------------------------
PRICES: dict[str, _Rates] = {
    model: _Rates(
        input=r["input"],
        output=r["output"],
        cache=r["cached_read"],
        cache_write=r["cached_write"],
    )
    for model, r in _PRICE_TABLE.items()
}


# ---------------------------------------------------------------------------
# Model-id resolution.
#
# The real ``claude`` agents report *dated* model ids (e.g.
# ``claude-sonnet-4-5-20250929``) while the canonical price table keys on the
# *base* alias (``claude-sonnet-4-5``). Without normalization those dated ids
# fall through to the unknown-model path and price at $0.0, so every eval cost
# silently reads as a fake $0.
#
# ``_resolve_rates`` tries an exact match first (so every existing known id —
# including the dated ids that ARE in the table, like
# ``claude-haiku-4-5-20251001`` — prices identically), then strips a single
# trailing ``-YYYYMMDD`` date snapshot and retries against the base alias. This
# tolerates future dated snapshots of already-priced models without inventing
# any new rates: a dated id can only resolve if its base alias is in the
# canonical table.
# ---------------------------------------------------------------------------
_DATE_SUFFIX_RE = re.compile(r"-\d{8}$")


def _resolve_rates(model: str) -> Optional[_Rates]:
    """Return the ``_Rates`` for *model*, tolerating a trailing ``-YYYYMMDD``.

    Resolution order:

    1. Exact match against ``PRICES`` (keeps every known id, dated or not,
       pricing identically to before).
    2. If *model* ends in a ``-YYYYMMDD`` date snapshot, strip it and match the
       base alias (e.g. ``claude-sonnet-4-5-20250929`` → ``claude-sonnet-4-5``).

    Returns ``None`` when neither resolves — the caller then warns + returns 0.
    """
    rates = PRICES.get(model)
    if rates is not None:
        return rates
    base = _DATE_SUFFIX_RE.sub("", model)
    if base != model:
        return PRICES.get(base)
    return None


def cost_usd(usage: object) -> float:
    """Return cost in USD for *usage*.

    *usage* must expose ``.model``, ``.input_tokens``, ``.output_tokens``,
    and ``.cache_tokens`` attributes (compatible with the ``Usage`` dataclass
    from ``usage_capture.py``). The optional ``.cache_creation_tokens``
    attribute is priced at the cache-WRITE rate (defaults to 0 when absent).

    Unknown model → emits ``UserWarning`` and returns ``0.0`` so the calling
    pipeline is never blocked.
    """
    model: str = usage.model  # type: ignore[attr-defined]
    rates = _resolve_rates(model)
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
    cache_creation_tokens: int = getattr(usage, "cache_creation_tokens", 0)

    return (
        input_tokens * rates.input
        + output_tokens * rates.output
        + cache_tokens * rates.cache
        + cache_creation_tokens * rates.cache_write
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

    rates = _resolve_rates(model)
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
