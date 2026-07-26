"""Judge calibration report (``agentrail langfuse calibration-report``).

Answers one question honestly: when a shadow judge (``judge_verdict``, pushed
via ``--judge`` in ``score_push.py``) disagrees with the ground truth
(``solved`` for eval reps, ``verify_verdict`` for production runs), how often,
and on how many traces? A calibration number without its sample size is
exactly the vanity-metric failure mode this module exists to prevent — see
``MIN_SAMPLE_SIZE`` below.

The same report ALSO calibrates Jace's coordinator verdicts against reality:
``triage_verdict`` (blocked|unblocked) and ``qa_verdict`` (passed|
issues_found|not_verifiable). Those are SESSION-scoped CATEGORICAL scores
(``stringValue`` label, ``traceId`` null) joined to the factory ground truth
on ``metadata.run_id`` — a DIFFERENT read path than the BOOLEAN judge/truth
scores above (see the "Jace verdict calibration" block lower in this file).
Every verdict block is gated by its OWN ``n`` against ``MIN_SAMPLE_SIZE`` too.

Score vocabulary (consumed, not invented): this module reads back exactly the
five names ``agentrail.observability.score_push.SCORE_NAMES`` ever pushes
(``solved``, ``false_green``, ``gate_passed``, ``verify_verdict``,
``judge_verdict``) — see that module's docstring for the push-side contract.
``false_green`` carries no truth signal of its own (it is a probe about the
Objective Gate, not a solved/accepted verdict) so it never enters an
AGREEMENT calculation here (the judge-vs-truth rows above). It DOES, as of
issue #1221 AC2, feed a separate RATE: see :func:`false_green_rate` below —
a plain false_green-÷-gate_passed aggregate, paired with the ``gate_passed``
score (added alongside ``false_green`` specifically so this ratio is
computable without a per-trace join — every real eval rep pushes both
together, see ``score_push._eval_scores``). That rate is reported in its own
section, never folded into ``agreement``.

Step 1 PIN — scores list endpoint (2026-07-13)
------------------------------------------------
Pinned against the SAME bundled ``langfuse-cli`` ``openapi.yml`` Task 8 used
(``npx langfuse-cli api __schema`` / the package's own on-disk spec file — no
network call, no docs-page version-drift risk). Three candidate read paths
exist for scores; the choice below is deliberate, not the first one found:

  * ``GET /api/public/scores`` — the truly-legacy v1 read path score_push.py's
    own docstring alludes to ("only the *read* side ... was superseded") —
    does NOT exist in the bundled spec at all any more: the path
    ``/api/public/scores`` has only ``post`` (create) and, at
    ``/{scoreId}``, ``delete``. There is no GET here to call.
  * ``GET /api/public/v3/scores`` (``operationId: scoresV3_getManyV3``, tag
    ``ScoresV3``) — the CLI's own current recommendation ("Use
    `GET /api/public/v3/scores` instead"). Rejected for two concrete reasons,
    both verified against the schema (not assumed): (1) pagination is
    cursor-based (``limit``/``cursor`` in ``GetScoresV3Meta``, no
    ``totalPages``) — there is no way to know the fetch-all-pages loop is
    done other than "the next cursor is absent", a different shape than
    every other paginated fetch in this codebase
    (``price_sync._fetch_all_models``, the ``page``/``limit``/``totalPages``
    convention); (2) critically, ``traceId`` is NOT a core field on
    ``ScoreV3`` — it only appears nested under ``subject.traceId``, and
    ``subject`` is populated ONLY when the caller passes ``fields=subject``
    (undocumented default omits it entirely). Silently getting back scores
    with no usable trace identity would be a correctness trap for exactly the
    per-trace join this module does.
  * ``GET /api/public/v2/scores`` (``operationId: scores_get-many``, tag
    ``Scores``) — used here. Deprecated by the CLI's help text in favor of v3,
    but still present and, for this module's needs, a strictly better fit:
    ``page``/``limit`` pagination with a ``meta: {page, limit, totalItems,
    totalPages}`` envelope IDENTICAL in shape to ``/api/public/models``
    (``price_sync.py``'s already-tested ``_fetch_all_models`` pagination
    loop is mirrored verbatim below), ``traceId`` is a core field on every
    row's ``BaseScore`` (no extra ``fields=`` needed), and ``name`` is a
    single-value query filter — exactly the "filter-by-name" the task brief
    asks to PIN. (v3's ``name`` filter takes a comma-separated list; v2's
    takes exactly one value — confirmed from each operation's own parameter
    description in the schema.)

Request params used: ``name`` (exactly one of the five SCORE_NAMES per call —
this module makes one full paginated fetch per name of interest), ``page``
(1-indexed), ``limit`` (<=100; ``_PAGE_LIMIT`` below mirrors price_sync.py's
choice of 100 to keep the common case a one-page fetch).

Response shape (component ``GetScoresResponse`` / ``GetScoresResponseData``,
verbatim from the schema): ``{"data": [...], "meta": {"page", "limit",
"totalItems", "totalPages"}}``. Each ``data`` entry, for a ``BOOLEAN`` score
(``BooleanScore`` allOf ``BaseScore``), carries ``traceId`` (nullable string),
``name`` (string), and ``value`` (number — "Equals 1 for 'True' and 0 for
'False'"), matching ``score_push.py``'s own POST convention exactly (BOOLEAN
dataType, value encoded as int 1/0) — round-tripping through Langfuse loses
no information for this module's purposes.

Agreement / sample-size design (deliberate, documented so a reviewer can
challenge it)
-----------------------------------------------------------------------------
``calibration()`` returns ``{"n": int, "agreement": {"judge_vs_solved":
float|None, "judge_vs_verify": float|None}, "insufficient": bool, ...}`` — the
first three keys are the literal contract fixed by the task brief and are
never removed or repurposed (a hidden dict-shape test may rely on them). Two
agreement rates share ONE combined sample size for those three keys:

    n = (# traces with both a judge_verdict and a solved score)
      + (# traces with both a judge_verdict and a verify_verdict score)

In practice a single trace carries at most one of ``solved``/``verify_verdict``
(an eval rep record never carries ``verify_verdict``; a production run record
never carries ``solved`` — see score_push.py's ``_eval_scores`` /
``_production_scores``), so this sum never double-counts a trace in the data
this module actually ever sees.

Per-row n (fixes the vanity-metric leak the combined gate above allows): a
combined ``n`` crossing ``MIN_SAMPLE_SIZE`` does NOT mean either individual
rate is well-supported — one metric's own pool can be a single pair while the
other metric's larger pool drags the *combined* total over the threshold,
which would let a thin rate render as a bare percentage. To close that gap,
the return dict also carries ``"n_by_metric": {"judge_vs_solved": int,
"judge_vs_verify": int}`` — each metric's OWN comparable-pair count — and
``render_markdown`` gates and labels each table row by ITS OWN n from this
dict, not the combined ``n``. (``n_by_metric`` is additive, not a breaking
change to the brief's fixed 3-key contract; callers that only look at
``n``/``agreement``/``insufficient`` are unaffected.) A rate whose own pool is
empty (0 comparable traces) is ``None`` — undefined, never a fabricated
``0.0`` — independent of any gate.

Traces with a ``judge_verdict`` score but NO truth score at all (neither
``solved`` nor ``verify_verdict``) contribute to neither agreement rate and
are excluded from ``n`` — there is nothing to compare them against.
"""
from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

