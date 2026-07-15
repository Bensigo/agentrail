"""Tests for the three intrinsic probes (issue #943).

Fixture-driven and deterministic, mirroring the reporter/scorer tests. Each
probe is asserted against crafted ``RunRecord`` fixtures (or a crafted
injection corpus) with hand-computed expectations:

- **AC1 routing cost-regret**: regret = cost of the solving model used minus the
  cheapest model that ALSO solved the same task across the run set. Dollars are
  asserted EXACTLY against ``usage_cost`` (never hard-coded).
- **AC2 retry lift**: solve-rate lift = with-retry solve-rate minus
  first-attempt-only solve-rate; wasted-retry cost = dollar cost of retries that
  did not flip the run to solved.
- **AC3 guardrail catch-rate**: a small injection corpus (secret-in-diff,
  deleted-test) fed through the REAL guardrails from ``agentrail.guardrails``;
  the caught fraction is asserted, with a clean case that is NOT flagged so the
  catch-rate is falsifiable.
- **AC4**: each probe is derived from recorded fields (model/usage/retries on
  the RunRecord, gate/guardrail decisions), never re-invented.
"""

from __future__ import annotations

import pytest

from agentrail.run.pricing import cost_usd
from agentrail.run.usage_capture import Usage

from agentrail.evals.pricing_adapter import usage_cost
from agentrail.evals.run_record import RetryEvent, RunRecord
from agentrail.evals.probes import (
    INJECTION_CORPUS,
    FalseClaimReport,
    GuardrailCatchReport,
    InjectionCase,
    RetryLiftReport,
    RoutingRegretReport,
    ScoredRun,
    false_claim_rate,
    guardrail_catch_rate,
    retry_lift,
    routing_cost_regret,
)


# Models present in the canonical price table, with a clear cheap/expensive gap.
CHEAP_MODEL = "claude-haiku-4-5"
EXPENSIVE_MODEL = "claude-opus-4-5"


def _usage(
    *,
    model: str,
    input_tokens: int = 1000,
    output_tokens: int = 1000,
    cache_tokens: int = 0,
    cache_creation_tokens: int = 0,
) -> Usage:
    return Usage(
        model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cache_tokens=cache_tokens,
        cache_creation_tokens=cache_creation_tokens,
    )


def _run(
    *,
    task: str,
    arm: str,
    model: str,
    usage: Usage,
    gate_passed: bool = True,
    retries=None,
) -> RunRecord:
    return RunRecord(
        task=task,
        arm=arm,
        diff="",
        model=model,
        usage=usage,
        wall_time_s=1.0,
        gate_passed=gate_passed,
        retries=list(retries or []),
    )


def _scored(run: RunRecord, solved: bool) -> ScoredRun:
    return ScoredRun(run=run, solved=solved)


# ---------------------------------------------------------------------------
# AC1 — routing cost-regret
# ---------------------------------------------------------------------------


def test_routing_regret_is_expensive_minus_cheapest_solving_model():
    """Task solved by both a cheap and an expensive model → regret on the
    expensive run is its cost minus the cheapest solving cost; the cheap run has
    zero regret (it IS the cheapest)."""
    cheap_usage = _usage(model=CHEAP_MODEL)
    expensive_usage = _usage(model=EXPENSIVE_MODEL)

    cheap_run = _run(task="t1", arm="baseline", model=CHEAP_MODEL, usage=cheap_usage)
    expensive_run = _run(task="t1", arm="full", model=EXPENSIVE_MODEL, usage=expensive_usage)

    report = routing_cost_regret(
        [_scored(cheap_run, True), _scored(expensive_run, True)]
    )

    cheap_cost = usage_cost(cheap_usage)
    expensive_cost = usage_cost(expensive_usage)
    assert expensive_cost > cheap_cost  # sanity: the table really differs

    # Overall regret = sum over solved runs of (run cost - cheapest solving cost
    # for that task). t1's cheapest solving cost is cheap_cost.
    expected_total = (cheap_cost - cheap_cost) + (expensive_cost - cheap_cost)
    assert report.total_regret_usd == pytest.approx(expected_total)
    assert report.total_regret_usd == pytest.approx(expensive_cost - cheap_cost)

    by_arm = {a.arm: a for a in report.per_arm}
    assert by_arm["baseline"].regret_usd == pytest.approx(0.0)
    assert by_arm["full"].regret_usd == pytest.approx(expensive_cost - cheap_cost)


