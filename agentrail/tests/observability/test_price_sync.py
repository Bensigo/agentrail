"""Tests for agentrail.observability.price_sync (agentrail langfuse sync-models).

``LangfuseHTTP._request`` is monkeypatched (mirrors test_langfuse_client.py's
pattern) so no real network call is made; every scenario below asserts the
OBSERVABLE contract: which HTTP methods fired, what body they carried, and
the returned {"created", "unchanged", "stale"} dict.
"""
from __future__ import annotations

import json
import re

import pytest

from agentrail.context.pricing import PRICE_TABLE
from agentrail.observability import langfuse_client as lc
from agentrail.observability import price_sync


@pytest.fixture
def client():
    return lc.LangfuseHTTP("http://localhost:3000", "pk", "sk")


def _get_response(data):
    return 200, json.dumps({
        "data": data,
        "meta": {"limit": 100, "page": 1, "totalItems": len(data), "totalPages": 1},
    }).encode()


def _remote_entry(name: str, rates: dict) -> dict:
    """A remote model definition already priced exactly per PRICE_TABLE."""
    return {
        "modelName": name,
        "matchPattern": f"^{re.escape(name)}$",
        "unit": "TOKENS",
        "inputPrice": rates["input"] / 1_000_000.0,
        "outputPrice": rates["output"] / 1_000_000.0,
    }


# ---------------------------------------------------------------------------
# (a) empty remote -> every PRICE_TABLE model POSTed
# ---------------------------------------------------------------------------

def test_empty_remote_creates_every_model_with_anchored_match_pattern(monkeypatch, client):
    calls = []

    def fake_request(method, url, headers, data, timeout):
        calls.append((method, url, data))
        if method == "GET":
            return _get_response([])
        return 200, b'{"id": "new"}'

    monkeypatch.setattr(lc, "_request", fake_request)

    result = price_sync.sync_models(client)

    assert set(result["created"]) == set(PRICE_TABLE.keys())
    assert result["unchanged"] == []
    assert result["stale"] == []

    post_calls = [c for c in calls if c[0] == "POST"]
    assert len(post_calls) == len(PRICE_TABLE)
    seen_names = set()
    for _, _url, data in post_calls:
        body = json.loads(data)
        name = body["modelName"]
        seen_names.add(name)
        assert name in PRICE_TABLE
        # matchPattern = exact-escaped model name, anchored ^...$
        assert body["matchPattern"] == f"^{re.escape(name)}$"
    assert seen_names == set(PRICE_TABLE.keys())


# ---------------------------------------------------------------------------
# (b) remote already matching -> zero POSTs, all "unchanged"
# ---------------------------------------------------------------------------

def test_remote_already_matching_makes_zero_posts(monkeypatch, client):
    remote_data = [_remote_entry(name, rates) for name, rates in PRICE_TABLE.items()]

    def fake_request(method, url, headers, data, timeout):
        if method == "GET":
            return _get_response(remote_data)
        raise AssertionError(f"unexpected {method} call when remote already matches")

    monkeypatch.setattr(lc, "_request", fake_request)

    result = price_sync.sync_models(client)

    assert result["created"] == []
    assert set(result["unchanged"]) == set(PRICE_TABLE.keys())
    assert result["stale"] == []


# ---------------------------------------------------------------------------
# (c) price drift -> POST issued, name in "created", old listed in "stale"
# ---------------------------------------------------------------------------

def test_price_drift_posts_correction_and_flags_old_as_stale(monkeypatch, client):
    drifted_name = "claude-sonnet-4-5"
    assert drifted_name in PRICE_TABLE

    remote_data = []
    for name, rates in PRICE_TABLE.items():
        if name == drifted_name:
            stale_entry = _remote_entry(name, rates)
            stale_entry["inputPrice"] = 999.0  # deliberately wrong / stale price
            remote_data.append(stale_entry)
        else:
            remote_data.append(_remote_entry(name, rates))

    post_calls = []

    def fake_request(method, url, headers, data, timeout):
        if method == "GET":
            return _get_response(remote_data)
        post_calls.append(json.loads(data))
        return 200, b'{"id": "corrected"}'

    monkeypatch.setattr(lc, "_request", fake_request)

    result = price_sync.sync_models(client)

    assert result["created"] == [drifted_name]
    assert result["stale"] == [drifted_name]
    assert set(result["unchanged"]) == set(PRICE_TABLE.keys()) - {drifted_name}

    assert len(post_calls) == 1
    expected = price_sync._per_token_prices(PRICE_TABLE[drifted_name])
    assert post_calls[0]["modelName"] == drifted_name
    assert post_calls[0]["inputPrice"] == pytest.approx(expected["input"])
    assert post_calls[0]["outputPrice"] == pytest.approx(expected["output"])


