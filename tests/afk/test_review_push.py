"""Tests for agentrail.afk.review_push — push_review_gate.

Coverage:
- Correct payload mapping (id, run_id, gate_name, status, blocking_reasons, repository_id).
- Not linked (no server.json) → returns False, no HTTP call made.
- HTTP error → returns False, never raises (non-fatal).
- "passed" status when no blocking findings.
- "failed" status when blocking findings present.
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

from agentrail.afk import review_push
from agentrail.afk.review import Finding, ReviewOutcome


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_server_json(tmp_path: Path, base_url: str = "http://localhost:3000",
                       api_key: str = "ar_test", repository_id: str = "repo-abc") -> None:
    d = tmp_path / ".agentrail"
    d.mkdir(parents=True, exist_ok=True)
    (d / "server.json").write_text(json.dumps({
        "base_url": base_url,
        "api_key": api_key,
        "repository_id": repository_id,
    }))


def _make_outcome(blocking=(), advisory=()) -> ReviewOutcome:
    return ReviewOutcome(
        blocking=list(blocking),
        advisory=list(advisory),
        memory_suggestions=[],
    )


def _finding(title="Bug", severity="P0", file="foo.py", body="fix it") -> Finding:
    return Finding(title=title, severity=severity, file=file, body=body)


class FakeResp:
    status = 202
    def __enter__(self): return self
    def __exit__(self, *a): return False


# ---------------------------------------------------------------------------
# Not linked
# ---------------------------------------------------------------------------


def test_push_returns_false_when_not_linked(tmp_path: Path, monkeypatch) -> None:
    """No server.json and no env vars → load_link returns None → returns False, no HTTP."""
    # Clear any server env vars so load_link has nothing to fall back to
    for key in ("AGENTRAIL_SERVER_BASE_URL", "AGENTRAIL_SERVER_API_KEY",
                "AGENTRAIL_SERVER_REPOSITORY_ID"):
        monkeypatch.delenv(key, raising=False)

    captured = []

    def fake_urlopen(req, timeout):
        captured.append(req)
        return FakeResp()

    monkeypatch.setattr(review_push.urllib.request, "urlopen", fake_urlopen)
    result = review_push.push_review_gate(tmp_path, "run-id", 1, _make_outcome())
    assert result is False
    assert not captured


# ---------------------------------------------------------------------------
# Payload mapping
# ---------------------------------------------------------------------------


def test_push_payload_fields(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path, base_url="http://localhost:4000",
                       api_key="key-abc", repository_id="repo-xyz")
    captured: dict = {}

    def fake_urlopen(req, timeout):
        captured["url"] = req.full_url
        captured["auth"] = req.get_header("Authorization")
        captured["body"] = json.loads(req.data)
        return FakeResp()

    monkeypatch.setattr(review_push.urllib.request, "urlopen", fake_urlopen)

    run_id = "run-000"
    round_no = 3
    finding = _finding(title="Null deref", severity="P0", file="main.py", body="check it")
    outcome = _make_outcome(blocking=[finding])

    result = review_push.push_review_gate(tmp_path, run_id, round_no, outcome)

    assert result is True
    assert captured["url"] == "http://localhost:4000/api/v1/ingest/review-gates"
    assert captured["auth"] == "Bearer key-abc"
    body = captured["body"]
    assert body["run_id"] == run_id
    assert body["repository_id"] == "repo-xyz"
    assert body["gate_name"] == f"review-round-{round_no}"
    assert body["status"] == "failed"
    assert len(body["blocking_reasons"]) == 1
    assert body["blocking_reasons"][0]["title"] == "Null deref"
    assert body["blocking_reasons"][0]["severity"] == "P0"
    assert body["blocking_reasons"][0]["file"] == "main.py"
    assert body["blocking_reasons"][0]["body"] == "check it"
    assert "evaluated_at" in body
    # id is uuid5 of review-gate:<run_id>:<round_no>
    expected_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"review-gate:{run_id}:{round_no}"))
    assert body["id"] == expected_id


def test_push_status_passed_when_no_blocking(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)
    captured: dict = {}

    def fake_urlopen(req, timeout):
        captured["body"] = json.loads(req.data)
        return FakeResp()

    monkeypatch.setattr(review_push.urllib.request, "urlopen", fake_urlopen)

    advisory_finding = _finding(severity="P2")
    outcome = _make_outcome(advisory=[advisory_finding])
    review_push.push_review_gate(tmp_path, "run-1", 1, outcome)

    assert captured["body"]["status"] == "passed"
    assert captured["body"]["blocking_reasons"] == []


def test_push_status_failed_when_blocking(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)
    captured: dict = {}

    def fake_urlopen(req, timeout):
        captured["body"] = json.loads(req.data)
        return FakeResp()

    monkeypatch.setattr(review_push.urllib.request, "urlopen", fake_urlopen)

    outcome = _make_outcome(blocking=[_finding(severity="P1")])
    review_push.push_review_gate(tmp_path, "run-2", 1, outcome)

    assert captured["body"]["status"] == "failed"
    assert len(captured["body"]["blocking_reasons"]) == 1


# ---------------------------------------------------------------------------
# Non-fatal
# ---------------------------------------------------------------------------


def test_push_returns_false_on_http_error(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)

    def boom(req, timeout):
        raise OSError("network down")

    monkeypatch.setattr(review_push.urllib.request, "urlopen", boom)
    result = review_push.push_review_gate(tmp_path, "run-3", 1, _make_outcome())
    assert result is False  # never raises


def test_push_id_is_deterministic(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)
    ids: list = []

    def fake_urlopen(req, timeout):
        ids.append(json.loads(req.data)["id"])
        return FakeResp()

    monkeypatch.setattr(review_push.urllib.request, "urlopen", fake_urlopen)

    run_id = "stable-run"
    round_no = 2
    review_push.push_review_gate(tmp_path, run_id, round_no, _make_outcome())
    review_push.push_review_gate(tmp_path, run_id, round_no, _make_outcome())

    assert len(ids) == 2
    assert ids[0] == ids[1]


def test_push_id_differs_by_round(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)
    ids: list = []

    def fake_urlopen(req, timeout):
        ids.append(json.loads(req.data)["id"])
        return FakeResp()

    monkeypatch.setattr(review_push.urllib.request, "urlopen", fake_urlopen)

    review_push.push_review_gate(tmp_path, "run-x", 1, _make_outcome())
    review_push.push_review_gate(tmp_path, "run-x", 2, _make_outcome())

    assert ids[0] != ids[1]


# ---------------------------------------------------------------------------
# parse_findings — structured JSON review
# ---------------------------------------------------------------------------


STRUCTURED_REVIEW = """\
# Review of PR #42

