import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import { rotateTelegramWebhookSecret } from "../rotate-telegram";

/**
 * Rotate a workspace's Telegram inbound webhook secret (#1031).
 *
 * POST /api/v1/workspaces/<workspaceId>/connectors/secret/rotate
 * Body: `{ provider: "telegram" }`.
 *
 * Regenerates the per-workspace `webhookSecret` and re-registers the webhook via
 * the existing connect-time `setWebhook` machinery (see `rotateTelegramWebhookSecret`),
 * best-effort/graceful exactly as at connect. Owner/admin only — same gate as the
 * connect route (PUT ../secret). The bot token is never re-collected or returned;
 * the encrypted credential is untouched.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (membership.role !== "owner" && membership.role !== "admin") {
    return NextResponse.json(
      { error: "Only an owner or admin can manage connectors" },
      { status: 403 }
    );
  }

  let body: { provider?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Only telegram has an inbound webhook secret to rotate today.
  if (body.provider !== "telegram") {
    return NextResponse.json(
      { error: "provider must be telegram" },
      { status: 400 }
    );
  }

  const result = await rotateTelegramWebhookSecret(workspaceId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  // Never return the new secret to the client — it is echoed only by Telegram.
  return NextResponse.json({ rotated: true });
}
