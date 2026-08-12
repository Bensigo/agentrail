"""Serialization and offline publication for Acceptance Case run reports.

This module is a report boundary, not an evaluation runner. It only converts
caller-supplied ``AcceptanceRunReport`` values to and from a versioned JSON
document and renders that document as deterministic Markdown.
"""
from __future__ import annotations

import json
import math
import os
import re
import stat
import tempfile
from pathlib import Path
from typing import Any, Dict, Mapping, Optional, Union

from .loader import ARMS
from .offline_runner import AcceptanceRunReport
from .promotion import PromotionResult
from .scorecards import AcceptanceObservation, SCORECARDS

REPORT_FORMAT_VERSION = 1
EVIDENCE_CLASSES = ("offline", "canary", "production")
PROMOTION_STATUSES = ("promote", "hold", "reject")
MAX_REPORT_INPUT_BYTES = 1024 * 1024

_REPORT_KEYS = {"formatVersion", "observations", "scorecards", "promotion", "corpusProvenance"}
_OBSERVATION_KEYS = {
    "case",
    "arm",
    "scorecard",
    "segment",
    "evidenceClass",
    "independentTruth",
    "jaceClaim",
    "provenance",
}
_PROMOTION_KEYS = {"status", "reasons", "metrics"}
_SCORECARD_METRIC_KEYS = {
    "total",
    "scored",
    "unscored",
    "claim_true",
    "truth_true",
    "false_green",
    "false_block",
}
_PROMOTION_METRIC_KEYS = {
    "total",
    "scored",
    "unscored",
    "correct",
    "false_green",
    "false_block",
    "correct_rate",
    "false_green_rate",
    "false_block_rate",
}
_PROVENANCE_KEYS = {
    "caseVersion",
    "corpusVersion",
    "repository",
    "repositoryCommit",
    "contractVersion",
    "model",
    "configVersion",
    "promptVersion",
    "guardrailVersion",
    "contextPackHash",
    "contextPackTokenBudget",
    "prHead",
    "diffIdentity",
    "environmentId",
    "artifactRefs",
    "scorerVersion",
    "outcomeSource",
}
_CORPUS_PROVENANCE_KEYS = {
    "corpusVersion",
    "labelClass",
    "labelAuthority",
    "caseDigests",
    "caseSplits",
}
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


class AcceptanceReportFormatError(ValueError):
    """Raised when a publication input is not a valid AcceptanceRunReport."""


def _mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise AcceptanceReportFormatError(f"{label} must be an object")
    return value


def _exact_keys(data: Mapping[str, Any], expected: set[str], label: str) -> None:
    unknown = set(data) - expected
    missing = expected - set(data)
    if unknown:
        raise AcceptanceReportFormatError(
            f"{label} contains unknown key(s): {', '.join(sorted(map(str, unknown)))}"
        )
    if missing:
        raise AcceptanceReportFormatError(
            f"{label} is missing required key(s): {', '.join(sorted(missing))}"
        )


def _required_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise AcceptanceReportFormatError(f"{label} must be a non-empty string")
    return value


def _non_negative_int(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise AcceptanceReportFormatError(f"{label} must be a non-negative integer")
    return value


def _number(value: Any, label: str) -> Union[int, float]:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
    ):
        raise AcceptanceReportFormatError(f"{label} must be a number")
    return value


def _claim(value: Any, label: str) -> Optional[bool]:
    if value is not None and not isinstance(value, bool):
        raise AcceptanceReportFormatError(f"{label} must be true, false, or null")
    return value


def _observation_to_dict(item: AcceptanceObservation) -> Dict[str, Any]:
    return {
        "case": item.case,
        "arm": item.arm,
        "scorecard": item.scorecard,
        "segment": item.segment,
        "evidenceClass": item.evidence_class,
        "independentTruth": item.independent_truth,
        "jaceClaim": item.jace_claim,
        # Every provenance key is part of the lineage and must survive.
        "provenance": dict(item.provenance),
    }