def test_routing_regret_uses_pricing_adapter_exactly():
    """The dollars must come from usage_cost (== cost_usd), never a re-invented
    price (AC4: derived from recorded usage/model)."""
    expensive_usage = _usage(model=EXPENSIVE_MODEL)
    cheap_usage = _usage(model=CHEAP_MODEL)
    runs = [
        _scored(_run(task="t1", arm="full", model=EXPENSIVE_MODEL, usage=expensive_usage), True),
        _scored(_run(task="t1", arm="baseline", model=CHEAP_MODEL, usage=cheap_usage), True),
    ]
    report = routing_cost_regret(runs)
    assert report.total_regret_usd == pytest.approx(
        cost_usd(expensive_usage) - cost_usd(cheap_usage)
    )


def test_routing_regret_unsolved_task_contributes_no_regret():
    """A task that was never solved contributes no regret (documented convention)."""
    expensive_usage = _usage(model=EXPENSIVE_MODEL)
    runs = [
        _scored(_run(task="t1", arm="full", model=EXPENSIVE_MODEL, usage=expensive_usage), False),
    ]
    report = routing_cost_regret(runs)
    assert report.total_regret_usd == pytest.approx(0.0)
    # The arm appears but with zero regret and zero solved runs.
    by_arm = {a.arm: a for a in report.per_arm}
    assert by_arm["full"].regret_usd == pytest.approx(0.0)
    assert by_arm["full"].solved_runs == 0


def test_routing_regret_empty_is_defined_not_crash():
    report = routing_cost_regret([])
    assert isinstance(report, RoutingRegretReport)
    assert report.total_regret_usd == pytest.approx(0.0)
    assert report.per_arm == []


def test_routing_regret_unsolved_cheap_does_not_lower_the_floor():
    """A cheaper model that did NOT solve must not become the cheapest *solving*
    floor — only solved runs define the achievable floor."""
    cheap_usage = _usage(model=CHEAP_MODEL)
    expensive_usage = _usage(model=EXPENSIVE_MODEL)
    runs = [
        # cheap tried t1 and failed — it is NOT a valid floor.
        _scored(_run(task="t1", arm="baseline", model=CHEAP_MODEL, usage=cheap_usage), False),
        # expensive solved t1 — it is the only solving model, so regret is 0.
        _scored(_run(task="t1", arm="full", model=EXPENSIVE_MODEL, usage=expensive_usage), True),
    ]
    report = routing_cost_regret(runs)
    assert report.total_regret_usd == pytest.approx(0.0)


# ---------------------------------------------------------------------------
# AC2 — retry lift + wasted-retry cost
# ---------------------------------------------------------------------------


def test_retry_lift_counts_only_retry_attributable_solves():
    """A run that failed its first attempt but solved after a retry contributes
    to the lift; a run that solved on the first attempt does not."""
    usage = _usage(model=CHEAP_MODEL)

    # Run A: solved on first attempt (no retries) → no lift from it.
    run_a = _run(task="t1", arm="full", model=CHEAP_MODEL, usage=usage, retries=[])

    # Run B: first attempt's gate was red, retried, then solved → lift +1.
    run_b = _run(
        task="t2",
        arm="full",
        model=CHEAP_MODEL,
        usage=usage,
        retries=[
            RetryEvent(attempt=1, model=CHEAP_MODEL, gate_passed=False, reason="gate red"),
            RetryEvent(attempt=2, model=CHEAP_MODEL, gate_passed=True, reason="escalation"),
        ],
    )

    report = retry_lift([_scored(run_a, True), _scored(run_b, True)])

    # With retries: both solved → 2/2 = 1.0.
    assert report.with_retry_solve_rate == pytest.approx(1.0)
    # First-attempt-only: run A solved on attempt 1 (no retries, solved=True);
    # run B's first attempt gate was red → it would NOT have solved without the
    # retry. So first-attempt solve-rate = 1/2 = 0.5.
    assert report.first_attempt_solve_rate == pytest.approx(0.5)
    assert report.lift == pytest.approx(0.5)


