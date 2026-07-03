"""Emit the REAL Python gate's verdict for every fixture in the shared corpus.

This is one half of the cross-language parity harness (issue #1042). It reads the
single, language-neutral fixture corpus
(``agentrail/guardrails/fixtures/injection_corpus.json`` — the SAME bytes the TS
side reads) and, for each case, runs the REAL Python queue-entrance gate
(:func:`agentrail.guardrails.policies.input_contract.admit_to_queue`) and records
the canonical admission verdict. Nothing is stubbed: this calls the production
gate function directly.

Two consumers, one source of truth
----------------------------------
* The **pytest** parity leg imports :func:`emit_corpus_verdicts` and compares the
  map it returns against the TS gate's verdict map (and the corpus contract).
* The **vitest / node** parity leg shells out to this module as a subprocess
  (``python3 -m agentrail.guardrails.parity.emit_verdicts`` with ``PYTHONPATH=.``)
  to obtain the Python verdict map, then diffs it against the TS gate's in-process
  map. The node CI job has python3 preinstalled, and the pure gate imports with
  only ``PYTHONPATH`` (no ``pip install -e .``), so this works in CI unchanged.

Because the corpus is a single file and the verdict is computed by the real gate,
adding a case to the corpus is automatically picked up by BOTH legs on the next
run with zero per-fixture registration (AC3).

Canonical verdict vocabulary
----------------------------
Both gates speak the same three-value admission vocabulary. This module maps the
Python gate's native :class:`Admission` onto those strings:

===========  =========================================================  ==================
canonical    Python ``Admission`` shape                                  TS ``V2Verdict``
===========  =========================================================  ==================
``admit``    ``entry`` set and ``entry.state is QueueState.QUEUED``      ``decision:"admit"``
``park``     ``is_parked`` (``entry.state is QueueState.PARKED``)        ``decision:"park"``
``reject``   ``is_rejected`` (``rejected`` set, ``entry`` is ``None``)   ``decision:"reject"``
===========  =========================================================  ==================
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Dict

import agentrail.guardrails.policies.input_contract as policy
from agentrail.afk.input_contract import Admission, AdmissionLedger, admit_to_queue
from agentrail.afk.queue_state import QueueState

# The canonical three-value admission vocabulary shared by both gates.
ADMIT = "admit"
PARK = "park"
REJECT = "reject"

# Resolved via the policy package itself (not a cwd-relative path) so it is found
# wherever the emitter runs — in-process under pytest, or as a subprocess spawned
# by the node job. This is the corpus's stable, single-sourced location; the TS
# side resolves the SAME file relative to the repo root.
CORPUS_PATH = (
    Path(policy.__file__).resolve().parents[1] / "fixtures" / "injection_corpus.json"
)


def load_corpus() -> dict:
    """Load and parse the one shared fixture corpus (raises on malformed JSON)."""
    return json.loads(CORPUS_PATH.read_text(encoding="utf-8"))


def canonical_verdict(body: str, *, injection_park: bool = False) -> Dict[str, str]:
    """Run the REAL Python gate over one issue body → canonical ``{decision, reason}``.

    A fresh :class:`AdmissionLedger` is used per call, so the stateful v2 checks
    (duplicate-content, per-writer rate limit) never fire across fixtures: this
    isolates the injection screen + machine-checkable-AC gate, which is exactly the
    decision surface the single-body corpus exercises. ``injection_park`` is passed
    straight through so the caller controls whether an injection probe is a hard
    REJECT (default) or a PARK (the live-loop intake setting).

    Returns a plain dict (JSON-serialisable) with:
      * ``decision`` — one of ``"admit"`` / ``"park"`` / ``"reject"``.
      * ``reason``   — the human-readable reason (``""`` for a clean admit).
    """
    result = admit_to_queue(
        number=1042,
        issue_body=body,
        ledger=AdmissionLedger(),
        injection_park=injection_park,
    )
    # With a ledger supplied, admit_to_queue always returns an Admission.
    assert isinstance(result, Admission), f"expected Admission, got {type(result)!r}"

    if result.is_rejected:
        reason = result.rejected.missing_ac if result.rejected is not None else ""
        return {"decision": REJECT, "reason": reason}
    if result.is_parked:
        reason = result.entry.reason if result.entry is not None else ""
        return {"decision": PARK, "reason": reason}
    # A non-rejected, non-parked admission is a clean QUEUED entry.
    assert result.entry is not None and result.entry.state is QueueState.QUEUED, (
        f"unexpected admission entry state: {result.entry!r}"
    )
    return {"decision": ADMIT, "reason": ""}


def emit_corpus_verdicts(*, injection_park: bool = False) -> Dict[str, Dict[str, str]]:
    """Real Python-gate verdict for EVERY fixture in the shared corpus.

    Returns ``{fixture_id: {"decision": ..., "reason": ...}}``. Zero per-fixture
    registration: it iterates whatever cases the corpus file currently holds, so a
    newly added case appears here automatically (AC3).
    """
    verdicts: Dict[str, Dict[str, str]] = {}
    for case in load_corpus()["cases"]:
        verdicts[case["id"]] = canonical_verdict(
            case["body"], injection_park=injection_park
        )
    return verdicts


def main(argv: list[str] | None = None) -> int:
    """CLI: print the corpus verdict map as JSON to stdout (for the node leg).

    ``--injection-park`` flips injection probes from REJECT to PARK, matching the
    live-loop intake; omitted (the default) an injection probe is a hard REJECT,
    which is what the corpus ``expect`` contract asserts.
    """
    argv = list(sys.argv[1:] if argv is None else argv)
    injection_park = "--injection-park" in argv
    verdicts = emit_corpus_verdicts(injection_park=injection_park)
    # Sorted keys → stable, diff-friendly output; the node side parses it as JSON.
    json.dump(verdicts, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":  # pragma: no cover - exercised via subprocess in tests
    raise SystemExit(main())
