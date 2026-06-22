import { NextRequest, NextResponse } from "next/server";
import {
  getConnector,
  getConnectorSecret,
  listQueueEntries,
} from "@agentrail/db-postgres";
import { decideReply } from "../handler";
import { sendTelegramMessage } from "../../../../workspaces/[workspaceId]/connectors/secret/telegram";

/**
 * Inbound Telegram webhook (#889) — the two-way half of the Telegram gateway.
 *
 * Telegram is configured per-bot (on connect, via `setWebhook`) to POST updates
 * to `/api/v1/connectors/telegram/webhook/<workspaceId>`. Mirrors the GitHub
 * webhook route's shape: parse defensively, authenticate, do the work, and never
 * 500 on a bad payload.
 *
 * AUTH + WORKSPACE IDENTIFICATION:
 *   - The workspace is the URL path param (`[workspaceId]`).
 *   - Telegram echoes the per-workspace `secret_token` we set at connect time in
 *     the `X-Telegram-Bot-Api-Secret-Token` header. We compare it against the
 *     secret stored in that workspace's telegram connector config
 *     (`config.webhookSecret`). A missing/mismatched header → 200 OK and ignore
 *     (no work, no leak). Combined with the chat-id check in `decideReply`, a
 *     request can neither act on a workspace it doesn't own nor read another
 *     chat's queue.
 *
 * BEST-EFFORT + ISOLATED: a malformed update must NEVER 500 (AC5) — we return
 * 200 and do nothing. The reply send is best-effort too.
 */

const SECRET_HEADER = "x-telegram-bot-api-secret-token";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  // Always 200 so Telegram doesn't retry/disable the webhook on our errors; the
  // body just says what we did. We never throw out of this handler.
  try {
    const { workspaceId } = await params;

    const connector = await getConnector(workspaceId, "telegram");
    // Not connected / disabled / no inbound secret configured → ignore quietly.
    const expectedSecret = connector?.config.webhookSecret;
    if (!connector || !connector.enabled || !expectedSecret) {
      return NextResponse.json({ ignored: "telegram not connected" });
    }

    // Authenticate the delivery against the stored per-workspace secret token.
    const provided = request.headers.get(SECRET_HEADER);
    if (!provided || provided !== expectedSecret) {
      return NextResponse.json({ ignored: "bad secret token" });
    }

    // Parse defensively — a malformed body is a silent no-op (AC5).
    const update = (await request.json().catch(() => null)) as unknown;

    // The pure decision needs the connected chat id + a queue snapshot. Pull the
    // full snapshot (active + recent terminals) so `/status` can report counts.
    const chatId = connector.config.chatId;
    const snapshot = await listQueueEntries(workspaceId, { activeOnly: false });

    const reply = decideReply(
      update as Parameters<typeof decideReply>[0],
      chatId,
      snapshot
    );
    if (!reply) {
      return NextResponse.json({ ok: true, replied: false });
    }

    // Send the reply best-effort. chatId is guaranteed non-empty here because
    // decideReply only returns a reply when the incoming chat matched it.
    const token = await getConnectorSecret(workspaceId, "telegram");
    if (token && chatId) {
      await sendTelegramMessage(token, chatId, reply);
    }
    return NextResponse.json({ ok: true, replied: true });
  } catch {
    // Never surface a 500 to Telegram — that would make it retry/disable us.
    return NextResponse.json({ ok: true, replied: false });
  }
}
