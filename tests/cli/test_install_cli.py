"""Tests for the native ``agentrail init`` / ``agentrail install`` command."""
from __future__ import annotations

import io
import json
import os
import tempfile
from pathlib import Path
from typing import Optional
from unittest import TestCase
from unittest.mock import patch


def _make_repo() -> Path:
    """Build a minimal AgentRail source repo (templates/skills/agentrail/scripts/package.json)."""
    repo = Path(tempfile.mkdtemp())

    (repo / "package.json").write_text(json.dumps({"name": "@useagentrail/cli", "version": "9.9.9"}))

    (repo / "templates").mkdir()
    (repo / "templates" / "AGENTS.md").write_text("# Agents\nHello\n")
    (repo / "templates" / "some-template.md").write_text("# Template\nWorld\n")
    # hidden under scripts/ — excluded from inventory
    (repo / "templates" / "scripts").mkdir()
    (repo / "templates" / "scripts" / "hidden.sh").write_text("#!/bin/sh\n")
    # skip-pattern: TASTE.md excluded
    (repo / "templates" / "TASTE.md").write_text("# Taste\n")

    (repo / "skills" / "my-skill").mkdir(parents=True)
    (repo / "skills" / "my-skill" / "SKILL.md").write_text("# Skill\n")

    # context-first hook source (#519) — lives under templates/scripts (hidden
    # prefix, not installed to the surface) and is placed by _install_claude_hooks.
    (repo / "templates" / "scripts").mkdir(exist_ok=True)
    (repo / "templates" / "scripts" / "context-first.sh").write_text("#!/usr/bin/env bash\nexit 0\n")

    scripts = repo / "scripts"
    scripts.mkdir()
    launcher = scripts / "agentrail"
    launcher.write_text("#!/usr/bin/env bash\necho launcher\n")
    launcher.chmod(0o755)

    (repo / "agentrail").mkdir()
    (repo / "agentrail" / "__init__.py").write_text("")
    (repo / "agentrail" / "cli").mkdir()
    (repo / "agentrail" / "cli" / "__init__.py").write_text("")

    return repo


def _run_install(repo: Path, target: Path, extra_args=None, now="2024-01-01T00:00:00.000Z"):
    from agentrail.cli.commands.install import run_install
    args = ["--target", str(target)] + (extra_args or [])
    with patch("agentrail.cli.commands.install._repo_dir", return_value=repo):
        return run_install(args, _now=now)


class TestFreshInstall(TestCase):
    def setUp(self):
        self.repo = _make_repo()
        self.target = Path(tempfile.mkdtemp())

    def test_returns_zero(self):
        self.assertEqual(_run_install(self.repo, self.target), 0)

    def test_copies_managed_files_to_surface(self):
        _run_install(self.repo, self.target)
        self.assertTrue((self.target / "AGENTS.md").exists())
        self.assertTrue((self.target / "some-template.md").exists())
        self.assertTrue((self.target / "skills" / "my-skill" / "SKILL.md").exists())
        self.assertTrue((self.target / "scripts" / "agentrail").exists())

    def test_skip_patterns_not_installed(self):
        _run_install(self.repo, self.target)
        self.assertFalse((self.target / "TASTE.md").exists())
        # hidden templates/scripts/* never land on surface
        self.assertFalse((self.target / "scripts" / "hidden.sh").exists())

    def test_state_records_version(self):
        _run_install(self.repo, self.target)
        state = json.loads((self.target / ".agentrail" / "state.json").read_text())
        self.assertEqual(state["agentrailVersion"], "9.9.9")
        self.assertEqual(state["schemaVersion"], 1)

    def test_state_records_content_hashes(self):
        _run_install(self.repo, self.target)
        state = json.loads((self.target / ".agentrail" / "state.json").read_text())
        agents = next(f for f in state["managedFiles"] if f["path"] == "AGENTS.md")
        self.assertTrue(agents["contentHash"].startswith("sha256:"))
        self.assertEqual(agents["installStatus"], "installed")

    def test_workflow_fields_present(self):
        _run_install(self.repo, self.target)
        state = json.loads((self.target / ".agentrail" / "state.json").read_text())
        for field in ("phase", "activeIssue", "completedRuns", "goals", "nextSuggestedAction"):
            self.assertIn(field, state["workflow"])

    def test_fresh_install_not_legacy_adopted(self):
        _run_install(self.repo, self.target)
        state = json.loads((self.target / ".agentrail" / "state.json").read_text())
        self.assertFalse(state["legacyAdopted"])

    def test_config_written(self):
        _run_install(self.repo, self.target)
        config = json.loads((self.target / ".agentrail" / "config.json").read_text())
        self.assertEqual(config["schemaVersion"], 1)
        self.assertIn(".agentrail/source/**", config["context"]["excludeGlobs"])

    def test_tracks_skill_and_registry_sources(self):
        _run_install(self.repo, self.target)
        state = json.loads((self.target / ".agentrail" / "state.json").read_text())
        skill = next(f for f in state["managedFiles"] if f["path"] == "skills/my-skill/SKILL.md")
        self.assertEqual(skill["source"], "skills/my-skill/SKILL.md")


