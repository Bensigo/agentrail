import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, getRun } from "@agentrail/db-postgres";
import { notFound } from "next/navigation";
import { EventTimeline } from "./event-timeline";

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ workspaceId: string; runId: string }>;
}) {
  const { workspaceId, runId } = await params;
  const session = await auth();
  if (!session?.user?.id) return notFound();

  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) return notFound();

  const run = await getRun(workspaceId, runId);
  if (!run) return notFound();

  const statusColors: Record<string, string> = {
    queued: "bg-[var(--gray-04)] text-[var(--gray-11)]",
    running: "bg-[#f76b15]/20 text-[var(--orange-11)]",
    success: "bg-[#29a383]/20 text-[var(--green-11)]",
    failed: "bg-[#e5484d]/20 text-[var(--red-11)]",
  };

  return (
    <div className="mx-auto max-w-[1440px]">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-bold tracking-tight text-[var(--gray-12)]">
          Run
        </h1>
        <span className="font-mono text-sm text-[var(--gray-09)]">
          {run.id.slice(0, 8)}
        </span>
        <span
          className={`rounded-sm px-1.5 py-0.5 text-xs font-medium ${statusColors[run.status]}`}
        >
          {run.status}
        </span>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-3">
          <p className="text-xs uppercase text-[var(--gray-09)]">Agent</p>
          <p className="mt-1 text-sm font-medium text-[var(--gray-12)]">
            {run.agent}
          </p>
        </div>
        <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-3">
          <p className="text-xs uppercase text-[var(--gray-09)]">Repository</p>
          <p className="mt-1 font-mono text-sm text-[var(--gray-12)]">
            {run.repositoryId ?? "—"}
          </p>
        </div>
        <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-3">
          <p className="text-xs uppercase text-[var(--gray-09)]">Branch</p>
          <p className="mt-1 font-mono text-sm text-[var(--gray-12)]">
            {run.branch ?? "—"}
          </p>
        </div>
        <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-3">
          <p className="text-xs uppercase text-[var(--gray-09)]">Started</p>
          <p className="mt-1 font-mono text-xs text-[var(--gray-12)]">
            {run.startedAt
              ? new Date(run.startedAt).toLocaleString()
              : "—"}
          </p>
        </div>
      </div>

      <div className="mt-8">
        <h2 className="text-sm font-bold text-[var(--gray-12)]">
          Event Timeline
        </h2>
        <EventTimeline workspaceId={workspaceId} runId={runId} />
      </div>
    </div>
  );
}
