"""Live observation worker for the tenant-scoped dependency watch.

This is deliberately separate from the Issue Queue runtime. A watch can read a
connected repository, inspect registry metadata, and persist candidates or a
typed failure, but it cannot enqueue an issue, edit a checkout, install a
package, or create an approval.
"""
from __future__ import annotations

import base64
import binascii
import json
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Mapping, Optional, Protocol

from agentrail.afk import queue_store
from agentrail.dependencies.cargo import (
    CARGO_LOCK_MAX_BYTES,
    CARGO_MANIFEST_MAX_BYTES,
)
from agentrail.dependencies.go_modules import (
    GO_GITHUB_TREE_MAX_ENTRIES,
    GO_MOD_MAX_BYTES,
    GO_PROXY_LIST_MAX_BYTES,
    GO_SUM_MAX_BYTES,
    go_proxy_list_url,
    go_snapshot_path_refusal,
    parse_go_proxy_list,
)
from agentrail.dependencies.pnpm import (
    DependencySnapshot,
    RegistryPackage,
)
from agentrail.dependencies.manager import SupportedDetection, detect_dependency_manager
from agentrail.dependencies.strict_json import loads_strict_json
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
_REGISTRY_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
_REGISTRY_READ_CHUNK_BYTES = 64 * 1024
_NPM_ABBREVIATED_ACCEPT = "application/vnd.npm.install-v1+json"


class _GoProxyNoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Reject proxy redirects before urllib can contact their target."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _open_go_proxy_request(request: urllib.request.Request, timeout: int) -> Any:
    """Open the canonical public Go proxy request without redirects or env proxies."""

    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        _GoProxyNoRedirectHandler(),
    )
    return opener.open(request, timeout=timeout)


