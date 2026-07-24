"""Tests for agentrail/context/wiki_fetch.py (Repo Wiki spec §4.2 hydration,
§4.4 contract 2, delivery plan §7 row 4). Mirrors test_memory_fetch.py's
unit-level structure: urllib.request.urlopen is mocked (no network), the
link comes from a server.json written into a fresh temp-dir fixture per test.
"""
from __future__ import annotations

import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

from agentrail.context.wiki_fetch import (
    WIKI_DIR_REL,
    WIKI_FETCH_TIMEOUT_SECONDS,
    WIKI_MANIFEST_REL,
    fetch_wiki_snapshot,
    wiki_page_filename,
)


def _link(root: Path) -> None:
    (root / ".agentrail").mkdir(parents=True, exist_ok=True)
    (root / ".agentrail" / "server.json").write_text(
        json.dumps(
            {
                "base_url": "https://console.example.test",
                "api_key": "test-key",
                "repository_id": "repo-uuid-1",
            }
        )
    )


class _FakeResponse:
    def __init__(self, body, status: int = 200) -> None:
        self._body = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
        self.status = status

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *exc) -> bool:
        return False


def _page(**overrides):
    page = {
        "slug": "wiki/overview",
        "title": "acme/widgets — overview",
        "kind": "overview",
        "bodyMd": "# Overview\n\nThis repo builds widgets.",
        "skeleton": {},
        "links": {"related": [], "dependsOn": [], "dependedOnBy": []},
        "citations": ["README.md"],
        "commitSha": "abc123",
        "inputsHash": "sha256:deadbeef",
        "generatedAt": "2026-07-24T00:00:00Z",
        "model": "claude-haiku-4-5-20251001",
        "writtenBy": "wiki-compiler",
        "stale": False,
    }
    page.update(overrides)
    return page


# ---------------------------------------------------------------------------
# wiki_page_filename — deterministic slug -> filename mapping
# ---------------------------------------------------------------------------
class WikiPageFilenameTests(unittest.TestCase):
    def test_overview_slug(self):
        self.assertEqual(wiki_page_filename("wiki/overview"), "overview.md")

    def test_unit_slug(self):
        self.assertEqual(
            wiki_page_filename("wiki/unit/agentrail-context"), "unit__agentrail-context.md"
        )

    def test_unrecognized_slug_sanitizes_slashes(self):
        name = wiki_page_filename("something/else/entirely")
        self.assertNotIn("/", name)
        self.assertEqual(name, "something__else__entirely.md")

    def test_path_traversal_attempt_never_escapes_the_wiki_dir(self):
        name = wiki_page_filename("../../etc/passwd")
        # No "/" survives -> joining onto wiki_dir can never traverse out of it.
        self.assertNotIn("/", name)


