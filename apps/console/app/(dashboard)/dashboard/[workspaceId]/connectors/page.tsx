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
        Connect GitHub to anchor the repository and exact PR identity used by
        the acceptance record. Chat channels belong on Gateways; optional
        tools and investigation evidence are not required for this setup.
      </p>
      <ConnectorsPanel workspaceId={workspaceId} />
    </div>
  );
}
