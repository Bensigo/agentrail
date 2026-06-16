"use client";

import { useCallback, useEffect, useState } from "react";
import {
  approvalKindLabel,
  pendingCount,
  type ApprovalItem,
} from "./approval-helpers";
import { SkeletonTableRows } from "../../../../../components/loading-skeleton";

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

const COLUMN_COUNT = 5;

function StatusBadge({ item }: { item: ApprovalItem }) {
  if (item.status === "approved") {
    return (
      <span
        title={item.approvedBy ? `Approved by ${item.approvedBy}` : "Approved"}
        className="px-1.5 py-0.5 rounded-sm text-xs font-medium bg-[color-mix(in_srgb,var(--green-11)_16%,transparent)] text-[var(--green-11)]"
      >
        Approved
      </span>
    );
  }
  return (
    <span className="px-1.5 py-0.5 rounded-sm text-xs font-medium bg-[color-mix(in_srgb,var(--yellow-11)_16%,transparent)] text-[var(--yellow-11)]">
      Pending
    </span>
  );
}

export function ApprovalsTable({ workspaceId }: { workspaceId: string }) {
  const [items, setItems] = useState<ApprovalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState<string | null>(null);

  const fetchApprovals = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/workspaces/${workspaceId}/approvals`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? `HTTP ${res.status}`
        );
      }
      const json = (await res.json()) as { items: ApprovalItem[] };
      setItems(json.items ?? []);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Failed to load pending approvals"
      );
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchApprovals();
  }, [fetchApprovals]);

  const approve = useCallback(
    async (item: ApprovalItem) => {
      setApproving(item.key);
      setError(null);
      try {
        const res = await fetch(
          `/api/v1/workspaces/${workspaceId}/approvals`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              runId: item.runId,
              kind: item.kind,
              target: item.target,
            }),
          }
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            (body as { error?: string }).error ?? `HTTP ${res.status}`
          );
        }
        await fetchApprovals();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to record approval");
      } finally {
        setApproving(null);
      }
    },
    [workspaceId, fetchApprovals]
  );

  const pending = pendingCount(items);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className="text-xs text-[var(--gray-09)]">
          <span className="font-mono text-[var(--gray-12)]">{pending}</span>{" "}
          pending
        </span>
        <button
          onClick={fetchApprovals}
          className="ml-auto h-8 px-3 rounded bg-[var(--gray-03)] border border-[var(--gray-06)] text-sm text-[var(--gray-12)] hover:border-[var(--gray-08)] transition-colors"
        >
          Refresh
        </button>
      </div>

      <div className="rounded border border-[var(--gray-05)] overflow-hidden">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-[var(--gray-05)] bg-[var(--gray-01)]">
              {["Action", "Target", "Run", "Status", ""].map((h, i) => (
                <th
                  key={h || `col-${i}`}
                  className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <SkeletonTableRows columns={COLUMN_COUNT} rows={6} />
            ) : error ? (
              <tr>
                <td
                  colSpan={COLUMN_COUNT}
                  className="px-3 py-8 text-center text-sm text-[var(--red-11)]"
                >
                  {error}
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td
                  colSpan={COLUMN_COUNT}
                  className="px-3 py-8 text-center text-sm text-[var(--gray-09)]"
                >
                  No irreversible actions awaiting approval. Actions appear here
                  only when the approval policy is enabled and a run reaches a
                  merge, deploy, or protected-target push.
                </td>
              </tr>
            ) : (
              items.map((item) => (
                <tr
                  key={item.key}
                  className="border-b border-[var(--gray-04)] hover:bg-[var(--gray-02)] transition-colors"
                  style={{ height: "34px" }}
                >
                  <td className="px-3 py-1.5 text-[var(--gray-12)]">
                    {approvalKindLabel(item.kind)}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs text-[var(--gray-11)]">
                    {item.target || "—"}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs text-[var(--gray-09)]">
                    {item.runId.slice(0, 12)}
                  </td>
                  <td className="px-3 py-1.5">
                    <StatusBadge item={item} />
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {item.status === "pending" ? (
                      <button
                        onClick={() => approve(item)}
                        disabled={approving === item.key}
                        className="h-8 px-3 rounded bg-[#ffe629] text-black text-sm font-medium hover:bg-[#ffdc00] disabled:opacity-60 transition-colors"
                      >
                        {approving === item.key ? "Approving…" : "Approve"}
                      </button>
                    ) : (
                      <span
                        className="font-mono text-xs text-[var(--gray-10)]"
                        title={formatUpdatedAt(item.updatedAt)}
                      >
                        {item.approvedBy || "—"}
                      </span>
                    )}
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
