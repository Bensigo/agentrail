"""Production :class:`HiddenTestRunner` — apply the agent's diff at the task's
pinned commit and execute the hidden tests in a sandboxed workspace (issue #952).

The spine's seam (``agentrail.evals.spine.HiddenTestRunner``) was wired in
#938 with :class:`UnimplementedHiddenTestRunner` as the honest no-op default —
returning ``False`` for every run so no false-green could leak. This module
ships the engine that replaces it: a real bool, computed by running the answer
key against the agent's produced diff in a workspace that the agent never saw.

## Position in the eval spine

::

    runner.run -> RunRecord(diff, ...)
                       |
                       v
           ProductionHiddenTestRunner.run_hidden_tests(task, run_record) -> bool
                       |
                       v
                  scorer.score -> Verdict

The runner has already torn down the agent's tempdir before this is called.
The hidden-test workspace is materialized HERE, separate from any path the
agent could have touched.

## What this module does in one run

1. **Materialize a fresh, isolated workspace**: ``git clone --local`` the host
   repository (the parent repo this CLI ships in) into a unique tempdir under
   ``$TMPDIR``, then ``git checkout <task.commit>`` so the workspace matches
   the task's pinned commit byte-for-byte.

   The workspace is in ``$TMPDIR`` with a unique prefix; the agent's run
   workdir, also in ``$TMPDIR`` with a *different* prefix, is gone by the time
   we are called. The two paths never overlap by construction (AC2).

2. **Apply the agent's diff** via ``git apply``. The diff lives ON the
   ``RunRecord`` (the spine's only handoff). If it is empty (the production
   ``SandboxAgentExecutor`` currently emits ``diff=""`` — flagged as a #952
   follow-up), the workspace is the unmodified pinned-commit checkout and the
   hidden tests run against that. For most tasks, that produces ``False`` (the
   solution isn't there); AC3 expects exactly that.

3. **Copy the hidden test files** from ``<task_dir>/<hidden_tests.root>/<file>``
   into the workspace at ``tests/_eval_hidden/<file>``. We pick a path that:

   - lives UNDER the workspace's ``tests/`` tree so pytest's default rootdir +
     conftest discovery just work,
   - lives at a path the agent could not have produced (so a "did the agent
     ship an answer-key file?" check is a no-op here — it could only ever fail
     by us putting one there, which is what we want),
   - is namespaced ``_eval_hidden`` so it never collides with a real test path.

   Each file is copied byte-for-byte. We do NOT modify the agent's working
   tree (the agent has already finished and its workdir is gone).

4. **Execute pytest with a wall-clock timeout** (AC4) in the workspace via
   ``subprocess.run(..., timeout=...)``. We use ``sys.executable -m pytest``
   so the same Python interpreter that's running the spine runs the tests —
   stays in lockstep with the rest of the harness. The default timeout is
   short by design: hidden tests are unit-test-sized; a runaway loop or a
   network call that hangs should fail closed, never block the spine.

5. **Return a real ``bool``**: ``True`` iff every hidden test passed (pytest
   exit code 0), ``False`` on:
   - any exception during materialize/apply/copy/execute,
   - pytest non-zero exit (failures, errors, collection errors, segfault),
   - timeout (``subprocess.TimeoutExpired``),
   - the answer-key files not resolving on disk.

   The runner NEVER raises into the spine; the contract is fail-closed.

## What this module does NOT do

- It does NOT touch the agent's run workdir. The agent has already finished
  and its workdir was destroyed by ``agentrail.evals.runner.run``'s
  ``finally`` block; we work in our OWN workspace.
- It does NOT mutate the ``RunRecord``. The record is the only handoff; it is
  pure data and we never write to it.
- It does NOT use the docker sandbox. Hidden-test execution is fast,
  CPU-bound, and only needs filesystem isolation (a tempdir) plus a wall
  clock. Pulling in docker would slow the spine and add a moving part.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from agentrail.evals.corpus.loader import CorpusTask
from agentrail.evals.run_record import RunRecord

logger = logging.getLogger(__name__)


# Default wall-clock timeout for hidden-test execution. The hidden tests are
# unit-test-sized; anything beyond a couple of minutes is a runaway and must
# fail closed. AC4: never hang the spine.
DEFAULT_TIMEOUT_S = 120.0

# The path inside the workspace where we drop the hidden tests. Namespaced so
# it cannot collide with a real test path the agent might have shipped, and
# lives under tests/ so pytest's default rootdir + conftest discovery work.
HIDDEN_TESTS_SUBPATH = Path("tests") / "_eval_hidden"


# ---------------------------------------------------------------------------
# Repo-root discovery — find the host repo whose objects we'll clone.
# ---------------------------------------------------------------------------


def _default_repo_root() -> Path:
    """Walk up from THIS module to the nearest directory containing ``.git``.

    The corpus is bundled inside this repo (``agentrail/evals/corpus/...``) and
    the pinned commit is a commit in this repo's history. So the host repo's
    own ``.git`` is the cheapest, most reliable source of objects: a
    ``git clone --local`` will hardlink objects (with ``--no-hardlinks`` to be
    safe across mounts) without touching the network.
    """
    here = Path(__file__).resolve()
    for parent in [here, *here.parents]:
        if (parent / ".git").exists():
            return parent
    # Fall back to the current working directory; the runner will fail closed
    # if it isn't a git repo.
    return Path.cwd()


# ---------------------------------------------------------------------------
# The production hidden-test runner.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ProductionHiddenTestRunner:
    """Apply the agent's diff at the task's pinned commit and run the answer key.

    Implements :class:`agentrail.evals.spine.HiddenTestRunner` by duck-typing
    (the Protocol is structural). The runner is a frozen dataclass so all
    configuration is upfront and visible at construction; there is no hidden
    state and tests can assert on the exact configuration that ran.

    Attributes:
        repo_root: Directory holding the ``.git`` whose objects we clone from.
            Defaults to the host repo (walked up from this module). Override in
            tests that want to point at a stub repo.
        timeout_s: Wall-clock timeout (seconds) for the pytest subprocess.
            Default :data:`DEFAULT_TIMEOUT_S`. AC4: a hidden test that hangs
            (infinite loop, network call) returns ``False`` within this window.
        workspace_prefix: ``tempfile.mkdtemp`` prefix. The prefix
            differentiates this workspace from any path the agent ran in,
            which is the structural half of AC2 (the agent's workdir prefix is
            ``agentrail-eval-run-``; ours is different).
    """

    repo_root: Optional[Path] = None
    timeout_s: float = DEFAULT_TIMEOUT_S
    workspace_prefix: str = "agentrail-eval-hiddentest-"

    # ----- public entrypoint ------------------------------------------------

    def run_hidden_tests(self, *, task: CorpusTask, run_record: RunRecord) -> bool:
        """Return ``True`` iff every hidden test passes against the agent's diff.

        Fail-closed: returns ``False`` on any error (apply failure, missing
        answer-key file, pytest non-zero exit, timeout, exception). Never
        raises into the spine.
        """
        repo_root = self.repo_root or _default_repo_root()

        workspace = Path(tempfile.mkdtemp(prefix=self.workspace_prefix))
        try:
            try:
                self._materialize_workspace(repo_root, task.commit, workspace)
            except _HiddenTestError as error:
                logger.warning(
                    "hidden-test runner: materialize failed for task=%s: %s",
                    task.name,
                    error,
                )
                return False

            if run_record.diff.strip():
                try:
                    self._apply_diff(workspace, run_record.diff)
                except _HiddenTestError as error:
                    logger.warning(
                        "hidden-test runner: git apply failed for task=%s: %s",
                        task.name,
                        error,
                    )
                    return False

            try:
                test_paths = self._copy_hidden_tests(task, workspace)
            except _HiddenTestError as error:
                logger.warning(
                    "hidden-test runner: copy hidden tests failed for task=%s: %s",
                    task.name,
                    error,
                )
                return False

            return self._run_pytest(workspace, test_paths)
        except Exception as error:  # noqa: BLE001 - fail closed on anything.
            logger.warning(
                "hidden-test runner: unexpected error for task=%s: %s",
                task.name,
                error,
            )
            return False
        finally:
            shutil.rmtree(workspace, ignore_errors=True)

    # ----- step 1: materialize workspace at pinned commit -------------------

    def _materialize_workspace(self, repo_root: Path, commit: str, workspace: Path) -> None:
        """``git clone --local`` ``repo_root`` into ``workspace`` and check out ``commit``.

        ``--local`` shares objects (no network), ``--no-hardlinks`` makes the
        clone independent so we can mutate freely. We then check out the
        pinned commit detached. The workspace ends up as a self-contained git
        working tree at ``commit``.
        """
        # The workspace dir already exists (we made it via mkdtemp). git clone
        # refuses to clone into a non-empty dir, so target a subpath.
        clone_target = workspace / "repo"
        clone = self._git(
            ["git", "clone", "--quiet", "--local", "--no-hardlinks",
             str(repo_root), str(clone_target)],
            cwd=None,
        )
        if clone.returncode != 0:
            raise _HiddenTestError(
                f"git clone failed (rc={clone.returncode}): "
                f"{(clone.stderr or '').strip()}"
            )

        # Detached checkout at the pinned commit.
        checkout = self._git(
            ["git", "-c", "advice.detachedHead=false", "checkout",
             "--quiet", commit],
            cwd=clone_target,
        )
        if checkout.returncode != 0:
            raise _HiddenTestError(
                f"git checkout {commit} failed (rc={checkout.returncode}): "
                f"{(checkout.stderr or '').strip()}"
            )

        # Move the cloned tree up so subsequent steps treat ``workspace`` as
        # the repo root. We do this by renaming entries; can't just move the
        # whole dir because pytest needs the workspace to be a git repo (for
        # rootdir + conftest discovery) AND we need the .git folder present.
        for entry in clone_target.iterdir():
            shutil.move(str(entry), str(workspace / entry.name))
        clone_target.rmdir()

    # ----- step 2: apply the agent's diff -----------------------------------

    def _apply_diff(self, workspace: Path, diff: str) -> None:
        """``git apply`` ``diff`` to ``workspace``.

        ``--whitespace=nowarn`` so trailing-whitespace fuzz doesn't fail an
        otherwise valid patch. ``--reject`` is NOT passed: we want a clean
        all-or-nothing apply; a partial apply would silently produce a
        Frankenstein workspace and bias the verdict.
        """
        apply = subprocess.run(
            ["git", "apply", "--whitespace=nowarn"],
            cwd=str(workspace),
            input=diff,
            capture_output=True,
            text=True,
        )
        if apply.returncode != 0:
            raise _HiddenTestError(
                f"git apply failed (rc={apply.returncode}): "
                f"{(apply.stderr or '').strip()}"
            )

    # ----- step 3: copy hidden tests into workspace -------------------------

    def _copy_hidden_tests(self, task: CorpusTask, workspace: Path) -> list[Path]:
        """Copy each hidden test file into the workspace and return its dest path.

        Source: ``<task.task_dir>/<hidden_tests.root>/<filename>`` (validated by
        the corpus loader). Dest: ``<workspace>/<HIDDEN_TESTS_SUBPATH>/<filename>``.
        We also drop a ``__init__.py`` and a ``conftest.py`` (so pytest can
        discover the dir even if the workspace's root conftest is missing).
        """
        dest_dir = workspace / HIDDEN_TESTS_SUBPATH
        dest_dir.mkdir(parents=True, exist_ok=True)
        (dest_dir / "__init__.py").write_text("", encoding="utf-8")

        sources = task.hidden_test_paths
        dest_paths: list[Path] = []
        for source in sources:
            if not source.is_file():
                raise _HiddenTestError(
                    f"hidden test file missing on disk: {source}"
                )
            dest = dest_dir / source.name
            shutil.copyfile(source, dest)
            dest_paths.append(dest)
        return dest_paths

    # ----- step 4: run pytest with a wall-clock timeout ---------------------

    def _run_pytest(self, workspace: Path, test_paths: list[Path]) -> bool:
        """Run ``pytest`` on the hidden-test files; return True iff exit 0.

        AC4: a hidden test that hangs returns ``False`` within ``timeout_s``.
        We use ``sys.executable -m pytest`` so the spine's interpreter runs
        the tests, and ``-q`` to keep output small. We also pass
        ``--no-header`` and ``-p no:cacheprovider`` to keep the run hermetic.
        """
        rel_paths = [str(p.relative_to(workspace)) for p in test_paths]
        cmd = [
            sys.executable,
            "-m",
            "pytest",
            "-q",
            "--no-header",
            "-p",
            "no:cacheprovider",
            *rel_paths,
        ]
        env = os.environ.copy()
        # Don't let a parent PYTEST_ADDOPTS or pytest plugins leak in unwanted
        # behaviour (e.g. coverage that fails on missing source).
        env.pop("PYTEST_ADDOPTS", None)
        # Make the workspace's ``agentrail/`` (and other top-level packages)
        # importable from the hidden tests. The workspace is a fresh git clone
        # without ``pip install -e .`` having run, so we prepend it to
        # PYTHONPATH explicitly. We PREPEND so the workspace's pinned code
        # wins over any system/site-packages install of the same name (the
        # whole point of pinning the commit).
        workspace_str = str(workspace)
        existing = env.get("PYTHONPATH", "")
        env["PYTHONPATH"] = (
            workspace_str if not existing else f"{workspace_str}{os.pathsep}{existing}"
        )
        try:
            result = subprocess.run(
                cmd,
                cwd=str(workspace),
                env=env,
                capture_output=True,
                text=True,
                timeout=self.timeout_s,
            )
        except subprocess.TimeoutExpired:
            logger.warning(
                "hidden-test runner: pytest exceeded timeout (%ss); failing closed",
                self.timeout_s,
            )
            return False
        if result.returncode != 0:
            logger.info(
                "hidden-test runner: pytest exit %s\nstdout:\n%s\nstderr:\n%s",
                result.returncode,
                (result.stdout or "")[-1000:],
                (result.stderr or "")[-500:],
            )
        return result.returncode == 0

    # ----- subprocess helper -----------------------------------------------

    def _git(self, cmd: list[str], *, cwd: Optional[Path]) -> subprocess.CompletedProcess:
        """Thin ``subprocess.run`` wrapper. Keeps capture/text args uniform."""
        return subprocess.run(
            cmd,
            cwd=str(cwd) if cwd is not None else None,
            capture_output=True,
            text=True,
        )


class _HiddenTestError(RuntimeError):
    """Internal failure during hidden-test execution. Never escapes to the spine."""


__all__ = [
    "DEFAULT_TIMEOUT_S",
    "HIDDEN_TESTS_SUBPATH",
    "ProductionHiddenTestRunner",
]
