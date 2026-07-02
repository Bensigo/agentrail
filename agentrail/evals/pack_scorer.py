"""Offline pack-vs-answer-key precision/recall scorer (#1029 AC2).

This is a **ground-truth** context-quality scorer. It compares the paths a
context pack CITED against the corpus task's ``requiredContext`` answer key
(``agentrail.evals.corpus.loader.CorpusTask.required_context``) and reports how
much of what the pack surfaced was actually required (precision) and how much of
what was required the pack surfaced (recall):

    precision = |cited ∩ required| / |cited|
    recall    = |cited ∩ required| / |required|

It is deliberately DISTINCT from
:func:`agentrail.context.pack_quality.compute_pack_quality`, which is a
ground-truth-FREE proxy (token-share of anchor items + provenance coverage) that
never sees the answer key. That proxy answers "does this pack look well-formed?";
this scorer answers "was this pack RIGHT, against the known answer?". Only the
offline eval corpus carries the ``requiredContext`` ground truth, so only this
offline scorer can compute it — the live run cannot.

Design rules (mirroring :mod:`agentrail.evals.probes`):

- **Pure, no IO.** Set arithmetic over path strings. No subprocess, sandbox,
  network, or filesystem access. Deterministic.
- **Set-based over paths.** Both operands are treated as SETS of paths, so a pack
  that cites the same path twice never inflates its own denominator.
- **``None`` is undefined, never a fake ``0.0``.** Precision is undefined when the
  pack cited nothing (0/0); recall is undefined when the answer key is empty
  (0/0). ``None`` (undefined) stays strictly distinct from a measured ``0.0`` (the
  pack cited things but hit none of them / hit none of the required set) — the
  repeated codebase invariant. Aggregates skip ``None`` scores rather than
  counting them as zero.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence


@dataclass(frozen=True)
class PackScore:
    """One pack's precision/recall against a task's required-context answer key.

    - ``precision`` — fraction of the pack's CITED paths that were required.
      ``None`` when the pack cited nothing (0/0 undefined), else in ``[0.0, 1.0]``.
    - ``recall`` — fraction of the REQUIRED paths the pack cited. ``None`` when the
      answer key is empty (0/0 undefined), else in ``[0.0, 1.0]``.
    - ``intersection`` — number of distinct paths in both sets (the hits).
    - ``cited_count`` — number of DISTINCT cited paths (precision denominator).
    - ``required_count`` — number of DISTINCT required paths (recall denominator).

    Immutable so a computed score cannot be mutated into a different verdict.
    """

    precision: Optional[float]
    recall: Optional[float]
    intersection: int
    cited_count: int
    required_count: int


def pack_precision_recall(
    cited_paths: Sequence[str],
    required_context: Sequence[str],
) -> PackScore:
    """Score one pack's cited paths against a task's required-context answer key.

    Both arguments are treated as SETS (duplicates collapse). Precision is
    undefined (``None``) when the pack cited nothing; recall is undefined
    (``None``) when the answer key is empty — ``None`` never conflated with a
    measured ``0.0``.
    """
    cited = set(cited_paths)
    required = set(required_context)
    hits = len(cited & required)
    cited_count = len(cited)
    required_count = len(required)

    # 0/0 is undefined (None), never a fabricated 0.0. A non-empty denominator
    # with zero hits is a genuine, measured 0.0.
    precision = (hits / cited_count) if cited_count else None
    recall = (hits / required_count) if required_count else None

    return PackScore(
        precision=precision,
        recall=recall,
        intersection=hits,
        cited_count=cited_count,
        required_count=required_count,
    )


@dataclass(frozen=True)
class ArmPackScore:
    """Per-arm aggregate of pack precision/recall over that arm's scored packs.

    - ``arm`` — the arm name.
    - ``pack_count`` — total packs scored for this arm (defined AND undefined).
    - ``mean_precision`` / ``mean_recall`` — the mean over only the DEFINED
      (non-``None``) per-pack scores. ``None`` when NO pack had a defined score
      (every denominator was empty) — never a fake ``0.0``.
    - ``defined_precision_count`` / ``defined_recall_count`` — how many packs
      contributed a defined score to each mean (the honest denominator).
    """

    arm: str
    pack_count: int
    mean_precision: Optional[float]
    mean_recall: Optional[float]
    defined_precision_count: int
    defined_recall_count: int


def _mean_defined(values: Sequence[Optional[float]]) -> tuple[Optional[float], int]:
    """Mean of the non-``None`` values plus how many were defined.

    Returns ``(None, 0)`` when every value is ``None`` (undefined mean, never a
    fake ``0.0``). ``None`` values are SKIPPED, never counted as zero.
    """
    defined = [v for v in values if v is not None]
    if not defined:
        return None, 0
    return sum(defined) / len(defined), len(defined)


def aggregate_pack_scores(
    scores_by_arm: Dict[str, Sequence[PackScore]],
) -> List[ArmPackScore]:
    """Aggregate per-pack scores into per-arm means, one entry per arm.

    The mean of each metric averages only the DEFINED per-pack values; a pack
    whose metric was ``None`` (undefined denominator) is skipped, never counted
    as ``0.0``. An arm whose every pack was undefined for a metric reports
    ``None`` for that mean. Arms are returned in a deterministic (sorted-by-name)
    order so the report is stable.
    """
    out: List[ArmPackScore] = []
    for arm in sorted(scores_by_arm):
        packs = list(scores_by_arm[arm])
        mean_p, defined_p = _mean_defined([p.precision for p in packs])
        mean_r, defined_r = _mean_defined([p.recall for p in packs])
        out.append(
            ArmPackScore(
                arm=arm,
                pack_count=len(packs),
                mean_precision=mean_p,
                mean_recall=mean_r,
                defined_precision_count=defined_p,
                defined_recall_count=defined_r,
            )
        )
    return out


__all__ = [
    "PackScore",
    "ArmPackScore",
    "pack_precision_recall",
    "aggregate_pack_scores",
]
