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
    3. If *model* carries an AI-gateway provider prefix, strip it and re-run
       steps 1–2 (e.g. ``anthropic/claude-sonnet-5`` → ``claude-sonnet-5``,
       ``z-ai/glm-5.2`` → ``glm-5.2``).
    4. If the (possibly stripped) id versions with dots the way OpenRouter
       renders Anthropic slugs, swap dots for dashes and re-run steps 1–2
       (e.g. ``claude-opus-4.8`` → ``claude-opus-4-8``).

    Returns ``None`` when neither resolves — the caller then warns + returns 0.
    """
    rates = _exact_or_dated(model)
    if rates is not None:
        return rates
    # 3. AI-gateway slugs carry a provider prefix the canonical table never
    #    keys on (OpenRouter: "anthropic/claude-sonnet-5", "z-ai/glm-5.2").
    #    Strip everything up to the last "/" and retry — without this, every
    #    hosted-fleet run priced as $0 (a silent cost-metering false green).
    if "/" in model:
        stripped = model.rsplit("/", 1)[1]
        rates = _exact_or_dated(stripped)
        if rates is not None:
            return rates
        model = stripped
    # 4. OpenRouter versions Anthropic slugs with dots ("claude-opus-4.8")
    #    while the canonical table uses dashes ("claude-opus-4-8").
    dashed = model.replace(".", "-")
    if dashed != model:
        return _exact_or_dated(dashed)
    return None


def _exact_or_dated(model: str) -> Optional[_Rates]:
    """Steps 1–2 of the chain: exact key, then trailing-date-snapshot strip."""
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


def cost_breakdown(usage: object, *, rerank_usd: float = 0.0) -> Dict[str, float]:
    """Return the per-component dollar decomposition of *usage*.

    Splits the single ``cost_usd`` scalar into the priced components so a report
    can show WHERE the dollars go (input vs output vs cache-read vs cache-write),
    not just the total, plus the per-layer spend lines:

    - ``input_usd``       — ``input_tokens`` at the input rate
    - ``output_usd``      — ``output_tokens`` at the output rate
    - ``cache_read_usd``  — ``cache_tokens`` at the (cheaper) cache-read rate
    - ``cache_write_usd`` — ``cache_creation_tokens`` at the cache-write rate
    - ``expansion_usd``   — the deterministic recall/expansion layer (#1043:
                            query-token expansion + symbol-level candidates).
                            It makes NO model call and consumes NO tokens, so its
                            spend is auditably a fixed ``0.0`` — surfaced as its
                            own line precisely so a report can SHOW the layer cost
                            nothing rather than leave it invisible (AC3).
    - ``rerank_usd``      — the LLM listwise rerank layer (#1044 AC3). UNLIKE
                            ``expansion_usd`` this is a REAL model-call cost: the
                            Haiku rerank's own token spend, already priced by
                            ``agentrail.context.llm_rerank.llm_rerank_cost_usd``
                            and surfaced on the pack as ``rerankCostUsd``. The
                            caller passes that pack value in via the *rerank_usd*
                            keyword; it defaults to ``0.0`` so every existing
                            caller (no rerank cost) is byte-identical to before.
    - ``total_usd``       — the sum of all components. With the default
                            ``rerank_usd=0.0`` this equals ``cost_usd(usage)``
                            exactly; when a real rerank cost is supplied the total
                            is the agent's token cost PLUS the rerank layer's
                            spend (the rerank tokens are not part of ``usage``).

    Uses the SAME ``_resolve_rates`` + ``/1_000_000`` math as ``cost_usd`` for the
    token components, so with no rerank cost the components sum to ``cost_usd``
    exactly (parity invariant). The components ALWAYS sum to ``total_usd``
    (components-sum-to-total parity), rerank cost included. Unknown model →
    mirrors ``cost_usd``: emits ``UserWarning`` and zeroes the token components,
    but still surfaces the supplied ``rerank_usd`` (it is independently priced and
    does not need the agent model's rate table) so the calling pipeline is never
    blocked and the rerank line stays honest.
    """
    rerank_component = float(rerank_usd)
    model: str = usage.model  # type: ignore[attr-defined]
    rates = _resolve_rates(model)
    if rates is None:
        warnings.warn(
            f"pricing: unknown model {model!r} — cost_breakdown returning zeros",
            UserWarning,
            stacklevel=2,
        )
        return {
            "input_usd": 0.0,
            "output_usd": 0.0,
            "cache_read_usd": 0.0,
            "cache_write_usd": 0.0,
            "expansion_usd": 0.0,
            "rerank_usd": rerank_component,
            "total_usd": rerank_component,
        }

    input_tokens: int = usage.input_tokens    # type: ignore[attr-defined]
    output_tokens: int = usage.output_tokens  # type: ignore[attr-defined]
    cache_tokens: int = usage.cache_tokens    # type: ignore[attr-defined]
    cache_creation_tokens: int = getattr(usage, "cache_creation_tokens", 0)

    input_usd = input_tokens * rates.input / 1_000_000
    output_usd = output_tokens * rates.output / 1_000_000
    cache_read_usd = cache_tokens * rates.cache / 1_000_000
    cache_write_usd = cache_creation_tokens * rates.cache_write / 1_000_000
    # Deterministic recall/expansion layer (#1043): no model call, no tokens →
    # a fixed 0.0 that keeps the components-sum-to-total parity exact.
    expansion_usd = 0.0

    return {
        "input_usd": input_usd,
        "output_usd": output_usd,
        "cache_read_usd": cache_read_usd,
        "cache_write_usd": cache_write_usd,
        "expansion_usd": expansion_usd,
        "rerank_usd": rerank_component,
        "total_usd": (
            input_usd
            + output_usd
            + cache_read_usd
            + cache_write_usd
            + expansion_usd
            + rerank_component
        ),
    }


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
