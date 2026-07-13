"""Tests for agentrail.observability.calibration (agentrail langfuse
calibration-report).

``LangfuseHTTP._request`` is monkeypatched (mirrors test_price_sync.py's and
test_score_push.py's pattern) so no real network call is made. The fake GET
handler below dispatches on the ``name=`` query parameter — mirroring how
``calibration._fetch_scores_by_name`` makes one full paginated fetch per
score name (``judge_verdict``, ``solved``, ``verify_verdict``).
"""
from __future__ import annotations

import json
from urllib.parse import parse_qs, urlparse

import pytest

from agentrail.observability import calibration
from agentrail.observability import langfuse_client as lc
from agentrail.observability.score_push import SCORE_NAMES


@pytest.fixture
def client():
    return lc.LangfuseHTTP("http://localhost:3000", "pk", "sk")


def _row(trace_id: str, name: str, value: int) -> dict:
    """A (trimmed but field-name-accurate) GET /api/public/v2/scores row —
    see calibration.py's Step 1 PIN for the BaseScore/BooleanScore fields."""
    return {
        "id": f"score-{trace_id}-{name}",
        "traceId": trace_id,
        "name": name,
        "value": value,
        "dataType": "BOOLEAN",
    }


def _paged_response(rows: list) -> bytes:
    return json.dumps({
        "data": rows,
        "meta": {"page": 1, "limit": 100, "totalItems": len(rows), "totalPages": 1},
    }).encode()


def _serve_by_name(monkeypatch, rows_by_name: dict):
    """Route GET /api/public/v2/scores?name=<X> to rows_by_name[<X>] (single
    page each, unless a caller overrides with a real multi-page fixture)."""
    calls = []

    def fake_request(method, url, headers, data, timeout):
        assert method == "GET", f"calibration must only GET scores, got {method}"
        calls.append(url)
        parsed = urlparse(url)
        assert parsed.path == "/api/public/v2/scores", (
            f"expected the v2 scores list endpoint, got {parsed.path}"
        )
        qs = parse_qs(parsed.query)
        name = qs["name"][0]
        rows = rows_by_name.get(name, [])
        return 200, _paged_response(rows)

    monkeypatch.setattr(lc, "_request", fake_request)
    return calls


# ---------------------------------------------------------------------------
# (a) agreement calc with n=4 (judge vs solved, 3/4 agree)
# ---------------------------------------------------------------------------

def test_agreement_calc_judge_vs_solved_n4(monkeypatch, client):
    judge_rows = [
        _row("t1", "judge_verdict", 1),
        _row("t2", "judge_verdict", 1),
        _row("t3", "judge_verdict", 0),
        _row("t4", "judge_verdict", 1),
    ]
    solved_rows = [
        _row("t1", "solved", 1),   # agree
        _row("t2", "solved", 1),   # agree
        _row("t3", "solved", 0),   # agree
        _row("t4", "solved", 0),   # disagree
    ]
    _serve_by_name(monkeypatch, {"judge_verdict": judge_rows, "solved": solved_rows})

    result = calibration.calibration(client)

    assert result["n"] == 4
    assert result["agreement"]["judge_vs_solved"] == pytest.approx(0.75)
    assert result["agreement"]["judge_vs_verify"] is None
    assert result["insufficient"] is True  # 4 < MIN_SAMPLE_SIZE (documented gate)


# ---------------------------------------------------------------------------
# (b) traces with a judge score but no truth score are excluded from n
# ---------------------------------------------------------------------------

def test_judge_only_traces_excluded_from_n(monkeypatch, client):
    judge_rows = [
        _row("t1", "judge_verdict", 1),
        _row("t2", "judge_verdict", 1),
        _row("t-judge-only-a", "judge_verdict", 1),
        _row("t-judge-only-b", "judge_verdict", 0),
    ]
    solved_rows = [
        _row("t1", "solved", 1),
        _row("t2", "solved", 1),
    ]
    _serve_by_name(monkeypatch, {"judge_verdict": judge_rows, "solved": solved_rows})

    result = calibration.calibration(client)

    # Only t1/t2 have BOTH a judge verdict and a truth score; the two
    # judge-only traces contribute to neither the numerator nor n.
    assert result["n"] == 2
    assert result["agreement"]["judge_vs_solved"] == pytest.approx(1.0)


