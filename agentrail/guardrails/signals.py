"""Framework-neutral ``Signals`` — the single data vocabulary guardrails read.

A guardrail must never reach into the environment (git, CI, a test runner) or know
which *framework* a repo uses.  Instead, an :mod:`agentrail.guardrails.adapters`
produces a :class:`Signals` snapshot from the environment, and every policy reads
that snapshot — and nothing else.  This is the seam that makes the guardrails
package framework-independent (issue #919): swap the adapters (or the config the
adapters/policies are handed) and the *same* policy code works for a Python repo,
a TypeScript repo, or anything else.

Design intent (foundation for #919–#921)
----------------------------------------
* :class:`Signals` is a small **frozen** dataclass with no methods that do I/O and
  no framework imports.  It carries the six neutral observations the gate epic
  needs: ``changed_files``, ``diff``, ``test_results``, ``ci_checks``,
  ``added_lines``, ``deleted_files``.  #920 (unified objective gate) and #921
  (other guardrails) will read more of these fields; the schema is deliberately
  broad so they don't have to widen it.
* All sequence fields normalise to immutable tuples in ``__post_init__`` so a
  ``Signals`` stays hashable and a policy cannot mutate the inputs it was handed.
* The element types (:class:`TestResult`, :class:`CiCheck`) are likewise frozen
  and framework-neutral: a "test" is a name + passed/failed, never a pytest node
  id; a "CI check" is a name + a conclusion string, never a GitHub API shape.

What does NOT live here
-----------------------
No ``subprocess``/``git``/``gh``/``pytest`` — producing these values is the
adapters' job.  This module is pure data.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Optional, Tuple


@dataclass(frozen=True)
class TestResult:
    """A single framework-neutral test outcome.

    ``name`` is whatever the test-runner adapter chose to call the unit (a file,
    a node id, a suite) — policies treat it as an opaque label.  ``passed`` is the
    only semantic bit; ``message`` is optional human context.
    """

    # Tell pytest this is not a test class (name starts with "Test").
    __test__ = False

    name: str
    passed: bool
    message: Optional[str] = None


@dataclass(frozen=True)
class CiCheck:
    """A single framework-neutral CI check outcome.

    ``conclusion`` is a lowercase string such as ``"success"``/``"failure"``;
    :attr:`succeeded` normalises the common success vocabularies so a policy need
    not know any one CI provider's spelling.
    """

    name: str
    conclusion: str

    @property
    def succeeded(self) -> bool:
        return self.conclusion.strip().lower() in {"success", "passed", "pass", "ok"}


@dataclass(frozen=True)
class Signals:
    """An immutable, framework-neutral snapshot of a change under evaluation.

    Every guardrail policy reads a ``Signals`` and nothing else.  Adapters
    (:mod:`agentrail.guardrails.adapters`) are the only code that *produces* one,
    by talking to git / CI / a test runner.

    Fields
    ------
    changed_files:
        Repo-relative paths touched by the change (committed-on-branch ∪
        working-tree, in the git adapter).  The primary input for classification.
    diff:
        The unified diff text for the change, if collected (empty string if not).
    test_results:
        Tuple of :class:`TestResult` produced by the test-runner adapter.
    ci_checks:
        Tuple of :class:`CiCheck` produced by the ci adapter.
    added_lines:
        Lines added by the change (for size/heuristic policies in later slices).
    deleted_files:
        Repo-relative paths the change deletes (a deletion is not a "changed
        file" you can apply a diff against — kept separate on purpose).
    """

    changed_files: Tuple[str, ...] = field(default_factory=tuple)
    diff: str = ""
    test_results: Tuple[TestResult, ...] = field(default_factory=tuple)
    ci_checks: Tuple[CiCheck, ...] = field(default_factory=tuple)
    added_lines: Tuple[str, ...] = field(default_factory=tuple)
    deleted_files: Tuple[str, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        # Normalise every iterable field to an immutable tuple so Signals is
        # hashable and policies cannot mutate the inputs they were handed.
        object.__setattr__(self, "changed_files", _as_tuple(self.changed_files))
        object.__setattr__(self, "test_results", _as_tuple(self.test_results))
        object.__setattr__(self, "ci_checks", _as_tuple(self.ci_checks))
        object.__setattr__(self, "added_lines", _as_tuple(self.added_lines))
        object.__setattr__(self, "deleted_files", _as_tuple(self.deleted_files))


def _as_tuple(value: Iterable) -> Tuple:
    if isinstance(value, tuple):
        return value
    return tuple(value)