# ---------------------------------------------------------------------------
# fetch_wiki_snapshot
# ---------------------------------------------------------------------------
class FetchWikiSnapshotTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.root = Path(self._tmpdir.name)
        self.addCleanup(self._tmpdir.cleanup)

    def _manifest_path(self) -> Path:
        return self.root / WIKI_MANIFEST_REL

    def _wiki_dir(self) -> Path:
        return self.root / WIKI_DIR_REL

    def test_fetch_writes_manifest_and_page_files_from_server_rows(self) -> None:
        _link(self.root)
        pages = [
            _page(slug="wiki/overview", title="Overview"),
            _page(
                slug="wiki/unit/agentrail-context",
                title="agentrail/context — Context Compiler",
                kind="unit",
                citations=["agentrail/context/index.py"],
            ),
        ]
        with mock.patch("urllib.request.urlopen") as fake_urlopen:
            fake_urlopen.return_value = _FakeResponse(
                {"schemaVersion": 1, "repo": "acme/widgets", "pages": pages}
            )
            result = fetch_wiki_snapshot(self.root, "acme/widgets", ttl_seconds=0)

        self.assertTrue(result)
        req = fake_urlopen.call_args[0][0]
        self.assertEqual(
            req.full_url,
            "https://console.example.test/api/v1/context/wiki-pages?repo=acme%2Fwidgets",
        )
        self.assertEqual(req.get_method(), "GET")
        self.assertEqual(req.get_header("Authorization"), "Bearer test-key")
        self.assertEqual(fake_urlopen.call_args.kwargs["timeout"], WIKI_FETCH_TIMEOUT_SECONDS)

        manifest = json.loads(self._manifest_path().read_text(encoding="utf-8"))
        self.assertEqual(manifest["repo"], "acme/widgets")
        self.assertIn("fetchedAt", manifest)
        self.assertEqual(
            manifest["pages"],
            [
                {"slug": "wiki/overview", "inputsHash": "sha256:deadbeef", "stale": False},
                {
                    "slug": "wiki/unit/agentrail-context",
                    "inputsHash": "sha256:deadbeef",
                    "stale": False,
                },
            ],
        )

        overview_md = (self._wiki_dir() / "overview.md").read_text(encoding="utf-8")
        self.assertIn("slug: wiki/overview", overview_md)
        self.assertIn("title: Overview", overview_md)
        self.assertIn("kind: overview", overview_md)
        self.assertIn("commitSha: abc123", overview_md)
        self.assertIn("inputsHash: sha256:deadbeef", overview_md)
        self.assertIn("model: claude-haiku-4-5-20251001", overview_md)
        self.assertIn("citations: [README.md]", overview_md)
        self.assertTrue(overview_md.endswith("This repo builds widgets.\n"))

        unit_md = (self._wiki_dir() / "unit__agentrail-context.md").read_text(encoding="utf-8")
        self.assertIn("slug: wiki/unit/agentrail-context", unit_md)

    def test_unlinked_repo_skips_network(self) -> None:
        # no server.json written
        with mock.patch("urllib.request.urlopen") as fake_urlopen:
            result = fetch_wiki_snapshot(self.root, "acme/widgets", ttl_seconds=0)

        self.assertFalse(result)
        fake_urlopen.assert_not_called()
        self.assertFalse(self._manifest_path().exists())

    def test_network_failure_is_nonfatal_and_preserves_existing_files(self) -> None:
        _link(self.root)
        self._wiki_dir().mkdir(parents=True, exist_ok=True)
        self._manifest_path().write_text(json.dumps({"repo": "acme/widgets", "pages": []}))
        (self._wiki_dir() / "overview.md").write_text("stale but present")

        with mock.patch(
            "urllib.request.urlopen", side_effect=urllib.error.URLError("connection refused")
        ):
            result = fetch_wiki_snapshot(self.root, "acme/widgets", ttl_seconds=0)

        self.assertFalse(result)
        self.assertEqual((self._wiki_dir() / "overview.md").read_text(), "stale but present")

    def test_auth_failure_is_nonfatal(self) -> None:
        _link(self.root)
        with mock.patch(
            "urllib.request.urlopen",
            side_effect=urllib.error.HTTPError(
                "https://console.example.test", 401, "unauthorized", None, None
            ),
        ):
            result = fetch_wiki_snapshot(self.root, "acme/widgets", ttl_seconds=0)

        self.assertFalse(result)
        self.assertFalse(self._manifest_path().exists())

    def test_garbage_body_is_nonfatal(self) -> None:
        _link(self.root)
        with mock.patch("urllib.request.urlopen") as fake_urlopen:
            fake_urlopen.return_value = _FakeResponse(b"not json {{{")
            result = fetch_wiki_snapshot(self.root, "acme/widgets", ttl_seconds=0)

        self.assertFalse(result)
        self.assertFalse(self._manifest_path().exists())

    def test_missing_pages_key_is_nonfatal(self) -> None:
        _link(self.root)
        with mock.patch("urllib.request.urlopen") as fake_urlopen:
            fake_urlopen.return_value = _FakeResponse({"schemaVersion": 1, "repo": "acme/widgets"})
            result = fetch_wiki_snapshot(self.root, "acme/widgets", ttl_seconds=0)

        self.assertFalse(result)
        self.assertFalse(self._manifest_path().exists())

    def test_non_dict_pages_are_dropped(self) -> None:
        _link(self.root)
        keep = _page()
        with mock.patch("urllib.request.urlopen") as fake_urlopen:
            fake_urlopen.return_value = _FakeResponse(
                {"pages": [keep, "garbage-string", 42, None, ["nested"]]}
            )
            result = fetch_wiki_snapshot(self.root, "acme/widgets", ttl_seconds=0)

        self.assertTrue(result)
        manifest = json.loads(self._manifest_path().read_text(encoding="utf-8"))
        self.assertEqual(len(manifest["pages"]), 1)
        self.assertEqual(manifest["pages"][0]["slug"], "wiki/overview")

    def test_page_missing_slug_is_skipped(self) -> None:
        _link(self.root)
        with mock.patch("urllib.request.urlopen") as fake_urlopen:
            fake_urlopen.return_value = _FakeResponse({"pages": [{"title": "no slug here"}]})
            result = fetch_wiki_snapshot(self.root, "acme/widgets", ttl_seconds=0)

        self.assertTrue(result)
        manifest = json.loads(self._manifest_path().read_text(encoding="utf-8"))
        self.assertEqual(manifest["pages"], [])
        self.assertEqual(list(self._wiki_dir().glob("*.md")), [])

    def test_ttl_fresh_snapshot_skips_network_and_zero_ttl_refetches(self) -> None:
        _link(self.root)
        self._wiki_dir().mkdir(parents=True, exist_ok=True)
        self._manifest_path().write_text(
            json.dumps({"repo": "acme/widgets", "pages": []})
        )  # mtime = now, well within the default TTL

        with mock.patch("urllib.request.urlopen") as fake_urlopen:
            fake_urlopen.return_value = _FakeResponse({"pages": [_page()]})

            self.assertTrue(
                fetch_wiki_snapshot(self.root, "acme/widgets")
            )  # default TTL: fresh, no network
            fake_urlopen.assert_not_called()

            self.assertTrue(
                fetch_wiki_snapshot(self.root, "acme/widgets", ttl_seconds=0)
            )  # forced refetch
            self.assertEqual(fake_urlopen.call_count, 1)

        manifest = json.loads(self._manifest_path().read_text(encoding="utf-8"))
        self.assertEqual(manifest["pages"][0]["slug"], "wiki/overview")

    def test_orphaned_page_file_pruned_when_server_no_longer_lists_it(self) -> None:
        _link(self.root)
        self._wiki_dir().mkdir(parents=True, exist_ok=True)
        (self._wiki_dir() / "unit__removed-unit.md").write_text("orphan from a prior fetch")

        with mock.patch("urllib.request.urlopen") as fake_urlopen:
            fake_urlopen.return_value = _FakeResponse(
                {"pages": [_page()]}
            )  # only "wiki/overview" now
            result = fetch_wiki_snapshot(self.root, "acme/widgets", ttl_seconds=0)

        self.assertTrue(result)
        self.assertFalse((self._wiki_dir() / "unit__removed-unit.md").exists())
        self.assertTrue((self._wiki_dir() / "overview.md").exists())


if __name__ == "__main__":
    unittest.main()
