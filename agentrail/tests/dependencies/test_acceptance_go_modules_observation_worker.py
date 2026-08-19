from __future__ import annotations

import base64
from dataclasses import replace
import hashlib
import json
import subprocess
from typing import Optional

import pytest

from agentrail.dependencies.acceptance_go_modules_observation_worker import (
    CommandResult,
    DescriptorError,
    GoModulesObservationWorker,
    HttpResponse,
    SourceCustodyError,
    WorkerConfig,
    bounded_go_version_command,
)
from agentrail.dependencies.server_selected_observation_worker import ServerSelectedObservationWorker
from agentrail.dependencies.go_sumdb import GoSumdbVerifier, parse_signed_go_sumdb_lookup
from agentrail.dependencies.source_inventory import (
    build_go_github_source_inventory_receipt,
    git_blob_object_id,
    validate_go_github_source_inventory,
)
from agentrail.tests.dependencies.test_go_sumdb import (
    NEW_SIGNED_TREE_NOTE,
    SIGNED_YAML_LOOKUP,
    YAML_INCLUSION_PROOF,
)


HEAD_SHA = "a" * 40
TREE_SHA = "b" * 40
MODULE = "gopkg.in/yaml.v3"
CURRENT = "v3.0.1"
TARGET = "v3.0.2"
MODULE_H1 = "h1:fxVm/GzAzEWqLHuvctI91KS9hhNmmWOoWu0XTYJS7CA="
GO_MOD_H1 = "h1:K4uyk7z7BCEPqu6E+C64Yfv1cQ7kz7rIZviUmN+EgEM="
GO_MOD = f"module example.com/root\n\ngo 1.26\n\nrequire {MODULE} {CURRENT}\n".encode()
GO_SUM = (
    f"{MODULE} {CURRENT} {MODULE_H1}\n"
    f"{MODULE} {CURRENT}/go.mod {GO_MOD_H1}\n"
).encode()


def _receipt() -> dict:
    entries = [
        {"path": "go.mod", "mode": "100644", "type": "blob", "sha": git_blob_object_id(GO_MOD, hash_hex_length=40)},
        {"path": "go.sum", "mode": "100644", "type": "blob", "sha": git_blob_object_id(GO_SUM, hash_hex_length=40)},
    ]
    inventory = validate_go_github_source_inventory(
        repository="acme/widgets",
        requested_ref=HEAD_SHA,
        commit={"sha": HEAD_SHA, "commit": {"tree": {"sha": TREE_SHA}}},
        tree_response={"sha": TREE_SHA, "truncated": False, "tree": entries},
    )
    return build_go_github_source_inventory_receipt(
        inventory, {"go.mod": GO_MOD, "go.sum": GO_SUM},
    ).as_dict()


def _descriptor() -> dict:
    receipt = _receipt()
    return {
        "claim": {"id": "22222222-2222-4222-8222-222222222222", "token": "claim-token-abcdefghijklmnopqrstuvwxyz123456", "expiresAt": "2026-08-14T08:05:00.000Z"},
        "binding": {
            "workspaceId": "11111111-1111-4111-8111-111111111111",
            "recordId": "33333333-3333-4333-8333-333333333333",
            "repo": "acme/widgets", "prNumber": 42, "headSha": HEAD_SHA,
            "headCycleId": "44444444-4444-4444-8444-444444444444", "authorityGeneration": 3,
            "acceptanceContract": {"id": "55555555-5555-4555-8555-555555555555", "version": 1, "sha256": "c" * 64},
            "compiledPack": {
                "id": "66666666-6666-4666-8666-666666666666", "sha256": "d" * 64,
                "sourceSnapshotId": "77777777-7777-4777-8777-777777777777",
                "sourceCustodyIdentitySha256": "e" * 64,
                "compilerVersion": "exact-head-correction-pack-v6", "policyVersion": "bounded-exact-ranges-v4",
            },
        },
        "candidate": {
            "identity": {"ecosystem": "go", "manager": "go-modules", "profile": "go_root_public_proxy_lock_v1"},
            "package": MODULE, "dependencyKind": "dependencies", "specifier": CURRENT,
            "currentVersion": CURRENT, "targetVersion": TARGET,
            "proposalFingerprint": "sha256:" + "f" * 64,
        },
        "source": {
            "manifest": {"path": "go.mod", "blobSha": git_blob_object_id(GO_MOD, hash_hex_length=40)},
            "lockfile": {"path": "go.sum", "blobSha": git_blob_object_id(GO_SUM, hash_hex_length=40)},
            "inventory": {"receipt": receipt, "identitySha256": receipt["identitySha256"]},
            "sumdb": {"priorSignedTreeNoteBase64": None, "priorSignedTreeNoteSha256": None, "generation": None},
        },
        "operation": {"updateArgv": ["go", "get", f"{MODULE}@{TARGET}"], "authority": "observe_or_refuse_only"},
        "github": {"token": "github-token"},
    }


