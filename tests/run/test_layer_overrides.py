"""Tests for the layer-overrides file and its wiring into ``layer_enabled`` (issue #1048).

The overrides file is the apply CLI's live lever: ``agentrail evals apply
--apply`` writes ``.agentrail/layer-overrides.json`` and the pipeline's
layer-flag helpers must consult it. Precedence, most specific first:

1. ``AGENTRAIL_EVAL_LAYER_<NAME>`` env — the eval harness's ablation seam.
2. This file's ``layers.<name>`` boolean — the recorded human decision.
3. Default ON.

These tests pin all three rungs and the defensive contract (a corrupt or
non-bool entry must never flip a layer).
"""
from __future__ import annotations

import json
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from agentrail.run.layer_overrides import (
    layer_override,
    load_layer_overrides,
    overrides_path,
)
from agentrail.run.pipeline import (
    bestofn_testfirst_enabled,
    diff_only_enforce_enabled,
    layer_enabled,
)


def _write_overrides(target: Path, layers: dict, **extra) -> None:
    d = target / ".agentrail"
    d.mkdir(parents=True, exist_ok=True)
    payload = {"layers": layers}
    payload.update(extra)
    (d / "layer-overrides.json").write_text(
        json.dumps(payload, indent=2) + "\n", encoding="utf-8"
    )


class _EnvIsolation(unittest.TestCase):
    """Base: strip AGENTRAIL_EVAL_LAYER_* so file/default rungs are testable."""

    def setUp(self) -> None:
        self._saved = {
            k: v for k, v in os.environ.items()
            if k.startswith("AGENTRAIL_EVAL_LAYER_")
        }
        for k in self._saved:
            del os.environ[k]

    def tearDown(self) -> None:
        for k in list(os.environ):
            if k.startswith("AGENTRAIL_EVAL_LAYER_"):
                del os.environ[k]
        os.environ.update(self._saved)


class LoadLayerOverridesTests(_EnvIsolation):
    def test_absent_file_is_empty(self) -> None:
        with TemporaryDirectory() as td:
            self.assertEqual(load_layer_overrides(Path(td)), {})
            self.assertIsNone(layer_override("critic", Path(td)))

    def test_keys_uppercased(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _write_overrides(root, {"critic": True, "bestofn": False})
            got = load_layer_overrides(root)
        self.assertEqual(got, {"CRITIC": True, "BESTOFN": False})

    def test_case_insensitive_lookup(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _write_overrides(root, {"critic": False})
            self.assertIs(layer_override("CRITIC", root), False)
            self.assertIs(layer_override("critic", root), False)

    def test_non_bool_values_dropped(self) -> None:
        # A string/int/null must NOT flip a layer — never coerced.
        with TemporaryDirectory() as td:
            root = Path(td)
            _write_overrides(
                root, {"critic": "true", "bestofn": 1, "warmcache": None, "ok": True}
            )
            got = load_layer_overrides(root)
        self.assertEqual(got, {"OK": True})

    def test_corrupt_json_is_empty(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            (root / ".agentrail").mkdir()
            (root / ".agentrail" / "layer-overrides.json").write_text(
                "{not json", encoding="utf-8"
            )
            self.assertEqual(load_layer_overrides(root), {})

    def test_layers_not_a_dict_is_empty(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            (root / ".agentrail").mkdir()
            (root / ".agentrail" / "layer-overrides.json").write_text(
                json.dumps({"layers": ["critic"]}), encoding="utf-8"
            )
            self.assertEqual(load_layer_overrides(root), {})

    def test_overrides_path_shape(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            self.assertEqual(
                overrides_path(root), root / ".agentrail" / "layer-overrides.json"
            )


class LayerEnabledPrecedenceTests(_EnvIsolation):
    """``layer_enabled`` reads the CWD; chdir a temp target to drive the file."""

    def setUp(self) -> None:
        super().setUp()
        self._cwd = os.getcwd()

    def tearDown(self) -> None:
        os.chdir(self._cwd)
        super().tearDown()

    def test_default_on_when_no_file_no_env(self) -> None:
        with TemporaryDirectory() as td:
            os.chdir(td)
            self.assertTrue(layer_enabled("CRITIC"))
            self.assertTrue(bestofn_testfirst_enabled())
            self.assertTrue(diff_only_enforce_enabled())

    def test_file_false_turns_layer_off(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            os.chdir(td)
            _write_overrides(
                root,
                {
                    "critic": False,
                    "bestofn_testfirst": False,
                    "diff_only_enforce": False,
                },
            )
            self.assertFalse(layer_enabled("CRITIC"))
            self.assertFalse(bestofn_testfirst_enabled())
            self.assertFalse(diff_only_enforce_enabled())

    def test_file_true_keeps_layer_on(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            os.chdir(td)
            _write_overrides(root, {"critic": True})
            self.assertTrue(layer_enabled("CRITIC"))

    def test_env_zero_beats_file_true(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            os.chdir(td)
            _write_overrides(root, {"critic": True})
            os.environ["AGENTRAIL_EVAL_LAYER_CRITIC"] = "0"
            self.assertFalse(layer_enabled("CRITIC"))  # env wins

    def test_env_one_beats_file_false(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            os.chdir(td)
            _write_overrides(root, {"critic": False})
            os.environ["AGENTRAIL_EVAL_LAYER_CRITIC"] = "1"
            self.assertTrue(layer_enabled("CRITIC"))  # env wins

    def test_env_typo_value_is_on(self) -> None:
        # Any set-but-not-"0" env value is ON (typo must not disable a layer).
        with TemporaryDirectory() as td:
            os.chdir(td)
            os.environ["AGENTRAIL_EVAL_LAYER_CRITIC"] = "yes"
            self.assertTrue(layer_enabled("CRITIC"))


if __name__ == "__main__":
    unittest.main()
