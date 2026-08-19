# Jace trust-layer migration ledger

Last reconciled in this proof checkout: 2026-08-13 against the exact main tree
at commit `18d30306f45adbe419eb24dcc4d3c5a6fb106383` and the follow-on Console
product-shell source changes described below. The pull-request description
must bind this ledger to the branch's final exact head and CI result. This
ledger claims only the bounded authenticated local browser exercise captured in
`docs/screenshots/console-product-shell-*.png` for that follow-on slice; it does
not claim deployed/live or customer proof. Canonical R10 completion and release
proof remain open.

This is the main-branch continuation of the canonical R1–R12 release gate
preserved in historical commit `4d21a409`. It keeps the original acceptance
criteria; it does not replace them with implementation history.

## Proof language

- **Source/test** means the bounded code path and focused tests exist.
- **Local runtime** means the integrated path ran locally, including real
  PostgreSQL where persistence is part of the claim.
- **Deployed/live** means the relevant hosted or external-provider path ran.
- **Customer** means a real customer request completed the path.

Source/test or local runtime proof must never be described as deployed, live,
or customer proof.

## One-time PR #1638 salvage reconciliation

This is the terminal inventory for original draft PR #1638. Future work must
use this section instead of reopening or rediscovering that draft.

- Current-main base: `9d80b70f52d8a386b215e0811b2777a21ee715de`.
- Original draft head: `1fe3729db53dd01f1405ec189e4e33e118057c02`.
- Merge base: `72c4b82892d2ee4da01d94238f7526a80537f3a6`.
- Original final diff: 231 commits, 355 files, 23,742 insertions, and 18,055
  deletions.
- Clean replacement source head before this ledger-only commit:
  `cf94888dd7339e56565dc3a3bbd32a4abfb1a9b7`.

Do not restart, update, or merge PR #1638. The replacement preserves current
main on conflict and carries only the compatible missing behavior below.

### Absorbed value

- **Acceptance Intake lifecycle.** Replayed `cc9a4bb0` and `e913c16e`. Hosted
  channel turns retain a trusted Intake binding; Jace can create a draft and
  read a bounded resume projection without confirming a Contract itself. The
  weaker outbound-reply and channel-confirmation paths are excluded below.
- **Immutable Brief provenance.** Replayed `0b454670`, `76f62704`, and
  `57d0dc24`. One Brief can bind multiple Records; each Record retains one
  deterministic Brief snapshot, SHA-256, provenance, and exact confirmed
  Contract identity. Snapshot reads use repeatable-read isolation. The query is
  fail-closed and tested, but no current-main production transition safely
  supplies the Brief identity yet, so automatic binding remains named source
  work rather than an implied runtime claim.
- **Local Acceptance Record Context Packs.** Replayed the compatible local
  compiler behavior from `989e3b7c`, `a4f7b8cc`, `d8dc8601`, `9517d8e6`, and
  `2560b1a1`: an `acceptance_record` target, confirmed Contract input, bounded
  cited/redacted retrieval, exclusions/gaps, deterministic hash, custody,
  freshness, JSON, and Markdown. It does not replace current main's newer
  exact-head Pack database model or claim a hosted worker. Salvage fix
  `991ecb82` applies the same redaction policy to the derived Pack goal, and
  `8b17bc1f` keeps the workspace index on current authoritative head custody.
- **Offline Acceptance Case evaluator.** Replayed the manifest-bound corpus,
  four isolated arms, independent scorecards, exact-head/environment proof
  validation, tri-state promotion, deterministic report publisher, tests, and
  evaluation PRD from `81468b7d` through `90b9c404`. It provides offline
  evaluation infrastructure only; it does not prove a product AC, live builder,
  customer outcome, or market value.
- **Operating authority.** Retained the trust-layer `AGENTS.md`, reconciled
  `CONTEXT.md`, and durable ADR 0012 decision while removing stale
  implementation inventories that conflict with this ledger.

### Console UI disposition

The production Console was reported to still show the old experience. Source
comparison is not deployment proof; these rows state only what the replacement
branch changes.

| PR #1638 UI family | Disposition | Exact current surface |
| --- | --- | --- |
| Workspace Context Packs index, navigation, and breadcrumb (`181c372b`) | **Absorbed and adapted.** Main had no workspace index route. The replacement adds a bounded current-authoritative-custody list, a Context Packs item under Evidence & context, and the matching breadcrumb. | `apps/console/app/(dashboard)/dashboard/[workspaceId]/context-packs/page.tsx`; `apps/console/app/components/sidebar-nav.ts`; `apps/console/app/components/breadcrumb-label.ts` |
| Brief-to-Acceptance transition (`38bff08a`, `5e89ebcb`) | **Absorbed and adapted.** The panel lists immutable Record links without claiming confirmation. It moved out of the Next.js page module so the current App Router type contract remains valid. | `apps/console/app/(dashboard)/dashboard/[workspaceId]/briefs/[slug]/acceptance-brief-transition-panel.tsx`; `apps/console/app/(dashboard)/dashboard/[workspaceId]/briefs/[slug]/page.tsx` |
| Chat Acceptance Context strip (`316a90e0`, `9e9797b6`) | **Absorbed.** The authenticated chat route derives its Intake from the member's server-owned conversation identity and returns only bounded Intake/Record/Brief navigation. The client cannot select those identities. | `apps/console/app/(dashboard)/dashboard/[workspaceId]/chat/components/acceptance-context-strip.tsx`; `apps/console/app/(dashboard)/dashboard/[workspaceId]/chat/components/chat-thread.tsx`; `apps/console/app/api/v1/workspaces/[workspaceId]/chat/route.ts` |
| Wiki recompile terminology (`7f21c5ea`) | **Absorbed.** The queued state now names repository Wiki compilation instead of presenting Jace as a factory. | `apps/console/app/(dashboard)/dashboard/[workspaceId]/wiki/components/recompile-button.tsx` |
| Home Acceptance Evidence (`be45aea9`) | **Presentation intent adapted; old component excluded as superseded.** Home now foregrounds the current tenant-scoped, occurrence-aware Acceptance Record summary rather than replaying the old evidence panel. | Old: `apps/console/app/(dashboard)/dashboard/[workspaceId]/components/acceptance-evidence-panel.tsx`; current: `apps/console/app/(dashboard)/dashboard/[workspaceId]/components/acceptance-record-summary-list.tsx` |
| Home outcome summary/ranges (`52d9e454`, `435c27fe`, `980e7118`) | **Presentation intent adapted; old components excluded as superseded.** Home retains the current outcome projection, including unknown and not-recorded states, while operational Digest, plan, Health, review-metric, and false-green panels leave the Home composition. Their source and data paths are not deleted by this UI slice. | `apps/console/app/(dashboard)/dashboard/[workspaceId]/page.tsx`; `apps/console/app/(dashboard)/dashboard/[workspaceId]/components/acceptance-outcome-metrics-panel.tsx` |
| Changes list/detail redesign (`ce0f1e80` through `6682109b`) | **Excluded as superseded in source.** Current main has the stricter tenant-scoped, occurrence-aware, artifact-proxy-safe R11 projections at the same routes. Replaying the old pages would weaken current custody. This is not a claim that production has deployed them. | `apps/console/app/(dashboard)/dashboard/[workspaceId]/changes/page.tsx`; `apps/console/app/(dashboard)/dashboard/[workspaceId]/changes/[recordId]/components/change-record-view.tsx` |
| Review-Gates create-issue action (`0e396beb`, `63434b71`) | **Excluded as incompatible.** Current main quarantines the legacy Review-Gate issue route; Record detail uses the newer Jace-only, human-approved gated issue custody. | Old: `apps/console/app/(dashboard)/dashboard/[workspaceId]/review-gates/components/create-issue-button.tsx`; current boundary: `apps/console/app/api/v1/workspaces/[workspaceId]/review-gates/[gateId]/issue/route.ts` |
| Connector redesign/catalog/copy (`181c372b`, `714ede9a`, `5f2c3d7f`, `7f21c5ea`) | **Presentation intent adapted after the salvage; old implementation remains excluded.** Current main keeps the newer full provider catalog, OAuth/secret handling, tenant-derived rows, and fixed-height sheet UX. The authenticated surface removes the old Heartbeat/autonomous-loop controls and describes connectors as provenance, bounded context, and optional investigation evidence instead of Jace implementation authority. The old two-provider filtering and projection changes remain excluded. | `apps/console/app/(dashboard)/dashboard/[workspaceId]/connectors/page.tsx`; `apps/console/app/(dashboard)/dashboard/[workspaceId]/connectors/components/` |
| Gateway relabel and sidebar restructuring (`741cbde5`, `240ee81a`, `4c855efe`) | **Presentation intent adapted; route removal excluded.** The customer shell now uses Trust layer (Home, Briefs, Acceptance Records, Approvals), Evidence & context (Memory, Wiki, Context Packs), and the Channels label for the unchanged `/gateways` route. Work, Chat, Goals, and factory-operation pages remain code-live and deep-linkable but are absent from visible navigation. Memory is deliberately retained despite #1638 omitting it. | `apps/console/app/(dashboard)/dashboard/[workspaceId]/gateways/page.tsx`; `apps/console/app/components/sidebar-nav.ts`; `apps/console/app/components/sidebar.tsx` |
| Brief index copy (`6682109b`) | **Excluded as weaker.** Current main's durable-understanding and human-correction wording is more accurate. | `apps/console/app/(dashboard)/dashboard/[workspaceId]/briefs/page.tsx` |
| Marketing/layout rewrite (`6eee9453` family) | **Excluded from this salvage.** It belongs to the still-open R12.1 lane and cannot be treated as implicit R12 completion. | `apps/console/app/layout.tsx`; `apps/console/app/(marketing)/` |

