"""Deterministic, non-authoritative verification of public Go checksum records.

This module verifies supplied, retained ``sum.golang.org`` proof material.  Its
v1 compatibility subset accepts the current official shape: exactly one pinned
signature and exactly three signed tree lines.  Although Go's general note and
tree readers accept co-signatures and future extension lines, v1 fails those
closed pending a later verifier version.  It does not fetch or persist a
receipt, authenticate Go proxy metadata or artifacts, invoke Go, grant an
adapter profile, or create evidence, Pack, approval, delivery, or execution
authority.
"""

from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass
import hashlib
import hmac
import re

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from agentrail.dependencies.go_modules import validate_go_module_version


GO_SUMDB_ORIGIN = "https://sum.golang.org"
GO_SUMDB_NAME = "sum.golang.org"
GO_SUMDB_VERIFIER_KEY = (
    "sum.golang.org+033de0ae+"
    "Ac4zctda0e5eza+HJyk9SxEdh+s3Ux18htTTAD8OuAn8"
)
GO_SUMDB_LOOKUP_MAX_BYTES = 1024 * 1024
GO_SUMDB_NOTE_MAX_BYTES = 1024 * 1024
GO_SUMDB_MAX_PROOF_HASHES = 64
GO_SUMDB_MAX_TREE_SIZE = (1 << 63) - 1

_DECIMAL = re.compile(r"^(?:0|[1-9][0-9]*)$")
_H1 = re.compile(r"^h1:[A-Za-z0-9+/]{43}=$")
_HASH_BASE64 = re.compile(r"^[A-Za-z0-9+/]{43}=$")
_TREE_PREFIX = "go.sum database tree"
_NOTE_SIGNATURE_PREFIX = "— "


def _decode_canonical_base64(value: str, *, label: str) -> bytes:
    try:
        decoded = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError(f"{label} is not canonical base64") from exc
    if base64.b64encode(decoded).decode("ascii") != value:
        raise ValueError(f"{label} is not canonical base64")
    return decoded


def _canonical_h1(value: str, *, label: str) -> str:
    if _H1.fullmatch(value) is None:
        raise ValueError(f"{label} is not a canonical Go h1 checksum")
    decoded = _decode_canonical_base64(value[3:], label=label)
    if len(decoded) != 32:
        raise ValueError(f"{label} is not a canonical Go h1 checksum")
    return value


def _bounded_decimal(value: str, *, label: str) -> int:
    if (
        _DECIMAL.fullmatch(value) is None
        or len(value) > 19
        or int(value) > GO_SUMDB_MAX_TREE_SIZE
    ):
        raise ValueError(f"{label} is malformed")
    return int(value)


def _official_verifier() -> tuple[int, bytes]:
    name, key_hash_text, encoded_key = GO_SUMDB_VERIFIER_KEY.split("+", 2)
    if name != GO_SUMDB_NAME or len(key_hash_text) != 8:
        raise RuntimeError("the pinned Go checksum database verifier is malformed")
    key_hash = int(key_hash_text, 16)
    key = _decode_canonical_base64(encoded_key, label="pinned verifier key")
    if len(key) != 33 or key[0] != 1:
        raise RuntimeError("the pinned Go checksum database verifier is unsupported")
    actual_hash = int.from_bytes(
        hashlib.sha256(name.encode("utf-8") + b"\n" + key).digest()[:4],
        "big",
    )
    if actual_hash != key_hash:
        raise RuntimeError("the pinned Go checksum database verifier hash is invalid")
    return key_hash, key[1:]


@dataclass(frozen=True)
class SignedGoSumdbTreeHead:
    """One official-key-authenticated tree head with its exact signed bytes."""

    signed_note_bytes: bytes
    signed_text_bytes: bytes
    tree_size: int
    tree_hash_bytes: bytes

    @property
    def tree_hash(self) -> str:
        return base64.b64encode(self.tree_hash_bytes).decode("ascii")


@dataclass(frozen=True)
class SignedGoSumdbLookup:
    """One exact lookup record paired with an authenticated signed tree head."""

    module_path: str
    version: str
    record_number: int
    record_text_bytes: bytes
    module_h1: str
    go_mod_h1: str
    tree_head: SignedGoSumdbTreeHead

    @property
    def signed_tree_note_bytes(self) -> bytes:
        return self.tree_head.signed_note_bytes

    @property
    def tree_size(self) -> int:
        return self.tree_head.tree_size

    @property
    def tree_hash(self) -> str:
        return self.tree_head.tree_hash