Looked at the diff; two real problems and one nit.

BEGIN_REVIEW_FIX_ISSUES_JSON
{
  "fix_issues": [
    {"title": "Null deref on missing config", "severity": "P1",
     "file": "app/main.py", "body": "Guard cfg before cfg.get() or it crashes on fresh installs."},
    {"title": "Race in cache write", "severity": "P2",
     "file": "app/cache.py", "body": "Take the lock before writing the shared dict."},
    {"title": "Typo in log message", "severity": "P3",
     "file": null, "body": "s/recieved/received/"}
  ],
  "memory_suggestions": []
}
END_REVIEW_FIX_ISSUES_JSON
"""


def test_parse_findings_structured_json() -> None:
    findings = review_push.parse_findings(STRUCTURED_REVIEW)
    assert len(findings) == 3

    assert findings[0]["severity"] == "critical"  # P1 → critical
    assert "Null deref on missing config" in findings[0]["description"]
    assert "app/main.py" in findings[0]["description"]
    assert findings[0]["suggested_fix"] == (
        "Guard cfg before cfg.get() or it crashes on fresh installs."
    )

    assert findings[1]["severity"] == "major"     # P2 → major
    assert findings[2]["severity"] == "minor"     # P3 → minor
    assert findings[2]["suggested_fix"] == "s/recieved/received/"


def test_parse_findings_p0_and_unknown_severity() -> None:
    text = (
        "BEGIN_REVIEW_FIX_ISSUES_JSON\n"
        '{"fix_issues": [{"title": "Boom", "severity": "P0", "body": "fix"},'
        ' {"title": "Meh", "severity": "wat", "body": ""}],'
        ' "memory_suggestions": []}\n'
        "END_REVIEW_FIX_ISSUES_JSON\n"
    )
    findings = review_push.parse_findings(text)
    assert findings[0]["severity"] == "critical"  # P0 → critical
    assert findings[1]["severity"] == "minor"     # other → minor
    assert findings[1]["suggested_fix"] == "Meh"  # falls back to title


def test_parse_findings_structured_empty_fix_issues_is_clean() -> None:
    text = (
        "All good.\n"
        "BEGIN_REVIEW_FIX_ISSUES_JSON\n"
        '{"fix_issues": [], "memory_suggestions": []}\n'
        "END_REVIEW_FIX_ISSUES_JSON\n"
    )
    assert review_push.parse_findings(text) == []


# ---------------------------------------------------------------------------
# parse_findings — messy prose review (fallback)
# ---------------------------------------------------------------------------


MESSY_PROSE_REVIEW = """\
Review notes (no machine block, agent went off-script):

