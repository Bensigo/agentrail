import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  queueEvidenceReviewCorrectionDelivery,
  readChangeRecordTimeline,
} from "@agentrail/db-postgres";

type DeliveryChannel = "mcp_task_context" | "github_pull_request" | "jace_task_inbox";
const channels = new Set<DeliveryChannel>(["mcp_task_context", "github_pull_request", "jace_task_inbox"]);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

function targetFor(channel: DeliveryChannel, value: unknown, recordId: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const target = value as Record<string, unknown>;
  if (channel === "mcp_task_context") {
    return nonempty(target.builder) && nonempty(target.taskContextKey) ? { builder: target.builder.trim(), taskContextKey: target.taskContextKey.trim() } : null;
  }
  if (channel === "github_pull_request") {
    return nonempty(target.repo) && Number.isSafeInteger(target.prNumber) && (target.prNumber as number) > 0 ? { repo: target.repo.trim(), prNumber: target.prNumber } : null;
  }
  return target.recordId === recordId ? { recordId } : null;
}

/** Queue an evidence-bound correction without confusing persistence with delivery. */
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
    return NextResponse.json({ error: "Only workspace owners or admins can queue correction delivery" }, { status: 403 });
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const correctionId = typeof body.correctionId === "string" ? body.correctionId : "";
  const deliveryKey = typeof body.deliveryKey === "string" ? body.deliveryKey.trim() : "";
  const channel = typeof body.channel === "string" ? body.channel : "";
  if (!correctionId || !deliveryKey || deliveryKey.length > 200 || !channels.has(channel as DeliveryChannel)) {
    return NextResponse.json({ error: "correctionId, deliveryKey, and a supported channel are required" }, { status: 400 });
  }
  const target = targetFor(channel as DeliveryChannel, body.target, recordId);
  if (!target) return NextResponse.json({ error: "delivery target does not match its channel or Acceptance Record" }, { status: 400 });
  if (!(await readChangeRecordTimeline({ workspaceId, recordId }))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const result = await queueEvidenceReviewCorrectionDelivery({
      workspaceId, recordId, correctionId, deliveryKey, channel, target,
    });
    return NextResponse.json({
      delivery: { id: result.id, channel, target, reviewRevisionId: result.reviewRevisionId, outcome: "queued" },
    }, { status: result.inserted ? 201 : 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to queue correction delivery";
    return NextResponse.json({ error: message }, { status: message.includes("not found") ? 404 : 409 });
  }
}
