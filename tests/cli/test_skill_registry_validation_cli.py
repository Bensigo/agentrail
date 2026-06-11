"""Pytest port of scripts/test-skill-registry-validation.

Tests validate_skill_registry (agentrail/cli/commands/doctor.py) and run_doctor
with real filesystem fixtures — no Node.js registry mutation needed.
"""
from __future__ import annotations

import json
import tempfile
from io import StringIO
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from agentrail.cli.commands.doctor import validate_skill_registry, run_doctor


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_SKILL_BODY_VALID = "\n".join([
    "# Frontend Web",
    "## Activation Guidance",
    "Use for frontend tasks.",
    "## Context To Inspect",
    "Look at src/.",
    "## Constraints",
    "Stay focused.",
    "## Verification Requirements",
    "Tests must pass.",
    "## Expected PR Evidence",
    "Screenshot attached.",
    "## Provenance / Audit",
    "First-party skill.",
])

_SKILL_BODY_MISSING_AUDIT = "\n".join([
    "# Frontend Web",
    "## Activation Guidance",
    "## Context To Inspect",
    "## Constraints",
    "## Verification Requirements",
    "## Expected PR Evidence",
    "# No Provenance section",
])


def _make_registry(skills=None) -> dict:
    """Return a minimal valid registry dict."""
    return {
        "schemaVersion": 1,
        "skills": skills if skills is not None else [
            {
                "name": "frontend-web",
                "localPath": "skills/frontend-web/SKILL.md",
                "description": "Build and modify web frontends",
                "licenseStatus": "ok",
                "auditStatus": "ok",
                "bundledByDefault": True,
                "triggers": {
                    "keywords": ["react", "frontend"],
                    "fileGlobs": [],
                    "projectSignals": [],
                },
                "provenance": {
                    "candidates": [{
                        "sourceName": "AgentRail",
                        "url": "https://example.com",
                        "relationship": "derived",
                        "verifiedStatus": "verified",
                        "auditNotes": "ok",
                    }],
                },
            }
        ],
    }


def _make_fixture(tmp_path: Path, registry_content=None, write_skill=True, skill_body=None) -> Path:
    """Create a target dir with optional registry and skill file."""
    target = tmp_path
    docs_agents = target / "docs" / "agents"
    docs_agents.mkdir(parents=True, exist_ok=True)

    if registry_content is not False:
        reg = registry_content if registry_content is not None else _make_registry()
        if isinstance(reg, dict):
            (docs_agents / "skill-registry.json").write_text(json.dumps(reg, indent=2))
        else:
            # raw string (e.g. "null", "false")
            (docs_agents / "skill-registry.json").write_text(reg)

    if write_skill:
        skill_dir = target / "skills" / "frontend-web"
        skill_dir.mkdir(parents=True, exist_ok=True)
        body = skill_body if skill_body is not None else _SKILL_BODY_VALID
        (skill_dir / "SKILL.md").write_text(body)

    return target


def _make_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir(exist_ok=True)
    (repo / "package.json").write_text(json.dumps({"version": "1.0.0"}))
    return repo


def _capture_doctor(target: Path, repo: Path) -> tuple[int, str]:
    buf = StringIO()

    def _fake_gh(cmd, **kwargs):
        m = MagicMock()
        m.returncode = 1
        m.stdout = ""
        return m

    with patch("agentrail.cli.commands.doctor._repo_dir", return_value=repo), \
         patch("agentrail.cli.commands.doctor.subprocess.run", side_effect=_fake_gh), \
         patch("sys.stdout", buf):
        rc = run_doctor(["--target", str(target)])
    return rc, buf.getvalue()


# ---------------------------------------------------------------------------
# validate_skill_registry — direct unit tests
# ---------------------------------------------------------------------------

class TestValidateSkillRegistryValid:
    def test_valid_registry_ok(self, tmp_path):
        repo = _make_repo(tmp_path)
        target = _make_fixture(tmp_path / "target")
        result = validate_skill_registry(str(target), repo)
        assert result.ok is True
        assert result.errors == []

    def test_valid_registry_reports_ok_skill_registry(self, tmp_path, capsys):
        """skills validate CLI reports 'ok skill registry' for a valid fixture."""
        from agentrail.cli.commands.skills import run_skills
        repo = _make_repo(tmp_path)
        target = _make_fixture(tmp_path / "target")
        buf = StringIO()
        with patch("agentrail.cli.commands.skills._repo_dir", return_value=repo), \
             patch("sys.stdout", buf):
            rc = run_skills(["validate", "--target", str(target)])
        assert rc == 0
        assert "ok skill registry" in buf.getvalue()


