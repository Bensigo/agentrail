# Jace trust-layer migration ledger

Last reconciled: 2026-08-06. Canonical product decision: [ADR 0012](adr/0012-jace-owns-the-acceptance-spine.md). Canonical post-MVP proof plan: [Jace trust-layer evaluation](prd/jace-trust-layer-evaluation.md).

## Canonical MVP flow

1. A task starts in Codex, Claude Code, Slack, Discord, or another supported
   channel and becomes one Acceptance Record carrying origin provenance.
2. Jace asks only unresolved questions in the originating channel where that
   integration supports it, drafts an Acceptance Contract, and a human
   confirms it.
3. Jace creates a bounded, versioned, cited Context Pack. It contains only
   acceptance criteria, relevant source ranges, architecture/repository
   boundaries, tests, decisions, exclusions, freshness/provenance, and an
   explicit token budget. Durable intent belongs to the Record, not a growing
   chat. Side agents return compact cited findings to the Record and cannot
   become an unbounded context source.
4. A human selects an external builder. Jace records the builder task context,
   repository, planned branch, confirmed contract, and selected pack; the
   builder implements without Jace silently changing code.
5. A PR is attached manually or correlated only from that exact recorded
   handoff. Its repository, PR number, exact head, and revisions are durable.
6. For every criterion, Jace plans the strongest safe proof for the available
   environment: browser interaction/artifact for UI; redacted request-response
   evidence for API; trigger plus bounded output/log/artifact for jobs;
   authorized readback/assertion for data/integrations; otherwise
   `not_testable`/`not_proven`. Every proof is bound to the PR head/environment.
7. Jace emits a blocker only for a required code change grounded in the
   contract, architecture boundary, enforced convention, or concrete risk.
   It includes evidence, impact, correction, and criterion-specific recheck.
8. A correction goes to the builder task context when supported, otherwise a
   durable GitHub/Jace fallback. Delivery attempts and acknowledgement are
   recorded; no claimed notification or resume without acknowledgement.
9. Human decides the PR outcome. Jace never auto-merges.

## Implemented and objectively checked foundations

| Slice | Commits | Evidence |
| --- | --- | --- |
| Record, immutable contract draft, human clarification revision, and confirmation | `8bc3a80c` through `0ec7d2e6`, `53cf907b` | focused Console route/contract tests and DB no-open-question unit test. Any workspace member can append a parsed immutable draft; confirmation remains owner/admin-only and fails closed while any question is open. A real migrated Postgres integration test exists but was skipped locally because no migrated database is available. |
| Metadata-only context-pack record and MCP read surface | `989e3b7c` through `a4f7b8cc` | Python context-pack tests and focused console tests |
| Dedicated scoped agent-MCP credentials | `2b179526`, `c27b6564` | focused bearer/API/MCP tests and package typecheck |
| Manual connected-repository PR attachment and immutable head revisions | `93efb0a3` | focused attachment route tests |
| Human-selected builder handoff and fail-closed webhook PR correlation | `1221c3c0`, `52a6c248` | focused builder-handoff and signed-webhook tests; unlinked PRs never enter the advisory queue |
| Independent criterion review validation and generic-smoke rejection | `78f92fc4` through `1034f42e` | `evidence-review-validation` and runner completion tests |
| Correction delivery acknowledgement seam | `429eb1a2` | focused MCP acknowledgement tests |
| Automatic correction queue, builder-task inbox, native MCP read/ack, and GitHub fallback dispatch | `7d560fcd` through `2890610f`, `f8789d6e` | focused review-completion/queue/ack/inbox/dispatch tests, MCP protocol test, and DB typecheck. A blocking review queues the exact correction only for its unique PR-attached handoff; packets retain exact review revision and runtime evidence. A builder can retrieve its recorded task's packet and acknowledge it through scoped MCP tools. GitHub dispatch posts a COMMENT-only PR issue-comment only for the current exact head and records delivered/failed. Neither carrier proves a live builder was notified or resumed. |
| Exact-head criterion verification-plan persistence | current migration slice | focused runner-plan, review-validation, and completion-route tests; DB typecheck. This is plan metadata, not runtime proof. |
| Review-bound UI artifact storage | current migration slice | focused artifact-plan and plan route tests; DB typecheck. The route derives the criterion/repo/head from a current persisted UI plan and records a digest; it does not exercise a flow or declare a pass. |
| Bounded Context Pack handoff metadata | current migration slice | focused MCP/user route and validator tests; requires budget, cited ranges, confirmed criterion IDs, explicit boundaries/tests/decisions/exclusions, freshness, and no-full-source custody. |
| Task-scoped external-builder Context Pack handoff | `fd297f13` | focused MCP builder-task route test, native MCP protocol test, MCP build/typecheck, and DB typecheck. A scoped builder can retrieve only its recorded handoff's confirmed contract and selected bounded Context Pack metadata/artifact references; it cannot retrieve raw source or treat handoff as proof of implementation. |
| Canonical pre-repository hosted intake | `742eafe9`, `d6ffaadf` | DB identity tests/typecheck, Jace hosted-inbound tests, and focused Console intake-route tests. A bound Console/Telegram/Discord/Slack turn records durable channel/conversation/source provenance before Eve receives it; failure to record returns 502. This does not yet ask questions, resolve a repository, link the Intake to an Acceptance Record, or send a channel-specific clarification. |
| Criterion execution queue, guarded result seam, and opt-in Eve worker | `ee6f36d7` through `ec9bfc08` | focused runner admission/completion, artifact, plan, prompt, worker-core, worker-runtime, console-client, and instrumentation tests. The worker claims only plan-bound exact-head jobs, runs a constrained root-Jace/QA turn, and completes via the trust endpoint; it is default-off and has no live safe-preview/browser proof. |

