from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from agentrail.cli.commands.context import _parse_target
from agentrail.context.config import (
    ContextConfig,
    DEFAULT_DENY_GLOBS,
    DEFAULT_EXCLUDE_GLOBS,
    SecretRedactionConfig,
)
from agentrail.context.sources import authority_for, inventory_sources, source_type_for
from agentrail.shared.fs import matches_any

# Config equivalent to what `agentrail install` writes (uses the same defaults).
_DEFAULT_CFG = ContextConfig(
    includeGlobs=["**/*"],
    excludeGlobs=list(DEFAULT_EXCLUDE_GLOBS),
    maxFileSizeBytes=262144,
    skipBinary=True,
    respectGitIgnore=True,
    secretRedaction=SecretRedactionConfig(
        enabled=True, action="exclude", denyGlobs=list(DEFAULT_DENY_GLOBS)
    ),
)


def _init_git(root: Path) -> None:
    subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
    subprocess.run(
        ["git", "-C", str(root), "config", "user.email", "test@example.com"], check=True
    )
    subprocess.run(
        ["git", "-C", str(root), "config", "user.name", "Test"], check=True
    )


def _commit_all(root: Path, message: str = "fixture") -> None:
    subprocess.run(["git", "-C", str(root), "add", "."], check=True)
    subprocess.run(
        ["git", "-C", str(root), "commit", "--quiet", "-m", message], check=True
    )


