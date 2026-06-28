"""Change-set classification for the Objective Gate — now a thin SHIM (issue #919).

Issue #907 made this module the single source of truth for the Red-Green Proof
classification, but it HARDCODED "Python source" (``path.endswith('.py')``) and
"pytest" (``test_*.py``).  Issue #919 lifts that classification into a
framework-neutral, config-driven guardrail and an adapters boundary:

  * the git I/O that collected the change set moved to
    :mod:`agentrail.guardrails.adapters.git`;
  * the "does this change require a test/proof?" decision moved to the PURE policy
    :mod:`agentrail.guardrails.policies.proof_required`, which reads a
    :class:`~agentrail.guardrails.signals.Signals` plus a
    :class:`~agentrail.guardrails.policies.proof_required.ProofConfig`
    (``source_globs`` / ``test_globs``) — no ``.py``/``pytest`` literal in it.

This module keeps its #907 public API byte-for-byte (``is_test_file``,
``is_proof_requiring_source``, ``changed_source_files``, ``changed_test_files``,
``requires_red_green_proof``, ``is_test_free_change``, ``collect_changed_files``,
``decide``, ``main``) and simply DELEGATES to the policy + git adapter, supplying
:data:`PYTHON_PROOF_CONFIG` — the default Python config that reproduces #907's
exact behaviour.  So:

  * ``.agentrail/verify.sh`` execs :func:`main` (unchanged), and
  * ``agentrail/run/pipeline.py`` imports :func:`collect_changed_files` and
    :func:`is_test_free_change` (unchanged),

both keep working IDENTICALLY, and the #907 tests pass unchanged (AC5).
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import Iterable, List, Optional, Sequence

from agentrail.guardrails.adapters import git as _git_adapter
from agentrail.guardrails.policies import proof_required as _proof
from agentrail.guardrails.policies.proof_required import ProofConfig
from agentrail.guardrails.signals import Signals

# Re-exported for callers that imported it from here (#907).
DEFAULT_BASE_REF = _git_adapter.DEFAULT_BASE_REF

# The default Python config — reproduces #907's hardcoded behaviour exactly.
# Source: any `.py` that is not a test.  Tests: `test_*.py` / `*_test.py`.
# These globs are the ONLY place the Python literals live now; the policy and
# adapters carry none.
PYTHON_PROOF_CONFIG = ProofConfig(
    source_globs=("*.py",),
    test_globs=("test_*.py", "*_test.py"),
)

# --- Wider-tests scope (issue: broaden the Red-Green Proof's pytest target set) ---
#
# By DEFAULT the gate runs ONLY the test files the agent changed (#907/#1012
# behaviour). That misses a change that *breaks an existing, unchanged test*: the
# agent never touches that test, so it never runs, and the gate goes green on a
# regression the hidden answer-key tests would catch.
#
# The "wider" scope additionally executes EXISTING repo tests so such a
# regression reds the gate. This carries a higher risk of red-ing legitimate runs
# (a pre-existing failing/flaky test now counts against the run), so it is
# **flag-gated and default-OFF**: ``changed`` reproduces today's behaviour exactly
# and is a no-op on merge.
#
#   AGENTRAIL_VERIFY_TEST_SCOPE = changed (default) | dirs | repo
#     changed → only the agent's changed test files (current behaviour).
#     dirs    → plus existing tests under the directories the change touched.
#     repo    → plus every existing test in the repo.
#   AGENTRAIL_VERIFY_PYTEST_PATHS = explicit space-separated paths (operator
#     override; REPLACES the computed set entirely, highest precedence).
TEST_SCOPE_ENV = "AGENTRAIL_VERIFY_TEST_SCOPE"
TEST_PATHS_ENV = "AGENTRAIL_VERIFY_PYTEST_PATHS"
DEFAULT_TEST_SCOPE = "changed"

# The directory holding the SEALED hidden answer-key tests. The gate must NEVER
# execute these — doing so leaks the exam. The eval runner already strips them
# from the agent's clone (runner._strip_answer_keys_from_clone); excluding them
# here too is defense-in-depth so no scope can ever reach them even if present.
HIDDEN_TEST_DIRNAME = "answer_key"


# ---------------------------------------------------------------------------
# Pure classification — delegates to the config-driven policy with the Python
# default config, preserving the #907 signatures and semantics.
# ---------------------------------------------------------------------------

def is_test_file(path: str) -> bool:
    """True iff *path* is a Python test file (``test_*.py`` or ``*_test.py``)."""
    return _proof.is_test_path(path, PYTHON_PROOF_CONFIG)


def is_proof_requiring_source(path: str) -> bool:
    """True iff a change to *path* needs a Red-Green Proof in THIS gate.

    Python source files that are not themselves tests (the default Python config);
    docs/config/TS are outside this gate's pytest proof scope and test-free here.
    """
    return _proof.is_proof_requiring_source(path, PYTHON_PROOF_CONFIG)


def changed_source_files(changed: Iterable[str]) -> List[str]:
    return _proof.changed_source_files(changed, PYTHON_PROOF_CONFIG)


def changed_test_files(changed: Iterable[str]) -> List[str]:
    return _proof.changed_test_files(changed, PYTHON_PROOF_CONFIG)


def requires_red_green_proof(changed: Iterable[str]) -> bool:
    """True iff the change touches Python source that must prove itself."""
    return _proof.requires_proof(Signals(changed_files=tuple(changed)), PYTHON_PROOF_CONFIG)


def is_test_free_change(changed: Iterable[str]) -> bool:
    """True iff the change is legitimately docs/config-only.

    Non-empty and touches no proof-requiring source.  An EMPTY change set is
    deliberately NOT test-free (#907).
    """
    return _proof.is_test_free(Signals(changed_files=tuple(changed)), PYTHON_PROOF_CONFIG)


# ---------------------------------------------------------------------------
# Change-set collection — delegates to the git adapter (where the I/O now lives).
# ---------------------------------------------------------------------------

def collect_changed_files(
    repo_dir: Path | str = ".", *, base_ref: Optional[str] = None
) -> List[str]:
    """Return the full set of files this change touches, against the base branch.

    Delegates to :func:`agentrail.guardrails.adapters.git.collect_changed_files`
    (the union of committed-on-branch and uncommitted working-tree changes).
    """
    return _git_adapter.collect_changed_files(repo_dir, base_ref=base_ref)


# ---------------------------------------------------------------------------
# Wider-tests target selection — which pytest files the Red-Green Proof runs.
# Pure selection (testable) is split from impure repo discovery (os.walk).
# ---------------------------------------------------------------------------

def is_hidden_test_path(path: str) -> bool:
    """True iff *path* lives under a sealed answer-key dir (never run by the gate)."""
    return HIDDEN_TEST_DIRNAME in Path(path).parts


def _is_under_changed_dirs(test_path: str, changed: Sequence[str]) -> bool:
    """True iff *test_path*'s dir is, or is nested under, a changed file's dir."""
    test_dir = Path(test_path).parent
    for f in changed:
        changed_dir = Path(f).parent
        if test_dir == changed_dir:
            return True
        try:
            test_dir.relative_to(changed_dir)
            return True
        except ValueError:
            continue
    return False


def select_pytest_targets(
    changed: Sequence[str],
    *,
    scope: str,
    repo_test_files: Sequence[str],
    explicit_paths: Sequence[str] = (),
) -> List[str]:
    """Choose the pytest target set for the Red-Green Proof run (pure).

    Always runs the agent's *changed* test files. Beyond that, *scope* broadens to
    existing repo tests so a change that breaks a pre-existing test reds the gate:

      * ``"changed"`` (default) — only the changed test files (#907/#1012).
      * ``"dirs"`` — plus existing tests under the directories the change touched.
      * ``"repo"`` — plus every existing test in the repo.

    ``explicit_paths`` (AGENTRAIL_VERIFY_PYTEST_PATHS), when given, REPLACES the
    computed set entirely (operator override). Sealed answer-key tests are
    excluded from every path in every mode — the gate never runs the hidden exam.
    Returns a deduped, sorted list.
    """
    if explicit_paths:
        chosen = [p for p in explicit_paths if p and not is_hidden_test_path(p)]
        return sorted(dict.fromkeys(chosen))

    targets = set(changed_test_files(changed))
    norm = (scope or "").strip().lower()
    if norm == "repo":
        targets.update(repo_test_files)
    elif norm == "dirs":
        targets.update(
            t for t in repo_test_files if _is_under_changed_dirs(t, changed)
        )
    # else "changed"/unknown → changed test files only (the default, no widening).

    return sorted(t for t in targets if not is_hidden_test_path(t))


def discover_repo_test_files(repo_dir: Path | str = ".") -> List[str]:
    """Walk *repo_dir* for existing pytest files (impure), skipping VCS/sealed dirs.

    Returns repo-relative POSIX paths of files matching the Python test globs,
    pruning ``.git`` and any ``answer_key`` subtree (the sealed hidden exam) so a
    wider scope can never discover the answer key.
    """
    root = Path(repo_dir)
    found: List[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in {".git", HIDDEN_TEST_DIRNAME}]
        for fn in filenames:
            if is_test_file(fn):
                found.append(Path(dirpath, fn).relative_to(root).as_posix())
    return found


# ---------------------------------------------------------------------------
# Standalone verify check — what .agentrail/verify.sh execs.
# ---------------------------------------------------------------------------

def decide(changed: Sequence[str]) -> tuple[int, str]:
    """Decide the standalone verify verdict for a known change set (pure).

    Returns ``(exit_code, message)``:
      * source changed AND a test changed → ``(0, "")`` sentinel meaning "run the
        tests" (the Red-Green Proof: the authored test must prove the source),
      * test(s) changed but NO proof-requiring source changed → ``(1, red
        message)`` (a test-only diff has no source under proof — running the
        agent's own test in isolation is a false-green vector; ADR 0008),
      * no test, source changed → ``(1, red message)``,
      * no test, only docs/config changed → ``(0, green message)``,
      * nothing changed at all → ``(1, red message)``.
    """
    test_files = changed_test_files(changed)
    source_files = changed_source_files(changed)
    if test_files:
        if source_files:
            return 0, ""  # caller runs pytest on these — source proves itself
        # Test files but no proof-requiring source: the run produced only a test
        # (or test + docs/config). There is nothing for the test to prove, so
        # running it in isolation cannot establish a Red-Green Proof — it would
        # greenlight a self-confirming test that implements no real code. Red.
        return 1, (
            "verify: only test files changed (no Python source under proof) — a "
            "test that proves no source is not a Red-Green Proof (red):\n  "
            + "\n  ".join(test_files)
        )
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
    exit_code, message = decide(changed)
    # decide() returns the (0, "") "run the tests" sentinel ONLY when a test
    # file changed AND proof-requiring source changed (the Red-Green Proof). A
    # test-only diff now reds in decide() and never reaches pytest — closing the
    # false-green where running the agent's own self-confirming test went green.
    if exit_code == 0 and not message:
        scope = os.environ.get(TEST_SCOPE_ENV, DEFAULT_TEST_SCOPE)
        explicit_paths = os.environ.get(TEST_PATHS_ENV, "").split()
        # Only walk the repo when a wider scope or an explicit override actually
        # needs the existing-test set — the default ``changed`` scope does not.
        norm = (scope or "").strip().lower()
        repo_test_files = (
            discover_repo_test_files(".")
            if not explicit_paths and norm in {"dirs", "repo"}
            else []
        )
        test_files = select_pytest_targets(
            changed,
            scope=scope,
            repo_test_files=repo_test_files,
            explicit_paths=explicit_paths,
        )
        if not test_files:
            # Defensive: decide() only returns this sentinel when a changed test
            # exists, so the set is non-empty in practice. If a filter ever empties
            # it, red rather than pass an empty pytest invocation (which exits 0).
            print(
                "verify: no runnable test targets after scope selection (red)",
                file=sys.stderr,
            )
            return 1
        print(f"verify: running tests (scope={norm or DEFAULT_TEST_SCOPE}):", file=sys.stderr)
        for t in test_files:
            print(f"  {t}", file=sys.stderr)
        return subprocess.call(
            [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", *test_files]
        )

    if message:
        print(message, file=sys.stderr)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
