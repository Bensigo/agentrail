import { NextRequest, NextResponse } from "next/server";
import { acknowledgeEvidenceReviewCorrectionDelivery } from "@agentrail/db-postgres";
import { requireAgentMcpWorkspace } from "@/lib/agent-mcp-auth";

/** The builder, not a best-effort gateway, proves it received the correction. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; deliveryId: string }> }
) {
  const { workspaceId, deliveryId } = await params;
  const authorization = await requireAgentMcpWorkspace(request, workspaceId, "acceptance:correction:ack");
  if (authorization instanceof NextResponse) return authorization;
  const body = await request.json().catch(() => ({})) as { detail?: unknown };
  const detail = typeof body.detail === "string" ? body.detail.trim() : null;
  const delivery = await acknowledgeEvidenceReviewCorrectionDelivery({ workspaceId, deliveryId, detail });
  if (!delivery) return NextResponse.json({ error: "Delivery not found or already acknowledged" }, { status: 404 });
  return NextResponse.json({ delivery: { id: delivery.id, outcome: delivery.outcome, confirmedAt: delivery.confirmedAt?.toISOString() ?? null } });
}