from agentrail.observability.langfuse_client import (
    LangfuseHTTP,
    deterministic_trace_id,
)
from agentrail.observability.score_push import SCORE_NAMES

# Below this many comparable (judge, truth) trace pairs, an agreement rate is
# not rendered as a percentage — "insufficient data" instead. A rate without
# its sample size is exactly the vanity-metric failure mode this report
# exists to prevent.
MIN_SAMPLE_SIZE = 10

# Query page size for GET /api/public/v2/scores — mirrors price_sync.py's
# choice for /api/public/models (keeps the common case a one-page fetch;
# the pagination loop below still handles more pages correctly either way).
_PAGE_LIMIT = 100

# Bump whenever agentrail.observability.score_push.SCORE_NAMES changes shape
# (a name added, renamed, or removed) so a calibration report generated
# against a stale vocabulary is visibly distinguishable, on its own dated
# markdown file, from one generated after the vocabulary changed.
# v2 (#1221 AC2): SCORE_NAMES gained ``gate_passed``.
SCORE_VOCABULARY_VERSION = 2

# Below this many gate-passed reps, the false-green rate (#1221 AC2) is not
# rendered as a percentage — mirrors MIN_SAMPLE_SIZE's no-vanity-metrics gate
# above, applied to this separate (non-agreement) aggregate.
FALSE_GREEN_MIN_SAMPLE_SIZE = 10


