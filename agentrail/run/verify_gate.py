"""Change-set classification for the Objective Gate (issue #907, sub-issue of #891).

The Red-Green Proof (ADR 0008) requires a *failing-then-passing* acceptance test
for any change that introduces new code behaviour. But a change that legitimately
needs NO new test — docs, config, markdown — has no test to fail-then-pass, so
the gate used to false-red it twice over:

  1. ``.agentrail/verify.sh`` exited 1 with "no changed test files — nothing to
     prove (red)", and
  2. the pipeline's Red-Green Proof *trail* could never be valid (the check goes
     green→green, never red), so :func:`objective_gate.evaluate` refused done.

This module is the **single source of truth** (AC3) that BOTH consumers use, so
they can never drift:

  * ``.agentrail/verify.sh`` execs :func:`main` — the standalone ``verify`` check.
  * ``agentrail/run/pipeline.py`` imports :func:`collect_changed_files` and
    :func:`requires_red_green_proof` to decide whether the trail is required.

The classification is driven entirely by the changed-FILE SET — never by the
agent's discretion (AC3). Anti-false-green is preserved (AC2): any change that
touches Python source still requires a proof in BOTH places.

The change set is the UNION of:
  * committed-on-branch changes — ``git diff merge-base(HEAD, base)..HEAD`` (AFK
    flow, where the agent's work is committed to a feature branch), and
  * uncommitted working-tree changes — tracked diffs + individually-listed
    untracked files (runner flow, where the agent leaves changes uncommitted so
    the gate can see them — see native_runner.py).

Looking at only one of those is the bug that sank the loop's own attempt (#899):
it checked the working tree alone, so a code change COMMITTED to a branch with no
test slipped through as green — a false-green hole in the very gate meant to
prevent false-greens.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import Iterable, List, Optional, Sequence

DEFAULT_BASE_REF = "origin/main"


# ---------------------------------------------------------------------------
# Pure classification — deterministic, unit-tested in isolation.
# ---------------------------------------------------------------------------

def is_test_file(path: str) -> bool:
    """True iff *path* is a Python test file (``test_*.py`` or ``*_test.py``)."""
    if not path.endswith(".py"):
        return False
    base = path.rsplit("/", 1)[-1]
    return base.startswith("test_") or base.endswith("_test.py")


def is_proof_requiring_source(path: str) -> bool:
    """True iff a change to *path* needs a Red-Green Proof in THIS gate.

    The gate proves behaviour via pytest, so the files that *require* a proof are
    Python source files that are not themselves tests. Everything else — docs,
    JSON/TOML/YAML config, markdown, shell, and TS/console code (which has its
    own CI gate) — is outside this gate's pytest proof scope and is legitimately
    test-free here.
    """
    return path.endswith(".py") and not is_test_file(path)


def changed_source_files(changed: Iterable[str]) -> List[str]:
    return sorted({p for p in changed if is_proof_requiring_source(p)})


def changed_test_files(changed: Iterable[str]) -> List[str]:
    return sorted({p for p in changed if is_test_file(p)})


def requires_red_green_proof(changed: Iterable[str]) -> bool:
    """True iff the change touches Python source that must prove itself.

    A docs/config-only change → False (legitimately test-free). Any Python
    source change → True (Red-Green Proof required; ADR 0008 intact).
    """
    return bool(changed_source_files(changed))


def is_test_free_change(changed: Iterable[str]) -> bool:
    """True iff the change is legitimately docs/config-only.

    A change is test-free only when it is NON-EMPTY and touches no
    proof-requiring source. An EMPTY change set is deliberately NOT test-free:
    "nothing was produced" must not waive the Red-Green Proof (it should stay
    red / require the trail), and an unknown change set (e.g. git unavailable)
    falls into the same safe branch.
    """
    changed = list(changed)
    return bool(changed) and not requires_red_green_proof(changed)


# ---------------------------------------------------------------------------
# Change-set collection — thin git I/O.
# ---------------------------------------------------------------------------

def _git(args: Sequence[str], cwd: Path) -> str:
    try:
        proc = subprocess.run(
            ["git", *args], cwd=str(cwd), capture_output=True, text=True, timeout=30
        )
    except Exception:
        return ""
    if proc.returncode != 0:
        return ""
    return proc.stdout or ""


def collect_changed_files(
    repo_dir: Path | str = ".", *, base_ref: Optional[str] = None
) -> List[str]:
    """Return the full set of files this change touches, against the base branch.

    Union of committed-on-branch changes (merge-base..HEAD) and uncommitted
    working-tree changes (tracked diffs + individually-listed untracked files).
    Best-effort: any git failure degrades to whatever could be collected (an
    empty list at worst), never raises.
    """
    cwd = Path(repo_dir)
    base = base_ref or os.environ.get("AGENTRAIL_BASE_REF") or DEFAULT_BASE_REF

    files: set[str] = set()

    # Committed-on-branch changes relative to the merge-base with the base branch.
    merge_base = _git(["merge-base", "HEAD", base], cwd).strip()
    if merge_base:
        committed = _git(["diff", "--name-only", merge_base, "HEAD"], cwd)
        files.update(p for p in committed.splitlines() if p.strip())

    # Tracked working-tree changes (staged + unstaged) vs HEAD.
    tracked = _git(["diff", "--name-only", "HEAD"], cwd)
    files.update(p for p in tracked.splitlines() if p.strip())

    # Untracked files, enumerated one-per-file (git status --porcelain collapses a
    # wholly-new directory to "?? dir/", which would hide the source files inside).
    untracked = _git(["ls-files", "--others", "--exclude-standard"], cwd)
    files.update(p for p in untracked.splitlines() if p.strip())

    return sorted(files)


# ---------------------------------------------------------------------------
# Standalone verify check — what .agentrail/verify.sh execs.
# ---------------------------------------------------------------------------

def decide(changed: Sequence[str]) -> tuple[int, str]:
    """Decide the standalone verify verdict for a known change set (pure).

    Returns ``(exit_code, message)``:
      * test files changed → ``(0, "")`` sentinel meaning "run the tests" (the
        caller runs pytest and uses its exit code instead),
      * no test, Python source changed → ``(1, red message)``,
      * no test, only docs/config changed → ``(0, green message)``,
      * nothing changed at all → ``(1, red message)``.

    The "run the tests" case is signalled with an empty message so :func:`main`
    knows to hand off to pytest rather than exit directly.
    """
    test_files = changed_test_files(changed)
    if test_files:
        return 0, ""  # caller runs pytest on these
    source_files = changed_source_files(changed)
    if source_files:
        return 1, (
            "verify: Python source changed but no acceptance test added — "
            "Red-Green Proof required (red):\n  " + "\n  ".join(source_files)
        )
    if not changed:
        return 1, (
            "verify: no changes detected — a run that produced nothing has "
            "nothing to prove (red)"
        )
    return 0, (
        "verify: docs/config-only change — no Python source touched, "
        "legitimately test-free (green)"
    )


def main(argv: Optional[Sequence[str]] = None) -> int:
    """The ``verify`` objective check. Collect the change set, then:

    test files changed → run them with pytest (the Red-Green Proof); otherwise
    green for a docs/config-only change, red for source-without-test or no-op.
    """
    # The ingestion env makes the ``*_push`` "not linked" tests false-fail under
    # the runner, so strip it (mirrors the old verify.sh).
    for var in (
        "AGENTRAIL_SERVER_BASE_URL",
        "AGENTRAIL_SERVER_API_KEY",
        "AGENTRAIL_SERVER_REPOSITORY_ID",
    ):
        os.environ.pop(var, None)

    changed = collect_changed_files(".")
    test_files = changed_test_files(changed)
    if test_files:
        print("verify: running changed tests:", file=sys.stderr)
        for t in test_files:
            print(f"  {t}", file=sys.stderr)
        return subprocess.call(
            [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", *test_files]
        )

    exit_code, message = decide(changed)
    if message:
        print(message, file=sys.stderr)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
