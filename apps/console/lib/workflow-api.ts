import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import { requireBearer } from "./bearer-auth";

export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHASES = [
  "planning",
  "implementing",
  "testing",
  "reviewing",
  "blocked",
  "needs_review",
];
export async function workflowAuthority(req: NextRequest, writing = false) {
  if (req.headers.has("authorization")) {
    const bearer = await requireBearer(req, { allowedKinds: ["workflow_mcp"] });
    if (bearer instanceof NextResponse) return bearer;
    if (bearer.teamId)
      return NextResponse.json(
        { error: "Workspace-scoped workflow key required" },
        { status: 403 },
      );
    return {
      workspaceId: bearer.workspaceId,
      human: false,
      actorId: bearer.apiKeyId,
    };
  }
  const session = await auth();
  if (!session?.user?.id)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get("workspaceId") ?? "";
  if (!UUID.test(workspaceId))
    return NextResponse.json(
      { error: "workspaceId is required" },
      { status: 400 },
    );
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (writing) {
    if (!["owner", "admin"].includes(membership.role))
      return NextResponse.json(
        { error: "Owner/admin required" },
        { status: 403 },
      );
    if (
      req.headers.get("origin") !==
      new URL(
        process.env.AGENTRAIL_PUBLIC_URL ||
          process.env.AUTH_URL ||
          req.nextUrl.origin,
      ).origin
    )
      return NextResponse.json(
        { error: "Same-origin request required" },
        { status: 403 },
      );
  }
  return { workspaceId, human: true, actorId: session.user.id };
}

export function workflowString(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= max &&
    !value.includes("\u0000")
  );
}
export async function workflowBody(
  req: NextRequest,
): Promise<Record<string, unknown> | null> {
  // Enforce the byte limit while streaming, before allocating/parsing a body.
  const reader = req.body?.getReader();
  if (!reader) return null;
  let bytes = 0;
  const parts: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16384) {
        await reader.cancel();
        return null;
      }
      parts.push(value);
    }
    const body = JSON.parse(Buffer.concat(parts).toString("utf8"));
    return body && typeof body === "object" && !Array.isArray(body)
      ? body
      : null;
  } catch {
    return null;
  }
}
export function workflowStartValid(body: Record<string, unknown>) {
  return (
    Object.keys(body).every((k) =>
      ["taskKey", "title", "agent", "repositoryId", "branch"].includes(k),
    ) &&
    workflowString(body.taskKey, 128) &&
    workflowString(body.title, 300) &&
    workflowString(body.agent, 100) &&
    typeof body.repositoryId === "string" &&
    UUID.test(body.repositoryId) &&
    workflowString(body.branch, 256)
  );
}
export function workflowUpdateValid(
  body: Record<string, unknown>,
  human: boolean,
) {
  if (
    !workflowString(body.eventKey, 128) ||
    !Number.isSafeInteger(body.expectedRevision) ||
    Number(body.expectedRevision) < 0
  )
    return false;
  if (human)
    return (
      Object.keys(body).every((k) =>
        ["eventKey", "expectedRevision", "decision"].includes(k),
      ) &&
      ["complete", "reopen", "release_check"].includes(String(body.decision))
    );
  if (
    !Object.keys(body).every((k) =>
      [
        "eventKey",
        "expectedRevision",
        "phase",
        "summary",
        "prUrl",
        "check",
        "checkReservation",
        "usage",
        "context",
      ].includes(k),
    )
  )
    return false;
  if (
    !PHASES.includes(String(body.phase)) ||
    !workflowString(body.summary, 4000)
  )
    return false;
  if (
    body.prUrl !== undefined &&
    (!workflowString(body.prUrl, 512) ||
      !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9][0-9]*$/.test(
        body.prUrl,
      ))
  )
    return false;
  const record = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const count = (value: unknown) =>
    value === null ||
    (Number.isSafeInteger(value) &&
      Number(value) >= 0 &&
      Number(value) <= 1e12);
  if (body.usage !== undefined) {
    const u = body.usage;
    if (
      !record(u) ||
      Object.keys(u).length !== 3 ||
      !Object.keys(u).every((k) =>
        ["inputTokens", "outputTokens", "costUsd"].includes(k),
      ) ||
      !count(u.inputTokens) ||
      !count(u.outputTokens) ||
      !(
        u.costUsd === null ||
        (typeof u.costUsd === "number" &&
          Number.isFinite(u.costUsd) &&
          u.costUsd >= 0 &&
          u.costUsd <= 1e9)
      )
    )
      return false;
  }
  if (body.context !== undefined) {
    const c = body.context;
    if (
      !record(c) ||
      Object.keys(c).length !== 4 ||
      !Object.keys(c).every((k) =>
        ["summary", "sources", "tokens", "windowTokens"].includes(k),
      ) ||
      !workflowString(c.summary, 1600) ||
      !Array.isArray(c.sources) ||
      c.sources.length > 12 ||
      !c.sources.every((v) => workflowString(v, 256)) ||
      !count(c.tokens) ||
      !(
        c.windowTokens === null ||
        (Number.isSafeInteger(c.windowTokens) &&
          Number(c.windowTokens) > 0 &&
          Number(c.windowTokens) <= 1e12)
      )
    )
      return false;
  }
  if (body.checkReservation !== undefined) {
    const reservation = body.checkReservation as Record<string, unknown> | null;
    if (
      !reservation ||
      typeof reservation !== "object" ||
      Object.keys(reservation).length !== 1 ||
      !workflowString(reservation.name, 100) ||
      body.phase !== "testing" ||
      body.check !== undefined
    )
      return false;
  }
  if (body.check !== undefined) {
    const c = body.check as Record<string, unknown> | null;
    if (
      !c ||
      typeof c !== "object" ||
      Array.isArray(c) ||
      !Object.keys(c).every((k) =>
        [
          "name",
          "passed",
          "exitCode",
          "outputSha256",
          "commitSha",
          "dirty",
        ].includes(k),
      ) ||
      !workflowString(c.name, 100) ||
      typeof c.passed !== "boolean" ||
      !Number.isSafeInteger(c.exitCode) ||
      Number(c.exitCode) < 0 ||
      Number(c.exitCode) > 255 ||
      c.passed !== (c.exitCode === 0) ||
      typeof c.commitSha !== "string" ||
      !/^[a-f0-9]{40}$/.test(c.commitSha) ||
      typeof c.dirty !== "boolean" ||
      typeof c.outputSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(c.outputSha256)
    )
      return false;
  }
  return true;
}
