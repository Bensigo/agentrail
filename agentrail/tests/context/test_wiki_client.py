"""Tests for agentrail/context/wiki_client.py — the read-only server client
(context source registry spec §G, step 2 of §K —
docs/superpowers/specs/2026-07-27-context-source-registry-design.md).

Mirrors test_wiki_fetch.py's structure exactly: urllib.request.urlopen is
mocked (no network), the link comes from a server.json written into a fresh
temp dir per test. The difference this file has to prove is the one the
module exists for — reading pages must leave NOTHING on disk, and must
distinguish "server unreachable" from "server says no such page".
"""
from __future__ import annotations

import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

from agentrail.context import wiki_client
from agentrail.context.wiki_fetch import WIKI_DIR_REL, render_page_text

_REPO = "acme/widgets"


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


def _payload(*pages):
    return {"schemaVersion": 1, "repo": _REPO, "pages": list(pages)}


class RemotePagesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp())
        _link(self.root)

    def test_returns_pages_from_the_server(self) -> None:
        payload = _payload(_page(), _page(slug="wiki/unit/core", title="core"))
        with mock.patch("urllib.request.urlopen", return_value=_FakeResponse(payload)):
            pages = wiki_client.remote_pages(self.root, repo_full_name=_REPO)
        self.assertIsNotNone(pages)
        self.assertEqual([p["slug"] for p in pages], ["wiki/overview", "wiki/unit/core"])

    def test_reads_nothing_onto_disk(self) -> None:
        """The module's central claim: a read never seeds the hydration cache.

        An executor running `wiki show` inside an ephemeral clone must not
        leave a directory behind that a later compile then treats as a
        durable copy to hash-diff against.
        """
        payload = _payload(_page())
        with mock.patch("urllib.request.urlopen", return_value=_FakeResponse(payload)):
            wiki_client.remote_pages(self.root, repo_full_name=_REPO)
            wiki_client.remote_status(self.root, repo_full_name=_REPO)
            wiki_client.remote_show(self.root, "wiki/overview", repo_full_name=_REPO)
        self.assertFalse((self.root / WIKI_DIR_REL).exists(), "a read must not create the wiki cache dir")

    def test_unlinked_repo_returns_none(self) -> None:
        bare = Path(tempfile.mkdtemp())
        self.assertIsNone(wiki_client.remote_pages(bare, repo_full_name=_REPO))

    def test_unresolvable_origin_returns_none_without_calling_the_server(self) -> None:
        """No origin remote (a bare temp dir) short-circuits before the fetch."""
        with mock.patch("urllib.request.urlopen") as urlopen:
            self.assertIsNone(wiki_client.remote_pages(self.root))
        urlopen.assert_not_called()

    def test_http_error_returns_none(self) -> None:
        error = urllib.error.HTTPError("u", 500, "boom", {}, None)
        with mock.patch("urllib.request.urlopen", side_effect=error):
            self.assertIsNone(wiki_client.remote_pages(self.root, repo_full_name=_REPO))

    def test_non_200_returns_none(self) -> None:
        with mock.patch("urllib.request.urlopen", return_value=_FakeResponse(_payload(), status=404)):
            self.assertIsNone(wiki_client.remote_pages(self.root, repo_full_name=_REPO))

    def test_unparseable_body_returns_none(self) -> None:
        with mock.patch("urllib.request.urlopen", return_value=_FakeResponse(b"not json")):
            self.assertIsNone(wiki_client.remote_pages(self.root, repo_full_name=_REPO))

    def test_malformed_rows_are_dropped_not_trusted(self) -> None:
        payload = _payload(_page(), "a string", {"noSlug": True}, _page(slug=""))
        with mock.patch("urllib.request.urlopen", return_value=_FakeResponse(payload)):
            pages = wiki_client.remote_pages(self.root, repo_full_name=_REPO)
        self.assertEqual([p["slug"] for p in pages], ["wiki/overview"])


class RemoteStatusTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp())
        _link(self.root)

    def _status(self, *pages):
        with mock.patch("urllib.request.urlopen", return_value=_FakeResponse(_payload(*pages))):
            return wiki_client.remote_status(self.root, repo_full_name=_REPO)

    def test_status_shape_matches_the_local_readers_keys(self) -> None:
        status = self._status(_page())
        self.assertEqual(status["origin"], "server")
        self.assertTrue(status["compiled"])
        self.assertEqual(status["commitSha"], "abc123")
        page = status["pages"][0]
        self.assertEqual(
            sorted(page),
            sorted(["slug", "file", "inputsHash", "currentInputsHash", "stale", "generatedAt", "ageSeconds", "model"]),
        )

    def test_server_page_has_no_local_file_or_recomputed_hash(self) -> None:
        """Both are None on purpose — see remote_status's docstring. A server
        page has no path in this clone, and recomputing staleness against a
        possibly-different local commit would answer a different question
        than the console shows for the same page."""
        page = self._status(_page())["pages"][0]
        self.assertIsNone(page["file"])
        self.assertIsNone(page["currentInputsHash"])

    def test_stale_comes_from_the_server_flag(self) -> None:
        page = self._status(_page(stale=True))["pages"][0]
        self.assertTrue(page["stale"])

    def test_empty_page_list_is_not_compiled(self) -> None:
        self.assertFalse(self._status()["compiled"])

    def test_unreachable_server_returns_none_so_the_caller_can_fall_back(self) -> None:
        with mock.patch("urllib.request.urlopen", side_effect=urllib.error.URLError("down")):
            self.assertIsNone(wiki_client.remote_status(self.root, repo_full_name=_REPO))


class RemoteShowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp())
        _link(self.root)

    def _show(self, slug, *pages):
        with mock.patch("urllib.request.urlopen", return_value=_FakeResponse(_payload(*pages))):
            return wiki_client.remote_show(self.root, slug, repo_full_name=_REPO)

    def test_text_is_byte_identical_to_what_hydration_would_write(self) -> None:
        """`wiki show` output must not depend on whether the clone happens to
        be hydrated — same page, same bytes, both paths."""
        page = _page()
        result = self._show("wiki/overview", page)
        self.assertEqual(result["text"], render_page_text(page))

    def test_found_page_carries_frontmatter_and_body(self) -> None:
        result = self._show("wiki/overview", _page())
        self.assertTrue(result["found"])
        self.assertEqual(result["origin"], "server")
        self.assertIsNone(result["file"])
        self.assertEqual(result["frontmatter"]["citations"], ["README.md"])
        self.assertEqual(result["body"], "# Overview\n\nThis repo builds widgets.")

    def test_missing_slug_is_found_false_with_the_available_slugs(self) -> None:
        """A reachable server that has no such page is NOT an outage. Listing
        what does exist is the whole slug-discovery story for an agent that
        cannot grep for one."""
        result = self._show("wiki/unit/nope", _page(), _page(slug="wiki/unit/core"))
        self.assertFalse(result["found"])
        self.assertEqual(result["slugs"], ["wiki/overview", "wiki/unit/core"])

    def test_outage_returns_none_not_found_false(self) -> None:
        """The two must stay distinguishable: None means fall back to local,
        found=False means report a genuine miss."""
        with mock.patch("urllib.request.urlopen", side_effect=urllib.error.URLError("down")):
            self.assertIsNone(wiki_client.remote_show(self.root, "wiki/overview", repo_full_name=_REPO))


class RankPagesTests(unittest.TestCase):
    def test_title_match_outranks_body_only_match(self) -> None:
        pages = [
            _page(slug="wiki/unit/billing", title="billing", bodyMd="Handles invoices."),
            _page(slug="wiki/unit/core", title="core", bodyMd="Core calls billing sometimes."),
        ]
        results = wiki_client.rank_pages(pages, "billing", limit=5)
        self.assertEqual([r["slug"] for r in results], ["wiki/unit/billing", "wiki/unit/core"])

    def test_stale_page_never_outranks_an_equally_matched_fresh_page(self) -> None:
        pages = [
            _page(slug="wiki/unit/a", title="billing", bodyMd="x", stale=True),
            _page(slug="wiki/unit/b", title="billing", bodyMd="x", stale=False),
        ]
        results = wiki_client.rank_pages(pages, "billing", limit=5)
        self.assertEqual(results[0]["slug"], "wiki/unit/b")
        self.assertTrue(results[1]["stale"])

    def test_non_matching_pages_are_omitted_entirely(self) -> None:
        pages = [_page(slug="wiki/unit/a", title="core", bodyMd="nothing relevant here")]
        self.assertEqual(wiki_client.rank_pages(pages, "billing"), [])

    def test_empty_query_ranks_nothing(self) -> None:
        self.assertEqual(wiki_client.rank_pages([_page()], "   "), [])

    def test_limit_is_honored(self) -> None:
        pages = [_page(slug=f"wiki/unit/{i}", title="billing") for i in range(10)]
        self.assertEqual(len(wiki_client.rank_pages(pages, "billing", limit=3)), 3)

    def test_longest_page_does_not_win_on_repetition_alone(self) -> None:
        """Presence-not-frequency (see rank_pages' docstring): page lengths
        here differ by an order of magnitude, and raw term frequency would
        hand every query to the overview."""
        pages = [
            _page(slug="wiki/unit/short", title="billing", bodyMd="Invoices."),
            _page(slug="wiki/overview", title="overview", bodyMd="billing " * 500),
        ]
        results = wiki_client.rank_pages(pages, "billing", limit=5)
        self.assertEqual(results[0]["slug"], "wiki/unit/short")

    def test_snippet_prefers_a_line_that_mentions_a_matched_term(self) -> None:
        pages = [_page(slug="wiki/unit/a", title="core", bodyMd="# Heading\n\nIntro line.\nRetries use backoff.")]
        results = wiki_client.rank_pages(pages, "retries", limit=1)
        self.assertEqual(results[0]["snippet"], "Retries use backoff.")


class LocalPagesTests(unittest.TestCase):
    def test_nothing_hydrated_is_an_empty_list_not_none(self) -> None:
        """Empty and unavailable are different answers: [] means "I looked
        locally and there is nothing", None means "I could not look"."""
        root = Path(tempfile.mkdtemp())
        self.assertEqual(wiki_client.local_pages(root), [])


if __name__ == "__main__":
    unittest.main()
