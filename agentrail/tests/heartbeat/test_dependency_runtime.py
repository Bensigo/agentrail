import base64
import json
from datetime import datetime

import pytest

from agentrail.heartbeat.dependency_runtime import DependencyWatchRuntime, RegistryClient
from agentrail.heartbeat import dependency_runtime


FILES = {
    "package.json": '{"dependencies":{"react":"^1.0.0"}}',
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      react:\n        specifier: ^1.0.0\n        version: 1.0.0\n",
}


class Executor:
    def __init__(self):
        self.executed = []

    def query(self, op, params):
        assert op == "claim_dependency_watches"
        return [{
            "id": "watch-1", "workspace_id": "ws-1", "repository_id": "repo-1",
            "repository_name": "ada/widgets", "default_branch": "main",
            "manifest_path": "package.json", "lockfile_path": "pnpm-lock.yaml",
            "selected_dependencies": ["react"], "selected_file_hashes": {},
            "cadence_seconds": 3600, "last_trigger": "manual",
        }]

    def execute(self, op, params):
        self.executed.append((op, params))


class Snapshot:
    def snapshot(self, *args):
        from agentrail.dependencies.pnpm import DependencySnapshot
        return DependencySnapshot(FILES, "sha-1")


class Registry:
    def package_metadata(self, package):
        from agentrail.dependencies.pnpm import RegistryPackage
        return RegistryPackage(("1.0.0", "1.1.0"))


class ProposalPublisher:
    def __init__(self):
        self.calls = []

    def publish(self, **kwargs):
        self.calls.append(kwargs)


def _json_default(value):
    """Encode the runtime's intentional timestamp without hiding other errors."""
    if isinstance(value, datetime):
        return value.isoformat()
    raise TypeError(f"unsupported JSON value: {type(value).__name__}")


def test_manual_watch_is_claimed_detected_and_persisted_without_queue_work():
    executor = Executor()
    publisher = ProposalPublisher()
    runtime = DependencyWatchRuntime(
        workspace_id="ws-1", executor=executor,
        snapshot_provider=Snapshot(), registry=Registry(),
        token_provider=lambda workspace_id, executor: "token",
        proposal_publisher=publisher,
    )
    result = runtime.run_once()
    assert result["claimed"] == 1
    assert result["candidates"] == 1
    assert len(executor.executed) == 1
    op, params = executor.executed[0]
    assert op == "record_dependency_watch_observation"
    assert params["status"] == "candidates"
    assert "queue" not in json.dumps(params, default=_json_default)
    assert result["proposal_errors"] == 0
    assert len(publisher.calls) == 1
    assert publisher.calls[0]["workspace_id"] == "ws-1"
    assert publisher.calls[0]["watch_id"] == "watch-1"
    assert publisher.calls[0]["candidate"].fingerprint
    assert executor.executed[0][1]["candidate_fingerprint"] == publisher.calls[0]["candidate"].fingerprint
    assert executor.executed[0][1]["candidate_fingerprint"] != executor.executed[0][1]["observation_key"]
    persisted = json.loads(executor.executed[0][1]["candidates"])
    assert persisted == [{
        "baseline_sha": "sha-1",
        "current_version": "1.0.0",
        "dependency_kind": "dependencies",
        "ecosystem": "node",
        "fingerprint": "sha256:44e0fa61c852f481d693e10cd724a68c2a25c0c37449ae3ba07b514aab2fb0cb",
        "lockfile_path": "pnpm-lock.yaml",
        "manager_commands": {
            "install": "pnpm install --frozen-lockfile",
            "update": "pnpm update --lockfile-only --ignore-scripts react@1.1.0",
            "version": "pnpm --version",
        },
        "manifest_path": "package.json",
        "package": "react",
        "package_manager": "pnpm",
        "package_manager_version": None,
        "specifier": "^1.0.0",
        "target_version": "1.1.0",
        "verification_commands": ["pnpm install --frozen-lockfile", "pnpm test"],
    }]
    assert "adapter_profile" not in persisted[0]
    assert "adapter_identity_fingerprint" not in persisted[0]


