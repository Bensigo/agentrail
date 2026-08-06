# Jace trust-layer migration ledger

Last reconciled: 2026-08-06. Canonical product decision: [ADR 0012](adr/0012-jace-owns-the-acceptance-spine.md). Canonical post-MVP proof plan: [Jace trust-layer evaluation](prd/jace-trust-layer-evaluation.md).

## Operating-context correction

The old operating context described Jace as an AI engineer that executes the
factory SDLC and opens PRs. That contradicted ADR 0012's accepted trust-layer
decision. Resolved here: Jace owns acceptance, bounded context, exact-head
evidence, blocking correction, and the human decision; external builders such
as Codex or Claude Code implement; Jace never silently edits or merges. The
factory remains legacy/internal infrastructure and historical evidence, not the
canonical public MVP. ADR 0012 and this ledger take precedence for product
language during migration.

## Coordinator checkpoint (2026-08-06, current branch)

The working baseline for this checkpoint was `ecfba3f4` after the runtime-proof,
builder-handoff, Console-admission, Context Pack lifecycle, and correction
delivery visibility slices. The
only expected untracked paths are local dependency/output directories. The recent commits
`9c05442d`, `0a615e7f`, `e4864b27`, and `e6f39939` add bounded UI/API
criterion execution, while `c2e395fd`, `b47a0717`, `cf192b8c`, `4d5edce4`,
and `7dff5d40` add recorded builder delivery, proof-eval checks, human builder
selection, and human Context Pack compilation admission. Their focused tests
are source and unit evidence only.

The hosted-runtime inspection found no installed Railway CLI or authenticated
project/environment identity in this checkout. The repository contains generic
Railway manifests for preview-worker/fleet only. Therefore no safe exact-head
preview, browser/API execution, deployment, external-builder session, or
authenticated Console browser flow has been exercised. Those remain explicit
live-only gaps, not failed product verdicts.

The Context Pack lifecycle slice is complete locally: the record detail GET
returns workspace-scoped safe compilation metadata, and the Console separates
queued/claimed/failed/not-proven work from a compiled Pack. Builder handoff
requires the matching compiled job, Pack, and confirmed Contract; it remains
disabled otherwise. Focused Console/DB checks pass. The attempted smaller-agent
delegation was stopped because it opened an unrelated worktree and returned no
diff; the coordinator verified that fact before applying this narrow fallback.
This advances the confirmed contract → bounded Pack → external builder flow and
does not introduce code generation, a chat interface, semantic search, or a
new verification modality.

The human Record now also exposes each evidence-bound correction delivery with
its exact review revision/head, channel/target, carrier attempts/outcome,
receipt timestamp, and inspectable correction packet. `queued`, `delivered`,
and `acknowledged` are explicitly distinct: only the latter proves the recorded
builder task received the packet, and none proves a repair or merge. This is
local source/unit evidence; no carrier, builder, or authenticated Console flow
has run live.

Webhook PR correlation now also admits one durable Acceptance Review request
for the recorded handoff's exact PR revision and confirmed Contract. It is
idempotent per revision, becomes `superseded` when a newer head attaches, and
becomes `completed` only when the existing validated review-completion seam
records a review. The Console shows the request separately from the review
verdict. The current bounded slice introduces only private leased claim custody
for that exact request and a worker-only contract/PR claim read; it does not
introduce a reviewer prompt, a verdict, a correction, a notification, or a
deployed worker. A `queued` or `claimed` request means Jace has work to do,
not that Jace reviewed, proved, blocked, notified, or approved anything.
Review completion now additionally requires the same current claim's request
ID and worker ID, alongside the existing record/contract/revision/head checks.
That closes stale-worker completion, but is not a reviewer runtime.
The Jace review-worker protocol core now holds one exact claim at a time and
pins its completion identity from that claim. It is not started until a
separate bounded PR-evidence evaluator exists; evaluator errors produce no
completion or verdict and let the lease recover honestly.
The evaluator input compiler accepts only GitHub pull metadata whose head
matches that claim, then caps changed files and textual patch bytes. A missing
patch, a foreign head, or over-budget diff produces no review input. Any
subsequent static evidence reference must fit a retained exact-head diff line;
this is source/unit enforcement, not a live GitHub fetch.
The worker-side GitHub adapter makes only authenticated read requests for that
PR's metadata and up-to-61 file entries, then feeds the bounded compiler in
memory. It refuses an absent token, non-2xx response, or different head. It
does not clone, persist source, or itself produce a review; no live GitHub
call has been exercised.
The evaluator core turns unavailable exact evidence into a complete,
criterion-by-criterion `not_proven` payload and otherwise accepts only an
injected structured evaluator result whose criterion/finding citations fit the
retained diff. It does not repair invalid output into a pass. The Jace worker
now has an opt-in model adapter and startup hook; deployment activation plus
one authenticated exact-head claim, evidence fetch, completion, and persisted
verdict remain unverified.

