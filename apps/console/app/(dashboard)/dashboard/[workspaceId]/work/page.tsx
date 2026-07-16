"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { type ColumnDef } from "@tanstack/react-table";
import { DataTable } from "../../../components/data-table";
import { EmptyState } from "../../../components/empty-state";
import { ErrorState } from "../../../components/error-state";
import { LoadingState } from "../../../components/loading-state";
import { WorkBoard } from "./components/work-board";
import { WorkStateChip } from "./components/work-state-chip";
import {
  groupWorkEntries,
  type QueueEntryView,
} from "../../../../../lib/work-vocabulary";

/**
 * Work — the task list (spec §4 "Work"). `queue_entries` rendered through the
 * shared state vocabulary (`lib/work-vocabulary.ts`): table + board toggle,
 * grouped Assigned / In progress / Blocked / Needs you / Shipped. Clicking a
 * work item lands on the existing run detail page — the queue entry id IS the
 * run id (see `claimQueueEntry`), so no extra lookup is needed.
 *
 * User-facing copy never says `queue_entry`, `tier`, or `remaining_budget`
 * (house rule + spec §3) — Tier/Budget are internal to the durable queue and
 * are deliberately not shown as columns here (they still exist on the
 * evidence-layer Issue Queue read model for anyone who reaches for it).
 */

type ViewMode = "table" | "board";

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

function buildColumns(): ColumnDef<QueueEntryView, unknown>[] {
  return [
    {
      id: "task",
      header: "Task",
      accessorKey: "title",
      cell: ({ row }) => (
        <div className="flex items-center gap-2 min-w-0">
          <span className="truncate text-sm font-medium text-[var(--gray-12)]">
            {row.original.title || "Untitled task"}
          </span>
          <span className="shrink-0 font-mono text-xs text-[var(--gray-09)]">
            {row.original.issueKey}
          </span>
        </div>
      ),
      enableSorting: true,
    },
    {
      id: "status",
      header: "Status",
      accessorKey: "state",
      cell: ({ row }) => <WorkStateChip entry={row.original} />,
      enableSorting: true,
    },
    {
      id: "updated",
      header: "Updated",
      accessorKey: "updatedAt",
      meta: { mono: true },
      cell: ({ row }) => (
        <span className="text-[var(--gray-09)]">
          {formatUpdatedAt(row.original.updatedAt)}
        </span>
      ),
      enableSorting: true,
    },
  ] satisfies ColumnDef<QueueEntryView, unknown>[];
}

export default function WorkPage() {
  const params = useParams<{ workspaceId: string }>();
  const router = useRouter();
  const { workspaceId } = params;

  const [entries, setEntries] = useState<QueueEntryView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("table");
  // Off by default: Work is the full task list (unlike the old self-flushing
  // Issue Queue), so Shipped/Needs-you read meaningfully on first load. On
  // hides Shipped to focus on what's still open.
  const [hideShipped, setHideShipped] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // `all=1`: the Work board needs every group populated (Shipped and
      // Needs you are terminals that would otherwise be excluded — see
      // `listQueueEntries`'s `activeOnly` default).
      const res = await fetch(
        `/api/v1/workspaces/${workspaceId}/queue?all=1`
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as { entries: QueueEntryView[] };
      setEntries(json.entries ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load work");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(
    () => (hideShipped ? entries.filter((e) => e.state !== "green") : entries),
    [entries, hideShipped]
  );

  const groups = useMemo(() => groupWorkEntries(visible), [visible]);
  const columns = useMemo(() => buildColumns(), []);

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-0.5">
        {(["table", "board"] as ViewMode[]).map((mode) => (
          <button
            key={mode}
            onClick={() => setViewMode(mode)}
            className={`h-7 px-3 rounded text-xs font-medium capitalize transition-colors ${
              viewMode === mode
                ? "bg-[var(--brand-accent)] text-[var(--gray-00)]"
                : "text-[var(--gray-11)] hover:text-[var(--gray-12)]"
            }`}
          >
            {mode}
          </button>
        ))}
      </div>
      <button
        onClick={() => setHideShipped((v) => !v)}
        className={`h-8 px-3 rounded text-xs font-medium border transition-colors ${
          hideShipped
            ? "bg-[var(--gray-04)] text-[var(--gray-12)] border-[var(--gray-08)]"
            : "bg-[var(--gray-02)] text-[var(--gray-11)] border-[var(--gray-05)] hover:border-[var(--gray-08)]"
        }`}
      >
        {hideShipped ? "Show shipped" : "Hide shipped"}
      </button>
      <button
        onClick={load}
        className="h-8 px-3 rounded bg-[var(--gray-03)] border border-[var(--gray-06)] text-xs text-[var(--gray-12)] hover:border-[var(--gray-08)] transition-colors"
      >
        Refresh
      </button>
    </div>
  );

  return (
    <div className="mx-auto max-w-[1440px] flex flex-col gap-4">
      <div>
        <h1 className="text-sm font-semibold text-[var(--gray-12)]">Work</h1>
        <p className="mt-1 max-w-[80ch] text-xs leading-relaxed text-[var(--gray-09)]">
          Everything assigned to Jace, from newly assigned to shipped. A
          blocked task shows why — waiting on another task or a person.
        </p>
      </div>

      {loading ? (
        <>
          {toolbar}
          <LoadingState variant="table" columns={3} rows={8} />
        </>
      ) : error ? (
        <>
          {toolbar}
          <ErrorState message={error} onRetry={load} />
        </>
      ) : visible.length === 0 ? (
        <>
          {toolbar}
          <EmptyState message="No work yet. Assign Jace a task to get started." />
        </>
      ) : viewMode === "table" ? (
        <DataTable
          columns={columns}
          data={visible}
          filterBar={toolbar}
          rowKey={(entry) => entry.id}
          onRowClick={(entry) =>
            router.push(`/dashboard/${workspaceId}/runs/${entry.id}`)
          }
          emptyMessage="No work yet. Assign Jace a task to get started."
        />
      ) : (
        <>
          {toolbar}
          <WorkBoard groups={groups} workspaceId={workspaceId} />
        </>
      )}
    </div>
  );
}
