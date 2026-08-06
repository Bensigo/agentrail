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
| Blocking-only review boundary | current migration slice | `evidence-review-validation` rejects unsupported bases, missing evidence/impact/correction/reverification, and style-only convention claims. The old `post_pr_review` root tool is explicitly disabled, the advisory review worker is not wired at Jace startup, and its standalone entrypoint refuses to start. The retained core/source is quarantined cleanup material only; Canonical exact-head Acceptance Review is the sole supported Jace merge-gate path. Focused Jace tool-policy, instruction, and instrumentation tests pass. |
| Correction delivery acknowledgement seam | `429eb1a2` | focused MCP acknowledgement tests |
| Automatic correction queue, builder-task inbox, native MCP read/ack, and GitHub fallback dispatch | `7d560fcd` through `2890610f`, `f8789d6e` | focused review-completion/queue/ack/inbox/dispatch tests, MCP protocol test, and DB typecheck. A blocking review queues the exact correction only for its unique PR-attached handoff; packets retain exact review revision and runtime evidence. A builder can retrieve its recorded task's packet and acknowledge it through scoped MCP tools. GitHub dispatch posts a COMMENT-only PR issue-comment only for the current exact head and records delivered/failed. Neither carrier proves a live builder was notified or resumed. |
| Exact-head criterion verification-plan persistence | current migration slice | focused runner-plan, review-validation, and completion-route tests; DB typecheck. This is plan metadata, not runtime proof. |
| Review-bound UI artifact storage | current migration slice | focused artifact-plan and plan route tests; DB typecheck. The route derives the criterion/repo/head from a current persisted UI plan and records a digest; it does not exercise a flow or declare a pass. |
| Review-bound redacted API artifact storage and safe execution descriptor | current migration slice | focused Console plan/claim tests, Jace prompt/uploader/worker-core tests, DB typecheck, and Node 24 Jace build. A planned API criterion must carry immutable `GET` + same-origin path + expected-status metadata and is claimed only against its exact ready PR-head preview. QA is instructed to upload a redacted request/response/assertion card through the plan-bound artifact route. Mutating, credential-bearing, and external requests are rejected from this path. No deployed execution or independent semantic assertion evaluator is proven; the artifact is not itself a pass. |
| Bounded Context Pack handoff metadata | current migration slice | focused MCP/user route and validator tests; requires budget, cited ranges, confirmed criterion IDs, explicit boundaries/tests/decisions/exclusions, freshness, and no-full-source custody. |
| Task-scoped external-builder Context Pack handoff | `fd297f13` | focused MCP builder-task route test, native MCP protocol test, MCP build/typecheck, and DB typecheck. A scoped builder can retrieve only its recorded handoff's confirmed contract and selected bounded Context Pack metadata/artifact references; it cannot retrieve raw source or treat handoff as proof of implementation. |
| Canonical hosted intake, session-bound draft, reply evidence, and bounded resume readback | `742eafe9` through `e913c16e` | DB identity/link/readback tests and typecheck; focused Console intake/draft/outbound/readback route tests; Jace hosted-inbound, intake-draft/reply/readback, channel-wiring, and tool-policy tests; Node 24 Jace build. A bound Console/Telegram/Discord/Slack turn records durable channel/conversation/source provenance before Eve receives it. Jace receives only the Console-returned Intake ID in trusted session attributes. It can draft a parsed immutable Record and, after a compaction, retrieve only a bounded first-inbound plus recent-tail/contract projection. It cannot select a tenant or Intake, confirm, compile/deliver a Pack, select a builder, execute code, or claim success on a degraded response. Final replies are appended only after channel delivery returns. No live channel round-trip is proven. |
| Console navigation trust-layer pivot | `240ee81a` | focused Sidebar navigation tests. Acceptance Records and Approvals are now primary; the customer navigation exposes only review evidence and repository wiki under Evidence & context. Factory work/runs, autonomous economics, memory/brief/investigation, and failure pages remain URL-reachable but are deliberately not primary product navigation. The connector catalog remains a separate unresolved product-scope slice. |
| Copy-only landing trust-layer pivot | current migration slice | focused marketing craft/pricing-copy suites and local browser evidence. The existing landing structure now describes Jace as the acceptance/evidence layer around Codex, Claude Code, or another selected builder; it no longer presents legacy factory run totals as trust proof or says Jace itself ships a PR. The shared pricing-card capacity and price packaging remain a separate commercial decision; this copy slice does not claim a live external-builder or channel round-trip. |
| Exact-review final human PR decision | current migration slice | focused Console route/detail and DB decision-validator tests; DB typecheck. Owners/admins can append one immutable `approved`, `changes_requested`, `rejected`, or explicit `approved_with_exception` decision only for a current exact-head Evidence Review. A standard approval is refused unless Jace recorded `proven`; an exception requires a rationale and does not alter Jace's independent verdict. This records no GitHub merge and has no migrated-DB or browser proof yet. The older `review_events` rework/revert ledger remains aggregate outcome infrastructure only; it is not used as the acceptance decision source. |
| Dependency-proposal Acceptance Record draft | current migration slice | focused converter and both dependency runner-route tests. A dependency candidate proposal becomes one deterministic canonical Acceptance Record for its connected repository. Candidate scope, baseline, expected files, verification commands, stop conditions, and every missing evidence item are preserved; missing evidence is an open question that blocks confirmation. Both the dedicated materialization endpoint and the former proposal endpoint now create/reuse only that draft and source provenance—never an issue, approval, builder handoff, dependency edit, PR, or merge. Legacy dependency approval/publisher code still exists as unused cleanup scope; it is not a supported product lane. |
| Criterion execution queue, guarded result seam, and opt-in Eve worker | `ee6f36d7` through `ec9bfc08`, current safe-preview queue slice | focused runner admission/completion, artifact, plan, prompt, worker-core, worker-runtime, console-client, and instrumentation tests; DB query typecheck. The worker claims only plan-bound exact-head UI jobs whose matching preview is `ready` with a URL. A `pending`, `claimed`, or `booting` preview stays queued rather than becoming a fabricated `not_testable`; superseded, missing, mismatched, failed, or torn-down previews become explicitly `not_testable`, and a lost post-claim projection is terminalized. It is default-off and has no live safe-preview/browser proof. A preview that turns terminal between two polling queries is recovered on the next claim poll, not a false pass. |
| Acceptance Context Pack compilation, custody reduction, and guarded report | `f527d095` plus current slice | Owner/admin admission binds a confirmed Contract, connected repository, captured ref, and phase. A default-off compiler worker claims only that tuple, disposable-clones the ref, rebuilds the index, compiles an `acceptance_record` Pack, reduces it to cited metadata, and reports it through a Jace-secret route. The route re-reads the claimed Contract, validates exact criteria/budget/custody/freshness, records the Pack, then marks the job compiled; raw source is rejected from manifest, custody, and freshness. Hermetic failure and real local clone/index/compiler/cleanup tests pass. No deployed claim/clone/report or external-builder retrieval is proven. |
| Acceptance Case corpus, independent scorecards, four-arm inputs, offline orchestration, and tri-state promotion | `81468b7d`, `1b6cf127`, `fd674f05`, `386f58a1`, current offline-runner slice | Focused Python tests validate frozen dev/held-out Cases, arm-separated independent scorecard denominators, a contract version, and a custody-only bounded Pack descriptor. The pure arm-input contract exposes only the frozen request to `agent-alone`; adds only the approved Contract to `contract-only`; adds the bounded Pack descriptor only to `contract-plus-pack`/`full-jace-loop`; and binds evaluator-only lineage to the case/version, contract version, exact PR head/diff, environment, and applicable Pack hash/budget. The offline runner expands every Case into exactly all four arms, gives the selected-builder adapter only its legal arm prompt plus a pinned operational checkout, then requires the adapter's returned PR head/environment to match the frozen Case before an evaluator-owned independent scorer can construct observations. No preselected PR head, case object, hidden label, source oracle, or conversation is given to the adapter. Every observation carries complete immutable case/corpus/repository/contract/model/config/prompt/guardrail/pack/PR/environment/artifact/scorer/outcome-source provenance, with explicit `none` only for non-pack arms. Pure promotion accepts only a complete four-arm held-out offline matrix under caller-declared per-scorecard/segment floors; missing/unknown data holds, measured violations reject, and canary/production observations never become offline truth. The runner has no live builder adapter, scorer implementation, persistence/report publisher, corpus run, or market-value result. |