## Canonical MVP flow

1. A task may start from a durable, editable Brief or in Codex, Claude Code,
   Slack, Discord, or another supported channel. A Brief remains the human-
   correctable working understanding while Jace shapes the task; its explicit,
   immutable provenance transition creates one Acceptance Record carrying
   origin provenance. Later Brief edits never silently rewrite a confirmed
   Contract, Context Pack, or evidence record.
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
   external builder implements without Jace silently changing code.
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
9. Human decides the PR outcome. Jace never silently edits or merges; the
   exact-head proof and evidence-bound blocking correction are the trust-layer
   product.

The workspace Home must summarize customer-facing trust work rather than
legacy factory activity. Its dated outcome view counts only canonical
exact-head Acceptance Reviews, their independent evidence verdicts, the final
human decision, and currently pending review/decision work. A Jace
`not_proven` verdict is distinct from a human `changes_requested` decision.

## Implemented and objectively checked foundations

| Slice | Commits | Evidence |
| --- | --- | --- |
| Record, immutable contract draft, human clarification revision, and confirmation | `8bc3a80c` through `0ec7d2e6`, `53cf907b` | focused Console route/contract tests and DB no-open-question unit test. Any workspace member can append a parsed immutable draft; confirmation remains owner/admin-only and fails closed while any question is open. A real migrated Postgres integration test exists but was skipped locally because no migrated database is available. |
| Metadata-only context-pack record and MCP read surface | `989e3b7c` through `a4f7b8cc` | Python context-pack tests and focused console tests |
| Dedicated scoped agent-MCP credentials | `2b179526`, `c27b6564` | focused bearer/API/MCP tests and package typecheck |
| Provenance-bound MCP Intake start; direct MCP contract-write retirement | `6deea890` | focused Console intake/credential/record-read tests, native MCP protocol test, package typecheck, DB typecheck, and static route/tool scan. A credential with the new `acceptance:intake:write` scope can submit only a bounded raw task and task-context key. The server derives the workspace-bound `mcp` origin, credential/task provenance, and idempotency keys; it ignores supplied repository, channel, and contract fields. Direct MCP record creation and draft revision routes/tools are removed, and new credentials cannot mint the retired draft-write scope. Existing database scope values remain migration-compatible but have no MCP contract-write route. This starts intake only; it neither asks questions nor drafts/confirms a contract or authorizes implementation. |
| Virtual MCP task-context clarification bridge | `cb190b86`, `3488a058` | full Jace suite (1,764 tests), explicit Node 24 Eve build, focused Console task-turn/readback tests, MCP native protocol test, and MCP/DB typechecks. An agent-MCP credential starts or idempotently forwards an explicit task-context message through the internal Jace hosted-inbound door. Jace binds a virtual `mcp` session to the credential/task context, records canonical `mcp:<credential>:<task>` Intake provenance, and writes its completed reply only into the durable Intake message seam. MCP can read bounded Intake evidence and send a further explicit user task-context reply. It cannot write a contract, select a repository, or claim its task-context message is independently authenticated human confirmation. This is unit-tested transport wiring, not a deployed/live Codex or Claude interaction. |
| Manual connected-repository PR attachment and immutable head revisions | `93efb0a3` | focused attachment route tests |
| Human-selected builder handoff and fail-closed webhook PR correlation | `1221c3c0`, `52a6c248` | focused builder-handoff and signed-webhook tests; unlinked PRs are never auto-attached or reviewed |
| Independent criterion review validation and generic-smoke rejection | `78f92fc4` through `1034f42e` | `evidence-review-validation` and runner completion tests |
| Blocking-only review boundary and advisory-lane removal | current migration slice | `evidence-review-validation` rejects unsupported bases, missing evidence/impact/correction/reverification, and style-only convention claims. The Jace reviewer subagent, root PR-comment tool, review-job worker/prompt/console transport, Console PR-comment/review-job endpoints, and their tests are removed. Focused Jace tool-policy, webhook, and acceptance-spine tests plus a fresh Node 24 build pass. Historical `review_jobs` migrations and deployed rows are deliberately retained but have no application schema, query, route, or worker caller. Canonical exact-head Acceptance Review is the sole supported Jace merge-gate path. |
| Correction delivery acknowledgement seam | `429eb1a2` | focused MCP acknowledgement tests |
| Automatic correction queue, builder-task inbox, durable Jace fallback, native MCP read/ack, and GitHub fallback dispatch | `7d560fcd` through `2890610f`, `f8789d6e`, `71079517` | focused review-completion/queue/ack/inbox/dispatch tests, native MCP protocol test, MCP build/typecheck, and DB typecheck. A blocking review queues the exact correction for its unique PR-attached handoff when one exists; packets retain exact review revision and runtime evidence. Without a recorded builder handoff, it instead queues a target-validated `jace_task_inbox` packet on the same Acceptance Record. The inbox is durable and inspectable in the Record, but stays `queued`: it does not invent a recipient, acknowledgement, repair, or resume claim. A builder can retrieve its recorded task's MCP packet and acknowledge it through scoped MCP tools. The MCP acknowledgement now sends the required recorded builder/task-context identity as well as the delivery ID, so it reaches the server's fail-closed acknowledgement seam instead of making an incomplete request. GitHub dispatch posts a COMMENT-only PR issue-comment only for the current exact head and records delivered/failed. Neither carrier proves a live builder was notified or resumed. |
| Exact-head criterion verification-plan persistence | current migration slice | focused runner-plan, review-validation, and completion-route tests; DB typecheck. This is plan metadata, not runtime proof. |
| Review-bound UI artifact storage | current migration slice | focused artifact-plan/plan-route and DB resolver tests; DB typecheck. The route derives the criterion/repo/head from a current persisted UI plan, requires the browser's observed URL to match the current exact ready preview origin, and records a digest; it does not exercise a flow or declare a pass. |
| Review-bound redacted API artifact storage and safe execution descriptor | current migration slice | focused Console plan/claim/upload and DB resolver tests, Jace prompt/uploader/worker-core tests, DB typecheck, and Node 24 Jace build. A planned API criterion must carry immutable `GET` + same-origin path + expected-status metadata and is claimed only against its exact ready PR-head preview. At API-artifact upload, the server re-resolves that preview and rejects any missing/non-ready/mismatched preview or request whose origin, method, path, query, fragment, or status diverges from the descriptor. QA is instructed to upload a redacted request/response/assertion card through the plan-bound artifact route. Mutating, credential-bearing, and external requests are rejected from this path. No deployed execution or independent semantic assertion evaluator is proven; the artifact is not itself a pass. |
| Bounded Context Pack handoff metadata | current migration slice | focused MCP/user route and validator tests; requires budget, cited ranges, confirmed criterion IDs, explicit boundaries/tests/decisions/exclusions, freshness, and no-full-source custody. |
| Task-scoped external-builder Context Pack handoff | `fd297f13`, `c2e395fd`, current Console handoff slice | focused Console detail/handoff and MCP builder-task route tests, native MCP protocol test, MCP build/typecheck, and DB typecheck. A human can now select an external builder, stable task key, and planned branch in the Acceptance Record Console only after a confirmed Contract and execute Context Pack exist; the server revalidates all repository/contract/Pack bindings and persists the route for PR correlation. A scoped builder can retrieve only its recorded handoff's confirmed contract and selected bounded Context Pack metadata/artifact references; it cannot retrieve raw source. The response is fail-closed on the delivery audit: before it exposes the Pack, Jace records the exact pack, handoff, builder task context, authenticated MCP credential, and delivery timestamp under an idempotent key. This is evidence of delivery to that authenticated task context, not proof of implementation, use, or a live external-builder session. |
| Canonical hosted intake, session-bound draft, reply evidence, and bounded resume readback | `742eafe9` through `e913c16e` | DB identity/link/readback tests and typecheck; focused Console intake/draft/outbound/readback route tests; Jace hosted-inbound, intake-draft/reply/readback, channel-wiring, and tool-policy tests; Node 24 Jace build. A bound Console/Telegram/Discord/Slack turn records durable channel/conversation/source provenance before Eve receives it. Jace receives only the Console-returned Intake ID in trusted session attributes. It can draft a parsed immutable Record and, after a compaction, retrieve only a bounded first-inbound plus recent-tail/contract projection. It cannot select a tenant or Intake, confirm, compile/deliver a Pack, select a builder, execute code, or claim success on a degraded response. Final replies are appended only after channel delivery returns. No live channel round-trip is proven. |
| Channel-bound contract confirmation | current migration slice | focused runner confirmation, Jace confirmation-core, hosted-inbound wiring, and tool-policy tests. Each hosted inbound turn binds its provider message key to the trusted Eve session. Jace can confirm a completed draft only from the current bound message; the Console refuses it unless that message is inbound, belongs to the same Intake, and follows the draft. The Contract records a channel-source actor. Confirmation still does not compile/deliver a Pack, select a builder, execute code, or merge; no live channel round-trip is proven. |
| Channel-bound and Console Context Pack compilation admission | current migration slice | focused runner/Console admission tests and Jace build. A confirmed session-bound Intake or owner/admin Console user can admit only its connected repository and confirmed Contract to the existing bounded `execute` compiler worker. The Console exposes this as “Prepare execute Context Pack” only when no execute Pack is recorded; it reports queued/already-admitted status, never a fabricated Pack or implementation. The admission has no builder, repository, source, or Pack input. No deployed compiler run is proven. |
| Console navigation, Home, and connector trust-layer pivot | `240ee81a`, `be45aea9`, `4c855efe`, `db0fef6`, `7f21c5ea`, `d5c2a63a`, `52d9e454`, `caf1db9a`, `435c27fe` | Focused Dashboard and connector tests. Acceptance Records and Approvals are primary. Home’s current primary surface is `OnboardingBanner`, then a server-rendered trust-outcome section with a shared server-validated `24h`/`7d`/`30d`/`1y` range selector, then `AcceptanceEvidencePanel`. Invalid/missing range input falls back to `30d`; callers cannot supply arbitrary bounds. The summary reads only canonical current exact-head evidence reviews, their Jace verdicts, append-only human decisions, and pending review/decision work. It renders distinct cards and honest counts/zeros/no-data state, preserves the Jace `not_proven` versus human `changes_requested` distinction, and does not call legacy factory/review-event metrics or poll the client. The raw outcome query binds ISO-UTC timestamps because this database driver's raw-SQL path rejects JavaScript `Date` parameters. Focused DB and Console tests pass; direct authenticated local database reads succeeded for all four ranges. Dia previously rendered the old migrated-database zero-state without the prior page error; the new range UI still needs an uncontended Dia browser check. No real completed review or final human decision has been exercised. `AcceptanceEvidencePanel` loads the five most recent Record headers and presents record-detail links, repository, issue/PR attachment, lifecycle state, updated time, and an honest empty state. Legacy digest/health component files may remain present but unmounted; compatibility/history routes may remain URL-reachable, and neither is a primary Home surface. Evidence & context exposes only Wiki; `/review-gates` remains URL-reachable for compatibility/history but is not product navigation. The Connector page keeps GitHub as the repository/PR/task-provenance anchor and preserves optional MCP/context plus investigation evidence providers; the connector sheet no longer renders heartbeat controls, while backend compatibility remains untouched. No live connector proof is claimed. |
| Durable Brief provenance and Brief/Acceptance transition visibility | `0b454670`, `76f62704`, `38bff08a`, `5e89ebcb`, `316a90e0`, `9e9797b6` | A long-lived editable Brief may seed multiple Acceptance Records; each Record has at most one source Brief. Each transition captures a workspace-scoped immutable header-plus-typed-item snapshot and provenance; later Brief edits cannot rewrite any Contract, Context Pack, review evidence, or decision. Brief detail shows zero/one/many linked Records, and Record detail links back to its current Brief while distinguishing the immutable snapshot from current editable context. Console chat now derives only the authenticated member's exact workspace-scoped `console` Intake, then returns a bounded navigation projection: Intake status, linked Record ID, and current Brief title/slug/status only when that Record already has a binding. The strip honestly distinguishes no Intake, no Record, and no linked Brief, and links the existing authorized Brief editor plus Record detail; it cannot create/bind a Brief, edit it inline, or expose source messages, contract, Pack, or immutable snapshot. Focused DB schema/integration tests, focused Console route/component/page tests, chat-context tests, and both package typechecks pass. The migration was not applied to a local database and no authenticated Console browser or hosted channel round-trip ran. |
| Copy-only landing trust-layer pivot | current migration slice | focused marketing craft/pricing-copy suites and local browser evidence. The existing landing structure now presents “Approve agent work with confidence.” and explains that Jace gives engineering teams evidence and control to trust AI coding agents. It describes Jace as the acceptance/evidence layer around Codex, Claude Code, or another selected builder; it no longer presents legacy factory run totals as trust proof or says Jace itself ships a PR. The chat demonstration shows task → Acceptance Contract goal/boundary/checkable criteria → human contract confirmation → bounded Context Pack for the selected external builder, rather than a model estimate/approval/run-outcome sequence. The existing phone, outcome, How-it-works, channel, stats, pricing, and closing-CTA sections were preserved while their copy now says: keep the existing coding agent/environment, set the bar, inspect exact-change evidence or a correction/stop path, then decide. Browser inspection at `http://localhost:3000` exercised the demo confirmation state and captured its post-confirmation text; the dev process logs Auth.js `MissingSecret`, so authenticated Console flow is still unverified. The shared pricing-card capacity and price packaging remain a separate commercial decision; this copy slice does not claim a live external-builder or channel round-trip. |
| Exact-review final human PR decision | current migration slice | focused Console route/detail and DB decision-validator tests; DB typecheck. Owners/admins can append one immutable `approved`, `changes_requested`, `rejected`, or explicit `approved_with_exception` decision only for a current exact-head Evidence Review. A standard approval is refused unless Jace recorded `proven`; an exception requires a rationale and does not alter Jace's independent verdict. This records no GitHub merge and has no migrated-DB or browser proof yet. The older `review_events` rework/revert ledger remains aggregate outcome infrastructure only; it is not used as the acceptance decision source. |
| Dependency-proposal Acceptance Record draft and legacy-approval quarantine | `bfbe61af` plus current migration slice | Focused converter/runner-route tests and three Console approval/Telegram suites (79 tests). A dependency candidate proposal becomes one deterministic canonical Acceptance Record for its connected repository. Candidate scope, baseline, expected files, verification commands, stop conditions, and every missing evidence item are preserved; missing evidence is an open question that blocks confirmation. Both the dedicated materialization endpoint and the former proposal endpoint now create/reuse only that draft and source provenance—never an issue, approval, builder handoff, dependency edit, PR, or merge. Historical dependency approvals are fail-closed before their atomic resolution: Console returns `410 approval_retired_quarantined`; Telegram acknowledges the callback but leaves the row pending. No legacy approval can publish an issue or enqueue work through supported channels. The publisher/query/schema cleanup remains after a migrated-production data inventory and forward migration; there is no live inventory or migration proof. |
| Criterion execution queue, guarded result seam, and opt-in exact-plan worker | `ee6f36d7` through `ec9bfc08`, `fbef412f`, `0a615e7f`, current safe-preview queue slice | Focused runner admission/completion, artifact, plan, worker-core/worker-runtime, API/browser executor, console-client, migration-schema, and DB proof-modality tests; DB query typecheck. The worker claims only plan-bound exact-head UI/API jobs whose matching preview is `ready` with a URL. A planned UI criterion persists a bounded immutable `uiSteps` list; a planned API criterion persists only `GET` + same-origin path + expected status. UI uses only those persisted browser actions through a private sidecar, captures a same-origin PNG/JPEG, and uploads it through the plan-bound route. API uses no root-Jace/QA model turn: it performs only the persisted same-origin `GET`, omits credentials, rejects redirects, never reads the response body, compares only the planned status, and uploads a redacted plan-bound request/status/assertion card. A `proven` result requires an artifact from that exact plan with the planned proof type: PNG/JPEG for UI and JSON for API. Unsafe/missing descriptors and previews are `not_testable`; a safe request failure, redirect, status mismatch, or storage failure is `not_proven`. The route and DB query refuse planned `job` or `data` modalities, which remain explicitly `not_testable`. Production Compose contains private browser-sidecar wiring and worker activation remains an explicit Console-token/artifact-store opt-in. No service has been deployed and no safe-preview UI or API flow has run live. |
| Acceptance Context Pack compilation, custody reduction, and guarded report | `f527d095` plus current slice | Owner/admin admission binds a confirmed Contract, connected repository, captured ref, and phase. A default-off compiler worker claims only that tuple, disposable-clones the ref, rebuilds the index, compiles an `acceptance_record` Pack, reduces it to cited metadata, and reports it through a Jace-secret route. The route re-reads the claimed Contract, validates exact criteria/budget/custody/freshness, records the Pack, then marks the job compiled; raw source is rejected from manifest, custody, and freshness. Hermetic failure and real local clone/index/compiler/cleanup tests pass. No deployed claim/clone/report or external-builder retrieval is proven. |
| Acceptance Case corpus, independent scorecards, four-arm inputs, offline orchestration, promotion, and report publication | `81468b7d`, `1b6cf127`, `fd674f05`, `386f58a1`, `7cffd035`, `1b624466`, `1f8842e3`, `90b9c404` | Focused Python tests validate frozen dev/held-out Cases, arm-separated independent scorecard denominators, a contract version, and a custody-only bounded Pack descriptor. A corpus manifest now binds every `case.json` SHA-256, corpus version, declared label class, label-authority identity, and complete inventory; drift, missing files, and unmanifested Cases fail closed. The held-out promotion/market boundary rejects `synthetic` fixtures even when they parse. The manifest cannot itself make labels independent: that authority must be supplied and audited outside the evaluated agent. The production-facing manifest-bound evaluator always re-admits the recorded corpus root, including when handed a typed corpus object, derives cases and splits only from that manifest, and carries corpus version/label authority/case digests/splits into the resulting offline report. The pure arm-input contract exposes only the frozen request to `agent-alone`; adds only the approved Contract to `contract-only`; adds the bounded Pack descriptor only to `contract-plus-pack`/`full-jace-loop`; and binds evaluator-only lineage to the case/version, contract version, exact PR head/diff, environment, and applicable Pack hash/budget. The offline runner expands every Case into exactly all four arms, gives the selected-builder adapter only its legal arm prompt plus a pinned operational checkout, then requires the adapter's returned PR head/environment to match the frozen Case before an evaluator-owned scorer constructs observations. No preselected PR head, case object, hidden label, source oracle, or conversation is given to the adapter. A pure proof verifier/scorer validates fixture-owned exact-head/environment artifact metadata: criterion-specific UI PNG/JPEG, redacted API JSON/status, job trigger/output, and data readback/assertion. It reports separate modality-outcome and modality-artifact-validity segments, so invalid evidence on an otherwise passing feature is visible as a proof false green; missing/ambiguous truth is `unscored`. Every observation carries complete immutable case/corpus/repository/contract/model/config/prompt/guardrail/pack/PR/environment/artifact/scorer/outcome-source provenance, with explicit `none` only for non-pack arms. Pure promotion accepts only a complete four-arm held-out offline matrix under caller-declared per-scorecard/segment floors; missing/unknown data holds, measured violations reject, and canary/production observations never become offline truth. The offline `acceptance-report` publisher validates caller-supplied versioned JSON and writes deterministic Markdown that retains observation provenance and explicit denominators, including honest empty evidence. It does not create a corpus, run a builder/scorer, calculate promotion, or make a product-benefit claim. The runner still has no live builder adapter, real independently scored fixture corpus, persisted corpus run, CLI/canary caller, or market-value result. |

