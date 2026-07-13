# PRD: Langfuse tracing + shadow-judge integration (agentrail + Jace)

## Problem

No tracing/observability infrastructure exists anywhere in this repo today — zero OpenTelemetry
or equivalent instrumentation. All "observability" is bespoke JSON: `.agentrail/runs/<run-id>/run.json`,
`cost-events.jsonl`, `verify/status.json`, hand-assembled into records by `agentrail run-records`
and read line-by-line by the run-forensics sonnet judge (epic #1168). That loop works — it has
already shipped one fix (#1181 → PR #1183) — but it is expensive to read by hand, has no
visualization, and its own cost ledgers are 0/54 populated in dogfood history: a known, unresolved
gap, because cost tracking is hand-rolled through `agentrail/run/pricing.py` with no per-call trace
to hang it on.

Jace (the Eve-based coordinator) has no cost/token tracking beyond Eve's own automatic `$eve.*`
workflow tags, and no tracing at all. Its three subagents (triage, researcher, QA) each produce a
structured verdict today, but nothing records the invoke → output → verdict lifecycle around them.

## Goals

1. Real distributed tracing for both agentrail's SDLC/AFK run loop and Jace's Eve-based subagents,
   against a locally self-hosted Langfuse instance for dev.
2. Real per-phase / per-call cost data in Langfuse, reusing agentrail's existing `pricing.py` as the
   single source of dollar truth — not Langfuse's own model-price table.
3. Shadow-judge: push the verdicts that already exist (agentrail's sonnet run-forensics judge; Jace's
   triage and QA subagent verdicts) into Langfuse as custom scores attached to their traces — additive
   telemetry only, no new judge logic.

## Non-goals

- No production/cloud Langfuse rollout. This phase is local dev only; cloud configuration is a
  separate, later decision.
- No replacement of the hidden-tests gate or the run-forensics ledger/issue-filing loop. They remain
  the sole real arbiter of correctness.
- No use of Langfuse's managed, UI-configured LLM-as-a-judge evaluator. "Shadow-judge" here means
  piping our own existing judge verdicts in as custom scores via the API — not adopting a
  Langfuse-managed judge.
- No replacement of the `agentrail/evals/` harness (corpus/arms/runner/scorer/reporter).
- No console/dashboard UI work.

## Design

Anchor files:
- `agentrail/run/pipeline.py` — `_run_pipeline` (:1084, run start/finish), `run_issue_phase` (:310),
  cost-capture block (:523-544)
- `agentrail/run/pricing.py` — `cost_usd`, `cost_breakdown`
- `agentrail/afk/runner.py` — `Runner._implement` (:243, subprocess boundary)
- `.memory/forensics/` ledger + sonnet judge (run-forensics loop, epic #1168)
- `apps/jace/agent/instrumentation.ts` (new — Eve's auto-discovered OTel seam, unused today)
- `apps/jace/agent/hooks/` (new — Eve `defineHook`, directory doesn't exist yet)
- `apps/jace/agent/subagents/{triage,researcher,qa}/`

1. **Local Langfuse instance.** `docker compose up` from Langfuse's own repo at `localhost:3000` —
   no persistence, dev-only, per Langfuse's own docs ("ideal for testing... not suitable for
   production"). Both systems read `LANGFUSE_HOST` / `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`
   from env; unset by default so the integration is opt-in.

2. **Agentrail tracing.** A new thin wrapper module (e.g. `agentrail/observability/langfuse_tracer.py`)
   using Langfuse Python SDK v3 (`@observe`, OpenTelemetry-based — the current recommended pattern,
   not the legacy low-level client). One trace per `_run_pipeline()` invocation; one generation per
   `run_issue_phase` call. The generation's `usage_details` / `cost_details` are populated from the
   *already-computed* `cost_usd()` / `cost_breakdown()` values — Langfuse's own model-price lookup is
   never invoked, so there is exactly one source of dollar truth.

3. **Subprocess trace linking.** AFK's `Runner._implement` shells out to the `agentrail` CLI as a
   subprocess rather than calling the pipeline in-process, so there is no true parent-child span
   across that boundary. Propagate a shared identifier (e.g. `AGENTRAIL_LANGFUSE_SESSION_ID`, one per
   AFK run) and use Langfuse's `sessionId` grouping to link every phase's trace under one session,
   instead of forcing artificial span nesting across a process boundary.

4. **Agentrail shadow-judge.** After the existing sonnet run-forensics judge produces its verdict for
   a run (unchanged), additionally call Langfuse's `create_score` API to attach that same verdict to
   the run's trace, looked up by `run_id`. The `.memory/forensics/` ledger and issue-filing flow are
   untouched — this is a pure additional sink for an existing signal.

5. **Jace tracing.** `apps/jace/agent/instrumentation.ts` is Eve's auto-discovered OTel export seam.
   Install `@langfuse/vercel-ai-sdk` + `@langfuse/tracing` + `@langfuse/otel`, since Jace's model calls
   already route through the `ai` package (`ai@7.0.11`) — this traces every model call (root Jace and
   all subagents) with minimal manual span code. The exporter setup also captures Eve's automatic
   `$eve.*` workflow tags (token counts, session/turn/subagent tree) so cost is read from the
   framework, not reconstructed by hand.

6. **Jace subagent-boundary spans.** New `apps/jace/agent/hooks/`, using Eve's `defineHook` subscribed
   to `turn.started` / `turn.completed` / `action.result`, emits spans around each subagent's
   invoke → output → verdict lifecycle (triage, researcher, QA). Eve hooks are observe-only — exactly
   the right constraint here, since tracing must never mutate agent context.

7. **Jace shadow-judge.** Pipe the triage subagent's structured verdict and the QA subagent's verdict
   into Langfuse as custom scores on their corresponding traces — the same additive pattern as
   agentrail's shadow-judge, no new judge logic invented for Jace.

8. **Feature flags.** Both integrations ship default-OFF (`AGENTRAIL_LANGFUSE_ENABLED` for agentrail;
   an equivalent env check inside `instrumentation.ts` for Jace), matching this repo's standing
   rollout-safety convention.

## Measurement (definition of success)

- A real agentrail run (dogfood or eval-harness run, with the flag on) produces a Langfuse trace with
  correct phase-level generations, whose cost figures match `pricing.py`'s own computed cost for that
  run bit-for-bit — asserted via the Langfuse API, not a manual UI check.
- A real Jace triage-subagent invocation produces a trace with a linked custom score matching the
  subagent's actual structured verdict.
- With the flag off, both integrations are provably inert: zero behavior change to the hidden-tests
  gate, the run-forensics ledger, or any subagent's verdict logic.

## Risks

- **Subprocess trace-context boundary** (AFK → `agentrail` CLI) is the trickiest piece of this design;
  session-grouping is a deliberate fallback, not true span nesting — call this out plainly rather than
  pretend it's seamless.
- **Duplicated cost-of-truth risk**: if Langfuse's own price-table lookup is left enabled instead of
  always passing explicit `cost_details`, agentrail ends up with two disagreeing dollar figures for
  the same run. Explicit `cost_details` on every generation is a hard requirement, not an
  optimization.
- **Eve churn**: Eve is pinned to an exact version (v0.19.0) because it is pre-1.0 and ships roughly
  41 releases per two weeks. The `instrumentation.ts` / `defineHook` surface used here should be
  treated as version-pinned and re-verified on any Eve bump.
- **Local-only scope creep**: nothing in this design should require or assume Langfuse Cloud
  credentials. Keep production/cloud entirely out of this PRD's code paths so local dev tooling
  doesn't silently become a production dependency.
