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
# Standalone verify check — what .agentrail/verify.sh execs.
# ---------------------------------------------------------------------------

def decide(changed: Sequence[str]) -> tuple[int, str]:
    """Decide the standalone verify verdict for a known change set (pure).

    Returns ``(exit_code, message)``:
      * test files changed → ``(0, "")`` sentinel meaning "run the tests",
      * no test, source changed → ``(1, red message)``,
      * no test, only docs/config changed → ``(0, green message)``,
      * nothing changed at all → ``(1, red message)``.
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