The next runtime-proof slice must run these direct executors against planned
safe UI and API flows and bind their observed results to these artifacts. Delivery is currently queue plus
acknowledgement only; no dispatcher has proven notification.

## Remaining work, in dependency order

### Context Pack custody and source-resolution ledger

- Durable acceptance intent is the confirmed, versioned Acceptance Contract in
  the Acceptance Record: it defines what the human approved and remains the
  authority for the task.
- The bounded per-task Context Pack is the compiler's metadata-only selection:
  cited paths/ranges, a reason for each selected source, token budget, stable
  hashes, exclusions, and freshness including the claimed immutable
  `repositoryRef`. It contains no raw repository source.
- Just-in-time source resolution belongs to the local builder checkout: Codex,
  Claude, or another selected builder rehydrates the cited ranges from its own
  repository at that ref. The server exposes the bounded pack and exact ref,
  not a source mirror.
- This implementation is still not live external-builder proof. Unit/focused
  tests cover the metadata, compiler cleanup, handoff, and read seams; no live
  Codex/Claude pickup, source rehydration, acknowledgement, or resumed task is
  established.

1. Run the new worker against a safe exact-head environment and prove a
   criterion-specific UI flow end to end. Add redacted API/job/data execution
   and artifacts rather than forcing those modalities through screenshots.
