import base64
import json
import urllib.error
import urllib.response
from datetime import datetime
from email.message import Message
from io import BytesIO

import pytest

from agentrail.dependencies.pnpm import DependencySnapshot
from agentrail.dependencies.source_inventory import (
    DependencySourceInventoryReceipt,
    git_blob_object_id,
)
from agentrail.heartbeat.dependency_watch import WatchObservation, WatchTrigger
from agentrail.heartbeat.dependency_runtime import DependencyWatchRuntime, RegistryClient
from agentrail.heartbeat import dependency_runtime


FILES = {
    "package.json": '{"dependencies":{"react":"^1.0.0"}}',
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      react:\n        specifier: ^1.0.0\n        version: 1.0.0\n",
}
GO_ROOT_BLOB_SHAS = {"go.mod": "c" * 40, "go.sum": "d" * 40}


def _go_root_tree_entries(root_files=None):
    blob_shas = GO_ROOT_BLOB_SHAS if root_files is None else {
        path: git_blob_object_id(content.encode("utf-8"), hash_hex_length=40)
        for path, content in root_files.items()
    }
    return [
        {
            "path": path,
            "type": "blob",
            "mode": "100644",
            "sha": blob_sha,
        }
        for path, blob_sha in blob_shas.items()
    ]


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
    assert params["source_inventory_receipt"] is None
    assert params["source_inventory_receipt_sha256"] is None
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


def test_explicit_cargo_snapshot_forces_root_inventory_before_file_reads():
    root_files = {"Cargo.toml": "[package]\nname='demo'\nversion='0.1.0'\n", "Cargo.lock": "version = 3\n"}
    calls = []

    def github_get(url, token):
        calls.append(url)
        if "/commits/" in url:
            return {"sha": "sha-cargo"}
        if "/contents/?ref=" in url:
            return [{"path": path, "type": "file"} for path in root_files]
        for path, content in root_files.items():
            if f"/contents/{path}?ref=" in url:
                return {"encoding": "base64", "content": base64.b64encode(content.encode()).decode()}
        raise AssertionError(f"unexpected GitHub URL: {url}")

    snapshot = dependency_runtime.GithubSnapshotProvider("token", github_get).snapshot(
        "ada/widgets", "main", "Cargo.toml", "Cargo.lock",
    )

    assert snapshot.files == root_files
    assert any("/contents/?ref=sha-cargo" in url for url in calls)
    assert calls.index(next(url for url in calls if "/contents/?ref=" in url)) < calls.index(
        next(url for url in calls if "/contents/Cargo.toml?ref=" in url)
    )


@pytest.mark.parametrize(
    "entry",
    ({"path": ".cargo", "type": "dir"}, {"path": ".cargo/config.toml", "type": "file"}),
)
def test_explicit_cargo_snapshot_refuses_repository_cargo_configuration(entry):
    calls = []

    def github_get(url, token):
        calls.append(url)
        if "/commits/" in url:
            return {"sha": "sha-cargo-config"}
        if "/contents/?ref=" in url:
            return [
                {"path": "Cargo.toml", "type": "file"},
                {"path": "Cargo.lock", "type": "file"},
                entry,
            ]
        raise AssertionError(f"Cargo config refusal reached content fetch: {url}")

    provider = dependency_runtime.GithubSnapshotProvider("token", github_get)
    with pytest.raises(ValueError, match="Cargo watch refuses repository .cargo configuration"):
        provider.snapshot("ada/widgets", "main", "Cargo.toml", "Cargo.lock")

    assert len(calls) == 2


@pytest.mark.parametrize(
    ("manifest", "lockfile"),
    (
        ("././Cargo.toml", "././Cargo.lock"),
        (".\\.\\Cargo.toml", ".\\.\\Cargo.lock"),
    ),
)
def test_redundant_cargo_locator_prefixes_cannot_skip_dot_cargo_inventory(
    manifest: str, lockfile: str,
) -> None:
    calls = []

    def github_get(url, token):
        calls.append(url)
        if "/commits/" in url:
            return {"sha": "sha-cargo-redundant-prefix"}
        if "/contents/?ref=" in url:
            return [
                {"path": "Cargo.toml", "type": "file"},
                {"path": "Cargo.lock", "type": "file"},
                {"path": ".cargo", "type": "dir"},
            ]
        raise AssertionError(f"Cargo config refusal reached content fetch: {url}")

    provider = dependency_runtime.GithubSnapshotProvider("token", github_get)

    with pytest.raises(ValueError, match="Cargo watch refuses repository .cargo configuration"):
        provider.snapshot("ada/widgets", "main", manifest, lockfile)

    assert len(calls) == 2
    assert "/contents/?ref=sha-cargo-redundant-prefix" in calls[1]


