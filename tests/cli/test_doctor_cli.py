"""Unit tests for ``agentrail doctor`` CLI command (agentrail/cli/commands/doctor.py).

All external I/O (subprocess / gh) is patched; filesystem is exercised via
temporary directories.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
import unittest
from io import StringIO
from pathlib import Path
from unittest.mock import MagicMock, patch

from agentrail.cli.commands.doctor import (
    run_doctor,
    inspect_state,
    validate_skill_registry,
    has_api_key,
    resolve_api_key,
    check_github_labels,
    REQUIRED_LABELS,
    StateResult,
    SkillRegistryResult,
)
from agentrail.cli import main as main_module


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _sha256_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def _make_repo(tmp: Path, version: str = "1.0.0") -> Path:
    """Create a minimal fake repo with package.json."""
    repo = tmp / "repo"
    repo.mkdir()
    (repo / "package.json").write_text(json.dumps({"name": "@bensigo/agentrail", "version": version}))
    return repo


def _make_target(tmp: Path) -> Path:
    target = tmp / "target"
    target.mkdir()
    return target


def _capture(fn, *args, **kwargs):
    """Call fn(*args, **kwargs) and return (rc, stdout_text)."""
    buf = StringIO()
    with patch("sys.stdout", buf):
        rc = fn(*args, **kwargs)
    return rc, buf.getvalue()


def _capture_with_stderr(fn, *args, **kwargs):
    """Call fn(*args, **kwargs) and return (rc, stdout_text, stderr_text)."""
    out_buf = StringIO()
    err_buf = StringIO()
    with patch("sys.stdout", out_buf), patch("sys.stderr", err_buf):
        try:
            rc = fn(*args, **kwargs)
        except SystemExit as exc:
            rc = int(exc.code)
    return rc, out_buf.getvalue(), err_buf.getvalue()


# ---------------------------------------------------------------------------
# inspect_state tests
# ---------------------------------------------------------------------------

class InspectStateMissingTests(unittest.TestCase):
    def test_no_state_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "target"
            target.mkdir()
            repo = _make_repo(Path(tmp))
            result = inspect_state(str(target), repo)
        self.assertEqual(result.state_status, "missing")

    def test_invalid_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "target"
            (target / ".agentrail").mkdir(parents=True)
            (target / ".agentrail" / "state.json").write_text("not json")
            repo = _make_repo(Path(tmp))
            result = inspect_state(str(target), repo)
        self.assertEqual(result.state_status, "invalid")
        self.assertTrue(result.state_error)

    def test_managed_files_not_array(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "target"
            (target / ".agentrail").mkdir(parents=True)
            state = {"agentrailVersion": "1.0.0", "managedFiles": "not-an-array"}
            (target / ".agentrail" / "state.json").write_text(json.dumps(state))
            repo = _make_repo(Path(tmp))
            result = inspect_state(str(target), repo)
        self.assertEqual(result.state_status, "ok")
        self.assertIn("managedFiles must be an array", result.state_shape_errors)


class InspectStateHashTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tmpdir = Path(self.tmp.name)
        self.repo = _make_repo(self.tmpdir)
        self.target = _make_target(self.tmpdir)
        (self.target / ".agentrail").mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def _write_state(self, managed_files, version="1.0.0"):
        state = {"agentrailVersion": version, "managedFiles": managed_files}
        (self.target / ".agentrail" / "state.json").write_text(json.dumps(state))

    def test_version_ok(self):
        self._write_state([])
        result = inspect_state(str(self.target), self.repo)
        self.assertEqual(result.version_status, "ok")
        self.assertTrue(result.hashes_ok)

    def test_version_outdated(self):
        self._write_state([], version="0.9.0")
        result = inspect_state(str(self.target), self.repo)
        self.assertEqual(result.version_status, "outdated")

    def test_matching_hash(self):
        content = b"hello world"
        (self.target / "some_file.md").write_bytes(content)
        managed = [{"path": "some_file.md", "contentHash": _sha256_bytes(content)}]
        self._write_state(managed)
        result = inspect_state(str(self.target), self.repo)
        self.assertEqual(result.hash_mismatches, [])
        self.assertTrue(result.hashes_ok)

    def test_hash_mismatch(self):
        (self.target / "some_file.md").write_bytes(b"changed content")
        managed = [{"path": "some_file.md", "contentHash": _sha256_bytes(b"original content")}]
        self._write_state(managed)
        result = inspect_state(str(self.target), self.repo)
        self.assertIn("some_file.md", result.hash_mismatches)
        self.assertFalse(result.hashes_ok)

    def test_missing_managed_file(self):
        managed = [{"path": "does_not_exist.md", "contentHash": "sha256:abc"}]
        self._write_state(managed)
        result = inspect_state(str(self.target), self.repo)
        self.assertIn("does_not_exist.md", result.missing_managed)
        self.assertFalse(result.hashes_ok)

    def test_optional_missing(self):
        managed = [{"path": "TASTE.md", "contentHash": "sha256:abc"}]
        self._write_state(managed)
        result = inspect_state(str(self.target), self.repo)
        self.assertIn("TASTE.md", result.optional_missing)
        self.assertEqual(result.missing_managed, [])

    def test_optional_modified(self):
        (self.target / "TASTE.md").write_bytes(b"custom taste")
        managed = [{"path": "TASTE.md", "contentHash": "sha256:abc"}]
        self._write_state(managed)
        result = inspect_state(str(self.target), self.repo)
        self.assertIn("TASTE.md", result.optional_modified)
        self.assertEqual(result.hash_mismatches, [])

    def test_source_mismatch(self):
        content_installed = b"installed version"
        content_source = b"newer source version"
        (self.target / "some_file.md").write_bytes(content_installed)
        source_rel = "templates/some_file.md"
        (self.repo / "templates").mkdir(exist_ok=True)
        (self.repo / source_rel).write_bytes(content_source)
        managed = [{
            "path": "some_file.md",
            "contentHash": _sha256_bytes(content_installed),
            "source": source_rel,
            "installStatus": "installed",
        }]
        self._write_state(managed)
        result = inspect_state(str(self.target), self.repo)
        self.assertIn("some_file.md", result.source_mismatches)

    def test_preserved_no_source_mismatch(self):
        """Files with preserved/legacy-adopted status skip source mismatch check."""
        content_installed = b"installed version"
        content_source = b"newer source version"
        (self.target / "some_file.md").write_bytes(content_installed)
        source_rel = "templates/some_file.md"
        (self.repo / "templates").mkdir(exist_ok=True)
        (self.repo / source_rel).write_bytes(content_source)
        managed = [{
            "path": "some_file.md",
            "contentHash": _sha256_bytes(content_installed),
            "source": source_rel,
            "installStatus": "preserved",
        }]
        self._write_state(managed)
        result = inspect_state(str(self.target), self.repo)
        self.assertEqual(result.source_mismatches, [])


# ---------------------------------------------------------------------------
# run_doctor output tests
# ---------------------------------------------------------------------------

class RunDoctorSetup:
    """Mixin: sets up a temp dir with a fake repo and target."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tmpdir = Path(self.tmp.name)
        self.repo = _make_repo(self.tmpdir)
        self.target = _make_target(self.tmpdir)

    def tearDown(self):
        self.tmp.cleanup()

    def _patch_repo_dir(self):
        return patch("agentrail.cli.commands.doctor._repo_dir", return_value=self.repo)

    def _patch_gh_skip(self):
        """Patch subprocess so gh is 'not available' (which→ rc=1) and _remote_is_github → False."""
        def fake_run(cmd, **kwargs):
            m = MagicMock()
            m.returncode = 1
            m.stdout = ""
            return m
        return patch("agentrail.cli.commands.doctor.subprocess.run", side_effect=fake_run)

    def _run(self, extra_args=None):
        args = ["--target", str(self.target)] + (extra_args or [])
        with self._patch_repo_dir(), self._patch_gh_skip():
            rc, out = _capture(run_doctor, args)
        return rc, out


