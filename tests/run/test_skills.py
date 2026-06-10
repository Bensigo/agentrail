"""Tests for agentrail/run/skills.py — TDD, one test per helper."""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

import pytest

from agentrail.run.skills import (
    MAX_AUTO_SKILLS,
    MAX_FILES,
    bundled_skills,
    has_segment,
    is_skill_available,
    keyword_matches,
    load_registry,
    match_file_signal,
    package_reason,
    package_signals,
    should_use_keyword,
    walk_files,
)


# ---------------------------------------------------------------------------
# has_segment
# ---------------------------------------------------------------------------

class TestHasSegment:
    def test_exact_match(self):
        assert has_segment("api", "api") is True

    def test_startswith_segment_slash(self):
        assert has_segment("api/users.ts", "api") is True

    def test_contains_slash_segment_slash(self):
        assert has_segment("src/api/x", "api") is True

    def test_ends_with_slash_segment_no_trailing_slash_is_false(self):
        # "x/api" — not equal to "api", doesn't start with "api/", doesn't contain "/api/"
        assert has_segment("x/api", "api") is False

    def test_no_match(self):
        assert has_segment("README.md", "api") is False

    def test_nested_deep(self):
        assert has_segment("src/server/routes/x.ts", "routes") is True


# ---------------------------------------------------------------------------
# match_file_signal
# ---------------------------------------------------------------------------

class TestMatchFileSignal:
    # frontend-web
    def test_frontend_tsx(self):
        assert match_file_signal("frontend-web", "app/page.tsx") is True

    def test_frontend_jsx(self):
        assert match_file_signal("frontend-web", "components/Button.jsx") is True

    def test_frontend_css(self):
        assert match_file_signal("frontend-web", "styles/global.css") is True

    def test_frontend_has_segment_app(self):
        assert match_file_signal("frontend-web", "app/layout.ts") is True

    def test_frontend_has_segment_components(self):
        assert match_file_signal("frontend-web", "components/Header.ts") is True

    def test_frontend_readme_false(self):
        assert match_file_signal("frontend-web", "README.md") is False

    # desktop-tauri
    def test_tauri_startswith(self):
        assert match_file_signal("desktop-tauri", "src-tauri/main.rs") is True

    def test_tauri_contains(self):
        assert match_file_signal("desktop-tauri", "apps/desktop/src-tauri/Cargo.toml") is True

    def test_tauri_conf_exact(self):
        assert match_file_signal("desktop-tauri", "tauri.conf.json") is True

    def test_tauri_conf_endswith(self):
        assert match_file_signal("desktop-tauri", "src/tauri.conf.json") is True

    def test_tauri_unrelated_false(self):
        assert match_file_signal("desktop-tauri", "src/main.ts") is False

    # backend-api
    def test_backend_routes(self):
        assert match_file_signal("backend-api", "server/routes/x.ts") is True

    def test_backend_api_segment(self):
        assert match_file_signal("backend-api", "src/api/users.ts") is True

    def test_backend_prisma(self):
        assert match_file_signal("backend-api", "prisma/schema.prisma") is True

    def test_backend_controllers(self):
        assert match_file_signal("backend-api", "src/controllers/auth.ts") is True

    def test_backend_unrelated_false(self):
        assert match_file_signal("backend-api", "README.md") is False

    # devops-deploy
    def test_devops_dockerfile_exact(self):
        assert match_file_signal("devops-deploy", "Dockerfile") is True

    def test_devops_dockerfile_endswith(self):
        assert match_file_signal("devops-deploy", "apps/api/Dockerfile") is True

    def test_devops_docker_compose_exact(self):
        assert match_file_signal("devops-deploy", "docker-compose.yml") is True

    def test_devops_docker_compose_endswith(self):
        assert match_file_signal("devops-deploy", "infra/docker-compose.yml") is True

    def test_devops_github_workflows(self):
        assert match_file_signal("devops-deploy", ".github/workflows/ci.yml") is True

    def test_devops_github_workflows_endswith(self):
        assert match_file_signal("devops-deploy", "apps/.github/workflows/ci.yml") is True

    def test_devops_vercel_exact(self):
        assert match_file_signal("devops-deploy", "vercel.json") is True

    def test_devops_vercel_endswith(self):
        assert match_file_signal("devops-deploy", "apps/vercel.json") is True

    def test_devops_infra_segment(self):
        assert match_file_signal("devops-deploy", "infra/k8s/deployment.yaml") is True

    def test_devops_readme_false(self):
        assert match_file_signal("devops-deploy", "README.md") is False

    # docs-current
    def test_docs_segment(self):
        assert match_file_signal("docs-current", "docs/x.md") is True

    def test_docs_nested(self):
        assert match_file_signal("docs-current", "src/docs/api.md") is True

    def test_docs_readme_false(self):
        assert match_file_signal("docs-current", "README.md") is False

    # unknown skill
    def test_unknown_skill_false(self):
        assert match_file_signal("unknown-skill", "anything.ts") is False


