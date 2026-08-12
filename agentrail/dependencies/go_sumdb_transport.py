"""Bounded retrieval for the public Go checksum database verifier.

This transport fetches one exact ``sum.golang.org`` lookup, constructs bounded
inclusion and timeline-consistency proofs from official hash tiles, and hands
them to :class:`GoSumdbVerifier`.  It does not persist timeline state, fetch Go
proxy artifacts, or grant any dependency proposal, evidence, Pack, delivery,
or execution authority.
"""

from __future__ import annotations

import base64
from collections.abc import Callable, Mapping
from dataclasses import dataclass
import hashlib
from typing import Any
import urllib.error
import urllib.request
from urllib.request import Request

from agentrail.dependencies.go_modules import (
    go_proxy_escape_path,
    validate_go_module_version,
)
from agentrail.dependencies.go_sumdb import (
    GO_SUMDB_LOOKUP_MAX_BYTES,
    GO_SUMDB_MAX_TREE_SIZE,
    GO_SUMDB_ORIGIN,
    GoSumdbVerifier,
    SignedGoSumdbLookup,
    SignedGoSumdbTreeHead,
    VerifiedGoSumdbRelease,
    parse_signed_go_sumdb_lookup,
)


GO_SUMDB_TIMEOUT_SECONDS = 8
GO_SUMDB_TILE_HEIGHT = 8
GO_SUMDB_TILE_MAX_BYTES = (1 << GO_SUMDB_TILE_HEIGHT) * 32
_READ_CHUNK_BYTES = 64 * 1024


class _GoSumdbNoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Reject redirects before urllib can contact their target."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _open_go_sumdb_request(request: Request, timeout: int) -> Any:
    """Open one sumdb request without redirects or environment proxies."""

    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        _GoSumdbNoRedirectHandler(),
    )
    return opener.open(request, timeout=timeout)


@dataclass(frozen=True)
class _Tile:
    height: int
    level: int
    number: int
    width: int

    @property
    def path(self) -> str:
        number = self.number
        encoded = f"{number % 1000:03d}"
        while number >= 1000:
            number //= 1000
            encoded = f"x{number % 1000:03d}/{encoded}"
        partial = ""
        if self.width != 1 << self.height:
            partial = f".p/{self.width}"
        return f"tile/{self.height}/{self.level}/{encoded}{partial}"


def _stored_hash_index(level: int, number: int) -> int:
    for _ in range(level):
        number = 2 * number + 1
    index = 0
    while number > 0:
        index += number
        number >>= 1
    return index + level


def _split_stored_hash_index(index: int) -> tuple[int, int]:
    number = index // 2
    index_at_number = _stored_hash_index(0, number)
    while True:
        next_index = index_at_number + 1 + ((number + 1) & -(number + 1)).bit_length() - 1
        if next_index > index:
            break
        number += 1
        index_at_number = next_index
    level = index - index_at_number
    return level, number >> level


def _maximum_power_of_two_below(value: int) -> tuple[int, int]:
    level = (value - 1).bit_length() - 1
    return 1 << level, level


def _subtree_indexes(low: int, high: int, indexes: list[int]) -> None:
    while low < high:
        width, level = _maximum_power_of_two_below(high - low + 1)
        if low & (width - 1):  # pragma: no cover - proof-planning invariant
            raise ValueError("Go checksum database proof math is invalid")
        indexes.append(_stored_hash_index(level, low >> level))
        low += width


def _subtree_index_group(low: int, high: int) -> tuple[int, ...]:
    indexes: list[int] = []
    _subtree_indexes(low, high, indexes)
    if not indexes:  # pragma: no cover - proof-planning invariant
        raise ValueError("Go checksum database proof subtree is empty")
    return tuple(indexes)


def _record_proof_index_groups(
    low: int,
    high: int,
    record_number: int,
    groups: list[tuple[int, ...]],
) -> None:
    if low + 1 == high:
        return
    width, _level = _maximum_power_of_two_below(high - low)
    if record_number < low + width:
        _record_proof_index_groups(low, low + width, record_number, groups)
        groups.append(_subtree_index_group(low + width, high))
    else:
        _record_proof_index_groups(low + width, high, record_number, groups)
        groups.append(_subtree_index_group(low, low + width))


