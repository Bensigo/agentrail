"""Tests for the statistically-honest regression gate (issue #1040, PRD4).

Every fixture is DETERMINISTIC — no RNG, no seed, no wall-clock. Each task's
reps are a fixed list of ``solved`` booleans and fixed token usage, so every
per-task solve fraction, dollar figure, paired delta, CI, and power value is an
exact function of the inputs. A genuine regression trips the gate; within-CI
jitter does not; ``<synthetic>`` reps never count. Re-running these tests can
never flip a verdict.

Mapping to the issue's acceptance criteria:

- AC1  seeded regression reds ......... test_ac1_seeded_regression_reds
- AC2  K=5 no-change stays green ...... test_ac2_stability_no_change_stays_green
- AC3  output has deltas+CI+power ..... test_ac3_report_exposes_deltas_ci_power
- AC4  under-powered => insufficient .. test_ac4_underpowered_returns_insufficient_reps
- hygiene: <synthetic> excluded ....... test_synthetic_rows_excluded_from_scoring
"""

from __future__ import annotations

from typing import List, Sequence

from agentrail.run.usage_capture import Usage

from agentrail.evals.regression_gate import (
    GateThresholds,
    GateVerdict,
    RegressionGateReport,
    evaluate_regression,
    render_gate_markdown,
)
from agentrail.evals.reporter import RepetitionRecord


# A model in the canonical price table => exact, non-estimated cost.
MODEL = "claude-sonnet-4-5"


def _usage(
    *,
    input_tokens: int = 1_000,
    output_tokens: int = 500,
    model: str = MODEL,
) -> Usage:
    return Usage(
        model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cache_tokens=0,
        cache_creation_tokens=0,
    )


def _reps(
    task: str,
    arm: str,
    solved_flags: Sequence[bool],
    *,
    output_tokens: int = 500,
    network_artifact: bool = False,
) -> List[RepetitionRecord]:
    """A task's fixed rep sequence in one arm — one record per ``solved`` flag.

    Cost is driven by ``output_tokens`` so the $/solved leg can be steered
    independently of the solve-rate leg in fixtures.
    """
    return [
        RepetitionRecord(
            task=task,
            arm=arm,
            solved=bool(flag),
            usage=_usage(output_tokens=output_tokens),
            network_artifact=network_artifact,
        )
        for flag in solved_flags
    ]


def _corpus(baseline_arm: str, candidate_arm: str, spec: dict) -> List[RepetitionRecord]:
    """Build a two-arm corpus from ``{task: (base_flags, cand_flags)}``.

    Keeps fixtures declarative: each task names its baseline and candidate
    solved-sequences; cost is uniform unless a test overrides it separately.
    """
    records: List[RepetitionRecord] = []
    for task, (base_flags, cand_flags) in spec.items():
        records += _reps(task, baseline_arm, base_flags)
        records += _reps(task, candidate_arm, cand_flags)
    return records


# ---------------------------------------------------------------------------
# AC1 — a deliberately degraded candidate arm must RED.
# ---------------------------------------------------------------------------

def test_ac1_seeded_regression_reds():
    """A candidate that solves consistently and materially LESS trips the gate.

    Every one of 10 tasks solves 5/5 in baseline and 1/5 in candidate: a uniform
    -0.8 per-task solve-rate delta, zero variance, so the paired 95% CI is a
    tight band well below zero and the effect dwarfs the 5pp materiality floor.
    This is the unambiguous regression the gate exists to catch.
    """
    spec = {
        f"task_{i}": ([True] * 5, [True] * 1 + [False] * 4)
        for i in range(10)
    }
    records = _corpus("baseline", "degraded", spec)

    report = evaluate_regression(
        records, baseline_arm="baseline", candidate_arm="degraded"
    )

    assert report.verdict is GateVerdict.RED
    assert report.solve_rate.regressed is True
    # CI is entirely below zero (harmful direction) and effect >> materiality.
    assert report.solve_rate.ci_high < 0.0
    assert abs(report.solve_rate.mean_delta) > report.solve_rate.materiality
    assert report.solve_rate.mean_delta < 0.0


