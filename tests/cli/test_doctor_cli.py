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
        # #404 Option B: no editable flow scripts are vendored under
        # .agentrail/source — only the native package + package.json.

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

    def test_legacy_layout_warns_but_does_not_block(self):
        """D4: an all-legacy-but-otherwise-healthy install still reports 'ok'
        for the migrated paths, plus a non-blocking 'warn' pointing at
        `agentrail upgrade`, without flipping the recommendation."""
        _, out = self._run()
        self.assertIn("  ok CONTEXT.md", out)
        self.assertIn(
            "  warn CONTEXT.md found at legacy path (CONTEXT.md); run `agentrail upgrade",
            out,
        )
        self.assertIn("  ok docs/agents/", out)
        self.assertIn("  ok skills/", out)
        self.assertIn("  ok docs/agents/skill-registry.json", out)
        self.assertIn("  - no blocking action", out)


class DoctorFullyHealthyNewLayoutInstallTests(RunDoctorSetup, unittest.TestCase):
    """Same as DoctorFullyHealthyInstallTests but using the House 2
    (.agentrail/-rooted) layout for every migrated path (D4 new-path-first)."""

    def setUp(self):
        super().setUp()
        t = self.target
        (t / "AGENTS.md").write_text("agents")
        (t / ".agentrail" / "context.md").parent.mkdir(parents=True, exist_ok=True)
        (t / ".agentrail" / "context.md").write_text("context")
        (t / ".agentrail" / "agents").mkdir(parents=True, exist_ok=True)
        (t / "docs" / "prd").mkdir(parents=True)
        (t / "docs" / "milestones").mkdir(parents=True)
        (t / ".agentrail" / "skills").mkdir(parents=True, exist_ok=True)
        agentrail_dir = t / ".agentrail"
        (agentrail_dir / "config.json").write_text("{}")
        source_dir = agentrail_dir / "source"
        source_dir.mkdir(exist_ok=True)
        (source_dir / "package.json").write_text(json.dumps({"version": "1.0.0"}))
        agentrail_pkg = source_dir / "agentrail"
        agentrail_pkg.mkdir(exist_ok=True)
        (agentrail_pkg / "__init__.py").write_text("")

        state = {"agentrailVersion": "1.0.0", "managedFiles": []}
        (agentrail_dir / "state.json").write_text(json.dumps(state))

        skill_md_dir = agentrail_dir / "skills" / "my-skill"
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
        (agentrail_dir / "agents" / "skill-registry.json").write_text(json.dumps(registry))

    def test_status_installed(self):
        rc, out = self._run()
        self.assertIn("status: installed", out)

    def test_recommendation_no_blocking(self):
        _, out = self._run()
        self.assertIn("  - no blocking action", out)

    def test_all_core_ok_no_legacy_warning(self):
        """New layout fully present: 'ok' everywhere, no legacy warn noise."""
        _, out = self._run()
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
                self.assertNotIn("legacy path", line, f"Unexpected legacy warning in core: {line}")

    def test_skill_registry_ok(self):
        _, out = self._run()
        self.assertIn("  ok skill registry", out)


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

# ---------------------------------------------------------------------------
# End-to-end run_doctor output tests — outdated / corrupt scenarios
# ---------------------------------------------------------------------------

class DoctorOutdatedVersionTests(RunDoctorSetup, unittest.TestCase):
    """status: outdated because state.json agentrailVersion differs from package.json."""

    def setUp(self):
        super().setUp()
        agentrail_dir = self.target / ".agentrail"
        agentrail_dir.mkdir()
        source_dir = agentrail_dir / "source"
        source_dir.mkdir()
        (source_dir / "package.json").write_text(json.dumps({"version": "1.0.0"}))

        # State records an older version; repo package.json is "1.0.0"
        state = {"agentrailVersion": "0.9.0", "managedFiles": []}
        (agentrail_dir / "state.json").write_text(json.dumps(state))

        # Minimal valid skill registry so registry_invalid stays False
        docs_agents = self.target / "docs" / "agents"
        docs_agents.mkdir(parents=True)
        (docs_agents / "skill-registry.json").write_text(
            json.dumps({"schemaVersion": 1, "skills": []})
        )

    def test_status_outdated(self):
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertIn("status: outdated", out)

    def test_warn_version_differs(self):
        _, out = self._run()
        self.assertIn("  warn AgentRail version differs from current package", out)


