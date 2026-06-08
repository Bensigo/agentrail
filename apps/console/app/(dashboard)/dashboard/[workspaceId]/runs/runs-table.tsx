"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";

interface Run {
  id: string;
  workspaceId: string;
  repositoryId: string | null;
  agent: string;
  branch: string | null;
  status: "queued" | "running" | "success" | "failed";
  startedAt: Date | string | null;
  finishedAt: Date | string | null;
  createdAt: Date | string;
}

const statusColors: Record<string, string> = {
  queued: "bg-[var(--gray-04)] text-[var(--gray-11)]",
  running: "bg-[#f76b15]/20 text-[var(--orange-11)]",
  success: "bg-[#29a383]/20 text-[var(--green-11)]",
  failed: "bg-[#e5484d]/20 text-[var(--red-11)]",
};

const statuses = ["all", "queued", "running", "success", "failed"] as const;

function formatDuration(start: Date | string | null, end: Date | string | null): string {
  if (!start) return "—";
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const secs = Math.round((e - s) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

function formatTime(ts: Date | string | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function RunsTable({
  runs,
  workspaceId,
  currentStatus,
}: {
  runs: Run[];
  workspaceId: string;
  currentStatus?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function setFilter(status: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (status === "all") {
      params.delete("status");
    } else {
      params.set("status", status);
    }
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="mt-6">
      <div className="flex items-center gap-1 border-b border-[var(--gray-04)] pb-2">
        {statuses.map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
              (s === "all" && !currentStatus) || s === currentStatus
                ? "bg-[var(--gray-03)] text-[var(--gray-12)]"
                : "text-[var(--gray-09)] hover:text-[var(--gray-12)]"
            }`}
          >
            {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--gray-04)]">
              <th className="pb-2 pr-4 text-xs font-medium uppercase text-[var(--gray-09)]">
                Run ID
              </th>
              <th className="pb-2 pr-4 text-xs font-medium uppercase text-[var(--gray-09)]">
                Repo
              </th>
              <th className="pb-2 pr-4 text-xs font-medium uppercase text-[var(--gray-09)]">
                Status
              </th>
              <th className="pb-2 pr-4 text-xs font-medium uppercase text-[var(--gray-09)]">
                Agent
              </th>
              <th className="pb-2 pr-4 text-xs font-medium uppercase text-[var(--gray-09)]">
                Started
              </th>
              <th className="pb-2 text-xs font-medium uppercase text-[var(--gray-09)]">
                Duration
              </th>
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="py-12 text-center text-sm text-[var(--gray-09)]"
                >
                  No runs found.
                </td>
              </tr>
            ) : (
              runs.map((run) => (
                <tr
                  key={run.id}
                  onClick={() =>
                    router.push(
                      `/dashboard/${workspaceId}/runs/${run.id}`
                    )
                  }
                  className="cursor-pointer border-b border-[var(--gray-04)] transition-colors hover:bg-[var(--gray-02)]"
                  style={{ height: "36px" }}
                >
                  <td className="pr-4 font-mono text-xs text-[var(--gray-12)]">
                    {run.id.slice(0, 8)}
                  </td>
                  <td className="pr-4 text-sm text-[var(--gray-11)]">
                    {run.repositoryId ?? "—"}
                  </td>
                  <td className="pr-4">
                    <span
                      className={`inline-flex rounded-sm px-1.5 py-0.5 text-xs font-medium ${statusColors[run.status]}`}
                    >
                      {run.status}
                    </span>
                  </td>
                  <td className="pr-4 text-sm text-[var(--gray-11)]">
                    {run.agent}
                  </td>
                  <td className="pr-4 font-mono text-xs text-[var(--gray-09)]">
                    {formatTime(run.startedAt)}
                  </td>
                  <td className="font-mono text-xs text-[var(--gray-09)]">
                    {formatDuration(run.startedAt, run.finishedAt)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
