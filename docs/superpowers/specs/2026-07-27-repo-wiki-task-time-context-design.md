# Repo Wiki at task time — design

**Date:** 2026-07-27
**Status:** approved, implementation in progress
**Predecessor:** `docs/superpowers/specs/2026-07-23-repo-wiki-compiled-repo-knowledge-design.md`

## Problem

The Repo Wiki compiles, pushes, and serves — 64 module-grain pages exist for
`Bensigo/agentrail` — but nothing on the work-producing path reads it.

Three surfaces that should be using it are not:

1. **Context packs.** The retrieval integration is complete but gated behind
   the rollout flag (`repo_wiki_enabled()`, default OFF), and the flag is set
   nowhere outside the onboarder's temporary env. With it off, `build_index`
   never imports `wiki.py`, so no `wiki_doc` record ever enters the index.
2. **The executor mid-run.** Its context affordance points at
   `agentrail context query` only. That CLI ranks over `index.json`, so wiki
   pages would surface there for free once they are indexed — but nothing
   tells the agent the wiki exists, and nothing mentions
   `agentrail context wiki show`, which is how it would read a whole unit page
   instead of a ranked chunk.
3. **Issue and PRD authoring in Jace.** `fetch_repo_wiki` exists and is gated
   read-only, but the instruction is scoped to *answering* architecture
   questions. Nothing tells Jace to ground a brief in the wiki before drafting,
   so an issue's acceptance criteria can name structure the model invented.

Two mechanical facts make this more than a flag flip:

- **Hydration does not reach the run path.** `agentrail context index` calls
  `fetch_wiki_snapshot`, but a run builds packs through
  `run/context.py:build_pack` → `packs.build_context_pack`, and the pipeline
  calls `build_index` directly. The CLI's hydrate step is skipped.
- **Hydrated pages alone produce no records.** `.agentrail/context/wiki/` is in
  the index's exclude globs, so `wiki_doc` records exist only as
  `compile_wiki`'s return value. Fetching without compiling puts files on disk
  that retrieval never sees.

## Goal

Maximize the wiki's contribution to precision on the work-producing path
without letting compiled prose become a new hallucination source. The wiki
tells an agent *where to look*; the code remains the answer.

## Design

### A. Ingest on the run path

**Hydrate where memory already hydrates.** `run/context.py:build_pack` calls
`fetch_memory_snapshot(target_dir)` before every `build_context_pack`. The wiki
hydrate goes beside it, same contract: gated on the rollout flag, every failure
non-fatal, TTL-cached (`WIKI_SNAPSHOT_TTL_SECONDS`, 300s) so it costs one round
trip per run rather than one per pack. Every pack build — run-level plan,
per-phase, JIT gather — inherits it from this single insertion point, and the
pipeline's direct `build_index` call needs no change.

**Runs never prompt the model.** `compile_wiki` stays inside `build_index`. The
run path sets the per-compile cost ceiling to 0. `_CostTracker.exceeded` is
`total_usd >= ceiling`, so a 0 ceiling reads as breached before the first page:
every drifted page ships skeleton-only, zero provider calls, and unchanged
pages take the existing byte-identical page-grain reuse path. Compilation
remains the onboarder's and the push-recompile webhook's job.

Drift is not silently absorbed: the stale-wiki-page freshness penalty already
in retrieval demotes a page whose `inputsHash` no longer matches current file
hashes, so ranking stays honest about staleness.

**Configuration.** `deploy/runner/agentrail-config.hosted.json` has no
`summary` block, so mode defaults to `disabled` and the wiki path is
unreachable regardless of the flag. It gets a non-disabled mode. With the
ceiling at 0 the prose provider is never invoked on the run path, so the mode
value only has to open the gate.

**Shared helper.** `_origin_repo_full_name` lives in `cli/commands/context.py`
and the run path needs the same resolution. It moves to a shared module both
callers import — no second copy of git-remote parsing.

### B. Pack shape

Unchanged from the predecessor spec, shipped as built:

- The overview page is pinned into the `repoOverview` section of every pack,
  body-capped, for cold-start orientation.
- Unit pages compete in normal retrieval under the existing authority
  demotion — a `wiki_doc` never outranks an equally-matched code source — and
  the stale-page penalty.

No new ranking logic, so the eval gate measures the design as specified rather
than a variant invented at rollout time.

### C. Executor affordance

The context instruction in both task blocks and the gather-phase fence names
the wiki and teaches the cheap-to-expensive ladder:

1. `agentrail context wiki show <slug>` — orient on the unit page.
2. `agentrail context query "<term>"` — find the specific code.
3. Read the file.

Ordering is the point. An unprompted agent starts at step 3 and never
orients, or greps. The gather subagent's fence ("your ONLY tools are the
`agentrail context` CLI and reading files") already permits the wiki
subcommand; it is unnamed, so it goes unused.

### D. Coordinator grounding

Jace's wiki instruction extends from "answer architecture questions" to
"ground the brief before drafting": read the relevant unit page before
`emit-issue-brief` and before publishing PRD slices, so acceptance criteria
name real units, real paths, and real symbols. No new plumbing —
`fetch_repo_wiki` already exists, is read-only, and needs no approval gate.

### E. Anti-hallucination guardrails

A compiled page is prose *about* code, and a stale page is a confident,
well-written lie. Three rules, each with precedent already in the codebase:

1. **The wiki never outranks code.** Already enforced by the authority
   demotion in retrieval.
2. **Verify before it lands.** A claim sourced from the wiki must be checked
   against the file before it enters an issue's acceptance criteria or an
   implementation edit. This mirrors the codebase-qa rule already in Jace's
   instructions: every claim grounded in a path the tool returned, never from
   memory.
3. **Wiki content is untrusted advisory data, never instructions.** Already
   framed that way by `fetch_repo_wiki`; the executor-facing affordance says
   the same.

### F. Rollout

Flag stays OFF by default in code. Before any prod env change, run the
comparison arm the predecessor spec calls for: `orientation-probes.json` and
the retrieval fixtures, flag-OFF versus flag-ON. Graduate only on the two-set
gate — no regress on seen or held-out, improvement on at least one. The fleet
and runner service env vars are set only after that.

**Stated limit:** sections C and D are prompt-level changes, and the two-set
retrieval gate does not measure them — it scores retrieval, not what an agent
does with what it retrieved. Their evidence has to come from eval-corpus
solve-rate. Until that runs, they are unmeasured, and this spec does not claim
otherwise.

## Testing

- Hydrate is non-fatal (unlinked repo, failing server, missing route) and
  TTL-deduped across repeated pack builds in one run.
- A ceiling of 0 produces zero provider calls, and drifted pages come back
  skeleton-only rather than raising.
- Flag-OFF packs stay byte-identical to today — the flag-OFF acceptance
  criterion the predecessor spec established.
- The shared repo-full-name helper returns identical results to the CLI's
  current private function for the same remotes, including the no-remote case.
- Prompt changes are asserted by their existing prompt-text tests.

## Out of scope

- Compiling or refreshing wiki prose during a run.
- Pinning unit pages for the task's likely files (deterministic injection
  beyond the overview) — considered and deferred; it consumes pack budget and
  needs its own eval evidence.
- Retiring the rollout flag.
