# PRD: Langfuse tracing + evals — the self-improvement substrate

## Problem

No tracing infrastructure exists in this repo — zero OpenTelemetry anywhere. Observability is
bespoke JSON (`.agentrail/runs/<run-id>/run.json`, `cost-events.jsonl`, `verify/status.json`)
hand-assembled by `agentrail run-records` and read line-by-line by the run-forensics sonnet judge
(epic #1168). That loop works — it shipped #1181 → PR #1183 — but it is manual, has no
visualization, no failure-history queries, and no way to prove a fix killed a failure class
rather than just closing an issue. Jace (Eve-based coordinator) has no tracing or cost tracking
at all beyond Eve's automatic `$eve.*` workflow tags.

The deeper problem: the improvement loop is open. We record runs and judge them, but deviations
become issues by hand, fixes are validated by re-reading logs by hand, and nothing accumulates
into a regression corpus. For a reliable, cost-effective factory, the loop must close: every
failure observed → queryable → becomes a test case → every fix proven against that test case.

## Goals

1. **Tracing** for both agentrail's SDLC/AFK run loop and Jace's Eve subagents, against a locally
   self-hosted Langfuse (persistent named volumes — history survives restarts; cloud is a later,
   separate decision for prod).
2. **Cost with one price source.** `agentrail/context/pricing.py:PRICE_TABLE` remains the sole
   dollar truth for both systems; Langfuse never invents a price we didn't give it.
3. **Truth-scores + shadow-judge with a calibration gate.** Hidden-test outcomes and verify-gate
   verdicts land on traces as scores (the ungameable signal); the existing sonnet forensics judge's
   verdict lands beside them; agreement between the two is a tracked metric with a named consumer.
4. **Self-improvement substrate.** Failing traces, tagged by failure fingerprint, become Langfuse
   dataset items; fixes are validated by experiments against those datasets. This is the loop
   #1172/#1173 asked for, and this PRD is the vehicle that subsumes them.

## Non-goals

- No production/cloud Langfuse in this phase (config isolation: nothing here may require cloud creds).
- No Langfuse managed UI-configured LLM-as-a-judge evaluator. Shadow-judge = our own judges pushing
  scores via API (`create_score`). Adopting the managed evaluator is a possible later phase, gated
  on calibration data.
- The hidden-tests gate and the `.memory/forensics/` issue-filing contract are not touched. They
  remain the final arbiter; Langfuse informs them, never replaces them.
- No console UI work.

## End-state: what retires, what stays

This integration must consolidate, not become a third observability system.

| Surface | Fate | When |
| --- | --- | --- |
| Hidden-tests gate (`agentrail/evals/` scorer) | **Stays forever** — final arbiter | — |
| `pricing.py` / `PRICE_TABLE` | **Stays forever** — single price source | — |
| `.agentrail/runs/<id>/` artifacts (run.json, verify/status.json) | **Stay** — runner-local ground truth the pipeline itself consumes | — |
| `cost-events.jsonl` + console cost push | **Retires** once Langfuse cost parity is proven bit-for-bit over one full dogfood batch | Phase 2 exit |
| Judge reads hand-assembled `run-records/*.json` | **Migrates** — judge queries traces via Langfuse API; `run-records` CLI stays as offline fallback | Phase 3 |
| Manual "did the fix work?" log re-reading | **Retires** — replaced by experiments against fingerprint datasets | Phase 3 |
| `agentrail/evals/` spine (corpus/arms/runner/reporter) | **Stays** — Langfuse stores/visualizes its outputs, doesn't replace its execution | — |

## Design

Anchor files: `agentrail/run/pipeline.py` (`_run_pipeline` :1084, `run_issue_phase` :310, cost
block :523-544), `agentrail/run/pricing.py`, `agentrail/context/pricing.py` (PRICE_TABLE),
`agentrail/afk/runner.py` (`Runner._implement` :243, subprocess boundary),
`apps/jace/agent/instrumentation.ts` (new), `apps/jace/agent/hooks/` (new),
`apps/jace/agent/subagents/{triage,researcher,qa}/`.

### Phase 1 — tracing + cost (both systems in parallel)

1. **Local instance.** Langfuse v3 docker compose at `localhost:3000`. Verified: the compose file
   declares named volumes (`langfuse_postgres_data` etc.) — trace history persists across restarts,
   which calibration and datasets depend on. Pin the compose to a tag, don't track main.
   SDKs read `LANGFUSE_HOST`/`LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` from env; unset = disabled.

2. **Agentrail tracer** (`agentrail/observability/` — `langfuse_client.py` + `tracer.py`) talks to
   Langfuse's stable public REST API directly via stdlib `urllib` (house pattern:
   `agentrail/run/cost_push.py`) — no Python SDK dependency, so SDK major churn can't touch us and
   trace IDs are derived deterministically from `run_id` (sha256 prefix), letting score-push find
   traces with no lookup. One trace per `_run_pipeline()`; one generation per `run_issue_phase`
   call, carrying phase name, model, and explicit `usageDetails`/`costDetails` computed by the
   *existing* `cost_usd()`/`cost_breakdown()` at pipeline.py:523-544. Langfuse's own price lookup
   is never used for agentrail generations.

