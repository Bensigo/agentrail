"""Tests for the preview recipe detector (agentrail/sandbox/preview_recipe.py, B2b).

``detect_recipe`` figures out how to boot a cloned repo for a preview: an
install command, a start command, a port, and a ready path. It never runs a
command or shells out — it only reads real files (``.agentrail/config.json``,
``package.json``, ``package-lock.json``) already present in the checkout.

Detection order under test:
  1. An explicit flat ``preview`` key in ``.agentrail/config.json`` always
     wins over any ``package.json`` heuristic, and never raises even when the
     file is missing, malformed, or the ``preview`` block is incomplete —
     any of those fall through to step 2 exactly as if no config existed.
  2. ``package.json`` heuristics: ``scripts.dev`` beats ``scripts.start``;
     install is ``npm ci`` iff ``package-lock.json`` exists; port is guessed
     from ``next``/``vite``/``react-scripts`` in (dev)dependencies.
  3. Nothing usable -> ``None``, never raises.
"""
from __future__ import annotations

import json
from pathlib import Path

from agentrail.sandbox.preview_recipe import PreviewRecipe, detect_recipe


def _write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload), encoding="utf-8")


class TestExplicitConfigWins:
    def test_wins_over_a_contradicting_package_json(self, tmp_path: Path) -> None:
        (tmp_path / ".agentrail").mkdir()
        _write_json(
            tmp_path / ".agentrail" / "config.json",
            {
                "preview": {
                    "install": "npm ci",
                    "start": "npm run dev",
                    "port": 4000,
                    "readyPath": "/healthz",
                }
            },
        )
        # A package.json present alongside would, on its own, resolve to a
        # completely different recipe (vite -> 5173, no lockfile -> install).
        # The explicit config must win outright, not blend with it.
        _write_json(
            tmp_path / "package.json",
            {"scripts": {"dev": "vite"}, "dependencies": {"vite": "^5.0.0"}},
        )

        recipe = detect_recipe(str(tmp_path))

        assert recipe == PreviewRecipe(
            install=["npm", "ci"],
            start=["npm", "run", "dev"],
            port=4000,
            ready_path="/healthz",
        )

    def test_omitted_install_is_none_and_ready_path_defaults_to_slash(
        self, tmp_path: Path
    ) -> None:
        (tmp_path / ".agentrail").mkdir()
        _write_json(
            tmp_path / ".agentrail" / "config.json",
            {"preview": {"start": "next dev", "port": 3000}},
        )

        recipe = detect_recipe(str(tmp_path))

        assert recipe == PreviewRecipe(
            install=None, start=["next", "dev"], port=3000, ready_path="/"
        )

    def test_missing_required_start_falls_back_to_package_json(
        self, tmp_path: Path
    ) -> None:
        (tmp_path / ".agentrail").mkdir()
        _write_json(tmp_path / ".agentrail" / "config.json", {"preview": {"port": 5000}})
        _write_json(
            tmp_path / "package.json",
            {"scripts": {"dev": "vite"}, "devDependencies": {"vite": "^5.0.0"}},
        )

        recipe = detect_recipe(str(tmp_path))

        assert recipe == PreviewRecipe(
            install=["npm", "install"], start=["npm", "run", "dev"], port=5173, ready_path="/"
        )

    def test_malformed_config_json_never_raises_and_falls_back_to_package_json(
        self, tmp_path: Path
    ) -> None:
        (tmp_path / ".agentrail").mkdir()
        (tmp_path / ".agentrail" / "config.json").write_text("{not valid json", encoding="utf-8")
        _write_json(tmp_path / "package.json", {"scripts": {"start": "node server.js"}})

        recipe = detect_recipe(str(tmp_path))

        assert recipe == PreviewRecipe(
            install=["npm", "install"], start=["npm", "run", "start"], port=3000, ready_path="/"
        )

    def test_malformed_config_json_with_no_package_json_returns_none(
        self, tmp_path: Path
    ) -> None:
        (tmp_path / ".agentrail").mkdir()
        (tmp_path / ".agentrail" / "config.json").write_text("{not valid json", encoding="utf-8")

        assert detect_recipe(str(tmp_path)) is None


