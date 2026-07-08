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

The retrieval seams (what makes the ablation arms falsifiable):

Retrieval honors two env seams this driver drives from the arm's layer flags:

- ``AGENTRAIL_CONTEXT_RERANK`` (see
  :func:`agentrail.context.rerank.rerank_enabled`, default ON) — the ``rerank``
  layer. The ``full`` arm retrieves WITH rerank, ``full-minus-rerank`` WITHOUT.
- ``AGENTRAIL_CONTEXT_QUERY_EXPANSION`` (see
  :func:`agentrail.context.expansion.query_expansion_enabled`, default OFF) — the
  ``expansion`` recall layer (#1043). The ``full`` arm retrieves WITH query
  expansion, ``full-minus-expansion`` WITHOUT. Without this seam the offline
  pack-vs-answer-key RECALL metric could not tell ``full`` from
  ``full-minus-expansion`` — every expansion delta would be a silent hard 0.

These are the SAME seams :func:`agentrail.evals.runner._arm_env` drives for the
live sandbox leg, so offline and live measure the same toggle. One deliberate
divergence: the runner writes into a FRESH subprocess env (so it can leave a
default-valued flag unset), but this driver mutates the CURRENT process env, which
may already carry an ambient value. So it writes BOTH directions explicitly
(``1``/``0``) per arm — never "set for on, unset for off" — otherwise an inherited
``AGENTRAIL_CONTEXT_QUERY_EXPANSION=1`` (e.g. from an AFK env) would leak into the
``full-minus-expansion`` arm and turn the ablation into a no-op.

Honesty rails:

- **Degrades to ``None``, never fabricates.** If no context index exists at the
  retrieval root (``.agentrail/context/index/index.json`` absent), this returns
  ``None`` — the reporter then renders ``n/a`` (undefined), never a fake ``0.0``.
  We NEVER trigger a heavy ``build_index`` rebuild here; scoring is a read of an
  index that already exists, or it honestly reports "not measured".
- **Restores the env vars.** The ``AGENTRAIL_CONTEXT_RERANK`` and
  ``AGENTRAIL_CONTEXT_QUERY_EXPANSION`` overrides are scoped to each retrieval
  call and the prior values are restored, so scoring never leaks a global flag
  into the rest of the run.
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

# The retrieval env seam the query-expansion (recall) stage reads. Kept in
# lockstep with ``agentrail.context.expansion.query_expansion_enabled`` (default
# OFF) and ``runner._arm_env`` (#1043).
_EXPANSION_ENV = "AGENTRAIL_CONTEXT_QUERY_EXPANSION"

# The retrieval env seam the LLM listwise rerank stage reads. Kept in lockstep
# with ``agentrail.context.llm_rerank.llm_rerank_enabled`` (default OFF) and
# ``runner._arm_env``'s llm_rerank bridge (#1044 AC2).
_LLM_RERANK_ENV = "AGENTRAIL_CONTEXT_LLM_RERANK"

# The rank-aware corpus-mean key ``evaluate_retrieval`` surfaces (#1088). The LLM
# rerank is a membership-preserving ORDERING change, so ``fileNDCG`` is the only
# summary mean it can move — the set-membership precision/recall means cannot see
# a reorder. Kept in lockstep with ``evaluation.py``'s ``summary.means`` key.
_FILE_NDCG_MEAN_KEY = "fileNDCG"

# How many retrieval results form the "pack" whose cited paths we score. Matches
# the live pack builder's default retrieval width
# (``agentrail.context.packs.build_context_pack`` calls ``query_context(...,
# limit=20)``) so the offline precision/recall reflects the same candidate set
# the live pipeline would surface.
_PACK_LIMIT = 20


def _index_exists(root: Path) -> bool:
    """True when a built context index is present at *root* (no rebuild)."""
    return (root / ".agentrail" / "context" / "index" / "index.json").is_file()


def _cited_paths(
    root: Path,
    query: str,
    *,
    rerank: bool,
    expansion: bool,
    index: Dict,
) -> List[str]:
    """Run real retrieval and return the DISTINCT paths it cited, in rank order.

    Honors the arm's ``rerank`` and ``expansion`` layer flags by scoping
    ``AGENTRAIL_CONTEXT_RERANK`` and ``AGENTRAIL_CONTEXT_QUERY_EXPANSION`` for the
    duration of the single ``query_context`` call, then restoring the prior
    values. Both directions are written explicitly (``1``/``0``) rather than
    "set for on, unset for off": we mutate the CURRENT process env (not a fresh
    subprocess like the runner), so an inherited value must be overridden in both
    the on and off arms or the ablation would leak into a no-op. The ``index`` is
    passed in (already loaded once per root) so we never trigger a
    ``build_index`` rebuild.
    """
    # Import here so the pure-config import graph (arms/pack_scorer) never pulls
    # in the heavy retrieval module unless offline scoring is actually run.
    from agentrail.context.retrieval import query_context

    # Same tokens the runner._arm_env bridge and the *_enabled() readers use.
    overrides = {
        _RERANK_ENV: "1" if rerank else "0",
        _EXPANSION_ENV: "1" if expansion else "0",
    }
    prior = {name: os.environ.get(name) for name in overrides}
    os.environ.update(overrides)
    try:
        result = query_context(root, query, limit=_PACK_LIMIT, index=index)
    finally:
        for name, value in prior.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value

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
    ``rerank`` and ``expansion`` flags applied, then scores the cited paths
    against ``task.required_context``. Pure scoring is delegated to
    :func:`agentrail.evals.pack_scorer.pack_precision_recall` — this function only
    provides the (real) cited paths.
    """
    cited = _cited_paths(
        root,
        task.prompt,
        rerank=arm.layers.rerank,
        expansion=arm.layers.expansion,
        index=index,
    )
    return pack_precision_recall(cited, task.required_context)


def compute_pack_scores(
    tasks: Sequence[CorpusTask],
    arms: Sequence[Arm],
    *,
    root: Path,
) -> Optional[List[ArmPackScore]]:
    """Offline per-arm pack precision/recall, or ``None`` when unavailable.

    For every (task, arm) it runs the real retrieval stage at *root* (honoring the
    arm's rerank and expansion flags) and scores the cited paths against the
    task's required-context answer key, then aggregates per arm via
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


def score_llm_rerank_ndcg(
    root: Path,
    fixture_file: Path,
    *,
    arms: Optional[Sequence[Arm]] = None,
    evaluate: Optional[object] = None,
) -> Dict[str, object]:
    """A/B the LLM listwise rerank OFF-vs-ON and report ``fileNDCG`` per arm (#1044 AC2).

    Runs :func:`agentrail.context.evaluation.evaluate_retrieval` over *fixture_file*
    once per arm, with the arm's env applied so the LLM rerank stage
    (:func:`agentrail.context.llm_rerank.llm_rerank_enabled`) is OFF for ``full``
    and ON for ``full-plus-llm_rerank``. It reports each arm's corpus-mean
    ``fileNDCG`` (issue #1088) plus the ON-minus-OFF delta.

    The LLM rerank is a membership-preserving ORDERING change, so ``fileNDCG`` is
    the only metric that can move — precision/recall are set-based and blind to a
    reorder. **Honest expectation:** on the current fixtures the delta is ~0
    because (a) most fixtures are already rank-saturated (per-fixture nDCG 1.0,
    no headroom — the harder-rank fixtures are tracked in #1107) and (b) the
    rerank only fires when a headless ``claude`` binary is available
    (:func:`agentrail.context.llm_rerank.llm_rerank_model_path_available`), which
    is absent/mocked in CI. This helper's job is to EXIST, toggle the seam, and
    report the metric honestly — never to fabricate a lift.

    The env mapping is the SAME seam :func:`agentrail.evals.runner._arm_env`
    drives for the live sandbox leg (single source of truth). Only the
    ``AGENTRAIL_CONTEXT_*`` retrieval seams are scoped for the duration of each
    ``evaluate`` call and the prior values are restored, both directions written
    explicitly (as :func:`_cited_paths` does) so an inherited ambient value can
    never leak the ON arm into the OFF arm.

    ``evaluate`` is injectable for testing (defaults to the real
    ``evaluate_retrieval``); it must accept ``(root, fixture_file)`` and return a
    report whose ``summary.means`` carries ``fileNDCG``.

    Returns ``{"arms": [{"arm", "llmRerank", "fileNDCG"}...], "fileNDCGDelta"}``.
    ``fileNDCGDelta`` is ``None`` when either arm's ``fileNDCG`` is missing/``None``
    (undefined, never a fake ``0.0``).
    """
    # Lazy imports: keep the pure-config import graph light and avoid a hard
    # dependency on the heavy retrieval/runner modules unless this A/B is run.
    if evaluate is None:
        from agentrail.context.evaluation import evaluate_retrieval as evaluate
    from agentrail.evals.runner import _arm_env

    if arms is None:
        from agentrail.evals.arms import llm_rerank_arms

        arms = llm_rerank_arms()

    root = Path(root).resolve()
    per_arm: List[Dict[str, object]] = []
    for arm in arms:
        arm_env = _arm_env(arm)
        # Scope only the retrieval seams; and always pin the LLM-rerank var in
        # BOTH directions (ON→"1" via the runner bridge, else explicit "0") so an
        # inherited ambient value never leaks the ON arm into the OFF arm.
        overrides = {
            name: value
            for name, value in arm_env.items()
            if name.startswith("AGENTRAIL_CONTEXT_")
        }
        overrides[_LLM_RERANK_ENV] = arm_env.get(_LLM_RERANK_ENV, "0")
        prior = {name: os.environ.get(name) for name in overrides}
        os.environ.update(overrides)
        try:
            report = evaluate(root, fixture_file)
        finally:
            for name, value in prior.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value
        means = (report or {}).get("summary", {}).get("means", {})
        per_arm.append(
            {
                "arm": arm.name,
                "llmRerank": overrides[_LLM_RERANK_ENV] == "1",
                _FILE_NDCG_MEAN_KEY: means.get(_FILE_NDCG_MEAN_KEY),
            }
        )

    off = next((a for a in per_arm if not a["llmRerank"]), None)
    on = next((a for a in per_arm if a["llmRerank"]), None)
    off_ndcg = off.get(_FILE_NDCG_MEAN_KEY) if off else None
    on_ndcg = on.get(_FILE_NDCG_MEAN_KEY) if on else None
    delta = (
        on_ndcg - off_ndcg
        if isinstance(off_ndcg, (int, float)) and isinstance(on_ndcg, (int, float))
        else None
    )
    return {"arms": per_arm, "fileNDCGDelta": delta}


__all__ = [
    "compute_pack_scores",
    "score_task_arm",
    "score_llm_rerank_ndcg",
]