def _promotion_to_dict(value: Optional[PromotionResult]) -> Optional[Dict[str, Any]]:
    if value is None:
        return None
    return {
        "status": value.status,
        "reasons": list(value.reasons),
        "metrics": {key: dict(metrics) for key, metrics in value.metrics.items()},
    }


def acceptance_run_report_to_dict(report: AcceptanceRunReport) -> Dict[str, Any]:
    """Return the stable JSON-compatible representation of ``report``."""
    if not isinstance(report, AcceptanceRunReport):
        raise TypeError("report must be an AcceptanceRunReport")
    return {
        "formatVersion": REPORT_FORMAT_VERSION,
        "observations": [_observation_to_dict(item) for item in report.observations],
        # Supplied aggregates are evidence too: publication never recomputes
        # or silently repairs them.
        "scorecards": {key: dict(value) for key, value in report.scorecards.items()},
        "promotion": _promotion_to_dict(report.promotion),
        "corpusProvenance": dict(report.corpus_provenance)
        if report.corpus_provenance is not None
        else None,
    }


def serialize_acceptance_run_report(report: AcceptanceRunReport) -> str:
    """Serialize a report deterministically as UTF-8 JSON text."""
    return json.dumps(
        acceptance_run_report_to_dict(report),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ) + "\n"


def _parse_observation(value: Any, index: int) -> AcceptanceObservation:
    data = _mapping(value, f"observations[{index}]")
    _exact_keys(data, _OBSERVATION_KEYS, f"observations[{index}]")
    case = _required_string(data.get("case"), f"observations[{index}].case")
    arm = _required_string(data.get("arm"), f"observations[{index}].arm")
    if arm not in ARMS:
        raise AcceptanceReportFormatError(f"observations[{index}].arm is unknown: {arm}")
    scorecard = _required_string(data.get("scorecard"), f"observations[{index}].scorecard")
    if scorecard not in SCORECARDS:
        raise AcceptanceReportFormatError(
            f"observations[{index}].scorecard is unknown: {scorecard}"
        )
    segment = _required_string(data.get("segment"), f"observations[{index}].segment")
    evidence_class = _required_string(
        data.get("evidenceClass"), f"observations[{index}].evidenceClass"
    )
    if evidence_class not in EVIDENCE_CLASSES:
        raise AcceptanceReportFormatError(
            f"observations[{index}].evidenceClass is unknown: {evidence_class}"
        )
    provenance_data = _mapping(data.get("provenance"), f"observations[{index}].provenance")
    _exact_keys(provenance_data, _PROVENANCE_KEYS, f"observations[{index}].provenance")
    provenance: Dict[str, str] = {}
    for key, item in provenance_data.items():
        if not isinstance(key, str) or not isinstance(item, str):
            raise AcceptanceReportFormatError(
                f"observations[{index}].provenance keys and values must be strings"
            )
        provenance[key] = item
    try:
        return AcceptanceObservation(
            case=case,
            arm=arm,
            scorecard=scorecard,
            segment=segment,
            evidence_class=evidence_class,  # type: ignore[arg-type]
            independent_truth=_claim(
                data.get("independentTruth"), f"observations[{index}].independentTruth"
            ),
            jace_claim=_claim(data.get("jaceClaim"), f"observations[{index}].jaceClaim"),
            provenance=provenance,
        )
    except ValueError as error:
        raise AcceptanceReportFormatError(f"observations[{index}] is invalid: {error}") from error


def _parse_scorecards(value: Any) -> Dict[str, Dict[str, int]]:
    data = _mapping(value, "scorecards")
    result: Dict[str, Dict[str, int]] = {}
    for bucket, metrics in data.items():
        if not isinstance(bucket, str) or not bucket:
            raise AcceptanceReportFormatError("scorecards keys must be non-empty strings")
        metric_data = _mapping(metrics, f"scorecards[{bucket!r}]")
        _exact_keys(metric_data, _SCORECARD_METRIC_KEYS, f"scorecards[{bucket!r}]")
        result[bucket] = {
            metric: _non_negative_int(amount, f"scorecards[{bucket!r}].{metric}")
            for metric, amount in metric_data.items()
        }
    return result


