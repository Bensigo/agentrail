"""Live observation worker for the tenant-scoped dependency watch.

This is deliberately separate from the Issue Queue runtime. A watch can read a
connected repository, inspect registry metadata, and persist candidates or a
typed failure, but it cannot enqueue an issue, edit a checkout, install a
package, or create an approval.
"""
from __future__ import annotations

import base64
import json
import urllib.parse
import urllib.request
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional, Protocol

from agentrail.afk import queue_store
from agentrail.dependencies.pnpm import (
    DependencySnapshot,
    RegistryPackage,
)
from agentrail.dependencies.manager import SupportedDetection, detect_dependency_manager
from agentrail.heartbeat.dependency_watch import (
    DependencyWatchState,
    WatchFailure,
    WatchObservation,
    WatchStore,
    WatchTrigger,
    observe_watch,
)
from agentrail.heartbeat.token_provider import get_github_token


CLAIM_WATCHES_OP = "claim_dependency_watches"
RECORD_WATCH_OBSERVATION_OP = "record_dependency_watch_observation"

queue_store._SQL.update(
    {
        CLAIM_WATCHES_OP: (
            "WITH candidates AS ("
            " SELECT id FROM dependency_watches"
            " WHERE workspace_id = %(workspace_id)s AND ("
            "   (status = 'checking' AND last_trigger IN ('manual', 'push'))"
            "   OR (cadence_seconds IS NOT NULL AND next_check_at IS NOT NULL"
            "       AND next_check_at <= %(now)s AND status <> 'checking')"
            " ) ORDER BY next_check_at NULLS FIRST, updated_at"
            " FOR UPDATE SKIP LOCKED LIMIT %(limit)s"
            ") UPDATE dependency_watches AS watch"
            " SET status = 'checking', last_trigger = CASE"
            "   WHEN watch.last_trigger IN ('manual', 'push') THEN watch.last_trigger"
            "   ELSE 'scheduled' END,"
            " last_triggered_at = %(now)s,"
            " next_check_at = CASE WHEN watch.cadence_seconds IS NULL THEN NULL"
            "   ELSE %(now)s + (watch.cadence_seconds * interval '1 second') END,"
            " updated_at = %(now)s FROM candidates"
            " WHERE watch.id = candidates.id"
            " RETURNING watch.*,"
            " (SELECT name FROM repositories r WHERE r.id = watch.repository_id) AS repository_name,"
            " (SELECT default_branch FROM repositories r WHERE r.id = watch.repository_id) AS default_branch"
        ),
        RECORD_WATCH_OBSERVATION_OP: (
            "WITH inserted AS (INSERT INTO dependency_watch_observations "
            "(workspace_id, watch_id, repository_id, trigger, baseline_sha, "
            "selected_file_hashes, observation_key, status, candidates, "
            "error_code, error_message, observed_at) VALUES "
            "(%(workspace_id)s, %(watch_id)s, %(repository_id)s, %(trigger)s, "
            "%(baseline_sha)s, %(selected_file_hashes)s::jsonb, %(observation_key)s, "
            "%(status)s, %(candidates)s::jsonb, %(error_code)s, %(error_message)s, "
            "%(observed_at)s) ON CONFLICT (workspace_id, repository_id, observation_key) "
            "DO NOTHING RETURNING id) UPDATE dependency_watches SET "
            "last_checked_sha = %(baseline_sha)s, selected_file_hashes = %(selected_file_hashes)s::jsonb, "
            "candidate_fingerprint = CASE WHEN %(status)s = 'candidates' THEN %(candidate_fingerprint)s ELSE NULL END, "
            "status = %(status)s, error_code = %(error_code)s, error_message = %(error_message)s, "
            "last_checked_at = %(observed_at)s, updated_at = %(observed_at)s "
            "WHERE id = %(watch_id)s AND workspace_id = %(workspace_id)s"
        ),
    }
)


class Reader(Protocol):
    def query(self, op: str, params: Dict[str, Any]) -> List[Dict[str, Any]]: ...

    def execute(self, op: str, params: Dict[str, Any]) -> None: ...


