"""Tests for agentrail.observability.score_push (agentrail langfuse push-scores).

Fixture JSON records below match the REAL on-disk shapes byte-for-byte
against the production code that writes them (grounded per the
eval-symbol-mismatch rule — no real instance of either record exists
anywhere on this machine; see score_push.py's module docstring for how that
was verified):

  * Production run record  -> agentrail/run/run_record.py:assemble_run_record
    (pinned against agentrail/tests/run/test_run_record.py)
  * Eval rep record         -> agentrail/evals/spine.py:_write_forensics_record
    (pinned against agentrail/tests/evals/test_spine.py, notably
    test_ac1_forensics_record_has_all_fields_for_a_normal_rep — confirms
    eval rep records carry NO run_id field at all)

``LangfuseHTTP._request`` is monkeypatched (mirrors test_price_sync.py's
pattern) so no real network call is made; every scenario asserts the
OBSERVABLE contract: which POST bodies fired and the returned
{"pushed", "skipped"} dict.
"""
from __future__ import annotations

import json

import pytest

from agentrail.observability import langfuse_client as lc
from agentrail.observability import score_push
from agentrail.observability.langfuse_client import deterministic_trace_id


@pytest.fixture
def client():
    return lc.LangfuseHTTP("http://localhost:3000", "pk", "sk")


def _post_spy(monkeypatch):
    calls = []

    def fake_request(method, url, headers, data, timeout):
        assert method == "POST", f"score_push must only POST, got {method}"
        calls.append((url, json.loads(data)))
        return 200, b'{"id": "new-score"}'

    monkeypatch.setattr(lc, "_request", fake_request)
    return calls