def _fetch_scores_by_name(client: LangfuseHTTP, name: str) -> List[dict]:
    """GET every page of ``/api/public/v2/scores`` filtered to one score name.

    Mirrors ``price_sync._fetch_all_models``'s page/limit loop exactly (same
    ``meta.totalPages`` stopping condition) — see the Step 1 PIN above for why
    v2, not v3, is the endpoint this module calls.
    """
    scores: List[dict] = []
    page = 1
    while True:
        resp = client.get_json(
            "/api/public/v2/scores",
            {"name": name, "page": page, "limit": _PAGE_LIMIT},
        )
        data = resp.get("data") or []
        scores.extend(data)
        meta = resp.get("meta") or {}
        total_pages = meta.get("totalPages") or 1
        if not data or page >= total_pages:
            break
        page += 1
    return scores


def _bool_by_trace(scores: Sequence[dict]) -> Dict[str, bool]:
    """Map ``traceId -> bool`` from a list of fetched score rows.

    Drops any row missing a usable string ``traceId``, and any row whose
    ``value`` is not exactly the BOOLEAN 1/0 convention ``score_push.py``
    writes (a stray non-boolean value is a data-shape problem, not a verdict,
    and must never silently become a truth/judge signal here).
    """
    out: Dict[str, bool] = {}
    for row in scores:
        trace_id = row.get("traceId")
        if not isinstance(trace_id, str) or not trace_id:
            continue
        value = row.get("value")
        if value == 1:
            out[trace_id] = True
        elif value == 0:
            out[trace_id] = False
        # anything else (None, a non-boolean number, a string) is not a real
        # boolean verdict -> skip this row entirely.
    return out


def _agreement(judge: Dict[str, bool], truth: Dict[str, bool]) -> Tuple[Optional[float], int]:
    """``(agreement_rate_or_None, n)`` over traces present in BOTH maps.

    ``n`` is the count of traces carrying both a judge verdict and this
    particular truth score. ``None`` (not ``0.0``) when ``n == 0`` — an
    undefined rate must never masquerade as "the judge was always wrong".
    """
    shared = judge.keys() & truth.keys()
    n = len(shared)
    if n == 0:
        return None, 0
    agree = sum(1 for trace_id in shared if judge[trace_id] == truth[trace_id])
    return agree / n, n


# ---------------------------------------------------------------------------
# False-green RATE (issue #1221 AC2) — false_green ÷ gate_passed, aggregated
# from pushed Langfuse scores. NOT an agreement metric (there is no "judge" or
# "truth" being compared here — see the module docstring); a straightforward
# count-based rate, the SAME ratio agentrail.evals.reporter._arm_report already
# computes locally per arm from a single run's in-process records. This
# function answers the same question ACROSS every rep that has ever pushed a
# score, from whatever eval runs pushed scores automatically (AC3) or via a
# manual ``push-scores`` backfill — a Langfuse-queryable aggregate, not just a
# one-run-at-a-time local number.
#
# Why no per-trace join is needed: score_push._eval_scores pushes false_green
# and gate_passed TOGETHER for every real (non-synthetic) eval rep — the two
# fetched populations are the exact same set of reps, so counting each
# name's ``value == 1`` rows independently and dividing is correct; a rep
# that only ever pushed ONE of the two (e.g. an old record from before
# gate_passed existed) is simply absent from the newer population's count,
# which undercounts the denominator honestly rather than joining it to a
# false_green row it was never paired with.
# ---------------------------------------------------------------------------


