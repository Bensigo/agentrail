import { GatewaysPanel } from "./components/gateways-panel";

export default async function GatewaysPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  return (
    <div className="mx-auto max-w-[1440px]">
      <h1 className="mb-1 text-sm font-semibold text-[var(--gray-12)]">
        Gateways
      </h1>
      <p className="mb-4 text-xs text-[var(--gray-09)]">
        Gateways are where you and your team talk to Jace. Each one is a place
        to start a conversation.
      </p>
      <GatewaysPanel workspaceId={workspaceId} />
    </div>
  );
}
