/**
 * #1345 manual verification script — NOT part of `vitest run` (this
 * package's automated suite intentionally never depends on a live Postgres;
 * mirrors the convention `confirm-unpark-race-proof.ts` set for #1341). Run
 * by hand against the local dev Postgres to prove the revise loop's full
 * deny -> revise -> confirm cycle end-to-end against REAL rows — no
 * mocking — and, critically, that AC3 (a denied entry never becomes
 * claimable without a fresh confirmed brief) holds at every step in
 * between.
 *
 * Usage:
 *   DATABASE_URL=postgres://agentrail:agentrail@localhost:5434/agentrail \
 *     npx tsx scripts/revise-loop-proof.ts
 *
 * Exercises the REAL exported functions from `../src/queries/github_intake.js`
 * (a scratch workspace per section, deleted at the end via cascade). Six
 * sections:
 *   1. deny -> revise: parkReason flips DENIED -> ALIGNMENT_PARK_REASON,
 *      title/body update, budget/model/taskType stay null, `state` NEVER
 *      leaves `parked`.
 *   2. revise -> confirm with NEW (cheaper) values -> queues with those NEW
 *      sanctioned values (AC1's own end-to-end shape: deny -> "make it
 *      cheaper" -> revised brief -> approve -> queued with the new values).
 *   3. AC3 invariant: between revise and confirm, the row cannot be
 *      Requeue-button'd past the gate (`requeueParkedQueueEntry` still
 *      refuses it) and cannot be released by an unrelated dependency
 *      clearing (`unparkDependents` still leaves it parked) — only a fresh
 *      `confirmAlignmentBrief` call can ever queue it.
 *   4. `reviseAlignmentBrief` is a safe no-op (`not_denied`) against an
 *      entry that is parked for a DIFFERENT reason (plain "awaiting
 *      alignment", never denied) or not parked at all (already queued).
 *   5. Multiple deny -> revise -> deny -> revise rounds all work (the
 *      supersede transition is repeatable, not a one-shot).
 *   6. `findQueueEntryByExternalId` is workspace-scoped: the SAME
 *      `repoFullName#number` in two different workspaces resolves to each
 *      workspace's OWN row, never cross-tenant.
 *   7. (#1345 PR③, the crash-window liveness gap) `reviseAlignmentBrief`
 *      commits the denial-clearing transition, but the direct
 *      `postAlignmentBrief` call the caller normally makes right after never
 *      runs (a simulated process crash in between): proves
 *      `findRevisedBriefRecoveryCandidates` — NOT
 *      `findAlignmentBriefCandidates`, which still can't see this row, since
 *      it still carries the OLD denied approval row — finds it, that a
 *      recovery post (`recordApprovalRequest` with the SAME derived request
 *      id `reviseAndRepostAlignmentBrief` would have used) creates exactly
 *      one fresh PENDING approval, and that a SECOND attempt at the
 *      IDENTICAL derived request id (modeling a direct post racing/
 *      following the recovery sweep) converges onto the SAME row
 *      (`created:false`) rather than ever creating two — exactly ONE
 *      pending approval for the entry throughout, and `state` never leaves
 *      `parked`.
 */
import { sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db } from "../src/db.js";
import {
  findQueueEntryByExternalId,
  reviseAlignmentBrief,
  denyAlignmentBrief,
  confirmAlignmentBrief,
  requeueParkedQueueEntry,
  unparkDependents,
  findAlignmentBriefCandidates,
  findRevisedBriefRecoveryCandidates,
  ALIGNMENT_PARK_REASON,
  ALIGNMENT_DENIED_PARK_REASON,
} from "../src/queries/github_intake.js";
import {
  getOrCreateJaceSession,
  bindEveSession,
  recordApprovalRequest,
} from "../src/queries/jace_sessions.js";

const DATABASE_URL =
  process.env["DATABASE_URL"] ?? "postgres://agentrail:agentrail@localhost:5434/agentrail";

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  [PASS] ${label}`);
  } else {
    failures++;
    console.log(`  [FAIL] ${label}`, detail !== undefined ? JSON.stringify(detail) : "");
  }
}

async function makeWorkspace(requireAlignment: boolean): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO workspaces (id, name, slug, require_alignment)
    VALUES (${id}, 'revise-proof', ${`revise-proof-${id}`}, ${requireAlignment})
  `);
  return id;
}