# ---------------------------------------------------------------------------
# package_reason
# ---------------------------------------------------------------------------

class TestPackageReason:
    def test_frontend_react_first_in_list(self):
        # react comes before next in the search list [react, next, vite, tailwindcss]
        result = package_reason("frontend-web", ["next", "react"])
        assert result == "project dependency: react in package.json"

    def test_frontend_next(self):
        result = package_reason("frontend-web", ["next"])
        assert result == "project dependency: next in package.json"

    def test_frontend_vite(self):
        result = package_reason("frontend-web", ["vite"])
        assert result == "project dependency: vite in package.json"

    def test_frontend_tailwindcss(self):
        result = package_reason("frontend-web", ["tailwindcss"])
        assert result == "project dependency: tailwindcss in package.json"

    def test_frontend_no_match(self):
        assert package_reason("frontend-web", ["lodash"]) is None

    def test_tauri_finds_tauri_dep(self):
        result = package_reason("desktop-tauri", ["@tauri-apps/api"])
        assert result is not None
        assert "@tauri-apps/api" in result

    def test_tauri_iterates_deps_for_prefix(self):
        # deps are iterated in order; first dep starting with @tauri-apps/ wins
        result = package_reason("desktop-tauri", ["lodash", "@tauri-apps/cli", "@tauri-apps/api"])
        assert "@tauri-apps/cli" in result

    def test_tauri_no_match(self):
        assert package_reason("desktop-tauri", ["lodash"]) is None

    def test_backend_express(self):
        result = package_reason("backend-api", ["express"])
        assert result == "project dependency: express in package.json"

    def test_backend_first_in_list_order(self):
        # search list is [express, fastify, hono, @nestjs/core, prisma, @prisma/client]
        # even if fastify appears first in deps, express wins if present
        result = package_reason("backend-api", ["fastify", "express"])
        assert result == "project dependency: express in package.json"

    def test_backend_nestjs(self):
        result = package_reason("backend-api", ["@nestjs/core"])
        assert result == "project dependency: @nestjs/core in package.json"

    def test_backend_no_match(self):
        assert package_reason("backend-api", ["lodash"]) is None

    def test_unknown_skill_none(self):
        assert package_reason("unknown-skill", ["react"]) is None


# ---------------------------------------------------------------------------
# keyword_matches
# ---------------------------------------------------------------------------