class InjectedVerifiedTransport:
    """Worker orchestration boundary; production proof math has its own tests."""

    def __init__(self) -> None:
        verified = GoSumdbVerifier().verify_release(
            SIGNED_YAML_LOOKUP,
            module_path=MODULE,
            version=CURRENT,
            inclusion_proof=YAML_INCLUSION_PROOF,
        )
        self.current = verified
        record, _old_note = SIGNED_YAML_LOOKUP.split(b"\n\n", 1)
        successor_lookup = parse_signed_go_sumdb_lookup(
            record + b"\n\n" + NEW_SIGNED_TREE_NOTE,
            module_path=MODULE,
            version=CURRENT,
        )
        self.target = replace(verified, lookup=replace(
            verified.lookup,
            version=TARGET,
            module_h1="h1:" + base64.b64encode(b"T" * 32).decode(),
            go_mod_h1="h1:" + base64.b64encode(b"G" * 32).decode(),
            tree_head=successor_lookup.tree_head,
        ), timeline="pinned_key_consistent_extension")
        self.calls: list[tuple[str, str]] = []

    def fetch_verified_release(self, verifier: GoSumdbVerifier, module_path: object, version: object):
        assert isinstance(verifier, GoSumdbVerifier)
        self.calls.append((str(module_path), str(version)))
        release = self.current if version == CURRENT else self.target
        verifier._tree_head = release.lookup.tree_head
        return release


class FakeHttp:
    def __init__(
        self,
        descriptor: Optional[dict] = None,
        *,
        go_sum: bytes = GO_SUM,
        osv: Optional[dict] = None,
    ) -> None:
        self.descriptor = descriptor or _descriptor()
        self.go_sum = go_sum
        self.osv = {"vulns": []} if osv is None else osv
        self.observation: Optional[dict] = None
        self.calls: list[tuple[str, str, Optional[bytes]]] = []
        self.headers: list[dict[str, str]] = []

    def __call__(self, method: str, url: str, headers: dict[str, str], body: Optional[bytes], max_bytes: int) -> HttpResponse:
        self.calls.append((method, url, body))
        self.headers.append(headers)
        if url.endswith("/api/v1/runner/acceptance-dependency-observation-work/claim"):
            return HttpResponse(200, json.dumps(self.descriptor).encode(), url)
        if "/contents/go.mod?ref=" in url:
            return self._github(url, GO_MOD)
        if "/contents/go.sum?ref=" in url:
            return self._github(url, self.go_sum)
        if url == "https://api.osv.dev/v1/query":
            return HttpResponse(200, json.dumps(self.osv).encode(), url)
        if url.endswith("/api/v1/runner/acceptance-dependency-observations"):
            self.observation = json.loads((body or b"").decode())
            return HttpResponse(201, b'{"kind":"recorded","status":"observed"}', url)
        raise AssertionError(f"unexpected request {method} {url}")

    @staticmethod
    def _github(url: str, content: bytes) -> HttpResponse:
        path = url.partition("/contents/")[2].partition("?ref=")[0]
        blob_sha = git_blob_object_id(content, hash_hex_length=40)
        encoded = base64.b64encode(content).decode()
        wrapped = "\n".join(encoded[index:index + 60] for index in range(0, len(encoded), 60)) + "\n"
        git_url = f"https://api.github.com/repos/acme/widgets/git/blobs/{blob_sha}"
        html_url = f"https://github.com/acme/widgets/blob/{HEAD_SHA}/{path}"
        payload = {
            "type": "file",
            "encoding": "base64",
            "size": len(content),
            "sha": blob_sha,
            "content": wrapped,
            "name": path,
            "path": path,
            "url": url,
            "html_url": html_url,
            "git_url": git_url,
            "download_url": f"https://raw.githubusercontent.com/acme/widgets/{HEAD_SHA}/{path}",
            "_links": {"self": url, "git": git_url, "html": html_url},
        }
        return HttpResponse(200, json.dumps(payload).encode(), url)