def test_npm_heartbeat_preserves_exact_legacy_candidate_payload_for_draft_custody():
    class NpmExecutor(Executor):
        def query(self, op, params):
            assert op == "claim_dependency_watches"
            return [{
                "id": "watch-npm", "workspace_id": "ws-1", "repository_id": "repo-1",
                "repository_name": "ada/widgets", "default_branch": "main",
                "manifest_path": "package.json", "lockfile_path": "package-lock.json",
                "selected_dependencies": ["lodash"], "selected_file_hashes": {},
                "cadence_seconds": 3600, "last_trigger": "manual",
            }]

    class NpmSnapshot:
        def snapshot(self, *args):
            from agentrail.dependencies.pnpm import DependencySnapshot

            return DependencySnapshot(
                {
                    "package.json": json.dumps({
                        "packageManager": "npm@10.8.2",
                        "scripts": {"test": "node --test"},
                        "dependencies": {"lodash": "^4.17.21"},
                    }),
                    "package-lock.json": json.dumps({
                        "lockfileVersion": 3,
                        "packages": {
                            "": {"dependencies": {"lodash": "^4.17.21"}},
                            "node_modules/lodash": {
                                "version": "4.17.21",
                                "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
                                "integrity": "sha512-" + base64.b64encode(b"f" * 64).decode("ascii"),
                            },
                        },
                    }),
                },
                "sha-npm-legacy",
            )

    class NpmRegistry:
        def package_metadata(self, package):
            from agentrail.dependencies.pnpm import RegistryPackage

            assert package == "lodash"
            return RegistryPackage(("4.17.21", "4.17.22"))

    executor = NpmExecutor()
    publisher = ProposalPublisher()
    runtime = DependencyWatchRuntime(
        workspace_id="ws-1",
        executor=executor,
        snapshot_provider=NpmSnapshot(),
        registry=NpmRegistry(),
        token_provider=lambda workspace_id, executor: "token",
        proposal_publisher=publisher,
    )

    result = runtime.run_once()

    expected = {
        "package": "lodash",
        "dependency_kind": "dependencies",
        "specifier": "^4.17.21",
        "current_version": "4.17.21",
        "target_version": "4.17.22",
        "manifest_path": "package.json",
        "lockfile_path": "package-lock.json",
        "baseline_sha": "sha-npm-legacy",
        "fingerprint": "sha256:64a74e4d239e31e70d34b6678f1af6e4cae1740af4fa9ce1dc240969cc7583fe",
        "ecosystem": "node",
        "package_manager": "npm",
        "package_manager_version": None,
        "verification_commands": ["npm test"],
        "manager_commands": {
            "version": "npm --version",
            "install": "npm ci --ignore-scripts",
            "update": "npm install lodash@4.17.22 --package-lock-only --ignore-scripts --no-audit --save-prod",
        },
    }
    persisted = json.loads(executor.executed[0][1]["candidates"])

    assert result["candidates"] == 1
    assert persisted == [expected]
    assert len(persisted[0]) == 14
    assert "adapter_profile" not in persisted[0]
    assert "adapter_identity_fingerprint" not in persisted[0]
    assert len(publisher.calls) == 1
    published = publisher.calls[0]["candidate"]
    assert published.fingerprint == expected["fingerprint"]
    assert published.adapter_profile == "npm_package_lock_only_v1"
    assert json.loads(json.dumps(
        dependency_runtime._legacy_candidate_payload(published)
    )) == expected