2. Prove a live supported external-builder delivery path and resume semantics.
   The automatic task-context queue, durable Jace inbox, native MCP read/ack,
   and GitHub fallback dispatch retain attempt/outcome, but no Codex/Claude builder has retrieved a
   packet, acknowledged it, or resumed work in a live integration test.
3. Prove a live supported Intake → missing-question → draft → human
   confirmation round-trip. Hosted Console, Telegram, Discord, and Slack now
   have append-only input/reply evidence and Jace can fetch a bounded resume
   projection, but no deployed channel has exercised that flow or proved that
   only unresolved questions were asked.
4. Remove the now-obsolete dependency approval/publisher callers after a
   production-data audit and forward migration; finish Console removal of
   obsolete connector/factory surfaces, and
   complete the copy-only landing pivot. The final human PR decision is now a current-review append-only
   seam, but it has not been exercised live in the migrated database/browser and does not capture
   post-merge rework/revert; those remain explicit aggregate outcome evidence.
   The sidebar is now trust-first, but routes/catalogs and the homepage still
   contain legacy product language or surfaces.
   Add the explicitly linked Brief-to-Acceptance transition and the dated
   canonical outcome summary without replacing the editable Brief or reusing
   legacy factory/review-event metrics. The Home zero-state summary itself is
   now Dia-browser verified against the local migrated database; the link must retain immutable source
   provenance at Contract/Record creation; the summary must state its time
   range, show honest empty/zero states, and distinguish evidence verdicts
   from human outcomes.
   Prove the hosted-chat/Console Brief interaction in an authenticated browser
   against a migrated database and live Intake. The current strip lets a user
   open the existing authorized Brief editor while a task conversation is
   shaping a Contract; it must continue to use the same provenance rather
   than create a channel-local Brief or mutate confirmed Contract/Pack
   history.
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
   four-arm orchestration, pure criterion-proof verifier/scorer, and pure
   tri-state promotion gate now exist; there is still no live builder adapter,
   real corpus, persisted corpus run, or market-value
   result.
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
| Remove: approval-to-issue execution | `bfbe61af` removed the reachable dependency branch from `apps/console/lib/approval-decision.ts` and guards Console/Telegram before `resolveApproval`; supported channel actions now leave legacy rows pending and return an explicit quarantine result. `dependency-upgrade-publisher.ts` and its direct unit test remain as unreachable historical code until the data migration removes the last dependency-approval bindings. | The production-data inventory must still explicitly quarantine or supersede every pending `jace_approvals` row with `tool_name = dependency_upgrade_contract` or a non-null `dependency_contract_id`; do not silently mark it approved/denied or claim publication. After that audited migration, delete the publisher and residual approval-coupled query/test code. Generic approval behavior must remain covered. |
| Replace: approval-coupled schema and query API | `dependency_upgrade_contracts.state`, `approval_id`, `issue_url`, `issue_number`, legacy state/event vocabulary; `jace_approvals.dependency_contract_id`; `attach/decide/set/publish` query functions and related foreign key. Migrations `0074`/`0076` are historical evidence and must not be edited. | Add a forward, reversible migration after data audit: retain/copy source provenance, create source-ledger fields/table if needed, write a durable migration report linking any old row to its Acceptance Record or an explicit `not_migrated` reason, then drop approval/issue columns and the approval foreign key only when no caller or pending row remains. Add replacement tests before removal. |

