import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  createAcceptanceBuilderHandoff,
  getRepositoryByName,
  getWorkspaceMembership,
  readAcceptanceContextPacks,
  readChangeRecordTimeline,
} from "@agentrail/db-postgres";

const BUILDER = /^[a-z][a-z0-9_-]{0,63}$/;
const TASK_CONTEXT = /^[^\s][\s\S]{0,255}$/;

function branchName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const branch = value.trim();
  if (!branch || branch.length > 255 || branch.startsWith("/") || branch.endsWith("/") || branch.includes("//") || branch.includes("..") || branch.endsWith(".lock") || /[\x00-\x20~^:?*\\[\\]/.test(branch)) return null;
  return branch;
}

/**
 * A human records the selected builder route before implementation. This is
 * intentionally not an agent-writable shortcut: a later GitHub webhook can
 * correlate only this exact repository/branch/task-context triple.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; recordId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { workspaceId, recordId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (membership.role !== "owner" && membership.role !== "admin") {
    return NextResponse.json({ error: "Only workspace owners or admins can select an external builder" }, { status: 403 });
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const builder = typeof body.builder === "string" ? body.builder.trim().toLowerCase() : "";
  const taskContextKey = typeof body.taskContextKey === "string" ? body.taskContextKey.trim() : "";
  const repo = typeof body.repo === "string" ? body.repo.trim() : "";
  const branch = branchName(body.branchName);
  const contractId = typeof body.contractId === "string" ? body.contractId : "";
  const contractVersion = body.contractVersion;
  const contextPackId = typeof body.contextPackId === "string" ? body.contextPackId : "";
  if (!BUILDER.test(builder) || !TASK_CONTEXT.test(taskContextKey) || !repo || !branch || !contractId || !Number.isInteger(contractVersion) || (contractVersion as number) < 1 || !contextPackId) {
    return NextResponse.json({ error: "builder, taskContextKey, repo, safe branchName, contractId, positive contractVersion, and contextPackId are required" }, { status: 400 });
  }
  const record = await readChangeRecordTimeline({ workspaceId, recordId });
  if (!record) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (record.record.repo !== repo) return NextResponse.json({ error: "Builder repository must match the Acceptance Record repository" }, { status: 409 });
  const [repository, packs] = await Promise.all([
    getRepositoryByName(workspaceId, repo),
    readAcceptanceContextPacks({ workspaceId, recordId }),
  ]);
  if (!repository) return NextResponse.json({ error: "Repository not found" }, { status: 404 });
  if (!packs?.some((pack) => pack.id === contextPackId)) return NextResponse.json({ error: "Context Pack not found for Acceptance Record" }, { status: 409 });
  try {
    const result = await createAcceptanceBuilderHandoff({
      workspaceId, recordId, repositoryId: repository.id, builder, taskContextKey,
      branchName: branch, contractId, contractVersion: contractVersion as number,
      contextPackId, createdBy: `user:${session.user.id}`,
    });
    const { handoff } = result;
    return NextResponse.json({
      handoff: {
        id: handoff.id, builder: handoff.builder, taskContextKey: handoff.taskContextKey,
        branchName: handoff.branchName, acceptanceContractId: handoff.acceptanceContractId,
        acceptanceContractVersion: handoff.acceptanceContractVersion, contextPackId: handoff.contextPackId,
        status: handoff.status, createdAt: handoff.createdAt.toISOString(),
      },
      inserted: result.inserted,
    }, { status: result.inserted ? 201 : 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create builder handoff";
    return NextResponse.json({ error: message }, { status: message.includes("already bound") ? 409 : 500 });
  }
}
