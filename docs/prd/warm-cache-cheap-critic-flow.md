# PRD: Warm-cache + cheap-critic best-of-N flow

## Problem

Each run of our pipeline solves one task with **three cold agent phases** —
test-author → execute → verify — where every phase is a fresh agent process
that re-loads the repo context from scratch, and the `verify` phase uses a
*separate, expensive model*. Measured cost of this: ~15–19 min of real agent
work per task (confirmed 2026-06-24: the work is genuine, not a hang). Because
the eval runs this exact same flow per task per arm, the flow's latency is also
why a full eval run takes hours and never completes in a bounded environment.

Deep research (2026-06-24, 22 verified claims, see
`memory/agent-flow-research-2026-06.md`) on how leading coding-agent systems
balance quality vs cost/latency converged on a clear, evidence-backed answer:
**keep the multi-role separation that protects quality, but (a) stop paying for
cold context on every phase and (b) replace the expensive end review with a
small fast critic that ranks a few attempts and stops early.** OpenHands' critic
took SWE-bench Verified 60.6%→66.4% and reached near-best quality in ~1.35
attempts instead of 8 (~83% fewer rollouts); Aider's reason/edit split lifted
pass-rate ~80%→85%.

## Goals

1. Cut per-task cost and latency by removing redundant cold-context loads across
   phases (prompt-cache prefix reuse) — **without** changing what each phase does.
2. Replace the single expensive `verify` pass with a **cheap critic + best-of-N
   early stopping**: generate a small number of candidate fixes, have a cheap
   model score them, keep the best, stop as soon as the critic is confident.
3. Keep every anti-false-green guarantee intact (see Non-goals).
4. Make every new piece **measurable and ablatable** by the eval (a dedicated arm
   + layer toggles), so we can prove the change is cheaper/faster and at least as
   correct before it becomes the default.

## Non-goals (these protect quality — do NOT do them)

- **Do NOT merge the test-author and executor into one shared conversation.**
  Research refuted that a single agent authoring its own validating tests and the
  fix is as good — it yields tautological tests (the exact false-green the harness
  exists to catch). "Warm" here means a reused *cache prefix*, not a merged role.
- **Do NOT let the executor grade its own work.** The critic stays an INDEPENDENT
  step (research refuted collapsing the reviewer into the executor). It just
  becomes cheap.
- **Do NOT touch the hidden-test scorer or the Objective Gate.** The final
  falsifiable "done" check is unchanged — it is the un-foolable truth.
- **Do NOT fan out many full agents per task.** Research: 3–10× tokens, usually no
  quality gain. Best-of-N here means a few *cheap* candidate fixes ranked by a
  cheap critic, not parallel full pipelines.

## Design

Anchor files: `agentrail/run/pipeline.py` (`_run_pipeline`, `run_issue_phase`,
the test-author→execute→verify sequence, `layer_enabled`), `agentrail/evals/arms.py`
(arm definitions + layer names), `agentrail/evals/spine.py` (arm execution).

1. **Critic seam** — a small, model-backed interface that takes a candidate
   change + task context and returns a cheap score/verdict (default model: a fast
   cheap tier, e.g. Haiku). No training required for v1; a learned critic is a
   later option. Independent of the executor.
2. **Best-of-N execute** — the execute phase produces N candidate fixes (small N,
   e.g. 2–3) instead of one; the critic ranks them; early-stop when a candidate
   clears the critic's confidence bar. Replaces the blind 5× retry loop.
3. **Critic-gated review** — the cheap critic replaces the expensive distinct-model
   `verify` phase as the independent reviewer feeding the Objective Gate. The
   gate's accept/reject contract is unchanged; only the reviewer's cost changes.
4. **Warm cache prefix** — make the large shared context (repo files / task) a
   stable cacheable prefix reused across phases, so each phase pays for cached
   input rather than a cold re-read. No role merge.
5. **Eval arm + layer toggles** — add a `full` vs new-flow arm and `AGENTRAIL_EVAL_LAYER_*`
   toggles for the critic / best-of-N / warm-cache pieces, so the eval ablates
   each and reports the cost/latency/solve-rate delta.

## Measurement (definition of success)

Run the eval `full` (today's flow) vs the new-flow arm on the corpus and compare:
- **$/solved** and **wall-time/task** strictly lower for the new flow, AND
- **solve-rate** (hidden tests) ≥ today's, AND
- **false-green rate** not worse.
If any of those fails, the new flow does not become default.

## Risks

- Best-of-N candidate generation could itself add cost if N is too large or the
  critic is weak → keep N small, gate behind a layer toggle, measure.
- A cheap critic may under-catch vs the expensive reviewer → the hidden-test gate
  still backstops in eval; in production the Objective Gate (deterministic checks)
  remains the hard gate, so a weak critic degrades selectivity, not safety.
- Cache-prefix reuse must not leak the answer key or cross-task state → reuse is
  per-task context only.
