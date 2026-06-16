"""Tests for the machine-scoped runner credentials store.

``agentrail login`` writes one credential file for the whole machine
(``~/.agentrail/credentials.json``); the runner reads it to know where the
backend is and how to authenticate. This is distinct from the per-repo
``.agentrail/server.json`` that ``agentrail link`` writes — login is about the
*account*, link is about a *repo*.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from agentrail.runner.credentials import (
    Credentials,
    load_credentials,
    save_credentials,
)


def test_save_then_load_roundtrips(tmp_path: Path):
    creds = Credentials(
        base_url="https://app.agentrail.dev",
        token="rt_secret",
        workspace_id="ws1",
    )
    save_credentials(creds, home=tmp_path)
    loaded = load_credentials(home=tmp_path)
    assert loaded == creds


def test_load_returns_none_when_not_logged_in(tmp_path: Path):
    assert load_credentials(home=tmp_path) is None


def test_save_strips_trailing_slash_from_base_url(tmp_path: Path):
    save_credentials(
        Credentials(base_url="https://app.agentrail.dev/", token="t", workspace_id="w"),
        home=tmp_path,
    )
    assert load_credentials(home=tmp_path).base_url == "https://app.agentrail.dev"


def test_credentials_file_is_private(tmp_path: Path):
    # The token is a secret — the file must not be world/group readable.
    save_credentials(
        Credentials(base_url="https://x", token="t", workspace_id="w"), home=tmp_path
    )
    path = tmp_path / ".agentrail" / "credentials.json"
    assert (path.stat().st_mode & 0o077) == 0


def test_load_returns_none_on_corrupt_file(tmp_path: Path):
    path = tmp_path / ".agentrail"
    path.mkdir(parents=True)
    (path / "credentials.json").write_text("{ not json")
    assert load_credentials(home=tmp_path) is None
