import base64
from email.message import Message
import hashlib
from io import BytesIO
import urllib.error
import urllib.request
import urllib.response
from urllib.request import Request

import pytest

from agentrail.dependencies.go_sumdb import (
    GoSumdbVerifier,
    SignedGoSumdbLookup,
    SignedGoSumdbTreeHead,
    VerifiedGoSumdbRelease,
)
from agentrail.dependencies.go_sumdb_transport import GoSumdbTransport
from agentrail.tests.dependencies.test_go_sumdb import (
    SIGNED_YAML_LOOKUP,
    YAML_INCLUSION_PROOF,
)


class _RetainedResponse:
    def __init__(self, body: bytes, url: str, *, status: int = 200) -> None:
        self._body = BytesIO(body)
        self._url = url
        self.status = status
        self.read_calls = 0
        self.headers = {"Content-Length": str(len(body))}

    def __enter__(self) -> "_RetainedResponse":
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def read(self, size: int = -1) -> bytes:
        self.read_calls += 1
        return self._body.read(size)

    def geturl(self) -> str:
        return self._url

    def getcode(self) -> int:
        return self.status


def test_transport_fetches_and_authenticates_one_exact_official_release() -> None:
    lookup_url = "https://sum.golang.org/lookup/gopkg.in/yaml.v3@v3.0.1"
    opened: list[tuple[Request, int]] = []

    def opener(request: Request, timeout: int) -> _RetainedResponse:
        opened.append((request, timeout))
        return _RetainedResponse(SIGNED_YAML_LOOKUP, lookup_url)

    transport = GoSumdbTransport(
        opener=opener,
        proof_material=lambda lookup: {
            "inclusion_proof": YAML_INCLUSION_PROOF,
            "consistency_proof": (),
        },
    )

    release = transport.fetch_verified_release(
        GoSumdbVerifier(),
        "gopkg.in/yaml.v3",
        "v3.0.1",
    )

    assert isinstance(release, VerifiedGoSumdbRelease)
    assert release.lookup.module_h1 == "h1:fxVm/GzAzEWqLHuvctI91KS9hhNmmWOoWu0XTYJS7CA="
    assert release.lookup.go_mod_h1 == "h1:K4uyk7z7BCEPqu6E+C64Yfv1cQ7kz7rIZviUmN+EgEM="
    assert len(opened) == 1
    request, timeout = opened[0]
    assert request.full_url == lookup_url
    assert request.get_method() == "GET"
    assert request.data is None
    assert request.get_header("Authorization") is None
    assert request.get_header("Proxy-Authorization") is None
    assert request.get_header("Cookie") is None
    assert timeout == 8


def test_default_transport_refuses_redirects_and_ambient_proxy_configuration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lookup_url = "https://sum.golang.org/lookup/gopkg.in/yaml.v3@v3.0.1"
    redirect_target = "https://redirect.example.invalid/forged-lookup"
    requested_urls: list[str] = []

    class RedirectingTransport(urllib.request.BaseHandler):
        handler_order = 100

        def https_open(self, request: Request):
            requested_urls.append(request.full_url)
            headers = Message()
            if request.full_url == lookup_url:
                headers["Location"] = redirect_target
                response = urllib.response.addinfourl(
                    BytesIO(b""), headers, lookup_url, 302,
                )
                response.msg = "Found"
                return response
            headers["Content-Length"] = str(len(SIGNED_YAML_LOOKUP))
            response = urllib.response.addinfourl(
                BytesIO(SIGNED_YAML_LOOKUP), headers, redirect_target, 200,
            )
            response.msg = "OK"
            return response

    real_build_opener = urllib.request.build_opener

    def build_no_network_opener(*handlers: object):
        assert any(
            isinstance(handler, urllib.request.ProxyHandler)
            and handler.proxies == {}
            for handler in handlers
        )
        return real_build_opener(RedirectingTransport(), *handlers)

    monkeypatch.setenv("HTTPS_PROXY", "http://ambient-proxy.example.invalid:8080")
    monkeypatch.setattr(urllib.request, "build_opener", build_no_network_opener)
    transport = GoSumdbTransport(
        proof_material=lambda lookup: pytest.fail(
            "a redirected lookup must not reach proof authentication"
        ),
    )

    with pytest.raises(urllib.error.HTTPError) as error:
        transport.fetch_verified_release(
            GoSumdbVerifier(),
            "gopkg.in/yaml.v3",
            "v3.0.1",
        )

    assert error.value.code == 302
    assert requested_urls == [lookup_url]