def _command(argv: tuple[str, ...]) -> CommandResult:
    if argv != ("go", "version"):
        raise AssertionError(f"worker attempted unauthorized command: {argv!r}")
    return CommandResult(0, "go version go1.26.1 darwin/arm64\n", "")


def test_claims_exact_go_work_and_posts_verified_observation_with_successor_note() -> None:
    http = FakeHttp()
    transport = InjectedVerifiedTransport()
    worker = GoModulesObservationWorker(
        WorkerConfig("https://console.example.test", "console-token", _descriptor()["binding"]["workspaceId"], "worker:go-1"),
        request=http, run_command=_command, sumdb_transport=transport,
    )

    assert worker.run_once() == "posted"
    assert json.loads(http.calls[0][2] or b"{}") == {"workerId": "worker:go-1"}
    assert http.headers[0]["authorization"] == "Bearer console-token"
    assert transport.calls == [(MODULE, CURRENT), (MODULE, TARGET)]
    assert http.observation is not None
    assert http.observation["candidate"]["identity"] == {"ecosystem": "go", "manager": "go-modules", "profile": "go_root_public_proxy_lock_v1"}
    assert http.observation["runtime"]["version"] == "1.26.1"
    assert http.observation["packageManager"]["updateArgv"] == ["go", "get", f"{MODULE}@{TARGET}"]
    assert http.observation["lockfile"]["disposition"] == "present"
    assert http.observation["security"]["provider"] == "osv"
    assert http.observation["security"]["reference"] == f"osv:Go:{MODULE}@{TARGET}"
    custody = http.observation["sumdbCustody"]
    assert custody["priorGeneration"] is None
    assert custody["priorSignedTreeNoteSha256"] is None
    assert custody["sourceInventoryReceiptSha256"] == _receipt()["identitySha256"]
    successor = base64.b64decode(custody["successorSignedTreeNoteBase64"], validate=True)
    assert hashlib.sha256(successor).hexdigest() == custody["successorSignedTreeNoteSha256"]


@pytest.mark.parametrize(
    "mutation",
    ["space", "tab", "invalid_alphabet", "invalid_padding", "malformed_json", "sha_drift"],
)
def test_refuses_non_github_base64_or_malformed_blob_custody(mutation: str) -> None:
    class MutatedGithubHttp(FakeHttp):
        @staticmethod
        def _github(url: str, content: bytes) -> HttpResponse:
            response = FakeHttp._github(url, content)
            if mutation == "malformed_json":
                return HttpResponse(response.status, b"{", response.final_url)
            payload = json.loads(response.body)
            if mutation == "space":
                payload["content"] = payload["content"].replace("\n", " \n", 1)
            elif mutation == "tab":
                payload["content"] = payload["content"].replace("\n", "\t\n", 1)
            elif mutation == "invalid_alphabet":
                payload["content"] = "*" + payload["content"][1:]
            elif mutation == "invalid_padding":
                payload["content"] = payload["content"].replace("\n", "") + "="
            elif mutation == "sha_drift":
                payload["sha"] = "0" * 40
            else:  # pragma: no cover - the parameter table is closed above.
                raise AssertionError(f"unknown mutation {mutation}")
            return HttpResponse(response.status, json.dumps(payload).encode(), response.final_url)

    http = MutatedGithubHttp()
    with pytest.raises(SourceCustodyError):
        _worker(http).run_once()
    assert http.observation is None


