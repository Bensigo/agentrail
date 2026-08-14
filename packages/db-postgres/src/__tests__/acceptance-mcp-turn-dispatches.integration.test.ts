import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../db.js";
import { apiKeys } from "../schema/api_keys.js";
import {
  acceptanceIntakeMessages,
  acceptanceIntakes,
  acceptanceMcpTurnDispatches,
} from "../schema/change_records.js";
import { workspaces } from "../schema/workspaces.js";
import {
  ACCEPTANCE_MCP_TURN_RESERVATION_STALE_MS,
  AcceptanceMcpTurnDispatchConflictError,
  completeAcceptanceMcpTurnDispatch,
  holdAcceptanceMcpTurnDispatch,
  readAcceptanceMcpTurnDispatch,
  reserveAcceptanceMcpTurnDispatch,
} from "../queries/change_records.js";

const DB_AVAILABLE = await (async () => {
  try {
    await db.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
})();

const describeDb = DB_AVAILABLE ? describe : describe.skip;

describeDb("Acceptance MCP turn dispatch custody", () => {
  let workspaceId: string;
  let credentialId: string;

  beforeEach(async () => {
    workspaceId = randomUUID();
    credentialId = randomUUID();
    await db.insert(workspaces).values({
      id: workspaceId,
      name: "MCP turn dispatch test",
      slug: `mcp-turn-${randomUUID()}`,
    });
    await db.insert(apiKeys).values({
      id: credentialId,
      workspaceId,
      name: "MCP test key",
      keyPrefix: `mcp_${randomUUID()}`,
      keyHash: randomUUID(),
      kind: "agent_mcp",
    });
  });

  afterEach(async () => {
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  });

  it("atomically reserves one canonical Intake turn under concurrent identical callers", async () => {
    const taskContextKey = "codex-task-7";
    const messageKey = "turn-concurrent";
    const conversationKey = `mcp:${credentialId}:${taskContextKey}`;
    const sourceKey = `mcp-inbound:${credentialId}:${taskContextKey}:${messageKey}`;
    const input = {
      workspaceId,
      credentialId,
      taskContextKey,
      messageKey,
      conversationKey,
      sourceKey,
      message: "Plan this exact task once.",
    };

    const results = await Promise.all([
      reserveAcceptanceMcpTurnDispatch(input),
      reserveAcceptanceMcpTurnDispatch(input),
    ]);

    expect(results.map(({ kind }) => kind).sort()).toEqual(["claimed", "replayed"]);
    expect(results.every(({ dispatch }) => dispatch.status === "reserved")).toBe(true);
    const stored = await readAcceptanceMcpTurnDispatch({
      workspaceId,
      credentialId,
      taskContextKey,
      messageKey,
    });
    expect(stored?.status).toBe("reserved");
    expect(await db.select().from(acceptanceIntakes)).toHaveLength(1);
    expect(await db.select().from(acceptanceIntakeMessages)).toMatchObject([{
      intakeId: stored?.intakeId,
      sourceKey,
      direction: "inbound",
      text: "Plan this exact task once.",
    }]);
  });

  it("persists one accepted Eve session and returns it on every exact replay", async () => {
    const taskContextKey = "codex-task-accepted";
    const messageKey = "turn-accepted";
    const input = {
      workspaceId,
      credentialId,
      taskContextKey,
      messageKey,
      conversationKey: `mcp:${credentialId}:${taskContextKey}`,
      sourceKey: `mcp-inbound:${credentialId}:${taskContextKey}:${messageKey}`,
      message: "Persist this Eve acceptance.",
    };
    await reserveAcceptanceMcpTurnDispatch(input);

    const completed = await completeAcceptanceMcpTurnDispatch({
      workspaceId,
      credentialId,
      taskContextKey,
      messageKey,
      sessionId: "eve-session-1",
      continuationToken: "eve-continuation-1",
    });
    const replay = await reserveAcceptanceMcpTurnDispatch(input);

    expect(completed).toMatchObject({
      kind: "accepted",
      dispatch: {
        status: "accepted",
        sessionId: "eve-session-1",
        continuationToken: "eve-continuation-1",
      },
    });
    expect(replay).toMatchObject({
      kind: "replayed",
      dispatch: {
        status: "accepted",
        sessionId: "eve-session-1",
        continuationToken: "eve-continuation-1",
      },
    });
  });

  it("makes an ambiguous dispatch terminally held with no later delivery claim", async () => {
    const taskContextKey = "codex-task-held";
    const messageKey = "turn-held";
    const input = {
      workspaceId,
      credentialId,
      taskContextKey,
      messageKey,
      conversationKey: `mcp:${credentialId}:${taskContextKey}`,
      sourceKey: `mcp-inbound:${credentialId}:${taskContextKey}:${messageKey}`,
      message: "Never retry this ambiguous delivery.",
    };
    await reserveAcceptanceMcpTurnDispatch(input);

    const held = await holdAcceptanceMcpTurnDispatch({
      workspaceId,
      credentialId,
      taskContextKey,
      messageKey,
      reason: "hosted_inbound_unreachable",
    });
    const replay = await reserveAcceptanceMcpTurnDispatch(input);
    const lateCompletion = await completeAcceptanceMcpTurnDispatch({
      workspaceId,
      credentialId,
      taskContextKey,
      messageKey,
      sessionId: "too-late",
      continuationToken: "too-late",
    });

    expect(held).toMatchObject({
      kind: "held",
      dispatch: { status: "held", resultReason: "hosted_inbound_unreachable" },
    });
    expect(replay).toMatchObject({
      kind: "replayed",
      dispatch: { status: "held", resultReason: "hosted_inbound_unreachable" },
    });
    expect(lateCompletion).toMatchObject({ kind: "held" });
  });

  it("rejects a message-key replay whose canonical content changed", async () => {
    const taskContextKey = "codex-task-collision";
    const messageKey = "turn-collision";
    const base = {
      workspaceId,
      credentialId,
      taskContextKey,
      messageKey,
      conversationKey: `mcp:${credentialId}:${taskContextKey}`,
      sourceKey: `mcp-inbound:${credentialId}:${taskContextKey}:${messageKey}`,
    };
    await reserveAcceptanceMcpTurnDispatch({ ...base, message: "Original exact content." });

    await expect(reserveAcceptanceMcpTurnDispatch({
      ...base,
      message: "Different content under the same turn key.",
    })).rejects.toBeInstanceOf(AcceptanceMcpTurnDispatchConflictError);
  });

  it("refuses to reserve a turn when the credential does not belong to the workspace", async () => {
    const foreignWorkspaceId = randomUUID();
    await db.insert(workspaces).values({
      id: foreignWorkspaceId,
      name: "Foreign MCP workspace",
      slug: `foreign-mcp-${randomUUID()}`,
    });
    try {
      await expect(reserveAcceptanceMcpTurnDispatch({
        workspaceId: foreignWorkspaceId,
        credentialId,
        taskContextKey: "foreign-task",
        messageKey: "foreign-turn",
        conversationKey: `mcp:${credentialId}:foreign-task`,
        sourceKey: `mcp-inbound:${credentialId}:foreign-task:foreign-turn`,
        message: "Do not cross this workspace boundary.",
      })).rejects.toThrow("Acceptance MCP credential is not current");
      expect(await db.select().from(acceptanceIntakes).where(
        eq(acceptanceIntakes.workspaceId, foreignWorkspaceId),
      )).toHaveLength(0);
    } finally {
      await db.delete(workspaces).where(eq(workspaces.id, foreignWorkspaceId));
    }
  });

  it("refuses a broad runner credential even when it belongs to the workspace", async () => {
    const runnerCredentialId = randomUUID();
    await db.insert(apiKeys).values({
      id: runnerCredentialId,
      workspaceId,
      name: "Runner key",
      keyPrefix: `runner_${randomUUID()}`,
      keyHash: randomUUID(),
      kind: "self_hosted",
    });

    await expect(reserveAcceptanceMcpTurnDispatch({
      workspaceId,
      credentialId: runnerCredentialId,
      taskContextKey: "runner-task",
      messageKey: "runner-turn",
      conversationKey: `mcp:${runnerCredentialId}:runner-task`,
      sourceKey: `mcp-inbound:${runnerCredentialId}:runner-task:runner-turn`,
      message: "A runner key must not enter the direct Jace door.",
    })).rejects.toThrow("Acceptance MCP credential is not current");
    expect(await db.select().from(acceptanceIntakes).where(
      eq(acceptanceIntakes.workspaceId, workspaceId),
    )).toHaveLength(0);
  });

  it("persists a stale reserved claim as held and never reclaims it", async () => {
    const taskContextKey = "codex-task-stale";
    const messageKey = "turn-stale";
    const input = {
      workspaceId,
      credentialId,
      taskContextKey,
      messageKey,
      conversationKey: `mcp:${credentialId}:${taskContextKey}`,
      sourceKey: `mcp-inbound:${credentialId}:${taskContextKey}:${messageKey}`,
      message: "Surface this interrupted claim without redelivery.",
    };
    const reserved = await reserveAcceptanceMcpTurnDispatch(input);
    await db.update(acceptanceMcpTurnDispatches).set({
      reservedAt: new Date(Date.now() - ACCEPTANCE_MCP_TURN_RESERVATION_STALE_MS - 1_000),
    }).where(eq(acceptanceMcpTurnDispatches.id, reserved.dispatch.id));

    const readback = await readAcceptanceMcpTurnDispatch({
      workspaceId,
      credentialId,
      taskContextKey,
      messageKey,
    });
    const replay = await reserveAcceptanceMcpTurnDispatch(input);

    expect(readback).toMatchObject({ status: "held", resultReason: "stale_reserved_claim" });
    expect(readback?.completedAt).toBeInstanceOf(Date);
    expect(replay).toMatchObject({
      kind: "replayed",
      dispatch: { status: "held", resultReason: "stale_reserved_claim" },
    });
  });
});
