import { notFound } from "next/navigation";
import { getMergePermission, latestGrantEvent } from "@agentrail/db-postgres";
import { getMembership, getSession } from "../../../../../lib/cached";
import { PageHeader } from "../../../../components/page-header";
import { MergePermissionToggle } from "./components/merge-permission-toggle";

/**
 * Workspace Permissions page. The old factory merge grant remains readable
 * only so owners can revoke it; the Trust Layer cannot create merge authority.
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
  // Only an owner may revoke a historical grant. Admin/member/viewer see the
  // current state read-only.
  const canManage = membership.role === "owner";

  return (
    <div className="mx-auto max-w-[1440px]">
      <PageHeader
        title="Permissions"
        subtitle="Jace records evidence; implementation and merge remain outside Jace."
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
