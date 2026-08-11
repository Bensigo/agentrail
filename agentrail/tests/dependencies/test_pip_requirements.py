from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

import agentrail.dependencies.pip_requirements as pip_requirements
from agentrail.dependencies.pip_requirements import (
    PIP_GRAPH_PROVENANCE_REASON,
    PIP_GRAPH_PROVENANCE_UNRESOLVED,
    parse_pip_requirements_snapshot,
)


FIXTURES = Path(__file__).parent / "fixtures" / "pip"
HASH_A = "a" * 64
HASH_B = "b" * 64


def snapshot(requirements_in: object, requirements_txt: object) -> dict[str, object]:
    return {
        "requirements.in": requirements_in,
        "requirements.txt": requirements_txt,
    }


def test_parses_exact_direct_intent_and_hashed_compiled_fixture_without_graph_claim() -> None:
    requirements_in = (FIXTURES / "requirements.in").read_text()
    requirements_txt = (FIXTURES / "requirements.txt").read_text()
    parsed = parse_pip_requirements_snapshot(
        snapshot(requirements_in, requirements_txt)
    )

    assert [(item.name, item.version) for item in parsed.direct] == [
        ("requests", "2.32.3"),
        ("urllib3", "2.5.0"),
    ]
    assert [item.name for item in parsed.compiled] == [
        "certifi",
        "charset-normalizer",
        "idna",
        "requests",
        "urllib3",
    ]
    assert parsed.compiled[0].sha256_hashes == (HASH_A, HASH_B)
    assert [(item.path, item.sha256, item.byte_count) for item in parsed.file_custody] == [
        (
            "requirements.in",
            hashlib.sha256(requirements_in.encode()).hexdigest(),
            len(requirements_in.encode()),
        ),
        (
            "requirements.txt",
            hashlib.sha256(requirements_txt.encode()).hexdigest(),
            len(requirements_txt.encode()),
        ),
    ]
    assert parsed.graph_provenance.status == PIP_GRAPH_PROVENANCE_UNRESOLVED
    assert parsed.graph_provenance.reason == PIP_GRAPH_PROVENANCE_REASON
    assert "dependency edges" in parsed.graph_provenance.reason


@pytest.mark.parametrize(
    "files",
    [
        None,
        {},
        {"requirements.in": "requests==2.32.3"},
        {
            "Requirements.in": "requests==2.32.3",
            "requirements.txt": f"requests==2.32.3 --hash=sha256:{HASH_A}",
        },
        {
            "../requirements.in": "requests==2.32.3",
            "requirements.txt": f"requests==2.32.3 --hash=sha256:{HASH_A}",
        },
        {
            "requirements/base.in": "requests==2.32.3",
            "requirements.txt": f"requests==2.32.3 --hash=sha256:{HASH_A}",
        },
        {
            "requirements.in": "requests==2.32.3",
            "requirements.txt": f"requests==2.32.3 --hash=sha256:{HASH_A}",
            "pip.conf": "[global]",
        },
    ],
)
def test_requires_only_the_exact_two_root_filenames(files: object) -> None:
    with pytest.raises(ValueError):
        parse_pip_requirements_snapshot(files)


@pytest.mark.parametrize(
    "line",
    [
        "Requests==2.32.3",
        "requests_lib==2.32.3",
        "requests..lib==2.32.3",
        "requests[socks]==2.32.3",
        "requests>=2.32.3",
        "requests~=2.32.3",
        "requests==2.32.3; python_version >= '3.11'",
        "requests @ https://files.example.invalid/requests.whl",
        "https://files.example.invalid/requests.whl",
        "./requests.whl",
        "git+https://example.invalid/requests.git",
        "-e git+https://example.invalid/requests.git",
        "-r other-requirements.in",
        "-c constraints.txt",
        "--index-url https://example.invalid/simple",
        "--extra-index-url https://example.invalid/simple",
        "--no-binary requests",
        "# requests==2.32.3",
        " requests==2.32.3",
        "requests==2.32.3 ",
        "requests\t==2.32.3",
        "requests==2.32.3 --hash=sha256:" + HASH_A,
    ],
)
def test_direct_intent_rejects_aliases_options_sources_markers_and_ambiguity(
    line: str,
) -> None:
    with pytest.raises(ValueError):
        parse_pip_requirements_snapshot(
            snapshot(line, f"requests==2.32.3 --hash=sha256:{HASH_A}")
        )


@pytest.mark.parametrize(
    "version",
    [
        "01.2",
        "1.02",
        "1.2.3.4.5",
        "1.2rc1",
        "1.2.post1",
        "1.2.dev1",
        "1.2+local",
        "1!1.2",
        "1.2.*",
        "1.2-1",
        "99999999999999999.1",
    ],
)
def test_rejects_versions_outside_the_narrow_canonical_stable_subset(
    version: str,
) -> None:
    with pytest.raises(ValueError, match="canonical stable release"):
        parse_pip_requirements_snapshot(
            snapshot(
                f"requests=={version}",
                f"requests=={version} --hash=sha256:{HASH_A}",
            )
        )


