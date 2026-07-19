import { notFound } from "next/navigation";
import { getMergePermission, latestGrantEvent } from "@agentrail/db-postgres";
import { getMembership, getSession } from "../../../../../lib/cached";
import { PageHeader } from "../../../../components/page-header";
import { MergePermissionToggle } from "./components/merge-permission-toggle";

/**
 * Workspace Permissions page (#1278 PR ①) — the owner-only console surface
 * for granting/revoking merge permission: the trust ceiling between "green
 * gate -> PR opened, Jace waits for you" (default) and "green gate -> merges
 * itself".
 *
 * Server component reading the queries directly (Budget page precedent, see
 * `../budget/page.tsx`: no client fetch, no new API route for the READ). The
 * mutation is a real Next.js Server Action (`./actions.ts`), re-checked
 * owner-only SERVER-side on every call — `canManage` below only decides
 * whether the control renders interactive, never the enforcement boundary.
 */
export default async function PermissionsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  const session = await getSession();
  if (!session?.user?.id) return notFound();

  const membership = await getMembership(session.user.id, workspaceId);
  if (!membership) return notFound();

  const [granted, lastGrant] = await Promise.all([
    getMergePermission(workspaceId),
    latestGrantEvent(workspaceId),
  ]);

  // Strictly owner-only for the mutation — deliberately narrower than the
  // repo's ADMIN_ROLES precedent (owner OR admin, e.g. the repos page):
  // granting merge is the trust ceiling, the one setting that lets
  // AgentRail push code to `main` unattended, so only the workspace owner
  // grants it. Admin/member/viewer see the current state read-only.
  const canManage = membership.role === "owner";

  return (
    <div className="mx-auto max-w-[1440px]">
      <PageHeader
        title="Permissions"
        subtitle="What AgentRail is allowed to do on its own."
      />
      <MergePermissionToggle
        workspaceId={workspaceId}
        granted={granted}
        canManage={canManage}
        lastGrant={
          lastGrant
            ? {
                granted: lastGrant.granted,
                createdAt: lastGrant.createdAt.toISOString(),
                grantedByName: lastGrant.grantedByName,
                grantedByEmail: lastGrant.grantedByEmail,
              }
            : null
        }
      />
    </div>
  );
}
