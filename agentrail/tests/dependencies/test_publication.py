from __future__ import annotations

import pytest

from agentrail.dependencies.publication import (
    build_dependency_pr_body,
    evaluate_dependency_publication,
)


def _run_data() -> dict:
    return {
        "dependencyPublication": {
            "candidate": {
                "package": "left-pad",
                "dependencyKind": "dependencies",
                "currentVersion": "1.3.0",
                "targetVersion": "1.3.1",
                "manifestPath": "package.json",
                "lockfilePath": "pnpm-lock.yaml",
                "baselineSha": "base-sha",
                "fingerprint": "sha256:candidate",
            },
            "approval": {"approved": True, "approvalId": "approval-1"},
            "evidence": {
                "candidateFingerprint": "sha256:candidate",
                "candidate": {
                    "fingerprint": "sha256:candidate",
                    "package": "left-pad",
                    "currentVersion": "1.3.0",
                    "targetVersion": "1.3.1",
                    "baselineSha": "base-sha",
                },
                "release": {"resolution": "resolved", "version": "1.3.1", "canonical": True, "sources": [{"identifier": "npm-left-pad-1.3.1", "url": "https://registry.npmjs.org/left-pad/1.3.1", "observedAt": "2026-08-03T00:00:00Z"}]},
                "usage": {"directImports": {"status": "not_found", "paths": [], "sourceIds": []}},
                "lock": {"resolution": "resolved", "directChanges": [{"package": "left-pad", "fromVersions": ["1.3.0"], "toVersions": ["1.3.1"], "scope": "direct"}], "transitiveChanges": []},
                "security": {"resolution": "resolved", "advisories": [], "sources": [{"identifier": "osv", "url": "https://osv.dev", "observedAt": "2026-08-03T00:00:00Z"}]},
                "decision": {"status": "ready", "proofComplete": True, "blockingReasons": [], "waivedReasons": []},
            },
            "execution": {
                "status": "green",
                "gate": {"verdict": "green"},
                "candidateFingerprint": "sha256:candidate",
                "baselineSha": "base-sha",
                "changedFiles": ["package.json", "pnpm-lock.yaml"],
                "allowedFiles": ["package.json", "pnpm-lock.yaml"],
                "baselineVerification": [{"command": ["pnpm", "test"], "passed": True}],
                "targetVerification": [{"command": ["pnpm", "test"], "passed": True}],
            },
            "reviewability": {
                "decision": {"status": "reviewable", "proofComplete": True, "reasons": []},
                "diff": {"baseSha": "base-sha", "headSha": "head-sha", "changedFiles": ["package.json", "pnpm-lock.yaml"], "changedLines": 4, "lockfileChangedLines": 3, "nonLockfileChangedLines": 1},
            },
            "objectiveGate": {
                "verdict": "green",
                "isGreen": True,
                "failedReasons": [],
                "evidence": [
                    {"name": "red-green-proof", "passed": True, "detail": "valid fail→pass trail"},
                    {"name": "independent-verification", "passed": True, "detail": "verifier accepted"},
                ],
            },
            "acEvidence": {"acs": [{"id": "AC1", "text": "Upgrade only the package", "status": "proven", "evidence": [{"ref": "tests/test_upgrade.py", "result": "passed"}]}], "unbound": [], "waived": [], "unverifiable": []},
            "visualEvidence": [],
        },
        "independentReview": "active",
    }


def test_publication_requires_all_bound_evidence_and_builds_server_body() -> None:
    decision = evaluate_dependency_publication(_run_data())

    assert decision.allowed is True
    body = build_dependency_pr_body(decision, issue_ref="1579")
    for text in (
        "left-pad",
        "1.3.0 → 1.3.1",
        "sha256:candidate",
        "Release evidence",
        "Transitive / peer result",
        "Security result",
        "Baseline tests",
        "Target tests",
        "Changed-file scope",
        "AC1",
        "Merge: disabled by default",
        "Resolves #1579",
    ):
        assert text in body


def test_stale_evidence_cannot_publish_a_pr() -> None:
    data = _run_data()
    data["dependencyPublication"]["evidence"]["candidateFingerprint"] = "sha256:old"

    decision = evaluate_dependency_publication(data)

    assert decision.allowed is False
    assert any("fingerprint" in reason.lower() for reason in decision.reasons)


def test_out_of_scope_file_cannot_publish_a_pr() -> None:
    data = _run_data()
    data["dependencyPublication"]["execution"]["changedFiles"].append("README.md")

    decision = evaluate_dependency_publication(data)

    assert decision.allowed is False
    assert any("README.md" in reason for reason in decision.reasons)


@pytest.mark.parametrize(
    ("mutate", "expected"),
    [
        (lambda payload: payload["dependencyPublication"]["acEvidence"].__setitem__("unbound", ["AC2"]), "unbound AC evidence"),
        (lambda payload: payload["dependencyPublication"]["acEvidence"].__setitem__("waived", [{"id": "AC3"}]), "waived AC evidence"),
        (lambda payload: payload["dependencyPublication"]["acEvidence"].__setitem__("unverifiable", [{"ac": "AC4"}]), "unverifiable AC evidence"),
        (lambda payload: payload["dependencyPublication"]["acEvidence"]["acs"][0].__setitem__("status", "waived"), "AC AC1 is waived"),
    ],
)
def test_unproven_ac_evidence_blocks_publication(mutate, expected: str) -> None:
    data = _run_data()
    mutate(data)

    decision = evaluate_dependency_publication(data)

    assert decision.allowed is False
    assert any(expected in reason for reason in decision.reasons)