The post-salvage authenticated-Console audit also found stale factory-authority
presentation outside the safely replayable #1638 families. Current source now
describes Review Gates as historical factory evidence, GitHub onboarding as
workspace-scoped provenance and exact-head custody, and Permissions as the
human-only merge boundary. The Console cannot create a new legacy automatic
merge grant; an owner may only revoke a historical grant. These are R11
authority corrections, not R10 implementation, R12 completion, deployment
proof, or customer proof. The customer shell hides Work and factory-operation
navigation without deleting those routes, APIs, historical data, or retained
infrastructure. Home uses current tenant-scoped Record and outcome projections;
the superseded #1638 Home and Changes components, Review-Gate issue creation,
and narrowed connector catalog remain intentionally excluded for the custody
and authority reasons above.

### Explicit exclusions

- Neither the old Intake direct-confirm endpoint nor its adapted post-draft
  approval-request branch was carried forward. The former bypassed current
  main's human approval resolver; the latter proved only that a new inbound
  message existed, not that its text explicitly confirmed the draft. Current
  main's human approval seam remains unchanged.
- The post-delivery outbound Intake recorder was not carried forward. Its
  best-effort audit write could fail after a provider delivered the reply,
  leaving canonical custody incomplete. A durable outbox or two-phase receipt
  model is required before that behavior is safe; this salvage does not invent
  one.
- The old Intake Context Pack admission/claim/report worker and compilation
  tables were not carried forward. Their routes are absent on current main and
  their metadata shape is weaker than the current exact-head Context Pack
  snapshot and compiled-Pack custody.
- Old direct `agent_mcp` credentials/scopes, direct Intake/Record/Pack delivery
  routes, and caller-selected task locators were not carried forward. This
  includes the absent MCP task-context Intake/Jace bridge from `cb190b86`,
  `3488a058`, and `8227d6f2` (`apps/jace/agent/channels/mcp.ts`,
  `apps/console/lib/agent-mcp-intake.ts`, and the old MCP Intake routes).
  Current main keeps server-selected, credential-bound read/ack seams; the old
  bridge is not queued ahead of the canonical R10.1 work.
- Old evidence-review tables, parallel reviewer worker architecture, and
  deletion of the active `review_job`/executor lanes were not carried forward.
  Current main's exact-head review, criterion execution, artifact, correction,
  human-decision, and signed-merge custody is newer and stricter.
- Legacy factory/task/product surfaces, stale schemas/migrations, old
  deployment sidecars, and the PR's marketing rewrite were not carried forward.
  Marketing is R12.1 work and remains outside this salvage implementation.
- Non-migration support edits and aliases with no current consumer were not
  carried forward.

The final finite audit covered all 231 original commits and 355 changed files.
No additional migration-aligned family is both absent from this replacement and
safe to replay on current main. This inventory is terminal; later work must use
the AC queue below rather than reopen PR #1638.

### Exact-head AC classification

These classifications apply to the replacement source head named above. An
`absorbed-and-proven in this PR` row means the named bounded source/test
contribution is present and verified; it does not convert missing deployed or
customer evidence into proof. An `already proven on main` row is not reopened
by this salvage. `awaiting deployed/live/customer proof` is a release gap, not
a source regression.

| AC | Canonical requirement | Classification | Exact boundary after salvage |
| --- | --- | --- | --- |
| R1.1 | Workspace Record and versioned Contract retain complete intent, provenance, criteria, boundaries, and codebase references. | `absorbed-and-proven in this PR` | Intake draft/readback and immutable Brief-binding primitives are source/test proven. Automatic production Brief binding is still not wired; no live request-to-outcome Record is claimed. |
| R1.2 | Append-only Record lineage joins Packs, builder, PR heads, evidence, decision, and post-merge facts without issue-keying. | `already proven on main` | New Brief binding custody is additive. Existing exact-head event and outcome lineage remains authoritative. |
| R2.1 | Primary chat, scoped MCP, and Console fallback use the same Record/approval seam. | `absorbed-and-proven in this PR` | Chat projects the canonical Intake/Record/Brief seam, and Jace can draft and read the bound Intake. Current main's human approval route remains authoritative. No deployed channel or MCP customer run is claimed. |
| R2.2 | Slack/Discord and other channels share that model instead of creating another acceptance path. | `absorbed-and-proven in this PR` | Console, Slack, Discord, and Telegram bind the same canonical Intake before Jace receives the turn. Delivered outbound reply custody is not claimed. Live provider proof is missing. |
| R3.1 | Authenticated MCP exposes bounded central Record/Contract/Pack/status/correction reads. | `already proven on main` | Old direct MCP write routes were intentionally excluded. Live customer MCP use remains separate. |
| R3.2 | MCP separates read/mutation and exposes no merge, deploy, shell, filesystem, or unrestricted source authority. | `already proven on main` | The salvaged tools remain session-bound; the no-second-write-path suite covers the expanded tool set. |
| R4.1 | An Acceptance Record Pack carries Contract/questions, bounded authoritative context, exclusions/gaps, custody/freshness/redaction, budget, and compiler version. | `absorbed-and-proven in this PR` | The compatible local compiler is restored and focused-tested. The obsolete hosted worker was excluded; current-main central Pack custody remains authoritative. |
| R4.2 | JSON/Markdown Pack representations reach only the selected builder and delivery is not implementation proof. | `already proven on main` | Local compiler outputs both forms. No real external builder retrieved them in this PR. |
| R5.1 | Manual/MCP/GitHub discovery and explicit human disambiguation safely select a Record. | `already proven on main` | No PR #1638 correlation path replaced current main. |
| R5.2 | Attachment and evidence bind workspace/repo/PR/head and invalidate stale heads. | `already proven on main` | Current occurrence-aware exact-head custody is preserved. |
| R6.1 | Review retains Contract version, exact head/diff, criterion evidence/refusal, risk/environment, and verifier metadata. | `already proven on main` | Offline evaluator is separate post-MVP evidence infrastructure and does not replace the product review. |
| R6.2 | Terminal states are exactly proven/failed/not_proven/not_testable and required non-proof blocks. | `already proven on main` | Old review architecture was excluded; current blocking semantics remain. |
| R7.1 | Verification uses an existing preview, bounded isolated exact-head boot, or explicit not_testable, with cleanup. | `already proven on main` | No old sidecar or runtime path replaces current preview/executor custody. |
| R7.2 | UI/API/data/job proof is safe, criterion-specific, and retains bounded artifacts. | `already proven on main` | CI/local runtime evidence remains main evidence; deployed safe-preview proof remains separate. |
| R8.1 | Failed/unproven required criteria create evidence-bound correction packets. | `already proven on main` | No correction implementation was replayed. |
| R8.2 | Correction retrieval is bounded through MCP/chat/Console and issue creation is gated. | `already proven on main` | The salvaged chat strip is navigation only and creates no second correction path. |
| R9.1 | Human accept/rework/reject/revert/unknown decisions remain explicit and Jace never merges. | `already proven on main` | No old decision writer or merge authority was replayed. |
| R9.2 | Effort/outcome metrics preserve denominators and known/unknown samples. | `already proven on main` | Offline evaluator scorecards are additive and do not relabel product outcomes. |
| R10.1 | Dependency observations use the R1-R9 spine and refuse unsafe runtime, lockfile, baseline, or security evidence. | `still incomplete source work` | This salvage does not change the accepted manager matrix. Required unsupported managers/canonical callers remain open. |
| R10.2 | Human-approved dependency work produces a bounded external-builder Pack or explicit optional managed route and re-enters exact-head review. | `still incomplete source work` | Current safe Pack foundation remains; end-to-end supported-manager delivery/re-entry depends on R10.1 completion. |
| R11.1 | Primary Console is Acceptance/Changes-first and answers intent, context, PR/head, proof, unknowns, decision, and outcome. | `awaiting deployed/live/customer proof` | Current-main source remains authoritative. Production was reported old; no authenticated deployment proof was available in this checkout. |
| R11.2 | List/detail/timeline, Contract/Pack, evidence/artifacts, corrections, decisions, and honest metrics are accessible without factory primacy. | `absorbed-and-proven in this PR` | Context Pack index, Brief transition, and Chat context are restored around current main's stronger Record surfaces. Source/tests are proven; deployed/live and customer proof are missing. |
| R12.1 | Landing tells the ordered Trust Layer story without factory/codegen/auto-merge/live-looking claims. | `still incomplete source work` | The known copy regression remains owner-held and outside this salvage. The PR #1638 marketing rewrite was not used as an implicit R12 fix. |
| R12.2 | Technical docs retain optional adapters and pricing remains an honest team experiment. | `awaiting deployed/live/customer proof` | Current-main source/test closure is preserved; no hosted commercial or customer proof is claimed. |

