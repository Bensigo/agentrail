"""Tests for the wiki INTEGRATION seam: manifest skeleton/links,
``assemble_wiki_pages`` (the exact ``POST /api/v1/ingest/wiki-pages`` wire
contract), and the hydrate-before-compile / push-after-compile composition
(Repo Wiki spec §4.2/§4.4 —
docs/superpowers/specs/2026-07-23-repo-wiki-compiled-repo-knowledge-design.md).

Distinct from test_wiki.py (the compiler's own unit contract),
test_wiki_push.py and test_wiki_fetch.py (each client's own wire contract in
isolation): this module proves the pieces COMPOSE correctly end to end —
compile -> assemble -> push, and fetch -> compile (hash-diff reuse) — which
is exactly what this integration PR wires together.

No test here touches a real LLM or a real server: prose uses the SAME
custom-command mock test seam as test_wiki.py; the server round trip is
monkeypatched at ``urllib.request.urlopen``, exactly like test_wiki_push.py
/ test_wiki_fetch.py already do.
"""
from __future__ import annotations

import json
import shutil
import tempfile
from pathlib import Path
from typing import Any, Dict

from agentrail.context import wiki, wiki_fetch, wiki_push
from agentrail.context.index import build_index
from agentrail.tests.context.test_wiki import _wiki_on, _write_mock, make_repo

_WIRE_CONTRACT_KEYS = {
    "slug", "title", "kind", "bodyMd", "skeleton", "links",
    "citations", "commitSha", "inputsHash", "model", "writtenBy", "generatedAt",
}


def _compiled_root() -> Path:
    """A fresh two-unit repo (pkg_a depends on pkg_b), already compiled once
    with the mock custom-command prose provider -- the standard fixture
    every test below builds on."""
    mock_dir = Path(tempfile.mkdtemp())
    command = _write_mock(mock_dir)
    root = make_repo(summary_mode="custom-command", summary_command=command)
    with _wiki_on():
        build_index(root)
    return root


def _link(root: Path) -> None:
    d = root / ".agentrail"
    d.mkdir(parents=True, exist_ok=True)
    (d / "server.json").write_text(
        json.dumps({
            "base_url": "http://localhost:3000",
            "workspace_id": "ws",
            "repository_id": "repo-1",
            "api_key": "ar_test",
        })
    )


class _FakeResp:
    """A minimal ``with urlopen(...) as resp`` stand-in (status + JSON body)."""

    def __init__(self, status: int = 200, body: bytes = b"") -> None:
        self.status = status
        self._body = body

    def __enter__(self) -> "_FakeResp":
        return self

    def __exit__(self, *_a: object) -> bool:
        return False

    def read(self) -> bytes:
        return self._body


# ---------------------------------------------------------------------------
# assemble_wiki_pages: the exact POST /api/v1/ingest/wiki-pages contract
# ---------------------------------------------------------------------------


def test_assemble_returns_exactly_the_wire_contract_keys() -> None:
    root = _compiled_root()
    pages, compile_event = wiki.assemble_wiki_pages(root)

    assert len(pages) == 3
    for page in pages:
        assert set(page.keys()) == _WIRE_CONTRACT_KEYS
        assert page["slug"]
        assert page["title"]
        assert page["kind"] in ("overview", "unit")
        assert "## Responsibility" in page["bodyMd"]
        assert not page["bodyMd"].startswith("---"), "bodyMd must be the BODY -- frontmatter already stripped"
        assert page["commitSha"]
        assert page["inputsHash"]
        assert page["writtenBy"] == "wiki-compiler"
        assert page["generatedAt"]

    assert compile_event is not None
    assert set(compile_event.keys()) == {"commitSha", "pagesWritten", "pagesReused", "costUsd", "model", "durationMs"}
    assert compile_event["pagesWritten"] == 3
    assert compile_event["pagesReused"] == 0
    assert compile_event["model"] == "mock-model"


