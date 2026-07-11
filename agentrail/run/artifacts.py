from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional

from agentrail.shared.json import read_json, write_json


def write_run_metadata(
    path: Path,
    *,
    started_at: str,
    issue: int,
    agent: str,
    command: str,
    prompt_file: str,
    resolved_skills_file: str,
    resolved_skills: List[Dict[str, Any]],
    max_execution_attempts: int,
    context_pack_file: Optional[str],
    context_retrieval: Dict[str, Any],
) -> None:
    write_json(path, {
        "startedAt": started_at,
        "targetType": "issue",
        "targetIssue": issue,
        "agent": agent,
        "command": command,
        "executionAttempt": 1,
        "maxExecutionAttempts": max_execution_attempts,
        "failedVerificationAttempts": 0,
        "promptFile": prompt_file,
        "contextPackFile": context_pack_file,
        "contextRetrieval": context_retrieval or {},
        "resolvedSkillsFile": resolved_skills_file,
        "resolvedSkills": resolved_skills,
    })


def update_run_metadata_attempts(
    path: Path,
    *,
    execution_attempt: int,
    max_execution_attempts: int,
    failed_verification_attempts: int,
    verifier_findings_file: str = "",
    blocked_reason: str = "",
) -> None:
    data = read_json(path)
    data["executionAttempt"] = execution_attempt
    data["maxExecutionAttempts"] = max_execution_attempts
    data["failedVerificationAttempts"] = failed_verification_attempts
    if verifier_findings_file:
        data["verifierFindingsFile"] = verifier_findings_file
    if blocked_reason:
        data["blockedReason"] = blocked_reason
    write_json(path, data)


def write_phase_status(
    path: Path,
    *,
    phase: str,
    status: str,
    started_at: str,
    finished_at: Optional[str],
    exit_status: int,
    metadata_file: str,
    output_file: str,
    execution_attempt: int,
    max_execution_attempts: int,
    verifier_findings_file: str = "",
) -> None:
    data: Dict[str, Any] = {
        "phase": phase,
        "status": status,
        "startedAt": started_at,
        "finishedAt": finished_at,
        "exitStatus": exit_status,
        "metadataFile": metadata_file,
        "outputFile": output_file,
        "executionAttempt": execution_attempt,
        "maxExecutionAttempts": max_execution_attempts,
    }
    if verifier_findings_file:
        data["verifierFindingsFile"] = verifier_findings_file
    write_json(path, data)


def write_phase_verdict(run_dir: Path, phase: str, verdict_payload: Dict[str, Any]) -> None:
    """Best-effort write-back of a parsed verdict onto ``<phase>/status.json``.

    Merges ``{"verdict": verdict_payload}`` into the phase's already-written
    status.json so a structured accept/reject survives alongside the raw
    process exit code — a verify agent that exits 0 but REJECTS in prose is
    otherwise indistinguishable from a genuine approval (issue #1181).

    Never raises into the pipeline: a missing or unreadable status.json (the
    phase hasn't written one yet, or never will) is a silent no-op, and a
    write failure is swallowed the same way. Safe to call more than once —
    each call overwrites the previous verdict.
    """
    path = Path(run_dir) / phase / "status.json"
    try:
        data = read_json(path)
    except Exception:  # noqa: BLE001 — best-effort, must never raise into the pipeline
        return
    data["verdict"] = verdict_payload
    try:
        write_json(path, data)
    except Exception:  # noqa: BLE001 — best-effort, must never raise into the pipeline
        pass


def write_phase_metadata(
    path: Path,
    *,
    phase: str,
    started_at: str,
    finished_at: Optional[str],
    status: str,
    exit_status: int,
    issue: int,
    agent: str,
    command: str,
    prompt_file: str,
    context_pack_file: Optional[str],
    output_file: str,
    status_file: str,
    run_id: str,
    run_dir: str,
    execution_attempt: int,
    max_execution_attempts: int,
    verifier_findings_file: str = "",
) -> None:
    data: Dict[str, Any] = {
        "phase": phase,
        "startedAt": started_at,
        "finishedAt": finished_at,
        "status": status,
        "exitStatus": exit_status,
        "targetType": "issue",
        "targetIssue": issue,
        "agent": agent,
        "command": command,
        "promptFile": prompt_file,
        "contextPackFile": context_pack_file,
        "outputFile": output_file,
        "statusFile": status_file,
        "runId": run_id,
        "runDir": run_dir,
        "executionAttempt": execution_attempt,
        "maxExecutionAttempts": max_execution_attempts,
    }
    if verifier_findings_file:
        data["verifierFindingsFile"] = verifier_findings_file
    write_json(path, data)
