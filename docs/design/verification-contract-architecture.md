# Verification-Contract Architecture (code map for PRD #767)

This is the **code architecture every issue under PRD #767 must follow**, so the
deep modules land in one agreed place with stable boundaries instead of being
re-invented per issue. It respects ADR 0006 (repo architecture) and ADRs
0007–0011. Terminology is from `CONTEXT.md`.

## Layering principle

Two kinds of code, kept separate:

- **Deep modules** — pure logic, no I/O, deterministic, unit-tested in isolation
  (the 🟢 modules from the PRD). They take plain inputs and return plain results.
- **Thin orchestration** — wires deep modules to the agent CLI, git, the DB, the
  network, and the console. Not unit-tested here; verified by integration/manual.

A deep module must never import the pipeline, the network, or the DB client. The
pipeline/orchestration imports the deep modules, not the reverse.

## Module map (home · responsibility · interface · tested)

| Module | Home | Interface (conceptual) | Deep/Test |
|---|---|---|---|
| **Output Format Enforcer** | `agentrail/run/output_enforcer.py` (new) | `enforce(edit, is_new_or_rename) -> Accepted(patch) \| Rejected(reason)` | 🟢 yes |
| **Objective Gate** | `agentrail/run/objective_gate.py` (new) | `evaluate(issue, change, red_green_evidence) -> Green \| Red(evidence)` | 🟢 yes |
| **Red-Green Proof recorder** | `agentrail/run/red_green.py` (new) | `record(run); verify_trail() -> bool` (reject never-failed) | 🟢 yes |
| **Independent Verifier** | `agentrail/run/` orchestration; model call | `verify(issue, change, tests, model!=implementer) -> Confirmed \| Rejected(reasons)` | thin (contract test) |
| **Role orchestration** (Test-Author/Implementer/Verifier) | `agentrail/run/pipeline.py` + `agentrail/afk/runner.py` | wires the three roles around the gate | thin |
| **Input-Contract validator** | `agentrail/afk/input_contract.py` (new) | `validate(issue) -> Ok \| Rejected(missing_AC)` | 🟢 yes |
| **Cost Meter** | extend `agentrail/run/usage_capture.py` + `agentrail/run/pricing.py` + `agentrail/run/cost_push.py` | capture `cache_creation`; `cost(usage) -> $`; `cost_per_issue_to_green(issue)`; read/creation ratio | 🟢 yes (math) |
| **Metrics read-model** | `agentrail/server/` + `packages/db-clickhouse/src/queries.ts` | accept rate, escalation rate aggregations | 🟢 yes (agg) |
| **Issue Queue state machine** | `agentrail/afk/queue_state.py` (new), building on `afk/store.py` + `afk/state.py`; server read model in existing `agentrail/server/queue.py` | `transition(entry, event) -> entry'`; terminals Green/Escalated-to-human/Blocked | 🟢 yes |
| **Budget Leash** | `agentrail/run/budget_leash.py` (new) | `check(spent, attempts, ceiling, attempt_limit) -> Continue \| Escalate \| StopToHuman` | 🟢 yes |
| **Compaction / Failure-Handoff builder** | `agentrail/run/compaction.py` (new) | `build(goal, attempt_diff, gate_error) -> handoff` (preserve failure-relevant, drop redundant) | 🟢 yes |
| **Model router / escalation** | extend `agentrail/run/routing.py` | `next_tier(tier, gate_result, budget)`; escalation = Queue transition | thin |
| **Connector adapters** | `agentrail/connectors/` (new): `base.py` interface, `github.py` (consolidate `afk/github.py`), `linear.py`, `discord.py` | `ingest() -> issues`, `post_result(issue, outcome)`, `notify(event)` | thin (integration) |
| **Trigger dispatcher (Heartbeat)** | `agentrail/heartbeat/` (new): event intake + cadence; dispatch via Queue | `on_event(event)`, `tick()`; stop on empty queue | thin |
| **Console surfaces** | `apps/console/app/(dashboard)/dashboard/[workspaceId]/` | falsifiable-metric pages; queue, connectors, triggers views; remove savings | thin (browser-verified) |
| **Schema** | `packages/db-clickhouse/src` | additive ALTER: `cost_events.cache_creation_tokens`; queue/metrics read tables | — |

## Boundaries that resolve existing-code ambiguity

- **Objective Gate (run-side, runs tests) is distinct from `agentrail/server/gates.py`** (the server-side Review Gate read model / policy surface). Do not merge them.
- **Queue:** the *execution* state machine lives in `agentrail/afk` (orchestrator side); `agentrail/server/queue.py` stays the server-side read model the console reads. The state machine is the source of truth; the server model projects it.
- **Connectors consolidate `afk/github.py`** behind the new `connectors/base.py` interface — do not add a second GitHub client.
- **Escalation is a Queue transition** (ADR 0011), implemented via `routing.py` + `queue_state.py`, not a bespoke retry loop.
- **`diff_savings.py` is an after-the-fact estimate, not enforcement** — the Output Enforcer (real enforcement) supersedes it as the output lever; leave `diff_savings.py` as advisory telemetry only.

## Testing

Deep modules (🟢) get isolated unit tests with fixtures, behavior-only (no internal
assertions), following the prior art in `packages/db-clickhouse/src/*.test.ts` and
`agentrail/run` pricing tests. Thin orchestration, connectors, heartbeat, and
console are verified by integration/manual + browser screenshots (TASTE.md).