### Next queue after salvage

1. **First actual unfinished AC: R10.1.** Continue the accepted-manager matrix
   and authenticated evidence callers. Every unsupported manager remains
   `refused_unsupported_profile`; no weaker PR #1638 adapter is reusable.
2. **Then R10.2.** Prove an approved supported-manager Pack reaches one selected
   external builder and re-enters the existing exact-head review path.
3. **R11 proof lane.** Deploy the replacement Console source, then run an
   authenticated production journey over Changes, Context Packs, Brief
   transition, Chat context, artifact access/refusal, and decision controls.
   Customer proof remains separate.
4. **R12.1 remains open but outside this salvage execution.** Do not silently
   absorb it into UI or marketing work.

## Direct Jace MCP planning/control continuation

This branch advances the source/test portion of R2.1 and R3 for a coding
agent that needs to talk to Jace directly, rather than only query repository
context or correction packets. It extends the existing stdio MCP server with:

- `jace_turn`, an idempotent planning, brainstorming, intake, and control turn
  bound to `mcp:<credential>:<task>` identity; and
- `jace_task_get`, a bounded read of one exact `messageKey` reply and the same task's Intake,
  server-linked Acceptance Record, Contract, exact-head Context Pack identities,
  and status.

The dedicated workspace-level `agent_mcp` credential derives the workspace;
generic runner/fleet keys are rejected, and default legacy bearer consumers
reject `agent_mcp`. Neither tool accepts a workspace or Record locator. Jace
can draft through the existing bound-Intake tool, but MCP
task text is not authenticated human confirmation. The surface exposes no
builder dispatch, implementation, merge, deploy, shell, filesystem, raw source,
or opaque artifact read. Jace reply delivery is the durable outbound Intake
write itself, so missing custody fails the virtual channel instead of claiming
delivery. Source/tests are proven by the focused Console, MCP, database-build,
and Jace suites on this branch. No deployed/live or customer MCP conversation is
claimed.

## R8 exit reconciliation

R8.1 and the canonical R8.2 source/test implementation are closed. There is
no R8.3. R8 remains **FAIL / not release-ready** because deployed/live and
customer proof are still missing. A missing live proof does not reopen a
completed source slice unless a regression is found.

The compact R8 gate remains: the correction reaches the associated builder
task context or durable fallback, records delivery/acknowledgement, and
never claims repair or resume without a receipt.

| AC | Canonical requirement | Source/test | Local runtime | Deployed/live | Customer | Implementation exit |
| --- | --- | --- | --- | --- | --- | --- |
| R8.1 | Failed or unproven required criteria create evidence-bound correction packets with the original criterion, observed and expected behavior, reproduction, affected context, evidence, and scope boundary. | Complete. The immutable packet path landed in PR #1652. | Complete. Packet identity, validation, and PostgreSQL custody ran locally. | Missing. | Missing. | **Closed.** |
| R8.2 | Packets are retrievable through MCP/chat/Console; follow-up GitHub issue creation remains gated. | Complete. MCP, primary Jace chat, and Console resolve the same server-validated current packet custody. Those retrieval surfaces remain read-only; the later R11.2c path permits one separate Jace-only, human-approved issue for exact current custody. | Partial. Persistence and current-cycle isolation ran against local PostgreSQL, and the adapters passed local tests/builds. No authenticated browser-to-server or external-provider run was performed. | Missing. | Missing. | **Source/test slice closed; release FAIL until deployed/live and customer proof exist.** |

The R8.2 extension is part of R8.2, not a new acceptance criterion:

1. Jace derives one selected builder route. It never broadcasts to multiple
   builders.
2. The Context Pack and correction packets are bound to the current PR head,
   head cycle, confirmed Contract, source custody, and compiled Pack identity.
3. GitHub publication is two-stage: ordinary finding comments contain no
   vendor mention, followed by at most one final mention for the selected
   recipient with the bounded immutable packet bundle.
4. A GitHub `201` comment receipt proves carrier acceptance only.
5. The Claude acknowledgement lane proves that a pinned GitHub workflow
   reported successful completion of the pinned Action with a session ID. It
   is not independent Anthropic attestation and does not prove agent start.
6. Repair-head evidence proves that the selected run observed an exact signed
   successor transition. It does not prove commit authorship or repair success.
7. If the selected GitHub carrier cannot be accepted, the same immutable
   dispatch can terminate in durable Jace custody. That fallback is not a
   carrier receipt, vendor activation, acknowledgement, or repair.
8. A new PR head invalidates the old operational dispatch. An A→B→A revisit
   gets a new head cycle and cannot revive old work or receipts.

## R8 implementation evidence

The implementation sequence is intentionally split into narrow pull requests:

- #1654–#1658, #1660–#1662, and #1664: selected route, exact-head Context Pack
  custody, compilation, dependency path proof, and persisted compiled Pack
  identity.
- #1665–#1668: current-head invalidation and reconciliation, selected dispatch,
  and server-owned carrier capability.
- #1669–#1671: GitHub preflight, two-stage carrier, carrier receipt, and the
  trusted production caller.
- #1672–#1673: one verifiable Claude acknowledgement lane and exact successor
  repair-head evidence.
- #1674: same-dispatch durable Jace fallback with no second vendor route or
  GitHub post.
- #1676: one server-derived current correction-packet resolver exposed through
  bounded read-only MCP, primary Jace chat, and Console surfaces.

