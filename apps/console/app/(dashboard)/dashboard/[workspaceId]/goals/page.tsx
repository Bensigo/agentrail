import Link from "next/link";
import { notFound } from "next/navigation";
import { GitBranch, Target } from "lucide-react";
import { isGoalLoopEnabled, listGoalsForWorkspace, listWorkspaceRepositories } from "@agentrail/db-postgres";
import { getMembership, getSession } from "../../../../../lib/cached";
import { PageHeader } from "../../../../components/page-header";
import { EmptyState } from "../../../../components/empty-state";
import { ActiveGoalCard } from "./components/active-goal-card";
import { DoneGoalCard } from "./components/done-goal-card";
import { NewGoalButton } from "./components/new-goal-button";

const ADMIN_ROLES = ["owner", "admin"] as const;

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
 *
 * "New goal" (#1289 AC — the goal loop shipped with no way for a HUMAN to
 * start one from the console): a goal is REQUIRED to be tied to a
 * repository (v1 is single-repo per goal, `schema/goals.ts`'s own comment),
 * so this page loads `listWorkspaceRepositories` alongside the goals view
 * and enforces "connect a repo first" in the UI — a zero-repo workspace
 * never renders the create form at all, it gets a "connect a repository"
 * empty state pointing at the Repos page instead. The API route
 * (`api/v1/workspaces/[workspaceId]/goals/route.ts`) enforces the SAME rule
 * server-side via `getRepository`, so this UI gate is a courtesy, not the
 * actual boundary. The button is further gated on `canManage` (owner/admin),
 * mirroring the Repos page's own `canManage` convention exactly — the API
 * route requires the same role, since creating a goal commits real spend.
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

  const [{ active, done }, repos] = await Promise.all([
    listGoalsForWorkspace(workspaceId),
    listWorkspaceRepositories(workspaceId),
  ]);

  const canManage = ADMIN_ROLES.includes(membership.role as (typeof ADMIN_ROLES)[number]);
  const repositoryOptions = repos.map((r) => ({ id: r.id, name: r.name }));
  const hasRepos = repositoryOptions.length > 0;

  const newGoalAction = !canManage ? undefined : hasRepos ? (
    <NewGoalButton workspaceId={workspaceId} repositories={repositoryOptions} />
  ) : (
    <Link
      href={`/dashboard/${workspaceId}/repos`}
      className="text-xs text-[var(--blue-11)] hover:underline"
    >
      Connect a repository to create a goal
    </Link>
  );

  if (active.length === 0 && done.length === 0) {
    return (
      <div className="mx-auto max-w-[1440px]">
        <PageHeader
          title="Goals"
          subtitle="What Jace is pursuing for this workspace, and how each one ended."
          actions={newGoalAction}
        />
        {hasRepos ? (
          <EmptyState
            icon={Target}
            title="No goals yet"
            description="A goal is set from a chat with Jace — state an objective and it pursues it, bounded by a leash, until the check is met or it needs you. Or use New goal above to start one yourself."
          />
        ) : (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <GitBranch className="h-10 w-10 text-[var(--gray-07)]" />
            <h3 className="mt-4 text-sm font-medium text-[var(--gray-12)]">
              Connect a repository first
            </h3>
            <p className="mt-1 max-w-md text-xs text-[var(--gray-09)]">
              Goals are tied to a repository — Jace files issues against a repo to pursue a goal.
            </p>
            <Link
              href={`/dashboard/${workspaceId}/repos`}
              className="mt-2 text-xs text-[var(--blue-11)] hover:underline"
            >
              Connect a repository to create your first goal.
            </Link>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1440px]">
      <PageHeader
        title="Goals"
        subtitle="What Jace is pursuing for this workspace, and how each one ended."
        actions={newGoalAction}
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