@dataclass(frozen=True)
class VerifiedGoSumdbRelease:
    """An exact record authenticated in one pinned-key sumdb timeline."""

    lookup: SignedGoSumdbLookup
    timeline: str
    gossip_verified: bool = False
    witness_verified: bool = False


def _proof_hashes(value: object, *, label: str) -> tuple[bytes, ...]:
    if not isinstance(value, (list, tuple)):
        raise ValueError(f"{label} must be a bounded list or tuple")
    if len(value) > GO_SUMDB_MAX_PROOF_HASHES:
        raise ValueError(f"{label} exceeds the hash limit")
    hashes = []
    for item in value:
        if (
            not isinstance(item, str)
            or len(item) != 44
            or not item.isascii()
            or _HASH_BASE64.fullmatch(item) is None
        ):
            raise ValueError(f"{label} contains a malformed hash")
        decoded = _decode_canonical_base64(item, label=f"{label} hash")
        if len(decoded) != 32:
            raise ValueError(f"{label} contains a malformed hash")
        hashes.append(decoded)
    return tuple(hashes)


def _node_hash(left: bytes, right: bytes) -> bytes:
    return hashlib.sha256(b"\x01" + left + right).digest()


def _maximum_power_of_two_below(value: int) -> int:
    if value <= 1:  # pragma: no cover - caller recursion invariant
        raise ValueError("Go checksum database proof math is invalid")
    return 1 << ((value - 1).bit_length() - 1)


def _run_record_proof(
    proof: tuple[bytes, ...],
    *,
    low: int,
    high: int,
    record_number: int,
    leaf_hash: bytes,
) -> bytes:
    if low + 1 == high:
        if proof:
            raise ValueError("Go checksum database inclusion proof has extra hashes")
        return leaf_hash
    if not proof:
        raise ValueError("Go checksum database inclusion proof is incomplete")
    width = _maximum_power_of_two_below(high - low)
    if record_number < low + width:
        subtree = _run_record_proof(
            proof[:-1],
            low=low,
            high=low + width,
            record_number=record_number,
            leaf_hash=leaf_hash,
        )
        return _node_hash(subtree, proof[-1])
    subtree = _run_record_proof(
        proof[:-1],
        low=low + width,
        high=high,
        record_number=record_number,
        leaf_hash=leaf_hash,
    )
    return _node_hash(proof[-1], subtree)


def _run_tree_proof(
    proof: tuple[bytes, ...],
    *,
    low: int,
    high: int,
    old_size: int,
    old_hash: bytes,
) -> tuple[bytes, bytes]:
    if old_size == high:
        if low == 0:
            if proof:
                raise ValueError("Go checksum database consistency proof has extra hashes")
            return old_hash, old_hash
        if len(proof) != 1:
            raise ValueError("Go checksum database consistency proof is malformed")
        return proof[0], proof[0]
    if not proof:
        raise ValueError("Go checksum database consistency proof is incomplete")
    width = _maximum_power_of_two_below(high - low)
    if old_size <= low + width:
        implied_old, implied_new = _run_tree_proof(
            proof[:-1],
            low=low,
            high=low + width,
            old_size=old_size,
            old_hash=old_hash,
        )
        return implied_old, _node_hash(implied_new, proof[-1])
    implied_old, implied_new = _run_tree_proof(
        proof[:-1],
        low=low + width,
        high=high,
        old_size=old_size,
        old_hash=old_hash,
    )
    return (
        _node_hash(proof[-1], implied_old),
        _node_hash(proof[-1], implied_new),
    )


def _parse_tree_text(signed_text: str) -> tuple[int, bytes]:
    lines = signed_text.splitlines()
    if (
        "\r" in signed_text
        or not signed_text.endswith("\n")
        or len(lines) != 3
        or lines[0] != _TREE_PREFIX
    ):
        raise ValueError("Go checksum database tree head is malformed")
    tree_size = _bounded_decimal(
        lines[1],
        label="Go checksum database tree head",
    )
    tree_hash_bytes = _decode_canonical_base64(
        lines[2],
        label="Go checksum database tree hash",
    )
    if tree_size < 1 or len(tree_hash_bytes) != 32:
        raise ValueError("Go checksum database tree head is malformed")
    return tree_size, tree_hash_bytes


