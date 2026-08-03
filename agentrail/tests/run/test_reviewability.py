from __future__ import annotations

from pathlib import Path

from agentrail.run.reviewability import (
    EnvironmentEvidence,
    ReviewabilityBudget,
    collect_reviewability_evidence,
    evaluate_reviewability,
    make_diff_evidence,
)


def _environment(**overrides: object) -> EnvironmentEvidence:
    values = {
        "package_manager": "pnpm",
        "runtime": "node 22",
        "lockfile_hash": "lock-sha",
        "verification_commands": ("pnpm test",),
        "environment_rung": "sandbox",
        "environment_mismatch": False,
        "runtime_evidence_available": True,
    }
    values.update(overrides)
    return EnvironmentEvidence(**values)  # type: ignore[arg-type]


def _diff(**overrides: object):
    values = {
        "base_sha": "base-123",
        "head_sha": "head-456",
        "changed_files": ("src/index.ts",),
        "additions": 12,
        "deletions": 4,
    }
    values.update(overrides)
    return make_diff_evidence(**values)  # type: ignore[arg-type]


def test_small_change_is_reviewable_when_environment_evidence_is_complete() -> None:
    result = evaluate_reviewability(_diff(), _environment())

    assert result.status == "reviewable"
    assert result.proof_complete is True
    assert result.split_recommended is False


def test_oversized_change_recommends_a_split_without_a_universal_line_claim() -> None:
    result = evaluate_reviewability(
        _diff(changed_files=tuple(f"src/file-{i}.ts" for i in range(4)), additions=80, deletions=30),
        _environment(),
        ReviewabilityBudget(max_changed_files=3, max_changed_lines=100, max_risk_score=3),
    )

    assert result.status == "split_recommended"
    assert result.split_recommended is True
    assert "changed files" in result.reasons[0]
    assert "Split" in result.recommendation


def test_truncated_diff_fails_closed_as_not_testable() -> None:
    result = evaluate_reviewability(
        _diff(truncated=True, omitted_paths=("src/omitted.ts",)), _environment()
    )

    assert result.status == "not_testable"
    assert result.proof_complete is False
    assert "truncated" in " ".join(result.reasons)


def test_sha_mismatch_fails_closed_as_not_testable() -> None:
    result = evaluate_reviewability(
        _diff(expected_head_sha="different-head"), _environment()
    )

    assert result.status == "not_testable"
    assert result.proof_complete is False
    assert "SHA" in " ".join(result.reasons)


def test_environment_mismatch_fails_closed_as_unverifiable() -> None:
    result = evaluate_reviewability(
        _diff(), _environment(environment_mismatch=True)
    )

    assert result.status == "unverifiable"
    assert result.proof_complete is False
    assert "environment" in " ".join(result.reasons)


def test_unavailable_runtime_evidence_is_not_green() -> None:
    result = evaluate_reviewability(
        _diff(), _environment(runtime=None, runtime_evidence_available=False)
    )

    assert result.status == "unverifiable"
    assert result.proof_complete is False
    assert "runtime evidence" in " ".join(result.reasons)


def test_diff_classifies_lockfiles_and_generated_paths_separately() -> None:
    diff = _diff(
        changed_files=(
            "src/index.ts",
            "pnpm-lock.yaml",
            "src/api.generated.ts",
        )
    )

    assert diff.lockfile_paths == ("pnpm-lock.yaml",)
    assert diff.generated_paths == ("src/api.generated.ts",)
    assert diff.hand_edited_source_paths == ("src/index.ts",)
    assert diff.risk_score == 4


def test_collector_records_git_and_environment_fields(tmp_path: Path, monkeypatch) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / ".agentrail").mkdir()
    (repo / ".agentrail" / "config.json").write_text(
        '{"runtime":"node 22"}', encoding="utf-8"
    )
    (repo / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n", encoding="utf-8")
    monkeypatch.chdir(repo)

    import subprocess

    def git(*args: str) -> None:
        subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)

    git("init", "--quiet")
    git("config", "user.email", "test@agentrail.dev")
    git("config", "user.name", "AgentRail Test")
    (repo / "src").mkdir()
    (repo / "src" / "index.ts").write_text("export const answer = 42;\n", encoding="utf-8")
    git("add", "-A")
    git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "base")
    (repo / "src" / "index.ts").write_text(
        "export const answer = 43;\nexport const ready = true;\n", encoding="utf-8"
    )

    evidence = collect_reviewability_evidence(
        repo,
        base_ref="HEAD",
        verification_commands=("pnpm test",),
    )

    assert evidence.diff.base_sha == evidence.diff.head_sha
    assert evidence.diff.changed_files == ("src/index.ts",)
    assert evidence.diff.additions == 2
    assert evidence.environment.package_manager == "pnpm"
    assert evidence.environment.lockfile_hash
    assert evidence.decision.status == "reviewable"
