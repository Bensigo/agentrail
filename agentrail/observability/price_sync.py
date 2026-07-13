"""Sync ``agentrail.context.pricing.PRICE_TABLE`` into Langfuse's Models API.

``agentrail langfuse sync-models`` is the CLI entrypoint (see
``agentrail/cli/commands/langfuse.py``); this module holds the pure sync
logic so it is independently testable against a monkeypatched
``LangfuseHTTP._request``.

PRICE_TABLE unit contract (read from agentrail/context/pricing.py — get this
wrong and every downstream Langfuse cost figure, and every Jace cost display
fed by it, is wrong):

    PRICE_TABLE: dict[str, _Rates] where _Rates has four float keys —
    ``input``, ``output``, ``cached_read``, ``cached_write`` — each in
    **USD per MILLION tokens ($/Mtok)**, per pricing.py's own docstring and
    its ``cost_for()`` division by ``_MTOK = 1_000_000.0``.

    Langfuse's Models API prices per SINGLE unit (``unit: "TOKENS"`` means
    price-per-token, not price-per-million-tokens). So syncing requires
    dividing every PRICE_TABLE rate by 1_000_000 — see ``_per_token_prices``.
    Example (hand-computed, also pinned in test_price_sync.py):
    'claude-sonnet-4-5' input=3.0 $/Mtok -> 3.0 / 1_000_000 = 0.000003 USD/token.

Step 1 PIN (2026-07-13, against https://langfuse.com/docs/api /
api.reference.langfuse.com, cross-checked against the pinned compose image
docker.io/langfuse/langfuse:3 == v3.212.0 per
agentrail/observability/docker-compose.langfuse.yml):

  * ``POST /api/public/models`` creates a model definition. Required fields:
    ``modelName`` (string), ``matchPattern`` (regex string). Optional:
    ``unit`` (e.g. "TOKENS"), ``startDate``, ``tokenizerId``,
    ``tokenizerConfig``, and pricing via EITHER the legacy
    ``inputPrice``/``outputPrice``/``totalPrice`` fields OR the modern
    ``pricingTiers`` / ``prices`` map. The API reference explicitly documents
    the legacy fields as still functional though deprecated: "Deprecated. Use
    'pricingTiers' instead. Price (USD) per input unit. Creates a default
    tier if pricingTiers not provided." We use the legacy ``inputPrice`` /
    ``outputPrice`` fields here — NOT the modern ``prices`` map — because a
    filed bug (langfuse/langfuse#7386, "POST /api/public/models does not
    persist 'prices' object as expected") documents the ``prices`` map
    silently dropping on create; the doc-confirmed legacy fields carry no
    such caveat. Consequence: only ``input``/``output`` rates are synced.
    ``cached_read``/``cached_write`` have no legacy-field equivalent and are
    NOT synced by this module (documented scope narrowing, not an oversight).
  * ``GET /api/public/models`` lists model definitions, paginated via
    ``page``/``limit`` query params, response shape
    ``{"data": [...], "meta": {"page", "limit", "totalItems", "totalPages"}}``.
  * There is no documented upsert endpoint and no documented delete endpoint.
    Idempotency is therefore CLIENT-SIDE: GET all existing definitions,
    compare by ``modelName`` + price, and POST a new definition only when one
    is missing or its price has drifted from PRICE_TABLE.
  * Multiple model definitions can exist for the same ``modelName``. Per the
    API reference's own field doc on ``modelName``: "If multiple with the
    same name exist, they are applied in the following order: (1) custom
    over built-in, (2) newest according to startTime where
    model.startTime<observation.startTime." So POSTing a corrected price
    under an unchanged ``modelName`` creates a NEWER definition that wins by
    ``startTime`` resolution for any generation observed after it — no
    explicit delete of the stale definition is needed or possible via this
    API. This module still reports the pre-existing (now-superseded)
    definition's name under ``"stale"`` in its return value so operators can
    see that a drift happened, but it takes no delete action (none exists).

sync_models() return contract: ``{"created": [names], "unchanged": [names],
"stale": [names]}`` where every name is a PRICE_TABLE key (not a Langfuse
record id). A price-drift model name appears in BOTH ``created`` (the new
definition was POSTed) and ``stale`` (the old definition it supersedes).
"""
from __future__ import annotations

