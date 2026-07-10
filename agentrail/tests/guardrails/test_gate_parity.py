"""Cross-language gate-parity — Python leg (issue #1042).

The queue entrance is guarded by TWO real implementations that must never silently
disagree: the Python gate (:mod:`agentrail.guardrails.policies.input_contract`) and
the TypeScript gate (``packages/db-postgres/src/queries/github_intake.ts``). This is
the Python half of the parity harness. It runs the REAL Python gate over EVERY case
in the single shared fixture corpus (via
:func:`agentrail.guardrails.parity.emit_verdicts.emit_corpus_verdicts` — no stubs)
and pins its verdict, per fixture, to the corpus's language-neutral ``expect``
contract.

The corpus ``expect`` field is the contract BOTH gates are held to. The TS leg
(``packages/db-postgres/src/__tests__/github-intake-parity.test.ts``, which runs in
the ``node`` CI job) performs the true cross-language diff: it computes the TS gate's
map in-process AND shells to ``python -m agentrail.guardrails.parity.emit_verdicts``
for the Python map, then asserts they agree fixture-for-fixture. This Python leg runs
in the ``python`` CI job (which has no node deps and cannot import the TS gate), so it
holds the Python side to the same shared contract there — together they make a silent
divergence impossible in either job.

Zero per-fixture registration: every assertion iterates whatever cases the corpus
file currently holds, so adding a case to the corpus is picked up here automatically
(AC3).
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

import agentrail.guardrails.policies.input_contract as policy
from agentrail.guardrails.parity import emit_verdicts

# The corpus's stable, single-sourced location, resolved via the policy package (not
# a cwd-relative path) so pytest finds it wherever it runs. This is the SAME file the
# TS leg reads and the SAME file the emitter reads.
CORPUS_PATH = (
    Path(policy.__file__).resolve().parents[1] / "fixtures" / "injection_corpus.json"
)

# The canonical three-value admission vocabulary. The corpus expresses only the two
# decisions a single issue body can produce statelessly (a "park" needs a prior
# submission in the ledger, which a one-body fixture cannot carry); PARK parity is
# covered by the stateful AC2/AC3 tests in both suites.
_EXPECT_TO_DECISION = {
    "reject": emit_verdicts.REJECT,
    "admit": emit_verdicts.ADMIT,
}


def _load_corpus() -> dict:
    return json.loads(CORPUS_PATH.read_text(encoding="utf-8"))


def _corpus_cases() -> list[dict]:
    return _load_corpus()["cases"]


def test_emitter_reads_the_one_shared_corpus():
    # The emitter must resolve the exact same bytes this test resolves — that shared
    # single-sourcing is what makes the cross-language diff meaningful.
    assert emit_verdicts.CORPUS_PATH == CORPUS_PATH
    assert CORPUS_PATH.is_file(), f"missing fixture corpus at {CORPUS_PATH}"


def test_real_python_gate_matches_corpus_contract():
    """Every fixture's REAL Python-gate verdict equals its corpus ``expect``.

    This is the whole point of the parity harness on the Python side: no fixture is
    hand-registered, the gate is not stubbed, and any drift between the gate and the
    shared contract surfaces as a readable per-fixture diff naming the offenders.
    """
    verdicts = emit_verdicts.emit_corpus_verdicts()
    cases = {case["id"]: case for case in _corpus_cases()}

    # Every fixture is exercised, and nothing extra is invented.
    assert set(verdicts) == set(cases), (
        "emitter and corpus disagree on the fixture set: "
        f"only-in-emitter={sorted(set(verdicts) - set(cases))} "
        f"only-in-corpus={sorted(set(cases) - set(verdicts))}"
    )

    disagreements = []
    for fixture_id, case in sorted(cases.items()):
        expected_decision = _EXPECT_TO_DECISION[case["expect"]]
        actual = verdicts[fixture_id]["decision"]
        if actual != expected_decision:
            disagreements.append(
                f"  {fixture_id}: expect={case['expect']!r} "
                f"(→ {expected_decision!r}) but python gate={actual!r} "
                f"— reason={verdicts[fixture_id]['reason']!r}"
            )

    assert not disagreements, (
        "Python gate disagrees with the shared corpus contract on "
        f"{len(disagreements)} fixture(s):\n" + "\n".join(disagreements)
    )


def test_every_rejected_fixture_carries_a_reason():
    # AC4-style: a machine-consumable reason must travel WITH the verdict (state, not
    # a log line) so the TS diff can show WHY, not just THAT, the gates agree.
    verdicts = emit_verdicts.emit_corpus_verdicts()
    for fixture_id, verdict in sorted(verdicts.items()):
        if verdict["decision"] == emit_verdicts.REJECT:
            assert verdict["reason"], f"{fixture_id} rejected with an empty reason"


def test_decision_vocabulary_is_the_canonical_three_values():
    # The verdict strings the emitter produces must be exactly the canonical admission
    # vocabulary the TS side also speaks — this equality is asserted directly in the
    # TS leg; here we pin the Python side of that contract.
    assert (emit_verdicts.ADMIT, emit_verdicts.PARK, emit_verdicts.REJECT) == (
        "admit",
        "park",
        "reject",
    )
    produced = {v["decision"] for v in emit_verdicts.emit_corpus_verdicts().values()}
    assert produced <= {emit_verdicts.ADMIT, emit_verdicts.PARK, emit_verdicts.REJECT}


def test_corpus_covers_both_admit_and_reject():
    # A parity corpus that only ever produces one verdict proves nothing; require the
    # shared corpus to exercise both an ADMIT and a REJECT path.
    expects = {case["expect"] for case in _corpus_cases()}
    assert "reject" in expects, "corpus has no REJECT fixture"
    assert "admit" in expects, "corpus has no ADMIT fixture"


def test_cli_emits_the_same_map_as_the_import(capsys):
    # The node leg consumes this module as a subprocess; its stdout JSON must equal
    # the in-process map the pytest leg uses, or the two legs would compare different
    # things.
    rc = emit_verdicts.main([])
    assert rc == 0
    printed = json.loads(capsys.readouterr().out)
    assert printed == emit_verdicts.emit_corpus_verdicts()
