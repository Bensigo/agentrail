"""Unit tests for ``agentrail skills`` CLI command (agentrail/cli/commands/skills.py).

Uses unittest/unittest.mock and temporary directories.
Run with: python -m pytest tests/cli/test_skills_cli.py -q
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from io import StringIO
from pathlib import Path
from unittest.mock import MagicMock, patch

from agentrail.cli.commands.skills import run_skills
from agentrail.cli.commands.doctor import SkillRegistryResult
import agentrail.cli.main as main_module


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

SKILL_REGISTRY_TEMPLATE = {
    "schemaVersion": 1,
    "description": "Test registry",
    "skills": [
        {
            "name": "tdd",
            "localPath": "skills/tdd/SKILL.md",
            "description": "Test-driven development workflow.",
            "bundledByDefault": True,
            "licenseStatus": "agentrail-authored",
            "auditStatus": "approved",
            "triggers": {
                "keywords": ["test", "tdd"],
                "fileGlobs": ["**/*.test.*"],
                "projectSignals": [],
            },
            "provenance": {
                "candidates": [
                    {
                        "sourceName": "AgentRail TDD skill",
                        "url": "https://example.com",
                        "relationship": "candidate-reference-only",
                        "verifiedStatus": "verified",
                        "auditNotes": "First-party.",
                        "autoInstall": False,
                    }
                ]
            },
        },
        {
            "name": "frontend-web",
            "localPath": "skills/frontend-web/SKILL.md",
            "description": "Build and modify web frontends.",
            "bundledByDefault": True,
            "licenseStatus": "agentrail-authored",
            "auditStatus": "approved",
            "triggers": {
                "keywords": ["frontend", "react", "ui"],
                "fileGlobs": ["**/*.tsx"],
                "projectSignals": [],
            },
            "provenance": {
                "candidates": [
                    {
                        "sourceName": "AgentRail frontend skill",
                        "url": "https://example.com",
                        "relationship": "candidate-reference-only",
                        "verifiedStatus": "verified",
                        "auditNotes": "First-party.",
                        "autoInstall": False,
                    }
                ]
            },
        },
    ],
}


def _make_target_with_registry(tmp: Path) -> Path:
    """Create a target dir with docs/agents/skill-registry.json containing 2 bundled skills."""
    target = tmp / "target"
    target.mkdir()
    registry_dir = target / "docs" / "agents"
    registry_dir.mkdir(parents=True)
    (registry_dir / "skill-registry.json").write_text(
        json.dumps(SKILL_REGISTRY_TEMPLATE), encoding="utf-8"
    )
    return target


def _make_repo(tmp: Path) -> Path:
    """Create a minimal repo with agentrail/templates/docs/agents/skill-registry.json."""
    repo = tmp / "repo"
    repo.mkdir()
    tmpl_dir = repo / "agentrail" / "templates" / "docs" / "agents"
    tmpl_dir.mkdir(parents=True)
    (tmpl_dir / "skill-registry.json").write_text(
        json.dumps(SKILL_REGISTRY_TEMPLATE), encoding="utf-8"
    )
    return repo


def _capture(fn, *args, **kwargs):
    """Call fn(*args, **kwargs) capturing stdout; returns (rc, stdout_text)."""
    buf = StringIO()
    with patch("sys.stdout", buf):
        rc = fn(*args, **kwargs)
    return rc, buf.getvalue()


def _capture_both(fn, *args, **kwargs):
    """Call fn(*args, **kwargs) capturing stdout+stderr; returns (rc, out, err)."""
    out_buf = StringIO()
    err_buf = StringIO()
    with patch("sys.stdout", out_buf), patch("sys.stderr", err_buf):
        try:
            rc = fn(*args, **kwargs)
        except SystemExit as exc:
            rc = int(exc.code)
    return rc, out_buf.getvalue(), err_buf.getvalue()


# ---------------------------------------------------------------------------
# skills list
# ---------------------------------------------------------------------------

class SkillsListTests(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._tmp_path = Path(self._tmp.name)
        self._target = _make_target_with_registry(self._tmp_path)
        self._repo = _make_repo(self._tmp_path)

    def tearDown(self):
        self._tmp.cleanup()

    def _run(self, extra_args=None):
        args = ["list", "--target", str(self._target)] + (extra_args or [])
        with patch("agentrail.cli.commands.skills._repo_dir", return_value=self._repo):
            return _capture(run_skills, args)

    def test_header_line(self):
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertIn(f"AgentRail skills list: {self._target}", out)

    def test_skill_names_listed(self):
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertIn("- tdd", out)
        self.assertIn("- frontend-web", out)

    def test_skill_path(self):
        rc, out = self._run()
        self.assertIn("  path: skills/tdd/SKILL.md", out)
        self.assertIn("  path: skills/frontend-web/SKILL.md", out)

    def test_skill_description(self):
        rc, out = self._run()
        self.assertIn("  description: Test-driven development workflow.", out)
        self.assertIn("  description: Build and modify web frontends.", out)

    def test_output_format_order(self):
        """Each skill block: '- <name>' then '  path:' then '  description:'"""
        rc, out = self._run()
        lines = [l for l in out.splitlines() if l.strip()]
        # Find tdd block
        idx = next(i for i, l in enumerate(lines) if l == "- tdd")
        self.assertTrue(lines[idx + 1].startswith("  path:"))
        self.assertTrue(lines[idx + 2].startswith("  description:"))

    def test_missing_registry_returns_1(self):
        """If no registry is installed or in repo, returns rc=1."""
        empty_repo = self._tmp_path / "empty_repo"
        empty_repo.mkdir()
        with patch("agentrail.cli.commands.skills._repo_dir", return_value=empty_repo):
            rc, out, err = _capture_both(run_skills, ["list", "--target", str(self._target)])
        # target has registry, so won't fail — test a target with no registry
        empty_target = self._tmp_path / "empty_target"
        empty_target.mkdir()
        with patch("agentrail.cli.commands.skills._repo_dir", return_value=empty_repo):
            rc, out, err = _capture_both(run_skills, ["list", "--target", str(empty_target)])
        self.assertEqual(rc, 1)
        self.assertIn("skills list:", err)


# ---------------------------------------------------------------------------
# skills resolve
# ---------------------------------------------------------------------------

class SkillsResolveTests(unittest.TestCase):

    def _mock_resolution(self, **overrides):
        base = {
            "targetDir": "/t",
            "autoSkills": True,
            "resolved": [
                {
                    "name": "tdd",
                    "localPath": "skills/tdd/SKILL.md",
                    "reasons": ["task keyword: test"],
                }
            ],
        }
        base.update(overrides)
        return base

    def test_basic_resolve(self):
        with patch(
            "agentrail.cli.commands.skills.resolve_skills",
            return_value=self._mock_resolution(),
        ), patch("agentrail.cli.commands.skills._repo_dir", return_value=Path("/repo")):
            rc, out = _capture(run_skills, ["resolve", "add a test"])
        self.assertEqual(rc, 0)
        self.assertIn("AgentRail skills resolve: /t", out)
        self.assertIn("task: add a test", out)
        self.assertIn("- tdd", out)
        self.assertIn("  path: skills/tdd/SKILL.md", out)
        self.assertIn("  reason: task keyword: test", out)

    def test_no_task_text_returns_rc2(self):
        rc, out, err = _capture_both(run_skills, ["resolve"])
        self.assertEqual(rc, 2)
        self.assertIn("skills resolve requires task text", err)

    def test_task_starting_with_dash_returns_rc2(self):
        rc, out, err = _capture_both(run_skills, ["resolve", "--oops"])
        self.assertEqual(rc, 2)
        self.assertIn("skills resolve requires task text", err)

    def test_no_auto_skills_disabled_message(self):
        resolution = self._mock_resolution(autoSkills=False, resolved=[])
        with patch(
            "agentrail.cli.commands.skills.resolve_skills",
            return_value=resolution,
        ), patch("agentrail.cli.commands.skills._repo_dir", return_value=Path("/repo")):
            rc, out = _capture(run_skills, ["resolve", "x", "--no-auto-skills"])
        self.assertEqual(rc, 0)
        self.assertIn("Automatic skill resolution disabled.", out)
        self.assertIn("No skills resolved.", out)

    def test_empty_resolved_no_skills_message(self):
        resolution = self._mock_resolution(resolved=[])
        with patch(
            "agentrail.cli.commands.skills.resolve_skills",
            return_value=resolution,
        ), patch("agentrail.cli.commands.skills._repo_dir", return_value=Path("/repo")):
            rc, out = _capture(run_skills, ["resolve", "unrecognized task"])
        self.assertEqual(rc, 0)
        self.assertIn("No skills resolved.", out)

    def test_multiple_reasons(self):
        resolution = self._mock_resolution(
            resolved=[
                {
                    "name": "tdd",
                    "localPath": "skills/tdd/SKILL.md",
                    "reasons": ["task keyword: test", "file signal: foo.test.ts"],
                }
            ]
        )
        with patch(
            "agentrail.cli.commands.skills.resolve_skills",
            return_value=resolution,
        ), patch("agentrail.cli.commands.skills._repo_dir", return_value=Path("/repo")):
            rc, out = _capture(run_skills, ["resolve", "add a test"])
        self.assertIn("  reason: task keyword: test", out)
        self.assertIn("  reason: file signal: foo.test.ts", out)

    def test_skill_resolution_error_returns_1(self):
        from agentrail.run.skills import SkillResolutionError
        with patch(
            "agentrail.cli.commands.skills.resolve_skills",
            side_effect=SkillResolutionError("Unknown skill: bogus"),
        ), patch("agentrail.cli.commands.skills._repo_dir", return_value=Path("/repo")):
            rc, out, err = _capture_both(run_skills, ["resolve", "fix something", "--skill", "bogus"])
        self.assertEqual(rc, 1)
        self.assertIn("Unknown skill: bogus", err)

    def test_no_auto_skills_flag_passed_to_resolve_skills(self):
        """--no-auto-skills passes auto_skills=False to resolve_skills."""
        captured = {}

        def _fake_resolve(target_dir, repo_dir, task, auto_skills=True, explicit_skills=None):
            captured["auto_skills"] = auto_skills
            return {"targetDir": str(target_dir), "autoSkills": auto_skills, "resolved": []}

        with patch("agentrail.cli.commands.skills.resolve_skills", side_effect=_fake_resolve), \
             patch("agentrail.cli.commands.skills._repo_dir", return_value=Path("/repo")):
            run_skills(["resolve", "do something", "--no-auto-skills"])
        self.assertFalse(captured["auto_skills"])

    def test_explicit_skill_passed(self):
        captured = {}

        def _fake_resolve(target_dir, repo_dir, task, auto_skills=True, explicit_skills=None):
            captured["explicit_skills"] = explicit_skills
            return {"targetDir": str(target_dir), "autoSkills": auto_skills, "resolved": []}

        with patch("agentrail.cli.commands.skills.resolve_skills", side_effect=_fake_resolve), \
             patch("agentrail.cli.commands.skills._repo_dir", return_value=Path("/repo")):
            run_skills(["resolve", "do something", "--skill", "tdd"])
        self.assertEqual(captured["explicit_skills"], ["tdd"])


# ---------------------------------------------------------------------------
# skills validate
# ---------------------------------------------------------------------------

class SkillsValidateTests(unittest.TestCase):

    def _ok_result(self, path: str) -> SkillRegistryResult:
        r = SkillRegistryResult()
        r.ok = True
        r.registry_path = path
        r.errors = []
        return r

    def _error_result(self, *msgs) -> SkillRegistryResult:
        r = SkillRegistryResult()
        r.ok = False
        r.registry_path = ""
        r.errors = list(msgs)
        return r

    def test_ok_registry(self):
        ok_result = self._ok_result("/some/path/skill-registry.json")
        with patch(
            "agentrail.cli.commands.skills.validate_skill_registry",
            return_value=ok_result,
        ), patch("agentrail.cli.commands.skills._repo_dir", return_value=Path("/repo")):
            rc, out = _capture(run_skills, ["validate", "--target", "/some/target"])
        self.assertEqual(rc, 0)
        self.assertIn("AgentRail skills validate: /some/target", out)
        self.assertIn("  ok skill registry", out)
        self.assertIn("  path /some/path/skill-registry.json", out)

    def test_error_registry_returns_1(self):
        err_result = self._error_result("schemaVersion must be 1", "skills must be an array")
        with patch(
            "agentrail.cli.commands.skills.validate_skill_registry",
            return_value=err_result,
        ), patch("agentrail.cli.commands.skills._repo_dir", return_value=Path("/repo")):
            rc, out = _capture(run_skills, ["validate", "--target", "/bad/target"])
        self.assertEqual(rc, 1)
        self.assertIn("AgentRail skills validate: /bad/target", out)
        self.assertIn("  error schemaVersion must be 1", out)
        self.assertIn("  error skills must be an array", out)

    def test_default_target_is_cwd(self):
        """Validate without --target should use cwd."""
        captured = {}

        def _fake_validate(target_dir, repo_dir):
            captured["target_dir"] = target_dir
            r = SkillRegistryResult()
            r.ok = True
            r.registry_path = "x"
            r.errors = []
            return r

        import os
        with patch("agentrail.cli.commands.skills.validate_skill_registry", side_effect=_fake_validate), \
             patch("agentrail.cli.commands.skills._repo_dir", return_value=Path("/repo")):
            run_skills(["validate"])
        self.assertEqual(captured["target_dir"], os.getcwd())


# ---------------------------------------------------------------------------
# Dispatch / edge cases
# ---------------------------------------------------------------------------

class SkillsDispatchTests(unittest.TestCase):

    def test_empty_args_returns_0(self):
        rc, out = _capture(run_skills, [])
        self.assertEqual(rc, 0)
        self.assertIn("Usage:", out)

    def test_dash_h_returns_0(self):
        rc, out = _capture(run_skills, ["-h"])
        self.assertEqual(rc, 0)
        self.assertIn("Usage:", out)

    def test_help_flag_returns_0(self):
        rc, out = _capture(run_skills, ["--help"])
        self.assertEqual(rc, 0)
        self.assertIn("Usage:", out)

    def test_unknown_subcommand_returns_2(self):
        rc, out, err = _capture_both(run_skills, ["frob"])
        self.assertEqual(rc, 2)
        self.assertIn("Unknown skills command: frob", err)

    def test_unknown_subcommand_no_stdout(self):
        rc, out, err = _capture_both(run_skills, ["frob"])
        self.assertEqual(out, "")


# ---------------------------------------------------------------------------
# main.py routing
# ---------------------------------------------------------------------------

class MainRoutingTests(unittest.TestCase):

    def test_main_routes_skills_list(self):
        """main() routes 'skills list' to run_skills."""
        called = {}

        def _fake_run_skills(args):
            called["args"] = args
            return 0

        with patch.object(main_module, "run_skills", _fake_run_skills):
            rc = main_module.main(["skills", "list", "--target", "/foo"])
        self.assertEqual(rc, 0)
        self.assertEqual(called["args"], ["list", "--target", "/foo"])

    def test_main_routes_skills_validate(self):
        called = {}

        def _fake_run_skills(args):
            called["args"] = args
            return 0

        with patch.object(main_module, "run_skills", _fake_run_skills):
            rc = main_module.main(["skills", "validate"])
        self.assertEqual(rc, 0)
        self.assertEqual(called["args"], ["validate"])

    def test_main_routes_skills_resolve(self):
        called = {}

        def _fake_run_skills(args):
            called["args"] = args
            return 0

        with patch.object(main_module, "run_skills", _fake_run_skills):
            rc = main_module.main(["skills", "resolve", "add a test"])
        self.assertEqual(rc, 0)
        self.assertEqual(called["args"], ["resolve", "add a test"])


if __name__ == "__main__":
    unittest.main()