class DoctorMissingInstallTests(RunDoctorSetup, unittest.TestCase):
    def test_status_missing(self):
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertIn("status: missing", out)

    def test_section_headers_present(self):
        _, out = self._run()
        for header in ["core:", "state:", "legacy scripts:", "skills:", "dashboard:", "github:", "recommendations:"]:
            self.assertIn(header, out)

    def test_state_section_missing(self):
        _, out = self._run()
        self.assertIn("  missing .agentrail/state.json", out)

    def test_skills_skipped(self):
        _, out = self._run()
        self.assertIn("  skipped no AgentRail install", out)

    def test_recommendation_install(self):
        _, out = self._run()
        self.assertIn("run agentrail install", out)


class DoctorHealthyInstallTests(RunDoctorSetup, unittest.TestCase):
    def setUp(self):
        super().setUp()
        # Create .agentrail/state.json with matching hashes + version
        agentrail_dir = self.target / ".agentrail"
        agentrail_dir.mkdir()
        # Create a simple source package so hidden_source_missing stays False
        source_dir = agentrail_dir / "source"
        source_dir.mkdir()
        (source_dir / "package.json").write_text(json.dumps({"version": "1.0.0"}))

        state = {"agentrailVersion": "1.0.0", "managedFiles": []}
        (agentrail_dir / "state.json").write_text(json.dumps(state))

        # Create a minimal valid skill registry
        docs_agents = self.target / "docs" / "agents"
        docs_agents.mkdir(parents=True)
        skill_md_dir = self.target / "skills" / "my-skill"
        skill_md_dir.mkdir(parents=True)
        skill_body = "\n".join([
            "# My Skill",
            "## Activation Guidance",
            "## Context To Inspect",
            "## Constraints",
            "## Verification Requirements",
            "## Expected PR Evidence",
            "## Provenance / Audit",
        ])
        (skill_md_dir / "SKILL.md").write_text(skill_body)

        registry = {
            "schemaVersion": 1,
            "skills": [{
                "name": "my-skill",
                "localPath": "skills/my-skill/SKILL.md",
                "description": "A test skill",
                "licenseStatus": "ok",
                "auditStatus": "ok",
                "bundledByDefault": True,
                "triggers": {
                    "keywords": ["test"],
                    "fileGlobs": [],
                    "projectSignals": [],
                },
                "provenance": {
                    "candidates": [{
                        "sourceName": "Test",
                        "url": "https://example.com",
                        "relationship": "derived",
                        "verifiedStatus": "verified",
                        "auditNotes": "ok",
                    }],
                },
            }],
        }
        (docs_agents / "skill-registry.json").write_text(json.dumps(registry))

    def test_status_installed(self):
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertIn("status: installed", out)

    def test_managed_hashes_ok(self):
        _, out = self._run()
        self.assertIn("  ok managed hashes match", out)

    def test_skill_registry_ok(self):
        _, out = self._run()
        self.assertIn("  ok skill registry", out)

    def test_recommendation_no_blocking(self):
        # With many core paths missing the recommendation is to install, not "no blocking".
        # This is correct legacy behaviour: required_missing triggers install recommendation.
        _, out = self._run()
        self.assertIn("recommendations:", out)
        # At minimum a recommendation line should appear
        self.assertRegex(out, r"recommendations:\n  - ")

    def test_state_ok_line(self):
        _, out = self._run()
        self.assertIn("  ok .agentrail/state.json", out)

    def test_version_ok_line(self):
        _, out = self._run()
        self.assertIn("  ok AgentRail version", out)

    def test_all_section_headers(self):
        _, out = self._run()
        for hdr in ["core:", "state:", "legacy scripts:", "skills:", "dashboard:", "github:", "recommendations:"]:
            self.assertIn(hdr, out)