def test_ac1_dollars_regression_reds():
    """A cost regression alone (same solves, much pricier) also REDs.

    Solve-rate is identical between arms (no solve regression), but the
    candidate burns ~3x the output tokens per rep, so $/solved rises far past the
    15% relative materiality floor with zero per-task variance. The $/solved leg
    must fire even though solve-rate is flat — the gate guards BOTH axes.
    """
    records: List[RepetitionRecord] = []
    for i in range(10):
        task = f"task_{i}"
        # Both arms solve 3/5 — identical solve-rate, so solve leg is flat.
        flags = [True, True, True, False, False]
        records += _reps(task, "baseline", flags, output_tokens=500)
        records += _reps(task, "pricey", flags, output_tokens=1_500)

    report = evaluate_regression(
        records, baseline_arm="baseline", candidate_arm="pricey"
    )

    assert report.verdict is GateVerdict.RED
    assert report.solve_rate.regressed is False  # solves unchanged
    assert report.dollars_per_solved.regressed is True
    assert report.dollars_per_solved.mean_delta > 0.0  # costs MORE per solve
    assert report.dollars_per_solved.ci_low > 0.0      # CI excludes zero, harmful


# ---------------------------------------------------------------------------
# AC2 — K consecutive no-change comparisons must all stay GREEN.
# ---------------------------------------------------------------------------

def _no_change_corpus(seed_offset: int) -> List[RepetitionRecord]:
    """A powered no-change corpus with identical per-task solve fractions.

    Models a mature eval corpus: 20 tasks at 10 reps each, mostly *saturated*
    (decisively solved 10/10 or unsolved 0/10) with a few genuinely mid-range
    tasks — the realistic shape where a confident GREEN is earnable. ``seed_offset``
    deterministically rotates WHICH reps solve on the mid-range tasks (not how
    many), modelling rep-order jitter between two identical arms. Every task's
    solve fraction is identical across arms, so the true regression is exactly
    zero and every RED would be a false positive; with the reps to resolve a 5pp
    effect, the honest verdict is a confident GREEN, not INSUFFICIENT_REPS.
    """
    records: List[RepetitionRecord] = []
    reps = 12
    # 24 tasks: 22 saturated (11 fully solved, 11 fully failed) + 2 mid-range.
    solve_counts = [12] * 11 + [0] * 11 + [6, 5]
    for i, k in enumerate(solve_counts):
        task = f"task_{i}"
        base_flags = [j < k for j in range(reps)]
        # Rotate which positions are True in the candidate — SAME count k.
        rot = (i + seed_offset) % reps
        cand_positions = {(p + rot) % reps for p in range(k)}
        cand_flags = [j in cand_positions for j in range(reps)]
        records += _reps(task, "baseline", base_flags)
        records += _reps(task, "candidate", cand_flags)
    return records


def test_ac2_stability_no_change_stays_green():
    """K=5 consecutive no-change comparisons on the same corpus all stay GREEN.

    Bounded false-positive rate is part of DONE: across 5 runs where the arms
    have identical per-task solve fractions (only rep ORDER differs), the gate
    must never red. Zero true effect => zero reds.
    """
    verdicts = []
    for k in range(5):
        records = _no_change_corpus(seed_offset=k)
        report = evaluate_regression(
            records, baseline_arm="baseline", candidate_arm="candidate"
        )
        verdicts.append(report.verdict)

    assert all(v is not GateVerdict.RED for v in verdicts), verdicts
    # With identical fractions the delta is exactly zero => confidently GREEN.
    assert all(v is GateVerdict.GREEN for v in verdicts), verdicts


