import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  upsertConnector,
} from "@agentrail/db-postgres";

const ADMIN_ROLES = ["owner", "admin"] as const;

/**
 * Persist the Linear webhook SIGNING SECRET for a workspace (#1292) — the
 * store-side companion of the receiver at
 * `/api/v1/connectors/linear/webhook/[workspaceId]`. Mirrors how the GitHub
 * `/setup` "Create webhook" action persists ITS secret into
 * `connectors.config.webhookSecret` (`workspaces/[workspaceId]/connectors/github/
 * webhook`), so the receiver can HMAC-verify every delivery.
 *
 * WHY PASTED, NOT GENERATED (the one real difference from GitHub): GitHub lets us
 * generate a secret and hand it to GitHub when we create the hook. Linear instead
 * GENERATES the signing secret itself when a webhook is created (in Linear's
 * Settings → API → Webhooks, pointed at this workspace's receiver URL) and shows
 * it once — so there is nothing to generate here; the operator pastes Linear's
 * value and we store it. A null / empty body clears it (disables webhook intake
 * without touching the MCP API key — `upsertConnector` never writes the `secret`
 * column, only `config`).
 *
 * Body: `{ webhookSecret: string | null }`. Returns the receiver URL to configure
 * in Linear.
 */
function receiverUrl(request: NextRequest, workspaceId: string): string {
  return `${new URL(request.url).origin}/api/v1/connectors/linear/webhook/${workspaceId}`;
}

export async function PUT(
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
  if (!ADMIN_ROLES.includes(membership.role as (typeof ADMIN_ROLES)[number])) {
    return NextResponse.json(
      { error: "Owner or admin role required" },
      { status: 403 }
    );
  }

  let body: { webhookSecret?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const raw = body.webhookSecret;
  const url = receiverUrl(request, workspaceId);

  // null / empty → clear the stored webhook secret (webhook intake off).
  if (raw === null || raw === undefined || raw === "") {
    await upsertConnector(workspaceId, "linear", { config: { webhookSecret: undefined } });
    return NextResponse.json({ configured: false, url });
  }

  if (typeof raw !== "string") {
    return NextResponse.json(
      { error: "webhookSecret must be a string" },
      { status: 400 }
    );
  }
  const secret = raw.trim();
  if (secret.length === 0) {
    await upsertConnector(workspaceId, "linear", { config: { webhookSecret: undefined } });
    return NextResponse.json({ configured: false, url });
  }

  try {
    await upsertConnector(workspaceId, "linear", { config: { webhookSecret: secret } });
    return NextResponse.json({ configured: true, url });
  } catch (err) {
    console.error("[connectors/linear/webhook] failed to persist secret:", err);
    return NextResponse.json(
      { error: "Failed to save the Linear webhook secret" },
      { status: 500 }
    );
  }
}