import math
import re
from typing import Dict, List

from agentrail.context.pricing import PRICE_TABLE
from agentrail.observability.langfuse_client import LangfuseHTTP

_MTOK = 1_000_000.0

# Query page size for GET /api/public/models. PRICE_TABLE has ~30 entries
# today; 100 keeps this a one-page fetch in the common case while the loop
# below still handles pagination correctly if the remote project has more.
_PAGE_LIMIT = 100


def _per_token_prices(rates: Dict[str, float]) -> Dict[str, float]:
    """Convert PRICE_TABLE's $/Mtok rates to Langfuse's $/token unit.

    Only ``input``/``output`` are converted — see the module docstring for
    why ``cached_read``/``cached_write`` are out of scope for this sync.
    """
    return {
        "input": rates["input"] / _MTOK,
        "output": rates["output"] / _MTOK,
    }


def _match_pattern(name: str) -> str:
    """Exact-match regex anchored on the full model name.

    Deliberately NOT case-insensitive (no ``(?i)`` prefix) — PRICE_TABLE keys
    are exact provider model identifiers (e.g. ``claude-sonnet-4-5``) and we
    want the sync to only ever match that literal string.
    """
    return f"^{re.escape(name)}$"


def _prices_match(entry: dict, expected: Dict[str, float]) -> bool:
    """True when a remote model definition's price already matches PRICE_TABLE."""
    input_price = entry.get("inputPrice")
    output_price = entry.get("outputPrice")
    if input_price is None or output_price is None:
        return False
    return math.isclose(
        input_price, expected["input"], rel_tol=1e-9, abs_tol=1e-15
    ) and math.isclose(
        output_price, expected["output"], rel_tol=1e-9, abs_tol=1e-15
    )


def _fetch_all_models(client: LangfuseHTTP) -> List[dict]:
    """GET every page of /api/public/models and return the flattened list."""
    models: List[dict] = []
    page = 1
    while True:
        resp = client.get_json(
            "/api/public/models", {"page": page, "limit": _PAGE_LIMIT}
        )
        data = resp.get("data") or []
        models.extend(data)
        meta = resp.get("meta") or {}
        total_pages = meta.get("totalPages") or 1
        if not data or page >= total_pages:
            break
        page += 1
    return models


def _create_model(client: LangfuseHTTP, name: str, expected: Dict[str, float]) -> None:
    body = {
        "modelName": name,
        "matchPattern": _match_pattern(name),
        "unit": "TOKENS",
        "inputPrice": expected["input"],
        "outputPrice": expected["output"],
    }
    client.post_json("/api/public/models", body)


def sync_models(client: LangfuseHTTP, dry_run: bool = False) -> dict:
    """Sync PRICE_TABLE into Langfuse's Models API.

    For every PRICE_TABLE entry:
      - no remote definition exists for that ``modelName``           -> POST, "created"
      - a remote definition exists and its price already matches     -> "unchanged" (no POST)
      - a remote definition exists but its price has drifted         -> POST a
        corrected (newer) definition ("created"); the pre-existing
        definition's name is also reported under "stale"

    ``dry_run=True`` performs the GET (to know what WOULD happen) but skips
    every POST — the return value still reports what would be created/stale.
    """
    remote = _fetch_all_models(client)
    remote_by_name: Dict[str, List[dict]] = {}
    for entry in remote:
        remote_by_name.setdefault(entry.get("modelName"), []).append(entry)

    created: List[str] = []
    unchanged: List[str] = []
    stale: List[str] = []

    for name, rates in PRICE_TABLE.items():
        expected = _per_token_prices(rates)
        existing = remote_by_name.get(name, [])

        if existing and any(_prices_match(e, expected) for e in existing):
            unchanged.append(name)
            continue

        if existing:
            # Price drift: the existing definition(s) are superseded by the
            # newer one we're about to create (Langfuse resolves multiple
            # definitions for the same modelName by newest startTime).
            stale.append(name)

        if not dry_run:
            _create_model(client, name, expected)
        created.append(name)

    return {"created": created, "unchanged": unchanged, "stale": stale}
