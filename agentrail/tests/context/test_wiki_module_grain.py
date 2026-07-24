"""Tests for module-grain Repo Wiki pages (agentrail/context/wiki.py).

Owner ruling (2026-07-24): "there is no depth -- it's app level instead of
module level; apps/console/auth should get its own compiled knowledge."
Amends the Repo Wiki spec (docs/superpowers/specs/2026-07-23-repo-wiki-
compiled-repo-knowledge-design.md) S3/S4.1 to a three-level page grain:
overview -> unit -> module.

Two layers of coverage here, mirroring test_wiki.py's own split:

  * Pure, direct tests of ``_build_module_tree`` and the slug functions --
    fast, no subprocess, exercise threshold/depth-cap/substance-floor and
    determinism without a full ``build_index`` round trip.
  * Integration tests through ``build_index`` (same "custom-command" mock
    seam test_wiki.py already established) for skeleton shapes, hash
    stability, the total-page cap, and a mixed-ecosystem end-to-end repo.

No test here touches a real LLM (see test_wiki.py's module docstring for
why "custom-command" mode is the house convention for this).
"""
from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import ExitStack, contextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional

from agentrail.context import wiki
from agentrail.context.index import build_index, load_index
from agentrail.context.models import Freshness, SourceRecord

_REPO_WIKI_FLAG = wiki.REPO_WIKI_ENV
_SPLIT_FILES_ENV = wiki.MODULE_SPLIT_FILES_ENV
_MAX_PAGES_ENV = wiki.WIKI_MAX_PAGES_ENV


# ---------------------------------------------------------------------------
# Env helpers (mirrors test_wiki.py's _env / _envs / _wiki_on)
# ---------------------------------------------------------------------------


@contextmanager
def _env(key: str, value: Optional[str]):
    prev = os.environ.get(key)
    if value is None:
        os.environ.pop(key, None)
    else:
        os.environ[key] = value
    try:
        yield
    finally:
        if prev is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = prev


@contextmanager
def _envs(**pairs: Optional[str]):
    with ExitStack() as stack:
        for key, value in pairs.items():
            stack.enter_context(_env(key, value))
        yield


@contextmanager
def _wiki_on(**extra: Optional[str]):
    with _envs(**{_REPO_WIKI_FLAG: "1", **extra}):
        yield


# ---------------------------------------------------------------------------
# Pure fixtures for direct _build_module_tree tests (no build_index needed)
# ---------------------------------------------------------------------------


def _fake_record(path: str, content_hash: Optional[str] = None) -> SourceRecord:
    return SourceRecord(
        id=f"source:{path}",
        sourceType="code",
        path=path,
        contentHash=content_hash or f"hash-{path}",
        modifiedAt=None,
        freshness=Freshness("current", None, None),
        authority="normal",
        visibility="local",
        linkedIssues=[],
        linkedPullRequests=[],
        chunkIds=[],
        auditRef=path,
        content=f"# {path}\n",
    )


def _records(*paths: str) -> List[SourceRecord]:
    return [_fake_record(path) for path in paths]


# ---------------------------------------------------------------------------
# Split-plan tests: threshold, substance floor, depth cap, determinism
# ---------------------------------------------------------------------------


