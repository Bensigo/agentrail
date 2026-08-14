# R10 github_claude dependency handoff and exact-head re-entry

## Status and proof boundary

This is the acceptance contract for one R10.2 source/test slice. It does not
claim a GitHub comment was delivered, Claude changed a pull request, a hosted
webhook ran, or an exact-head review passed. Those are later live proofs.

The branch is rebased on current main after the MCP migrations `0101`/`0102`
and Context Pack regeneration migration `0103`. This slice registers
`0104_acceptance_dependency_builder_deliveries.sql` at the next journal index.
It has no runtime dependency on Context Pack regeneration; the ordering only
preserves one forward-only migration history.

## Intent

After an owner or admin has approved an exact-current R10.1 dependency
observation and Jace has minted its immutable metadata-only external Builder
Pack, the owner/admin can deliver that exact Pack once to the selected
`github_claude` route. Jace reserves custody before the external write, records
an exact GitHub issue-comment receipt or a terminal hold, and never retries an
uncertain write. If the same connected repository later emits a signed
`pull_request:synchronize` event from the delivered head to a successor head,
the existing exact-head transition atomically records delivery-attributed
re-entry and admits the successor review job. Delivery, head movement, and
re-entry are never passing evidence.

## Acceptance criteria

1. A delivery reservation accepts only exact workspace, Record, and external
   Builder Pack event identities. It revalidates tenant membership, current
   authoritative Record/head occurrence, confirmed Contract, compiled Context
   Pack, approved observation, route selection, and current GitHub App
   installation/repository identity under the Record PR lock.
2. Only the selected active `github_claude` route is eligible. The persisted
   capability is a new immutable
   `acceptance_dependency_builder_handoff_capability` with scope
   `dependency_initial_builder_handoff_only`. It does not reuse or imply the
   correction-only capability profile.
3. Reservation and its append-only Record event commit before an external
   write. Exactly one successful reservation returns a send claim. Concurrent
   or replayed calls return custody without another claim.
4. The renderer is deterministic, metadata-only, and at most 12 KiB. It binds
   workspace, Record, repository, PR, delivered head occurrence, authority
   generation, confirmed Contract identity/hash, compiled Pack identity/hash,
   external Builder Pack/event/hash, candidate fingerprint, route revision,
   and delivery identity. It contains no source ranges/content, opaque
   artifacts, credentials, secrets, raw provider response, instruction beyond
   the approved dependency candidate, merge/deploy instruction, or untrusted
   `@` mention. The bounded package-manager argv is immutable Pack metadata,
   not Jace execution authority. It contains exactly one selected `@claude`
   activation.
5. The GitHub adapter reuses the existing server-derived installation-token
   mint scoped to the exact repository (`issues: write` and
   `pull_requests: write`); this is not a new independent credential scope. It accepts
   only HTTP 201 whose bounded response has the exact posted body, issue URL,
   numeric comment id, and canonical comment URL. Tokens and raw responses are
   never persisted or logged.
6. Accepted, bounded-failure, and unknown-write outcomes terminalize the
   reservation and append one result event. Unknown/ambiguous writes enter
   `ambiguous_hold`; they are never retried automatically. A lost database
   result write leaves the prior reservation inert on replay, so it cannot
   broadcast a second mention.
7. Re-entry is recorded only from the existing authenticated GitHub App
   webhook after an exact-repository signed `pull_request:synchronize` with
   `before` equal to a carrier-accepted delivered head occurrence and `after`
   equal to a successor head. The same transaction must advance the canonical
   Record occurrence and admit the exact successor review job.
8. The append-only re-entry event links delivery, GitHub delivery id, prior
   head/cycle, successor head/cycle, existing external-PR delivery event,
   existing head-advance event, and admitted review job. It explicitly records
   `authorship: not_independently_proven` and `proof: not_proven`.
9. Wrong tenant, Record, repository, PR, head occurrence, Contract, Pack,
   route, installation, webhook action, before SHA, missing review admission,
   replay conflict, or corrupted custody fails closed. No API grants Jace
   implementation, merge, deploy, shell, filesystem, code-generation, or
   generic dispatch authority.
10. Real-Postgres tests prove reservation/replay races, immutable binding,
    exact receipt/terminal hold, cross-tenant and stale-head refusal, and
    signed-synchronize re-entry linkage. Adapter tests prove bounded bodies,
    exact receipts, and no retry after uncertain writes.

## Narrow interfaces

### Database

`reserveAcceptanceDependencyBuilderDelivery({ workspaceId, recordId,
externalBuilderPackEventId, requestedBy })` returns either a unique `reserved`
send claim, an inert replay/hold/terminal projection, or a fail-closed reason.

`reportAcceptanceDependencyBuilderDelivery({ workspaceId, deliveryId,
outcome })` accepts one of:

- `carrier_accepted` with exact comment id, canonical URL, and body hash;
- `bounded_failed` with an enumerated closed failure;
- `unknown_post_outcome` with an enumerated ambiguity reason.

`advanceConfirmedAcceptanceRecordPullRequestHead` remains the only PR-head
transition. Its signed synchronize transaction additionally closes eligible
delivery rows and appends re-entry events only after the successor review job
exists.

### Production adapter

`runGithubDependencyBuilderDelivery` is the single adapter orchestrator:
reserve, mint least-authority credential, post the database-issued body once,
then report. It has no retry loop and returns no token, body, raw response, or
opaque artifact.

An authenticated owner/admin POST route accepts only the external Builder Pack
event id. The server derives the workspace, Record, repository, PR, route,
installation, and all custody bindings.

## Explicit non-goals

- Dependency installation or code generation.
- Builder implementation, merge, deployment, or release authority.
- Correction delivery or correction acknowledgement.
- Supporting adapters other than `github_claude`.
- Notification fan-out, vendor broadcast, or generic logging.
- Treating an attempted/accepted comment, successor commit, webhook, admitted
  job, or re-entry event as exact-head passing proof.

## Later live exercise prerequisites

The migration and Console source must first be deployed at one exact commit. A
test workspace must have the GitHub App installed for the exact repository with
issue/Pull Request comment permission, a selected active `github_claude` route,
the trusted Claude GitHub integration/workflow, a confirmed Contract, current
authoritative open PR head, admitted compiled Pack, supported observed
dependency candidate, owner/admin approval, and the minted external Builder
Pack. The authenticated owner/admin triggers delivery; GitHub must return the
exact comment receipt; Claude must produce a successor commit on that same PR;
GitHub must deliver a signed synchronize event with exact before/after SHAs;
the workspace must be enrolled for reviewer-of-record webhooks; and the review
worker must admit and execute the successor exact-head job. Passing proof still
requires the normal R7 evidence result for that successor head.