class TestValidateSkillRegistryNonObjectRoot:
    @pytest.mark.parametrize("raw_root", ["null", "false", "0", '""', "[]"])
    def test_non_object_root_rejected(self, tmp_path, raw_root):
        repo = _make_repo(tmp_path)
        safe_name = "".join(c if c.isalnum() else "_" for c in raw_root)
        target = _make_fixture(tmp_path / f"fixture_{safe_name}", write_skill=False)
        (target / "docs" / "agents" / "skill-registry.json").write_text(raw_root)
        result = validate_skill_registry(str(target), repo)
        assert result.ok is False
        assert any("registry root must be an object" in e for e in result.errors)

    @pytest.mark.parametrize("raw_root", ["null", "false", "0", '""', "[]"])
    def test_non_object_root_cli_rc1(self, tmp_path, raw_root):
        from agentrail.cli.commands.skills import run_skills
        repo = _make_repo(tmp_path)
        safe_name = "".join(c if c.isalnum() else "_" for c in raw_root)
        target = _make_fixture(tmp_path / f"cli_{safe_name}", write_skill=False)
        (target / "docs" / "agents" / "skill-registry.json").write_text(raw_root)
        buf = StringIO()
        with patch("agentrail.cli.commands.skills._repo_dir", return_value=repo), \
             patch("sys.stdout", buf):
            rc = run_skills(["validate", "--target", str(target)])
        assert rc == 1
        assert "registry root must be an object" in buf.getvalue()


class TestValidateSkillRegistryDuplicate:
    def test_duplicate_skill_names_rejected(self, tmp_path):
        repo = _make_repo(tmp_path)
        skill_entry = _make_registry()["skills"][0].copy()
        reg = _make_registry(skills=[skill_entry, dict(skill_entry)])  # duplicate name
        target = _make_fixture(tmp_path / "target", registry_content=reg)
        result = validate_skill_registry(str(target), repo)
        assert result.ok is False
        assert any("duplicate skill name" in e for e in result.errors)


class TestValidateSkillRegistryMissingDescription:
    def test_missing_required_field_description(self, tmp_path):
        repo = _make_repo(tmp_path)
        skill_entry = {k: v for k, v in _make_registry()["skills"][0].items() if k != "description"}
        reg = _make_registry(skills=[skill_entry])
        target = _make_fixture(tmp_path / "target", registry_content=reg)
        result = validate_skill_registry(str(target), repo)
        assert result.ok is False
        assert any("missing required field description" in e for e in result.errors)


class TestValidateSkillRegistryInvalidLocalPath:
    def test_nonexistent_localpath_rejected(self, tmp_path):
        repo = _make_repo(tmp_path)
        skill_entry = dict(_make_registry()["skills"][0])
        skill_entry["localPath"] = "skills/nope/SKILL.md"
        reg = _make_registry(skills=[skill_entry])
        target = _make_fixture(tmp_path / "target", registry_content=reg, write_skill=False)
        result = validate_skill_registry(str(target), repo)
        assert result.ok is False
        assert any("localPath does not exist" in e for e in result.errors)


class TestValidateSkillRegistryMissingRegistryFile:
    def test_missing_registry_file_cannot_read(self, tmp_path):
        repo = _make_repo(tmp_path)
        target = tmp_path / "target"
        target.mkdir()
        # No registry file at all
        result = validate_skill_registry(str(target), repo)
        assert result.ok is False
        assert any("cannot read registry" in e for e in result.errors)

    def test_missing_registry_cli_rc1(self, tmp_path):
        from agentrail.cli.commands.skills import run_skills
        repo = _make_repo(tmp_path)
        target = tmp_path / "target"
        target.mkdir()
        buf = StringIO()
        with patch("agentrail.cli.commands.skills._repo_dir", return_value=repo), \
             patch("sys.stdout", buf):
            rc = run_skills(["validate", "--target", str(target)])
        assert rc == 1
        assert "cannot read registry" in buf.getvalue()


class TestValidateSkillRegistryMissingSection:
    def test_skill_md_missing_provenance_audit_section(self, tmp_path):
        repo = _make_repo(tmp_path)
        target = _make_fixture(tmp_path / "target", skill_body=_SKILL_BODY_MISSING_AUDIT)
        result = validate_skill_registry(str(target), repo)
        assert result.ok is False
        assert any("missing SKILL.md section ## Provenance / Audit" in e for e in result.errors)