class DependencyProposalPublisher(Protocol):
    """Submit an observed candidate to Jace's proposal boundary.

    The publisher may create a durable proposal/contract, but it cannot
    approve it or admit executable work. The API owns that approval gate.
    """

    def publish(self, *, workspace_id: str, watch_id: str, candidate: Any) -> None: ...


class HttpDependencyProposalPublisher:
    """Small authenticated adapter from the heartbeat process to console Jace."""

    def __init__(
        self,
        *,
        base_url: str,
        token: str,
        post: Optional[Callable[[str, Dict[str, Any], str], Any]] = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self._post = post or self._post_json

    def _post_json(self, url: str, payload: Dict[str, Any], token: str) -> Any:
        request = urllib.request.Request(
            url,
            data=json.dumps(payload, sort_keys=True).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "agentrail-heartbeat",
            },
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=8) as response:
            return json.load(response)

    def publish(self, *, workspace_id: str, watch_id: str, candidate: Any) -> None:
        fingerprint = getattr(candidate, "fingerprint", None)
        if not isinstance(fingerprint, str) or not fingerprint:
            raise ValueError("dependency candidate has no fingerprint")
        self._post(
            f"{self.base_url}/api/v1/runner/dependency-upgrade-proposals",
            {
                "workspaceId": workspace_id,
                "watchId": watch_id,
                "candidateFingerprint": fingerprint,
            },
            self.token,
        )


class RegistryClient:
    def __init__(self, get_json: Callable[[str], Any], manager_id: Optional[str] = None):
        self._get_json = get_json
        self.manager_id = manager_id

    def package_metadata(self, package: str) -> Optional[RegistryPackage]:
        try:
            encoded = urllib.parse.quote(package, safe="@/:")
            if self.manager_id in (None, "npm", "pnpm"):
                body = self._get_json("https://registry.npmjs.org/" + encoded)
                versions = body.get("versions", {}) if isinstance(body, dict) else {}
                return RegistryPackage(tuple(str(version) for version in versions)) if isinstance(versions, dict) else None
            if self.manager_id in ("poetry", "uv"):
                body = self._get_json("https://pypi.org/pypi/" + encoded + "/json")
                releases = body.get("releases", {}) if isinstance(body, dict) else {}
                return RegistryPackage(tuple(str(version) for version in releases)) if isinstance(releases, dict) else None
            if self.manager_id == "cargo":
                body = self._get_json("https://crates.io/api/v1/crates/" + encoded)
                versions = body.get("versions", []) if isinstance(body, dict) else []
                values = [item.get("num") for item in versions if isinstance(item, dict) and isinstance(item.get("num"), str)]
                return RegistryPackage(tuple(values))
            if self.manager_id == "go-modules":
                raw = self._get_json("https://proxy.golang.org/" + encoded + "/@v/list")
                if not isinstance(raw, str):
                    return None
                return RegistryPackage(tuple(line.strip() for line in raw.splitlines() if line.strip()))
            return None
        except Exception:
            return None


class NewestCompatibleTarget:
    """Conservative target choice for the detector's already-validated specifier."""

    def choose_target_version(self, package, current_version, specifier, available_versions):
        def nums(value: str):
            parts = value.lstrip("v=").split(".")
            try: return tuple(int(p.split("-")[0]) for p in parts[:3])
            except ValueError: return None

        current = nums(current_version)
        if current is None: return None
        candidates = [v for v in available_versions if nums(v) is not None and nums(v) > current]
        if specifier.startswith("^"):
            candidates = [v for v in candidates if nums(v)[0] == current[0]]
        elif specifier.startswith("~"):
            candidates = [v for v in candidates if nums(v)[:2] == current[:2]]
        return max(candidates, key=lambda v: nums(v)) if candidates else None