def _parse_promotion(value: Any) -> Optional[PromotionResult]:
    if value is None:
        return None
    data = _mapping(value, "promotion")
    _exact_keys(data, _PROMOTION_KEYS, "promotion")
    status = _required_string(data.get("status"), "promotion.status")
    if status not in PROMOTION_STATUSES:
        raise AcceptanceReportFormatError(f"promotion.status is unknown: {status}")
    reasons_value = data.get("reasons")
    if not isinstance(reasons_value, list) or any(not isinstance(item, str) for item in reasons_value):
        raise AcceptanceReportFormatError("promotion.reasons must be an array of strings")
    metric_data = _mapping(data.get("metrics"), "promotion.metrics")
    metrics: Dict[str, Dict[str, Union[int, float]]] = {}
    for cell, values in metric_data.items():
        if not isinstance(cell, str) or not cell:
            raise AcceptanceReportFormatError("promotion metric keys must be non-empty strings")
        values_data = _mapping(values, f"promotion.metrics[{cell!r}]")
        _exact_keys(values_data, _PROMOTION_METRIC_KEYS, f"promotion.metrics[{cell!r}]")
        metrics[cell] = {
            metric: _number(number, f"promotion.metrics[{cell!r}].{metric}")
            for metric, number in values_data.items()
        }
    return PromotionResult(status=status, reasons=tuple(reasons_value), metrics=metrics)


def _parse_corpus_provenance(value: Any) -> Optional[Dict[str, Any]]:
    if value is None:
        return None
    data = _mapping(value, "corpusProvenance")
    _exact_keys(data, _CORPUS_PROVENANCE_KEYS, "corpusProvenance")
    corpus_version = _required_string(data.get("corpusVersion"), "corpusProvenance.corpusVersion")
    label_class = _required_string(data.get("labelClass"), "corpusProvenance.labelClass")
    if label_class not in {"synthetic", "independent"}:
        raise AcceptanceReportFormatError(
            "corpusProvenance.labelClass must be synthetic or independent"
        )

    authority_data = _mapping(data.get("labelAuthority"), "corpusProvenance.labelAuthority")
    if not authority_data:
        raise AcceptanceReportFormatError("corpusProvenance.labelAuthority must not be empty")
    label_authority = {
        _required_string(key, "corpusProvenance.labelAuthority key"): _required_string(
            item, f"corpusProvenance.labelAuthority.{key}"
        )
        for key, item in authority_data.items()
    }

    digest_data = _mapping(data.get("caseDigests"), "corpusProvenance.caseDigests")
    split_data = _mapping(data.get("caseSplits"), "corpusProvenance.caseSplits")
    if not digest_data:
        raise AcceptanceReportFormatError("corpusProvenance.caseDigests must not be empty")
    if set(digest_data) != set(split_data):
        raise AcceptanceReportFormatError(
            "corpusProvenance.caseDigests and caseSplits must name the same cases"
        )
    case_digests: Dict[str, str] = {}
    case_splits: Dict[str, str] = {}
    for raw_case, raw_digest in digest_data.items():
        case = _required_string(raw_case, "corpusProvenance case name")
        digest = _required_string(raw_digest, f"corpusProvenance.caseDigests.{case}")
        if not _SHA256.fullmatch(digest):
            raise AcceptanceReportFormatError(
                f"corpusProvenance.caseDigests.{case} must be a lowercase SHA-256"
            )
        split = _required_string(split_data[raw_case], f"corpusProvenance.caseSplits.{case}")
        if split not in {"dev", "held-out"}:
            raise AcceptanceReportFormatError(
                f"corpusProvenance.caseSplits.{case} must be dev or held-out"
            )
        case_digests[case] = digest
        case_splits[case] = split
    return {
        "corpusVersion": corpus_version,
        "labelClass": label_class,
        "labelAuthority": label_authority,
        "caseDigests": case_digests,
        "caseSplits": case_splits,
    }


