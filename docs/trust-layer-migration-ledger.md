# Jace trust-layer migration ledger

Last reconciled: 2026-08-11 at main commit `13a528ce`, after merged PR
#1702. The bounded dependency source/test foundations are recorded below;
canonical R10 completion and release proof remain open.

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
| R8.2 | Packets are retrievable through MCP/chat/Console; follow-up GitHub issue creation remains gated. | Complete. MCP, primary Jace chat, and Console resolve the same server-validated current packet custody. Those retrieval surfaces remain read-only; the later R11.2c path permits one separate owner/admin-gated issue for exact current custody. | Partial. Persistence and current-cycle isolation ran against local PostgreSQL, and the adapters passed local tests/builds. No authenticated browser-to-server or external-provider run was performed. | Missing. | Missing. | **Source/test slice closed; release FAIL until deployed/live and customer proof exist.** |

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

PR #1709 adds the closed `rust` / `cargo` /
`cargo_lock_registry_only_v1` evidence profile. It accepts only exact Cargo
and rustc 1.97.1 evidence, root `Cargo.toml` and `Cargo.lock` exact-head
custody, a candidate from a canonical crates.io direct dependency with an
exact stable caret constraint, an upward compatible stable target, and the
exact OSV `crates.io` package-and-target identity. The bounded Python parser
accepts only the root
package and ordinary dependency tables plus a single unambiguous, reachable
crates.io lock graph; ignored tables, replacement or qualified lock edges,
noncanonical or colliding crate names, unsafe integer ranges, custom sources,
and yanked current or target versions fail closed before proposal authority.

The immutable future-builder instruction is `cargo update --manifest-path
Cargo.toml registry+https://github.com/rust-lang/crates.io-index#<package>@<current>
--precise <target>`. It is not executed by this slice. The compiler is
versioned to v6 with policy v4 because Cargo safety adds exact-head absence
custody for both root `.cargo/config` and `.cargo/config.toml`. Those two probes
run only after dependency reads, only for a Pack that already binds both root
Cargo files, and only when the bounded 16-read budget can admit the needed
receipts without a partial absence claim. Present or secret-bearing config is
retained only as metadata and refuses the profile; missing or ambiguous
custody remains `not_proven`. Configuration bytes are never selected,
rendered, or persisted, and older v5 Packs cannot prove this new condition.

Trusted runner evidence remains responsible for attesting direct pinned
binaries, an isolated scratch root and empty Cargo home, an allowlisted
environment with no wrapper, credential, proxy, registry, rustup, or Git
escape hatches, bounded crates.io-only resolution, and no child process other
than the fixed rustc version probe. The database does not infer those facts.
It validates the bounded evidence and independently rebinds the Record,
current head cycle, confirmed Contract, compiled Pack, root source blobs, tree
and dual-config custody, and OSV identity. A pre-support Cargo v2 refusal can
replay only as the same immutable refusal; changed evidence conflicts and a
new broad or malformed body creates no event. Cargo remains outside the
legacy draft and managed-execution profiles. No install, issue, delivery,
pull-request, or merge authority is added.

PR #1695 reconciled the source/test conclusion then supported by these bounded
profiles. It closed only the pnpm, npm, Yarn 4, and uv foundation; it did not
close canonical R10.1.

Canonical R10.1 source/test remains open. The active v1 matrix requires safe,
adapter-driven profiles across the named package-manager families. pnpm, npm,
Yarn 4, uv, and Cargo are currently accepted profiles. pip/requirements,
Poetry, Maven, Gradle, NuGet/dotnet, Composer, and Go Modules remain required
R10 work; detected-only or source-only observer support is not operational
support.

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

The rebased Cargo source gate covers 110 focused Python manager/observer tests,
242 focused Console compiler, parser, route, dispatch-consumer, and
Record-detail tests, and seven DB boundary tests. Fresh-migrated PostgreSQL
proof and complete-suite counts will be recorded after the rebased tree is
executed. Package typechecks/builds, scoped lint, and diff checks are green.
The slice also carries a
[browser-rendered component screenshot](screenshots/r101-cargo-receipt.png) of
the exact Cargo receipt and no-authority Pack; it is component proof, not an
authenticated Record-detail flow. No Cargo or rustc command was run, no
crates.io or OSV evidence was acquired, no authenticated canonical runner
called the ingestion route, no external builder received a Pack, and no
deployed, live, or customer path was observed.

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

The R11.2c slice adds one owner/admin-gated GitHub issue path for the exact
current correction-packet set. Its opaque binding includes the authoritative
head occurrence, confirmed Contract, posted R11.2b bundle and attestation, and
ordered packet identities and digests. Reservation rederives that custody and
membership under the PR lock. Only a freshly inserted reservation releases the
server-rendered `{title, body}` request; existing reservations and terminal
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
state. It exposes the exact current binding and immutable issue status, and
shows the action only to an owner/admin when no issue exists. No parallel raw
timeline inference or optimistic success state is used.

Local R11.2c proof includes 57 focused database boundary/schema/renderer tests,
16 fresh migrated PostgreSQL R11.2b/gated-issue cases after the final rendered
evidence and orphan-custody hardening, the 89-case Change Record integration
suite, 203 focused Console route/helper/component tests, and a full
142-file / 1,789-test fresh-migrated database run before the final focused
evidence-reference and orphan-custody hardening. Package typechecks/builds,
scoped lint, diff checks, and independent adversarial review also passed. This
is source/test and local PostgreSQL/component proof only. No authenticated
browser flow, real GitHub issue write, deployed/live path, or customer outcome
was observed.

R11.2 source/test work is complete at this bounded boundary. R11 remains
**FAIL / not release-ready** until authenticated browser, deployed/live, and
customer proof exist.

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
