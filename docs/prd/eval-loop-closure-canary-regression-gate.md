# PRD: Eval-loop closure — consumer, canary, regression gate

## Problem

The eval→diagnose→gate→optimize loop is severed at its last seam — but not
where originally assumed. The ingest half **already shipped**: #942 is closed
with the `eval_arm_metrics` schema, the
`apps/console/app/api/v1/ingest/eval-arm-metrics/` route (+ tests), and
`HttpMetricsWriter` flipped on. What's missing is the consumer side. And the
originally-planned regression gate ("fail if solve-rate drops >5%") would fire
on pure noise: at 30 reps the aggregate solve-rate 95% CI is roughly ±16pp,
tie tasks flip 33%↔67% between reps (one flip moves the aggregate 3.3pp and
$-per-solved ~12%), and unmarked `<synthetic>` ECONNRESET rows ($0, no diff)
contaminate baselines — `runner.py`/`reporter.py` contain zero
synthetic/ECONNRESET handling today.

## Goals

1. **Consumer/apply CLI**: dated eval report → proposed
   `.agentrail/layer-overrides.json` + `routing --apply` changes, against the
   EXISTING ingest route. No new endpoint.
2. **Nightly canary GH Action** producing a dated eval report; open issue #981
   (HITL default-flip; its blocker #980 is closed) is the named first consumer.
3. **A statistically honest regression gate**: paired per-task deltas,
   confidence intervals instead of point thresholds, synthetic-row exclusion.

## Non-goals

- No new metrics-ingest endpoint (shipped in #942).
- No re-litigating the ground truth: solved = hidden tests only.

## Design

Anchor files: `agentrail/evals/runner.py`, `agentrail/evals/reporter.py`,
`agentrail/evals/arms/__init__.py`,
`apps/console/app/api/v1/ingest/eval-arm-metrics/route.ts`,
`agentrail/run/pricing.py`.

1. **Data hygiene before aggregation** — mark and exclude
   `model == "<synthetic>"` / $0-no-diff rows; report them as a
   network-artifact count per stratum, so a 3-rep 0-solve $0.0000 stratum can
   never read as a real regression.
2. **Paired gate** — same tasks in both arms; per-task delta with a paired
   test and a minimum rep count; thresholds expressed as confidence intervals
   ("red iff the CI excludes zero AND the effect exceeds X") on solve-rate AND
   $/solved. The $/solved leg doubles as PRD2's cost non-regression check.
3. **Canary action** — nightly, bounded corpus subset, reporting on the
   per-stratum axes that already exist (difficulty stratification +
   per-component cost breakdown); writes the dated report the apply CLI and
   #981 consume.
4. **Consumer/apply CLI** — reads the dated report, proposes flag/routing
   changes, applies only behind an explicit `--apply` (proposal-by-default).
   Telemetry seam: unlinked runs currently push nothing — canary runs must be
   linked (or the push path extended per PRD2's live-metrics workstream), else the live-metrics
   lane stays dark for exactly the runs this gate reads.
5. **Fail-closed auth** — any new or extended route in this family rejects
   requests when its auth secret is unconfigured. Do NOT copy the GitHub
   webhook's fail-open skip (HMAC verify returns true when the secret is
   unset): these payloads ultimately flip live behavior flags via the consumer
   CLI.

## Measurement (definition of success)

- Seeded-regression test: the gate reds on a deliberately degraded arm.
- Stability: K consecutive no-change nightly runs stay green (bounded
  false-positive rate is part of DONE, not an afterthought).
- The #981 flip is executed on the strength of a canary report — the loop's
  first fully closed cycle.

## Risks

- Honest CIs may demand more reps/tasks than the budget likes → prefer paired
  designs and explicit tie-task handling over raw rep inflation; report
  statistical power in the report rather than hiding it.
- A flaky gate is an ignored gate → the stability criterion above is a hard
  acceptance item.
- The apply CLI is a new lever on live behavior → proposal-by-default, human
  `--apply`, fail-closed auth on every input to it.
