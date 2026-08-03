from __future__ import annotations

import pytest

from agentrail.run.dependency_publication import (
    build_dependency_pr_body,
    dependency_publication_failure,
)


def _payload() -> dict:
    return {
        "dependencyExecution": {
            "status": "green",
            "gate": {"verdict": "green"},
            "candidateFingerprint": "sha256:candidate",
            "approvalId": "approval-1",
            "approved": True,
            "dependencyKind": "dependencies",
            "package": "react",
            "currentVersion": "18.2.0",
            "targetVersion": "18.3.0",
            "baselineSha": "base-sha",
            "lockfilePath": "pnpm-lock.yaml",
            "changedFiles": ["package.json", "pnpm-lock.yaml"],
            "allowedFiles": ["package.json", "pnpm-lock.yaml"],
            "baselineInstall": {"passed": True},
            "targetInstall": {"passed": True},
            "baselineVerification": [{"command": ["pnpm", "test"], "passed": True}],
            "targetVerification": [{"command": ["pnpm", "test"], "passed": True}],
        },
        "dependencyEvidence": {
            "candidateFingerprint": "sha256:candidate",
            "candidate": {
                "fingerprint": "sha256:candidate",
                "package": "react",
                "currentVersion": "18.2.0",
                "targetVersion": "18.3.0",
                "baselineSha": "base-sha",
            },
            "release": {"resolution": "resolved", "sources": [{"identifier": "npm-react-18.3.0"}]},
            "usage": {
                "directImports": {"status": "proven"},
                "configReferences": {"status": "not_found"},
                "peerUsage": {"status": "not_found"},
                "workspaceUsage": {"status": "not_found"},
            },
            "lock": {
                "directChanges": [{"package": "react"}],
                "transitiveChanges": [{"package": "scheduler"}],
                "peerConflicts": [],
            },
            "security": {"resolution": "resolved", "advisories": []},
            "decision": {"status": "ready", "proofComplete": True},
        },
        "reviewability": {
            "decision": {
                "status": "reviewable",
                "proofComplete": True,
                "recommendation": "Evidence is complete.",
            }
            ,"diff": {"baseSha": "base-sha", "headSha": "head-sha"}
        },
        "objectiveGate": {
            "verdict": "green",
            "isGreen": True,
            "evidence": [
                {"name": "red-green-proof", "passed": True, "detail": "valid fail-pass trail"},
                {"name": "independent-verification", "passed": True, "detail": "verifier accepted"},
            ],
        },
        "independentReview": "active",
        "acEvidence": {
            "acs": [{
                "id": "AC1",
                "text": "Only the approved dependency files change",
                "status": "proven",
                "evidence": [{"ref": "tests/test_upgrade.py", "result": "passed"}],
                "verifierResult": "independent verifier accepted",
            }],
            "unbound": [],
            "waived": [],
            "unverifiable": [],
        },
    }


def test_proof_bearing_body_contains_candidate_and_evidence_sections() -> None:
    body = build_dependency_pr_body(_payload(), issue_ref="1579")
    assert "sha256:candidate" in body
    assert "scheduler" in body
    assert "Baseline tests" in body
    assert "Merge: disabled by default" in body
    assert "AC1" in body
    assert "independent verifier accepted" in body
    assert "Resolves #1579" in body


@pytest.mark.parametrize(
    ("change", "expected"),
    [
        ({"dependencyEvidence": {"candidateFingerprint": "stale"}}, "fingerprint"),
        ({"dependencyEvidence": None}, "evidence is missing"),
    ],
)
def test_stale_or_missing_proof_cannot_publish(change: dict, expected: str) -> None:
    payload = _payload()
    payload.update(change)
    reason = dependency_publication_failure(payload)
    assert reason is not None
    assert expected in reason
    with pytest.raises(ValueError):
        build_dependency_pr_body(payload)


def test_out_of_scope_file_cannot_publish() -> None:
    payload = _payload()
    payload["dependencyExecution"]["changedFiles"].append("README.md")
    reason = dependency_publication_failure(payload)
    assert reason is not None
    assert "README.md" in reason


def test_missing_required_gate_evidence_cannot_publish() -> None:
    payload = _payload()
    payload["objectiveGate"]["evidence"] = []
    payload["independentReview"] = "skipped:no_distinct_model"

    reason = dependency_publication_failure(payload)

    assert reason is not None
    assert "Red-Green Proof" in reason
    assert "Independent Verification" in reason


@pytest.mark.parametrize(
    ("mutate", "expected"),
    [
        (lambda payload: payload["acEvidence"].__setitem__("unbound", ["AC2"]), "unbound AC evidence"),
        (lambda payload: payload["acEvidence"].__setitem__("waived", [{"id": "AC3"}]), "waived AC evidence"),
        (lambda payload: payload["acEvidence"].__setitem__("unverifiable", [{"ac": "AC4"}]), "unverifiable AC evidence"),
        (lambda payload: payload["acEvidence"]["acs"][0].__setitem__("status", "waived"), "AC AC1 is waived"),
    ],
)
def test_unproven_ac_evidence_blocks_publication(mutate, expected: str) -> None:
    payload = _payload()
    mutate(payload)

    reason = dependency_publication_failure(payload)

    assert reason is not None
    assert expected in reason
    with pytest.raises(ValueError):
        build_dependency_pr_body(payload)