def test_transport_fetches_the_exact_tile_for_one_record_inclusion_proof() -> None:
    records = (b"synthetic record zero\n", b"synthetic record one\n", b"synthetic record two\n")
    leaves = tuple(hashlib.sha256(b"\x00" + record).digest() for record in records)
    left_subtree = hashlib.sha256(b"\x01" + leaves[0] + leaves[1]).digest()
    root = hashlib.sha256(b"\x01" + left_subtree + leaves[2]).digest()
    lookup = SignedGoSumdbLookup(
        module_path="example.com/synthetic",
        version="v1.0.0",
        record_number=1,
        record_text_bytes=records[1],
        module_h1="h1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        go_mod_h1="h1:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
        tree_head=SignedGoSumdbTreeHead(
            signed_note_bytes=b"synthetic signed note",
            signed_text_bytes=b"synthetic signed tree",
            tree_size=3,
            tree_hash_bytes=root,
        ),
    )
    tile_url = "https://sum.golang.org/tile/8/0/000.p/3"
    opened: list[tuple[str, int]] = []

    def opener(request: Request, timeout: int) -> _RetainedResponse:
        opened.append((request.full_url, timeout))
        return _RetainedResponse(b"".join(leaves), tile_url)

    transport = GoSumdbTransport(
        opener=opener,
        proof_material=lambda lookup: pytest.fail(
            "the public tile proof interface must not use supplied proof material"
        ),
    )

    material = transport.fetch_proof_material(lookup)

    assert opened == [(tile_url, 8)]
    assert material == {
        "inclusion_proof": (
            base64.b64encode(leaves[0]).decode("ascii"),
            base64.b64encode(leaves[2]).decode("ascii"),
        ),
        "consistency_proof": (),
    }


def test_verified_release_uses_public_proof_fetch_when_no_callback_is_supplied() -> None:
    lookup_url = "https://sum.golang.org/lookup/gopkg.in/yaml.v3@v3.0.1"
    seen: list[tuple[SignedGoSumdbLookup, SignedGoSumdbTreeHead | None]] = []

    class RetainedProofTransport(GoSumdbTransport):
        def fetch_proof_material(
            self,
            lookup: SignedGoSumdbLookup,
            prior_tree_head: SignedGoSumdbTreeHead | None = None,
        ) -> dict[str, object]:
            seen.append((lookup, prior_tree_head))
            return {
                "inclusion_proof": YAML_INCLUSION_PROOF,
                "consistency_proof": (),
            }

    def opener(request: Request, timeout: int) -> _RetainedResponse:
        assert request.full_url == lookup_url
        assert timeout == 8
        return _RetainedResponse(SIGNED_YAML_LOOKUP, lookup_url)

    verifier = GoSumdbVerifier()
    transport = RetainedProofTransport(opener=opener)

    release = transport.fetch_verified_release(
        verifier,
        "gopkg.in/yaml.v3",
        "v3.0.1",
    )

    assert isinstance(release, VerifiedGoSumdbRelease)
    assert release.lookup.module_h1 == "h1:fxVm/GzAzEWqLHuvctI91KS9hhNmmWOoWu0XTYJS7CA="
    assert seen == [(release.lookup, None)]


