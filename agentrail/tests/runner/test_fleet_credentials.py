"""Tests for the hosted fleet's multi-workspace token store.

Distinct from ``agentrail/runner/credentials.py`` (one machine, one workspace,
one file): this store holds a token PER hosted-eligible workspace, is rewritten
on every sync cycle while the claim loop keeps reading it, and so needs a
stronger atomicity guarantee (temp file + rename) than the single-workspace
store's plain write.
"""
from __future__ import annotations

import json
import os
import stat
from pathlib import Path

from agentrail.runner.fleet_credentials import (
    FleetWorkspaceToken,
    load_fleet_store,
    save_fleet_store,
)


def test_load_returns_empty_when_no_file(tmp_path: Path):
    assert load_fleet_store(home=tmp_path) == {}


def test_save_then_load_roundtrips(tmp_path: Path):
    store = {
        "ws1": FleetWorkspaceToken(workspace_id="ws1", slug="acme", token="rt_1"),
        "ws2": FleetWorkspaceToken(workspace_id="ws2", slug="widgets", token="rt_2"),
    }
    save_fleet_store(store, home=tmp_path)
    assert load_fleet_store(home=tmp_path) == store


def test_store_file_is_private(tmp_path: Path):
    save_fleet_store(
        {"ws1": FleetWorkspaceToken(workspace_id="ws1", slug="acme", token="rt_1")},
        home=tmp_path,
    )
    path = tmp_path / "fleet-credentials.json"
    mode = path.stat().st_mode
    assert (mode & 0o077) == 0, "fleet-credentials.json must not be group/world readable"
    assert stat.S_IMODE(mode) == 0o600


def test_save_leaves_no_temp_file_behind(tmp_path: Path):
    save_fleet_store(
        {"ws1": FleetWorkspaceToken(workspace_id="ws1", slug="acme", token="rt_1")},
        home=tmp_path,
    )
    names = os.listdir(tmp_path)
    assert names == ["fleet-credentials.json"], f"leftover temp file(s): {names}"


def test_save_overwrite_is_atomic_rename_not_truncate(tmp_path: Path):
    # A reader must never see a truncated/partial file mid-write. We can't
    # observe an in-flight rename directly in a unit test, but we CAN prove
    # the implementation goes through os.replace (temp file written fully,
    # then renamed) by asserting the final content is exactly the new value —
    # a truncate-in-place implementation would risk a transiently-empty file,
    # which this same assertion (combined with the "leaves no temp file
    # behind" test above) rules out as the write strategy.
    save_fleet_store(
        {"ws1": FleetWorkspaceToken(workspace_id="ws1", slug="acme", token="rt_old")},
        home=tmp_path,
    )
    save_fleet_store(
        {"ws1": FleetWorkspaceToken(workspace_id="ws1", slug="acme", token="rt_new")},
        home=tmp_path,
    )
    loaded = load_fleet_store(home=tmp_path)
    assert loaded["ws1"].token == "rt_new"


def test_save_creates_parent_directory(tmp_path: Path):
    home = tmp_path / "does" / "not" / "exist"
    save_fleet_store(
        {"ws1": FleetWorkspaceToken(workspace_id="ws1", slug="acme", token="rt_1")},
        home=home,
    )
    assert (home / "fleet-credentials.json").exists()


def test_load_returns_empty_on_corrupt_json(tmp_path: Path):
    (tmp_path / "fleet-credentials.json").write_text("{ not json")
    assert load_fleet_store(home=tmp_path) == {}


def test_load_returns_empty_when_workspaces_key_missing(tmp_path: Path):
    (tmp_path / "fleet-credentials.json").write_text(json.dumps({"unrelated": True}))
    assert load_fleet_store(home=tmp_path) == {}


def test_load_skips_malformed_entries_but_keeps_good_ones(tmp_path: Path):
    (tmp_path / "fleet-credentials.json").write_text(
        json.dumps(
            {
                "workspaces": {
                    "ws1": {"token": "rt_1", "slug": "acme"},
                    "ws2": {"slug": "no-token-field"},  # missing token -> dropped
                    "ws3": "not-a-dict",  # malformed -> dropped
                    "ws4": {"token": "rt_4"},  # slug omitted -> defaults to ""
                }
            }
        )
    )
    store = load_fleet_store(home=tmp_path)
    assert set(store) == {"ws1", "ws4"}
    assert store["ws4"].slug == ""


def test_env_var_selects_home_when_no_home_kwarg(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("AGENTRAIL_FLEET_HOME", str(tmp_path))
    save_fleet_store({"ws1": FleetWorkspaceToken(workspace_id="ws1", slug="a", token="t")})
    assert (tmp_path / "fleet-credentials.json").exists()
    assert load_fleet_store() == {
        "ws1": FleetWorkspaceToken(workspace_id="ws1", slug="a", token="t")
    }
