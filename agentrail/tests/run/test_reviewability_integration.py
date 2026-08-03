from __future__ import annotations

import json
from pathlib import Path

import pytest

from agentrail.run import artifacts
from agentrail.run.objective_gate import AcCoverage, CheckResult, evaluate
from agentrail.run.pipeline import apply_reviewability_gate, finalize_objective_gate
from agentrail.run.reviewability import (
    EnvironmentEvidence,
    ReviewabilityBudget,
    ReviewabilityEvidence,
    evaluate_reviewability,
    make_diff_evidence,
)


def _environment(**overrides: object) -> EnvironmentEvidence:
    values = {
        "package_manager": "pnpm",
        "runtime": "node 22",
        "lockfile_hash": "lock-sha",
        "verification_commands": ("pnpm test",),
        "environment_rung": "sandbox",
        "environment_mismatch": False,
        "runtime_evidence_available": True,
    }
    values.update(overrides)
    return EnvironmentEvidence(**values)  # type: ignore[arg-type]


def _evidence(*, diff=None, environment=None, budget=None) -> ReviewabilityEvidence:
    diff = diff or make_diff_evidence(
        base_sha="base-123",
        head_sha="head-456",
        changed_files=("src/index.ts",),
        additions=12,
        deletions=4,
    )
    environment = environment or _environment()
    budget = budget or ReviewabilityBudget()
    return ReviewabilityEvidence(
        diff=diff,
        environment=environment,
        budget=budget,
        decision=evaluate_reviewability(diff, environment, budget),
    )


def _green_gate():
    return evaluate(
        checks=[CheckResult(name="tests", passed=True, detail="passed")],
        ac_coverage=AcCoverage(total=1, covered=1),
    )


@pytest.mark.parametrize(
    "evidence",
    [
        pytest.param(
            _evidence(
                diff=make_diff_evidence(
                    base_sha="base-123",
                    head_sha="head-456",
                    changed_files=("src/index.ts",),
                    truncated=True,
                    omitted_paths=("src/omitted.ts",),
                )
            ),
            id="truncated-diff",
        ),
        pytest.param(
            _evidence(
                diff=make_diff_evidence(
                    base_sha="base-123",
                    head_sha="head-456",
                    expected_head_sha="different-head",
                    changed_files=("src/index.ts",),
                )
            ),
            id="sha-mismatch",
        ),
        pytest.param(
            _evidence(environment=_environment(environment_mismatch=True)),
            id="environment-mismatch",
        ),
        pytest.param(
            _evidence(
                diff=make_diff_evidence(
                    base_sha="base-123",
                    head_sha="head-456",
                    changed_files=("src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"),
                    additions=80,
                    deletions=30,
                ),
                budget=ReviewabilityBudget(
                    max_changed_files=3,
                    max_changed_lines=100,
                    max_risk_score=3,
                ),
            ),
            id="over-budget",
        ),
    ],
)
def test_pipeline_persists_reviewability_failures_as_red(
    tmp_path: Path, evidence: ReviewabilityEvidence
) -> None:
    gate = apply_reviewability_gate(_green_gate(), evidence)

    assert gate.is_green is False
    assert gate.verdict == "red"
    assert any(reason.startswith(f"reviewability {evidence.decision.status}") for reason in gate.failed_reasons)

    metadata_path = tmp_path / "run.json"
    outcome = finalize_objective_gate(metadata_path, gate_result=gate)
    persisted = json.loads(metadata_path.read_text(encoding="utf-8"))

    assert outcome["done"] is False
    assert persisted["objectiveGate"]["verdict"] == "red"
    assert persisted["objectiveGate"]["isGreen"] is False
    assert persisted["objectiveGate"]["evidence"][-1]["name"] == "reviewability"
    assert persisted["objectiveGate"]["evidence"][-1]["passed"] is False


def test_post_commit_head_refresh_updates_artifact_and_gate_surface(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    metadata_path = run_dir / "run.json"
    evidence_path = run_dir / "reviewability_evidence.json"
    evidence = _evidence()
    metadata_path.parent.mkdir(parents=True)
    metadata_path.write_text(
        json.dumps(
            {
                "objectiveGate": {
                    "verdict": "green",
                    "state": "pass",
                    "isGreen": True,
                    "failedReasons": [],
                    "evidence": [
                        {"name": "reviewability", "passed": True, "detail": "old"}
                    ],
                }
            }
        ),
        encoding="utf-8",
    )
    artifacts.write_reviewability_evidence(
        evidence_path,
        metadata_path=metadata_path,
        evidence=evidence.to_dict(),
    )

    refreshed = artifacts.refresh_reviewability_head_sha(
        evidence_path,
        metadata_path=metadata_path,
        head_sha="committed-head-789",
    )
    persisted = json.loads(metadata_path.read_text(encoding="utf-8"))
    persisted_artifact = json.loads(evidence_path.read_text(encoding="utf-8"))

    assert refreshed["diff"]["headSha"] == "committed-head-789"
    assert persisted["reviewability"]["diff"]["headSha"] == "committed-head-789"
    assert persisted_artifact["diff"]["headSha"] == "committed-head-789"
    assert persisted["objectiveGate"]["verdict"] == "green"
    assert persisted["objectiveGate"]["evidence"][0]["passed"] is True
