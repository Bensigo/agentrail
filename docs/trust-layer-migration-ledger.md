# Jace trust-layer migration ledger

Last reconciled: 2026-08-11 at main commit `55284831`, after merged PRs
#1677–#1683 and #1685–#1691. The current Yarn evidence-profile slice is
described below and remains narrower than canonical R10.1 closure.

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
| R8.2 | Packets are retrievable through MCP/chat/Console; follow-up GitHub issue creation remains gated. | Complete. MCP, primary Jace chat, and Console resolve the same server-validated current packet custody; none can create a follow-up issue. | Partial. Persistence and current-cycle isolation ran against local PostgreSQL, and the adapters passed local tests/builds. No authenticated browser-to-server or external-provider run was performed. | Missing. | Missing. | **Source/test slice closed; release FAIL until deployed/live and customer proof exist.** |

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

This slice adds the closed `node` / `yarn` /
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

Canonical R10.1 therefore remains open. Subsequent versioned adapter slices
must close the remaining v1 priority managers—pip, Poetry, uv; Maven,
Gradle; dotnet/NuGet; Composer; Cargo; and Go Modules—before R10 source/test
closure. Bun and the lower-priority detected managers may remain labelled
extension points. Frameworks use their ecosystem package-manager adapter and
do not create separate capability claims.

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

Local R10.2 proof includes focused DB and Console tests, five fresh migrated
PostgreSQL transaction cases, the full 1,689-test database suite, package
typechecks/builds, scoped lint, and independent adversarial review. No external
builder received the Pack, no dependency was installed, and no deployed/live
or customer path was observed. R10 remains **FAIL / not release-ready** until
the manager-neutral R10.1 contract and required v1 adapter evidence profiles
are closed and the deployed/live and customer proof gates are satisfied.

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

R11.2 remains open for the criterion-outcome and opaque artifact-custody path,
then the packet-bound gated-issue path. R11 remains **FAIL / not
release-ready**.

## R12 progress

PR #1690 closed the canonical R12.1 and R12.2 source/test slice. The public
landing now tells the ordered planning, human-confirmed criteria, MCP handoff,
selected external coding agent, intent review, evidence/refusal, and human
decision flow without presenting Jace as a factory, code generator,
auto-merge system, or live-outcome claim. Public pricing is consistently
labelled a team commercial experiment rather than proof of product value,
delivery capacity, or review savings.

The technical README surfaces remain allowed implementation context for the
optional CLI, runner, self-hosting, and MCP adapters. They do not give Jace
merge authority or turn adapter mechanics into public-product or deployed
proof. Focused marketing truth tests, Console typecheck, targeted lint, diff
checks, independent review, and all PR CI checks are green.

This is source/test proof only. No deployed landing render, payment
availability, hosted external-builder flow, commercial conversion, or customer
outcome was observed. R12 remains **FAIL / not release-ready** until its
deployed/live and customer proof gates are satisfied.

## Remaining canonical order

The remaining source implementation order is the required R10.1 v1 profiles,
then the remaining R11.2 criterion/artifact and gated-issue slices. R12
source/test is closed. The bounded R10.2 Pack slice is a merged foundation, and
R11.2a must remain compatible with each admitted profile. The canonical
requirements remain:

| AC | Required behavior |
| --- | --- |
| R9.1 | Human actions explicitly cover accept/merge, rework, reject, revert/post-merge failure, and unknown/not-recorded without Jace merging. |
| R9.2 | Review effort and outcome metrics are explicit; known and unknown samples remain distinct. |
| R10.1 | Dependency observation/evidence uses the R1–R9 spine and refuses unsafe runtime, lockfile, baseline, or security conditions. |
| R10.2 | An approved dependency proposal yields an external-builder Pack or explicitly labelled optional managed-build route; no bypasses Record/approval/evidence/exact-head review. |
| R11.1 | Primary Console is Acceptance/Changes-first and answers requested work, supplied context, PR/head, proof, unknowns, needed decision, and outcome. |
| R11.2 | List/detail/timeline, Contract/Pack, PR/head, criterion evidence/artifacts, correction/gated issue, decision controls, and sample-honest metrics are accessible without factory-queue primacy. |
| R12.1 | The unchanged landing structure tells planning → confirmed criteria → MCP handoff → external builder → intent review → evidence/refusal → human decision; it does not present factory/codegen/auto-merge/live-looking claims. |
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
