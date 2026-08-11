"""Recomputable, source-only inventory custody for dependency observations.

This module owns no evidence, approval, Pack, or execution capability.  It
turns one already authenticated GitHub App exact-tree read into a bounded,
source-free receipt whose hashes can be recomputed from the retained identity
and content-addressed Git objects.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import re
from typing import Any, Mapping, Sequence, Tuple

from agentrail.dependencies.go_modules import (
    GO_GITHUB_TREE_MAX_ENTRIES,
    GO_MOD_MAX_BYTES,
    GO_SUM_MAX_BYTES,
    go_snapshot_path_refusal,
)
from agentrail.dependencies.strict_json import loads_strict_json


GO_GITHUB_SOURCE_INVENTORY_PROFILE = "go_github_exact_tree_source_inventory_v1"
SOURCE_INVENTORY_RECEIPT_KIND = "github_exact_tree_dependency_source_inventory"
SOURCE_INVENTORY_RECEIPT_SCHEMA_VERSION = 1
GO_SOURCE_INVENTORY_MAX_PATH_BYTES = 4 * 1024
GO_SOURCE_INVENTORY_MAX_TOTAL_PATH_BYTES = 8 * 1024 * 1024
GO_SOURCE_INVENTORY_MAX_RECEIPT_BYTES = 16 * 1024 * 1024

_GITHUB_REPOSITORY = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$"
)
_LOWER_HEX = re.compile(r"^[0-9a-f]+$")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_ENTRY_MODE = {
    "blob": frozenset(("100644", "100755")),
    "tree": frozenset(("040000",)),
}


def _canonical_json(value: object) -> str:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    except (TypeError, ValueError, UnicodeEncodeError) as exc:
        raise ValueError("source inventory receipt is not canonical UTF-8 JSON") from exc


def _sha256_json(value: object) -> str:
    try:
        encoded = _canonical_json(value).encode("utf-8")
    except UnicodeEncodeError as exc:
        raise ValueError("source inventory receipt contains invalid Unicode") from exc
    return hashlib.sha256(encoded).hexdigest()


def _exact_object_sha(value: object, *, label: str, hex_length: int) -> str:
    if (
        not isinstance(value, str)
        or len(value) != hex_length
        or _LOWER_HEX.fullmatch(value) is None
    ):
        raise ValueError(f"{label} is not an exact lowercase Git object SHA")
    return value


def _safe_repository(repository: object) -> str:
    if not isinstance(repository, str) or _GITHUB_REPOSITORY.fullmatch(repository) is None:
        raise ValueError("GitHub repository must be an exact owner/name slug")
    owner, name = repository.split("/", 1)
    if owner in (".", "..") or name in (".", ".."):
        raise ValueError("GitHub repository must be an exact owner/name slug")
    return repository


def validate_github_repository_slug(repository: object) -> str:
    """Return one bounded owner/name slug before it is interpolated into a URL."""

    return _safe_repository(repository)


def validate_github_requested_ref(requested_ref: object) -> str:
    """Return bounded ref text before it is interpolated into a bearer request."""

    return _safe_ref(requested_ref)


def _safe_ref(requested_ref: object) -> str:
    if not isinstance(requested_ref, str) or not requested_ref or _CONTROL.search(requested_ref):
        raise ValueError("GitHub requested ref is not bounded text")
    try:
        encoded = requested_ref.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise ValueError("GitHub requested ref is not valid UTF-8") from exc
    if len(encoded) > 1024:
        raise ValueError("GitHub requested ref exceeds the byte limit")
    return requested_ref


def _safe_path(path: object) -> Tuple[str, int]:
    if (
        not isinstance(path, str)
        or not path
        or path.startswith("/")
        or path.endswith("/")
        or "\\" in path
        or _CONTROL.search(path)
        or any(part in ("", ".", "..") for part in path.split("/"))
    ):
        raise ValueError("GitHub Go inventory contains a non-canonical path")
    if not path.isascii():
        raise ValueError("GitHub Go inventory paths must be ASCII")
    try:
        encoded = path.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise ValueError("GitHub Go inventory path is not valid UTF-8") from exc
    if len(encoded) > GO_SOURCE_INVENTORY_MAX_PATH_BYTES:
        raise ValueError("GitHub Go inventory path exceeds the byte limit")
    return path, len(encoded)


def git_blob_object_id(content: bytes, *, hash_hex_length: int) -> str:
    """Return the Git blob object ID for exact bytes and repository hash family."""

    if not isinstance(content, bytes):
        raise ValueError("Git blob content must be bytes")
    if hash_hex_length == 40:
        digest = hashlib.sha1()  # noqa: S324 - Git SHA-1 object identity, not security.
    elif hash_hex_length == 64:
        digest = hashlib.sha256()
    else:
        raise ValueError("Git object hash family is unsupported")
    digest.update(f"blob {len(content)}\0".encode("ascii"))
    digest.update(content)
    return digest.hexdigest()


@dataclass(frozen=True)
class GoGithubInventoryEntry:
    path: str
    mode: str
    kind: str
    object_sha: str

    def as_dict(self) -> dict[str, object]:
        return {
            "path": self.path,
            "mode": self.mode,
            "type": self.kind,
            "objectSha": self.object_sha,
        }


@dataclass(frozen=True)
class ValidatedGoGithubInventory:
    repository: str
    requested_ref: str
    commit_sha: str
    root_tree_sha: str
    entries: Tuple[GoGithubInventoryEntry, ...]

    def required_blob_sha(self, path: str) -> str | None:
        """Derive a root blob identity from the immutable validated entries."""

        for entry in self.entries:
            if entry.path == path and entry.kind == "blob" and entry.mode == "100644":
                return entry.object_sha
        return None


@dataclass(frozen=True)
class DependencySourceInventoryReceipt:
    """Immutable canonical receipt text plus its self-declared identity."""

    canonical_json: str
    identity_sha256: str

    def as_dict(self) -> dict[str, Any]:
        value = loads_strict_json(self.canonical_json, document="source inventory receipt")
        if not isinstance(value, dict):  # pragma: no cover - factory invariant
            raise ValueError("source inventory receipt is not an object")
        return value


def validate_go_github_source_inventory(
    *,
    repository: object,
    requested_ref: object,
    commit: object,
    tree_response: object,
) -> ValidatedGoGithubInventory:
    """Validate one complete, exact GitHub recursive tree before file reads."""

    repository_value = _safe_repository(repository)
    requested_ref_value = _safe_ref(requested_ref)
    if not isinstance(commit, Mapping):
        raise ValueError("GitHub did not return an exact Go commit")
    commit_sha_raw = commit.get("sha")
    if not isinstance(commit_sha_raw, str) or len(commit_sha_raw) not in (40, 64):
        raise ValueError("GitHub did not return an exact Go commit SHA")
    commit_sha = _exact_object_sha(
        commit_sha_raw,
        label="GitHub Go commit SHA",
        hex_length=len(commit_sha_raw),
    )
    commit_data = commit.get("commit")
    tree_data = commit_data.get("tree") if isinstance(commit_data, Mapping) else None
    tree_sha_raw = tree_data.get("sha") if isinstance(tree_data, Mapping) else None
    if not isinstance(tree_sha_raw, str) or len(tree_sha_raw) not in (40, 64):
        raise ValueError("GitHub did not return the exact Go root tree SHA")
    if len(tree_sha_raw) != len(commit_sha):
        raise ValueError("GitHub Go commit and tree use different hash families")
    tree_sha = _exact_object_sha(
        tree_sha_raw,
        label="GitHub Go root tree SHA",
        hex_length=len(commit_sha),
    )

    if not isinstance(tree_response, Mapping) or tree_response.get("sha") != tree_sha:
        raise ValueError("GitHub Go inventory is not bound to the exact root tree SHA")
    if tree_response.get("truncated") is not False:
        raise ValueError("GitHub Go recursive inventory is truncated")
    raw_entries = tree_response.get("tree")
    if not isinstance(raw_entries, list):
        raise ValueError("GitHub did not return a recursive Go inventory")
    if len(raw_entries) >= GO_GITHUB_TREE_MAX_ENTRIES:
        raise ValueError("GitHub Go recursive inventory exceeds the entry limit")

    total_path_bytes = 0
    entries = []
    folded_paths: dict[str, str] = {}
    for raw_entry in raw_entries:
        if not isinstance(raw_entry, Mapping):
            raise ValueError("GitHub Go recursive inventory contains a malformed entry")
        kind = raw_entry.get("type")
        if kind == "commit":
            raise ValueError("GitHub Go recursive inventory contains an opaque submodule")
        if kind not in _ENTRY_MODE:
            raise ValueError("GitHub Go recursive inventory contains a malformed entry type")
        mode = raw_entry.get("mode")
        if not isinstance(mode, str) or mode not in _ENTRY_MODE[kind]:
            raise ValueError("GitHub Go recursive inventory contains an unsupported entry mode")
        path, path_bytes = _safe_path(raw_entry.get("path"))
        total_path_bytes += path_bytes
        if total_path_bytes > GO_SOURCE_INVENTORY_MAX_TOTAL_PATH_BYTES:
            raise ValueError("GitHub Go recursive inventory exceeds the path byte limit")
        folded = path.casefold()
        previous = folded_paths.get(folded)
        if previous is not None:
            raise ValueError(
                "GitHub Go recursive inventory contains colliding paths: "
                f"{previous} and {path}"
            )
        folded_paths[folded] = path
        object_sha_raw = raw_entry.get("sha")
        if not isinstance(object_sha_raw, str) or len(object_sha_raw) != len(commit_sha):
            raise ValueError("GitHub Go inventory object SHA uses a different hash family")
        object_sha = _exact_object_sha(
            object_sha_raw,
            label="GitHub Go inventory object SHA",
            hex_length=len(commit_sha),
        )
        entries.append(GoGithubInventoryEntry(path, mode, kind, object_sha))

    entries.sort(key=lambda entry: entry.path.encode("utf-8"))
    paths = tuple(entry.path for entry in entries)
    refusal = go_snapshot_path_refusal(paths)
    if refusal is not None:
        raise ValueError(refusal)

    entries_by_path = {entry.path: entry for entry in entries}
    for required in ("go.mod", "go.sum"):
        entry = entries_by_path.get(required)
        if entry is None or entry.kind != "blob" or entry.mode != "100644":
            raise ValueError(
                f"GitHub Go recursive inventory has no exact regular root {required} blob"
            )

    return ValidatedGoGithubInventory(
        repository=repository_value,
        requested_ref=requested_ref_value,
        commit_sha=commit_sha,
        root_tree_sha=tree_sha,
        entries=tuple(entries),
    )


def build_go_github_source_inventory_receipt(
    inventory: ValidatedGoGithubInventory,
    required_file_bytes: Mapping[str, bytes],
) -> DependencySourceInventoryReceipt:
    """Bind exact root bytes to the validated tree and emit no source text."""

    if set(required_file_bytes) != {"go.mod", "go.sum"}:
        raise ValueError("Go source inventory receipt requires exact go.mod and go.sum bytes")
    limits = {"go.mod": GO_MOD_MAX_BYTES, "go.sum": GO_SUM_MAX_BYTES}
    required_files = []
    entries_by_path = {entry.path: entry for entry in inventory.entries}
    for path in ("go.mod", "go.sum"):
        content = required_file_bytes[path]
        if not isinstance(content, bytes):
            raise ValueError(f"{path} receipt content must be bytes")
        if len(content) > limits[path]:
            raise ValueError(f"{path} exceeds the receipt byte limit")
        root_entry = entries_by_path.get(path)
        if root_entry is None or root_entry.kind != "blob" or root_entry.mode != "100644":
            raise ValueError(f"source inventory has no exact regular root {path} blob")
        expected_blob_sha = root_entry.object_sha
        actual_blob_sha = git_blob_object_id(
            content,
            hash_hex_length=len(expected_blob_sha),
        )
        if actual_blob_sha != expected_blob_sha:
            raise ValueError(
                f"GitHub Go root {path} does not match its local Git blob identity"
            )
        required_files.append({
            "path": path,
            "mode": "100644",
            "blobSha": expected_blob_sha,
            "byteCount": len(content),
            "contentSha256": hashlib.sha256(content).hexdigest(),
        })

    entry_payload = [entry.as_dict() for entry in inventory.entries]
    receipt_without_identity: dict[str, object] = {
        "kind": SOURCE_INVENTORY_RECEIPT_KIND,
        "schemaVersion": SOURCE_INVENTORY_RECEIPT_SCHEMA_VERSION,
        "identity": {
            "ecosystem": "go",
            "manager": "go-modules",
            "profile": GO_GITHUB_SOURCE_INVENTORY_PROFILE,
        },
        "authority": {
            "provider": "github",
            "method": "github_app_installation_api",
            "apiOrigin": "https://api.github.com",
            "repository": inventory.repository,
            "requestedRef": inventory.requested_ref,
            "commitSha": inventory.commit_sha,
            "rootTreeSha": inventory.root_tree_sha,
        },
        "inventory": {
            "recursive": True,
            "truncated": False,
            "entryCount": len(entry_payload),
            "entries": entry_payload,
            "entriesSha256": _sha256_json(entry_payload),
        },
        "requiredFiles": required_files,
        "policy": {"name": "go_root_source_inventory_v1", "result": "admitted"},
    }
    identity_sha256 = _sha256_json(receipt_without_identity)
    receipt = {**receipt_without_identity, "identitySha256": identity_sha256}
    canonical = _canonical_json(receipt)
    try:
        byte_count = len(canonical.encode("utf-8"))
    except UnicodeEncodeError as exc:  # pragma: no cover - paths validated above
        raise ValueError("source inventory receipt is not valid UTF-8") from exc
    if byte_count > GO_SOURCE_INVENTORY_MAX_RECEIPT_BYTES:
        raise ValueError("Go source inventory receipt exceeds the byte limit")
    return DependencySourceInventoryReceipt(canonical, identity_sha256)


__all__ = [
    "DependencySourceInventoryReceipt",
    "GoGithubInventoryEntry",
    "GO_GITHUB_SOURCE_INVENTORY_PROFILE",
    "SOURCE_INVENTORY_RECEIPT_KIND",
    "SOURCE_INVENTORY_RECEIPT_SCHEMA_VERSION",
    "ValidatedGoGithubInventory",
    "build_go_github_source_inventory_receipt",
    "git_blob_object_id",
    "validate_github_repository_slug",
    "validate_github_requested_ref",
    "validate_go_github_source_inventory",
]