The final R8 local proof included focused Console tests, the exact Console CI
lane, full database tests, fresh migrated PostgreSQL integration, package
typechecks, builds, lint, independent review, and green CI. These are
source/test and local-runtime facts. No deployed GitHub carrier, live vendor
workflow, or customer run has been claimed.

## R9 progress

R9.1 is merged and source/test complete. PR #1677 added one owner/admin
decision bound to the current posted, attested review cycle without giving
Jace merge authority. PR #1678 makes the authenticated GitHub webhook the
sole writer of merge state, records the factual merge separately from whether
the exact decision aligned, and retains deploy, incident, and revert
observations only against that immutable merge custody. It makes no GitHub
merge request.

The local proof includes focused route/query tests and a migrated PostgreSQL
run covering approval, exception, conflicting or absent decisions, immutable
replay, A→B→A isolation, transaction rollback, and decision/head races.

R9.2 is source/test complete. PR #1679 records one owner/admin-declared
`human_input` effort total against the opaque current attested head-cycle
binding. It does not infer effort from elapsed time, and its Record-scoped
metrics keep eligible, known, and unknown samples separate.

The outcome slice in PR #1680 projects a bounded historical cohort only from
exact posted-review, review-job, confirmed
Contract, decision, signed-merge delivery, and post-merge custody. Known human
decisions, explicit `not_recorded`, and malformed or ambiguous
`excluded_unknown` samples remain separate. Factual signed merge, deployment,
incident, and revert observations are reported separately from the human
decision. The projection and Console panel passed focused tests and a migrated
PostgreSQL run, including malformed custody, observation cutoffs, and A→B→A
cycle isolation. The combined local proof includes focused route, query, and
component tests, the full database and exact Console CI suites, migrated
PostgreSQL integration, package typechecks and builds, scoped lint, and
independent adversarial review. PR #1679 also carries a browser-rendered
component screenshot; it is component proof, not an authenticated
browser-to-server run.

This is source/test and local-runtime proof only. No deployed GitHub delivery,
live human decision, authenticated browser run, or customer outcome has been
observed. R9 remains **FAIL / not release-ready** because deployed/live proof
and customer proof are still open.

## R10 progress

PR #1681 added a bounded R10.1 source/test foundation. It records one immutable
dependency observation against the current authoritative Acceptance Record
head cycle after revalidating the confirmed Contract, compiled Pack, source
snapshot, manifest, lockfile, and exact-head tree custody under the existing
PR lock. The trusted runner supplies bounded candidate, runtime, package
manager, lockfile, and security evidence; the database derives the immutable
binding, candidate fingerprint, and outcome. It records closed
outcomes for observed evidence, unsafe runtime, lockfile refusal, baseline
refusal, security refusal, and evidence that remains not proven.

The runner cannot choose the repository, PR, head cycle, authority generation,
Contract, or resulting status. The slice neither installs dependencies nor
creates an issue, approval, queue entry, builder dispatch, pull request, or
merge action. It does not extend the legacy dependency-watch or generic
approval lanes.

PR #1687 separately moved the authenticated legacy dependency heartbeat's
pnpm proposal into one draft Acceptance Record and draft Contract. Its custody
is explicitly watch-only and independently `not_proven`; it does not confirm
criteria or grant approval, issue, queue, builder, delivery, install, PR, or
merge authority. The former legacy approval path retains historical decisions
but can no longer publish an issue or enqueue dependency work.

PR #1691 closed a source-custody regression in that draft-only lane. The
persisted watch configuration must now be either `auto` / `auto` or the exact
root `package.json` / `pnpm-lock.yaml` pair before a draft can be created.
Mixed or non-root paths fail before any Record write, and replay revalidates
later watch-path drift. This does not upgrade watch evidence beyond
`not_proven` or grant any downstream authority.

The merged accepted-observation profile was pnpm-specific: it required a
Node/npm package identity, `package.json`, `pnpm-lock.yaml`, an OSV npm
reference, and `pnpm_lockfile_only_v1`. PR #1685 made the observation contract
and fingerprint explicitly profile-bound, but it did not add another accepted
manager.

PR #1688 added the closed `node` / `npm` / `npm_package_lock_only_v1`
evidence profile. It accepts only root `package.json` and `package-lock.json`
custody, exact Node and npm versions, an exact OSV package-and-target
reference, and one dependency-kind-safe command plan:
`npm install <package>@<target> --package-lock-only --ignore-scripts
--no-audit <save-kind-flag>`. The save flag is exact for dependencies,
development, optional, or peer dependencies. The command is immutable future
builder instruction only; this slice does not execute npm or treat suppressed
npm audit output as security evidence. OSV remains the separately bound
security authority.

The profile addition does not reinterpret history. A bounded pre-support npm
v2 event that was durably refused as `unsupported_manager_profile` can replay
only against its exact immutable evidence. Changed evidence conflicts, a new
malformed npm body cannot create an event, and the old refusal cannot be
approved or minted into an external-builder Pack. Existing pnpm semantics,
including pnpm-compatible npm aliases and legacy v1 replay, remain unchanged.

PR #1692 added the closed `node` / `yarn` /
`yarn_berry_v4_root_lockfile_only_v1` evidence profile. It accepts only stable
Yarn 4 with stable Node 18.12 or newer, a root `package.json` and `yarn.lock`,
an exact OSV npm package-and-target reference, and one dependency-kind-safe
future-builder command plan: `yarn add <package>@<target>
--mode=update-lockfile`, with the exact `--dev`, `--optional`, or `--peer`
flag when the stored dependency kind requires it. It does not accept Yarn
Classic, Yarn 2 or 3, workspace or nested manifests, protocol aliases, or
`yarn up`'s project-wide update semantics.

The compiled Context Pack compiler is versioned to v5 with policy v3 because
Yarn safety adds immutable exact-head custody for root `.yarnrc.yml` absence.
The probe runs only after dependency reads and never exceeds the existing
16-read cap. A present configuration is retained only as exact metadata and
refuses the profile; missing or ambiguous absence evidence remains
`not_proven`. Configuration bytes are not selected, rendered, or persisted.
Older Packs remain immutable and cannot prove this new absence condition.

As with npm, a pre-support Yarn v2 refusal can replay only against the same
immutable event, binding, source custody, and evidence. It cannot be promoted
to `observed`, approved, or minted into an external-builder Pack. A changed
same-cycle body conflicts, and a new malformed body creates no event.

PR #1694 added the closed `python` / `uv` /
`uv_project_lockfile_only_v1` evidence profile. It accepts only stable uv
0.12.x with a stable Python 3 runtime, a root `pyproject.toml` and `uv.lock`,
one canonical PyPI package in direct project dependencies, a canonical
`>=X.Y.Z` lower bound, stable upward current and target versions, and the exact
OSV `PyPI` package-and-target identity. The immutable future-builder command is
`uv lock --no-cache --no-config --no-python-downloads --no-sources --no-build
--upgrade-package <package>==<target>`. It updates only the lockfile and is not
executed by this slice.

The authenticated runner evidence remains responsible for attesting a clean,
allowlisted environment with no ambient `UV_*` index, configuration, Python,
or cache overrides and PyPI-only TLS egress. The database does not infer those
facts: it validates the bounded evidence, rederives current Record, Contract,
compiled-Pack, root-file, blob, tree, and head-cycle custody, and otherwise
records a refusal or `not_proven`. Existing v5/v3 Packs are sufficient only
when they already prove both exact root files; no compiler version was changed.

The Python detector now emits the same lock-only command and rejects ambiguous
project metadata, dependency forms, lock sources, versions, and missing
distribution hashes before registry access. It is still the legacy watch
observer and does not call the canonical R10.1 ingestion route. Therefore this
is source/test compatibility, not a live uv evidence caller.

As with npm and Yarn, a pre-support uv v2 refusal can replay only against its
exact immutable event and evidence. It cannot become `observed`, approved, or
minted into an external-builder Pack. Changed evidence conflicts; a new broad
or malformed uv body creates no event. Legacy v1 replay remains pnpm-only.