Deletion order: (1) inventory migrated production data and back it up; (2)
quarantine/supersede historical pending dependency approvals in durable data;
supported Console and Telegram actions are already fail-closed by `bfbe61af`,
but that is not a data migration; (3) migrate source rows and link them to
canonical Records where valid; (4) migrate callers and run targeted database/
route/heartbeat coverage; (5) remove the now-unreachable publisher and
approval-coupled code; (6) run a forward schema cleanup migration. Existing
migration files and historical events are retained as audit history. This plan
deliberately does not treat a source-code search as proof that production has
no old approvals.

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

- No Codex/Claude live pickup, live MCP/Slack/Discord/Console acceptance-draft or
  reply-recording round-trip, session-resume Intake read, GitHub canonical PR
  fetch, context compiler attestation, deployed safe-preview execution,
  browser proof, non-UI artifact capture, Jace live delivery dispatch, or
  migration smoke exists yet. The opt-in exact-plan worker is unit-tested only;
  its runtime must not be represented as an exercised criterion. The native
  MCP server is unit-tested to call the durable correction inbox and receipt
  endpoint, but no live external builder has done so; only its recorded
  acknowledgement proves receipt. MCP now has an in-code virtual Jace channel:
  credential-bound start/reply calls create or resume the same canonical Intake
  and Jace replies into its bounded durable message evidence. Its explicit
  task-context replies are not independently authenticated human identity, and
  no deployed/live Codex or Claude clarification, confirmation, Context Pack
  delivery, or builder-resume round-trip is proven.