def _worker(http: FakeHttp, transport: Optional[InjectedVerifiedTransport] = None) -> GoModulesObservationWorker:
    return GoModulesObservationWorker(
        WorkerConfig(
            "https://console.example.test",
            "console-token",
            http.descriptor["binding"]["workspaceId"],
            "worker:go-1",
        ),
        request=http,
        run_command=_command,
        sumdb_transport=transport or InjectedVerifiedTransport(),
    )


def test_rejects_remote_plaintext_console_transport_before_claiming() -> None:
    config = WorkerConfig(
        "http://console.example.test",
        "workspace-api-key",
        _descriptor()["binding"]["workspaceId"],
        "worker:go-1",
    )
    with pytest.raises(ValueError, match="worker configuration"):
        GoModulesObservationWorker(
            config,
            request=FakeHttp(),
            run_command=_command,
            sumdb_transport=InjectedVerifiedTransport(),
        )
    with pytest.raises(ValueError, match="worker configuration"):
        ServerSelectedObservationWorker(
            config,
            request=FakeHttp(),
            run_command=_command,
            sumdb_transport=InjectedVerifiedTransport(),
        )


def test_refuses_noncanonical_persisted_source_receipt_without_posting() -> None:
    descriptor = _descriptor()
    descriptor["source"]["inventory"]["receipt"]["policy"]["result"] = "denied"
    http = FakeHttp(descriptor)

    with pytest.raises(SourceCustodyError, match="persisted source inventory receipt"):
        _worker(http).run_once()
    assert http.observation is None


def test_refuses_a_non_forward_or_cross_major_claim_before_source_reads() -> None:
    for current, target in (("v3.0.1", "v3.0.0"), ("v3.0.0", "v4.0.0")):
        descriptor = _descriptor()
        descriptor["candidate"]["specifier"] = current
        descriptor["candidate"]["currentVersion"] = current
        descriptor["candidate"]["targetVersion"] = target
        descriptor["operation"]["updateArgv"][-1] = f"{MODULE}@{target}"
        http = FakeHttp(descriptor)

        with pytest.raises(DescriptorError, match="candidate binding"):
            _worker(http).run_once()
        assert [call[1] for call in http.calls] == [
            "https://console.example.test/api/v1/runner/acceptance-dependency-observation-work/claim",
        ]
        assert http.observation is None


def test_refuses_exact_head_go_sum_that_disagrees_with_pinned_key_current_release() -> None:
    mismatched_sum = GO_SUM.replace(MODULE_H1.encode(), ("h1:" + base64.b64encode(b"X" * 32).decode()).encode())
    descriptor = _descriptor()
    descriptor["source"]["lockfile"]["blobSha"] = git_blob_object_id(mismatched_sum, hash_hex_length=40)
    receipt_entries = descriptor["source"]["inventory"]["receipt"]["inventory"]["entries"]
    for entry in receipt_entries:
        if entry["path"] == "go.sum":
            entry["objectSha"] = descriptor["source"]["lockfile"]["blobSha"]
    # A source receipt cannot be edited piecemeal into authority. Rebuild it
    # from the exact bytes so this test reaches the independent sumdb check.
    entries = [
        {"path": "go.mod", "mode": "100644", "type": "blob", "sha": git_blob_object_id(GO_MOD, hash_hex_length=40)},
        {"path": "go.sum", "mode": "100644", "type": "blob", "sha": git_blob_object_id(mismatched_sum, hash_hex_length=40)},
    ]
    inventory = validate_go_github_source_inventory(
        repository="acme/widgets", requested_ref=HEAD_SHA,
        commit={"sha": HEAD_SHA, "commit": {"tree": {"sha": TREE_SHA}}},
        tree_response={"sha": TREE_SHA, "truncated": False, "tree": entries},
    )
    receipt = build_go_github_source_inventory_receipt(
        inventory, {"go.mod": GO_MOD, "go.sum": mismatched_sum},
    ).as_dict()
    descriptor["source"]["inventory"] = {"receipt": receipt, "identitySha256": receipt["identitySha256"]}
    http = FakeHttp(descriptor, go_sum=mismatched_sum)

    with pytest.raises(SourceCustodyError, match="go.sum does not match"):
        _worker(http).run_once()
    assert http.observation is None


