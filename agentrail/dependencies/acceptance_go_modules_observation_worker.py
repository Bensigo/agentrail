"""Read-only Go Modules evidence producer for one server-derived R10 lease.

The worker reads exact GitHub blobs, reconstructs the persisted source receipt,
probes only ``go version``, and verifies checksum-log records through the
existing pinned-key sumdb transport.  The descriptor's ``go get`` argv is
evidence about a possible external-builder operation; this process never runs
it and owns no implementation, PR, merge, or deployment authority.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import re
import subprocess
import urllib.parse
from typing import Mapping, Optional, Protocol

from agentrail.dependencies.acceptance_pnpm_observation_worker import (
    CommandResult,
    DescriptorError,
    HttpRequest,
    HttpResponse,
    SourceCustodyError,
    WorkerConfig,
    WorkerError,
    bounded_http_request,
)
from agentrail.dependencies.go_modules import (
    GO_MODULES_OBSERVATION_PROFILE,
    parse_go_module_files,
    stable_go_version,
    validate_go_module_version,
)
from agentrail.dependencies.go_sumdb import GoSumdbVerifier, VerifiedGoSumdbRelease
from agentrail.dependencies.go_sumdb_transport import GoSumdbTransport
from agentrail.dependencies.source_inventory import (
    build_go_github_source_inventory_receipt,
    validate_go_github_source_inventory,
)


UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
SHA1 = re.compile(r"^[a-f0-9]{40}$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
FINGERPRINT = re.compile(r"^sha256:[a-f0-9]{64}$")
REPO = re.compile(r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$")
GO_RUNTIME = re.compile(r"^go version go(1\.(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*))?) [^\s/]+/[^\s/]+$")
IDENTITY = {
    "ecosystem": "go",
    "manager": "go-modules",
    "profile": GO_MODULES_OBSERVATION_PROFILE,
}
# A Go claim carries the persisted, source-free recursive inventory receipt.
# Its existing source-custody contract permits up to 16 MiB, so retaining the
# pnpm claim's 64 KiB response cap here would silently make ordinary Go repos
# unclaimable.
MAX_CLAIM_BYTES = 16 * 1024 * 1024 + 64 * 1024
MAX_SOURCE_BYTES = 8 * 1024 * 1024
MAX_OSV_BYTES = 1024 * 1024
MAX_RESPONSE_BYTES = 64 * 1024


class SumdbTransport(Protocol):
    def fetch_verified_release(
        self,
        verifier: GoSumdbVerifier,
        module_path: object,
        version: object,
    ) -> VerifiedGoSumdbRelease: ...


def _canonical_json(value: object) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def _canonical_sha256(value: object) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _exact_keys(value: object, keys: set[str]) -> bool:
    return isinstance(value, dict) and set(value) == keys


def _text(value: object, maximum: int) -> bool:
    return (
        isinstance(value, str)
        and 0 < len(value) <= maximum
        and value == value.strip()
        and not any(ord(character) < 32 or ord(character) == 127 for character in value)
    )


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

    current_release = stable_go_version(candidate.get("currentVersion")) if isinstance(candidate, dict) else None
    target_release = stable_go_version(candidate.get("targetVersion")) if isinstance(candidate, dict) else None
    if (
        not _exact_keys(claim, {"id", "token", "expiresAt"})
        or not UUID.fullmatch(str(claim.get("id", "")))
        or not _text(claim.get("token"), 256)
        or not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", str(claim.get("token", "")))
        or not _text(claim.get("expiresAt"), 64)
    ):
        raise DescriptorError("claim identity is invalid")
    if (
        not _exact_keys(binding, {
            "workspaceId", "recordId", "repo", "prNumber", "headSha", "headCycleId",
            "authorityGeneration", "acceptanceContract", "compiledPack",
        })
        or binding.get("workspaceId") != workspace_id
        or not UUID.fullmatch(str(binding.get("recordId", "")))
        or not REPO.fullmatch(str(binding.get("repo", "")))
        or not isinstance(binding.get("prNumber"), int)
        or binding["prNumber"] <= 0
        or not SHA1.fullmatch(str(binding.get("headSha", "")))
        or not UUID.fullmatch(str(binding.get("headCycleId", "")))
        or not isinstance(binding.get("authorityGeneration"), int)
        or binding["authorityGeneration"] < 0
    ):
        raise DescriptorError("Record/head binding is invalid")
    contract = binding["acceptanceContract"]
    pack = binding["compiledPack"]
    if (
        not _exact_keys(contract, {"id", "version", "sha256"})
        or not UUID.fullmatch(str(contract.get("id", "")))
        or not isinstance(contract.get("version"), int)
        or contract["version"] <= 0
        or not SHA256.fullmatch(str(contract.get("sha256", "")))
    ):
        raise DescriptorError("Contract binding is invalid")
    if (
        not _exact_keys(pack, {
            "id", "sha256", "sourceSnapshotId", "sourceCustodyIdentitySha256",
            "compilerVersion", "policyVersion",
        })
        or not UUID.fullmatch(str(pack.get("id", "")))
        or not UUID.fullmatch(str(pack.get("sourceSnapshotId", "")))
        or not SHA256.fullmatch(str(pack.get("sha256", "")))
        or not SHA256.fullmatch(str(pack.get("sourceCustodyIdentitySha256", "")))
        or not _text(pack.get("compilerVersion"), 128)
        or not _text(pack.get("policyVersion"), 128)
    ):
        raise DescriptorError("Context Pack binding is invalid")
    if (
        not _exact_keys(candidate, {
            "identity", "package", "dependencyKind", "specifier", "currentVersion",
            "targetVersion", "proposalFingerprint",
        })
        or candidate.get("identity") != IDENTITY
        or candidate.get("dependencyKind") != "dependencies"
        or candidate.get("specifier") != candidate.get("currentVersion")
        or candidate.get("currentVersion") == candidate.get("targetVersion")
        or validate_go_module_version(candidate.get("package"), candidate.get("currentVersion")) is not None
        or validate_go_module_version(candidate.get("package"), candidate.get("targetVersion")) is not None
        or current_release is None
        or target_release is None
        or current_release[0] != target_release[0]
        or target_release <= current_release
        or not FINGERPRINT.fullmatch(str(candidate.get("proposalFingerprint", "")))
    ):
        raise DescriptorError("Go Modules candidate binding is invalid")
    if not _exact_keys(source, {"manifest", "lockfile", "inventory", "sumdb"}):
        raise DescriptorError("Go source binding is invalid")
    for name, path in (("manifest", "go.mod"), ("lockfile", "go.sum")):
        file = source.get(name)
        if (
            not _exact_keys(file, {"path", "blobSha"})
            or file.get("path") != path
            or not SHA1.fullmatch(str(file.get("blobSha", "")))
        ):
            raise DescriptorError(f"{name} source binding is invalid")
    inventory = source["inventory"]
    if (
        not _exact_keys(inventory, {"receipt", "identitySha256"})
        or not isinstance(inventory.get("receipt"), dict)
        or not SHA256.fullmatch(str(inventory.get("identitySha256", "")))
    ):
        raise DescriptorError("source inventory receipt binding is invalid")
    sumdb = source["sumdb"]
    if (
        not _exact_keys(sumdb, {
            "priorSignedTreeNoteBase64", "priorSignedTreeNoteSha256", "generation",
        })
        or (
            sumdb.get("generation") is not None
            and (not isinstance(sumdb["generation"], int) or sumdb["generation"] < 0)
        )
    ):
        raise DescriptorError("sumdb note custody binding is invalid")
    if sumdb["priorSignedTreeNoteBase64"] is None:
        if sumdb["priorSignedTreeNoteSha256"] is not None or sumdb["generation"] is not None:
            raise DescriptorError("sumdb bootstrap custody is inconsistent")
    elif (
        not _text(sumdb["priorSignedTreeNoteBase64"], 64 * 1024)
        or not SHA256.fullmatch(str(sumdb.get("priorSignedTreeNoteSha256", "")))
        or not isinstance(sumdb["generation"], int)
        or sumdb["generation"] < 0
    ):
        raise DescriptorError("retained sumdb note custody is invalid")
    expected_argv = ["go", "get", f"{candidate['package']}@{candidate['targetVersion']}"]
    if (
        not _exact_keys(operation, {"updateArgv", "authority"})
        or operation.get("updateArgv") != expected_argv
        or operation.get("authority") != "observe_or_refuse_only"
    ):
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
    if (
        not isinstance(payload, dict)
        or not {"type", "encoding", "size", "sha", "content"}.issubset(payload)
        or payload.get("type") != "file"
        or payload.get("encoding") != "base64"
        or payload.get("sha") != expected_blob_sha
        or not isinstance(payload.get("size"), int)
        or isinstance(payload.get("size"), bool)
        or not 0 <= payload["size"] <= MAX_SOURCE_BYTES
        or not isinstance(payload.get("content"), str)
    ):
        raise SourceCustodyError("exact-head source blob custody did not match the descriptor")
    encoded = payload["content"].replace("\r", "").replace("\n", "")
    try:
        content = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError, TypeError) as exc:
        raise SourceCustodyError("exact-head source body was not canonical base64") from exc
    if base64.b64encode(content).decode("ascii") != encoded:
        raise SourceCustodyError("exact-head source body was not canonical base64")
    actual = hashlib.sha1(f"blob {len(content)}\0".encode() + content).hexdigest()
    if len(content) != payload["size"] or actual != expected_blob_sha:
        raise SourceCustodyError("exact-head source blob custody did not match the descriptor")
    return content


def _recompute_source_receipt(
    receipt: Mapping[str, object],
    identity_sha256: str,
    *,
    repository: str,
    head_sha: str,
    go_mod: bytes,
    go_sum: bytes,
) -> tuple[str, ...]:
    try:
        authority = receipt["authority"]
        inventory_payload = receipt["inventory"]
        if not isinstance(authority, Mapping) or not isinstance(inventory_payload, Mapping):
            raise ValueError("receipt sections are malformed")
        if (
            authority.get("repository") != repository
            or authority.get("requestedRef") != head_sha
            or authority.get("commitSha") != head_sha
        ):
            raise ValueError("receipt is not bound to the exact repository head")
        raw_entries = inventory_payload.get("entries")
        if not isinstance(raw_entries, list):
            raise ValueError("receipt inventory is unavailable")
        tree_entries = []
        for entry in raw_entries:
            if not isinstance(entry, Mapping):
                raise ValueError("receipt inventory entry is malformed")
            tree_entries.append({
                "path": entry.get("path"),
                "mode": entry.get("mode"),
                "type": entry.get("type"),
                "sha": entry.get("objectSha"),
            })
        root_tree_sha = authority.get("rootTreeSha")
        validated = validate_go_github_source_inventory(
            repository=repository,
            requested_ref=head_sha,
            commit={"sha": head_sha, "commit": {"tree": {"sha": root_tree_sha}}},
            tree_response={"sha": root_tree_sha, "truncated": False, "tree": tree_entries},
        )
        rebuilt = build_go_github_source_inventory_receipt(
            validated,
            {"go.mod": go_mod, "go.sum": go_sum},
        )
        if (
            rebuilt.identity_sha256 != identity_sha256
            or rebuilt.as_dict() != dict(receipt)
            or receipt.get("identitySha256") != identity_sha256
        ):
            raise ValueError("receipt is not canonical or recomputable")
        return tuple(entry.path for entry in validated.entries)
    except (KeyError, TypeError, ValueError) as exc:
        raise SourceCustodyError("persisted source inventory receipt did not match exact-head source") from exc


def _prior_verifier(sumdb: Mapping[str, object]) -> tuple[GoSumdbVerifier, Optional[bytes]]:
    encoded = sumdb["priorSignedTreeNoteBase64"]
    if encoded is None:
        return GoSumdbVerifier(), None
    try:
        assert isinstance(encoded, str)
        note = base64.b64decode(encoded, validate=True)
    except (AssertionError, binascii.Error, ValueError) as exc:
        raise DescriptorError("retained sumdb note is not canonical base64") from exc
    if base64.b64encode(note).decode("ascii") != encoded:
        raise DescriptorError("retained sumdb note is not canonical base64")
    if hashlib.sha256(note).hexdigest() != sumdb["priorSignedTreeNoteSha256"]:
        raise DescriptorError("retained sumdb note digest does not match custody")
    try:
        return GoSumdbVerifier.from_retained_signed_tree_note(note), note
    except ValueError as exc:
        raise SourceCustodyError("retained sumdb signed note failed pinned-key authentication") from exc


def _go_version_probe(run_command, identity: Mapping[str, str]) -> tuple[str, Optional[str], str]:
    argv = ("go", "version")
    try:
        result = run_command(argv)
    except Exception:
        report = {"kind": "go_version_probe_v1", "version": 1, "argv": list(argv), "outcome": "unavailable"}
        return "unavailable", None, _canonical_sha256(report)
    stdout = result.stdout.strip()
    matched = GO_RUNTIME.fullmatch(stdout)
    version = matched.group(1) if result.returncode == 0 and matched else None
    disposition = "safe" if version is not None else "unsafe"
    report = {
        "kind": "go_version_probe_v1",
        "version": 1,
        "argv": list(argv),
        "returnCode": result.returncode,
        "stdout": stdout[:128],
        "stderrSha256": hashlib.sha256(result.stderr[:1024].encode()).hexdigest(),
        "identity": identity,
        "disposition": disposition,
    }
    return disposition, version, _canonical_sha256(report)


class GoModulesObservationWorker:
    def __init__(
        self,
        config: WorkerConfig,
        *,
        request: HttpRequest,
        run_command,
        sumdb_transport: SumdbTransport | None = None,
    ) -> None:
        parsed = urllib.parse.urlsplit(config.console_url)
        loopback_http = parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        if (
            (parsed.scheme != "https" and not loopback_http)
            or not parsed.netloc
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or not UUID.fullmatch(config.workspace_id)
            or not _text(config.workspace_api_key, 4096)
            or not _text(config.worker_id, 128)
        ):
            raise ValueError("worker configuration is invalid")
        self.config = WorkerConfig(
            config.console_url.rstrip("/"),
            config.workspace_api_key,
            config.workspace_id.lower(),
            config.worker_id,
        )
        self.request = request
        self.run_command = run_command
        self.sumdb_transport = sumdb_transport or GoSumdbTransport()

    def run_once(self) -> str:
        claim_url = self.config.console_url + "/api/v1/runner/acceptance-dependency-observation-work/claim"
        claim_body = json.dumps({
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
            "user-agent": "AgentRail-go-modules-evidence/1",
        }
        contents: dict[str, bytes] = {}
        for name in ("manifest", "lockfile"):
            file = source[name]
            quoted_path = urllib.parse.quote(file["path"], safe="/")
            url = (
                f"https://api.github.com/repos/{binding['repo']}/contents/{quoted_path}"
                f"?ref={binding['headSha']}"
            )
            contents[name] = _decode_github_file(
                self.request("GET", url, github_headers, None, MAX_SOURCE_BYTES),
                url,
                file["blobSha"],
            )

        supplied_paths = _recompute_source_receipt(
            source["inventory"]["receipt"],
            source["inventory"]["identitySha256"],
            repository=binding["repo"],
            head_sha=binding["headSha"],
            go_mod=contents["manifest"],
            go_sum=contents["lockfile"],
        )
        try:
            files = parse_go_module_files(
                contents["manifest"].decode("utf-8"),
                contents["lockfile"].decode("utf-8"),
                supplied_paths=supplied_paths,
            )
        except (UnicodeDecodeError, ValueError) as exc:
            raise SourceCustodyError("exact-head Go module files do not satisfy the bounded profile") from exc
        requirement = files.requirements.get(candidate["package"])
        if requirement is None or requirement.version != candidate["currentVersion"]:
            raise SourceCustodyError("exact-head go.mod candidate does not match the claimed release")

        runtime_disposition, runtime_version, runtime_hash = _go_version_probe(
            self.run_command,
            IDENTITY,
        )
        verifier, prior_note = _prior_verifier(source["sumdb"])
        try:
            current = self.sumdb_transport.fetch_verified_release(
                verifier, candidate["package"], candidate["currentVersion"],
            )
            self._release_matches(current, candidate["package"], candidate["currentVersion"])
            if (
                files.sums.get((candidate["package"], candidate["currentVersion"], "module"))
                != current.lookup.module_h1
                or files.sums.get((candidate["package"], candidate["currentVersion"], "go.mod"))
                != current.lookup.go_mod_h1
            ):
                raise SourceCustodyError("exact-head go.sum does not match pinned-key current checksum evidence")
            target = self.sumdb_transport.fetch_verified_release(
                verifier, candidate["package"], candidate["targetVersion"],
            )
            self._release_matches(target, candidate["package"], candidate["targetVersion"])
        except SourceCustodyError:
            raise
        except ValueError as exc:
            raise SourceCustodyError("sumdb pinned-key timeline or release proof was refused") from exc
        successor = verifier.tree_head
        if successor is None:
            raise SourceCustodyError("sumdb verifier produced no authenticated successor note")
        successor_note = successor.signed_note_bytes
        if prior_note is not None and hashlib.sha256(successor_note).digest() == hashlib.sha256(prior_note).digest():
            raise SourceCustodyError("sumdb timeline did not advance beyond retained custody")

        security_disposition, security_hash = self._osv(candidate)
        integrity = {
            "kind": "go_sumdb_pinned_key_release_pair_v1",
            "current": self._release_evidence(current),
            "target": self._release_evidence(target),
            "successorSignedTreeNoteSha256": hashlib.sha256(successor_note).hexdigest(),
            "gossipVerified": False,
            "witnessVerified": False,
        }
        lock_hash = _canonical_sha256({
            "kind": "go_exact_head_mod_sum_and_sumdb_v1",
            "headSha": binding["headSha"],
            "manifest": {
                **source["manifest"],
                "contentSha256": hashlib.sha256(contents["manifest"]).hexdigest(),
            },
            "lockfile": {
                **source["lockfile"],
                "contentSha256": hashlib.sha256(contents["lockfile"]).hexdigest(),
            },
            "sourceInventoryReceiptSha256": source["inventory"]["identitySha256"],
            "integrity": integrity,
        })
        manager_hash = _canonical_sha256({
            "kind": "go_modules_manager_evidence_v1",
            "runtimeEvidenceSha256": runtime_hash,
            "profile": GO_MODULES_OBSERVATION_PROFILE,
            "integrity": integrity,
        })
        evidence = {
            "workspaceId": binding["workspaceId"],
            "recordId": binding["recordId"],
            "compiledPackId": binding["compiledPack"]["id"],
            "candidate": {key: candidate[key] for key in (
                "identity", "package", "dependencyKind", "specifier", "currentVersion", "targetVersion",
            )},
            "runtime": {
                "identity": IDENTITY,
                "disposition": runtime_disposition,
                "version": runtime_version,
                "evidenceSha256": runtime_hash,
            },
            "packageManager": {
                "disposition": "safe" if runtime_disposition == "safe" else runtime_disposition,
                "name": "go",
                "version": runtime_version,
                "profile": GO_MODULES_OBSERVATION_PROFILE,
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
                "reference": f"osv:Go:{candidate['package']}@{candidate['targetVersion']}",
                "reportSha256": security_hash,
            },
            "sumdbCustody": {
                "priorGeneration": source["sumdb"]["generation"],
                "priorSignedTreeNoteSha256": (
                    hashlib.sha256(prior_note).hexdigest() if prior_note is not None else None
                ),
                "successorSignedTreeNoteBase64": base64.b64encode(successor_note).decode("ascii"),
                "successorSignedTreeNoteSha256": hashlib.sha256(successor_note).hexdigest(),
                "sourceInventoryReceiptSha256": source["inventory"]["identitySha256"],
            },
        }
        observation_url = self.config.console_url + "/api/v1/runner/acceptance-dependency-observations"
        headers = self._console_headers()
        headers["x-agentrail-dependency-claim-token"] = descriptor["claim"]["token"]
        posted = self.request(
            "POST",
            observation_url,
            headers,
            json.dumps(evidence, separators=(",", ":")).encode(),
            MAX_RESPONSE_BYTES,
        )
        if posted.status not in {200, 201} or posted.final_url != observation_url:
            raise WorkerError(f"dependency observation post failed with status {posted.status}")
        return "posted"

    @staticmethod
    def _release_matches(release: VerifiedGoSumdbRelease, module_path: str, version: str) -> None:
        if (
            not isinstance(release, VerifiedGoSumdbRelease)
            or release.lookup.module_path != module_path
            or release.lookup.version != version
            or release.gossip_verified
            or release.witness_verified
        ):
            raise SourceCustodyError("sumdb release proof did not match the exact candidate")

    @staticmethod
    def _release_evidence(release: VerifiedGoSumdbRelease) -> dict[str, object]:
        return {
            "module": release.lookup.module_path,
            "version": release.lookup.version,
            "recordNumber": release.lookup.record_number,
            "recordTextSha256": hashlib.sha256(release.lookup.record_text_bytes).hexdigest(),
            "moduleH1": release.lookup.module_h1,
            "goModH1": release.lookup.go_mod_h1,
            "treeSize": release.lookup.tree_size,
            "treeHash": release.lookup.tree_hash,
            "timeline": release.timeline,
        }

    def _console_headers(self) -> dict[str, str]:
        return {
            "authorization": f"Bearer {self.config.workspace_api_key}",
            "content-type": "application/json",
            "user-agent": "AgentRail-go-modules-evidence/1",
        }

    def _osv(self, candidate: Mapping[str, object]) -> tuple[str, str]:
        query = {
            "package": {"ecosystem": "Go", "name": candidate["package"]},
            "version": candidate["targetVersion"],
        }
        url = "https://api.osv.dev/v1/query"
        response = self.request(
            "POST",
            url,
            {"content-type": "application/json", "user-agent": "AgentRail-go-modules-evidence/1"},
            json.dumps(query, separators=(",", ":")).encode(),
            MAX_OSV_BYTES,
        )
        if response.status != 200 or response.final_url != url or len(response.body) > MAX_OSV_BYTES:
            report = {"kind": "osv_go_query_v1", "query": query, "outcome": "unavailable"}
            return "unavailable", _canonical_sha256(report)
        try:
            payload = json.loads(response.body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            report = {"kind": "osv_go_query_v1", "query": query, "outcome": "ambiguous"}
            return "ambiguous", _canonical_sha256(report)
        vulns = payload.get("vulns", []) if isinstance(payload, dict) else None
        if not isinstance(vulns, list) or not all(
            isinstance(item, dict) and _text(item.get("id"), 256) for item in vulns
        ):
            report = {"kind": "osv_go_query_v1", "query": query, "outcome": "ambiguous"}
            return "ambiguous", _canonical_sha256(report)
        ids = sorted({item["id"] for item in vulns})
        disposition = "affected" if ids else "clear"
        report = {
            "kind": "osv_go_query_v1",
            "query": query,
            "outcome": disposition,
            "vulnerabilityIds": ids,
        }
        return disposition, _canonical_sha256(report)


def bounded_go_version_command(argv: tuple[str, ...]) -> CommandResult:
    """Run the sole authorized local process with network/toolchain downloads off."""
    if argv != ("go", "version"):
        raise ValueError("only the Go version probe is authorized")
    environment = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "CI": "1",
        "NO_COLOR": "1",
        "GOTOOLCHAIN": "local",
        "GOPROXY": "off",
        "GOSUMDB": "off",
        "GOENV": "off",
        "GOWORK": "off",
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
    "GoModulesObservationWorker",
    "HttpResponse",
    "SourceCustodyError",
    "WorkerConfig",
    "WorkerError",
    "bounded_go_version_command",
    "bounded_http_request",
]
