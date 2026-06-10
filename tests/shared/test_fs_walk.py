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

from agentrail.shared.fs import matches_glob, walk_files


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


if __name__ == "__main__":
    unittest.main()
