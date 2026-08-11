from dataclasses import replace

import pytest

import agentrail.dependencies.go_sumdb as go_sumdb_module
from agentrail.dependencies.go_sumdb import (
    GO_SUMDB_VERIFIER_KEY,
    GoSumdbVerifier,
    _parse_tree_text,
    parse_signed_go_sumdb_lookup,
)


# Retained official sum.golang.org lookup and tree-head bytes.  The proof
# vectors are canonical Go tlog RecordProof/TreeProof values derived from the
# corresponding authenticated tile cache and anchored to these signed roots.
SIGNED_YAML_LOOKUP = """10738965
gopkg.in/yaml.v3 v3.0.1 h1:fxVm/GzAzEWqLHuvctI91KS9hhNmmWOoWu0XTYJS7CA=
gopkg.in/yaml.v3 v3.0.1/go.mod h1:K4uyk7z7BCEPqu6E+C64Yfv1cQ7kz7rIZviUmN+EgEM=

go.sum database tree
54715574
FUQBK+dBbFoa4DioEhMzkxn0fazBN3B6r+ZlT1TImNc=

— sum.golang.org Az3grpRUpAlGqlrE8Ie1d6i2+5RqP+xweAW4Xc9QpBw2VsHnIh08nNr5Gcbrq7A4N8eqbP15ABesspft4PXzZsLSfAU=
""".encode("utf-8")

YAML_INCLUSION_PROOF = (
    "vM+Zoj1IfCtvgzeGfX65uyxKRv6c3Oy1XOHyNsLGH7I=",
    "FKZH/HXbpnny8TcNDpDUnv7if0abKXYOjNqxatSDs7Y=",
    "kxo4jyd09UGFLtQYhRBM/iQIw69P9Vw2HnT84TalTp0=",
    "Dz5Y9oPEBSsL9fI89qwo1dpjTk6QF7RHrQMhMhw3nNQ=",
    "A00qtFWjl5osF48lahxu4lw3gc9ilZ4yOGqKsXw1mfo=",
    "g+kiNJF0SzeThJHZg+C+LQylRpxfHzze9AnxBPnbQFw=",
    "hf04vS9d/PkBLdxLH/owu0IAB4TzljFPRg1L/4wz4dQ=",
    "l/pCXb3lNPr3XoLunwaizcWagmsYfvU2HLtaoqrLagI=",
    "c0KSa8YtRjnN8Hl+AaBYZd5chtSuYAd1WV6RYjsUJTE=",
    "jbso36GURiBPCIoe7mAODgge6wEptt2wVzsFJI4Z2XI=",
    "/tWamSzQPfn6RtsOFNabj027hEtEkb9Aih9fey+FMYE=",
    "KbG/HD/cdjLi7sV6ooP9Y9ZVgg4PN9YunQK7Il1khRg=",
    "k5et4PR5IvIKZcISBopja6RyyuE4fCTA/NMJEC37PeI=",
    "p++AVJLzyw3Y08Mm0KwIjIEOnfJlKGa67yrIXy57+iM=",
    "p9fWMonF7h7CbgX6B04YRU2VqCbrbBWtu96INQpJf9M=",
    "Y4yT7OblBqsuhYPk3l7BOYsvalz/UYafby1XWDd7LCo=",
    "6pfMcDplbU0c27LwEp82ZNpgNEthZyPk81kNvRgB9Dg=",
    "+vDR8xppB1AYVW3TY9Cv2TmlFYjebvqfA1yDf3tMz3A=",
    "17DjpsQUMaQJPTTal0U/gWKGczw3j5LrnuYNPIWLWRE=",
    "VJ2cn3rGgxho2lxwCSo/Ov7CQ28TGmzmDHbd0jlucRQ=",
    "nIRuzymbjzJlsjA+EqvhWQ8+pNgGnPCM6ky8MeXW/tQ=",
    "udRjhEO3cF7L32j7Q10R5wvQUePEcEcbtRwJ5/Md75U=",
    "zAqn6H1b1nXY+WEE0oXtcxeR0ZK0SAkXNZevmpPr+pA=",
    "/aUpTUlzK5BioQh7tUCcS1LgK65RPE5w5KuZLXwSa7I=",
    "zesWuZw10TEJInNKrllG2PEgH8cKacLp6LY5WpXGOcY=",
    "lttMqOwwB1gRDbJ/CiiGokyzgSthSxByrfkoeIMmVIk=",
)

