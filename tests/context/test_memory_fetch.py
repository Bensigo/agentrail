"""Tests for the memory-lane snapshot producer (issue #1071).

Covers the write half that #1039 left out: fetch_memory_snapshot pulls the
linked server's memory_items and writes MEMORY_SNAPSHOT_REL, which the lane
(read half, tests in test_memory_lane.py) already consumes.

All tests are hermetic: urllib.request.urlopen is mocked (no network), the
link comes from a server.json written into the git fixture (which takes
precedence over any ambient AGENTRAIL_SERVER_* env afk may have set), and the
unlinked test explicitly strips those env vars.

The two E2E tests are the AC1 evidence: they go through the REAL run entry
point ``agentrail.run.context.build_pack`` with NO ``memory_items=`` injection
seam, and assert the fetched rows surface in (or, on failure, stay out of) the
persisted pack's memory lane.
"""
from __future__ import annotations

import contextlib
import json
import os
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

from agentrail.context.memory_fetch import (
    MEMORY_FETCH_TIMEOUT_SECONDS,
    fetch_memory_snapshot,
)
from agentrail.context.memory_lane import MEMORY_SNAPSHOT_REL
from agentrail.run.context import build_pack
from tests.context.test_memory_lane import _make_repo, _mem

_LINK_ENV_KEYS = (
    "AGENTRAIL_SERVER_BASE_URL",
    "AGENTRAIL_SERVER_API_KEY",
    "AGENTRAIL_SERVER_REPOSITORY_ID",
)


class _FakeResponse:
    """Minimal stand-in for urlopen's context-manager response."""

    def __init__(self, body, status: int = 200) -> None:
        self._body = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
        self.status = status

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *exc) -> bool:
        return False


def _link_repo(root: Path) -> None:
    """Write the server.json link (takes precedence over ambient env vars)."""
    (root / ".agentrail" / "server.json").write_text(
        json.dumps(
            {
                "base_url": "https://console.example.test",
                "api_key": "test-key",
                "repository_id": "repo-uuid-1",
            }
        ),
        encoding="utf-8",
    )


@contextlib.contextmanager
def _no_link_env():
    """Strip AGENTRAIL_SERVER_* so afk's ambient env can't link the repo."""
    with mock.patch.dict(os.environ):
        for key in _LINK_ENV_KEYS:
            os.environ.pop(key, None)
        yield


def _snapshot_path(root: Path) -> Path:
    return root / MEMORY_SNAPSHOT_REL