def test_transport_fetches_consistency_proof_for_a_three_leaf_extension() -> None:
    records = (b"synthetic record zero\n", b"synthetic record one\n", b"synthetic record two\n")
    leaves = tuple(hashlib.sha256(b"\x00" + record).digest() for record in records)
    prior_root = hashlib.sha256(b"\x01" + leaves[0] + leaves[1]).digest()
    new_root = hashlib.sha256(b"\x01" + prior_root + leaves[2]).digest()
    prior = SignedGoSumdbTreeHead(
        signed_note_bytes=b"synthetic prior signed note",
        signed_text_bytes=b"synthetic prior signed tree",
        tree_size=2,
        tree_hash_bytes=prior_root,
    )
    lookup = SignedGoSumdbLookup(
        module_path="example.com/synthetic",
        version="v1.0.0",
        record_number=1,
        record_text_bytes=records[1],
        module_h1="h1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        go_mod_h1="h1:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
        tree_head=SignedGoSumdbTreeHead(
            signed_note_bytes=b"synthetic new signed note",
            signed_text_bytes=b"synthetic new signed tree",
            tree_size=3,
            tree_hash_bytes=new_root,
        ),
    )
    tile_url = "https://sum.golang.org/tile/8/0/000.p/3"
    opened: list[str] = []

    def opener(request: Request, timeout: int) -> _RetainedResponse:
        assert timeout == 8
        opened.append(request.full_url)
        return _RetainedResponse(b"".join(leaves), tile_url)

    material = GoSumdbTransport(opener=opener).fetch_proof_material(
        lookup,
        prior_tree_head=prior,
    )

    assert opened == [tile_url]
    assert material == {
        "inclusion_proof": (
            base64.b64encode(leaves[0]).decode("ascii"),
            base64.b64encode(leaves[2]).decode("ascii"),
        ),
        "consistency_proof": (
            base64.b64encode(leaves[2]).decode("ascii"),
        ),
    }


def test_lookup_non_success_status_is_refused_before_body_or_proof() -> None:
    lookup_url = "https://sum.golang.org/lookup/gopkg.in/yaml.v3@v3.0.1"
    response = _RetainedResponse(SIGNED_YAML_LOOKUP, lookup_url, status=206)
    proof_calls = 0

    def proof_material(lookup: SignedGoSumdbLookup) -> dict[str, object]:
        nonlocal proof_calls
        proof_calls += 1
        pytest.fail(
            f"HTTP 206 reached proof authentication after {response.read_calls} body reads"
        )

    transport = GoSumdbTransport(
        opener=lambda request, timeout: response,
        proof_material=proof_material,
    )

    with pytest.raises(ValueError):
        transport.fetch_verified_release(
            GoSumdbVerifier(),
            "gopkg.in/yaml.v3",
            "v3.0.1",
        )

    assert response.read_calls == 0
    assert proof_calls == 0


def test_transport_falls_back_to_the_historical_full_tile() -> None:
    records = (b"synthetic record zero\n", b"synthetic record one\n", b"synthetic record two\n")
    leaves = tuple(hashlib.sha256(b"\x00" + record).digest() for record in records)
    left_subtree = hashlib.sha256(b"\x01" + leaves[0] + leaves[1]).digest()
    root = hashlib.sha256(b"\x01" + left_subtree + leaves[2]).digest()
    lookup = SignedGoSumdbLookup(
        module_path="example.com/synthetic",
        version="v1.0.0",
        record_number=1,
        record_text_bytes=records[1],
        module_h1="h1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        go_mod_h1="h1:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
        tree_head=SignedGoSumdbTreeHead(
            signed_note_bytes=b"synthetic signed note",
            signed_text_bytes=b"synthetic signed tree",
            tree_size=3,
            tree_hash_bytes=root,
        ),
    )
    partial_url = "https://sum.golang.org/tile/8/0/000.p/3"
    full_url = "https://sum.golang.org/tile/8/0/000"
    full_tile = b"".join(leaves) + b"\x00" * (8192 - 96)
    opened: list[str] = []

    def opener(request: Request, timeout: int) -> _RetainedResponse:
        assert timeout == 8
        opened.append(request.full_url)
        if request.full_url == partial_url:
            raise urllib.error.HTTPError(
                partial_url,
                404,
                "Not Found",
                Message(),
                None,
            )
        if request.full_url == full_url:
            return _RetainedResponse(full_tile, full_url)
        pytest.fail(f"unexpected checksum database URL: {request.full_url}")

    material = GoSumdbTransport(opener=opener).fetch_proof_material(lookup)

    assert opened == [partial_url, full_url]
    assert material["inclusion_proof"] == (
        base64.b64encode(leaves[0]).decode("ascii"),
        base64.b64encode(leaves[2]).decode("ascii"),
    )


