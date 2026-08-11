"""Observation-only dependency-watch trigger seam.

The console/database stores watch intent and cursors. This module is the small
heartbeat-side seam that decides whether an observation is allowed to run and
delegates dependency analysis to the manager-neutral observer. It never
creates queue entries, edits files, installs packages, or approves work.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Dict, Mapping, Optional, Protocol, Sequence, Tuple

from agentrail.dependencies.observation import observe_dependencies
from agentrail.dependencies.manager import SupportedDetection, detect_dependency_manager
from agentrail.dependencies.pnpm import (
    CandidatesResult,
    DependencyCandidate,
    DependencySnapshot,
    ObservationResult,
    ObservationStatus,
    RegistryAdapter,
    TargetVersionAdapter,
)


class WatchTrigger(str, Enum):
    MANUAL = "manual"
    SCHEDULED = "scheduled"
    PUSH = "push"


class WatchFailure(str, Enum):
    AUTHORIZATION = "authorization"
    INVALID_TRIGGER = "invalid_trigger"
    SELECTED_FILES_UNCHANGED = "selected_files_unchanged"
    UNSUPPORTED = "unsupported"
    INSUFFICIENT_EVIDENCE = "insufficient_evidence"


@dataclass(frozen=True)
class DependencyWatchState:
    workspace_id: str
    repository_id: str
    # "auto" lets the repository adapter select the manifest and lockfile;
    # explicit paths remain available for monorepos and unusual layouts.
    selected_manifest: str = "auto"
    selected_lockfile: str = "auto"
    selected_dependencies: Tuple[str, ...] = ()
    cadence_seconds: Optional[int] = None
    last_checked_sha: Optional[str] = None
    selected_file_hashes: Mapping[str, str] = field(default_factory=dict)
    candidate_fingerprint: Optional[str] = None
    status: str = "idle"
    error_code: Optional[str] = None
    error_message: Optional[str] = None
    last_checked_at: Optional[datetime] = None


@dataclass(frozen=True)
class WatchObservation:
    trigger: WatchTrigger
    status: str
    observation_key: str
    candidate_fingerprint: Optional[str] = None
    candidates: Tuple[DependencyCandidate, ...] = ()
    failure: Optional[WatchFailure] = None
    reason: Optional[str] = None
    skipped: bool = False


class WatchStore(Protocol):
    def workspace_for_watch(self, watch_id: str) -> Optional[str]:
        """Return the owning workspace, or None when the watch is unknown."""

    def record_observation(
        self,
        *,
        watch_id: str,
        workspace_id: str,
        observation: WatchObservation,
        snapshot: DependencySnapshot,
        selected_file_hashes: Mapping[str, str],
        observed_at: datetime,
    ) -> bool:
        """Persist the observation; False means the observation key already exists."""


def selected_files_changed(
    previous: Mapping[str, str], current: Mapping[str, str], selected_paths: Sequence[str]
) -> bool:
    """Push gating: only selected manifest/lockfile changes may trigger detection."""
    return any(previous.get(path) != current.get(path) for path in selected_paths)


def file_hashes(files: Mapping[str, str], selected_paths: Sequence[str]) -> Dict[str, str]:
    return {
        path: hashlib.sha256(files[path].encode("utf-8")).hexdigest()
        for path in selected_paths
        if path in files
    }


def _selected_paths(watch: DependencyWatchState, files: Mapping[str, str]) -> Tuple[str, ...]:
    """Resolve auto watches to the single detected manager's files.

    Explicit paths remain important for monorepos. Auto watches use the same
    manager detector as observation, so a push cannot accidentally trigger on
    an unrelated lockfile.
    """
    requested = (watch.selected_manifest, watch.selected_lockfile)
    if all(path != "auto" for path in requested):
        return requested
    detection = detect_dependency_manager(files)
    if isinstance(detection, SupportedDetection):
        paths = [detection.manifest_path]
        if detection.lockfile_path:
            paths.append(detection.lockfile_path)
        return tuple(dict.fromkeys(paths))
    return tuple(sorted(path for path in files if path.endswith((
        "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock",
        "pyproject.toml", "poetry.lock", "uv.lock", "Cargo.toml", "Cargo.lock",
        "go.mod", "go.sum",
    ))))


def _observation_key(result: ObservationResult, snapshot: DependencySnapshot) -> str:
    receipt = snapshot.source_inventory_receipt
    if isinstance(result, CandidatesResult):
        candidate_fingerprints = sorted(
            candidate.fingerprint for candidate in result.candidates
        )
        payload: object = candidate_fingerprints
        if receipt is not None:
            payload = {
                "candidate_fingerprints": candidate_fingerprints,
                "source_inventory_receipt_sha256": receipt.identity_sha256,
            }
        digest = hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        receipt_suffix = (
            f":source:{receipt.identity_sha256}" if receipt is not None else ""
        )
        return f"candidates:{digest}{receipt_suffix}"
    payload = {
        "baseline_sha": snapshot.baseline_sha,
        "reasons": list(result.reasons),
        "status": result.status.value,
    }
    if receipt is not None:
        payload["source_inventory_receipt_sha256"] = receipt.identity_sha256
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    receipt_suffix = (
        f":source:{receipt.identity_sha256}" if receipt is not None else ""
    )
    return f"{result.status.value}:{digest}{receipt_suffix}"


def _candidate_fingerprint(result: ObservationResult) -> Optional[str]:
    if isinstance(result, CandidatesResult) and result.candidates:
        return result.candidates[0].fingerprint
    return None


def _failure_for(result: ObservationResult) -> Optional[WatchFailure]:
    if result.status is ObservationStatus.UNSUPPORTED:
        return WatchFailure.UNSUPPORTED
    if result.status is ObservationStatus.INSUFFICIENT_EVIDENCE:
        return WatchFailure.INSUFFICIENT_EVIDENCE
    return None


def observe_watch(
    *,
    watch_id: str,
    requested_workspace_id: str,
    watch: DependencyWatchState,
    snapshot: DependencySnapshot,
    registry: RegistryAdapter,
    target_versions: TargetVersionAdapter,
    trigger: WatchTrigger,
    store: WatchStore,
    now: Optional[datetime] = None,
) -> WatchObservation:
    """Run one explicit/manual/scheduled observation, fail-closed and deduped."""
    observed_at = now or datetime.now(timezone.utc)
    if watch.workspace_id != requested_workspace_id:
        observation = WatchObservation(
            trigger=trigger,
            status="failed",
            observation_key="authorization",
            failure=WatchFailure.AUTHORIZATION,
            reason="watch belongs to another workspace",
        )
        return observation

    selected_paths = _selected_paths(watch, snapshot.files)
    current_hashes = file_hashes(snapshot.files, selected_paths)
    if trigger is WatchTrigger.PUSH and not selected_files_changed(
        watch.selected_file_hashes, current_hashes, selected_paths
    ):
        receipt_suffix = (
            f":source:{snapshot.source_inventory_receipt.identity_sha256}"
            if snapshot.source_inventory_receipt is not None
            else ""
        )
        observation = WatchObservation(
            trigger=trigger,
            status="unchanged",
            observation_key=(
                f"push-unchanged:{snapshot.baseline_sha}{receipt_suffix}"
            ),
            failure=WatchFailure.SELECTED_FILES_UNCHANGED,
            reason="selected manifest and lockfile did not change",
            skipped=True,
        )
        store.record_observation(
            watch_id=watch_id,
            workspace_id=requested_workspace_id,
            observation=observation,
            snapshot=snapshot,
            selected_file_hashes=current_hashes,
            observed_at=observed_at,
        )
        return observation

    result = observe_dependencies(
        snapshot,
        selected_dependencies=watch.selected_dependencies,
        registry=registry,
        target_versions=target_versions,
    )
    failure = _failure_for(result)
    observation = WatchObservation(
        trigger=trigger,
        status="candidates" if result.status is ObservationStatus.CANDIDATES else (
            "unchanged" if result.status is ObservationStatus.UNCHANGED else "failed"
        ),
        observation_key=_observation_key(result, snapshot),
        candidate_fingerprint=_candidate_fingerprint(result),
        candidates=result.candidates,
        failure=failure,
        reason="; ".join(result.reasons) if result.reasons else None,
    )
    store.record_observation(
        watch_id=watch_id,
        workspace_id=requested_workspace_id,
        observation=observation,
        snapshot=snapshot,
        selected_file_hashes=current_hashes,
        observed_at=observed_at,
    )
    return observation
