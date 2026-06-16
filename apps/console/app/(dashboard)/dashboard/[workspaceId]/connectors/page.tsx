import { ConnectorsPanel } from "./components/connectors-panel";

export default async function ConnectorsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  return (
    <div className="mx-auto max-w-[1440px]">
      <h1 className="mb-1 text-sm font-semibold text-[var(--gray-12)]">
        Connectors
      </h1>
      <p className="mb-4 text-xs text-[var(--gray-09)]">
        Two-way links between the tools your team already uses and the Issue
        Queue: connectors ingest human-created issues into the queue and post run
        results back.
      </p>
      <ConnectorsPanel workspaceId={workspaceId} />
    </div>
  );
}