class DoctorOutdatedSourceMismatchTests(RunDoctorSetup, unittest.TestCase):
    """status: outdated because a managedFile's source in the repo has a different hash
    (no HASH_MISMATCH; target content matches contentHash; installStatus is 'installed')."""

    def setUp(self):
        super().setUp()
        agentrail_dir = self.target / ".agentrail"
        agentrail_dir.mkdir()
        source_dir = agentrail_dir / "source"
        source_dir.mkdir()
        (source_dir / "package.json").write_text(json.dumps({"version": "1.0.0"}))

        # File installed in the target — hash matches what's in state
        installed_content = b"installed version"
        (self.target / "AGENTS.md").write_bytes(installed_content)

        # Repo has a NEWER version of the source file
        source_rel = "templates/AGENTS.md"
        (self.repo / "templates").mkdir(exist_ok=True)
        (self.repo / source_rel).write_bytes(b"newer repo version")

        state = {
            "agentrailVersion": "1.0.0",
            "managedFiles": [{
                "path": "AGENTS.md",
                "contentHash": _sha256_bytes(installed_content),
                "source": source_rel,
                "installStatus": "installed",  # not preserved/legacy-adopted
            }],
        }
        (agentrail_dir / "state.json").write_text(json.dumps(state))

        # Minimal valid skill registry
        docs_agents = self.target / "docs" / "agents"
        docs_agents.mkdir(parents=True)
        (docs_agents / "skill-registry.json").write_text(
            json.dumps({"schemaVersion": 1, "skills": []})
        )

    def test_status_outdated(self):
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertIn("status: outdated", out)

    def test_warn_source_mismatch(self):
        _, out = self._run()
        self.assertIn("  warn current package mismatch: AGENTS.md", out)


class DoctorCorruptRegistryTests(RunDoctorSetup, unittest.TestCase):
    """status: corrupt because docs/agents/skill-registry.json fails validation."""

    def setUp(self):
        super().setUp()
        agentrail_dir = self.target / ".agentrail"
        agentrail_dir.mkdir()
        source_dir = agentrail_dir / "source"
        source_dir.mkdir()
        (source_dir / "package.json").write_text(json.dumps({"version": "1.0.0"}))

        state = {"agentrailVersion": "1.0.0", "managedFiles": []}
        (agentrail_dir / "state.json").write_text(json.dumps(state))

        # Write an invalid registry (schemaVersion wrong, skills not a list)
        docs_agents = self.target / "docs" / "agents"
        docs_agents.mkdir(parents=True)
        (docs_agents / "skill-registry.json").write_text(
            json.dumps({"schemaVersion": 99, "skills": "not-an-array"})
        )

    def test_status_corrupt(self):
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertIn("status: corrupt", out)

    def test_skills_error_line(self):
        _, out = self._run()
        # validate_skill_registry errors are printed as "  error <msg>" in skills section
        self.assertRegex(out, r"skills:\n(?:.*\n)*  error ")


# ---------------------------------------------------------------------------
# Partial hidden source missing (ported from scripts/test-doctor lines 55–63)
# ---------------------------------------------------------------------------

class DoctorPartialSourceMissingTests(RunDoctorSetup, unittest.TestCase):
    """status: modified because .agentrail/source/package.json is absent (hidden_source_missing)."""

    def setUp(self):
        super().setUp()
        agentrail_dir = self.target / ".agentrail"
        agentrail_dir.mkdir()
        # Intentionally do NOT create .agentrail/source/package.json

        state = {"agentrailVersion": "1.0.0", "managedFiles": []}
        (agentrail_dir / "state.json").write_text(json.dumps(state))

        docs_agents = self.target / "docs" / "agents"
        docs_agents.mkdir(parents=True)
        (docs_agents / "skill-registry.json").write_text(
            json.dumps({"schemaVersion": 1, "skills": []})
        )

    def test_status_modified(self):
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertIn("status: modified", out)

    def test_recommendation_reinstall(self):
        _, out = self._run()
        self.assertIn("run agentrail install --target", out)