def _parse_signed_tree_note(note_bytes: bytes) -> SignedGoSumdbTreeHead:
    try:
        note = note_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("Go checksum database tree note is not UTF-8") from exc
    if "\r" in note or not note.endswith("\n"):
        raise ValueError("Go checksum database tree note is not canonical text")
    text, separator, signature_block = note.rpartition("\n\n")
    if not separator or not text or not signature_block:
        raise ValueError("Go checksum database tree note is malformed")
    signed_text = text + "\n"
    signature_lines = signature_block.splitlines()
    if len(signature_lines) != 1:
        raise ValueError("Go checksum database tree note must have one signature")
    signature_line = signature_lines[0]
    expected_prefix = f"{_NOTE_SIGNATURE_PREFIX}{GO_SUMDB_NAME} "
    if not signature_line.startswith(expected_prefix):
        raise ValueError("Go checksum database tree note is not signed by the pinned authority")
    encoded_signature = signature_line[len(expected_prefix) :]
    signature = _decode_canonical_base64(
        encoded_signature,
        label="Go checksum database tree signature",
    )
    expected_key_hash, public_key = _official_verifier()
    if len(signature) != 68 or int.from_bytes(signature[:4], "big") != expected_key_hash:
        raise ValueError("Go checksum database tree signature uses the wrong key")
    try:
        Ed25519PublicKey.from_public_bytes(public_key).verify(
            signature[4:],
            signed_text.encode("utf-8"),
        )
    except (InvalidSignature, ValueError) as exc:
        raise ValueError("Go checksum database tree signature is invalid") from exc

    tree_size, tree_hash_bytes = _parse_tree_text(signed_text)
    return SignedGoSumdbTreeHead(
        signed_note_bytes=note_bytes,
        signed_text_bytes=signed_text.encode("utf-8"),
        tree_size=tree_size,
        tree_hash_bytes=tree_hash_bytes,
    )


def parse_signed_go_sumdb_lookup(
    response: object,
    *,
    module_path: object,
    version: object,
) -> SignedGoSumdbLookup:
    """Parse one exact requested record and verify its signed tree head.

    V1 accepts exactly one pinned signature and exactly three signed tree
    lines.  Co-signed or future-extended notes fail closed.  The record is not
    yet proven included in that tree; callers must verify an inclusion proof
    before using the returned checksum lines as custody.
    """

    if not isinstance(response, bytes):
        raise ValueError("Go checksum database lookup response must be bytes")
    if len(response) > GO_SUMDB_LOOKUP_MAX_BYTES:
        raise ValueError("Go checksum database lookup response exceeds the byte limit")
    if not isinstance(module_path, str) or not isinstance(version, str):
        raise ValueError("Go checksum database lookup identity is malformed")
    version_error = validate_go_module_version(module_path, version)
    if version_error is not None:
        raise ValueError(version_error)
    try:
        text = response.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("Go checksum database lookup response is not UTF-8") from exc
    if "\r" in text or "\x00" in text:
        raise ValueError("Go checksum database lookup response is not canonical text")

    record_block_bytes, separator, signed_tree_note_bytes = response.partition(b"\n\n")
    if not separator or not record_block_bytes or not signed_tree_note_bytes:
        raise ValueError("Go checksum database lookup response is malformed")
    record_block = record_block_bytes.decode("utf-8")
    record_lines = record_block.split("\n")
    if len(record_lines) != 3:
        raise ValueError("Go checksum database lookup record is malformed")
    record_number = _bounded_decimal(
        record_lines[0],
        label="Go checksum database lookup record",
    )
    expected_prefix = f"{module_path} {version} "
    expected_mod_prefix = f"{module_path} {version}/go.mod "
    if not record_lines[1].startswith(expected_prefix) or not record_lines[2].startswith(
        expected_mod_prefix
    ):
        raise ValueError("Go checksum database lookup does not contain the exact requested release")
    module_h1 = _canonical_h1(
        record_lines[1][len(expected_prefix) :],
        label="Go module checksum",
    )
    go_mod_h1 = _canonical_h1(
        record_lines[2][len(expected_mod_prefix) :],
        label="Go go.mod checksum",
    )
    tree_head = _parse_signed_tree_note(signed_tree_note_bytes)
    if record_number >= tree_head.tree_size:
        raise ValueError("Go checksum database record is outside the signed tree")
    _record_number_bytes, record_separator, raw_record = record_block_bytes.partition(b"\n")
    if not record_separator:  # pragma: no cover - established by record_lines above
        raise ValueError("Go checksum database lookup record is malformed")
    record_text_bytes = raw_record + b"\n"
    return SignedGoSumdbLookup(
        module_path=module_path,
        version=version,
        record_number=record_number,
        record_text_bytes=record_text_bytes,
        module_h1=module_h1,
        go_mod_h1=go_mod_h1,
        tree_head=tree_head,
    )