def test_assemble_golden_dict_matches_the_ingest_route_contract_exactly() -> None:
    """A pinned, field-by-field golden dict for one page -- this is the
    EXACT shape apps/console/app/api/v1/ingest/wiki-pages/route.ts's
    isRawWikiPage validates and upsertWikiPages persists."""
    root = _compiled_root()
    pages, _compile_event = wiki.assemble_wiki_pages(root)
    by_slug = {p["slug"]: p for p in pages}
    unit_a = by_slug["wiki/unit/pkg-a"]

    commit_sha = unit_a["commitSha"]
    generated_at = unit_a["generatedAt"]
    assert unit_a == {
        "slug": "wiki/unit/pkg-a",
        "title": "pkg_a — pkg_a",
        "kind": "unit",
        "bodyMd": unit_a["bodyMd"],  # asserted separately below (long, generated)
        "skeleton": {
            "path": "pkg_a",
            "files": ["pkg_a/mod1.py"],
            "exports": ["run_mod1"],
            "dependsOn": ["wiki/unit/pkg-b"],
            "dependedOnBy": [],
        },
        "links": {
            "related": ["wiki/unit/pkg-b", "wiki/overview"],
            "dependsOn": ["wiki/unit/pkg-b"],
            "dependedOnBy": [],
        },
        "citations": ["pkg_a/mod1.py"],
        "commitSha": commit_sha,
        "inputsHash": unit_a["inputsHash"],
        "model": "mock-model",
        "writtenBy": "wiki-compiler",
        "generatedAt": generated_at,
    }
    assert "## Responsibility" in unit_a["bodyMd"]
    assert "Mock responsibility." in unit_a["bodyMd"]


def test_assemble_reflects_reused_pages_on_a_steady_state_second_compile() -> None:
    """The steady-state path every real onboard/index --push run hits after
    the first compile: everything reused, but assemble_wiki_pages must still
    read back the exact same structured shape from the manifest + on-disk
    pages (skeleton/links are recomputed every compile -- see
    _build_unit_skeleton -- even when the .md text itself is reused)."""
    root = _compiled_root()
    with _wiki_on():
        second = build_index(root)
    assert second["wikiReport"]["pagesWritten"] == 0
    assert second["wikiReport"]["pagesReused"] == 3

    pages, compile_event = wiki.assemble_wiki_pages(root)
    by_slug = {p["slug"]: p for p in pages}
    assert set(by_slug) == {"wiki/overview", "wiki/unit/pkg-a", "wiki/unit/pkg-b"}
    assert by_slug["wiki/unit/pkg-a"]["skeleton"]["path"] == "pkg_a"
    assert by_slug["wiki/unit/pkg-a"]["links"]["dependsOn"] == ["wiki/unit/pkg-b"]
    assert compile_event["pagesWritten"] == 0
    assert compile_event["pagesReused"] == 3


def test_assemble_empty_when_nothing_compiled_yet() -> None:
    root = make_repo(summary_mode="disabled")
    pages, compile_event = wiki.assemble_wiki_pages(root)
    assert pages == []
    assert compile_event is None


def test_assemble_is_read_only_never_triggers_a_compile() -> None:
    """Calling assemble_wiki_pages on an uncompiled repo must not create
    .agentrail/context/wiki/ -- it only reads, never compiles."""
    root = make_repo(summary_mode="custom-command", summary_command="true")
    wiki.assemble_wiki_pages(root)
    assert not wiki.wiki_dir_for(root).exists()


# ---------------------------------------------------------------------------
# skeleton.path / skeleton.files / links present per page (wiki-tree.ts's
# exact read contract: skeleton.path, skeleton.files, links.{related,
# dependsOn,dependedOnBy})
# ---------------------------------------------------------------------------