# ---------------------------------------------------------------------------
# Legacy raw workflow scripts detected (ported from scripts/test-doctor lines 66–75)
# ---------------------------------------------------------------------------

class DoctorLegacyScriptTests(RunDoctorSetup, unittest.TestCase):
    """scripts/ralph-loop present but NOT in managed inventory → warn + recommend removal."""

    def setUp(self):
        super().setUp()
        agentrail_dir = self.target / ".agentrail"
        agentrail_dir.mkdir()
        source_dir = agentrail_dir / "source"
        source_dir.mkdir()
        (source_dir / "package.json").write_text(json.dumps({"version": "1.0.0"}))

        state = {"agentrailVersion": "1.0.0", "managedFiles": []}
        (agentrail_dir / "state.json").write_text(json.dumps(state))

        docs_agents = self.target / "docs" / "agents"
        docs_agents.mkdir(parents=True)
        (docs_agents / "skill-registry.json").write_text(
            json.dumps({"schemaVersion": 1, "skills": []})
        )

        scripts_dir = self.target / "scripts"
        scripts_dir.mkdir()
        legacy = scripts_dir / "ralph-loop"
        legacy.write_text("#!/usr/bin/env bash\necho legacy\n")
        legacy.chmod(0o755)

    def test_warn_legacy_scripts_present(self):
        _, out = self._run()
        self.assertIn("  warn legacy raw workflow scripts present: scripts/ralph-loop", out)

    def test_recommendation_remove_legacy_scripts(self):
        _, out = self._run()
        self.assertIn("remove legacy raw workflow scripts", out)


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


# ---------------------------------------------------------------------------
# validate_skill_registry — detailed cases ported from the legacy bash
# scripts/test-skill-registry-validation (M6 slice 2).
#
# The bash test installed a real project then mutated the registry / skill
# files and asserted specific error strings. Here we build a synthetic valid
# registry on disk and apply the same mutations, exercising the same error
# paths with mocked filesystem (no `agentrail install`, no node).
# ---------------------------------------------------------------------------

_VALID_SKILL_BODY = "\n".join([
    "# Frontend Web",
    "## Activation Guidance",
    "## Context To Inspect",
    "## Constraints",
    "## Verification Requirements",
    "## Expected PR Evidence",
    "## Provenance / Audit",
])


def _make_valid_registry_target(tmp: Path):
    """Build a target dir with a valid two-skill registry and SKILL.md files.

    Returns (target, registry_dict). Mutate the dict and re-write with
    ``_write_registry`` to exercise validation failure paths.
    """
    target = tmp / "target"
    target.mkdir()
    docs_agents = target / "docs" / "agents"
    docs_agents.mkdir(parents=True)

    def _skill(name: str) -> dict:
        skill_dir = target / "skills" / name
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text(_VALID_SKILL_BODY, encoding="utf-8")
        return {
            "name": name,
            "localPath": f"skills/{name}/SKILL.md",
            "description": f"{name} skill",
            "licenseStatus": "agentrail-authored",
            "auditStatus": "approved",
            "bundledByDefault": True,
            "triggers": {
                "keywords": [name],
                "fileGlobs": [],
                "projectSignals": [],
            },
            "provenance": {
                "candidates": [
                    {
                        "sourceName": f"AgentRail {name} skill",
                        "url": "https://example.com",
                        "relationship": "candidate-reference-only",
                        "verifiedStatus": "verified",
                        "auditNotes": "First-party.",
                        "autoInstall": False,
                    }
                ]
            },
        }

    registry = {"schemaVersion": 1, "skills": [_skill("frontend-web"), _skill("backend-api")]}
    _write_registry(target, registry)
    return target, registry


def _write_registry(target: Path, registry) -> None:
    (target / "docs" / "agents" / "skill-registry.json").write_text(
        json.dumps(registry, indent=2) + "\n", encoding="utf-8"
    )


