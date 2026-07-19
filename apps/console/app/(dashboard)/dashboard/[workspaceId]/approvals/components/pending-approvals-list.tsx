"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { PendingApprovalRow } from "@agentrail/db-postgres";
import { Inbox } from "lucide-react";
import { EmptyState } from "../../../../components/empty-state";
import {
  channelLabel,
  formatRelativeTime,
  summarizeApprovalToolInput,
  toolLabel,
} from "../approvals-helpers";

/**
 * Pending approvals — one row per `jace_approvals` row with `status='pending'`
 * (issue #1276). `approval.id`/`conversationKey` are never rendered as
 * visible text (names over IDs) — the summary headline (title/name, per
 * tool) and the channel's plain-English label are the only identifying text
 * shown.
 *
 * Approve/Deny (PR ②) POST to `/api/v1/workspaces/:workspaceId/approvals/:id`
 * — that route resolves through the EXACT SAME seam a Telegram tap does
 * (`resolveApproval` + `applyAlignmentDecision`); this component's own job is
 * only to hide the buttons for a member/viewer (`canManage`) and reflect the
 * result. The route re-checks the role server-side regardless — a
 * client-hidden button is not the security boundary.
 */
export function PendingApprovalsList({
  rows,
  workspaceId,
  canManage,
}: {
  rows: PendingApprovalRow[];
  workspaceId: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [errorById, setErrorById] = useState<Record<string, string>>({});

  async function decide(id: string, decision: "approved" | "denied") {
    setPendingId(id);
    setErrorById((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    try {
      const res = await fetch(`/api/v1/workspaces/${workspaceId}/approvals/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (err) {
      setErrorById((prev) => ({
        ...prev,
        [id]: err instanceof Error ? err.message : "Failed to resolve this approval",
      }));
    } finally {
      setPendingId(null);
    }
  }

  if (rows.length === 0) {
    return (
      <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)]">
        <EmptyState
          message="Nothing waiting on your approval right now."
          icon={<Inbox size={20} />}
        />
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded border border-[var(--gray-05)] bg-[var(--gray-02)]">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-[var(--gray-05)]">
            <th className="px-3 py-2 text-left font-medium uppercase tracking-wide text-[var(--gray-09)]">
              Approval
            </th>
            <th className="px-3 py-2 text-left font-medium uppercase tracking-wide text-[var(--gray-09)]">
              Source
            </th>
            <th className="px-3 py-2 text-right font-medium uppercase tracking-wide text-[var(--gray-09)]">
              Waiting
            </th>
            {canManage && (
              <th className="px-3 py-2 text-right font-medium uppercase tracking-wide text-[var(--gray-09)]">
                Actions
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const summary = summarizeApprovalToolInput(row.toolName, row.toolInput);
            const age = formatRelativeTime(row.createdAt);
            const busy = pendingId === row.id;
            const rowError = errorById[row.id];
            return (
              <tr key={row.id} className="border-b border-[var(--gray-04)] last:border-0 align-top">
                <td className="px-3 py-2">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      {/* text-xs: no genuine space constraint for these short
                          tool labels (badge is shrink-0, sibling truncates).
                          font-medium stays — Status Badge shape (rounded-sm +
                          px-1.5 py-0.5), guide-sanctioned. */}
                      <span className="inline-flex shrink-0 items-center rounded-sm border border-[var(--gray-06)] bg-[var(--gray-03)] px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide text-[var(--gray-10)]">
                        {toolLabel(row.toolName)}
                      </span>
                      <span className="truncate text-[var(--gray-12)]">{summary.headline}</span>
                    </div>
                    {summary.fields.length > 0 && (
                      <dl className="flex flex-col gap-0.5">
                        {summary.fields.map((field, i) => (
                          <div key={`${field.label}-${i}`} className="flex gap-1 text-[var(--gray-09)]">
                            {field.label && <dt className="shrink-0">{field.label}:</dt>}
                            {/* font-mono: these values are frequently raw
                                tool-input data ($ estimates, unknown-tool
                                fallback key/value pairs) even where a known
                                tool renders prose ("Private"/"Public") — one
                                consistent treatment for the whole field. */}
                            <dd className="truncate font-mono">{field.value}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                    {rowError && <p className="text-[var(--red-11)]">{rowError}</p>}
                  </div>
                </td>
                <td className="px-3 py-2 text-[var(--gray-10)]">{channelLabel(row.channel)}</td>
                {/* font-mono: relative-time value. */}
                <td className="px-3 py-2 text-right font-mono text-[var(--gray-09)]" title={age.title}>
                  {age.label}
                </td>
                {canManage && (
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => decide(row.id, "denied")}
                        disabled={busy}
                        className="h-7 px-2.5 rounded bg-[var(--gray-03)] border border-[var(--gray-06)] text-xs text-[var(--red-11)] hover:border-[var(--red-09)]/50 disabled:opacity-50 transition-colors"
                      >
                        Deny
                      </button>
                      {/* font-bold: primary action (colored fill), matches
                          Deny's plain weight staying as the secondary case. */}
                      <button
                        type="button"
                        onClick={() => decide(row.id, "approved")}
                        disabled={busy}
                        className="h-7 px-2.5 rounded bg-[var(--green-09)] text-white text-xs font-bold hover:bg-[var(--green-11)] disabled:opacity-50 transition-colors"
                      >
                        {busy ? "Working…" : "Approve"}
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
