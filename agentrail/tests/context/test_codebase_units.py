"""Tests for mixed-ecosystem codebase-unit detection (agentrail/context/index.py).

Owner feedback on the deployed Repo Wiki: "the wiki has no knowledge in it" --
one concrete cause is that ``detect_manifest_units`` returned EARLY on npm
workspace units, so a root manifest of a DIFFERENT ecosystem (e.g. this very
repo's own root ``pyproject.toml`` + ``agentrail/`` Python package, living
alongside an npm monorepo) never became a unit and got no wiki page at all --
the repo's single biggest codebase unit, silently dropped.

Covers:
  - Mixed-ecosystem UNION: npm workspaces + root pyproject.toml -> N+1 units.
  - Pure-npm and pure-python repos: unchanged (no union branch fires).
  - Dedup: a derived root-ecosystem unit path colliding with an existing
    workspace unit path never doubles up.
  - ``_pyproject_project_name`` / ``_root_ecosystem_unit_path``: the PEP 621 /
    Poetry name extraction and the conservative directory-existence guard.
  - Ownership: ``_unit_id_for_path``'s longest-path-wins never double-owns a
    file that belongs to a more specific npm workspace unit.
  - ``configured_codebase_units`` (highest priority) is untouched by any of
    this -- an explicit override still short-circuits detection entirely.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typing import List

from agentrail.context.config import ContextConfig
from agentrail.context.index import (
    _pyproject_project_name,
    _root_ecosystem_unit_path,
    _unit_id_for_path,
    detect_codebase_units,
    detect_manifest_units,
)
from agentrail.context.models import Freshness, SourceRecord


def _rec(path: str) -> SourceRecord:
    return SourceRecord(
        id=f"source:{path}",
        sourceType="code",
        path=path,
        contentHash="x",
        modifiedAt=None,
        freshness=Freshness("current", None, None),
        authority="normal",
        visibility="local",
        linkedIssues=[],
        linkedPullRequests=[],
        chunkIds=[],
        auditRef=f"audit:{path}",
        content="",
    )


def _write(root: Path, rel_path: str, content: str = "") -> None:
    full = root / rel_path
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(content, encoding="utf-8")


def _mixed_ecosystem_repo() -> Path:
    """npm workspaces (apps/console, apps/api) + a root pyproject.toml whose
    project name matches a real top-level Python package dir (factory/)."""
    root = Path(tempfile.mkdtemp())
    _write(root, "package.json", json.dumps({"name": "monorepo", "workspaces": ["apps/*"]}))
    _write(root, "apps/console/package.json", json.dumps({"name": "console"}))
    _write(root, "apps/api/package.json", json.dumps({"name": "api"}))
    _write(root, "pyproject.toml", '[project]\nname = "factory"\n')
    _write(root, "factory/__init__.py", "")
    _write(root, "factory/main.py", "def run():\n    pass\n")
    return root


def _mixed_ecosystem_records(root: Path) -> List[SourceRecord]:
    return [
        _rec("package.json"),
        _rec("apps/console/package.json"),
        _rec("apps/api/package.json"),
        _rec("pyproject.toml"),
        _rec("factory/__init__.py"),
        _rec("factory/main.py"),
    ]


# ---------------------------------------------------------------------------
# Mixed-ecosystem UNION: N+1 units
# ---------------------------------------------------------------------------


class MixedEcosystemUnionTests(unittest.TestCase):
    def test_root_pyproject_becomes_its_own_unit_alongside_workspaces(self) -> None:
        root = _mixed_ecosystem_repo()
        records = _mixed_ecosystem_records(root)
        units = detect_manifest_units(root, records)
        paths = sorted(u["path"] for u in units)
        self.assertEqual(paths, ["apps/api", "apps/console", "factory"], "N (2 workspaces) + 1 (python) = 3 units")

    def test_python_unit_path_is_the_package_dir_not_root(self) -> None:
        root = _mixed_ecosystem_repo()
        records = _mixed_ecosystem_records(root)
        units = detect_manifest_units(root, records)
        factory_unit = next(u for u in units if u["path"] == "factory")
        self.assertEqual(factory_unit["detection"], "root_manifest")
        self.assertEqual(factory_unit["manifestPath"], "pyproject.toml")
        self.assertEqual(factory_unit["id"], "codebase-unit:factory")
        self.assertEqual(factory_unit["name"], "factory")

    def test_workspace_units_are_untouched_by_the_union(self) -> None:
        root = _mixed_ecosystem_repo()
        records = _mixed_ecosystem_records(root)
        units = detect_manifest_units(root, records)
        console_unit = next(u for u in units if u["path"] == "apps/console")
        self.assertEqual(console_unit["detection"], "workspace_manifest")
        self.assertEqual(console_unit["manifestPath"], "package.json")

    def test_detect_codebase_units_sorts_the_union_deterministically(self) -> None:
        root = _mixed_ecosystem_repo()
        records = _mixed_ecosystem_records(root)
        cfg = ContextConfig()
        units = detect_codebase_units(root, cfg, records)
        paths = [u["path"] for u in units]
        self.assertEqual(paths, sorted(paths), "detect_codebase_units always sorts by (path, id)")
        self.assertEqual(len(units), 3)

    def test_union_is_order_independent_of_record_iteration(self) -> None:
        root = _mixed_ecosystem_repo()
        records = _mixed_ecosystem_records(root)
        forward = detect_manifest_units(root, records)
        backward = detect_manifest_units(root, list(reversed(records)))
        self.assertEqual(sorted(u["path"] for u in forward), sorted(u["path"] for u in backward))

    def test_only_one_other_ecosystem_unit_added_even_with_multiple_root_manifests(self) -> None:
        """Deterministic cap: if a repo somehow ships BOTH a root
        pyproject.toml and a root go.mod alongside npm workspaces, only the
        first (sorted order) is added -- never two extra units for one
        ambiguous "the root" concept."""
        root = _mixed_ecosystem_repo()
        _write(root, "go.mod", "module example.com/factory\n")
        records = _mixed_ecosystem_records(root) + [_rec("go.mod")]
        units = detect_manifest_units(root, records)
        other_ecosystem_units = [u for u in units if u["detection"] == "root_manifest"]
        self.assertEqual(len(other_ecosystem_units), 1)


# ---------------------------------------------------------------------------
# Pure npm / pure python: UNCHANGED
# ---------------------------------------------------------------------------


class UnchangedForSingleEcosystemReposTests(unittest.TestCase):
    def test_pure_npm_repo_unchanged(self) -> None:
        root = Path(tempfile.mkdtemp())
        _write(root, "package.json", json.dumps({"workspaces": ["packages/*"]}))
        _write(root, "packages/a/package.json", "{}")
        _write(root, "packages/b/package.json", "{}")
        records = [_rec("package.json"), _rec("packages/a/package.json"), _rec("packages/b/package.json")]
        units = detect_manifest_units(root, records)
        self.assertEqual(sorted(u["path"] for u in units), ["packages/a", "packages/b"])
        self.assertTrue(all(u["detection"] == "workspace_manifest" for u in units))

    def test_pure_python_repo_unchanged_root_fallback(self) -> None:
        """No package.json at all -> detect_workspace_units returns [], so
        the ORIGINAL (pre-fix) single-unit "." fallback fires exactly as
        before -- the union branch is never reached."""
        root = Path(tempfile.mkdtemp())
        _write(root, "pyproject.toml", '[project]\nname = "solo"\n')
        _write(root, "solo/__init__.py", "")
        records = [_rec("pyproject.toml"), _rec("solo/__init__.py")]
        units = detect_manifest_units(root, records)
        self.assertEqual(len(units), 1)
        self.assertEqual(units[0]["path"], ".")
        self.assertEqual(units[0]["detection"], "root_manifest")

    def test_npm_workspaces_with_no_other_ecosystem_manifest_unchanged(self) -> None:
        """Workspaces exist, but nothing else at root -- the union's
        other_manifest lookup finds nothing, early-returns workspace_units
        exactly like the pre-fix code did."""
        root = Path(tempfile.mkdtemp())
        _write(root, "package.json", json.dumps({"workspaces": ["packages/*"]}))
        _write(root, "packages/a/package.json", "{}")
        records = [_rec("package.json"), _rec("packages/a/package.json")]
        units = detect_manifest_units(root, records)
        self.assertEqual(len(units), 1)
        self.assertEqual(units[0]["path"], "packages/a")

    def test_no_manifests_at_all_returns_empty(self) -> None:
        root = Path(tempfile.mkdtemp())
        records = [_rec("README.md")]
        self.assertEqual(detect_manifest_units(root, records), [])


# ---------------------------------------------------------------------------
# Dedup against an overlapping workspace unit path
# ---------------------------------------------------------------------------


class DedupTests(unittest.TestCase):
    def test_colliding_derived_path_is_deduped_not_doubled(self) -> None:
        root = Path(tempfile.mkdtemp())
        _write(root, "package.json", json.dumps({"workspaces": ["*"]}))
        _write(root, "widget/package.json", "{}")
        _write(root, "pyproject.toml", '[project]\nname = "widget"\n')
        _write(root, "widget/__init__.py", "")
        records = [_rec("package.json"), _rec("widget/package.json"), _rec("pyproject.toml")]
        units = detect_manifest_units(root, records)
        self.assertEqual(len(units), 1, "the workspace unit alone -- deduped, never doubled")
        self.assertEqual(units[0]["path"], "widget")
        self.assertEqual(units[0]["detection"], "workspace_manifest")


# ---------------------------------------------------------------------------
# _pyproject_project_name
# ---------------------------------------------------------------------------


class PyprojectProjectNameTests(unittest.TestCase):
    def test_pep621_project_table(self) -> None:
        text = '[project]\nname = "agentrail"\nversion = "0.1.0"\n'
        self.assertEqual(_pyproject_project_name(text), "agentrail")

    def test_poetry_style_table(self) -> None:
        text = '[tool.poetry]\nname = "my-poetry-app"\nversion = "1.0.0"\n'
        self.assertEqual(_pyproject_project_name(text), "my-poetry-app")

    def test_missing_name_returns_none(self) -> None:
        text = "[project]\nversion = \"0.1.0\"\n"
        self.assertIsNone(_pyproject_project_name(text))

    def test_no_recognizable_table_returns_none(self) -> None:
        text = "[build-system]\nrequires = [\"setuptools\"]\n"
        self.assertIsNone(_pyproject_project_name(text))

    def test_malformed_text_returns_none_never_raises(self) -> None:
        self.assertIsNone(_pyproject_project_name("not even toml { } [["))
        self.assertIsNone(_pyproject_project_name(""))

    def test_name_from_a_later_table_is_not_picked_up(self) -> None:
        """Only the FIRST [project]/[tool.poetry] table's name -- a `name =`
        line belonging to some other table must never leak in."""
        text = '[project]\nname = "real"\n\n[tool.other]\nname = "decoy"\n'
        self.assertEqual(_pyproject_project_name(text), "real")


# ---------------------------------------------------------------------------
# _root_ecosystem_unit_path
# ---------------------------------------------------------------------------


class RootEcosystemUnitPathTests(unittest.TestCase):
    def test_matching_package_dir_preferred_over_root(self) -> None:
        root = Path(tempfile.mkdtemp())
        _write(root, "pyproject.toml", '[project]\nname = "agentrail"\n')
        _write(root, "agentrail/__init__.py", "")
        self.assertEqual(_root_ecosystem_unit_path(root, "pyproject.toml"), "agentrail")

    def test_hyphenated_name_normalizes_to_underscore_dir(self) -> None:
        root = Path(tempfile.mkdtemp())
        _write(root, "pyproject.toml", '[project]\nname = "my-package"\n')
        _write(root, "my_package/__init__.py", "")
        self.assertEqual(_root_ecosystem_unit_path(root, "pyproject.toml"), "my_package")

    def test_falls_back_to_root_when_no_matching_dir(self) -> None:
        root = Path(tempfile.mkdtemp())
        _write(root, "pyproject.toml", '[project]\nname = "nomatch"\n')
        self.assertEqual(_root_ecosystem_unit_path(root, "pyproject.toml"), ".")

    def test_falls_back_to_root_when_dir_exists_but_not_a_python_package(self) -> None:
        """A directory with the right name but no __init__.py is not
        trusted -- could be an unrelated dir (e.g. a docs/ folder that
        happens to share a name) rather than the real package."""
        root = Path(tempfile.mkdtemp())
        _write(root, "pyproject.toml", '[project]\nname = "agentrail"\n')
        (root / "agentrail").mkdir()
        self.assertEqual(_root_ecosystem_unit_path(root, "pyproject.toml"), ".")

    def test_non_python_ecosystems_default_to_root(self) -> None:
        root = Path(tempfile.mkdtemp())
        _write(root, "go.mod", "module example.com/x\n")
        self.assertEqual(_root_ecosystem_unit_path(root, "go.mod"), ".")
        _write(root, "Cargo.toml", "[package]\nname = \"x\"\n")
        self.assertEqual(_root_ecosystem_unit_path(root, "Cargo.toml"), ".")

    def test_unreadable_pyproject_falls_back_to_root_never_raises(self) -> None:
        root = Path(tempfile.mkdtemp())
        # No pyproject.toml written at all -- read_text raises OSError internally.
        self.assertEqual(_root_ecosystem_unit_path(root, "pyproject.toml"), ".")


# ---------------------------------------------------------------------------
# Ownership: longest-path-wins never double-owns a workspace-unit file
# ---------------------------------------------------------------------------


class OwnershipTests(unittest.TestCase):
    def test_workspace_file_is_owned_by_its_workspace_unit_not_the_python_unit(self) -> None:
        root = _mixed_ecosystem_repo()
        records = _mixed_ecosystem_records(root)
        units = detect_manifest_units(root, records)
        owner = _unit_id_for_path(units, "apps/console/package.json")
        self.assertEqual(owner, "codebase-unit:appsconsole")

    def test_python_file_is_owned_by_the_python_unit(self) -> None:
        root = _mixed_ecosystem_repo()
        records = _mixed_ecosystem_records(root)
        units = detect_manifest_units(root, records)
        owner = _unit_id_for_path(units, "factory/main.py")
        self.assertEqual(owner, "codebase-unit:factory")

    def test_top_level_file_outside_every_unit_has_no_owner(self) -> None:
        """A root-level file (README.md) is contained by NEITHER the
        specific workspace units NOR the specific "factory" unit (which,
        unlike the "." fallback, does not swallow the whole repo)."""
        root = _mixed_ecosystem_repo()
        records = _mixed_ecosystem_records(root)
        units = detect_manifest_units(root, records)
        self.assertIsNone(_unit_id_for_path(units, "README.md"))

    def test_dedup_collision_case_still_has_single_unambiguous_owner(self) -> None:
        root = Path(tempfile.mkdtemp())
        _write(root, "package.json", json.dumps({"workspaces": ["*"]}))
        _write(root, "widget/package.json", "{}")
        _write(root, "pyproject.toml", '[project]\nname = "widget"\n')
        _write(root, "widget/__init__.py", "")
        records = [_rec("package.json"), _rec("widget/package.json"), _rec("pyproject.toml"), _rec("widget/app.py")]
        units = detect_manifest_units(root, records)
        self.assertEqual(_unit_id_for_path(units, "widget/app.py"), "codebase-unit:widget")


# ---------------------------------------------------------------------------
# configured_codebase_units still short-circuits everything (priority intact)
# ---------------------------------------------------------------------------


class ConfiguredUnitsPriorityTests(unittest.TestCase):
    def test_explicit_config_override_bypasses_union_detection_entirely(self) -> None:
        root = _mixed_ecosystem_repo()
        records = _mixed_ecosystem_records(root)
        cfg = ContextConfig(codebaseUnits=[{"path": ".", "name": "everything"}])
        units = detect_codebase_units(root, cfg, records)
        self.assertEqual(len(units), 1)
        self.assertEqual(units[0]["path"], ".")
        self.assertEqual(units[0]["detection"], "config_override")


if __name__ == "__main__":
    unittest.main()
