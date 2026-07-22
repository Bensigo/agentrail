import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  listConsoleChatThreads,
} from "@agentrail/db-postgres";
import { isConsoleChatEnabled } from "../../../../../../../lib/chat/feature-flags";

/**
 * GET /api/v1/workspaces/:workspaceId/chat/threads
 *
 * This member's own console chat threads (#1288 sessions + history UI) —
 * powers the header's history panel and the ＋/"New chat" affordance's
 * "next n" computation. A thread is a distinct `n` in this member's
 * `console:<userId>:<n>` conversation-key family, DERIVED from the
 * `jace_messages` rows that already exist (no new table, no migration — see
 * `listConsoleChatThreads`'s own doc-comment). An empty, never-messaged
 * thread is purely client-side until its first send materializes a row, so it
 * legitimately isn't here yet (matches ChatGPT's history).
 *
 * Auth mirrors the sibling `../chat/route.ts` exactly: `auth()` -> 401,
 * `getWorkspaceMembership` -> 403, `isConsoleChatEnabled` -> 404 (the endpoint
 * simply does not exist until rollout — never 403, which would leak that the
 * feature exists). The thread scope is derived from the SERVER session's own
 * `session.user.id`, NEVER a client param — a member can only ever list their
 * own threads (no IDOR), the same posture the chat route uses.
 *
 * Wire fields are snake_case (`last_message_at`, `message_count`) — every
 * console route's JSON convention; the DB layer's camelCase is mapped here.
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

  const threads = await listConsoleChatThreads(workspaceId, session.user.id);

  return NextResponse.json({
    threads: threads.map((t) => ({
      n: t.n,
      title: t.title,
      last_message_at: t.lastMessageAt.toISOString(),
      message_count: t.messageCount,
    })),
  });
}