@pytest.mark.parametrize(
    ("manifest", "lockfile"),
    (
        ("/Cargo.toml", "Cargo.lock"),
        ("C:\\Cargo.toml", "Cargo.lock"),
        ("../Cargo.toml", "Cargo.lock"),
        ("Cargo.toml", "./Cargo.toml"),
    ),
)
def test_snapshot_provider_rejects_unsafe_or_colliding_locator_paths_before_network(
    manifest: str, lockfile: str,
) -> None:
    calls = []
    provider = dependency_runtime.GithubSnapshotProvider(
        "token", lambda url, token: calls.append(url),
    )

    with pytest.raises(ValueError, match="repository (?:path|paths)"):
        provider.snapshot("ada/widgets", "main", manifest, lockfile)

    assert calls == []


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


def test_explicit_go_snapshot_binds_complete_recursive_exact_tree_before_file_reads():
    tree_sha = "b" * 40
    go_mod = "module example.com/root\n\ngo 1.26\n\nrequire github.com/acme/lib v1.2.3\n"
    checksum = "h1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    go_sum = (
        f"github.com/acme/lib v1.2.3 {checksum}\n"
        f"github.com/acme/lib v1.2.3/go.mod {checksum}\n"
    )
    root_files = {"go.mod": go_mod, "go.sum": go_sum}
    root_blob_shas = {
        path: git_blob_object_id(content.encode("utf-8"), hash_hex_length=40)
        for path, content in root_files.items()
    }
    calls = []

    def github_get(url, token):
        calls.append(url)
        if "/commits/" in url:
            return {"sha": "a" * 40, "commit": {"tree": {"sha": tree_sha}}}
        if "/contents/?ref=" in url:
            return [{"path": path, "type": "file"} for path in root_files]
        if f"/git/trees/{tree_sha}?recursive=1" in url:
            return {
                "sha": tree_sha,
                "truncated": False,
                "tree": _go_root_tree_entries(root_files),
            }
        for path, content in root_files.items():
            if f"/git/blobs/{root_blob_shas[path]}" in url:
                return {
                    "encoding": "base64",
                    "content": base64.b64encode(content.encode()).decode(),
                    "sha": root_blob_shas[path],
                }
        raise AssertionError(f"unexpected GitHub URL: {url}")

    snapshot = dependency_runtime.GithubSnapshotProvider("token", github_get).snapshot(
        "ada/widgets", "main", "go.mod", "go.sum",
    )

    assert snapshot.files == root_files
    assert snapshot.source_inventory_receipt is not None
    receipt = snapshot.source_inventory_receipt.as_dict()
    assert receipt["identity"]["profile"] == "go_github_exact_tree_source_inventory_v1"
    assert receipt["authority"]["repository"] == "ada/widgets"
    assert receipt["authority"]["commitSha"] == "a" * 40
    assert receipt["authority"]["rootTreeSha"] == tree_sha
    assert receipt["identitySha256"] == snapshot.source_inventory_receipt.identity_sha256
    tree_call = next(url for url in calls if "/git/trees/" in url)
    mod_call = next(url for url in calls if f"/git/blobs/{root_blob_shas['go.mod']}" in url)
    assert calls.index(tree_call) < calls.index(mod_call)
    assert tree_call.endswith(f"/git/trees/{tree_sha}?recursive=1")


@pytest.mark.parametrize("body_sha", (None, "e" * 40))
def test_go_snapshot_refuses_missing_or_mismatched_git_blob_sha(body_sha) -> None:
    tree_sha = "b" * 40
    calls = []

    def github_get(url, token):
        calls.append(url)
        if "/commits/" in url:
            return {"sha": "a" * 40, "commit": {"tree": {"sha": tree_sha}}}
        if "/contents/?ref=" in url:
            return [
                {"path": "go.mod", "type": "file"},
                {"path": "go.sum", "type": "file"},
            ]
        if "/git/trees/" in url:
            return {
                "sha": tree_sha,
                "truncated": False,
                "tree": _go_root_tree_entries(),
            }
        if f"/git/blobs/{GO_ROOT_BLOB_SHAS['go.mod']}" in url:
            body = {
                "encoding": "base64",
                "content": base64.b64encode(b"not decoded").decode(),
            }
            if body_sha is not None:
                body["sha"] = body_sha
            return body
        raise AssertionError(url)

    provider = dependency_runtime.GithubSnapshotProvider("token", github_get)
    with pytest.raises(ValueError, match="exact tree blob SHA"):
        provider.snapshot("ada/widgets", "main", "go.mod", "go.sum")

    assert not any(
        f"/git/blobs/{GO_ROOT_BLOB_SHAS['go.sum']}" in url for url in calls
    )


