from __future__ import annotations

import statistics
import unittest
from dataclasses import dataclass, field
from typing import List

from agentrail.server.cost_baseline import BaselineResult, compute_baseline


@dataclass
class FakeClickHouseClient:
    """In-memory fake returning a fixed per-run cost sequence."""

    per_run_costs: List[float] = field(default_factory=list)
    calls: list[dict] = field(default_factory=list)

    def query_cost_per_run(
        self,
        *,
        workspace_id: str,
        model: str,
        phase: str,
        repository_id: str,
        window_days: int,
    ) -> List[float]:
        self.calls.append(
            {
                "workspace_id": workspace_id,
                "model": model,
                "phase": phase,
                "repository_id": repository_id,
                "window_days": window_days,
            }
        )
        return list(self.per_run_costs)


# A sequence with a comfortable spread so mean + 2*stddev is well-defined.
_OBSERVATIONS = [1.0, 1.2, 0.9, 1.1, 1.0, 0.8, 1.3, 1.0]
_MEAN = statistics.fmean(_OBSERVATIONS)
_STDDEV = statistics.pstdev(_OBSERVATIONS)


class CostBaselineComputerTests(unittest.TestCase):
    def _client(self, costs: List[float]) -> FakeClickHouseClient:
        return FakeClickHouseClient(per_run_costs=list(costs))

    def test_ac1_anomaly_fires_above_threshold(self) -> None:
        client = self._client(_OBSERVATIONS)
        observed = _MEAN + 2.0 * _STDDEV + 0.5
        result = compute_baseline(
            workspace_id="ws_1",
            model="gpt-5.5",
            phase="execute",
            repository_id="repo_1",
            observed_cost_usd=observed,
            client=client,
        )
        self.assertIsInstance(result, BaselineResult)
        self.assertTrue(result.is_anomaly)
        self.assertFalse(result.insufficient_data)
        self.assertEqual(result.observation_count, len(_OBSERVATIONS))
        self.assertAlmostEqual(result.mean, _MEAN)
        self.assertAlmostEqual(result.stddev, _STDDEV)
        assert result.deviation_sigmas is not None
        self.assertGreater(result.deviation_sigmas, 2.0)

    def test_ac2_no_anomaly_below_threshold(self) -> None:
        client = self._client(_OBSERVATIONS)
        observed = _MEAN + 0.5 * _STDDEV
        result = compute_baseline(
            workspace_id="ws_1",
            model="gpt-5.5",
            phase="execute",
            repository_id="repo_1",
            observed_cost_usd=observed,
            client=client,
        )
        self.assertFalse(result.is_anomaly)
        self.assertFalse(result.insufficient_data)
        assert result.deviation_sigmas is not None
        self.assertLess(result.deviation_sigmas, 2.0)

    def test_ac3_insufficient_data_suppresses_anomaly(self) -> None:
        client = self._client([1.0, 2.0, 3.0, 4.0])  # only 4 observations
        result = compute_baseline(
            workspace_id="ws_1",
            model="gpt-5.5",
            phase="execute",
            repository_id="repo_1",
            observed_cost_usd=1_000_000.0,  # absurdly high, must still not flag
            client=client,
        )
        self.assertTrue(result.insufficient_data)
        self.assertFalse(result.is_anomaly)
        self.assertEqual(result.observation_count, 4)
        self.assertIsNone(result.deviation_sigmas)

    def test_ac4_sigma_threshold_is_respected(self) -> None:
        client = self._client(_OBSERVATIONS)
        # Choose an observation that is an anomaly at 2 sigma but not at 3 sigma.
        observed = _MEAN + 2.5 * _STDDEV

        flagged = compute_baseline(
            workspace_id="ws_1",
            model="gpt-5.5",
            phase="execute",
            repository_id="repo_1",
            observed_cost_usd=observed,
            client=client,
            sigma_threshold=2.0,
        )
        self.assertTrue(flagged.is_anomaly)

        not_flagged = compute_baseline(
            workspace_id="ws_1",
            model="gpt-5.5",
            phase="execute",
            repository_id="repo_1",
            observed_cost_usd=observed,
            client=self._client(_OBSERVATIONS),
            sigma_threshold=3.0,
        )
        self.assertFalse(not_flagged.is_anomaly)

    def test_window_days_passed_through_to_client(self) -> None:
        client = self._client(_OBSERVATIONS)
        compute_baseline(
            workspace_id="ws_1",
            model="gpt-5.5",
            phase="execute",
            repository_id="repo_1",
            observed_cost_usd=_MEAN,
            client=client,
            baseline_window_days=14,
        )
        self.assertEqual(client.calls[0]["window_days"], 14)

    def test_zero_stddev_only_flags_when_strictly_above_mean(self) -> None:
        client = self._client([2.0, 2.0, 2.0, 2.0, 2.0, 2.0])
        above = compute_baseline(
            workspace_id="ws_1",
            model="gpt-5.5",
            phase="execute",
            repository_id="repo_1",
            observed_cost_usd=2.5,
            client=client,
        )
        self.assertTrue(above.is_anomaly)
        self.assertIsNone(above.deviation_sigmas)

        at_mean = compute_baseline(
            workspace_id="ws_1",
            model="gpt-5.5",
            phase="execute",
            repository_id="repo_1",
            observed_cost_usd=2.0,
            client=self._client([2.0, 2.0, 2.0, 2.0, 2.0, 2.0]),
        )
        self.assertFalse(at_mean.is_anomaly)


if __name__ == "__main__":
    unittest.main()
