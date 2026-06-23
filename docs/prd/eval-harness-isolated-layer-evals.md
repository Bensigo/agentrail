# AgentRail Eval Harness — Isolated, Per-Layer Evaluation PRD

## Problem Statement

We believe AgentRail makes coding agents cheaper and more correct, but today that is a hunch, not a measurement. We cannot improve what we cannot measure, and right now we have no honest, repeatable way to answer two questions: *what is the harness actually good at?* and *which part of it is worth keeping?*

The harness is a stack of independent bets — context retrieval/packing, model routing/escalation, the Objective Gate, the retry loop, and guardrails — and they mask each other. An end-to-end win can hide a layer that is doing nothing or actively hurting. We already suspect this is happening (routing forfeits caching, the plan phase is pinned to an expensive model, the verify gate lets plausible-but-wrong PRs through with green CI), but we have no number that isolates any single layer's contribution.

What exists today is partial and not trustworthy as evidence:

- The offline retrieval evaluation grades the context layer against itself with no plain-agent or plain-grep baseline, so its recall/precision numbers cannot say whether AgentRail beats a dumb baseline.
- The end-to-end A/B protocol has the right shape (frozen tasks, baseline arm, repetitions) but has only ever been run at n=3 and is explicitly "directional only," not buyer-grade.
- Several live "context quality" metrics are always zero because the live runner never computes them — a false green that makes the dashboard lie.
- The autonomous loop ships PRs that pass their own checks and CI but fail human review. We have no metric that catches this "false green" before a human does.

Without isolated, honest measurement, every optimization is a guess, every regression is invisible until a human notices, and we cannot make a credible cost/quality claim to a buyer.

## Solution

Build a single eval harness that proves what the harness does and attributes the result to specific layers. It lives in a top-level `evals/` directory so any agent or developer can find it and understand "this is how we prove the harness works" without asking anyone.

The harness is one shared pipeline (a "spine") that every layer plugs into, rather than four drifting scripts:

```
frozen corpus → arm runner (sandbox) → hidden-test scorer → N repetitions → report (Postgres + committed markdown)
```

- **Frozen corpus.** A pre-registered set of real coding tasks. Each task is a repository pinned at a commit, a prompt/issue, a hidden test suite that proves the task was done correctly, a ground-truth required-context set, and a difficulty tag. Tasks are committed before any run so results cannot be cherry-picked.
- **Hidden-test scorer.** A task is *solved* if and only if its hidden tests pass. The hidden tests live in a separate location and are mounted into the sandbox only at scoring time, so the agent never sees the answer key. This is the only signal that cannot be fooled by code that merely looks finished — it is the direct countermeasure to the loop's false-green PRs.
- **Arms and leave-one-out ablation.** An "arm" is one configuration of the harness run against the same frozen tasks. We run a plain-agent baseline, a full-harness arm, and one ablation arm per layer with exactly one layer turned off. A layer's worth is `full` minus `full-without-that-layer` on the same scorer. A large positive delta means the layer earns its place; a zero or negative delta means it should be fixed or removed.
- **Repetitions and variance.** Agents are non-deterministic, so each (task, arm) pair runs N≥5 times with a pinned model and temperature. We report the mean *and* the spread, because a harness that solves 9/10 is a different product from one that solves 5/10 at the same average.
- **Cost per solved task.** The headline cost metric is dollars per *solved* task, computed through the existing single-source pricing module — never cost per task (which rewards failing cheaply) and never success without cost (which rewards burning an expensive model on everything).
- **Intrinsic probes.** Beyond solve-rate, each layer reports one measurement that hidden tests cannot see — most importantly the Objective Gate's false-green rate (of runs the gate passed, how many fail the hidden tests).
- **Honesty rails.** Pre-registered tasks, a held-out task split never looked at during development, difficulty stratification, and reporting of failures/ties/spread rather than only wins.

Results land in Postgres so the existing console can surface real, computed numbers — closing the "metrics always zero" false green — and a dated markdown report is committed alongside the corpus.

## User Stories