NEW_SIGNED_TREE_NOTE = """go.sum database tree
54717027
X8mO+rr4u+lIE2vmoFwuTa3LI038lIvvPEB3B2p3X7g=

— sum.golang.org Az3gruu60QOJ6mBYsURIUNeOq31xHaYKpFtaDmHUozy5UJ7qrnE9V9HTMiiZ+njWC6dQ9O2sDPoctRg4BM626vaS/QM=
""".encode("utf-8")

YAML_NEW_INCLUSION_PROOF = (
    *YAML_INCLUSION_PROOF[:-1],
    "dWt4IE0t0wKXLy19rEpX1+8o7Hhhh1fLBdzy7xrkSNA=",
)

YAML_CONSISTENCY_PROOF = (
    "7f/obfEoW4jIbJZyRyz34jfj6eITEHb/iv6NkozjCvo=",
    "bcvksSMiPWC2Xun0HO+6R5NshOUGIoGDO1y/U8t1pnc=",
    "/jlWp82whNKvvdxcVJxDJhwRP6lPGemB+NQJJ31WZvI=",
    "G+9NULqJ6s2rLSIeQSqCVfcUB7E3SwQnUQxf1GGa2UA=",
    "XFWOxVd30gBEhvqqzRNOPRaK2fWctUfydQGnl2WcxKw=",
    "2mQ09/sA/kjOrV/OjHK1ceZA9e2+pUfqyPIsM5NtPck=",
    "aNuXqNkaFPG/qITLSTRgmeVmp0dwLqP5h6gdKs2Kx4I=",
    "Gg/PbcCR4uN+7hcPb6sO1Q9FegUqKsVq0YnX9rVoB+Q=",
    "fhHSFHDclh3YRVq6qNltVv2Xd/6Dm7pWoWGCa5GJ8v4=",
    "JtiEzKsXCSpvr+vx1He2rdzf+RCepR5riQ+skC40Oig=",
    "mZlAmQMqppdW3f/TNsJzj+azEh3Ijyr23tEh+gqNWEs=",
    "LRoK75Fl9Xm/WwEIaTWhDfGQhrUueYYA3wPj+rj/MMk=",
    "OLpOVyADdNPvwfq9Rg93rYScfgug3yfzvaWVfZmqxHk=",
    "17Gvxx5iaYiTLGjdBCBUK1QIkjiu7ZfV08fIqXw35C4=",
    "gwSputUthSEyzllKMFLaAsdOCuwR/d0bRMPxUnmQ4IU=",
    "LTeRjLNQrs2XohrHPK+i0suyG0bVpk2qTmxNB7qdEMc=",
    "MdOpnRMfUoL32HLkVBWTCaT4Zo6BT5bFmNeOGpopF5o=",
    "/WnQtddEqG03mbcU1XID1iws1nlKHVkJcaREWknCOiE=",
    "xJ20xXM4QItt5vxFOtolZ5l18p7ej1+RimNkgWmoRFM=",
)


def _lookup_with_tree_note(note: bytes) -> bytes:
    record, _old_note = SIGNED_YAML_LOOKUP.split(b"\n\n", 1)
    return record + b"\n\n" + note


def _lookup_with_record_lines(*record_lines: bytes) -> bytes:
    _record, note = SIGNED_YAML_LOOKUP.split(b"\n\n", 1)
    return b"\n".join((b"10738965", *record_lines)) + b"\n\n" + note