def test_truth_only_traces_excluded_from_n(monkeypatch, client):
    """Symmetric case: a solved/verify score with no judge verdict alongside
    it must not inflate n either — there is no judge opinion to compare."""
    judge_rows = [_row("t1", "judge_verdict", 1)]
    solved_rows = [
        _row("t1", "solved", 1),
        _row("t-no-judge", "solved", 0),
    ]
    _serve_by_name(monkeypatch, {"judge_verdict": judge_rows, "solved": solved_rows})

    result = calibration.calibration(client)

    assert result["n"] == 1
    assert result["agreement"]["judge_vs_solved"] == pytest.approx(1.0)


# ---------------------------------------------------------------------------
# (c) n=2 -> insufficient: true, and the rendered markdown has no percentage
# ---------------------------------------------------------------------------

def test_n2_is_insufficient_and_markdown_has_no_percentage(monkeypatch, client):
    judge_rows = [_row("t1", "judge_verdict", 1), _row("t2", "judge_verdict", 0)]
    solved_rows = [_row("t1", "solved", 1), _row("t2", "solved", 0)]
    _serve_by_name(monkeypatch, {"judge_verdict": judge_rows, "solved": solved_rows})

    result = calibration.calibration(client)
    assert result["n"] == 2
    assert result["insufficient"] is True
    # The rate itself is still computed honestly (both agree -> 1.0) — it is
    # the MARKDOWN that must never print it as a percentage below threshold.
    assert result["agreement"]["judge_vs_solved"] == pytest.approx(1.0)

    md = calibration.render_markdown(result, generated_at="2026-07-13")
    assert "insufficient data" in md
    assert "%" not in md


def test_zero_comparable_pairs_renders_no_data_not_a_percentage():
    result = {
        "n": 0,
        "agreement": {"judge_vs_solved": None, "judge_vs_verify": None},
        "insufficient": True,
    }
    md = calibration.render_markdown(result, generated_at="2026-07-13")
    assert "no data" in md
    assert "%" not in md


# ---------------------------------------------------------------------------
# (d) dated path + score-vocabulary-version check
# ---------------------------------------------------------------------------

def test_write_markdown_report_lands_at_dated_path_with_n_and_vocab_version(tmp_path):
    result = {
        "n": 12,
        "agreement": {"judge_vs_solved": 0.9166666666666666, "judge_vs_verify": None},
        "insufficient": False,
    }

    path = calibration.write_markdown_report(result, reports_dir=tmp_path, date="2026-07-13")

    assert path == tmp_path / "calibration-2026-07-13.md"
    assert path.exists()
    text = path.read_text(encoding="utf-8")
    assert "n=12" in text
    assert f"v{calibration.SCORE_VOCABULARY_VERSION}" in text
    for name in SCORE_NAMES:
        assert name in text
    # Sufficient data (n=12 >= MIN_SAMPLE_SIZE) -> a real percentage renders.
    assert "91.7%" in text


def test_default_reports_dir_matches_evals_reports_directory():
    # Calibration reports are dated markdown files living alongside eval
    # reports (agentrail/evals/reports/), distinguished by filename prefix.
    from agentrail.evals.reporter import default_reports_dir as eval_reports_dir

    assert calibration.default_reports_dir() == eval_reports_dir()


# ---------------------------------------------------------------------------
# Both truth kinds present at once -> combined n, independent rates
# ---------------------------------------------------------------------------

def test_both_judge_vs_solved_and_judge_vs_verify_combine_into_one_n(monkeypatch, client):
    judge_rows = [
        _row("eval-1", "judge_verdict", 1),
        _row("eval-2", "judge_verdict", 1),
        _row("prod-1", "judge_verdict", 0),
        _row("prod-2", "judge_verdict", 1),
        _row("prod-3", "judge_verdict", 1),
    ]
    solved_rows = [
        _row("eval-1", "solved", 1),
        _row("eval-2", "solved", 0),
    ]
    verify_rows = [
        _row("prod-1", "verify_verdict", 0),
        _row("prod-2", "verify_verdict", 1),
        _row("prod-3", "verify_verdict", 0),
    ]
    _serve_by_name(monkeypatch, {
        "judge_verdict": judge_rows, "solved": solved_rows, "verify_verdict": verify_rows,
    })

    result = calibration.calibration(client)

    assert result["n"] == 5  # 2 (eval) + 3 (production)
    assert result["agreement"]["judge_vs_solved"] == pytest.approx(0.5)   # 1 of 2 agree
    assert result["agreement"]["judge_vs_verify"] == pytest.approx(2 / 3)  # 2 of 3 agree


