"""Evidence and policy for reviewable factory changes.

This module records what a reviewer can actually establish about a change. It
does not promise that a pull request under a fixed number of lines is safe: the
reviewability budget is a configurable operational threshold that can recommend
a split or escalation when the change is too large or carries extra risk.

The evaluator is deliberately fail-closed:

* missing, mismatched, or truncated diff evidence is ``not_testable``;
* missing or mismatched runtime evidence is ``unverifiable``;
* neither state is a green proof.

The pure dataclasses are the durable contract. ``collect_reviewability_evidence``
is the small factory-side adapter that gathers best-effort git, manifest, and
verification metadata into that contract.
"""
from __future__ import annotations

import hashlib
import json
import os
from subprocess import run as _run_subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional, Sequence, Tuple


REVIEWABILITY_SCHEMA_VERSION = 2
DEFAULT_MAX_CHANGED_FILES = 40
DEFAULT_MAX_CHANGED_LINES = 800
DEFAULT_MAX_RISK_SCORE = 3
MAX_CAPTURED_PATHS = 1_000

_LOCKFILE_NAMES = {
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "poetry.lock",
    "pdm.lock",
    "uv.lock",
    "Cargo.lock",
    "Gemfile.lock",
    "composer.lock",
    "go.sum",
}


def _as_tuple(values: Iterable[str] = ()) -> Tuple[str, ...]:
    return tuple(sorted({str(value) for value in values if str(value)}))


def _positive_int(value: Any, default: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


@dataclass(frozen=True)
class ReviewabilityBudget:
    """Configurable reviewability threshold, not a universal line guarantee."""

    max_changed_files: int = DEFAULT_MAX_CHANGED_FILES
    max_changed_lines: int = DEFAULT_MAX_CHANGED_LINES
    max_risk_score: int = DEFAULT_MAX_RISK_SCORE

    @classmethod
    def from_mapping(cls, value: Optional[Mapping[str, Any]]) -> "ReviewabilityBudget":
        value = value or {}
        return cls(
            max_changed_files=_positive_int(
                value.get("maxChangedFiles", value.get("max_changed_files")),
                DEFAULT_MAX_CHANGED_FILES,
            ),
            max_changed_lines=_positive_int(
                value.get("maxChangedLines", value.get("max_changed_lines")),
                DEFAULT_MAX_CHANGED_LINES,
            ),
            max_risk_score=_positive_int(
                value.get("maxRiskScore", value.get("max_risk_score")),
                DEFAULT_MAX_RISK_SCORE,
            ),
        )

    def to_dict(self) -> dict[str, int]:
        return {
            "maxChangedFiles": self.max_changed_files,
            "maxChangedLines": self.max_changed_lines,
            "maxRiskScore": self.max_risk_score,
        }


@dataclass(frozen=True)
class DiffEvidence:
    base_sha: str
    head_sha: str
    changed_files: Tuple[str, ...] = ()
    additions: int = 0
    deletions: int = 0
    generated_paths: Tuple[str, ...] = ()
    lockfile_paths: Tuple[str, ...] = ()
    hand_edited_source_paths: Tuple[str, ...] = ()
    omitted_paths: Tuple[str, ...] = ()
    truncated: bool = False
    sha_mismatch: bool = False
    capture_error: Optional[str] = None
    lockfile_additions: int = 0
    lockfile_deletions: int = 0

    @property
    def changed_lines(self) -> int:
        return self.additions + self.deletions

    @property
    def lockfile_changed_lines(self) -> int:
        return self.lockfile_additions + self.lockfile_deletions

    @property
    def non_lockfile_changed_lines(self) -> int:
        return max(0, self.changed_lines - self.lockfile_changed_lines)

    @property
    def non_lockfile_paths(self) -> Tuple[str, ...]:
        return tuple(path for path in self.changed_files if path not in self.lockfile_paths)

    @property
    def non_lockfile_risk_score(self) -> int:
        return max(0, self.risk_score - (2 if self.lockfile_paths else 0))

    @property
    def risk_score(self) -> int:
        score = 0
        if self.generated_paths:
            score += 2
        if self.lockfile_paths:
            score += 2
        if len(self.hand_edited_source_paths) > 20:
            score += 1
        return score

    def to_dict(self) -> dict[str, Any]:
        return {
            "baseSha": self.base_sha,
            "headSha": self.head_sha,
            "changedFiles": list(self.changed_files),
            "additions": self.additions,
            "deletions": self.deletions,
            "changedLines": self.changed_lines,
            "lockfileAdditions": self.lockfile_additions,
            "lockfileDeletions": self.lockfile_deletions,
            "lockfileChangedLines": self.lockfile_changed_lines,
            "nonLockfileChangedLines": self.non_lockfile_changed_lines,
            "nonLockfilePaths": list(self.non_lockfile_paths),
            "generatedPaths": list(self.generated_paths),
            "lockfilePaths": list(self.lockfile_paths),
            "handEditedSourcePaths": list(self.hand_edited_source_paths),
            "omittedPaths": list(self.omitted_paths),
            "truncated": self.truncated,
            "shaMismatch": self.sha_mismatch,
            "captureError": self.capture_error,
            "riskScore": self.risk_score,
        }


@dataclass(frozen=True)
class EnvironmentEvidence:
    package_manager: Optional[str]
    runtime: Optional[str]
    lockfile_hash: Optional[str]
    verification_commands: Tuple[str, ...] = ()
    environment_rung: str = "unknown"
    environment_mismatch: bool = False
    runtime_evidence_available: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "packageManager": self.package_manager,
            "runtime": self.runtime,
            "lockfileHash": self.lockfile_hash,
            "verificationCommands": list(self.verification_commands),
            "environmentRung": self.environment_rung,
            "environmentMismatch": self.environment_mismatch,
            "runtimeEvidenceAvailable": self.runtime_evidence_available,
        }