def test_ac2_within_ci_noise_does_not_red():
    """Small sub-materiality jitter (one rep flips on a few tasks) stays non-RED.

    A couple of tasks move by a single rep (0.2 per-task) in opposite directions
    — real jitter, but the mean paired delta sits inside the CI around zero and
    below materiality. The gate must NOT red on noise; that is the whole point of
    CIs over point thresholds.
    """
    records: List[RepetitionRecord] = []
    counts = [(4, 4), (3, 3), (5, 5), (2, 3), (3, 2), (4, 4), (1, 1), (5, 5),
              (2, 2), (4, 4), (3, 3), (5, 5)]
    for i, (bk, ck) in enumerate(counts):
        task = f"task_{i}"
        records += _reps(task, "baseline", [j < bk for j in range(5)])
        records += _reps(task, "candidate", [j < ck for j in range(5)])

    report = evaluate_regression(
        records, baseline_arm="baseline", candidate_arm="candidate"
    )
    assert report.verdict is not GateVerdict.RED
    assert report.solve_rate.regressed is False


# ---------------------------------------------------------------------------
# AC3 — the report exposes per-task deltas, the CI, and achieved power.
# ---------------------------------------------------------------------------

def test_ac3_report_exposes_deltas_ci_power():
    """A verdict alone is not enough: deltas + CI + power must all be present."""
    spec = {
        f"task_{i}": ([True] * 5, [True] * 1 + [False] * 4)
        for i in range(8)
    }
    records = _corpus("baseline", "degraded", spec)
    report = evaluate_regression(
        records, baseline_arm="baseline", candidate_arm="degraded"
    )

    # Per-task deltas — one per paired task, each carrying its solve delta.
    assert len(report.per_task_deltas) == 8
    for d in report.per_task_deltas:
        assert d.solve_rate_delta == -0.8
        assert d.baseline_solve_rate == 1.0
        assert d.candidate_solve_rate == 0.2

    # Confidence interval on the paired mean.
    assert report.solve_rate.ci_low <= report.solve_rate.mean_delta <= report.solve_rate.ci_high
    assert report.solve_rate.ci_excludes_zero is True

    # Achieved power is a real probability in [0, 1] and reported on the leg.
    assert 0.0 <= report.solve_rate.achieved_power <= 1.0
    assert 0.0 <= report.dollars_per_solved.achieved_power <= 1.0

    # And it all renders into the human report without error.
    md = render_gate_markdown(report)
    assert "Per-task paired deltas" in md
    assert "power" in md
    assert "95% CI" in md


# ---------------------------------------------------------------------------
# AC4 — an under-powered comparison is INSUFFICIENT_REPS, not green/red.
# ---------------------------------------------------------------------------

def test_ac4_underpowered_returns_insufficient_reps():
    """Too few paired tasks => explicit INSUFFICIENT_REPS, distinct from GREEN.

    Only two tasks, each solving identically in both arms. There is no
    regression, but two paired points cannot power a confident 'no regression'
    call — so the gate must return INSUFFICIENT_REPS rather than a false GREEN.
    """
    spec = {
        "task_0": ([True, True, False], [True, True, False]),
        "task_1": ([True, False, False], [True, False, False]),
    }
    records = _corpus("baseline", "candidate", spec)
    report = evaluate_regression(
        records, baseline_arm="baseline", candidate_arm="candidate"
    )

    assert report.verdict is GateVerdict.INSUFFICIENT_REPS
    assert report.verdict is not GateVerdict.GREEN
    assert report.verdict is not GateVerdict.RED


def test_ac4_underpowered_by_low_power_even_with_enough_tasks():
    """Enough tasks but too little power to SEE a 5pp drop => INSUFFICIENT_REPS.

    Five tasks, only 2 reps each, all tied. There are >= min_paired_tasks, and no
    regression, yet the achieved power to detect a materiality-sized effect is
    far below the 0.80 floor — so a GREEN would be dishonest ('didn't look hard
    enough' masquerading as 'nothing there'). The gate downgrades to
    INSUFFICIENT_REPS.
    """
    spec = {
        f"task_{i}": ([True, False], [True, False])
        for i in range(5)
    }
    records = _corpus("baseline", "candidate", spec)
    report = evaluate_regression(
        records, baseline_arm="baseline", candidate_arm="candidate"
    )

    assert report.verdict is GateVerdict.INSUFFICIENT_REPS
    assert report.solve_rate.underpowered is True
    assert report.solve_rate.achieved_power < report.thresholds.min_power


