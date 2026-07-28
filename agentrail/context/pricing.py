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

import re
from typing import Optional, TypedDict

# ---------------------------------------------------------------------------
# Price table  (all values in $/Mtok)
# ---------------------------------------------------------------------------

class _Rates(TypedDict):
    input: float
    output: float
    cached_read: float
    cached_write: float



# ---------------------------------------------------------------------------
# Canonical price table — SINGLE source of truth for all dollar math (#715).
# Rates verified against https://platform.claude.com/docs/.../pricing (2026-06).
# Claude: cached_read = 0.1x input, 5m cached_write = 1.25x input.
# run/pricing.py derives its PRICES view from this table — do not add a second table.
# ---------------------------------------------------------------------------

PRICE_TABLE: dict[str, _Rates] = {
    'claude-3-5-haiku-20241022': {"input": 0.8, "output": 4.0, "cached_read": 0.08, "cached_write": 1.0},
    'claude-3-5-sonnet-20241022': {"input": 3.0, "output": 15.0, "cached_read": 0.3, "cached_write": 3.75},
    'claude-3-opus-20240229': {"input": 15.0, "output": 75.0, "cached_read": 1.5, "cached_write": 18.75},
    'claude-fable-5': {"input": 10.0, "output": 50.0, "cached_read": 1.0, "cached_write": 12.5},
    'claude-haiku-3-5': {"input": 0.8, "output": 4.0, "cached_read": 0.08, "cached_write": 1.0},
    'claude-haiku-4-5': {"input": 1.0, "output": 5.0, "cached_read": 0.1, "cached_write": 1.25},
    'claude-haiku-4-5-20251001': {"input": 1.0, "output": 5.0, "cached_read": 0.1, "cached_write": 1.25},
    'claude-opus-3-5': {"input": 15.0, "output": 75.0, "cached_read": 1.5, "cached_write": 18.75},
    'claude-opus-4': {"input": 15.0, "output": 75.0, "cached_read": 1.5, "cached_write": 18.75},
    'claude-opus-4-5': {"input": 5.0, "output": 25.0, "cached_read": 0.5, "cached_write": 6.25},
    'claude-opus-4-6': {"input": 5.0, "output": 25.0, "cached_read": 0.5, "cached_write": 6.25},
    'claude-opus-4-7': {"input": 5.0, "output": 25.0, "cached_read": 0.5, "cached_write": 6.25},
    'claude-opus-4-8': {"input": 5.0, "output": 25.0, "cached_read": 0.5, "cached_write": 6.25},
    'claude-sonnet-3-5': {"input": 3.0, "output": 15.0, "cached_read": 0.3, "cached_write": 3.75},
    'claude-sonnet-3-7': {"input": 3.0, "output": 15.0, "cached_read": 0.3, "cached_write": 3.75},
    'claude-sonnet-4-5': {"input": 3.0, "output": 15.0, "cached_read": 0.3, "cached_write": 3.75},
    'claude-sonnet-4-6': {"input": 3.0, "output": 15.0, "cached_read": 0.3, "cached_write": 3.75},
    # Claude Sonnet 5 — sticker rates ($3/$15 per MTok). OpenRouter bills an
    # introductory $2/$10 through 2026-08-31; we deliberately price at sticker so
    # ledgers never silently understate spend when the promo lapses (small,
    # conservative overstatement until then).
    'claude-sonnet-5': {"input": 3.0, "output": 15.0, "cached_read": 0.3, "cached_write": 3.75},
    'codex-mini-latest': {"input": 1.5, "output": 6.0, "cached_read": 0.375, "cached_write": 1.5},
    'cursor/claude-opus-4-6': {"input": 5.0, "output": 25.0, "cached_read": 0.5, "cached_write": 6.25},
    'cursor/claude-sonnet-4-5': {"input": 3.0, "output": 15.0, "cached_read": 0.3, "cached_write": 3.75},
    'cursor/gpt-4.1': {"input": 2.0, "output": 8.0, "cached_read": 0.5, "cached_write": 2.0},
    'cursor/gpt-4o': {"input": 2.5, "output": 10.0, "cached_read": 1.25, "cached_write": 2.5},
    # GLM 5.2 (the hosted fleet's verify seat, reached as z-ai/glm-5.2 via
    # OpenRouter). OpenRouter's balanced routing lists ~$0.2982/$0.9372 per MTok
    # and rates vary by upstream provider (Z.ai direct is $1.40/$4.40) — these
    # are approximations, rounded up. cached_read assumes ~75% off (automatic
    # caching); cached_write = input (no write premium on automatic-cache models).
    'glm-5.2': {"input": 0.30, "output": 0.94, "cached_read": 0.075, "cached_write": 0.30},
    'gpt-4.1': {"input": 2.0, "output": 8.0, "cached_read": 0.5, "cached_write": 2.0},
    'gpt-4.1-mini': {"input": 0.4, "output": 1.6, "cached_read": 0.1, "cached_write": 0.4},
    'gpt-4.1-nano': {"input": 0.1, "output": 0.4, "cached_read": 0.025, "cached_write": 0.1},
    'gpt-4o': {"input": 2.5, "output": 10.0, "cached_read": 1.25, "cached_write": 2.5},
    'gpt-4o-mini': {"input": 0.15, "output": 0.6, "cached_read": 0.075, "cached_write": 0.15},
    'gpt-5': {"input": 10.0, "output": 40.0, "cached_read": 2.5, "cached_write": 10.0},
    'gpt-5-codex': {"input": 15.0, "output": 60.0, "cached_read": 3.75, "cached_write": 15.0},
    'gpt-5.5': {"input": 2.0, "output": 8.0, "cached_read": 1.0, "cached_write": 2.0},
    'o3': {"input": 10.0, "output": 40.0, "cached_read": 2.5, "cached_write": 10.0},
    'o4-mini': {"input": 1.1, "output": 4.4, "cached_read": 0.275, "cached_write": 1.1},
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
# Model-id resolution — the ONE chain, for every caller of this table
# ---------------------------------------------------------------------------
# Real callers do not report the bare aliases PRICE_TABLE keys on. They report
# whatever their provider calls the model:
#
#   claude (direct)  claude-sonnet-4-5-20250929   dated snapshot
#   OpenRouter       anthropic/claude-haiku-4.5   provider prefix + dotted version
#   OpenRouter       z-ai/glm-5.2                 provider prefix + dotted version
#
# A bare ``PRICE_TABLE.get(model)`` misses all three, and a miss is not loud:
# ``cost_for`` returns the chars/4 fallback with ``estimate=True``, and callers
# that (correctly) refuse to bill a real gateway call at an invented
# sonnet-class rate then record $0 instead. That is how 23 production wiki
# compiles of ``anthropic/claude-haiku-4.5`` — 1,431 prose pages of genuine
# spend — all landed in the ledger as $0.00, and how the wiki's own
# ``AGENTRAIL_WIKI_MAX_COST_USD`` ceiling never once engaged.
#
# ``resolve_rates`` is that missing chain, and it lives HERE, next to the table
# it resolves against, so every consumer of the canonical table gets it (#715's
# single-source-of-truth rule applied to the LOOKUP, not just the numbers).
# ``run/pricing.py``'s PRICE_TABLE tier delegates to this function rather than
# keeping a second copy.
#
# Normalization only ever WIDENS what an existing key matches — it never
# invents a rate. A model whose base alias is absent from the table stays
# unknown, and ``cost_for`` still flags it as an estimate.

_DATE_SUFFIX_RE = re.compile(r"-\d{8}$")


def _exact_or_dated(model: str) -> Optional[_Rates]:
    """Exact key, then the same key with a trailing ``-YYYYMMDD`` stripped."""
    rates = PRICE_TABLE.get(model)
    if rates is not None:
        return rates
    base = _DATE_SUFFIX_RE.sub("", model)
    if base != model:
        return PRICE_TABLE.get(base)
    return None


def resolve_rates(model: str) -> Optional[_Rates]:
    """Return the canonical ``_Rates`` for *model*, or ``None`` if unpriced.

    Resolution order (each step re-runs the exact/dated lookup):

    1. exact match (``claude-haiku-4-5``);
    2. trailing date snapshot stripped (``claude-sonnet-4-5-20250929``);
    3. AI-gateway provider prefix stripped (``anthropic/claude-sonnet-5``,
       ``z-ai/glm-5.2``) — note ``cursor/…`` keys are IN the table verbatim and
       so are caught by step 1 before any stripping happens;
    4. dotted version numbers swapped for dashes, the way OpenRouter renders
       Anthropic slugs (``claude-haiku-4.5`` → ``claude-haiku-4-5``).

    Never raises; a non-string *model* resolves to ``None``.
    """
    if not isinstance(model, str) or not model:
        return None

    rates = _exact_or_dated(model)
    if rates is not None:
        return rates

    if "/" in model:
        stripped = model.rsplit("/", 1)[1]
        rates = _exact_or_dated(stripped)
        if rates is not None:
            return rates
        model = stripped

    dashed = model.replace(".", "-")
    if dashed != model:
        return _exact_or_dated(dashed)
    return None


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
        Model identifier. Accepts the bare table alias (``"claude-sonnet-4-5"``,
        ``"gpt-4o"``) as well as the dated and AI-gateway forms real providers
        report (``"claude-sonnet-4-5-20250929"``, ``"anthropic/claude-haiku-4.5"``)
        — see :func:`resolve_rates`.
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
        ``model``        – the model string passed in, verbatim (resolution is a
                           lookup detail; the caller's own id is never rewritten)
        ``dollars``      – total USD cost (float)
        ``rates``        – the four per-Mtok rates used
        ``estimate``     – True when the model is unknown
        ``estimator``    – ``"chars/4"`` when ``estimate`` is True, else None
    """
    rates = resolve_rates(model)
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
