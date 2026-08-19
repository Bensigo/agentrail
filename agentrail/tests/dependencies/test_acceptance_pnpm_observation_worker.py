from __future__ import annotations

import base64
import hashlib
import json
import subprocess
import urllib.error
from typing import Optional

import pytest

from agentrail.dependencies.acceptance_pnpm_observation_worker import (
    CommandResult,
    HttpResponse,
    PnpmObservationWorker,
    SourceCustodyError,
    WorkerConfig,
    WorkerError,
    bounded_http_request,
    bounded_version_command,
)


def _blob_sha(content: bytes) -> str:
    return hashlib.sha1(f"blob {len(content)}\0".encode() + content).hexdigest()


MANIFEST = json.dumps({
    "packageManager": "pnpm@11.19.0",
    "engines": {"node": ">=22.0.0"},
    "dependencies": {"lodash": "^4.17.20"},
}, separators=(",", ":")).encode()
LOCKFILE = b"lockfileVersion: '9.0'\npackages:\n  lodash@4.17.21: {}\n"


def _descriptor() -> dict:
    return {
        "claim": {
            "id": "22222222-2222-4222-8222-222222222222",
            "token": "claim-token-abcdefghijklmnopqrstuvwxyz123456",
            "expiresAt": "2026-08-14T08:05:00.000Z",
        },
        "binding": {
            "workspaceId": "11111111-1111-4111-8111-111111111111",
            "recordId": "33333333-3333-4333-8333-333333333333",
            "repo": "acme/widgets",
            "prNumber": 42,
            "headSha": "a" * 40,
            "headCycleId": "44444444-4444-4444-8444-444444444444",
            "authorityGeneration": 3,
            "acceptanceContract": {
                "id": "55555555-5555-4555-8555-555555555555",
                "version": 1,
                "sha256": "b" * 64,
            },
            "compiledPack": {
                "id": "66666666-6666-4666-8666-666666666666",
                "sha256": "c" * 64,
                "sourceSnapshotId": "77777777-7777-4777-8777-777777777777",
                "sourceCustodyIdentitySha256": "d" * 64,
                "compilerVersion": "exact-head-correction-pack-v6",
                "policyVersion": "bounded-exact-ranges-v4",
            },
        },
        "candidate": {
            "identity": {"ecosystem": "node", "manager": "pnpm", "profile": "pnpm_lockfile_only_v1"},
            "package": "lodash",
            "dependencyKind": "dependencies",
            "specifier": "^4.17.20",
            "currentVersion": "4.17.20",
            "targetVersion": "4.17.21",
            "proposalFingerprint": "sha256:" + "e" * 64,
        },
        "source": {
            "manifest": {"path": "package.json", "blobSha": _blob_sha(MANIFEST)},
            "lockfile": {"path": "pnpm-lock.yaml", "blobSha": _blob_sha(LOCKFILE)},
        },
        "operation": {
            "updateArgv": ["pnpm", "update", "lodash@4.17.21", "--lockfile-only", "--ignore-scripts"],
            "authority": "observe_or_refuse_only",
        },
        "github": {"token": "github-token"},
    }


class FakeHttp:
    def __init__(self, descriptor: Optional[dict] = None, *, osv: Optional[dict] = None):
        self.descriptor = descriptor or _descriptor()
        self.osv = {"vulns": []} if osv is None else osv
        self.calls: list[tuple[str, str, dict[str, str], Optional[bytes]]] = []
        self.observation: Optional[dict] = None

    def __call__(self, method: str, url: str, headers: dict[str, str], body: Optional[bytes], max_bytes: int) -> HttpResponse:
        self.calls.append((method, url, headers, body))
        if url.endswith("/api/v1/runner/acceptance-dependency-observation-work/claim"):
            return HttpResponse(200, json.dumps(self.descriptor).encode(), url)
        if "/contents/package.json?ref=" in url:
            return self._github(url, MANIFEST)
        if "/contents/pnpm-lock.yaml?ref=" in url:
            return self._github(url, LOCKFILE)
        if url == "https://api.osv.dev/v1/query":
            return HttpResponse(200, json.dumps(self.osv).encode(), url)
        if url.endswith("/api/v1/runner/acceptance-dependency-observations"):
            self.observation = json.loads((body or b"").decode())
            return HttpResponse(201, b'{"kind":"recorded","status":"observed"}', url)
        raise AssertionError(f"unexpected request {method} {url}")

    @staticmethod
    def _github(url: str, content: bytes) -> HttpResponse:
        payload = {
            "type": "file",
            "encoding": "base64",
            "size": len(content),
            "sha": _blob_sha(content),
            "content": base64.b64encode(content).decode(),
        }
        return HttpResponse(200, json.dumps(payload).encode(), url)