PR #1703 added a strict source-only Cargo observer foundation in the legacy
Python dependency layer. It does not register Cargo as a canonical
database/Console acceptance-observation profile, cannot pass the canonical
R10.1 ingestion boundary as `observed`, and grants no approval, Pack, builder,
delivery, pull-request, or merge authority.

PR #1709 temporarily admitted the `rust` / `cargo` /
`cargo_lock_registry_only_v1` profile beyond the evidence the implementation
could authenticate. Opaque caller-supplied digests did not prove a crates.io
checksum response, registry response identity, a complete exact-head source
inventory, security-report custody, or an isolated trusted runner. This
correction therefore removes Cargo from the Console and database operational,
strict-current, frozen-replay, receipt, approval, and external-builder Pack
registries.

PR #1716 added a strict source-only Composer 2 root parser in the legacy Python
dependency layer. It accepts a bounded root `composer.json` and
`composer.lock` syntax subset, preserves exact supplied-file SHA-256 custody,
and keeps Composer content-hash recomputation, Packagist authenticity,
distribution integrity, transitive graph reachability, runtime, security, and
Acceptance Record authority explicitly unresolved. It does not register
Composer as a canonical evidence profile and grants no approval, Pack,
execution, delivery, pull-request, or merge authority.

The strict Python Cargo parser and source-only observation candidate remain.
They can reject unsafe manifest and lockfile shapes, but Cargo.lock checksum
strings are provided source material, not authenticated crates.io receipts.
New bounded Cargo bodies record `refused_unsupported_profile`; they cannot
become `observed`, approved, or minted into a Pack. Former `observed` events
remain immutable audit rows, while current replay, receipt projection,
approval, and Pack authority fail closed. Cargo remains outside legacy draft
and managed execution, which stays pnpm-only.

The v6/v4 Context Pack compiler's bounded root `.cargo/config` and
`.cargo/config.toml` absence probes remain generic exact-head source-custody
metadata. They neither register a Cargo evidence profile nor authenticate
registry, checksum, security, or runner evidence, and they grant no Cargo
approval, Pack, delivery, or execution authority.

PR #1720 adds the closed `php` / `composer` /
`composer_lock_public_packagist_v1` evidence profile. It admits only one
canonical lowercase `vendor/name` production requirement from the strict
root parser, a stable caret or tilde constraint, an exact stable locked
release, and a higher stable target within that same constraint. Runtime and
manager evidence are pinned to PHP 8.5.9 and Composer 2.10.2. The current
compiled Pack must bind exact root `composer.json` and `composer.lock`
source/blob/tree custody. The current compiler and the component proof use
compiler v6 and policy v4; Composer does not treat the version labels alone as
source evidence.

The parser-to-observer reachability proof uses a Composer-generated public
Packagist lock row. A required bounded HTTPS zip `dist` claim may coexist with
an optional bounded HTTPS git `source` claim only when both references identify
the same release. Those fields remain unauthenticated source syntax; they do
not prove repository authenticity or distribution integrity.

The immutable future-builder instruction is `composer --no-interaction
--no-plugins --no-scripts --no-cache update <package>:<target>
--with-dependencies --minimal-changes --no-dev --no-install --no-audit
--no-progress`. It is not executed by the canonical path in this slice.
Security evidence must carry the exact
`osv:Packagist:<package>@<target>` identity. The authenticated evidence
boundary remains responsible for the PHP, Composer, Packagist, sandbox, and
security facts; the database validates the bounded report and independently
rebinds the Record, current head cycle, confirmed Contract, compiled Pack,
root-file custody, and OSV identity. It does not reparse caller-supplied raw
manifest or lock bodies.

A pre-support Composer v2 refusal can replay only as the same immutable
refusal. Changed evidence conflicts, and a new broad or malformed body creates
no event. Composer remains outside the legacy draft and managed-execution
profiles. The resulting R10.2 Pack is metadata-only,
`deliveryAuthority:not_granted`, and requires exact-head R7 re-entry; no
install, issue, delivery, pull-request, or merge authority is added.

PR #1695 reconciled the source/test conclusion then supported by these bounded
profiles. It closed only the pnpm, npm, Yarn 4, and uv foundation; it did not
close canonical R10.1.

Canonical R10.1 source/test remains open. The active v1 matrix requires safe,
adapter-driven profiles across the named package-manager families. pnpm, npm,
Yarn 4, uv, and Composer are currently accepted profiles. Cargo,
pip/requirements, Poetry, Maven, Gradle, NuGet/dotnet, and Go Modules remain
required R10 work; detected-only or source-only observer support is not
operational support.

The current pnpm producer slice makes one accepted profile operational in
source/test without widening its authority. A workspace-bound runner API key
can claim only server-selected `dependency_watch` work for its own tenant and
the request supplies only a worker identity, never a workspace locator. The
claim is for one current authoritative
Record occurrence. The short lease and final write are bound to the exact
workspace, Record/head cycle and authority generation, confirmed Contract,
active compiled Pack generation, candidate fingerprint/body, and pnpm profile.
The worker receives only an exact-repository, `contents:read` GitHub token,
reads the exact-head root `package.json` and `pnpm-lock.yaml` blobs, runs only
`node --version` and `pnpm --version`, performs one bounded OSV query, and
submits the result to the existing canonical v2 observation route. Remote
Console transport must use HTTPS; plaintext HTTP is restricted to loopback
development. A failed credential mint releases the opaque lease. The claim
persists the exact workspace GitHub installation identity used for credential
minting, and final admission rejects any installation rebind. The final route
revalidates every binding and atomically consumes only the matching claim;
provisional, superseded, ambiguous, forged, stale, replayed-with-
different-evidence, cross-workspace, and competing-candidate custody fail
closed.

This is not full manager coverage and does not close R10.1. It performs no
install, update, build, test, package script, approval, external-builder Pack
delivery, pull-request mutation, merge, or deployment. No live GitHub or OSV
request, deployed worker pickup, approved builder re-entry, or customer path
has been observed. The claim migration is reserved as `0105` behind direct
MCP's `0101`/`0102`, Context Pack regeneration's `0103`, and exact-Pack Claude
delivery custody's `0104`; it must be rebased or renumbered if that merge
order changes.

Every manager without a bounded safe profile must return the explicit
fail-closed `refused_unsupported_profile` capability/evidence result. Such a
result cannot become `observed`, receive approval, or mint an R10.2 Pack, and
immutable historical replay cannot promote it. Bun, Ruby Bundler, Elixir Mix,
Dart Pub, SwiftPM, and other lower-priority managers remain explicit extension
points until a safe profile is added; none may be coerced to npm semantics.

PR #1706 temporarily admitted a Go Modules profile beyond the custody the
implementation could prove. This corrective slice removes Go from accepted
evidence, approval, and external-builder Pack authority while retaining a
source-only observation foundation. Historical rows remain audit-visible under
the normal immutable-event policy, but do not grant current approval or Pack
authority. New Go bodies are `refused_unsupported_profile` and cannot be
accepted as `observed`. `go.sum` values are syntax-checked provided-baseline
material only, not authenticated checksum-database or proxy receipts. No live
builder, deployed, or customer proof is claimed.

This bounded Go source-custody slice closes only the repository-inventory
part of that gap. The authenticated GitHub App snapshot provider reads one
exact commit, its recursive tree, and the root `go.mod` and `go.sum` Git blobs
from `api.github.com`; redirects, cross-origin response URLs, oversized or
duplicate-key JSON, truncated trees, unsafe entries, mixed object-hash
families, and mismatched locally recomputed Git blob identities fail closed.
The source-free canonical receipt binds the exact repository, requested ref,
commit, root tree, sorted inventory, and root-file byte/content identities into
the observation key and an append-only database row. Exact retries are
idempotent; altered receipt identity cannot reuse the prior observation key.