def _cargo_base64_content_limits(decoded_byte_limit: int) -> tuple[int, int]:
    """Return compact and conservatively line-wrapped base64 character caps."""

    compact = 4 * ((decoded_byte_limit + 2) // 3)
    wrapped = compact + ((compact + 59) // 60) + 1
    return compact, wrapped


def _canonical_repository_path(raw_path: str) -> str:
    """Canonicalize one repository-relative locator without hiding traversal."""

    if not isinstance(raw_path, str):
        raise ValueError("repository path must be text")
    path = raw_path.replace("\\", "/")
    if (
        not path
        or "\x00" in path
        or path.startswith("/")
        or (len(path) >= 2 and path[0].isalpha() and path[1] == ":")
    ):
        raise ValueError(f"unsafe repository path: {raw_path}")
    parts = []
    for part in path.split("/"):
        if part == ".":
            continue
        if not part or part == "..":
            raise ValueError(f"unsafe repository path: {raw_path}")
        parts.append(part)
    if not parts:
        raise ValueError(f"unsafe repository path: {raw_path}")
    return "/".join(parts)

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
            "error_code, error_message, observed_at, candidate_fingerprint) VALUES "
            "(%(workspace_id)s, %(watch_id)s, %(repository_id)s, %(trigger)s, "
            "%(baseline_sha)s, %(selected_file_hashes)s::jsonb, %(observation_key)s, "
            "%(status)s, %(candidates)s::jsonb, %(error_code)s, %(error_message)s, "
            "%(observed_at)s, %(candidate_fingerprint)s) ON CONFLICT "
            "(workspace_id, repository_id, observation_key) "
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

    def package_metadata_source_url(self, package: str) -> Optional[str]:
        if self.manager_id != "go-modules":
            return None
        try:
            return go_proxy_list_url(package)
        except ValueError:
            return None

    def package_metadata(self, package: str) -> Optional[RegistryPackage]:
        try:
            encoded = urllib.parse.quote(package, safe="@/:")
            if self.manager_id in ("npm", "pnpm"):
                body = self._get_json("https://registry.npmjs.org/" + encoded)
                versions = body.get("versions", {}) if isinstance(body, dict) else {}
                return RegistryPackage(tuple(str(version) for version in versions)) if isinstance(versions, dict) else None
            if self.manager_id in ("poetry", "uv"):
                body = self._get_json("https://pypi.org/pypi/" + encoded + "/json")
                releases = body.get("releases", {}) if isinstance(body, dict) else {}
                return RegistryPackage(tuple(str(version) for version in releases)) if isinstance(releases, dict) else None
            if self.manager_id == "cargo":
                body = self._get_json("https://crates.io/api/v1/crates/" + encoded)
                if not isinstance(body, dict):
                    return None
                crate = body.get("crate")
                versions = body.get("versions")
                if (
                    not isinstance(crate, dict)
                    or type(crate.get("id")) is not str
                    or crate["id"] != package
                    or not isinstance(versions, list)
                    or not versions
                ):
                    return None
                values: List[str] = []
                yanked: List[str] = []
                seen = set()
                for item in versions:
                    if not isinstance(item, dict):
                        return None
                    version = item.get("num")
                    is_yanked = item.get("yanked")
                    if (
                        type(version) is not str
                        or not version
                        or version != version.strip()
                        or type(is_yanked) is not bool
                        or version in seen
                    ):
                        return None
                    seen.add(version)
                    values.append(version)
                    if is_yanked:
                        yanked.append(version)
                return RegistryPackage(tuple(values), tuple(yanked))
            if self.manager_id == "go-modules":
                raw = self._get_json(go_proxy_list_url(package))
                if not isinstance(raw, str):
                    return None
                return RegistryPackage(parse_go_proxy_list(package, raw))
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
    _NODE_ROOT_MARKERS = (
        "package.json",
        "package-lock.json",
        "npm-shrinkwrap.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "bun.lock",
        "bun.lockb",
    )
    _ROOT_INVENTORY_MAX_ENTRIES = 1_000
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

    def _verify_go_recursive_inventory(
        self,
        repository: str,
        commit: Mapping[str, Any],
    ) -> Mapping[str, str]:
        """Require one complete exact-tree inventory for a root Go watch."""

        commit_sha = commit.get("sha") if isinstance(commit, dict) else None
        if (
            not isinstance(commit_sha, str)
            or len(commit_sha) not in (40, 64)
            or any(character not in "0123456789abcdef" for character in commit_sha)
        ):
            raise ValueError("GitHub did not return an exact Go commit SHA")
        commit_data = commit.get("commit") if isinstance(commit, dict) else None
        tree_data = commit_data.get("tree") if isinstance(commit_data, dict) else None
        tree_sha = tree_data.get("sha") if isinstance(tree_data, dict) else None
        if (
            not isinstance(tree_sha, str)
            or len(tree_sha) not in (40, 64)
            or any(character not in "0123456789abcdef" for character in tree_sha)
        ):
            raise ValueError("GitHub did not return the exact Go root tree SHA")
        response = self._get(
            "https://api.github.com/repos/"
            f"{repository}/git/trees/{tree_sha}?recursive=1",
            self.token,
        )
        if not isinstance(response, dict) or response.get("sha") != tree_sha:
            raise ValueError("GitHub Go inventory is not bound to the exact root tree SHA")
        if response.get("truncated") is not False:
            raise ValueError("GitHub Go recursive inventory is truncated")
        entries = response.get("tree")
        if not isinstance(entries, list):
            raise ValueError("GitHub did not return a recursive Go inventory")
        if len(entries) >= GO_GITHUB_TREE_MAX_ENTRIES:
            raise ValueError("GitHub Go recursive inventory exceeds the entry limit")

        inventory: List[str] = []
        entries_by_path: Dict[str, Dict[str, Any]] = {}
        folded_paths: Dict[str, str] = {}
        for item in entries:
            if not isinstance(item, dict):
                raise ValueError("GitHub Go recursive inventory contains a malformed entry")
            raw_path = item.get("path")
            kind = item.get("type")
            if not isinstance(raw_path, str) or kind not in ("blob", "tree", "commit"):
                raise ValueError("GitHub Go recursive inventory contains a malformed entry")
            path = _canonical_repository_path(raw_path)
            if path != raw_path:
                raise ValueError("GitHub Go recursive inventory contains a non-canonical path")
            folded = path.casefold()
            previous = folded_paths.get(folded)
            if previous is not None:
                raise ValueError(
                    "GitHub Go recursive inventory contains colliding paths: "
                    f"{previous} and {path}"
                )
            folded_paths[folded] = path
            if kind == "commit":
                raise ValueError("GitHub Go recursive inventory contains an opaque submodule")
            inventory.append(path)
            entries_by_path[path] = item

        refusal = go_snapshot_path_refusal(inventory)
        if refusal is not None:
            raise ValueError(refusal)
        required_blob_shas: Dict[str, str] = {}
        for required in ("go.mod", "go.sum"):
            item = entries_by_path.get(required)
            blob_sha = item.get("sha") if isinstance(item, dict) else None
            if (
                item is None
                or item.get("type") != "blob"
                or item.get("mode") != "100644"
                or not isinstance(blob_sha, str)
                or len(blob_sha) not in (40, 64)
                or any(character not in "0123456789abcdef" for character in blob_sha)
            ):
                raise ValueError(
                    f"GitHub Go recursive inventory has no exact regular root {required} blob"
                )
            required_blob_shas[required] = blob_sha
        return required_blob_shas

    def snapshot(self, repository: str, branch: str, manifest: str, lockfile: str) -> DependencySnapshot:
        normal_manifest = _canonical_repository_path(manifest)
        normal_lockfile = _canonical_repository_path(lockfile)
        if normal_manifest == normal_lockfile and normal_manifest != "auto":
            raise ValueError("repository paths collide after canonicalization")
        commit = self._get(
            f"https://api.github.com/repos/{repository}/commits/{urllib.parse.quote(branch, safe='')}",
            self.token,
        )
        sha = commit.get("sha") if isinstance(commit, dict) else None
        if not isinstance(sha, str) or not sha: raise ValueError("GitHub did not return a commit SHA")
        files: Dict[str, str] = {}
        paths = [normal_manifest, normal_lockfile]
        requested_auto = "auto" in paths
        root_package_watch = normal_manifest == "package.json"
        root_cargo_watch = normal_manifest == "Cargo.toml" and normal_lockfile == "Cargo.lock"
        root_go_watch = normal_manifest == "go.mod" and normal_lockfile == "go.sum"
        cargo_inventory = root_cargo_watch
        go_inventory = root_go_watch
        go_root_blob_shas: Mapping[str, str] = {}
        if requested_auto or root_package_watch or root_cargo_watch or root_go_watch:
            listing = self._get(
                f"https://api.github.com/repos/{repository}/contents/?ref={urllib.parse.quote(sha, safe='')}",
                self.token,
            )
            if not isinstance(listing, list):
                raise ValueError("GitHub did not return a repository root listing")
            # GitHub's Contents API returns at most 1,000 directory entries.
            # Exactly 1,000 is therefore ambiguous: a competing manager marker
            # may have been truncated from the response.
            if len(listing) >= self._ROOT_INVENTORY_MAX_ENTRIES:
                raise ValueError("GitHub repository root listing exceeds the inventory limit")
            available = {
                str(item.get("path"))
                for item in listing
                if isinstance(item, dict) and item.get("type") == "file"
            }
            cargo_inventory = root_cargo_watch or (
                requested_auto and {"Cargo.toml", "Cargo.lock"}.issubset(available)
            )
            go_inventory = root_go_watch or (
                requested_auto and {"go.mod", "go.sum"}.issubset(available)
            )
            if cargo_inventory and any(
                isinstance(item, dict)
                and (item.get("path") == ".cargo" or str(item.get("path", "")).startswith(".cargo/"))
                for item in listing
            ):
                raise ValueError("Cargo watch refuses repository .cargo configuration until it is modeled")
            if go_inventory:
                go_root_blob_shas = self._verify_go_recursive_inventory(repository, commit)
            if requested_auto:
                paths = [path for path in self._AUTO_ROOT_FILES if path in available]
            elif root_cargo_watch:
                paths.extend(path for path in self._AUTO_ROOT_FILES if path in available)
            elif root_go_watch:
                paths.extend(path for path in self._AUTO_ROOT_FILES if path in available)
            else:
                # Explicit/legacy root package.json watches must see the same-SHA
                # competing manager markers. Fetching only the selected pair
                # would turn an incomplete snapshot into false npm/pnpm support.
                paths.extend(
                    path for path in self._NODE_ROOT_MARKERS if path in available
                )
        for path in dict.fromkeys(path for path in paths if path != "auto"):
            body = self._get(
                f"https://api.github.com/repos/{repository}/contents/{urllib.parse.quote(path, safe='/')}?ref={sha}",
                self.token,
            )
            content = body.get("content") if isinstance(body, dict) else None
            encoding = body.get("encoding") if isinstance(body, dict) else None
            if not isinstance(content, str) or encoding != "base64": raise ValueError(f"GitHub did not return {path}")
            normal_path = _canonical_repository_path(path)
            expected_go_blob_sha = go_root_blob_shas.get(normal_path)
            if expected_go_blob_sha is not None and (
                not isinstance(body, dict)
                or body.get("sha") != expected_go_blob_sha
            ):
                raise ValueError(
                    f"GitHub Go root {normal_path} body is not bound to its exact tree blob SHA"
                )
            cargo_byte_limit = (
                CARGO_MANIFEST_MAX_BYTES
                if cargo_inventory and normal_path == "Cargo.toml"
                else CARGO_LOCK_MAX_BYTES
                if cargo_inventory and normal_path == "Cargo.lock"
                else None
            )
            go_byte_limit = (
                GO_MOD_MAX_BYTES
                if go_inventory and normal_path == "go.mod"
                else GO_SUM_MAX_BYTES
                if go_inventory and normal_path == "go.sum"
                else None
            )
            byte_limit = cargo_byte_limit or go_byte_limit
            if byte_limit is not None:
                compact_limit, wrapped_limit = _cargo_base64_content_limits(byte_limit)
                compact_length = len(content) - content.count("\n")
                if len(content) > wrapped_limit or compact_length > compact_limit:
                    raise ValueError(f"{normal_path} base64 content exceeds the encoded-size limit")
            compact_content = content.replace("\n", "")
            try:
                decoded = base64.b64decode(
                    compact_content,
                    validate=go_inventory,
                ).decode("utf-8")
            except (binascii.Error, UnicodeDecodeError, ValueError) as exc:
                raise ValueError(f"GitHub returned malformed text content for {normal_path}") from exc
            files[normal_path] = decoded
        return DependencySnapshot(files=files, baseline_sha=sha)


def _legacy_candidate_payload(candidate: Any) -> Dict[str, Any]:
    """Keep the merged #1687 heartbeat producer vector byte-shape stable.

    Adapter profile custody is carried by the later evidence/execution
    identity.  Adding it to the persisted draft candidate would silently alter
    the live proposal contract.
    """

    return {
        "package": candidate.package,
        "dependency_kind": candidate.dependency_kind,
        "specifier": candidate.specifier,
        "current_version": candidate.current_version,
        "target_version": candidate.target_version,
        "manifest_path": candidate.manifest_path,
        "lockfile_path": candidate.lockfile_path,
        "baseline_sha": candidate.baseline_sha,
        "fingerprint": candidate.fingerprint,
        "ecosystem": candidate.ecosystem,
        "package_manager": candidate.package_manager,
        "package_manager_version": candidate.package_manager_version,
        "verification_commands": candidate.verification_commands,
        "manager_commands": dict(candidate.manager_commands),
    }


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
        candidates = [_legacy_candidate_payload(candidate) for candidate in observation.candidates]
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


def _github_get(url: str, token: str) -> Any:
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "User-Agent": "agentrail-heartbeat"})
    with urllib.request.urlopen(request, timeout=8) as response:
        return json.load(response)


