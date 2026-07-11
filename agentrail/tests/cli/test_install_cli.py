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
    """Build a minimal AgentRail source repo (agentrail/{templates,skills}, scripts/, package.json)."""
    repo = Path(tempfile.mkdtemp())

    (repo / "package.json").write_text(json.dumps({"name": "@useagentrail/cli", "version": "9.9.9"}))

    (repo / "agentrail" / "templates").mkdir(parents=True)
    (repo / "agentrail" / "templates" / "AGENTS.md").write_text("# Agents\nHello\n")
    (repo / "agentrail" / "templates" / "some-template.md").write_text("# Template\nWorld\n")
    # hidden under scripts/ — excluded from inventory
    (repo / "agentrail" / "templates" / "scripts").mkdir()
    (repo / "agentrail" / "templates" / "scripts" / "hidden.sh").write_text("#!/bin/sh\n")
    # skip-pattern: TASTE.md excluded
    (repo / "agentrail" / "templates" / "TASTE.md").write_text("# Taste\n")

    # House-2 (repo-structure-v2, PR-5 / #1136): CONTEXT.md and docs/agents/*
    # are clean one-time moves under .agentrail/ — see _map_template_destination.
    (repo / "agentrail" / "templates" / "CONTEXT.md").write_text("# Context\nProject context.\n")
    (repo / "agentrail" / "templates" / "docs" / "agents").mkdir(parents=True)
    (repo / "agentrail" / "templates" / "docs" / "agents" / "agent-instructions.md").write_text(
        "# Agent Instructions\nFollow the rules.\n"
    )

    (repo / "agentrail" / "skills" / "my-skill").mkdir(parents=True)
    (repo / "agentrail" / "skills" / "my-skill" / "SKILL.md").write_text("# Skill\n")

    # context-first hook source (#519) — lives under agentrail/templates/scripts
    # (hidden prefix, not installed to the surface) and is placed by
    # _install_claude_hooks.
    (repo / "agentrail" / "templates" / "scripts").mkdir(exist_ok=True)
    (repo / "agentrail" / "templates" / "scripts" / "context-first.sh").write_text("#!/usr/bin/env bash\nexit 0\n")

    scripts = repo / "agentrail" / "scripts"
    scripts.mkdir(parents=True)
    launcher = scripts / "agentrail"
    launcher.write_text("#!/usr/bin/env bash\necho launcher\n")
    launcher.chmod(0o755)

    (repo / "agentrail" / "__init__.py").write_text("")
    (repo / "agentrail" / "cli").mkdir()
    (repo / "agentrail" / "cli" / "__init__.py").write_text("")

    # Dev-only content nested under agentrail/ by repo-structure-v2 — must
    # never leak into a consumer project's vendor copy (#1131 follow-up).
    (repo / "agentrail" / "tests" / "cli").mkdir(parents=True)
    (repo / "agentrail" / "tests" / "cli" / "test_something.py").write_text("# dev test\n")
    (repo / "agentrail" / "docker" / "runner").mkdir(parents=True)
    (repo / "agentrail" / "docker" / "runner" / "Dockerfile").write_text("FROM python:3.11\n")

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
        # hidden agentrail/templates/scripts/* never land on surface
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
        self.assertEqual(skill["source"], "agentrail/skills/my-skill/SKILL.md")