3. **Subprocess linking.** AFK shells out to the `agentrail` CLI (`afk/runner.py:243`), so true
   parent-child spans across that boundary are impossible. One `AGENTRAIL_LANGFUSE_SESSION_ID` per
   AFK run, propagated via env, groups all phase traces under one Langfuse session. This is
   deliberate session-grouping, not fake nesting.

4. **Jace via Eve's own OTel seam.** Verified against Eve v0.19.0's instrumentation guide: Eve does
   NOT own the OTel provider — `agent/instrumentation.ts`'s `setup` callback is where the app
   registers it, and Eve already produces the full span tree (`ai.eve.turn` → `ai.streamText` →
   model/tool calls) through the AI SDK automatically, including subagent sessions. So the
   integration is: register the Langfuse span processor in `setup`, and use the
   `events["step.started"]` runtime-context callback to stamp the root session id onto spans so
   Langfuse groups a whole session tree (root + triage/researcher/QA subagent runs) under one
   session. No per-subagent span authoring needed. Note: `$eve.*` workflow tags are a separate
   Vercel-dashboard surface and do NOT appear on OTel spans — token usage comes from the AI SDK
   spans themselves.

5. **Jace cost policy.** Jace has no pricing module, so its dollars come from Langfuse model
   definitions — but those definitions are *synced from PRICE_TABLE* by a small idempotent script
   (`langfuse models sync` CLI or API) run as part of local setup. One price source, two consumers.
   Any model seen in traces with no matching definition is a visible gap in Langfuse, not a silent $0.

6. **Flags default-OFF.** `AGENTRAIL_LANGFUSE_ENABLED` gates the Python tracer; the presence of
   Langfuse env keys gates `instrumentation.ts` (Eve enables telemetry by the file's presence, so
   the file itself must no-op its exporter without keys). Flag-off inertness is a tested property.

### Phase 2 — truth-scores + shadow-judge + calibration

