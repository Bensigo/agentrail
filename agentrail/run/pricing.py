"""Per-model pricing table and cost computation.

PRICES is the single source of truth for PRICE_TABLE-derived token rates.
Rates are in USD per million tokens ($/MTok). Each entry has three fields:
input, output, cache.

Cache rate covers input-cache-read tokens uniformly (per PRD #451 §2).

Pricing is resolved gateway-first as of #1337 PR ② — see ``_resolve_rates``'s
own docstring below for the two-tier (gateway snapshot, then PRICE_TABLE)
resolution order and ``PriceSource`` for the recorded-source vocabulary.
"""
from __future__ import annotations

import json
import re
import warnings
from pathlib import Path
from typing import Any, Dict, Literal, NamedTuple, Optional, Tuple, Union

from agentrail.context.pricing import PRICE_TABLE as _PRICE_TABLE


class _Rates(NamedTuple):
    input: float        # $/MTok
    output: float       # $/MTok
    cache: float        # $/MTok  (cache-READ rate, canonical ``cached_read``)
    cache_write: float  # $/MTok  (cache-WRITE rate, canonical ``cached_write``)


# ---------------------------------------------------------------------------
# Price source vocabulary (#1337 PR ②), shared with the TypeScript resolver
# (``apps/console/lib/alignment/resolve-price.ts``): ``"gateway"`` = the
# committed OpenRouter snapshot had this model; ``"price_table"`` = the
# canonical ``PRICE_TABLE`` resolution chain had it instead. ``"fallback"``
# is NOT produced by ``_resolve_rates`` below — it names
# ``agentrail.context.pricing.cost_for``'s pre-existing, separate
# ``_FALLBACK_RATE`` neutral-rate mechanism (a different function, for
# context-pack/rerank cost estimation, not run-cost metering — out of scope
# for this PR). The value stays in the union for parity with that mechanism
# and with the TypeScript side, not because this module ever emits it.
# ---------------------------------------------------------------------------
PriceSource = Literal["gateway", "price_table", "fallback"]


class _ResolvedRates(NamedTuple):
    rates: _Rates
    source: PriceSource


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
# Gateway snapshot (#1337 PR ②) — the committed OpenRouter model-catalog
# snapshot. It is hand-mirrored into TWO byte-identical committed copies, the
# same cross-language drift-guard convention #1334/#1335 use for PRICE_TABLE:
#
#   - ``agentrail/context/openrouter-catalog.snapshot.json`` — THIS module's
#     source (a package-local file under the ``agentrail`` package, so it
#     ships inside the runner/fleet image automatically: the Docker images
#     ``COPY agentrail ./agentrail`` and ``pip install .`` it, and
#     pyproject.toml's ``[tool.setuptools.package-data]`` lists this exact
#     file so it lands in site-packages — NOT stripped by the images'
#     ``rm -rf ./agentrail/tests ./agentrail/docker``. NEITHER image ships
#     ``apps/console/``, which is why the Python side canNOT read the console
#     copy below.)
#   - ``apps/console/lib/alignment/openrouter-catalog.snapshot.json`` — the
#     console's own copy, read by ``gateway-catalog.ts`` via a bundler JSON
#     import; ships in the console image (``apps/console`` + ``packages/*``),
#     which conversely does NOT ship the ``agentrail`` package.
#
# The refresh script (``apps/console/scripts/refresh-openrouter-catalog.ts``)
# writes BOTH; ``test_gateway_snapshot_parity`` asserts they stay
# byte-identical so drift fails CI. The two images have DISJOINT file sets,
# so one path cannot serve both — hence the mirror rather than a single
# shared file.
#
# Loaded ONCE at import time and cached in ``_GATEWAY_RATES`` — a plain
# local-disk read, not a network call (no live fetch on any request hot
# path; the file itself is refreshed offline, see the TS script's module
# doc). A missing/unreadable/malformed file still degrades to an EMPTY
# gateway table rather than raising (resolution then falls through to
# PRICE_TABLE-only, exactly as before #1337) — a defensive backstop, no
# longer the expected deployed state now that the package-local copy ships.
# ---------------------------------------------------------------------------
_SNAPSHOT_PATH = (
    Path(__file__).resolve().parents[1] / "context" / "openrouter-catalog.snapshot.json"
)


