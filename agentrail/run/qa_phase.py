"""The QA phase — an opt-in, runner-side runtime check that runs AFTER the
Objective Gate has already passed (#1148).

Where it sits
-------------
The factory's in-run gates are *objective* — they prove the change compiles, the
Red-Green Proof holds, and the changed tests pass. None of them exercises the
change the way a user would: boot the app, click through it, confirm nothing
throws in the browser. A PR can be green on every objective signal and still ship
a blank page. The QA phase closes that gap by executing a repo-authored harness
(``.agentrail/qa.sh``) against a running build and turning its verdict into a
review gate + a PR comment.

Design constraints (all load-bearing)
-------------------------------------
* **Opt-in, default OFF.** Gated on :func:`qa_enabled` (``AGENTRAIL_QA == "1"``),
  modelled on ``jit_gather_enabled`` rather than ``layer_enabled`` — the latter
  *defaults ON* and so cannot express a default-OFF phase. When the flag is unset
  the pipeline never calls into this module at all, so a run is byte-identical to
  today (AC3).
* **Only runs when it can prove something.** Two cheap pre-filters short-circuit
  to a recorded *skip* rather than an execution: no ``.agentrail/qa.sh`` in the
  target repo, or a change-set that touches no UI/runtime surface
  (:func:`is_ui_runtime_change`). A skip is NOT a gate row and never reds a run.
* **Fails safe.** The harness runs under :func:`run_with_timeout`, which tees
  combined output to a log file and returns ``124`` after killing the process on
  timeout. A hung browser or a crashing harness therefore becomes a *failed* QA
  verdict with the captured tail — never a wedged run and never a raise (AC4).
* **Evidence is bounded.** The log tail is passed through :func:`bound_evidence`
  (tail 200 lines → secret-scrub → 16 KB cap) before it can leave the machine.

The module is pure orchestration: it takes the change-set as an argument (the
pipeline computes it from the git adapter; tests pass a list), so every branch —
skip, pass, timeout, crash — is unit-testable by faking
:func:`run_with_timeout`.
"""
from __future__ import annotations

import os
import shlex
from dataclasses import dataclass, field
from fnmatch import fnmatch
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence

from agentrail.run.evidence import bound_evidence
from agentrail.run.proc import run_with_timeout

# --- Flag + config -----------------------------------------------------------

QA_ENV = "AGENTRAIL_QA"
QA_TIMEOUT_ENV = "AGENTRAIL_QA_TIMEOUT"
# A cold Next.js boot + a couple of page assertions fits comfortably in 3 min;
# operators can raise it via AGENTRAIL_QA_TIMEOUT for a heavier harness.
DEFAULT_QA_TIMEOUT = 180
QA_SCRIPT_RELPATH = (".agentrail", "qa.sh")

# UI / runtime surfaces a browser/runtime harness can actually exercise.
# Deliberately NARROW for v1 (front-end + rendered app routes) — widened from
# data, not guessed. A change touching NONE of these is recorded as a skip rather
# than executed, so QA never boots a browser for a pure back-end/docs change it
# could not verify anyway. Matched against repo-relative paths with the same
# fnmatch semantics the proof-required policy uses.
UI_RUNTIME_GLOBS: tuple[str, ...] = (
    "*.tsx",
    "*.jsx",
    "*.css",
    "*.scss",
    "*.html",
    "apps/console/**",
    "apps/**/app/**",
    "apps/**/components/**",
)


def qa_enabled() -> bool:
    """True iff the QA phase is switched on (``AGENTRAIL_QA == "1"``).

    Default OFF. Modelled on ``jit_gather_enabled`` — NOT ``layer_enabled``,
    which defaults ON and cannot express an opt-in phase.
    """
    return (os.environ.get(QA_ENV) or "").strip() == "1"


def qa_timeout() -> int:
    """Wall-clock ceiling for the harness, in seconds.

    ``AGENTRAIL_QA_TIMEOUT`` overrides :data:`DEFAULT_QA_TIMEOUT`; a non-numeric
    or non-positive override is ignored (falls back to the default).
    """
    raw = (os.environ.get(QA_TIMEOUT_ENV) or "").strip()
    if raw:
        try:
            val = int(raw)
        except ValueError:
            val = 0
        if val > 0:
            return val
    return DEFAULT_QA_TIMEOUT


def qa_script_path(target_dir: Path) -> Path:
    """Path to the repo-authored QA harness, ``<target>/.agentrail/qa.sh``."""
    return target_dir.joinpath(*QA_SCRIPT_RELPATH)


def _matches_any(path: str, patterns: Sequence[str]) -> bool:
    """True iff *path* matches any glob in *patterns*.

    Mirrors ``proof_required._matches_any``: ``fnmatch`` does not treat ``/``
    specially, so ``**/x`` also matches a top-level ``x`` and a directory-less
    pattern matches by basename.
    """
    base = path.rsplit("/", 1)[-1]
    for pat in patterns:
        if fnmatch(path, pat):
            return True
        if pat.startswith("**/") and fnmatch(path, pat[3:]):
            return True
        if "/" not in pat and fnmatch(base, pat):
            return True
    return False


