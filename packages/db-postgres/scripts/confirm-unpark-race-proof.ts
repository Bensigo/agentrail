/**
 * #1341 manual verification script — NOT part of `vitest run` (this package's
 * automated suite intentionally never depends on a live Postgres; see
 * `src/__tests__/workspace-grant-events-schema.test.ts`'s own note). Run by
 * hand against the local dev Postgres to produce the "scripted two-connection
 * interleaving proof" the issue's Verification Evidence section asks for —
 * paste this script's output into the PR as evidence, the way the #1274 PR①
 * reviewer's own "22-check independent script" did.
 *
 * Usage:
 *   DATABASE_URL=postgres://agentrail:agentrail@localhost:5434/agentrail \
 *     npx tsx scripts/confirm-unpark-race-proof.ts
 *
 * Exercises the REAL exported functions from `../src/queries/github_intake.js`
 * against real rows (a scratch workspace, deleted at the end via cascade) —
 * no mocking. Five sections:
 *   1. Four-ordering safety matrix (mirrors the pre-#1341 mocked "reviewer
 *      repro" describe block, now against a real Postgres so the SEMANTIC
 *      claims — not just the call shape — are re-proven for the new
 *      single-UPDATE confirmAlignmentBrief).
 *   2. Deterministic two-connection interleaving repro: a THIRD connection
 *      holds an explicit `SELECT ... FOR UPDATE` on the dependent row so
 *      `unparkDependents` and `confirmAlignmentBrief` are BOTH guaranteed to
 *      be genuinely in-flight (blocked on the same row) at once before either
 *      is allowed to complete — true forced concurrency, not just sequential
 *      ordering. Run once with the lock released "unpark-first" and once
 *      "confirm-first" (both orderings the issue names).
 *   3. Concurrent stress trials: many repetitions of a genuine
 *      `Promise.all([unparkDependents(...), confirmAlignmentBrief(...)])`
 *      race with no forced ordering at all, asserting the row NEVER wedges
 *      regardless of which one the DB/event-loop happens to interleave first.
 *   4. The requireAlignment-flip edge (#1341 item 4) end-to-end.
 *   5. Belt-and-suspenders guard: unpark's re-park UPDATE is a genuine no-op
 *      once a budget is already written.
 *   6. confirm's OWN `state = 'parked'` guard is re-checked at lock time
 *      (EvalPlanQual), not snapshot-only: a row that leaves `parked` while
 *      confirm is blocked on its row lock is NOT clobbered with a budget.
 */
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db } from "../src/db.js";
import {
  confirmAlignmentBrief,
  unparkDependents,
  denyAlignmentBrief,
  ALIGNMENT_PARK_REASON,
  ALIGNMENT_DENIED_PARK_REASON,
} from "../src/queries/github_intake.js";

const DATABASE_URL =
  process.env["DATABASE_URL"] ?? "postgres://agentrail:agentrail@localhost:5432/agentrail";

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
      VALUES (${id}, 'race-proof', ${`race-proof-${id}`}, ${requireAlignment})
    `);
  return id;
}

async function insertRow(opts: {
  workspaceId: string;
  externalId: string;
  state: string;
  blockedBy?: number[];
  parkReason?: string | null;
  estimatedBudgetUsd?: number | null;
}): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO queue_entries
      (id, workspace_id, source, external_id, title, body, state, blocked_by, park_reason, estimated_budget_usd)
    VALUES (
      ${id}, ${opts.workspaceId}, 'github', ${opts.externalId}, 't', '',
      ${opts.state}, ${JSON.stringify(opts.blockedBy ?? [])}::jsonb,
      ${opts.parkReason ?? null}, ${opts.estimatedBudgetUsd ?? null}
    )
  `);
  return id;
}

