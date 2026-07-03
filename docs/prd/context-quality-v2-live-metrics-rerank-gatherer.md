# PRD: Context quality v2 — live metrics, rerank, JIT gatherer

## Problem

Pack precision is 0.43 after the listwise rerank lifted it from 0.22: more than
half the pack tokens paid for on every run are noise. Target (set 2026-07-02):
**precision ≥0.7 AT recall ≥0.85 within budget** — never precision alone. Two
measurement facts block any honest hill-climb today:

- **Live runs never compute context metrics.** Precision/coverage are always 0
  in production; only the offline eval computes them, and even there the
  executor→RunResult hop is an open TODO (#994,
  `agentrail/evals/runner.py:468-483` hardcodes None).
- **The metric itself is broken for this purpose.** `precision_at_budget`
  (`agentrail/context/pack_quality.py:18-101`) is label-membership (sourceType /
  authority) over the FIXED `RETRIEVAL_MAX_TOKENS` denominator
  (`agentrail/context/packs.py:632-638`). A rerank that trims filler to a
  smaller, more relevant pack **lowers** the metric; relabeling authority or
  budget-stuffing raises it. It is doubly gameable and anti-correlated with the
  improvement it is supposed to validate.

## Goals

All workstreams below are built unconditionally, at production level. No
workstream is gated on another's results; the testing phase starts after all
build work is complete.

1. **Live metrics.** Real precision/recall from live runs, grounded in what
   the executor actually read.
2. **Recall + precision layers.** Query expansion + tree-sitter symbol-level
   candidates (recall); Haiku listwise rerank replacing lexical scoring +
   symbol packing (precision). "Eval-validated" made true via a real rerank
   arm.
3. **JIT gatherer.** The sequential context-gatherer subagent with a
   deterministic manifest handoff.
4. **Cost governance.** Per-layer cost telemetry through
   `agentrail/run/pricing.py`; $/solved non-regression enforced by the PRD4
   gate.

## Non-goals (these protect the objective — do NOT do them)

- Never optimize or gate on precision alone — it is gameable by dropping
  candidates; the bar is always joint precision+recall within budget.
- No parallel per-task fan-out gatherer (the 3–15× token regime). One
  sequential read-only gatherer is the research-validated exception.
- No merging the gather role into execute; the deterministic manifest handoff
  is the contract between them.

## Design

### Live metrics (producer-side wiring only)

Anchor files: `agentrail/run/pipeline.py:451` (`push_context_pack`),
`agentrail/run/usage_capture.py`, `agentrail/context/packs.py:632-638`,
`agentrail/context/pack_quality.py`. ClickHouse columns and the ingest route
already accept all the quality fields — nothing consumer-side to build here.

1. **Fix the push payload** — it currently reads precision from `runMetadata`
   instead of the persisted pack JSON; and unlinked runs (eval/canary) push
   nothing. Fix the source and extend the push so the runs the PRD4 gate reads
   are never dark.
2. **Executor-read logging WITHOUT runner instrumentation** — Claude
   transcripts (`~/.claude/projects/<encoded-cwd>/*.jsonl`) and Codex rollouts
   already sit on disk with full tool-use records, and `usage_capture.py`
   already has the cwd-encoding + since_ts machinery to locate them. Add a
   sibling of `capture_usage` that parses mid-run file reads and harvests them
   into run.json **before workdir teardown** (`native_runner.py` deletes the
   workdir and tails only 40 log lines). No new CLI flags or hooks needed for
   claude/codex.
3. **Per-engine coverage tags** — cursor/hermes have no transcript vehicle, and
   the hook vehicle (`agentrail/run/context_inject.py` — note the real path) is
   claude-only. Every read-derived metric carries the engine that produced it;
   uncovered engines report n/a, never a measured zero — the same n/a-vs-0
   hygiene the eval reporter already draws.
4. **Redefine the metrics:**
   - Live **precision** = tokens of pack files the executor actually read /
     actual pack tokens (actual-selected denominator). Label-share
     `precision_at_budget` may remain a diagnostic but must never gate.
   - Live **recall** = fraction of *pre-existing* files modified in the final
     accepted diff that were in the pack. Created files are excluded from the
     denominator; no-diff runs are a separate coverage count, NOT recall=0
     (15/21 recent eval failures produced no diff); cross-check against
     transcript reads, which capture read-not-edited files the diff proxy
     misses.
   - Free implicit labels for the feedback loop: pack files never read =
     precision waste; files the executor fetched itself = recall misses.

### Recall + precision layers

5. Query expansion + symbol-level candidates via tree-sitter (recall); Haiku
   listwise rerank (windows of ~10–20 candidates, sliding merge) replacing
   lexical scoring, plus packing symbols instead of whole files (precision).
6. **Make "validated via eval harness" true first**: add `rerank` to
   `LAYER_NAMES` plus a full-minus-rerank arm (the documented one-line
   extension, `agentrail/evals/arms/__init__.py:26-28` — no rerank arm exists
   today) AND an offline pack-vs-answer-key precision/recall scorer. Until both
   exist, no rerank change may claim eval validation.

### JIT gatherer

7. Single sequential read-only gatherer subagent (cheap Haiku-class model)
   restricted to the `agentrail context` tool; deterministic manifest handoff:
   paths + line ranges + pinned exact symbol names/signatures +
   checked-irrelevant negatives.
8. **Cache-safety is a hard requirement (#978):** the manifest is built ONCE
   per issue and injected verbatim into the byte-stable `shared_task_prefix`
   (`agentrail/run/prompts.py:327-361`); `pack_id` must be pinned (it currently
   embeds a per-build timestamp) so prefix identity holds across
   test-author/execute/verify. A per-phase rebuild thrashes the warm cache and
   erases the #978 win.
9. **New-phase seams that silently misroute:**
   `rc.phase_commands.get(phase, rc.agent_command)`
   (`agentrail/run/pipeline.py:364`) falls back to the implementer's expensive
   model — the gather phase must be explicitly enumerated with its cheap
   command; the phase whitelist in `agentrail/context/packs.py:562` must
   include `gather` or the pack is silently swallowed; the gatherer layer flag
   ships **default-OFF at merge** (deliberately inverting the layer_enabled
   default-ON pattern — rollout safety only, flipped on in the post-build
   testing phase); stale forced-context artifacts must be cleaned up when
   the flag flips.

## Measurement (definition of success)

- Live metrics done when a live run's run.json and the dashboard show non-zero
  read-grounded precision/recall with engine tags, and eval/canary runs push
  pack metadata.
- Overall success bar: precision ≥0.7 AT recall ≥0.85 within budget on the
  read-grounded metrics, solve-rate not worse, $/solved not worse (full vs
  full-minus-rerank arms); with the gatherer on, total tokens ≈ flat and
  executor-context tokens down materially.
- The testing phase starts after all build work is complete; the gatherer's
  default-OFF flag flips on there (rollout safety, not phase gating).

## Risks

- Metric gaming migrates (read-grounded precision is gameable by shipping tiny
  packs) → the joint precision+recall bar, separate coverage counts, and the
  $/solved backstop.
- Haiku rerank + expansion add spend → per-layer cost telemetry via pricing.py
  and the PRD4 non-regression gate.
- Transcript parsing is engine-version-coupled → tolerate-and-tag: unknown
  format ⇒ n/a for that run, never a zero.
