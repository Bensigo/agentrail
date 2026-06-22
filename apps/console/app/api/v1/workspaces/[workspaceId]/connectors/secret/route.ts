import { randomBytes } from "crypto";
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
import {
  resolveTelegramChatId,
  sendTelegramWelcome,
  setTelegramWebhook,
} from "./telegram";

/**
 * Public base URL of this AgentRail server — the host Telegram must be able to
 * reach to POST inbound updates. `AGENTRAIL_SERVER_BASE_URL` is the established
 * public-base env (it also seeds the GitHub OAuth callback; see `.env.example`).
 * Returns "" when unset so the connect flow degrades gracefully (skips inbound
 * registration) rather than building a broken `undefined/...` webhook URL.
 */
function publicBaseUrl(): string {
  const raw =
    process.env["AGENTRAIL_SERVER_BASE_URL"] ||
    process.env["NEXTAUTH_URL"] ||
    (process.env["VERCEL_URL"] ? `https://${process.env["VERCEL_URL"]}` : "");
  return raw.replace(/\/+$/, "");
}

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

  // Telegram connect-time flow: chat id is optional. With no chat id, resolve
  // the user's direct-chat id from the bot's recent updates (they must have
  // messaged the bot first). Then send a one-time welcome so the user gets
  // immediate confirmation. A resolution/welcome failure is reported and the
  // credential is NOT stored (don't save a half-connected channel).
  let resolvedChatId = rawChatId;
  // Telegram inbound webhook secret (#889): generated per connect, stored in
  // config, passed to Telegram's setWebhook so it can be echoed + validated on
  // every inbound delivery.
  let webhookSecret: string | undefined;
  if (kind === "telegram") {
    const token = rawSecret.trim();
    if (!resolvedChatId) {
      const resolved = await resolveTelegramChatId(token);
      if (!resolved.ok) {
        return NextResponse.json({ error: resolved.error }, { status: 400 });
      }
      resolvedChatId = resolved.chatId;
    }
    const welcome = await sendTelegramWelcome(token, resolvedChatId);
    if (!welcome.ok) {
      return NextResponse.json({ error: welcome.error }, { status: 400 });
    }

    // Register the inbound webhook (#889). BEST-EFFORT: a setWebhook failure (or
    // an unset public base URL) only disables the inbound path — it must never
    // block saving the outbound channel. We surface a warning in the response.
    webhookSecret = randomBytes(32).toString("hex");
    const base = publicBaseUrl();
    if (base) {
      const webhookUrl = `${base}/api/v1/connectors/telegram/webhook/${workspaceId}`;
      const registered = await setTelegramWebhook(token, webhookUrl, webhookSecret);
      if (!registered.ok) {
        // Don't store a secret for a webhook Telegram won't actually call.
        webhookSecret = undefined;
        console.warn(
          "[connectors/secret] telegram setWebhook failed (inbound disabled):",
          registered.error
        );
      }
    } else {
      webhookSecret = undefined;
      console.warn(
        "[connectors/secret] AGENTRAIL_SERVER_BASE_URL unset — skipping telegram inbound webhook registration (outbound still connected)."
      );
    }
  }

  try {
    await setConnectorSecret(
      workspaceId,
      provider as ConnectorProvider,
      rawSecret.trim(),
      {
        chatId: kind === "telegram" ? resolvedChatId : undefined,
        webhookSecret: kind === "telegram" ? webhookSecret ?? null : undefined,
      }
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