- Worktree: `/Users/macbook/work/bensigo-ai-workflow-trust-record` on
  `codex/trust-layer-acceptance-record`; committed product slices include
  `d8dc8601` (metadata-only local Pack manifest), `9e45e856` (compiler bridge
  plan), `93946d66` (eval removal map), and `4b735b27` (dependency source to
  Acceptance Record), and `f527d095` (compiler job admission/claim). The
  latest committed cleanup is `88c8f153` (removal of the advisory reviewer
  lane). `6deea890`, `cb190b86`, and `3488a058` retire the direct-draft
  contradiction and add the virtual MCP transport. Their focused test evidence
  is recorded above; no live MCP clarification/confirmation behavior is being
  inferred from it.
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
expanding scope. The advisory-review cleanup was completed locally after a
short read-only audit failed to return a bounded result; historical database
rows were retained while all application callers were removed. The MCP
direct-draft bypass is now retired in favor of credential-bound Intake start,
with an explicit no-live-clarification claim. The next slice must either
provide an honest MCP question/confirmation loop or advance the still-bounded
runtime-proof/delivery work without claiming that loop exists. Separately, a
bounded dependency-lane map remains required before any destructive cleanup
and must classify every approval/publisher caller as remove, neutral
infrastructure, or still-needed compatibility.

The virtual MCP Jace-channel slice was delegated to one bounded implementation
agent and independently cross-checked before integration. The matching
Console/MCP glue stayed local only because the available agent slots were full
and it depended on the just-retired route's exact identity contract. The next
two implementation slices return to one-owner delegation where capacity is
available: first an independently scoped runtime-proof modality, then its
cross-slice integration/verification; neither may edit overlapping paths.
The next review-request claim slice is a local exception: its claim,
supersession, and review-completion changes all share one atomic queue state
machine. A bounded read-only audit was attempted to compare the Context Pack
lease pattern, but the available subagent thread limit rejected it before any
work started. The coordinator therefore reuses and tests that pattern locally;
no broad reviewer or autonomous implementation work is delegated.
