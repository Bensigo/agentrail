import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  setDiscordWebhookUrl,
  upsertConnector,
} from "@agentrail/db-postgres";

/**
 * Manage the Discord notify connector (M038, AC3). A workspace owner/admin
 * connects Discord by saving a channel webhook URL, or disconnects by clearing
 * it. The webhook is write-only here: the read model (GET ../connectors) only
 * ever returns a masked target, never the secret token.
 *
 * A **Connector** (CONTEXT.md) is the two-way seam between an external tool and
 * the Issue Queue; Discord is the *notify* half — it posts run completion and
 * escalation-to-human notifications to this channel (agentrail/connectors/discord.py).
 */
function isDiscordWebhook(url: string): boolean {
  // Accept the canonical Discord webhook host only — a real, falsifiable check
  // (no arbitrary URL that would never deliver). discord.com / discordapp.com,
  // https, under /api/webhooks/.
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    const okHost =
      host === "discord.com" ||
      host === "discordapp.com" ||
      host === "ptb.discord.com" ||
      host === "canary.discord.com";
    return okHost && u.pathname.includes("/api/webhooks/");
  } catch {
    return false;
  }
}

const CHANNEL_PROBE_TIMEOUT_MS = 8000;

/**
 * Resolve the target channel id from a Discord incoming webhook URL (best-effort,
 * unauthenticated `GET /webhooks/{id}/{token}`). A webhook URL alone carries no
 * channel id, but Jace's native Discord channel needs one for proactive
 * `receive` targets (#1050) — this is the only place that id can come from
 * without a new form field. A probe failure returns undefined so the caller can
 * still save the webhook (legacy notify keeps working; the Jace-native path just
 * stays a documented no-op until a later reconnect resolves it).
 */
async function resolveDiscordChannelId(
  webhookUrl: string
): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHANNEL_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(webhookUrl, { signal: controller.signal });
    if (!res.ok) return undefined;
    const body = (await res.json().catch(() => ({}))) as {
      channel_id?: unknown;
    };
    return typeof body.channel_id === "string" ? body.channel_id : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
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
  if (membership.role !== "owner" && membership.role !== "admin") {
    return NextResponse.json(
      { error: "Only an owner or admin can manage connectors" },
      { status: 403 }
    );
  }

  let body: { webhookUrl?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const raw = body.webhookUrl;
  // null / empty → disconnect.
  if (raw === null || raw === undefined || raw === "") {
    await setDiscordWebhookUrl(workspaceId, null);
    // Self-configure: disconnecting disables the discord connector row.
    try {
      await upsertConnector(workspaceId, "discord", { enabled: false });
    } catch (err) {
      console.error("[connectors/discord] failed to disable connector:", err);
    }
    return NextResponse.json({ connected: false });
  }
  if (typeof raw !== "string" || !isDiscordWebhook(raw)) {
    return NextResponse.json(
      { error: "Provide a valid Discord channel webhook URL" },
      { status: 400 }
    );
  }

  try {
    await setDiscordWebhookUrl(workspaceId, raw);
    // Self-configure on connect: upsert an enabled discord connector row with
    // default trigger config. Best-effort — never fail the webhook save on it.
    try {
      const channelId = await resolveDiscordChannelId(raw);
      await upsertConnector(
        workspaceId,
        "discord",
        channelId ? { enabled: true, config: { channelId } } : { enabled: true }
      );
    } catch (err) {
      console.error("[connectors/discord] failed to enable connector:", err);
    }
    return NextResponse.json({ connected: true });
  } catch (err) {
    console.error("[connectors/discord] failed to save webhook:", err);
    return NextResponse.json(
      { error: "Failed to save Discord webhook" },
      { status: 500 }
    );
  }
}