The next runtime-proof slice must execute a planned safe UI flow and bind its
observed result to these artifacts. Delivery is currently queue plus
acknowledgement only; no dispatcher has proven notification.

## Remaining work, in dependency order

1. Run the new worker against a safe exact-head environment and prove a
   criterion-specific UI flow end to end. Add redacted API/job/data execution
   and artifacts rather than forcing those modalities through screenshots.
2. Prove a live supported external-builder delivery path and resume semantics.
   The automatic task-context queue, native MCP read/ack, and GitHub fallback
   dispatch retain attempt/outcome, but no Codex/Claude builder has retrieved a
   packet, acknowledged it, or resumed work in a live integration test.
3. Prove a live supported Intake → missing-question → draft → human
   confirmation round-trip. Hosted Console, Telegram, Discord, and Slack now
   have append-only input/reply evidence and Jace can fetch a bounded resume
   projection, but no deployed channel has exercised that flow or proved that
   only unresolved questions were asked.
4. Remove the now-obsolete dependency approval/publisher callers and the
   quarantined legacy advisory-review core/worker/prompt after scans prove no
   remaining acceptance-spine caller or retained data depends on them; finish Console removal of obsolete connector/factory surfaces, and
   complete the copy-only landing pivot. The final human PR decision is now a current-review append-only
   seam, but it is not live/migrated-DB/browser verified and does not capture
   post-merge rework/revert; those remain explicit aggregate outcome evidence.
   The sidebar is now trust-first, but routes/catalogs and the homepage still
   contain legacy product language or surfaces.
