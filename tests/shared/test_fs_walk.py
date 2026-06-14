"""
Regression tests for source-tree walking and glob exclusion.

Both behaviors below caused the context index to balloon to ~1.6GB on a pnpm
workspace: nested `node_modules` are symlinks, and the `**/node_modules/**`
exclude glob never matched nested paths, so the walker descended into every
dependency.
"""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from agentrail.shared.fs import _doublestar_regex, glob_to_regex, matches_any, matches_glob, walk_files


class MatchesGlobNestedTest(unittest.TestCase):
    def test_double_star_node_modules_matches_nested_file(self) -> None:
        self.assertTrue(
            matches_glob("**/node_modules/**", "apps/console/node_modules/react/index.js")
        )

    def test_double_star_node_modules_matches_nested_dir(self) -> None:
        self.assertTrue(
            matches_glob("**/node_modules/**", "packages/db/node_modules", is_directory=True)
        )

    def test_literal_prefix_shortcut_still_anchored(self) -> None:
        # A plain `node_modules/**` should still only match at the root, not nested.
        self.assertTrue(matches_glob("node_modules/**", "node_modules/react/index.js"))
        self.assertFalse(matches_glob("node_modules/**", "apps/console/node_modules/react/index.js"))


class WalkFilesSymlinkTest(unittest.TestCase):
    def test_does_not_descend_into_symlinked_directory(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            (root / "src").mkdir()
            (root / "src" / "app.py").write_text("print('hi')\n")

            # A real directory full of "dependencies" that lives outside the tree...
            external = root / "_external"
            external.mkdir()
            (external / "big.js").write_text("x\n")

            # ...exposed inside the tree only via a symlink, like pnpm node_modules.
            os.symlink(external, root / "src" / "node_modules")

            walked = walk_files(root, [])
            rels = {f.relative_path for f in walked if not f.directory}

            self.assertIn("src/app.py", rels)
            self.assertNotIn("src/node_modules/big.js", rels)


class GlobCacheMemoizationTest(unittest.TestCase):
    """AC1 (#686): glob_to_regex and _doublestar_regex are compiled once per distinct glob."""

    def setUp(self) -> None:
        glob_to_regex.cache_clear()
        _doublestar_regex.cache_clear()

    def tearDown(self) -> None:
        glob_to_regex.cache_clear()
        _doublestar_regex.cache_clear()

    def test_glob_to_regex_compiles_once_per_distinct_glob(self) -> None:
        """Calling glob_to_regex N times with the same glob string hits the cache N-1 times."""
        globs = ["**/*.py", "node_modules/**", "*.json"]
        paths = [f"src/module_{i}.py" for i in range(1000)]

        # Simulate walking 1000 paths against a few globs (the hot path in matches_any).
        for path in paths:
            matches_any(globs, path)

        info = glob_to_regex.cache_info()
        # There are 3 distinct globs; one of them ("**/*.py") goes through _doublestar_regex
        # rather than glob_to_regex directly, but the suffix is compiled via glob_to_regex.
        # The important invariant: misses ≤ distinct glob strings, not O(paths).
        distinct_globs = len(set(globs)) + 1  # +1 for the "*.py" suffix of "**/*.py"
        self.assertLessEqual(
            info.misses,
            distinct_globs,
            f"glob_to_regex compiled {info.misses} times; expected ≤ {distinct_globs} "
            f"(distinct globs), not O(paths={len(paths)})",
        )

    def test_doublestar_regex_compiles_once_per_distinct_glob(self) -> None:
        """_doublestar_regex is compiled once per distinct **/-prefixed glob."""
        globs = ["**/*.py", "**/*.ts", "**/*.json"]
        paths = [f"src/deep/module_{i}.py" for i in range(500)]

        for path in paths:
            matches_any(globs, path)

        ds_info = _doublestar_regex.cache_info()
        self.assertLessEqual(
            ds_info.misses,
            len(globs),
            f"_doublestar_regex compiled {ds_info.misses} times; expected ≤ {len(globs)}",
        )
        # Verify hits >> misses: the cache is actually being used across paths.
        self.assertGreater(
            ds_info.hits,
            ds_info.misses * 10,
            f"Cache hit rate too low: hits={ds_info.hits}, misses={ds_info.misses}",
        )


if __name__ == "__main__":
    unittest.main()
