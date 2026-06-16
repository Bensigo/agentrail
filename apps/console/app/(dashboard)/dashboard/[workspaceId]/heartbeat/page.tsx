import { HeartbeatPanel } from "./components/heartbeat-panel";

export default async function HeartbeatPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  return (
    <div className="mx-auto max-w-[1440px]">
      <h1 className="mb-1 text-sm font-semibold text-[var(--gray-12)]">
        Heartbeat
      </h1>
      <p className="mb-4 max-w-[80ch] text-xs leading-relaxed text-[var(--gray-09)]">
        The autonomous loop that polls GitHub for labeled issues on a cadence and
        admits them into the Issue Queue. Enabling it here records the operator
        intent the live daemon reads; the daemon only actually runs once all three
        prerequisite capabilities are present.
      </p>
      <HeartbeatPanel workspaceId={workspaceId} />
    </div>
  );
}
