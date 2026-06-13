from __future__ import annotations

import pytest

from agentrail.server.cost_baseline import compute_baseline


class FakeQueryResult:
    def __init__(self, rows: list[dict[str, float | str]]) -> None:
        self._rows = rows

    def named_results(self) -> list[dict[str, float | str]]:
        return self._rows


class FakeClickHouseClient:
    def __init__(self, costs: list[float]) -> None:
        self.costs = costs
        self.calls: list[dict[str, object]] = []

    def query(self, query: str, parameters: dict[str, object]) -> FakeQueryResult:
        self.calls.append({"query": query, "parameters": parameters})
        return FakeQueryResult(
            [{"run_id": f"run-{idx}", "observed_cost_usd": cost} for idx, cost in enumerate(self.costs, start=1)]
        )


def test_compute_baseline_flags_observed_cost_above_mean_plus_two_sigmas() -> None:
    client = FakeClickHouseClient([1.0, 1.0, 1.0, 1.0, 3.0])

    result = compute_baseline(
        "workspace-001",
        "claude-sonnet-4-6",
        "execute",
        "repo-001",
        3.1,
        client=client,
    )

    assert result.insufficient_data is False
    assert result.observation_count == 5
    assert result.mean == pytest.approx(1.4)
    assert result.stddev == pytest.approx(0.8)
    assert result.is_anomaly is True
    assert result.deviation_sigmas == pytest.approx(2.125)
    assert client.calls[0]["parameters"] == {
        "workspace_id": "workspace-001",
        "model": "claude-sonnet-4-6",
        "phase": "execute",
        "repository_id": "repo-001",
        "baseline_window_days": 30,
    }


def test_compute_baseline_suppresses_cost_below_threshold() -> None:
    client = FakeClickHouseClient([1.0, 1.0, 1.0, 1.0, 3.0])

    result = compute_baseline(
        "workspace-001",
        "claude-sonnet-4-6",
        "execute",
        "repo-001",
        2.9,
        client=client,
    )

    assert result.is_anomaly is False
    assert result.deviation_sigmas == pytest.approx(1.875)


def test_compute_baseline_returns_insufficient_data_for_fewer_than_five_observations() -> None:
    client = FakeClickHouseClient([1.0, 1.0, 1.0, 50.0])

    result = compute_baseline(
        "workspace-001",
        "claude-sonnet-4-6",
        "execute",
        "repo-001",
        100.0,
        client=client,
    )

    assert result.insufficient_data is True
    assert result.is_anomaly is False
    assert result.deviation_sigmas is None
    assert result.observation_count == 4


def test_compute_baseline_respects_configurable_sigma_threshold() -> None:
    client = FakeClickHouseClient([1.0, 1.0, 1.0, 1.0, 3.0])

    result = compute_baseline(
        "workspace-001",
        "claude-sonnet-4-6",
        "execute",
        "repo-001",
        3.1,
        client=client,
        sigma_threshold=3.0,
    )

    assert result.deviation_sigmas == pytest.approx(2.125)
    assert result.is_anomaly is False