def false_green_rate(client: LangfuseHTTP) -> dict:
    """Aggregate the eval-harness false-green RATE from Langfuse scores.

    Returns ``{"gate_passed_count": int, "false_green_count": int, "rate":
    float|None, "insufficient": bool}``. ``rate`` is ``None`` — never a
    fabricated ``0.0`` — when ``gate_passed_count == 0`` (undefined
    denominator), matching the None-vs-0.0 discipline
    ``agentrail.evals.reporter.ArmReport.false_green_rate`` already keeps
    locally. ``insufficient`` gates on :data:`FALSE_GREEN_MIN_SAMPLE_SIZE`,
    mirroring :data:`MIN_SAMPLE_SIZE`'s no-vanity-metrics rule for the
    agreement rows above — a thin sample renders "insufficient data" in
    :func:`render_markdown`, never a bare, overconfident percentage.

    Production run records never contribute here: ``score_push.
    _production_scores`` has no ``gate_passed`` field (issue #1221 AC4 —
    production coverage is explicitly deferred to #1222, the private-gate
    issue). This aggregate is eval-corpus-only by construction, not by an
    extra filter.
    """
    gate_passed_rows = _fetch_scores_by_name(client, "gate_passed")
    false_green_rows = _fetch_scores_by_name(client, "false_green")
    gate_passed_count = sum(1 for row in gate_passed_rows if row.get("value") == 1)
    false_green_count = sum(1 for row in false_green_rows if row.get("value") == 1)
    rate = (false_green_count / gate_passed_count) if gate_passed_count else None
    return {
        "gate_passed_count": gate_passed_count,
        "false_green_count": false_green_count,
        "rate": rate,
        "insufficient": gate_passed_count < FALSE_GREEN_MIN_SAMPLE_SIZE,
    }


# ---------------------------------------------------------------------------
# Jace verdict calibration (triage_verdict / qa_verdict vs real run outcomes).
#
# These two scores are SESSION-scoped CATEGORICAL scores pushed by Jace's
# verdict hook (apps/jace/agent/hooks/langfuse-verdict-score.ts): their
# ``traceId`` is null, the verdict label lives in ``stringValue`` (not the
# numeric ``value``), and the ONLY join key back to the factory's per-run
# ground truth is ``metadata.run_id`` — so ``_bool_by_trace`` (which requires
# a ``traceId`` and a 1/0 ``value``) can NOT read them. The factory pushes its
# truth (``solved`` / ``verify_verdict``) TRACE-scoped, keyed by
# ``deterministic_trace_id(run_id)``, so the join is: verdict.metadata.run_id
# -> deterministic_trace_id(run_id) -> the truth row's ``traceId``.
#
# "Reality" (a run passed vs. failed/rejected) is resolved from whichever truth
# the run carries: an accepted ``verify_verdict`` (value 1) or a ``solved`` run
# (value 1) counts as PASSED; a rejected verify (0) / unsolved run (0) counts
# as FAILED. verify_verdict is consulted first (production runs), then solved
# (eval reps); a run carries at most one in practice (see this module's
# docstring / score_push.py's _eval_scores vs _production_scores).
# ---------------------------------------------------------------------------

# Verdict score names read from GET /api/public/v2/scores (Jace's hook writes
# exactly these two CATEGORICAL scores). Kept separate from score_push's
# SCORE_NAMES because those four are BOOLEAN factory/judge scores; these two
# are the coordinator's session-scoped verdicts.
_TRIAGE_SCORE_NAME = "triage_verdict"
_QA_SCORE_NAME = "qa_verdict"

# qa_verdict -> expected run reality. ``not_verifiable`` is deliberately absent:
# it is EXCLUDED from agreement (there is no ground-truth expectation to hold
# it to), never scored as agree or disagree.
_QA_EXPECT_PASS = {"passed": True, "issues_found": False}


