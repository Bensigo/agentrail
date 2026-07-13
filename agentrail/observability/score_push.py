"""Push judgeable outcomes onto Langfuse traces as scores (``agentrail
langfuse push-scores``).

Reads a flat directory of JSON files — either PRODUCTION run-records
(``agentrail.run.run_record.assemble_run_record``, one file per run) or EVAL
per-repetition forensics records (``agentrail.evals.spine._write_forensics_record``,
one file per ``(task, arm, rep)``) — and POSTs one Langfuse score per
applicable score kind found in each record. Never blocks on a malformed
record: every failure mode below lands the record in the returned
``skipped`` list with a reason instead of raising, so a batch push can never
stall or crash whatever judge pass runs before/around it.

Score vocabulary (FIXED — do not invent additional score names elsewhere):

    solved          — eval rep record's hidden-test outcome (bool)
    false_green     — eval rep record's objective-gate false-green probe (bool)
    verify_verdict  — production run record's verify-phase structured verdict
                      ("accepted", bool)
    judge_verdict   — optional external shadow-judge decision, supplied via
                      ``--judge <ledger.json>`` and looked up by the SAME
                      identity string used to build that record's trace id
                      (see "Judge ledger format" below)

Step 1 PIN — scores API shape (2026-07-13)
-------------------------------------------
Pinned against the bundled ``langfuse-cli``'s own ``openapi.yml`` (the exact
artifact ``npx langfuse-cli api __schema`` reads offline — no network call
needed, and no version-drift risk vs. a docs page): component
``legacyCreateScoreRequest`` behind ``POST /api/public/scores``
(``operationId: legacy_scoreV1_create``, tag ``LegacyScoreV1``). The
create-score endpoint has NOT moved across the v1->v3 API bump — only the
*read* side (``GET .../scores``) was superseded by ``scores-v3s``/``v3/scores``;
``legacy-score-v1s create`` is still the only create action ``api __schema``
lists, and the CLI's own tip ("Prefer scores over legacy-score-v1s for
list/get operations") is silent on create for exactly that reason.

Request body fields (verbatim from the schema, only the ones this module
sets are elaborated):

  * ``name`` (string, REQUIRED) — one of the four score names above.
  * ``value`` (REQUIRED — ``CreateScoreValue`` = ``oneOf[number, string]``).
    Schema description, verbatim: "The value of the score. Must be passed as
    string for categorical and text scores, and numeric for boolean and
    numeric scores. Boolean score values must equal either 1 or 0 (true or
    false)." -> every score here uses ``dataType: "BOOLEAN"`` and encodes its
    value as the INTEGER ``1`` or ``0`` — never a JSON ``true``/``false``,
    never a string. This is the "consistent encoding" the task brief asks
    for: ``solved``/``false_green``/``verify_verdict``/``judge_verdict`` are
    all real Python ``bool`` at the source and all become BOOLEAN/0-or-1.
  * ``dataType`` (``ScoreDataType`` enum: NUMERIC | BOOLEAN | CATEGORICAL |
    CORRECTION | TEXT) — always ``"BOOLEAN"`` here.
  * ``traceId`` (string, nullable) — ``deterministic_trace_id(<identity>)``
    (Task 1's ``agentrail.observability.langfuse_client.deterministic_trace_id``).
  * ``comment`` (string, nullable) — best-effort human-readable context (e.g.
    a verify verdict's own ``reason`` string) when one is available; purely
    informational, never parsed back by this module.

Response: ``legacyCreateScoreResponse`` = ``{"id": <str>}``. Unused here — a
successful push is just a non-raising ``client.post_json`` call, matching
``price_sync.py``'s house pattern (``agentrail/observability/price_sync.py``).

Step 1 PIN — real record field names (grounding)
-------------------------------------------------
The task brief's Step 1(b) asked to read ONE real record of each kind from
dogfood history / ``agentrail/evals/reports/``. Neither exists anywhere on
this machine (checked broadly: no ``run-records/`` directory of any kind, no
``*--*--rep*.json`` file, under any of the ~15 other AgentRail checkouts on
disk, nor in ``agentrail/evals/reports/``) — the two features that produce
these files (issue #1178/#1180 for production, #1169/#1176 for eval) merged
into ``main`` recently enough that no real instance has been generated yet in
this environment. Grounding instead used the PRODUCTION CODE that assembles
each record (the actual source of truth for what gets written) plus its own
test suite, which pins concrete example payloads byte-for-byte:

  * Production record — ``agentrail/run/run_record.py:assemble_run_record``,
    written to ``<target>/.agentrail/run-records/<run_id>.json``. Top-level
    ``run_id`` (string) is the identity. ``verify_verdict`` is either
    ``None`` (no verify phase ran, OR one ran but never wrote back a
    structured verdict — both cases are equally "nothing to score" for this
    module) or ``{"accepted": bool, "reason": str}`` — pinned verbatim in
    ``agentrail/tests/run/test_run_record.py`` (e.g.
    ``verdict={"accepted": True, "reason": "tests pin the AC"}`` ->
    ``record["verify_verdict"] == {"accepted": True, "reason": "..."}"``).
  * Eval rep record — ``agentrail/evals/spine.py:_write_forensics_record``,
    written to ``<reports_dir>/run-records/<date>/<task>--<arm>--rep<N>.json``.
    Pinned in ``agentrail/tests/evals/test_spine.py``
    (``test_ac1_forensics_record_has_all_fields_for_a_normal_rep``). Its
    payload has **no ``run_id`` field at all** — a real mismatch vs. the
    plan's guessed field list, caught by following the eval-symbol-mismatch
    rule instead of trusting the brief. Its identity is the
    ``(task, arm, rep)`` triple encoded in its own filename; ``solved``,
    ``false_green``, and ``synthetic`` are plain top-level bools.

Eval-record identity (a deliberate design decision, not a guess)
-----------------------------------------------------------------
Because eval rep records carry no ``run_id``, and ``deterministic_trace_id``
needs *some* string, this module derives one:
``f"{file.parent.name}--{task}--{arm}--rep{rep}"``. ``file.parent.name`` is
normally the ``<date>`` directory eval rep records live under, which the
JSON payload itself doesn't carry — this keeps two identically-named
``(task, arm, rep)`` records from two different eval dates from colliding on
the same trace id. This identity is ALSO what a ``--judge`` ledger entry for
an eval record must be keyed by (see below).

Judge ledger format (this module defines it; no prior schema exists on disk)
------------------------------------------------------------------------------
``--judge <ledger.json>`` is a JSON object mapping a record's identity string
(a production ``run_id``, or an eval record's derived
``"<date>--<task>--<arm>--rep<N>"`` string) to ``{"verdict": <bool>, ...}``.
Only the ``verdict`` key is read; anything else in the entry is ignored.
An entry whose ``verdict`` is present but not a real ``bool`` is treated the
same as no entry at all (no ``judge_verdict`` score emitted for that
record) — this is additive-only, so a malformed judge entry never turns a
record that otherwise scored cleanly into a skip.

Fail-closed contract
---------------------
  * Corrupt / non-JSON-object file -> skipped, reason ``"unparseable"``.
  * ``synthetic: true`` on an eval record -> ALWAYS skipped, reason
    ``"synthetic"`` — checked BEFORE anything else, per the
    eval-econnreset-synthetic-fallback rule: a ``<synthetic>`` network-
    artifact run's zero-cost, no-diff result must never become a real score
    (it would corrupt the calibration signal Task 9's agreement-rate report
    is built on).
  * A record with no derivable identity (no usable ``run_id`` string, and
    not ``task``/``arm``/``rep``-shaped either) -> skipped, reason
    ``"missing run_id"``.
  * A record whose identity resolves but yields zero usable score fields
    (production: no ``verify_verdict``; eval: neither ``solved`` nor
    ``false_green``) AND no judge-ledger entry either -> skipped, reason
    ``"missing verdict"``.

None of the above ever raises out of ``push_scores`` — the loop always moves
on to the next file. A genuine Langfuse HTTP/network failure during a POST
is NOT caught here (matches ``price_sync.sync_models``'s house pattern,
which lets ``LangfuseHTTP.post_json``'s ``RuntimeError`` propagate) — this is
an explicit, manually-invoked operator action, not something wired into the
judge pass itself, so a real outage should surface loudly rather than being
silently swallowed as a per-record skip.

``push_scores`` return contract: ``{"pushed": int, "skipped": [{"record":
<filename>, "reason": <str>}, ...]}``. ``pushed`` counts individual score
POSTs (one record can contribute more than one — e.g. an eval record with
both ``solved`` and ``false_green`` present pushes two), NOT records.
``dry_run=True`` performs all the same file reads and decisions but issues
zero POSTs — mirrors ``sync_models``'s dry-run contract exactly (still
reports what WOULD be pushed).
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from agentrail.observability.langfuse_client import LangfuseHTTP, deterministic_trace_id

_log = logging.getLogger(__name__)

# Fixed score-name vocabulary (module docstring). Exported for callers (e.g.
# Task 9's calibration report) that need to filter Langfuse scores back down
# to exactly the names this module ever pushes.
SCORE_NAMES = ("solved", "false_green", "verify_verdict", "judge_verdict")


def _bool_value(value: Any) -> Optional[int]:
    """Coerce a real ``bool`` to Langfuse's BOOLEAN numeric convention (1/0).

    Returns ``None`` — not ``0`` — for anything that is not an actual
    ``bool`` (a non-bool "truthy" value is a data-shape problem, not a
    verdict, and must never silently become a score). ``bool`` is checked
    explicitly (not just falsy/truthy) because ``isinstance(True, int)`` is
    also true in Python and would otherwise let a stray int slip through.
    """
    if isinstance(value, bool):
        return 1 if value else 0
    return None


def _score_body(
    trace_id: str, name: str, value: int, comment: Optional[str] = None
) -> Dict[str, Any]:
    """One ``POST /api/public/scores`` body — see Step 1 PIN in the module docstring."""
    body: Dict[str, Any] = {
        "traceId": trace_id,
        "name": name,
        "value": value,
        "dataType": "BOOLEAN",
    }
    if comment:
        body["comment"] = comment
    return body


def _load_judge_ledger(judge_file: Optional[Path]) -> Dict[str, Any]:
    """Best-effort load of the ``--judge`` ledger. Never raises: an absent,
    unreadable, or malformed ledger just means no ``judge_verdict`` scores
    get added — it must never block the rest of push_scores."""
    if judge_file is None:
        return {}
    try:
        data = json.loads(Path(judge_file).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        _log.warning("could not read judge ledger %s; proceeding without it", judge_file)
        return {}
    return data if isinstance(data, dict) else {}


def _judge_verdict_for(ledger: Dict[str, Any], identity: str) -> Optional[int]:
    entry = ledger.get(identity)
    if not isinstance(entry, dict):
        return None
    return _bool_value(entry.get("verdict"))


def _identity_and_kind(record: dict, file_path: Path) -> Tuple[Optional[str], Optional[str]]:
    """Return ``(identity, kind)`` where ``kind`` is ``"production"`` or
    ``"eval"``; ``(None, None)`` when the record shape lets us derive
    neither (the ``"missing run_id"`` fail-closed case)."""
    run_id = record.get("run_id")
    if isinstance(run_id, str) and run_id:
        return run_id, "production"

    task, arm, rep = record.get("task"), record.get("arm"), record.get("rep")
    if (
        isinstance(task, str)
        and task
        and isinstance(arm, str)
        and arm
        and isinstance(rep, int)
        and not isinstance(rep, bool)
    ):
        identity = f"{file_path.parent.name}--{task}--{arm}--rep{rep}"
        return identity, "eval"

    return None, None


def _production_scores(record: dict) -> List[Tuple[str, int, Optional[str]]]:
    """``[(score_name, value, comment)]`` derivable from a production run record."""
    scores: List[Tuple[str, int, Optional[str]]] = []
    verdict = record.get("verify_verdict")
    if isinstance(verdict, dict):
        value = _bool_value(verdict.get("accepted"))
        if value is not None:
            scores.append(("verify_verdict", value, verdict.get("reason")))
    return scores


def _eval_scores(record: dict) -> List[Tuple[str, int, Optional[str]]]:
    """``[(score_name, value, comment)]`` derivable from an eval rep record."""
    scores: List[Tuple[str, int, Optional[str]]] = []
    solved = _bool_value(record.get("solved"))
    if solved is not None:
        scores.append(("solved", solved, None))
    false_green = _bool_value(record.get("false_green"))
    if false_green is not None:
        scores.append(("false_green", false_green, None))
    return scores


def push_scores(
    client: LangfuseHTTP,
    records_dir: Path,
    judge_file: Optional[Path] = None,
    dry_run: bool = False,
) -> dict:
    """Push every applicable score for every record under ``records_dir``.

    Non-recursive (flat ``*.json`` glob): both production run-records and
    eval per-rep records are single JSON files directly inside whatever
    directory the caller points ``--records`` at (a production
    ``.agentrail/run-records/`` directory, or one eval
    ``<reports_dir>/run-records/<date>/`` directory). Files are processed in
    sorted-name order for deterministic output.
    """
    records_dir = Path(records_dir)
    ledger = _load_judge_ledger(judge_file)

    pushed = 0
    skipped: List[Dict[str, str]] = []

    for file_path in sorted(records_dir.glob("*.json")):
        record_name = file_path.name

        try:
            raw = file_path.read_text(encoding="utf-8")
            data = json.loads(raw)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            skipped.append({"record": record_name, "reason": "unparseable"})
            continue

        if not isinstance(data, dict):
            skipped.append({"record": record_name, "reason": "unparseable"})
            continue

        # Synthetic-hygiene rule: checked BEFORE identity/verdict extraction
        # so a synthetic record is NEVER turned into any score, regardless
        # of what else it contains.
        if data.get("synthetic") is True:
            skipped.append({"record": record_name, "reason": "synthetic"})
            continue

        identity, kind = _identity_and_kind(data, file_path)
        if identity is None:
            skipped.append({"record": record_name, "reason": "missing run_id"})
            continue

        record_scores = (
            _production_scores(data) if kind == "production" else _eval_scores(data)
        )

        judge_value = _judge_verdict_for(ledger, identity)
        if judge_value is not None:
            record_scores.append(("judge_verdict", judge_value, None))

        if not record_scores:
            skipped.append({"record": record_name, "reason": "missing verdict"})
            continue

        trace_id = deterministic_trace_id(identity)
        for name, value, comment in record_scores:
            body = _score_body(trace_id, name, value, comment)
            if not dry_run:
                client.post_json("/api/public/scores", body)
            pushed += 1

    return {"pushed": pushed, "skipped": skipped}