def _authenticate_record_inclusion(
    lookup: SignedGoSumdbLookup,
    inclusion_proof: object,
) -> None:
    proof = _proof_hashes(inclusion_proof, label="Go checksum database inclusion proof")
    record_hash = hashlib.sha256(b"\x00" + lookup.record_text_bytes).digest()
    implied_root = _run_record_proof(
        proof,
        low=0,
        high=lookup.tree_size,
        record_number=lookup.record_number,
        leaf_hash=record_hash,
    )
    if not hmac.compare_digest(implied_root, lookup.tree_head.tree_hash_bytes):
        raise ValueError("Go checksum database inclusion proof does not match the signed tree")


class GoSumdbVerifier:
    """Verify one v1 single-signature, three-tree-line sumdb timeline.

    Co-signed, witnessed, or future-extended checkpoints fail closed even
    though broader Go readers may accept them.  A later verifier version must
    model those formats before they can enter custody.
    """

    __slots__ = ("_tree_head",)

    def __init__(self) -> None:
        self._tree_head: SignedGoSumdbTreeHead | None = None

    @classmethod
    def from_retained_signed_tree_note(
        cls,
        prior_signed_tree_note: object,
    ) -> GoSumdbVerifier:
        """Restart v1 custody after re-verifying the raw pinned-key note."""

        if not isinstance(prior_signed_tree_note, bytes):
            raise ValueError("retained Go checksum database tree note must be bytes")
        if len(prior_signed_tree_note) > GO_SUMDB_NOTE_MAX_BYTES:
            raise ValueError("retained Go checksum database tree note exceeds the byte limit")
        prior = _parse_signed_tree_note(prior_signed_tree_note)
        verifier = cls()
        verifier._tree_head = prior
        return verifier

    @property
    def tree_head(self) -> SignedGoSumdbTreeHead | None:
        return self._tree_head

    def _advance(
        self,
        new_head: SignedGoSumdbTreeHead,
        consistency_proof: object,
    ) -> str:
        proof = _proof_hashes(
            consistency_proof,
            label="Go checksum database consistency proof",
        )
        prior = self._tree_head
        if prior is None:
            if proof:
                raise ValueError(
                    "empty Go checksum database timeline cannot carry a consistency proof"
                )
            return "pinned_key_empty_timeline_bootstrap"
        if new_head.tree_size < prior.tree_size:
            raise ValueError("Go checksum database tree rollback is forbidden")
        if new_head.tree_size == prior.tree_size:
            if not hmac.compare_digest(
                new_head.tree_hash_bytes,
                prior.tree_hash_bytes,
            ):
                raise ValueError("Go checksum database tree fork is forbidden")
            if proof:
                raise ValueError("unchanged Go checksum database tree cannot carry a proof")
            return "pinned_key_same_tree"

        implied_old, implied_new = _run_tree_proof(
            proof,
            low=0,
            high=new_head.tree_size,
            old_size=prior.tree_size,
            old_hash=prior.tree_hash_bytes,
        )
        old_matches = hmac.compare_digest(implied_old, prior.tree_hash_bytes)
        new_matches = hmac.compare_digest(implied_new, new_head.tree_hash_bytes)
        if not old_matches or not new_matches:
            raise ValueError("Go checksum database consistency proof is invalid")
        return "pinned_key_consistent_extension"

    def verify_release(
        self,
        response: object,
        *,
        module_path: object,
        version: object,
        inclusion_proof: object,
        consistency_proof: object = (),
    ) -> VerifiedGoSumdbRelease:
        """Authenticate one exact ZIP and go.mod checksum pair.

        Proofs are bounded lists or tuples of canonical base64-encoded tlog
        hashes.  A newer signed head requires a consistency proof from this
        verifier's retained head.  The checkpoint must use v1's one pinned
        signature and exactly three signed tree lines.  State changes only
        after every check succeeds.
        """

        lookup = parse_signed_go_sumdb_lookup(
            response,
            module_path=module_path,
            version=version,
        )
        _authenticate_record_inclusion(lookup, inclusion_proof)
        timeline = self._advance(lookup.tree_head, consistency_proof)
        self._tree_head = lookup.tree_head
        return VerifiedGoSumdbRelease(lookup=lookup, timeline=timeline)


__all__ = [
    "GO_SUMDB_NAME",
    "GO_SUMDB_ORIGIN",
    "GO_SUMDB_VERIFIER_KEY",
    "GoSumdbVerifier",
    "SignedGoSumdbLookup",
    "SignedGoSumdbTreeHead",
    "VerifiedGoSumdbRelease",
    "parse_signed_go_sumdb_lookup",
]
