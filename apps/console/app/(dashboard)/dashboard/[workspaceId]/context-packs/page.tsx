import { ContextPacksTable } from "./components/context-packs-table";

export default async function ContextPacksPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  return (
    <div className="mx-auto max-w-[1440px]">
      <h1 className="mb-1 text-sm font-semibold text-[var(--gray-12)]">
        Context Packs
      </h1>
      <p className="mb-4 text-xs text-[var(--gray-09)]">
        A context pack is the bundle of code snippets AgentRail retrieved for an
        agent before it started working — what it read, and how many tokens that
        took versus reading whole files.
      </p>
      <ContextPacksTable workspaceId={workspaceId} />
    </div>
  );
}