# ---------------------------------------------------------------------------
# Unit: fetch-and-snapshot behaviour (mocked HTTP).
# ---------------------------------------------------------------------------
class FetchMemorySnapshotTests(unittest.TestCase):
    def test_fetch_writes_snapshot_from_server_rows(self) -> None:
        root = _make_repo()
        _link_repo(root)
        rows = [
            _mem("m1", "We build Jace on the Eve framework.", mem_type="decision", written_by="jace"),
            _mem("m2", "Pricing math routes through agentrail/run/pricing.py."),
        ]
        with mock.patch("urllib.request.urlopen") as fake_urlopen:
            fake_urlopen.return_value = _FakeResponse({"items": rows})
            result = fetch_memory_snapshot(root, ttl_seconds=0)

        self.assertTrue(result)
        # Request went to the new bearer-authed GET endpoint with the link's key.
        req = fake_urlopen.call_args[0][0]
        self.assertEqual(
            req.full_url,
            "https://console.example.test/api/v1/context/memory-items?repository_id=repo-uuid-1",
        )
        self.assertEqual(req.get_method(), "GET")
        self.assertEqual(req.get_header("Authorization"), "Bearer test-key")
        self.assertEqual(fake_urlopen.call_args.kwargs["timeout"], MEMORY_FETCH_TIMEOUT_SECONDS)
        # Snapshot landed at the exact path the lane reads, rows intact.
        data = json.loads(_snapshot_path(root).read_text(encoding="utf-8"))
        self.assertEqual(data["items"], rows)
        self.assertEqual(data["repository_id"], "repo-uuid-1")
        self.assertIn("fetched_at", data)

    def test_unlinked_repo_skips_network(self) -> None:
        root = _make_repo()  # no server.json
        with _no_link_env(), mock.patch("urllib.request.urlopen") as fake_urlopen:
            result = fetch_memory_snapshot(root, ttl_seconds=0)

        self.assertFalse(result)
        fake_urlopen.assert_not_called()
        self.assertFalse(_snapshot_path(root).exists())

    def test_network_failure_is_nonfatal_and_preserves_stale_snapshot(self) -> None:
        root = _make_repo()
        _link_repo(root)
        stale = {"items": [_mem("old", "Last known good row.")]}
        _snapshot_path(root).parent.mkdir(parents=True, exist_ok=True)
        _snapshot_path(root).write_text(json.dumps(stale), encoding="utf-8")

        with mock.patch(
            "urllib.request.urlopen",
            side_effect=urllib.error.URLError("connection refused"),
        ):
            result = fetch_memory_snapshot(root, ttl_seconds=0)  # must not raise (AC2)

        self.assertFalse(result)
        # Failed refresh never deletes the last known good snapshot.
        self.assertEqual(
            json.loads(_snapshot_path(root).read_text(encoding="utf-8")), stale
        )

    def test_auth_failure_is_nonfatal(self) -> None:
        root = _make_repo()
        _link_repo(root)
        with mock.patch(
            "urllib.request.urlopen",
            side_effect=urllib.error.HTTPError(
                "https://console.example.test", 401, "unauthorized", None, None
            ),
        ):
            result = fetch_memory_snapshot(root, ttl_seconds=0)

        self.assertFalse(result)
        self.assertFalse(_snapshot_path(root).exists())

    def test_garbage_body_is_nonfatal(self) -> None:
        root = _make_repo()
        _link_repo(root)
        with mock.patch("urllib.request.urlopen") as fake_urlopen:
            fake_urlopen.return_value = _FakeResponse(b"not json {{{")
            result = fetch_memory_snapshot(root, ttl_seconds=0)

        self.assertFalse(result)
        self.assertFalse(_snapshot_path(root).exists())

    def test_missing_items_key_is_nonfatal(self) -> None:
        root = _make_repo()
        _link_repo(root)
        with mock.patch("urllib.request.urlopen") as fake_urlopen:
            fake_urlopen.return_value = _FakeResponse({"rows": [_mem("m1", "wrong key")]})
            result = fetch_memory_snapshot(root, ttl_seconds=0)

        self.assertFalse(result)
        self.assertFalse(_snapshot_path(root).exists())

    def test_non_dict_rows_are_dropped(self) -> None:
        root = _make_repo()
        _link_repo(root)
        keep = _mem("m1", "Only dict-shaped rows survive.")
        with mock.patch("urllib.request.urlopen") as fake_urlopen:
            fake_urlopen.return_value = _FakeResponse(
                {"items": [keep, "garbage-string", 42, None, ["nested"]]}
            )
            result = fetch_memory_snapshot(root, ttl_seconds=0)

        self.assertTrue(result)
        data = json.loads(_snapshot_path(root).read_text(encoding="utf-8"))
        self.assertEqual(data["items"], [keep])

    def test_ttl_fresh_snapshot_skips_network_and_zero_ttl_refetches(self) -> None:
        root = _make_repo()
        _link_repo(root)
        _snapshot_path(root).parent.mkdir(parents=True, exist_ok=True)
        _snapshot_path(root).write_text(
            json.dumps({"items": [_mem("old", "Fresh enough.")]}), encoding="utf-8"
        )  # mtime = now, well within the default TTL

        with mock.patch("urllib.request.urlopen") as fake_urlopen:
            fake_urlopen.return_value = _FakeResponse({"items": [_mem("new", "Refetched.")]})

            self.assertTrue(fetch_memory_snapshot(root))  # default TTL: fresh, no network
            fake_urlopen.assert_not_called()

            self.assertTrue(fetch_memory_snapshot(root, ttl_seconds=0))  # forced refetch
            self.assertEqual(fake_urlopen.call_count, 1)

        data = json.loads(_snapshot_path(root).read_text(encoding="utf-8"))
        self.assertEqual(data["items"][0]["id"], "new")


# ---------------------------------------------------------------------------
# E2E (AC1): the REAL run path — agentrail.run.context.build_pack with no
# memory_items= injection seam — produces a pack whose memory lane carries the
# rows the (mocked) server returned.
# ---------------------------------------------------------------------------
class ProducerEndToEndTests(unittest.TestCase):
    def test_fetched_snapshot_populates_lane_via_real_run_build_pack(self) -> None:
        root = _make_repo()
        _link_repo(root)
        rows = [
            _mem(
                "mem-e2e-1",
                "AgentRail memory lane end to end row.",
                mem_type="decision",
                written_by="jace",
            )
        ]
        with mock.patch("urllib.request.urlopen") as fake_urlopen:
            fake_urlopen.return_value = _FakeResponse({"items": rows})
            json_path = build_pack(root, "issue", 1, "plan")

        self.assertIsNotNone(json_path, "real run path failed to build a pack")
        # The producer ran inside build_pack (the test never wrote the snapshot).
        self.assertTrue(_snapshot_path(root).exists())
        pack = json.loads((root / json_path).read_text(encoding="utf-8"))
        lane = pack["memoryLane"]
        self.assertTrue(lane, "memory lane is empty despite fetched snapshot")
        lane_json = json.dumps(lane)
        self.assertIn("AgentRail memory lane end to end row.", lane_json)
        self.assertIn("jace", lane_json)  # attribution survives the round trip

    def test_fetch_failure_still_builds_pack_with_empty_lane(self) -> None:
        root = _make_repo()
        _link_repo(root)
        with mock.patch(
            "urllib.request.urlopen",
            side_effect=urllib.error.URLError("server unreachable"),
        ):
            json_path = build_pack(root, "issue", 1, "plan")

        # AC2: the failed fetch never breaks the run — pack still builds,
        # lane just renders empty.
        self.assertIsNotNone(json_path)
        pack = json.loads((root / json_path).read_text(encoding="utf-8"))
        self.assertEqual(pack["memoryLane"], [])


if __name__ == "__main__":
    unittest.main()