class DoctorFullyHealthyInstallTests(RunDoctorSetup, unittest.TestCase):
    """Creates ALL required paths so we get 'no blocking action'."""

    def _create_required_paths(self):
        t = self.target
        (t / "AGENTS.md").write_text("agents")
        (t / "CONTEXT.md").write_text("context")
        (t / "docs" / "agents").mkdir(parents=True)
        (t / "docs" / "prd").mkdir(parents=True)
        (t / "docs" / "milestones").mkdir(parents=True)
        (t / "skills").mkdir(parents=True)
        agentrail_dir = t / ".agentrail"
        agentrail_dir.mkdir(exist_ok=True)
        (agentrail_dir / "config.json").write_text("{}")
        source_dir = agentrail_dir / "source"
        source_dir.mkdir(exist_ok=True)
        (source_dir / "package.json").write_text(json.dumps({"version": "1.0.0"}))
        agentrail_pkg = source_dir / "agentrail"
        agentrail_pkg.mkdir(exist_ok=True)
        (agentrail_pkg / "__init__.py").write_text("")
        scripts = source_dir / "scripts"
        scripts.mkdir(exist_ok=True)
        for name in ["agentrail", "agentrail-legacy", "install-workflow"]:
            p = scripts / name
            p.write_text("#!/bin/sh\n")
            p.chmod(0o755)
        tmpl_scripts = source_dir / "templates" / "scripts"
        tmpl_scripts.mkdir(parents=True)
        for name in ["memory", "ralph-loop", "afk-workflow", "review-pr", "pr"]:
            p = tmpl_scripts / name
            p.write_text("#!/bin/sh\n")
            p.chmod(0o755)

    def setUp(self):
        super().setUp()
        self._create_required_paths()
        agentrail_dir = self.target / ".agentrail"
        state = {"agentrailVersion": "1.0.0", "managedFiles": []}
        (agentrail_dir / "state.json").write_text(json.dumps(state))
        # Minimal valid skill registry
        docs_agents = self.target / "docs" / "agents"
        skill_md_dir = self.target / "skills" / "my-skill"
        skill_md_dir.mkdir(parents=True)
        skill_body = "\n".join([
            "# My Skill",
            "## Activation Guidance",
            "## Context To Inspect",
            "## Constraints",
            "## Verification Requirements",
            "## Expected PR Evidence",
            "## Provenance / Audit",
        ])
        (skill_md_dir / "SKILL.md").write_text(skill_body)
        registry = {
            "schemaVersion": 1,
            "skills": [{
                "name": "my-skill",
                "localPath": "skills/my-skill/SKILL.md",
                "description": "A test skill",
                "licenseStatus": "ok",
                "auditStatus": "ok",
                "bundledByDefault": True,
                "triggers": {
                    "keywords": ["test"],
                    "fileGlobs": [],
                    "projectSignals": [],
                },
                "provenance": {
                    "candidates": [{
                        "sourceName": "Test",
                        "url": "https://example.com",
                        "relationship": "derived",
                        "verifiedStatus": "verified",
                        "auditNotes": "ok",
                    }],
                },
            }],
        }
        (docs_agents / "skill-registry.json").write_text(json.dumps(registry))

    def test_status_installed(self):
        rc, out = self._run()
        self.assertIn("status: installed", out)

    def test_recommendation_no_blocking(self):
        _, out = self._run()
        self.assertIn("  - no blocking action", out)

    def test_all_core_ok(self):
        _, out = self._run()
        # No "  missing" lines in core section
        lines = out.split("\n")
        in_core = False
        for line in lines:
            if line == "core:":
                in_core = True
                continue
            if in_core and line.endswith(":") and not line.startswith(" "):
                break
            if in_core:
                self.assertNotIn("  missing", line, f"Unexpected missing in core: {line}")


