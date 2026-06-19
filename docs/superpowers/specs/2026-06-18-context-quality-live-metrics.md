# Spec: Live Context-Quality Metrics

**Date:** 2026-06-18
**Status:** Approved — producer implemented (`agentrail/context/pack_quality.py`, wired into `search_context().runMetadata`)
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

### Final decisions (as implemented)

`compute_pack_quality(selected, excluded, selected_context_tokens)` in `agentrail/context/pack_quality.py` is pure and total (never raises). `search_context()` calls it from the richer **pre-compaction** items (`raw["results"]`, which carry `sourceType`/`authority`/`freshness`/`contentHash`/`textHash`) — the compacted `results` list drops those fields — while overriding each item's `tokenEstimate` with the compacted value so the precision denominator stays aligned with `selectedContextTokens`. Excluded items come from `raw["excluded"]`.

1. **Precision numerator — required/anchor token share.** Required signal is `sourceType ∈ {context_doc, taste_doc}` when an item carries a `sourceType`/`kind`; otherwise it falls back to `authority == "critical"` (the top authority tier per `score_authority`). `precision_at_budget = sum(tokenEstimate of required selected items) ÷ selected_context_tokens`, clamped to `[0,1]`; `0.0` when `selected_context_tokens <= 0`. (No score threshold — deterministic.)
2. **Citation = stable provenance hash share.** A selected item counts only if it carries a non-empty `contentHash` or `textHash`; a bare `path`/`citation` does NOT count (the always-present `citation` is why the dashboard read 0). `citation_coverage = hashed selected ÷ total selected`; `0.0` when no selected items.
3. **Stale = freshness status.** `stale_count` = selected items whose freshness status ∈ `{stale, expired}`. Freshness is tolerated as either a dict `{"status": ...}` (the real shape on source objects) or a plain string.
4. **Denied = excluded visibility/authority.** `denied_count` = excluded items with `visibility == "denied"` OR `authority == "denied"` (fields are **flattened** on excluded items here, not nested under `policy` as in `evaluation._candidate_leaks`).
5. **source_hash_list** = ordered stable hashes of selected items (`contentHash` preferred, else `textHash`), skipping empties.

Index-snapshot comparison for staleness was NOT used: the retrieval engine already populates `freshness.status` on every source (`stale`/`expired`/`current`), so the live signal needs no DB round-trip.

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