class GithubSnapshotProvider:
    _AUTO_ROOT_FILES = (
        "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml",
        "yarn.lock", "bun.lock", "bun.lockb", "pyproject.toml", "poetry.lock",
        "uv.lock", "requirements.txt", "requirements-dev.txt", "Cargo.toml", "Cargo.lock",
        "go.mod", "go.sum", "Gemfile", "Gemfile.lock", "composer.json", "composer.lock",
        "pom.xml", "build.gradle", "build.gradle.kts", "packages.lock.json", "mix.exs",
        "mix.lock", "pubspec.yaml", "pubspec.lock", "Package.swift", "Package.resolved",
    )

    def __init__(self, token: str, http_get: Callable[[str, str], Any]):
        self.token = token
        self._get = http_get

    def snapshot(self, repository: str, branch: str, manifest: str, lockfile: str) -> DependencySnapshot:
        commit = self._get(
            f"https://api.github.com/repos/{repository}/commits/{urllib.parse.quote(branch, safe='')}",
            self.token,
        )
        sha = commit.get("sha") if isinstance(commit, dict) else None
        if not isinstance(sha, str) or not sha: raise ValueError("GitHub did not return a commit SHA")
        files: Dict[str, str] = {}
        paths = [manifest, lockfile]
        if "auto" in paths:
            listing = self._get(
                f"https://api.github.com/repos/{repository}/contents/?ref={urllib.parse.quote(sha, safe='')}",
                self.token,
            )
            if not isinstance(listing, list):
                raise ValueError("GitHub did not return a repository root listing")
            available = {
                str(item.get("path"))
                for item in listing
                if isinstance(item, dict) and item.get("type") == "file"
            }
            paths = [path for path in self._AUTO_ROOT_FILES if path in available]
        for path in dict.fromkeys(path for path in paths if path != "auto"):
            body = self._get(
                f"https://api.github.com/repos/{repository}/contents/{urllib.parse.quote(path, safe='/')}?ref={sha}",
                self.token,
            )
            content = body.get("content") if isinstance(body, dict) else None
            encoding = body.get("encoding") if isinstance(body, dict) else None
            if not isinstance(content, str) or encoding != "base64": raise ValueError(f"GitHub did not return {path}")
            files[path] = base64.b64decode(content.replace("\n", "")).decode("utf-8")
        return DependencySnapshot(files=files, baseline_sha=sha)


class SqlWatchStore(WatchStore):
    def __init__(self, executor: Reader, row: Dict[str, Any]):
        self.executor = executor
        self.row = row

    def workspace_for_watch(self, watch_id: str) -> Optional[str]:
        return str(self.row.get("workspace_id")) if str(self.row.get("id")) == watch_id else None

    def record_observation(self, *, watch_id, workspace_id, observation, snapshot, selected_file_hashes, observed_at):
        error_code = None
        if observation.failure is WatchFailure.UNSUPPORTED: error_code = "unsupported"
        elif observation.failure is WatchFailure.INSUFFICIENT_EVIDENCE: error_code = "insufficient_evidence"
        candidates = [asdict(candidate) for candidate in observation.candidates]
        self.executor.execute(RECORD_WATCH_OBSERVATION_OP, {
            "workspace_id": workspace_id,
            "watch_id": watch_id,
            "repository_id": self.row["repository_id"],
            "trigger": observation.trigger.value,
            "baseline_sha": snapshot.baseline_sha,
            "selected_file_hashes": json.dumps(dict(selected_file_hashes), sort_keys=True),
            "observation_key": observation.observation_key,
            "candidate_fingerprint": observation.candidate_fingerprint,
            "status": observation.status,
            "candidates": json.dumps(candidates, sort_keys=True),
            "error_code": error_code,
            "error_message": observation.reason,
            "observed_at": observed_at,
        })
        return True


def _http_get(url: str, token: str) -> Any:
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "User-Agent": "agentrail-heartbeat"})
    with urllib.request.urlopen(request, timeout=8) as response:
        return json.load(response)


