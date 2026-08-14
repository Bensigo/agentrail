"""Read-only pnpm evidence producer for one server-derived R10 work lease.

The worker never runs install, update, build, test, Git, or package scripts.
Its complete process surface is ``node --version`` and ``pnpm --version``.
The Console remains authoritative for work selection and for final v2
observation admission/refusal.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import ssl
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Callable, Mapping, Optional


UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
SHA1 = re.compile(r"^[a-f0-9]{40}$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
FINGERPRINT = re.compile(r"^sha256:[a-f0-9]{64}$")
REPO = re.compile(r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$")
PACKAGE = re.compile(r"^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$")
SEMVER = re.compile(r"^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$")
IDENTITY = {"ecosystem": "node", "manager": "pnpm", "profile": "pnpm_lockfile_only_v1"}
MAX_CLAIM_BYTES = 64 * 1024
MAX_SOURCE_BYTES = 1024 * 1024
MAX_OSV_BYTES = 1024 * 1024
MAX_RESPONSE_BYTES = 64 * 1024


class WorkerError(RuntimeError):
    pass


class DescriptorError(WorkerError):
    pass


class SourceCustodyError(WorkerError):
    pass


@dataclass(frozen=True)
class HttpResponse:
    status: int
    body: bytes
    final_url: str


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: str
    stderr: str


@dataclass(frozen=True)
class WorkerConfig:
    console_url: str
    console_token: str
    workspace_id: str
    worker_id: str


HttpRequest = Callable[[str, str, dict[str, str], Optional[bytes], int], HttpResponse]
CommandRunner = Callable[[tuple[str, ...]], CommandResult]


def _canonical_sha256(value: object) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return hashlib.sha256(encoded).hexdigest()


def _exact_keys(value: object, keys: set[str]) -> bool:
    return isinstance(value, dict) and set(value) == keys


def _text(value: object, maximum: int) -> bool:
    return isinstance(value, str) and 0 < len(value) <= maximum and value == value.strip() \
        and not any(ord(character) < 32 or ord(character) == 127 for character in value)


def _parse_descriptor(value: object, workspace_id: str) -> dict:
    if not _exact_keys(value, {"claim", "binding", "candidate", "source", "operation", "github"}):
        raise DescriptorError("claim descriptor has an unknown or missing field")
    descriptor = value
    claim = descriptor["claim"]
    binding = descriptor["binding"]
    candidate = descriptor["candidate"]
    source = descriptor["source"]
    operation = descriptor["operation"]
    github = descriptor["github"]
    if not _exact_keys(claim, {"id", "token", "expiresAt"}) or not UUID.fullmatch(str(claim.get("id", ""))) \
            or not _text(claim.get("token"), 256) \
            or not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", str(claim.get("token", ""))) \
            or not _text(claim.get("expiresAt"), 64):
        raise DescriptorError("claim identity is invalid")
    if not _exact_keys(binding, {
        "workspaceId", "recordId", "repo", "prNumber", "headSha", "headCycleId",
        "authorityGeneration", "acceptanceContract", "compiledPack",
    }) or binding.get("workspaceId") != workspace_id \
            or not UUID.fullmatch(str(binding.get("recordId", ""))) \
            or not REPO.fullmatch(str(binding.get("repo", ""))) \
            or not isinstance(binding.get("prNumber"), int) or binding["prNumber"] <= 0 \
            or not SHA1.fullmatch(str(binding.get("headSha", ""))) \
            or not UUID.fullmatch(str(binding.get("headCycleId", ""))) \
            or not isinstance(binding.get("authorityGeneration"), int) or binding["authorityGeneration"] < 0:
        raise DescriptorError("Record/head binding is invalid")
    contract = binding["acceptanceContract"]
    pack = binding["compiledPack"]
    if not _exact_keys(contract, {"id", "version", "sha256"}) \
            or not UUID.fullmatch(str(contract.get("id", ""))) \
            or not isinstance(contract.get("version"), int) or contract["version"] <= 0 \
            or not SHA256.fullmatch(str(contract.get("sha256", ""))):
        raise DescriptorError("Contract binding is invalid")
    if not _exact_keys(pack, {
        "id", "sha256", "sourceSnapshotId", "sourceCustodyIdentitySha256",
        "compilerVersion", "policyVersion",
    }) or not UUID.fullmatch(str(pack.get("id", ""))) \
            or not UUID.fullmatch(str(pack.get("sourceSnapshotId", ""))) \
            or not SHA256.fullmatch(str(pack.get("sha256", ""))) \
            or not SHA256.fullmatch(str(pack.get("sourceCustodyIdentitySha256", ""))) \
            or not _text(pack.get("compilerVersion"), 128) or not _text(pack.get("policyVersion"), 128):
        raise DescriptorError("Context Pack binding is invalid")
    if not _exact_keys(candidate, {
        "identity", "package", "dependencyKind", "specifier", "currentVersion",
        "targetVersion", "proposalFingerprint",
    }) or candidate.get("identity") != IDENTITY \
            or not PACKAGE.fullmatch(str(candidate.get("package", ""))) \
            or candidate.get("dependencyKind") not in {"dependencies", "devDependencies"} \
            or not _text(candidate.get("specifier"), 256) \
            or not SEMVER.fullmatch(str(candidate.get("currentVersion", ""))) \
            or not SEMVER.fullmatch(str(candidate.get("targetVersion", ""))) \
            or candidate.get("currentVersion") == candidate.get("targetVersion") \
            or not FINGERPRINT.fullmatch(str(candidate.get("proposalFingerprint", ""))):
        raise DescriptorError("pnpm candidate binding is invalid")
    if not _exact_keys(source, {"manifest", "lockfile"}):
        raise DescriptorError("source binding is invalid")
    for name, path in (("manifest", "package.json"), ("lockfile", "pnpm-lock.yaml")):
        file = source.get(name)
        if not _exact_keys(file, {"path", "blobSha"}) or file.get("path") != path \
                or not SHA1.fullmatch(str(file.get("blobSha", ""))):
            raise DescriptorError(f"{name} source binding is invalid")
    expected_argv = [
        "pnpm", "update", f"{candidate['package']}@{candidate['targetVersion']}",
        "--lockfile-only", "--ignore-scripts",
    ]
    if not _exact_keys(operation, {"updateArgv", "authority"}) \
            or operation.get("updateArgv") != expected_argv \
            or operation.get("authority") != "observe_or_refuse_only":
        raise DescriptorError("operation exceeds the observation-only profile")
    if not _exact_keys(github, {"token"}) or not _text(github.get("token"), 2048):
        raise DescriptorError("GitHub source credential is unavailable")
    return descriptor


def _decode_github_file(response: HttpResponse, expected_url: str, expected_blob_sha: str) -> bytes:
    if response.status != 200 or response.final_url != expected_url or len(response.body) > MAX_SOURCE_BYTES:
        raise SourceCustodyError("exact-head source read was unavailable")
    try:
        payload = json.loads(response.body)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SourceCustodyError("exact-head source response was malformed") from exc
    if not _exact_keys(payload, {"type", "encoding", "size", "sha", "content"}) \
            or payload.get("type") != "file" or payload.get("encoding") != "base64" \
            or payload.get("sha") != expected_blob_sha \
            or not isinstance(payload.get("size"), int) or payload["size"] < 0 \
            or payload["size"] > MAX_SOURCE_BYTES or not isinstance(payload.get("content"), str):
        raise SourceCustodyError("exact-head source blob custody did not match the descriptor")
    try:
        content = base64.b64decode(payload["content"], validate=True)
    except (ValueError, TypeError) as exc:
        raise SourceCustodyError("exact-head source body was not canonical base64") from exc
    actual = hashlib.sha1(f"blob {len(content)}\0".encode() + content).hexdigest()
    if len(content) != payload["size"] or actual != expected_blob_sha:
        raise SourceCustodyError("exact-head source blob custody did not match the descriptor")
    return content


def _probe(run_command: CommandRunner, argv: tuple[str, ...], kind: str) -> tuple[str, Optional[str], str]:
    try:
        result = run_command(argv)
    except Exception:
        evidence = {"kind": kind, "version": 1, "argv": list(argv), "outcome": "unavailable"}
        return "unavailable", None, _canonical_sha256(evidence)
    stdout = result.stdout.strip()
    normalized = stdout[1:] if argv[0] == "node" and stdout.startswith("v") else stdout
    disposition = "safe" if result.returncode == 0 and SEMVER.fullmatch(normalized) else "unsafe"
    version = normalized if _text(normalized, 64) else None
    evidence = {
        "kind": kind,
        "version": 1,
        "argv": list(argv),
        "returnCode": result.returncode,
        "stdout": stdout[:128],
        "stderrSha256": hashlib.sha256(result.stderr[:1024].encode()).hexdigest(),
        "disposition": disposition,
    }
    return disposition, version, _canonical_sha256(evidence)


class PnpmObservationWorker:
    def __init__(self, config: WorkerConfig, *, request: HttpRequest, run_command: CommandRunner):
        parsed = urllib.parse.urlsplit(config.console_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password \
                or parsed.query or parsed.fragment or not UUID.fullmatch(config.workspace_id) \
                or not _text(config.console_token, 4096) or not _text(config.worker_id, 128):
            raise ValueError("worker configuration is invalid")
        self.config = WorkerConfig(
            config.console_url.rstrip("/"), config.console_token,
            config.workspace_id.lower(), config.worker_id,
        )
        self.request = request
        self.run_command = run_command

    def run_once(self) -> str:
        claim_url = self.config.console_url + "/api/v1/runner/acceptance-dependency-observation-work/claim"
        claim_body = json.dumps({
            "workspaceId": self.config.workspace_id,
            "workerId": self.config.worker_id,
        }, separators=(",", ":")).encode()
        claim = self.request("POST", claim_url, self._console_headers(), claim_body, MAX_CLAIM_BYTES)
        if claim.status == 204:
            return "idle"
        if claim.status != 200 or claim.final_url != claim_url or len(claim.body) > MAX_CLAIM_BYTES:
            raise WorkerError(f"dependency observation claim failed with status {claim.status}")
        try:
            descriptor = _parse_descriptor(json.loads(claim.body), self.config.workspace_id)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise DescriptorError("claim descriptor was not JSON") from exc

        binding = descriptor["binding"]
        candidate = descriptor["candidate"]
        source = descriptor["source"]
        github_headers = {
            "accept": "application/vnd.github+json",
            "authorization": f"Bearer {descriptor['github']['token']}",
            "x-github-api-version": "2022-11-28",
            "user-agent": "AgentRail-pnpm-evidence/1",
        }
        contents: dict[str, bytes] = {}
        for name in ("manifest", "lockfile"):
            file = source[name]
            quoted_path = urllib.parse.quote(file["path"], safe="/")
            url = (
                f"https://api.github.com/repos/{binding['repo']}/contents/{quoted_path}"
                f"?ref={binding['headSha']}"
            )
            response = self.request("GET", url, github_headers, None, MAX_SOURCE_BYTES)
            contents[name] = _decode_github_file(response, url, file["blobSha"])

        manifest_safe = self._manifest_matches(contents["manifest"], candidate)
        runtime_disposition, runtime_version, runtime_hash = _probe(
            self.run_command, ("node", "--version"), "node_version_probe_v1",
        )
        manager_disposition, manager_version, manager_hash = _probe(
            self.run_command, ("pnpm", "--version"), "pnpm_version_probe_v1",
        )
        if not manifest_safe or manager_version is None \
                or not self._manifest_manager_matches(contents["manifest"], manager_version):
            manager_disposition = "unsafe"
            manager_hash = _canonical_sha256({
                "kind": "pnpm_manager_profile_evidence_v1",
                "version": 1,
                "probeSha256": manager_hash,
                "manifestCandidateMatches": manifest_safe,
                "manifestManagerMatches": manager_version is not None
                    and self._manifest_manager_matches(contents["manifest"], manager_version),
            })

        security_disposition, security_hash = self._osv(candidate)
        lock_hash = _canonical_sha256({
            "kind": "pnpm_exact_head_lockfile_v1",
            "version": 1,
            "headSha": binding["headSha"],
            "path": source["lockfile"]["path"],
            "blobSha": source["lockfile"]["blobSha"],
            "contentSha256": hashlib.sha256(contents["lockfile"]).hexdigest(),
            "byteCount": len(contents["lockfile"]),
        })
        evidence = {
            "workspaceId": binding["workspaceId"],
            "recordId": binding["recordId"],
            "compiledPackId": binding["compiledPack"]["id"],
            "candidate": {key: candidate[key] for key in (
                "identity", "package", "dependencyKind", "specifier", "currentVersion", "targetVersion"
            )},
            "runtime": {
                "identity": IDENTITY,
                "disposition": runtime_disposition,
                "version": runtime_version,
                "evidenceSha256": runtime_hash,
            },
            "packageManager": {
                "disposition": manager_disposition,
                "name": "pnpm",
                "version": manager_version,
                "profile": "pnpm_lockfile_only_v1",
                "updateArgv": descriptor["operation"]["updateArgv"],
                "evidenceSha256": manager_hash,
            },
            "manifest": source["manifest"],
            "lockfile": {
                "disposition": "present",
                "path": source["lockfile"]["path"],
                "blobSha": source["lockfile"]["blobSha"],
                "evidenceSha256": lock_hash,
            },
            "baseline": {"headSha": binding["headSha"]},
            "security": {
                "identity": IDENTITY,
                "disposition": security_disposition,
                "provider": "osv",
                "reference": f"osv:npm:{candidate['package']}@{candidate['targetVersion']}",
                "reportSha256": security_hash,
            },
        }
        observation_url = self.config.console_url + "/api/v1/runner/acceptance-dependency-observations"
        headers = self._console_headers()
        headers["x-agentrail-dependency-claim-token"] = descriptor["claim"]["token"]
        posted = self.request(
            "POST", observation_url, headers,
            json.dumps(evidence, separators=(",", ":")).encode(), MAX_RESPONSE_BYTES,
        )
        if posted.status not in {200, 201} or posted.final_url != observation_url:
            raise WorkerError(f"dependency observation post failed with status {posted.status}")
        return "posted"

    def _console_headers(self) -> dict[str, str]:
        return {
            "authorization": f"Bearer {self.config.console_token}",
            "content-type": "application/json",
            "user-agent": "AgentRail-pnpm-evidence/1",
        }

    @staticmethod
    def _manifest(contents: bytes) -> Optional[Mapping[str, object]]:
        try:
            value = json.loads(contents)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
        return value if isinstance(value, dict) else None

    @classmethod
    def _manifest_matches(cls, contents: bytes, candidate: Mapping[str, object]) -> bool:
        manifest = cls._manifest(contents)
        lane = manifest.get(str(candidate["dependencyKind"])) if manifest else None
        return isinstance(lane, dict) and lane.get(candidate["package"]) == candidate["specifier"]

    @classmethod
    def _manifest_manager_matches(cls, contents: bytes, version: str) -> bool:
        manifest = cls._manifest(contents)
        return bool(manifest and manifest.get("packageManager") == f"pnpm@{version}")

    def _osv(self, candidate: Mapping[str, object]) -> tuple[str, str]:
        query = {
            "package": {"ecosystem": "npm", "name": candidate["package"]},
            "version": candidate["targetVersion"],
        }
        url = "https://api.osv.dev/v1/query"
        response = self.request(
            "POST", url,
            {"content-type": "application/json", "user-agent": "AgentRail-pnpm-evidence/1"},
            json.dumps(query, separators=(",", ":")).encode(), MAX_OSV_BYTES,
        )
        if response.status != 200 or response.final_url != url or len(response.body) > MAX_OSV_BYTES:
            report = {"kind": "osv_npm_query_v1", "query": query, "outcome": "unavailable"}
            return "unavailable", _canonical_sha256(report)
        try:
            payload = json.loads(response.body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            report = {"kind": "osv_npm_query_v1", "query": query, "outcome": "ambiguous"}
            return "ambiguous", _canonical_sha256(report)
        vulns = payload.get("vulns", []) if isinstance(payload, dict) else None
        if not isinstance(vulns, list) or not all(isinstance(item, dict) and _text(item.get("id"), 256) for item in vulns):
            report = {"kind": "osv_npm_query_v1", "query": query, "outcome": "ambiguous"}
            return "ambiguous", _canonical_sha256(report)
        ids = sorted({item["id"] for item in vulns})
        disposition = "affected" if ids else "clear"
        report = {"kind": "osv_npm_query_v1", "query": query, "outcome": disposition, "vulnerabilityIds": ids}
        return disposition, _canonical_sha256(report)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: object,
        code: int,
        msg: str,
        headers: Mapping[str, str],
        newurl: str,
    ) -> None:
        return None


def bounded_http_request(
    method: str,
    url: str,
    headers: dict[str, str],
    body: Optional[bytes],
    max_bytes: int,
) -> HttpResponse:
    """HTTPS request with no ambient proxy, no redirects, and a hard body cap."""
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        urllib.request.HTTPSHandler(context=ssl.create_default_context()),
        _NoRedirect(),
    )
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        response = opener.open(request, timeout=10)
    except urllib.error.HTTPError as error:
        response = error
    except urllib.error.URLError as error:
        raise WorkerError("HTTP request unavailable") from error
    with response:
        payload = response.read(max_bytes + 1)
        if len(payload) > max_bytes:
            raise WorkerError("HTTP response exceeded its evidence bound")
        return HttpResponse(response.status, payload, response.geturl())


def bounded_version_command(argv: tuple[str, ...]) -> CommandResult:
    if argv not in {("node", "--version"), ("pnpm", "--version")}:
        raise ValueError("only Node and pnpm version probes are authorized")
    environment = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "CI": "1",
        "NO_COLOR": "1",
        "COREPACK_ENABLE_NETWORK": "0",
        "COREPACK_ENABLE_PROJECT_SPEC": "0",
        "npm_config_ignore_scripts": "true",
    }
    try:
        completed = subprocess.run(
            argv,
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
            env=environment,
            shell=False,
        )
    except (OSError, subprocess.SubprocessError):
        return CommandResult(127, "", "unavailable")
    return CommandResult(
        completed.returncode,
        completed.stdout[:1024],
        completed.stderr[:1024],
    )


__all__ = [
    "CommandResult",
    "DescriptorError",
    "HttpResponse",
    "PnpmObservationWorker",
    "SourceCustodyError",
    "WorkerConfig",
    "WorkerError",
    "bounded_http_request",
    "bounded_version_command",
]