@dataclass(frozen=True)
class ReviewabilityDecision:
    status: str
    proof_complete: bool
    split_recommended: bool
    reasons: Tuple[str, ...] = ()
    recommendation: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "proofComplete": self.proof_complete,
            "splitRecommended": self.split_recommended,
            "reasons": list(self.reasons),
            "recommendation": self.recommendation,
        }


@dataclass(frozen=True)
class ReviewabilityEvidence:
    diff: DiffEvidence
    environment: EnvironmentEvidence
    budget: ReviewabilityBudget
    decision: ReviewabilityDecision
    schema_version: int = REVIEWABILITY_SCHEMA_VERSION

    def to_dict(self) -> dict[str, Any]:
        return {
            "schemaVersion": self.schema_version,
            "diff": self.diff.to_dict(),
            "environment": self.environment.to_dict(),
            "reviewabilityBudget": self.budget.to_dict(),
            "decision": self.decision.to_dict(),
        }


def _config_mapping(repo_dir: Path) -> Mapping[str, Any]:
    """Read the target's optional reviewability configuration defensively."""
    try:
        value = json.loads(
            (repo_dir / ".agentrail" / "config.json").read_text(encoding="utf-8")
        )
    except (OSError, ValueError, TypeError):
        return {}
    return value if isinstance(value, Mapping) else {}


def reviewability_budget(repo_dir: Path | str) -> ReviewabilityBudget:
    """Resolve the configurable budget without changing the default posture.

    Both the compact top-level ``reviewabilityBudget`` form and the nested
    ``reviewability.budget`` form are accepted so repositories can adopt the
    policy without a config migration.
    """
    config = _config_mapping(Path(repo_dir))
    value = config.get("reviewabilityBudget")
    if not isinstance(value, Mapping):
        reviewability = config.get("reviewability")
        value = reviewability.get("budget") if isinstance(reviewability, Mapping) else None
    return ReviewabilityBudget.from_mapping(value if isinstance(value, Mapping) else None)


def _path_kind(path: str) -> str:
    normalized = path.replace("\\", "/")
    basename = normalized.rsplit("/", 1)[-1]
    if basename in _LOCKFILE_NAMES:
        return "lockfile"
    lowered = normalized.lower()
    if (
        "/generated/" in f"/{lowered}"
        or basename.endswith(".generated.py")
        or ".generated." in basename
        or basename.endswith((".gen.ts", ".gen.tsx", ".gen.js", ".gen.py"))
        or "__generated__" in lowered
        or lowered.startswith(("generated/", "gen/"))
        or lowered.startswith(("dist/", "build/", ".next/", "coverage/"))
    ):
        return "generated"
    return "source"


def _classify_paths(paths: Iterable[str]) -> tuple[Tuple[str, ...], Tuple[str, ...], Tuple[str, ...]]:
    generated: list[str] = []
    lockfiles: list[str] = []
    source: list[str] = []
    for path in paths:
        kind = _path_kind(path)
        if kind == "generated":
            generated.append(path)
        elif kind == "lockfile":
            lockfiles.append(path)
        else:
            source.append(path)
    return _as_tuple(generated), _as_tuple(lockfiles), _as_tuple(source)


