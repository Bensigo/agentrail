"""
Tests for ``agentrail upgrade`` — native Python port.

Covers:
- fresh install writes managed files, state.json, config.json
- idempotency: second run leaves files unchanged, state stable
- skip patterns: TASTE.md and templates/scripts/* excluded
- locally-modified preserve/force
- missing-restore
- config not overwritten without --force, overwritten with --force
- missing state.json → error
- parse_upgrade_args: --target, --force, unknown→rc2
- main.py routes "upgrade" to run_upgrade
- legacy-layout migration (repo-structure-v2 PR-6, #1137): moving
  CONTEXT.md/TASTE.md/docs/agents/docs/memory/skills into .agentrail/,
  merge-not-overwrite of pre-existing .agentrail/{config.json,
  hooks/context-first.sh,verify.sh,server.json}, idempotent re-run, and
  doctor's legacy-path warnings clearing after upgrade
"""
from __future__ import annotations

import json
import os
import stat
import tempfile
from pathlib import Path
from typing import Any, Dict
from unittest import TestCase
from unittest.mock import patch


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _sha256(path: Path) -> str:
    import hashlib
    return f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"


def _make_fake_repo(tmp_dir: str) -> Path:
    """
    Create a fake agentrail repo with:
      - package.json (version 9.9.9)
      - agentrail/templates/
          some-template.md         <- regular managed file
          scripts/hidden.sh        <- MUST be skipped (hidden prefix)
          TASTE.md                 <- MUST be skipped (skipPattern)
          docs/memory/note.md      <- MUST be skipped (skipPattern)
      - agentrail/skills/
          skills/my-skill/SKILL.md <- managed under "skills/" prefix
      - agentrail/scripts/agentrail          <- extraFiles
      - agentrail/scripts/install-workflow   <- for source materialization
      - agentrail/                 <- for source materialization
    """
    repo = Path(tmp_dir) / "fake-repo"

    # package.json
    repo.mkdir(parents=True)
    (repo / "package.json").write_text(json.dumps({"name": "@bensigo/agentrail", "version": "9.9.9"}))

    # agentrail/templates/
    (repo / "agentrail" / "templates").mkdir(parents=True)
    (repo / "agentrail" / "templates" / "some-template.md").write_text("# Template\nHello World\n")
    (repo / "agentrail" / "templates" / "scripts").mkdir()
    (repo / "agentrail" / "templates" / "scripts" / "hidden.sh").write_text("#!/bin/sh\necho hidden\n")
    (repo / "agentrail" / "templates" / "TASTE.md").write_text("# Taste\nSkip me\n")
    (repo / "agentrail" / "templates" / "docs" / "memory").mkdir(parents=True)
    (repo / "agentrail" / "templates" / "docs" / "memory" / "note.md").write_text("memory note\n")

    # agentrail/skills/
    (repo / "agentrail" / "skills" / "my-skill").mkdir(parents=True)
    (repo / "agentrail" / "skills" / "my-skill" / "SKILL.md").write_text("# Skill\nDo stuff\n")

    # agentrail/scripts/ (extraFiles + source materialization scripts)
    (repo / "agentrail" / "scripts").mkdir(parents=True)
    for script in ("agentrail", "install-workflow"):
        s = repo / "agentrail" / "scripts" / script
        s.write_text(f"#!/bin/sh\necho {script}\n")
        s.chmod(0o755)

    # agentrail/ package directory (for source materialization)
    (repo / "agentrail" / "__init__.py").write_text("")

    return repo


def _make_minimal_state(target: Path, managed_files=None) -> None:
    """Write a minimal .agentrail/state.json to target."""
    agentrail_dir = target / ".agentrail"
    agentrail_dir.mkdir(parents=True, exist_ok=True)
    state = {
        "schemaVersion": 1,
        "agentrailVersion": "0.0.1",
        "installedAt": "2025-01-01T00:00:00.000Z",
        "updatedAt": "2025-01-01T00:00:00.000Z",
        "legacyAdopted": False,
        "managedFiles": managed_files if managed_files is not None else [],
        "workflow": {
            "phase": "idle",
        },
    }
    (agentrail_dir / "state.json").write_text(json.dumps(state, indent=2) + "\n")