# ---------------------------------------------------------------------------
# Non-boolean / malformed rows are skipped, never crash the fetch
# ---------------------------------------------------------------------------

def test_malformed_rows_are_skipped_not_crashed_on(monkeypatch, client):
    judge_rows = [
        _row("t1", "judge_verdict", 1),
        {"id": "bad-1", "traceId": None, "name": "judge_verdict", "value": 1},  # no traceId
        {"id": "bad-2", "traceId": "t-weird", "name": "judge_verdict", "value": 0.5},  # not 0/1
        {"id": "bad-3", "name": "judge_verdict", "value": 1},  # missing traceId key entirely
    ]
    solved_rows = [_row("t1", "solved", 1)]
    _serve_by_name(monkeypatch, {"judge_verdict": judge_rows, "solved": solved_rows})

    result = calibration.calibration(client)

    assert result["n"] == 1
    assert result["agreement"]["judge_vs_solved"] == pytest.approx(1.0)


# ---------------------------------------------------------------------------
# Pagination plumbing mirrors price_sync._fetch_all_models exactly
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Review-fix regression: a row's OWN n must gate/label it, never the combined
# total — a thin metric must not "borrow" a healthy n from the other metric.
# ---------------------------------------------------------------------------

def test_n_by_metric_present_and_correct_alongside_combined_n(monkeypatch, client):
    """calibration() carries each metric's own n in ``n_by_metric`` in
    addition to (never instead of) the brief's fixed 3-key contract."""
    judge_rows = [
        _row("t1", "judge_verdict", 1),
        _row("t2", "judge_verdict", 1),
        _row("t3", "judge_verdict", 0),
        _row("t4", "judge_verdict", 1),
    ]
    solved_rows = [
        _row("t1", "solved", 1),
        _row("t2", "solved", 1),
        _row("t3", "solved", 0),
        _row("t4", "solved", 0),
    ]
    _serve_by_name(monkeypatch, {"judge_verdict": judge_rows, "solved": solved_rows})

    result = calibration.calibration(client)

    # Brief's fixed contract untouched.
    assert result["n"] == 4
    assert result["agreement"]["judge_vs_solved"] == pytest.approx(0.75)
    assert result["insufficient"] is True
    # Additive field: this metric's own pool is exactly the same 4 pairs here
    # (single-truth-kind scenario), the other metric's own pool is 0.
    assert result["n_by_metric"] == {"judge_vs_solved": 4, "judge_vs_verify": 0}


