import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  enqueueAcceptanceContextPackCompilation,
  getRepositoryByName,
  getWorkspaceMembership,
  readChangeRecordTimeline,
} from "@agentrail/db-postgres";

const PHASES = new Set(["plan", "execute", "verify", "review"]);

/**
 * Queues compilation of a bounded Acceptance Context Pack. This is a human
 * admission step, not a caller-supplied pack upload and not a builder handoff:
 * the worker must later claim this exact confirmed-contract/repository binding.
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
    return NextResponse.json({ error: "Only workspace owners or admins can request Context Pack compilation" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const contractId = typeof body.contractId === "string" ? body.contractId.trim() : "";
  const contractVersion = body.contractVersion;
  const phase = typeof body.phase === "string" ? body.phase : "";
  if (!contractId || !Number.isInteger(contractVersion) || (contractVersion as number) < 1 || !PHASES.has(phase)) {
    return NextResponse.json({ error: "contractId, positive contractVersion, and a valid phase are required" }, { status: 400 });
  }

  const record = await readChangeRecordTimeline({ workspaceId, recordId });
  if (!record) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const repository = await getRepositoryByName(workspaceId, record.record.repo);
  if (!repository) return NextResponse.json({ error: "Repository not found" }, { status: 404 });

  try {
    const result = await enqueueAcceptanceContextPackCompilation({
      workspaceId,
      recordId,
      repositoryId: repository.id,
      contractId,
      contractVersion: contractVersion as number,
      phase: phase as "plan" | "execute" | "verify" | "review",
      createdBy: `user:${session.user.id}`,
    });
    return NextResponse.json({
      compilation: {
        id: result.compilation.id,
        acceptanceContractId: result.compilation.acceptanceContractId,
        acceptanceContractVersion: result.compilation.acceptanceContractVersion,
        phase: result.compilation.phase,
        status: result.compilation.status,
        createdAt: result.compilation.createdAt.toISOString(),
      },
      inserted: result.inserted,
    }, { status: result.inserted ? 201 : 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to queue Context Pack compilation";
    return NextResponse.json({ error: message }, { status: message.includes("confirmed") || message.includes("bound") ? 409 : 500 });
  }
}