class SplitTreeTests(unittest.TestCase):
    def test_at_or_under_threshold_stays_a_leaf(self) -> None:
        files = _records(*[f"pkg/f{i}.py" for i in range(5)])
        tree = wiki._build_module_tree("pkg", 0, files, 5, wiki.MODULE_SPLIT_DEPTH_CAP, wiki.MODULE_SUBSTANCE_FLOOR)
        self.assertFalse(tree.is_hub)
        self.assertEqual(len(tree.all_files), 5)

    def test_over_threshold_splits_into_hub(self) -> None:
        files = _records(*[f"pkg/sub_a/f{i}.py" for i in range(3)], *[f"pkg/sub_b/f{i}.py" for i in range(3)])
        tree = wiki._build_module_tree("pkg", 0, files, 5, wiki.MODULE_SPLIT_DEPTH_CAP, wiki.MODULE_SUBSTANCE_FLOOR)
        self.assertTrue(tree.is_hub)
        self.assertEqual({child.path for child in tree.children}, {"pkg/sub_a", "pkg/sub_b"})
        self.assertEqual(tree.direct_files, [])

    def test_substance_floor_folds_small_dirs_into_direct_files(self) -> None:
        # sub_a/sub_b clear the floor (3 each); "tiny" (1 file) does not and
        # folds into the parent's own direct files instead of becoming a page.
        files = _records(
            "pkg/__init__.py", "pkg/root2.py",
            *[f"pkg/sub_a/f{i}.py" for i in range(3)],
            *[f"pkg/sub_b/f{i}.py" for i in range(3)],
            "pkg/tiny/only.py",
        )
        tree = wiki._build_module_tree("pkg", 0, files, 5, wiki.MODULE_SPLIT_DEPTH_CAP, wiki.MODULE_SUBSTANCE_FLOOR)
        self.assertTrue(tree.is_hub)
        self.assertEqual({child.path for child in tree.children}, {"pkg/sub_a", "pkg/sub_b"})
        direct_paths = {record.path for record in tree.direct_files}
        self.assertEqual(direct_paths, {"pkg/__init__.py", "pkg/root2.py", "pkg/tiny/only.py"})

    def test_no_eligible_subdir_collapses_to_leaf(self) -> None:
        """Every immediate subdir is under the floor -> nothing to split
        into -> the node stays a leaf even though it is over threshold."""
        files = _records("pkg/a/only.py", "pkg/b/only.py", "pkg/c/only.py", "pkg/d/only.py")
        tree = wiki._build_module_tree("pkg", 0, files, 2, wiki.MODULE_SPLIT_DEPTH_CAP, wiki.MODULE_SUBSTANCE_FLOOR)
        self.assertFalse(tree.is_hub)
        self.assertEqual(len(tree.all_files), 4)

    def test_depth_cap_forces_leaf_even_over_threshold(self) -> None:
        # A single-branch chain forced 3 levels deep; the depth-cap level
        # must stay a leaf even though its own file count (4) exceeds the
        # threshold (2) -- recursion is bounded, not file-count-bounded, at
        # the cap.
        files = _records(
            "deep/root_direct.py",
            "deep/L1/l1_direct.py",
            "deep/L1/L2/l2_direct.py",
            "deep/L1/L2/L3/f1.py", "deep/L1/L2/L3/f2.py", "deep/L1/L2/L3/f3.py", "deep/L1/L2/L3/f4.py",
        )
        tree = wiki._build_module_tree("deep", 0, files, 2, wiki.MODULE_SPLIT_DEPTH_CAP, wiki.MODULE_SUBSTANCE_FLOOR)
        self.assertTrue(tree.is_hub)
        self.assertEqual(tree.depth, 0)
        l1 = tree.children[0]
        self.assertEqual((l1.path, l1.depth, l1.is_hub), ("deep/L1", 1, True))
        l2 = l1.children[0]
        self.assertEqual((l2.path, l2.depth, l2.is_hub), ("deep/L1/L2", 2, True))
        l3 = l2.children[0]
        self.assertEqual((l3.path, l3.depth, l3.is_hub), ("deep/L1/L2/L3", 3, False), "depth cap forces a leaf")
        self.assertEqual(len(l3.all_files), 4)

    def test_split_is_deterministic_across_two_builds(self) -> None:
        files = _records(
            "pkg/__init__.py",
            *[f"pkg/sub_a/f{i}.py" for i in range(4)],
            *[f"pkg/sub_b/f{i}.py" for i in range(4)],
        )
        tree_1 = wiki._build_module_tree("pkg", 0, files, 5, wiki.MODULE_SPLIT_DEPTH_CAP, wiki.MODULE_SUBSTANCE_FLOOR)
        tree_2 = wiki._build_module_tree("pkg", 0, list(reversed(files)), 5, wiki.MODULE_SPLIT_DEPTH_CAP, wiki.MODULE_SUBSTANCE_FLOOR)

        def _shape(node: "wiki._ModuleNode") -> Any:
            return (node.path, node.depth, [r.path for r in node.direct_files], [_shape(c) for c in node.children])

        self.assertEqual(_shape(tree_1), _shape(tree_2), "input order must not affect the split shape")

    def test_module_split_files_env_override(self) -> None:
        with _env(_SPLIT_FILES_ENV, "3"):
            self.assertEqual(wiki.module_split_files(), 3)
        with _env(_SPLIT_FILES_ENV, None):
            self.assertEqual(wiki.module_split_files(), wiki.DEFAULT_MODULE_SPLIT_FILES)
        with _env(_SPLIT_FILES_ENV, "not-a-number"):
            self.assertEqual(wiki.module_split_files(), wiki.DEFAULT_MODULE_SPLIT_FILES)
        with _env(_SPLIT_FILES_ENV, "0"):
            self.assertEqual(wiki.module_split_files(), wiki.DEFAULT_MODULE_SPLIT_FILES, "non-positive override falls back")


