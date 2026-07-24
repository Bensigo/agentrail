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
 * Credential-based connector management (M038 catalog expansion; Gateway →
 * Channels cutover). A workspace owner/admin connects an **MCP** tool (Linear,
 * Figma, Context7) by saving its credential, or disconnects by clearing it.
 * The credential is write-only: it is stored in `connectors.secret` and NEVER
 * returned to the client — the read model (GET ../connectors) exposes only a
 * `hasSecret`-derived status. GitHub is OAuth (no secret). Discord, Slack and
 * Telegram are Jace-native chat channels: none of them has a credential to
 * paste — connecting is DMing the shared Jace bot, recorded as a
 * `chat_identities` row (read by GET ../connectors), not a secret written
 * here — so none of the three is in this route's allowlist. Discord's former
 * dedicated webhook route is deleted for the same reason.
 *
 * Body: `{ provider, secret }`. A null / empty `secret` disconnects.
 */

/** Providers this route manages — the credential-based ones only. */
const CREDENTIAL_PROVIDERS = new Set<ConnectorProvider>([
  "linear",
  "figma",
  "context7",
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

  let body: { provider?: unknown; secret?: unknown };
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
      { error: "provider must be one of linear, figma, context7" },
      { status: 400 }
    );
  }
  const kind = provider as ConnectorKind;

  const rawSecret = body.secret;

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
  const check = validateConnectorCredential(kind, rawSecret);
  if (!check.ok) {
    return NextResponse.json({ error: check.error }, { status: 400 });
  }

  // Gate 2 (real): the provider must actually accept the credential, so a
  // well-formed-but-wrong key is rejected before we ever store it.
  const verified = await verifyConnectorCredential(kind, rawSecret);
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error }, { status: 400 });
  }

  try {
    await setConnectorSecret(workspaceId, provider as ConnectorProvider, rawSecret.trim());
    return NextResponse.json({ connected: true });
  } catch (err) {
    console.error("[connectors/secret] failed to save credential:", err);
    return NextResponse.json(
      { error: "Failed to save connector credential" },
      { status: 500 }
    );
  }
}