def make_diff_evidence(
    *,
    base_sha: str,
    head_sha: str,
    changed_files: Iterable[str] = (),
    additions: int = 0,
    deletions: int = 0,
    expected_head_sha: Optional[str] = None,
    omitted_paths: Iterable[str] = (),
    truncated: bool = False,
    capture_error: Optional[str] = None,
    lockfile_additions: int = 0,
    lockfile_deletions: int = 0,
) -> DiffEvidence:
    paths = _as_tuple(changed_files)
    generated, lockfiles, source = _classify_paths(paths)
    sha_mismatch = bool(expected_head_sha and head_sha and expected_head_sha != head_sha)
    if expected_head_sha and not head_sha:
        sha_mismatch = True
    return DiffEvidence(
        base_sha=base_sha,
        head_sha=head_sha,
        changed_files=paths,
        additions=max(0, int(additions)),
        deletions=max(0, int(deletions)),
        generated_paths=generated,
        lockfile_paths=lockfiles,
        hand_edited_source_paths=source,
        omitted_paths=_as_tuple(omitted_paths),
        truncated=bool(truncated),
        sha_mismatch=sha_mismatch,
        capture_error=capture_error,
        lockfile_additions=max(0, int(lockfile_additions)),
        lockfile_deletions=max(0, int(lockfile_deletions)),
    )


def evaluate_reviewability(
    diff: DiffEvidence,
    environment: EnvironmentEvidence,
    budget: Optional[ReviewabilityBudget] = None,
) -> ReviewabilityDecision:
    """Evaluate whether the evidence supports a reviewable change claim."""
    budget = budget or ReviewabilityBudget()
    reasons: list[str] = []

    if not diff.base_sha or not diff.head_sha:
        reasons.append("base and head SHA evidence is incomplete")
    if diff.sha_mismatch:
        reasons.append("base/head SHA does not match the reviewed change")
    if diff.truncated or diff.omitted_paths:
        reasons.append("the changed-file evidence is truncated or omits paths")
    if diff.capture_error:
        reasons.append(f"diff evidence could not be collected: {diff.capture_error}")
    if reasons:
        return ReviewabilityDecision(
            status="not_testable",
            proof_complete=False,
            split_recommended=False,
            reasons=_as_tuple(reasons),
            recommendation="Re-capture the exact base/head diff before review.",
        )

    if (
        environment.environment_mismatch
        or not environment.runtime_evidence_available
        or not environment.runtime
        or not environment.lockfile_hash
        or not environment.verification_commands
        or environment.environment_rung == "unknown"
    ):
        if environment.environment_mismatch:
            reasons.append("the recorded runtime environment does not match the expected environment")
        if not environment.runtime_evidence_available or not environment.runtime:
            reasons.append("runtime evidence is unavailable")
        if not environment.lockfile_hash:
            reasons.append("lockfile hash evidence is unavailable")
        if not environment.verification_commands:
            reasons.append("no verification commands were recorded")
        if environment.environment_rung == "unknown":
            reasons.append("the factory environment rung is unknown")
        return ReviewabilityDecision(
            status="unverifiable",
            proof_complete=False,
            split_recommended=False,
            reasons=_as_tuple(reasons),
            recommendation="Run the declared verification in a known environment and record its evidence.",
        )

    over_budget: list[str] = []
    if len(diff.non_lockfile_paths) > budget.max_changed_files:
        over_budget.append(
            f"non-lockfile changed files {len(diff.non_lockfile_paths)} exceed budget {budget.max_changed_files}"
        )
    if diff.non_lockfile_changed_lines > budget.max_changed_lines:
        over_budget.append(
            f"non-lockfile changed lines {diff.non_lockfile_changed_lines} exceed budget {budget.max_changed_lines}"
        )
    if diff.non_lockfile_risk_score > budget.max_risk_score:
        over_budget.append(
            f"non-lockfile risk score {diff.non_lockfile_risk_score} exceeds budget {budget.max_risk_score}"
        )
    if over_budget:
        return ReviewabilityDecision(
            status="split_recommended",
            proof_complete=False,
            split_recommended=True,
            reasons=_as_tuple(over_budget),
            recommendation=_split_recommendation(over_budget),
        )

    return ReviewabilityDecision(
        status="reviewable",
        proof_complete=True,
        split_recommended=False,
        recommendation="Evidence is complete within the configured reviewability budget.",
    )


def _split_recommendation(reasons: Sequence[str]) -> str:
    guidance: list[str] = [
        "Split the change into smaller independently verifiable pull requests.",
    ]
    if any("changed files" in reason for reason in reasons):
        guidance.append(
            "Group unrelated files or modules into separate PRs so each slice is reviewable on its own."
        )
    if any("changed lines" in reason for reason in reasons):
        guidance.append("Trim the remaining source edits into smaller chunks.")
    if any("risk score" in reason for reason in reasons):
        guidance.append(
            "Isolate generated, lockfile, or otherwise high-risk churn from hand-edited source changes."
        )
    guidance.append(
        "This recommendation is advisory only; it does not create child issues, queue entries, or mutate code."
    )
    guidance.append("Reasons: " + "; ".join(reasons))
    return " ".join(guidance)