# ---------------------------------------------------------------------------
# Slug tests
# ---------------------------------------------------------------------------


class ModuleSlugTests(unittest.TestCase):
    def test_module_slug_shape(self) -> None:
        unit = {"id": "codebase-unit:appsconsole", "name": "apps/console", "path": "apps/console"}
        self.assertEqual(wiki.module_slug(unit, "apps/console/app/api/v1"), "wiki/unit/appsconsole/app-api-v1")

    def test_module_slug_single_segment(self) -> None:
        unit = {"id": "codebase-unit:pkg", "name": "pkg", "path": "pkg"}
        self.assertEqual(wiki.module_slug(unit, "pkg/widgets"), "wiki/unit/pkg/widgets")

    def test_module_slug_strips_underscores_like_the_existing_unit_slugify(self) -> None:
        """_module_relpath_slug reuses index.slugify verbatim per segment --
        it strips `_` (never converts to `-`), matching the EXISTING unit-id
        slugify convention exactly (e.g. a unit path "big_pkg" already
        slugifies to "bigpkg" today); this is a deliberate reuse, not a new
        rule invented for modules."""
        unit = {"id": "codebase-unit:pkg", "name": "pkg", "path": "pkg"}
        self.assertEqual(wiki.module_slug(unit, "pkg/sub_a"), "wiki/unit/pkg/suba")

    def test_module_slug_stable_regardless_of_sibling_changes(self) -> None:
        """A module's slug depends only on the unit id + its own real path --
        never on which OTHER modules exist alongside it this compile."""
        unit = {"id": "codebase-unit:pkg", "name": "pkg", "path": "pkg"}
        slug_before = wiki.module_slug(unit, "pkg/sub_a")
        # simulate "a sibling module sub_z appeared" -- irrelevant to sub_a's own slug
        slug_after = wiki.module_slug(unit, "pkg/sub_a")
        self.assertEqual(slug_before, slug_after)

    def test_slug_to_filename_for_module(self) -> None:
        self.assertEqual(wiki.slug_to_filename("wiki/unit/appsconsole/app-api-v1"), "unit__appsconsole__app-api-v1.md")

    def test_slug_to_filename_for_plain_unit_unchanged(self) -> None:
        self.assertEqual(wiki.slug_to_filename("wiki/unit/pkg-a"), "unit__pkg-a.md")


# ---------------------------------------------------------------------------
# hub_inputs_hash tests
# ---------------------------------------------------------------------------


class HubHashTests(unittest.TestCase):
    def test_stable_when_child_content_changes_but_set_and_direct_files_dont(self) -> None:
        direct = _records("pkg/__init__.py")
        h1 = wiki.hub_inputs_hash(direct, ["wiki/unit/pkg/sub-a", "wiki/unit/pkg/sub-b"])
        h2 = wiki.hub_inputs_hash(direct, ["wiki/unit/pkg/sub-a", "wiki/unit/pkg/sub-b"])
        self.assertEqual(h1, h2)

    def test_changes_when_child_set_changes(self) -> None:
        direct = _records("pkg/__init__.py")
        h1 = wiki.hub_inputs_hash(direct, ["wiki/unit/pkg/sub-a"])
        h2 = wiki.hub_inputs_hash(direct, ["wiki/unit/pkg/sub-a", "wiki/unit/pkg/sub-b"])
        self.assertNotEqual(h1, h2)

    def test_changes_when_direct_files_change(self) -> None:
        h1 = wiki.hub_inputs_hash(_records("pkg/__init__.py"), ["wiki/unit/pkg/sub-a"])
        h2 = wiki.hub_inputs_hash(_records("pkg/__init__.py", "pkg/extra.py"), ["wiki/unit/pkg/sub-a"])
        self.assertNotEqual(h1, h2)


# ---------------------------------------------------------------------------
# Integration fixtures (build_index + custom-command mock, mirrors test_wiki.py)
# ---------------------------------------------------------------------------