class TestKeywordMatches:
    def test_simple_word_boundary_match(self):
        assert keyword_matches("test", "add a test") is True

    def test_simple_word_boundary_no_partial(self):
        # "test" should NOT match inside "latest" — word boundary prevents it
        assert keyword_matches("test", "latest") is False

    def test_special_char_keyword_substring(self):
        # "next.js" has a dot → not alnum-words form → substring test
        assert keyword_matches("next.js", "use next.js here") is True

    def test_special_char_not_present(self):
        assert keyword_matches("next.js", "use react here") is False

    def test_multi_word_keyword_boundary(self):
        # "api key" is alnum-words form (two words) → word-boundary regex
        assert keyword_matches("api key", "need an api key now") is True

    def test_multi_word_keyword_no_match(self):
        assert keyword_matches("api key", "need an api") is False

    def test_uppercase_keyword_lowercased(self):
        assert keyword_matches("React", "use react framework") is True

    def test_keyword_at_start(self):
        assert keyword_matches("build", "build the project") is True

    def test_keyword_at_end(self):
        assert keyword_matches("deploy", "we need to deploy") is True


# ---------------------------------------------------------------------------
# should_use_keyword
# ---------------------------------------------------------------------------

class TestShouldUseKeyword:
    def test_non_docs_always_true(self):
        assert should_use_keyword("frontend-web", "anything") is True
        assert should_use_keyword("backend-api", "react") is True
        assert should_use_keyword("tdd", "anything") is True

    def test_docs_current_allowed_keywords(self):
        for kw in ["current", "latest", "docs", "documentation", "sdk", "license", "provenance", "tauri"]:
            assert should_use_keyword("docs-current", kw) is True

    def test_docs_current_disallowed_keyword(self):
        assert should_use_keyword("docs-current", "react") is False
        assert should_use_keyword("docs-current", "typescript") is False

    def test_docs_current_keyword_case_insensitive(self):
        assert should_use_keyword("docs-current", "SDK") is True
        assert should_use_keyword("docs-current", "Docs") is True


# ---------------------------------------------------------------------------
# walk_files
# ---------------------------------------------------------------------------

class TestWalkFiles:
    def test_basic_walk_sorted(self, tmp_path):
        # Create files
        (tmp_path / "b.ts").write_text("b")
        (tmp_path / "a.ts").write_text("a")
        subdir = tmp_path / "src"
        subdir.mkdir()
        (subdir / "c.ts").write_text("c")

        result = walk_files(tmp_path)
        assert result == ["a.ts", "b.ts", "src/c.ts"]

    def test_ignores_node_modules(self, tmp_path):
        (tmp_path / "index.ts").write_text("x")
        nm = tmp_path / "node_modules"
        nm.mkdir()
        (nm / "lodash.js").write_text("x")

        result = walk_files(tmp_path)
        assert "node_modules/lodash.js" not in result
        assert "index.ts" in result

    def test_ignores_all_ignored_dirs(self, tmp_path):
        (tmp_path / "main.ts").write_text("x")
        for d in [".git", ".agentrail", "dist", "build", ".next", "target"]:
            dpath = tmp_path / d
            dpath.mkdir()
            (dpath / "file.txt").write_text("x")

        result = walk_files(tmp_path)
        assert result == ["main.ts"]

    def test_uses_forward_slashes(self, tmp_path):
        sub = tmp_path / "src" / "api"
        sub.mkdir(parents=True)
        (sub / "index.ts").write_text("x")

        result = walk_files(tmp_path)
        assert result == ["src/api/index.ts"]

    def test_caps_at_max_files(self, tmp_path):
        for i in range(1100):
            (tmp_path / f"f{i:04d}.ts").write_text("x")

        result = walk_files(tmp_path)
        assert len(result) == MAX_FILES


# ---------------------------------------------------------------------------
# package_signals
# ---------------------------------------------------------------------------