5. Migrate a clean database, run full targeted suites, then browser/E2E proof
   against a live safe preview. No migration, delivery channel, or UI is live
   verified yet.
6. Continue the separate post-MVP trust-layer evaluation program defined in
   [`docs/prd/jace-trust-layer-evaluation.md`](prd/jace-trust-layer-evaluation.md)
   after the acceptance spine is coherent. It uses Acceptance Cases, not a
   relabelled factory benchmark: frozen dev/held-out labels, four Jace-specific
   arms, independently scored scorecards, complete lineage, segmented tri-state
   promotion, and strict separation of offline/canary/production evidence. The
   frozen loader, scorecards, non-leaky arm-input/lineage seam, pure offline
   four-arm orchestration, and pure tri-state promotion gate now exist; there
   is still no live builder adapter, proof verifier/scorer, persistence/report
   publisher, corpus run, or market-value result.
   Do not preserve legacy factory/execution evals for history alone: first map
   dependencies; classify every component as remove, neutral-infrastructure
   reuse, or replace; build/migrate to the Acceptance-Case spine; run targeted
   replacement coverage; only then delete obsolete product logic, fixtures,
   docs, and tests in a bounded cleanup slice. The market-value scorecards must
   honestly measure lower false-greens/noise/context waste/review-rework and
   better task success/repair with denominators and sample-size limits.

## Context Pack compiler bridge (implementation plan)

The local compiler is implemented and tested, but is not yet a Jace product
worker. `agentrail.context.packs.build_context_pack` accepts an
`acceptance_record` target plus confirmed contract and produces a deterministic,
bounded, cited, redacted pack with compiler version, content hash, custody,
freshness, index provenance, JSON, and Markdown output. It does not itself
resolve a workspace repository, authenticate a clone, record a central Pack,
or hand a pack to a builder.

The existing hosted `onboard` worker proves a reusable safe checkout pattern:
the Console claim returns one workspace-scoped installation token and repo/ref;
the worker shallow-clones into a disposable directory, builds an index, and
removes the directory while redacting clone failures. Reuse this mechanism, not
the onboarding's memory/LLM/factory semantics.

Required vertical slices:

1. Add a dedicated acceptance-pack compilation job that can be admitted only
   for a confirmed Contract and the Record's connected repository. Its
   deterministic identity binds record, confirmed contract version, repository,
   and phase; it never selects a builder, edits code, creates a PR, or merges.
2. Add claim/report routes under the Jace shared-secret boundary. A claim must
   return only the bound record/contract/repository/ref and a fresh
   workspace-scoped clone credential. A report must be owned by the claiming
   worker and must not mark a Pack as compiled without validated bounded
   metadata.
3. Add a disposable compiler worker: clone exact claimed ref, rebuild the local
   index, compile only the confirmed Contract, reduce its output to the
   metadata-only Pack manifest, and report explicit `failed`/`not_proven`
   status on clone/index/compile failure. It must not put raw source content in
   Postgres. The default custody policy may hand the builder cited ranges and
   local artifact references, not a repository dump.
4. Bind a successful report to `recordAcceptanceContextPack`, then require a
   human-selected builder handoff to name that exact Pack. The existing handoff
   already enforces selected confirmed contract plus Pack; it does not prove
   the compiler worker ran.
5. Test admission, claim ownership, exact contract/repository binding,
   compiler manifest conversion, bounded/redacted failure behavior, and one
   local worker smoke against a disposable repository. A deployed clone and
   external-builder retrieval remain separate live proof.

Implemented foundation: an owner/admin can now admit an idempotent Context Pack
compilation job only for the Record's connected repository and an exact
confirmed Contract version. Admission snapshots the repository default branch
as `repositoryRef`; the Jace-secret claim atomically returns only that job,
confirmed contract, repository/ref, and a fresh workspace clone credential.
It has no source payload and cannot choose a builder, modify code, create a PR,
or merge. Tests cover human admission authority, missing record/repository,
claim authentication/empty queue, deterministic identity, and migration/schema
invariants.