7. **Truth-scores.** Eval-harness runs attach `solved` (hidden tests) and `false_green` per trace;
   production runs attach the verify-gate verdict (`verify_verdict` from PR #1183). These are the
   scores Langfuse filtering/error-analysis pivots on — opinion scores never substitute for them.

8. **Shadow-judge.** The existing sonnet forensics judge additionally pushes its verdict via
   `create_score` onto the run's trace (looked up by `run_id`). Ledger and issue-filing flow
   unchanged — pure additional sink.

9. **Calibration gate (the consumer).** A small report (extends the existing forensics judge pass)
   computes judge-vs-truth agreement: on eval runs, judge verdict vs hidden tests; on production
   runs, judge verdict vs verify-gate + CI + review outcome. Published per judge pass. The standing
   rule: no judge graduates to any gating role until its agreement rate on the held-out split
   clears a pre-registered threshold — and that graduation decision is itself a user call, out of
   scope here. Scores without this consumer are vanity metrics; this report is why Phase 2 exists.

### Phase 3 — the self-improvement loop

10. **Fingerprint tags.** The forensics failure taxonomy (doctor-waived, verify-prose-reject,
    rapid-relaunch, quota-as-failure, …) becomes trace tags, applied by the judge pass. Failure
    classes become queryable and countable in Langfuse instead of living only in ledger markdown.

11. **Datasets from failures.** Each fingerprint gets a Langfuse dataset; failing traces are added
    as items (linked via `sourceTraceId`). Datasets split seen/held-out per the two-set acceptance
    gate convention.

12. **Experiments validate fixes.** A fix for fingerprint X is accepted only when an experiment
    over dataset X shows the failure class dead (and the held-out split doesn't regress) — replacing
    manual log re-reading as fix validation. Hidden tests + dollars remain the final arbiter for
    anything the experiment can't prove.

## Prerequisites (before Phase 1 code)

- **P1 — cost-capture smoke run.** The 0/54 empty cost ledgers in dogfood history are explained:
  per-phase cost events landed 2026-06-12 (#503) and the judged runs were June 4–12, predating the
  feature. But the seam is therefore *unproven* in dogfood: one fresh dogfood run on current main
  must produce a populated `cost-events.jsonl` before the Langfuse cost story builds on it.
- **P2 — version pins.** Agentrail needs no Langfuse SDK (REST only); the pins that matter are the
  compose image tag and Jace's JS packages (`@langfuse/otel` — the docs' current major moves fast:
  a v4→v5 migration guide already exists, so pin whatever is current at implementation time, exact
  version not a range, matching the Eve-pin philosophy). Jace side re-verified against the
  Eve-pinned stack (Node ≥ 24, `ai@7.0.11` — both compatible per current Langfuse docs).

## Measurement (definition of success)

- **Cost parity:** one dogfood run with the flag on produces a Langfuse trace whose per-phase and
  total cost match `pricing.py`'s figures bit-for-bit, asserted via the Langfuse API.
- **Session stitching:** an AFK run's phases appear as one Langfuse session; a Jace session tree
  (root + one subagent) appears grouped under one session id.
- **Truth linkage:** an eval-harness run's trace carries its hidden-test score; a production run's
  trace carries its verify verdict; a judged run additionally carries the judge score.
- **Calibration report exists** and states the judge-vs-truth agreement rate with its sample size.
- **Loop closure (Phase 3):** at least one fingerprint dataset exists, built from real failing
  traces, and one experiment has been run against it.
- **Flag-off inertness:** with flags off, zero behavior change — verified by the existing full
  test suite plus an explicit no-network assertion.

## Testing Decisions

- **Tracer unit tests** run against a fake Langfuse client: correct trace/generation shape, explicit
  cost_details always present, no call escapes when the flag is off (fail the test on any network
  attempt).
- **Price-sync test:** syncing PRICE_TABLE twice is idempotent; a model missing from PRICE_TABLE is
  reported, never silently priced.
- **Integration smoke** (one per system) runs only when a local Langfuse is reachable (skipped
  otherwise, never mocked-green in CI): perform a real traced run, then assert via the Langfuse API
  that the trace, session grouping, and cost figures landed.
- **Score-push tests:** verdict → `create_score` payload mapping, including the fail-closed case
  (missing run_id/trace lookup logs and skips, never blocks the judge pass).
- Jace `instrumentation.ts` is covered by the smoke test (Eve auto-discovery is framework behavior
  we don't re-test), plus a unit test that the exporter no-ops without env keys.

## Risks

- **Eve churn:** pre-1.0, ~41 releases/fortnight, pinned exact at 0.19.0. `instrumentation.ts` and
  `step.started` are the seams used here; re-verify both on any Eve bump (they are documented
  surfaces, not internals — but pre-1.0 docs churn too).
- **Trace payload sensitivity:** Eve records full message history and outputs by default
  (`recordInputs`/`recordOutputs`); agentrail traces carry prompts and diffs. Acceptable while
  self-hosted local-only; any move to cloud re-opens this as a sanitization decision (shared-memory
  prompt-injection surface rule applies).
- **Volume/sampling:** dogfood volume is trivially small; no sampling in this phase. If prod-scale
  ever matters, sampling is an exporter-level knob, noted so it isn't rediscovered as a crisis.
- **Write-only-scores regression:** the calibration report (Phase 2, item 9) is the named consumer;
  if it's descoped, the shadow-judge should be descoped with it.
- **Subprocess boundary:** session-grouping across AFK→CLI is a documented limitation, not a bug to
  fix later with heroics.
