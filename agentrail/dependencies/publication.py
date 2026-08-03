"""Fail-closed publication contract for proof-bearing dependency PRs.

The factory is the last writer before GitHub.  This module deliberately has no
GitHub or model dependency: it consumes the run artifacts produced by the
candidate, evidence, execution, Objective Gate, and reviewability stages and
returns either a deterministic PR body or blocking reasons.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Sequence


def _get(value: Mapping[str, Any] | None, *names: str, default: Any = None) -> Any:
    if not isinstance(value, Mapping):
        return default
    for name in names:
        if name in value:
            return value[name]
    return default


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _text(value: Any, default: str = "") -> str:
    return str(value).strip() if value is not None else default


def _items(value: Any) -> list[Any]:
    return list(value) if isinstance(value, (list, tuple)) else []


def _section(data: Mapping[str, Any], *names: str) -> Mapping[str, Any]:
    return _mapping(_get(data, *names))


@dataclass(frozen=True)
class DependencyPublicationDecision:
    allowed: bool
    reasons: tuple[str, ...]
    payload: Mapping[str, Any]


def _publication_payload(run_data: Mapping[str, Any]) -> Mapping[str, Any] | None:
    nested = _get(run_data, "dependencyPublication", "dependency_publication")
    if isinstance(nested, Mapping):
        return nested
    # These aliases are the artifact names used by the earlier dependency
    # slices.  Their presence marks the run as a dependency publication, even
    # when the newer envelope has not yet been materialised.
    markers = (
        "dependencyUpgrade",
        "dependency_upgrade",
        "dependencyContract",
        "approvedDependencyUpgrade",
        "dependencyEvidence",
        "dependencyExecution",
        "dependencyExecutionResult",
    )
    if any(name in run_data for name in markers):
        return run_data
    return None


def is_dependency_publication(run_data: Mapping[str, Any]) -> bool:
    return _publication_payload(run_data) is not None


def _candidate(payload: Mapping[str, Any]) -> Mapping[str, Any]:
    candidate = _mapping(_get(payload, "candidate", "dependencyCandidate"))
    if candidate:
        return candidate
    contract = _mapping(_get(payload, "contract", "dependencyContract", "approvedDependencyUpgrade"))
    candidate = _mapping(_get(contract, "candidate", "dependencyCandidate")) or contract
    if candidate:
        return candidate
    execution = _mapping(_get(payload, "execution", "dependencyExecution", "dependencyExecutionResult"))
    if execution:
        return {
            "package": _get(execution, "package"),
            "ecosystem": _get(execution, "ecosystem"),
            "packageManager": _get(execution, "packageManager", "package_manager"),
            "packageManagerVersion": _get(execution, "packageManagerVersion", "package_manager_version"),
            "dependencyKind": _get(execution, "dependencyKind", "dependency_kind"),
            "currentVersion": _get(execution, "currentVersion", "current_version"),
            "targetVersion": _get(execution, "targetVersion", "target_version"),
            "manifestPath": _get(execution, "manifestPath", "manifest_path"),
            "lockfilePath": _get(execution, "lockfilePath", "lockfile_path"),
            "baselineSha": _get(execution, "baselineSha", "baseline_sha"),
            "fingerprint": _get(execution, "candidateFingerprint", "candidate_fingerprint"),
        }
    evidence = _mapping(_get(payload, "evidence", "dependencyEvidence"))
    return _mapping(_get(evidence, "candidate", "dependencyCandidate"))


def _approval(payload: Mapping[str, Any]) -> Mapping[str, Any]:
    approval = _mapping(_get(payload, "approval", "humanApproval"))
    if approval:
        return approval
    contract = _mapping(_get(payload, "contract", "dependencyContract", "approvedDependencyUpgrade"))
    if contract:
        return contract
    execution = _mapping(_get(payload, "execution", "dependencyExecution", "dependencyExecutionResult"))
    return {
        "approved": _get(execution, "approved"),
        "approvalId": _get(execution, "approvalId", "approval_id"),
    }


def _evidence(payload: Mapping[str, Any], run_data: Mapping[str, Any]) -> Mapping[str, Any]:
    return _section(payload, "evidence", "dependencyEvidence") or _section(run_data, "dependencyEvidence")


def _execution(payload: Mapping[str, Any], run_data: Mapping[str, Any]) -> Mapping[str, Any]:
    return _section(payload, "execution", "dependencyExecution", "dependencyExecutionResult") or _section(
        run_data, "dependencyExecution", "dependencyExecutionResult"
    )


def _candidate_value(candidate: Mapping[str, Any], *names: str) -> str:
    return _text(_get(candidate, *names))


def _proof_row(gate: Mapping[str, Any], names: Sequence[str]) -> tuple[bool, str]:
    for item in _items(_get(gate, "evidence")):
        row = _mapping(item)
        if _text(_get(row, "name")) in names:
            return bool(_get(row, "passed")), _text(_get(row, "detail"))
    return False, "evidence row is missing"


def _ac_evidence(payload: Mapping[str, Any], run_data: Mapping[str, Any]) -> Mapping[str, Any]:
    return _section(payload, "acEvidence", "ac_evidence") or _section(run_data, "acEvidence", "ac_evidence")


def _blocked_ac_reasons(ac: Mapping[str, Any]) -> list[str]:
    reasons: list[str] = []

    unbound = [_text(item) for item in _items(_get(ac, "unbound")) if _text(item)]
    if unbound:
        reasons.append("unbound AC evidence: " + ", ".join(unbound))

    waived = [_text(_get(item, "id")) for item in _items(_get(ac, "waived")) if _text(_get(item, "id"))]
    if waived:
        reasons.append("waived AC evidence: " + ", ".join(waived))

    unverifiable = [_text(_get(item, "ac")) for item in _items(_get(ac, "unverifiable")) if _text(_get(item, "ac"))]
    if unverifiable:
        reasons.append("unverifiable AC evidence: " + ", ".join(unverifiable))

    for item in _items(_get(ac, "acs")):
        row = _mapping(item)
        ac_id = _text(_get(row, "id")) or "unknown-ac"
        status = _text(_get(row, "status"))
        if status and status != "proven":
            reasons.append(f"AC {ac_id} is {status}")

    return reasons


def evaluate_dependency_publication(run_data: Mapping[str, Any]) -> DependencyPublicationDecision:
    """Validate every prerequisite required before a dependency PR is opened."""
    payload = _publication_payload(run_data)
    if payload is None:
        return DependencyPublicationDecision(True, (), {})

    candidate = _candidate(payload)
    approval = _approval(payload)
    evidence = _evidence(payload, run_data)
    execution = _execution(payload, run_data)
    gate = _section(payload, "objectiveGate") or _section(run_data, "objectiveGate")
    reviewability = _section(payload, "reviewability") or _section(run_data, "reviewability")
    ac = _ac_evidence(payload, run_data)
    reasons: list[str] = []

    fingerprint = _candidate_value(candidate, "fingerprint", "candidateFingerprint")
    if not fingerprint:
        reasons.append("candidate fingerprint is missing")
    if _get(approval, "approved") is not True or not _text(_get(approval, "approvalId", "approval_id")):
        reasons.append("explicit human approval is missing")

    evidence_decision = _section(evidence, "decision")
    evidence_fingerprint = _text(_get(evidence, "candidateFingerprint", "candidate_fingerprint"))
    identity = _section(evidence, "candidate")
    if not evidence:
        reasons.append("dependency evidence is missing")
    elif evidence_fingerprint != fingerprint:
        reasons.append("dependency evidence fingerprint does not match the approved candidate")
    for label, candidate_names, identity_names in (
        ("package", ("package",), ("package",)),
        ("current version", ("currentVersion", "current_version"), ("currentVersion", "current_version")),
        ("target version", ("targetVersion", "target_version"), ("targetVersion", "target_version")),
        ("baseline SHA", ("baselineSha", "baseline_sha"), ("baselineSha", "baseline_sha")),
        ("package manager", ("packageManager", "package_manager"), ("packageManager", "package_manager")),
    ):
        expected = _candidate_value(candidate, *candidate_names)
        observed = _candidate_value(identity, *identity_names)
        if expected and observed and expected != observed:
            reasons.append(f"dependency evidence {label} is stale or mismatched")
    if _get(evidence_decision, "proofComplete") is not True or _text(_get(evidence_decision, "status")) != "ready":
        reasons.append("dependency evidence is not proof-complete")
    waived = _items(_get(evidence_decision, "waivedReasons", "waived_reasons"))
    if waived and not _mapping(_get(evidence_decision, "waiver")):
        reasons.append("dependency evidence contains waivers without an explicit waiver record")

    execution_status = _text(_get(execution, "status"))
    execution_gate = _section(execution, "gate")
    if execution_status != "green" or _text(_get(execution_gate, "verdict")) != "green":
        reasons.append("approved dependency execution is not green")
    execution_fingerprint = _text(_get(execution, "candidateFingerprint", "candidate_fingerprint"))
    if not execution_fingerprint:
        reasons.append("dependency execution fingerprint is missing")
    elif execution_fingerprint != fingerprint:
        reasons.append("dependency execution fingerprint does not match the approved candidate")
    execution_baseline = _text(_get(execution, "baselineSha", "baseline_sha"))
    candidate_baseline = _candidate_value(candidate, "baselineSha", "baseline_sha")
    if execution_baseline and candidate_baseline and execution_baseline != candidate_baseline:
        reasons.append("dependency execution ran from a stale baseline SHA")

    if _text(_get(gate, "verdict")) != "green" or _get(gate, "isGreen") is not True:
        reasons.append("Objective Gate is not green")
    red_green_ok, _ = _proof_row(gate, ("red-green-proof", "redGreenProof"))
    if not red_green_ok:
        reasons.append("Red-Green Proof is missing or invalid")
    independent_ok, _ = _proof_row(gate, ("independent-verification", "independentVerification"))
    if _text(_get(run_data, "independentReview")) != "active" or not independent_ok:
        reasons.append("Independent Verification is missing or inactive")

    reasons.extend(_blocked_ac_reasons(ac))

    review_decision = _section(reviewability, "decision")
    review_diff = _section(reviewability, "diff")
    if _text(_get(review_decision, "status")) != "reviewable" or _get(review_decision, "proofComplete") is not True:
        reasons.append("reviewability evidence is not proof-complete")
    if not _text(_get(review_diff, "headSha", "head_sha")):
        reasons.append("reviewability evidence has no final head SHA")

    changed = [_text(item) for item in _items(_get(execution, "changedFiles", "changed_files")) if _text(item)]
    allowed = [_text(item) for item in _items(_get(execution, "allowedFiles", "allowed_files")) if _text(item)]
    if not allowed:
        allowed = [
            _candidate_value(candidate, "manifestPath", "manifest_path"),
            _candidate_value(candidate, "lockfilePath", "lockfile_path"),
        ] + [_text(item) for item in _items(_get(candidate, "requiredTestPaths", "required_test_paths"))]
        allowed = [item for item in allowed if item]
    out_of_scope = sorted(set(changed) - set(allowed))
    if out_of_scope:
        reasons.append("out-of-scope changed files: " + ", ".join(out_of_scope))
    if not changed:
        reasons.append("dependency execution did not record changed files")
    lockfile = _candidate_value(candidate, "lockfilePath", "lockfile_path")
    if not lockfile:
        reasons.append("dependency execution did not record the approved lockfile path")
    elif lockfile not in changed:
        reasons.append("dependency execution did not record the approved lockfile change")

    # A valid publication body is also an audit artifact. It includes the
    # negative/waived states instead of collapsing them into a green claim.
    return DependencyPublicationDecision(not reasons, tuple(dict.fromkeys(reasons)), payload)


def _bullet(values: Any, empty: str = "not recorded") -> str:
    items = [_text(value) for value in _items(values) if _text(value)]
    return "\n".join(f"- {item}" for item in items) or f"- {empty}"


def _commands(values: Any) -> str:
    commands: list[str] = []
    for item in _items(values):
        row = _mapping(item)
        command = _get(row, "command")
        if isinstance(command, (list, tuple)):
            commands.append(" ".join(_text(part) for part in command))
        elif _text(command):
            commands.append(_text(command))
    return "; ".join(commands) or "not recorded"


def build_dependency_pr_body(decision: DependencyPublicationDecision, *, issue_ref: str = "") -> str:
    """Build the PR body from artifacts, never from agent prose."""
    payload = decision.payload
    candidate = _candidate(payload)
    evidence = _evidence(payload, payload)
    execution = _execution(payload, payload)
    gate = _section(payload, "objectiveGate")
    reviewability = _section(payload, "reviewability")
    release = _section(evidence, "release")
    usage = _section(evidence, "usage")
    lock = _section(evidence, "lock")
    security = _section(evidence, "security")
    execution_files = _items(_get(execution, "changedFiles", "changed_files"))
    diff = _section(reviewability, "diff")
    ac = _section(payload, "acEvidence", "ac_evidence")
    visual = _items(_get(payload, "visualEvidence", "visual_evidence", "visualEvidenceRefs"))
    refused = list(decision.reasons)
    refused.extend(_text(item) for item in _items(_get(_section(evidence, "decision"), "blockingReasons", "blocking_reasons")))
    waived = _items(_get(_section(evidence, "decision"), "waivedReasons", "waived_reasons"))
    body = [
        f"Resolves #{issue_ref}" if issue_ref else "Proof-bearing dependency upgrade",
        "",
        "## Outcome",
        f"Upgrade {_candidate_value(candidate, 'package')} from {_candidate_value(candidate, 'currentVersion', 'current_version')} → {_candidate_value(candidate, 'targetVersion', 'target_version')}.",
        "This PR was constructed from the run artifacts. It is reviewable only because the publication contract passed; the artifacts remain the source of truth.",
        "",
        "## Candidate",
        f"- Package: `{_candidate_value(candidate, 'package')}` ({_candidate_value(candidate, 'dependencyKind', 'dependency_kind')})",
        f"- Ecosystem: `{_candidate_value(candidate, 'ecosystem') or 'not recorded'}`",
        f"- Package manager: `{_candidate_value(candidate, 'packageManager', 'package_manager') or 'not recorded'}`",
        f"- Version: `{_candidate_value(candidate, 'currentVersion', 'current_version')}` → `{_candidate_value(candidate, 'targetVersion', 'target_version')}`",
        f"- Candidate fingerprint: `{_candidate_value(candidate, 'fingerprint', 'candidateFingerprint')}`",
        f"- Baseline SHA: `{_candidate_value(candidate, 'baselineSha', 'baseline_sha')}`",
        "",
        "## Affected usage",
        _bullet(_get(usage, "directImports", "direct_imports"), "Usage evidence was not recorded."),
        "",
        "## Release evidence",
        f"- Resolution: `{_text(_get(release, 'resolution'), 'unknown')}`; version `{_text(_get(release, 'version'), 'unknown')}`; canonical: `{bool(_get(release, 'canonical'))}`",
        _bullet([_get(source, "url", "identifier") for source in _items(_get(release, "sources"))], "No canonical release source recorded."),
        "",
        "## Transitive / peer result",
        f"- Resolution: `{_text(_get(lock, 'resolution'), 'unknown')}`",
        _bullet([_text(_get(item, 'package')) + " " + ", ".join(_text(v) for v in _items(_get(item, 'toVersions', 'to_versions'))) for item in _items(_get(lock, 'transitiveChanges', 'transitive_changes'))], "No transitive changes recorded."),
        _bullet([_text(_get(item, 'detail')) for item in _items(_get(lock, 'peerConflicts', 'peer_conflicts'))], "No peer conflicts recorded."),
        "",
        "## Security result",
        f"- Resolution: `{_text(_get(security, 'resolution'), 'unknown')}`",
        _bullet([_text(_get(item, 'id')) + " " + _text(_get(item, 'severity')) for item in _items(_get(security, 'advisories'))], "No advisories recorded."),
        "",
        "## Baseline tests",
        _bullet([f"{_commands([item])} — {'passed' if _get(item, 'passed') is True else 'not proven'}" for item in _items(_get(execution, 'baselineVerification', 'baseline_verification'))]),
        "",
        "## Target tests",
        _bullet([f"{_commands([item])} — {'passed' if _get(item, 'passed') is True else 'not proven'}" for item in _items(_get(execution, 'targetVerification', 'target_verification'))]),
        "",
        "## Changed-file scope",
        _bullet(execution_files),
        f"- Non-lockfile reviewability: `{_get(diff, 'nonLockfileChangedLines', 'non_lockfile_changed_lines', default='not recorded')}` lines",
        f"- Lockfile churn (reported separately): `{_get(diff, 'lockfileChangedLines', 'lockfile_changed_lines', default='not recorded')}` lines",
        "",
        "## Acceptance-criteria proof",
    ]
    acs = _items(_get(ac, "acs"))
    if acs:
        for item in acs:
            row = _mapping(item)
            refs = ", ".join(_text(_get(ref, "ref", "id")) for ref in _items(_get(row, "evidence"))) or "none"
            verifier = _text(_get(row, "verifierResult", "verifier_result", "result"), "not recorded")
            body.append(f"- `{_text(_get(row, 'id'))}` — {_text(_get(row, 'text'))} — status: `{_text(_get(row, 'status'), 'not proven')}`; evidence: {refs}; verifier: `{verifier}`")
    else:
        body.append("- No per-AC artifact recorded; not proven.")
    body.extend([
        f"- Unbound ACs: {', '.join(_text(item) for item in _items(_get(ac, 'unbound'))) or 'none'}",
        f"- Waived ACs: {', '.join(_text(_get(item, 'id')) for item in _items(_get(ac, 'waived'))) or 'none'}",
        f"- Unverifiable ACs: {', '.join(_text(_get(item, 'ac')) for item in _items(_get(ac, 'unverifiable'))) or 'none'}",
        "",
        "## Gate and review evidence",
        f"- Objective Gate: `{_text(_get(gate, 'verdict'), 'not proven')}`",
        f"- Red-Green Proof: `{_proof_row(gate, ('red-green-proof', 'redGreenProof'))[1]}`",
        f"- Independent Verification: `{_proof_row(gate, ('independent-verification', 'independentVerification'))[1]}`",
        f"- Reviewability: `{_text(_get(_section(reviewability, 'decision'), 'status'), 'not proven')}`; final head `{_text(_get(_section(reviewability, 'diff'), 'headSha', 'head_sha'), 'not recorded')}`",
        "",
        "## Unverified / refused / waived checks",
        _bullet(refused, "None recorded."),
        _bullet([f"waived: {item}" for item in waived], "No dependency evidence waivers recorded."),
        "",
        "## Visual evidence",
        _bullet(visual, "Not applicable to this non-UI dependency change."),
        "",
        "Merge: disabled by default. Human review and any merge decision remain separate from this publication path.",
    ])
    return "\n".join(body)


__all__ = [
    "DependencyPublicationDecision",
    "build_dependency_pr_body",
    "evaluate_dependency_publication",
    "is_dependency_publication",
]