Implemented next: a default-off disposable compiler worker claims only the
bound tuple, shallow-clones its ref, rebuilds its index, builds the local
Acceptance Record Pack, reduces it to durable metadata, reports it, and always
deletes the checkout. A successful report re-reads the worker-owned claim and
its confirmed Contract, validates its metadata, records a Pack, then marks the
job `compiled`; a failure can only record a bounded `failed` result. A real
local clone/index/compiler/report smoke passes. Still missing: claim-expiry or
retry policy, artifact custody beyond metadata-only references, deployed
claim/clone/report proof, and external-builder retrieval. Compiler claims are
reclaimed only after a 15-minute lease; after three abandoned attempts they
become an explicit `failed` result rather than cycling indefinitely. The Console/MCP Pack
routes still also permit separately validated caller-supplied metadata/artifact
refs; they must not be described as a live compiler attestation. The legacy
factory's Context Pack file is not a substitute for this worker.

## Dependency approval-lane removal plan (pre-destructive audit)

Audit date: 2026-08-06. This is a repository-source map, not a production-data
inventory. No deletion is authorized until a migrated database is inspected
for pending legacy approvals and a forward migration/recovery plan is tested.

| Classification | Current code/data | Required migration action |
| --- | --- | --- |
| Keep: canonical acceptance entry | `agentrail/heartbeat/dependency_runtime.py` posts to `/runner/dependency-upgrade-proposals`; that route and `/runner/dependency-upgrade-contracts/[contractId]/acceptance-record` now draft a deterministic Acceptance Record. `dependency-upgrade-acceptance.ts` converts candidate evidence to the confirmed-contract shape. | Keep and test as the dependency-watch intake. It must remain a source only: no builder selection, edit, PR, merge, or runtime claim. |
| Reuse only as neutral source infrastructure | Dependency watch observations; candidate fingerprint validation; the candidate/proposal portion of `dependency_upgrade_contracts`; `findDependencyCandidate`, create/reuse, refresh, and read functions. These establish candidate, repository, baseline, and evidence provenance before a Record exists. | Split/rename their semantics to a source ledger. Retain candidate/proposal/provenance history and deterministic identity, but replace approval-oriented state with explicit source-evidence freshness. The canonical Acceptance Record remains the only human contract/decision object. |
| Remove: approval-to-issue execution | `apps/console/lib/approval-decision.ts`'s dependency branch; `dependency-upgrade-publisher.ts`; their tests; the dependency-specific console approval actor branch; and the shared Telegram callback path once historical approvals are retired. This is the only source-scan path from a dependency candidate to GitHub issue publication. | First quarantine or explicitly supersede every pending `jace_approvals` row with `tool_name = dependency_upgrade_contract` or a non-null `dependency_contract_id`; do not silently mark it approved/denied or claim publication. Then remove the special decision/publisher path and its tests. Generic approval behavior must remain covered. |
| Replace: approval-coupled schema and query API | `dependency_upgrade_contracts.state`, `approval_id`, `issue_url`, `issue_number`, legacy state/event vocabulary; `jace_approvals.dependency_contract_id`; `attach/decide/set/publish` query functions and related foreign key. Migrations `0074`/`0076` are historical evidence and must not be edited. | Add a forward, reversible migration after data audit: retain/copy source provenance, create source-ledger fields/table if needed, write a durable migration report linking any old row to its Acceptance Record or an explicit `not_migrated` reason, then drop approval/issue columns and the approval foreign key only when no caller or pending row remains. Add replacement tests before removal. |

Deletion order: (1) inventory migrated production data and back it up; (2)
quarantine/supersede historical pending dependency approvals through both
Console and Telegram paths; (3) migrate source rows and link them to canonical
Records where valid; (4) migrate callers and run targeted database/route/
heartbeat coverage; (5) remove publisher and approval-decision code; (6) run
a forward schema cleanup migration. Existing migration files and historical
events are retained as audit history. This plan deliberately does not treat a
source-code search as proof that production has no old approvals.

## Legacy execution-eval removal plan (pre-destructive audit)

Audit date: 2026-08-06. The source audit independently confirms the evaluation
PRD's classification. The current corpus loader requires a factory task prompt,
agent-visible working tree, and hidden code tests; `RunRecord` treats the
executor's Objective Gate as the claim to compare with those tests; the scorer
defines false green as `gate_passed && hidden_tests_failed`. That is useful
execution-benchmark machinery, but it does not score whether Jace confirmed a
contract, supplied bounded context, proved a criterion on an exact PR head, or
reduced human rework.