def _verify_bootstrap(response: bytes, proof: object):
    return GoSumdbVerifier().verify_release(
        response,
        module_path="gopkg.in/yaml.v3",
        version="v3.0.1",
        inclusion_proof=proof,
    )


def test_signed_lookup_is_bound_to_the_exact_requested_release() -> None:
    lookup = parse_signed_go_sumdb_lookup(
        SIGNED_YAML_LOOKUP,
        module_path="gopkg.in/yaml.v3",
        version="v3.0.1",
    )

    assert lookup.record_number == 10_738_965
    assert lookup.tree_size == 54_715_574
    assert lookup.tree_hash == "FUQBK+dBbFoa4DioEhMzkxn0fazBN3B6r+ZlT1TImNc="
    assert lookup.module_h1 == "h1:fxVm/GzAzEWqLHuvctI91KS9hhNmmWOoWu0XTYJS7CA="
    assert lookup.go_mod_h1 == "h1:K4uyk7z7BCEPqu6E+C64Yfv1cQ7kz7rIZviUmN+EgEM="


def test_lookup_preserves_the_exact_record_and_signed_note_bytes() -> None:
    lookup = parse_signed_go_sumdb_lookup(
        SIGNED_YAML_LOOKUP,
        module_path="gopkg.in/yaml.v3",
        version="v3.0.1",
    )

    record_prefix, signed_note = SIGNED_YAML_LOOKUP.split(b"\n\n", 1)
    _record_number, record_text = record_prefix.split(b"\n", 1)
    assert lookup.record_text_bytes == record_text + b"\n"
    assert lookup.signed_tree_note_bytes == signed_note


def test_requested_release_is_authenticated_in_the_signed_tree() -> None:
    verified = _verify_bootstrap(SIGNED_YAML_LOOKUP, YAML_INCLUSION_PROOF)

    assert verified.timeline == "pinned_key_empty_timeline_bootstrap"
    assert verified.lookup.record_number == 10_738_965


def test_one_verifier_timeline_advances_only_with_a_consistency_proof() -> None:
    verifier = GoSumdbVerifier()
    first = verifier.verify_release(
        SIGNED_YAML_LOOKUP,
        module_path="gopkg.in/yaml.v3",
        version="v3.0.1",
        inclusion_proof=YAML_INCLUSION_PROOF,
    )

    second = verifier.verify_release(
        _lookup_with_tree_note(NEW_SIGNED_TREE_NOTE),
        module_path="gopkg.in/yaml.v3",
        version="v3.0.1",
        inclusion_proof=YAML_NEW_INCLUSION_PROOF,
        consistency_proof=YAML_CONSISTENCY_PROOF,
    )

    assert first.timeline == "pinned_key_empty_timeline_bootstrap"
    assert first.gossip_verified is False
    assert first.witness_verified is False
    assert second.timeline == "pinned_key_consistent_extension"
    assert second.gossip_verified is False
    assert second.witness_verified is False
    assert verifier.tree_head is not None
    assert verifier.tree_head.tree_size == 54_717_027