The next slice must execute a planned safe UI flow and bind its observed result
to these artifacts. Delivery is currently queue plus acknowledgement only; no
dispatcher has proven notification.

## Remaining work, in dependency order

1. Run the new worker against a safe exact-head environment and prove a
   criterion-specific UI flow end to end. Add redacted API/job/data execution
   and artifacts rather than forcing those modalities through screenshots.
2. Prove a live supported external-builder delivery path and resume semantics.
   The automatic task-context queue, native MCP read/ack, and GitHub fallback
   dispatch retain attempt/outcome, but no Codex/Claude builder has retrieved a
   packet, acknowledged it, or resumed work in a live integration test.
3. Resolve a canonical Intake to its Acceptance Record, then implement
   originating-channel missing-question replies. Hosted Console, Telegram,
   Discord, and Slack input is now durably recorded before Eve work, but no
   repository is resolved, no contract is drafted, and no clarification is
   yet sent/received through any channel.
4. Add human PR outcome, dependency-upgrade acceptance flow, Console removal
   of obsolete factory/advisory surfaces, and copy-only landing pivot.
5. Migrate a clean database, run full targeted suites, then browser/E2E proof
   against a live safe preview. No migration, delivery channel, or UI is live
   verified yet.
6. Build the separate post-MVP trust-layer evaluation program defined in
   [`docs/prd/jace-trust-layer-evaluation.md`](prd/jace-trust-layer-evaluation.md)
   after the acceptance spine is coherent. It uses Acceptance Cases, not a
   relabelled factory benchmark: frozen dev/held-out labels, four Jace-specific
   arms, independently scored scorecards, complete lineage, segmented tri-state
   promotion, and strict separation of offline/canary/production evidence.
   Do not preserve legacy factory/execution evals for history alone: first map
   dependencies; classify every component as remove, neutral-infrastructure
   reuse, or replace; build/migrate to the Acceptance-Case spine; run targeted
   replacement coverage; only then delete obsolete product logic, fixtures,
   docs, and tests in a bounded cleanup slice. The market-value scorecards must
   honestly measure lower false-greens/noise/context waste/review-rework and
   better task success/repair with denominators and sample-size limits.

## Non-goals

- Building a replacement coding agent, code factory, or automatic merge lane.
- Advisory/random/style review. Style is a blocker only when an explicit
  enforced convention or approved architecture rule is violated.
- Generic page-load checks presented as behavioral proof.
- Whole-repository or chat-history prompt dumps.

## Unverified assumptions and current boundaries

- No Codex/Claude live pickup, Slack/Discord runtime integration, GitHub
  canonical PR fetch, context compiler attestation, deployed safe-preview
  execution, browser proof, non-UI artifact capture, Jace live delivery dispatch,
  or migration smoke exists yet. The opt-in Eve worker is unit-tested only;
  its runtime must not be represented as an exercised criterion. The native
  MCP server is unit-tested to call the durable correction inbox and receipt
  endpoint, but no live external builder has done so; only its recorded
  acknowledgement proves receipt.
- Worktree: `/Users/macbook/work/bensigo-ai-workflow-trust-record` on
  `codex/trust-layer-acceptance-record`; the most recent product slice is
  `fd297f13` (task-scoped builder Context Pack handoff). The only expected untracked
  paths are generated dependency directories.
  Preserve the shared dirty checkout at `/Users/macbook/work/bensigo-ai-workflow`
  and generated ignored dependency directories in this worktree.
- This ledger is the implementation checkpoint. Re-read it and ADR 0012
  before each substantial slice; current code and tests outrank a side audit.

## Delegation policy

The main agent is the coordinator: it owns scope decisions, architecture
synthesis, ledger maintenance, integration/rejection of returned diffs, and
cross-slice verification. By default, a short-lived smaller subagent owns one
bounded implementation slice with explicit acceptance criteria, write paths,
and tests. Main-agent edits are limited to tiny glue that cannot be separated
safely. No two agents may edit overlapping paths.

A read-only audit is permitted only for one bounded independent question whose
answer can be returned as compact evidence without the full migration history.
Every delegation names its question or implementation slice, allowed sources or
write paths, decision value, acceptance criteria, and stop condition. A side
audit returns only established facts with sources, contradictions, and a
recommendation; the coordinator independently verifies it before integration.
An implementation agent must list changed files and tests. Do not delegate
broad implementation, overlapping design, or open-ended exploration. Keep
parallel work at the smallest number needed.

Before each new slice, the coordinator says why it is local or delegated,
prunes obsolete context, and confirms it advances the accepted MVP flow. The
builder-handoff foundation was the one local exception because this policy
arrived mid-slice; the webhook correlation was delegated, then selectively
integrated against its newer base. The delivery-queue subagent could not obtain
this branch and was stopped; its narrow glue was completed locally. Next, use a
fresh bounded implementation agent only when its base can be pinned; otherwise
the coordinator must explicitly retain the review-bound proof-plan slice.
