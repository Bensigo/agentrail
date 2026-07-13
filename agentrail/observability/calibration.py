"""Judge calibration report (``agentrail langfuse calibration-report``).

Answers one question honestly: when a shadow judge (``judge_verdict``, pushed
via ``--judge`` in ``score_push.py``) disagrees with the ground truth
(``solved`` for eval reps, ``verify_verdict`` for production runs), how often,
and on how many traces? A calibration number without its sample size is
exactly the vanity-metric failure mode this module exists to prevent — see
``MIN_SAMPLE_SIZE`` below.

Score vocabulary (consumed, not invented): this module reads back exactly the
four names ``agentrail.observability.score_push.SCORE_NAMES`` ever pushes
(``solved``, ``false_green``, ``verify_verdict``, ``judge_verdict``) — see that
module's docstring for the push-side contract. ``false_green`` carries no
truth signal of its own (it is a probe about the Objective Gate, not a
solved/accepted verdict) so it is read for vocabulary bookkeeping only and
never enters an agreement calculation here.

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

Request params used: ``name`` (exactly one of the four SCORE_NAMES per call —
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
``calibration()`` returns exactly ``{"n": int, "agreement": {"judge_vs_solved":
float|None, "judge_vs_verify": float|None}, "insufficient": bool}`` — the
contract fixed by the task brief. Two agreement rates share ONE combined
sample size and ONE insufficiency gate:

    n = (# traces with both a judge_verdict and a solved score)
      + (# traces with both a judge_verdict and a verify_verdict score)

In practice a single trace carries at most one of ``solved``/``verify_verdict``
(an eval rep record never carries ``verify_verdict``; a production run record
never carries ``solved`` — see score_push.py's ``_eval_scores`` /
``_production_scores``), so this sum never double-counts a trace in the data
this module actually ever sees. ``insufficient = n < MIN_SAMPLE_SIZE`` gates
BOTH rates identically in the rendered markdown (never a bare percentage from
either side) — a combined n therefore CAN in principle mask one side having
too few pairs on its own while the other carries the report over the
threshold; nothing in the given interface exposes a per-metric n to fix this
without inventing extra return keys, so this is a known, documented limitation
rather than a silent one. A rate whose own pool is empty (0 comparable traces)
is ``None`` — undefined, never a fabricated ``0.0`` — independent of the
combined gate.

Traces with a ``judge_verdict`` score but NO truth score at all (neither
``solved`` nor ``verify_verdict``) contribute to neither agreement rate and
are excluded from ``n`` — there is nothing to compare them against.
"""
from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

from agentrail.observability.langfuse_client import LangfuseHTTP
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
SCORE_VOCABULARY_VERSION = 1


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


def calibration(client: LangfuseHTTP) -> dict:
    """Fetch judge/truth scores and compute the calibration numbers.

    Returns exactly ``{"n": int, "agreement": {"judge_vs_solved": float|None,
    "judge_vs_verify": float|None}, "insufficient": bool}`` — see the module
    docstring for the combined-n / insufficiency design this shape commits to.
    """
    judge = _bool_by_trace(_fetch_scores_by_name(client, "judge_verdict"))
    solved = _bool_by_trace(_fetch_scores_by_name(client, "solved"))
    verify = _bool_by_trace(_fetch_scores_by_name(client, "verify_verdict"))

    rate_solved, n_solved = _agreement(judge, solved)
    rate_verify, n_verify = _agreement(judge, verify)

    n = n_solved + n_verify
    return {
        "n": n,
        "agreement": {
            "judge_vs_solved": rate_solved,
            "judge_vs_verify": rate_verify,
        },
        "insufficient": n < MIN_SAMPLE_SIZE,
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
    - ``insufficient`` (combined n below :data:`MIN_SAMPLE_SIZE`) ->
      "insufficient data" — NEVER a bare percentage, regardless of what the
      raw rate happens to be.
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
    carries the report's sample size (``n``) right next to it so a rate is
    never printed without the count it was computed from.
    """
    n = result["n"]
    insufficient = result["insufficient"]
    agreement = result["agreement"]

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
        "percentage — see the module docstring for why the two rates below "
        "share one combined sample size."
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
        lines.append(f"| {label} | {_fmt_rate(rate, insufficient)} | n={n} |")
    lines.append("")
    if insufficient:
        lines.append(
            f"_Insufficient data: only {n} comparable trace pair(s) so far "
            f"(need >= {MIN_SAMPLE_SIZE}). Push more judge verdicts via "
            "`agentrail langfuse push-scores --judge` before trusting either "
            "rate above._"
        )
        lines.append("")

    return "\n".join(lines)


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