def test_retry_wasted_cost_for_runs_retries_never_flipped():
    """A run whose retries never flipped it to solved is wasted-retry cost: the
    dollar cost of that run's retry attempts."""
    first_usage = _usage(model=CHEAP_MODEL, input_tokens=500, output_tokens=500)
    # The RunRecord.usage is the whole-run usage; retries don't carry usage on
    # the contract, so wasted-retry cost is the run's usage cost attributed to
    # the retries of an unsolved run (the dollars spent past the first attempt).
    run = _run(
        task="t1",
        arm="full",
        model=CHEAP_MODEL,
        usage=first_usage,
        gate_passed=False,
        retries=[
            RetryEvent(attempt=1, model=CHEAP_MODEL, gate_passed=False, reason="gate red"),
            RetryEvent(attempt=2, model=CHEAP_MODEL, gate_passed=False, reason="gate red"),
        ],
    )
    report = retry_lift([_scored(run, False)])

    # The run retried but never solved → its whole run cost is wasted-retry cost
    # (every attempt past the first was spent and none flipped it).
    assert report.wasted_retry_cost_usd == pytest.approx(usage_cost(first_usage))


def test_retry_no_wasted_cost_when_retry_solved():
    """A run that retried and DID solve is not wasted (the retry paid off)."""
    usage = _usage(model=CHEAP_MODEL)
    run = _run(
        task="t1",
        arm="full",
        model=CHEAP_MODEL,
        usage=usage,
        retries=[
            RetryEvent(attempt=1, model=CHEAP_MODEL, gate_passed=False, reason="gate red"),
            RetryEvent(attempt=2, model=CHEAP_MODEL, gate_passed=True, reason="escalation"),
        ],
    )
    report = retry_lift([_scored(run, True)])
    assert report.wasted_retry_cost_usd == pytest.approx(0.0)


def test_retry_no_wasted_cost_when_no_retries():
    """A run that never retried contributes no wasted-retry cost even if unsolved."""
    usage = _usage(model=CHEAP_MODEL)
    run = _run(task="t1", arm="full", model=CHEAP_MODEL, usage=usage, retries=[])
    report = retry_lift([_scored(run, False)])
    assert report.wasted_retry_cost_usd == pytest.approx(0.0)
    assert report.lift == pytest.approx(0.0)


def test_retry_lift_empty_is_defined_not_crash():
    report = retry_lift([])
    assert isinstance(report, RetryLiftReport)
    # Undefined solve-rates report None (ratio over empty), never a crash.
    assert report.with_retry_solve_rate is None
    assert report.first_attempt_solve_rate is None
    assert report.lift is None
    assert report.wasted_retry_cost_usd == pytest.approx(0.0)


# ---------------------------------------------------------------------------
# #1172 AC1 — reviewer false-claim rate (accept ∧ not solved)
# ---------------------------------------------------------------------------


def _run_v(
    *,
    task: str,
    arm: str,
    verdicts,
) -> RunRecord:
    """A RunRecord carrying reviewer verdicts (the #1169 forensics field)."""
    return RunRecord(
        task=task,
        arm=arm,
        diff="",
        model=CHEAP_MODEL,
        usage=_usage(model=CHEAP_MODEL),
        wall_time_s=1.0,
        gate_passed=True,
        verdicts=list(verdicts),
    )


def _verdict(accepted: bool, phase: str = "verify") -> dict:
    return {"phase": phase, "accepted": accepted, "reason": ""}


def test_false_claim_counts_accepted_not_solved():
    """accept ∧ not-solved is a false claim; accept ∧ solved is NOT; reject ∧
    not-solved is NOT (the reviewer never claimed success)."""
    runs = [
        # accepted AND not solved -> counted (numerator + denominator).
        _scored(_run_v(task="t1", arm="full", verdicts=[_verdict(True)]), False),
        # accepted AND solved -> denominator only, NOT a false claim.
        _scored(_run_v(task="t2", arm="full", verdicts=[_verdict(True)]), True),
        # rejected AND not solved -> excluded entirely (no accept claim).
        _scored(_run_v(task="t3", arm="full", verdicts=[_verdict(False)]), False),
    ]
    report = false_claim_rate(runs)
    assert isinstance(report, FalseClaimReport)
    (arm,) = report.per_arm
    assert arm.arm == "full"
    # Denominator = accepted runs (t1, t2). t3 rejected -> excluded.
    assert arm.accepted_runs == 2
    # Numerator = accepted AND not solved (t1 only).
    assert arm.false_claims == 1
    assert arm.false_claim_rate == pytest.approx(0.5)