class ValidateSkillRegistryDetailTests(unittest.TestCase):
    """Failure-path coverage ported from scripts/test-skill-registry-validation."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._tmp_path = Path(self._tmp.name)
        self._repo = self._tmp_path / "repo"
        self._repo.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def _validate(self, target: Path) -> SkillRegistryResult:
        return validate_skill_registry(str(target), self._repo)

    def _assert_invalid(self, target: Path, needle: str):
        result = self._validate(target)
        self.assertFalse(result.ok, f"expected invalid registry, got ok; errors={result.errors}")
        self.assertTrue(
            any(needle in e for e in result.errors),
            f"expected an error containing {needle!r}; got {result.errors}",
        )

    def test_valid_registry_ok(self):
        target, _ = _make_valid_registry_target(self._tmp_path)
        result = self._validate(target)
        self.assertTrue(result.ok, f"valid registry rejected: {result.errors}")

    def test_root_non_object_rejected(self):
        # Bash looped over null/false/0/""/[]; all must be rejected as non-object.
        for root in ("null", "false", "0", '""', "[]"):
            with self.subTest(root=root):
                target, _ = _make_valid_registry_target(self._tmp_path)
                # overwrite with a raw non-object root
                (target / "docs" / "agents" / "skill-registry.json").write_text(
                    root + "\n", encoding="utf-8"
                )
                self._assert_invalid(target, "registry root must be an object")
                # rebuild for next iteration
                import shutil
                shutil.rmtree(target)

    def test_duplicate_skill_name_rejected(self):
        target, registry = _make_valid_registry_target(self._tmp_path)
        registry["skills"][1]["name"] = registry["skills"][0]["name"]
        _write_registry(target, registry)
        self._assert_invalid(target, "duplicate skill name")

    def test_missing_required_field_rejected(self):
        target, registry = _make_valid_registry_target(self._tmp_path)
        del registry["skills"][0]["description"]
        _write_registry(target, registry)
        self._assert_invalid(target, "missing required field description")

    def test_invalid_local_path_rejected(self):
        target, registry = _make_valid_registry_target(self._tmp_path)
        registry["skills"][0]["localPath"] = "skills/nope/SKILL.md"
        _write_registry(target, registry)
        self._assert_invalid(target, "localPath does not exist")

    def test_missing_registry_file_rejected(self):
        target, _ = _make_valid_registry_target(self._tmp_path)
        (target / "docs" / "agents" / "skill-registry.json").unlink()
        self._assert_invalid(target, "cannot read registry")

    def test_missing_skill_section_rejected(self):
        target, registry = _make_valid_registry_target(self._tmp_path)
        # Replace a skill body with one lacking the required audit sections.
        skill_md = target / registry["skills"][0]["localPath"]
        skill_md.write_text("# Frontend Web\n\nUse this skill when changing frontend code.\n", encoding="utf-8")
        self._assert_invalid(target, "missing SKILL.md section ## Provenance / Audit")

    def test_malformed_triggers_rejected(self):
        target, registry = _make_valid_registry_target(self._tmp_path)
        registry["skills"][0]["triggers"]["keywords"] = "frontend"
        _write_registry(target, registry)
        # Native message is "triggers.keywords must be an array of non-empty strings";
        # the bash test matched the substring "triggers.keywords must be an array".
        self._assert_invalid(target, "triggers.keywords must be an array")


def _make_valid_registry_target_new_layout(tmp: Path):
    """Same as ``_make_valid_registry_target`` but under the House 2 layout:
    ``.agentrail/agents/skill-registry.json`` + ``.agentrail/skills/<name>/SKILL.md``.
    """
    target = tmp / "target"
    target.mkdir()
    agentrail_agents = target / ".agentrail" / "agents"
    agentrail_agents.mkdir(parents=True)

    def _skill(name: str) -> dict:
        skill_dir = target / ".agentrail" / "skills" / name
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text(_VALID_SKILL_BODY, encoding="utf-8")
        return {
            "name": name,
            "localPath": f"skills/{name}/SKILL.md",
            "description": f"{name} skill",
            "licenseStatus": "agentrail-authored",
            "auditStatus": "approved",
            "bundledByDefault": True,
            "triggers": {
                "keywords": [name],
                "fileGlobs": [],
                "projectSignals": [],
            },
            "provenance": {
                "candidates": [
                    {
                        "sourceName": f"AgentRail {name} skill",
                        "url": "https://example.com",
                        "relationship": "candidate-reference-only",
                        "verifiedStatus": "verified",
                        "auditNotes": "First-party.",
                        "autoInstall": False,
                    }
                ]
            },
        }

    registry = {"schemaVersion": 1, "skills": [_skill("frontend-web"), _skill("backend-api")]}
    (agentrail_agents / "skill-registry.json").write_text(
        json.dumps(registry, indent=2) + "\n", encoding="utf-8"
    )
    return target, registry


class ValidateSkillRegistryDualPathTests(unittest.TestCase):
    """D4 dual-path coverage: new House 2 layout, legacy-only, and new-preferred."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._tmp_path = Path(self._tmp.name)
        self._repo = self._tmp_path / "repo"
        self._repo.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def _validate(self, target: Path) -> SkillRegistryResult:
        return validate_skill_registry(str(target), self._repo)

    def test_new_layout_only_ok(self):
        target, _ = _make_valid_registry_target_new_layout(self._tmp_path)
        result = self._validate(target)
        self.assertTrue(result.ok, f"valid new-layout registry rejected: {result.errors}")
        self.assertIn(".agentrail", result.registry_path)

    def test_legacy_layout_only_ok(self):
        # Same fixture used elsewhere in this file for the pre-v2 layout;
        # kept here too so both cases sit side by side for this reader.
        target, _ = _make_valid_registry_target(self._tmp_path)
        result = self._validate(target)
        self.assertTrue(result.ok, f"valid legacy-layout registry rejected: {result.errors}")
        self.assertIn(str(Path("docs") / "agents"), result.registry_path)

    def test_new_layout_preferred_when_both_present(self):
        target, _ = _make_valid_registry_target_new_layout(self._tmp_path)
        # Also drop a legacy registry alongside it, deliberately invalid, to
        # prove it is never consulted once the new layout resolves.
        legacy_docs_agents = target / "docs" / "agents"
        legacy_docs_agents.mkdir(parents=True)
        (legacy_docs_agents / "skill-registry.json").write_text("not json", encoding="utf-8")
        result = self._validate(target)
        self.assertTrue(result.ok, f"new-layout registry should win over broken legacy: {result.errors}")
        self.assertIn(".agentrail", result.registry_path)


