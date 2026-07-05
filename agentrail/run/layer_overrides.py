"""Layer overrides file — the apply CLI's lever on the run pipeline (issue #1048).

``agentrail evals apply --apply`` writes ``.agentrail/layer-overrides.json``
in the target checkout; the pipeline's layer-flag helpers
(:func:`agentrail.run.pipeline.layer_enabled` and friends) consult it so the
file actually steers live runs. Precedence, most specific first:

1. ``AGENTRAIL_EVAL_LAYER_<NAME>`` env var — the eval harness's ablation seam.
   When SET (to anything), the file is ignored for that layer, so eval arms
   are never contaminated by a checkout's overrides.
2. This file's ``layers.<name>`` boolean — the recorded, evidence-backed
   human decision (#981's flip is one).
3. The built-in default (ON) — the real autonomous loop with neither env nor
   file behaves byte-identically to before this seam existed.

File shape (extra keys are provenance, ignored by the loader)::

    {
      "layers": {"critic": true, "bestofn": false},
      "source": "eval-report-2026-06-29.md"
    }

Defensive contract, mirroring ``layer_enabled``'s "a typo'd flag must never
silently disable a layer": only a JSON boolean counts. A missing file,
unparseable JSON, a non-dict ``layers``, or a non-bool value all yield "no
override" (the default stays ON).
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Dict, Optional

OVERRIDES_FILENAME = "layer-overrides.json"


def overrides_path(target: Optional[Path] = None) -> Path:
    """``<target>/.agentrail/layer-overrides.json`` (target defaults to cwd).

    The cwd default matches how the pipeline is actually invoked — ``agentrail
    run issue <N>`` runs from the target checkout, the same convention
    ``.agentrail/config.json`` reads rely on.
    """
    base = target if target is not None else Path(os.getcwd())
    return base / ".agentrail" / OVERRIDES_FILENAME


def load_layer_overrides(target: Optional[Path] = None) -> Dict[str, bool]:
    """The ``layers`` map from the overrides file, keys uppercased; ``{}`` on any problem.

    Uppercase keys align with the ``AGENTRAIL_EVAL_LAYER_<NAME>`` env
    namespace, so ``"critic"`` in the file and ``layer_enabled("CRITIC")`` in
    the pipeline meet in the middle. Non-bool values are dropped, never
    coerced — a corrupt entry must not flip a layer.
    """
    path = overrides_path(target)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict):
        return {}
    layers = raw.get("layers")
    if not isinstance(layers, dict):
        return {}
    result: Dict[str, bool] = {}
    for name, value in layers.items():
        if isinstance(name, str) and isinstance(value, bool):
            result[name.upper()] = value
    return result


def layer_override(name: str, target: Optional[Path] = None) -> Optional[bool]:
    """The file's boolean for ``name`` (case-insensitive), or ``None`` when unset."""
    return load_layer_overrides(target).get(name.upper())