def test_admits_one_to_four_bounded_stable_release_components() -> None:
    for version in ("1", "1.2", "1.2.3", "1.2.3.4"):
        parsed = parse_pip_requirements_snapshot(
            snapshot(
                f"single-release=={version}",
                f"single-release=={version} --hash=sha256:{HASH_A}",
            )
        )
        assert parsed.direct[0].version == version


@pytest.mark.parametrize(
    "line",
    [
        "requests==2.32.3",
        "requests>=2.32.3 --hash=sha256:" + HASH_A,
        "Requests==2.32.3 --hash=sha256:" + HASH_A,
        "requests[socks]==2.32.3 --hash=sha256:" + HASH_A,
        "requests==2.32.3; python_version >= '3.11' --hash=sha256:" + HASH_A,
        "requests @ https://files.example.invalid/requests.whl --hash=sha256:" + HASH_A,
        "https://files.example.invalid/requests.whl --hash=sha256:" + HASH_A,
        "./requests.whl --hash=sha256:" + HASH_A,
        "git+https://example.invalid/requests.git#egg=requests --hash=sha256:" + HASH_A,
        "-e git+https://example.invalid/requests.git#egg=requests",
        "-r other-requirements.txt",
        "-c constraints.txt",
        "--require-hashes",
        "--index-url https://example.invalid/simple",
        "--only-binary :all:",
        "requests==2.32.3 --hash=sha512:" + HASH_A,
        "requests==2.32.3 --hash=sha256:" + "a" * 63,
        "requests==2.32.3 --hash=sha256:" + "A" * 64,
        "requests==2.32.3 --hash=sha256:" + HASH_A + " # via root",
        "requests==2.32.3 \\",
        "    --hash=sha256:" + HASH_A,
        " requests==2.32.3 --hash=sha256:" + HASH_A,
        "requests==2.32.3  --hash=sha256:" + HASH_A,
        "requests==2.32.3 --hash=sha256:" + HASH_A + " ",
    ],
)
def test_compiled_file_rejects_unhashed_and_noncanonical_requirement_forms(
    line: str,
) -> None:
    with pytest.raises(ValueError):
        parse_pip_requirements_snapshot(snapshot("requests==2.32.3", line))


def test_adversarial_option_and_unhashed_fixtures_fail_closed() -> None:
    for filename in ("adversarial-options.txt", "adversarial-unhashed.txt"):
        with pytest.raises(ValueError):
            parse_pip_requirements_snapshot(
                snapshot("requests==2.32.3", (FIXTURES / filename).read_text())
            )


def test_adversarial_alias_fixture_fails_closed() -> None:
    with pytest.raises(ValueError, match="canonical PyPI distribution name"):
        parse_pip_requirements_snapshot(
            snapshot(
                (FIXTURES / "adversarial-alias.in").read_text(),
                f"requests-lib==2.32.3 --hash=sha256:{HASH_A}",
            )
        )


def test_rejects_duplicate_or_case_colliding_names_and_duplicate_hashes() -> None:
    with pytest.raises(ValueError, match="duplicates distribution requests"):
        parse_pip_requirements_snapshot(
            snapshot(
                "requests==2.32.3\nrequests==2.32.3",
                f"requests==2.32.3 --hash=sha256:{HASH_A}",
            )
        )
    with pytest.raises(ValueError, match="canonical PyPI distribution name"):
        parse_pip_requirements_snapshot(
            snapshot(
                "requests==2.32.3",
                "requests==2.32.3 --hash=sha256:"
                + HASH_A
                + "\nRequests==2.32.3 --hash=sha256:"
                + HASH_B,
            )
        )
    with pytest.raises(ValueError, match="duplicates a sha256 hash"):
        parse_pip_requirements_snapshot(
            snapshot(
                "requests==2.32.3",
                f"requests==2.32.3 --hash=sha256:{HASH_A} --hash=sha256:{HASH_A}",
            )
        )


def test_requires_every_direct_pin_at_the_identical_compiled_version() -> None:
    with pytest.raises(ValueError, match="missing direct distribution requests"):
        parse_pip_requirements_snapshot(
            snapshot(
                "requests==2.32.3",
                f"urllib3==2.5.0 --hash=sha256:{HASH_A}",
            )
        )
    with pytest.raises(ValueError, match="exact direct version for requests"):
        parse_pip_requirements_snapshot(
            snapshot(
                "requests==2.32",
                f"requests==2.32.0 --hash=sha256:{HASH_A}",
            )
        )


@pytest.mark.parametrize("bad_text", [None, b"requests==2.32.3", "\ud800"])
def test_rejects_non_text_and_invalid_utf8_inputs(bad_text: object) -> None:
    with pytest.raises(ValueError):
        parse_pip_requirements_snapshot(
            snapshot(bad_text, f"requests==2.32.3 --hash=sha256:{HASH_A}")
        )


