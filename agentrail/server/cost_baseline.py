"""Cost Baseline Computer (Milestone 016).

Pure-compute module that derives a per-run cost baseline from the ``cost_events``
timeline over a trailing window and flags whether a freshly observed cost is an
anomaly. Detection surfaces overages only; it does not change billing logic.

No real ClickHouse driver is wired here. The module depends on a minimal
``ClickHouseClient`` typing ``Protocol`` (mirroring ``TelemetryStore`` in
``telemetry.py``) so any object exposing ``query_cost_per_run`` satisfies it;
unit tests supply an in-memory fake.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass
from typing import List, Optional, Protocol

# Below this many observations in the trailing window the baseline is not
# statistically meaningful, so we report insufficient data and never flag.
MIN_OBSERVATIONS = 5


class ClickHouseClient(Protocol):
    """Query contract for the ``cost_events`` table.

    Implementations return the per-run summed ``cost_usd`` for each run that
    matches the given dimensions over the trailing ``window_days`` window.
    Aggregation to one value per ``run_id`` is the client's responsibility so
    this module stays pure.
    """

    def query_cost_per_run(
        self,
        *,
        workspace_id: str,
        model: str,
        phase: str,
        repository_id: str,
        window_days: int,
    ) -> List[float]: ...


@dataclass
class BaselineResult:
    mean: float
    stddev: float
    observation_count: int
    is_anomaly: bool
    deviation_sigmas: Optional[float]
    insufficient_data: bool


def compute_baseline(
    workspace_id: str,
    model: str,
    phase: str,
    repository_id: str,
    observed_cost_usd: float,
    *,
    client: ClickHouseClient,
    baseline_window_days: int = 30,
    sigma_threshold: float = 2.0,
) -> BaselineResult:
    """Compute the trailing-window cost baseline and flag anomalies.

    Queries per-run ``cost_usd`` over the trailing window, computes the mean and
    population standard deviation across runs, and flags ``observed_cost_usd`` as
    an anomaly when it exceeds ``mean + sigma_threshold * stddev``.

    When fewer than ``MIN_OBSERVATIONS`` runs exist in the window the baseline is
    not meaningful: ``insufficient_data`` is ``True`` and ``is_anomaly`` is
    ``False`` regardless of the observed cost.
    """
    observations = client.query_cost_per_run(
        workspace_id=workspace_id,
        model=model,
        phase=phase,
        repository_id=repository_id,
        window_days=baseline_window_days,
    )
    observation_count = len(observations)

    if observation_count < MIN_OBSERVATIONS:
        return BaselineResult(
            mean=statistics.fmean(observations) if observations else 0.0,
            stddev=statistics.pstdev(observations) if observation_count > 1 else 0.0,
            observation_count=observation_count,
            is_anomaly=False,
            deviation_sigmas=None,
            insufficient_data=True,
        )

    mean = statistics.fmean(observations)
    # Population stddev: the window is treated as the full set of observed runs,
    # not a sample drawn from a larger population.
    stddev = statistics.pstdev(observations)

    if stddev == 0.0:
        # Every run cost the same; any value strictly above is an overage, but a
        # sigma deviation is undefined.
        return BaselineResult(
            mean=mean,
            stddev=stddev,
            observation_count=observation_count,
            is_anomaly=observed_cost_usd > mean,
            deviation_sigmas=None,
            insufficient_data=False,
        )

    deviation_sigmas = (observed_cost_usd - mean) / stddev
    is_anomaly = observed_cost_usd > mean + sigma_threshold * stddev

    return BaselineResult(
        mean=mean,
        stddev=stddev,
        observation_count=observation_count,
        is_anomaly=is_anomaly,
        deviation_sigmas=deviation_sigmas,
        insufficient_data=False,
    )
