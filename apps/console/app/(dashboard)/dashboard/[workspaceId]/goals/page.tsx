import { notFound } from "next/navigation";
import { Target } from "lucide-react";
import { isGoalLoopEnabled, listGoalsForWorkspace } from "@agentrail/db-postgres";
import { getMembership, getSession } from "../../../../../lib/cached";
import { PageHeader } from "../../../../components/page-header";
import { EmptyState } from "../../../../components/empty-state";
import { ActiveGoalCard } from "./components/active-goal-card";
import { DoneGoalCard } from "./components/done-goal-card";

/**
 * Workspace Goals page (#1289 AC2 — deferred from the goal-loop backend PR,
 * `docs/prd/jace-goal-loop.md`): the console's only view of what Jace is
 * pursuing for this workspace, and how each past goal ended. A server
 * component reading the query layer directly (Budget-page precedent,
 * `budget/page.tsx`'s own doc-comment: "no client fetch, no new API route").
 *
 * Auth mirrors the sibling workspace pages exactly (plain membership gate):
 * the workspace layout already guards session + membership, this re-checks
 * defensively.
 *
 * Flag-gated behind `isGoalLoopEnabled` (workspace column `jaceGoalLoop`,
 * default OFF): this page 404s when the flag is off for the workspace, same
 * posture as the console-chat page's `isConsoleChatEnabled` gate
 * (`chat/page.tsx`) — the surface simply doesn't exist until rollout,
 * matching the sidebar entry (`components/sidebar.tsx`) which also only
 * renders when this same flag is on (computed once in the workspace layout
 * and threaded down, same wiring as `chatEnabled`).
 */
export default async function GoalsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  const session = await getSession();
  if (!session?.user?.id) return notFound();

  const membership = await getMembership(session.user.id, workspaceId);
  if (!membership) return notFound();

  if (!(await isGoalLoopEnabled(workspaceId))) return notFound();

  const { active, done } = await listGoalsForWorkspace(workspaceId);

  if (active.length === 0 && done.length === 0) {
    return (
      <div className="mx-auto max-w-[1440px]">
        <PageHeader
          title="Goals"
          subtitle="What Jace is pursuing for this workspace, and how each one ended."
        />
        <EmptyState
          icon={Target}
          title="No goals yet"
          description="A goal is set from a chat with Jace — state an objective and it pursues it, bounded by a leash, until the check is met or it needs you."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1440px]">
      <PageHeader
        title="Goals"
        subtitle="What Jace is pursuing for this workspace, and how each one ended."
      />

      <div className="flex flex-col gap-6">
        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-normal uppercase tracking-wide text-[var(--gray-09)]">
            Active ({active.length})
          </h2>
          {active.length === 0 ? (
            <p className="text-xs text-[var(--gray-09)]">No active goals right now.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {active.map((goal) => (
                <ActiveGoalCard key={goal.id} goal={goal} />
              ))}
            </div>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-normal uppercase tracking-wide text-[var(--gray-09)]">
            Done ({done.length})
          </h2>
          {done.length === 0 ? (
            <p className="text-xs text-[var(--gray-09)]">No goals have finished yet.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {done.map((goal) => (
                <DoneGoalCard key={goal.id} goal={goal} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