def _run_upgrade(repo: Path, target: Path, extra_args=None):
    from agentrail.cli.commands.upgrade import run_upgrade
    args = ["--target", str(target)]
    if extra_args:
        args.extend(extra_args)
    with patch("agentrail.cli.commands.upgrade._repo_dir", return_value=repo):
        rc = run_upgrade(args, _now="2026-01-01T00:00:00.000Z")
    return rc


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestFreshUpgrade(TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.repo = _make_fake_repo(self.tmp)
        self.target = Path(self.tmp) / "target"
        self.target.mkdir()
        _make_minimal_state(self.target)

    def test_fresh_upgrade_installs_files(self):
        import io
        buf = io.StringIO()
        with patch("sys.stdout", buf):
            rc = _run_upgrade(self.repo, self.target)
        self.assertEqual(rc, 0)
        output = buf.getvalue()
        self.assertIn("AgentRail upgrade:", output)
        self.assertIn("updated: .agentrail/state.json", output)

        # Managed files should exist in target. House-2 dedupe (repo-structure-v2
        # PR-6, #1137): skills/ is installed to .agentrail/skills/ only — the
        # legacy top-level skills/ copy is no longer (re)created by upgrade.
        self.assertTrue((self.target / "some-template.md").exists())
        self.assertTrue((self.target / ".agentrail" / "skills" / "my-skill" / "SKILL.md").exists())
        self.assertFalse((self.target / "skills" / "my-skill" / "SKILL.md").exists())
        self.assertTrue((self.target / "scripts" / "agentrail").exists())

    def test_fresh_upgrade_writes_state_json(self):
        _run_upgrade(self.repo, self.target)
        state = json.loads((self.target / ".agentrail" / "state.json").read_text())
        self.assertEqual(state["schemaVersion"], 1)
        self.assertEqual(state["agentrailVersion"], "9.9.9")
        self.assertEqual(state["updatedAt"], "2026-01-01T00:00:00.000Z")
        self.assertIsInstance(state["managedFiles"], list)
        self.assertGreater(len(state["managedFiles"]), 0)

        # Each managed file has path, source, contentHash, installStatus
        for mf in state["managedFiles"]:
            self.assertIn("path", mf)
            self.assertIn("source", mf)
            self.assertIn("contentHash", mf)
            self.assertIn("installStatus", mf)

        # Installed files have installStatus "added"
        paths = {mf["path"]: mf for mf in state["managedFiles"]}
        self.assertIn("some-template.md", paths)
        self.assertEqual(paths["some-template.md"]["installStatus"], "added")

    def test_fresh_upgrade_calls_write_state(self):
        # Guard against a regression to a bare write_text path: state.json must
        # be persisted through the atomic+flock write_state helper. Content-only
        # assertions can't catch that (write_text and write_state produce the
        # same bytes), so assert the helper itself is invoked.
        with patch("agentrail.cli.commands.upgrade.write_state") as ws:
            _run_upgrade(self.repo, self.target)
        ws.assert_called_once()
        state_path = Path(ws.call_args[0][0])
        self.assertEqual(state_path.name, "state.json")
        self.assertEqual(state_path.parent.name, ".agentrail")
        self.assertIsInstance(ws.call_args[0][1], dict)

    def test_fresh_upgrade_writes_config_json(self):
        import io
        buf = io.StringIO()
        with patch("sys.stdout", buf):
            _run_upgrade(self.repo, self.target)
        output = buf.getvalue()
        self.assertIn("updated: .agentrail/config.json", output)
        cfg = json.loads((self.target / ".agentrail" / "config.json").read_text())
        self.assertEqual(cfg["schemaVersion"], 1)
        self.assertIn("runner", cfg)
        self.assertIn("context", cfg)

    def test_fresh_upgrade_materializes_source(self):
        _run_upgrade(self.repo, self.target)
        source_dir = self.target / ".agentrail" / "source"
        self.assertTrue(source_dir.is_dir())
        # #404 Option B: vendor only the native package + runtime data dirs +
        # package.json (launcher redirect). The native agentrail/ package is
        # vendored so the launcher can resolve it.
        self.assertTrue((source_dir / "package.json").exists())
        self.assertTrue((source_dir / "agentrail").is_dir())
        self.assertTrue((source_dir / "agentrail" / "templates").is_dir())
        self.assertTrue((source_dir / "agentrail" / "skills").is_dir())
        # No editable flow scripts are vendored — projects can't fork orchestration.
        self.assertFalse((source_dir / "scripts").exists(),
                         ".agentrail/source/scripts must not be vendored (#404 Option B)")


class TestIdempotency(TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.repo = _make_fake_repo(self.tmp)
        self.target = Path(self.tmp) / "target"
        self.target.mkdir()
        _make_minimal_state(self.target)

    def test_second_run_no_install_lines(self):
        # First run
        _run_upgrade(self.repo, self.target)

        # Second run — capture output
        import io
        buf = io.StringIO()
        with patch("sys.stdout", buf):
            rc = _run_upgrade(self.repo, self.target)
        self.assertEqual(rc, 0)
        output = buf.getvalue()

        # No "installed:" lines on second run
        self.assertNotIn("\ninstalled:", output)
        self.assertNotIn("\nupdated: some-template", output)
        # state.json still updated (it's always written)
        self.assertIn("updated: .agentrail/state.json", output)

    def test_second_run_managed_files_stable(self):
        _run_upgrade(self.repo, self.target)
        state1 = json.loads((self.target / ".agentrail" / "state.json").read_text())

        _run_upgrade(self.repo, self.target)
        state2 = json.loads((self.target / ".agentrail" / "state.json").read_text())

        mf1 = {f["path"]: f for f in state1["managedFiles"]}
        mf2 = {f["path"]: f for f in state2["managedFiles"]}
        self.assertEqual(set(mf1.keys()), set(mf2.keys()))
        for p, f1 in mf1.items():
            f2 = mf2[p]
            self.assertEqual(f1["contentHash"], f2["contentHash"])
            self.assertEqual(f1["installStatus"], f2["installStatus"])


class TestSkipPatterns(TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.repo = _make_fake_repo(self.tmp)
        self.target = Path(self.tmp) / "target"
        self.target.mkdir()
        _make_minimal_state(self.target)

    def test_taste_md_not_in_managed(self):
        _run_upgrade(self.repo, self.target)
        state = json.loads((self.target / ".agentrail" / "state.json").read_text())
        paths = [mf["path"] for mf in state["managedFiles"]]
        self.assertNotIn("TASTE.md", paths)

    def test_hidden_scripts_not_in_managed(self):
        _run_upgrade(self.repo, self.target)
        state = json.loads((self.target / ".agentrail" / "state.json").read_text())
        paths = [mf["path"] for mf in state["managedFiles"]]
        # templates/scripts/* are hidden (startswith "scripts/")
        hidden = [p for p in paths if p.startswith("scripts/") and p != "scripts/agentrail"]
        self.assertEqual(hidden, [], f"Found hidden template paths: {hidden}")

    def test_docs_memory_not_in_managed(self):
        _run_upgrade(self.repo, self.target)
        state = json.loads((self.target / ".agentrail" / "state.json").read_text())
        paths = [mf["path"] for mf in state["managedFiles"]]
        for p in paths:
            self.assertFalse(p.startswith("docs/memory/"), f"docs/memory path leaked: {p}")

    def test_skills_included(self):
        # House-2 dedupe (repo-structure-v2 PR-6, #1137): upgrade tracks
        # skills only at the new .agentrail/skills/ location — the legacy
        # top-level skills/ path is never (re)created or tracked.
        _run_upgrade(self.repo, self.target)
        state = json.loads((self.target / ".agentrail" / "state.json").read_text())
        paths = [mf["path"] for mf in state["managedFiles"]]
        self.assertIn(".agentrail/skills/my-skill/SKILL.md", paths)
        self.assertNotIn("skills/my-skill/SKILL.md", paths)

    def test_scripts_agentrail_extrafile_included(self):
        _run_upgrade(self.repo, self.target)
        state = json.loads((self.target / ".agentrail" / "state.json").read_text())
        paths = [mf["path"] for mf in state["managedFiles"]]
        self.assertIn("scripts/agentrail", paths)


class TestLocallyModified(TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.repo = _make_fake_repo(self.tmp)
        self.target = Path(self.tmp) / "target"
        self.target.mkdir()
        _make_minimal_state(self.target)
        # First install
        _run_upgrade(self.repo, self.target)
        # Now read state so we have contentHash for some-template.md
        self.state = json.loads((self.target / ".agentrail" / "state.json").read_text())

    def _get_managed(self, path: str) -> Dict[str, Any]:
        for mf in self.state["managedFiles"]:
            if mf["path"] == path:
                return mf
        raise KeyError(path)

    def test_locally_modified_preserved_without_force(self):
        """Editing a managed file then upgrading without --force preserves local edit."""
        (self.target / "some-template.md").write_text("# LOCAL EDIT\nI changed this\n")
        original_content = (self.target / "some-template.md").read_text()

        import io
        buf = io.StringIO()
        with patch("sys.stdout", buf):
            rc = _run_upgrade(self.repo, self.target)
        self.assertEqual(rc, 0)
        output = buf.getvalue()

        # File should be unchanged (local edit preserved)
        self.assertEqual((self.target / "some-template.md").read_text(), original_content)
        self.assertIn("preserved local: some-template.md", output)

    def test_locally_modified_overwritten_with_force(self):
        """Editing a managed file then upgrading WITH --force overwrites it."""
        (self.target / "some-template.md").write_text("# LOCAL EDIT\nI changed this\n")
        original_repo_content = (self.repo / "agentrail" / "templates" / "some-template.md").read_text()

        import io
        buf = io.StringIO()
        with patch("sys.stdout", buf):
            rc = _run_upgrade(self.repo, self.target, ["--force"])
        self.assertEqual(rc, 0)
        output = buf.getvalue()

        # File should be overwritten with repo content
        self.assertEqual((self.target / "some-template.md").read_text(), original_repo_content)
        self.assertIn("forced: some-template.md", output)

    def test_locally_modified_installstatus(self):
        """Without force: installStatus remains preserved for locally modified file."""
        (self.target / "some-template.md").write_text("# LOCAL EDIT\n")
        _run_upgrade(self.repo, self.target)
        state = json.loads((self.target / ".agentrail" / "state.json").read_text())
        mf = next(f for f in state["managedFiles"] if f["path"] == "some-template.md")
        self.assertEqual(mf["installStatus"], "preserved")

    def test_locally_modified_force_installstatus(self):
        """With force: installStatus becomes forced."""
        (self.target / "some-template.md").write_text("# LOCAL EDIT\n")
        _run_upgrade(self.repo, self.target, ["--force"])
        state = json.loads((self.target / ".agentrail" / "state.json").read_text())
        mf = next(f for f in state["managedFiles"] if f["path"] == "some-template.md")
        self.assertEqual(mf["installStatus"], "forced")


class TestMissingRestore(TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.repo = _make_fake_repo(self.tmp)
        self.target = Path(self.tmp) / "target"
        self.target.mkdir()
        _make_minimal_state(self.target)
        # First install
        _run_upgrade(self.repo, self.target)

    def test_missing_file_restored(self):
        # Delete managed file
        managed = self.target / "some-template.md"
        self.assertTrue(managed.exists())
        managed.unlink()
        self.assertFalse(managed.exists())

        import io
        buf = io.StringIO()
        with patch("sys.stdout", buf):
            rc = _run_upgrade(self.repo, self.target)
        self.assertEqual(rc, 0)
        output = buf.getvalue()

        self.assertTrue(managed.exists())
        self.assertIn("missing: some-template.md", output)
        self.assertIn("restored: some-template.md", output)

    def test_missing_installstatus(self):
        (self.target / "some-template.md").unlink()
        _run_upgrade(self.repo, self.target)
        state = json.loads((self.target / ".agentrail" / "state.json").read_text())
        mf = next(f for f in state["managedFiles"] if f["path"] == "some-template.md")
        self.assertEqual(mf["installStatus"], "restored")


class TestConfigHandling(TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.repo = _make_fake_repo(self.tmp)
        self.target = Path(self.tmp) / "target"
        self.target.mkdir()
        _make_minimal_state(self.target)

    def test_config_not_overwritten_without_force(self):
        # Write custom config
        agentrail_dir = self.target / ".agentrail"
        agentrail_dir.mkdir(parents=True, exist_ok=True)
        custom_config = {"schemaVersion": 99, "custom": True}
        (agentrail_dir / "config.json").write_text(json.dumps(custom_config))

        _run_upgrade(self.repo, self.target)
        read_back = json.loads((agentrail_dir / "config.json").read_text())
        self.assertEqual(read_back["schemaVersion"], 99)
        self.assertTrue(read_back["custom"])

    def test_config_overwritten_with_force(self):
        # Write custom config
        agentrail_dir = self.target / ".agentrail"
        agentrail_dir.mkdir(parents=True, exist_ok=True)
        custom_config = {"schemaVersion": 99, "custom": True}
        (agentrail_dir / "config.json").write_text(json.dumps(custom_config))

        _run_upgrade(self.repo, self.target, ["--force"])
        read_back = json.loads((agentrail_dir / "config.json").read_text())
        self.assertEqual(read_back["schemaVersion"], 1)
        self.assertNotIn("custom", read_back)


class TestMissingStateJson(TestCase):
    def test_missing_state_json_errors(self):
        tmp = tempfile.mkdtemp()
        repo = _make_fake_repo(tmp)
        target = Path(tmp) / "target"
        target.mkdir()
        # Do NOT write state.json

        import io
        err = io.StringIO()
        with patch("sys.stderr", err):
            rc = _run_upgrade(repo, target)
        self.assertNotEqual(rc, 0)
        self.assertIn("agentrail init first", err.getvalue())


class TestParseArgs(TestCase):
    def test_default_target_is_cwd(self):
        from agentrail.cli.commands.upgrade import parse_upgrade_args
        with patch("os.getcwd", return_value="/some/cwd"):
            target, force = parse_upgrade_args([])
        self.assertEqual(target, "/some/cwd")
        self.assertFalse(force)

    def test_target_flag(self):
        from agentrail.cli.commands.upgrade import parse_upgrade_args
        target, force = parse_upgrade_args(["--target", "/my/dir"])
        self.assertEqual(target, "/my/dir")
        self.assertFalse(force)

    def test_force_flag(self):
        from agentrail.cli.commands.upgrade import parse_upgrade_args
        target, force = parse_upgrade_args(["--force"])
        self.assertTrue(force)

    def test_target_and_force(self):
        from agentrail.cli.commands.upgrade import parse_upgrade_args
        target, force = parse_upgrade_args(["--target", "/x", "--force"])
        self.assertEqual(target, "/x")
        self.assertTrue(force)

    def test_unknown_arg_rc2(self):
        from agentrail.cli.commands.upgrade import run_upgrade
        tmp = tempfile.mkdtemp()
        repo = _make_fake_repo(tmp)
        import io
        err = io.StringIO()
        with patch("sys.stderr", err), \
             patch("agentrail.cli.commands.upgrade._repo_dir", return_value=repo):
            rc = run_upgrade(["--unknown-flag"])
        self.assertEqual(rc, 2)

    def test_target_missing_value_rc2(self):
        from agentrail.cli.commands.upgrade import run_upgrade
        tmp = tempfile.mkdtemp()
        repo = _make_fake_repo(tmp)
        import io
        err = io.StringIO()
        with patch("sys.stderr", err), \
             patch("agentrail.cli.commands.upgrade._repo_dir", return_value=repo):
            rc = run_upgrade(["--target"])
        self.assertEqual(rc, 2)


class TestMainRouting(TestCase):
    def test_main_routes_upgrade(self):
        import agentrail.cli.main as m
        with patch("agentrail.cli.main.run_upgrade", return_value=0) as mock_up:
            rc = m.main(["upgrade", "--target", "/x"])
        mock_up.assert_called_once_with(["--target", "/x"])
        self.assertEqual(rc, 0)

    def test_main_routes_upgrade_force(self):
        import agentrail.cli.main as m
        with patch("agentrail.cli.main.run_upgrade", return_value=0) as mock_up:
            rc = m.main(["upgrade", "--force"])
        mock_up.assert_called_once_with(["--force"])
        self.assertEqual(rc, 0)


class TestWorkflowMerge(TestCase):
    """Verify that existing workflow fields are preserved/merged."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.repo = _make_fake_repo(self.tmp)
        self.target = Path(self.tmp) / "target"
        self.target.mkdir()

    def test_workflow_fields_preserved(self):
        """Existing workflow fields like activeIssue are preserved."""
        agentrail_dir = self.target / ".agentrail"
        agentrail_dir.mkdir(parents=True)
        state = {
            "schemaVersion": 1,
            "agentrailVersion": "0.0.1",
            "installedAt": "2025-01-01T00:00:00.000Z",
            "updatedAt": "2025-01-01T00:00:00.000Z",
            "legacyAdopted": False,
            "managedFiles": [],
            "workflow": {
                "phase": "active",
                "activeIssue": 42,
                "completedRuns": [{"issue": 1}],
                "goals": ["do stuff"],
                "worktrees": ["wt1"],
            },
        }
        (agentrail_dir / "state.json").write_text(json.dumps(state, indent=2) + "\n")

        _run_upgrade(self.repo, self.target)
        new_state = json.loads((agentrail_dir / "state.json").read_text())
        wf = new_state["workflow"]
        self.assertEqual(wf["phase"], "active")
        self.assertEqual(wf["activeIssue"], 42)
        self.assertEqual(wf["completedRuns"], [{"issue": 1}])
        self.assertEqual(wf["goals"], ["do stuff"])
        self.assertEqual(wf["worktrees"], ["wt1"])

    def test_installed_at_preserved(self):
        """installedAt from previous state.json is preserved."""
        agentrail_dir = self.target / ".agentrail"
        agentrail_dir.mkdir(parents=True)
        state = {
            "schemaVersion": 1,
            "agentrailVersion": "0.0.1",
            "installedAt": "2020-01-01T00:00:00.000Z",
            "updatedAt": "2020-01-01T00:00:00.000Z",
            "legacyAdopted": False,
            "managedFiles": [],
            "workflow": {},
        }
        (agentrail_dir / "state.json").write_text(json.dumps(state, indent=2) + "\n")

        _run_upgrade(self.repo, self.target)
        new_state = json.loads((agentrail_dir / "state.json").read_text())
        self.assertEqual(new_state["installedAt"], "2020-01-01T00:00:00.000Z")
        self.assertEqual(new_state["updatedAt"], "2026-01-01T00:00:00.000Z")

    def test_lists_coerced_when_not_lists(self):
        """workflow completedRuns/goals/worktrees that are not lists become []."""
        agentrail_dir = self.target / ".agentrail"
        agentrail_dir.mkdir(parents=True)
        state = {
            "schemaVersion": 1,
            "agentrailVersion": "0.0.1",
            "installedAt": "2025-01-01T00:00:00.000Z",
            "updatedAt": "2025-01-01T00:00:00.000Z",
            "legacyAdopted": False,
            "managedFiles": [],
            "workflow": {
                "completedRuns": "not-a-list",
                "goals": None,
                "worktrees": 42,
            },
        }
        (agentrail_dir / "state.json").write_text(json.dumps(state, indent=2) + "\n")

        _run_upgrade(self.repo, self.target)
        new_state = json.loads((agentrail_dir / "state.json").read_text())
        wf = new_state["workflow"]
        self.assertEqual(wf["completedRuns"], [])
        self.assertEqual(wf["goals"], [])
        self.assertEqual(wf["worktrees"], [])


class TestFileModeBits(TestCase):
    """Executable source files remain executable after copy."""

    def test_scripts_agentrail_is_executable(self):
        tmp = tempfile.mkdtemp()
        repo = _make_fake_repo(tmp)
        target = Path(tmp) / "target"
        target.mkdir()
        _make_minimal_state(target)

        _run_upgrade(repo, target)
        installed = target / "scripts" / "agentrail"
        self.assertTrue(installed.exists())
        mode = installed.stat().st_mode
        self.assertTrue(mode & stat.S_IXUSR, "scripts/agentrail should be executable")


class TestChangedUpdated(TestCase):
    """Source file updated since last install; user did NOT modify target → auto-update."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.repo = _make_fake_repo(self.tmp)
        self.target = Path(self.tmp) / "target"
        self.target.mkdir()
        _make_minimal_state(self.target)

    def test_source_changed_updates_target(self):
        # Step 1: fresh install — target hash == source hash == recorded contentHash
        _run_upgrade(self.repo, self.target)

        state_after_first = json.loads((self.target / ".agentrail" / "state.json").read_text())
        mf_first = next(f for f in state_after_first["managedFiles"] if f["path"] == "some-template.md")
        self.assertEqual(mf_first["installStatus"], "added")
        first_hash = mf_first["contentHash"]

        # Confirm target matches source
        self.assertEqual(_sha256(self.target / "some-template.md"), first_hash)

        # Step 2: mutate the SOURCE file in the fake repo (sourceHash changes)
        new_source_content = "# Template\nHello Updated World\n"
        (self.repo / "agentrail" / "templates" / "some-template.md").write_text(new_source_content)
        new_source_hash = _sha256(self.repo / "agentrail" / "templates" / "some-template.md")
        self.assertNotEqual(new_source_hash, first_hash, "source hash must differ after mutation")

        # Target file is still the freshly-installed version (currentHash == previous.contentHash)
        self.assertEqual(_sha256(self.target / "some-template.md"), first_hash)

        # Step 3: run upgrade again (no --force)
        import io
        buf = io.StringIO()
        with patch("sys.stdout", buf):
            rc = _run_upgrade(self.repo, self.target)
        self.assertEqual(rc, 0)
        output = buf.getvalue()

        # Step 4: assertions
        # Target file now equals new source content
        self.assertEqual((self.target / "some-template.md").read_text(), new_source_content)

        # Output contains "changed: some-template.md" and "updated: some-template.md"
        self.assertIn("changed: some-template.md", output)
        self.assertIn("updated: some-template.md", output)

        # State reflects installStatus == "updated" and contentHash == new source hash
        state_after_second = json.loads((self.target / ".agentrail" / "state.json").read_text())
        mf_second = next(f for f in state_after_second["managedFiles"] if f["path"] == "some-template.md")
        self.assertEqual(mf_second["installStatus"], "updated")
        self.assertEqual(mf_second["contentHash"], new_source_hash)


class TestAddedCategory(TestCase):
    """When a file exists in target but is NOT in managed and differs from source,
    it should get installStatus legacy-adopted (not overwritten)."""

    def test_existing_untracked_file_legacy_adopted(self):
        tmp = tempfile.mkdtemp()
        repo = _make_fake_repo(tmp)
        target = Path(tmp) / "target"
        target.mkdir()
        _make_minimal_state(target, managed_files=[])

        # Pre-create some-template.md with different content
        (target / "some-template.md").write_text("# I was here before install\n")
        original_content = (target / "some-template.md").read_text()

        import io
        buf = io.StringIO()
        with patch("sys.stdout", buf):
            rc = _run_upgrade(repo, target)
        self.assertEqual(rc, 0)
        output = buf.getvalue()

        # File should NOT be overwritten
        self.assertEqual((target / "some-template.md").read_text(), original_content)
        self.assertIn("preserved existing untracked: some-template.md", output)

        state = json.loads((target / ".agentrail" / "state.json").read_text())
        mf = next(f for f in state["managedFiles"] if f["path"] == "some-template.md")
        self.assertEqual(mf["installStatus"], "legacy-adopted")


# ---------------------------------------------------------------------------
# Legacy-layout migration (repo-structure-v2, PR-6 / #1137)
#
# These tests build a fixture that mimics a real pre-House-2 install: a
# top-level CONTEXT.md/TASTE.md, docs/agents/*, docs/memory/*, a dual
# skills/ + .claude/skills copy, AND a pre-existing .agentrail/ directory
# holding load-bearing local files (config.json, hooks/context-first.sh,
# verify.sh, server.json with a "live" API key) that must survive the
# migration byte-for-byte untouched. Covers AC1-AC4 of issue #1137.
# ---------------------------------------------------------------------------

_FAKE_SERVER_API_KEY = "sk-live-fakeButRealisticApiKey1234567890ABCDEF"


def _make_fake_repo_with_agents(tmp_dir: str) -> Path:
    """Like ``_make_fake_repo`` but also ships a ``docs/agents/*`` template
    (maps to ``.agentrail/agents/*`` per ``_map_template_destination``),
    needed to exercise the docs/agents/* -> .agentrail/agents/* migration."""
    repo = _make_fake_repo(tmp_dir)
    (repo / "agentrail" / "templates" / "docs" / "agents").mkdir(parents=True)
    (repo / "agentrail" / "templates" / "docs" / "agents" / "some-agent.md").write_text(
        "# Some Agent\nAgent doc content\n"
    )
    return repo


def _make_legacy_layout_target(tmp_dir: str) -> Path:
    """Build a legacy-layout target fixture: pre-House-2 install locations
    (root CONTEXT.md/TASTE.md, docs/agents/*, docs/memory/*, dual skills/ +
    .claude/skills copies) PLUS a pre-existing .agentrail/ directory holding
    load-bearing local files that ``upgrade`` must never overwrite/regenerate
    (config.json, hooks/context-first.sh, verify.sh, server.json with a fake
    "live" API key), and a legacy state.json whose managedFiles paths are all
    still at their pre-migration (legacy) locations.
    """
    target = Path(tmp_dir) / "legacy-target"
    target.mkdir(parents=True)

    # --- legacy root files ---
    (target / "CONTEXT.md").write_text("# Context\nOld root context\n")
    (target / "TASTE.md").write_text("# Taste\nOld root taste\n")

    # --- docs/agents/* (legacy location for what now maps to .agentrail/agents/*) ---
    (target / "docs" / "agents").mkdir(parents=True)
    (target / "docs" / "agents" / "some-agent.md").write_text("# Some Agent\nAgent doc content\n")

    # --- docs/memory/* (legacy location, never state-tracked) ---
    (target / "docs" / "memory").mkdir(parents=True)
    (target / "docs" / "memory" / "session-1.md").write_text("memory note from a real session\n")

    # --- dual skills/ + .claude/skills copies (legacy dedupe target) ---
    (target / "skills" / "my-skill").mkdir(parents=True)
    (target / "skills" / "my-skill" / "SKILL.md").write_text("# Skill\nDo stuff\n")
    (target / ".claude" / "skills" / "my-skill").mkdir(parents=True)
    (target / ".claude" / "skills" / "my-skill" / "SKILL.md").write_text("# Skill\nDo stuff\n")

    # --- pre-existing .agentrail/ dir with load-bearing local files ---
    agentrail_dir = target / ".agentrail"
    agentrail_dir.mkdir(parents=True, exist_ok=True)
    (agentrail_dir / "config.json").write_text(
        json.dumps({"custom": "hand-edited config, must survive untouched"}, indent=2) + "\n"
    )
    (agentrail_dir / "hooks").mkdir(parents=True, exist_ok=True)
    (agentrail_dir / "hooks" / "context-first.sh").write_text(
        "#!/bin/sh\n# custom hook, hand-edited, must survive untouched\necho custom-hook\n"
    )
    (agentrail_dir / "hooks" / "context-first.sh").chmod(0o755)
    (agentrail_dir / "verify.sh").write_text(
        "#!/bin/sh\n# custom verify script, hand-edited, must survive untouched\nexit 0\n"
    )
    (agentrail_dir / "verify.sh").chmod(0o755)
    (agentrail_dir / "server.json").write_text(
        json.dumps({"apiKey": _FAKE_SERVER_API_KEY}, indent=2) + "\n"
    )

    # --- legacy state.json: managedFiles at PRE-migration (legacy) paths ---
    managed_files = [
        {
            "path": "CONTEXT.md",
            "contentHash": _sha256(target / "CONTEXT.md"),
            "installStatus": "installed",
        },
        {
            "path": "docs/agents/some-agent.md",
            "contentHash": _sha256(target / "docs" / "agents" / "some-agent.md"),
            "installStatus": "installed",
        },
        {
            "path": "skills/my-skill/SKILL.md",
            "contentHash": _sha256(target / "skills" / "my-skill" / "SKILL.md"),
            "installStatus": "installed",
        },
    ]
    state = {
        "schemaVersion": 1,
        "agentrailVersion": "0.0.1",
        "installedAt": "2025-01-01T00:00:00.000Z",
        "updatedAt": "2025-01-01T00:00:00.000Z",
        "legacyAdopted": False,
        "managedFiles": managed_files,
        "workflow": {"phase": "idle"},
    }
    (agentrail_dir / "state.json").write_text(json.dumps(state, indent=2) + "\n")

    return target


class TestLegacyLayoutMigration(TestCase):
    """Repo-structure-v2 PR-6 (#1137): ``agentrail upgrade`` physically
    migrates a legacy-layout install into ``.agentrail/``, merging into (never
    overwriting/recreating) any pre-existing load-bearing local files."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.repo = _make_fake_repo_with_agents(self.tmp)
        self.target = _make_legacy_layout_target(self.tmp)

        # Snapshot pre-existing load-bearing local files BEFORE running
        # upgrade, so we can assert byte-for-byte identity afterward.
        self.config_before = (self.target / ".agentrail" / "config.json").read_bytes()
        self.hook_before = (self.target / ".agentrail" / "hooks" / "context-first.sh").read_bytes()
        self.verify_before = (self.target / ".agentrail" / "verify.sh").read_bytes()
        self.server_json_before = (self.target / ".agentrail" / "server.json").read_bytes()

    # --- AC1 ---

    def test_ac1_migrates_to_exact_house2_tree_preserving_local_files(self):
        rc = _run_upgrade(self.repo, self.target)
        self.assertEqual(rc, 0)

        # New House-2 locations exist with the migrated content.
        self.assertEqual(
            (self.target / ".agentrail" / "context.md").read_text(), "# Context\nOld root context\n"
        )
        self.assertEqual(
            (self.target / ".agentrail" / "taste.md").read_text(), "# Taste\nOld root taste\n"
        )
        self.assertEqual(
            (self.target / ".agentrail" / "agents" / "some-agent.md").read_text(),
            "# Some Agent\nAgent doc content\n",
        )
        self.assertEqual(
            (self.target / ".agentrail" / "memory" / "session-1.md").read_text(),
            "memory note from a real session\n",
        )
        self.assertTrue((self.target / ".agentrail" / "skills" / "my-skill" / "SKILL.md").exists())

        # Legacy locations are gone (fully migrated + pruned).
        self.assertFalse((self.target / "CONTEXT.md").exists())
        self.assertFalse((self.target / "TASTE.md").exists())
        self.assertFalse((self.target / "docs" / "agents").exists())
        self.assertFalse((self.target / "docs" / "memory").exists())
        self.assertFalse((self.target / "skills").exists())

        # skills/ is deduped: no longer tracked at its legacy path in state.json.
        state = json.loads((self.target / ".agentrail" / "state.json").read_text())
        paths = [mf["path"] for mf in state["managedFiles"]]
        self.assertIn(".agentrail/skills/my-skill/SKILL.md", paths)
        self.assertNotIn("skills/my-skill/SKILL.md", paths)

        # Pre-existing load-bearing local files survive byte-for-byte untouched.
        self.assertEqual((self.target / ".agentrail" / "config.json").read_bytes(), self.config_before)
        self.assertEqual(
            (self.target / ".agentrail" / "hooks" / "context-first.sh").read_bytes(), self.hook_before
        )
        self.assertEqual((self.target / ".agentrail" / "verify.sh").read_bytes(), self.verify_before)
        self.assertEqual((self.target / ".agentrail" / "server.json").read_bytes(), self.server_json_before)

    # --- AC2 ---

    def test_ac2_idempotent_second_run_is_a_noop(self):
        rc1 = _run_upgrade(self.repo, self.target)
        self.assertEqual(rc1, 0)

        tracked_relpaths = (
            ".agentrail/context.md",
            ".agentrail/taste.md",
            ".agentrail/agents/some-agent.md",
            ".agentrail/memory/session-1.md",
            ".agentrail/skills/my-skill/SKILL.md",
            ".agentrail/config.json",
            ".agentrail/hooks/context-first.sh",
            ".agentrail/verify.sh",
            ".agentrail/server.json",
        )
        after_first = {rel: (self.target / rel).read_bytes() for rel in tracked_relpaths}
        state_after_first = json.loads((self.target / ".agentrail" / "state.json").read_text())

        rc2 = _run_upgrade(self.repo, self.target)
        self.assertEqual(rc2, 0)

        for rel, content in after_first.items():
            self.assertEqual((self.target / rel).read_bytes(), content, f"{rel} changed on second run")

        # No legacy paths resurrected by the second run.
        self.assertFalse((self.target / "CONTEXT.md").exists())
        self.assertFalse((self.target / "TASTE.md").exists())
        self.assertFalse((self.target / "docs" / "agents").exists())
        self.assertFalse((self.target / "docs" / "memory").exists())
        self.assertFalse((self.target / "skills").exists())

        state_after_second = json.loads((self.target / ".agentrail" / "state.json").read_text())
        paths_first = sorted(mf["path"] for mf in state_after_first["managedFiles"])
        paths_second = sorted(mf["path"] for mf in state_after_second["managedFiles"])
        self.assertEqual(paths_first, paths_second)
        self.assertFalse(any(p.startswith("skills/") for p in paths_second))

    # --- AC3 ---

    def test_ac3_doctor_warns_then_clean_after_upgrade(self):
        from agentrail.cli.commands.doctor import run_doctor
        import io

        def _run_doctor_captured():
            buf = io.StringIO()

            def _fake_run(cmd, **kwargs):
                from unittest.mock import MagicMock
                m = MagicMock()
                m.returncode = 1
                m.stdout = ""
                return m

            with patch("agentrail.cli.commands.doctor._repo_dir", return_value=self.repo), \
                 patch("agentrail.cli.commands.doctor.subprocess.run", side_effect=_fake_run), \
                 patch("sys.stdout", buf):
                run_doctor(["--target", str(self.target)])
            return buf.getvalue()

        pre_output = _run_doctor_captured()

        # doctor warns with SPECIFIC legacy file paths (not a generic message)
        # for every subtree this PR migrates.
        self.assertIn(
            "warn CONTEXT.md found at legacy path (CONTEXT.md); "
            f"run `agentrail upgrade --target {self.target}` to migrate to .agentrail/context.md",
            pre_output,
        )
        self.assertIn(
            "warn TASTE.md found at legacy path (TASTE.md); "
            f"run `agentrail upgrade --target {self.target}` to migrate to .agentrail/taste.md",
            pre_output,
        )
        self.assertIn(
            "warn docs/agents/ found at legacy path (docs/agents); "
            f"run `agentrail upgrade --target {self.target}` to migrate to .agentrail/agents",
            pre_output,
        )
        self.assertIn(
            "warn skills/ found at legacy path (skills); "
            f"run `agentrail upgrade --target {self.target}` to migrate to .agentrail/skills",
            pre_output,
        )
        self.assertIn(
            "warn docs/memory/ found at legacy path (docs/memory); "
            f"run `agentrail upgrade --target {self.target}` to migrate to .agentrail/memory",
            pre_output,
        )

        _run_upgrade(self.repo, self.target)

        post_output = _run_doctor_captured()

        # None of the legacy-path warnings remain after upgrade completes.
        self.assertNotIn("found at legacy path", post_output)

    # --- AC4 ---

    def test_ac4_server_json_survives_byte_for_byte(self):
        server_path = self.target / ".agentrail" / "server.json"
        before = server_path.read_bytes()
        self.assertIn(_FAKE_SERVER_API_KEY.encode(), before)

        _run_upgrade(self.repo, self.target)
        after_first = server_path.read_bytes()
        self.assertEqual(after_first, before, "server.json (live API key) must never be regenerated")

        # Cover the idempotent (second-run) path too.
        _run_upgrade(self.repo, self.target)
        after_second = server_path.read_bytes()
        self.assertEqual(after_second, before, "server.json must remain untouched across repeat upgrades")
