import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  isCommit,
  RELEASE_CHECK_NAME,
  releaseUrlValid,
} from "@agentrail/db-postgres";
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
export async function workflowAuthority(
  req: NextRequest,
  writing = false,
  admitVerifier = false,
) {
  if (req.headers.has("authorization")) {
    const bearer = await requireBearer(req, {
      allowedKinds: admitVerifier
        ? ["workflow_mcp", "workflow_release"]
        : ["workflow_mcp"],
    });
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
      releaseVerifier: bearer.kind === "workflow_release",
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
  return {
    workspaceId,
    human: true,
    actorId: session.user.id,
    releaseVerifier: false,
  };
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
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function githubLink(value: unknown, kind: "pull" | "issues") {
  return (
    workflowString(value, 512) &&
    new RegExp(
      `^https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/${kind}/[1-9][0-9]*$`,
    ).test(value)
  );
}

function deliveryStartValid(value: unknown) {
  return (
    record(value) &&
    Object.keys(value).every((key) =>
      ["kind", "endpoint", "brief", "prUrl"].includes(key),
    ) &&
    (value.kind === "feature" || value.kind === "fix" || value.kind === "pr") &&
    (value.endpoint === "review" || value.endpoint === "release") &&
    workflowString(value.brief, 3000) &&
    (value.kind === "pr"
      ? githubLink(value.prUrl, "pull")
      : value.prUrl === undefined)
  );
}

function checkpointValid(value: unknown) {
  if (!record(value)) return false;
  switch (value.step) {
    case "ready":
      return (
        Object.keys(value).every((key) =>
          ["step", "criteria", "planPath", "issueUrl"].includes(key),
        ) &&
        Array.isArray(value.criteria) &&
        value.criteria.length >= 1 &&
        value.criteria.length <= 8 &&
        value.criteria.every((item) => workflowString(item, 400)) &&
        (value.issueUrl === undefined ||
          githubLink(value.issueUrl, "issues")) &&
        (value.planPath === undefined ||
          (workflowString(value.planPath, 256) &&
            value.planPath.endsWith(".md") &&
            !/^[A-Za-z]:|[\\\x00-\x1f]/.test(value.planPath) &&
            !value.planPath
              .split("/")
              .some((part) => !part || part === "." || part === "..")))
      );
    case "review":
      return Object.keys(value).length === 2 && isCommit(value.headSha);
    case "release":
      return (
        Object.keys(value).length === 3 &&
        isCommit(value.commitSha) &&
        releaseUrlValid(value.targetUrl)
      );
    case "follow_up":
      return (
        Object.keys(value).every((key) => ["step", "issueUrl"].includes(key)) &&
        (value.issueUrl === undefined || githubLink(value.issueUrl, "issues"))
      );
    case "ship":
    case "rework":
      return Object.keys(value).length === 1;
    default:
      return false;
  }
}

export function workflowStartValid(body: Record<string, unknown>) {
  return (
    Object.keys(body).every((k) =>
      [
        "taskKey",
        "title",
        "agent",
        "repositoryId",
        "branch",
        "delivery",
      ].includes(k),
    ) &&
    workflowString(body.taskKey, 128) &&
    workflowString(body.title, 300) &&
    workflowString(body.agent, 100) &&
    typeof body.repositoryId === "string" &&
    UUID.test(body.repositoryId) &&
    workflowString(body.branch, 256) &&
    (body.delivery === undefined || deliveryStartValid(body.delivery))
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
        "checkpoint",
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
  if (body.prUrl !== undefined && !githubLink(body.prUrl, "pull")) return false;
  if (
    body.checkpoint !== undefined &&
    (!checkpointValid(body.checkpoint) ||
      body.check !== undefined ||
      body.checkReservation !== undefined)
  )
    return false;
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
          "releaseUrl",
        ].includes(k),
      ) ||
      !workflowString(c.name, 100) ||
      typeof c.passed !== "boolean" ||
      !Number.isSafeInteger(c.exitCode) ||
      Number(c.exitCode) < 0 ||
      Number(c.exitCode) > 255 ||
      c.passed !== (c.exitCode === 0) ||
      !isCommit(c.commitSha) ||
      (c.name === RELEASE_CHECK_NAME && c.passed === true
        ? !releaseUrlValid(c.releaseUrl)
        : c.releaseUrl !== undefined) ||
      typeof c.dirty !== "boolean" ||
      typeof c.outputSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(c.outputSha256)
    )
      return false;
  }
  return true;
}