1. As a harness maintainer, I want a repeatable eval that returns a single solve-rate number, so that I can tell whether a change made the harness better or worse.
2. As a harness maintainer, I want each coding task to carry a hidden test suite the agent never sees, so that "solved" cannot be faked by code that only looks finished.
3. As a harness maintainer, I want hidden tests mounted only at scoring time, so that the answer key never leaks into the agent's context.
4. As a harness maintainer, I want a plain-agent baseline arm, so that every AgentRail number is a comparison and not an unanchored figure.
5. As a harness maintainer, I want each layer turned off in its own arm, so that I can attribute the result to a specific layer via leave-one-out ablation.
6. As a harness maintainer, I want the per-layer delta reported as `full` minus `full-without-layer`, so that I can see exactly what each layer is worth.
7. As a harness maintainer, I want layers with zero or negative delta surfaced, so that I know what to fix or remove.
8. As a harness maintainer, I want each task and arm run at least five times, so that randomness does not masquerade as signal.
9. As a harness maintainer, I want the spread reported alongside the mean, so that I can distinguish a reliable harness from a lucky one.
10. As a harness maintainer, I want cost reported as dollars per solved task, so that cheap failures and expensive successes both score badly.
11. As a harness maintainer, I want all dollar math routed through the existing pricing module, so that cost numbers stay consistent across the system.
12. As a harness maintainer, I want the Objective Gate's false-green rate measured, so that I can quantify how often it passes work that actually fails the hidden tests.
13. As a harness maintainer, I want the routing layer's model-choice-vs-difficulty and cost regret measured, so that I can tell whether routing actually saves money.
14. As a harness maintainer, I want the retry loop's solve-rate lift and wasted-retry cost measured, so that I can tell whether retries pay for themselves.
15. As a harness maintainer, I want guardrails measured against an injection corpus (secret in diff, deleted test), so that I can confirm the safety floor actually catches violations.
16. As a context engineer, I want the offline retrieval eval to gain a plain-grep baseline arm, so that recall and precision numbers mean something relative to a dumb baseline.
17. As a developer, I want all evals under a single top-level `evals/` directory, so that I can find and understand them without asking anyone.
18. As a developer, I want a README in `evals/` explaining what an eval is and how to run one, so that I can onboard without tribal knowledge.
19. As a developer, I want the corpus tasks committed before runs, so that nobody can cherry-pick tasks after seeing results.
20. As a developer, I want a held-out split of tasks never used during development, so that we do not overfit the harness to its own eval.
21. As a developer, I want tasks tagged by difficulty, so that we can report that the harness's edge is large on hard, scattered-context tasks and small on easy ones rather than hiding it in one average.
22. As a developer, I want corpus v0 seeded from our own already-merged issues that shipped with tests, so that we get honest ground truth at low cost.
23. As a developer, I want a CLI entry point to run an eval over a chosen corpus and set of arms, so that running an eval is one command.
24. As a developer, I want each run executed in the existing sandbox, so that evals reuse the production isolation path rather than inventing a new one.
25. As an operator, I want eval results written to Postgres, so that the console can display real computed numbers instead of always-zero placeholders.
26. As an operator, I want a dated markdown report committed per run, so that historical results are auditable in git.
27. As a maintainer, I want failures and ties reported, not just wins, so that the eval stays honest.
28. As a buyer-facing stakeholder, I want the end-to-end cost/quality comparison hardened beyond n=3, so that the number is credible outside the team.
29. As a maintainer, I want adding a new task to the corpus to be a documented, low-friction step, so that the corpus can grow over time.
30. As a maintainer, I want a new layer to be evaluable by adding one ablation arm, so that the eval scales as the harness grows.

## Implementation Decisions

- **Single shared spine, many probes.** Build one pipeline — corpus loader → arm runner → scorer → repetition controller → reporter — and plug layer-specific probes into it, rather than separate scripts per layer. This keeps "eval every layer" maintainable.
- **Ground truth is hidden held-out tests.** Solved is defined solely by a hidden test suite passing. Hidden tests are stored separately from the task's working tree and are mounted into the sandbox only during scoring, never during the agent run. This is the single most important decision and the direct countermeasure to false-green PRs.
- **Isolation by leave-one-out ablation.** The arms are: `baseline` (plain agent, no AgentRail), `full` (everything on), and one `full-minus-<layer>` arm per layer (context, routing, verify gate, retry, guardrails). Each layer's contribution is the difference between `full` and the arm with that layer removed. Everything else is held fixed: same tasks, same repo snapshot, same model, same temperature, same limits.
- **Modules to build (deep, testable in isolation):**
  - *Corpus module* — loads and validates frozen tasks; each task carries repo+commit, prompt, hidden-test reference, required-context set, and difficulty tag. Reuses the fixture-loading shape already established by the offline retrieval evaluation. Pure and deterministic; trivial to test.
  - *Arm module* — declarative description of a harness configuration (which layers on/off, which model is pinned). No execution logic; just configuration the runner consumes. Adding a layer means adding one ablation arm here.
  - *Runner module* — takes (task, arm) and executes one run inside the existing sandbox, returning a raw run record (diff produced, tokens, model used, wall time, gate decisions, retry events). Wraps the sandbox; does not reimplement isolation.
  - *Scorer module* — takes a run record plus the task's hidden tests and returns pass/fail and the per-layer probe metrics (false-green for the gate, cost regret for routing, retry lift, guardrail catch rate). Deep and pure given its inputs.
  - *Pricing adapter* — all dollar figures computed through the existing single-source pricing module; the eval never hard-codes prices.
  - *Reporter module* — aggregates repetitions into per-arm solve-rate, dollars-per-solved-task, token totals, variance/spread, and per-layer deltas; emits a dated committed markdown report and writes the same numbers to Postgres for the console.
  - *Context-layer baseline arm* — extend the existing offline retrieval evaluation with a plain-grep baseline arm so its recall/precision become comparative.
  - *CLI command* — one entry point to run an eval over a chosen corpus and set of arms with a repetition count.
