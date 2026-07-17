"use client";

import { useCallback, useEffect, useState } from "react";
import { QueueStateBadge } from "./queue-state-badge";
import {
  DEFAULT_BUDGET,
  type QueueEntryView,
  type QueueState,
} from "./queue-helpers";
import { SkeletonTableRows } from "../../../../../components/loading-skeleton";

// Active queue: only states an issue occupies while it's still pending.
const ACTIVE_FILTERS: { label: string; value: QueueState | "" }[] = [
  { label: "All", value: "" },
  { label: "Queued", value: "queued" },
  { label: "Parked", value: "parked" },
  { label: "Running", value: "running" },
];

// Terminals only show under History (the queue self-flushes them otherwise).
const TERMINAL_FILTERS: { label: string; value: QueueState | "" }[] = [
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
  const [stateFilter, setStateFilter] = useState<QueueState | "">("queued");
  // History off → fetch active-only (the queue self-flushes terminals); on →
  // fetch everything so the terminal filters have rows to show.
  const [showHistory, setShowHistory] = useState(false);

  const fetchQueue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = showHistory ? "?all=1" : "";
      const res = await fetch(`/api/v1/workspaces/${workspaceId}/queue${qs}`);
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
  }, [workspaceId, showHistory]);

  useEffect(() => {
    fetchQueue();
  }, [fetchQueue]);

  const filters = showHistory
    ? [...ACTIVE_FILTERS, ...TERMINAL_FILTERS]
    : ACTIVE_FILTERS;
  const visible = stateFilter
    ? entries.filter((e) => e.state === stateFilter)
    : entries;

  return (
    <div className="flex flex-col gap-3">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-1">
        {filters.map(({ label, value }) => (
          <button
            key={value || "all"}
            onClick={() => setStateFilter(value)}
            className={`h-8 px-2.5 rounded text-xs font-medium border transition-colors ${
              stateFilter === value
                ? "bg-[var(--yellow-09)] text-black border-[var(--yellow-09)]"
                : "bg-[var(--gray-02)] text-[var(--gray-11)] border-[var(--gray-05)] hover:border-[var(--gray-08)]"
            }`}
          >
            {label}
          </button>
        ))}
        <button
          onClick={() => {
            // Leaving history view: snap any terminal filter back to Queued so
            // the (now active-only) result isn't filtered to an empty set.
            if (showHistory && stateFilter && stateFilter !== "queued") {
              const stillVisible = ACTIVE_FILTERS.some(
                (f) => f.value === stateFilter
              );
              if (!stillVisible) setStateFilter("queued");
            }
            setShowHistory((v) => !v);
          }}
          className={`ml-auto h-8 px-3 rounded text-sm border transition-colors ${
            showHistory
              ? "bg-[var(--gray-04)] text-[var(--gray-12)] border-[var(--gray-08)]"
              : "bg-[var(--gray-02)] text-[var(--gray-11)] border-[var(--gray-05)] hover:border-[var(--gray-08)]"
          }`}
          title="Show completed issues (Green / Escalated / Blocked). The queue itself only holds pending work."
        >
          {showHistory ? "Hide history" : "Show history"}
        </button>
        <button
          onClick={fetchQueue}
          className="h-8 px-3 rounded bg-[var(--gray-03)] border border-[var(--gray-06)] text-sm text-[var(--gray-12)] hover:border-[var(--gray-08)] transition-colors"
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
                  className="px-3 py-8 text-center text-sm text-[var(--red-11)]"
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
                          ? "text-[var(--red-11)]"
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