def test_reauthenticates_retained_note_and_refuses_digest_drift() -> None:
    descriptor = _descriptor()
    _record, retained_note = SIGNED_YAML_LOOKUP.split(b"\n\n", 1)
    descriptor["source"]["sumdb"] = {
        "priorSignedTreeNoteBase64": base64.b64encode(retained_note).decode(),
        "priorSignedTreeNoteSha256": "0" * 64,
        "generation": 4,
    }
    http = FakeHttp(descriptor)

    with pytest.raises(DescriptorError, match="digest does not match"):
        _worker(http).run_once()
    assert http.observation is None


def test_reauthenticates_valid_retained_note_and_preserves_prior_generation() -> None:
    descriptor = _descriptor()
    _record, retained_note = SIGNED_YAML_LOOKUP.split(b"\n\n", 1)
    descriptor["source"]["sumdb"] = {
        "priorSignedTreeNoteBase64": base64.b64encode(retained_note).decode(),
        "priorSignedTreeNoteSha256": hashlib.sha256(retained_note).hexdigest(),
        "generation": 4,
    }
    http = FakeHttp(descriptor)

    assert _worker(http).run_once() == "posted"
    assert http.observation is not None
    assert http.observation["sumdbCustody"]["priorGeneration"] == 4
    assert http.observation["sumdbCustody"]["priorSignedTreeNoteSha256"] == hashlib.sha256(retained_note).hexdigest()


def test_sumdb_rollback_refusal_never_posts_observation() -> None:
    class RollbackTransport(InjectedVerifiedTransport):
        def fetch_verified_release(self, verifier: GoSumdbVerifier, module_path: object, version: object):
            if version == TARGET:
                raise ValueError("Go checksum database tree rollback is forbidden")
            return super().fetch_verified_release(verifier, module_path, version)

    http = FakeHttp()
    with pytest.raises(SourceCustodyError, match="timeline or release proof"):
        _worker(http, RollbackTransport()).run_once()
    assert http.observation is None


def test_osv_vulnerability_is_separate_from_sumdb_integrity() -> None:
    http = FakeHttp(osv={"vulns": [{"id": "GO-2026-1234"}]})
    assert _worker(http).run_once() == "posted"
    assert http.observation is not None
    assert http.observation["security"]["disposition"] == "affected"
    assert http.observation["lockfile"]["disposition"] == "present"


def test_go_version_probe_disables_toolchain_and_module_networks(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def run(argv: tuple[str, ...], **options: object) -> subprocess.CompletedProcess[str]:
        captured.update(options)
        return subprocess.CompletedProcess(argv, 0, "go version go1.26.1 darwin/arm64\n", "")

    monkeypatch.setattr("subprocess.run", run)
    assert bounded_go_version_command(("go", "version")).returncode == 0
    environment = captured["env"]
    assert isinstance(environment, dict)
    assert environment == {
        "PATH": environment["PATH"],
        "CI": "1",
        "NO_COLOR": "1",
        "GOTOOLCHAIN": "local",
        "GOPROXY": "off",
        "GOSUMDB": "off",
        "GOENV": "off",
        "GOWORK": "off",
    }
    assert captured["shell"] is False
    with pytest.raises(ValueError, match="only the Go version probe"):
        bounded_go_version_command(("go", "get", f"{MODULE}@{TARGET}"))


def test_generic_worker_dispatches_one_server_selected_go_claim_without_reclaiming() -> None:
    http = FakeHttp()
    worker = ServerSelectedObservationWorker(
        WorkerConfig(
            "https://console.example.test",
            "console-token",
            http.descriptor["binding"]["workspaceId"],
            "worker:generic-1",
        ),
        request=http,
        run_command=_command,
        sumdb_transport=InjectedVerifiedTransport(),
    )

    assert worker.run_once() == "posted"
    claim_calls = [url for _method, url, _body in http.calls if url.endswith("/claim")]
    assert claim_calls == ["https://console.example.test/api/v1/runner/acceptance-dependency-observation-work/claim"]
