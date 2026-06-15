"""
AC5 tests for issue #709 — AFK execute-phase diff preference steering.

Three sub-cases:
  (a) steering text is present in the execute-phase prompt
  (b) outputTokensSaved accounting is correct for a diff edit
  (c) full-rewrite / new-file path records 0 saved without error
"""
from __future__ import annotations

import pytest

# ---------------------------------------------------------------------------
# (a) Steering text is present in issue_run_phase_prompt("execute", …)
# ---------------------------------------------------------------------------


def test_execute_prompt_has_diff_preference_text():
    from agentrail.run.prompts import issue_run_phase_prompt

    prompt = issue_run_phase_prompt(
        "execute",
        123,
        issue_context="Issue: add a feature",
        base_prompt="base ralph instructions",
        context_summary="context summary",
    )
    # Both keywords must appear — the preference and the exception path.
    assert "unified diff" in prompt, "execute prompt must mention 'unified diff'"
    assert "patch" in prompt, "execute prompt must mention 'patch'"
    assert "full rewrite" in prompt or "full-file rewrite" in prompt, (
        "execute prompt must mention when a full rewrite is acceptable"
    )


def test_plan_prompt_does_not_gain_diff_text():
    """The diff-preference clause must NOT appear in the plan phase."""
    from agentrail.run.prompts import issue_run_phase_prompt

    prompt = issue_run_phase_prompt(
        "plan",
        123,
        issue_context="Issue: add a feature",
        base_prompt="base ralph instructions",
        context_summary="context summary",
    )
    assert "unified diff" not in prompt


# ---------------------------------------------------------------------------
# (b) outputTokensSaved accounting is correct for a diff edit
# ---------------------------------------------------------------------------


def test_estimate_output_savings_diff_edit():
    from agentrail.afk.diff_savings import estimate_output_savings

    # Modified file: 200 full-rewrite tokens, 40 actual diff tokens → saved = 160
    entries = [
        {
            "file": "src/foo.py",
            "status": "M",
            "est_full_rewrite_tokens": 200,
            "actual_diff_tokens": 40,
        }
    ]
    result = estimate_output_savings(entries, "claude-sonnet-4-5")

    assert result["outputTokensSaved"] == 160
    # Dollar saving must be positive and match manual calculation:
    # 160 tokens × $15.00 / 1_000_000 = $0.0024
    expected_dollars = 160 * 15.00 / 1_000_000
    assert abs(result["outputDollarsSaved"] - expected_dollars) < 1e-10
    assert result["estimate"] is False
    assert result["model"] == "claude-sonnet-4-5"
    assert result["outputRatePerMtok"] == 15.00

    # Per-file detail must be auditable.
    assert len(result["perFile"]) == 1
    pf = result["perFile"][0]
    assert pf["file"] == "src/foo.py"
    assert pf["outputTokensSaved"] == 160


def test_estimate_output_savings_multiple_files():
    from agentrail.afk.diff_savings import estimate_output_savings

    entries = [
        {"file": "a.py", "status": "M", "est_full_rewrite_tokens": 100, "actual_diff_tokens": 30},
        {"file": "b.py", "status": "M", "est_full_rewrite_tokens": 50, "actual_diff_tokens": 10},
    ]
    result = estimate_output_savings(entries, "claude-sonnet-4-5")

    assert result["outputTokensSaved"] == 110  # 70 + 40
    assert result["outputDollarsSaved"] == pytest.approx(110 * 15.0 / 1_000_000)


def test_estimate_output_savings_unknown_model_is_flagged():
    """Unknown model must set estimate=True and still return a dollar figure."""
    from agentrail.afk.diff_savings import estimate_output_savings

    entries = [
        {"file": "x.py", "status": "M", "est_full_rewrite_tokens": 100, "actual_diff_tokens": 10},
    ]
    result = estimate_output_savings(entries, "some-unknown-model-xyz")

    assert result["estimate"] is True
    assert result["outputTokensSaved"] == 90
    assert result["outputDollarsSaved"] > 0  # fallback rate applied


# ---------------------------------------------------------------------------
# (c) Full-rewrite / new-file path records 0 saved, no error
# ---------------------------------------------------------------------------


def test_estimate_output_savings_new_file_zero():
    """New files (status A) must record outputTokensSaved == 0, no error."""
    from agentrail.afk.diff_savings import estimate_output_savings

    entries = [
        {
            "file": "new_module.py",
            "status": "A",
            "est_full_rewrite_tokens": 0,
            "actual_diff_tokens": 0,
        }
    ]
    result = estimate_output_savings(entries, "claude-sonnet-4-5")

    assert result["outputTokensSaved"] == 0
    assert result["outputDollarsSaved"] == 0.0
    assert result["perFile"][0]["outputTokensSaved"] == 0