class ShippedSkillRegistryRegressionTest(unittest.TestCase):
    """Regression guard for the real bug found while porting the bash test.

    The legacy scripts/test-skill-registry-validation FAILED on base because the
    shipped frontend-web SKILL.md (a frontend-design doc with '## Overview',
    '## When to Use', ...) lacks ALL six machine-readable audit sections that
    validate_skill_registry enforces. The other four registry skills
    (desktop-tauri, backend-api, devops-deploy, docs-current) are fine. This
    means `agentrail skills validate` and `agentrail doctor` fail on a fresh
    install solely because of frontend-web.

    This test pins that finding so it is visible and so a fix flips it green.
    The repo skills live at <repo>/agentrail/skills/<name>/SKILL.md.
    """

    REPO_ROOT = Path(__file__).resolve().parents[2]
    REGISTRY = REPO_ROOT / "agentrail" / "templates" / "docs" / "agents" / "skill-registry.json"
    REQUIRED = [
        "## Activation Guidance",
        "## Context To Inspect",
        "## Constraints",
        "## Verification Requirements",
        "## Expected PR Evidence",
        "## Provenance / Audit",
    ]

    @unittest.skipUnless(REGISTRY.exists(), "shipped skill-registry.json not present")
    def test_only_frontend_web_is_missing_audit_sections(self):
        registry = json.loads(self.REGISTRY.read_text(encoding="utf-8"))
        missing_by_skill = {}
        for skill in registry["skills"]:
            body_path = self.REPO_ROOT / "agentrail" / skill["localPath"]
            if not body_path.exists():
                missing_by_skill[skill["name"]] = ["<localPath missing>"]
                continue
            body = body_path.read_text(encoding="utf-8")
            missing = [s for s in self.REQUIRED if s not in body]
            if missing:
                missing_by_skill[skill["name"]] = missing

        # KNOWN BUG: frontend-web is the only offender. If this assertion ever
        # fails, the shipped surface changed — re-evaluate the finding.
        self.assertEqual(
            set(missing_by_skill),
            {"frontend-web"},
            "Expected exactly frontend-web to be missing audit sections; "
            f"got {missing_by_skill!r}. If frontend-web was fixed, update/remove "
            "this regression guard.",
        )


