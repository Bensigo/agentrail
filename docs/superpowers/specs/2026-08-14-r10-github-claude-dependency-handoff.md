# R10 github_claude dependency handoff

## Status and proof boundary

This is the acceptance contract for one R10.2 backend source/test slice. It
does not claim a GitHub comment was delivered, Claude changed a pull request,
a hosted webhook ran, or an exact-head review passed. Those are later live
proofs.

The branch is rebased after the MCP migrations `0101`/`0102` and Context Pack
regeneration migration `0103`. This slice registers
`0104_acceptance_dependency_builder_deliveries.sql` at journal index 109.

## Intent

After an owner or admin approves an exact-current R10.1 dependency observation
and Jace mints its immutable metadata-only external Builder Pack, that
owner/admin can deliver the exact Pack once to the selected `github_claude`
route. Jace reserves custody before the external write and records either an
exact GitHub issue-comment receipt or a closed outcome. It never retries an
uncertain write.

This slice does not attribute a later successor head to the delivery. Signed
successor-head re-entry remains a separate exact-head capability.

## Acceptance criteria

1. Reservation accepts only exact workspace, Record, and external Builder Pack
   event identities. Under the Record/PR lock it revalidates tenant membership,
   the current authoritative head occurrence, confirmed Contract, active
   compiled Context Pack generation, approved observation, selected route, and
   current GitHub App installation identity.
2. Only the selected active `github_claude` route is eligible. The immutable
   capability is scoped to `dependency_initial_builder_handoff_only`; it does
   not reuse or imply correction authority.
3. Reservation and its append-only Record event commit before the external
   write. Exactly one successful reservation returns a send claim. Concurrent
   and replayed calls never return another claim.
4. An already queued or running regeneration of the exact Pack blocks a new
   reservation. An exact delivery in `reserved` or `ambiguous_hold` protects
   its active Pack: replacement completion under the same Record/PR lock
   terminalizes regeneration as held before any active-generation swap. Only
   that exact `builder_delivery_in_flight` hold may continue when at least one
   delivery with the same tenant, Record, head, Contract, Pack, and generation
   binding is `carrier_accepted` or `bounded_failed` and none remains `reserved`
   or `ambiguous_hold`. One idempotent human retry reuses the same provisional
   generation under one retry child; it does not create a parallel root or make
   other held reasons retryable. A replacement that activates first makes the
   old approved Pack ineligible for reservation.
5. The renderer is deterministic, metadata-only, and at most 12 KiB. It binds
   Record, repository, PR, delivered head occurrence, authority generation,
   Contract, compiled Pack, external Builder Pack, candidate, route revision,
   and delivery identities. It includes exactly one selected `@claude` mention
   and no source content, credentials, secrets, merge, or deployment authority.
6. The GitHub adapter binds credential minting and posting to the exact GitHub
   installation identity captured by the reservation. It revalidates that
   identity from one server-derived installation read before minting the
   repository-scoped token. A workspace rebind is a bounded credential failure
   and produces no post. The adapter accepts only HTTP 201 with the exact posted
   body, issue URL, numeric comment id, and canonical comment URL. Tokens and
   raw responses are never persisted or logged.
7. Accepted, bounded-failure, and unknown-write outcomes close the reservation
   and append one result event. Unknown writes enter `ambiguous_hold` and are
   never retried automatically. A lost result write leaves the reservation
   inert on replay, preventing a second mention.
8. Wrong tenant, role, Record, repository, head occurrence, Contract, Pack
   generation, route, installation, or custody fails closed. No interface
   grants Jace implementation, merge, deploy, shell, filesystem, code
   generation, or generic dispatch authority.
9. Focused tests cover reservation/replay races, exact receipt and terminal
   outcomes, tenant/head/route/custody refusal, regeneration-before-reservation,
   `reserved` and `ambiguous_hold` activation interlocks, multi-delivery refusal
   while any exact-bound delivery remains unresolved, exact terminal
   continuation over the same provisional generation, and replacement-before-
   reservation. Credential and adapter tests cover installation rebind refusal,
   bounded bodies, exact receipts, and no retry after uncertain writes.

## Narrow interfaces

### Database

`reserveAcceptanceDependencyBuilderDelivery({ workspaceId, recordId,
externalBuilderPackEventId, requestedBy })` returns a unique `reserved` send
claim, an inert replay/hold/terminal projection, or a fail-closed reason.

`reportAcceptanceDependencyBuilderDelivery({ workspaceId, deliveryId,
outcome })` accepts one of:

- `carrier_accepted` with exact comment id, canonical URL, and body hash;
- `bounded_failed` with an enumerated closed failure;
- `unknown_post_outcome` with an enumerated ambiguity reason.

### Production adapter

`runGithubDependencyBuilderDelivery` performs reserve, least-authority
credential mint, one post of the database-issued body, and outcome reporting.
Credential minting must match the installation identity stored by the
reservation; identity drift closes as `bounded_failed` without posting. The
adapter has no retry loop and returns no token, body, raw response, or opaque
artifact.

An authenticated owner/admin POST route accepts only the external Builder Pack
event id. The server derives every other custody binding.

## Explicit non-goals

- Dependency installation or code generation.
- Builder implementation, merge, deployment, or release authority.
- Signed successor-head attribution or review-job re-entry automation.
- Correction delivery or correction acknowledgement.
- Adapters other than `github_claude`.
- Notification fan-out, vendor broadcast, or generic logging.
- Treating a reservation, comment attempt/receipt, or later head movement as
  exact-head passing proof.

## Later live exercise prerequisites

The migration and Console source must first be deployed at one exact commit. A
test workspace must have the GitHub App installed for the exact repository, a
selected active `github_claude` route, confirmed Contract, current authoritative
open PR head, active compiled Pack, supported observed dependency candidate,
owner/admin approval, and minted external Builder Pack. The owner/admin then
triggers delivery and GitHub must return the exact comment receipt. This slice
still requires direct deployed/live and customer proof; successor exact-head
review is outside this delivery-only contract.
