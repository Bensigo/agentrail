import { notFound } from "next/navigation";
import { getMembership, getSession } from "../../../../../lib/cached";
import { isConsoleChatEnabled } from "../../../../../lib/chat/feature-flags";
import { PageHeader } from "../../../../components/page-header";
import { ChatThread } from "./components/chat-thread";

/**
 * Console chat (#1288; redesign spec §4 Chat) — a workspace member's own
 * private thread with Jace, right from the dashboard. Gated behind
 * `CONSOLE_CHAT_ENABLED` (default OFF, `lib/chat/feature-flags.ts`): this
 * page 404s when the flag is off for the workspace, same posture as the
 * `/chat` API route it talks to — the surface simply doesn't exist until
 * rollout, matching the sidebar entry (`components/sidebar.tsx`) which also
 * only renders when this same flag is on.
 *
 * Auth mirrors the sibling workspace pages exactly (plain membership gate;
 * the workspace layout already guards session + membership, this re-checks
 * defensively — same idiom as `approvals/page.tsx`).
 *
 * Client-side polling (`ChatThread`), not a server-component DB read: unlike
 * most dashboard pages (Budget-page precedent — "no client fetch"), a live
 * conversation genuinely needs incremental updates without a manual
 * refresh, the same reasoning `runs/[runId]/page.tsx`'s event timeline
 * already established for this codebase.
 */
export default async function ChatPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  const session = await getSession();
  if (!session?.user?.id) return notFound();

  const membership = await getMembership(session.user.id, workspaceId);
  if (!membership) return notFound();

  if (!isConsoleChatEnabled(workspaceId)) return notFound();

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-4">
      <PageHeader title="Chat" subtitle="Talk to Jace right from the dashboard." />
      <ChatThread workspaceId={workspaceId} />
    </div>
  );
}
