"""The liveness timing config is the ONE source of truth, invariant by construction (#1388 AC4)."""
from __future__ import annotations

import json
from pathlib import Path

from agentrail.runner import liveness


def test_constants_match_the_canonical_json():
    cfg = json.loads(
        (Path(liveness.__file__).with_name("liveness_config.json")).read_text()
    )
    assert liveness.LIVENESS_INTERVAL_SECONDS == cfg["liveness_interval_seconds"]
    assert liveness.LIVENESS_STALENESS_SECONDS == cfg["liveness_staleness_seconds"]
    assert liveness.EXECUTION_CEILING_SECONDS == cfg["execution_ceiling_seconds"]
    assert liveness.WALLCLOCK_FALLBACK_SECONDS == cfg["wallclock_fallback_seconds"]


def test_orderings_hold():
    # A healthy pinging run is provably never reclaimed (AC2).
    assert liveness.LIVENESS_INTERVAL_SECONDS < liveness.LIVENESS_STALENESS_SECONDS
    # Many pings happen across one run.
    assert liveness.LIVENESS_INTERVAL_SECONDS < liveness.EXECUTION_CEILING_SECONDS
    # AC4: the wall-clock fallback exceeds the execution ceiling.
    assert liveness.WALLCLOCK_FALLBACK_SECONDS > liveness.EXECUTION_CEILING_SECONDS


def test_native_runner_ceiling_is_sourced_from_the_config():
    from agentrail.sandbox import native_runner

    assert native_runner.DEFAULT_TIMEOUT == liveness.EXECUTION_CEILING_SECONDS