# ---------------------------------------------------------------------------
# (d) unit-conversion pin
# ---------------------------------------------------------------------------

def test_unit_conversion_pin_claude_sonnet_4_5():
    # PRICE_TABLE['claude-sonnet-4-5'] = {"input": 3.0, "output": 15.0, ...}
    # in USD per MILLION tokens ($/Mtok), per pricing.py's own docstring.
    # Langfuse prices per SINGLE token (unit="TOKENS"), so the conversion is
    # $/Mtok / 1_000_000 = $/token. Hand-computed:
    #   input:  3.0  / 1_000_000 = 0.000003 USD/token
    #   output: 15.0 / 1_000_000 = 0.000015 USD/token
    rates = PRICE_TABLE["claude-sonnet-4-5"]
    assert rates["input"] == 3.0
    assert rates["output"] == 15.0

    converted = price_sync._per_token_prices(rates)

    assert converted["input"] == pytest.approx(0.000003)
    assert converted["output"] == pytest.approx(0.000015)


# ---------------------------------------------------------------------------
# (e) --dry-run -> zero POSTs, would-create names returned
# ---------------------------------------------------------------------------

def test_dry_run_makes_zero_posts_but_reports_would_create(monkeypatch, client):
    def fake_request(method, url, headers, data, timeout):
        if method == "GET":
            return _get_response([])
        raise AssertionError("no POST expected under dry_run=True")

    monkeypatch.setattr(lc, "_request", fake_request)

    result = price_sync.sync_models(client, dry_run=True)

    assert set(result["created"]) == set(PRICE_TABLE.keys())
    assert result["unchanged"] == []
    assert result["stale"] == []


def test_dry_run_price_drift_reports_stale_without_posting(monkeypatch, client):
    drifted_name = "gpt-4o"
    assert drifted_name in PRICE_TABLE

    remote_data = []
    for name, rates in PRICE_TABLE.items():
        if name == drifted_name:
            stale_entry = _remote_entry(name, rates)
            stale_entry["outputPrice"] = 1.0  # deliberately wrong
            remote_data.append(stale_entry)
        else:
            remote_data.append(_remote_entry(name, rates))

    def fake_request(method, url, headers, data, timeout):
        if method == "GET":
            return _get_response(remote_data)
        raise AssertionError("no POST expected under dry_run=True")

    monkeypatch.setattr(lc, "_request", fake_request)

    result = price_sync.sync_models(client, dry_run=True)

    assert result["created"] == [drifted_name]
    assert result["stale"] == [drifted_name]


# ---------------------------------------------------------------------------
# Pagination plumbing (multi-page GET)
# ---------------------------------------------------------------------------

def test_fetch_all_models_follows_pagination(monkeypatch, client):
    name_a, name_b = list(PRICE_TABLE.keys())[:2]
    page1 = {
        "data": [_remote_entry(name_a, PRICE_TABLE[name_a])],
        "meta": {"limit": 1, "page": 1, "totalItems": 2, "totalPages": 2},
    }
    page2 = {
        "data": [_remote_entry(name_b, PRICE_TABLE[name_b])],
        "meta": {"limit": 1, "page": 2, "totalItems": 2, "totalPages": 2},
    }

    def fake_request(method, url, headers, data, timeout):
        assert method == "GET"
        if "page=1" in url:
            return 200, json.dumps(page1).encode()
        return 200, json.dumps(page2).encode()

    monkeypatch.setattr(lc, "_request", fake_request)

    models = price_sync._fetch_all_models(client)
    names = {m["modelName"] for m in models}
    assert names == {name_a, name_b}