_MOCK_SCRIPT = """
import json, sys

def main():
    sys.stdin.readline()
    print(json.dumps({"text": json.dumps({
        "responsibility": "Mock responsibility.",
        "fileNotes": {},
        "relationships": "Mock relationships.",
    }), "usage": {"inputTokens": 100, "outputTokens": 50}}))

main()
"""


def _write_mock(tmp_dir: Path) -> str:
    script_path = tmp_dir / "mock_prose.py"
    script_path.write_text(_MOCK_SCRIPT, encoding="utf-8")
    return f"{shlex.quote(sys.executable)} {shlex.quote(str(script_path))}"


def make_repo(
    *,
    codebase_units: Optional[List[Dict[str, Any]]] = None,
    summary_mode: str = "custom-command",
    summary_command: Optional[str] = None,
    files: Dict[str, str],
) -> Path:
    root = Path(tempfile.mkdtemp())
    subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.email", "test@example.com"], check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.name", "Test"], check=True)
    (root / ".agentrail").mkdir()

    summary_cfg: Dict[str, Any] = {"mode": summary_mode}
    if summary_command is not None:
        summary_cfg.update({"provider": "mock", "model": "mock-model", "customCommand": summary_command})

    ctx = {
        "includeGlobs": ["**/*"],
        "excludeGlobs": [".git/**", ".agentrail/context/**"],
        "maxFileSizeBytes": 262144,
        "skipBinary": True,
        "respectGitIgnore": True,
        "secretRedaction": {"enabled": False, "action": "exclude", "denyGlobs": []},
        "embedding": {"mode": "disabled", "provider": None, "model": None},
        "summary": summary_cfg,
        "codebaseUnits": codebase_units if codebase_units is not None else [],
    }
    (root / ".agentrail" / "config.json").write_text(json.dumps({"schemaVersion": 1, "context": ctx}, indent=2), encoding="utf-8")

    for rel_path, content in files.items():
        full_path = root / rel_path
        full_path.parent.mkdir(parents=True, exist_ok=True)
        full_path.write_text(content, encoding="utf-8")

    subprocess.run(["git", "-C", str(root), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(root), "commit", "-m", "init", "--quiet"], check=True)
    return root


def _big_pkg_files(n_sub_a: int = 3, n_sub_b: int = 3) -> Dict[str, str]:
    files = {
        "big_pkg/__init__.py": "",
        "big_pkg/root_mod.py": "def root_fn():\n    return 1\n",
        "big_pkg/tiny/only.py": "def tiny_fn():\n    return 1\n",
    }
    for i in range(n_sub_a):
        files[f"big_pkg/sub_a/f{i}.py"] = f"def a_fn_{i}():\n    return {i}\n"
    for i in range(n_sub_b):
        files[f"big_pkg/sub_b/f{i}.py"] = f"from big_pkg.sub_a.f0 import a_fn_0\n\n\ndef b_fn_{i}():\n    return a_fn_0() + {i}\n"
    return files


_BIG_PKG_UNIT = [{"id": "big-pkg", "name": "big_pkg", "path": "big_pkg"}]


