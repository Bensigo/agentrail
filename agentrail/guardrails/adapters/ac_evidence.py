"""AC-evidence adapter — the file I/O behind the AC Proof Gate (Arc C).

The coverage math (:func:`agentrail.guardrails.policies.check_runner.ac_coverage_for`)
is pure. Something has to read the builder-declared bindings
(``.agentrail/ac_bindings.json``), the human-authored waivers
(``.agentrail/ac_waivers.json``), and the captured JUnit report — that is this
adapter's only job. Defensive throughout: a missing or malformed file yields
empty data (the gate then reads the affected ACs as honestly ``unbound``),
never an exception.
"""
from __future__ import annotations

import json
import logging
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Tuple

from agentrail.guardrails.adapters.check_runner import _load_config
from agentrail.run.verify_gate import DEFAULT_JUNIT_REPORT

_log = logging.getLogger(__name__)

BINDINGS_FILE = Path(".agentrail") / "ac_bindings.json"
WAIVERS_FILE = Path(".agentrail") / "ac_waivers.json"


def _load_json(path: Path) -> Optional[Any]:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001 — defensive: malformed file = no data
        _log.warning("could not parse %s: %s", path, exc)
        return None


def load_ac_bindings(target_dir: Path) -> Tuple[Dict[str, List[str]], Dict[str, Dict[str, str]]]:
    """Read ``.agentrail/ac_bindings.json`` → ``(bindings, unverifiable)``.

    ``{"AC1": ["tests/x.py::test_a"], "AC3": {"unverifiable": true, "why":
    "...", "whatWouldProveIt": "..."}}`` — a list value is proof pointers
    (pytest node ids or declared check names); an object value with truthy
    ``unverifiable`` is the builder's declared refusal for that AC.
    """
    data = _load_json(Path(target_dir) / BINDINGS_FILE)
    bindings: Dict[str, List[str]] = {}
    unverifiable: Dict[str, Dict[str, str]] = {}
    if not isinstance(data, Mapping):
        return bindings, unverifiable
    for key, value in data.items():
        ac_id = str(key).strip()
        if not ac_id:
            continue
        if isinstance(value, (list, tuple)):
            refs = [str(v).strip() for v in value if str(v).strip()]
            if refs:
                bindings[ac_id] = refs
        elif isinstance(value, Mapping) and value.get("unverifiable"):
            unverifiable[ac_id] = {
                "why": str(value.get("why") or ""),
                "whatWouldProveIt": str(value.get("whatWouldProveIt") or ""),
            }
    return bindings, unverifiable


def load_ac_waivers(target_dir: Path) -> Dict[str, Dict[str, str]]:
    """Read ``.agentrail/ac_waivers.json`` → ``{id: {reason, by, at}}``.

    Human-authored, in-repo, explicit (spec §7). The gate treats a waived AC
    as covered; recording and surfacing the waiver is the caller's job.
    """
    data = _load_json(Path(target_dir) / WAIVERS_FILE)
    waivers: Dict[str, Dict[str, str]] = {}
    if not isinstance(data, Mapping):
        return waivers
    for key, value in data.items():
        ac_id = str(key).strip()
        if not ac_id or not isinstance(value, Mapping):
            continue
        waivers[ac_id] = {
            "reason": str(value.get("reason") or ""),
            "by": str(value.get("by") or ""),
            "at": str(value.get("at") or ""),
        }
    return waivers


def load_junit_results(target_dir: Path) -> Dict[str, str]:
    """Parse the captured JUnit report → ``{dotted test key: outcome}``.

    Report path: the ``verifyReport`` key of ``.agentrail/config.json`` when
    declared (repos whose verify command emits its own JUnit file), else the
    verify-gate default. Keys are ``classname.name`` (the policy's
    ``_normalize_test_ref`` maps pytest node ids onto the same form); outcomes
    are ``passed`` / ``failed`` / ``error`` / ``skipped``. Missing or
    malformed report → ``{}`` (command-level evidence still works).
    """
    config = _load_config(Path(target_dir)) or {}
    declared = str(config.get("verifyReport") or "").strip()
    report = Path(target_dir) / (declared or DEFAULT_JUNIT_REPORT)
    if not report.is_file():
        return {}
    try:
        root = ET.parse(report).getroot()
    except ET.ParseError as exc:
        _log.warning("could not parse junit report %s: %s", report, exc)
        return {}
    results: Dict[str, str] = {}
    for case in root.iter("testcase"):
        classname = (case.get("classname") or "").strip()
        name = (case.get("name") or "").strip()
        if not name:
            continue
        key = f"{classname}.{name}" if classname else name
        if case.find("failure") is not None:
            outcome = "failed"
        elif case.find("error") is not None:
            outcome = "error"
        elif case.find("skipped") is not None:
            outcome = "skipped"
        else:
            outcome = "passed"
        results[key] = outcome
    return results