- **Directory layout.** Everything lives under a top-level `evals/` directory: `corpus/` (frozen tasks + hidden answer keys), `arms/` (arm configs), `runner/`, `scorer/`, `reports/` (dated committed results), and a `README.md`. A new developer should understand the eval from this directory alone.
- **Honesty rails encoded, not optional.** Corpus tasks are committed before runs (pre-registration); a held-out split is reserved and never inspected during development; tasks are stratified by difficulty (proxied by required-context scatter); reports always include failures, ties, and spread.
- **Repetitions and pinning.** N≥5 repetitions per (task, arm), with model and temperature pinned and recorded on every run.
- **Persistence reuses existing surfaces.** Results write to Postgres using existing run/metrics surfaces so the console shows real numbers, finally replacing the always-zero context-quality placeholders.
- **Phasing.** (1) Spine + scorer + corpus v0 (~10 tasks seeded from our own merged, test-bearing issues) + baseline and full arms. (2) Ablation arms for per-layer deltas. (3) Intrinsic probes, false-green for the Objective Gate first. (4) Held-out split, difficulty stratification, and console wiring.

## Testing Decisions

- **Test external behavior, not internals.** A good test fixes the inputs to a module and asserts on its observable output, so that we can refactor a module's internals without rewriting its tests.
- **Scorer module is the priority for tests.** Given a fixed run record and a fixed hidden-test result, assert the correct solved/failed verdict and the correct probe metrics (especially false-green: a run whose gate passed but whose hidden tests failed must be counted as a false green). This module carries the most truth and must be airtight.
- **Corpus module tests** assert that valid task definitions load and that malformed ones (missing hidden tests, missing required-context, bad difficulty tag) are rejected with clear errors — mirroring how the existing retrieval evaluation validates its fixtures.
- **Reporter module tests** assert that a fixed set of repetition records aggregates into the correct solve-rate, dollars-per-solved-task, spread, and per-layer delta — including that an all-failure arm reports zero solved and does not divide by zero on cost-per-solved.
- **Pricing adapter tests** assert that token counts map to the same dollar figures the existing pricing module produces, so eval cost stays consistent with the rest of the system.
- **Prior art.** The existing offline retrieval evaluation and its fixture tests are the model for fixture-driven, deterministic eval tests; the existing cost-baseline tests are the model for pricing-backed assertions.
- **Runner is integration-tested sparingly.** The runner depends on the sandbox and a real agent, so it is covered by a small number of integration runs rather than fine-grained unit tests; its output contract (the run record shape) is what the scorer tests depend on and is asserted there.

## Out of Scope

- Authoring a large benchmark. Corpus v0 is ~10–15 tasks; growing it to a buyer-grade benchmark is ongoing work, not part of the initial build.
- LLM-judge and human-review scoring paths. This PRD commits to hidden held-out tests as the sole ground truth; rubric/judge scoring for tasks that lack hidden tests is a possible later extension.
- A bespoke eval UI. Results surface through the existing console; no new dashboard pages are built here.
- Real-time/online evaluation inside live production runs. This harness is offline and deliberate; wiring live runs to compute these metrics continuously is future work.
- Changing the harness layers themselves. This PRD measures the layers; acting on the findings (fixing routing, the gate, etc.) is downstream work the eval exists to inform.
- External public benchmarks (e.g. swapping in a third-party task suite). The structure is SWE-bench-shaped, but adopting an external suite is not in scope.

## Further Notes

- The expensive, irreplaceable asset is the corpus — tasks with honest hidden answer keys. Everything else is plumbing. Our own already-merged issues that shipped with tests are a free, high-quality source because the human-accepted version already came with its proof.
- The harness's value is non-uniform: largest on hard tasks with scattered context, smallest on easy single-file tasks. Reporting per difficulty stratum is therefore not optional polish — a single aggregate number actively hides the real story.
- The false-green rate of the Objective Gate is the most operationally important number we do not currently have; it quantifies, before a human notices, how often the autonomous loop ships work that passes its own checks but fails the hidden tests.
- This work makes previously-always-zero context-quality metrics real by computing them offline and persisting them, but it does not by itself make the *live* runner compute them — that remains a separate gap.