This receipt remains source inventory, not dependency evidence. It does not
authenticate `go.sum` against the checksum database or module proxy, and it
does not supply registry release, security, isolated-runtime, builder, or
customer proof. Go remains absent from accepted Console/database profiles,
legacy draft, canonical evidence, approval, external-builder Pack, and managed
execution registries. The existing source-only observer and immutable audit
history remain unchanged. Local source/test proof does not claim a live GitHub
delivery, deployed runtime, or customer outcome.

PR #1724 adds a separate pure Go checksum-database verifier and bounded
transport/proof-construction foundation. The verifier pins the official
`sum.golang.org` key, binds the exact requested module/version and zip plus
`/go.mod` hashes to the signed lookup record, checks record inclusion, and
maintains an in-memory monotonic signed-tree timeline with consistency proofs.
The transport uses exact HTTPS paths, no ambient proxy or credentials, refuses
redirects before following them, caps response bodies, and reconstructs the
required tile proofs. That slice did not make a live checksum-database request
and added no database, watcher, evidence, approval, Pack, builder, delivery, or
execution authority.

This follow-on stores only small opaque raw signed-tree-note metadata (at most
4 KiB) as canonical Base64 with a recomputed SHA-256 and append-only
compare-and-set lineage. Each row is bound to the exact workspace, watch,
repository, prior generation, and Go source-inventory observation. A blocking
per-watch transaction lock admits one bootstrap and one successor per current
digest; exact retries are idempotent, while stale, reused, or competing
successors conflict. Source-observation deletion is restricted while custody
exists; one explicit whole-watch teardown removes the complete timeline before
intentional watch or workspace deletion. PostgreSQL deliberately stores no
caller-parsed tree size or root and does not claim to authenticate the note,
record inclusion, or consistency. A later Python runtime slice must reload the
raw prior note through the pinned-key verifier, authenticate the new lookup and
proofs, then advance this custody. Go remains outside draft, accepted evidence,
approval, Pack, builder, delivery, and managed execution authority.

