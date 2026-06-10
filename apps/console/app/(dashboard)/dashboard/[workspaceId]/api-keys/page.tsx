import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, listApiKeys } from "@agentrail/db-postgres";
import { ApiKeysTable } from "./components/api-keys-table";
import type { ApiKeyRow } from "./components/create-key-dialog";

export default async function ApiKeysPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  const session = await auth();
  const userId = session?.user?.id ?? null;

  let keys: ApiKeyRow[] = [];
  let canManage = false;

  if (userId) {
    try {
      const membership = await getWorkspaceMembership(userId, workspaceId);
      if (membership) {
        canManage =
          membership.role === "owner" || membership.role === "admin";
        const rows = await listApiKeys(workspaceId);
        keys = rows.map((k) => ({
          id: k.id,
          name: k.name,
          key_prefix: k.keyPrefix,
          team_id: k.teamId,
          created_at: k.createdAt.toISOString(),
          last_used_at: k.lastUsedAt ? k.lastUsedAt.toISOString() : null,
          is_revoked: k.revokedAt !== null,
          revoked_at: k.revokedAt ? k.revokedAt.toISOString() : null,
        }));
      }
    } catch {
      // DB unavailable — empty list
    }
  }

  return (
    <div className="mx-auto max-w-[1440px]">
      <h1 className="mb-4 text-sm font-semibold text-[var(--gray-12)]">
        API Keys
      </h1>
      <ApiKeysTable
        workspaceId={workspaceId}
        initialKeys={keys}
        canManage={canManage}
      />
    </div>
  );
}
