import { listApiKeys } from "@agentrail/db-postgres";
import { ApiKeysTable } from "./components/api-keys-table";
import type { ApiKeyRow } from "./components/create-key-dialog";
import { getMembership, getSession } from "../../../../../lib/cached";
import { PageHeader } from "../../../../components/page-header";

export default async function ApiKeysPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  const session = await getSession();
  const userId = session?.user?.id ?? null;

  let keys: ApiKeyRow[] = [];
  let canManage = false;

  if (userId) {
    // Membership and the key list are independent lookups — run them in
    // parallel and only expose the keys if the membership check passes.
    const [membership, rows] = await Promise.all([
      getMembership(userId, workspaceId).catch(() => null),
      listApiKeys(workspaceId).catch(() => null),
    ]);
    if (membership) {
      canManage = membership.role === "owner" || membership.role === "admin";
      keys = (rows ?? []).map((k) => ({
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
  }

  return (
    <div className="mx-auto max-w-[1440px]">
      <PageHeader
        title="API Keys"
        subtitle="Authenticate CLI and integrations against this workspace."
      />
      <ApiKeysTable
        workspaceId={workspaceId}
        initialKeys={keys}
        canManage={canManage}
      />
    </div>
  );
}
