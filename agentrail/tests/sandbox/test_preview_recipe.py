"""Tests for the preview recipe detector (agentrail/sandbox/preview_recipe.py, B2b).

``detect_recipe`` figures out how to boot a cloned repo for a preview: an
install command, a start command, a port, and a ready path. It never runs a
command or shells out — it only reads real files (``.agentrail/config.json``,
``package.json`` and package-manager lockfiles) already present in the
checkout.

Detection order under test:
  1. An explicit flat ``preview`` key in ``.agentrail/config.json``. Two
     distinct failure modes, tested separately (fix round 1, #1):
       - No intent expressed at all (file missing, malformed JSON, or
         ``preview`` isn't a dict) -> falls through to step 2, exactly as if
         no config existed (``TestExplicitConfigAbsentFallsThrough``).
       - Intent expressed but broken — a dict-shaped ``preview`` missing a
         required ``start``/``port``, or an invalid ``port`` -> hard
         ``None``, and NEVER falls through, even when a package.json is
         present and could supply a plausible-looking fallback
         (``TestExplicitConfigFailsClosed``).
     A complete, valid block always wins outright over package.json
     (``TestExplicitConfigWins``).
  2. ``package.json`` heuristics: ``scripts.dev`` beats ``scripts.start``;
     install matches the detected lockfile (``pnpm-lock.yaml`` /
     ``yarn.lock`` / ``package-lock.json``); port is guessed from
     ``next``/``vite``/``react-scripts`` in (dev)dependencies via the
     independently-tested ``_framework_port`` helper
     (``TestFrameworkPortHelper``, fix round 1, #2) so a dropped mapping
     entry can't hide behind ``next``/``react-scripts`` sharing the same
     port number as the unknown-framework default.
  3. Nothing usable -> ``None``, never raises.
"""
from __future__ import annotations

import json
from pathlib import Path

from agentrail.sandbox.preview_recipe import PreviewRecipe, _framework_port, detect_recipe


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

    def test_complete_explicit_block_without_package_json_returns_the_recipe(
        self, tmp_path: Path
    ) -> None:
        (tmp_path / ".agentrail").mkdir()
        _write_json(
            tmp_path / ".agentrail" / "config.json",
            {
                "preview": {
                    "install": "pnpm install",
                    "start": "pnpm dev",
                    "port": 8080,
                    "readyPath": "/ping",
                }
            },
        )

        recipe = detect_recipe(str(tmp_path))

        assert recipe == PreviewRecipe(
            install=["pnpm", "install"],
            start=["pnpm", "dev"],
            port=8080,
            ready_path="/ping",
        )

    def test_non_string_install_is_treated_as_skip_install(self, tmp_path: Path) -> None:
        (tmp_path / ".agentrail").mkdir()
        _write_json(
            tmp_path / ".agentrail" / "config.json",
            {"preview": {"install": ["npm", "ci"], "start": "npm run dev", "port": 3000}},
        )

        recipe = detect_recipe(str(tmp_path))

        # `install` must be a shell command STRING per the brief. A JSON
        # array (or any other non-string) doesn't invalidate the whole block
        # the way a bad `start`/`port` does — since `install` is optional,
        # it is downgraded to "skip install" instead. Pinning this
        # deliberately-lenient behavior (review finding #6).
        assert recipe == PreviewRecipe(
            install=None, start=["npm", "run", "dev"], port=3000, ready_path="/"
        )


