import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  setConnectorSecret,
  type ConnectorProvider,
} from "@agentrail/db-postgres";
import {
  validateConnectorCredential,
  type ConnectorKind,
} from "../../../../../../../app/(dashboard)/dashboard/[workspaceId]/connectors/components/connector-helpers";
import { verifyConnectorCredential } from "./verify";

/**
 * Credential-based connector management (M038 catalog expansion). A workspace
 * owner/admin connects an **MCP** tool (Linear, Figma, Context7) or a **gateway**
 * channel that authenticates with a token (Slack incoming webhook, Telegram bot)
 * by saving its credential, or disconnects by clearing it. The credential is
 * write-only: it is stored in `connectors.secret` and NEVER returned to the
 * client — the read model (GET ../connectors) exposes only a `hasSecret`-derived
 * status. Discord keeps its dedicated webhook route; GitHub is OAuth (no secret).
 *
 * Body: `{ provider, secret, chatId? }`. A null / empty `secret` disconnects.
 */

/** Providers this route manages — the credential-based ones only. */
const CREDENTIAL_PROVIDERS = new Set<ConnectorProvider>([
  "linear",
  "figma",
  "context7",
  "slack",
  "telegram",
]);

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
  if (membership.role !== "owner" && membership.role !== "admin") {
    return NextResponse.json(
      { error: "Only an owner or admin can manage connectors" },
      { status: 403 }
    );
  }

  let body: { provider?: unknown; secret?: unknown; chatId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const provider = body.provider;
  if (
    typeof provider !== "string" ||
    !CREDENTIAL_PROVIDERS.has(provider as ConnectorProvider)
  ) {
    return NextResponse.json(
      { error: "provider must be one of linear, figma, context7, slack, telegram" },
      { status: 400 }
    );
  }
  const kind = provider as ConnectorKind;

  const rawSecret = body.secret;
  const rawChatId =
    typeof body.chatId === "string" ? body.chatId.trim() : undefined;

  // null / empty → disconnect (clear the stored credential, disable the row).
  if (rawSecret === null || rawSecret === undefined || rawSecret === "") {
    try {
      await setConnectorSecret(workspaceId, provider as ConnectorProvider, null);
      return NextResponse.json({ connected: false });
    } catch (err) {
      console.error("[connectors/secret] failed to disconnect:", err);
      return NextResponse.json(
        { error: "Failed to disconnect connector" },
        { status: 500 }
      );
    }
  }

  if (typeof rawSecret !== "string") {
    return NextResponse.json(
      { error: "secret must be a string" },
      { status: 400 }
    );
  }

  // Gate 1 (cheap): the credential must have the upstream's true shape.
  const check = validateConnectorCredential(kind, rawSecret, rawChatId);
  if (!check.ok) {
    return NextResponse.json({ error: check.error }, { status: 400 });
  }

  // Gate 2 (real): the provider must actually accept the credential, so a
  // well-formed-but-wrong key is rejected before we ever store it.
  const verified = await verifyConnectorCredential(kind, rawSecret, rawChatId);
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error }, { status: 400 });
  }

  try {
    await setConnectorSecret(
      workspaceId,
      provider as ConnectorProvider,
      rawSecret.trim(),
      { chatId: kind === "telegram" ? rawChatId : undefined }
    );
    return NextResponse.json({ connected: true });
  } catch (err) {
    console.error("[connectors/secret] failed to save credential:", err);
    return NextResponse.json(
      { error: "Failed to save connector credential" },
      { status: 500 }
    );
  }
}
