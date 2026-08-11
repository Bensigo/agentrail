from __future__ import annotations

import hashlib
from dataclasses import FrozenInstanceError

import pytest

import agentrail.dependencies.source_inventory as source_inventory_module
from agentrail.dependencies.source_inventory import (
    GO_GITHUB_SOURCE_INVENTORY_PROFILE,
    GoGithubInventoryEntry,
    ValidatedGoGithubInventory,
    build_go_github_source_inventory_receipt,
    git_blob_object_id,
    validate_go_github_source_inventory,
)


COMMIT_SHA = "a" * 40
TREE_SHA = "b" * 40
GO_MOD = b"module example.com/root\n\ngo 1.26\n"
GO_SUM = b"example.com/lib v1.2.3 h1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n"


def _entry(path: str, content: bytes) -> dict[str, object]:
    return {
        "path": path,
        "mode": "100644",
        "type": "blob",
        "sha": git_blob_object_id(content, hash_hex_length=40),
    }


def _inventory(entries: list[dict[str, object]]):
    return validate_go_github_source_inventory(
        repository="acme/widgets",
        requested_ref="main",
        commit={"sha": COMMIT_SHA, "commit": {"tree": {"sha": TREE_SHA}}},
        tree_response={"sha": TREE_SHA, "truncated": False, "tree": entries},
    )


def test_go_receipt_is_stable_recomputable_and_source_free() -> None:
    entries = [
        _entry("go.sum", GO_SUM),
        {"path": "src", "mode": "040000", "type": "tree", "sha": "c" * 40},
        _entry("go.mod", GO_MOD),
    ]
    receipt = build_go_github_source_inventory_receipt(
        _inventory(entries),
        {"go.mod": GO_MOD, "go.sum": GO_SUM},
    )
    reordered = build_go_github_source_inventory_receipt(
        _inventory(list(reversed(entries))),
        {"go.sum": GO_SUM, "go.mod": GO_MOD},
    )

    payload = receipt.as_dict()
    assert receipt.identity_sha256 == reordered.identity_sha256
    assert receipt.canonical_json == reordered.canonical_json
    assert payload["identity"] == {
        "ecosystem": "go",
        "manager": "go-modules",
        "profile": GO_GITHUB_SOURCE_INVENTORY_PROFILE,
    }
    assert [entry["path"] for entry in payload["inventory"]["entries"]] == [
        "go.mod",
        "go.sum",
        "src",
    ]
    assert payload["authority"]["commitSha"] == COMMIT_SHA
    assert payload["authority"]["rootTreeSha"] == TREE_SHA
    assert payload["identitySha256"] == receipt.identity_sha256
    assert payload["requiredFiles"] == [
        {
            "path": "go.mod",
            "mode": "100644",
            "blobSha": git_blob_object_id(GO_MOD, hash_hex_length=40),
            "byteCount": len(GO_MOD),
            "contentSha256": hashlib.sha256(GO_MOD).hexdigest(),
        },
        {
            "path": "go.sum",
            "mode": "100644",
            "blobSha": git_blob_object_id(GO_SUM, hash_hex_length=40),
            "byteCount": len(GO_SUM),
            "contentSha256": hashlib.sha256(GO_SUM).hexdigest(),
        },
    ]
    assert "module example.com/root" not in receipt.canonical_json
    assert "AAAAAAAAAAAAAAAA" not in receipt.canonical_json


def test_go_receipt_refuses_root_body_that_does_not_match_the_tree_blob() -> None:
    inventory = _inventory([_entry("go.mod", GO_MOD), _entry("go.sum", GO_SUM)])

    with pytest.raises(ValueError, match="local Git blob identity"):
        build_go_github_source_inventory_receipt(
            inventory,
            {"go.mod": GO_MOD + b" ", "go.sum": GO_SUM},
        )


@pytest.mark.parametrize(
    ("entry", "reason"),
    (
        ({"path": "link", "mode": "120000", "type": "blob", "sha": "d" * 40}, "mode"),
        ({"path": "opaque", "mode": "160000", "type": "commit", "sha": "d" * 40}, "submodule"),
        ({"path": "bad\\path", "mode": "100644", "type": "blob", "sha": "d" * 40}, "canonical"),
        ({"path": "src", "mode": "040000", "type": "tree", "sha": "D" * 40}, "object SHA"),
    ),
)
def test_go_inventory_refuses_non_recomputable_entries(
    entry: dict[str, object], reason: str,
) -> None:
    entries = [_entry("go.mod", GO_MOD), _entry("go.sum", GO_SUM), entry]

    with pytest.raises(ValueError, match=reason):
        _inventory(entries)


def test_go_inventory_refuses_mixed_hash_families() -> None:
    entries = [_entry("go.mod", GO_MOD), _entry("go.sum", GO_SUM)]
    entries[0]["sha"] = "d" * 64

    with pytest.raises(ValueError, match="hash family"):
        _inventory(entries)


@pytest.mark.parametrize(
    ("path", "reason"),
    (
        ("café/file.go", "ASCII"),
        ("go.work", "go.work"),
        ("nested/go.sum", "nested"),
        ("src/vendor/lib.go", "vendored"),
        ("home/.netrc", "configuration"),
        ("tools/.gitconfig", "configuration"),
        (".goenv", "configuration"),
        ("go.env", "configuration"),
        ("nested/.config/go/env", "configuration"),
    ),
)
def test_go_inventory_path_policy_is_ascii_and_matches_go_source_refusals(
    path: str,
    reason: str,
) -> None:
    entries = [
        _entry("go.mod", GO_MOD),
        _entry("go.sum", GO_SUM),
        {"path": path, "mode": "100644", "type": "blob", "sha": "d" * 40},
    ]

    with pytest.raises(ValueError, match=reason):
        _inventory(entries)


def test_go_inventory_enforces_aggregate_path_bytes(monkeypatch) -> None:
    monkeypatch.setattr(
        source_inventory_module,
        "GO_SOURCE_INVENTORY_MAX_TOTAL_PATH_BYTES",
        len("go.mod") + len("go.sum"),
    )

    with pytest.raises(ValueError, match="path byte limit"):
        _inventory([
            _entry("go.mod", GO_MOD),
            _entry("go.sum", GO_SUM),
            {"path": "x", "mode": "100644", "type": "blob", "sha": "d" * 40},
        ])


def test_manual_inventory_cannot_override_or_mutate_required_root_blob_identity() -> None:
    manual = ValidatedGoGithubInventory(
        repository="acme/widgets",
        requested_ref="main",
        commit_sha=COMMIT_SHA,
        root_tree_sha=TREE_SHA,
        entries=(
            GoGithubInventoryEntry("go.mod", "100644", "blob", "d" * 40),
            GoGithubInventoryEntry(
                "go.sum",
                "100644",
                "blob",
                git_blob_object_id(GO_SUM, hash_hex_length=40),
            ),
        ),
    )

    assert not hasattr(manual, "required_blob_shas")
    with pytest.raises(FrozenInstanceError):
        manual.entries = ()  # type: ignore[misc]
    with pytest.raises(ValueError, match="local Git blob identity"):
        build_go_github_source_inventory_receipt(
            manual,
            {"go.mod": GO_MOD, "go.sum": GO_SUM},
        )