class TestHouse2Layout(TestCase):
    """PR-5 / #1136: fresh installs write the House-2 .agentrail/-rooted layout.

    CONTEXT.md and docs/agents/* are clean one-time moves (no transitional
    duplicate at the old path). skills/ installs to BOTH the legacy top-level
    copy and the new .agentrail/skills copy — dropping the legacy dup is
    explicitly PR-8's job per the execution plan, not this PR's."""

    def setUp(self):
        self.repo = _make_repo()
        self.target = Path(tempfile.mkdtemp())

    def test_context_md_moved_to_agentrail_context(self):
        _run_install(self.repo, self.target)
        moved = self.target / ".agentrail" / "context.md"
        self.assertTrue(moved.exists())
        self.assertEqual(moved.read_text(), "# Context\nProject context.\n")

    def test_root_context_md_not_installed(self):
        _run_install(self.repo, self.target)
        self.assertFalse((self.target / "CONTEXT.md").exists())

    def test_docs_agents_moved_to_agentrail_agents(self):
        _run_install(self.repo, self.target)
        moved = self.target / ".agentrail" / "agents" / "agent-instructions.md"
        self.assertTrue(moved.exists())
        self.assertEqual(moved.read_text(), "# Agent Instructions\nFollow the rules.\n")

    def test_root_docs_agents_not_installed(self):
        _run_install(self.repo, self.target)
        self.assertFalse((self.target / "docs" / "agents" / "agent-instructions.md").exists())

    def test_state_records_house2_destinations(self):
        _run_install(self.repo, self.target)
        state = json.loads((self.target / ".agentrail" / "state.json").read_text())
        paths = {f["path"] for f in state["managedFiles"]}
        self.assertIn(".agentrail/context.md", paths)
        self.assertIn(".agentrail/agents/agent-instructions.md", paths)
        self.assertNotIn("CONTEXT.md", paths)
        self.assertNotIn("docs/agents/agent-instructions.md", paths)

    def test_dual_skills_root_both_installed(self):
        _run_install(self.repo, self.target)
        self.assertTrue((self.target / "skills" / "my-skill" / "SKILL.md").exists())
        self.assertTrue((self.target / ".agentrail" / "skills" / "my-skill" / "SKILL.md").exists())

    def test_dual_skills_root_share_source_in_state(self):
        _run_install(self.repo, self.target)
        state = json.loads((self.target / ".agentrail" / "state.json").read_text())
        legacy_skill = next(f for f in state["managedFiles"] if f["path"] == "skills/my-skill/SKILL.md")
        house2_skill = next(
            f for f in state["managedFiles"] if f["path"] == ".agentrail/skills/my-skill/SKILL.md"
        )
        self.assertEqual(legacy_skill["source"], "agentrail/skills/my-skill/SKILL.md")
        self.assertEqual(house2_skill["source"], "agentrail/skills/my-skill/SKILL.md")

    def test_agentrail_gitignore_written(self):
        _run_install(self.repo, self.target)
        gitignore = self.target / ".agentrail" / ".gitignore"
        self.assertTrue(gitignore.exists())
        self.assertEqual(
            gitignore.read_text(),
            "context/\nruns/\nbatch/\n*.log\nserver.json\n",
        )

    def test_agentrail_gitignore_preserved_without_force(self):
        _run_install(self.repo, self.target)
        gitignore = self.target / ".agentrail" / ".gitignore"
        gitignore.write_text("# local edit\ncustom/\n")
        _run_install(self.repo, self.target)
        self.assertEqual(gitignore.read_text(), "# local edit\ncustom/\n")

    def test_agentrail_gitignore_rewritten_with_force(self):
        _run_install(self.repo, self.target)
        gitignore = self.target / ".agentrail" / ".gitignore"
        gitignore.write_text("# local edit\ncustom/\n")
        _run_install(self.repo, self.target, extra_args=["--force"])
        self.assertEqual(
            gitignore.read_text(),
            "context/\nruns/\nbatch/\n*.log\nserver.json\n",
        )


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
        (self.repo / "agentrail" / "skills" / "other-skill").mkdir(parents=True, exist_ok=True)
        (self.repo / "agentrail" / "skills" / "other-skill" / "SKILL.md").write_text("# Other\n")
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
        _sh.rmtree(str(self.repo / "agentrail" / "skills"))
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
        # agentrail/templates/scripts/* is the hidden prefix — never installed as a managed file.
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
            entries[0]["hooks"][0]["command"],
            "$CLAUDE_PROJECT_DIR/.agentrail/hooks/context-first.sh",
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

    def test_reinstall_over_legacy_relative_command_no_duplicate(self):
        # Installs made before the $CLAUDE_PROJECT_DIR fix wired a relative
        # command; reinstalling must recognize it and not add a second entry.
        settings_path = self.target / ".claude" / "settings.json"
        settings_path.parent.mkdir(parents=True, exist_ok=True)
        settings_path.write_text(json.dumps({"hooks": {"PreToolUse": [{
            "matcher": "Grep|Glob|Bash",
            "hooks": [{"type": "command",
                       "command": ".agentrail/hooks/context-first.sh"}],
        }]}}))
        _run_install(self.repo, self.target)
        settings = json.loads(settings_path.read_text())
        self.assertEqual(len(settings["hooks"]["PreToolUse"]), 1)

    def test_no_hook_source_does_not_error(self):
        (self.repo / "agentrail" / "templates" / "scripts" / "context-first.sh").unlink()
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
        self.assertTrue((source / "agentrail" / "templates").is_dir())
        self.assertTrue((source / "agentrail" / "skills").is_dir())

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

    def test_dev_only_subdirs_excluded_from_vendor(self):
        """repo-structure-v2 nested agentrail/{tests,scripts,docker} directly
        under the vendored ``agentrail/`` package root (epic #1131
        follow-up). ``_materialize_source`` copies that whole package tree,
        so without an explicit exclusion the 282-file pytest suite and the
        Docker build context would ship into every installed project.

        The one exception is ``agentrail/scripts/agentrail`` — the runtime
        launcher, a managed extraFile a self-upgrade must read back from the
        vendor (#1162 x #1163). The dev-only scripts alongside it (benchmark/
        typecheck/test) still must NOT be vendored.
        """
        # A dev-only script alongside the launcher, to prove it is trimmed
        # while the launcher survives.
        (self.repo / "agentrail" / "scripts" / "benchmark-context.py").write_text("# dev only\n")
        _run_install(self.repo, self.target)
        vendored_package = self.target / ".agentrail" / "source" / "agentrail"
        self.assertFalse((vendored_package / "tests").exists(),
                         ".agentrail/source/agentrail/tests must not be vendored")
        self.assertFalse((vendored_package / "docker").exists(),
                         ".agentrail/source/agentrail/docker must not be vendored")
        # scripts/ is trimmed to ONLY the runtime launcher.
        self.assertFalse((vendored_package / "scripts" / "benchmark-context.py").exists(),
                         "dev-only agentrail/scripts/*.py must not be vendored")
        self.assertTrue((vendored_package / "scripts" / "agentrail").exists(),
                        "the runtime launcher must survive the agentrail/scripts trim")

    def test_nested_templates_scripts_survives_dev_subdir_exclusion(self):
        """Regression guard for the fix above: excluding agentrail/scripts
        (dev benchmark/typecheck scripts) must NOT also strip the same-named
        but unrelated agentrail/templates/scripts/ directory, which holds the
        context-first.sh hook template install.py's _install_claude_hooks
        reads from the vendored copy on a self-upgrade run.
        """
        _run_install(self.repo, self.target)
        vendored_package = self.target / ".agentrail" / "source" / "agentrail"
        self.assertTrue(
            (vendored_package / "templates" / "scripts" / "context-first.sh").exists(),
            "nested templates/scripts/context-first.sh must survive the vendor dev-subdir trim",
        )

    def test_self_upgrade_build_inventory_reads_vendored_launcher(self):
        """Regression (#1162 x #1163): a self-upgrade runs _build_inventory
        against the vendored .agentrail/source. #1162's dev-subdir trim
        stripped agentrail/scripts/ wholesale — including the runtime launcher
        the inventory's ``scripts/agentrail`` extraFile sources — so
        _build_inventory raised FileNotFoundError ("failed to build inventory")
        on every installed project's `agentrail upgrade`. The launcher must
        survive the trim so a self-upgrade can rebuild its inventory.
        """
        from agentrail.cli.commands._template_sync import _build_inventory
        _run_install(self.repo, self.target)
        vendored = self.target / ".agentrail" / "source"
        # Must not raise FileNotFoundError building the launcher extraFile hash.
        inventory = _build_inventory(vendored)
        paths = [entry["path"] for entry in inventory]
        self.assertIn("scripts/agentrail", paths)


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
        """Materialize the legacy bash installer inside the real repo's
        agentrail/scripts/ dir (it derives repo_dir from its own location, so
        it must live there). Prefer the working tree; else reconstruct from
        git history. Returns the path, or None if unavailable. Caller is
        responsible for cleanup of a reconstructed copy (it is removed in the
        finally of test_parity)."""
        wt = self.repo / "agentrail" / "scripts" / "install-workflow"
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
                # only resolves when it lives at agentrail/scripts/install-workflow.
                dest = self.repo / "agentrail" / "scripts" / "install-workflow"
                dest.write_text(r.stdout)
                dest.chmod(0o755)
                return dest
        return None

    def test_parity(self):
        import shutil as _sh
        if _sh.which("node") is None:
            self.skipTest("node required by legacy bash installer is not on PATH")

        wt = self.repo / "agentrail" / "scripts" / "install-workflow"
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