def _load_gateway_snapshot(path: Path) -> Dict[str, Tuple[float, float]]:
    """Read the committed OpenRouter snapshot into a ``slug -> (input, output)``
    $/MTok map. Never raises — see the module-level note above for why a
    missing file is an expected, gracefully-handled case, not an error.
    """
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}

    models = raw.get("models") if isinstance(raw, dict) else None
    if not isinstance(models, list):
        return {}

    rates: Dict[str, Tuple[float, float]] = {}
    for entry in models:
        if not isinstance(entry, dict):
            continue
        slug = entry.get("id")
        in_rate = entry.get("inUsdPerMTok")
        out_rate = entry.get("outUsdPerMTok")
        if isinstance(slug, str) and isinstance(in_rate, (int, float)) and isinstance(out_rate, (int, float)):
            rates[slug] = (float(in_rate), float(out_rate))
    return rates


_GATEWAY_RATES: Dict[str, Tuple[float, float]] = _load_gateway_snapshot(_SNAPSHOT_PATH)


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


def _resolve_rates(model: str) -> Optional[_ResolvedRates]:
    """Return the resolved rates + which tier produced them, for *model*
    (#1337 PR ②: gateway-first).

    Resolution order:

    1. GATEWAY — exact match against the committed OpenRouter snapshot
       (``_GATEWAY_RATES``). The snapshot's keys are already full, dot-form,
       provider-prefixed OpenRouter slugs (e.g. ``"anthropic/claude-sonnet-5"``,
       ``"z-ai/glm-5.2"``) — exactly the form a real hosted-fleet run's
       ``model`` string already takes, so no prefix-strip/dot-dash
       normalization is needed on this side. A bare id like
       ``"claude-sonnet-4-5"`` (a direct, non-gateway Anthropic API call)
       correctly misses here and falls through to tier 2.
    2. PRICE_TABLE — ``_resolve_price_table_rates``, the pre-#1337
       exact/dated/prefix/dot-dash normalization chain, unchanged.

    ``cache``/``cache_write`` ALWAYS prefer PRICE_TABLE's own rates when it
    has an entry for *model*, even when the gateway tier won input/output —
    the gateway snapshot carries no cache-rate fields (see
    ``openrouter-normalize.ts``'s field mapping), and every one of today's
    real gateway-priced hosted-fleet seats already has a PRICE_TABLE entry
    to borrow them from. Only when NEITHER tier has any entry for *model* do
    cache rates fall back to the same neutral 0.1x-input / 1.25x-input
    convention ``agentrail.context.pricing.cost_for``'s ``_FALLBACK_RATE``
    already documents for "no known cache behaviour" — not invented here:
    every Claude entry in PRICE_TABLE happens to use exactly that ratio.

    Returns ``None`` when NEITHER tier resolves *model* at all — the caller
    then warns and treats the model as fully unpriced, exactly as before
    this PR (no behaviour change on the fully-unknown path).
    """
    gateway_io = _GATEWAY_RATES.get(model)
    table_rates = _resolve_price_table_rates(model)

    if gateway_io is None and table_rates is None:
        return None

    source: PriceSource
    if gateway_io is not None:
        input_rate, output_rate = gateway_io
        source = "gateway"
    else:
        assert table_rates is not None  # narrows for type-checkers; guaranteed above
        input_rate, output_rate = table_rates.input, table_rates.output
        source = "price_table"

    if table_rates is not None:
        cache_rate, cache_write_rate = table_rates.cache, table_rates.cache_write
    else:
        cache_rate = round(input_rate * 0.1, 6)
        cache_write_rate = round(input_rate * 1.25, 6)

    return _ResolvedRates(
        rates=_Rates(input=input_rate, output=output_rate, cache=cache_rate, cache_write=cache_write_rate),
        source=source,
    )