def _tree_proof_index_groups(
    low: int,
    high: int,
    old_size: int,
    groups: list[tuple[int, ...]],
) -> None:
    if old_size == high:
        if low != 0:
            groups.append(_subtree_index_group(low, high))
        return
    width, _level = _maximum_power_of_two_below(high - low)
    if old_size <= low + width:
        _tree_proof_index_groups(low, low + width, old_size, groups)
        groups.append(_subtree_index_group(low + width, high))
    else:
        _tree_proof_index_groups(low + width, high, old_size, groups)
        groups.append(_subtree_index_group(low, low + width))


def _tile_for_index(index: int) -> tuple[_Tile, int, int]:
    level, number = _split_stored_hash_index(index)
    tile_level = level // GO_SUMDB_TILE_HEIGHT
    level_in_tile = level - tile_level * GO_SUMDB_TILE_HEIGHT
    tile_number = (number << level_in_tile) >> GO_SUMDB_TILE_HEIGHT
    number -= (tile_number << GO_SUMDB_TILE_HEIGHT) >> level_in_tile
    width = (number + 1) << level_in_tile
    tile = _Tile(
        height=GO_SUMDB_TILE_HEIGHT,
        level=tile_level,
        number=tile_number,
        width=width,
    )
    start = (number << level_in_tile) * 32
    end = ((number + 1) << level_in_tile) * 32
    return tile, start, end


def _tile_for_tree(index: int, tree_size: int) -> tuple[_Tile, int, int]:
    tile, start, end = _tile_for_index(index)
    full_width = 1 << tile.height
    maximum = tree_size >> (tile.level * tile.height)
    first = tile.number << tile.height
    width = full_width
    if first + width >= maximum:
        if first >= maximum:  # pragma: no cover - proof-planning invariant
            raise ValueError("Go checksum database tile is outside the signed tree")
        width = maximum - first
    return (
        _Tile(tile.height, tile.level, tile.number, width),
        start,
        end,
    )


def _tile_hash(data: bytes) -> bytes:
    if len(data) == 32:
        return data
    if not data or len(data) % 64:
        raise ValueError("Go checksum database tile hash slice is malformed")
    middle = len(data) // 2
    return hashlib.sha256(
        b"\x01" + _tile_hash(data[:middle]) + _tile_hash(data[middle:])
    ).digest()