class TestPackageJsonHeuristics:
    def test_dev_script_is_preferred_over_start_script(self, tmp_path: Path) -> None:
        _write_json(
            tmp_path / "package.json",
            {"scripts": {"dev": "next dev", "start": "next start"}},
        )

        recipe = detect_recipe(str(tmp_path))

        assert recipe is not None
        assert recipe.start == ["npm", "run", "dev"]

    def test_start_script_used_when_no_dev_script(self, tmp_path: Path) -> None:
        _write_json(tmp_path / "package.json", {"scripts": {"start": "node index.js"}})

        recipe = detect_recipe(str(tmp_path))

        assert recipe is not None
        assert recipe.start == ["npm", "run", "start"]

    def test_install_uses_npm_ci_when_lockfile_present(self, tmp_path: Path) -> None:
        _write_json(tmp_path / "package.json", {"scripts": {"dev": "vite"}})
        (tmp_path / "package-lock.json").write_text("{}", encoding="utf-8")

        recipe = detect_recipe(str(tmp_path))

        assert recipe is not None
        assert recipe.install == ["npm", "ci"]

    def test_install_uses_npm_install_when_no_lockfile(self, tmp_path: Path) -> None:
        _write_json(tmp_path / "package.json", {"scripts": {"dev": "vite"}})

        recipe = detect_recipe(str(tmp_path))

        assert recipe is not None
        assert recipe.install == ["npm", "install"]

    def test_port_for_next_dependency_is_3000(self, tmp_path: Path) -> None:
        _write_json(
            tmp_path / "package.json",
            {"scripts": {"dev": "next dev"}, "dependencies": {"next": "14.0.0"}},
        )

        recipe = detect_recipe(str(tmp_path))

        assert recipe is not None
        assert recipe.port == 3000

    def test_port_for_vite_dependency_is_5173(self, tmp_path: Path) -> None:
        _write_json(
            tmp_path / "package.json",
            {"scripts": {"dev": "vite"}, "devDependencies": {"vite": "^5.0.0"}},
        )

        recipe = detect_recipe(str(tmp_path))

        assert recipe is not None
        assert recipe.port == 5173

    def test_port_for_react_scripts_dependency_is_3000(self, tmp_path: Path) -> None:
        _write_json(
            tmp_path / "package.json",
            {
                "scripts": {"start": "react-scripts start"},
                "dependencies": {"react-scripts": "5.0.1"},
            },
        )

        recipe = detect_recipe(str(tmp_path))

        assert recipe is not None
        assert recipe.port == 3000

    def test_port_defaults_to_3000_when_framework_is_unrecognized(
        self, tmp_path: Path
    ) -> None:
        _write_json(tmp_path / "package.json", {"scripts": {"dev": "node server.js"}})

        recipe = detect_recipe(str(tmp_path))

        assert recipe is not None
        assert recipe.port == 3000

    def test_ready_path_defaults_to_slash(self, tmp_path: Path) -> None:
        _write_json(tmp_path / "package.json", {"scripts": {"dev": "vite"}})

        recipe = detect_recipe(str(tmp_path))

        assert recipe is not None
        assert recipe.ready_path == "/"


class TestUndetectable:
    def test_no_package_json_and_no_config_returns_none(self, tmp_path: Path) -> None:
        assert detect_recipe(str(tmp_path)) is None

    def test_package_json_without_dev_or_start_script_returns_none(
        self, tmp_path: Path
    ) -> None:
        _write_json(tmp_path / "package.json", {"scripts": {"build": "tsc"}})

        assert detect_recipe(str(tmp_path)) is None

    def test_malformed_package_json_never_raises_and_returns_none(
        self, tmp_path: Path
    ) -> None:
        (tmp_path / "package.json").write_text("{not valid json", encoding="utf-8")

        assert detect_recipe(str(tmp_path)) is None