def _command(argv: tuple[str, ...]) -> CommandResult:
    if argv == ("node", "--version"):
        return CommandResult(0, "v22.22.3\n", "")
    if argv == ("pnpm", "--version"):
        return CommandResult(0, "11.19.0\n", "")
    raise AssertionError(f"producer attempted an unauthorized command: {argv!r}")


@pytest.mark.parametrize("console_url", [
    "http://console.example.test",
    "http://192.0.2.10:3000",
])
def test_rejects_remote_plaintext_console_urls(console_url: str) -> None:
    with pytest.raises(ValueError, match="worker configuration is invalid"):
        PnpmObservationWorker(
            WorkerConfig(
                console_url=console_url,
                workspace_api_key="workspace-api-key",
                workspace_id="11111111-1111-4111-8111-111111111111",
                worker_id="worker:pnpm-1",
            ),
            request=FakeHttp(),
            run_command=_command,
        )


@pytest.mark.parametrize("console_url", [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
])
def test_allows_plaintext_console_only_on_loopback(console_url: str) -> None:
    PnpmObservationWorker(
        WorkerConfig(
            console_url=console_url,
            workspace_api_key="workspace-api-key",
            workspace_id="11111111-1111-4111-8111-111111111111",
            worker_id="worker:pnpm-1",
        ),
        request=FakeHttp(),
        run_command=_command,
    )


def test_claims_exact_work_gathers_bounded_evidence_and_posts_v2_observation() -> None:
    http = FakeHttp()
    worker = PnpmObservationWorker(
        WorkerConfig(
            console_url="https://console.example.test",
            workspace_api_key="workspace-api-key",
            workspace_id="11111111-1111-4111-8111-111111111111",
            worker_id="worker:pnpm-1",
        ),
        request=http,
        run_command=_command,
    )

    assert worker.run_once() == "posted"
    claim_call = http.calls[0]
    assert claim_call[0] == "POST"
    assert json.loads((claim_call[3] or b"").decode()) == {"workerId": "worker:pnpm-1"}
    assert claim_call[2]["authorization"] == "Bearer workspace-api-key"
    assert http.observation == {
        "workspaceId": "11111111-1111-4111-8111-111111111111",
        "recordId": "33333333-3333-4333-8333-333333333333",
        "compiledPackId": "66666666-6666-4666-8666-666666666666",
        "candidate": {
            "identity": {"ecosystem": "node", "manager": "pnpm", "profile": "pnpm_lockfile_only_v1"},
            "package": "lodash",
            "dependencyKind": "dependencies",
            "specifier": "^4.17.20",
            "currentVersion": "4.17.20",
            "targetVersion": "4.17.21",
        },
        "runtime": {
            "identity": {"ecosystem": "node", "manager": "pnpm", "profile": "pnpm_lockfile_only_v1"},
            "disposition": "safe",
            "version": "22.22.3",
            "evidenceSha256": http.observation["runtime"]["evidenceSha256"],
        },
        "packageManager": {
            "disposition": "safe",
            "name": "pnpm",
            "version": "11.19.0",
            "profile": "pnpm_lockfile_only_v1",
            "updateArgv": ["pnpm", "update", "lodash@4.17.21", "--lockfile-only", "--ignore-scripts"],
            "evidenceSha256": http.observation["packageManager"]["evidenceSha256"],
        },
        "manifest": {"path": "package.json", "blobSha": _blob_sha(MANIFEST)},
        "lockfile": {
            "disposition": "present",
            "path": "pnpm-lock.yaml",
            "blobSha": _blob_sha(LOCKFILE),
            "evidenceSha256": http.observation["lockfile"]["evidenceSha256"],
        },
        "baseline": {"headSha": "a" * 40},
        "security": {
            "identity": {"ecosystem": "node", "manager": "pnpm", "profile": "pnpm_lockfile_only_v1"},
            "disposition": "clear",
            "provider": "osv",
            "reference": "osv:npm:lodash@4.17.21",
            "reportSha256": http.observation["security"]["reportSha256"],
        },
    }
    assert all(len(http.observation[key][hash_key]) == 64 for key, hash_key in (
        ("runtime", "evidenceSha256"),
        ("packageManager", "evidenceSha256"),
        ("lockfile", "evidenceSha256"),
        ("security", "reportSha256"),
    ))
    github_urls = [url for _, url, _, _ in http.calls if url.startswith("https://api.github.com/")]
    assert github_urls == [
        "https://api.github.com/repos/acme/widgets/contents/package.json?ref=" + "a" * 40,
        "https://api.github.com/repos/acme/widgets/contents/pnpm-lock.yaml?ref=" + "a" * 40,
    ]