@pytest.mark.parametrize(
    "requirements_in, requirements_txt",
    [
        (
            "\ufeffrequests==2.32.3",
            f"requests==2.32.3 --hash=sha256:{HASH_A}",
        ),
        (
            "requests==2.32.3\r\n",
            f"requests==2.32.3 --hash=sha256:{HASH_A}",
        ),
        (
            "requests==2.32.3",
            f"\ufeffrequests==2.32.3 --hash=sha256:{HASH_A}",
        ),
        (
            "requests==2.32.3",
            f"requests==2.32.3 --hash=sha256:{HASH_A}\r\n",
        ),
    ],
)
def test_rejects_bom_and_crlf_custody_aliases(
    requirements_in: str, requirements_txt: str
) -> None:
    with pytest.raises(ValueError):
        parse_pip_requirements_snapshot(snapshot(requirements_in, requirements_txt))


def test_enforces_document_line_package_and_hash_bounds(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(ValueError, match="requirements.in exceeds the byte limit"):
        parse_pip_requirements_snapshot(
            snapshot(
                "x" * (pip_requirements.PIP_REQUIREMENTS_IN_MAX_BYTES + 1),
                f"requests==2.32.3 --hash=sha256:{HASH_A}",
            )
        )
    with pytest.raises(ValueError, match="line limit"):
        parse_pip_requirements_snapshot(
            snapshot(
                "\n" * pip_requirements.PIP_REQUIREMENTS_IN_MAX_LINES,
                f"requests==2.32.3 --hash=sha256:{HASH_A}",
            )
        )
    with pytest.raises(ValueError, match="line 1 exceeds the byte limit"):
        parse_pip_requirements_snapshot(
            snapshot(
                "x" * (pip_requirements.PIP_REQUIREMENT_LINE_MAX_BYTES + 1),
                f"requests==2.32.3 --hash=sha256:{HASH_A}",
            )
        )

    monkeypatch.setattr(pip_requirements, "PIP_MAX_DIRECT_REQUIREMENTS", 1)
    with pytest.raises(ValueError, match="direct-requirement limit"):
        parse_pip_requirements_snapshot(
            snapshot(
                "requests==2.32.3\nurllib3==2.5.0",
                "requests==2.32.3 --hash=sha256:"
                + HASH_A
                + "\nurllib3==2.5.0 --hash=sha256:"
                + HASH_B,
            )
        )

    monkeypatch.setattr(pip_requirements, "PIP_MAX_DIRECT_REQUIREMENTS", 512)
    monkeypatch.setattr(pip_requirements, "PIP_MAX_COMPILED_REQUIREMENTS", 1)
    with pytest.raises(ValueError, match="compiled-requirement limit"):
        parse_pip_requirements_snapshot(
            snapshot(
                "requests==2.32.3",
                "requests==2.32.3 --hash=sha256:"
                + HASH_A
                + "\nurllib3==2.5.0 --hash=sha256:"
                + HASH_B,
            )
        )

    monkeypatch.setattr(pip_requirements, "PIP_MAX_COMPILED_REQUIREMENTS", 5_000)
    monkeypatch.setattr(pip_requirements, "PIP_MAX_HASHES_PER_REQUIREMENT", 1)
    with pytest.raises(ValueError, match="per-requirement hash limit"):
        parse_pip_requirements_snapshot(
            snapshot(
                "requests==2.32.3",
                f"requests==2.32.3 --hash=sha256:{HASH_A} --hash=sha256:{HASH_B}",
            )
        )

    monkeypatch.setattr(pip_requirements, "PIP_MAX_HASHES_PER_REQUIREMENT", 32)
    monkeypatch.setattr(pip_requirements, "PIP_MAX_TOTAL_HASHES", 1)
    with pytest.raises(ValueError, match="total hash limit"):
        parse_pip_requirements_snapshot(
            snapshot(
                "requests==2.32.3",
                "requests==2.32.3 --hash=sha256:"
                + HASH_A
                + "\nurllib3==2.5.0 --hash=sha256:"
                + HASH_B,
            )
        )


def test_blank_lines_are_the_only_non_requirement_lines_admitted() -> None:
    parsed = parse_pip_requirements_snapshot(
        snapshot(
            "\nrequests==2.32.3\n\n",
            f"\nrequests==2.32.3 --hash=sha256:{HASH_A}\n\n",
        )
    )
    assert len(parsed.direct) == len(parsed.compiled) == 1

    for noncanonical_blank in (" ", "\t", "\u00a0"):
        with pytest.raises(ValueError):
            parse_pip_requirements_snapshot(
                snapshot(
                    "requests==2.32.3\n" + noncanonical_blank,
                    f"requests==2.32.3 --hash=sha256:{HASH_A}",
                )
            )