def test_ac4_insufficient_is_distinct_from_a_real_regression():
    """A real, material regression REDs even on a thin sample — RED beats power.

    Sanity that INSUFFICIENT_REPS does not swallow genuine red signal: three
    tasks, each 5/5 -> 0/5, a uniform -1.0 delta with zero variance. Even at the
    minimum task count the effect is unmistakable, so the gate reds (a detected
    harmful effect is not made less real by a small sample).
    """
    spec = {
        f"task_{i}": ([True] * 5, [False] * 5)
        for i in range(3)
    }
    records = _corpus("baseline", "gone", spec)
    report = evaluate_regression(
        records, baseline_arm="baseline", candidate_arm="gone"
    )
    assert report.verdict is GateVerdict.RED


# ---------------------------------------------------------------------------
# Hygiene (#1033) — <synthetic> network-artifact reps are excluded from scoring.
# ---------------------------------------------------------------------------

def test_synthetic_rows_excluded_from_scoring():
    """ECONNRESET <synthetic> reps must not manufacture a regression.

    Baseline solves 5/5 on every task. The candidate ALSO solves 5/5 on every
    real rep, but each candidate task carries extra ``network_artifact`` reps
    with solved=False. If those artifacts were scored, the candidate would look
    like a catastrophic regression (solve-rate cratered) and the gate would red.
    Because they are excluded, both arms are 5/5 and the gate does NOT red — and
    the excluded count is disclosed on the report.
    """
    records: List[RepetitionRecord] = []
    for i in range(8):
        task = f"task_{i}"
        records += _reps(task, "baseline", [True] * 5)
        records += _reps(task, "candidate", [True] * 5)
        # Poison the candidate with dropped-connection artifacts (solved=False).
        records += _reps(
            task, "candidate", [False] * 3, network_artifact=True
        )

    report = evaluate_regression(
        records, baseline_arm="baseline", candidate_arm="candidate"
    )

    # Excluded artifacts are disclosed, not scored.
    assert report.network_artifact_count == 8 * 3
    # Every paired task is 5/5 vs 5/5 once artifacts are removed => no regression.
    for d in report.per_task_deltas:
        assert d.candidate_solve_rate == 1.0
        assert d.solve_rate_delta == 0.0
    assert report.verdict is not GateVerdict.RED


def test_synthetic_only_candidate_still_excluded():
    """Artifacts on one arm only are still stripped before pairing.

    A single ECONNRESET rep appended to each candidate task (solved=False) must
    not drag the candidate solve fraction below baseline. Post-hygiene both arms
    match, so no spurious negative delta appears.
    """
    records: List[RepetitionRecord] = []
    for i in range(6):
        task = f"task_{i}"
        records += _reps(task, "baseline", [True, True, True, False, False])
        records += _reps(task, "candidate", [True, True, True, False, False])
        records += _reps(task, "candidate", [False], network_artifact=True)

    report = evaluate_regression(
        records, baseline_arm="baseline", candidate_arm="candidate"
    )
    for d in report.per_task_deltas:
        assert d.baseline_solve_rate == d.candidate_solve_rate == 0.6
        assert d.solve_rate_delta == 0.0
    assert report.verdict is not GateVerdict.RED


# ---------------------------------------------------------------------------
# Tie handling — tie tasks are kept as paired zeros and disclosed.
# ---------------------------------------------------------------------------

def test_tie_tasks_kept_as_paired_zeros():
    """Tasks that tie are retained (as zeros) and counted, not dropped.

    Four tasks tie exactly (same fraction both arms); four move slightly. All
    eight remain paired; the four ties are flagged and counted. Dropping ties
    would bias the mean and waste the honest 'arms agree' signal.
    """
    records: List[RepetitionRecord] = []
    tie_counts = [3, 3, 4, 2]        # same in both arms
    move = [(3, 4), (4, 3), (2, 3), (5, 4)]
    for i, k in enumerate(tie_counts):
        task = f"tie_{i}"
        records += _reps(task, "baseline", [j < k for j in range(5)])
        records += _reps(task, "candidate", [j < k for j in range(5)])
    for i, (bk, ck) in enumerate(move):
        task = f"move_{i}"
        records += _reps(task, "baseline", [j < bk for j in range(5)])
        records += _reps(task, "candidate", [j < ck for j in range(5)])

    report = evaluate_regression(
        records, baseline_arm="baseline", candidate_arm="candidate"
    )
    assert len(report.per_task_deltas) == 8
    assert report.tie_task_count == 4
    ties = [d for d in report.per_task_deltas if d.is_tie]
    assert len(ties) == 4
    for d in ties:
        assert d.solve_rate_delta == 0.0