def _str_by_run_id(scores: Sequence[dict]) -> Dict[str, str]:
    """Map ``metadata.run_id -> stringValue`` from session-scoped CATEGORICAL
    verdict score rows.

    Unlike :func:`_bool_by_trace`, this reads the CATEGORICAL shape Jace's
    verdict hook writes: the label is in ``stringValue`` (the numeric ``value``
    is null/unused for a categorical score) and the join key is
    ``metadata.run_id`` (``traceId`` is null on a session-scoped score). Any
    row missing a usable string ``run_id`` under ``metadata`` or a usable
    ``stringValue`` is dropped — there is nothing to join or compare. On a
    duplicate ``run_id`` the last row seen wins (a re-run's later verdict
    supersedes an earlier one), matching the iteration order Langfuse returns.
    """
    out: Dict[str, str] = {}
    for row in scores:
        meta = row.get("metadata")
        if not isinstance(meta, dict):
            continue
        run_id = meta.get("run_id")
        # run_id may arrive as a string ("4077") or a JSON number (4077) depending
        # on how the model echoed it into the verdict's structured output. Accept
        # both and normalize to str — deterministic_trace_id() stringifies anyway,
        # so "4077" and 4077 join to the same trace. bool is an int subclass, so
        # reject it explicitly (a True/False run_id is nonsense, not id 1/0).
        if isinstance(run_id, bool) or not isinstance(run_id, (str, int)):
            continue
        run_id = str(run_id).strip()
        if not run_id:
            continue
        value = row.get("stringValue")
        if not isinstance(value, str) or not value:
            continue
        out[run_id] = value
    return out


def _reality_passed(
    run_id: str, solved: Dict[str, bool], verify: Dict[str, bool]
) -> Optional[bool]:
    """Resolve a run's real outcome to ``True`` (passed), ``False``
    (failed/rejected), or ``None`` (no ground truth to compare against).

    Joins the verdict's raw ``run_id`` to the factory's trace-keyed truth via
    ``deterministic_trace_id`` (the exact key score_push.py wrote the truth
    under). verify_verdict (accepted) takes precedence over solved when both
    are somehow present; in practice a run carries at most one.
    """
    trace_id = deterministic_trace_id(run_id)
    if trace_id in verify:
        return verify[trace_id]
    if trace_id in solved:
        return solved[trace_id]
    return None


def _triage_agreement(
    triage_by_run: Dict[str, str],
    solved: Dict[str, bool],
    verify: Dict[str, bool],
) -> dict:
    """triage_verdict (blocked|unblocked) vs. reality.

    ``blocked`` is correct iff the run did NOT pass (verify-rejected /
    terminally failed); ``unblocked`` is correct iff the run passed. Rows whose
    verdict is neither literal, or whose run carries no ground truth, are
    excluded from ``n``. Emits the agreement rate plus the two directional
    error counts the brief asks for: ``false_blocked`` (blocked but the run
    actually passed) and ``false_unblocked`` (unblocked but the run failed).
    """
    n = agree = false_blocked = false_unblocked = 0
    for run_id, verdict in triage_by_run.items():
        if verdict not in ("blocked", "unblocked"):
            continue
        passed = _reality_passed(run_id, solved, verify)
        if passed is None:
            continue
        n += 1
        if verdict == "blocked":
            if not passed:
                agree += 1
            else:
                false_blocked += 1
        else:  # unblocked
            if passed:
                agree += 1
            else:
                false_unblocked += 1
    return {
        "n": n,
        "agreement": (agree / n) if n else None,
        "false_blocked": false_blocked,
        "false_unblocked": false_unblocked,
        "insufficient": n < MIN_SAMPLE_SIZE,
    }


def _qa_agreement(
    qa_by_run: Dict[str, str],
    solved: Dict[str, bool],
    verify: Dict[str, bool],
) -> dict:
    """qa_verdict (passed|issues_found|not_verifiable) vs. reality.

    ``passed`` -> expect the run passed; ``issues_found`` -> expect the run
    failed; ``not_verifiable`` -> EXCLUDED from agreement entirely (counted
    only for the breakdown). Rows whose run carries no ground truth are also
    excluded from ``n``. Returns the agreement rate plus a per-verdict
    breakdown (comparable count + agree count for the scored verdicts, and the
    excluded count for ``not_verifiable``).
    """
    n = agree = 0
    breakdown: Dict[str, Dict[str, int]] = {
        "passed": {"total": 0, "agree": 0},
        "issues_found": {"total": 0, "agree": 0},
        "not_verifiable": {"excluded": 0},
    }
    for run_id, verdict in qa_by_run.items():
        if verdict == "not_verifiable":
            breakdown["not_verifiable"]["excluded"] += 1
            continue
        expect = _QA_EXPECT_PASS.get(verdict)
        if expect is None:
            continue  # unknown verdict label -> nothing to compare
        passed = _reality_passed(run_id, solved, verify)
        if passed is None:
            continue
        cell = breakdown.setdefault(verdict, {"total": 0, "agree": 0})
        cell["total"] += 1
        n += 1
        if passed == expect:
            agree += 1
            cell["agree"] += 1
    return {
        "n": n,
        "agreement": (agree / n) if n else None,
        "breakdown": breakdown,
        "insufficient": n < MIN_SAMPLE_SIZE,
    }


