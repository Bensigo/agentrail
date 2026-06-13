from __future__ import annotations

import math
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any, Protocol


class ClickHouseClient(Protocol):
    def query(self, query: str, parameters: Mapping[str, object]) -> object: ...


@dataclass(frozen=True)
class BaselineResult:
    mean: float
    stddev: float
    observation_count: int
    is_anomaly: bool
    deviation_sigmas: float | None
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
    rows = _query_baseline_rows(
        client,
        workspace_id=workspace_id,
        model=model,
        phase=phase,
        repository_id=repository_id,
        baseline_window_days=baseline_window_days,
    )
    costs = [_cost_from_row(row) for row in rows]
    costs = [cost for cost in costs if cost is not None]
    observation_count = len(costs)

    if observation_count < 5:
        return BaselineResult(
            mean=_mean(costs),
            stddev=_population_stddev(costs),
            observation_count=observation_count,
            is_anomaly=False,
            deviation_sigmas=None,
            insufficient_data=True,
        )

    mean = _mean(costs)
    stddev = _population_stddev(costs)
    if stddev == 0:
        deviation_sigmas = None
        is_anomaly = observed_cost_usd > mean
    else:
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


def _query_baseline_rows(
    client: ClickHouseClient,
    *,
    workspace_id: str,
    model: str,
    phase: str,
    repository_id: str,
    baseline_window_days: int,
) -> Iterable[object]:
    query = """
        SELECT
          run_id,
          sum(cost_usd) AS observed_cost_usd
        FROM cost_events
        WHERE workspace_id = {workspace_id:String}
          AND model = {model:String}
          AND phase = {phase:String}
          AND repository_id = {repository_id:String}
          AND occurred_at >= now() - INTERVAL {baseline_window_days:UInt16} DAY
        GROUP BY run_id
    """
    result = client.query(
        query,
        parameters={
            "workspace_id": workspace_id,
            "model": model,
            "phase": phase,
            "repository_id": repository_id,
            "baseline_window_days": baseline_window_days,
        },
    )
    return _rows_from_query_result(result)


def _rows_from_query_result(result: object) -> Iterable[object]:
    named_results = getattr(result, "named_results", None)
    if callable(named_results):
        return named_results()

    result_rows = getattr(result, "result_rows", None)
    if result_rows is not None:
        return result_rows

    if isinstance(result, Iterable) and not isinstance(result, (str, bytes, Mapping)):
        return result

    return []


def _cost_from_row(row: object) -> float | None:
    if isinstance(row, Mapping):
        for key in ("observed_cost_usd", "cost_usd", "sum(cost_usd)"):
            value = row.get(key)
            cost = _float_or_none(value)
            if cost is not None:
                return cost
        return None

    if isinstance(row, tuple) and row:
        return _float_or_none(row[-1])

    return _float_or_none(row)


def _float_or_none(value: object) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        cost = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(cost):
        return None
    return cost


def _mean(values: list[float]) -> float:
    if not values:
        return 0.0
    return sum(values) / len(values)


def _population_stddev(values: list[float]) -> float:
    if not values:
        return 0.0
    mean = _mean(values)
    variance = sum((value - mean) ** 2 for value in values) / len(values)
    return math.sqrt(variance)