def acceptance_run_report_from_dict(value: Any) -> AcceptanceRunReport:
    """Validate and parse one JSON-compatible report object."""
    data = _mapping(value, "report")
    _exact_keys(data, _REPORT_KEYS, "report")
    if data.get("formatVersion") != REPORT_FORMAT_VERSION:
        raise AcceptanceReportFormatError(f"formatVersion must be {REPORT_FORMAT_VERSION}")
    observations_value = data.get("observations")
    if not isinstance(observations_value, list):
        raise AcceptanceReportFormatError("observations must be an array")
    observations = tuple(
        _parse_observation(item, index) for index, item in enumerate(observations_value)
    )
    try:
        return AcceptanceRunReport(
            observations=observations,
            scorecards=_parse_scorecards(data.get("scorecards")),
            promotion=_parse_promotion(data.get("promotion")),
            corpus_provenance=_parse_corpus_provenance(data.get("corpusProvenance")),
        )
    except ValueError as error:
        raise AcceptanceReportFormatError(f"report is invalid: {error}") from error


def parse_acceptance_run_report_json(payload: Union[str, bytes]) -> AcceptanceRunReport:
    """Parse and validate JSON text without executing any evaluation code."""
    if isinstance(payload, str):
        size = len(payload.encode("utf-8"))
    elif isinstance(payload, bytes):
        size = len(payload)
    else:
        raise AcceptanceReportFormatError("report JSON must be text or bytes")
    if size > MAX_REPORT_INPUT_BYTES:
        raise AcceptanceReportFormatError(
            f"report JSON exceeds {MAX_REPORT_INPUT_BYTES} byte limit"
        )

    def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> Dict[str, Any]:
        result: Dict[str, Any] = {}
        for key, item in pairs:
            if key in result:
                raise AcceptanceReportFormatError(f"duplicate JSON key: {key}")
            result[key] = item
        return result

    def reject_nonfinite_constant(constant: str) -> None:
        raise AcceptanceReportFormatError(f"invalid JSON constant: {constant}")

    try:
        value = json.loads(
            payload,
            object_pairs_hook=reject_duplicate_keys,
            parse_constant=reject_nonfinite_constant,
        )
    except (TypeError, ValueError) as error:
        raise AcceptanceReportFormatError(f"invalid JSON: {error}") from error
    return acceptance_run_report_from_dict(value)


def read_acceptance_run_report(path: Path) -> AcceptanceRunReport:
    """Read exactly one caller-supplied JSON report from ``path``."""
    try:
        with path.open("rb") as handle:
            payload = handle.read(MAX_REPORT_INPUT_BYTES + 1)
    except OSError as error:
        raise AcceptanceReportFormatError(f"cannot read input: {error}") from error
    if len(payload) > MAX_REPORT_INPUT_BYTES:
        raise AcceptanceReportFormatError(
            f"report JSON exceeds {MAX_REPORT_INPUT_BYTES} byte limit"
        )
    return parse_acceptance_run_report_json(payload)