@pytest.mark.parametrize(
    ("tree_mutation", "reason"),
    (
        ({"truncated": True}, "truncated"),
        ({"sha": "c" * 40}, "exact root tree SHA"),
        (
            {
                "tree": [
                    *_go_root_tree_entries(),
                    {"path": "go.work", "type": "blob", "mode": "100644", "sha": "e" * 40},
                ]
            },
            "go.work",
        ),
        (
            {
                "tree": [
                    *_go_root_tree_entries(),
                    {"path": "tools/go.mod", "type": "blob", "mode": "100644", "sha": "e" * 40},
                ]
            },
            "nested",
        ),
        (
            {
                "tree": [
                    *_go_root_tree_entries(),
                    {"path": ".config/go/env", "type": "blob", "mode": "100644", "sha": "e" * 40},
                ]
            },
            "configuration",
        ),
        (
            {
                "tree": [
                    *_go_root_tree_entries(),
                    {"path": "vendor", "type": "tree", "mode": "040000", "sha": "e" * 40},
                ]
            },
            "vendored",
        ),
        (
            {
                "tree": [
                    *_go_root_tree_entries(),
                    {"path": "opaque", "type": "commit", "mode": "160000"},
                ]
            },
            "opaque submodule",
        ),
    ),
)
def test_go_recursive_inventory_refuses_incomplete_or_unmodelled_state(
    tree_mutation, reason,
) -> None:
    tree_sha = "b" * 40
    calls = []
    tree = {
        "sha": tree_sha,
        "truncated": False,
        "tree": _go_root_tree_entries(),
    }
    tree.update(tree_mutation)

    def github_get(url, token):
        calls.append(url)
        if "/commits/" in url:
            return {"sha": "a" * 40, "commit": {"tree": {"sha": tree_sha}}}
        if "/contents/?ref=" in url:
            return [
                {"path": "go.mod", "type": "file"},
                {"path": "go.sum", "type": "file"},
            ]
        if "/git/trees/" in url:
            return tree
        raise AssertionError(f"Go inventory refusal reached file fetch: {url}")

    provider = dependency_runtime.GithubSnapshotProvider("token", github_get)
    with pytest.raises(ValueError, match=reason):
        provider.snapshot("ada/widgets", "main", "go.mod", "go.sum")

    assert not any(
        f"/git/blobs/{GO_ROOT_BLOB_SHAS['go.mod']}" in url for url in calls
    )


def test_go_recursive_inventory_requires_commit_tree_identity() -> None:
    calls = []

    def github_get(url, token):
        calls.append(url)
        if "/commits/" in url:
            return {"sha": "a" * 40}
        if "/contents/?ref=" in url:
            return [
                {"path": "go.mod", "type": "file"},
                {"path": "go.sum", "type": "file"},
            ]
        raise AssertionError(f"missing tree identity reached another request: {url}")

    provider = dependency_runtime.GithubSnapshotProvider("token", github_get)
    with pytest.raises(ValueError, match="exact Go root tree SHA"):
        provider.snapshot("ada/widgets", "main", "go.mod", "go.sum")

    assert len(calls) == 2


def test_go_recursive_inventory_requires_canonical_exact_commit_sha() -> None:
    calls = []

    def github_get(url, token):
        calls.append(url)
        if "/commits/" in url:
            return {
                "sha": "branch-shaped-not-a-sha",
                "commit": {"tree": {"sha": "b" * 40}},
            }
        if "/contents/?ref=" in url:
            return [
                {"path": "go.mod", "type": "file"},
                {"path": "go.sum", "type": "file"},
            ]
        raise AssertionError(url)

    provider = dependency_runtime.GithubSnapshotProvider("token", github_get)
    with pytest.raises(ValueError, match="exact Go commit SHA"):
        provider.snapshot("ada/widgets", "main", "go.mod", "go.sum")

    assert len(calls) == 2