class TestClaudeSkillsInstall(TestCase):
    """AC1: .claude/skills/<name>/SKILL.md installed for every repo skill."""

    def setUp(self):
        self.repo = _make_repo()
        self.target = Path(tempfile.mkdtemp())

    def test_skill_installed_in_claude_skills(self):
        _run_install(self.repo, self.target)
        self.assertTrue(
            (self.target / ".claude" / "skills" / "my-skill" / "SKILL.md").exists()
        )

    def test_skill_content_copied(self):
        _run_install(self.repo, self.target)
        content = (self.target / ".claude" / "skills" / "my-skill" / "SKILL.md").read_text()
        self.assertEqual(content, "# Skill\n")

    def test_reinstall_overwrites_skill(self):
        _run_install(self.repo, self.target)
        # Overwrite the installed copy with different content
        dest = self.target / ".claude" / "skills" / "my-skill" / "SKILL.md"
        dest.write_text("# Old\n")
        # Re-run install
        _run_install(self.repo, self.target)
        self.assertEqual(dest.read_text(), "# Skill\n")

    def test_multiple_skills_all_installed(self):
        # Add a second skill to the repo
        (self.repo / "skills" / "other-skill").mkdir(parents=True, exist_ok=True)
        (self.repo / "skills" / "other-skill" / "SKILL.md").write_text("# Other\n")
        _run_install(self.repo, self.target)
        self.assertTrue(
            (self.target / ".claude" / "skills" / "my-skill" / "SKILL.md").exists()
        )
        self.assertTrue(
            (self.target / ".claude" / "skills" / "other-skill" / "SKILL.md").exists()
        )

    def test_no_skills_dir_does_not_error(self):
        # Remove skills dir from repo
        import shutil as _sh
        _sh.rmtree(str(self.repo / "skills"))
        rc = _run_install(self.repo, self.target)
        self.assertEqual(rc, 0)


class TestClaudeHooksInstall(TestCase):
    """#519: context-first PreToolUse hook installed + wired into settings.json."""

    def setUp(self):
        self.repo = _make_repo()
        self.target = Path(tempfile.mkdtemp())

    def test_hook_script_installed_and_executable(self):
        _run_install(self.repo, self.target)
        hook = self.target / ".agentrail" / "hooks" / "context-first.sh"
        self.assertTrue(hook.exists())
        self.assertTrue(os.access(hook, os.X_OK))

    def test_hook_not_placed_on_project_surface(self):
        # templates/scripts/* is the hidden prefix — never installed as a managed file.
        _run_install(self.repo, self.target)
        self.assertFalse((self.target / "scripts" / "context-first.sh").exists())
        self.assertFalse((self.target / "hooks" / "context-first.sh").exists())

    def test_settings_json_wired(self):
        _run_install(self.repo, self.target)
        settings = json.loads((self.target / ".claude" / "settings.json").read_text())
        entries = settings["hooks"]["PreToolUse"]
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["matcher"], "Grep|Glob|Bash")
        self.assertEqual(
            entries[0]["hooks"][0]["command"], ".agentrail/hooks/context-first.sh"
        )

    def test_settings_merge_preserves_existing(self):
        settings_path = self.target / ".claude" / "settings.json"
        settings_path.parent.mkdir(parents=True, exist_ok=True)
        settings_path.write_text(json.dumps({"model": "opus", "hooks": {"PostToolUse": []}}))
        _run_install(self.repo, self.target)
        settings = json.loads(settings_path.read_text())
        self.assertEqual(settings["model"], "opus")
        self.assertIn("PostToolUse", settings["hooks"])
        self.assertEqual(len(settings["hooks"]["PreToolUse"]), 1)

    def test_reinstall_idempotent_no_duplicate_entry(self):
        _run_install(self.repo, self.target)
        _run_install(self.repo, self.target)
        settings = json.loads((self.target / ".claude" / "settings.json").read_text())
        self.assertEqual(len(settings["hooks"]["PreToolUse"]), 1)

    def test_no_hook_source_does_not_error(self):
        (self.repo / "templates" / "scripts" / "context-first.sh").unlink()
        rc = _run_install(self.repo, self.target)
        self.assertEqual(rc, 0)
        self.assertFalse((self.target / ".agentrail" / "hooks" / "context-first.sh").exists())


