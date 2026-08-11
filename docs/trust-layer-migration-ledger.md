# Jace trust-layer migration ledger

Last reconciled: 2026-08-11 at main commit `95388f60`, after merged PR
#1676.

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

## Remaining canonical order

The next implementation work is R9, then R10, R11, and R12. Their canonical
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
live-provider, and customer proof remain separate release gates. The first R9.1
slice adds the missing current-head human decision seam without giving Jace
merge authority. A later R9.1 slice must converge the current signed-GitHub
merge event and the separate post-merge outcome route onto one exact
decided-head lineage. None of these slices may reopen the bounded R8
implementation merely because deployed, live, or customer proof is missing.
