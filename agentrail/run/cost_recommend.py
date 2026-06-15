"""Cost-saving recommendation engine for ``agentrail cost --recommend``.

Reads a per-run cost record and emits a prioritised, quantified list of
cost-saving recommendations derived from three optimizer signal groups:

1. **Cache hit rate** (populated by M026 slice 1 / issue #704):
   Fields: ``cache_hit_rate`` (float 0-1), ``cache_eligible_tokens`` (int),
           ``model`` (str).

2. **Model routing overspend** (populated by M026 slice 4 / issue #707):
   Field: ``model_routing`` (list of phase dicts).
   Each dict: ``{phase, model_used, cheaper_model, overspend_usd}``.

3. **Pack cost vs budget** (populated by M026 slice 3 / issue #706):
   Fields: ``pack_cost_usd`` (float), ``budget_usd`` (float | None),
           ``items_dropped`` (int | None), ``pack_threshold_usd`` (float | None).

All dollar math routes through ``agentrail.run.pricing.PRICES``.

Until the feeder slices (#704, #706, #707) land, absent fields default to
``None``/empty, no recommendations fire, and ``recommend()`` returns ``[]``.
"""
from __future__ import annotations

from typing import Union

from agentrail.run.pricing import PRICES

# Sentinel value used in the JSON output (AC5) when a model is unknown.
ESTIMATE_UNAVAILABLE = "estimate unavailable"

# Type alias for a single recommendation dict.
Recommendation = dict


def _cache_recommendation(record: dict) -> Recommendation | None:
    """Fire when cache_hit_rate < 0.5 and cache_eligible_tokens is present."""
    cache_hit_rate = record.get("cache_hit_rate")
    if cache_hit_rate is None:
        return None
    if not isinstance(cache_hit_rate, (int, float)):
        return None
    if cache_hit_rate >= 0.5:
        return None

    eligible_tokens: int | None = record.get("cache_eligible_tokens")
    if not eligible_tokens:
        return None

    model: str = record.get("model", "")
    rates = PRICES.get(model)

    if rates is None:
        # AC5: unknown model — include rec but flag saving as unavailable
        action = (
            f"Enable prompt caching (set `cache_enabled: true`); "
            f"estimated saving unavailable for unknown model {model!r} — "
            f"{eligible_tokens:,} cache-eligible tokens at unknown rate."
        )
        return {
            "technique": "prompt_caching",
            "action": action,
            "estimated_saving_usd": ESTIMATE_UNAVAILABLE,
        }

    # Saving: eligible tokens priced at input rate minus the cheaper cache rate.
    saving_usd = eligible_tokens * (rates.input - rates.cache) / 1_000_000
    action = (
        f"Enable prompt caching (set `cache_enabled: true`); "
        f"estimated saving ~${saving_usd:.4f}/run based on {eligible_tokens:,} "
        f"cache-eligible tokens at {model} cache rate."
    )
    return {
        "technique": "prompt_caching",
        "action": action,
        "estimated_saving_usd": saving_usd,
    }


def _routing_recommendations(record: dict) -> list[Recommendation]:
    """Fire one rec per phase with overspend_usd > 0."""
    routing: list[dict] | None = record.get("model_routing")
    if not routing:
        return []

    recs: list[Recommendation] = []
    for phase_entry in routing:
        overspend = phase_entry.get("overspend_usd", 0.0)
        if not isinstance(overspend, (int, float)) or overspend <= 0:
            continue
        phase = phase_entry.get("phase", "unknown")
        model_used = phase_entry.get("model_used", "?")
        cheaper = phase_entry.get("cheaper_model", "?")
        action = (
            f"Downgrade {phase!r} from {model_used!r} to {cheaper!r}; "
            f"overspend was ${overspend:.4f} on this run "
            f"(use `agentrail cost --routing --apply` to apply)."
        )
        recs.append({
            "technique": "model_routing",
            "action": action,
            "estimated_saving_usd": overspend,
        })
    return recs


def _pack_recommendation(record: dict) -> Recommendation | None:
    """Fire when pack cost exceeds the configured budget or threshold."""
    pack_cost = record.get("pack_cost_usd")
    if pack_cost is None or not isinstance(pack_cost, (int, float)):
        return None

    budget = record.get("budget_usd")
    if budget is not None and isinstance(budget, (int, float)) and pack_cost > budget:
        saving = pack_cost - budget
        action = (
            f"Tighten context budget (set `contextBudgetUsd: {budget:.4f}` in config); "
            f"pack cost was ${pack_cost:.4f}, budget ${budget:.4f}."
        )
        return {
            "technique": "context_budget",
            "action": action,
            "estimated_saving_usd": saving,
        }

    # Alternative: items_dropped == 0 and pack cost exceeds threshold
    threshold = record.get("pack_threshold_usd")
    items_dropped = record.get("items_dropped")
    if (
        threshold is not None
        and isinstance(threshold, (int, float))
        and items_dropped == 0
        and pack_cost > threshold
    ):
        saving = pack_cost - threshold
        action = (
            f"Tighten context budget (set `contextBudgetUsd: {threshold:.4f}` in config); "
            f"pack cost was ${pack_cost:.4f}, threshold ${threshold:.4f}."
        )
        return {
            "technique": "context_budget",
            "action": action,
            "estimated_saving_usd": saving,
        }

    return None


def _sort_key(rec: Recommendation) -> tuple:
    """Float savings sort descending; 'estimate unavailable' sort last."""
    v = rec["estimated_saving_usd"]
    if isinstance(v, (int, float)):
        return (0, -v)
    return (1, 0)


def recommend(record: dict) -> list[Recommendation]:
    """Return a prioritised list of cost-saving recommendations for *record*.

    Returns an empty list when no signal fires a positive recommendation.
    Callers should emit ``"No cost-saving recommendations for this run."`` when
    the list is empty.

    Per-run cost record fields consumed (all optional; absent = no signal):
      - model (str)
      - cache_hit_rate (float 0-1)
      - cache_eligible_tokens (int)
      - model_routing (list[{phase, model_used, cheaper_model, overspend_usd}])
      - pack_cost_usd (float)
      - budget_usd (float)
      - items_dropped (int)
      - pack_threshold_usd (float)
    """
    recs: list[Recommendation] = []

    cache_rec = _cache_recommendation(record)
    if cache_rec is not None:
        recs.append(cache_rec)

    recs.extend(_routing_recommendations(record))

    pack_rec = _pack_recommendation(record)
    if pack_rec is not None:
        recs.append(pack_rec)

    # Keep only recs with a positive quantified saving or "estimate unavailable".
    # A saving of 0.0 is not actionable.
    def _is_positive(rec: Recommendation) -> bool:
        v = rec["estimated_saving_usd"]
        if isinstance(v, (int, float)):
            return v > 0
        return True  # "estimate unavailable" — include per AC5

    recs = [r for r in recs if _is_positive(r)]

    recs.sort(key=_sort_key)
    return recs
