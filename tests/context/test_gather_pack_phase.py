"""Tests for the gather phase in the pack builder (issue #1049, PR A).

Covers:
- build_context_pack accepts target_kind="issue", phase="gather" (no raise).
- Unknown phases and pr+non-review phases still raise RuntimeError.
- run_id-pinned pack ids are deterministic (identical across builds, no
  timestamp slug component); without run_id the timestamp slug is unchanged.
- "gather" participates in the goal-relevance phase gate like "plan".

Behavior-neutral guarantee: nothing in the pipeline passes phase="gather"
or run_id yet, so these tests exercise only the new inert surface.
"""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from agentrail.context.index import build_index
from agentrail.context.packs import (
    _goal_relevant,
    _pack_slug,
    _run_id_slug,
    build_context_pack,
)


def _make_repo() -> Path:
    """Minimal git repo fixture suitable for build_context_pack tests."""
    root = Path(tempfile.mkdtemp())
    subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
    (root / ".agentrail").mkdir()
    (root / ".agentrail" / "config.json").write_text(
        json.dumps({
            "schemaVersion": 1,
            "context": {
                "includeGlobs": ["**/*"],
                "excludeGlobs": [
                    ".git/**", ".agentrail/context/**", ".agentrail/source/**",
                    ".env", ".env.*", "**/.env", "**/.env.*",
                    "**/*.pem", "**/*.key", "**/*credentials*", "**/*secret*",
                ],
                "maxFileSizeBytes": 262144,
                "skipBinary": True,
                "respectGitIgnore": True,
                "secretRedaction": {
                    "enabled": True, "action": "exclude",
                    "denyGlobs": [".env", ".env.*", "**/.env"],
                },
                "embedding": {"mode": "disabled", "provider": None, "model": None},
                "summary": {"mode": "disabled", "provider": None, "model": None},
            },
        }, indent=2),
        encoding="utf-8",
    )
    (root / ".agentrail" / "state.json").write_text(
        json.dumps({"workflow": {"activeIssue": 9, "activePhase": "plan", "goals": []}}),
        encoding="utf-8",
    )
    (root / "CONTEXT.md").write_text(
        "# Context\n\nIssue #9 context for gather phase tests.\n",
        encoding="utf-8",
    )
    (root / "TASTE.md").write_text(
        "# Taste\n\nEvidence over claims for issue #9.\n",
        encoding="utf-8",
    )
    (root / "src").mkdir()
    (root / "src" / "module.py").write_text(
        "# module for issue #9\ndef gather_target():\n    return 9\n",
        encoding="utf-8",
    )
    subprocess.run(["git", "-C", str(root), "config", "user.email", "test@example.com"], check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.name", "Test"], check=True)
    subprocess.run(["git", "-C", str(root), "add", "."], check=True)
    subprocess.run(["git", "-C", str(root), "commit", "--quiet", "-m", "init"], check=True)
    build_index(root)
    return root


class GatherPhaseWhitelistTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.root = _make_repo()

    def test_issue_gather_phase_builds_a_pack(self) -> None:
        """phase='gather' is accepted for issues and returns a pack dict."""
        pack = build_context_pack(self.root, "issue", 9, "gather")
        self.assertIsInstance(pack, dict)
        self.assertEqual(pack["target"], {"kind": "issue", "number": 9, "phase": "gather"})
        self.assertIn("packId", pack)
        self.assertTrue((self.root / pack["jsonPath"]).exists())

    def test_unknown_issue_phase_still_raises(self) -> None:
        with self.assertRaises(RuntimeError):
            build_context_pack(self.root, "issue", 9, "bogus")

    def test_pr_non_review_phase_still_raises(self) -> None:
        with self.assertRaises(RuntimeError):
            build_context_pack(self.root, "pr", 9, "gather")


class RunPinnedPackIdTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.root = _make_repo()

    def test_run_id_pack_id_is_deterministic_across_builds(self) -> None:
        run_id = "20260707-010101-issue-9-claude-123"
        first = build_context_pack(self.root, "issue", 9, "gather", run_id=run_id)
        second = build_context_pack(self.root, "issue", 9, "gather", run_id=run_id)
        self.assertEqual(first["packId"], second["packId"])
        self.assertEqual(first["jsonPath"], second["jsonPath"])
        self.assertEqual(
            first["packId"],
            f"issue-9-gather-{_run_id_slug(run_id)}",
        )
        # No timestamp-slug component: the id must not embed the pack's own
        # generatedAt slug (which differs per build anyway — determinism above
        # already proves it, this pins the shape).
        self.assertNotIn(_pack_slug(first["generatedAt"]), first["packId"])
        self.assertNotIn(_pack_slug(second["generatedAt"]), second["packId"])

    def test_run_id_slug_is_filesystem_safe(self) -> None:
        slug = _run_id_slug("20260707-010101-Issue #9/Claude:123")
        self.assertTrue(slug)
        self.assertTrue(all(ch.isalnum() and ch.islower() or ch == "-" for ch in slug if not ch.isdigit()))
        self.assertNotIn("--", slug)
        self.assertFalse(slug.startswith("-") or slug.endswith("-"))

    def test_without_run_id_pack_id_uses_timestamp_slug(self) -> None:
        """No run_id (all current callers): pack_id keeps the timestamp slug shape."""
        pack = build_context_pack(self.root, "issue", 9, "plan")
        expected = f"issue-9-plan-{_pack_slug(pack['generatedAt'])}"
        self.assertEqual(pack["packId"], expected)


class GatherGoalRelevanceTests(unittest.TestCase):
    def test_gather_gates_goal_status_like_plan(self) -> None:
        """A non-active goal is irrelevant for gather exactly as it is for plan."""
        done_goal = {"status": "done", "activeIssue": 9}
        active_goal = {"status": "active", "activeIssue": 9}
        self.assertFalse(_goal_relevant(done_goal, "issue", 9, "gather"))
        self.assertFalse(_goal_relevant(done_goal, "issue", 9, "plan"))
        self.assertTrue(_goal_relevant(active_goal, "issue", 9, "gather"))
        self.assertTrue(_goal_relevant(active_goal, "issue", 9, "plan"))


if __name__ == "__main__":
    unittest.main()