# ---------------------------------------------------------------------------
# Pairing — only tasks present in BOTH arms are paired; the rest are disclosed.
# ---------------------------------------------------------------------------

def test_unpaired_tasks_are_dropped_and_disclosed():
    """A task in only one arm cannot be paired; it is dropped and counted."""
    records: List[RepetitionRecord] = []
    for i in range(4):
        task = f"shared_{i}"
        records += _reps(task, "baseline", [True, True, True, False, False])
        records += _reps(task, "candidate", [True, True, True, False, False])
    # Baseline-only and candidate-only tasks.
    records += _reps("base_only", "baseline", [True] * 5)
    records += _reps("cand_only", "candidate", [True] * 5)

    report = evaluate_regression(
        records, baseline_arm="baseline", candidate_arm="candidate"
    )
    paired_tasks = {d.task for d in report.per_task_deltas}
    assert paired_tasks == {f"shared_{i}" for i in range(4)}
    assert report.dropped_task_count == 2  # base_only + cand_only


def test_dollars_per_solved_none_when_task_never_solves_in_an_arm():
    """$/solved delta is None (not 0.0) when a task never solves in one arm.

    A defined $/solved needs at least one solve in that arm. When baseline solves
    the task but candidate never does, there is no candidate ratio to difference,
    so the per-task $/solved delta is explicitly None — distinct from a real 0.0.
    """
    records: List[RepetitionRecord] = []
    # Task that solves in baseline but never in candidate.
    records += _reps("t0", "baseline", [True, True, False, False, False])
    records += _reps("t0", "candidate", [False] * 5)
    # A few normal tasks so the corpus is otherwise well-formed.
    for i in range(1, 5):
        task = f"t{i}"
        records += _reps(task, "baseline", [True, True, True, False, False])
        records += _reps(task, "candidate", [True, True, True, False, False])

    report = evaluate_regression(
        records, baseline_arm="baseline", candidate_arm="candidate"
    )
    t0 = next(d for d in report.per_task_deltas if d.task == "t0")
    assert t0.candidate_dollars_per_solved is None
    assert t0.dollars_per_solved_delta is None


# ---------------------------------------------------------------------------
# Custom thresholds are honored.
# ---------------------------------------------------------------------------

def test_custom_materiality_makes_a_borderline_move_immaterial():
    """Raising materiality can turn a would-be RED into a non-material GREEN path.

    A uniform -0.2 per-task solve drop with zero variance reds at the default 5pp
    materiality. Raise materiality above 0.2 and the same real, tight-CI effect
    is now deemed immaterial — the gate must not red on a below-threshold effect.
    """
    spec = {
        f"task_{i}": ([True] * 5, [True] * 4 + [False])  # 1.0 -> 0.8, delta -0.2
        for i in range(12)
    }
    records = _corpus("baseline", "candidate", spec)

    strict = evaluate_regression(
        records, baseline_arm="baseline", candidate_arm="candidate"
    )
    assert strict.verdict is GateVerdict.RED  # -0.2 > 0.05 materiality

    # Relax BOTH legs' materiality: the fewer solves also nudge $/solved up, so
    # isolating the solve-rate axis means loosening the dollar floor too. Now the
    # -0.2 solve drop is below the 0.30 floor and the $ move is below its floor.
    lenient = evaluate_regression(
        records,
        baseline_arm="baseline",
        candidate_arm="candidate",
        thresholds=GateThresholds(
            solve_rate_materiality=0.30,
            dollars_per_solved_materiality_frac=0.50,
        ),
    )
    assert lenient.verdict is not GateVerdict.RED  # both effects now immaterial
    assert lenient.solve_rate.exceeds_materiality is False
