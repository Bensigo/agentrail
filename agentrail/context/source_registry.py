"""Knowledge sources behind one interface (context source registry spec §A/§B —
docs/superpowers/specs/2026-07-27-context-source-registry-design.md).

Today a context pack comes from exactly one place: ``query_context`` over the
local file index. Every other knowledge source the product has — the compiled
repo wiki, workspace memory, and whatever comes after — has needed its own
bespoke path into the pack. This module is the seam that stops that: a source
implements one method, the registry consults the ones the planner asked for,
and the merge decides what lands.

**Phase one ships the `code` source only, and it is a wrapper, not a rewrite.**
The existing hybrid retriever, expansion layer, reranker, authority tiers, and
freshness demotions are untouched and still do all the work. With one source
registered, :func:`merge` is deliberately the identity function, so a pack
built through the registry is byte-identical to one built without it. That
equivalence is the entire deliverable of this phase — if it does not hold, the
wrapper is wrong, and no later measurement of a second source would mean
anything.

WHAT IS NOT HERE, ON PURPOSE:

* **Multi-source merging.** :func:`merge` raises on more than one payload
  rather than concatenating them. BM25 scores are corpus-relative — a score
  from a 64-page wiki corpus and one from a 40k-chunk code corpus are not on
  the same scale, and naive concatenation lets corpus size decide the pack.
  Spec §E has to be settled against the retrieval fixtures first. Raising is
  the point: a silent concatenation would look like it worked.
* **Source selection and weighting.** The planner grows that in the next
  phase (spec §C). Until then every registered source is consulted.
* **A model anywhere in this path.** Task-time LLM recon is the gather phase;
  it was measured against the two-set gate, it failed, and #1049 was closed
  with the flag off. Source selection is a classification a signal table can
  do.
"""
from __future__ import annotations

import os
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Protocol, Sequence

REGISTRY_ENV = "AGENTRAIL_CONTEXT_SOURCE_REGISTRY"

# How long any single source may take before the pack build stops waiting for
# it. A source that misses this is not an error -- it degrades to zero
# candidates and is named in provenance. Chosen to sit above a local index
# query and above the wiki client's own 5s HTTP timeout, so this backstop
# fires only when a source is genuinely wedged rather than merely slow.
SOURCE_TIMEOUT_SECONDS = 20.0


def registry_enabled() -> bool:
    """Is the source registry ON for this process? DEFAULT OFF.

    Same convention as every other rollout flag in this package: explicitly
    ``"1"`` and nothing else. Flag OFF means ``build_context_pack`` calls
    ``query_context`` directly, exactly as it did before this module existed.
    """
    return (os.environ.get(REGISTRY_ENV) or "").strip() == "1"


@dataclass(frozen=True)
class SourceBudget:
    """What a source may spend answering one query.

    Advisory, not enforced here: a source is expected to respect
    ``max_items``, and the pack's own token trim is the real ceiling. Passed
    explicitly rather than read from config inside each source so two sources
    can never disagree about what the budget was.
    """

    max_items: int
    max_tokens: int


@dataclass
class SourceOutcome:
    """One source's contribution, including how it failed if it did.

    ``payload`` is a ``query_context``-shaped dict, or None when the source
    raised or timed out. Keeping the failure alongside the result — rather
    than dropping failed sources on the floor — is what lets a pack say which
    knowledge was unavailable when it was built. A pack that silently omits a
    source reads identically to one where that source had nothing to say, and
    those are very different facts during a postmortem.
    """

    name: str
    payload: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    elapsed_ms: float = 0.0

    @property
    def ok(self) -> bool:
        return self.payload is not None

    @property
    def candidate_count(self) -> int:
        return len((self.payload or {}).get("results") or [])

    def provenance(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "ok": self.ok,
            "candidates": self.candidate_count,
            "elapsedMs": round(self.elapsed_ms, 1),
            "error": self.error,
        }


class ContextSource(Protocol):
    """One knowledge source. Ranks its own candidates; ranks nothing else.

    A source does NOT decide inclusion, does not trim to a token budget, and
    does not compare itself against other sources. It returns scored
    candidates and stops — every cross-source decision belongs to the merge,
    which is the only place that can see all of them at once.
    """

    name: str
    authority: str

    def search(self, root: Path, query_text: str, budget: SourceBudget) -> Dict[str, Any]:
        ...


@dataclass
class CodeSource:
    """The local file index — today's entire retrieval path, wrapped.

    ``authority`` is "normal" to match what code/doc records already carry in
    ``retrieval.authority_demotion`` (no boost, no demotion). It is declared
    here so the merge can eventually reason about source-level authority
    without reaching into records, but nothing reads it yet, and the
    per-record tiers stay authoritative.
    """

    name: str = "code"
    authority: str = "normal"

    def search(self, root: Path, query_text: str, budget: SourceBudget) -> Dict[str, Any]:
        from agentrail.context.retrieval import query_context

        return query_context(root, query_text, limit=budget.max_items)


