"""Cost-aware model routing: identify cheaper same-family models.

Given a Usage record and a phase name, computes whether a cheaper model in
the same provider family could have run the same token budget at lower cost,
and by how much (overspend_usd).

Ladders (expensive → cheap):
  claude: fable-5 → opus → sonnet → haiku
  gpt:    gpt-5/o3 → gpt-4o → gpt-4o-mini/o4-mini

Only same-family, next-tier-down recommendations are made. No cross-family
recommendations (Claude ↔ GPT).
"""
from __future__ import annotations

import json
import warnings
from pathlib import Path
from typing import Optional, Tuple

from agentrail.run.pricing import PRICES

# ---------------------------------------------------------------------------
# Family ladders: list of (tier_keyword, canonical_model) ordered expensive → cheap.
# canonical_model is the representative for that tier; it MUST exist in PRICES.
# ---------------------------------------------------------------------------
_CLAUDE_LADDER: list[Tuple[str, str]] = [
    ("fable",  "claude-fable-5"),
    ("opus",   "claude-opus-4-8"),
    ("sonnet", "claude-sonnet-4-6"),
    ("haiku",  "claude-haiku-4-5"),
]

_GPT_LADDER: list[Tuple[str, str]] = [
    ("gpt-top",   "gpt-5"),
    ("gpt-mid",   "gpt-4o"),
    ("gpt-cheap", "gpt-4o-mini"),
]

_LADDERS: dict[str, list[Tuple[str, str]]] = {
    "claude": _CLAUDE_LADDER,
    "gpt":    _GPT_LADDER,
}


def _classify_claude(model: str) -> Optional[int]:
    """Return tier index (0=fable, 1=opus, 2=sonnet, 3=haiku) or None."""
    m = model.lower()
    if "fable" in m:
        return 0
    if "opus" in m:
        return 1
    if "sonnet" in m:
        return 2
    if "haiku" in m:
        return 3
    return None


def _classify_gpt(model: str) -> Optional[int]:
    """Return tier index (0=top, 1=mid, 2=cheap) or None.

    gpt-4o-mini must be checked before gpt-4o to avoid prefix collision.
    """
    m = model.lower()
    if "gpt-4o-mini" in m or "o4-mini" in m:
        return 2
    if "gpt-4o" in m:
        return 1
    if "gpt-5" in m or m == "o3" or m.startswith("o3-"):
        return 0
    return None


def classify(model: str) -> Optional[Tuple[str, int]]:
    """Return (family, tier_index) for *model*, or None if unclassifiable.

    family is ``'claude'`` or ``'gpt'``; tier_index 0 = most expensive.
    """
    if not model:
        return None
    m = model.lower()
    if any(kw in m for kw in ("fable", "claude", "opus", "sonnet", "haiku")):
        tier = _classify_claude(model)
        if tier is not None:
            return ("claude", tier)
    if any(kw in m for kw in ("gpt", "o3", "o4")):
        tier = _classify_gpt(model)
        if tier is not None:
            return ("gpt", tier)
    return None


def cheaper_model(model: str) -> Optional[str]:
    """Return the canonical model for the next-cheaper tier, or None.

    Returns None when *model* is already the cheapest in its family, when it
    cannot be classified, or when it is unknown.
    """
    result = classify(model)
    if result is None:
        return None
    family, tier = result
    ladder = _LADDERS[family]
    next_tier = tier + 1
    if next_tier >= len(ladder):
        return None
    return ladder[next_tier][1]


def cost_for_model(
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_tokens: int,
) -> float:
    """Reprice a token breakdown at *model*'s rates.

    Returns 0.0 and emits a UserWarning when the model is not in PRICES.
    """
    rates = PRICES.get(model)
    if rates is None:
        warnings.warn(
            f"routing: unknown model {model!r} — cannot reprice",
            UserWarning,
            stacklevel=2,
        )
        return 0.0
    return (
        input_tokens  * rates.input
        + output_tokens * rates.output
        + cache_tokens  * rates.cache
    ) / 1_000_000


def routing_record(usage: object, phase: str = "execute") -> Optional[dict]:
    """Build a model_routing dict for *usage* or return None.

    Returns None when:
    - the used model is not in PRICES (emits UserWarning naming the model)
    - no cheaper same-family model exists (model already cheapest)
    - overspend_usd <= 0

    Returned dict keys: phase, model_used, cheaper_model, tokens,
    cost_used_usd, cost_cheaper_usd, overspend_usd.
    """
    model: str = getattr(usage, "model", "")
    input_tokens: int = getattr(usage, "input_tokens", 0)
    output_tokens: int = getattr(usage, "output_tokens", 0)
    cache_tokens: int = getattr(usage, "cache_tokens", 0)

    if not model:
        warnings.warn(
            "routing: empty model name — no routing recommendation",
            UserWarning,
            stacklevel=2,
        )
        return None

    if model not in PRICES:
        warnings.warn(
            f"routing: unknown model {model!r} — no routing recommendation",
            UserWarning,
            stacklevel=2,
        )
        return None

    alt = cheaper_model(model)
    if alt is None:
        return None  # already cheapest in its family

    if alt not in PRICES:
        warnings.warn(
            f"routing: cheaper model {alt!r} not in PRICES — skipping recommendation",
            UserWarning,
            stacklevel=2,
        )
        return None

    cost_used = cost_for_model(model, input_tokens, output_tokens, cache_tokens)
    cost_alt  = cost_for_model(alt,   input_tokens, output_tokens, cache_tokens)
    overspend = cost_used - cost_alt

    if overspend <= 0:
        return None

    return {
        "phase":            phase,
        "model_used":       model,
        "cheaper_model":    alt,
        "tokens":           input_tokens + output_tokens + cache_tokens,
        "cost_used_usd":    round(cost_used, 8),
        "cost_cheaper_usd": round(cost_alt,  8),
        "overspend_usd":    round(overspend, 8),
    }


def _apply_routing(rec: dict, target: Path, agent: str) -> bool:
    """Write runners.<agent>.models.<phase> = cheaper_model to .agentrail/config.json.

    Idempotent: no-op when the configured model is already the cheaper model
    or a cheaper tier in the same family. Returns True if updated, False if
    already at that model or cheaper.
    """
    phase = rec["phase"]
    rec_model = rec["cheaper_model"]

    config_path = target / ".agentrail" / "config.json"
    cfg: dict = {}
    if config_path.exists():
        try:
            cfg = json.loads(config_path.read_text())
        except (ValueError, OSError):
            cfg = {}

    runners = cfg.setdefault("runners", {})
    runner_cfg = runners.setdefault(agent, {})
    models_map = runner_cfg.setdefault("models", {})
    current = models_map.get(phase, "")

    if current:
        rec_cls = classify(rec_model)
        cur_cls = classify(current)
        if rec_cls and cur_cls and cur_cls[0] == rec_cls[0]:
            # Same family: if current is at same tier or cheaper tier, no-op.
            if cur_cls[1] >= rec_cls[1]:
                return False
        elif current == rec_model:
            return False

    models_map[phase] = rec_model
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps(cfg, indent=2))
    return True