def _write(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


# ---------------------------------------------------------------------------
# Fixture builders — real field names, per the module docstring's grounding.
# ---------------------------------------------------------------------------

def _production_record(run_id: str, *, accepted: bool, reason: str = "looks good") -> dict:
    """A (trimmed but field-name-accurate) assemble_run_record() output."""
    return {
        "record_version": 1,
        "source": "production",
        "run_id": run_id,
        "run_dir": f"/tmp/.agentrail/runs/{run_id}",
        "target_type": "issue",
        "issue": 1178,
        "agent": "claude",
        "command": "claude -p --dangerously-skip-permissions",
        "started_at": "2026-07-05T10:00:00Z",
        "finished_at": "2026-07-05T10:20:00Z",
        "attempts": {
            "execution_attempt": 1,
            "max_execution_attempts": 3,
            "failed_verification_attempts": 0,
        },
        "resolved_skills": None,
        "context_pack_file": "context-pack.json",
        "context_retrieval": {"chunks": 5},
        "reads_coverage": None,
        "phases": [
            {
                "name": "verify",
                "status": "completed",
                "exit_status": 0,
                "started_at": "2026-07-05T10:15:00Z",
                "finished_at": "2026-07-05T10:20:00Z",
                "verdict": {"accepted": accepted, "reason": reason},
                "output_file": "verify/output.md",
                "tokens": None,
                "cost_usd": None,
                "model": None,
            }
        ],
        "cost": {"total_usd": None, "events": 0, "unmatched_phases": []},
        "objective_gate": None,
        "review": None,
        "verify_phase_ran": True,
        "verify_verdict": {"accepted": accepted, "reason": reason},
        "blocked_reason": None,
        "verifier_findings_file": None,
        "ci_outcome": None,
        "review_outcome": None,
        "branch": None,
        "diff_path": None,
        "missing": [],
        "assembled_at": "2026-07-05T10:20:01.000Z",
    }


def _eval_record(task: str, arm: str, rep: int, *, solved: bool, false_green: bool = False,
                  synthetic: bool = False) -> dict:
    """A (real field-name-accurate) _write_forensics_record() payload."""
    return {
        "task": task,
        "arm": arm,
        "rep": rep,
        "solved": solved,
        "false_green": false_green,
        "synthetic": synthetic,
        "gate_output": "",
        "verdicts": [],
        "phase_usage": {"execute": {"tokens": 150.0, "cost_usd": 0.01}},
        "diff_path": None,
        "started_at": "2026-07-11T00:00:00Z",
        "finished_at": "2026-07-11T00:05:00Z",
    }


# ---------------------------------------------------------------------------
# (a) production record with a verify verdict -> one POST, dataType BOOLEAN
# ---------------------------------------------------------------------------

def test_production_record_pushes_verify_verdict_score(tmp_path, monkeypatch, client):
    run_id = "20260705-100000-issue-1178-claude-1"
    _write(tmp_path / f"{run_id}.json", _production_record(run_id, accepted=True))

    calls = _post_spy(monkeypatch)
    result = score_push.push_scores(client, tmp_path)

    assert result == {"pushed": 1, "skipped": []}
    assert len(calls) == 1
    url, body = calls[0]
    assert url.endswith("/api/public/scores")
    assert body["name"] == "verify_verdict"
    assert body["value"] == 1  # BOOLEAN convention: 1, not True
    assert body["dataType"] == "BOOLEAN"
    assert body["traceId"] == deterministic_trace_id(run_id)
    assert body["comment"] == "looks good"


def test_production_record_rejected_verdict_encodes_zero(tmp_path, monkeypatch, client):
    run_id = "20260705-100000-issue-1178-claude-2"
    _write(tmp_path / f"{run_id}.json", _production_record(run_id, accepted=False, reason="nope"))

    calls = _post_spy(monkeypatch)
    result = score_push.push_scores(client, tmp_path)

    assert result["pushed"] == 1
    assert calls[0][1]["value"] == 0
    assert calls[0][1]["dataType"] == "BOOLEAN"


# ---------------------------------------------------------------------------
# (b) eval rep record with solved: true -> POSTs for solved + false_green
# ---------------------------------------------------------------------------

def test_eval_record_pushes_solved_and_false_green_scores(tmp_path, monkeypatch, client):
    date_dir = tmp_path / "2026-07-11"
    _write(date_dir / "alpha-task--baseline--rep1.json",
           _eval_record("alpha-task", "baseline", 1, solved=True, false_green=False))

    calls = _post_spy(monkeypatch)
    result = score_push.push_scores(client, date_dir)

    assert result["pushed"] == 2
    assert result["skipped"] == []
    names = {c[1]["name"] for c in calls}
    assert names == {"solved", "false_green"}
    for _url, body in calls:
        assert body["dataType"] == "BOOLEAN"
        if body["name"] == "solved":
            assert body["value"] == 1
        else:
            assert body["value"] == 0
        # every score for this record shares the same trace id
        expected_identity = f"2026-07-11--alpha-task--baseline--rep1"
        assert body["traceId"] == deterministic_trace_id(expected_identity)


# ---------------------------------------------------------------------------
# (c) synthetic eval record -> ALWAYS skipped, reason "synthetic"
# ---------------------------------------------------------------------------

def test_synthetic_eval_record_is_always_skipped(tmp_path, monkeypatch, client):
    date_dir = tmp_path / "2026-07-11"
    _write(date_dir / "beta-task--gather--rep2.json",
           _eval_record("beta-task", "gather", 2, solved=False, synthetic=True))

    calls = _post_spy(monkeypatch)
    result = score_push.push_scores(client, date_dir)

    assert calls == []
    assert result == {
        "pushed": 0,
        "skipped": [{"record": "beta-task--gather--rep2.json", "reason": "synthetic"}],
    }


# ---------------------------------------------------------------------------
# (d) corrupt JSON -> skipped, reason "unparseable"; never crashes the batch
# ---------------------------------------------------------------------------

def test_corrupt_json_is_skipped_and_does_not_block_the_rest(tmp_path, monkeypatch, client):
    (tmp_path / "corrupt.json").write_text("{not valid json!!", encoding="utf-8")
    run_id = "20260705-100000-issue-1178-claude-3"
    _write(tmp_path / f"{run_id}.json", _production_record(run_id, accepted=True))

    calls = _post_spy(monkeypatch)
    result = score_push.push_scores(client, tmp_path)

    assert len(calls) == 1  # the valid record still got processed
    assert result["pushed"] == 1
    assert {"record": "corrupt.json", "reason": "unparseable"} in result["skipped"]


def test_non_dict_json_is_skipped_unparseable(tmp_path, monkeypatch, client):
    (tmp_path / "list.json").write_text("[1, 2, 3]", encoding="utf-8")
    calls = _post_spy(monkeypatch)
    result = score_push.push_scores(client, tmp_path)
    assert calls == []
    assert result == {"pushed": 0, "skipped": [{"record": "list.json", "reason": "unparseable"}]}


# ---------------------------------------------------------------------------
# (e) judge ledger entry keyed by run_id -> adds a judge_verdict score
# ---------------------------------------------------------------------------

def test_judge_ledger_entry_adds_judge_verdict_score(tmp_path, monkeypatch, client):
    # Judge ledger lives OUTSIDE records_dir — a ledger sitting alongside the
    # records it annotates must not itself be swept up by the *.json glob.
    records_dir = tmp_path / "records"
    run_id = "20260705-100000-issue-1178-claude-4"
    _write(records_dir / f"{run_id}.json", _production_record(run_id, accepted=True))
    judge_file = tmp_path / "judge-ledger.json"
    judge_file.write_text(json.dumps({run_id: {"verdict": False, "notes": "judge disagreed"}}),
                           encoding="utf-8")

    calls = _post_spy(monkeypatch)
    result = score_push.push_scores(client, records_dir, judge_file=judge_file)

    assert result["pushed"] == 2
    assert result["skipped"] == []
    names_to_value = {c[1]["name"]: c[1]["value"] for c in calls}
    assert names_to_value == {"verify_verdict": 1, "judge_verdict": 0}
    for _url, body in calls:
        assert body["traceId"] == deterministic_trace_id(run_id)


def test_judge_ledger_entry_keyed_by_eval_identity(tmp_path, monkeypatch, client):
    date_dir = tmp_path / "2026-07-11"
    _write(date_dir / "alpha-task--baseline--rep1.json",
           _eval_record("alpha-task", "baseline", 1, solved=True))
    identity = "2026-07-11--alpha-task--baseline--rep1"
    judge_file = tmp_path / "judge-ledger.json"
    judge_file.write_text(json.dumps({identity: {"verdict": True}}), encoding="utf-8")

    calls = _post_spy(monkeypatch)
    result = score_push.push_scores(client, date_dir, judge_file=judge_file)

    assert result["pushed"] == 3  # solved + false_green + judge_verdict
    names = {c[1]["name"] for c in calls}
    assert names == {"solved", "false_green", "judge_verdict"}


def test_missing_or_malformed_judge_ledger_never_blocks(tmp_path, monkeypatch, client):
    records_dir = tmp_path / "records"
    run_id = "20260705-100000-issue-1178-claude-5"
    _write(records_dir / f"{run_id}.json", _production_record(run_id, accepted=True))
    # Deliberately NOT inside records_dir — a judge ledger sitting alongside
    # the records it annotates must not itself be picked up as a record by
    # push_scores' *.json glob.
    bad_judge_file = tmp_path / "bad-judge.json"
    bad_judge_file.write_text("{not json", encoding="utf-8")

    calls = _post_spy(monkeypatch)
    result = score_push.push_scores(client, records_dir, judge_file=bad_judge_file)

    assert result["pushed"] == 1  # verify_verdict still pushed; judge silently absent
    assert result["skipped"] == []


# ---------------------------------------------------------------------------
# (f) --dry-run posts nothing
# ---------------------------------------------------------------------------

def test_dry_run_posts_nothing_but_reports_would_push(tmp_path, monkeypatch, client):
    run_id = "20260705-100000-issue-1178-claude-6"
    _write(tmp_path / f"{run_id}.json", _production_record(run_id, accepted=True))
    date_dir = tmp_path  # co-locate an eval record too, for breadth
    _write(date_dir / "alpha-task--baseline--rep1.json",
           _eval_record("alpha-task", "baseline", 1, solved=True, false_green=True))

    def fail_on_any_request(*args, **kwargs):
        raise AssertionError("no HTTP request expected under dry_run=True")

    monkeypatch.setattr(lc, "_request", fail_on_any_request)

    result = score_push.push_scores(client, tmp_path, dry_run=True)

    assert result["pushed"] == 3  # 1 verify_verdict + solved + false_green
    assert result["skipped"] == []


# ---------------------------------------------------------------------------
# Fail-closed: missing run_id / missing verdict fields (never crash, always skip)
# ---------------------------------------------------------------------------

def test_record_with_no_identity_is_skipped_missing_run_id(tmp_path, monkeypatch, client):
    _write(tmp_path / "no-identity.json", {"foo": "bar"})
    calls = _post_spy(monkeypatch)
    result = score_push.push_scores(client, tmp_path)
    assert calls == []
    assert result == {
        "pushed": 0,
        "skipped": [{"record": "no-identity.json", "reason": "missing run_id"}],
    }


def test_production_record_with_no_verify_verdict_and_no_judge_is_skipped(tmp_path, monkeypatch, client):
    run_id = "20260705-100000-issue-1178-claude-7"
    record = _production_record(run_id, accepted=True)
    record["verify_verdict"] = None
    record["verify_phase_ran"] = False
    record["phases"] = []
    _write(tmp_path / f"{run_id}.json", record)

    calls = _post_spy(monkeypatch)
    result = score_push.push_scores(client, tmp_path)

    assert calls == []
    assert result == {
        "pushed": 0,
        "skipped": [{"record": f"{run_id}.json", "reason": "missing verdict"}],
    }


# ---------------------------------------------------------------------------
# Everything together: exact skip list across a mixed batch
# ---------------------------------------------------------------------------

def test_mixed_batch_skip_list_is_exact(tmp_path, monkeypatch, client):
    good_run_id = "20260705-100000-issue-1178-claude-8"
    _write(tmp_path / f"{good_run_id}.json", _production_record(good_run_id, accepted=True))
    _write(tmp_path / "corrupt.json", {})  # valid JSON, but empty dict -> no identity
    (tmp_path / "corrupt.json").write_text("not json at all", encoding="utf-8")
    _write(tmp_path / "beta-task--gather--rep2.json",
           _eval_record("beta-task", "gather", 2, solved=False, synthetic=True))
    no_identity_record = {"unrelated": True}
    _write(tmp_path / "unrelated.json", no_identity_record)

    calls = _post_spy(monkeypatch)
    result = score_push.push_scores(client, tmp_path)

    assert result["pushed"] == 1
    assert sorted(result["skipped"], key=lambda d: d["record"]) == sorted(
        [
            {"record": "corrupt.json", "reason": "unparseable"},
            {"record": "beta-task--gather--rep2.json", "reason": "synthetic"},
            {"record": "unrelated.json", "reason": "missing run_id"},
        ],
        key=lambda d: d["record"],
    )
    assert len(calls) == 1
