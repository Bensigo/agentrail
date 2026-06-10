"""Native Python port of the leaf helpers from the legacy Node.js skill resolver.

Faithful port of scripts/agentrail-legacy lines 769-915.
Orchestration (resolve_skills) is implemented in Task 2; this module
contains ONLY the leaf helpers and matchers.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Dict, List, Optional

IGNORED_DIRS = {".git", "node_modules", ".agentrail", "dist", "build", ".next", "target"}
MAX_FILES = 1000
MAX_AUTO_SKILLS = 4


def load_registry(target_dir: Path, repo_dir: Path) -> tuple[str, dict]:
    """Return (registry_path_str, registry_dict).

    Prefer installed <target>/docs/agents/skill-registry.json,
    else fall back to <repo>/templates/docs/agents/skill-registry.json.
    Mirror legacy lines 778-781.
    """
    installed = target_dir / "docs" / "agents" / "skill-registry.json"
    source = repo_dir / "templates" / "docs" / "agents" / "skill-registry.json"
    registry_path = installed if installed.exists() else source
    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    return (str(registry_path), registry)


def bundled_skills(registry: dict) -> List[dict]:
    """Return registry['skills'] filtered to entries where bundledByDefault is truthy.

    Mirror legacy line 782.
    """
    return [skill for skill in registry["skills"] if skill.get("bundledByDefault")]


def is_skill_available(target_dir: Path, skill: dict) -> bool:
    """Return True if <target_dir>/<skill['localPath']> exists on disk.

    Mirror legacy lines 791-793.
    """
    return (target_dir / skill["localPath"]).exists()


def walk_files(root: Path) -> List[str]:
    """Return relative POSIX paths of files under root.

    Directories are visited in sorted order (localeCompare equivalent: sorted()).
    IGNORED_DIRS entries are skipped entirely.
    Collection stops once MAX_FILES paths are gathered.
    Mirror legacy walkFiles lines 827-850.
    """
    files: List[str] = []

    def _walk(directory: Path) -> None:
        if len(files) >= MAX_FILES:
            return
        try:
            entries = sorted(directory.iterdir(), key=lambda e: e.name)
        except OSError:
            return
        for entry in entries:
            if len(files) >= MAX_FILES:
                return
            if entry.is_dir():
                if entry.name not in IGNORED_DIRS:
                    _walk(entry)
            elif entry.is_file():
                # Build a forward-slash relative path (mirror of path.relative().split(sep).join("/"))
                rel = entry.relative_to(root).as_posix()
                files.append(rel)

    _walk(root)
    return files


def package_signals(root: Path) -> List[str]:
    """Return sorted keys of (dependencies ∪ devDependencies) from <root>/package.json.

    Returns [] on any error (missing file, invalid JSON, missing keys).
    Mirror legacy readPackageSignals lines 852-861.
    """
    package_path = root / "package.json"
    try:
        package_json = json.loads(package_path.read_text(encoding="utf-8"))
        deps: Dict[str, str] = {
            **(package_json.get("dependencies") or {}),
            **(package_json.get("devDependencies") or {}),
        }
        return sorted(deps.keys())
    except Exception:
        return []


def has_segment(file: str, segment: str) -> bool:
    """Return True if file equals segment, starts with 'segment/', or contains '/segment/'.

    Mirror legacy hasSegment lines 863-865.
    """
    return (
        file == segment
        or file.startswith(f"{segment}/")
        or f"/{segment}/" in file
    )


def match_file_signal(skill_name: str, file: str) -> bool:
    """Return True if file is a signal for the given skill.

    Port of legacy matchFileSignal lines 867-884. Per-skill rules:
    - frontend-web: .tsx/.jsx/.css extension OR app/components segment
    - desktop-tauri: src-tauri/ prefix, /src-tauri/ containment, tauri.conf.json
    - backend-api: api/server/routes/controllers/prisma segments
    - devops-deploy: .github/workflows/, Dockerfile, docker-compose.yml, vercel.json, infra segment
    - docs-current: docs segment
    """
    if skill_name == "frontend-web":
        return (
            bool(re.search(r"\.(tsx|jsx|css)$", file))
            or has_segment(file, "app")
            or has_segment(file, "components")
        )

    if skill_name == "desktop-tauri":
        return (
            file.startswith("src-tauri/")
            or "/src-tauri/" in file
            or file == "tauri.conf.json"
            or file.endswith("/tauri.conf.json")
        )

    if skill_name == "backend-api":
        return (
            has_segment(file, "api")
            or has_segment(file, "server")
            or has_segment(file, "routes")
            or has_segment(file, "controllers")
            or has_segment(file, "prisma")
        )

    if skill_name == "devops-deploy":
        return (
            file.startswith(".github/workflows/")
            or file.endswith("/.github/workflows/ci.yml")
            or file == "Dockerfile"
            or file.endswith("/Dockerfile")
            or file == "docker-compose.yml"
            or file.endswith("/docker-compose.yml")
            or file == "vercel.json"
            or file.endswith("/vercel.json")
            or has_segment(file, "infra")
        )

    if skill_name == "docs-current":
        return has_segment(file, "docs")

    return False


def package_reason(skill_name: str, deps: List[str]) -> Optional[str]:
    """Return a human-readable reason string if a skill is signalled by a package dep.

    Port of legacy packageReason lines 886-901.
    - frontend-web: first of [react, next, vite, tailwindcss] present in deps (list order, not deps order)
    - desktop-tauri: first dep (iterating deps in order) that starts with '@tauri-apps/'
    - backend-api: first of [express, fastify, hono, @nestjs/core, prisma, @prisma/client] present in deps
    Returns None when no match or unrecognised skill.

    JS `.find` on the NAMES list means we iterate the fixed names list to find the
    first name that exists in deps — NOT iterating deps to find a name match.
    desktop-tauri is the exception: JS `deps.find(name => name.startsWith(...))` iterates deps.
    """
    if skill_name == "frontend-web":
        names = ["react", "next", "vite", "tailwindcss"]
        dep = next((n for n in names if n in deps), None)
        return f"project dependency: {dep} in package.json" if dep else None

    if skill_name == "desktop-tauri":
        # Iterates deps (not a fixed names list) — first dep starting with @tauri-apps/
        dep = next((d for d in deps if d.startswith("@tauri-apps/")), None)
        return f"project dependency: {dep} in package.json" if dep else None

    if skill_name == "backend-api":
        names = ["express", "fastify", "hono", "@nestjs/core", "prisma", "@prisma/client"]
        dep = next((n for n in names if n in deps), None)
        return f"project dependency: {dep} in package.json" if dep else None

    return None


def keyword_matches(keyword: str, lower_task: str) -> bool:
    """Return True if keyword matches lower_task.

    Port of legacy keywordMatches lines 903-909.
    - Normalize keyword to lowercase.
    - If the normalized form is NOT purely alnum words (^[a-z0-9]+(?: [a-z0-9]+)*$),
      use a substring test (lower_task.includes(normalized)).
    - Otherwise use a \\b word-boundary regex, escaping special chars as JS does
      (re.escape in Python is equivalent to JS replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")).

    Note: the JS escape replaces the same set of chars that re.escape handles,
    so re.escape is a faithful translation.
    """
    normalized = keyword.lower()
    if not re.match(r"^[a-z0-9]+(?: [a-z0-9]+)*$", normalized):
        return normalized in lower_task
    pattern = r"\b" + re.escape(normalized) + r"\b"
    return bool(re.search(pattern, lower_task))


def should_use_keyword(skill_name: str, keyword: str) -> bool:
    """Return True unless skill is docs-current, in which case only an allowed set qualifies.

    Port of legacy shouldUseKeyword lines 911-914.
    Allowed for docs-current (case-insensitive):
    current, latest, docs, documentation, sdk, license, provenance, tauri
    """
    if skill_name != "docs-current":
        return True
    _DOCS_ALLOWED = {"current", "latest", "docs", "documentation", "sdk", "license", "provenance", "tauri"}
    return keyword.lower() in _DOCS_ALLOWED