async function insertRow(opts: {
  workspaceId: string;
  externalId: string;
  state: string;
  title?: string;
  body?: string;
  blockedBy?: number[];
  parkReason?: string | null;
  estimatedBudgetUsd?: number | null;
  modelOverride?: string | null;
}): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO queue_entries
      (id, workspace_id, source, external_id, title, body, state, blocked_by, park_reason, estimated_budget_usd, model_override)
    VALUES (
      ${id}, ${opts.workspaceId}, 'github', ${opts.externalId},
      ${opts.title ?? "Original title"}, ${opts.body ?? "original body"},
      ${opts.state}, ${JSON.stringify(opts.blockedBy ?? [])}::jsonb,
      ${opts.parkReason ?? null}, ${opts.estimatedBudgetUsd ?? null}, ${opts.modelOverride ?? null}
    )
  `);
  return id;
}

async function readRow(id: string) {
  const rows = (await db.execute(sql`
    SELECT state, title, body, park_reason, estimated_budget_usd, model_override, task_type
    FROM queue_entries WHERE id = ${id}
  `)) as unknown as Array<{
    state: string;
    title: string;
    body: string;
    park_reason: string | null;
    estimated_budget_usd: string | null;
    model_override: string | null;
    task_type: string | null;
  }>;
  return rows[0];
}

async function setGreen(id: string): Promise<void> {
  await db.execute(sql`UPDATE queue_entries SET state = 'green' WHERE id = ${id}`);
}

async function dropWorkspace(id: string): Promise<void> {
  await db.execute(sql`DELETE FROM workspaces WHERE id = ${id}`);
}

async function section1DenyThenRevise() {
  console.log("\n=== 1. deny -> revise: supersedes the denial, never touches `state` ===");
  const ws = await makeWorkspace(true);
  try {
    const id = await insertRow({
      workspaceId: ws,
      externalId: "acme/revise#1",
      state: "parked",
      title: "Original title",
      body: "original body",
      parkReason: ALIGNMENT_PARK_REASON,
    });

    const denied = await denyAlignmentBrief(id);
    check("deny: succeeds", denied === true, denied);
    let row = await readRow(id);
    check("deny: parkReason is the denial reason", row.park_reason === ALIGNMENT_DENIED_PARK_REASON, row.park_reason);
    check("deny: state stays parked", row.state === "parked", row.state);

    const revised = await reviseAlignmentBrief({
      queueEntryId: id,
      title: "Cheaper version",
      body: "## Acceptance criteria\n- [ ] AC1: narrower scope\n",
    });
    check("revise: succeeds (ok:true)", revised.ok === true, revised);

    row = await readRow(id);
    check("revise: title updated", row.title === "Cheaper version", row.title);
    check("revise: body updated", row.body.includes("narrower scope"), row.body);
    check("revise: parkReason cleared to ALIGNMENT_PARK_REASON", row.park_reason === ALIGNMENT_PARK_REASON, row.park_reason);
    check("revise: state NEVER left parked", row.state === "parked", row.state);
    check("revise: estimatedBudgetUsd stays null", row.estimated_budget_usd === null, row.estimated_budget_usd);
    check("revise: modelOverride stays null", row.model_override === null, row.model_override);
    check("revise: taskType stays null", row.task_type === null, row.task_type);
  } finally {
    await dropWorkspace(ws);
  }
}

async function section2ReviseThenConfirmWithNewValues() {
  console.log("\n=== 2. revise -> confirm with NEW values -> queues with the NEW sanctioned budget/model (AC1) ===");
  const ws = await makeWorkspace(true);
  try {
    const id = await insertRow({
      workspaceId: ws,
      externalId: "acme/revise#2",
      state: "parked",
      parkReason: ALIGNMENT_DENIED_PARK_REASON, // already denied at the start of this section
    });

    await reviseAlignmentBrief({
      queueEntryId: id,
      title: "Cheaper version",
      body: "## Acceptance criteria\n- [ ] AC1: narrower scope\n",
    });

    // The ORIGINAL (denied) brief would have sanctioned $9.99 /
    // claude-opus; the REVISED ("make it cheaper") brief sanctions a
    // cheaper model/budget instead — proving the NEW values, not the old
    // ones, are what actually get written on confirm.
    const confirmed = await confirmAlignmentBrief({
      queueEntryId: id,
      estimatedBudgetUsd: 0.75,
      modelOverride: "anthropic/claude-haiku-4-5",
      taskType: "mechanical",
    });
    check("confirm: succeeds", confirmed === true, confirmed);

    const row = await readRow(id);
    check("confirm: state flips to queued", row.state === "queued", row.state);
    check("confirm: parkReason cleared", row.park_reason === null, row.park_reason);
    check("confirm: NEW (cheaper) budget written", Number(row.estimated_budget_usd) === 0.75, row.estimated_budget_usd);
    check("confirm: NEW (cheaper) model written", row.model_override === "anthropic/claude-haiku-4-5", row.model_override);
    check("confirm: taskType written", row.task_type === "mechanical", row.task_type);
  } finally {
    await dropWorkspace(ws);
  }
}

async function section3Ac3InvariantBetweenReviseAndConfirm() {
  console.log("\n=== 3. AC3: between revise and confirm, the row cannot be requeued or dependency-released — ONLY a fresh confirm can queue it ===");
  const ws = await makeWorkspace(true);
  try {
    // 3a: requeueParkedQueueEntry (the console's Requeue-button action)
    // must still refuse a revised-but-unconfirmed row.
    {
      const id = await insertRow({
        workspaceId: ws,
        externalId: "acme/revise#3a",
        state: "parked",
        parkReason: ALIGNMENT_DENIED_PARK_REASON,
      });
      await reviseAlignmentBrief({ queueEntryId: id, title: "t", body: "b" });

      const outcome = await requeueParkedQueueEntry(ws, id);
      check("3a: requeue refuses (alignment_locked)", outcome === "alignment_locked", outcome);
      const row = await readRow(id);
      check("3a: state STILL parked (never became claimable)", row.state === "parked", row.state);
    }

    // 3b: a resolved dependency must not release a revised-but-unconfirmed
    // row either (unparkDependents' own `estimatedBudgetUsd IS NOT NULL`
    // aligned check correctly reads null here). Blocker/dependent share ONE
    // repoFullName ("acme/revise-dep") with different NUMERIC issue numbers
    // — `unmetBlockers` parses `blockedBy` as plain issue numbers against
    // sibling rows in the SAME repo, so a non-numeric suffix would silently
    // fail to parse rather than exercise the scenario.
    {
      const blocker = await insertRow({ workspaceId: ws, externalId: "acme/revise-dep#301", state: "parked" });
      const dep = await insertRow({
        workspaceId: ws,
        externalId: "acme/revise-dep#302",
        state: "parked",
        blockedBy: [301],
        parkReason: ALIGNMENT_DENIED_PARK_REASON,
      });
      await reviseAlignmentBrief({ queueEntryId: dep, title: "t", body: "b" });

      await setGreen(blocker);
      const released = await unparkDependents(ws, "acme/revise-dep#301");
      check("3b: NOT released by the resolved dependency alone", !released.includes("acme/revise-dep#302"), released);
      const row = await readRow(dep);
      check("3b: state STILL parked", row.state === "parked", row.state);
      check("3b: parkReason is the (unconfirmed) awaiting-alignment reason", row.park_reason === ALIGNMENT_PARK_REASON, row.park_reason);

      // NOW confirm it — this is the ONLY thing that can queue it.
      await confirmAlignmentBrief({ queueEntryId: dep, estimatedBudgetUsd: 1, modelOverride: "m", taskType: null });
      const confirmedRow = await readRow(dep);
      check("3b: confirm is what finally queues it", confirmedRow.state === "queued", confirmedRow.state);
    }
  } finally {
    await dropWorkspace(ws);
  }
}

async function section4NotDeniedIsSafeNoOp() {
  console.log("\n=== 4. reviseAlignmentBrief is a safe no-op against a non-denied entry ===");
  const ws = await makeWorkspace(true);
  try {
    const awaitingId = await insertRow({
      workspaceId: ws,
      externalId: "acme/revise#4a",
      state: "parked",
      parkReason: ALIGNMENT_PARK_REASON, // parked, but never denied
    });
    const result1 = await reviseAlignmentBrief({ queueEntryId: awaitingId, title: "t", body: "b" });
    check("4a: not_denied for a plain awaiting-alignment park", result1.ok === false && result1.reason === "not_denied", result1);
    const row1 = await readRow(awaitingId);
    check("4a: title untouched", row1.title === "Original title", row1.title);

    const queuedId = await insertRow({ workspaceId: ws, externalId: "acme/revise#4b", state: "queued" });
    const result2 = await reviseAlignmentBrief({ queueEntryId: queuedId, title: "t", body: "b" });
    check("4b: not_denied for an already-queued row", result2.ok === false && result2.reason === "not_denied", result2);

    const result3 = await reviseAlignmentBrief({ queueEntryId: randomUUID(), title: "t", body: "b" });
    check("4c: not_found for a nonexistent id", result3.ok === false && result3.reason === "not_found", result3);
  } finally {
    await dropWorkspace(ws);
  }
}

async function section5RepeatedDenyReviseRounds() {
  console.log("\n=== 5. multiple deny -> revise rounds all work (repeatable, not one-shot) ===");
  const ws = await makeWorkspace(true);
  try {
    const id = await insertRow({
      workspaceId: ws,
      externalId: "acme/revise#5",
      state: "parked",
      parkReason: ALIGNMENT_DENIED_PARK_REASON,
    });

    for (let round = 1; round <= 3; round++) {
      const revised = await reviseAlignmentBrief({
        queueEntryId: id,
        title: `Round ${round}`,
        body: `body ${round}`,
      });
      check(`round ${round}: revise succeeds`, revised.ok === true, revised);

      const denied = await denyAlignmentBrief(id);
      check(`round ${round}: deny succeeds again`, denied === true, denied);

      const row = await readRow(id);
      check(`round ${round}: state stays parked throughout`, row.state === "parked", row.state);
      check(`round ${round}: parkReason is the denial reason again`, row.park_reason === ALIGNMENT_DENIED_PARK_REASON, row.park_reason);
    }

    // One final revise (no re-deny) so the entry ends the section in the
    // "awaiting a fresh brief" state, matching what a real revise loop
    // leaves behind.
    const final = await reviseAlignmentBrief({ queueEntryId: id, title: "Final", body: "final body" });
    check("final revise succeeds", final.ok === true, final);
    const row = await readRow(id);
    check("final: parkReason is ALIGNMENT_PARK_REASON, ready for a fresh brief", row.park_reason === ALIGNMENT_PARK_REASON, row.park_reason);
  } finally {
    await dropWorkspace(ws);
  }
}

async function section6WorkspaceScopedLookup() {
  console.log("\n=== 6. findQueueEntryByExternalId is workspace-scoped (never cross-tenant) ===");
  const wsA = await makeWorkspace(true);
  const wsB = await makeWorkspace(true);
  try {
    const idA = await insertRow({ workspaceId: wsA, externalId: "acme/shared#1", state: "parked", title: "Workspace A's entry" });
    const idB = await insertRow({ workspaceId: wsB, externalId: "acme/shared#1", state: "parked", title: "Workspace B's entry" });

    const foundA = await findQueueEntryByExternalId(wsA, "acme/shared", 1);
    const foundB = await findQueueEntryByExternalId(wsB, "acme/shared", 1);

    check("6: workspace A's lookup resolves to A's own row", foundA?.id === idA, foundA);
    check("6: workspace B's lookup resolves to B's own row (never A's)", foundB?.id === idB, foundB);
    check("6: the two rows are genuinely different", idA !== idB, { idA, idB });

    const notFound = await findQueueEntryByExternalId(wsA, "acme/nonexistent", 999);
    check("6: a genuinely absent (repo, number) resolves null", notFound === null, notFound);
  } finally {
    await dropWorkspace(wsA);
    await dropWorkspace(wsB);
  }
}

/** A real jace_sessions row with a bound eveSessionId, so
 * `recordApprovalRequest` (which requires a non-null `eveSessionId`) can be
 * called directly — mirrors what a real Telegram session looks like once the
 * first turn creates it, without needing a live Telegram bot for this proof. */
async function makeJaceSession(
  workspaceId: string
): Promise<{ sessionId: string; eveSessionId: string }> {
  const session = await getOrCreateJaceSession(
    workspaceId,
    "telegram",
    `revise-proof-${randomUUID()}`
  );
  const eveSessionId = `eve-${randomUUID()}`;
  await bindEveSession(session.id, eveSessionId);
  return { sessionId: session.id, eveSessionId };
}

async function countPendingApprovals(queueEntryId: string): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT count(*)::int AS n FROM jace_approvals
    WHERE queue_entry_id = ${queueEntryId} AND status = 'pending'
  `)) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