@dataclass
class Registry:
    sources: List[ContextSource] = field(default_factory=list)

    def names(self) -> List[str]:
        return [source.name for source in self.sources]


def build_registry(root: Path) -> Registry:
    """The sources available for this repo.

    Phase one: ``code`` only. The wiki source arrives with the planner's
    source weights (spec §C/§K step 4) and memory migrates after that (§F),
    deliberately last — folding the memory lane in changes pack bytes for
    every run including ones with no wiki, which would contaminate the first
    measurement of whether the wiki helps.
    """
    return Registry(sources=[CodeSource()])


def consult(
    root: Path,
    query_text: str,
    budget: SourceBudget,
    sources: Sequence[ContextSource],
) -> List[SourceOutcome]:
    """Ask every source concurrently; never raise.

    Fail-open per source, the same contract ``fetch_memory_snapshot`` and
    ``compile_wiki`` already hold: one wedged or broken source degrades that
    source to zero candidates, and the pack still builds from whatever else
    answered. Outcomes come back in the order sources were registered, not
    completion order, so a pack's provenance is deterministic.
    """
    if not sources:
        return []

    def _run(source: ContextSource) -> SourceOutcome:
        started = time.monotonic()
        try:
            payload = source.search(root, query_text, budget)
        except Exception as exc:  # noqa: BLE001 - a broken source must not fail the pack
            return SourceOutcome(name=source.name, error=f"{type(exc).__name__}: {exc}", elapsed_ms=(time.monotonic() - started) * 1000)
        elapsed = (time.monotonic() - started) * 1000
        if not isinstance(payload, dict):
            return SourceOutcome(name=source.name, error=f"source returned {type(payload).__name__}, expected dict", elapsed_ms=elapsed)
        return SourceOutcome(name=source.name, payload=payload, elapsed_ms=elapsed)

    if len(sources) == 1:
        # No thread for the single-source case: it keeps the flag-ON path's
        # stack identical to the flag-OFF path's, so a traceback from inside
        # retrieval reads the same either way.
        return [_run(sources[0])]

    with ThreadPoolExecutor(max_workers=len(sources)) as pool:
        futures = [pool.submit(_run, source) for source in sources]
        outcomes = []
        for source, future in zip(sources, futures):
            try:
                outcomes.append(future.result(timeout=SOURCE_TIMEOUT_SECONDS))
            except Exception as exc:  # noqa: BLE001 - includes TimeoutError
                outcomes.append(SourceOutcome(name=source.name, error=f"{type(exc).__name__}: {exc}"))
        return outcomes


def merge(outcomes: Sequence[SourceOutcome]) -> Dict[str, Any]:
    """Combine source payloads into one ``query_context``-shaped result.

    With a single successful source this is the IDENTITY function — the
    payload is returned unchanged, not copied and rebuilt — which is what
    makes a registry-built pack byte-identical to a directly-built one.

    With more than one it raises. Concatenating results from different corpora
    would silently let corpus size decide the pack, because BM25 scores are
    corpus-relative (spec §E). The scale reconciliation — calibrated
    per-source normalization, or rank fusion if calibration proves unstable —
    is a measured decision against the retrieval fixtures, not something to
    improvise here.
    """
    successful = [outcome for outcome in outcomes if outcome.ok]
    if not successful:
        errors = "; ".join(f"{o.name}: {o.error}" for o in outcomes) or "no sources registered"
        raise RuntimeError(f"no context source produced a result ({errors})")
    if len(successful) > 1:
        raise NotImplementedError(
            "multi-source merge needs the score-comparability decision in "
            "docs/superpowers/specs/2026-07-27-context-source-registry-design.md §E "
            f"(sources: {', '.join(o.name for o in successful)})"
        )
    return successful[0].payload  # type: ignore[return-value]


def query_sources(root: Path, query_text: str, budget: Dict[str, int]) -> Dict[str, Any]:
    """Registry-backed replacement for a direct ``query_context`` call.

    Takes the pack's own ``retrievalBudget`` dict so the call site does not
    have to translate, and returns the same shape ``query_context`` does,
    plus a ``sourceProvenance`` list. The extra key is additive: nothing in
    ``packs.py`` enumerates this dict's keys, so a pack built with it is
    unchanged.
    """
    registry = build_registry(root)
    outcomes = consult(
        root,
        query_text,
        SourceBudget(max_items=int(budget.get("maxItems", 20)), max_tokens=int(budget.get("maxTokens", 0))),
        registry.sources,
    )
    merged = merge(outcomes)
    merged["sourceProvenance"] = [outcome.provenance() for outcome in outcomes]
    return merged