def test_manifest_unit_pages_carry_path_files_exports_and_dependency_slugs() -> None:
    root = _compiled_root()
    manifest = json.loads((wiki.wiki_dir_for(root) / "manifest.json").read_text(encoding="utf-8"))
    by_slug = {p["slug"]: p for p in manifest["pages"]}

    pkg_a, pkg_b = by_slug["wiki/unit/pkg-a"], by_slug["wiki/unit/pkg-b"]

    # skeleton.path / skeleton.files -- the exact keys wiki-tree.ts's
    # deriveUnitPath / deriveFileRoster read.
    assert pkg_a["skeleton"]["path"] == "pkg_a"
    assert pkg_a["skeleton"]["files"] == ["pkg_a/mod1.py"]
    assert pkg_a["skeleton"]["exports"] == ["run_mod1"]
    assert pkg_b["skeleton"]["path"] == "pkg_b"
    assert pkg_b["skeleton"]["files"] == ["pkg_b/helper.py"]

    # unit_depends_on in/out, both in skeleton AND in links, as page slugs.
    assert pkg_a["skeleton"]["dependsOn"] == ["wiki/unit/pkg-b"]
    assert pkg_a["skeleton"]["dependedOnBy"] == []
    assert pkg_b["skeleton"]["dependsOn"] == []
    assert pkg_b["skeleton"]["dependedOnBy"] == ["wiki/unit/pkg-a"]

    assert pkg_a["links"] == {"related": ["wiki/unit/pkg-b", "wiki/overview"], "dependsOn": ["wiki/unit/pkg-b"], "dependedOnBy": []}
    assert pkg_b["links"] == {"related": ["wiki/unit/pkg-a", "wiki/overview"], "dependsOn": [], "dependedOnBy": ["wiki/unit/pkg-a"]}

    # Title present per page too.
    assert pkg_a["title"] == "pkg_a — pkg_a"
    assert pkg_b["title"] == "pkg_b — pkg_b"


def test_manifest_overview_page_carries_unit_roster_and_related_links() -> None:
    root = _compiled_root()
    manifest = json.loads((wiki.wiki_dir_for(root) / "manifest.json").read_text(encoding="utf-8"))
    overview = next(p for p in manifest["pages"] if p["slug"] == "wiki/overview")

    assert sorted(overview["skeleton"]["units"]) == ["pkg_a", "pkg_b"]
    assert overview["skeleton"]["unitCount"] == 2
    assert overview["links"]["related"] == ["wiki/unit/pkg-a", "wiki/unit/pkg-b"]
    assert overview["title"].endswith("— repo overview")


def test_page_md_bytes_unaffected_by_skeleton_links_on_reuse() -> None:
    """AC: 'unchanged pages must still be byte-identical on rebuild (the
    manifest may rewrite, page .md files must not)' -- skeleton/links landed
    in the MANIFEST only; the page markdown's own bytes are untouched."""
    root = _compiled_root()
    page_path = wiki.wiki_dir_for(root) / "unit__pkg-a.md"
    before = page_path.read_text(encoding="utf-8")
    before_mtime = page_path.stat().st_mtime_ns

    with _wiki_on():
        build_index(root)  # second compile: hash-unchanged -> reused

    after = page_path.read_text(encoding="utf-8")
    after_mtime = page_path.stat().st_mtime_ns
    assert before == after
    assert before_mtime == after_mtime
    assert "skeleton" not in before, "skeleton/links are manifest-only, never rendered into the page body"


# ---------------------------------------------------------------------------
# Hydration -> zero regen: a fake server snapshot with unchanged hashes must
# make the subsequent compile write nothing and reuse every page.
# ---------------------------------------------------------------------------


def test_hydrated_pages_with_unchanged_hashes_are_reused_with_zero_regen(monkeypatch) -> None:
    # "Machine 1": a real compile, whose pages/hashes are exactly what a
    # server snapshot for this same commit would contain.
    root = _compiled_root()
    server_pages, _compile_event = wiki.assemble_wiki_pages(root)
    assert len(server_pages) == 3

    # Simulate "machine 2": a fresh checkout of the SAME commit that never
    # compiled locally -- wipe only the local wiki artifacts (the git
    # content/commit, which inputsHash is computed over, stays identical).
    shutil.rmtree(wiki.wiki_dir_for(root))
    assert not wiki.wiki_dir_for(root).exists()
    _link(root)

    captured: Dict[str, Any] = {}

    def fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        return _FakeResp(200, json.dumps({"pages": server_pages}).encode("utf-8"))

    monkeypatch.setattr(wiki_fetch.urllib.request, "urlopen", fake_urlopen)
    ok = wiki_fetch.fetch_wiki_snapshot(root, "acme/widgets", ttl_seconds=0)
    assert ok is True
    assert "acme%2Fwidgets" in captured["url"] or "acme/widgets" in captured["url"]
    assert (wiki.wiki_dir_for(root) / "overview.md").is_file(), "hydration must materialize local page files"

    # The compile on "machine 2": every page's recomputed inputsHash must
    # match what hydration just wrote -> zero regeneration, zero LLM calls.
    with _wiki_on():
        result = build_index(root)
    report = result["wikiReport"]
    assert report["pagesWritten"] == 0, "hydrated pages with unchanged hashes must be reused, not regenerated"
    assert report["pagesReused"] == 3
    assert report["llmCalls"] == 0
    assert report["costUsd"] == 0.0