class GoSumdbTransport:
    """Fetch and authenticate one exact public checksum-database release."""

    def __init__(
        self,
        *,
        opener: Callable[[Request, int], Any] = _open_go_sumdb_request,
        proof_material: Callable[[SignedGoSumdbLookup], Mapping[str, object]] | None = None,
    ) -> None:
        self._opener = opener
        self._proof_material = proof_material

    @staticmethod
    def _lookup_url(module_path: object, version: object) -> str:
        error = validate_go_module_version(module_path, version)
        if error is not None:
            raise ValueError(error)
        assert isinstance(module_path, str)
        assert isinstance(version, str)
        escaped_path = go_proxy_escape_path(module_path)
        return f"{GO_SUMDB_ORIGIN}/lookup/{escaped_path}@{version}"

    @staticmethod
    def _read_lookup(response: Any, *, expected_url: str) -> bytes:
        status = getattr(response, "status", None)
        if status is None and hasattr(response, "getcode"):
            status = response.getcode()
        if status is not None and status != 200:
            raise ValueError("Go checksum database lookup response is not HTTP 200")
        final_url = response.geturl() if hasattr(response, "geturl") else None
        if final_url != expected_url:
            raise ValueError("Go checksum database response URL does not match the request")

        headers = getattr(response, "headers", None)
        raw_length = headers.get("Content-Length") if headers is not None else None
        declared_length: int | None = None
        if raw_length is not None:
            try:
                declared_length = int(raw_length)
            except (TypeError, ValueError) as exc:
                raise ValueError(
                    "Go checksum database response has an invalid Content-Length"
                ) from exc
            if declared_length < 0 or declared_length > GO_SUMDB_LOOKUP_MAX_BYTES:
                raise ValueError("Go checksum database response exceeds the byte limit")

        chunks: list[bytes] = []
        total = 0
        while True:
            remaining = GO_SUMDB_LOOKUP_MAX_BYTES + 1 - total
            chunk = response.read(min(_READ_CHUNK_BYTES, remaining))
            if not chunk:
                break
            if not isinstance(chunk, bytes):
                raise ValueError("Go checksum database response body is not bytes")
            chunks.append(chunk)
            total += len(chunk)
            if total > GO_SUMDB_LOOKUP_MAX_BYTES:
                raise ValueError("Go checksum database response exceeds the byte limit")
        if declared_length is not None and declared_length != total:
            raise ValueError(
                "Go checksum database response Content-Length does not match its body"
            )
        return b"".join(chunks)

    @staticmethod
    def _read_tile(response: Any, *, expected_url: str, expected_bytes: int) -> bytes:
        status = getattr(response, "status", None)
        if status is None and hasattr(response, "getcode"):
            status = response.getcode()
        if status is not None and status != 200:
            raise ValueError("Go checksum database tile response is not HTTP 200")
        final_url = response.geturl() if hasattr(response, "geturl") else None
        if final_url != expected_url:
            raise ValueError("Go checksum database tile URL does not match the request")
        if expected_bytes < 32 or expected_bytes > GO_SUMDB_TILE_MAX_BYTES:
            raise ValueError("Go checksum database tile size is outside the bound")

        headers = getattr(response, "headers", None)
        raw_length = headers.get("Content-Length") if headers is not None else None
        if raw_length is not None:
            try:
                declared_length = int(raw_length)
            except (TypeError, ValueError) as exc:
                raise ValueError(
                    "Go checksum database tile has an invalid Content-Length"
                ) from exc
            if declared_length != expected_bytes:
                raise ValueError("Go checksum database tile length is invalid")

        chunks: list[bytes] = []
        total = 0
        while True:
            remaining = expected_bytes + 1 - total
            chunk = response.read(min(_READ_CHUNK_BYTES, remaining))
            if not chunk:
                break
            if not isinstance(chunk, bytes):
                raise ValueError("Go checksum database tile body is not bytes")
            chunks.append(chunk)
            total += len(chunk)
            if total > expected_bytes:
                raise ValueError("Go checksum database tile exceeds its exact bound")
        if total != expected_bytes:
            raise ValueError("Go checksum database tile length is invalid")
        return b"".join(chunks)

    def fetch_proof_material(
        self,
        lookup: SignedGoSumdbLookup,
        prior_tree_head: SignedGoSumdbTreeHead | None = None,
    ) -> Mapping[str, object]:
        """Fetch the exact tiles needed for one record inclusion proof."""

        if not isinstance(lookup, SignedGoSumdbLookup):
            raise ValueError("signed Go checksum database lookup is required")
        if prior_tree_head is not None and not isinstance(
            prior_tree_head, SignedGoSumdbTreeHead
        ):
            raise ValueError("prior signed Go checksum database tree head is malformed")
        if not isinstance(lookup.tree_size, int) or not (
            1 <= lookup.tree_size <= GO_SUMDB_MAX_TREE_SIZE
        ):
            raise ValueError("Go checksum database tree size is malformed")
        if not isinstance(lookup.record_number, int) or not (
            0 <= lookup.record_number < lookup.tree_size
        ):
            raise ValueError("Go checksum database record number is outside the tree")
        if prior_tree_head is not None and (
            not isinstance(prior_tree_head.tree_size, int)
            or not (1 <= prior_tree_head.tree_size <= GO_SUMDB_MAX_TREE_SIZE)
        ):
            raise ValueError("Go checksum database prior tree size is malformed")
        if (
            prior_tree_head is not None
            and prior_tree_head.tree_size > lookup.tree_size
        ):
            raise ValueError("Go checksum database tree rollback is forbidden")

        inclusion_groups: list[tuple[int, ...]] = []
        _record_proof_index_groups(
            0,
            lookup.tree_size,
            lookup.record_number,
            inclusion_groups,
        )
        if len(inclusion_groups) > 64:  # mirrors the verifier's proof hash cap
            raise ValueError("Go checksum database inclusion proof exceeds the hash limit")

        consistency_groups: list[tuple[int, ...]] = []
        if (
            prior_tree_head is not None
            and prior_tree_head.tree_size < lookup.tree_size
        ):
            _tree_proof_index_groups(
                0,
                lookup.tree_size,
                prior_tree_head.tree_size,
                consistency_groups,
            )
        if len(consistency_groups) > 64:
            raise ValueError("Go checksum database consistency proof exceeds the hash limit")

        tile_cache: dict[str, bytes] = {}

        def fetch_stored_hash(index: int) -> bytes:
            tile, start, end = _tile_for_tree(index, lookup.tree_size)
            tile_url = f"{GO_SUMDB_ORIGIN}/{tile.path}"
            data = tile_cache.get(tile_url)
            if data is None:
                expected_bytes = tile.width * 32

                def read_requested_tile(
                    exact_tile: _Tile,
                    exact_url: str,
                    exact_bytes: int,
                ) -> bytes:
                    request = Request(
                        exact_url,
                        headers={
                            "Accept": "application/octet-stream",
                            "User-Agent": "agentrail-go-sumdb",
                        },
                        method="GET",
                    )
                    with self._opener(request, GO_SUMDB_TIMEOUT_SECONDS) as response:
                        return self._read_tile(
                            response,
                            expected_url=exact_url,
                            expected_bytes=exact_bytes,
                        )

                try:
                    data = read_requested_tile(tile, tile_url, expected_bytes)
                except urllib.error.HTTPError as exc:
                    full_width = 1 << tile.height
                    if exc.code != 404 or tile.width == full_width:
                        raise
                    full_tile = _Tile(
                        tile.height,
                        tile.level,
                        tile.number,
                        full_width,
                    )
                    full_url = f"{GO_SUMDB_ORIGIN}/{full_tile.path}"
                    full_data = read_requested_tile(
                        full_tile,
                        full_url,
                        full_width * 32,
                    )
                    data = full_data[:expected_bytes]
                tile_cache[tile_url] = data
            return _tile_hash(data[start:end])

        def fetch_proof(groups: list[tuple[int, ...]]) -> tuple[str, ...]:
            proof: list[str] = []
            for group in groups:
                hashes = [fetch_stored_hash(index) for index in group]
                subtree_hash = hashes[-1]
                for left_hash in reversed(hashes[:-1]):
                    subtree_hash = hashlib.sha256(
                        b"\x01" + left_hash + subtree_hash
                    ).digest()
                proof.append(base64.b64encode(subtree_hash).decode("ascii"))
            return tuple(proof)

        return {
            "inclusion_proof": fetch_proof(inclusion_groups),
            "consistency_proof": fetch_proof(consistency_groups),
        }

    def fetch_verified_release(
        self,
        verifier: GoSumdbVerifier,
        module_path: object,
        version: object,
    ) -> VerifiedGoSumdbRelease:
        """Fetch one lookup and authenticate it in ``verifier``'s timeline."""

        if not isinstance(verifier, GoSumdbVerifier):
            raise ValueError("Go checksum database verifier is required")
        lookup_url = self._lookup_url(module_path, version)
        request = Request(
            lookup_url,
            headers={
                "Accept": "text/plain",
                "User-Agent": "agentrail-go-sumdb",
            },
            method="GET",
        )
        with self._opener(request, GO_SUMDB_TIMEOUT_SECONDS) as response:
            raw_lookup = self._read_lookup(response, expected_url=lookup_url)

        lookup = parse_signed_go_sumdb_lookup(
            raw_lookup,
            module_path=module_path,
            version=version,
        )
        material = (
            self._proof_material(lookup)
            if self._proof_material is not None
            else self.fetch_proof_material(lookup, verifier.tree_head)
        )
        if not isinstance(material, Mapping) or set(material) != {
            "inclusion_proof",
            "consistency_proof",
        }:
            raise ValueError("Go checksum database proof material is malformed")
        return verifier.verify_release(
            raw_lookup,
            module_path=module_path,
            version=version,
            inclusion_proof=material["inclusion_proof"],
            consistency_proof=material["consistency_proof"],
        )


__all__ = ["GO_SUMDB_TIMEOUT_SECONDS", "GoSumdbTransport"]