class ContextSourcesTests(unittest.TestCase):
    """Port of scripts/test-context-sources — tests the Python engine directly."""

    def _make_fixture(self) -> Path:
        """Build a fixture repo that mirrors the bash test fixture."""
        root = Path(tempfile.mkdtemp())
        _init_git(root)

        for d in [
            "src",
            "docs/agents",
            "docs/memory",
            "docs/prd",
            "docs/milestones",
            "skills/backend-api",
            ".agentrail/context/index",
            ".agentrail/runs/run-1",
            "apps/web",
            "node_modules/pkg",
            "dist",
            "ignored",
        ]:
            (root / d).mkdir(parents=True, exist_ok=True)

        # Included source files
        (root / "src/app.js").write_text('console.log("hello");\n', encoding="utf-8")
        (root / "docs/agents/local.md").write_text("# Local Agent Doc\n", encoding="utf-8")
        (root / "docs/memory/lesson.md").write_text("# Lesson\n", encoding="utf-8")
        (root / "docs/prd/feature.md").write_text("# Feature PRD\n", encoding="utf-8")
        (root / "docs/milestones/m1.md").write_text("# Milestone\n", encoding="utf-8")
        (root / "skills/backend-api/SKILL.md").write_text("# Backend API\n", encoding="utf-8")
        (root / ".agentrail/runs/run-1/findings.json").write_text(
            '{"findings":[]}\n', encoding="utf-8"
        )

        # Generated context artifact (must be excluded)
        (root / ".agentrail/context/index/sources.json").write_text("[]\n", encoding="utf-8")

        # Excluded: build outputs
        (root / "node_modules/pkg/index.js").write_text("module.exports = {};\n", encoding="utf-8")
        (root / "dist/bundle.js").write_text('console.log("built");\n', encoding="utf-8")

        # Excluded: gitignored directory
        (root / "ignored/skip.md").write_text("# Ignored\n", encoding="utf-8")
        (root / ".gitignore").write_text("ignored/\n", encoding="utf-8")

        # Excluded: secret-bearing files
        (root / ".env").write_text("TOKEN=secret\n", encoding="utf-8")
        (root / "apps/web/.env.local").write_text("TOKEN=secret\n", encoding="utf-8")
        (root / "private.pem").write_text("PRIVATE KEY\n", encoding="utf-8")
        (root / "nested-secret.txt").write_text("SECRET\n", encoding="utf-8")
        (root / "API_SECRET.txt").write_text("SECRET\n", encoding="utf-8")
        (root / "Private.KEY").write_text("SECRET\n", encoding="utf-8")

        # Excluded: log files (root-level and nested)
        (root / "debug.log").write_text("boot ok\n", encoding="utf-8")
        (root / "apps/web/server.log").write_text("GET / 200\n", encoding="utf-8")

        # Excluded: binary file
        (root / "src/image.bin").write_bytes(b"binary\x00file")

        _commit_all(root, "Initial fixture")
        return root

    # ------------------------------------------------------------------
    # Source type tests
    # ------------------------------------------------------------------

    def test_code_source_type(self) -> None:
        root = self._make_fixture()
        records = inventory_sources(root, _DEFAULT_CFG)
        by_path = {r.path: r.sourceType for r in records}
        self.assertEqual(by_path.get("src/app.js"), "code", "repo code file should have sourceType=code")

    def test_agent_doc_source_type(self) -> None:
        root = self._make_fixture()
        records = inventory_sources(root, _DEFAULT_CFG)
        by_path = {r.path: r.sourceType for r in records}
        self.assertEqual(by_path.get("docs/agents/local.md"), "agent_doc")

    def test_memory_source_type(self) -> None:
        root = self._make_fixture()
        records = inventory_sources(root, _DEFAULT_CFG)
        by_path = {r.path: r.sourceType for r in records}
        self.assertEqual(by_path.get("docs/memory/lesson.md"), "memory")

    def test_prd_source_type(self) -> None:
        root = self._make_fixture()
        records = inventory_sources(root, _DEFAULT_CFG)
        by_path = {r.path: r.sourceType for r in records}
        self.assertEqual(by_path.get("docs/prd/feature.md"), "prd")

    def test_milestone_source_type(self) -> None:
        root = self._make_fixture()
        records = inventory_sources(root, _DEFAULT_CFG)
        by_path = {r.path: r.sourceType for r in records}
        self.assertEqual(by_path.get("docs/milestones/m1.md"), "milestone")

    def test_skill_source_type(self) -> None:
        root = self._make_fixture()
        records = inventory_sources(root, _DEFAULT_CFG)
        by_path = {r.path: r.sourceType for r in records}
        self.assertEqual(by_path.get("skills/backend-api/SKILL.md"), "skill")

    def test_run_artifact_source_type(self) -> None:
        root = self._make_fixture()
        records = inventory_sources(root, _DEFAULT_CFG)
        by_path = {r.path: r.sourceType for r in records}
        self.assertEqual(by_path.get(".agentrail/runs/run-1/findings.json"), "run_artifact")

    def test_agentrail_state_source_type(self) -> None:
        root = Path(tempfile.mkdtemp())
        _init_git(root)
        (root / ".agentrail").mkdir()
        (root / ".agentrail/state.json").write_text('{"workflow":{}}\n', encoding="utf-8")
        _commit_all(root, "state fixture")
        records = inventory_sources(root, _DEFAULT_CFG)
        state_record = next((r for r in records if r.path == ".agentrail/state.json"), None)
        self.assertIsNotNone(state_record, ".agentrail/state.json should be included")
        self.assertEqual(state_record.sourceType, "agentrail_state")  # type: ignore[union-attr]

    # ------------------------------------------------------------------
    # Source record field tests
    # ------------------------------------------------------------------

    def test_content_hash_has_sha256_prefix(self) -> None:
        root = self._make_fixture()
        records = inventory_sources(root, _DEFAULT_CFG)
        self.assertTrue(records)
        for r in records:
            self.assertTrue(
                r.contentHash.startswith("sha256:"),
                f"contentHash should start with 'sha256:' — got {r.contentHash!r} for {r.path}",
            )

    def test_freshness_populated(self) -> None:
        root = self._make_fixture()
        records = inventory_sources(root, _DEFAULT_CFG)
        for r in records:
            self.assertIsNotNone(r.freshness, f"freshness missing for {r.path}")

    def test_authority_populated(self) -> None:
        root = self._make_fixture()
        records = inventory_sources(root, _DEFAULT_CFG)
        for r in records:
            self.assertIsNotNone(r.authority, f"authority missing for {r.path}")

    def test_visibility_is_local(self) -> None:
        root = self._make_fixture()
        records = inventory_sources(root, _DEFAULT_CFG)
        for r in records:
            self.assertEqual(r.visibility, "local", f"visibility should be 'local' for {r.path}")

    def test_linked_issues_is_list(self) -> None:
        root = self._make_fixture()
        records = inventory_sources(root, _DEFAULT_CFG)
        for r in records:
            self.assertIsInstance(r.linkedIssues, list, f"linkedIssues should be a list for {r.path}")

    def test_linked_prs_is_list(self) -> None:
        root = self._make_fixture()
        records = inventory_sources(root, _DEFAULT_CFG)
        for r in records:
            self.assertIsInstance(
                r.linkedPullRequests, list, f"linkedPullRequests should be a list for {r.path}"
            )

    def test_chunk_ids_is_list(self) -> None:
        root = self._make_fixture()
        records = inventory_sources(root, _DEFAULT_CFG)
        for r in records:
            self.assertIsInstance(r.chunkIds, list, f"chunkIds should be a list for {r.path}")

    # ------------------------------------------------------------------
    # Exclusion tests
    # ------------------------------------------------------------------

    def test_node_modules_excluded(self) -> None:
        root = self._make_fixture()
        paths = [r.path for r in inventory_sources(root, _DEFAULT_CFG)]
        self.assertFalse(
            any("node_modules" in p for p in paths), "node_modules should be excluded"
        )

    def test_dist_excluded(self) -> None:
        root = self._make_fixture()
        paths = [r.path for r in inventory_sources(root, _DEFAULT_CFG)]
        self.assertNotIn("dist/bundle.js", paths, "build output should be excluded")

    def test_gitignored_files_excluded(self) -> None:
        root = self._make_fixture()
        paths = [r.path for r in inventory_sources(root, _DEFAULT_CFG)]
        self.assertNotIn("ignored/skip.md", paths, "gitignored files should be excluded")

    def test_binary_files_excluded(self) -> None:
        root = self._make_fixture()
        paths = [r.path for r in inventory_sources(root, _DEFAULT_CFG)]
        self.assertNotIn("src/image.bin", paths, "binary files should be excluded")

    def test_dot_env_excluded(self) -> None:
        root = self._make_fixture()
        paths = [r.path for r in inventory_sources(root, _DEFAULT_CFG)]
        self.assertNotIn(".env", paths, ".env should be excluded")

    def test_nested_env_local_excluded(self) -> None:
        root = self._make_fixture()
        paths = [r.path for r in inventory_sources(root, _DEFAULT_CFG)]
        self.assertNotIn("apps/web/.env.local", paths, "nested .env.local should be excluded")

    def test_pem_excluded(self) -> None:
        root = self._make_fixture()
        paths = [r.path for r in inventory_sources(root, _DEFAULT_CFG)]
        self.assertNotIn("private.pem", paths, "*.pem files should be excluded")

    def test_key_excluded(self) -> None:
        root = self._make_fixture()
        paths = [r.path for r in inventory_sources(root, _DEFAULT_CFG)]
        self.assertNotIn("Private.KEY", paths, "*.KEY files should be excluded")

    def test_secret_named_files_excluded(self) -> None:
        root = self._make_fixture()
        paths = [r.path for r in inventory_sources(root, _DEFAULT_CFG)]
        self.assertNotIn("nested-secret.txt", paths, "*secret* files should be excluded")
        self.assertNotIn("API_SECRET.txt", paths, "case-varied *SECRET* files should be excluded")

    def test_log_files_excluded(self) -> None:
        root = self._make_fixture()
        paths = [r.path for r in inventory_sources(root, _DEFAULT_CFG)]
        self.assertNotIn("debug.log", paths, "root-level *.log files should be excluded")
        self.assertNotIn("apps/web/server.log", paths, "nested *.log files should be excluded")

    def test_context_index_artifacts_excluded(self) -> None:
        root = self._make_fixture()
        paths = [r.path for r in inventory_sources(root, _DEFAULT_CFG)]
        self.assertFalse(
            any(p.startswith(".agentrail/context/index") for p in paths),
            "generated context artifacts should be excluded",
        )

    def test_git_paths_excluded(self) -> None:
        root = self._make_fixture()
        paths = [r.path for r in inventory_sources(root, _DEFAULT_CFG)]
        self.assertFalse(
            any(p.startswith(".git/") for p in paths), ".git paths should be excluded"
        )

    # ------------------------------------------------------------------
    # Determinism test
    # ------------------------------------------------------------------

    def test_output_is_deterministic(self) -> None:
        root = self._make_fixture()
        first = [r.path for r in inventory_sources(root, _DEFAULT_CFG)]
        second = [r.path for r in inventory_sources(root, _DEFAULT_CFG)]
        self.assertEqual(first, second, "inventory_sources output should be deterministic")

    # ------------------------------------------------------------------
    # Optional-dirs test
    # ------------------------------------------------------------------

    def test_optional_dirs_missing_still_returns_required_docs(self) -> None:
        root = Path(tempfile.mkdtemp())
        _init_git(root)
        (root / "CONTEXT.md").write_text("# Context\n", encoding="utf-8")
        # Intentionally omit docs/memory, docs/prd, docs/milestones
        _commit_all(root, "minimal fixture")
        paths = [r.path for r in inventory_sources(root, _DEFAULT_CFG)]
        self.assertIn("CONTEXT.md", paths, "CONTEXT.md should be listed even without optional doc dirs")

    # ------------------------------------------------------------------
    # Custom-glob config test
    # ------------------------------------------------------------------

    def test_custom_include_globs_filter_sources(self) -> None:
        root = Path(tempfile.mkdtemp())
        _init_git(root)
        (root / "src/nested").mkdir(parents=True)
        (root / "docs").mkdir()
        (root / "src/app.js").write_text('console.log("top");\n', encoding="utf-8")
        (root / "src/nested/app.js").write_text('console.log("nested");\n', encoding="utf-8")
        (root / "docs/README.md").write_text("# Docs\n", encoding="utf-8")
        _commit_all(root, "custom glob fixture")

        cfg = ContextConfig(
            includeGlobs=["src/**/*.js", "docs/**/*.md"],
            excludeGlobs=[],
            maxFileSizeBytes=262144,
            skipBinary=True,
            respectGitIgnore=True,
            secretRedaction=SecretRedactionConfig(enabled=False, action="exclude", denyGlobs=[]),
        )
        paths = [r.path for r in inventory_sources(root, cfg)]
        self.assertIn("src/app.js", paths, "src/**/*.js should match top-level files")
        self.assertIn("src/nested/app.js", paths, "src/**/*.js should match nested files")
        self.assertIn("docs/README.md", paths, "docs/**/*.md should match top-level docs")

    # ------------------------------------------------------------------
    # Malformed config test
    # ------------------------------------------------------------------

    def test_malformed_config_raises_runtime_error(self) -> None:
        root = Path(tempfile.mkdtemp())
        subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
        (root / ".agentrail").mkdir()
        (root / ".agentrail/config.json").write_text("{\n", encoding="utf-8")
        with self.assertRaises(RuntimeError) as ctx:
            inventory_sources(root)
        self.assertIn("invalid .agentrail/config.json", str(ctx.exception))

    # ------------------------------------------------------------------
    # CLI --target validation test
    # ------------------------------------------------------------------

    def test_parse_target_missing_value_raises_system_exit(self) -> None:
        with self.assertRaises(SystemExit) as ctx:
            _parse_target(["sources", "--target"])
        self.assertIn("--target requires a directory", str(ctx.exception))