def test_go_recursive_inventory_entry_cap_fails_closed(monkeypatch) -> None:
    tree_sha = "b" * 40
    monkeypatch.setattr(dependency_runtime, "GO_GITHUB_TREE_MAX_ENTRIES", 2)

    def github_get(url, token):
        if "/commits/" in url:
            return {"sha": "a" * 40, "commit": {"tree": {"sha": tree_sha}}}
        if "/contents/?ref=" in url:
            return [
                {"path": "go.mod", "type": "file"},
                {"path": "go.sum", "type": "file"},
            ]
        if "/git/trees/" in url:
            return {
                "sha": tree_sha,
                "truncated": False,
                "tree": _go_root_tree_entries(),
            }
        raise AssertionError(url)

    provider = dependency_runtime.GithubSnapshotProvider("token", github_get)
    with pytest.raises(ValueError, match="entry limit"):
        provider.snapshot("ada/widgets", "main", "go.mod", "go.sum")


@pytest.mark.parametrize(
    ("oversized_path", "cap_name"),
    (("go.mod", "GO_MOD_MAX_BYTES"), ("go.sum", "GO_SUM_MAX_BYTES")),
)
def test_go_snapshot_rejects_oversized_encoded_content_before_decode(
    monkeypatch, oversized_path: str, cap_name: str,
) -> None:
    tree_sha = "b" * 40
    real_decode = base64.b64decode
    small_content = base64.b64encode(b"x").decode()
    oversized_content = "A" * 128
    decoded_payloads = []
    blob_shas = {
        path: (
            GO_ROOT_BLOB_SHAS[path]
            if path == oversized_path
            else git_blob_object_id(b"x", hash_hex_length=40)
        )
        for path in ("go.mod", "go.sum")
    }
    monkeypatch.setattr(dependency_runtime, cap_name, 1)

    def github_get(url, token):
        if "/commits/" in url:
            return {"sha": "a" * 40, "commit": {"tree": {"sha": tree_sha}}}
        if "/contents/?ref=" in url:
            return [
                {"path": "go.mod", "type": "file"},
                {"path": "go.sum", "type": "file"},
            ]
        if "/git/trees/" in url:
            return {
                "sha": tree_sha,
                "truncated": False,
                "tree": [
                    {"path": path, "type": "blob", "mode": "100644", "sha": blob_shas[path]}
                    for path in ("go.mod", "go.sum")
                ],
            }
        for path in ("go.mod", "go.sum"):
            if f"/git/blobs/{blob_shas[path]}" in url:
                return {
                    "encoding": "base64",
                    "content": oversized_content if path == oversized_path else small_content,
                    "sha": blob_shas[path],
                }
        raise AssertionError(url)

    def track_decode(value, *args, **kwargs):
        decoded_payloads.append(value)
        if value == oversized_content:
            raise AssertionError("oversized Go content reached base64 decoding")
        return real_decode(value, *args, **kwargs)

    monkeypatch.setattr(dependency_runtime.base64, "b64decode", track_decode)
    provider = dependency_runtime.GithubSnapshotProvider("token", github_get)

    with pytest.raises(
        ValueError,
        match=f"{oversized_path} base64 content exceeds the encoded-size limit",
    ):
        provider.snapshot("ada/widgets", "main", "go.mod", "go.sum")

    assert oversized_content not in decoded_payloads


def test_go_snapshot_rejects_malformed_base64_content() -> None:
    tree_sha = "b" * 40

    def github_get(url, token):
        if "/commits/" in url:
            return {"sha": "a" * 40, "commit": {"tree": {"sha": tree_sha}}}
        if "/contents/?ref=" in url:
            return [
                {"path": "go.mod", "type": "file"},
                {"path": "go.sum", "type": "file"},
            ]
        if "/git/trees/" in url:
            return {
                "sha": tree_sha,
                "truncated": False,
                "tree": _go_root_tree_entries(),
            }
        if f"/git/blobs/{GO_ROOT_BLOB_SHAS['go.mod']}" in url:
            return {
                "encoding": "base64",
                "content": "%%%",
                "sha": GO_ROOT_BLOB_SHAS["go.mod"],
            }
        raise AssertionError(url)

    provider = dependency_runtime.GithubSnapshotProvider("token", github_get)
    with pytest.raises(ValueError, match="malformed text content for go.mod"):
        provider.snapshot("ada/widgets", "main", "go.mod", "go.sum")


def test_sql_observation_persists_candidate_fingerprint_separately_from_observation_key():
    sql = dependency_runtime.queue_store._SQL[dependency_runtime.RECORD_WATCH_OBSERVATION_OP]
    assert "candidate_fingerprint" in sql.split("VALUES", 1)[0]
    assert "%(candidate_fingerprint)s" in sql
    assert "source_inventory_receipt" in sql.split("VALUES", 1)[0]
    assert "source_inventory_receipt_sha256" in sql.split("VALUES", 1)[0]


