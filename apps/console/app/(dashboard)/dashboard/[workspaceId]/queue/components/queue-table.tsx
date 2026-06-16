"use client";

import { useCallback, useEffect, useState } from "react";
import { QueueStateBadge } from "./queue-state-badge";
import {
  DEFAULT_BUDGET,
  type QueueEntryView,
  type QueueState,
} from "./queue-helpers";
import { SkeletonTableRows } from "../../../../../components/loading-skeleton";

const STATE_FILTERS: { label: string; value: QueueState | "" }[] = [
  { label: "All", value: "" },
  { label: "Queued", value: "queued" },
  { label: "Running", value: "running" },
  { label: "Green", value: "green" },
  { label: "Escalated", value: "escalated-to-human" },
  { label: "Blocked", value: "blocked" },
];

function formatUpdatedAt(iso: string): string {
  if (!iso) return "—";
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

const COLUMN_COUNT = 6;

export function QueueTable({ workspaceId }: { workspaceId: string }) {
  const [entries, setEntries] = useState<QueueEntryView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState<QueueState | "">("");

  const fetchQueue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/workspaces/${workspaceId}/queue`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as { entries: QueueEntryView[] };
      setEntries(json.entries ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the Issue Queue");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchQueue();
  }, [fetchQueue]);

  const visible = stateFilter
    ? entries.filter((e) => e.state === stateFilter)
    : entries;

  return (
    <div className="flex flex-col gap-3">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-1">
        {STATE_FILTERS.map(({ label, value }) => (
          <button
            key={value || "all"}
            onClick={() => setStateFilter(value)}
            className={`h-8 px-2.5 rounded text-xs font-medium border transition-colors ${
              stateFilter === value
                ? "bg-[#ffe629] text-black border-[#ffe629]"
                : "bg-[var(--gray-02)] text-[var(--gray-11)] border-[var(--gray-05)] hover:border-[var(--gray-08)]"
            }`}
          >
            {label}
          </button>
        ))}
        <button
          onClick={fetchQueue}
          className="ml-auto h-8 px-3 rounded bg-[var(--gray-03)] border border-[var(--gray-06)] text-sm text-[var(--gray-12)] hover:border-[var(--gray-08)] transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Table */}
      <div className="rounded border border-[var(--gray-05)] overflow-hidden">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-[var(--gray-05)] bg-[var(--gray-01)]">
              {["Issue", "Agent", "Tier", "Budget", "State", "Updated"].map(
                (h) => (
                  <th
                    key={h}
                    className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]"
                  >
                    {h}
                  </th>
                )
              )}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <SkeletonTableRows columns={COLUMN_COUNT} rows={8} />
            ) : error ? (
              <tr>
                <td
                  colSpan={COLUMN_COUNT}
                  className="px-3 py-8 text-center text-sm text-[#ff9592]"
                >
                  {error}
                </td>
              </tr>
            ) : visible.length === 0 ? (
              <tr>
                <td
                  colSpan={COLUMN_COUNT}
                  className="px-3 py-8 text-center text-sm text-[var(--gray-09)]"
                >
                  No issues in the queue. Issues enter the queue only with
                  machine-checkable acceptance criteria.
                </td>
              </tr>
            ) : (
              visible.map((entry) => (
                <tr
                  key={entry.issueKey}
                  className="border-b border-[var(--gray-04)] hover:bg-[var(--gray-02)] transition-colors"
                  style={{ height: "34px" }}
                >
                  <td className="px-3 py-1.5">
                    <span className="font-medium text-[var(--gray-12)]">
                      {entry.title || "—"}
                    </span>
                    <span className="ml-2 font-mono text-xs text-[var(--gray-09)]">
                      {entry.issueKey}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-[var(--gray-11)]">
                    {entry.agent}
                  </td>
                  <td className="px-3 py-1.5">
                    <span
                      className="font-mono text-xs text-[var(--gray-11)]"
                      title={
                        entry.tier === "strong"
                          ? "Escalated to the strong model after a red gate"
                          : "Running on the cheap model"
                      }
                    >
                      {entry.tier}
                    </span>
                  </td>
                  <td className="px-3 py-1.5">
                    <span
                      className={`font-mono text-xs ${
                        entry.remainingBudget === 0
                          ? "text-[#ff9592]"
                          : "text-[var(--gray-11)]"
                      }`}
                      title="Remaining escalation-attempt budget (Budget Leash)"
                    >
                      {entry.remainingBudget}/{DEFAULT_BUDGET}
                    </span>
                  </td>
                  <td className="px-3 py-1.5">
                    <QueueStateBadge state={entry.state} />
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs text-[var(--gray-10)]">
                    {formatUpdatedAt(entry.updatedAt)}
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
