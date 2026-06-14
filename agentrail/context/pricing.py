"""Provider price table and model-aware costing function.

All dollar math for M022-M025 routes through ``cost_for``.

Rates are in **USD per million tokens ($/Mtok)** as published by each provider.
Table last verified: 2026-06-15.

Sources:
  Anthropic  — https://www.anthropic.com/pricing
  OpenAI     — https://openai.com/api/pricing/
  Cursor     — subscription add-on; priced at the underlying model rate

Each entry has four keys:
  input        – regular prompt tokens
  output       – completion tokens (typically 5× input rate)
  cached_read  – prompt-cache hit (reads cached prefix)
  cached_write – prompt-cache write (storing a new prefix)
"""
from __future__ import annotations

from typing import TypedDict

# ---------------------------------------------------------------------------
# Price table  (all values in $/Mtok)
# ---------------------------------------------------------------------------

class _Rates(TypedDict):
    input: float
    output: float
    cached_read: float
    cached_write: float


PRICE_TABLE: dict[str, _Rates] = {
    # -----------------------------------------------------------------------
    # Anthropic  (claude-* models)
    # -----------------------------------------------------------------------
    # Claude Opus 4 / 4.6
    "claude-opus-4-6": {
        "input":        15.00,
        "output":       75.00,
        "cached_read":   1.50,
        "cached_write": 18.75,
    },
    # Claude Opus 4 (alias)
    "claude-opus-4": {
        "input":        15.00,
        "output":       75.00,
        "cached_read":   1.50,
        "cached_write": 18.75,
    },
    # Claude Sonnet 4.5 / 4.6
    "claude-sonnet-4-5": {
        "input":         3.00,
        "output":        15.00,
        "cached_read":   0.30,
        "cached_write":  3.75,
    },
    "claude-sonnet-4-6": {
        "input":         3.00,
        "output":        15.00,
        "cached_read":   0.30,
        "cached_write":  3.75,
    },
    # Claude Haiku 4.5
    "claude-haiku-4-5": {
        "input":         0.80,
        "output":         4.00,
        "cached_read":   0.08,
        "cached_write":  1.00,
    },
    # Older Anthropic model aliases still seen in the wild
    "claude-3-5-sonnet-20241022": {
        "input":         3.00,
        "output":        15.00,
        "cached_read":   0.30,
        "cached_write":  3.75,
    },
    "claude-3-5-haiku-20241022": {
        "input":         0.80,
        "output":         4.00,
        "cached_read":   0.08,
        "cached_write":  1.00,
    },
    "claude-3-opus-20240229": {
        "input":        15.00,
        "output":       75.00,
        "cached_read":   1.50,
        "cached_write": 18.75,
    },

    # -----------------------------------------------------------------------
    # OpenAI / Codex
    # -----------------------------------------------------------------------
    "gpt-4o": {
        "input":         2.50,
        "output":        10.00,
        "cached_read":   1.25,
        "cached_write":  2.50,
    },
    "gpt-4o-mini": {
        "input":         0.15,
        "output":         0.60,
        "cached_read":   0.075,
        "cached_write":  0.15,
    },
    # GPT-4.1 family (released 2025)
    "gpt-4.1": {
        "input":         2.00,
        "output":         8.00,
        "cached_read":   0.50,
        "cached_write":  2.00,
    },
    "gpt-4.1-mini": {
        "input":         0.40,
        "output":         1.60,
        "cached_read":   0.10,
        "cached_write":  0.40,
    },
    "gpt-4.1-nano": {
        "input":         0.10,
        "output":         0.40,
        "cached_read":   0.025,
        "cached_write":  0.10,
    },
    # o-series reasoning models
    "o3": {
        "input":        10.00,
        "output":       40.00,
        "cached_read":   2.50,
        "cached_write": 10.00,
    },
    "o4-mini": {
        "input":         1.10,
        "output":         4.40,
        "cached_read":   0.275,
        "cached_write":  1.10,
    },
    # Codex CLI default model
    "codex-mini-latest": {
        "input":         1.50,
        "output":         6.00,
        "cached_read":   0.375,
        "cached_write":  1.50,
    },

    # -----------------------------------------------------------------------
    # Cursor  (proxied models; priced at the underlying model rate)
    # Note: Cursor bills via subscription tiers for most usage.  These rates
    # reflect the cost of the underlying model that Cursor routes to and are
    # used here for cost-estimation purposes only.
    # -----------------------------------------------------------------------
    "cursor/claude-sonnet-4-5": {
        "input":         3.00,
        "output":        15.00,
        "cached_read":   0.30,
        "cached_write":  3.75,
    },
    "cursor/claude-opus-4-6": {
        "input":        15.00,
        "output":       75.00,
        "cached_read":   1.50,
        "cached_write": 18.75,
    },
    "cursor/gpt-4o": {
        "input":         2.50,
        "output":        10.00,
        "cached_read":   1.25,
        "cached_write":  2.50,
    },
    "cursor/gpt-4.1": {
        "input":         2.00,
        "output":         8.00,
        "cached_read":   0.50,
        "cached_write":  2.00,
    },
}

# ---------------------------------------------------------------------------
# Fallback (chars/4 estimator)
# ---------------------------------------------------------------------------
# When neither the model nor a tokenizer are available, callers may pass
# token counts derived from ``len(text) // 4``.  We flag the result so
# consumers know the cost is approximate.
_FALLBACK_RATE: _Rates = {
    "input":        3.00,   # sonnet-class rate as a neutral fallback
    "output":       15.00,
    "cached_read":   0.30,
    "cached_write":  3.75,
}

_MTOK = 1_000_000.0


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def cost_for(
    model: str,
    *,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cached_read: int = 0,
    cached_write: int = 0,
) -> dict:
    """Return a structured cost payload for the given token counts.

    Parameters
    ----------
    model:
        Model identifier (e.g. ``"claude-sonnet-4-5"``, ``"gpt-4o"``).
    input_tokens:
        Regular (non-cached) prompt tokens.
    output_tokens:
        Completion tokens.
    cached_read:
        Prompt-cache hit tokens (reading a stored prefix).
    cached_write:
        Prompt-cache write tokens (storing a new prefix).

    Returns
    -------
    dict with keys:
        ``model``        – the model string passed in
        ``dollars``      – total USD cost (float)
        ``rates``        – the four per-Mtok rates used
        ``estimate``     – True when the model is unknown
        ``estimator``    – ``"chars/4"`` when ``estimate`` is True, else None
    """
    rates = PRICE_TABLE.get(model)
    is_estimate = rates is None
    if is_estimate:
        rates = _FALLBACK_RATE

    dollars = (
        input_tokens  * rates["input"]        / _MTOK
        + output_tokens * rates["output"]       / _MTOK
        + cached_read   * rates["cached_read"]  / _MTOK
        + cached_write  * rates["cached_write"] / _MTOK
    )

    return {
        "model": model,
        "dollars": dollars,
        "rates": {
            "input":        rates["input"],
            "output":       rates["output"],
            "cached_read":  rates["cached_read"],
            "cached_write": rates["cached_write"],
        },
        "estimate":  is_estimate,
        "estimator": "chars/4" if is_estimate else None,
    }