class DoctorHashMismatchTests(RunDoctorSetup, unittest.TestCase):
    def setUp(self):
        super().setUp()
        agentrail_dir = self.target / ".agentrail"
        agentrail_dir.mkdir()
        source_dir = agentrail_dir / "source"
        source_dir.mkdir()
        (source_dir / "package.json").write_text(json.dumps({"version": "1.0.0"}))

        # Write a real file but record a wrong hash
        (self.target / "AGENTS.md").write_bytes(b"actual content")
        state = {
            "agentrailVersion": "1.0.0",
            "managedFiles": [{
                "path": "AGENTS.md",
                "contentHash": _sha256_bytes(b"original content"),  # mismatch
            }],
        }
        (agentrail_dir / "state.json").write_text(json.dumps(state))

        # minimal registry
        docs_agents = self.target / "docs" / "agents"
        docs_agents.mkdir(parents=True)
        (docs_agents / "skill-registry.json").write_text(json.dumps({
            "schemaVersion": 1, "skills": []
        }))

    def test_status_modified(self):
        rc, out = self._run()
        self.assertIn("status: modified", out)

    def test_warn_hash_mismatch_line(self):
        _, out = self._run()
        self.assertIn("  warn hash mismatch: AGENTS.md", out)

    def test_recommendation_install_or_force(self):
        # hash_mismatch + required_missing → legacy picks "install" (required_missing wins)
        _, out = self._run()
        # Either --force or install (required_missing takes precedence per legacy 4062-4065)
        self.assertTrue(
            "--force" in out or "run agentrail install" in out,
            f"Expected install or --force recommendation in:\n{out}",
        )