def test_hydration_alone_never_compiles_or_calls_the_provider(monkeypatch) -> None:
    """fetch_wiki_snapshot itself must never trigger a compile -- it only
    materializes local files; the compile is a separate, later step."""
    root = _compiled_root()
    server_pages, _ = wiki.assemble_wiki_pages(root)
    shutil.rmtree(wiki.wiki_dir_for(root))
    _link(root)

    monkeypatch.setattr(
        wiki_fetch.urllib.request,
        "urlopen",
        lambda req, timeout=None: _FakeResp(200, json.dumps({"pages": server_pages}).encode("utf-8")),
    )
    wiki_fetch.fetch_wiki_snapshot(root, "acme/widgets", ttl_seconds=0)

    # No manifest.json / compile-report.json written by hydration alone --
    # only page .md files + hydration's OWN manifest.json (fetchedAt/pages
    # shape, distinct from the compiler's compiledAt/commitSha/pages shape).
    hydrate_manifest = json.loads((wiki.wiki_dir_for(root) / "manifest.json").read_text(encoding="utf-8"))
    assert "fetchedAt" in hydrate_manifest
    assert "compiledAt" not in hydrate_manifest
    assert not (wiki.wiki_dir_for(root) / "compile-report.json").exists()


# ---------------------------------------------------------------------------
# Push called with a compile event after a real compile (fake transport)
# ---------------------------------------------------------------------------


def test_push_wiki_pages_called_with_compile_event_after_a_real_compile(monkeypatch) -> None:
    root = _compiled_root()
    _link(root)
    pages, compile_event = wiki.assemble_wiki_pages(root)
    assert compile_event is not None

    captured: Dict[str, Any] = {}

    def fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["body"] = json.loads(req.data.decode("utf-8"))
        return _FakeResp(200)

    monkeypatch.setattr(wiki_push.urllib.request, "urlopen", fake_urlopen)
    result = wiki_push.push_wiki_pages(root, "acme/widgets", pages, compile_event)

    assert result is True
    assert captured["url"] == "http://localhost:3000/api/v1/ingest/wiki-pages"
    assert captured["body"]["repoFullName"] == "acme/widgets"
    assert captured["body"]["compileEvent"] == compile_event
    assert len(captured["body"]["pages"]) == 3
    pushed_slugs = {p["slug"] for p in captured["body"]["pages"]}
    assert pushed_slugs == {"wiki/overview", "wiki/unit/pkg-a", "wiki/unit/pkg-b"}
    # Every pushed page is exactly what assemble_wiki_pages produced -- the
    # push layer does no reshaping of its own (wiki_push.py's docstring:
    # "this module does no shaping beyond wrapping them in the request
    # envelope").
    assert captured["body"]["pages"] == pages


def test_push_wiki_pages_skipped_when_custody_switch_off(monkeypatch) -> None:
    root = _compiled_root()
    _link(root)
    (root / ".agentrail" / "config.json").write_text(
        json.dumps({"context": {"summary": {"mode": "custom-command"}, "wiki": {"upload": False}}})
    )
    pages, compile_event = wiki.assemble_wiki_pages(root)

    captured: Dict[str, Any] = {}

    def fake_urlopen(req, timeout=None):
        captured["called"] = True
        return _FakeResp(200)

    monkeypatch.setattr(wiki_push.urllib.request, "urlopen", fake_urlopen)
    result = wiki_push.push_wiki_pages(root, "acme/widgets", pages, compile_event)

    assert result is False
    assert "called" not in captured
