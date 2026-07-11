"""Fixtures for the CLI test suite.

The auth gate added in main() (issue #865) blocks usage/server commands when no
credentials are present. The routing tests here exercise dispatch, not the gate,
so they would otherwise trip the gate in CI (no credentials, env stripped by the
repo-wide conftest). Fake an authenticated machine by default so `main()` reaches
the dispatch logic. Tests that assert gate behaviour (test_auth_gate.py) patch
`load_credentials` themselves, which overrides this fixture for their duration.
"""
from __future__ import annotations

from unittest.mock import patch

import pytest

from agentrail.runner.credentials import Credentials

_TEST_CREDS = Credentials(
    base_url="https://example.com",
    token="tok-test",
    workspace_id="ws-test",
)


@pytest.fixture(autouse=True)
def _authenticated_cli(monkeypatch: pytest.MonkeyPatch):
    with patch("agentrail.cli.main.load_credentials", return_value=_TEST_CREDS):
        yield