async function countApprovalsWithRequestId(
  eveSessionId: string,
  requestId: string
): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT count(*)::int AS n FROM jace_approvals
    WHERE eve_session_id = ${eveSessionId} AND request_id = ${requestId}
  `)) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

async function section7CrashWindowRecoveryAndConvergence() {
  console.log(
    "\n=== 7. crash-window liveness gap: recovery sweep finds a revised-but-unposted entry, and converges with a racing/repeated post onto exactly ONE pending row ==="
  );
  const ws = await makeWorkspace(true);
  try {
    const id = await insertRow({
      workspaceId: ws,
      externalId: "acme/revise#7",
      state: "parked",
      parkReason: ALIGNMENT_DENIED_PARK_REASON,
    });

    // Seed the original denial's own audit-trail approval row (status =
    // 'denied') — exactly what a real deny -> revise cycle leaves behind
    // (reviseAlignmentBrief NEVER deletes it; see that function's own
    // doc-comment). `recordApprovalRequest` always inserts 'pending'; flip it
    // to 'denied' with a direct UPDATE to model the post-denial state this
    // section starts from.
    const { sessionId, eveSessionId } = await makeJaceSession(ws);
    const deniedRequestId = `alignment-brief:${id}`;
    const recordedDenied = await recordApprovalRequest({
      workspaceId: ws,
      sessionId,
      eveSessionId,
      requestId: deniedRequestId,
      toolName: "alignment_brief",
      toolInput: {},
      approveOptionId: "approve",
      denyOptionId: "deny",
      queueEntryId: id,
    });
    await db.execute(
      sql`UPDATE jace_approvals SET status = 'denied' WHERE id = ${recordedDenied.approval.id}`
    );

    // 7a. reviseAlignmentBrief clears the denial. In production the caller
    // (the console revise route, or the webhook's edited branch) would call
    // postAlignmentBrief IMMEDIATELY after this — simulate a crash right
    // here: that direct post never happens.
    const revised = await reviseAlignmentBrief({
      queueEntryId: id,
      title: "Cheaper version",
      body: "## Acceptance criteria\n- [ ] narrower scope\n",
    });
    check("7a: revise succeeds", revised.ok === true, revised);
    if (!revised.ok) return;

    // 7b. WITHOUT this PR's fix, this entry would now be invisible to
    // findAlignmentBriefCandidates FOREVER (it still carries the denied
    // approval row) — but findRevisedBriefRecoveryCandidates DOES see it.
    const admissionCandidates = await findAlignmentBriefCandidates(ws, 50);
    check(
      "7b: findAlignmentBriefCandidates does NOT see it (still has an approval row — the denied one)",
      !admissionCandidates.some((c) => c.id === id),
      admissionCandidates.map((c) => c.id)
    );
    const recoveryCandidates = await findRevisedBriefRecoveryCandidates(ws, 50);
    const recovered = recoveryCandidates.find((c) => c.id === id);
    check(
      "7b: findRevisedBriefRecoveryCandidates DOES see it (cleared denial + denied row + no pending row)",
      recovered !== undefined,
      recoveryCandidates.map((c) => c.id)
    );
    check(
      "7b: the recovery candidate's own updatedAt matches the revise transition's updatedAt (both derive the SAME request id from it)",
      recovered !== undefined && recovered.updatedAt.getTime() === revised.updatedAt.getTime(),
      { candidate: recovered?.updatedAt, revised: revised.updatedAt }
    );

    // 7c. The reconciler's recovery post — derives the SAME request id
    // `reviseAndRepostAlignmentBrief` (apps/console/lib/alignment-reconciler.ts)
    // would have used for a DIRECT post of this exact revise transition.
    const recoveryRequestId = `alignment-brief:${id}:revise-${revised.updatedAt.getTime()}`;
    const firstPost = await recordApprovalRequest({
      workspaceId: ws,
      sessionId,
      eveSessionId,
      requestId: recoveryRequestId,
      toolName: "alignment_brief",
      toolInput: { title: "Cheaper version" },
      approveOptionId: "approve",
      denyOptionId: "deny",
      queueEntryId: id,
    });
    check("7c: recovery post creates a NEW row (created:true)", firstPost.created === true, firstPost);
    check(
      "7c: exactly ONE pending approval row for this entry now",
      (await countPendingApprovals(id)) === 1,
      await countPendingApprovals(id)
    );

    // 7d. Recovered: findRevisedBriefRecoveryCandidates no longer sees it —
    // a pending row now exists, so a later sweep won't re-post it again.
    const afterRecovery = await findRevisedBriefRecoveryCandidates(ws, 50);
    check(
      "7d: no longer a recovery candidate once a pending row exists",
      !afterRecovery.some((c) => c.id === id),
      afterRecovery.map((c) => c.id)
    );

    // 7e. CONVERGENCE: a second attempt at the IDENTICAL derived request id
    // — modeling a direct post racing (or following) this same recovery, or
    // the reconciler sweep simply running twice — converges onto the SAME
    // row via `recordApprovalRequest`'s own `onConflictDoNothing`
    // (created:false), never creating a second pending brief.
    const secondPost = await recordApprovalRequest({
      workspaceId: ws,
      sessionId,
      eveSessionId,
      requestId: recoveryRequestId,
      toolName: "alignment_brief",
      toolInput: { title: "Cheaper version" },
      approveOptionId: "approve",
      denyOptionId: "deny",
      queueEntryId: id,
    });
    check(
      "7e: a second post at the SAME derived request id converges (created:false)",
      secondPost.created === false,
      secondPost
    );
    check(
      "7e: both posts resolve the SAME approval row",
      secondPost.approval.id === firstPost.approval.id,
      { first: firstPost.approval.id, second: secondPost.approval.id }
    );
    check(
      "7e: STILL exactly ONE row for (eveSessionId, requestId) — never two",
      (await countApprovalsWithRequestId(eveSessionId, recoveryRequestId)) === 1,
      await countApprovalsWithRequestId(eveSessionId, recoveryRequestId)
    );
    check(
      "7e: STILL exactly ONE pending approval for this entry — a racing/repeated post never double-briefs",
      (await countPendingApprovals(id)) === 1,
      await countPendingApprovals(id)
    );

    // 7f. AC3 still holds throughout recovery: the entry never became
    // claimable — only a fresh confirmAlignmentBrief could do that.
    const row = await readRow(id);
    check("7f: state STILL parked throughout recovery", row.state === "parked", row.state);
  } finally {
    await dropWorkspace(ws);
  }
}

async function main() {
  console.log(`Connecting to ${DATABASE_URL.replace(/:[^:@]+@/, ":***@")}`);
  await section1DenyThenRevise();
  await section2ReviseThenConfirmWithNewValues();
  await section3Ac3InvariantBetweenReviseAndConfirm();
  await section4NotDeniedIsSafeNoOp();
  await section5RepeatedDenyReviseRounds();
  await section6WorkspaceScopedLookup();
  await section7CrashWindowRecoveryAndConvergence();

  console.log(`\n=== SUMMARY: ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Script crashed:", err);
  process.exit(1);
});