def _display(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _markdown(value: Any) -> str:
    """Escape caller-controlled text before placing it in Markdown."""
    return (
        _display(value)
        .replace("\\", "\\\\")
        .replace("|", "\\|")
        .replace("#", "\\#")
        .replace(">", "\\>")
        .replace("*", "\\*")
        .replace("_", "\\_")
        .replace("`", "\\`")
        .replace("[", "\\[")
        .replace("]", "\\]")
        .replace("\r\n", "<br>")
        .replace("\r", "<br>")
        .replace("\n", "<br>")
    )


def _observation_sort_key(item: AcceptanceObservation) -> tuple[str, ...]:
    """Use a stable publication order without altering the supplied evidence."""
    return (
        item.case,
        item.arm,
        item.scorecard,
        item.segment,
        item.evidence_class,
        json.dumps(
            item.provenance,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ),
    )


def render_acceptance_run_report_markdown(report: AcceptanceRunReport) -> str:
    """Render deterministic Markdown with an explicit offline boundary."""
    lines = [
        "# Acceptance Case report",
        "",
        "> OFFLINE EVIDENCE ONLY — no product-benefit claim",
        "",
        "This publication contains only caller-supplied Acceptance Case evidence.",
        "It does not run a builder, scorer, corpus, canary, or promotion policy.",
        "",
        "## Observations",
        "",
    ]
    if not report.observations:
        lines.extend(
            [
                "NO OFFLINE EVIDENCE",
                "",
                "No observations were supplied; no pass, zero-rate, or promotion result is inferred.",
                "Supplied aggregate fields remain available in the JSON source and are not interpreted here.",
            ]
        )
    else:
        lines.extend(
            [
                "| Case | Arm | Scorecard | Segment | Evidence | Independent truth | Jace claim |",
                "| --- | --- | --- | --- | --- | --- | --- |",
            ]
        )
        for item in sorted(report.observations, key=_observation_sort_key):
            lines.append(
                "| {case} | {arm} | {scorecard} | {segment} | {evidence} | {truth} | {claim} |".format(
                    case=_markdown(item.case),
                    arm=_markdown(item.arm),
                    scorecard=_markdown(item.scorecard),
                    segment=_markdown(item.segment),
                    evidence=_markdown(item.evidence_class),
                    truth=_markdown(item.independent_truth),
                    claim=_markdown(item.jace_claim),
                )
            )
        lines.extend(["", "## Observation provenance", ""])
        for item in sorted(report.observations, key=_observation_sort_key):
            lines.extend(
                [
                    f"### {_markdown(item.case)} / {_markdown(item.arm)} / "
                    f"{_markdown(item.scorecard)} / {_markdown(item.segment)}",
                    "",
                    "| Field | Value |",
                    "| --- | --- |",
                ]
            )
            lines.extend(
                f"| {_markdown(key)} | {_markdown(item.provenance[key])} |"
                for key in sorted(item.provenance)
            )
            lines.append("")

    lines.extend(["", "## Explicit aggregate scorecards", ""])
    if report.scorecards:
        lines.extend(["| Cell | Total | Scored | Unscored |", "| --- | ---: | ---: | ---: |"])
        for cell in sorted(report.scorecards):
            values = report.scorecards[cell]
            lines.append(
                "| {cell} | {total} | {scored} | {unscored} |".format(
                    cell=_markdown(cell),
                    total=_markdown(values.get("total", "not supplied")),
                    scored=_markdown(values.get("scored", "not supplied")),
                    unscored=_markdown(values.get("unscored", "not supplied")),
                )
            )
    else:
        lines.append("No aggregate scorecards were supplied.")

    lines.extend(["", "## Promotion", ""])
    if not report.observations:
        lines.append("Not evaluated: no observations supplied.")
    elif report.promotion is None:
        lines.append("No promotion result supplied.")
    else:
        lines.append(f"Status: {_markdown(report.promotion.status)}")
        if report.promotion.reasons:
            lines.extend(["", "Reasons:"])
            lines.extend(f"- {_markdown(reason)}" for reason in report.promotion.reasons)
    return "\n".join(lines) + "\n"


def write_acceptance_run_report_markdown(report: AcceptanceRunReport, path: Path) -> None:
    """Write only the requested Markdown output path."""
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        metadata = None
    except OSError as error:
        raise OSError(f"cannot inspect output path: {error}") from error
    if metadata is not None and (
        stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode)
    ):
        raise OSError("output path must not be an existing symlink or non-regular file")

    rendered = render_acceptance_run_report_markdown(report)
    temporary_path: Optional[Path] = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            delete=False,
        ) as handle:
            temporary_path = Path(handle.name)
            handle.write(rendered)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
        temporary_path = None
        try:
            directory_fd = os.open(path.parent, os.O_RDONLY)
        except OSError:
            directory_fd = None
        if directory_fd is not None:
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink()
            except FileNotFoundError:
                pass