def test_thin_metric_does_not_borrow_combined_n_from_the_other_metric(monkeypatch, client):
    """Reproduces the exact reported leak: 1 real judge_vs_solved pair
    (100% agreement) + 9 real judge_vs_verify pairs (55.6% agreement).
    Combined n=10 crosses MIN_SAMPLE_SIZE, but judge_vs_solved's OWN pool is
    just 1 pair — it must render as "insufficient data", not a bare "100.0%"
    borrowed from the other metric's healthier n. Drives the real
    fetch -> calibration() -> render_markdown() pipeline end to end, not a
    hand-built dict.
    """
    judge_rows = [_row("eval-1", "judge_verdict", 1)] + [
        _row(f"prod-{i}", "judge_verdict", 1 if i < 5 else 0) for i in range(9)
    ]
    solved_rows = [_row("eval-1", "solved", 1)]
    # 9 verify pairs: judge says True for prod-0..4 (5), False for prod-5..8
    # (4). Truth agrees with judge on the first 5 traces and disagrees on the
    # remaining 4 -> 5/9 = 0.5555... = 55.6% agreement.
    verify_rows = []
    for i in range(9):
        judge_val = 1 if i < 5 else 0
        agree = i < 5
        truth_val = judge_val if agree else (1 - judge_val)
        verify_rows.append(_row(f"prod-{i}", "verify_verdict", truth_val))

    _serve_by_name(monkeypatch, {
        "judge_verdict": judge_rows, "solved": solved_rows, "verify_verdict": verify_rows,
    })

    result = calibration.calibration(client)

    assert result["n"] == 10  # 1 + 9 crosses MIN_SAMPLE_SIZE combined
    assert result["insufficient"] is False  # combined gate says "sufficient"
    assert result["n_by_metric"] == {"judge_vs_solved": 1, "judge_vs_verify": 9}
    assert result["agreement"]["judge_vs_solved"] == pytest.approx(1.0)
    assert result["agreement"]["judge_vs_verify"] == pytest.approx(5 / 9)

    md = calibration.render_markdown(result, generated_at="2026-07-13")

    # The thin metric (n=1) must NEVER render as a bare percentage, even
    # though the combined total says "sufficient".
    solved_line = [l for l in md.splitlines() if l.startswith("| judge_verdict vs solved")][0]
    assert "insufficient data" in solved_line
    assert "100.0%" not in solved_line
    assert "n=1" in solved_line
    # judge_vs_verify's own n (9) is also below MIN_SAMPLE_SIZE (10) on its
    # own -> it must ALSO render as insufficient, not the 55.6% a
    # combined-n-only gate would have shown.
    verify_line = [l for l in md.splitlines() if l.startswith("| judge_verdict vs verify_verdict")][0]
    assert "insufficient data" in verify_line
    assert "55.6%" not in verify_line
    assert "n=9" in verify_line


def test_one_row_sufficient_on_its_own_renders_even_if_other_row_is_thin():
    """Complementary case: a row whose OWN n clears MIN_SAMPLE_SIZE must
    render its real percentage even though the OTHER row's own n is thin —
    per-row gating must not become overly conservative either."""
    result = {
        "n": 18,
        "agreement": {"judge_vs_solved": 0.8, "judge_vs_verify": 0.5},
        "insufficient": False,
        "n_by_metric": {"judge_vs_solved": 15, "judge_vs_verify": 3},
    }
    md = calibration.render_markdown(result, generated_at="2026-07-13")

    solved_line = [l for l in md.splitlines() if l.startswith("| judge_verdict vs solved")][0]
    assert "80.0%" in solved_line
    assert "n=15" in solved_line

    verify_line = [l for l in md.splitlines() if l.startswith("| judge_verdict vs verify_verdict")][0]
    assert "insufficient data" in verify_line
    assert "n=3" in verify_line


def test_render_markdown_falls_back_to_combined_n_when_n_by_metric_absent():
    """Old-shape callers (no ``n_by_metric`` key) keep working: each row
    falls back to the combined n rather than raising."""
    result = {
        "n": 12,
        "agreement": {"judge_vs_solved": 0.9166666666666666, "judge_vs_verify": None},
        "insufficient": False,
    }
    md = calibration.render_markdown(result, generated_at="2026-07-13")
    solved_line = [l for l in md.splitlines() if l.startswith("| judge_verdict vs solved")][0]
    assert "91.7%" in solved_line
    assert "n=12" in solved_line


def test_fetch_scores_by_name_follows_pagination(monkeypatch, client):
    page1 = {
        "data": [_row("t1", "judge_verdict", 1)],
        "meta": {"page": 1, "limit": 1, "totalItems": 2, "totalPages": 2},
    }
    page2 = {
        "data": [_row("t2", "judge_verdict", 0)],
        "meta": {"page": 2, "limit": 1, "totalItems": 2, "totalPages": 2},
    }

    def fake_request(method, url, headers, data, timeout):
        assert method == "GET"
        if "page=1" in url:
            return 200, json.dumps(page1).encode()
        return 200, json.dumps(page2).encode()

    monkeypatch.setattr(lc, "_request", fake_request)

    rows = calibration._fetch_scores_by_name(client, "judge_verdict")
    trace_ids = {r["traceId"] for r in rows}
    assert trace_ids == {"t1", "t2"}


if __name__ == "__main__":
    import unittest
    unittest.main()