def test_false_claim_empty_verdicts_excluded_from_denominator():
    """A run with NO verdict-bearing phase carried no reviewer accept — it is
    excluded from the denominator, even when it did not solve."""
    runs = [
        # No verdicts at all: the reviewer never accepted -> not in denominator.
        _scored(_run_v(task="t1", arm="full", verdicts=[]), False),
        # A real accepted-not-solved so the arm still appears.
        _scored(_run_v(task="t2", arm="full", verdicts=[_verdict(True)]), False),
    ]
    (arm,) = false_claim_rate(runs).per_arm
    assert arm.accepted_runs == 1  # only t2; the empty-verdicts run is excluded
    assert arm.false_claims == 1
    assert arm.false_claim_rate == pytest.approx(1.0)


def test_false_claim_uses_final_verdict_bearing_phase():
    """When a run has multiple verdict phases, the FINAL one's accept is the
    reviewer's operative decision — an earlier reject overturned by a later
    accept still ships."""
    runs = [
        _scored(
            _run_v(
                task="t1",
                arm="full",
                verdicts=[_verdict(False, "critic"), _verdict(True, "critic-2")],
            ),
            False,
        ),
    ]
    (arm,) = false_claim_rate(runs).per_arm
    # Final verdict accepted -> counted as an accept; not solved -> false claim.
    assert arm.accepted_runs == 1
    assert arm.false_claims == 1
    assert arm.false_claim_rate == pytest.approx(1.0)


def test_false_claim_rate_none_when_arm_accepted_nothing():
    """An arm that accepted NOTHING has an undefined denominator: the rate is
    None (never a fabricated 0.0), matching the false_green_rate discipline."""
    runs = [
        _scored(_run_v(task="t1", arm="full", verdicts=[_verdict(False)]), False),
        _scored(_run_v(task="t2", arm="full", verdicts=[]), True),
    ]
    (arm,) = false_claim_rate(runs).per_arm
    assert arm.accepted_runs == 0
    assert arm.false_claims == 0
    assert arm.false_claim_rate is None


def test_false_claim_rate_is_per_arm():
    """Counts are broken out per arm, in sorted arm order."""
    runs = [
        _scored(_run_v(task="t1", arm="baseline", verdicts=[_verdict(True)]), False),
        _scored(_run_v(task="t1", arm="full", verdicts=[_verdict(True)]), True),
    ]
    report = false_claim_rate(runs)
    arms = {a.arm: a for a in report.per_arm}
    assert [a.arm for a in report.per_arm] == ["baseline", "full"]
    assert arms["baseline"].false_claim_rate == pytest.approx(1.0)
    assert arms["full"].false_claim_rate == pytest.approx(0.0)


def test_false_claim_rate_empty_is_defined_not_crash():
    report = false_claim_rate([])
    assert isinstance(report, FalseClaimReport)
    assert report.per_arm == []


# ---------------------------------------------------------------------------
# AC3 — guardrail injection-corpus catch-rate
# ---------------------------------------------------------------------------


def test_injection_corpus_has_required_violation_cases():
    """The corpus must include at minimum a secret-in-diff and a deleted-test
    violation, plus a clean (no-violation) falsifier."""
    kinds = {c.kind for c in INJECTION_CORPUS}
    assert "secret_in_diff" in kinds
    assert "deleted_test" in kinds
    # A clean case so catch-rate is falsifiable (not trivially 100%).
    assert any(not c.is_violation for c in INJECTION_CORPUS)