def _git(repo_dir: Path, args: Sequence[str]) -> tuple[str, Optional[str]]:
    try:
        result = _run_subprocess(
            ["git", *args],
            cwd=str(repo_dir),
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except Exception as exc:  # noqa: BLE001 - evidence must fail closed, not crash the run
        return "", str(exc)
    if result.returncode != 0:
        return "", (result.stderr or "git command failed").strip()
    return result.stdout or "", None


def _parse_numstat(output: str) -> tuple[int, int]:
    additions = 0
    deletions = 0
    for line in output.splitlines():
        fields = line.split("\t", 2)
        if len(fields) < 2:
            continue
        try:
            if fields[0] != "-":
                additions += int(fields[0])
            if fields[1] != "-":
                deletions += int(fields[1])
        except ValueError:
            continue
    return additions, deletions


def _read_untracked_numstat(repo_dir: Path, paths: Sequence[str]) -> tuple[int, int, Tuple[str, ...]]:
    additions = 0
    omitted: list[str] = []
    for path in paths:
        file_path = repo_dir / path
        try:
            if file_path.stat().st_size > 2 * 1024 * 1024:
                omitted.append(path)
                continue
            additions += len(file_path.read_text(encoding="utf-8", errors="replace").splitlines())
        except (OSError, UnicodeError):
            omitted.append(path)
    return additions, 0, _as_tuple(omitted)


def collect_diff_evidence(
    repo_dir: Path | str,
    *,
    base_ref: Optional[str] = None,
    expected_head_sha: Optional[str] = None,
) -> DiffEvidence:
    """Collect bounded git evidence for committed and working-tree changes."""
    repo_dir = Path(repo_dir)
    base_ref = base_ref or os.environ.get("AGENTRAIL_BASE_REF") or "origin/main"
    base_sha, base_error = _git(repo_dir, ["merge-base", "HEAD", base_ref])
    # Disposable factory clones are sometimes shallow or do not have a remote
    # named origin/main. HEAD is still a useful, exact baseline for the
    # working-tree diff in that case; only retain an error when the fallback
    # cannot establish a commit either.
    if not base_sha and base_ref != "HEAD":
        fallback_sha, fallback_error = _git(repo_dir, ["rev-parse", "HEAD"])
        if fallback_sha:
            base_sha, base_error = fallback_sha, None
        elif fallback_error:
            base_error = f"base ref {base_ref!r}: {base_error}; fallback: {fallback_error}"
    head_sha, head_error = _git(repo_dir, ["rev-parse", "HEAD"])
    base_sha = base_sha.strip()
    head_sha = head_sha.strip()

    errors = [error for error in (base_error, head_error) if error]
    changed: set[str] = set()
    additions = 0
    deletions = 0
    truncated = False
    omitted: set[str] = set()

    ranges: list[tuple[str, ...]] = []
    if base_sha:
        ranges.append((base_sha, "HEAD"))
    ranges.append(("HEAD",))
    for diff_range in ranges:
        name_args = ["diff", "--name-only", *diff_range]
        names, name_error = _git(repo_dir, name_args)
        if name_error:
            errors.append(name_error)
        changed.update(path.strip() for path in names.splitlines() if path.strip())
        stats, stats_error = _git(repo_dir, ["diff", "--numstat", *diff_range])
        if stats_error:
            errors.append(stats_error)
        add, delete = _parse_numstat(stats)
        additions += add
        deletions += delete

    untracked_output, untracked_error = _git(
        repo_dir, ["ls-files", "--others", "--exclude-standard"]
    )
    if untracked_error:
        errors.append(untracked_error)
    untracked = [path.strip() for path in untracked_output.splitlines() if path.strip()]
    if len(untracked) > MAX_CAPTURED_PATHS:
        truncated = True
        omitted.update(untracked[MAX_CAPTURED_PATHS:])
        untracked = untracked[:MAX_CAPTURED_PATHS]
    changed.update(untracked)
    add, delete, unreadable = _read_untracked_numstat(repo_dir, untracked)
    additions += add
    deletions += delete
    omitted.update(unreadable)
    truncated = truncated or bool(unreadable)

    return make_diff_evidence(
        base_sha=base_sha,
        head_sha=head_sha,
        changed_files=changed,
        additions=additions,
        deletions=deletions,
        expected_head_sha=expected_head_sha,
        omitted_paths=omitted,
        truncated=truncated,
        capture_error="; ".join(dict.fromkeys(errors)) if errors else None,
    )


def _lockfiles(repo_dir: Path) -> list[Path]:
    return sorted(
        path for path in repo_dir.rglob("*")
        if path.is_file() and path.name in _LOCKFILE_NAMES
        and ".git" not in path.parts
    )


def _lockfile_hash(repo_dir: Path) -> Optional[str]:
    files = _lockfiles(repo_dir)
    if not files:
        return None
    digest = hashlib.sha256()
    for path in files:
        try:
            digest.update(str(path.relative_to(repo_dir)).encode("utf-8"))
            digest.update(b"\0")
            digest.update(path.read_bytes())
            digest.update(b"\0")
        except OSError:
            return None
    return digest.hexdigest()


def _package_manager(repo_dir: Path) -> Optional[str]:
    for name, manager in (
        ("pnpm-lock.yaml", "pnpm"),
        ("yarn.lock", "yarn"),
        ("package-lock.json", "npm"),
        ("bun.lock", "bun"),
        ("bun.lockb", "bun"),
        ("poetry.lock", "poetry"),
        ("uv.lock", "uv"),
        ("Cargo.lock", "cargo"),
        ("go.sum", "go"),
    ):
        if (repo_dir / name).is_file():
            return manager
    return None


def _runtime(repo_dir: Path, config: Mapping[str, Any]) -> Optional[str]:
    configured = config.get("runtime")
    if isinstance(configured, str) and configured.strip():
        return configured.strip()
    for name in (".nvmrc", ".node-version", ".python-version"):
        path = repo_dir / name
        if path.is_file():
            value = path.read_text(encoding="utf-8", errors="replace").strip()
            if value:
                return value
    if (repo_dir / "pyproject.toml").is_file() or (repo_dir / "requirements.txt").is_file():
        return f"python {sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    return None


def collect_environment_evidence(
    repo_dir: Path | str,
    *,
    verification_commands: Iterable[str] = (),
    environment_rung: str = "sandbox",
) -> EnvironmentEvidence:
    """Collect manifest/runtime evidence without claiming a preview was run."""
    repo_dir = Path(repo_dir)
    config = _config_mapping(repo_dir)

    package_manager = _package_manager(repo_dir)
    runtime = _runtime(repo_dir, config)
    lockfile_hash = _lockfile_hash(repo_dir)
    commands = _as_tuple(verification_commands)
    expected = config.get("reviewabilityEnvironment")
    if not isinstance(expected, Mapping):
        reviewability = config.get("reviewability")
        expected = reviewability.get("environment") if isinstance(reviewability, Mapping) else {}
    expected = expected if isinstance(expected, Mapping) else {}
    mismatch = any(
        expected_value is not None and expected_value != actual
        for expected_value, actual in (
            (expected.get("packageManager"), package_manager),
            (expected.get("runtime"), runtime),
            (expected.get("lockfileHash"), lockfile_hash),
            (expected.get("environmentRung"), environment_rung),
        )
    )
    return EnvironmentEvidence(
        package_manager=package_manager,
        runtime=runtime,
        lockfile_hash=lockfile_hash,
        verification_commands=commands,
        environment_rung=environment_rung,
        environment_mismatch=mismatch,
        runtime_evidence_available=bool(runtime),
    )


def collect_reviewability_evidence(
    repo_dir: Path | str,
    *,
    verification_commands: Iterable[str] = (),
    base_ref: Optional[str] = None,
    expected_head_sha: Optional[str] = None,
    environment_rung: str = "sandbox",
    budget: Optional[ReviewabilityBudget] = None,
) -> ReviewabilityEvidence:
    budget = budget or reviewability_budget(repo_dir)
    diff = collect_diff_evidence(
        repo_dir, base_ref=base_ref, expected_head_sha=expected_head_sha
    )
    environment = collect_environment_evidence(
        repo_dir,
        verification_commands=verification_commands,
        environment_rung=environment_rung,
    )
    return ReviewabilityEvidence(
        diff=diff,
        environment=environment,
        budget=budget,
        decision=evaluate_reviewability(diff, environment, budget),
    )


__all__ = [
    "DiffEvidence",
    "EnvironmentEvidence",
    "ReviewabilityBudget",
    "ReviewabilityDecision",
    "ReviewabilityEvidence",
    "collect_diff_evidence",
    "collect_environment_evidence",
    "collect_reviewability_evidence",
    "evaluate_reviewability",
    "make_diff_evidence",
]
