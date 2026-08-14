import { NextRequest, NextResponse } from "next/server";
import {
  findEnabledJaceWorkspace,
  readAcceptanceIntakeMessage,
  readAcceptanceIntakeMcpReply,
  readAcceptanceIntakeReadback,
  readAcceptanceRecordDetail,
} from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";
import {
  dispatchMcpJaceTurn,
  MCP_MESSAGE_KEY_LIMIT,
  MCP_MESSAGE_LIMIT,
  MCP_TASK_CONTEXT_KEY_LIMIT,
  mcpIntakeId,
  mcpMessageSourceKey,
} from "../../../../../lib/agent-jace-mcp";

const AUTHORITY = Object.freeze({
  humanConfirmation: "required_elsewhere",
  implementation: "not_granted",
  merge: "not_granted",
  deployment: "not_granted",
});
const MAX_BODY_BYTES = 16 * 1024;

export const runtime = "nodejs";

function bounded(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= limit && !/[\u0000-\u001f\u007f]/u.test(text) ? text : null;
}

async function readBoundedJson(request: Request): Promise<Record<string, unknown> | null> {
  const contentLength = request.headers.get("content-length");
  if ((contentLength !== null
      && (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES))
    || !request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_BODY_BYTES) {
        try { await reader.cancel(); } catch { /* closed */ }
        return null;
      }
      chunks.push(next.value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return value != null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function authorize(request: NextRequest) {
  const authorization = await requireBearer(request);
  if (authorization instanceof NextResponse) return authorization;
  if (authorization.kind !== "self_hosted") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (await findEnabledJaceWorkspace(authorization.workspaceId) !== authorization.workspaceId) {
    return NextResponse.json({ error: "Jace is not enabled" }, { status: 403 });
  }
  return authorization;
}

function compactRecord(
  detail: Awaited<ReturnType<typeof readAcceptanceRecordDetail>>,
) {
  if (detail.kind !== "record") return detail;
  return {
    kind: "record" as const,
    id: detail.detail.summary.recordId,
    repo: detail.detail.summary.repo,
    unknownReasons: detail.detail.summary.unknownReasons,
    contractIdentity: detail.detail.contract.identity,
    pullRequest: detail.detail.pullRequest,
    contextPacks: detail.detail.contextPacks.map((pack) => ({
      occurrence: pack.occurrence,
      sourceSnapshot: {
        id: pack.sourceSnapshot.id,
        status: pack.sourceSnapshot.status,
        reason: pack.sourceSnapshot.reason,
        binding: pack.sourceSnapshot.binding,
      },
      compiledPacks: pack.compiledPacks.map((compiled) => ({
        id: compiled.id,
        compilerVersion: compiled.compilerVersion,
        policyVersion: compiled.policyVersion,
        packSha256: compiled.packSha256,
        binding: compiled.binding,
      })),
    })),
  };
}

export async function GET(request: NextRequest) {
  const authorization = await authorize(request);
  if (authorization instanceof NextResponse) return authorization;
  const keys = [...request.nextUrl.searchParams.keys()].sort();
  const taskContextKey = bounded(
    request.nextUrl.searchParams.get("taskContextKey"),
    MCP_TASK_CONTEXT_KEY_LIMIT,
  );
  const messageKey = bounded(request.nextUrl.searchParams.get("messageKey"), MCP_MESSAGE_KEY_LIMIT);
  if (!taskContextKey || !messageKey || keys.length !== 2
    || keys[0] !== "messageKey" || keys[1] !== "taskContextKey") {
    return NextResponse.json({ error: "taskContextKey and messageKey are required" }, { status: 400 });
  }
  const intakeId = mcpIntakeId({
    workspaceId: authorization.workspaceId,
    credentialId: authorization.apiKeyId,
    taskContextKey,
  });
  const intake = await readAcceptanceIntakeReadback({
    workspaceId: authorization.workspaceId,
    intakeId,
  });
  if (!intake || intake.intake.originChannel !== "mcp") {
    return NextResponse.json({ error: "Jace task not found" }, { status: 404 });
  }
  const replyToSourceKey = mcpMessageSourceKey(authorization.apiKeyId, taskContextKey, messageKey);
  const reply = await readAcceptanceIntakeMcpReply({
    workspaceId: authorization.workspaceId,
    intakeId,
    replyToSourceKey,
  });
  const detail = intake.intake.recordId
    ? await readAcceptanceRecordDetail({
        workspaceId: authorization.workspaceId,
        recordId: intake.intake.recordId,
      })
    : null;
  return NextResponse.json({
    task: { taskContextKey, messageKey, intakeId },
    reply: reply
      ? { status: "available", id: reply.id, text: reply.text.slice(0, 2_000), textTruncated: reply.text.length > 2_000 }
      : { status: "pending" },
    acceptance: {
      intake: intake.intake,
      messages: {
        firstInbound: intake.firstInbound,
        recent: intake.recentMessages,
        counts: intake.messageCounts,
      },
      contract: intake.contract,
      record: detail ? compactRecord(detail) : null,
    },
    authority: AUTHORITY,
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const authorization = await authorize(request);
  if (authorization instanceof NextResponse) return authorization;

  const body = await readBoundedJson(request);
  if (!body || Object.keys(body).length !== 3
    || !Object.keys(body).every((key) =>
      key === "taskContextKey" || key === "messageKey" || key === "message")) {
    return NextResponse.json({ error: "Invalid Jace turn" }, { status: 400 });
  }
  const taskContextKey = bounded(body.taskContextKey, MCP_TASK_CONTEXT_KEY_LIMIT);
  const messageKey = bounded(body.messageKey, MCP_MESSAGE_KEY_LIMIT);
  const message = bounded(body.message, MCP_MESSAGE_LIMIT);
  if (!taskContextKey || !messageKey || !message) {
    return NextResponse.json({ error: "Invalid Jace turn" }, { status: 400 });
  }

  const intakeId = mcpIntakeId({
    workspaceId: authorization.workspaceId,
    credentialId: authorization.apiKeyId,
    taskContextKey,
  });
  const sourceKey = mcpMessageSourceKey(authorization.apiKeyId, taskContextKey, messageKey);
  const existing = await readAcceptanceIntakeMessage({
    workspaceId: authorization.workspaceId,
    intakeId,
    sourceKey,
  });
  if (existing) {
    if (existing.direction !== "inbound" || existing.text !== message) {
      return NextResponse.json(
        { error: "messageKey is already bound to different task-context content" },
        { status: 409 },
      );
    }
    return NextResponse.json({
      task: { taskContextKey, intakeId },
      accepted: true,
      duplicate: true,
      authority: AUTHORITY,
    });
  }
  const result = await dispatchMcpJaceTurn({
    workspaceId: authorization.workspaceId,
    credentialId: authorization.apiKeyId,
    taskContextKey,
    sourceKey,
    message,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: "Jace did not accept the task-context turn", reason: result.reason },
      { status: 502 },
    );
  }
  return NextResponse.json({
    task: { taskContextKey, intakeId },
    accepted: true,
    session: { id: result.sessionId, continuationToken: result.continuationToken },
    authority: AUTHORITY,
  }, { status: 202 });
}
