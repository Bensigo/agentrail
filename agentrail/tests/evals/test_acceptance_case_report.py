"""Tests for offline Acceptance Case report serialization and publication."""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from agentrail.evals.acceptance_case.offline_runner import AcceptanceRunReport
from agentrail.evals.acceptance_case.report import (
    AcceptanceReportFormatError,
    acceptance_run_report_from_dict,
    parse_acceptance_run_report_json,
    render_acceptance_run_report_markdown,
    serialize_acceptance_run_report,
    write_acceptance_run_report_markdown,
    MAX_REPORT_INPUT_BYTES,
)
from agentrail.evals.acceptance_case.scorecards import AcceptanceObservation


def _observation(**overrides: object) -> AcceptanceObservation:
    provenance = {
        "caseVersion": "case-v1",
        "corpusVersion": "corpus-v1",
        "repository": "acme/app",
        "repositoryCommit": "base-sha",
        "contractVersion": "contract-v1",
        "model": "builder-v1",
        "configVersion": "config-v1",
        "promptVersion": "prompt-v1",
        "guardrailVersion": "guardrail-v1",
        "contextPackHash": "sha256:pack",
        "contextPackTokenBudget": "900",
        "prHead": "head-sha",
        "diffIdentity": "sha256:diff",
        "environmentId": "preview-1",
        "artifactRefs": "artifact-1",
        "scorerVersion": "scorer-v1",
        "outcomeSource": "independent-label-v1",
    }
    base: dict[str, object] = {
        "case": "case-1",
        "arm": "full-jace-loop",
        "scorecard": "proof",
        "segment": "ui",
        "evidence_class": "offline",
        "independent_truth": True,
        "jace_claim": True,
        "provenance": provenance,
    }
    base.update(overrides)
    return AcceptanceObservation(**base)  # type: ignore[arg-type]


def _scorecard(**overrides: int) -> dict[str, int]:
    metrics = {
        "total": 1,
        "scored": 1,
        "unscored": 0,
        "claim_true": 1,
        "truth_true": 1,
        "false_green": 0,
        "false_block": 0,
    }
    metrics.update(overrides)
    return metrics


def test_round_trip_is_deterministic_and_preserves_nullable_claims_and_lineage() -> None:
    report = AcceptanceRunReport(
        observations=(
            _observation(case="case-b", independent_truth=None, jace_claim=None),
            _observation(case="case-a", independent_truth=False, jace_claim=True),
        ),
        scorecards={
            "full-jace-loop:offline:proof:ui": _scorecard(
                total=2, scored=1, unscored=1
            )
        },
        promotion=None,
    )

    payload = serialize_acceptance_run_report(report)
    parsed = parse_acceptance_run_report_json(payload)

    assert serialize_acceptance_run_report(parsed) == payload
    assert parsed.observations[0].independent_truth is None
    assert parsed.observations[0].jace_claim is None
    assert parsed.observations[0].provenance["prHead"] == "head-sha"
    markdown = render_acceptance_run_report_markdown(parsed)
    assert markdown.index("case-a") < markdown.index("case-b")
    assert "| prHead | head-sha |" in markdown
    assert "| contextPackTokenBudget | 900 |" in markdown
    assert "| full-jace-loop:offline:proof:ui | 2 | 1 | 1 |" in markdown
    assert "OFFLINE EVIDENCE ONLY" in markdown


def test_empty_report_cannot_render_as_evidence_or_promotion() -> None:
    report = AcceptanceRunReport(
        observations=(),
        scorecards={
            "full-jace-loop:offline:proof:ui": _scorecard(
                total=0,
                scored=0,
                unscored=0,
                claim_true=0,
                truth_true=0,
            )
        },
        promotion=None,
    )

    markdown = render_acceptance_run_report_markdown(report)
    assert "NO OFFLINE EVIDENCE" in markdown
    assert "Not evaluated: no observations supplied." in markdown
    assert "| full-jace-loop:offline:proof:ui | 0 | 0 | 0 |" in markdown
    assert "Status: promote" not in markdown


@pytest.mark.parametrize(
    "payload, expected",
    [
        ("{", "invalid JSON"),
        (
            json.dumps(
                {
                    "formatVersion": 2,
                    "observations": [],
                    "scorecards": {},
                    "promotion": None,
                    "corpusProvenance": None,
                }
            ),
            "formatVersion",
        ),
        (
            json.dumps(
                {
                    "formatVersion": 1,
                    "observations": [{"arm": "full"}],
                    "scorecards": {},
                    "promotion": None,
                    "corpusProvenance": None,
                }
            ),
            "observations[0]",
        ),
    ],
)
def test_rejects_malformed_or_legacy_report_inputs(payload: str, expected: str) -> None:
    with pytest.raises(AcceptanceReportFormatError, match=re.escape(expected)):
        parse_acceptance_run_report_json(payload)


