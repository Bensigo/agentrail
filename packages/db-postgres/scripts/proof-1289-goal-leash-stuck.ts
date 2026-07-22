/**
 * Hand-run LIVE-DB proof for issue #1289 (Jace goal loop) — the leash +
 * stuck-rule safety heart, against a REAL Postgres instance rather than the
 * mocked-db unit tests (`queries/goal_rules.test.ts` / `queries/
 * goals.test.ts`). This exercises the real transactional
 * `recordOutcomeAndTransition` path end to end: real INSERT/UPDATE
 * statements, real cascade deletes, real column defaults — everything a
 * mock can only assert the CONTRACT of.
 *
 * Usage:
 *   cd packages/db-postgres
 *   DATABASE_URL=postgres://agentrail:agentrail@localhost:5434/agentrail \
 *     npx tsx scripts/proof-1289-goal-leash-stuck.ts
 *
 * SAFETY (see `test-cleanup-deleted-user-data` — never delete by a
 * non-unique name/label on a live DB): this script creates exactly ONE
 * workspace row (a fresh random slug) and deletes it BY ITS OWN PRIMARY KEY
 * in `finally`, even on assertion failure. Every repository/goal/goal_event
 * this run creates cascades away with it (`ON DELETE CASCADE` at every
 * level — see schema/goals.ts and schema/goal_events.ts). Nothing
 * pre-existing is ever touched.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../src/db.js";
import { workspaces } from "../src/schema/workspaces.js";
import {
  createRepository,
  isGoalLoopEnabled,
  createGoal,
  recordIssueFiled,
  recordOutcomeAndTransition,
  goalCanFileNextIssue,
  getGoalById,
} from "../src/queries/index.js";

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean): void {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}`);
  }
}

async function main() {
  const marker = `goal-proof-${Date.now()}-${randomUUID().slice(0, 8)}`;

  const [workspace] = await db
    .insert(workspaces)
    .values({ name: marker, slug: marker })
    .returning();
  if (!workspace) throw new Error("failed to create proof workspace");

  try {
    console.log("Flag default-OFF (rollout safety):");
    check(
      "a freshly created workspace has jaceGoalLoop=false by default",
      (await isGoalLoopEnabled(workspace.id)) === false
    );

    // Opt this one proof workspace in (mirrors flipping the column directly —
    // there is no console UI toggle yet, same posture as mergePermission/
    // hostedExecution before their own UIs shipped).
    await db.update(workspaces).set({ jaceGoalLoop: true }).where(eq(workspaces.id, workspace.id));
    check("flipping the column makes isGoalLoopEnabled true", (await isGoalLoopEnabled(workspace.id)) === true);

    const repo = await createRepository({
      workspaceId: workspace.id,
      name: `${marker}-repo`,
      url: `https://github.com/agentrail/${marker}`,
      defaultBranch: "main",
    });

    // --- Scenario 1: issue-count leash trips at exactly maxIssues ---
    console.log("\nLeash (issues) — trips at exactly maxIssues:");
    const issueLeashGoal = await createGoal({
      workspaceId: workspace.id,
      repositoryId: repo.id,
      objective: "burn down flaky tests",
      slug: `${marker}-issue-leash`,
      checkType: "metric",
      checkThreshold: 999, // unreachable — isolates the leash from the reached check
      maxIssues: 2,
      maxSpendUsd: 1000,
      stuckThreshold: 5, // loose — isolates the leash from the stuck rule
    });

    await recordIssueFiled(issueLeashGoal.id, "1001");
    const r1 = await recordOutcomeAndTransition({
      workspaceId: workspace.id,
      issueExternalId: "1001",
      outcome: "blocked",
      costUsd: 5,
    });
    check("1st of 2 issues: still active, action=refill", r1.matched && r1.action === "refill");

    await recordIssueFiled(issueLeashGoal.id, "1002");
    const r2 = await recordOutcomeAndTransition({
      workspaceId: workspace.id,
      issueExternalId: "1002",
      outcome: "blocked",
      costUsd: 5,
    });
    check("2nd of 2 issues: leash trips, action=escalate_leashed", r2.matched && r2.action === "escalate_leashed");
    check("goal row persisted status='leashed'", r2.goal?.status === "leashed");

    const canFileMore = await goalCanFileNextIssue(issueLeashGoal.id);
    check("goalCanFileNextIssue now refuses (leash exhausted)", canFileMore.allow === false);

    // A THIRD issue somehow mapped to this goal must find it already
    // terminal and refuse to evaluate at all — the "never loops forever"
    // proof against a REAL transaction, not just the pure function.
    await recordIssueFiled(issueLeashGoal.id, "1003"); // bookkeeping only; the goal is already leashed
    const r3 = await recordOutcomeAndTransition({
      workspaceId: workspace.id,
      issueExternalId: "1003",
      outcome: "green",
      costUsd: 5,
    });
    check(
      "a goal already 'leashed' maps a further issue to matched=false (findActiveGoalForIssue excludes non-active goals)",
      r3.matched === false
    );

    // --- Scenario 2: spend leash trips at exactly maxSpendUsd ---
    console.log("\nLeash (spend) — trips at exactly maxSpendUsd:");
    const spendLeashGoal = await createGoal({
      workspaceId: workspace.id,
      repositoryId: repo.id,
      objective: "keep deps current",
      slug: `${marker}-spend-leash`,
      checkType: "metric",
      checkThreshold: 999,
      maxIssues: 1000,
      maxSpendUsd: 20,
      stuckThreshold: 5,
    });
    await recordIssueFiled(spendLeashGoal.id, "2001");
    const s1 = await recordOutcomeAndTransition({
      workspaceId: workspace.id,
      issueExternalId: "2001",
      outcome: "green",
      costUsd: 19,
    });
    check("$19 of $20 spent: still active", s1.matched && s1.action === "refill");

    await recordIssueFiled(spendLeashGoal.id, "2002");
    const s2 = await recordOutcomeAndTransition({
      workspaceId: workspace.id,
      issueExternalId: "2002",
      outcome: "green",
      costUsd: 1.5,
    });
    check("$20.50 of $20 spent: leash trips on spend", s2.matched && s2.action === "escalate_leashed");
    const spendGoalRow = await getGoalById(spendLeashGoal.id);
    check("persisted spendUsd is exactly 20.5 (no float drift)", spendGoalRow?.spendUsd === 20.5);

    // --- Scenario 3: stuck rule trips at exactly stuckThreshold consecutive non-green outcomes, WITH leash room left ---
    console.log("\nStuck rule — trips independent of leash (which still has room left):");
    const stuckGoal = await createGoal({
      workspaceId: workspace.id,
      repositoryId: repo.id,
      objective: "reach 80% coverage",
      slug: `${marker}-stuck`,
      checkType: "metric",
      checkThreshold: 999,
      maxIssues: 100, // deliberately huge — proves the stuck rule, not the leash, is what stops this
      maxSpendUsd: 1000,
      stuckThreshold: 2,
    });
    await recordIssueFiled(stuckGoal.id, "3001");
    const u1 = await recordOutcomeAndTransition({
      workspaceId: workspace.id,
      issueExternalId: "3001",
      outcome: "blocked",
      costUsd: 1,
    });
    check("1st non-green outcome: still active", u1.matched && u1.action === "refill");

    await recordIssueFiled(stuckGoal.id, "3002");
    const u2 = await recordOutcomeAndTransition({
      workspaceId: workspace.id,
      issueExternalId: "3002",
      outcome: "escalated-to-human",
      costUsd: 1,
    });
    check("2nd CONSECUTIVE non-green outcome: stuck rule trips, action=escalate_stuck", u2.matched && u2.action === "escalate_stuck");
    check("goal row persisted status='paused'", u2.goal?.status === "paused");
    check(
      "leash had 98 issues of room left — the stuck rule alone is what stopped this, not the leash",
      (u2.goal?.issuesFiled ?? 0) < (u2.goal?.maxIssues ?? 0)
    );

    // --- Scenario 4: a green outcome resets the stuck counter ---
    console.log("\nStuck counter resets on a green outcome:");
    const recoveringGoal = await createGoal({
      workspaceId: workspace.id,
      repositoryId: repo.id,
      objective: "reach 90% coverage",
      slug: `${marker}-recovering`,
      checkType: "metric",
      checkThreshold: 999,
      maxIssues: 100,
      maxSpendUsd: 1000,
      stuckThreshold: 2,
    });
    await recordIssueFiled(recoveringGoal.id, "4001");
    await recordOutcomeAndTransition({
      workspaceId: workspace.id,
      issueExternalId: "4001",
      outcome: "blocked",
      costUsd: 1,
    });
    await recordIssueFiled(recoveringGoal.id, "4002");
    const g1 = await recordOutcomeAndTransition({
      workspaceId: workspace.id,
      issueExternalId: "4002",
      outcome: "green",
      costUsd: 1,
    });
    check("a green outcome after one miss resets the counter — still active", g1.matched && g1.action === "refill");
    await recordIssueFiled(recoveringGoal.id, "4003");
    const g2 = await recordOutcomeAndTransition({
      workspaceId: workspace.id,
      issueExternalId: "4003",
      outcome: "blocked",
      costUsd: 1,
    });
    check("one more miss after the reset is only the FIRST consecutive miss again — still active, not stuck", g2.matched && g2.action === "refill");

    // --- Scenario 5: reached via the metric check ---
    console.log("\nReached (metric check):");
    const reachableGoal = await createGoal({
      workspaceId: workspace.id,
      repositoryId: repo.id,
      objective: "ship 2 green PRs",
      slug: `${marker}-reachable`,
      checkType: "metric",
      checkMetric: "green_run_count",
      checkThreshold: 2,
      maxIssues: 100,
      maxSpendUsd: 1000,
      stuckThreshold: 5,
    });
    await recordIssueFiled(reachableGoal.id, "5001");
    await recordOutcomeAndTransition({
      workspaceId: workspace.id,
      issueExternalId: "5001",
      outcome: "green",
      costUsd: 1,
    });
    await recordIssueFiled(reachableGoal.id, "5002");
    const rr = await recordOutcomeAndTransition({
      workspaceId: workspace.id,
      issueExternalId: "5002",
      outcome: "green",
      costUsd: 1,
    });
    check("2nd green outcome meets the threshold: action=reached", rr.matched && rr.action === "reached");
    check("goal row persisted status='reached' (a completion, not a leash/stuck failure)", rr.goal?.status === "reached");
  } finally {
    // Cleanup — exact PK only (see module doc-comment's SAFETY note).
    // Cascades to every repository/goal/goal_event this run created.
    await db.delete(workspaces).where(eq(workspaces.id, workspace.id));
    console.log("\nCleanup: removed the exact workspace row this run created (cascaded to repo/goals/goal_events).");
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("\nSCRIPT ERROR (not an assertion failure):", err);
    process.exit(1);
  });