def is_ui_runtime_change(changed_files: Iterable[str]) -> bool:
    """True iff any changed path is a UI/runtime surface QA can exercise."""
    return any(_matches_any(p, UI_RUNTIME_GLOBS) for p in changed_files if p)


# --- Result ------------------------------------------------------------------


@dataclass
class QaResult:
    """Outcome of the QA phase.

    ``verdict`` is one of ``passed`` / ``failed`` / ``skipped``. Only ``failed``
    reds the run and posts a gate row; ``skipped`` is recorded but never gates.
    ``exit_code`` is the harness exit status (``124`` == timeout) or ``None`` for
    a skip. ``findings`` / ``evidence_refs`` use the console review-gate vocab.
    """

    verdict: str
    reason: str = ""
    exit_code: Optional[int] = None
    artifacts_dir: Optional[str] = None
    artifact_names: List[str] = field(default_factory=list)
    log_tail: str = ""
    findings: List[Dict[str, str]] = field(default_factory=list)
    evidence_refs: List[Dict[str, str]] = field(default_factory=list)

    @property
    def is_red(self) -> bool:
        return self.verdict == "failed"

    @property
    def is_skip(self) -> bool:
        return self.verdict == "skipped"

    @property
    def is_pass(self) -> bool:
        return self.verdict == "passed"

    def to_json(self) -> Dict[str, object]:
        """Serialise for ``run.json['qa']`` (camelCase, matching sibling blocks)."""
        return {
            "verdict": self.verdict,
            "reason": self.reason,
            "exitCode": self.exit_code,
            "artifactsDir": self.artifacts_dir,
            "artifactNames": self.artifact_names,
            "logTail": self.log_tail,
            "findings": self.findings,
            "evidenceRefs": self.evidence_refs,
        }


def _skip(reason: str) -> QaResult:
    return QaResult(verdict="skipped", reason=reason)


def _list_artifacts(artifacts_dir: Path) -> List[str]:
    """Basenames of files the harness wrote (screenshots, notes) — never paths,
    so nothing runner-local leaks downstream."""
    try:
        return sorted(p.name for p in artifacts_dir.iterdir() if p.is_file())
    except OSError:
        return []


def run_qa_phase(
    target_dir: Path,
    run_dir: Path,
    *,
    changed_files: Sequence[str],
    timeout: Optional[int] = None,
) -> QaResult:
    """Run ``.agentrail/qa.sh`` against the change, or record why it was skipped.

    Control flow:
      1. no ``.agentrail/qa.sh``        → skipped (nothing to run)
      2. change touches no UI/runtime   → skipped (nothing QA can verify)
      3. otherwise                      → exec the harness under a timeout and
         map its exit code: ``0`` → passed, ``124`` → failed (timed out), any
         other non-zero → failed (exit N).

    Never raises for an ordinary harness failure, and fails SAFE on
    timeout/crash. The harness contract is ``qa.sh <artifacts_dir>`` — exit 0
    passes, any non-zero fails — mirroring ``.agentrail/verify.sh``.
    """
    script = qa_script_path(target_dir)
    if not script.exists():
        return _skip("no .agentrail/qa.sh in target repo")

    if not is_ui_runtime_change(changed_files):
        return _skip("change-set touches no UI/runtime surface")

    qa_dir = run_dir / "qa"
    artifacts_dir = qa_dir / "artifacts"
    artifacts_dir.mkdir(parents=True, exist_ok=True)
    log_file = qa_dir / "qa.log"

    limit = timeout if timeout is not None else qa_timeout()

    # `qa.sh <artifacts_dir>` — run through the shell so a repo can write the
    # harness as a normal shell script. run_with_timeout tees combined output to
    # log_file and returns 124 after killing the process on timeout, so a hung
    # browser can never wedge the run (AC4).
    argv = ["bash", "-lc", f".agentrail/qa.sh {shlex.quote(str(artifacts_dir))}"]
    exit_code = run_with_timeout(
        argv, cwd=target_dir, timeout=limit, output_file=log_file
    )

    log_tail = ""
    try:
        log_tail = bound_evidence(log_file.read_text(errors="replace"))
    except OSError:
        pass

    artifact_names = _list_artifacts(artifacts_dir)
    artifacts_str = str(artifacts_dir)

    if exit_code == 0:
        return QaResult(
            verdict="passed",
            reason="qa.sh exited 0",
            exit_code=0,
            artifacts_dir=artifacts_str,
            artifact_names=artifact_names,
            log_tail=log_tail,
        )

    # Any non-zero — including 124 (timeout) — is a QA red. Fail-safe: a crash or
    # a timeout becomes a FAILED verdict carrying the captured tail, never a hang.
    if exit_code == 124:
        reason = f"qa.sh timed out after {limit}s"
        category = "blocked"
    else:
        reason = f"qa.sh exited {exit_code}"
        category = "visual"
    finding = {
        "severity": "major",
        "category": category,
        "description": reason,
        "suggested_fix": (
            "Inspect the QA log tail and artifacts, then reproduce locally with "
            "`.agentrail/qa.sh <dir>`."
        ),
    }
    return QaResult(
        verdict="failed",
        reason=reason,
        exit_code=exit_code,
        artifacts_dir=artifacts_str,
        artifact_names=artifact_names,
        log_tail=log_tail,
        findings=[finding],
    )