def test_guardrail_catch_rate_catches_the_planted_violations():
    """The REAL guardrails catch both planted violations; the clean case is not
    flagged, so the catch-rate (over violations) is 2/2 and falsifiable."""
    report = guardrail_catch_rate(INJECTION_CORPUS)
    assert isinstance(report, GuardrailCatchReport)

    # Every violation case was caught.
    violations = [c for c in report.cases if c.is_violation]
    clean = [c for c in report.cases if not c.is_violation]
    assert all(c.caught for c in violations)
    assert all(not c.flagged for c in clean)

    # Catch-rate is computed over the VIOLATION cases only.
    assert report.violations == len(violations)
    assert report.caught == len(violations)
    assert report.catch_rate == pytest.approx(1.0)

    # A real guardrail fired for each violation (named, not stubbed).
    fired = {c.kind: c.guardrail for c in report.cases if c.caught}
    assert fired["secret_in_diff"] == "push_guardrail"
    assert fired["deleted_test"] in {"objective_gate"}


def test_guardrail_catch_rate_falsifier_clean_case_not_flagged():
    """A clean diff with no secret and no deleted test must NOT be flagged — this
    is the falsifier proving the probe is not trivially always-catch."""
    clean = [c for c in INJECTION_CORPUS if not c.is_violation]
    assert clean, "corpus must contain a clean case"
    report = guardrail_catch_rate(clean)
    # No violations → catch-rate is undefined (None), never a fake 0/0 = 1.0.
    assert report.catch_rate is None
    assert all(not c.flagged for c in report.cases)


def test_guardrail_probe_runs_real_registered_guardrails():
    """Sanity that the probe drives guardrails from the real registry — the
    named guardrails it uses must actually be registered (no stub)."""
    from agentrail.guardrails.registry import list_guardrails

    names = {g.name for g in list_guardrails()}
    assert "push_guardrail" in names
    assert "objective_gate" in names


def test_guardrail_catch_rate_empty_is_defined_not_crash():
    report = guardrail_catch_rate([])
    assert report.catch_rate is None
    assert report.violations == 0
    assert report.caught == 0
    assert report.cases == []


# ---------------------------------------------------------------------------
# Reporter rendering — all three probes surface in the committed markdown.
# ---------------------------------------------------------------------------


def test_render_probes_markdown_surfaces_all_three():
    from agentrail.evals.reporter import render_probes_markdown

    cheap_usage = _usage(model=CHEAP_MODEL)
    expensive_usage = _usage(model=EXPENSIVE_MODEL)
    routing = routing_cost_regret(
        [
            _scored(_run(task="t1", arm="baseline", model=CHEAP_MODEL, usage=cheap_usage), True),
            _scored(_run(task="t1", arm="full", model=EXPENSIVE_MODEL, usage=expensive_usage), True),
        ]
    )
    retry = retry_lift(
        [
            _scored(
                _run(
                    task="t2",
                    arm="full",
                    model=CHEAP_MODEL,
                    usage=cheap_usage,
                    retries=[
                        RetryEvent(attempt=1, model=CHEAP_MODEL, gate_passed=False),
                        RetryEvent(attempt=2, model=CHEAP_MODEL, gate_passed=True),
                    ],
                ),
                True,
            )
        ]
    )
    guardrail = guardrail_catch_rate(INJECTION_CORPUS)

    md = render_probes_markdown(routing=routing, retry=retry, guardrail=guardrail)

    assert "Routing cost-regret" in md
    assert "Retry lift" in md
    assert "Guardrail injection-corpus catch-rate" in md
    # The real catch-rate is surfaced.
    assert "100.0%" in md
    # The clean falsifier appears as not-flagged.
    assert "clean (not flagged)" in md


def test_render_probes_markdown_none_probes_render_not_available():
    from agentrail.evals.reporter import render_probes_markdown

    md = render_probes_markdown(routing=None, retry=None, guardrail=None)
    assert md.count("_Not available") >= 1
    # No crash, all three sections present.
    assert "Routing cost-regret" in md
    assert "Retry lift" in md
    assert "Guardrail injection-corpus catch-rate" in md


# ---------------------------------------------------------------------------
# CLI surface — `agentrail evals probes` runs the live guardrail catch-rate.
# ---------------------------------------------------------------------------


def test_cli_evals_probes_prints_real_catch_rate(capsys):
    from agentrail.cli.commands.evals import run_evals

    rc = run_evals(["probes"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "Guardrail injection-corpus catch-rate" in out
    assert "Catch-rate: 100.0%" in out
    assert "secret_in_diff via push_guardrail: CAUGHT" in out
