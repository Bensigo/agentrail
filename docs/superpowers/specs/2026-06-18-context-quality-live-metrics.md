# Spec: Live Context-Quality Metrics

**Date:** 2026-06-18
**Status:** Draft — needs sign-off on the proxy definitions before implementation
**Related:** `agentrail/run/context_pack_push.py`, `agentrail/run/context.py`, `agentrail/context/evaluation.py`, Context Quality console page

## Problem

The Context Quality dashboard shows `0%` for `precision_at_budget` and `citation_coverage`, and `0` for `stale_count` / `denied_count`, on **all real data** (e.g. 175/175 packs in workspace `1004eefa…`). This is not a UI bug — the **producer never computes these metrics**:

- `push_context_pack()` reads them from the `retrieval` dict: `float(retrieval.get("precision_at_budget") or 0.0)`.
- `context_retrieval_metadata()` (`search_context(...).runMetadata`) never sets those keys.
- The only code that computes precision (`evaluation._precision_at_budget`) lives in the **offline eval/benchmark harness**, which requires ground-truth `relevant_paths` / `required_sources` from fixtures — data a live run does not have.

A UI honesty pass now renders these as "Not reported yet" instead of a false green "all stable". This spec defines how to actually **produce** them.

## Key constraint

A live run has **no ground truth** for "which sources were truly relevant", so the eval-harness precision definition cannot be reused verbatim. We need **proxy definitions** computable from data already present at retrieval time. Fortunately the ClickHouse schema comments already describe the intended proxy semantics:

- `precision_at_budget` — "Fraction of token budget filled by required sources (0.0–1.0)."
- `citation_coverage` — "Fraction of included items that carry a citation (0.0–1.0)."
- `stale_count` — "Number of included items whose source hash is older than the current index snapshot."
- `denied_count` — "Number of candidate items excluded by source custody policy."

## Available runtime signals (no ground truth needed)

From `search_context()` results and `build_context_pack()`:
- Per selected item: `path`, `tokenEstimate`, relevance `score`, `lineStart/End`, `reason`.
- Pack buckets: `requiredContext`, `likelyFiles`, `likelyDocs`, `relevantMemory`, anchors (`anchors_extracted`).
- `retrievalBudget`: `{ maxItems, maxTokens }`; `selectedContextTokens`; `selectedSources`; `source_hash_list`.
- Per candidate `policy`: `{ visibility, authority, freshness }` — see `evaluation._candidate_leaks`. `freshness ∈ {stale, expired}` and `visibility/authority == "denied"` are exactly the stale/denied signals, with **no ground truth required**.

## Proposed proxy definitions

| Metric | Live proxy | Range |
|---|---|---|
| `precision_at_budget` | Sum of `tokenEstimate` for **required/anchor** selected items ÷ `selectedContextTokens` (clamp [0,1]). "How much of the packed budget went to must-have context vs. filler." | 0.0–1.0 |
| `citation_coverage` | Count of included items with a non-empty `citation`/`path` provenance ÷ total included items. | 0.0–1.0 |
| `stale_count` | Count of **selected** items whose `policy.freshness ∈ {stale, expired}` (or whose `source_hash` predates the latest `index_snapshots.indexed_at`). | integer ≥ 0 |
| `denied_count` | Count of **candidate** items excluded with `policy.visibility == "denied"` or `policy.authority == "denied"`. | integer ≥ 0 |

Open decisions for sign-off:
1. **Precision numerator** — "required sources only" vs. "required + high-score (score ≥ threshold)". Recommend: required/anchor tokens only (matches the schema comment, deterministic, no magic threshold).
2. **Stale source** — use `policy.freshness` (if the retrieval engine populates it) vs. compare `source_hash_list` against the newest `index_snapshots` row. Recommend: `policy.freshness` when present, fall back to index-snapshot comparison.
3. **Citation definition** — every selected item has a `path`, so "has citation" must mean something stronger (e.g. carries a stable `source_hash`/symbol anchor). Need to confirm what "citation" means for this codebase's packs.

## Where to compute

Compute inside the retrieval/pack layer and surface on `runMetadata` so `push_context_pack` picks the keys up unchanged:
- Add a `quality_metrics` block to `search_context().runMetadata` (or a helper `compute_pack_quality(results, pack, budget)` called from `context_retrieval_metadata`).
- `context_pack_push.py` already maps `retrieval.get("precision_at_budget")` etc. — once `runMetadata` carries them, no push change needed (or thread them explicitly for clarity).

## Acceptance criteria

- AC1: A live run with real retrieval populates all four metrics with non-default values where applicable; a run with only required sources in budget yields `precision_at_budget` near 1.0.
- AC2: `citation_coverage` reflects the share of included items with provenance; an all-anchored pack ≈ 1.0.
- AC3: A pack that selected a stale-by-policy source reports `stale_count ≥ 1`; a clean pack reports 0.
- AC4: A retrieval that excluded a denied candidate reports `denied_count ≥ 1`.
- AC5: Unit tests for the pure `compute_pack_quality` function over fixtures (mirrors `evaluation` tests). No network/index dependency in the unit tests.
- AC6: New packs flow real values to ClickHouse `context_packs`; the Context Quality page leaves the "Not reported yet" state automatically once non-zero values arrive.

## Out of scope

- Backfilling historical packs (their inputs weren't captured; not recoverable).
- The eval-harness ground-truth precision (stays in `evaluation.py` for benchmarks).
- `repository_id` storage on `context_packs` (already fixed: column added + populated on ingest).
