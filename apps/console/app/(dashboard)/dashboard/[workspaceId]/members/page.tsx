import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, listWorkspaceMembers } from "@agentrail/db-postgres";
import { MembersTable, type MemberRow } from "./components/members-table";

export default async function MembersPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  const session = await auth();
  const userId = session?.user?.id ?? null;

  let members: MemberRow[] = [];
  let canAdd = false;
  let callerRole: string | null = null;

  if (userId) {
    try {
      const membership = await getWorkspaceMembership(userId, workspaceId);
      if (membership) {
        callerRole = membership.role;
        canAdd = membership.role === "owner" || membership.role === "admin";
        const rows = await listWorkspaceMembers(workspaceId);
        members = rows.map((m) => ({
          user_id: m.userId,
          email: m.email,
          name: m.name,
          role: m.role,
          joined_at: m.joinedAt.toISOString(),
        }));
      }
    } catch {
      // DB unavailable — empty list
    }
  }

  return (
    <div className="mx-auto max-w-[1440px]">
      <h1 className="mb-4 text-sm font-semibold text-[var(--gray-12)]">
        Members
      </h1>
      <MembersTable
        workspaceId={workspaceId}
        initialMembers={members}
        currentUserId={userId}
        canAdd={canAdd}
        callerRole={callerRole}
      />
    </div>
  );
}
