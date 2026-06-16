import { QueueTable } from "./components/queue-table";

export default async function QueuePage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  return (
    <div className="mx-auto max-w-[1440px]">
      <h1 className="mb-1 text-sm font-semibold text-[var(--gray-12)]">
        Issue Queue
      </h1>
      <p className="mb-4 text-xs text-[var(--gray-09)]">
        Human-defined issues awaiting or undergoing autonomous execution. Each
        carries its tier, remaining budget, and state.
      </p>
      <QueueTable workspaceId={workspaceId} />
    </div>
  );
}