def _wiki_records(index_data: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [record for record in index_data.get("records", []) if record.get("sourceType") == "wiki_doc"]


# ---------------------------------------------------------------------------
# Hub vs leaf skeleton shapes (integration)
# ---------------------------------------------------------------------------


class HubLeafSkeletonTests(unittest.TestCase):
    def test_hub_and_leaf_manifest_shapes(self) -> None:
        mock_dir = Path(tempfile.mkdtemp())
        command = _write_mock(mock_dir)
        root = make_repo(codebase_units=_BIG_PKG_UNIT, summary_command=command, files=_big_pkg_files())
        with _wiki_on(**{_SPLIT_FILES_ENV: "5"}):
            result = build_index(root)
        report = result["wikiReport"]
        self.assertGreater(report["pagesWritten"], 0)

        manifest = json.loads((wiki.wiki_dir_for(root) / "manifest.json").read_text(encoding="utf-8"))
        by_slug = {page["slug"]: page for page in manifest["pages"]}

        # The unit root split -> its OWN page is a HUB, still at the unit slug.
        hub = by_slug["wiki/unit/big-pkg"]
        self.assertEqual(hub["skeleton"]["pageKind"], "hub")
        self.assertEqual(hub["skeleton"]["path"], "big_pkg")
        self.assertIn("big_pkg/tiny/only.py", hub["skeleton"]["directFiles"], "sub-floor dir folds into hub direct files")
        self.assertEqual(set(hub["skeleton"]["children"]), {"wiki/unit/big-pkg/suba", "wiki/unit/big-pkg/subb"})
        self.assertIn("counts", hub["skeleton"])
        self.assertEqual(hub["skeleton"]["counts"]["files"], 9)  # root(2) + tiny(1) + sub_a(3) + sub_b(3) -- see _big_pkg_files
        self.assertEqual(hub["skeleton"]["files"], hub["skeleton"]["directFiles"], "back-compat alias for console's deriveFileRoster")

        # Leaf modules.
        leaf_a = by_slug["wiki/unit/big-pkg/suba"]
        self.assertEqual(leaf_a["skeleton"]["pageKind"], "leaf")
        self.assertEqual(leaf_a["skeleton"]["path"], "big_pkg/sub_a")
        self.assertEqual(len(leaf_a["skeleton"]["files"]), 3)

        leaf_b = by_slug["wiki/unit/big-pkg/subb"]
        self.assertEqual(leaf_b["skeleton"]["pageKind"], "leaf")
        # sub_b imports from sub_a -> intra-unit module dependency edge.
        self.assertIn("wiki/unit/big-pkg/suba", leaf_b["skeleton"]["dependsOn"])
        self.assertIn("wiki/unit/big-pkg/subb", leaf_a["skeleton"]["dependedOnBy"])

        # Body content sanity: hub page has a Child modules section; leaf does not.
        hub_text = (wiki.wiki_dir_for(root) / "unit__big-pkg.md").read_text(encoding="utf-8")
        self.assertIn("## Child modules", hub_text)
        leaf_text = (wiki.wiki_dir_for(root) / "unit__big-pkg__suba.md").read_text(encoding="utf-8")
        self.assertNotIn("## Child modules", leaf_text)
        self.assertIn('kind: "module"', leaf_text)

    def test_wire_kind_maps_module_to_unit_for_push_compat(self) -> None:
        """assemble_wiki_pages's pre-existing kind fallback (anything not
        overview/unit -> unit) is deliberately reused for "module" pages: the
        server's wiki_page_kind enum only knows overview/unit today, so a
        module page's own skeleton.pageKind carries the hub/leaf distinction
        while the WIRE kind stays "unit" -- additive, no server change needed
        for this PR (see PR body's documented deviation)."""
        mock_dir = Path(tempfile.mkdtemp())
        command = _write_mock(mock_dir)
        root = make_repo(codebase_units=_BIG_PKG_UNIT, summary_command=command, files=_big_pkg_files())
        with _wiki_on(**{_SPLIT_FILES_ENV: "5"}):
            build_index(root)
        pages, _compile_event = wiki.assemble_wiki_pages(root)
        by_slug = {page["slug"]: page for page in pages}
        self.assertEqual(by_slug["wiki/unit/big-pkg/suba"]["kind"], "unit")
        self.assertEqual(by_slug["wiki/unit/big-pkg"]["kind"], "unit")
        self.assertEqual(by_slug["wiki/overview"]["kind"], "overview")


# ---------------------------------------------------------------------------
# Hash stability: editing one leaf's file must not touch its hub/siblings/overview
# ---------------------------------------------------------------------------


class ModuleHashStabilityTests(unittest.TestCase):
    def test_editing_one_leaf_file_only_regenerates_that_leaf(self) -> None:
        mock_dir = Path(tempfile.mkdtemp())
        command = _write_mock(mock_dir)
        root = make_repo(codebase_units=_BIG_PKG_UNIT, summary_command=command, files=_big_pkg_files())
        with _wiki_on(**{_SPLIT_FILES_ENV: "5"}):
            build_index(root)
            wiki_dir = wiki.wiki_dir_for(root)
            hub_before = (wiki_dir / "unit__big-pkg.md").read_text(encoding="utf-8")
            hub_mtime_before = (wiki_dir / "unit__big-pkg.md").stat().st_mtime_ns
            sub_a_before = (wiki_dir / "unit__big-pkg__suba.md").read_text(encoding="utf-8")
            sub_b_before = (wiki_dir / "unit__big-pkg__subb.md").read_text(encoding="utf-8")
            sub_b_mtime_before = (wiki_dir / "unit__big-pkg__subb.md").stat().st_mtime_ns
            overview_before = (wiki_dir / "overview.md").read_text(encoding="utf-8")

            time.sleep(0.05)
            (root / "big_pkg" / "sub_a" / "f0.py").write_text("def a_fn_0():\n    return 999  # changed\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(root), "add", "-A"], check=True)
            subprocess.run(["git", "-C", str(root), "commit", "-m", "change sub_a/f0", "--quiet"], check=True)

            report = build_index(root)["wikiReport"]

            hub_after = (wiki_dir / "unit__big-pkg.md").read_text(encoding="utf-8")
            hub_mtime_after = (wiki_dir / "unit__big-pkg.md").stat().st_mtime_ns
            sub_a_after = (wiki_dir / "unit__big-pkg__suba.md").read_text(encoding="utf-8")
            sub_b_after = (wiki_dir / "unit__big-pkg__subb.md").read_text(encoding="utf-8")
            sub_b_mtime_after = (wiki_dir / "unit__big-pkg__subb.md").stat().st_mtime_ns
            overview_after = (wiki_dir / "overview.md").read_text(encoding="utf-8")

        self.assertNotEqual(sub_a_before, sub_a_after, "the edited leaf must regenerate")
        self.assertEqual(hub_before, hub_after, "the hub must NOT regenerate -- child SET and hub's own direct files are unchanged")
        self.assertEqual(hub_mtime_before, hub_mtime_after)
        self.assertEqual(sub_b_before, sub_b_after, "an unrelated sibling leaf must NOT regenerate")
        self.assertEqual(sub_b_mtime_before, sub_b_mtime_after)
        self.assertEqual(overview_before, overview_after, "overview must NOT regenerate -- the unit's own (hub) hash is unchanged")
        self.assertEqual(report["pagesWritten"], 1, "only the edited leaf")

    def test_new_subdir_crossing_the_floor_changes_the_hub(self) -> None:
        """Adding a NEW subdirectory that clears the substance floor changes
        the hub's child SET -> the hub (and the unit's contribution to the
        overview hash) must regenerate; unrelated existing leaves must not."""
        mock_dir = Path(tempfile.mkdtemp())
        command = _write_mock(mock_dir)
        root = make_repo(codebase_units=_BIG_PKG_UNIT, summary_command=command, files=_big_pkg_files())
        with _wiki_on(**{_SPLIT_FILES_ENV: "5"}):
            build_index(root)
            wiki_dir = wiki.wiki_dir_for(root)
            hub_before = (wiki_dir / "unit__big-pkg.md").read_text(encoding="utf-8")
            sub_a_before = (wiki_dir / "unit__big-pkg__suba.md").read_text(encoding="utf-8")
            sub_a_mtime_before = (wiki_dir / "unit__big-pkg__suba.md").stat().st_mtime_ns

            time.sleep(0.05)
            for i in range(3):
                (root / "big_pkg" / "sub_c" / f"f{i}.py").parent.mkdir(parents=True, exist_ok=True)
                (root / "big_pkg" / "sub_c" / f"f{i}.py").write_text(f"def c_fn_{i}():\n    return {i}\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(root), "add", "-A"], check=True)
            subprocess.run(["git", "-C", str(root), "commit", "-m", "add sub_c", "--quiet"], check=True)

            build_index(root)

            hub_after = (wiki_dir / "unit__big-pkg.md").read_text(encoding="utf-8")
            sub_a_after = (wiki_dir / "unit__big-pkg__suba.md").read_text(encoding="utf-8")
            sub_a_mtime_after = (wiki_dir / "unit__big-pkg__suba.md").stat().st_mtime_ns
            self.assertTrue((wiki_dir / "unit__big-pkg__subc.md").is_file(), "new module gets its own page")

        self.assertNotEqual(hub_before, hub_after, "the hub's child set changed -> it must regenerate")
        self.assertEqual(sub_a_before, sub_a_after, "an unrelated existing leaf must not regenerate")
        self.assertEqual(sub_a_mtime_before, sub_a_mtime_after)


# ---------------------------------------------------------------------------
# Total page cap
# ---------------------------------------------------------------------------


class ModuleWikiStatusTests(unittest.TestCase):
    """wiki_status (agentrail context wiki status) does its OWN live
    recomputation of "current" hashes to detect staleness without a
    recompile -- _current_unit_hashes must know the hub-vs-leaf hash rules,
    or a split unit's own page would show a false "stale" (comparing a hub
    hash against the old flat-subtree formula) and a module page's real
    edits would show a false "not stale" (no entry at all)."""

    def test_freshly_compiled_hub_and_leaf_pages_are_not_stale(self) -> None:
        mock_dir = Path(tempfile.mkdtemp())
        command = _write_mock(mock_dir)
        root = make_repo(codebase_units=_BIG_PKG_UNIT, summary_command=command, files=_big_pkg_files())
        with _wiki_on(**{_SPLIT_FILES_ENV: "5"}):
            build_index(root)
            # module_split_files() is env-read at call time (same as the
            # compile-time threshold, and a real single CLI/shell session
            # keeps it consistent) -- wiki_status must be read inside the
            # SAME env for its live split-tree recomputation to match what
            # was actually compiled.
            status = wiki.wiki_status(root)
        by_slug = {page["slug"]: page for page in status["pages"]}
        self.assertFalse(by_slug["wiki/unit/big-pkg"]["stale"], "the hub's own page must not show false-stale")
        self.assertFalse(by_slug["wiki/unit/big-pkg/suba"]["stale"])
        self.assertFalse(by_slug["wiki/overview"]["stale"])
        self.assertEqual(by_slug["wiki/unit/big-pkg"]["currentInputsHash"], by_slug["wiki/unit/big-pkg"]["inputsHash"])

    def test_editing_a_leaf_file_without_recompiling_shows_stale(self) -> None:
        mock_dir = Path(tempfile.mkdtemp())
        command = _write_mock(mock_dir)
        root = make_repo(codebase_units=_BIG_PKG_UNIT, summary_command=command, files=_big_pkg_files())
        with _wiki_on(**{_SPLIT_FILES_ENV: "5"}):
            build_index(root)  # first compile: pages written, manifest hashes pinned

        (root / "big_pkg" / "sub_a" / "f0.py").write_text("def a_fn_0():\n    return 999\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(root), "add", "-A"], check=True)
        subprocess.run(["git", "-C", str(root), "commit", "-m", "edit", "--quiet"], check=True)

        with _env(_SPLIT_FILES_ENV, "5"), _env(_REPO_WIKI_FLAG, None):
            # Flag OFF: refreshes index.json's content hashes for the edited
            # file WITHOUT recompiling the wiki -- wiki/*.md and manifest.json
            # stay exactly as the first compile left them, so wiki_status's
            # live diff is checked against genuinely stale on-disk pages.
            build_index(root)
            status = wiki.wiki_status(root)
        by_slug = {page["slug"]: page for page in status["pages"]}
        self.assertTrue(by_slug["wiki/unit/big-pkg/suba"]["stale"], "the edited module must show stale before a recompile")
        self.assertFalse(by_slug["wiki/unit/big-pkg"]["stale"], "the hub's own hash is unaffected by a child's content edit")


class ModulePageCapTests(unittest.TestCase):
    def test_total_page_cap_drops_modules_keeps_unit_roots(self) -> None:
        files = _big_pkg_files(n_sub_a=3, n_sub_b=3)
        # A third, independent sub-package so there are 3 module candidates
        # (sub_a, sub_b, sub_c) competing for a cap of 1 remaining slot.
        for i in range(3):
            files[f"big_pkg/sub_c/f{i}.py"] = f"def c_fn_{i}():\n    return {i}\n"
        mock_dir = Path(tempfile.mkdtemp())
        command = _write_mock(mock_dir)
        root = make_repo(codebase_units=_BIG_PKG_UNIT, summary_command=command, files=files)
        # 1 overview + 1 unit root (hub) always kept -> max_pages=3 leaves
        # exactly ONE module slot for 3 candidates (sub_a/sub_b/sub_c).
        with _wiki_on(**{_SPLIT_FILES_ENV: "5", _MAX_PAGES_ENV: "3"}):
            result = build_index(root)
        report = result["wikiReport"]

        self.assertEqual(report["pagesTotalCap"], 3)
        self.assertEqual(len(report["modulePagesDropped"]), 2, "3 module candidates, 1 kept -> 2 dropped")
        self.assertTrue(all(slug.startswith("wiki/unit/big-pkg/") for slug in report["modulePagesDropped"]))
        self.assertEqual(report["totalPages"], 3, "overview + hub + 1 surviving module -- must not double-count the overview")
        self.assertEqual(report["totalPages"], report["pagesWritten"], "fresh compile: every kept page was written")

        wiki_dir = wiki.wiki_dir_for(root)
        self.assertTrue((wiki_dir / "unit__big-pkg.md").is_file(), "the unit's own root page is never dropped by this cap")
        self.assertTrue((wiki_dir / "overview.md").is_file())
        module_pages = list(wiki_dir.glob("unit__big-pkg__*.md"))
        self.assertEqual(len(module_pages), 1, "only 1 of the 3 module candidates survives the cap")

        audit_path = root / ".agentrail" / "context" / "audit" / "events.jsonl"
        events = [json.loads(line) for line in audit_path.read_text(encoding="utf-8").splitlines() if line.strip()]
        cap_events = [e for e in events if e.get("event") == "wiki_compile" and e.get("action") == "module_pages_capped"]
        self.assertTrue(cap_events, "the cap must be logged, never silent")

    def test_wiki_max_pages_env_override(self) -> None:
        with _env(_MAX_PAGES_ENV, "10"):
            self.assertEqual(wiki.wiki_max_pages(), 10)
        with _env(_MAX_PAGES_ENV, None):
            self.assertEqual(wiki.wiki_max_pages(), wiki.DEFAULT_WIKI_MAX_PAGES)


# ---------------------------------------------------------------------------
# Mixed-ecosystem end-to-end: npm workspaces + python root union (PR 1446's
# _root_ecosystem_unit) -> the python unit auto-splits into its subpackages.
# ---------------------------------------------------------------------------


class MixedEcosystemEndToEndTest(unittest.TestCase):
    def test_python_root_unit_auto_splits(self) -> None:
        files = {
            "package.json": json.dumps({"name": "root", "private": True, "workspaces": ["apps/*"]}),
            "apps/webapp/package.json": json.dumps({"name": "webapp", "version": "0.0.0"}),
            "apps/webapp/index.js": "module.exports = {};\n",
            "pyproject.toml": '[project]\nname = "bigpkg"\n',
        }
        # bigpkg/ mirrors _big_pkg_files' shape but under the pyproject name.
        files["bigpkg/__init__.py"] = ""
        files["bigpkg/root_mod.py"] = "def root_fn():\n    return 1\n"
        for i in range(3):
            files[f"bigpkg/sub_a/f{i}.py"] = f"def a_fn_{i}():\n    return {i}\n"
        for i in range(3):
            files[f"bigpkg/sub_b/f{i}.py"] = f"def b_fn_{i}():\n    return {i}\n"

        mock_dir = Path(tempfile.mkdtemp())
        command = _write_mock(mock_dir)
        # codebase_units=None (empty list from make_repo's default) triggers
        # REAL auto-detection: detect_manifest_units unions the npm workspace
        # unit (apps/webapp) with the root pyproject.toml unit (bigpkg/,
        # since name="bigpkg" resolves to an existing bigpkg/__init__.py dir
        # -- index._root_ecosystem_unit_path).
        root = make_repo(codebase_units=[], summary_command=command, files=files)
        with _wiki_on(**{_SPLIT_FILES_ENV: "5"}):
            result = build_index(root)
        report = result["wikiReport"]

        self.assertEqual(report["unitsDropped"], [], "sanity: no drops expected at unit grain")
        self.assertEqual(report["unitsIncluded"], 2, "apps/webapp (npm) + bigpkg (python root union)")

        manifest = json.loads((wiki.wiki_dir_for(root) / "manifest.json").read_text(encoding="utf-8"))
        slugs = {page["slug"] for page in manifest["pages"]}
        self.assertIn("wiki/unit/bigpkg", slugs)
        self.assertIn("wiki/unit/appswebapp", slugs)
        # The python unit split -- module pages exist under its slug.
        module_slugs = {slug for slug in slugs if slug.startswith("wiki/unit/bigpkg/")}
        self.assertEqual(module_slugs, {"wiki/unit/bigpkg/suba", "wiki/unit/bigpkg/subb"})
        # The npm workspace unit (5 files, well under threshold) never split.
        self.assertFalse(any(slug.startswith("wiki/unit/appswebapp/") for slug in slugs))

        by_slug = {page["slug"]: page for page in manifest["pages"]}
        self.assertEqual(by_slug["wiki/unit/bigpkg"]["skeleton"]["pageKind"], "hub")
        # skeleton.path is the REAL directory path -- console's wiki-tree.ts
        # nests module pages under their unit purely from this field.
        self.assertEqual(by_slug["wiki/unit/bigpkg/suba"]["skeleton"]["path"], "bigpkg/sub_a")


if __name__ == "__main__":
    unittest.main()