def _resolve_price_table_rates(model: str) -> Optional[_Rates]:
    """Return the ``_Rates`` for *model* from ``PRICES``, tolerating a
    trailing ``-YYYYMMDD`` and an AI-gateway prefix (tier 2 of
    ``_resolve_rates`` above; this is the pre-#1337 resolution chain,
    unchanged, just renamed from the old top-level ``_resolve_rates``).

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

    Returns ``None`` when neither resolves.
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


def resolve_price_source(model: str) -> Optional[PriceSource]:
    """Return WHICH tier priced *model* — ``"gateway"`` | ``"price_table"`` —
    or ``None`` if neither did (#1337 PR ②).

    This is the same value ``cost_breakdown`` records as its ``price_source``
    key, exposed on its own so a caller that already holds the scalar
    ``cost_usd`` (the run pipeline's cost/budget block, which computes ``cost``
    from ``cost_usd(usage)`` and must not have that line perturbed) can stamp
    the price source onto its durable ledger record without recomputing the
    full breakdown dict. Determinism guarantees consistency: ``_resolve_rates``
    reads only the two module-level tables (``_GATEWAY_RATES``, ``PRICES``),
    neither of which changes at runtime, so this and the ``cost_usd`` call in
    the same block always agree on the tier.

    Non-fatal by contract: a non-string / unresolvable *model* yields ``None``
    rather than raising, so stamping the price source onto a ledger record can
    never break the run's cost/telemetry path (which is non-fatal end to end —
    mirrors ``cost_usd``'s own tolerance of unknown models).
    """
    if not isinstance(model, str):
        return None
    resolved = _resolve_rates(model)
    return resolved.source if resolved is not None else None


def cost_usd(usage: object) -> float:
    """Return cost in USD for *usage*.

    *usage* must expose ``.model``, ``.input_tokens``, ``.output_tokens``,
    and ``.cache_tokens`` attributes (compatible with the ``Usage`` dataclass
    from ``usage_capture.py``). The optional ``.cache_creation_tokens``
    attribute is priced at the cache-WRITE rate (defaults to 0 when absent).

    Unknown model → emits ``UserWarning`` and returns ``0.0`` so the calling
    pipeline is never blocked. Rates are resolved gateway-first (#1337 PR ②
    — see ``_resolve_rates``); callers that need to know WHICH tier priced
    this usage should call ``cost_breakdown`` instead, which surfaces
    ``price_source`` — ``cost_usd`` itself stays a bare ``float`` return, its
    existing contract, unchanged.
    """
    model: str = usage.model  # type: ignore[attr-defined]
    resolved = _resolve_rates(model)
    if resolved is None:
        warnings.warn(
            f"pricing: unknown model {model!r} — cost_usd returning 0.0",
            UserWarning,
            stacklevel=2,
        )
        return 0.0
    rates = resolved.rates

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


def cost_breakdown(usage: object, *, rerank_usd: float = 0.0) -> Dict[str, Any]:
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
    - ``price_source``    — (#1337 PR ②) which tier ``_resolve_rates`` resolved
                            this usage's rates from: ``"gateway"`` (the
                            committed OpenRouter snapshot) or ``"price_table"``
                            (the canonical PRICE_TABLE chain); ``None`` on the
                            unknown-model path below (nothing priced this usage,
                            so there is no source to record). This field is what
                            the run pipeline threads through ``build_cost_record``
                            into the durable cost-events ledger (local JSONL +
                            the ClickHouse ``cost_events.price_source`` column)
                            to make ledgers auditable per AC1 — the same value
                            is available standalone via ``resolve_price_source``
                            for callers that don't need the full breakdown.
                            (It is deliberately NOT forwarded into Langfuse
                            ``costDetails``, which must stay all-numeric — see
                            ``tracer.py``.)

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
    resolved = _resolve_rates(model)
    if resolved is None:
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
            "price_source": None,
        }
    rates = resolved.rates

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
        "price_source": resolved.source,
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

    resolved = _resolve_rates(model)
    if resolved is None:
        return {
            "cache_hit_rate": cache_hit_rate,
            "cached_usd_saved": "estimate unavailable",
            "baseline_uncached_usd": "estimate unavailable",
        }
    rates = resolved.rates

    cached_usd_saved = cache_tokens * (rates.input - rates.cache) / 1_000_000
    baseline_uncached_usd = (
        total_prompt_tokens * rates.input + output_tokens * rates.output
    ) / 1_000_000

    return {
        "cache_hit_rate": cache_hit_rate,
        "cached_usd_saved": cached_usd_saved,
        "baseline_uncached_usd": baseline_uncached_usd,
    }