class TestPackageSignals:
    def test_returns_sorted_union_of_deps(self, tmp_path):
        pkg = {
            "dependencies": {"react": "^18", "next": "^14"},
            "devDependencies": {"typescript": "^5", "eslint": "^8"},
        }
        (tmp_path / "package.json").write_text(json.dumps(pkg))

        result = package_signals(tmp_path)
        assert result == sorted(["react", "next", "typescript", "eslint"])

    def test_missing_file_returns_empty(self, tmp_path):
        result = package_signals(tmp_path)
        assert result == []

    def test_invalid_json_returns_empty(self, tmp_path):
        (tmp_path / "package.json").write_text("not json")
        result = package_signals(tmp_path)
        assert result == []

    def test_no_deps_keys_returns_empty(self, tmp_path):
        (tmp_path / "package.json").write_text(json.dumps({"name": "foo"}))
        result = package_signals(tmp_path)
        assert result == []

    def test_deduplicates_overlapping_deps(self, tmp_path):
        pkg = {
            "dependencies": {"react": "^18"},
            "devDependencies": {"react": "^18"},  # same key
        }
        (tmp_path / "package.json").write_text(json.dumps(pkg))
        result = package_signals(tmp_path)
        assert result == ["react"]


# ---------------------------------------------------------------------------
# load_registry / bundled_skills / is_skill_available
# ---------------------------------------------------------------------------

class TestRegistry:
    def _make_registry(self, tmp_path: Path) -> dict:
        registry = {
            "skills": [
                {
                    "name": "frontend-web",
                    "bundledByDefault": True,
                    "localPath": ".claude/skills/frontend-web.md",
                    "description": "Frontend skill",
                },
                {
                    "name": "backend-api",
                    "bundledByDefault": False,
                    "localPath": ".claude/skills/backend-api.md",
                    "description": "Backend skill",
                },
                {
                    "name": "docs-current",
                    "bundledByDefault": True,
                    "localPath": ".claude/skills/docs-current.md",
                    "description": "Docs skill",
                },
            ]
        }
        return registry

    def test_load_registry_prefers_installed(self, tmp_path):
        target = tmp_path / "target"
        repo = tmp_path / "repo"
        target.mkdir()
        repo.mkdir()

        installed_dir = target / "docs" / "agents"
        installed_dir.mkdir(parents=True)
        registry = self._make_registry(tmp_path)
        (installed_dir / "skill-registry.json").write_text(json.dumps(registry))

        # Also put one in repo (should NOT be chosen)
        repo_dir = repo / "templates" / "docs" / "agents"
        repo_dir.mkdir(parents=True)
        (repo_dir / "skill-registry.json").write_text(json.dumps({"skills": []}))

        path_str, loaded = load_registry(target, repo)
        assert "target" in path_str
        assert len(loaded["skills"]) == 3

    def test_load_registry_falls_back_to_repo(self, tmp_path):
        target = tmp_path / "target"
        repo = tmp_path / "repo"
        target.mkdir()
        repo.mkdir()

        repo_dir = repo / "templates" / "docs" / "agents"
        repo_dir.mkdir(parents=True)
        registry = self._make_registry(tmp_path)
        (repo_dir / "skill-registry.json").write_text(json.dumps(registry))

        path_str, loaded = load_registry(target, repo)
        assert "repo" in path_str
        assert len(loaded["skills"]) == 3

    def test_bundled_skills_filters_bundled_by_default(self, tmp_path):
        registry = self._make_registry(tmp_path)
        result = bundled_skills(registry)
        names = [s["name"] for s in result]
        assert "frontend-web" in names
        assert "docs-current" in names
        assert "backend-api" not in names

    def test_is_skill_available_true_when_file_exists(self, tmp_path):
        target = tmp_path / "target"
        skill_dir = target / ".claude" / "skills"
        skill_dir.mkdir(parents=True)
        (skill_dir / "frontend-web.md").write_text("# skill")

        skill = {"localPath": ".claude/skills/frontend-web.md"}
        assert is_skill_available(target, skill) is True

    def test_is_skill_available_false_when_missing(self, tmp_path):
        target = tmp_path / "target"
        target.mkdir()
        skill = {"localPath": ".claude/skills/frontend-web.md"}
        assert is_skill_available(target, skill) is False


# ---------------------------------------------------------------------------
# constants
# ---------------------------------------------------------------------------

def test_constants():
    assert MAX_FILES == 1000
    assert MAX_AUTO_SKILLS == 4
