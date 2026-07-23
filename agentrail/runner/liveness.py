"""Execution-**liveness** timing — the ONE source of truth (#1388).

House naming: *Heartbeat* (CONTEXT.md) is the dispatch-trigger layer — the loop
that decides WHEN to look for grabbable work. This module is the unrelated
execution-**liveness** signal: while a claimed entry is *already running*, the
fleet worker pings the console so a silently-dead runner is reclaimed in minutes
instead of the old blanket wall-clock sweep's up-to-90-minute wait. Keep the two
words apart in code and copy so they never collide.

**Why a single config source (#1388 AC4).** Before this, two unrelated magic
numbers lived in two languages:

  - ``native_runner.DEFAULT_TIMEOUT`` = 3600s — the subprocess execution ceiling
    (Python).
  - ``runner.ts::STALE_RUN_MINUTES`` = 90min — the stale-run reclaim window (TS).

The reclaim window HAD to stay above the execution ceiling (90min > 60min) so a
legitimately long run near its ceiling was never reaped mid-flight — but that
ordering was upheld only *by convention*, one number in each language, free to
drift. ``liveness_config.json`` now declares all of them in one place, and this
loader enforces the orderings **by construction** (a failed assertion at import
is a build-time bug, not a silent production drift):

  - ``liveness_interval < liveness_staleness`` — a healthy run that keeps pinging
    is provably never reclaimed (a few missed pings of slack; #1388 AC2).
  - ``liveness_interval < execution_ceiling`` — many pings happen across one run.
  - ``wallclock_fallback > execution_ceiling`` — the #1388 AC4 invariant: the
    *wall-clock fallback* staleness (used only for runners that never ping — a
    self-hosted or an older runner) must exceed the execution ceiling so a
    non-pinging but legitimately long run is never reaped while still executing.

The console (TypeScript) side reads the SAME ``liveness_config.json`` in a
lockstep vitest test so the reclaim window it uses can never drift from these
values (see ``packages/db-postgres/src/queries/liveness.lockstep.test.ts``).
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Dict

_log = logging.getLogger("agentrail.runner.liveness")

_CONFIG_PATH = Path(__file__).with_name("liveness_config.json")

# Defaults mirror liveness_config.json EXACTLY. They exist only so a packaging
# accident that drops the JSON (or a malformed edit) degrades to the shipped
# values rather than breaking the runner at import — the run loop must never die
# because a config file couldn't be read.
_DEFAULTS: Dict[str, int] = {
    "liveness_interval_seconds": 60,
    "liveness_staleness_seconds": 300,
    "execution_ceiling_seconds": 3600,
    "wallclock_fallback_seconds": 5400,
}


def _load() -> Dict[str, int]:
    try:
        raw = json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:  # missing / unreadable / malformed JSON
        _log.warning(
            "liveness_config.json unreadable (%s); using built-in defaults", exc
        )
        return dict(_DEFAULTS)
    cfg: Dict[str, int] = {}
    for key, fallback in _DEFAULTS.items():
        value = raw.get(key, fallback)
        try:
            cfg[key] = int(value)
        except (TypeError, ValueError):
            _log.warning(
                "liveness_config.json key %r is not an int (%r); using default %d",
                key,
                value,
                fallback,
            )
            cfg[key] = fallback
    return cfg


_CFG = _load()

#: How often the fleet worker pings the console while a claim executes (seconds).
LIVENESS_INTERVAL_SECONDS: int = _CFG["liveness_interval_seconds"]
#: A run with liveness pings is reclaimed after this long WITHOUT one (seconds).
LIVENESS_STALENESS_SECONDS: int = _CFG["liveness_staleness_seconds"]
#: Hard ceiling on a single host run's subprocess (seconds) — native_runner.
EXECUTION_CEILING_SECONDS: int = _CFG["execution_ceiling_seconds"]
#: Wall-clock reclaim window for a run that NEVER pinged (seconds) — the
#: backward-compatible fallback for self-hosted / older runners.
WALLCLOCK_FALLBACK_SECONDS: int = _CFG["wallclock_fallback_seconds"]

# Orderings enforced by construction (#1388 AC4) — see the module docstring.
assert (
    0 < LIVENESS_INTERVAL_SECONDS < LIVENESS_STALENESS_SECONDS
), "liveness interval must be positive and below the liveness-staleness window"
assert (
    LIVENESS_INTERVAL_SECONDS < EXECUTION_CEILING_SECONDS
), "liveness interval must be well below the execution ceiling"
assert (
    WALLCLOCK_FALLBACK_SECONDS > EXECUTION_CEILING_SECONDS
), "wall-clock fallback staleness must exceed the execution ceiling"
