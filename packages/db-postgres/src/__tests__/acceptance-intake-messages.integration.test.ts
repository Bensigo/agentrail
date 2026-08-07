import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db } from "../db.js";
import { workspaces } from "../schema/workspaces.js";
import {
  appendAcceptanceOutboundReply,
  recordAcceptanceInboundIntake,
} from "../queries/change_records.js";

const DB_AVAILABLE: boolean = await (async () => {
  try {
    const rows = Array.from(await db.execute(sql`
      SELECT to_regclass('public.acceptance_intakes') AS intakes,
             to_regclass('public.acceptance_intake_messages') AS messages
    `)) as Array<{ intakes: string | null; messages: string | null }>;
    return rows[0]?.intakes === "acceptance_intakes" && rows[0]?.messages === "acceptance_intake_messages";
  } catch {
    return false;
  }
})();

describe.skipIf(!DB_AVAILABLE)("Acceptance Intake outbound replies", () => {
  let workspaceId: string;

  beforeEach(async () => {
    const rows = await db.insert(workspaces).values({ name: "intake reply test", slug: `intake-reply-${randomUUID()}` }).returning({ id: workspaces.id });
    workspaceId = rows[0]!.id;
  });

  afterEach(async () => {
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  });

  it("appends outbound evidence, is retry-safe, and fails closed across workspaces", async () => {
    const inbound = await recordAcceptanceInboundIntake({
      workspaceId, originChannel: "slack", conversationKey: `thread-${randomUUID()}`,
      sourceKey: "inbound-1", text: "I need a feature",
    });
    const first = await appendAcceptanceOutboundReply({ workspaceId, intakeId: inbound.intake.id, sourceKey: "outbound-1", text: "Which repository?" });
    expect(first?.inserted).toBe(true);
    expect(first?.message.direction).toBe("outbound");

    const retry = await appendAcceptanceOutboundReply({ workspaceId, intakeId: inbound.intake.id, sourceKey: "outbound-1", text: "Which repository?" });
    expect(retry?.inserted).toBe(false);
    expect(retry?.message.id).toBe(first?.message.id);
    expect(await appendAcceptanceOutboundReply({ workspaceId: randomUUID(), intakeId: inbound.intake.id, sourceKey: "outbound-2", text: "Wrong tenant" })).toBeNull();
  });
});