def test_sql_observation_persists_source_receipt_without_mutating_candidate_shape():
    executor = Executor()
    identity_sha256 = "e" * 64
    receipt = DependencySourceInventoryReceipt(
        '{"identitySha256":"' + identity_sha256 + '"}',
        identity_sha256,
    )
    store = dependency_runtime.SqlWatchStore(
        executor,
        {"id": "watch-1", "repository_id": "repo-1"},
    )

    store.record_observation(
        watch_id="watch-1",
        workspace_id="ws-1",
        observation=WatchObservation(
            trigger=WatchTrigger.MANUAL,
            status="unchanged",
            observation_key=f"unchanged:source:{identity_sha256}",
        ),
        snapshot=DependencySnapshot(
            {},
            "a" * 40,
            source_inventory_receipt=receipt,
        ),
        selected_file_hashes={},
        observed_at=datetime(2026, 8, 12),
    )

    _, params = executor.executed[0]
    assert json.loads(params["source_inventory_receipt"]) == {
        "identitySha256": identity_sha256,
    }
    assert params["source_inventory_receipt_sha256"] == identity_sha256
    assert json.loads(params["candidates"]) == []


def test_runtime_failure_insert_passes_explicit_null_source_receipt_params():
    executor = Executor()
    runtime = DependencyWatchRuntime(
        workspace_id="ws-1",
        executor=executor,
        token_provider=lambda workspace_id, reader: None,
    )

    result = runtime.run_once()

    assert result["failed"] == 1
    _, params = executor.executed[0]
    assert params["source_inventory_receipt"] is None
    assert params["source_inventory_receipt_sha256"] is None


def test_registry_client_never_falls_back_to_npm_without_a_supported_manager():
    calls = []
    client = RegistryClient(lambda url: calls.append(url) or {}, manager_id=None)

    assert client.package_metadata("lodash") is None
    assert calls == []


def test_cargo_registry_client_preserves_yanked_versions_for_the_profile() -> None:
    client = RegistryClient(
        lambda url: {
            "crate": {"id": "serde"},
            "versions": [
                {"num": "1.0.203", "yanked": False},
                {"num": "1.0.204", "yanked": True},
            ],
        },
        manager_id="cargo",
    )

    metadata = client.package_metadata("serde")

    assert metadata is not None
    assert metadata.available_versions == ("1.0.203", "1.0.204")
    assert metadata.yanked_versions == ("1.0.204",)


def test_go_registry_client_uses_exact_public_proxy_path_and_strict_rows() -> None:
    calls = []
    client = RegistryClient(
        lambda url: calls.append(url) or "v1.2.3\nv1.3.0\n",
        manager_id="go-modules",
    )

    metadata = client.package_metadata("github.com/acme/lib")

    assert metadata is not None
    assert metadata.available_versions == ("v1.2.3", "v1.3.0")
    assert calls == [
        "https://proxy.golang.org/github.com/acme/lib/@v/list"
    ]


@pytest.mark.parametrize(
    "body",
    (
        "v1.2.3\nv1.2.3\n",
        "v1.2.3\n\nv1.3.0\n",
        "v1.2.3-rc.1\n",
        "v0.0.0-20260101000000-abcdefabcdef\n",
        {"versions": ["v1.2.3"]},
    ),
)
def test_go_registry_client_rejects_malformed_or_duplicate_proxy_rows(body) -> None:
    client = RegistryClient(lambda url: body, manager_id="go-modules")

    assert client.package_metadata("github.com/acme/lib") is None


@pytest.mark.parametrize(
    "body",
    (
        {},
        {"crate": {"id": "other"}, "versions": [{"num": "1.0.0", "yanked": False}]},
        {"crate": {"id": 123}, "versions": [{"num": "1.0.0", "yanked": False}]},
        {"crate": {"id": "serde"}, "versions": []},
        {"crate": {"id": "serde"}, "versions": {}},
        {"crate": {"id": "serde"}, "versions": [None]},
        {"crate": {"id": "serde"}, "versions": [{"num": 100, "yanked": False}]},
        {"crate": {"id": "serde"}, "versions": [{"num": "", "yanked": False}]},
        {"crate": {"id": "serde"}, "versions": [{"num": "1.0.0"}]},
        {"crate": {"id": "serde"}, "versions": [{"num": "1.0.0", "yanked": 0}]},
        {
            "crate": {"id": "serde"},
            "versions": [
                {"num": "1.0.0", "yanked": False},
                {"num": "1.0.0", "yanked": False},
            ],
        },
        {
            "crate": {"id": "serde"},
            "versions": [
                {"num": "1.0.0", "yanked": False},
                {"num": "1.0.0", "yanked": True},
            ],
        },
    ),
)
def test_cargo_registry_client_rejects_unbound_or_malformed_release_rows(body) -> None:
    client = RegistryClient(lambda url: body, manager_id="cargo")

    assert client.package_metadata("serde") is None