@pytest.mark.parametrize(
    "record_lines",
    (
        (
            b"gopkg.in/yaml.v3 v3.0.1 h1:fxVm/GzAzEWqLHuvctI91KS9hhNmmWOoWu0XTYJS7CA=",
        ),
        (
            b"gopkg.in/yaml.v3 v3.0.1 h1:fxVm/GzAzEWqLHuvctI91KS9hhNmmWOoWu0XTYJS7CA=",
            b"gopkg.in/yaml.v3 v3.0.1 h1:fxVm/GzAzEWqLHuvctI91KS9hhNmmWOoWu0XTYJS7CA=",
            b"gopkg.in/yaml.v3 v3.0.1/go.mod h1:K4uyk7z7BCEPqu6E+C64Yfv1cQ7kz7rIZviUmN+EgEM=",
        ),
        (
            b"gopkg.in/yaml.v3 v3.0.1 h1:fxVm/GzAzEWqLHuvctI91KS9hhNmmWOoWu0XTYJS7CA=",
            b"gopkg.in/yaml.v3 v3.0.1 h1:AxVm/GzAzEWqLHuvctI91KS9hhNmmWOoWu0XTYJS7CA=",
            b"gopkg.in/yaml.v3 v3.0.1/go.mod h1:K4uyk7z7BCEPqu6E+C64Yfv1cQ7kz7rIZviUmN+EgEM=",
        ),
        (
            b"example.com/other v1.0.0 h1:fxVm/GzAzEWqLHuvctI91KS9hhNmmWOoWu0XTYJS7CA=",
            b"example.com/other v1.0.0/go.mod h1:K4uyk7z7BCEPqu6E+C64Yfv1cQ7kz7rIZviUmN+EgEM=",
        ),
    ),
)
def test_missing_duplicate_or_unrelated_release_lines_fail_closed(
    record_lines: tuple[bytes, ...],
) -> None:
    with pytest.raises(ValueError):
        parse_signed_go_sumdb_lookup(
            _lookup_with_record_lines(*record_lines),
            module_path="gopkg.in/yaml.v3",
            version="v3.0.1",
        )


def test_conflicting_requested_checksum_fails_record_inclusion() -> None:
    altered = SIGNED_YAML_LOOKUP.replace(
        b"h1:fxVm/GzAzEWqLHuvctI91KS9hhNmmWOoWu0XTYJS7CA=",
        b"h1:AxVm/GzAzEWqLHuvctI91KS9hhNmmWOoWu0XTYJS7CA=",
    )

    with pytest.raises(ValueError, match="inclusion proof"):
        _verify_bootstrap(altered, YAML_INCLUSION_PROOF)


@pytest.mark.parametrize(
    "module_path, version",
    (
        ("gopkg.in/!yaml.v3", "v3.0.1"),
        ("Gopkg.in/yaml.v3", "v3.0.1"),
        ("gopkg.in/yaml.v3", "v3.0.01"),
        ("gopkg.in/yaml.v3", "v4.0.0"),
    ),
)
def test_noncanonical_or_mismatched_lookup_identity_fails_closed(
    module_path: str,
    version: str,
) -> None:
    with pytest.raises(ValueError):
        parse_signed_go_sumdb_lookup(
            SIGNED_YAML_LOOKUP,
            module_path=module_path,
            version=version,
        )


