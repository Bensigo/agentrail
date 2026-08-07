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
        Channels
      </h1>
      <p className="mb-4 text-xs text-[var(--gray-09)]">
        Choose where your team talks to Jace and starts work. Supported
        channels keep the request connected to its Acceptance Record.
      </p>
      <GatewaysPanel workspaceId={workspaceId} />
    </div>
  );
}
