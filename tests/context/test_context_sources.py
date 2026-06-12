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
from agentrail.context.sources import inventory_sources

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


if __name__ == "__main__":
    unittest.main()