def _registry_get(url: str, manager_id: str) -> Any:
    """Fetch one registry response without forwarding GitHub credentials.

    The response is bounded before UTF-8 decoding or JSON parsing. A missing
    Content-Length is allowed for chunked responses, but the streamed N+1 read
    still refuses a body beyond the fixed cap.
    """

    response_limit = (
        GO_PROXY_LIST_MAX_BYTES
        if manager_id == "go-modules"
        else _REGISTRY_MAX_RESPONSE_BYTES
    )
    accept = (
        _NPM_ABBREVIATED_ACCEPT
        if manager_id in ("npm", "pnpm")
        else "text/plain" if manager_id == "go-modules" else "application/json"
    )
    request = urllib.request.Request(
        url,
        headers={"Accept": accept, "User-Agent": "agentrail-heartbeat"},
    )
    open_request = (
        _open_go_proxy_request
        if manager_id == "go-modules"
        else urllib.request.urlopen
    )
    with open_request(request, timeout=8) as response:
        if manager_id == "go-modules":
            final_url = response.geturl() if hasattr(response, "geturl") else None
            if final_url != url:
                raise ValueError("Go proxy response URL does not match the canonical request")
        headers = getattr(response, "headers", None)
        raw_length = headers.get("Content-Length") if headers is not None else None
        declared_length: Optional[int] = None
        if raw_length is not None:
            try:
                declared_length = int(raw_length)
            except (TypeError, ValueError) as exc:
                raise ValueError("registry response has an invalid Content-Length") from exc
            if declared_length < 0 or declared_length > response_limit:
                raise ValueError("registry response exceeds the byte limit")

        chunks: List[bytes] = []
        total = 0
        while True:
            remaining = response_limit + 1 - total
            chunk = response.read(min(_REGISTRY_READ_CHUNK_BYTES, remaining))
            if not chunk:
                break
            if not isinstance(chunk, bytes):
                raise ValueError("registry response body is not bytes")
            chunks.append(chunk)
            total += len(chunk)
            if total > response_limit:
                raise ValueError("registry response exceeds the byte limit")
        if declared_length is not None and total != declared_length:
            raise ValueError("registry response Content-Length does not match its body")

    try:
        text = b"".join(chunks).decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("registry response is not valid UTF-8") from exc
    if manager_id == "go-modules":
        return text
    return loads_strict_json(text, document="registry response")


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
            provider = self.snapshot_provider or GithubSnapshotProvider(token, _github_get)
            snapshot = provider.snapshot(str(row["repository_name"]), str(row.get("default_branch") or "main"), str(row["manifest_path"]), str(row["lockfile_path"]))
            detected = detect_dependency_manager(snapshot.files)
            manager_id = (
                detected.manager_id.value
                if isinstance(detected, SupportedDetection)
                else None
            )
            registry = self.registry or RegistryClient(
                lambda url: _registry_get(url, manager_id or ""),
                manager_id,
            )
            watch = DependencyWatchState(
                workspace_id=self.workspace_id,
                repository_id=str(row["repository_id"]),
                selected_manifest=_canonical_repository_path(str(row["manifest_path"])),
                selected_lockfile=_canonical_repository_path(str(row["lockfile_path"])),
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
