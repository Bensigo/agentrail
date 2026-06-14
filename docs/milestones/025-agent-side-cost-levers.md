# Milestone 025: Agent-Side Cost Levers — Caching, Multi-Turn, Output Discipline

## Source

Product repositioning (see Milestone 022). Beyond context retrieval (fewer input
tokens on the first call), the largest remaining savings live in **agent-side
levers** that AgentRail can apply through the workflow, hook, MCP, and context
pack — all **agent surfaces**, with the results read by the human on the
dashboard (Milestone 023). Three levers, one already-flagged gap:

1. **Prompt / KV caching** (already in the plan)
2. **Multi-turn / cumulative measurement and dedup** (already in the plan)
3. **Output-token discipline** (the gap — not yet captured)

## Cost equation reminder

`cost = Σ over every call ( input × in_price + output × out_price + cached ×
read_price )`. Retrieval cuts first-call input. The levers below cut the other
terms: price-per-token (caching), call count and re-sent context (multi-turn),
and **output tokens** (discipline) — output is ~5× the price of input at every
Claude tier, and the comparable multiple holds on Codex/Cursor.

## Required Context

- `agentrail/context/packs.py` + `agentrail/context/retrieval.py`: the context
  pack is assembled here. Caching is a **prefix match** — any byte change in the
  prefix invalidates everything after it. AgentRail controls the pack, so it can
  structure packs as **stable prefix (repo/system context) + volatile suffix
  (the per-turn ask)** so the host's prompt cache hits (~0.1× input price on
  reads; writes break even after ~2 requests on a 5-min TTL).
- `apps/console/.../scorecard/page.tsx`: already records `cache_tokens` /
  `cache_ratio` — the measurement surface for lever 1.
- `agentrail/context/retrieval.py` `runMetadata`: per-call accounting; extend to
  cumulative, multi-turn cost (not single-shot).
- `templates/scripts/context-first.sh`, `.agentrail/hooks/context-first.sh`,
  `templates/AGENTS.md`: where agent output discipline is steered/enforced.

## Levers

### 1. Prompt-cache-friendly packs
Order pack content stable→volatile, deterministic serialization (no timestamps /
unsorted JSON / per-request IDs in the prefix), so repeated context re-sent each
turn is served from cache instead of re-billed. Make `cache_ratio` a target, not
just a metric.

### 2. Multi-turn cumulative measurement + cross-turn dedup
Track cumulative session cost across turns (where the compounding 50–70% lives),
and avoid re-sending / re-reading context the agent already has this session
(ties to Context Memory — advisory, source-linked, avoids re-derivation).

### 3. Output-token discipline (the new lever)
Reduce what the agent *writes* — the 5× side of the bill:
- **Suppress over-commenting** — no narrating-the-obvious code comments.
- **No unnecessary doc/file creation** — don't emit README/summary/scratch files
  the task didn't ask for.
- **Diffs over full-file rewrites** — patch, don't reprint whole files.
- **Terse output / effort calibration** — no preamble or routine-action narration
  between tool calls.
Steered via `AGENTS.md` + the context-first hook; **measured** as output tokens
per run on the dashboard so the saving is visible and itemized.

## Acceptance Criteria

- [ ] Context packs are assembled stable-prefix → volatile-suffix with
      deterministic serialization; a test asserts byte-identical prefixes across
      two turns with the same repo context (cache-eligible).
- [ ] `cache_ratio` is surfaced as a lever (target + $-left-on-the-table) — see
      Milestone 023 cache-hit panel; this milestone produces the cache-friendly
      packs that move it.
- [ ] `runMetadata` records cumulative multi-turn cost and cross-turn dedup
      savings (not only single-shot).
- [ ] Output-discipline guidance lives in `templates/AGENTS.md` and the
      context-first steering: no over-commenting, no unrequested doc/file
      creation, prefer diffs, terse between tool calls.
- [ ] Output tokens per run are recorded and attributable on the dashboard
      (feeds Milestone 023 savings attribution: the "output" source).
- [ ] Existing retrieval quality-gate fixture suite stays green; no workflow
      command removed or changed.

## Test Plan

- New: `tests/context/test_cache_friendly_packs.py` — same repo context across
  two turns yields a byte-identical cacheable prefix; a volatile-suffix change
  does not alter the prefix.
- New/extend: `tests/context/test_savings.py` — cumulative multi-turn savings is
  non-negative and decomposes by source (cache / retrieval / dedup / output).
- New: `tests/cli/test_output_discipline_steering.py` — `AGENTS.md` + hook carry
  the output-discipline guidance (assert presence of the steering strings).

## Likely Issue Slices

- Cache-friendly pack assembly (stable prefix / deterministic serialization)
- Multi-turn cumulative + cross-turn dedup accounting in `runMetadata`
- Output-discipline steering in `AGENTS.md` + context-first hook
- Output-token recording per run + attribution to the dashboard

## Blocked By

Milestone 022 (real-dollar cost engine — every lever's saving must be priced).

## Notes

- All three levers are **agent-surface** (pack assembly, hook, AGENTS.md,
  workflow); the human only ever sees the resulting savings on the dashboard.
- Output discipline must not degrade quality — the rule is "say less, not do
  less": fewer comments and files, same correctness. High quality without
  emptying the bank.
