"""Offline pack-score DRIVER — run real retrieval, score against the answer key (#1029 AC2/AC3).

``pack_scorer`` is deliberately PURE (set arithmetic, no IO). This module is the
IO-bearing half: it runs the SAME deterministic retrieval the live context
pipeline uses (:func:`agentrail.context.retrieval.query_context`), extracts the
paths that retrieval CITED, and hands them to the pure scorer
(:func:`agentrail.evals.pack_scorer.pack_precision_recall`) against each corpus
task's ``required_context`` answer key.

Why this exists (the #1029 false-green fix):

The live sandbox executor does NOT surface a pack's cited paths — the
:class:`agentrail.evals.runner.AgentExecution` returns
``precision_at_budget=None`` / ``citation_coverage=None`` (TODO #994: pack
metadata is not plumbed out of the sandbox subprocess), and the corpus ships only
the prompt + answer key on disk, no materialized source tree. So the pack scorer
could never see a real pack from a live run — which is exactly why the reporter's
precision/recall rendered ``n/a`` on every real eval. The fix is to compute the
pack score OFFLINE, deterministically, from the retrieval stage itself.

The rerank seam (the whole point of the #1029 rerank arm):

Retrieval honors ``AGENTRAIL_CONTEXT_RERANK`` (see
:func:`agentrail.context.rerank.rerank_enabled`). This driver sets that env var
from the arm's ``rerank`` layer flag — the SAME bridge
:func:`agentrail.evals.runner._arm_env` applies — so the ``full`` arm retrieves
WITH rerank and the ``full-minus-rerank`` arm retrieves WITHOUT it. That is what
makes the two arms produce a genuinely different cited set, and therefore a
genuinely different (falsifiable) precision/recall delta.

Honesty rails:

- **Degrades to ``None``, never fabricates.** If no context index exists at the
  retrieval root (``.agentrail/context/index/index.json`` absent), this returns
  ``None`` — the reporter then renders ``n/a`` (undefined), never a fake ``0.0``.
  We NEVER trigger a heavy ``build_index`` rebuild here; scoring is a read of an
  index that already exists, or it honestly reports "not measured".
- **Restores the env var.** The ``AGENTRAIL_CONTEXT_RERANK`` override is scoped to
  each retrieval call and the prior value is restored, so scoring never leaks a
  global flag into the rest of the run.
- **Set-based, deterministic.** Cited paths are de-duplicated preserving first
  appearance; the pure scorer treats them as a set. No randomness, no network.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Dict, List, Optional, Sequence

from agentrail.evals.arms import Arm
from agentrail.evals.corpus.loader import CorpusTask
from agentrail.evals.pack_scorer import (
    ArmPackScore,
    PackScore,
    aggregate_pack_scores,
    pack_precision_recall,
)

_log = logging.getLogger(__name__)

# The retrieval env seam the rerank stage reads. Kept in lockstep with
# ``agentrail.context.rerank.rerank_enabled`` and ``runner._arm_env``.
_RERANK_ENV = "AGENTRAIL_CONTEXT_RERANK"

# How many retrieval results form the "pack" whose cited paths we score. Matches
# the live pack builder's default retrieval width
# (``agentrail.context.packs.build_context_pack`` calls ``query_context(...,
# limit=20)``) so the offline precision/recall reflects the same candidate set
# the live pipeline would surface.
_PACK_LIMIT = 20


def _index_exists(root: Path) -> bool:
    """True when a built context index is present at *root* (no rebuild)."""
    return (root / ".agentrail" / "context" / "index" / "index.json").is_file()


def _cited_paths(root: Path, query: str, *, rerank: bool, index: Dict) -> List[str]:
    """Run real retrieval and return the DISTINCT paths it cited, in rank order.

    Honors the arm's rerank flag by scoping ``AGENTRAIL_CONTEXT_RERANK`` for the
    duration of the single ``query_context`` call, then restoring the prior
    value. The ``index`` is passed in (already loaded once per root) so we never
    trigger a ``build_index`` rebuild.
    """
    # Import here so the pure-config import graph (arms/pack_scorer) never pulls
    # in the heavy retrieval module unless offline scoring is actually run.
    from agentrail.context.retrieval import query_context

    prior = os.environ.get(_RERANK_ENV)
    if rerank:
        # Default is ON when unset; make the "on" arm explicit rather than
        # depending on ambient env, so scoring is reproducible regardless of the
        # process's inherited environment.
        os.environ[_RERANK_ENV] = "1"
    else:
        # Same OFF token the runner._arm_env bridge writes.
        os.environ[_RERANK_ENV] = "0"
    try:
        result = query_context(root, query, limit=_PACK_LIMIT, index=index)
    finally:
        if prior is None:
            os.environ.pop(_RERANK_ENV, None)
        else:
            os.environ[_RERANK_ENV] = prior

    seen: List[str] = []
    for item in result.get("results", []):
        path = item.get("path") or item.get("citation")
        if path and path not in seen:
            seen.append(path)
    return seen


def score_task_arm(
    task: CorpusTask,
    arm: Arm,
    *,
    root: Path,
    index: Dict,
) -> PackScore:
    """Score one (task, arm) pack against the task's required-context answer key.

    Runs the deterministic retrieval for *task.prompt* at *root* with the arm's
    rerank flag applied, then scores the cited paths against
    ``task.required_context``. Pure scoring is delegated to
    :func:`agentrail.evals.pack_scorer.pack_precision_recall` — this function only
    provides the (real) cited paths.
    """
    cited = _cited_paths(root, task.prompt, rerank=arm.layers.rerank, index=index)
    return pack_precision_recall(cited, task.required_context)


def compute_pack_scores(
    tasks: Sequence[CorpusTask],
    arms: Sequence[Arm],
    *,
    root: Path,
) -> Optional[List[ArmPackScore]]:
    """Offline per-arm pack precision/recall, or ``None`` when unavailable.

    For every (task, arm) it runs the real retrieval stage at *root* (honoring the
    arm's rerank flag) and scores the cited paths against the task's
    required-context answer key, then aggregates per arm via
    :func:`agentrail.evals.pack_scorer.aggregate_pack_scores`.

    Returns ``None`` — so the reporter renders ``n/a`` (undefined, never a fake
    ``0.0``) — when there is no built context index at *root*. We never rebuild
    the index here (that is a heavy, minutes-long operation and not the eval's
    job); a pack score is a read of an index that already exists, or an honest
    "not measured".
    """
    root = Path(root).resolve()
    if not _index_exists(root):
        _log.info(
            "pack scoring skipped: no context index at %s "
            "(precision/recall will render n/a — never fabricated)",
            root,
        )
        return None

    # Import here (heavy module) only once we know we will actually score.
    from agentrail.context.index import load_index

    try:
        index = load_index(root)
    except OSError:
        # Raced/removed between the existence check and the load — degrade
        # honestly rather than crash the whole eval on a context-quality read.
        _log.warning("pack scoring skipped: index at %s vanished before load", root)
        return None

    scores_by_arm: Dict[str, List[PackScore]] = {arm.name: [] for arm in arms}
    for arm in arms:
        for task in tasks:
            try:
                score = score_task_arm(task, arm, root=root, index=index)
            except Exception as exc:  # noqa: BLE001 - a retrieval hiccup on ONE
                # (task, arm) must not zero out the whole context-quality read;
                # skip that pack (it simply does not contribute to the mean).
                _log.warning(
                    "pack scoring failed for task=%s arm=%s: %s",
                    task.name,
                    arm.name,
                    exc,
                )
                continue
            scores_by_arm[arm.name].append(score)

    return aggregate_pack_scores(scores_by_arm)


__all__ = [
    "compute_pack_scores",
    "score_task_arm",
]