async function readRow(id: string) {
  const rows = (await db.execute(sql`
    SELECT state, park_reason, estimated_budget_usd, model_override, task_type
    FROM queue_entries WHERE id = ${id}
  `)) as unknown as Array<{
    state: string;
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

/** A wedge: parked, budget written, but the dependency is ALREADY green. */
function isWedged(row: Awaited<ReturnType<typeof readRow>>): boolean {
  return row.state === "parked" && row.estimated_budget_usd !== null;
}

async function section1FourOrderingMatrix() {
  console.log("\n=== 1. Four-ordering safety matrix (real Postgres) ===");
  const ws = await makeWorkspace(true);
  try {
    // --- ordering A: blocker green -> unpark -> stays parked "awaiting
    // alignment", budget/model still null (pre-#1341 bug, pinned fixed) ---
    {
      const blocker = await insertRow({ workspaceId: ws, externalId: "acme/r#42", state: "parked" });
      const dep = await insertRow({
        workspaceId: ws,
        externalId: "acme/r#7",
        state: "parked",
        blockedBy: [42],
        parkReason: "Waiting on #42",
      });
      await setGreen(blocker);
      const released = await unparkDependents(ws, "acme/r#42");
      check("A: not released (still needs a confirmed brief)", released.length === 0, released);
      const row = await readRow(dep);
      check("A: state stays parked", row.state === "parked", row.state);
      check("A: parkReason flips to ALIGNMENT_PARK_REASON", row.park_reason === ALIGNMENT_PARK_REASON, row.park_reason);
      check("A: budget still null", row.estimated_budget_usd === null, row.estimated_budget_usd);
    }

    // --- ordering B: confirm-then-release ---
    {
      const blocker = await insertRow({ workspaceId: ws, externalId: "acme/r#43", state: "parked" });
      const dep = await insertRow({
        workspaceId: ws,
        externalId: "acme/r#8",
        state: "parked",
        blockedBy: [43],
        parkReason: "Waiting on #43",
      });
      const confirmed = await confirmAlignmentBrief({
        queueEntryId: dep,
        estimatedBudgetUsd: 1.35,
        modelOverride: "anthropic/claude-sonnet-5",
        taskType: "ui",
      });
      check("B: confirm succeeds (ceiling sanctioned even though blocked)", confirmed === true);
      let row = await readRow(dep);
      check("B: stays parked with the DEPENDENCY reason (not the alignment one)", row.park_reason === "Waiting on #43", row.park_reason);
      check("B: budget IS written despite staying parked", Number(row.estimated_budget_usd) === 1.35, row.estimated_budget_usd);

      await setGreen(blocker);
      const released = await unparkDependents(ws, "acme/r#43");
      check("B: unpark releases it now (budget already sanctioned)", released.includes("acme/r#8"), released);
      row = await readRow(dep);
      check("B: final state queued", row.state === "queued", row.state);
      check("B: parkReason cleared", row.park_reason === null, row.park_reason);
      check("B: budget preserved through release", Number(row.estimated_budget_usd) === 1.35, row.estimated_budget_usd);
      check("B: NOT wedged", !isWedged(row));
    }

    // --- ordering C: release-then-confirm ---
    {
      const blocker = await insertRow({ workspaceId: ws, externalId: "acme/r#44", state: "parked" });
      const dep = await insertRow({
        workspaceId: ws,
        externalId: "acme/r#9",
        state: "parked",
        blockedBy: [44],
        parkReason: "Waiting on #44",
      });
      await setGreen(blocker);
      const released = await unparkDependents(ws, "acme/r#44");
      check("C: not released yet (no confirmed brief)", released.length === 0, released);
      let row = await readRow(dep);
      check("C: parkReason flips to ALIGNMENT_PARK_REASON", row.park_reason === ALIGNMENT_PARK_REASON, row.park_reason);

      const confirmed = await confirmAlignmentBrief({
        queueEntryId: dep,
        estimatedBudgetUsd: 2.5,
        modelOverride: "anthropic/claude-sonnet-5",
        taskType: null,
      });
      check("C: confirm succeeds", confirmed === true);
      row = await readRow(dep);
      check("C: final state queued (blocker was already green)", row.state === "queued", row.state);
      check("C: parkReason cleared", row.park_reason === null, row.park_reason);
      check("C: budget written", Number(row.estimated_budget_usd) === 2.5, row.estimated_budget_usd);
      check("C: NOT wedged", !isWedged(row));
    }

    // --- ordering D: denied-then-release ---
    {
      const blocker = await insertRow({ workspaceId: ws, externalId: "acme/r#45", state: "parked" });
      const dep = await insertRow({
        workspaceId: ws,
        externalId: "acme/r#10",
        state: "parked",
        blockedBy: [45],
        parkReason: "Waiting on #45",
      });
      const denied = await denyAlignmentBrief(dep);
      check("D: deny succeeds", denied === true);
      await setGreen(blocker);
      const released = await unparkDependents(ws, "acme/r#45");
      check("D: denial survives — never released", released.length === 0, released);
      const row = await readRow(dep);
      check("D: parkReason stays DENIED", row.park_reason === ALIGNMENT_DENIED_PARK_REASON, row.park_reason);
      check("D: state stays parked", row.state === "parked", row.state);
    }
  } finally {
    await dropWorkspace(ws);
  }
}

/**
 * Genuine forced concurrency: connection L holds a `SELECT ... FOR UPDATE` on
 * the dependent row so that WHICHEVER of unpark/confirm's final UPDATE tries
 * to touch it next is guaranteed to actually block waiting for L — proving
 * both are truly in-flight together, not just fast sequential calls.
 *
 * Note on what "unpark wins" even means here: since the blocker is ALREADY
 * green by the time both racers fire, but confirm has NOT committed yet,
 * unpark's own (unblocked, plain-read) `estimatedBudgetUsd` lookup ALWAYS
 * observes `null` at this point — so unpark NEVER takes its "aligned,
 * release" branch in this exact race (that branch only ever fires once
 * confirm has ALREADY committed, which is the plain sequential case section 1
 * already proves). Under true concurrency, unpark instead always attempts its
 * GUARDED else-branch (re-park with `ALIGNMENT_PARK_REASON`, WHERE
 * `estimated_budget_usd IS NULL`) — the #1341 belt-and-suspenders write. The
 * genuine race is which of THAT write and confirm's write reaches the row
 * first once L releases:
 *  - confirm first: its fresh CTE already saw the green blocker and commits
 *    queued+budget; unpark's guarded re-park then finds `estimated_budget_usd
 *    IS NULL` false and silently no-ops (0 rows).
 *  - unpark's guarded write first: it harmlessly stamps `ALIGNMENT_PARK_REASON`
 *    (state stays 'parked', budget stays null); confirm's write runs right
 *    after, using a FRESH statement-time snapshot (blocker still green), and
 *    overwrites it correctly to queued+budget regardless.
 * Either way the row converges to the same correct final state — asserted
 * below regardless of which one the DB happened to let through first.
 */
async function raceOnce(opts: {
  ws: string;
  blockerExternalId: string;
  depExternalId: string;
  blockerNum: number;
  label: string;
  /** Give unpark's preliminary (unblocked) reads a head start so ITS final
   * UPDATE reaches L's lock queue before confirm's does — this is what lets
   * the "unpark commits its release first" ordering actually happen instead
   * of confirm (a single round trip) always winning the queue. */
  staggerUnparkFirstMs?: number;
}) {
  const raw = postgres(DATABASE_URL, { max: 1 });
  try {
    const blocker = await insertRow({ workspaceId: opts.ws, externalId: opts.blockerExternalId, state: "parked" });
    const dep = await insertRow({
      workspaceId: opts.ws,
      externalId: opts.depExternalId,
      state: "parked",
      blockedBy: [opts.blockerNum],
      parkReason: `Waiting on #${opts.blockerNum}`,
    });
    await setGreen(blocker);

    // Connection L: hold the row lock open in an explicit transaction.
    const held = raw.begin(async (l) => {
      await l`SELECT id FROM queue_entries WHERE id = ${dep} FOR UPDATE`;
      // Hold until releaseLock() is called below.
      await new Promise<void>((resolve) => {
        releaseLockResolvers.push(resolve);
      });
    });

    // Give L a moment to actually acquire the lock before firing the racers.
    await new Promise((r) => setTimeout(r, 150));

    let unparkPromise: Promise<string[]>;
    let confirmPromise: Promise<boolean>;
    if (opts.staggerUnparkFirstMs) {
      // unpark's own preliminary selects (batch query, workspaceRequiresAlignment,
      // unmetBlockers) are all plain reads — NOT blocked by L's row lock — so
      // this head start lets it clear all of them and reach (and block on)
      // its OWN final UPDATE before confirm's single-statement UPDATE even
      // starts, so unpark reaches L's queue first.
      unparkPromise = unparkDependents(opts.ws, opts.blockerExternalId);
      await new Promise((r) => setTimeout(r, opts.staggerUnparkFirstMs));
      confirmPromise = confirmAlignmentBrief({
        queueEntryId: dep,
        estimatedBudgetUsd: 3.75,
        modelOverride: "anthropic/claude-sonnet-5",
        taskType: null,
      });
    } else {
      unparkPromise = unparkDependents(opts.ws, opts.blockerExternalId);
      confirmPromise = confirmAlignmentBrief({
        queueEntryId: dep,
        estimatedBudgetUsd: 3.75,
        modelOverride: "anthropic/claude-sonnet-5",
        taskType: null,
      });
    }

    // Give both racers time to reach (and block on) the row lock.
    await new Promise((r) => setTimeout(r, 150));
    releaseLock();
    await held;

    const [released, confirmed] = await Promise.all([unparkPromise, confirmPromise]);
    const row = await readRow(dep);
    console.log(
      `  [${opts.label}] released=${JSON.stringify(released)} confirmed=${confirmed} -> state=${row.state} parkReason=${row.park_reason} budget=${row.estimated_budget_usd}`
    );
    check(`${opts.label}: NOT wedged`, !isWedged(row) || row.state === "queued", row);
    check(
      `${opts.label}: converges to queued-with-budget`,
      row.state === "queued" && row.park_reason === null && Number(row.estimated_budget_usd) === 3.75,
      row
    );
  } finally {
    await raw.end({ timeout: 5 });
  }
}

let releaseLockResolvers: Array<() => void> = [];
function releaseLock() {
  const resolvers = releaseLockResolvers;
  releaseLockResolvers = [];
  for (const r of resolvers) r();
}

async function section2ForcedInterleaving() {
  console.log("\n=== 2. Deterministic two-connection interleaving repro (forced concurrency via row lock) ===");
  const ws = await makeWorkspace(true);
  try {
    // race-1: simultaneous start — confirm (a single round trip) reaches
    // L's lock queue first in practice, commits queued-with-budget; unpark's
    // guarded re-park write then loses (0 rows: budget is no longer null).
    await raceOnce({
      ws,
      blockerExternalId: "acme/race#100",
      depExternalId: "acme/race#101",
      blockerNum: 100,
      label: "race-1 (confirm's write reaches the lock first)",
    });
    // race-2: unpark gets a head start on its OWN unblocked preliminary reads
    // so ITS guarded re-park write reaches L's queue first instead — the
    // mirror ordering (see raceOnce's own doc-comment for why this is still
    // "unpark's re-park write", never a release, under true concurrency).
    await raceOnce({
      ws,
      blockerExternalId: "acme/race#200",
      depExternalId: "acme/race#201",
      blockerNum: 200,
      label: "race-2 (unpark's re-park write reaches the lock first)",
      staggerUnparkFirstMs: 60,
    });
  } finally {
    await dropWorkspace(ws);
  }
}

async function section3StressTrials(trials = 20) {
  console.log(`\n=== 3. Concurrent stress trials (Promise.all, no forced ordering, n=${trials}) ===`);
  const ws = await makeWorkspace(true);
  const outcomes: Record<string, number> = {};
  try {
    for (let i = 0; i < trials; i++) {
      // Each trial gets its OWN throwaway repo namespace (`acme/stressN`) so
      // concurrent-looking rows across trials never collide on blockedBy=[1].
      const blocker = await insertRow({ workspaceId: ws, externalId: `acme/stress${i}#1`, state: "parked" });
      const dep = await insertRow({
        workspaceId: ws,
        externalId: `acme/stress${i}#999`,
        state: "parked",
        blockedBy: [1],
        parkReason: "Waiting on #1",
      });
      await setGreen(blocker);

      const [, confirmed] = await Promise.all([
        unparkDependents(ws, `acme/stress${i}#1`),
        confirmAlignmentBrief({
          queueEntryId: dep,
          estimatedBudgetUsd: 9.99,
          modelOverride: "m",
          taskType: null,
        }),
      ]);
      const row = await readRow(dep);
      const key = `${row.state}|${row.park_reason}|budget=${row.estimated_budget_usd !== null}`;
      outcomes[key] = (outcomes[key] ?? 0) + 1;
      check(`trial ${i}: NOT wedged`, !isWedged(row), row);
      check(
        `trial ${i}: converged to queued-with-budget`,
        row.state === "queued" && row.park_reason === null && row.estimated_budget_usd !== null,
        { row, confirmed }
      );
    }
    console.log("  outcome histogram:", outcomes);
  } finally {
    await dropWorkspace(ws);
  }
}

async function section4RequireAlignmentFlip() {
  console.log("\n=== 4. requireAlignment-flip edge (#1341 item 4) ===");
  const ws = await makeWorkspace(true);
  try {
    const blocker = await insertRow({ workspaceId: ws, externalId: "acme/flip#1", state: "parked" });
    const dep = await insertRow({
      workspaceId: ws,
      externalId: "acme/flip#2",
      state: "parked",
      blockedBy: [1],
      parkReason: "Waiting on #1",
    });
    await setGreen(blocker);

    // Operator flips the flag off mid-flight.
    await db.execute(
      sql`UPDATE workspaces SET require_alignment = false WHERE id = ${ws}`
    );

    const released = await unparkDependents(ws, "acme/flip#1");
    check("flip: released via the !requireAlignment escape", released.includes("acme/flip#2"), released);
    let row = await readRow(dep);
    check("flip: state queued", row.state === "queued", row.state);
    check("flip: budget NEVER written by the release path", row.estimated_budget_usd === null, row.estimated_budget_usd);

    // A stale Approve tap arrives afterward.
    const confirmed = await confirmAlignmentBrief({
      queueEntryId: dep,
      estimatedBudgetUsd: 5.0,
      modelOverride: "m",
      taskType: null,
    });
    check("flip: confirmAlignmentBrief no-ops (pinned option (a))", confirmed === false, confirmed);
    row = await readRow(dep);
    check("flip: budget STILL null — the ceiling is safely never sanctioned", row.estimated_budget_usd === null, row.estimated_budget_usd);
    check("flip: state untouched (still queued)", row.state === "queued", row.state);
  } finally {
    await dropWorkspace(ws);
  }
}

async function section5BeltAndSuspenders() {
  console.log("\n=== 5. Belt-and-suspenders: unpark's re-park UPDATE no-ops once budget is written ===");
  const ws = await makeWorkspace(true);
  try {
    const blocker = await insertRow({ workspaceId: ws, externalId: "acme/belt#1", state: "parked" });
    const dep = await insertRow({
      workspaceId: ws,
      externalId: "acme/belt#2",
      state: "parked",
      blockedBy: [1],
      parkReason: "Waiting on #1",
    });
    // Confirm lands FIRST (blocker not green yet -> stays parked, dependency reason).
    await confirmAlignmentBrief({
      queueEntryId: dep,
      estimatedBudgetUsd: 4.2,
      modelOverride: "m",
      taskType: null,
    });
    let row = await readRow(dep);
    check("belt: still parked (blocker not green)", row.state === "parked", row.state);
    check("belt: budget already written", Number(row.estimated_budget_usd) === 4.2, row.estimated_budget_usd);

    // Now the blocker goes green and unpark runs — it MUST release cleanly,
    // never re-parking "awaiting alignment" over the sanctioned budget.
    await setGreen(blocker);
    const released = await unparkDependents(ws, "acme/belt#1");
    check("belt: released", released.includes("acme/belt#2"), released);
    row = await readRow(dep);
    check("belt: final state queued, budget intact, reason cleared", row.state === "queued" && row.park_reason === null && Number(row.estimated_budget_usd) === 4.2, row);
  } finally {
    await dropWorkspace(ws);
  }
}

/**
 * Section 6 (added in #1341 review): proves confirm's OWN `state = 'parked'`
 * guard lives on the final UPDATE, not just the `target` CTE — so it is
 * re-checked at LOCK time (EvalPlanQual), not merely at snapshot time. This is
 * the case the mocked flip-edge test structurally CANNOT cover: there the row
 * has already left `parked` before confirm even reads it (snapshot excludes
 * it). Here the row is genuinely `parked` when confirm's statement takes its
 * snapshot (so the CTE DOES pick it up), and only transitions to `queued`
 * while confirm is blocked on the row lock. If the guard were left solely in
 * the CTE, EvalPlanQual would re-check only `qe.id = agg.id` and confirm would
 * clobber the now-`queued` row with a budget; with the guard on the UPDATE the
 * re-check sees `state = 'queued'` and matches zero rows.
 */
async function section6ConfirmGuardRecheckedAtLockTime() {
  console.log(
    "\n=== 6. confirm's state='parked' guard is EvalPlanQual-re-checked at lock time (not snapshot-only) ==="
  );
  const ws = await makeWorkspace(true);
  const raw = postgres(DATABASE_URL, { max: 1 });
  try {
    // No blockers: absent any race, confirm WOULD release this to
    // queued-with-budget — so a wrongly-unguarded write is unmistakable
    // (budget lands where it must not).
    const dep = await insertRow({ workspaceId: ws, externalId: "acme/guard#1", state: "parked" });

    // Connection L: transition the row OUT of `parked` and hold the txn open so
    // its row lock blocks confirm's UPDATE.
    const held = raw.begin(async (l) => {
      await l`UPDATE queue_entries SET state = 'queued' WHERE id = ${dep}`;
      await new Promise<void>((resolve) => {
        releaseLockResolvers.push(resolve);
      });
    });
    // Let L acquire the lock and apply its (uncommitted) change first.
    await new Promise((r) => setTimeout(r, 150));

    // confirm's statement snapshot is taken NOW (row still `parked` to it,
    // since L is uncommitted) — the CTE picks the row up — then its UPDATE
    // blocks on L's lock.
    const confirmPromise = confirmAlignmentBrief({
      queueEntryId: dep,
      estimatedBudgetUsd: 9.99,
      modelOverride: "anthropic/claude-sonnet-5",
      taskType: null,
    });
    await new Promise((r) => setTimeout(r, 150)); // confirm reaches + blocks on the lock
    releaseLock(); // L commits state='queued'; confirm wakes and re-checks
    await held;

    const confirmed = await confirmPromise;
    const row = await readRow(dep);
    console.log(`  [guard] confirmed=${confirmed} -> state=${row.state} budget=${row.estimated_budget_usd}`);
    check("guard: confirm no-ops once the row left parked (lock-time re-check)", confirmed === false, confirmed);
    check("guard: budget NEVER written onto the no-longer-parked row", row.estimated_budget_usd === null, row.estimated_budget_usd);
    check("guard: state untouched (stays queued from L's commit)", row.state === "queued", row.state);
  } finally {
    await raw.end({ timeout: 5 });
    await dropWorkspace(ws);
  }
}

async function main() {
  console.log(`Connecting to ${DATABASE_URL.replace(/:[^:@]+@/, ":***@")}`);
  await section1FourOrderingMatrix();
  await section2ForcedInterleaving();
  await section3StressTrials(20);
  await section4RequireAlignmentFlip();
  await section5BeltAndSuspenders();
  await section6ConfirmGuardRecheckedAtLockTime();

  console.log(`\n=== SUMMARY: ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Script crashed:", err);
  process.exit(1);
});