class TestVendorTrim(TestCase):
    """#404 Option B: only the native package + runtime data dirs + package.json."""

    def setUp(self):
        self.repo = _make_repo()
        self.target = Path(tempfile.mkdtemp())

    def test_vendor_contents(self):
        _run_install(self.repo, self.target)
        source = self.target / ".agentrail" / "source"
        self.assertTrue((source / "package.json").exists())
        self.assertTrue((source / "agentrail").is_dir())
        self.assertTrue((source / "templates").is_dir())
        self.assertTrue((source / "skills").is_dir())

    def test_no_editable_flow_scripts_vendored(self):
        _run_install(self.repo, self.target)
        source = self.target / ".agentrail" / "source"
        self.assertFalse((source / "scripts").exists(),
                         ".agentrail/source/scripts must not be vendored")

    def test_native_package_vendored(self):
        _run_install(self.repo, self.target)
        source = self.target / ".agentrail" / "source"
        self.assertTrue((source / "agentrail" / "__init__.py").exists())

    def test_vendor_package_json_present_for_launcher_redirect(self):
        _run_install(self.repo, self.target)
        source = self.target / ".agentrail" / "source"
        pkg = json.loads((source / "package.json").read_text())
        self.assertEqual(pkg["name"], "@useagentrail/cli")


class TestLegacyAdoption(TestCase):
    def setUp(self):
        self.repo = _make_repo()
        self.target = Path(tempfile.mkdtemp())

    def test_preexisting_managed_file_adopts(self):
        # A managed file already exists with local edits and no prior state.
        (self.target / "AGENTS.md").write_text("# Local edit\nKeep me\n")
        _run_install(self.repo, self.target)
        # Local edit preserved
        self.assertIn("Keep me", (self.target / "AGENTS.md").read_text())
        state = json.loads((self.target / ".agentrail" / "state.json").read_text())
        self.assertTrue(state["legacyAdopted"])
        agents = next(f for f in state["managedFiles"] if f["path"] == "AGENTS.md")
        self.assertEqual(agents["installStatus"], "legacy-adopted")


class TestArgs(TestCase):
    def setUp(self):
        self.repo = _make_repo()

    def test_target_missing_argument(self):
        from agentrail.cli.commands.install import run_install
        buf = io.StringIO()
        with patch("agentrail.cli.commands.install._repo_dir", return_value=self.repo), \
             patch("sys.stderr", buf):
            rc = run_install(["--target", "--force"])
        self.assertEqual(rc, 2)
        self.assertIn("--target requires a directory", buf.getvalue())

    def test_unknown_option(self):
        from agentrail.cli.commands.install import run_install
        buf = io.StringIO()
        with patch("agentrail.cli.commands.install._repo_dir", return_value=self.repo), \
             patch("sys.stderr", buf):
            rc = run_install(["--bogus"])
        self.assertEqual(rc, 2)

    def test_help_returns_zero(self):
        from agentrail.cli.commands.install import run_install
        with patch("agentrail.cli.commands.install._repo_dir", return_value=self.repo):
            rc = run_install(["--help"])
        self.assertEqual(rc, 0)


class TestGithubLabels(TestCase):
    def setUp(self):
        self.repo = _make_repo()
        self.target = Path(tempfile.mkdtemp())

    def test_labels_call_gh_for_each_required_label(self):
        from agentrail.cli.commands.doctor import REQUIRED_LABELS
        calls = []

        def fake_run(argv, **kwargs):
            calls.append(argv)
            class P:
                returncode = 0
            return P()

        with patch("agentrail.cli.commands.install._repo_dir", return_value=self.repo), \
             patch("agentrail.cli.commands.install.shutil.which", return_value="/usr/bin/gh"), \
             patch("agentrail.cli.commands.install.subprocess.run", side_effect=fake_run):
            from agentrail.cli.commands.install import run_install
            rc = run_install(["--target", str(self.target), "--github-labels"], _now="2024-01-01T00:00:00.000Z")
        self.assertEqual(rc, 0)
        label_calls = [c for c in calls if "label" in c]
        created = {c[c.index("create") + 1] for c in label_calls}
        self.assertEqual(created, set(REQUIRED_LABELS))

    def test_labels_skipped_when_gh_missing(self):
        with patch("agentrail.cli.commands.install._repo_dir", return_value=self.repo), \
             patch("agentrail.cli.commands.install.shutil.which", return_value=None), \
             patch("agentrail.cli.commands.install.subprocess.run") as mock_run:
            from agentrail.cli.commands.install import run_install
            rc = run_install(["--target", str(self.target), "--github-labels"], _now="2024-01-01T00:00:00.000Z")
        self.assertEqual(rc, 0)
        mock_run.assert_not_called()


