import { NextRequest, NextResponse } from "next/server";
import { appendJaceMessage } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";
import { isConsoleChatEnabled } from "../../../../../lib/chat/feature-flags";

const MAX_TEXT_LENGTH = 8000;

/**
 * POST /api/v1/runner/chat-reply   { workspaceId, conversationKey, text }
 *
 * Jace's console-chat WORKER SENDER (#1288 PR②) — the console-facing half of
 * `apps/jace/agent/channels/console.ts`'s `message.completed` handler.
 * Jace has no direct Postgres access (`apps/jace` is deliberately excluded
 * from this repo's pnpm workspace — see that channel file's own header
 * comment), so this is how its completed reply becomes a `jace_messages`
 * row: the SAME mechanism every other channel uses to deliver a reply, just
 * routed through an authenticated HTTP call back to the console instead of
 * an external platform API (Telegram/Discord/Slack post directly to their
 * own provider APIs; console chat has no such external API of its own).
 *
 * AUTH: the shared `JACE_CONSOLE_TOKEN` secret via `requireJaceConsoleSecret`
 * — the same central-secret seam every other Jace-coordinator route uses.
 * `workspaceId`/`conversationKey` are trusted directly from the body, unlike
 * `runner/workspace-memory`'s `eveSessionId` -> ledger indirection: this
 * route is never model- or caller-choosable — Jace's `console.ts` channel
 * only ever calls it with the exact values the console itself supplied
 * earlier in the SAME round trip (send -> channel_inbox -> hosted-inbound
 * `target` -> Eve session state -> here), so there is no attacker-controlled
 * input to resolve away.
 *
 * Also flag-gated (`isConsoleChatEnabled`): a reply for a workspace that has
 * since had the flag turned off is rejected rather than silently written —
 * this endpoint stays exactly as dark as the console's own `/chat` routes
 * when the feature is off.
 *
 * 400 — malformed body. 401 — bad/missing secret. 404 — flag off for this
 * workspace. 502 — the backing store errored. 200 — `{ ok: true }`.
 */
export async function POST(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) {
    return authError;
  }

  const body = (await request.json().catch(() => null)) as
    | { workspaceId?: unknown; conversationKey?: unknown; text?: unknown }
    | null;

  const workspaceId = typeof body?.workspaceId === "string" ? body.workspaceId.trim() : "";
  const conversationKey =
    typeof body?.conversationKey === "string" ? body.conversationKey.trim() : "";
  const text = typeof body?.text === "string" ? body.text.trim() : "";

  if (!workspaceId) {
    return NextResponse.json({ error: "workspaceId is required" }, { status: 400 });
  }
  if (!conversationKey) {
    return NextResponse.json({ error: "conversationKey is required" }, { status: 400 });
  }
  if (!text) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return NextResponse.json(
      { error: `text exceeds ${MAX_TEXT_LENGTH} characters` },
      { status: 400 }
    );
  }

  if (!isConsoleChatEnabled(workspaceId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    await appendJaceMessage({ workspaceId, conversationKey, role: "jace", text });
  } catch (err) {
    console.error("[runner/chat-reply] write failed:", err);
    return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