def calibration(client: LangfuseHTTP) -> dict:
    """Fetch judge/truth scores and compute the calibration numbers.

    Returns ``{"n": int, "agreement": {"judge_vs_solved": float|None,
    "judge_vs_verify": float|None}, "insufficient": bool, "n_by_metric":
    {"judge_vs_solved": int, "judge_vs_verify": int}}`` — the first three keys
    are the brief's fixed contract (combined n / combined insufficiency gate);
    ``n_by_metric`` is additive and carries each metric's OWN comparable-pair
    count so the renderer can gate and label each row honestly instead of
    reusing the combined n. See the module docstring for why the combined n
    alone is not sufficient.

    Also additive (never removing the judge keys above): ``"triage"`` and
    ``"qa"`` carry Jace's verdict calibration — see :func:`_triage_agreement`
    and :func:`_qa_agreement`. Each is independently gated by its OWN ``n``
    against :data:`MIN_SAMPLE_SIZE`; zero paired data renders "insufficient
    data", never a vanity rate or a crash.

    Also additive: ``"false_green"`` carries the false-green RATE (issue
    #1221 AC2, :func:`false_green_rate`) — NOT an agreement metric, computed
    independently of the judge/truth fetches above.
    """
    judge = _bool_by_trace(_fetch_scores_by_name(client, "judge_verdict"))
    solved = _bool_by_trace(_fetch_scores_by_name(client, "solved"))
    verify = _bool_by_trace(_fetch_scores_by_name(client, "verify_verdict"))

    rate_solved, n_solved = _agreement(judge, solved)
    rate_verify, n_verify = _agreement(judge, verify)

    # Jace's session-scoped CATEGORICAL verdicts, joined to the SAME factory
    # truth (solved / verify) on run_id. Additive to the judge contract below.
    triage_by_run = _str_by_run_id(_fetch_scores_by_name(client, _TRIAGE_SCORE_NAME))
    qa_by_run = _str_by_run_id(_fetch_scores_by_name(client, _QA_SCORE_NAME))

    n = n_solved + n_verify
    return {
        "n": n,
        "agreement": {
            "judge_vs_solved": rate_solved,
            "judge_vs_verify": rate_verify,
        },
        "insufficient": n < MIN_SAMPLE_SIZE,
        "n_by_metric": {
            "judge_vs_solved": n_solved,
            "judge_vs_verify": n_verify,
        },
        "triage": _triage_agreement(triage_by_run, solved, verify),
        "qa": _qa_agreement(qa_by_run, solved, verify),
        "false_green": false_green_rate(client),
    }


# ---------------------------------------------------------------------------
# Markdown rendering — separate from the fetch/aggregate above and trivially
# testable on a plain dict (no client, no monkeypatching required).
# ---------------------------------------------------------------------------

_LABELS = (
    ("judge_vs_solved", "judge_verdict vs solved"),
    ("judge_vs_verify", "judge_verdict vs verify_verdict"),
)


def _fmt_rate(rate: Optional[float], insufficient: bool) -> str:
    """Render one agreement rate, honoring the no-vanity-metrics gate.

    - ``rate is None`` (no comparable traces at all for this pairing) ->
      "no data" — distinct from both a real 0% and "insufficient data".
    - ``insufficient`` (THIS row's own n below :data:`MIN_SAMPLE_SIZE` — see
      ``render_markdown``, which passes each row's own n here, never the
      combined total) -> "insufficient data" — NEVER a bare percentage,
      regardless of what the raw rate happens to be.
    - otherwise -> the real percentage, one decimal place.
    """
    if rate is None:
        return "no data"
    if insufficient:
        return "insufficient data"
    return f"{rate * 100:.1f}%"