Poetry was audited rather than admitted. Its non-installing `update <package>
--lock` command still has no exact-target argument and Poetry 2.4.1 can fall
back from sdist metadata inspection to a PEP 517 isolated builder. There is no
lock-time `--no-build` control. A Poetry profile therefore remains required
R10 work, pending a bounded sandbox/metadata-custody design. The same
fail-closed rule applies to managers without a bounded safe profile. The audit
is grounded in Poetry's [update command contract](https://python-poetry.org/docs/cli/#update)
and pinned [sdist metadata fallback](https://github.com/python-poetry/poetry/blob/2.4.1/src/poetry/inspection/info.py#L446-L537).

The corrective contract is versioned. New runner requests must carry the
explicit ecosystem, manager, and profile identity; legacy v1 request bodies are
rejected rather than inferred. Existing immutable v1 pnpm observation events
remain replay-compatible and cannot be duplicated by an equivalent v2 report.

Local proof for the merged pnpm profile includes focused parser, route, and
query tests; a fresh migrated PostgreSQL run covering replay, conflicts,
refusal truth, source-custody drift, reconciliation, A→B→A, and head-advance
races; the full database suite; package typechecks/builds; scoped lint; and
independent adversarial review. The npm slice adds 106 focused Console tests,
four focused npm and historical-replay PostgreSQL cases, the complete 82-case
change-record integration run, and the full 1,712-test database suite on fresh
migrated PostgreSQL. Package typechecks/builds, scoped lint, diff checks, and
independent adversarial review are also green. No deployed runner, live OSV
evidence acquisition, npm execution, external-builder delivery, or customer
dependency proposal has been observed.

The post-rebase Yarn compatibility gate covers 211 focused Console tests,
five DB boundary tests, and four focused fresh-migrated PostgreSQL cases
covering exact profile admission,
configuration custody, immutable historical replay, refusal truth, and R10.2
Pack propagation. The complete 86-case Change Record integration file and the
full 138-file / 1,750-test database suite pass on fresh migrated PostgreSQL.
Package typechecks/builds, scoped lint, diff checks, and independent adversarial
review are green. No Yarn command was executed, no live OSV evidence was
acquired, no builder received the Pack, and no deployed, live, or customer path
was observed.

The uv compatibility gate covers 82 focused Python dependency/runtime tests,
152 focused Console parser, route, and Record-detail tests, six DB boundary
tests, and three focused fresh-migrated PostgreSQL cases covering exact profile
admission, refusal truth, exact root custody, immutable historical replay, and
R10.2 Pack propagation. The exact Python CI lane passed 5,207 tests, and the
full fresh-migrated database run passed 138 files and 1,754 tests. Package
typechecks/builds, scoped lint, diff checks, and independent adversarial review
are green. No uv or OSV command was run, no live canonical runner called the
ingestion route, no external builder received the Pack, and no deployed, live,
or customer path was observed.

The Cargo authority correction carries focused Console parser, route, and
Record-detail refusal regressions plus fresh-PostgreSQL cases for fake-digest
refusal and immutable historical-row custody. Those cases require new Cargo
bodies to remain unsupported, preserve former observed events as audit rows,
and prove zero current replay, approval, or Pack authority even when an
external-builder route is valid. The Python parser/source-only observation and
the explicit no-Cargo-managed-execution regression remain in place. No Cargo
or rustc command was run, no crates.io checksum or OSV response was
authenticated, no canonical runner called the ingestion route, no external
builder received a Pack, and no deployed, live, or customer path was observed.

The Composer compatibility gate covers 993 focused Python dependency and
guardrail tests, 194 focused Console parser, ingestion-route, and Record-detail
tests, eight DB boundary tests, and three focused fresh-migrated PostgreSQL
cases covering exact profile admission, refusal truth, immutable historical
replay, root-source custody, and R10.2 Pack propagation. The complete 96-case
Change Record file and full 143-file / 1,914-test database suite pass on fresh
migrated PostgreSQL. Package typechecks/builds, scoped lint, generated
guardrail-doc parity, diff checks, and independent adversarial review are
green. The slice also carries a
[browser-rendered component screenshot](screenshots/r101-composer-receipt.png)
of the synthetic exact Composer receipt and no-authority Pack; it is component
proof, not an authenticated Record-detail flow. No canonical 3.0.4 target
upgrade or OSV evidence acquisition ran, no authenticated canonical caller
submitted the receipt, no external builder received a Pack, and no deployed,
live, or customer path was observed.

PR #1682 merged the bounded R10.2 source/test slice. An owner or admin can
approve only an exact current R10.1 `observed` receipt. Under the same PR lock,
the database revalidates the authoritative head occurrence, confirmed
Contract, compiled Pack and source custody, and the already selected external
builder route before atomically appending the human approval and immutable
dependency Pack. Replays require the same actor and complete two-event custody;
stale cycles, refused observations, role loss, route or Pack drift, partial
events, and A→B→A revisits fail closed.

The Pack explicitly records `deliveryAuthority: not_granted`, the scope
boundary `dependency_external_builder_pack_only`, and required exact-head R7
re-entry. The existing Record detail surface exposes the receipt and bounded
approval action; it exposes no install, managed-build, issue, queue, dispatch,
delivery, pull-request mutation, or merge action.

Local R10.2 proof for the current supported profiles includes focused DB and Console tests, five fresh migrated
PostgreSQL transaction cases, the full 1,689-test database suite, package
typechecks/builds, scoped lint, and independent adversarial review. No external
builder received the Pack, no dependency was installed, and no deployed/live
or customer path was observed. PR #1682's R10.2 Pack foundation is merged, but
canonical R10.2 remains source/test open until the required v1 R10.1 profiles
can reach the same safe proposal/Pack boundary. R10 remains **FAIL / not
release-ready** until those profiles are complete, a canonical runner supplies
real evidence, an approved Pack reaches an external builder and re-enters
exact-head review, and deployed/live and customer proof gates are satisfied.

The current `github_claude` handoff branch adds one narrower R10.2 source/test
continuation. An owner/admin can reserve one exact approved external Builder
Pack before a single metadata-only GitHub comment write. The capability is an
initial dependency handoff with one selected `@claude` mention; it does not
reuse the correction-only capability lifecycle. Exact accepted receipts,
ambiguous terminal holds, and append-only events retain the Record, Contract,
compiled Pack, external Builder Pack, route revision, installation identity,
and delivered head occurrence. Regeneration and delivery serialize under the
same Record/PR lock: queued/running regeneration blocks reservation, a reserved
or ambiguous delivery protects its active Pack, and a replacement that
activates first makes the superseded Pack unavailable for delivery. Only an
exact `builder_delivery_in_flight` hold with at least one matching
`carrier_accepted` or `bounded_failed` delivery and zero matching `reserved` or
`ambiguous_hold` deliveries may create one idempotent retry child over the same
provisional generation. Matching includes tenant, Record, head, Contract, Pack,
and generation custody; other held reasons remain inert. Before
minting or posting, the adapter revalidates the exact GitHub installation
identity captured by the reservation. A workspace installation rebind closes
as a bounded failure with no post. Signed successor-head
attribution and review-job re-entry automation are explicitly deferred from
this slice. Delivery and head movement do not pass a criterion. Focused local
Postgres and adapter tests are the only intended branch proof. It does not
claim an external comment, Claude pickup/implementation, hosted webhook,
deployed runtime, review result, merge, or customer use. The live exercise
remains required after merge and deployment.

## R11 progress

PR #1683 merged the bounded R11.1 source/test slice. One tenant-scoped,
set-based reader answers the seven primary Acceptance Record questions from
exact Contract, head occurrence, review, decision, signed-merge, post-merge,
Context Pack snapshot, and compiled-Pack custody. It acquires attached-PR locks
in deterministic order, distinguishes A→B→A cycles by occurrence identity, and
turns malformed, ambiguous, missing, or over-limit evidence into explicit
unknown or not-recorded states instead of synthesizing an answer from raw
timeline JSON.

The primary sidebar now starts with Changes. Workspace Home shows a bounded
Acceptance summary before the legacy Digest, the Changes page and member API
use the same server projection, and Record detail returns to Changes instead of
factory Work. The surface is read-only: it creates no issue, queue entry,
dispatch, delivery, pull-request mutation, or merge request, and it does not
present missing deployment, incident, or revert receipts as known negatives.

Local R11.1 proof includes focused DB and Console tests, eight fresh migrated
PostgreSQL summary cases, the full 1,698-test database suite, package
typechecks/builds, scoped lint, and independent adversarial review. This is
source/test and local PostgreSQL/UI-component proof only. No authenticated
browser-to-server, deployed/live, or customer path was observed.

PR #1686 merged the bounded R11.2a source/test slice. One tenant-scoped,
read-only detail resolver revalidates the confirmed Contract, occurrence-bound
PR head cycles, posted review custody, correction packets, Context Pack
snapshots, and compiled Pack metadata under the existing PR lock. It preserves
A→B→A as distinct occurrences, rejects malformed or cross-workspace Pack
custody, and fails closed on bounded event, snapshot, Pack, occurrence, or
two-megabyte serialized-detail limits instead of truncating the result.

The existing authenticated Record detail surface renders the full confirmed
Contract, exact current and historical PR occurrences, metadata-only Context
Pack and compiled Pack custody, and a Contract-ordered criterion matrix. Only
an exact immutable correction packet establishes criterion-level failed or
not-proven evidence. Other criterion results, artifact custody, and gated-issue
custody remain explicitly unknown; raw timeline JSON stays audit-only and is
never used to infer status. The surface adds no artifact access, issue action,
queue, dispatch, delivery, pull-request mutation, or merge action.

Local R11.2a proof includes two boundary tests, six fresh migrated PostgreSQL
detail cases, the 79-case change-record integration suite, the full
1,709-test database suite, 92 focused Console route/component tests, package
typechecks/builds, scoped lint, and independent adversarial review. The
serialized-byte guard is exercised with 56 valid Packs, below the separate
64-Pack cap. This is source/test and local PostgreSQL/UI-component proof only.
No authenticated browser-to-server, artifact-store, deployed/live, or customer
path was observed.

PR #1700 added a further bounded R11.2 source/test contribution: the same
tenant-scoped Record detail can expose strictly revalidated pnpm dependency
draft-proposal custody from persisted source. It carries no approval,
delivery, execution, issue, pull-request, or merge authority, and it does not
turn a draft proposal into a Context Pack. It preserves the existing
fail-closed detail boundary and does not close the remaining R11.2 work.

PR #1701 merged the R11.2b slice: one immutable, Contract-ordered criterion-outcome
bundle for the exact posted review cycle. The database rederives every outcome
from the stored verification plan, deterministic execution attempt,
reservation, result, correction packet, preview, GitHub post attempt, and
confirmed Contract under the existing PR lock. It atomically appends the
extended posted-review attestation and bundle, preserves a known external-post
head race as historical custody, and never revives an earlier A occurrence
after A→B→A. Partial pairs, forged storage keys, malformed or late receipts,
and incompatible replays fail closed.

Member routes expose only current bundle metadata and opaque deterministic
artifact IDs. The server resolves the private object key, signs and consumes
it internally, enforces an eight-second and two-megabyte proxy bound, and
verifies the returned bytes against the receipt SHA-256 before responding.
The complete member Record response recursively removes private artifact,
evidence, and boot-log storage coordinates; the raw audit timeline cannot
bypass that boundary. Review requests with more than 100 inline comments are
rejected before any proof lookup or GitHub side effect. The Record detail view
renders the exact current outcomes and artifact receipts without adding an
issue, queue, dispatch, delivery, pull-request mutation, or merge action.

Local R11.2b proof includes three boundary tests, eight fresh migrated PostgreSQL
criterion-custody cases, the 89-case Change Record integration suite, 178
focused Console route/proxy/component tests, the full 140-file / 1,774-test
fresh-migrated database suite, package typechecks/builds, scoped lint, diff
checks, and independent adversarial review. This is source/test and local
PostgreSQL/component proof only. No authenticated browser flow, real
artifact-store object, live GitHub write, deployed/live path, or customer
outcome was observed.

The R11.2c slice adds one Jace-only, human-approved GitHub issue path for the
exact current correction-packet set. Its opaque binding includes the
authoritative head occurrence, confirmed Contract, posted R11.2b bundle and
attestation, and ordered packet identities and digests. Reservation rederives
that custody and membership under the PR lock. Only a freshly inserted
reservation releases the server-rendered `{title, body}` request; existing
reservations and terminal
states withhold the request, so the route cannot automatically retry an
uncertain external write.

The connector makes exactly one bounded GitHub request with only `title` and
`body`. It sends no labels, assignees, milestone, agent mention, queue entry,
dispatch, pull-request mutation, or merge request, so the issue cannot satisfy
the legacy factory intake trigger at creation. Definitive rejection and
ambiguous transport outcomes become terminal database receipts. A verified
GitHub `201` can be recorded after a head advance for historical audit, but it
never reappears as current custody. The rendered body neutralizes untrusted
Markdown and mentions and includes only a SHA-256 of the evidence reference;
artifact keys and raw evidence, execution, preview, or storage coordinates are
absent. Orphan table/event states fail closed rather than becoming “not
recorded.”

The existing Record detail projection is the only browser read model for this
state. It exposes the exact current binding and immutable issue status but no
issue-creation action. Even an owner or admin browser POST receives
`jace_approval_required`; Jace must mint the request from an Eve session and
obtain the human approval. No parallel raw timeline inference or optimistic
success state is used.

Local R11.2c proof includes 57 focused database boundary/schema/renderer tests,
16 fresh migrated PostgreSQL R11.2b/gated-issue cases after the final rendered
evidence and orphan-custody hardening, the 89-case Change Record integration
suite, 203 focused Console route/helper/component tests, and a full
142-file / 1,789-test fresh-migrated database run before the final focused
evidence-reference and orphan-custody hardening. Package typechecks/builds,
scoped lint, diff checks, and independent adversarial review also passed. This
is source/test and local PostgreSQL/component proof only.

A separate R11.2 browser-proof lane is now source-wired to run the production
Console with a directly minted Auth.js database session, fresh migrated
PostgreSQL, and a real MinIO object. Its exact-ID fixture covers owner, member,
foreign, and unauthenticated reads; opaque artifact success and hash-tamper
refusal; A→B→A currentness; the owner `409` / member `403` browser publication
refusal; and zero approval, reservation, or publication writes.

That lane was not executed in this checkout: the managed local sandbox refused
both the production listener and Docker socket, while the fixture script's
separate strict typecheck, the Console typecheck, and the production Console
build passed. GitHub CI run `31552976700`, job `93979981919`, subsequently ran
the production listener with fresh migrated PostgreSQL and MinIO at PR head
`148cfbfc` and passed all seven Chromium scenarios in 15.2 seconds. This is
CI-runner browser/runtime proof for that exact test tree, not deployed/live or
customer proof. The final PR head must still pass the same external merge gate.
No real GitHub issue write was performed.

R11.2 product-source behavior remains source/test closed at this bounded
boundary, and the bounded authenticated browser proof above is established at
CI-runtime level. R11 remains **FAIL / not release-ready** until the separate
deployed/live and customer proof exists.

This branch adds a narrow R11.2 Context Pack regeneration execution path to
the existing human request receipt. The request event and one deterministic
execution are inserted atomically. A central-Jace-authenticated,
out-of-process worker can claim only an opaque execution/lease identity; the
Console then re-derives and revalidates the exact workspace, Acceptance Record,
authoritative head occurrence, confirmed Contract, prior compiled Pack, source
snapshot, and tree custody. It derives the current Wiki base index from
server-held Wiki data. Identical Wiki/compiler/policy inputs terminate
unchanged; changed Wiki inputs admit a new immutable generation snapshot that
preserves the exact old head/tree/Contract/overlay bindings, then
re-materializes exact-head GitHub bytes through the existing deterministic
non-LLM compiler. The prior snapshot and Pack remain immutable. The outcome is
append-only and terminal: immutable replacement, explicit unchanged,
not-current, not-proven, or held. Leases are single-attempt; an expired or
ambiguous execution is held and cannot be automatically recompiled.
An owner/admin may deliberately create one new idempotent execution from a
terminal credential hold or exact-content GitHub availability/rejection only,
after the server revalidates the same current Record/head-cycle/Contract/prior
Pack custody. Ambiguous execution, exhausted lease, custody, compiler/proof,
and not-current outcomes never expose a retry action.

The worker is a standalone process and is default-off behind
`JACE_CONTEXT_PACK_REGENERATION_WORKER=1`. It uses the dedicated
`JACE_CONTEXT_PACK_REGENERATION_WORKER_TOKEN`, which is accepted only by the
opaque claim/execute routes and must differ from the deployment-wide
`JACE_CONSOLE_TOKEN`. Deploy the worker with a credential-minimal environment;
its startup fails closed whenever the broad `JACE_CONSOLE_TOKEN` is present.
The routes accept no tenant, Record,
Contract, Pack, repository, head, source, correction, builder, PR-mutation,
merge, or deployment coordinates from the worker. Focused source tests and
fresh PostgreSQL transaction tests prove queue idempotency, concurrent claim,
opaque lease custody, head-drift refusal, stale-lease holding, bounded request
bodies, deterministic execution, immutable fresh-snapshot compilation with the
production compiler, identical-input replay, and readback. This is source/test
and local PostgreSQL proof only. The worker has not been enabled against a
deployed Console; no live GitHub bytes were regenerated, no deployment
occurred, and no customer proof exists.

The additive execution schema is registered as migration `0103` at journal
index 108, directly after current main's `0101`/`0102` MCP migrations. It has
no source or migration dependency on the separate, still-unmerged external
builder-handoff draft; that post-launch work must take the next free migration
slot if it proceeds.

## R12 progress

PR #1690 originally closed the canonical R12.1 and R12.2 source/test slice.
It made the public landing state the ordered planning, human-confirmed
Contract, MCP handoff, bounded Context Pack, selected external coding agent,
confirmed-intent review, evidence/refusal, and human-decision flow without
presenting Jace as a factory, code generator, auto-merge system, or
live-outcome claim.

PR #1693 later regressed the explicit ordered MCP, Contract, Context Pack, and
confirmed-intent wording, and weakened the focused R12.1 test that guarded it.
PRs #1696 and #1698 preserved that regression. R12.1 is therefore reopened;
its remediation is owner-held. The separate landing-page side mission is
paused and does not supply R12.1 closure.

R12.2 remains source/test closed. Public pricing is consistently labelled a
team commercial experiment rather than proof of product value, delivery
capacity, or review savings. The technical README surfaces remain allowed
implementation context for the optional CLI, runner, self-hosting, and MCP
adapters. They do not give Jace merge authority or turn adapter mechanics into
public-product or deployed proof.

The original #1690 focused marketing truth tests, Console typecheck, targeted
lint, diff checks, independent review, and PR CI were source/test proof for
that original slice. They do not close the reopened R12.1 requirement after
the later regression.

This is source/test proof only. No deployed landing render, payment
availability, hosted external-builder flow, commercial conversion, or customer
outcome was observed. R12 remains **FAIL / not release-ready**: R12.1 needs
owner-held source/test remediation, and both R12 criteria still lack
deployed/live and customer proof.

## Remaining canonical order

The remaining source implementation follows a dependency DAG, not strict
R-number order. R11.2 source/test work is closed at the bounded member and
human-gated surfaces above; its runtime and release proofs remain open.
Independent R10.1 v1 manager profiles may proceed in parallel; each R10.2
expansion waits for its safe R10.1 profile. R12.1 remediation is held for the
owner; R12.2 source/test remains closed. R10 source/test remains open.
Lower-priority manager adapters remain explicit fail-closed extensions and
must preserve R11.2a, R11.2b, and R11.2c compatibility. The canonical
requirements remain:

| AC | Required behavior |
| --- | --- |
| R9.1 | Human actions explicitly cover accept/merge, rework, reject, revert/post-merge failure, and unknown/not-recorded without Jace merging. |
| R9.2 | Review effort and outcome metrics are explicit; known and unknown samples remain distinct. |
| R10.1 | Dependency observation/evidence uses the R1–R9 spine and refuses unsafe runtime, lockfile, baseline, or security conditions. |
| R10.2 | An approved dependency proposal yields an external-builder Pack or explicitly labelled optional managed-build route; no bypasses Record/approval/evidence/exact-head review. |
| R11.1 | Primary Console is Acceptance/Changes-first and answers requested work, supplied context, PR/head, proof, unknowns, needed decision, and outcome. |
| R11.2 | List/detail/timeline, Contract/Pack, PR/head, criterion evidence/artifacts, correction/gated issue, decision controls, and sample-honest metrics are accessible without factory-queue primacy. |
| R12.1 | The landing must tell planning → human-confirmed Contract → MCP handoff → bounded Context Pack → selected external builder → confirmed-intent review → evidence/refusal → human decision; it must not present factory/codegen/auto-merge/live-looking claims. **Reopened: owner-held source/test remediation.** |
| R12.2 | Technical docs retain optional internal adapters; pricing is a consistent team commercial experiment, not a product-value claim. |

Each following slice must name the AC it closes and preserve the proof
boundaries above. There is no remaining canonical R8 source blocker; deployed,
live-provider, and customer proof remain separate release gates. R9.1 now
records the current-head human decision and converges signed GitHub merge plus
post-merge facts onto the same exact lineage without giving Jace merge
authority. R9.2 keeps explicit recorded effort, known outcomes, not-recorded
samples, and excluded or unknown custody distinct. None of the remaining
slices may reopen the bounded R8 implementation merely because deployed, live,
or customer proof is missing.
