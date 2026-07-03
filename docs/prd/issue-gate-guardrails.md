# PRD: Issue-gate guardrails (input contract v2)

## Problem

Three writers put issues into the factory queue: humans labeling GitHub issues,
eval auto-tickets, and (soon) the create-issue tool of Jace (the coordinator
built on Eve). Today's
admission gate is an AC-checkbox regex only, dual-implemented in lockstep
(`validateAcceptanceCriteria` in `packages/db-postgres/src/queries/github_intake.ts:24-59`
and `agentrail/guardrails/policies/input_contract.py`, reached on the Python
side via the `agentrail/afk/input_contract.py` shim). Any human labeling any
GitHub issue with the trigger label reaches the queue with **zero injection
screening, no content dedup, and no rate limit** — and the issue body is stored
verbatim (`github_intake.ts:246`), later injected into prompts assembled at
`agentrail/run/pipeline.py:218-267`, and executed by an unrestricted-shell
runner.

The original framing — put the gate inside Jace's create-issue
tool — protects only one of the three writers. `needsApproval: always()` on
that tool is a UX gate, not a security boundary. The security boundary is the
two real queue entrances.

## Goals

1. Injection screening, content dedup, and per-writer rate limiting enforced at
   **both** queue entrances: `enqueueGithubIssue` (TS console/webhook path) and
   `admit_to_queue` (Python heartbeat path).
2. Single-sourced policy: extend `agentrail/guardrails/policies/input_contract.py`;
   the TS mirror is kept honest by a **cross-language parity test** — one shared
   fixture corpus run against both gates (reuse the #943 injection-probe corpus).
3. Defense-at-read: a second screening/framing point at prompt-assembly /
   pack-injection time, because sanitize-on-write cannot cover pre-existing
   queue rows, webhook writes, or post-admission body edits.
4. Eval auto-tickets pass through the same gate. One gate, all writers.

## Non-goals

- **Not a launch prerequisite for Jace (PRD3).** Jace
  ships human-gated (`needsApproval: always()`) in parallel; this PRD is the
  prerequisite for *relaxing* that approval, not for launching.
- No gate logic living inside Eve's create-issue tool (it may pre-validate for
  UX, but enforcement happens at the queue).
- No third gate implementation and no divergence from the guardrails-package
  consolidation (#918–#922).

## Design

Anchor files: `packages/db-postgres/src/queries/github_intake.ts:218-261`
(`enqueueGithubIssue`), `agentrail/guardrails/policies/input_contract.py` (the
real policy — `agentrail/issue/input_contract.py` does not exist; the AFK path
is a shim re-export), `agentrail/heartbeat/dispatcher.py` (`admit_to_queue`),
`agentrail/run/pipeline.py:218-267` (prompt assembly).

1. **Policy v2 in the guardrails package** — add injection screening
   (heuristics + deny-list, fixtures seeded from #943's probe corpus),
   content-hash near-duplicate detection (deterministic uuid5 entry ids already
   dedup exact replays; this adds duplicate-*content* detection), and
   per-writer rate limits to `input_contract`.
2. **Wire both entrances** — the TS gate extends the `validateAcceptanceCriteria`
   call-site inside `enqueueGithubIssue`; the Python gate extends the policy
   `admit_to_queue` already calls.
3. **Parity test** — one shared JSON fixture corpus (reject cases from #943 +
   real house-format issues as negative controls) executed by both a vitest and
   a pytest suite; CI fails if the two gates ever disagree.
4. **Read-side framing** — at prompt assembly, delimit the issue body as
   untrusted content and re-run the injection screen; a read-side failure parks
   the entry for human review instead of silently proceeding.
5. **Linear intake (scoped add-on)** — `agentrail/connectors/linear.py` is a
   complete `LinearConnector` with zero call-sites; wire it into the heartbeat
   CLI construction so Linear labels trigger runs through this same gate
   (`queueSourceEnum` already contains `"linear"`). If deferred, the plan must
   say "Linear trigger: non-goal, adapter exists unwired" explicitly.

## Measurement (definition of success)

- Parity suite green: both gates agree on every fixture in the shared corpus.
- All #943 injection probes rejected at both entrances; zero regressions on the
  house-format negative controls.
- A crafted post-admission body edit is caught by the read-side screen (test).
- Duplicate-content and rate-limit behavior covered by tests on both paths.

## Risks

- Heuristic screening is bypassable → it is one layer of several: write-screen
  + read-frame + human approval on the Jace lane + the Objective Gate
  downstream. The goal is raising attacker cost, not perfection.
- Over-blocking legitimate issues → negative-control fixtures; failures park
  for review rather than drop.
- TS/Python lockstep drift silently reopens the bypass → the parity test is a
  required deliverable, not a nicety.