@pytest.mark.parametrize(
    "proof",
    (
        YAML_INCLUSION_PROOF[:-1],
        (*YAML_INCLUSION_PROOF, YAML_INCLUSION_PROOF[-1]),
        (*YAML_INCLUSION_PROOF[:-1], "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
        (*YAML_INCLUSION_PROOF[:-1], "not-base64"),
        tuple("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" for _ in range(65)),
        "not-a-sequence-of-hashes",
    ),
)
def test_malformed_or_wrong_inclusion_proof_fails_closed(proof: object) -> None:
    with pytest.raises(ValueError, match="inclusion proof"):
        _verify_bootstrap(SIGNED_YAML_LOOKUP, proof)


@pytest.mark.parametrize("proof_field", ("inclusion_proof", "consistency_proof"))
def test_oversized_proof_element_is_rejected_before_base64_decode(
    monkeypatch: pytest.MonkeyPatch,
    proof_field: str,
) -> None:
    oversized = "A" * (1024 * 1024)
    real_decode = go_sumdb_module.base64.b64decode

    def guarded_decode(value: object, *args: object, **kwargs: object) -> bytes:
        if value is oversized:
            raise AssertionError("oversized proof element reached base64 decoding")
        return real_decode(value, *args, **kwargs)

    monkeypatch.setattr(go_sumdb_module.base64, "b64decode", guarded_decode)
    proofs: dict[str, object] = {
        "inclusion_proof": YAML_INCLUSION_PROOF,
        "consistency_proof": (),
    }
    proofs[proof_field] = (oversized,)

    with pytest.raises(ValueError, match=f"{proof_field.removesuffix('_proof')} proof"):
        GoSumdbVerifier().verify_release(
            SIGNED_YAML_LOOKUP,
            module_path="gopkg.in/yaml.v3",
            version="v3.0.1",
            **proofs,
        )


@pytest.mark.parametrize("proof_field", ("inclusion_proof", "consistency_proof"))
def test_non_list_or_tuple_proof_sequence_fails_closed(proof_field: str) -> None:
    proofs: dict[str, object] = {
        "inclusion_proof": YAML_INCLUSION_PROOF,
        "consistency_proof": (),
    }
    proofs[proof_field] = range(0)

    with pytest.raises(ValueError, match="bounded list or tuple"):
        GoSumdbVerifier().verify_release(
            SIGNED_YAML_LOOKUP,
            module_path="gopkg.in/yaml.v3",
            version="v3.0.1",
            **proofs,
        )


@pytest.mark.parametrize(
    "altered_note",
    (
        SIGNED_YAML_LOOKUP.replace(b"sum.golang.org Az3", b"evil.example Az3"),
        SIGNED_YAML_LOOKUP.replace(b"Az3grpR", b"Bz3grpR"),
        SIGNED_YAML_LOOKUP.replace(b"FUQBK+", b"GUQBK+"),
        SIGNED_YAML_LOOKUP.rstrip(b"\n"),
        SIGNED_YAML_LOOKUP.replace(b"\n", b"\r\n", 1),
    ),
)
def test_bad_key_signature_tree_or_note_encoding_fails_closed(altered_note: bytes) -> None:
    with pytest.raises(ValueError):
        parse_signed_go_sumdb_lookup(
            altered_note,
            module_path="gopkg.in/yaml.v3",
            version="v3.0.1",
        )


def test_v1_refuses_a_co_signed_checkpoint_even_with_the_official_signature() -> None:
    record, note = SIGNED_YAML_LOOKUP.split(b"\n\n", 1)
    signed_text, official_signature = note.split(b"\n\n", 1)
    witness_signature = (
        b"\xe2\x80\x94 witness.example " + b"A" * 91 + b"="
    )
    co_signed = (
        record
        + b"\n\n"
        + signed_text
        + b"\n\n"
        + official_signature.rstrip(b"\n")
        + b"\n"
        + witness_signature
        + b"\n"
    )

    with pytest.raises(ValueError, match="one signature"):
        parse_signed_go_sumdb_lookup(
            co_signed,
            module_path="gopkg.in/yaml.v3",
            version="v3.0.1",
        )


def test_v1_refuses_future_extended_signed_tree_text() -> None:
    tree_hash = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

    with pytest.raises(ValueError, match="tree head"):
        _parse_tree_text(
            f"go.sum database tree\n1\n{tree_hash}\nfuture extension\n"
        )


def test_empty_timeline_rejects_caller_supplied_consistency_material() -> None:
    verifier = GoSumdbVerifier()

    with pytest.raises(ValueError, match="empty.*timeline"):
        verifier.verify_release(
            SIGNED_YAML_LOOKUP,
            module_path="gopkg.in/yaml.v3",
            version="v3.0.1",
            inclusion_proof=YAML_INCLUSION_PROOF,
            consistency_proof=(YAML_CONSISTENCY_PROOF[0],),
        )
    assert verifier.tree_head is None


def test_newer_tree_requires_valid_consistency_and_preserves_prior_on_failure() -> None:
    verifier = GoSumdbVerifier()
    verifier.verify_release(
        SIGNED_YAML_LOOKUP,
        module_path="gopkg.in/yaml.v3",
        version="v3.0.1",
        inclusion_proof=YAML_INCLUSION_PROOF,
    )

    wrong_proof = (
        *YAML_CONSISTENCY_PROOF[:-1],
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    )
    for proof in ((), YAML_CONSISTENCY_PROOF[:-1], wrong_proof):
        with pytest.raises(ValueError, match="consistency proof"):
            verifier.verify_release(
                _lookup_with_tree_note(NEW_SIGNED_TREE_NOTE),
                module_path="gopkg.in/yaml.v3",
                version="v3.0.1",
                inclusion_proof=YAML_NEW_INCLUSION_PROOF,
                consistency_proof=proof,
            )
        assert verifier.tree_head is not None
        assert verifier.tree_head.tree_size == 54_715_574


def test_older_signed_tree_never_downgrades_a_verifier_timeline() -> None:
    verifier = GoSumdbVerifier()
    verifier.verify_release(
        SIGNED_YAML_LOOKUP,
        module_path="gopkg.in/yaml.v3",
        version="v3.0.1",
        inclusion_proof=YAML_INCLUSION_PROOF,
    )
    verifier.verify_release(
        _lookup_with_tree_note(NEW_SIGNED_TREE_NOTE),
        module_path="gopkg.in/yaml.v3",
        version="v3.0.1",
        inclusion_proof=YAML_NEW_INCLUSION_PROOF,
        consistency_proof=YAML_CONSISTENCY_PROOF,
    )

    with pytest.raises(ValueError, match="rollback"):
        verifier.verify_release(
            SIGNED_YAML_LOOKUP,
            module_path="gopkg.in/yaml.v3",
            version="v3.0.1",
            inclusion_proof=YAML_INCLUSION_PROOF,
        )
    assert verifier.tree_head is not None
    assert verifier.tree_head.tree_size == 54_717_027


def test_same_size_different_root_is_a_fork_even_after_valid_lookup_proof() -> None:
    verifier = GoSumdbVerifier()
    verifier.verify_release(
        SIGNED_YAML_LOOKUP,
        module_path="gopkg.in/yaml.v3",
        version="v3.0.1",
        inclusion_proof=YAML_INCLUSION_PROOF,
    )
    assert verifier.tree_head is not None
    verifier._tree_head = replace(verifier.tree_head, tree_hash_bytes=b"\x00" * 32)

    with pytest.raises(ValueError, match="fork"):
        verifier.verify_release(
            SIGNED_YAML_LOOKUP,
            module_path="gopkg.in/yaml.v3",
            version="v3.0.1",
            inclusion_proof=YAML_INCLUSION_PROOF,
        )


def test_same_authenticated_tree_is_idempotent_without_proof() -> None:
    verifier = GoSumdbVerifier()
    verifier.verify_release(
        SIGNED_YAML_LOOKUP,
        module_path="gopkg.in/yaml.v3",
        version="v3.0.1",
        inclusion_proof=YAML_INCLUSION_PROOF,
    )

    replay = verifier.verify_release(
        SIGNED_YAML_LOOKUP,
        module_path="gopkg.in/yaml.v3",
        version="v3.0.1",
        inclusion_proof=YAML_INCLUSION_PROOF,
    )

    assert replay.timeline == "pinned_key_same_tree"


def test_same_authenticated_tree_rejects_unnecessary_consistency_proof() -> None:
    verifier = GoSumdbVerifier()
    verifier.verify_release(
        SIGNED_YAML_LOOKUP,
        module_path="gopkg.in/yaml.v3",
        version="v3.0.1",
        inclusion_proof=YAML_INCLUSION_PROOF,
    )

    with pytest.raises(ValueError, match="unchanged.*proof"):
        verifier.verify_release(
            SIGNED_YAML_LOOKUP,
            module_path="gopkg.in/yaml.v3",
            version="v3.0.1",
            inclusion_proof=YAML_INCLUSION_PROOF,
            consistency_proof=(YAML_CONSISTENCY_PROOF[0],),
        )


def test_public_verifier_has_one_exact_official_key_and_no_key_override() -> None:
    assert GO_SUMDB_VERIFIER_KEY == (
        "sum.golang.org+033de0ae+"
        "Ac4zctda0e5eza+HJyk9SxEdh+s3Ux18htTTAD8OuAn8"
    )
    with pytest.raises(TypeError):
        GoSumdbVerifier("caller-supplied-key")  # type: ignore[call-arg]


@pytest.mark.parametrize(
    "record_number",
    (b"01", b"+10738965", b"-1", b"9223372036854775808"),
)
def test_noncanonical_or_out_of_range_record_number_fails_closed(
    record_number: bytes,
) -> None:
    _old_number, rest = SIGNED_YAML_LOOKUP.split(b"\n", 1)
    with pytest.raises(ValueError, match="lookup record"):
        parse_signed_go_sumdb_lookup(
            record_number + b"\n" + rest,
            module_path="gopkg.in/yaml.v3",
            version="v3.0.1",
        )


def test_tree_text_has_the_same_signed_int64_size_bound_as_go() -> None:
    tree_hash = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    size, parsed_hash = _parse_tree_text(
        f"go.sum database tree\n{(1 << 63) - 1}\n{tree_hash}\n"
    )
    assert size == (1 << 63) - 1
    assert parsed_hash == b"\x00" * 32

    for invalid_size in ("0", str(1 << 63)):
        with pytest.raises(ValueError, match="tree head"):
            _parse_tree_text(
                f"go.sum database tree\n{invalid_size}\n{tree_hash}\n"
            )


def test_lookup_and_retained_note_byte_caps_fail_before_parsing() -> None:
    oversized = b"x" * (1024 * 1024 + 1)
    with pytest.raises(ValueError, match="byte limit"):
        parse_signed_go_sumdb_lookup(
            oversized,
            module_path="gopkg.in/yaml.v3",
            version="v3.0.1",
        )
    with pytest.raises(ValueError, match="byte limit"):
        GoSumdbVerifier.from_retained_signed_tree_note(oversized)


def test_retained_state_requires_raw_signed_note_bytes() -> None:
    lookup = parse_signed_go_sumdb_lookup(
        SIGNED_YAML_LOOKUP,
        module_path="gopkg.in/yaml.v3",
        version="v3.0.1",
    )

    with pytest.raises(ValueError, match="must be bytes"):
        GoSumdbVerifier.from_retained_signed_tree_note(lookup.tree_head)


def test_verifier_restarts_from_a_reverified_retained_signed_note() -> None:
    _record, retained_note = SIGNED_YAML_LOOKUP.split(b"\n\n", 1)
    verifier = GoSumdbVerifier.from_retained_signed_tree_note(retained_note)

    extension = verifier.verify_release(
        _lookup_with_tree_note(NEW_SIGNED_TREE_NOTE),
        module_path="gopkg.in/yaml.v3",
        version="v3.0.1",
        inclusion_proof=YAML_NEW_INCLUSION_PROOF,
        consistency_proof=YAML_CONSISTENCY_PROOF,
    )

    assert extension.timeline == "pinned_key_consistent_extension"
    assert verifier.tree_head is not None
    assert verifier.tree_head.signed_note_bytes == NEW_SIGNED_TREE_NOTE


@pytest.mark.parametrize(
    "tampered",
    (
        SIGNED_YAML_LOOKUP.split(b"\n\n", 1)[1].replace(
            b"sum.golang.org Az3",
            b"evil.example Az3",
        ),
        SIGNED_YAML_LOOKUP.split(b"\n\n", 1)[1].replace(b"Az3grpR", b"Bz3grpR"),
        SIGNED_YAML_LOOKUP.split(b"\n\n", 1)[1].replace(b"FUQBK+", b"GUQBK+"),
    ),
)
def test_restart_rejects_tampered_or_wrong_key_prior_note(tampered: bytes) -> None:
    with pytest.raises(ValueError):
        GoSumdbVerifier.from_retained_signed_tree_note(tampered)