@pytest.mark.parametrize(
    ("oversized_path", "cap_name"),
    (
        ("Cargo.toml", "CARGO_MANIFEST_MAX_BYTES"),
        ("Cargo.lock", "CARGO_LOCK_MAX_BYTES"),
    ),
)
def test_cargo_snapshot_rejects_oversized_encoded_content_before_base64_decode(
    monkeypatch, oversized_path: str, cap_name: str,
) -> None:
    real_decode = base64.b64decode
    small_content = base64.b64encode(b"x").decode("ascii")
    oversized_content = "A" * 128
    decoded_payloads = []

    monkeypatch.setattr(dependency_runtime, cap_name, 1)

    def github_get(url, token):
        if "/commits/" in url:
            return {"sha": "sha-cargo-encoded-limit"}
        if "/contents/?ref=" in url:
            return [
                {"path": "Cargo.toml", "type": "file"},
                {"path": "Cargo.lock", "type": "file"},
            ]
        for path in ("Cargo.toml", "Cargo.lock"):
            if f"/contents/{path}?ref=" in url:
                return {
                    "encoding": "base64",
                    "content": oversized_content if path == oversized_path else small_content,
                }
        raise AssertionError(f"unexpected GitHub URL: {url}")

    def track_decode(value, *args, **kwargs):
        decoded_payloads.append(value)
        if value == oversized_content:
            raise AssertionError("oversized Cargo content reached base64 decoding")
        return real_decode(value, *args, **kwargs)

    monkeypatch.setattr(dependency_runtime.base64, "b64decode", track_decode)
    provider = dependency_runtime.GithubSnapshotProvider("token", github_get)

    with pytest.raises(ValueError, match=f"{oversized_path} base64 content exceeds the encoded-size limit"):
        provider.snapshot("ada/widgets", "main", "Cargo.toml", "Cargo.lock")

    assert oversized_content not in decoded_payloads


class RegistryResponse:
    def __init__(
        self,
        body: bytes,
        *,
        content_length: str | None,
        final_url: str | None = None,
    ) -> None:
        self.body = body
        self.offset = 0
        self.headers = {}
        self.final_url = final_url
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

    def geturl(self) -> str | None:
        return self.final_url


