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
        Connect the tools that provide repository, task, optional tool, and
        investigation context. GitHub anchors GitHub-backed flows to a
        repository and its PR/task provenance; MCP and observability
        connections are optional and do not replace criterion-specific
        exact-head proof.
      </p>
      <ConnectorsPanel workspaceId={workspaceId} />
    </div>
  );
}
