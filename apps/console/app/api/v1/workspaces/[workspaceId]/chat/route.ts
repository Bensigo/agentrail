import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  appendJaceMessage,
  listJaceMessagesSince,
  enqueueChannelMessage,
} from "@agentrail/db-postgres";
import { dispatchQueuedChannelMessages } from "../../../../../../lib/channel-dispatch";
import { isConsoleChatEnabled } from "../../../../../../lib/chat/feature-flags";
import { consoleConversationKey } from "../../../../../../lib/chat/conversation-key";

const MAX_TEXT_LENGTH = 8000;

/**
 * GET  /api/v1/workspaces/:workspaceId/chat?after_seq=<n>
 * POST /api/v1/workspaces/:workspaceId/chat   { text }
 *
 * The console chat surface's one seam (#1288; redesign spec §4 Chat) — a
 * workspace member's own private thread with Jace (`console:<userId>:1`,
 * see `lib/chat/conversation-key.ts`). Gated behind `CONSOLE_CHAT_ENABLED`
 * (default OFF, `lib/chat/feature-flags.ts`): both verbs 404 when the flag
 * is off for this workspace, so the endpoint simply does not exist until
 * rollout — never a 403, which would leak "this feature exists but you
 * can't use it".
 *
 * POST writes the member's OWN message synchronously (so it renders before
 * Jace's turn even starts), then enqueues that same message into
 * `channel_inbox` (`channel: "console"`) and kicks the dispatcher —
 * mirroring the Telegram/Discord/Slack webhook routes' enqueue-then-kick
 * pattern exactly (see `lib/channel-dispatch.ts`'s `processConsoleRow`).
 * Jace's reply lands as a SEPARATE `jace_messages` row, written by
 * `POST /api/v1/runner/chat-reply` once the Eve turn completes — this route
 * never waits for it; the client discovers it by polling GET with
 * `after_seq` set to the highest `seq` it has already rendered.
 */
export async function GET(
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

  if (!isConsoleChatEnabled(workspaceId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const afterSeqParam = request.nextUrl.searchParams.get("after_seq");
  const parsedAfterSeq =
    afterSeqParam !== null && afterSeqParam !== "" ? parseInt(afterSeqParam, 10) : 0;
  const afterSeq = Number.isFinite(parsedAfterSeq) ? parsedAfterSeq : 0;

  const conversationKey = consoleConversationKey(session.user.id);
  const messages = await listJaceMessagesSince(workspaceId, conversationKey, afterSeq);

  return NextResponse.json({
    messages: messages.map((m) => ({
      id: m.id,
      seq: m.seq,
      role: m.role,
      text: m.text,
      created_at: m.createdAt.toISOString(),
    })),
  });
}

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

  if (!isConsoleChatEnabled(workspaceId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as { text?: string };
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return NextResponse.json(
      { error: `text exceeds ${MAX_TEXT_LENGTH} characters` },
      { status: 400 }
    );
  }

  const conversationKey = consoleConversationKey(session.user.id);

  // Written synchronously so the member's OWN message renders immediately —
  // before Jace's turn even starts, let alone completes.
  const message = await appendJaceMessage({
    workspaceId,
    conversationKey,
    role: "user",
    text,
  });

  await enqueueChannelMessage({
    workspaceId,
    channel: "console",
    conversationKey,
    kind: "message",
    senderId: session.user.id,
    senderDisplay: session.user.name ?? "",
    providerMessageId: randomUUID(),
    payload: { text },
  });

  // Fire-and-forget kick (mirrors every channel webhook route's own
  // enqueue-then-kick — see lib/channel-dispatch.ts's header comment): a
  // drain failure is the dispatcher's problem, never this request's.
  void dispatchQueuedChannelMessages().catch((err) => {
    console.error("[chat/send] dispatch kick failed:", err);
  });

  return NextResponse.json(
    {
      message: {
        id: message.id,
        seq: message.seq,
        role: message.role,
        text: message.text,
        created_at: message.createdAt.toISOString(),
      },
    },
    { status: 201 }
  );
}
