"""Producer side of read-grounded live context metrics (issue #1037).

Exercises the migration-free push path end to end WITHOUT any network:

* ``read_pack_included`` pulls the ACTUAL selected pack items straight from the
  persisted pack JSON (the precision denominator), degrading to ``[]`` on a
  missing / malformed pack.
* ``_live_metric_items`` encodes the waste/miss lists as ordinary
  ``context_events`` rows (``live_waste`` / ``live_miss``) — no new ClickHouse
  column, so no DB migration (the STOP-and-flag constraint).
* ``push_live_context_metrics`` on an UNLINKED run (no server.json, no
  ``AGENTRAIL_SERVER_*`` env) writes the metrics + items to the local sidecar
  instead of POSTing. The whole path is bounded: no link ⇒ no urlopen, so the
  test cannot hang on the network.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from agentrail.run.context_pack_push import (
    _live_metric_items,
    push_live_context_metrics,
    read_pack_included,
)

_SIDECAR = ".agentrail/context/pack-telemetry.jsonl"


@pytest.fixture(autouse=True)
def _no_server_link(monkeypatch):
    """Force the unlinked (sidecar) path: no server.json, no env link.

    AFK sets AGENTRAIL_SERVER_* when it runs the pipeline; clearing them here
    keeps the test hermetic and network-free (load_link → None → sidecar).
    """
    for var in (
        "AGENTRAIL_SERVER_BASE_URL",
        "AGENTRAIL_SERVER_API_KEY",
        "AGENTRAIL_SERVER_REPOSITORY_ID",
    ):
        monkeypatch.delenv(var, raising=False)


def _write_pack(target: Path, *files):
    """Persist a minimal pack JSON with the given (path, tokenEstimate) items."""
    pack = {
        "packId": "pack-abc",
        "retrievalBudget": {"maxTokens": 5000},
        "included": [{"path": p, "tokenEstimate": t} for p, t in files],
    }
    pack_file = "context-pack.json"
    (target / pack_file).write_text(json.dumps(pack), encoding="utf-8")
    return pack_file


def _read_sidecar(target: Path):
    lines = (target / _SIDECAR).read_text(encoding="utf-8").splitlines()
    return [json.loads(line) for line in lines if line.strip()]


# --------------------------------------------------------------------------- #
# read_pack_included                                                          #
# --------------------------------------------------------------------------- #
class TestReadPackIncluded:
    def test_returns_included_items_from_persisted_pack(self, tmp_path):
        pack_file = _write_pack(tmp_path, ("a.py", 400), ("b.py", 300))
        included = read_pack_included(tmp_path, pack_file)
        assert [i["path"] for i in included] == ["a.py", "b.py"]
        assert included[0]["tokenEstimate"] == 400

    def test_missing_pack_is_empty_list_not_error(self, tmp_path):
        assert read_pack_included(tmp_path, "does-not-exist.json") == []

    def test_none_pack_file_is_empty_list(self, tmp_path):
        assert read_pack_included(tmp_path, None) == []


# --------------------------------------------------------------------------- #
# _live_metric_items (migration-free items encoding, AC4)                      #
# --------------------------------------------------------------------------- #
class TestLiveMetricItems:
    def test_waste_and_miss_become_tagged_items(self):
        metrics = {"waste": ["unread.py"], "miss": ["self_fetched.py"]}
        items = _live_metric_items(metrics)
        by_reason = {i["reason"]: i for i in items}
        assert by_reason["live_waste"]["path"] == "unread.py"
        assert by_reason["live_waste"]["included"] is True
        assert by_reason["live_miss"]["path"] == "self_fetched.py"
        assert by_reason["live_miss"]["included"] is False

    def test_na_engine_none_lists_produce_no_items(self):
        # cursor/hermes: waste/miss are None (n/a) → nothing to encode.
        assert _live_metric_items({"waste": None, "miss": None}) == []

    def test_items_are_bounded(self):
        many = [f"f{i}.py" for i in range(500)]
        items = _live_metric_items({"waste": many, "miss": many})
        assert len(items) <= 100


# --------------------------------------------------------------------------- #
# push_live_context_metrics (unlinked → sidecar; no network)                   #
# --------------------------------------------------------------------------- #
class TestPushUnlinked:
    def test_pushes_metrics_and_items_to_sidecar(self, tmp_path):
        pack_file = _write_pack(tmp_path, ("a.py", 400), ("unread.py", 100))
        metrics = {
            "engine": "claude",
            "precision": 0.8,
            "recall": 0.5,
            "recallStatus": "ok",
            "waste": ["unread.py"],
            "miss": ["self_fetched.py"],
        }
        ok = push_live_context_metrics(
            tmp_path, "run-123", metrics, pack_file=pack_file
        )
        assert ok is True

        records = _read_sidecar(tmp_path)
        assert len(records) == 1
        rec = records[0]
        assert rec["delivery"] == "unlinked"
        assert rec["run_id"] == "run-123"
        # The live metrics ride as a top-level payload key (unknown-key tolerant).
        assert rec["live_context_metrics"]["precision"] == 0.8
        assert rec["live_context_metrics"]["engine"] == "claude"
        # waste/miss are drillable context_events items (migration-free channel).
        reasons = {i.get("reason") for i in rec["items"]}
        assert "live_waste" in reasons
        assert "live_miss" in reasons

    def test_na_engine_run_still_pushes_engine_tag(self, tmp_path):
        # A cursor run: read-derived metrics n/a, but the engine tag + explicit
        # n/a must still reach the console so it never shows a fake zero.
        pack_file = _write_pack(tmp_path, ("a.py", 400))
        metrics = {
            "engine": "cursor",
            "readStatus": "n/a",
            "precision": None,
            "precisionStatus": "n/a",
            "recall": 1.0,
            "waste": None,
            "miss": None,
        }
        ok = push_live_context_metrics(
            tmp_path, "run-cursor", metrics, pack_file=pack_file
        )
        assert ok is True
        rec = _read_sidecar(tmp_path)[0]
        assert rec["live_context_metrics"]["engine"] == "cursor"
        assert rec["live_context_metrics"]["precision"] is None
        # No waste/miss items for an n/a engine (nothing measured).
        reasons = {i.get("reason") for i in rec["items"]}
        assert "live_waste" not in reasons
        assert "live_miss" not in reasons

    def test_no_persisted_pack_still_emits_minimal_record(self, tmp_path):
        # A search-only run with no pack file: still surface the engine tag so
        # the dashboard is not dark. Falls back to a minimal record.
        metrics = {
            "engine": "claude",
            "precision": None,
            "packTokens": 0,
            "packFileCount": 0,
            "waste": [],
            "miss": [],
        }
        ok = push_live_context_metrics(
            tmp_path, "run-nopack", metrics, pack_file=None
        )
        assert ok is True
        rec = _read_sidecar(tmp_path)[0]
        assert rec["run_id"] == "run-nopack"
        assert rec["live_context_metrics"]["engine"] == "claude"

    def test_non_dict_metrics_is_a_noop(self, tmp_path):
        assert push_live_context_metrics(tmp_path, "r", None) is False  # type: ignore[arg-type]
        assert not (tmp_path / _SIDECAR).exists()
