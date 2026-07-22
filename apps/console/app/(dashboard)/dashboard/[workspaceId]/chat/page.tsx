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
 *
 * Full-bleed layout (owner-directed revision): every other dashboard page
 * renders inside the workspace layout's own `p-6` content wrapper
 * (`layout.tsx`) and simply flows with the page. Chat deliberately opts out
 * of that with `-m-6` (cancelling the wrapper's padding on all four sides)
 * plus `h-[calc(100vh-3rem)]` (subtracting exactly the layout's `h-12`
 * topbar) so the thread owns the ENTIRE remaining viewport — full width,
 * full height, no surrounding card — the same shape as ChatGPT/Claude's own
 * chat surface. The header row re-adds its own horizontal/top padding so
 * the title isn't flush against the edge; `ChatThread` below it is what
 * actually goes edge-to-edge (its own doc-comment covers the inner
 * max-width'd, centered message column that keeps prose readable without
 * the OUTER scroll region/composer being boxed in).
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
    <div className="-m-6 flex h-[calc(100vh-3rem)] flex-col">
      <div className="shrink-0 px-6 pt-5 pb-3">
        <PageHeader title="Chat" subtitle="Talk to Jace right from the dashboard." />
      </div>
      <ChatThread workspaceId={workspaceId} />
    </div>
  );
}