def test_transport_collapses_leaf_tile_hashes_into_rfc6962_proof_nodes() -> None:
    records = tuple(f"synthetic record {index}\n".encode("ascii") for index in range(7))
    leaves = tuple(hashlib.sha256(b"\x00" + record).digest() for record in records)

    def node(left: bytes, right: bytes) -> bytes:
        return hashlib.sha256(b"\x01" + left + right).digest()

    left = node(node(leaves[0], leaves[1]), node(leaves[2], leaves[3]))
    right = node(node(leaves[4], leaves[5]), leaves[6])
    lookup = SignedGoSumdbLookup(
        module_path="example.com/synthetic",
        version="v1.0.0",
        record_number=0,
        record_text_bytes=records[0],
        module_h1="h1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        go_mod_h1="h1:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
        tree_head=SignedGoSumdbTreeHead(
            signed_note_bytes=b"synthetic signed note",
            signed_text_bytes=b"synthetic signed tree",
            tree_size=7,
            tree_hash_bytes=node(left, right),
        ),
    )
    tile_url = "https://sum.golang.org/tile/8/0/000.p/7"
    opened: list[str] = []

    def opener(request: Request, timeout: int) -> _RetainedResponse:
        assert timeout == 8
        opened.append(request.full_url)
        return _RetainedResponse(b"".join(leaves), tile_url)

    material = GoSumdbTransport(opener=opener).fetch_proof_material(lookup)

    assert opened == [tile_url]
    assert material == {
        "inclusion_proof": tuple(
            base64.b64encode(proof_hash).decode("ascii")
            for proof_hash in (
                leaves[1],
                node(leaves[2], leaves[3]),
                right,
            )
        ),
        "consistency_proof": (),
    }


def test_transport_orders_right_branch_proof_like_go_tlog_leaf_proof() -> None:
    records = tuple(f"synthetic record {index}\n".encode("ascii") for index in range(7))
    leaves = tuple(hashlib.sha256(b"\x00" + record).digest() for record in records)

    def node(left: bytes, right: bytes) -> bytes:
        return hashlib.sha256(b"\x01" + left + right).digest()

    left = node(node(leaves[0], leaves[1]), node(leaves[2], leaves[3]))
    right = node(node(leaves[4], leaves[5]), leaves[6])
    lookup = SignedGoSumdbLookup(
        module_path="example.com/synthetic",
        version="v1.0.0",
        record_number=6,
        record_text_bytes=records[6],
        module_h1="h1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        go_mod_h1="h1:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
        tree_head=SignedGoSumdbTreeHead(
            signed_note_bytes=b"synthetic signed note",
            signed_text_bytes=b"synthetic signed tree",
            tree_size=7,
            tree_hash_bytes=node(left, right),
        ),
    )
    tile_url = "https://sum.golang.org/tile/8/0/000.p/7"

    def opener(request: Request, timeout: int) -> _RetainedResponse:
        assert request.full_url == tile_url
        assert timeout == 8
        return _RetainedResponse(b"".join(leaves), tile_url)

    material = GoSumdbTransport(opener=opener).fetch_proof_material(lookup)

    assert material == {
        "inclusion_proof": (
            base64.b64encode(node(leaves[4], leaves[5])).decode("ascii"),
            base64.b64encode(left).decode("ascii"),
        ),
        "consistency_proof": (),
    }