class House2DualPathSourceTypeTests(unittest.TestCase):
    """New House 2 (.agentrail/-rooted) paths must be recognized additively
    alongside the pre-v2 legacy locations (repo-structure v2 D4/D5)."""

    def test_agentrail_context_md_is_context_doc(self) -> None:
        self.assertEqual(source_type_for(".agentrail/context.md"), "context_doc")

    def test_agentrail_taste_md_is_taste_doc(self) -> None:
        self.assertEqual(source_type_for(".agentrail/taste.md"), "taste_doc")

    def test_agentrail_agents_is_agent_doc(self) -> None:
        self.assertEqual(source_type_for(".agentrail/agents/local.md"), "agent_doc")

    def test_agentrail_memory_is_memory(self) -> None:
        self.assertEqual(source_type_for(".agentrail/memory/lesson.md"), "memory")

    def test_agentrail_skills_is_skill(self) -> None:
        self.assertEqual(source_type_for(".agentrail/skills/backend-api/SKILL.md"), "skill")

    def test_legacy_paths_still_recognized(self) -> None:
        # Regression guard: adding .agentrail/ recognition must not disturb
        # the pre-v2 legacy checks.
        self.assertEqual(source_type_for("CONTEXT.md"), "context_doc")
        self.assertEqual(source_type_for("TASTE.md"), "taste_doc")
        self.assertEqual(source_type_for("docs/agents/local.md"), "agent_doc")
        self.assertEqual(source_type_for("docs/memory/lesson.md"), "memory")
        self.assertEqual(source_type_for("skills/backend-api/SKILL.md"), "skill")

    def test_prd_and_milestones_have_no_agentrail_equivalent(self) -> None:
        # D5: docs/prd/ and docs/milestones/ are never migrated into
        # .agentrail/, in either the old or new layout.
        self.assertEqual(source_type_for(".agentrail/prd/feature.md"), "code")
        self.assertEqual(source_type_for(".agentrail/milestones/m1.md"), "code")

    def test_agentrail_context_md_is_critical_authority(self) -> None:
        self.assertEqual(authority_for("context_doc", ".agentrail/context.md"), "critical")

    def test_agentrail_taste_and_agent_doc_are_high_authority(self) -> None:
        self.assertEqual(authority_for("taste_doc", ".agentrail/taste.md"), "high")
        self.assertEqual(authority_for("agent_doc", ".agentrail/agents/local.md"), "high")


