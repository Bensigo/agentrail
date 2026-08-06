"""Serialization and offline publication for Acceptance Case run reports.

This module is a report boundary, not an evaluation runner. It only converts
caller-supplied ``AcceptanceRunReport`` values to and from a versioned JSON
document and renders that document as deterministic Markdown.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Mapping, Optional, Union

from .loader import ARMS
from .offline_runner import AcceptanceRunReport
from .promotion import PromotionResult
from .scorecards import AcceptanceObservation, SCORECARDS

REPORT_FORMAT_VERSION = 1
EVIDENCE_CLASSES = ("offline", "canary", "production")
PROMOTION_STATUSES = ("promote", "hold", "reject")


class AcceptanceReportFormatError(ValueError):
    """Raised when a publication input is not a valid AcceptanceRunReport."""


def _mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise AcceptanceReportFormatError(f"{label} must be an object")
    return value


def _required_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise AcceptanceReportFormatError(f"{label} must be a non-empty string")
    return value


def _non_negative_int(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise AcceptanceReportFormatError(f"{label} must be a non-negative integer")
    return value


def _number(value: Any, label: str) -> Union[int, float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
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
        "corpusProvenance": dict(report.corpus_provenance) if report.corpus_provenance is not None else None,
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
        result[bucket] = {
            str(metric): _non_negative_int(amount, f"scorecards[{bucket!r}].{metric}")
            for metric, amount in metric_data.items()
        }
    return result


def _parse_promotion(value: Any) -> Optional[PromotionResult]:
    if value is None:
        return None
    data = _mapping(value, "promotion")
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
        metrics[cell] = {
            str(metric): _number(number, f"promotion.metrics[{cell!r}].{metric}")
            for metric, number in values_data.items()
        }
    return PromotionResult(status=status, reasons=tuple(reasons_value), metrics=metrics)


def acceptance_run_report_from_dict(value: Any) -> AcceptanceRunReport:
    """Validate and parse one JSON-compatible report object."""
    data = _mapping(value, "report")
    if data.get("formatVersion") != REPORT_FORMAT_VERSION:
        raise AcceptanceReportFormatError(f"formatVersion must be {REPORT_FORMAT_VERSION}")
    observations_value = data.get("observations")
    if not isinstance(observations_value, list):
        raise AcceptanceReportFormatError("observations must be an array")
    observations = tuple(
        _parse_observation(item, index) for index, item in enumerate(observations_value)
    )
    try:
        corpus_provenance = data.get("corpusProvenance")
        if corpus_provenance is not None and not isinstance(corpus_provenance, Mapping):
            raise AcceptanceReportFormatError("corpusProvenance must be an object or null")
        return AcceptanceRunReport(
            observations=observations,
            scorecards=_parse_scorecards(data.get("scorecards")),
            promotion=_parse_promotion(data.get("promotion")),
            corpus_provenance=dict(corpus_provenance) if corpus_provenance is not None else None,
        )
    except ValueError as error:
        raise AcceptanceReportFormatError(f"report is invalid: {error}") from error


def parse_acceptance_run_report_json(payload: Union[str, bytes]) -> AcceptanceRunReport:
    """Parse and validate JSON text without executing any evaluation code."""
    try:
        value = json.loads(payload)
    except (TypeError, ValueError) as error:
        raise AcceptanceReportFormatError(f"invalid JSON: {error}") from error
    return acceptance_run_report_from_dict(value)


def read_acceptance_run_report(path: Path) -> AcceptanceRunReport:
    """Read exactly one caller-supplied JSON report from ``path``."""
    try:
        payload = path.read_text(encoding="utf-8")
    except OSError as error:
        raise AcceptanceReportFormatError(f"cannot read input: {error}") from error
    return parse_acceptance_run_report_json(payload)


def _display(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _observation_sort_key(item: AcceptanceObservation) -> tuple[str, ...]:
    """Use a stable publication order without altering the supplied evidence."""
    return (
        item.case,
        item.arm,
        item.scorecard,
        item.segment,
        item.evidence_class,
        json.dumps(item.provenance, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
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
                    case=item.case,
                    arm=item.arm,
                    scorecard=item.scorecard,
                    segment=item.segment,
                    evidence=item.evidence_class,
                    truth=_display(item.independent_truth),
                    claim=_display(item.jace_claim),
                )
            )
        lines.extend(["", "## Observation provenance", ""])
        for item in sorted(report.observations, key=_observation_sort_key):
            lines.extend(
                [
                    f"### {item.case} / {item.arm} / {item.scorecard} / {item.segment}",
                    "",
                    "| Field | Value |",
                    "| --- | --- |",
                ]
            )
            lines.extend(f"| {key} | {item.provenance[key]} |" for key in sorted(item.provenance))
            lines.append("")

    lines.extend(["", "## Explicit aggregate scorecards", ""])
    if report.scorecards:
        lines.extend(["| Cell | Total | Scored | Unscored |", "| --- | ---: | ---: | ---: |"])
        for cell in sorted(report.scorecards):
            values = report.scorecards[cell]
            lines.append(
                "| {cell} | {total} | {scored} | {unscored} |".format(
                    cell=cell,
                    total=_display(values.get("total", "not supplied")),
                    scored=_display(values.get("scored", "not supplied")),
                    unscored=_display(values.get("unscored", "not supplied")),
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
        lines.append(f"Status: {report.promotion.status}")
        if report.promotion.reasons:
            lines.extend(["", "Reasons:"])
            lines.extend(f"- {reason}" for reason in report.promotion.reasons)
    return "\n".join(lines) + "\n"


def write_acceptance_run_report_markdown(report: AcceptanceRunReport, path: Path) -> None:
    """Write only the requested Markdown output path."""
    path.write_text(render_acceptance_run_report_markdown(report), encoding="utf-8")