This PR has a blocking problem. P1: the retry loop in worker.py never
backs off, so a flaky upstream hammers the API until the rate limiter
bans us. Must fix before merge.
"""


def test_parse_findings_prose_fallback_single_finding() -> None:
    findings = review_push.parse_findings(MESSY_PROSE_REVIEW)
    assert len(findings) == 1
    f = findings[0]
    assert f["severity"] == "critical"
    assert "retry loop in worker.py" in f["description"]
    assert f["suggested_fix"]  # non-empty how-to-fix text


def test_parse_findings_prose_fallback_truncates_long_text() -> None:
    long_text = "blocking problem: " + "x" * 5000
    findings = review_push.parse_findings(long_text)
    assert len(findings) == 1
    assert len(findings[0]["description"]) <= 1001  # limit + ellipsis


# ---------------------------------------------------------------------------
# parse_findings — clean pass (empty)
# ---------------------------------------------------------------------------


def test_parse_findings_empty_text() -> None:
    assert review_push.parse_findings("") == []
    assert review_push.parse_findings("   \n  ") == []


def test_parse_findings_clean_prose_pass() -> None:
    text = "Reviewed the diff carefully. No blocking issues found. LGTM."
    assert review_push.parse_findings(text) == []


# ---------------------------------------------------------------------------
# push_review_gate includes parsed findings
# ---------------------------------------------------------------------------


def test_push_includes_findings_from_review_text(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)
    captured: dict = {}

    def fake_urlopen(req, timeout):
        captured["body"] = json.loads(req.data)
        return FakeResp()

    monkeypatch.setattr(review_push.urllib.request, "urlopen", fake_urlopen)

    outcome = _make_outcome(blocking=[_finding(severity="P1")])
    review_push.push_review_gate(tmp_path, "run-f", 1, outcome,
                                 review_text=STRUCTURED_REVIEW)

    findings = captured["body"]["findings"]
    assert len(findings) == 3
    assert findings[0]["severity"] == "critical"
    assert {"severity", "description", "suggested_fix"} <= set(findings[0])


def test_push_findings_default_empty(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)
    captured: dict = {}

    def fake_urlopen(req, timeout):
        captured["body"] = json.loads(req.data)
        return FakeResp()

    monkeypatch.setattr(review_push.urllib.request, "urlopen", fake_urlopen)

    review_push.push_review_gate(tmp_path, "run-g", 1, _make_outcome())
    assert captured["body"]["findings"] == []