class DependencyWatchRuntime:
    def __init__(self, *, workspace_id: str, executor: Reader, snapshot_provider=None, registry=None, target_versions=None, token_provider=get_github_token, proposal_publisher: Optional[DependencyProposalPublisher] = None):
        self.workspace_id = workspace_id
        self.executor = executor
        self.snapshot_provider = snapshot_provider
        self.registry = registry
        self.target_versions = target_versions or NewestCompatibleTarget()
        self.token_provider = token_provider
        self.proposal_publisher = proposal_publisher

    def run_once(self, limit: int = 25) -> Dict[str, int]:
        now = datetime.now(timezone.utc)
        rows = self.executor.query(CLAIM_WATCHES_OP, {"workspace_id": self.workspace_id, "now": now, "limit": limit})
        result = {"claimed": len(rows), "candidates": 0, "failed": 0, "unchanged": 0, "proposal_errors": 0}
        for row in rows:
            observation = self._observe(row, now)
            result[observation.status] = result.get(observation.status, 0) + 1
            if observation.status == "candidates" and self.proposal_publisher:
                for candidate in observation.candidates:
                    try:
                        self.proposal_publisher.publish(
                            workspace_id=self.workspace_id,
                            watch_id=str(row["id"]),
                            candidate=candidate,
                        )
                    except Exception as exc:
                        result["proposal_errors"] += 1
                        print(
                            f"dependency proposal submission failed for {row['id']}:{getattr(candidate, 'fingerprint', 'unknown')}: {exc}"
                        )
        return result

    def _observe(self, row: Dict[str, Any], now: datetime) -> WatchObservation:
        trigger = WatchTrigger(str(row.get("last_trigger") or "scheduled"))
        try:
            token = self.token_provider(self.workspace_id, self.executor)
            if not token: raise ValueError("GitHub installation token unavailable")
            provider = self.snapshot_provider or GithubSnapshotProvider(token, _http_get)
            snapshot = provider.snapshot(str(row["repository_name"]), str(row.get("default_branch") or "main"), str(row["manifest_path"]), str(row["lockfile_path"]))
            detected = detect_dependency_manager(snapshot.files)
            registry = self.registry or RegistryClient(
                lambda url: _http_get(url, ""),
                detected.manager_id.value if isinstance(detected, SupportedDetection) else None,
            )
            watch = DependencyWatchState(
                workspace_id=self.workspace_id,
                repository_id=str(row["repository_id"]),
                selected_manifest=str(row["manifest_path"]),
                selected_lockfile=str(row["lockfile_path"]),
                selected_dependencies=tuple(json.loads(row.get("selected_dependencies", "[]")) if isinstance(row.get("selected_dependencies"), str) else row.get("selected_dependencies", [])),
                cadence_seconds=row.get("cadence_seconds"),
                last_checked_sha=row.get("last_checked_sha"),
                selected_file_hashes=json.loads(row.get("selected_file_hashes", "{}")) if isinstance(row.get("selected_file_hashes"), str) else (row.get("selected_file_hashes") or {}),
            )
            observation = observe_watch(
                watch_id=str(row["id"]), requested_workspace_id=self.workspace_id, watch=watch,
                snapshot=snapshot, registry=registry, target_versions=self.target_versions,
                trigger=trigger, store=SqlWatchStore(self.executor, row), now=now,
            )
            return observation
        except Exception as exc:
            result = WatchObservation(trigger=trigger, status="failed", observation_key=f"error:{trigger.value}:{row['id']}:{now.isoformat()}", failure=WatchFailure.INSUFFICIENT_EVIDENCE, reason=str(exc))
            self.executor.execute(RECORD_WATCH_OBSERVATION_OP, {
                "workspace_id": self.workspace_id, "watch_id": row["id"], "repository_id": row["repository_id"],
                "trigger": trigger.value, "baseline_sha": None, "selected_file_hashes": json.dumps({}),
                "observation_key": result.observation_key, "candidate_fingerprint": None,
                "status": "failed", "candidates": json.dumps([]),
                "error_code": "invalid_snapshot", "error_message": str(exc), "observed_at": now,
            })
            return result