def render_markdown(result: dict, *, generated_at: str) -> str:
    """Render a ``calibration()`` result dict as a markdown report.

    Pure string rendering — no I/O, no client. Every agreement rate line
    carries ITS OWN sample size right next to it — never the other metric's,
    and never the combined total — so a rate is never printed without the
    count it was actually computed from.

    ``result["n_by_metric"]`` (added alongside the brief's fixed 3-key
    contract; see the module docstring) supplies each metric's own n. When
    absent — e.g. a hand-built dict from before this field existed — each row
    falls back to the combined ``n`` so older callers keep working.
    """
    n = result["n"]
    insufficient = result["insufficient"]
    agreement = result["agreement"]
    n_by_metric = result.get("n_by_metric") or {}

    lines: List[str] = []
    lines.append("# Langfuse judge calibration report")
    lines.append("")
    lines.append(f"Generated: {generated_at}")
    lines.append("")
    lines.append(
        f"Score vocabulary: v{SCORE_VOCABULARY_VERSION} "
        f"({', '.join(SCORE_NAMES)})"
    )
    lines.append("")
    lines.append(
        "Compares the optional shadow-judge score (`judge_verdict`, pushed via "
        "`agentrail langfuse push-scores --judge`) against the ground truth "
        "each traced run actually carries (`solved` for eval reps, "
        "`verify_verdict` for production runs). A rate below "
        f"n={MIN_SAMPLE_SIZE} renders as **insufficient data**, never a bare "
        "percentage — gated on EACH row's own sample size, not the combined "
        "total below."
    )
    lines.append("")
    lines.append(f"Total comparable (judge, truth) trace pairs: n={n}")
    lines.append("")
    lines.append("## Agreement")
    lines.append("")
    lines.append("| Comparison | Agreement | n |")
    lines.append("| --- | ---: | ---: |")
    for key, label in _LABELS:
        rate = agreement[key]
        row_n = n_by_metric.get(key, n)
        row_insufficient = row_n < MIN_SAMPLE_SIZE
        lines.append(f"| {label} | {_fmt_rate(rate, row_insufficient)} | n={row_n} |")
    lines.append("")
    if insufficient:
        lines.append(
            f"_Insufficient data: only {n} comparable trace pair(s) so far "
            f"(need >= {MIN_SAMPLE_SIZE}). Push more judge verdicts via "
            "`agentrail langfuse push-scores --judge` before trusting either "
            "rate above._"
        )
        lines.append("")

    _render_triage(lines, result.get("triage"))
    _render_qa(lines, result.get("qa"))
    _render_false_green(lines, result.get("false_green"))

    return "\n".join(lines)


def _render_triage(lines: List[str], triage: Optional[dict]) -> None:
    """Append the triage_verdict-vs-reality section (no-op when absent, so
    old-shape ``result`` dicts without a ``"triage"`` key render unchanged)."""
    if triage is None:
        return
    n = triage["n"]
    insufficient = triage["insufficient"]
    lines.append("## Jace triage verdict vs reality")
    lines.append("")
    lines.append(
        "`triage_verdict` (session-scoped, joined on `metadata.run_id`) vs. the "
        "run's real outcome: **blocked** is correct when the run was "
        "verify-rejected / terminally failed, **unblocked** when it passed."
    )
    lines.append("")
    lines.append("| Comparison | Agreement | n |")
    lines.append("| --- | ---: | ---: |")
    lines.append(
        f"| triage_verdict vs reality | {_fmt_rate(triage['agreement'], insufficient)} "
        f"| n={n} |"
    )
    lines.append("")
    lines.append(f"- false_blocked (blocked, but the run passed): {triage['false_blocked']}")
    lines.append(
        f"- false_unblocked (unblocked, but the run failed): {triage['false_unblocked']}"
    )
    lines.append("")
    if insufficient:
        lines.append(
            f"_Insufficient data: only {n} comparable run pair(s) "
            f"(need >= {MIN_SAMPLE_SIZE})._"
        )
        lines.append("")


