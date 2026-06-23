"""Adapters — the ONLY place framework / environment I/O lives (issue #919).

A guardrail policy is pure: it reads a :class:`~agentrail.guardrails.signals.Signals`
and a config and returns a :class:`~agentrail.guardrails.base.Verdict`.  Something
has to *produce* that ``Signals`` from the real world — that is an adapter's job,
and the only job done here.  Adapters are where ``subprocess``/``git``/``gh``/
``pytest`` may appear; policies (``agentrail/guardrails/policies/``) never import
them (AC4).

Layout
------
* :mod:`agentrail.guardrails.adapters.git` — ``changed_files`` and ``diff``.
* :mod:`agentrail.guardrails.adapters.ci` — ``ci_checks``.
* :mod:`agentrail.guardrails.adapters.test_runner` — ``test_results``.

Each exposes a small function returning the slice of :class:`Signals` it owns, and
:func:`build_signals` composes them.  Every adapter is best-effort: an environment
failure degrades to an empty value, never raises — the gate must still run.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional, Sequence

from agentrail.guardrails.signals import CiCheck, Signals, TestResult


def build_signals(
    repo_dir: Path | str = ".",
    *,
    base_ref: Optional[str] = None,
    ci_checks: Sequence[CiCheck] = (),
    test_results: Sequence[TestResult] = (),
    include_diff: bool = False,
) -> Signals:
    """Compose a :class:`Signals` from the available adapters.

    The git adapter is always run (it is the primary input for classification);
    ``ci_checks``/``test_results`` are passed through from their adapters by the
    caller (they require a network/test run the gate may not want to trigger).
    """
    from agentrail.guardrails.adapters import git as git_adapter

    changed_files = git_adapter.collect_changed_files(repo_dir, base_ref=base_ref)
    diff = git_adapter.collect_diff(repo_dir, base_ref=base_ref) if include_diff else ""
    deleted_files = git_adapter.collect_deleted_files(repo_dir, base_ref=base_ref)
    return Signals(
        changed_files=tuple(changed_files),
        diff=diff,
        test_results=tuple(test_results),
        ci_checks=tuple(ci_checks),
        deleted_files=tuple(deleted_files),
    )


__all__ = ["build_signals"]