class TestExplicitConfigFailsClosed:
    """A ``preview`` key that IS present as a dict, but broken, is expressed-
    but-botched user intent: `detect_recipe` must return `None` outright and
    must NEVER fall through to package.json, even when one is present and
    would otherwise resolve to a plausible-looking recipe (review finding
    #1 — a typo'd explicit config must not silently boot a different
    service than the one the user configured).
    """

    def test_missing_required_start_returns_none_even_with_package_json_present(
        self, tmp_path: Path
    ) -> None:
        (tmp_path / ".agentrail").mkdir()
        _write_json(tmp_path / ".agentrail" / "config.json", {"preview": {"port": 5000}})
        _write_json(
            tmp_path / "package.json",
            {"scripts": {"dev": "vite"}, "devDependencies": {"vite": "^5.0.0"}},
        )

        assert detect_recipe(str(tmp_path)) is None

    def test_missing_required_port_returns_none_even_with_package_json_present(
        self, tmp_path: Path
    ) -> None:
        (tmp_path / ".agentrail").mkdir()
        _write_json(
            tmp_path / ".agentrail" / "config.json", {"preview": {"start": "npm run dev"}}
        )
        _write_json(
            tmp_path / "package.json",
            {"scripts": {"dev": "vite"}, "devDependencies": {"vite": "^5.0.0"}},
        )

        assert detect_recipe(str(tmp_path)) is None

    def test_boolean_port_is_rejected_even_with_package_json_present(
        self, tmp_path: Path
    ) -> None:
        (tmp_path / ".agentrail").mkdir()
        _write_json(
            tmp_path / ".agentrail" / "config.json",
            {"preview": {"start": "npm run dev", "port": True}},
        )
        _write_json(
            tmp_path / "package.json",
            {"scripts": {"dev": "vite"}, "devDependencies": {"vite": "^5.0.0"}},
        )

        # `bool` is an `int` subclass in Python — `port: true` must not be
        # silently accepted as `port: 1` (review finding #5).
        assert detect_recipe(str(tmp_path)) is None


class TestExplicitConfigAbsentFallsThrough:
    """No `preview` key was ever legible in the first place — not merely
    incomplete. All of these are treated identically to "no config.json at
    all" and fall through to package.json heuristics normally, unlike
    `TestExplicitConfigFailsClosed`'s cases.
    """

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

    def test_preview_key_not_a_dict_falls_back_to_package_json(self, tmp_path: Path) -> None:
        (tmp_path / ".agentrail").mkdir()
        _write_json(tmp_path / ".agentrail" / "config.json", {"preview": "npm run dev"})
        _write_json(tmp_path / "package.json", {"scripts": {"start": "node server.js"}})

        recipe = detect_recipe(str(tmp_path))

        # A `preview` value that isn't an object at all (a bare string here)
        # is NOT "expressed-but-broken intent" the way an incomplete dict is
        # — there's no dict to have expressed intent through — so this must
        # fall through, and must never raise either (review finding #7).
        assert recipe == PreviewRecipe(
            install=["npm", "install"], start=["npm", "run", "start"], port=3000, ready_path="/"
        )


class TestFrameworkPortHelper:
    """Direct, white-box coverage of `_framework_port` (review finding #2).

    `next`/`react-scripts` both resolve to the SAME port number as the
    unknown-framework default (3000), so a black-box assertion on a full
    recipe's `port` can't tell "the mapping fired" apart from "nothing
    matched and the default fired instead" — proven empirically in review by
    deleting both mapping entries and finding all 17 prior tests still
    green. Testing the helper directly closes that hole: deleting an entry
    now fails a test here.
    """

    def test_next_maps_to_3000(self) -> None:
        assert _framework_port({"next": "14.0.0"}) == 3000

    def test_vite_maps_to_5173(self) -> None:
        assert _framework_port({"vite": "^5.0.0"}) == 5173

    def test_react_scripts_maps_to_3000(self) -> None:
        assert _framework_port({"react-scripts": "5.0.1"}) == 3000

    def test_unrecognized_framework_returns_none(self) -> None:
        assert _framework_port({"express": "4.18.0"}) is None


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

    def test_install_uses_pnpm_when_pnpm_lockfile_present(self, tmp_path: Path) -> None:
        _write_json(
            tmp_path / "package.json",
            {
                "scripts": {"dev": "vite"},
                "dependencies": {"@acme/ui": "workspace:*"},
            },
        )
        (tmp_path / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n", encoding="utf-8")

        recipe = detect_recipe(str(tmp_path))

        assert recipe is not None
        assert recipe.install == ["corepack", "pnpm", "install", "--frozen-lockfile"]

    def test_install_uses_yarn_when_yarn_lockfile_present(self, tmp_path: Path) -> None:
        _write_json(tmp_path / "package.json", {"scripts": {"dev": "vite"}})
        (tmp_path / "yarn.lock").write_text("# yarn lockfile v1\n", encoding="utf-8")

        recipe = detect_recipe(str(tmp_path))

        assert recipe is not None
        assert recipe.install == ["corepack", "yarn", "install", "--frozen-lockfile"]

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