def _render_qa(lines: List[str], qa: Optional[dict]) -> None:
    """Append the qa_verdict-vs-reality section (no-op when absent)."""
    if qa is None:
        return
    n = qa["n"]
    insufficient = qa["insufficient"]
    breakdown = qa.get("breakdown") or {}
    lines.append("## Jace QA verdict vs reality")
    lines.append("")
    lines.append(
        "`qa_verdict` vs. the run's real outcome: **passed** expects a passing "
        "run, **issues_found** a failing one; **not_verifiable** is excluded "
        "from agreement entirely."
    )
    lines.append("")
    lines.append("| Comparison | Agreement | n |")
    lines.append("| --- | ---: | ---: |")
    lines.append(
        f"| qa_verdict vs reality | {_fmt_rate(qa['agreement'], insufficient)} | n={n} |"
    )
    lines.append("")
    lines.append("Per-verdict breakdown:")
    lines.append("")
    lines.append("| Verdict | Comparable | Agree |")
    lines.append("| --- | ---: | ---: |")
    for label in ("passed", "issues_found"):
        cell = breakdown.get(label) or {"total": 0, "agree": 0}
        lines.append(f"| {label} | {cell.get('total', 0)} | {cell.get('agree', 0)} |")
    excluded = (breakdown.get("not_verifiable") or {}).get("excluded", 0)
    lines.append(f"| not_verifiable (excluded) | {excluded} | n/a |")
    lines.append("")
    if insufficient:
        lines.append(
            f"_Insufficient data: only {n} comparable run pair(s) "
            f"(need >= {MIN_SAMPLE_SIZE})._"
        )
        lines.append("")


def _render_false_green(lines: List[str], false_green: Optional[dict]) -> None:
    """Append the false-green RATE section (#1221 AC2). No-op when absent, so
    old-shape ``result`` dicts without a ``"false_green"`` key render
    unchanged (same convention as ``_render_triage``/``_render_qa``)."""
    if false_green is None:
        return
    gate_passed_count = false_green["gate_passed_count"]
    false_green_count = false_green["false_green_count"]
    rate = false_green["rate"]
    insufficient = false_green["insufficient"]
    lines.append("## False-green rate (eval harness, all pushed reps)")
    lines.append("")
    lines.append(
        "`false_green ÷ gate_passed`, aggregated from every `false_green`/"
        "`gate_passed` score pair Langfuse has ever received (issue #1221 "
        "AC2) — NOT an agreement metric (see `agreement` above); the same "
        "ratio `agentrail.evals.reporter` computes per arm for one run, here "
        "aggregated across every eval run that pushed scores. Production-run "
        "coverage is explicitly out of scope (#1221 AC4 — deferred to "
        "#1222, the private-gate issue): a production run record never "
        "carries a `gate_passed` score, so it can never appear here."
    )
    lines.append("")
    lines.append("| Rate | Gate-passed reps | False-green reps |")
    lines.append("| ---: | ---: | ---: |")
    rate_cell = _fmt_rate(rate, insufficient)
    lines.append(f"| {rate_cell} | n={gate_passed_count} | {false_green_count} |")
    lines.append("")
    if insufficient:
        lines.append(
            f"_Insufficient data: only {gate_passed_count} gate-passed rep(s) "
            f"with a pushed score so far (need >= {FALSE_GREEN_MIN_SAMPLE_SIZE})._"
        )
        lines.append("")


def default_reports_dir() -> Path:
    """Same committed reports directory the eval reporter writes into
    (``agentrail/evals/reports/``) — calibration reports are dated markdown
    files living alongside eval reports, distinguished by filename prefix."""
    return Path(__file__).resolve().parent.parent / "evals" / "reports"


def write_markdown_report(
    result: dict, *, reports_dir: Optional[Path] = None, date: str
) -> Path:
    """Render and write a dated markdown report; return the written path.

    File name is ``calibration-<date>.md`` (mirrors
    ``evals/reporter.py``'s ``eval-report-<date>.md`` convention) so
    calibration reports are auditable in git and ordered chronologically.
    """
    base = Path(reports_dir) if reports_dir is not None else default_reports_dir()
    base.mkdir(parents=True, exist_ok=True)
    path = base / f"calibration-{date}.md"
    path.write_text(render_markdown(result, generated_at=date), encoding="utf-8")
    return path