class TestValidateSkillRegistryMalformedTriggers:
    def test_keywords_as_string_rejected(self, tmp_path):
        repo = _make_repo(tmp_path)
        skill_entry = dict(_make_registry()["skills"][0])
        skill_entry["triggers"] = dict(skill_entry["triggers"])
        skill_entry["triggers"]["keywords"] = "frontend"  # string, not array
        reg = _make_registry(skills=[skill_entry])
        target = _make_fixture(tmp_path / "target", registry_content=reg)
        result = validate_skill_registry(str(target), repo)
        assert result.ok is False
        assert any("triggers.keywords must be an array" in e for e in result.errors)


# ---------------------------------------------------------------------------
# run_doctor integration — validates skill registry (from bash test-skill-registry-validation)
# ---------------------------------------------------------------------------

class TestDoctorWithMissingRegistry:
    def _make_installed(self, tmp_path: Path) -> Path:
        target = tmp_path / "target"
        target.mkdir()
        agentrail_dir = target / ".agentrail"
        agentrail_dir.mkdir()
        source_dir = agentrail_dir / "source"
        source_dir.mkdir()
        (source_dir / "package.json").write_text(json.dumps({"version": "1.0.0"}))
        state = {"agentrailVersion": "1.0.0", "managedFiles": []}
        (agentrail_dir / "state.json").write_text(json.dumps(state))
        return target

    def test_doctor_missing_registry_status_corrupt(self, tmp_path):
        repo = _make_repo(tmp_path)
        target = self._make_installed(tmp_path)
        # No registry file
        rc, out = _capture_doctor(target, repo)
        assert "status: corrupt" in out

    def test_doctor_missing_registry_reports_cannot_read(self, tmp_path):
        repo = _make_repo(tmp_path)
        target = self._make_installed(tmp_path)
        rc, out = _capture_doctor(target, repo)
        assert "cannot read registry" in out

    def test_doctor_missing_registry_reports_missing_file(self, tmp_path):
        repo = _make_repo(tmp_path)
        target = self._make_installed(tmp_path)
        rc, out = _capture_doctor(target, repo)
        assert "missing docs/agents/skill-registry.json" in out


class TestDoctorWithBrokenSkillPath:
    def _make_installed_with_broken_registry(self, tmp_path: Path) -> Path:
        target = tmp_path / "target"
        target.mkdir()
        agentrail_dir = target / ".agentrail"
        agentrail_dir.mkdir()
        source_dir = agentrail_dir / "source"
        source_dir.mkdir()
        (source_dir / "package.json").write_text(json.dumps({"version": "1.0.0"}))
        state = {"agentrailVersion": "1.0.0", "managedFiles": []}
        (agentrail_dir / "state.json").write_text(json.dumps(state))

        skill_entry = dict(_make_registry()["skills"][0])
        skill_entry["localPath"] = "skills/nope/SKILL.md"
        reg = _make_registry(skills=[skill_entry])
        docs_agents = target / "docs" / "agents"
        docs_agents.mkdir(parents=True)
        (docs_agents / "skill-registry.json").write_text(json.dumps(reg))
        return target

    def test_doctor_broken_skill_path_status_corrupt(self, tmp_path):
        repo = _make_repo(tmp_path)
        target = self._make_installed_with_broken_registry(tmp_path)
        rc, out = _capture_doctor(target, repo)
        assert "status: corrupt" in out

    def test_doctor_broken_skill_path_reports_localpath(self, tmp_path):
        repo = _make_repo(tmp_path)
        target = self._make_installed_with_broken_registry(tmp_path)
        rc, out = _capture_doctor(target, repo)
        assert "localPath does not exist: skills/nope/SKILL.md" in out


class TestDoctorWithInvalidRegistryRoot:
    def _make_installed_null_registry(self, tmp_path: Path) -> Path:
        target = tmp_path / "target"
        target.mkdir()
        agentrail_dir = target / ".agentrail"
        agentrail_dir.mkdir()
        source_dir = agentrail_dir / "source"
        source_dir.mkdir()
        (source_dir / "package.json").write_text(json.dumps({"version": "1.0.0"}))
        state = {"agentrailVersion": "1.0.0", "managedFiles": []}
        (agentrail_dir / "state.json").write_text(json.dumps(state))

        docs_agents = target / "docs" / "agents"
        docs_agents.mkdir(parents=True)
        (docs_agents / "skill-registry.json").write_text("null")
        return target

    def test_doctor_invalid_root_status_corrupt(self, tmp_path):
        repo = _make_repo(tmp_path)
        target = self._make_installed_null_registry(tmp_path)
        rc, out = _capture_doctor(target, repo)
        assert "status: corrupt" in out

    def test_doctor_invalid_root_reports_error(self, tmp_path):
        repo = _make_repo(tmp_path)
        target = self._make_installed_null_registry(tmp_path)
        rc, out = _capture_doctor(target, repo)
        assert "registry root must be an object" in out
