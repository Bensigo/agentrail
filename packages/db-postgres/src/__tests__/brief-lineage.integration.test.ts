import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../db.js";
import { briefs } from "../schema/briefs.js";
import { jaceApprovals, jaceSessions } from "../schema/jace_sessions.js";
import { queueEntries } from "../schema/queue_entries.js";
import { workspaces } from "../schema/workspaces.js";
import { __resetProcessLedger, enqueueGithubIssue } from "../queries/github_intake.js";

/**
 * #1602 / #1625 — real-Postgres proof for durable brief lineage. These
 * invariants live in migration 0078 and the queue INSERT, so mocks that only
 * inspect Drizzle expressions are not sufficient evidence.
 */
const DB_AVAILABLE: boolean = await (async () => {
  try {
    await db.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!DB_AVAILABLE)("brief lineage — real Postgres", () => {
  let workspaceA: string;
  let workspaceB: string;

  async function createWorkspace(label: string): Promise<string> {
    const rows = await db
      .insert(workspaces)
      .values({ name: label, slug: `brief-lineage-${randomUUID()}` })
      .returning({ id: workspaces.id });
    return rows[0]!.id;
  }

  async function createBrief(workspaceId: string): Promise<string> {
    const rows = await db
      .insert(briefs)
      .values({
        workspaceId,
        slug: `brief-${randomUUID()}`,
        title: "Integration-test brief",
      })
      .returning({ id: briefs.id });
    return rows[0]!.id;
  }

  beforeEach(async () => {
    __resetProcessLedger();
    workspaceA = await createWorkspace("brief lineage A");
    workspaceB = await createWorkspace("brief lineage B");
  });

  afterEach(async () => {
    await db.delete(workspaces).where(eq(workspaces.id, workspaceA));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceB));
  });

  it("migration 0078 clears provenance without deleting the queue row", async () => {
    const briefId = await createBrief(workspaceA);
    const rows = await db
      .insert(queueEntries)
      .values({
        workspaceId: workspaceA,
        alignmentBriefId: briefId,
        source: "github",
        externalId: `owner/repo#${randomUUID()}`,
        title: "Queue row with durable provenance",
        body: "",
      })
      .returning({ id: queueEntries.id });
    const queueId = rows[0]!.id;

    await db.delete(briefs).where(eq(briefs.id, briefId));
    const queueRows = await db
      .select({ id: queueEntries.id, alignmentBriefId: queueEntries.alignmentBriefId })
      .from(queueEntries)
      .where(eq(queueEntries.id, queueId));

    expect(queueRows).toEqual([{ id: queueId, alignmentBriefId: null }]);
  });

  it("does not persist a foreign-workspace brief supplied through an approved issue", async () => {
    const foreignBriefId = await createBrief(workspaceB);
    const issueNumber = 91922;
    const repo = "owner/repo";
    const issueUrl = `https://github.com/${repo}/issues/${issueNumber}`;
    const sessionRows = await db
      .insert(jaceSessions)
      .values({
        workspaceId: workspaceA,
        channel: "integration-test",
        conversationKey: randomUUID(),
      })
      .returning({ id: jaceSessions.id });
    const sessionId = sessionRows[0]!.id;
    await db.insert(jaceApprovals).values({
      workspaceId: workspaceA,
      sessionId,
      eveSessionId: `eve-${randomUUID()}`,
      requestId: `request-${randomUUID()}`,
      callbackToken: `callback-${randomUUID()}`,
      toolName: "create_issue",
      approveOptionId: "approve",
      denyOptionId: "deny",
      toolInput: {
        _briefLineage: { briefId: foreignBriefId },
        _brief: {
          estimateUsd: 1,
          suggestedModel: { slug: "anthropic/claude-sonnet-5" },
        },
      },
      status: "approved",
      publishedIssueUrl: issueUrl,
    });

    const result = await enqueueGithubIssue({
      workspaceId: workspaceA,
      repoFullName: repo,
      number: issueNumber,
      title: "Queue entry must not borrow foreign provenance",
      body: "## Acceptance criteria\n- [ ] has proof\n",
    });
    expect(result.enqueued).toBe(true);

    const queueRows = await db
      .select({ workspaceId: queueEntries.workspaceId, alignmentBriefId: queueEntries.alignmentBriefId })
      .from(queueEntries)
      .where(eq(queueEntries.id, result.id!));
    expect(queueRows).toEqual([{ workspaceId: workspaceA, alignmentBriefId: null }]);
  });
});