class AgentrailTemplatesDocsSourceTypeTests(unittest.TestCase):
    """Regression guard for the repo-structure v2 follow-up fix (epic #1131):
    the AgentRail source repo's own templates docs live under
    agentrail/templates/docs/..., not the pre-v2 un-nested templates/docs/...
    (which no longer exists on disk). source_type_for() must classify the
    nested path, not silently fall through to generic "code"."""

    def test_agentrail_templates_docs_agents_is_agent_doc(self) -> None:
        self.assertEqual(
            source_type_for("agentrail/templates/docs/agents/ralph-loop.md"), "agent_doc"
        )

    def test_agentrail_templates_docs_memory_is_memory(self) -> None:
        self.assertEqual(
            source_type_for("agentrail/templates/docs/memory/lesson.md"), "memory"
        )

    def test_agentrail_templates_docs_prd_is_prd(self) -> None:
        self.assertEqual(
            source_type_for("agentrail/templates/docs/prd/feature.md"), "prd"
        )

    def test_agentrail_templates_docs_milestones_is_milestone(self) -> None:
        self.assertEqual(
            source_type_for("agentrail/templates/docs/milestones/m1.md"), "milestone"
        )

    def test_old_unnested_templates_docs_no_longer_recognized(self) -> None:
        # The pre-v2 top-level templates/docs/... path was removed from disk
        # by the repo-structure v2 arc; it must not falsely classify as
        # agent_doc anymore and should fall through to generic "code".
        self.assertEqual(
            source_type_for("templates/docs/agents/ralph-loop.md"), "code"
        )