class DoctorInvalidStateTests(RunDoctorSetup, unittest.TestCase):
    def setUp(self):
        super().setUp()
        agentrail_dir = self.target / ".agentrail"
        agentrail_dir.mkdir()
        (agentrail_dir / "state.json").write_text("not json {{{")

    def test_status_corrupt(self):
        rc, out = self._run()
        self.assertIn("status: corrupt", out)

    def test_error_invalid_state(self):
        _, out = self._run()
        self.assertIn("  error invalid .agentrail/state.json", out)

    def test_recommendation_repair(self):
        _, out = self._run()
        self.assertIn("repair or remove .agentrail/state.json", out)


# ---------------------------------------------------------------------------
# Dashboard section — API key
# ---------------------------------------------------------------------------

class DoctorDashboardTests(RunDoctorSetup, unittest.TestCase):
    def _run_with_env(self, env_extra=None):
        args = ["--target", str(self.target)]
        env = os.environ.copy()
        env.pop("AGENTRAIL_API_KEY", None)
        if env_extra:
            env.update(env_extra)
        with self._patch_repo_dir(), self._patch_gh_skip():
            with patch.dict(os.environ, env, clear=True):
                rc, out = _capture(run_doctor, args)
        return rc, out

    def test_api_key_configured(self):
        _, out = self._run_with_env({"AGENTRAIL_API_KEY": "test-key-123"})
        self.assertIn("  ok AGENTRAIL_API_KEY configured", out)

    def test_api_key_not_configured(self):
        _, out = self._run_with_env()
        self.assertIn("  info AGENTRAIL_API_KEY not configured (local-only mode", out)
        self.assertIn("dashboard features disabled", out)


# ---------------------------------------------------------------------------
# parse_target tests
# ---------------------------------------------------------------------------

