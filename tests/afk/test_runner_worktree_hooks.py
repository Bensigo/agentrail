"""#519: _setup_worktree seeds the context-first hook into AFK worktrees.

Verifies the hook script + .claude/settings.json are copied from the main
checkout into the worktree (copy-if-absent), and that .agentrail/tmp/ is NOT
seeded so fresh worktrees start unmarked.
"""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agentrail.afk.runner import Runner
from agentrail.afk.state import AfkState, Store


def _make_runner(tmp_path: Path) -> Runner:
    target = tmp_path / "main"
    target.mkdir()
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    store = Store(AfkState(concurrency=1, max_retries=1, max_review_rounds=1, slots={0: None}))
    return Runner(
        target=target, engine="claude", base="main", concurrency=1,
        afk_label="afk", queue_labels=["ready"], run_dir=run_dir, store=store,
    )


class SetupWorktreeHooksTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.tmp = Path(self.td.name)
        self.runner = _make_runner(self.tmp)
        # Seed the main checkout as a fully-installed target.
        ar = self.runner.target / ".agentrail"
        (ar / "hooks").mkdir(parents=True)
        (ar / "hooks" / "context-first.sh").write_text("#!/usr/bin/env bash\nexit 0\n")
        (ar).joinpath("state.json").write_text("{}")
        (self.runner.target / ".claude").mkdir()
        (self.runner.target / ".claude" / "settings.json").write_text(
            '{"hooks":{"PreToolUse":[]}}'
        )
        # Pretend the marker already exists in the main checkout (must NOT propagate).
        (ar / "tmp").mkdir()
        (ar / "tmp" / "context-queried").touch()

    def tearDown(self):
        self.td.cleanup()

    def _setup(self) -> Path:
        wt = self.tmp / "wt"
        wt.mkdir()
        # Skip the git fetch/worktree-add subprocesses; only exercise the seeding.
        with patch("agentrail.afk.runner.subprocess.run"):
            self.runner._setup_worktree(wt, "origin/main")
        return wt

    def test_hook_seeded_and_executable(self):
        wt = self._setup()
        hook = wt / ".agentrail" / "hooks" / "context-first.sh"
        self.assertTrue(hook.exists())
        self.assertTrue(os.access(hook, os.X_OK))

    def test_settings_seeded(self):
        wt = self._setup()
        self.assertTrue((wt / ".claude" / "settings.json").exists())

    def test_tmp_marker_not_seeded(self):
        wt = self._setup()
        self.assertFalse((wt / ".agentrail" / "tmp" / "context-queried").exists())

    def test_existing_worktree_files_not_clobbered(self):
        wt = self.tmp / "wt"
        wt.mkdir()
        (wt / ".claude").mkdir()
        (wt / ".claude" / "settings.json").write_text('{"local":"keep"}')
        with patch("agentrail.afk.runner.subprocess.run"):
            self.runner._setup_worktree(wt, "origin/main")
        self.assertIn("keep", (wt / ".claude" / "settings.json").read_text())


if __name__ == "__main__":
    unittest.main()
