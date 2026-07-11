from pathlib import Path
from agentrail.afk import review


def test_classify_returns_flat_advisory_findings(tmp_path: Path):
    f = tmp_path / "review.md"
    f.write_text(
        "BEGIN_REVIEW_FIX_ISSUES_JSON\n"
        '{"fix_issues": ['
        '{"title": "null deref", "severity": "P0", "file": "a.py", "body": "guard it"},'
        '{"title": "naming", "severity": "P3", "file": "b.py", "body": "rename"}'
        '], "memory_suggestions": []}\n'
        "END_REVIEW_FIX_ISSUES_JSON\n"
    )
    outcome = review.classify(f)
    assert outcome is not None
    assert len(outcome.findings) == 2
    assert {x.severity for x in outcome.findings} == {"P0", "P3"}
    assert not hasattr(outcome, "blocking")


def test_is_clean_when_no_findings(tmp_path: Path):
    f = tmp_path / "review.md"
    f.write_text(
        "BEGIN_REVIEW_FIX_ISSUES_JSON\n"
        '{"fix_issues": [], "memory_suggestions": []}\n'
        "END_REVIEW_FIX_ISSUES_JSON\n"
    )
    outcome = review.classify(f)
    assert outcome is not None and outcome.findings == [] and outcome.is_clean