class IndexGlobRescopeTests(unittest.TestCase):
    """Repo-structure v2 PR-7 (#1138): default index globs must include the
    House-2 .agentrail/ content dirs, keep the legacy dual-path fallbacks
    indexed, and exclude only generated caches / secrets under .agentrail/.
    """

    def _make_fixture(self) -> Path:
        root = Path(tempfile.mkdtemp())
        _init_git(root)

        for d in [
            ".agentrail/agents",
            ".agentrail/skills/backend-api",
            ".agentrail/memory",
            ".agentrail/runs/run-1",
            ".agentrail/handoffs/handoff-1",
            ".agentrail/context/index",
            ".agentrail/source/agentrail",
            ".agentrail/batch/job-1",
            "docs/agents",
            "docs/memory",
        ]:
            (root / d).mkdir(parents=True, exist_ok=True)

        # New House-2 content dirs — must be included.
        (root / ".agentrail/agents/local.md").write_text("# Local Agent\n", encoding="utf-8")
        (root / ".agentrail/skills/backend-api/SKILL.md").write_text("# Backend API\n", encoding="utf-8")
        (root / ".agentrail/memory/lesson.md").write_text("# Lesson\n", encoding="utf-8")
        (root / ".agentrail/context.md").write_text("# Context\n", encoding="utf-8")
        (root / ".agentrail/taste.md").write_text("# Taste\n", encoding="utf-8")
        (root / ".agentrail/config.json").write_text('{"context":{}}\n', encoding="utf-8")

        # Run/handoff artifacts — must stay included (prior-mistake surfacing
        # in context/index.py reads these).
        (root / ".agentrail/runs/run-1/findings.json").write_text('{"findings":[]}\n', encoding="utf-8")
        (root / ".agentrail/handoffs/handoff-1/notes.md").write_text("# Handoff\n", encoding="utf-8")

        # Legacy dual-path fallbacks — must stay included.
        (root / "docs/agents/local.md").write_text("# Legacy Agent Doc\n", encoding="utf-8")
        (root / "docs/memory/lesson.md").write_text("# Legacy Lesson\n", encoding="utf-8")
        (root / "CONTEXT.md").write_text("# Context\n", encoding="utf-8")
        (root / "TASTE.md").write_text("# Taste\n", encoding="utf-8")

        # Generated cache / vendor / secret paths — must be excluded.
        (root / ".agentrail/context/index/sources.json").write_text("[]\n", encoding="utf-8")
        (root / ".agentrail/source/agentrail/cli.py").write_text("# vendored copy\n", encoding="utf-8")
        (root / ".agentrail/batch/job-1/output.json").write_text("{}\n", encoding="utf-8")
        (root / ".agentrail/server.json").write_text('{"apiKey":"live-secret"}\n', encoding="utf-8")

        _commit_all(root, "PR-7 index-glob fixture")
        return root

    # ------------------------------------------------------------------
    # New House-2 content dirs must be indexed.
    # ------------------------------------------------------------------

    def test_agentrail_agents_included(self) -> None:
        root = self._make_fixture()
        paths = [r.path for r in inventory_sources(root, _DEFAULT_CFG)]
        self.assertIn(".agentrail/agents/local.md", paths)

    def test_agentrail_skills_included(self) -> None:
        root = self._make_fixture()
        paths = [r.path for r in inventory_sources(root, _DEFAULT_CFG)]
        self.assertIn(".agentrail/skills/backend-api/SKILL.md", paths)

    def test_agentrail_memory_included(self) -> None:
        root = self._make_fixture()
        paths = [r.path for r in inventory_sources(root, _DEFAULT_CFG)]
        self.assertIn(".agentrail/memory/lesson.md", paths)

    def test_agentrail_context_md_included(self) -> None:
        root = self._make_fixture()
        paths = [r.path for r in inventory_sources(root, _DEFAULT_CFG)]
        self.assertIn(".agentrail/context.md", paths)

    def test_agentrail_taste_md_included(self) -> None:
        root = self._make_fixture()
        paths = [r.path for r in inventory_sources(root, _DEFAULT_CFG)]
        self.assertIn(".agentrail/taste.md", paths)

    def test_agentrail_config_json_included(self) -> None:
        root = self._make_fixture()
        paths = [r.path for r in inventory_sources(root, _DEFAULT_CFG)]
        self.assertIn(".agentrail/config.json", paths)

    # ------------------------------------------------------------------
    # Run/handoff artifacts must stay indexed (prior-mistake surfacing).
    # ------------------------------------------------------------------

    def test_agentrail_runs_included(self) -> None:
        root = self._make_fixture()
        paths = [r.path for r in inventory_sources(root, _DEFAULT_CFG)]
        self.assertIn(".agentrail/runs/run-1/findings.json", paths)

    def test_agentrail_handoffs_included(self) -> None:
        root = self._make_fixture()
        paths = [r.path for r in inventory_sources(root, _DEFAULT_CFG)]
        self.assertIn(".agentrail/handoffs/handoff-1/notes.md", paths)

    # ------------------------------------------------------------------
    # Legacy dual-path fallbacks must stay indexed.
    # ------------------------------------------------------------------

    def test_legacy_docs_agents_still_included(self) -> None:
        root = self._make_fixture()
        paths = [r.path for r in inventory_sources(root, _DEFAULT_CFG)]
        self.assertIn("docs/agents/local.md", paths)

    def test_legacy_docs_memory_still_included(self) -> None:
        root = self._make_fixture()
        paths = [r.path for r in inventory_sources(root, _DEFAULT_CFG)]
        self.assertIn("docs/memory/lesson.md", paths)

    def test_legacy_root_context_md_still_included(self) -> None:
        root = self._make_fixture()
        paths = [r.path for r in inventory_sources(root, _DEFAULT_CFG)]
        self.assertIn("CONTEXT.md", paths)

    def test_legacy_root_taste_md_still_included(self) -> None:
        root = self._make_fixture()
        paths = [r.path for r in inventory_sources(root, _DEFAULT_CFG)]
        self.assertIn("TASTE.md", paths)

    # ------------------------------------------------------------------
    # Generated caches / vendor copy / secrets must be excluded.
    # ------------------------------------------------------------------

    def test_agentrail_context_cache_excluded(self) -> None:
        root = self._make_fixture()
        paths = [r.path for r in inventory_sources(root, _DEFAULT_CFG)]
        self.assertNotIn(".agentrail/context/index/sources.json", paths)

    def test_agentrail_source_vendor_copy_excluded(self) -> None:
        root = self._make_fixture()
        paths = [r.path for r in inventory_sources(root, _DEFAULT_CFG)]
        self.assertNotIn(".agentrail/source/agentrail/cli.py", paths)

    def test_agentrail_batch_excluded(self) -> None:
        root = self._make_fixture()
        paths = [r.path for r in inventory_sources(root, _DEFAULT_CFG)]
        self.assertNotIn(".agentrail/batch/job-1/output.json", paths)

    def test_agentrail_server_json_excluded(self) -> None:
        root = self._make_fixture()
        paths = [r.path for r in inventory_sources(root, _DEFAULT_CFG)]
        self.assertNotIn(".agentrail/server.json", paths, ".agentrail/server.json holds a live API key and must never be indexed")

    def test_agentrail_server_json_denied_for_redaction_too(self) -> None:
        # Defense in depth: even if a deployment's excludeGlobs is
        # customized away from the default, server.json must still be
        # caught by the secret-redaction deny list.
        self.assertTrue(
            matches_any(DEFAULT_DENY_GLOBS, ".agentrail/server.json"),
            "server.json should also be covered by DEFAULT_DENY_GLOBS as defense in depth",
        )


if __name__ == "__main__":
    unittest.main()