def test_refuses_source_blob_drift_without_posting() -> None:
    descriptor = _descriptor()
    descriptor["source"]["manifest"]["blobSha"] = "0" * 40
    http = FakeHttp(descriptor)
    worker = PnpmObservationWorker(
        WorkerConfig("https://console.example.test", "console-token", descriptor["binding"]["workspaceId"], "worker:pnpm-1"),
        request=http,
        run_command=_command,
    )
    with pytest.raises(SourceCustodyError, match="blob custody"):
        worker.run_once()
    assert http.observation is None


def test_manifest_profile_drift_posts_unsafe_manager_refusal_evidence() -> None:
    drifted = json.dumps({
        "packageManager": "pnpm@10.0.0",
        "dependencies": {"lodash": "^4.17.20"},
    }, separators=(",", ":")).encode()
    descriptor = _descriptor()
    descriptor["source"]["manifest"]["blobSha"] = _blob_sha(drifted)
    http = FakeHttp(descriptor)

    original = http.__call__
    def request(method: str, url: str, headers: dict[str, str], body: Optional[bytes], max_bytes: int) -> HttpResponse:
        if "/contents/package.json?ref=" in url:
            return FakeHttp._github(url, drifted)
        return original(method, url, headers, body, max_bytes)

    worker = PnpmObservationWorker(
        WorkerConfig("https://console.example.test", "console-token", descriptor["binding"]["workspaceId"], "worker:pnpm-1"),
        request=request,
        run_command=_command,
    )
    assert worker.run_once() == "posted"
    assert http.observation is not None
    assert http.observation["packageManager"]["disposition"] == "unsafe"


def test_osv_findings_post_affected_security_evidence() -> None:
    http = FakeHttp(osv={"vulns": [{"id": "GHSA-xxxx-yyyy-zzzz"}]})
    worker = PnpmObservationWorker(
        WorkerConfig("https://console.example.test", "console-token", _descriptor()["binding"]["workspaceId"], "worker:pnpm-1"),
        request=http,
        run_command=_command,
    )
    assert worker.run_once() == "posted"
    assert http.observation is not None
    assert http.observation["security"]["disposition"] == "affected"


def test_bounded_http_request_normalizes_transport_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    class UnavailableOpener:
        def open(self, request, timeout):  # noqa: ANN001, ANN201
            raise urllib.error.URLError("offline")

    monkeypatch.setattr("urllib.request.build_opener", lambda *handlers: UnavailableOpener())
    with pytest.raises(WorkerError, match="HTTP request unavailable"):
        bounded_http_request("GET", "https://example.test/evidence", {}, None, 128)


def test_version_probe_disables_corepack_downloads_and_project_dispatch(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def run(argv: tuple[str, ...], **options: object) -> subprocess.CompletedProcess[str]:
        captured.update(options)
        return subprocess.CompletedProcess(argv, 0, "11.19.0\n", "")

    monkeypatch.setattr("subprocess.run", run)
    assert bounded_version_command(("pnpm", "--version")).returncode == 0
    environment = captured["env"]
    assert isinstance(environment, dict)
    assert environment == {
        "PATH": environment["PATH"],
        "CI": "1",
        "NO_COLOR": "1",
        "COREPACK_ENABLE_NETWORK": "0",
        "COREPACK_ENABLE_PROJECT_SPEC": "0",
        "npm_config_ignore_scripts": "true",
    }
    assert captured["shell"] is False