def test_explicit_npm_watch_inventories_alternate_lock_and_never_proposes(
    monkeypatch,
):
    class ExplicitNpmExecutor(Executor):
        def query(self, op, params):
            assert op == "claim_dependency_watches"
            return [{
                "id": "watch-npm", "workspace_id": "ws-1", "repository_id": "repo-1",
                "repository_name": "ada/widgets", "default_branch": "main",
                "manifest_path": "package.json", "lockfile_path": "package-lock.json",
                "selected_dependencies": ["lodash"], "selected_file_hashes": {},
                "cadence_seconds": 3600, "last_trigger": "manual",
            }]

    package_json = json.dumps({
        "packageManager": "npm@10.8.2",
        "scripts": {"test": "node --test"},
        "dependencies": {"lodash": "^4.17.21"},
    })
    package_lock = json.dumps({
        "lockfileVersion": 3,
        "packages": {
            "": {"dependencies": {"lodash": "^4.17.21"}},
            "node_modules/lodash": {"version": "4.17.21"},
        },
    })
    root_files = {
        "package.json": package_json,
        "package-lock.json": package_lock,
        "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    }
    calls = []

    def github_get(url, token):
        calls.append(url)
        if "/commits/" in url:
            return {"sha": "sha-npm"}
        if "/contents/?ref=" in url:
            return [
                {"path": path, "type": "file"}
                for path in root_files
            ]
        for path, content in root_files.items():
            if f"/contents/{path}?ref=" in url:
                return {
                    "encoding": "base64",
                    "content": base64.b64encode(content.encode()).decode(),
                }
        raise AssertionError(f"unexpected GitHub URL: {url}")

    class TrackingRegistry:
        def __init__(self):
            self.calls = []

        def package_metadata(self, package):
            self.calls.append(package)
            raise AssertionError("conflicting Node snapshot reached registry")

    monkeypatch.setattr(dependency_runtime, "_github_get", github_get)
    executor = ExplicitNpmExecutor()
    registry = TrackingRegistry()
    publisher = ProposalPublisher()
    runtime = DependencyWatchRuntime(
        workspace_id="ws-1",
        executor=executor,
        registry=registry,
        token_provider=lambda workspace_id, executor: "github-token",
        proposal_publisher=publisher,
    )

    result = runtime.run_once()

    assert result["claimed"] == 1
    assert result["failed"] == 1
    assert result["candidates"] == 0
    assert registry.calls == []
    assert publisher.calls == []
    assert any("/contents/?ref=sha-npm" in url for url in calls)
    assert any("/contents/pnpm-lock.yaml?ref=sha-npm" in url for url in calls)
    _, persisted = executor.executed[0]
    assert persisted["status"] == "failed"
    assert persisted["error_code"] == "unsupported"
    assert "conflicting lockfile pnpm-lock.yaml" in persisted["error_message"]


def test_root_inventory_at_github_contents_limit_refuses_as_incomplete():
    calls = []

    def github_get(url, token):
        calls.append(url)
        if "/commits/" in url:
            return {"sha": "sha-limit"}
        if "/contents/?ref=" in url:
            return [
                {"path": f"file-{index}", "type": "file"}
                for index in range(1_000)
            ]
        raise AssertionError(f"inventory limit reached content fetch: {url}")

    provider = dependency_runtime.GithubSnapshotProvider("token", github_get)

    with pytest.raises(ValueError, match="inventory limit"):
        provider.snapshot(
            "ada/widgets",
            "main",
            "package.json",
            "package-lock.json",
        )

    assert len(calls) == 2


def test_sql_observation_persists_candidate_fingerprint_separately_from_observation_key():
    sql = dependency_runtime.queue_store._SQL[dependency_runtime.RECORD_WATCH_OBSERVATION_OP]
    assert "candidate_fingerprint" in sql.split("VALUES", 1)[0]
    assert "%(candidate_fingerprint)s" in sql


def test_registry_client_never_falls_back_to_npm_without_a_supported_manager():
    calls = []
    client = RegistryClient(lambda url: calls.append(url) or {}, manager_id=None)

    assert client.package_metadata("lodash") is None
    assert calls == []


class RegistryResponse:
    def __init__(self, body: bytes, *, content_length: str | None) -> None:
        self.body = body
        self.offset = 0
        self.headers = {}
        if content_length is not None:
            self.headers["Content-Length"] = content_length
        self.read_calls = 0

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self, size: int) -> bytes:
        self.read_calls += 1
        chunk = self.body[self.offset : self.offset + size]
        self.offset += len(chunk)
        return chunk


def test_npm_registry_transport_has_public_bounded_headers(monkeypatch):
    body = b'{"versions":{"1.0.0":{},"1.1.0":{}}}'
    response = RegistryResponse(body, content_length=str(len(body)))
    captured = {}

    def open_request(request, timeout):
        captured["request"] = request
        captured["timeout"] = timeout
        return response

    monkeypatch.setattr(dependency_runtime.urllib.request, "urlopen", open_request)
    client = RegistryClient(
        lambda url: dependency_runtime._registry_get(url, "npm"), manager_id="npm"
    )

    metadata = client.package_metadata("lodash")

    assert metadata is not None
    assert metadata.available_versions == ("1.0.0", "1.1.0")
    request = captured["request"]
    assert request.get_header("Authorization") is None
    assert request.get_header("Accept") == "application/vnd.npm.install-v1+json"
    assert request.get_header("Accept") != "application/vnd.github+json"
    assert captured["timeout"] == 8


@pytest.mark.parametrize("overflow", ("declared", "chunked"))
def test_registry_transport_oversize_is_insufficient_evidence(
    monkeypatch, overflow: str
):
    monkeypatch.setattr(dependency_runtime, "_REGISTRY_MAX_RESPONSE_BYTES", 32)
    monkeypatch.setattr(dependency_runtime, "_REGISTRY_READ_CHUNK_BYTES", 8)
    if overflow == "declared":
        response = RegistryResponse(b"", content_length="33")
    else:
        response = RegistryResponse(b"x" * 33, content_length=None)
    monkeypatch.setattr(
        dependency_runtime.urllib.request,
        "urlopen",
        lambda request, timeout: response,
    )
    client = RegistryClient(
        lambda url: dependency_runtime._registry_get(url, "npm"), manager_id="npm"
    )

    assert client.package_metadata("lodash") is None
    if overflow == "declared":
        assert response.read_calls == 0
    else:
        assert response.read_calls > 1


def test_registry_transport_malformed_json_is_insufficient_evidence(monkeypatch):
    response = RegistryResponse(b'{"versions":', content_length="12")
    monkeypatch.setattr(
        dependency_runtime.urllib.request,
        "urlopen",
        lambda request, timeout: response,
    )
    client = RegistryClient(
        lambda url: dependency_runtime._registry_get(url, "npm"), manager_id="npm"
    )

    assert client.package_metadata("lodash") is None