| Classification | Confirmed direct dependencies | Required action before deletion |
| --- | --- | --- |
| Reuse only as neutral infrastructure | `corpus/loader.py` provides frozen commit and held-out controls; `run_record.py` is immutable observation/cost data; `scorer.py` is pure independent hidden-test scoring; `reporter.py`, pricing, and fail-closed canary scheduling provide aggregation/provenance mechanics. | Generalize these around an Acceptance Case and separate scorecards. Hidden tests remain one optional independent code-outcome label, never contract/runtime-proof/human-trust truth. Preserve historical reports as clearly labelled legacy evidence only. |
| Replace | `runner.py::SandboxAgentExecutor`; `spine.py`; `arms/`; legacy `task.json` and answer-key fixture contract; CLI `evals.py` default `baseline`/`full`; canary's baseline/full execution policy and current factory metrics. | Build the Acceptance-Case schema/loader, four-arm runner, proof-verifier protocol, independent scorecards, and tri-state promotion first. Migrate CLI, reporter, regression gate, and canary to explicit offline/canary/production evidence classes. |
| Remove after replacement coverage | `packer_tightening.py`, gather/memory/factory A/B reporting, execution-layer ablation fixtures/tests, and factory-only corpus fixtures/docs that have no mapped Acceptance-Case scorecard. | Run new dev and held-out Acceptance Cases with denominator/sample-size reporting; verify all direct imports are gone; then delete in a separately reviewed cleanup. Do not delete migration reports or historical outcomes. |

Confirmed caller constraints: `agentrail/cli/commands/evals.py` imports both
`SandboxAgentExecutor` and `ProductionHiddenTestRunner`; `spine.py` and
`canary.py` import the factory arms/runner/hidden-test interfaces; the nightly
workflow invokes `agentrail evals canary`. Therefore none of those files can be
removed today. The next implementation phase stays gated on a coherent
acceptance spine; first build the Acceptance-Case replacement beside the
legacy benchmark, migrate callers, run targeted replacement coverage, then
perform cleanup. No market-value claim follows from current factory results.

## Non-goals

- Building a replacement coding agent, code factory, or automatic merge lane.
- Advisory/random/style review. Style is a blocker only when an explicit
  enforced convention or approved architecture rule is violated.
- Generic page-load checks presented as behavioral proof.
- Whole-repository or chat-history prompt dumps.

## Unverified assumptions and current boundaries

- No Codex/Claude live pickup, live Slack/Discord/Console acceptance-draft or
  reply-recording round-trip, session-resume Intake read, GitHub canonical PR
  fetch, context compiler attestation, deployed safe-preview execution,
  browser proof, non-UI artifact capture, Jace live delivery dispatch, or
  migration smoke exists yet. The opt-in Eve worker is unit-tested only;
  its runtime must not be represented as an exercised criterion. The native
  MCP server is unit-tested to call the durable correction inbox and receipt
  endpoint, but no live external builder has done so; only its recorded
  acknowledgement proves receipt.
- Worktree: `/Users/macbook/work/bensigo-ai-workflow-trust-record` on
  `codex/trust-layer-acceptance-record`; committed product slices include
  `d8dc8601` (metadata-only local Pack manifest), `9e45e856` (compiler bridge
  plan), `93946d66` (eval removal map), and `4b735b27` (dependency source to
  Acceptance Record), and `f527d095` (compiler job admission/claim). The
  current uncommitted slice hardens the exact-head UI execution queue so it
  waits for a matching ready preview; it has no production execution or
  telemetry effect.
  The only expected unrelated untracked paths are generated dependency
  directories.
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
this branch and was stopped; its narrow glue was completed locally. The
session-bound intake-to-draft bridge was also retained locally because it
crossed the already-owned hosted-inbound and Console shared-secret boundary.
The outbound-reply worker was stopped after it did not return a bounded result;
its persistence commit appeared on the branch and was independently inspected,
then the coordinator added and verified the minimal post-delivery channel
wiring in a separate commit. This does not establish a live channel flow. The
former-proposal-route migration remained local because it overlapped the
coordinator-owned dependency converter and runner API fixture. The attempted
smaller-model Context Pack job delegation was stopped after it did not return a
bounded implementation; its persistence glue was completed locally without
expanding scope. The next slice is the disposable compiler worker and its
report seam; separately, a bounded dependency-lane map remains required before
any destructive cleanup and must classify every approval/publisher caller as
remove, neutral infrastructure, or still-needed compatibility.
