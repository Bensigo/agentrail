import { notFound } from "next/navigation";
import { getMembership, getSession } from "../../../../../lib/cached";
import { RepositoryConnection } from "./repository-connection";
import { AgentConnection } from "./agent-connection";
export default async function AgentsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const session = await getSession();
  if (!session?.user?.id) return notFound();
  const membership = await getMembership(session.user.id, workspaceId);
  if (!membership) return notFound();
  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-xl font-semibold">Connect your agent</h1>
      {["owner", "admin"].includes(membership.role) && (
        <RepositoryConnection workspaceId={workspaceId} />
      )}
      <AgentConnection
        workspaceId={workspaceId}
        canManage={["owner", "admin"].includes(membership.role)}
        consoleOrigin={
          process.env.AGENTRAIL_PUBLIC_URL ||
          process.env.AUTH_URL ||
          "http://localhost:3000"
        }
      />
    </div>
  );
}