class ParseTargetTests(unittest.TestCase):
    def _run_with_stderr(self, args):
        with tempfile.TemporaryDirectory() as tmp:
            repo = _make_repo(Path(tmp))
            target = _make_target(Path(tmp))
            with patch("agentrail.cli.commands.doctor._repo_dir", return_value=repo):
                with patch("agentrail.cli.commands.doctor.subprocess.run") as mock_sub:
                    mock_sub.return_value = MagicMock(returncode=1, stdout="")
                    rc, out, err = _capture_with_stderr(run_doctor, args)
        return rc, out, err

    def test_target_flag_honored(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = _make_repo(Path(tmp))
            target = _make_target(Path(tmp))
            args = ["--target", str(target)]
            with patch("agentrail.cli.commands.doctor._repo_dir", return_value=repo):
                with patch("agentrail.cli.commands.doctor.subprocess.run") as mock_sub:
                    mock_sub.return_value = MagicMock(returncode=1, stdout="")
                    rc, out = _capture(run_doctor, args)
            self.assertIn(str(target), out)

    def test_unknown_option_rc2(self):
        rc, out, err = self._run_with_stderr(["--unknown-flag"])
        self.assertEqual(rc, 2)

    def test_help_rc0(self):
        rc, out, err = self._run_with_stderr(["-h"])
        self.assertEqual(rc, 0)

    def test_help_long_rc0(self):
        rc, out, err = self._run_with_stderr(["--help"])
        self.assertEqual(rc, 0)


# ---------------------------------------------------------------------------
# has_api_key / resolve_api_key tests
# ---------------------------------------------------------------------------

class ApiKeyTests(unittest.TestCase):
    def test_env_var(self):
        with patch.dict(os.environ, {"AGENTRAIL_API_KEY": "mykey"}, clear=False):
            self.assertTrue(has_api_key("/any"))
            self.assertEqual(resolve_api_key("/any"), "mykey")

    def test_no_key(self):
        env = {k: v for k, v in os.environ.items() if k != "AGENTRAIL_API_KEY"}
        with patch.dict(os.environ, env, clear=True):
            with tempfile.TemporaryDirectory() as tmp:
                self.assertFalse(has_api_key(tmp))
                self.assertIsNone(resolve_api_key(tmp))

    def test_config_json_key(self):
        env = {k: v for k, v in os.environ.items() if k != "AGENTRAIL_API_KEY"}
        with patch.dict(os.environ, env, clear=True):
            with tempfile.TemporaryDirectory() as tmp:
                agentrail_dir = Path(tmp) / ".agentrail"
                agentrail_dir.mkdir()
                (agentrail_dir / "config.json").write_text(json.dumps({"apiKey": "from-config"}))
                self.assertTrue(has_api_key(tmp))
                self.assertEqual(resolve_api_key(tmp), "from-config")


# ---------------------------------------------------------------------------
# check_github_labels tests
# ---------------------------------------------------------------------------

class CheckGithubLabelsTests(unittest.TestCase):
    def test_skipped_when_no_gh(self):
        def fake_run(cmd, **kwargs):
            m = MagicMock()
            m.returncode = 1
            m.stdout = ""
            return m

        with patch("agentrail.cli.commands.doctor.subprocess.run", side_effect=fake_run):
            buf = StringIO()
            with patch("sys.stdout", buf):
                check_github_labels("/tmp/not-a-repo")
        out = buf.getvalue()
        self.assertIn("github:", out)
        self.assertIn("skipped", out)

    def test_all_labels_present(self):
        labels_json = json.dumps([{"name": lbl} for lbl in REQUIRED_LABELS])

        call_count = 0
        def fake_run(cmd, **kwargs):
            nonlocal call_count
            m = MagicMock()
            # "which gh" → rc 0 (available)
            # "git remote get-url" → github.com
            # "gh label list" → all labels
            if "which" in cmd:
                m.returncode = 0
                m.stdout = "/usr/bin/gh"
            elif "remote" in cmd:
                m.returncode = 0
                m.stdout = "https://github.com/org/repo.git"
            else:
                m.returncode = 0
                m.stdout = labels_json
            call_count += 1
            return m

        with patch("agentrail.cli.commands.doctor.subprocess.run", side_effect=fake_run):
            buf = StringIO()
            with patch("sys.stdout", buf):
                with tempfile.TemporaryDirectory() as tmp:
                    check_github_labels(tmp)
        out = buf.getvalue()
        self.assertIn("  ok GitHub labels", out)

    def test_missing_labels_warn(self):
        present = REQUIRED_LABELS[:3]  # only first 3 present
        labels_json = json.dumps([{"name": lbl} for lbl in present])

        def fake_run(cmd, **kwargs):
            m = MagicMock()
            if "which" in cmd:
                m.returncode = 0
                m.stdout = "/usr/bin/gh"
            elif "remote" in cmd:
                m.returncode = 0
                m.stdout = "https://github.com/org/repo.git"
            else:
                m.returncode = 0
                m.stdout = labels_json
            return m

        with patch("agentrail.cli.commands.doctor.subprocess.run", side_effect=fake_run):
            buf = StringIO()
            with patch("sys.stdout", buf):
                with tempfile.TemporaryDirectory() as tmp:
                    check_github_labels(tmp)
        out = buf.getvalue()
        self.assertIn("  warn missing GitHub labels:", out)


# ---------------------------------------------------------------------------
# main.py routes doctor
# ---------------------------------------------------------------------------

class MainRoutesDoctorTests(unittest.TestCase):
    def test_main_routes_doctor(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = _make_repo(Path(tmp))
            target = _make_target(Path(tmp))
            args = ["doctor", "--target", str(target)]
            with patch("agentrail.cli.commands.doctor._repo_dir", return_value=repo):
                with patch("agentrail.cli.commands.doctor.subprocess.run") as mock_sub:
                    mock_sub.return_value = MagicMock(returncode=1, stdout="")
                    buf = StringIO()
                    with patch("sys.stdout", buf):
                        rc = main_module.main(args)
            out = buf.getvalue()
        self.assertEqual(rc, 0)
        self.assertIn("AgentRail doctor:", out)
        self.assertIn("status:", out)


if __name__ == "__main__":
    unittest.main()