def test_rejects_foreign_or_over_budget_observation_lineage() -> None:
    data = json.loads(
        serialize_acceptance_run_report(
            AcceptanceRunReport(observations=(_observation(),), scorecards={}, promotion=None)
        )
    )
    data["observations"][0]["arm"] = "full"
    with pytest.raises(AcceptanceReportFormatError, match="arm"):
        acceptance_run_report_from_dict(data)

    data["observations"][0]["arm"] = "full-jace-loop"
    data["observations"][0]["provenance"]["contextPackTokenBudget"] = ""
    with pytest.raises(AcceptanceReportFormatError, match="provenance values"):
        acceptance_run_report_from_dict(data)


def test_rejects_duplicate_and_unknown_json_keys() -> None:
    with pytest.raises(AcceptanceReportFormatError, match="duplicate JSON key"):
        parse_acceptance_run_report_json(
            '{"formatVersion":1,"formatVersion":1,"observations":[],"scorecards":{},'
            '"promotion":null,"corpusProvenance":null}'
        )

    data = json.loads(
        serialize_acceptance_run_report(
            AcceptanceRunReport(observations=(), scorecards={}, promotion=None)
        )
    )
    data["unexpected"] = True
    with pytest.raises(AcceptanceReportFormatError, match="unknown key"):
        acceptance_run_report_from_dict(data)

    data = json.loads(
        serialize_acceptance_run_report(
            AcceptanceRunReport(observations=(), scorecards={}, promotion=None)
        )
    )
    data["corpusProvenance"] = {
        "corpusVersion": "v1",
        "labelClass": "independent",
        "labelAuthority": {},
        "caseDigests": {},
        "caseSplits": {},
        "unexpected": True,
    }
    with pytest.raises(AcceptanceReportFormatError, match="corpusProvenance.*unknown key"):
        acceptance_run_report_from_dict(data)

    data = json.loads(
        serialize_acceptance_run_report(
            AcceptanceRunReport(
                observations=(),
                scorecards={"cell": _scorecard()},
                promotion=None,
            )
        )
    )
    data["scorecards"]["cell"]["unexpected"] = 1
    with pytest.raises(AcceptanceReportFormatError, match="scorecards.*unknown key"):
        acceptance_run_report_from_dict(data)


def test_rejects_invalid_nested_corpus_provenance() -> None:
    data = json.loads(
        serialize_acceptance_run_report(
            AcceptanceRunReport(observations=(), scorecards={}, promotion=None)
        )
    )
    data["corpusProvenance"] = {
        "corpusVersion": "v1",
        "labelClass": "independent",
        "labelAuthority": {"owner": "independent-team"},
        "caseDigests": {"case-1": "a" * 64},
        "caseSplits": {"case-2": "held-out"},
    }
    with pytest.raises(AcceptanceReportFormatError, match="must name the same cases"):
        acceptance_run_report_from_dict(data)


def test_rejects_oversized_input_before_json_parse() -> None:
    payload = " " * MAX_REPORT_INPUT_BYTES + "{}"
    with pytest.raises(AcceptanceReportFormatError, match="byte limit"):
        parse_acceptance_run_report_json(payload)


def test_escapes_caller_values_in_markdown() -> None:
    report = AcceptanceRunReport(
        observations=(_observation(case="case | one", provenance={**_observation().provenance, "prHead": "head\\value"}),),
        scorecards={"cell | one": _scorecard()},
        promotion=None,
    )
    markdown = render_acceptance_run_report_markdown(report)
    assert "case \\| one" in markdown
    assert "head\\\\value" in markdown
    assert "cell \\| one" in markdown


def test_atomic_write_preserves_existing_output_and_cleans_temp_on_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    output = tmp_path / "report.md"
    output.write_text("sentinel", encoding="utf-8")

    def fail_replace(source: str | bytes, destination: str | bytes) -> None:
        raise OSError("replace failed")

    monkeypatch.setattr("agentrail.evals.acceptance_case.report.os.replace", fail_replace)
    with pytest.raises(OSError, match="replace failed"):
        write_acceptance_run_report_markdown(
            AcceptanceRunReport(observations=(), scorecards={}, promotion=None), output
        )
    assert output.read_text(encoding="utf-8") == "sentinel"
    assert list(tmp_path.glob(".report.md.*")) == []


@pytest.mark.parametrize("kind", ["symlink", "directory"])
def test_rejects_existing_non_regular_output(tmp_path: Path, kind: str) -> None:
    output = tmp_path / "report.md"
    if kind == "symlink":
        output.symlink_to(tmp_path / "target.md")
    else:
        output.mkdir()
    with pytest.raises(OSError, match="existing symlink or non-regular"):
        write_acceptance_run_report_markdown(
            AcceptanceRunReport(observations=(), scorecards={}, promotion=None), output
        )