class TestMainRouting(TestCase):
    def test_main_routes_init(self):
        import agentrail.cli.main as m
        with patch("agentrail.cli.main.run_install", return_value=0) as mock_ri:
            rc = m.main(["init", "--target", "/x"])
        mock_ri.assert_called_once_with(["--target", "/x"])
        self.assertEqual(rc, 0)

    def test_main_routes_install(self):
        import agentrail.cli.main as m
        with patch("agentrail.cli.main.run_install", return_value=0) as mock_ri:
            rc = m.main(["install", "--github-labels"])
        mock_ri.assert_called_once_with(["--github-labels"])
        self.assertEqual(rc, 0)


class TestParityWithBash(TestCase):
    """Install the legacy bash installer into dir A and the native installer into
    dir B with the same args; project-owned files MUST be identical. The only
    intended divergence is .agentrail/source (the #404 trim)."""

    def setUp(self):
        # Use the REAL repo for parity (bash needs the real templates/skills).
        from agentrail.cli.main import _repo_dir
        self.repo = _repo_dir()

    def _canonical_state(self, path: Path) -> dict:
        s = json.loads(path.read_text())
        # Drop timestamps (non-deterministic between the two runs).
        s.pop("installedAt", None)
        s.pop("updatedAt", None)
        return s

    def _tree(self, root: Path):
        files = {}
        for p in sorted(root.rglob("*")):
            if p.is_file():
                rel = p.relative_to(root).as_posix()
                if rel.startswith(".agentrail/source/"):
                    continue  # intended divergence (#404 trim)
                if rel in (".agentrail/state.json", ".agentrail/config.json"):
                    continue  # compared separately / canonicalized
                if rel.startswith(".git/"):
                    continue
                if rel.endswith(".lock"):
                    continue  # native atomic-write sidecar, not a project file
                files[rel] = p.read_bytes()
        return files

    def _stage_legacy_installer(self) -> Optional[Path]:
        """Materialize the legacy bash installer inside the real repo's scripts/
        dir (it derives repo_dir from its own location, so it must live there).
        Prefer the working tree; else reconstruct from git history. Returns the
        path, or None if unavailable. Caller is responsible for cleanup of a
        reconstructed copy (it is removed in the finally of test_parity)."""
        wt = self.repo / "scripts" / "install-workflow"
        if wt.exists():
            return wt
        import subprocess as sp
        for ref in ("HEAD", "origin/main", "main"):
            r = sp.run(["git", "-C", str(self.repo), "show",
                        f"{ref}:scripts/install-workflow"],
                       capture_output=True, text=True)
            if r.returncode == 0 and r.stdout:
                # Restore at the canonical path: the legacy installer's vendor
                # step does `cp scripts/install-workflow`, a self-reference that
                # only resolves when it lives at scripts/install-workflow.
                dest = self.repo / "scripts" / "install-workflow"
                dest.write_text(r.stdout)
                dest.chmod(0o755)
                return dest
        return None

    def test_parity(self):
        import shutil as _sh
        if _sh.which("node") is None:
            self.skipTest("node required by legacy bash installer is not on PATH")

        wt = self.repo / "scripts" / "install-workflow"
        existed_in_tree = wt.exists()
        bash_installer = self._stage_legacy_installer()
        if bash_installer is None:
            self.skipTest("legacy bash install-workflow not resolvable from git")
        # Only clean up a copy we materialized (don't delete a real working-tree file).
        reconstructed = not existed_in_tree

        import subprocess as sp
        a = Path(tempfile.mkdtemp())
        b = Path(tempfile.mkdtemp())
        try:
            sp.run([str(bash_installer), "--target", str(a)], check=True,
                   stdout=sp.DEVNULL, stderr=sp.DEVNULL)
            _run_install(self.repo, b)
            self._assert_parity(a, b)
        finally:
            if reconstructed and bash_installer.exists():
                bash_installer.unlink()

    def _assert_parity(self, a: Path, b: Path):

        tree_a = self._tree(a)
        tree_b = self._tree(b)
        self.assertEqual(set(tree_a), set(tree_b),
                         "project-surface file sets differ between bash and native")
        for rel in tree_a:
            self.assertEqual(tree_a[rel], tree_b[rel], f"content differs for {rel}")

        # Canonicalized state.json + config.json identical.
        self.assertEqual(
            self._canonical_state(a / ".agentrail" / "state.json"),
            self._canonical_state(b / ".agentrail" / "state.json"),
        )
        self.assertEqual(
            json.loads((a / ".agentrail" / "config.json").read_text()),
            json.loads((b / ".agentrail" / "config.json").read_text()),
        )

        # The #404 divergence: native vendor has NO scripts dir.
        self.assertFalse((b / ".agentrail" / "source" / "scripts").exists())