def test_estimate_output_savings_rename_zero():
    """Renamed files (status R) must record 0 saved."""
    from agentrail.afk.diff_savings import estimate_output_savings

    entries = [{"file": "renamed.py", "status": "R", "est_full_rewrite_tokens": 0, "actual_diff_tokens": 0}]
    result = estimate_output_savings(entries, "claude-sonnet-4-5")

    assert result["outputTokensSaved"] == 0
    assert result["outputDollarsSaved"] == 0.0


def test_estimate_output_savings_large_diff_clamped_to_zero():
    """When actual_diff_tokens > est_full_rewrite_tokens, savings is 0 (not negative)."""
    from agentrail.afk.diff_savings import estimate_output_savings

    entries = [
        {
            "file": "big_diff.py",
            "status": "M",
            "est_full_rewrite_tokens": 10,
            "actual_diff_tokens": 200,  # diff larger than the file — clamp
        }
    ]
    result = estimate_output_savings(entries, "claude-sonnet-4-5")

    assert result["outputTokensSaved"] == 0
    assert result["outputDollarsSaved"] == 0.0


def test_estimate_output_savings_empty_entries():
    """Empty entry list must return zeros without error."""
    from agentrail.afk.diff_savings import estimate_output_savings

    result = estimate_output_savings([], "claude-sonnet-4-5")

    assert result["outputTokensSaved"] == 0
    assert result["outputDollarsSaved"] == 0.0
    assert result["perFile"] == []


def test_estimate_output_savings_mixed_files():
    """Mixed A/M entries: only M files contribute savings."""
    from agentrail.afk.diff_savings import estimate_output_savings

    entries = [
        {"file": "new.py", "status": "A", "est_full_rewrite_tokens": 500, "actual_diff_tokens": 0},
        {"file": "existing.py", "status": "M", "est_full_rewrite_tokens": 100, "actual_diff_tokens": 25},
    ]
    result = estimate_output_savings(entries, "claude-sonnet-4-5")

    assert result["outputTokensSaved"] == 75  # only from the M file
    pf_by_file = {p["file"]: p for p in result["perFile"]}
    assert pf_by_file["new.py"]["outputTokensSaved"] == 0
    assert pf_by_file["existing.py"]["outputTokensSaved"] == 75


# ---------------------------------------------------------------------------
# collect_worktree_diff — unit tests via subprocess mocking
# ---------------------------------------------------------------------------


def test_collect_worktree_diff_empty_on_no_commits(tmp_path):
    """When git diff returns non-zero or empty, collect_worktree_diff returns []."""
    from unittest.mock import patch, MagicMock
    from agentrail.afk.diff_savings import collect_worktree_diff

    mock_result = MagicMock()
    mock_result.returncode = 1
    mock_result.stdout = ""
    with patch("subprocess.run", return_value=mock_result):
        entries = collect_worktree_diff(tmp_path, "main")
    assert entries == []


def test_collect_worktree_diff_classifies_modified(tmp_path):
    """Modified files must produce entries with full/diff token counts."""
    from unittest.mock import patch, MagicMock, call
    from agentrail.afk.diff_savings import collect_worktree_diff

    # Create the file so read_text succeeds.
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "foo.py").write_text("x = 1\n" * 20)  # 20 lines

    def fake_run(args, **kwargs):
        m = MagicMock()
        if "--name-status" in args:
            m.returncode = 0
            m.stdout = "M\tsrc/foo.py\n"
        else:
            m.returncode = 0
            m.stdout = "@@ -1,20 +1,21 @@\n" + "+y = 2\n" + " x = 1\n" * 20
        return m

    with patch("subprocess.run", side_effect=fake_run):
        entries = collect_worktree_diff(tmp_path, "main")

    assert len(entries) == 1
    e = entries[0]
    assert e["status"] == "M"
    assert e["file"] == "src/foo.py"
    assert e["est_full_rewrite_tokens"] > 0
    assert e["actual_diff_tokens"] > 0


def test_collect_worktree_diff_classifies_new_file(tmp_path):
    """Added files (status A) must be classified with zeros for token counts."""
    from unittest.mock import patch, MagicMock
    from agentrail.afk.diff_savings import collect_worktree_diff

    def fake_run(args, **kwargs):
        m = MagicMock()
        m.returncode = 0
        m.stdout = "A\tnew_file.py\n"
        return m

    with patch("subprocess.run", side_effect=fake_run):
        entries = collect_worktree_diff(tmp_path, "main")

    assert len(entries) == 1
    assert entries[0]["status"] == "A"
    assert entries[0]["est_full_rewrite_tokens"] == 0
    assert entries[0]["actual_diff_tokens"] == 0