def test_github_source_transport_is_bounded_exact_and_uses_the_app_bearer(monkeypatch):
    url = "https://api.github.com/repos/ada/widgets/commits/main"
    body = b'{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
    response = RegistryResponse(
        body,
        content_length=str(len(body)),
        final_url=url,
    )
    captured = {}

    def open_request(request, timeout):
        captured["request"] = request
        captured["timeout"] = timeout
        return response

    monkeypatch.setattr(dependency_runtime, "_open_github_request", open_request)

    result = dependency_runtime._github_get(url, "installation-token")

    assert result == {"sha": "a" * 40}
    request = captured["request"]
    assert request.get_header("Authorization") == "Bearer installation-token"
    assert request.get_header("Accept") == "application/vnd.github+json"
    assert captured["timeout"] == 8
    encoded_go_sum_cap = 4 * ((dependency_runtime.GO_SUM_MAX_BYTES + 2) // 3)
    assert dependency_runtime._GITHUB_MAX_RESPONSE_BYTES > encoded_go_sum_cap


@pytest.mark.parametrize(
    "url",
    (
        "https://example.invalid/repos/ada/widgets/commits/main",
        "https://api.github.com.example.invalid/repos/ada/widgets/commits/main",
        "https://api.github.com:443/repos/ada/widgets/commits/main",
        "https://user@api.github.com/repos/ada/widgets/commits/main",
    ),
)
def test_github_source_transport_never_sends_bearer_outside_exact_api_origin(
    monkeypatch, url: str,
) -> None:
    contacted = []
    monkeypatch.setattr(
        dependency_runtime,
        "_open_github_request",
        lambda request, timeout: contacted.append(request.full_url),
    )

    with pytest.raises(ValueError, match="exact public API origin"):
        dependency_runtime._github_get(url, "installation-token")

    assert contacted == []


def test_github_snapshot_refuses_unbounded_ref_before_bearer_request() -> None:
    contacted = []
    provider = dependency_runtime.GithubSnapshotProvider(
        "installation-token",
        lambda url, token: contacted.append((url, token)),
    )

    with pytest.raises(ValueError, match="requested ref"):
        provider.snapshot("ada/widgets", "main\nforged", "go.mod", "go.sum")

    assert contacted == []


def test_github_source_transport_refuses_final_url_mismatch_before_read(monkeypatch):
    source_url = "https://api.github.com/repos/ada/widgets/commits/main"
    response = RegistryResponse(
        b'{"sha":"' + b"a" * 40 + b'"}',
        content_length="50",
        final_url="https://api.github.com/repositories/1/commits/main",
    )
    monkeypatch.setattr(
        dependency_runtime,
        "_open_github_request",
        lambda request, timeout: response,
    )

    with pytest.raises(ValueError, match="exact request"):
        dependency_runtime._github_get(source_url, "installation-token")

    assert response.read_calls == 0


def test_github_source_transport_never_follows_a_redirect_with_the_bearer(monkeypatch):
    source_url = "https://api.github.com/repos/ada/widgets/commits/main"
    target_url = "https://storage.example.invalid/redirect-target"
    requested_urls = []

    class RedirectingTransport(urllib.request.BaseHandler):
        handler_order = 100

        def https_open(self, request):
            requested_urls.append(request.full_url)
            headers = Message()
            if request.full_url == source_url:
                headers["Location"] = target_url
                response = urllib.response.addinfourl(
                    BytesIO(b""), headers, source_url, 302,
                )
                response.msg = "Found"
                return response
            raise AssertionError("GitHub bearer reached a redirect target")

    real_build_opener = urllib.request.build_opener

    def build_no_network_opener(*handlers):
        assert any(
            isinstance(handler, dependency_runtime._GitHubNoRedirectHandler)
            for handler in handlers
        )
        assert any(
            isinstance(handler, urllib.request.ProxyHandler)
            and handler.proxies == {}
            for handler in handlers
        )
        redirect_handler = next(
            handler
            for handler in handlers
            if isinstance(handler, dependency_runtime._GitHubNoRedirectHandler)
        )
        return real_build_opener(
            urllib.request.ProxyHandler({}),
            RedirectingTransport(),
            redirect_handler,
        )

    monkeypatch.setattr(
        dependency_runtime.urllib.request,
        "build_opener",
        build_no_network_opener,
    )
    request = urllib.request.Request(
        source_url,
        headers={"Authorization": "Bearer installation-token"},
    )

    with pytest.raises(urllib.error.HTTPError) as error:
        dependency_runtime._open_github_request(request, timeout=8)

    assert error.value.code == 302
    assert requested_urls == [source_url]


@pytest.mark.parametrize("overflow", ("declared", "chunked"))
def test_github_source_transport_refuses_oversized_json(
    monkeypatch, overflow: str,
) -> None:
    url = "https://api.github.com/repos/ada/widgets/commits/main"
    monkeypatch.setattr(dependency_runtime, "_GITHUB_MAX_RESPONSE_BYTES", 8)
    monkeypatch.setattr(dependency_runtime, "_GITHUB_READ_CHUNK_BYTES", 4)
    response = RegistryResponse(
        b'{"x":"123"}' if overflow == "chunked" else b"",
        content_length="9" if overflow == "declared" else None,
        final_url=url,
    )
    monkeypatch.setattr(
        dependency_runtime,
        "_open_github_request",
        lambda request, timeout: response,
    )

    with pytest.raises(ValueError, match="byte limit"):
        dependency_runtime._github_get(url, "installation-token")

    if overflow == "declared":
        assert response.read_calls == 0
    else:
        assert response.read_calls > 1


def test_github_source_transport_rejects_duplicate_json_keys(monkeypatch):
    url = "https://api.github.com/repos/ada/widgets/commits/main"
    body = b'{"sha":"a","sha":"b"}'
    monkeypatch.setattr(
        dependency_runtime,
        "_open_github_request",
        lambda request, timeout: RegistryResponse(
            body,
            content_length=str(len(body)),
            final_url=url,
        ),
    )

    with pytest.raises(ValueError, match="duplicate JSON key"):
        dependency_runtime._github_get(url, "installation-token")


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


def test_go_proxy_transport_has_no_credentials_and_uses_go_byte_cap(monkeypatch):
    body = b"v1.2.3\nv1.3.0\n"
    canonical_url = "https://proxy.golang.org/github.com/acme/lib/@v/list"
    response = RegistryResponse(
        body,
        content_length=str(len(body)),
        final_url=canonical_url,
    )
    captured = {}

    def open_request(request, timeout):
        captured["request"] = request
        captured["timeout"] = timeout
        return response

    monkeypatch.setattr(dependency_runtime, "_open_go_proxy_request", open_request)
    client = RegistryClient(
        lambda url: dependency_runtime._registry_get(url, "go-modules"),
        manager_id="go-modules",
    )

    metadata = client.package_metadata("github.com/acme/lib")

    assert metadata is not None
    request = captured["request"]
    assert request.full_url == canonical_url
    assert request.get_header("Authorization") is None
    assert request.get_header("Accept") == "text/plain"
    assert captured["timeout"] == 8


def test_go_proxy_transport_refuses_redirected_final_url_before_read(monkeypatch):
    canonical_url = "https://proxy.golang.org/github.com/acme/lib/@v/list"
    response = RegistryResponse(
        b"v1.2.3\nv1.3.0\n",
        content_length="16",
        final_url="https://storage.example.invalid/forged-list",
    )
    monkeypatch.setattr(
        dependency_runtime,
        "_open_go_proxy_request",
        lambda request, timeout: response,
    )
    client = RegistryClient(
        lambda url: dependency_runtime._registry_get(url, "go-modules"),
        manager_id="go-modules",
    )

    assert client.package_metadata("github.com/acme/lib") is None
    assert response.read_calls == 0


def test_go_proxy_transport_never_opens_a_redirect_target(monkeypatch):
    source_url = "https://proxy.golang.org/github.com/acme/lib/@v/list"
    target_url = "https://storage.example.invalid/redirect-target"
    requested_urls = []

    class RedirectingTransport(urllib.request.BaseHandler):
        handler_order = 100

        def https_open(self, request):
            requested_urls.append(request.full_url)
            headers = Message()
            if request.full_url == source_url:
                headers["Location"] = target_url
                response = urllib.response.addinfourl(
                    BytesIO(b""), headers, source_url, 302,
                )
                response.msg = "Found"
                return response
            headers["Content-Length"] = "7"
            response = urllib.response.addinfourl(
                BytesIO(b"v1.2.3\n"), headers, target_url, 200,
            )
            response.msg = "OK"
            return response

    real_build_opener = urllib.request.build_opener

    def build_no_network_opener(*handlers):
        assert any(
            isinstance(handler, dependency_runtime._GoProxyNoRedirectHandler)
            for handler in handlers
        )
        assert any(
            isinstance(handler, urllib.request.ProxyHandler)
            and handler.proxies == {}
            for handler in handlers
        )
        redirect_handler = next(
            handler
            for handler in handlers
            if isinstance(handler, dependency_runtime._GoProxyNoRedirectHandler)
        )
        return real_build_opener(
            urllib.request.ProxyHandler({}),
            RedirectingTransport(),
            redirect_handler,
        )

    monkeypatch.setattr(
        dependency_runtime.urllib.request,
        "build_opener",
        build_no_network_opener,
    )
    request = urllib.request.Request(source_url)

    with pytest.raises(urllib.error.HTTPError) as error:
        dependency_runtime._open_go_proxy_request(request, timeout=8)

    assert error.value.code == 302
    assert requested_urls == [source_url]


@pytest.mark.parametrize("overflow", ("declared", "chunked"))
def test_go_proxy_transport_enforces_profile_specific_byte_cap(
    monkeypatch, overflow: str,
) -> None:
    monkeypatch.setattr(dependency_runtime, "GO_PROXY_LIST_MAX_BYTES", 8)
    monkeypatch.setattr(dependency_runtime, "_REGISTRY_READ_CHUNK_BYTES", 4)
    response = RegistryResponse(
        b"v1.2.3\nX" if overflow == "chunked" else b"",
        content_length="9" if overflow == "declared" else None,
        final_url="https://proxy.golang.org/github.com/acme/lib/@v/list",
    )
    monkeypatch.setattr(
        dependency_runtime,
        "_open_go_proxy_request",
        lambda request, timeout: response,
    )
    client = RegistryClient(
        lambda url: dependency_runtime._registry_get(url, "go-modules"),
        manager_id="go-modules",
    )

    assert client.package_metadata("github.com/acme/lib") is None
    if overflow == "declared":
        assert response.read_calls == 0
    else:
        assert response.read_calls > 1


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
