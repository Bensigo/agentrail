"use client";

import { useRouter } from "next/navigation";
import {
  formatParkReason,
  WORK_GROUPS,
  type QueueEntryView,
  type WorkGroup,
} from "../../../../../../lib/work-vocabulary";

/** Column accent — a thin top border, not a full color wash (dense product, TASTE.md). */
const GROUP_ACCENT: Record<WorkGroup, string> = {
  Assigned: "border-t-[var(--gray-07)]",
  "In progress": "border-t-[#f76b15]",
  Blocked: "border-t-[#ffe629]",
  "Needs you": "border-t-[#e5484d]",
  Shipped: "border-t-[#29a383]",
};

function formatUpdatedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function WorkCard({
  entry,
  workspaceId,
}: {
  entry: QueueEntryView;
  workspaceId: string;
}) {
  const router = useRouter();
  const reason =
    entry.state === "parked"
      ? formatParkReason(entry.parkReason, entry.blockedBy)
      : undefined;
  const go = () => router.push(`/dashboard/${workspaceId}/runs/${entry.id}`);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={go}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          go();
        }
      }}
      className="cursor-pointer rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-2.5 transition-colors hover:border-[var(--gray-08)] hover:bg-[var(--gray-03)]"
    >
      <p className="text-sm text-[var(--gray-12)] line-clamp-2">
        {entry.title || "Untitled task"}
      </p>
      {reason && (
        <p className="mt-1 text-xs text-[var(--gray-09)]">{reason}</p>
      )}
      <p className="mt-1.5 font-mono text-xs text-[var(--gray-09)]">
        {formatUpdatedAt(entry.updatedAt)}
      </p>
    </div>
  );
}

export function WorkBoard({
  groups,
  workspaceId,
}: {
  groups: Record<WorkGroup, QueueEntryView[]>;
  workspaceId: string;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 overflow-x-auto sm:grid-cols-2 lg:grid-cols-5">
      {WORK_GROUPS.map((group) => {
        const entries = groups[group];
        return (
          <div
            key={group}
            className={`flex min-w-[220px] flex-col gap-2 rounded border border-[var(--gray-05)] border-t-2 bg-[var(--gray-01)] p-2.5 ${GROUP_ACCENT[group]}`}
          >
            <div className="flex items-center justify-between px-0.5">
              <span className="text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                {group}
              </span>
              <span className="font-mono text-xs text-[var(--gray-09)]">
                {entries.length}
              </span>
            </div>
            <div className="flex flex-col gap-2">
              {entries.length === 0 ? (
                <p className="px-0.5 py-4 text-center text-xs text-[var(--gray-08)]">
                  Nothing here
                </p>
              ) : (
                entries.map((entry) => (
                  <WorkCard
                    key={entry.id}
                    entry={entry}
                    workspaceId={workspaceId}
                  />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