# ---------------------------------------------------------------------------
# Tests: daemon health section (AC4, AC5)
# ---------------------------------------------------------------------------

class TestDaemonHealthDoctor(unittest.TestCase):
    """Tests for the 'daemon:' section added to agentrail doctor."""

    def setUp(self):
        self._tmp = tempfile.mkdtemp()
        self._sock = Path(self._tmp) / "daemon-test.sock"

    def tearDown(self):
        import shutil
        shutil.rmtree(self._tmp, ignore_errors=True)

    def _run_doctor_for(self, target_dir: str):
        with patch("subprocess.run") as mock_sub:
            mock_sub.return_value = MagicMock(returncode=1, stdout="", stderr="")
            rc, out = _capture(run_doctor, ["--target", target_dir])
        return rc, out

    def test_daemon_skipped_when_not_running(self):
        """AC4 (SKIP): no socket → 'skipped daemon not running'."""
        with patch("agentrail.context.daemon.socket_path_for", return_value=self._sock):
            rc, out = self._run_doctor_for(self._tmp)
        self.assertIn("daemon:", out)
        self.assertIn("skipped", out)
        self.assertIn("not running", out)

    def test_daemon_ok_when_running(self):
        """AC4 (OK): running daemon → '  ok daemon running ...'."""
        self._sock.touch()
        status_resp = {
            "pid": 55555,
            "uptimeSeconds": 60,
            "lastIndexedAt": "2026-06-13T10:22:01Z",
            "socketPath": str(self._sock),
            "state": "running",
        }
        with patch("agentrail.context.daemon.socket_path_for", return_value=self._sock), \
             patch("agentrail.context.daemon.rpc", return_value=status_resp):
            rc, out = self._run_doctor_for(self._tmp)
        self.assertIn("daemon:", out)
        self.assertIn("  ok", out)
        self.assertIn("55555", out)

    def test_daemon_warn_when_stale(self):
        """AC4 (WARN): stale daemon → '  warn stale ...'."""
        self._sock.touch()
        status_resp = {
            "pid": 77777,
            "uptimeSeconds": 5,
            "lastIndexedAt": "2026-06-13T10:00:00Z",
            "socketPath": str(self._sock),
            "state": "stale",
        }
        with patch("agentrail.context.daemon.socket_path_for", return_value=self._sock), \
             patch("agentrail.context.daemon.rpc", return_value=status_resp):
            rc, out = self._run_doctor_for(self._tmp)
        self.assertIn("daemon:", out)
        self.assertIn("warn", out)
        self.assertIn("stale", out)
        self.assertIn("77777", out)

    def test_daemon_rpc_error_shows_skipped(self):
        """AC4 (SKIP): RPC error → skipped."""
        self._sock.touch()
        with patch("agentrail.context.daemon.socket_path_for", return_value=self._sock), \
             patch("agentrail.context.daemon.rpc", side_effect=OSError("refused")):
            rc, out = self._run_doctor_for(self._tmp)
        self.assertIn("daemon:", out)
        self.assertIn("skipped", out)

    def test_ac5_existing_sections_present(self):
        """AC5: daemon section added without removing existing doctor sections."""
        with patch("agentrail.context.daemon.socket_path_for", return_value=self._sock):
            rc, out = self._run_doctor_for(self._tmp)
        # Core sections must remain
        self.assertIn("AgentRail doctor:", out)
        self.assertIn("core:", out)
        self.assertIn("state:", out)
        self.assertIn("dashboard:", out)
        self.assertIn("daemon:", out)
        self.assertIn("github:", out)
        self.assertIn("recommendations:", out)


if __name__ == "__main__":
    unittest.main()