def test_transport_matches_independent_rfc6962_proofs_for_small_trees() -> None:
    def node(left: bytes, right: bytes) -> bytes:
        return hashlib.sha256(b"\x01" + left + right).digest()

    def split_width(width: int) -> int:
        return 1 << ((width - 1).bit_length() - 1)

    def encoded(proof: tuple[bytes, ...]) -> tuple[str, ...]:
        return tuple(base64.b64encode(item).decode("ascii") for item in proof)

    for tree_size in range(1, 65):
        records = tuple(
            f"differential record {index}\n".encode("ascii")
            for index in range(tree_size)
        )
        leaves = tuple(hashlib.sha256(b"\x00" + record).digest() for record in records)
        subtree_cache: dict[tuple[int, int], bytes] = {}

        def subtree(low: int, high: int) -> bytes:
            key = (low, high)
            if key not in subtree_cache:
                if low + 1 == high:
                    subtree_cache[key] = leaves[low]
                else:
                    width = split_width(high - low)
                    subtree_cache[key] = node(
                        subtree(low, low + width),
                        subtree(low + width, high),
                    )
            return subtree_cache[key]

        def record_proof(low: int, high: int, record_number: int) -> tuple[bytes, ...]:
            if low + 1 == high:
                return ()
            width = split_width(high - low)
            if record_number < low + width:
                return record_proof(low, low + width, record_number) + (
                    subtree(low + width, high),
                )
            return record_proof(low + width, high, record_number) + (
                subtree(low, low + width),
            )

        def consistency_proof(low: int, high: int, old_size: int) -> tuple[bytes, ...]:
            if old_size == high:
                return () if low == 0 else (subtree(low, high),)
            width = split_width(high - low)
            if old_size <= low + width:
                return consistency_proof(low, low + width, old_size) + (
                    subtree(low + width, high),
                )
            return consistency_proof(low + width, high, old_size) + (
                subtree(low, low + width),
            )

        tile_url = f"https://sum.golang.org/tile/8/0/000.p/{tree_size}"
        tile_bytes = b"".join(leaves)
        opened: list[str] = []

        def opener(request: Request, timeout: int) -> _RetainedResponse:
            assert request.full_url == tile_url
            assert timeout == 8
            opened.append(request.full_url)
            return _RetainedResponse(tile_bytes, tile_url)

        transport = GoSumdbTransport(opener=opener)

        def lookup(record_number: int) -> SignedGoSumdbLookup:
            return SignedGoSumdbLookup(
                module_path="example.com/differential",
                version="v1.0.0",
                record_number=record_number,
                record_text_bytes=records[record_number],
                module_h1="h1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                go_mod_h1="h1:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
                tree_head=SignedGoSumdbTreeHead(
                    signed_note_bytes=b"synthetic signed note",
                    signed_text_bytes=b"synthetic signed tree",
                    tree_size=tree_size,
                    tree_hash_bytes=subtree(0, tree_size),
                ),
            )

        for record_number in range(tree_size):
            opened.clear()
            material = transport.fetch_proof_material(lookup(record_number))
            assert material == {
                "inclusion_proof": encoded(record_proof(0, tree_size, record_number)),
                "consistency_proof": (),
            }, (tree_size, record_number, None)
            assert opened == ([] if tree_size == 1 else [tile_url])

        representative_prior_sizes = sorted({
            1,
            max(1, tree_size // 3),
            max(1, tree_size // 2),
            max(1, tree_size - 1),
            tree_size,
        })
        for prior_size in representative_prior_sizes:
            opened.clear()
            prior = SignedGoSumdbTreeHead(
                signed_note_bytes=b"synthetic prior signed note",
                signed_text_bytes=b"synthetic prior signed tree",
                tree_size=prior_size,
                tree_hash_bytes=subtree(0, prior_size),
            )
            material = transport.fetch_proof_material(
                lookup(tree_size - 1),
                prior_tree_head=prior,
            )
            assert material == {
                "inclusion_proof": encoded(record_proof(0, tree_size, tree_size - 1)),
                "consistency_proof": encoded(
                    consistency_proof(0, tree_size, prior_size)
                ),
            }, (tree_size, tree_size - 1, prior_size)
            assert opened == ([] if tree_size == 1 else [tile_url])


def test_transport_matches_rfc6962_across_height_eight_tile_boundaries() -> None:
    def node(left: bytes, right: bytes) -> bytes:
        return hashlib.sha256(b"\x01" + left + right).digest()

    def split_width(width: int) -> int:
        return 1 << ((width - 1).bit_length() - 1)

    observed_urls: set[str] = set()
    saw_multiple_tiles = False

    for tree_size in (255, 256, 257, 513):
        records = tuple(
            f"tile-boundary record {index}\n".encode("ascii")
            for index in range(tree_size)
        )
        leaves = tuple(hashlib.sha256(b"\x00" + record).digest() for record in records)
        subtree_cache: dict[tuple[int, int], bytes] = {}

        def subtree(low: int, high: int) -> bytes:
            key = (low, high)
            if key not in subtree_cache:
                if low + 1 == high:
                    subtree_cache[key] = leaves[low]
                else:
                    width = split_width(high - low)
                    subtree_cache[key] = node(
                        subtree(low, low + width),
                        subtree(low + width, high),
                    )
            return subtree_cache[key]

        def record_ranges(low: int, high: int, record_number: int) -> tuple[tuple[int, int], ...]:
            if low + 1 == high:
                return ()
            width = split_width(high - low)
            if record_number < low + width:
                return record_ranges(low, low + width, record_number) + (
                    (low + width, high),
                )
            return record_ranges(low + width, high, record_number) + (
                (low, low + width),
            )

        def consistency_ranges(low: int, high: int, old_size: int) -> tuple[tuple[int, int], ...]:
            if old_size == high:
                return () if low == 0 else ((low, high),)
            width = split_width(high - low)
            if old_size <= low + width:
                return consistency_ranges(low, low + width, old_size) + (
                    (low + width, high),
                )
            return consistency_ranges(low + width, high, old_size) + (
                (low, low + width),
            )

        def stored_nodes(low: int, high: int) -> tuple[tuple[int, int], ...]:
            result: list[tuple[int, int]] = []
            while low < high:
                width = split_width(high - low + 1)
                level = width.bit_length() - 1
                assert low & (width - 1) == 0
                result.append((level, low >> level))
                low += width
            return tuple(result)

        def tile_for_node(level: int, number: int) -> tuple[str, tuple[int, int, int]]:
            tile_level = level // 8
            level_in_tile = level - tile_level * 8
            tile_number = (number << level_in_tile) >> 8
            maximum = tree_size >> (tile_level * 8)
            first = tile_number << 8
            width = min(256, maximum - first)
            assert width > 0
            suffix = "" if width == 256 else f".p/{width}"
            url = (
                "https://sum.golang.org/tile/8/"
                f"{tile_level}/{tile_number:03d}{suffix}"
            )
            return url, (tile_level, tile_number, width)

        def encoded(ranges: tuple[tuple[int, int], ...]) -> tuple[str, ...]:
            return tuple(
                base64.b64encode(subtree(low, high)).decode("ascii")
                for low, high in ranges
            )

        record_numbers = sorted({0, tree_size // 2, tree_size - 1})
        prior_sizes = sorted({1, max(1, tree_size // 2), tree_size - 1})
        for record_number in record_numbers:
            for prior_size in (None, *prior_sizes):
                inclusion_ranges = record_ranges(0, tree_size, record_number)
                consistency = (
                    ()
                    if prior_size is None
                    else consistency_ranges(0, tree_size, prior_size)
                )
                expected_urls: list[str] = []
                tile_specs: dict[str, tuple[int, int, int]] = {}
                for low, high in (*inclusion_ranges, *consistency):
                    for level, number in stored_nodes(low, high):
                        url, spec = tile_for_node(level, number)
                        tile_specs[url] = spec
                        if url not in expected_urls:
                            expected_urls.append(url)

                opened: list[str] = []

                def opener(request: Request, timeout: int) -> _RetainedResponse:
                    assert timeout == 8
                    assert request.full_url in tile_specs
                    opened.append(request.full_url)
                    tile_level, tile_number, width = tile_specs[request.full_url]
                    span = 1 << (tile_level * 8)
                    first = tile_number * 256 * span
                    body = b"".join(
                        subtree(first + index * span, first + (index + 1) * span)
                        for index in range(width)
                    )
                    return _RetainedResponse(body, request.full_url)

                lookup = SignedGoSumdbLookup(
                    module_path="example.com/tile-boundary",
                    version="v1.0.0",
                    record_number=record_number,
                    record_text_bytes=records[record_number],
                    module_h1="h1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                    go_mod_h1="h1:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
                    tree_head=SignedGoSumdbTreeHead(
                        signed_note_bytes=b"synthetic signed note",
                        signed_text_bytes=b"synthetic signed tree",
                        tree_size=tree_size,
                        tree_hash_bytes=subtree(0, tree_size),
                    ),
                )
                prior = (
                    None
                    if prior_size is None
                    else SignedGoSumdbTreeHead(
                        signed_note_bytes=b"synthetic prior signed note",
                        signed_text_bytes=b"synthetic prior signed tree",
                        tree_size=prior_size,
                        tree_hash_bytes=subtree(0, prior_size),
                    )
                )

                material = GoSumdbTransport(opener=opener).fetch_proof_material(
                    lookup,
                    prior_tree_head=prior,
                )

                assert material == {
                    "inclusion_proof": encoded(inclusion_ranges),
                    "consistency_proof": encoded(consistency),
                }, (tree_size, record_number, prior_size)
                assert opened == expected_urls
                observed_urls.update(opened)
                saw_multiple_tiles = saw_multiple_tiles or len(opened) > 1

    assert "https://sum.golang.org/tile/8/0/000.p/255" in observed_urls
    assert "https://sum.golang.org/tile/8/0/000" in observed_urls
    assert "https://sum.golang.org/tile/8/0/001.p/1" in observed_urls
    assert any("/tile/8/1/" in url for url in observed_urls)
    assert saw_multiple_tiles


def test_transport_rejects_constructible_invalid_tree_identities_before_io() -> None:
    opened: list[str] = []

    def opener(request: Request, timeout: int) -> _RetainedResponse:
        opened.append(request.full_url)
        pytest.fail("invalid checksum database identity reached the opener")

    transport = GoSumdbTransport(opener=opener)
    cases = (
        ("zero tree", 0, 0, None, "tree size"),
        ("negative tree", -1, 0, None, "tree size"),
        ("negative record", 1, -1, None, "record number"),
        ("record at tree bound", 1, 1, None, "record number"),
        ("zero prior tree", 1, 0, 0, "prior tree size"),
        ("negative prior tree", 1, 0, -1, "prior tree size"),
    )
    failures: list[str] = []

    for label, tree_size, record_number, prior_size, expected_message in cases:
        lookup = SignedGoSumdbLookup(
            module_path="example.com/invalid-identity",
            version="v1.0.0",
            record_number=record_number,
            record_text_bytes=b"synthetic invalid identity\n",
            module_h1="h1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            go_mod_h1="h1:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
            tree_head=SignedGoSumdbTreeHead(
                signed_note_bytes=b"synthetic signed note",
                signed_text_bytes=b"synthetic signed tree",
                tree_size=tree_size,
                tree_hash_bytes=b"\x00" * 32,
            ),
        )
        prior = (
            None
            if prior_size is None
            else SignedGoSumdbTreeHead(
                signed_note_bytes=b"synthetic prior signed note",
                signed_text_bytes=b"synthetic prior signed tree",
                tree_size=prior_size,
                tree_hash_bytes=b"\x00" * 32,
            )
        )
        try:
            transport.fetch_proof_material(lookup, prior_tree_head=prior)
        except ValueError as exc:
            if expected_message not in str(exc):
                failures.append(f"{label}: unexpected error: {exc}")
        except Exception as exc:  # pragma: no cover - desired failure diagnostic
            failures.append(f"{label}: wrong exception {type(exc).__name__}: {exc}")
        else:
            failures.append(f"{label}: accepted")

    assert opened == []
    assert failures == []
