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
    SkillResolutionError,
    bundled_skills,
    has_segment,
    is_skill_available,
    keyword_matches,
    load_registry,
    match_file_signal,
    package_reason,
    package_signals,
    resolve_skills,
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


# ---------------------------------------------------------------------------
# resolve_skills orchestration
# ---------------------------------------------------------------------------

def _make_skill(name: str, local_path: str, description: str, keywords: list, bundled: bool = True) -> dict:
    return {
        "name": name,
        "bundledByDefault": bundled,
        "localPath": local_path,
        "description": description,
        "triggers": {"keywords": keywords},
    }


def _write_registry(target: Path, skills: list) -> None:
    """Write skill-registry.json into the installed location."""
    reg_dir = target / "docs" / "agents"
    reg_dir.mkdir(parents=True, exist_ok=True)
    (reg_dir / "skill-registry.json").write_text(json.dumps({"skills": skills}))


def _create_skill_files(target: Path, skill_defs: list) -> None:
    """Create the localPath files so the skills are 'available'."""
    for skill in skill_defs:
        p = target / skill["localPath"]
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(f"# {skill['name']}")


class TestResolveSkills:
    """Tests for the resolve_skills orchestration function."""

    def _setup(self, tmp_path: Path, skills: list, make_available: list | None = None):
        """Set up a minimal target dir with registry and optional skill files."""
        target = tmp_path / "target"
        target.mkdir()
        repo = tmp_path / "repo"  # not needed if installed registry exists
        repo.mkdir()

        _write_registry(target, skills)
        if make_available is None:
            make_available = skills
        _create_skill_files(target, make_available)
        return target, repo

    # ------------------------------------------------------------------
    # explicit skills
    # ------------------------------------------------------------------

    def test_explicit_unknown_raises(self, tmp_path):
        skills = [
            _make_skill("tdd", ".claude/skills/tdd.md", "TDD", ["test"]),
        ]
        target, repo = self._setup(tmp_path, skills)
        with pytest.raises(SkillResolutionError, match="Unknown skill: nonexistent"):
            resolve_skills(target, repo, "add a test", explicit_skills=["nonexistent"])

    def test_explicit_unavailable_raises(self, tmp_path):
        skills = [
            _make_skill("tdd", ".claude/skills/tdd.md", "TDD", ["test"]),
        ]
        target, repo = self._setup(tmp_path, skills, make_available=[])
        with pytest.raises(SkillResolutionError, match="Unavailable skill: tdd"):
            resolve_skills(target, repo, "add a test", explicit_skills=["tdd"])

    def test_explicit_available_in_resolved(self, tmp_path):
        skills = [
            _make_skill("tdd", ".claude/skills/tdd.md", "TDD", ["test"]),
        ]
        target, repo = self._setup(tmp_path, skills)
        result = resolve_skills(target, repo, "some task", explicit_skills=["tdd"])
        names = [r["name"] for r in result["resolved"]]
        assert "tdd" in names
        entry = next(r for r in result["resolved"] if r["name"] == "tdd")
        assert "explicit --skill" in entry["reasons"]

    # ------------------------------------------------------------------
    # auto keyword matching
    # ------------------------------------------------------------------

    def test_auto_keyword_match(self, tmp_path):
        skills = [
            _make_skill("tdd", ".claude/skills/tdd.md", "TDD", ["test"]),
        ]
        target, repo = self._setup(tmp_path, skills)
        result = resolve_skills(target, repo, "add a test")
        names = [r["name"] for r in result["resolved"]]
        assert "tdd" in names
        entry = next(r for r in result["resolved"] if r["name"] == "tdd")
        assert "task keyword: test" in entry["reasons"]

    def test_auto_disabled_resolved_empty(self, tmp_path):
        skills = [
            _make_skill("tdd", ".claude/skills/tdd.md", "TDD", ["test"]),
        ]
        target, repo = self._setup(tmp_path, skills)
        result = resolve_skills(target, repo, "add a test", auto_skills=False)
        assert result["resolved"] == []
        assert result["autoSkills"] is False

    # ------------------------------------------------------------------
    # unavailable list
    # ------------------------------------------------------------------

    def test_unavailable_skill_in_unavailable_not_resolved(self, tmp_path):
        available_skill = _make_skill("tdd", ".claude/skills/tdd.md", "TDD", ["test"])
        missing_skill = _make_skill("devops-deploy", ".claude/skills/devops-deploy.md", "DevOps", ["deploy"])
        skills = [available_skill, missing_skill]
        # Only create tdd file, not devops-deploy
        target, repo = self._setup(tmp_path, skills, make_available=[available_skill])

        result = resolve_skills(target, repo, "deploy something")
        unavail_names = [u["name"] for u in result["unavailable"]]
        assert "devops-deploy" in unavail_names
        resolved_names = [r["name"] for r in result["resolved"]]
        assert "devops-deploy" not in resolved_names

    def test_unavailable_entry_has_name_and_local_path(self, tmp_path):
        missing_skill = _make_skill("devops-deploy", ".claude/skills/devops-deploy.md", "DevOps", ["deploy"])
        skills = [missing_skill]
        target, repo = self._setup(tmp_path, skills, make_available=[])

        result = resolve_skills(target, repo, "anything")
        assert len(result["unavailable"]) == 1
        entry = result["unavailable"][0]
        assert entry["name"] == "devops-deploy"
        assert entry["localPath"] == ".claude/skills/devops-deploy.md"

    # ------------------------------------------------------------------
    # output shape
    # ------------------------------------------------------------------

    def test_output_shape(self, tmp_path):
        skills = [
            _make_skill("tdd", ".claude/skills/tdd.md", "TDD", ["test"]),
        ]
        target, repo = self._setup(tmp_path, skills)
        result = resolve_skills(target, repo, "add a test")

        assert "registryPath" in result
        assert "targetDir" in result
        assert "autoSkills" in result
        assert "maxAutoSkills" in result
        assert result["maxAutoSkills"] == 4
        assert "unavailable" in result
        assert "resolved" in result

        for entry in result["resolved"]:
            assert "name" in entry
            assert "localPath" in entry
            assert "description" in entry
            assert "reasons" in entry
            assert isinstance(entry["reasons"], list)

    def test_target_dir_in_output(self, tmp_path):
        skills = [_make_skill("tdd", ".claude/skills/tdd.md", "TDD", [])]
        target, repo = self._setup(tmp_path, skills)
        result = resolve_skills(target, repo, "anything")
        assert result["targetDir"] == str(target)

    # ------------------------------------------------------------------
    # MAX_AUTO_SKILLS cap
    # ------------------------------------------------------------------

    def test_max_auto_skills_cap(self, tmp_path):
        """If more than 4 skills would match by keyword, only the first 4 are resolved."""
        # Create 5 skills all with keyword "deploy"
        skills = [
            _make_skill(f"skill-{i}", f".claude/skills/skill-{i}.md", f"Skill {i}", ["deploy"])
            for i in range(5)
        ]
        target, repo = self._setup(tmp_path, skills)
        result = resolve_skills(target, repo, "deploy everything")
        assert len(result["resolved"]) == MAX_AUTO_SKILLS  # == 4

    def test_max_auto_skills_registry_order(self, tmp_path):
        """The first 4 in registry order are chosen, not the last one."""
        skills = [
            _make_skill(f"skill-{i}", f".claude/skills/skill-{i}.md", f"Skill {i}", ["deploy"])
            for i in range(5)
        ]
        target, repo = self._setup(tmp_path, skills)
        result = resolve_skills(target, repo, "deploy everything")
        resolved_names = [r["name"] for r in result["resolved"]]
        assert "skill-4" not in resolved_names
        for i in range(4):
            assert f"skill-{i}" in resolved_names

    # ------------------------------------------------------------------
    # file signal
    # ------------------------------------------------------------------

    def test_file_signal_backend_api(self, tmp_path):
        """backend-api skill matched via file signal from server/ directory."""
        skills = [
            _make_skill("backend-api", ".claude/skills/backend-api.md", "Backend", []),
        ]
        target, repo = self._setup(tmp_path, skills)

        # Create the file signal: server/x.ts
        server_dir = target / "server"
        server_dir.mkdir()
        (server_dir / "x.ts").write_text("// server")

        result = resolve_skills(target, repo, "add an endpoint")
        names = [r["name"] for r in result["resolved"]]
        assert "backend-api" in names
        entry = next(r for r in result["resolved"] if r["name"] == "backend-api")
        # The first file signal matching should appear as a reason
        file_reasons = [r for r in entry["reasons"] if r.startswith("file signal:")]
        assert len(file_reasons) == 1
        assert "server/x.ts" in file_reasons[0]

    def test_docs_current_file_signal_gated_by_task_words(self, tmp_path):
        """docs-current file signal only fires when task contains certain words."""
        skills = [
            _make_skill("docs-current", ".claude/skills/docs-current.md", "Docs", []),
        ]
        target, repo = self._setup(tmp_path, skills)

        # Create a docs/ dir so match_file_signal fires
        docs_dir = target / "docs" / "guide"
        docs_dir.mkdir(parents=True)
        (docs_dir / "intro.md").write_text("# intro")

        # Task without the gate words — file signal should NOT fire
        result = resolve_skills(target, repo, "add a feature")
        names = [r["name"] for r in result["resolved"]]
        assert "docs-current" not in names

        # Task WITH a gate word — file signal SHOULD fire
        result2 = resolve_skills(target, repo, "update the docs")
        names2 = [r["name"] for r in result2["resolved"]]
        assert "docs-current" in names2

    # ------------------------------------------------------------------
    # reason deduplication
    # ------------------------------------------------------------------

    def test_reason_dedup(self, tmp_path):
        """Including the same skill twice with the same reason keeps it once."""
        skills = [
            _make_skill("tdd", ".claude/skills/tdd.md", "TDD", ["test"]),
        ]
        target, repo = self._setup(tmp_path, skills)
        # Pass explicit AND auto both produce the same skill — but different reasons.
        # To test dedup we call explicit twice via same name (only appears once since dict).
        result = resolve_skills(target, repo, "add a test", explicit_skills=["tdd"])
        entry = next(r for r in result["resolved"] if r["name"] == "tdd")
        # "explicit --skill" should appear exactly once even if logic tried to add twice
        assert entry["reasons"].count("explicit --skill") == 1

    # ------------------------------------------------------------------
    # non-bundled skills are excluded
    # ------------------------------------------------------------------

    def test_non_bundled_skill_excluded(self, tmp_path):
        """Skills with bundledByDefault=False are excluded from auto-resolution."""
        skills = [
            _make_skill("tdd", ".claude/skills/tdd.md", "TDD", ["test"], bundled=True),
            _make_skill("secret-skill", ".claude/skills/secret-skill.md", "Secret", ["test"], bundled=False),
        ]
        target, repo = self._setup(tmp_path, skills)
        result = resolve_skills(target, repo, "add a test")
        resolved_names = [r["name"] for r in result["resolved"]]
        assert "secret-skill" not in resolved_names

    def test_non_bundled_skill_not_in_unavailable(self, tmp_path):
        """Non-bundled skills (even missing) should not appear in unavailable list."""
        skills = [
            _make_skill("secret-skill", ".claude/skills/secret-skill.md", "Secret", ["test"], bundled=False),
        ]
        # Don't create the file
        target, repo = self._setup(tmp_path, skills, make_available=[])
        result = resolve_skills(target, repo, "add a test")
        unavail_names = [u["name"] for u in result["unavailable"]]
        assert "secret-skill" not in unavail_names
