"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { type ColumnDef } from "@tanstack/react-table";
import { DataTable } from "../../../components/data-table";
import { StatHeader } from "../../../components/stat-header";
import { EmptyState } from "../../../components/empty-state";
import { ErrorState } from "../../../components/error-state";
import { LoadingState } from "../../../components/loading-state";
import { CreateIssueButton } from "./components/create-issue-button";
import {
  blockingReasonLabel,
  blockingReasonSeverity,
  type BlockingReasonInput,
} from "./blocking-reason";

interface EvidenceRef {
  label: string;
  url: string;
}

interface ReviewGateFinding {
  severity: "critical" | "major" | "minor";
  description: string;
  suggested_fix: string;
}

interface ReviewGate {
  id: string;
  runId: string;
  gateName: string;
  status: "passed" | "failed" | "pending";
  conditions: Record<string, unknown>[];
  blockingReasons: BlockingReasonInput[];
  evidenceRefs: EvidenceRef[];
  findings: ReviewGateFinding[] | null;
  evaluatedAt: string | null;
}

// Relative time ("3m ago") with the absolute time on hover — human-readable first.
function relTime(iso: string | null): { label: string; title: string } {
  if (!iso) return { label: "—", title: "" };
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const m = Math.round(diff / 60000);
  const h = Math.round(diff / 3600000);
  const days = Math.round(diff / 86400000);
  const label = m < 1 ? "just now" : m < 60 ? `${m}m ago` : h < 24 ? `${h}h ago` : `${days}d ago`;
  return { label, title: d.toLocaleString() };
}

function StatusBadge({ status }: { status: ReviewGate["status"] }) {
  const styles: Record<ReviewGate["status"], string> = {
    passed: "bg-[color-mix(in_srgb,var(--green-11)_16%,transparent)] text-[var(--green-11)]",
    failed: "bg-[color-mix(in_srgb,var(--red-11)_16%,transparent)] text-[var(--red-11)]",
    pending: "bg-[color-mix(in_srgb,var(--yellow-11)_16%,transparent)] text-[var(--yellow-11)]",
  };
  return (
    <span className={`px-1.5 py-0.5 rounded-sm text-xs font-medium ${styles[status]}`}>
      {status}
    </span>
  );
}

function FindingsCountBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span
      title={`${count} advisory finding${count === 1 ? "" : "s"}`}
      className="px-1.5 py-0.5 rounded-sm text-xs font-medium shrink-0 bg-[var(--gray-03)] text-[var(--gray-11)]"
    >
      {count} finding{count === 1 ? "" : "s"}
    </span>
  );
}

function GateSubRow({
  gate,
  workspaceId,
}: {
  gate: ReviewGate;
  workspaceId: string;
}) {
  const findings = gate.findings ?? [];
  return (
    <div className="space-y-3">
      {gate.conditions.length > 0 && (
        <div>
          {/* font-normal: a field label above one block of data, not a
              heading — matches run-detail-header.tsx's unweighted field
              labels. Applies to every field label of this shape below. */}
          <p className="text-xs font-normal uppercase tracking-wide text-[var(--gray-09)] mb-1">
            Criteria checked
          </p>
          <div className="space-y-1.5">
            {gate.conditions.map((cond, i) => (
              <div
                key={i}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-3 py-2"
              >
                {Object.entries(cond).map(([k, v]) => (
                  <span key={k} className="text-xs">
                    <span className="text-[var(--gray-09)]">{k}: </span>
                    <span className="font-mono text-[var(--gray-12)]">
                      {typeof v === "object" ? JSON.stringify(v) : String(v)}
                    </span>
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {gate.blockingReasons.length > 0 && (
        <div>
          <p className="text-xs font-normal uppercase tracking-wide text-[var(--gray-09)] mb-1">
            Why merge was blocked
          </p>
          <ul className="space-y-1">
            {gate.blockingReasons.map((reason, i) => {
              const label = blockingReasonLabel(reason);
              const severity = blockingReasonSeverity(reason);
              return (
                <li
                  key={i}
                  className="text-xs font-mono text-[var(--red-11)] flex items-start gap-1.5"
                >
                  <span className="mt-0.5 shrink-0">✕</span>
                  <span className="flex-1">{label}</span>
                  {severity && (
                    // text-xs + px-1.5 (not the ad-hoc 10px/px-1): matches
                    // the canonical Status Badge scale and padding used by
                    // every other badge in this codebase — px-1 fell under
                    // the 8px cramped-padding floor.
                    <span className="shrink-0 px-1.5 py-0.5 rounded text-xs font-medium bg-[color-mix(in_srgb,var(--red-11)_12%,transparent)] text-[var(--red-11)]">
                      {severity}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {gate.evidenceRefs.length > 0 && (
        <div>
          <p className="text-xs font-normal uppercase tracking-wide text-[var(--gray-09)] mb-1">
            Evidence
          </p>
          <div className="flex flex-wrap gap-2">
            {gate.evidenceRefs.map((ref, i) => (
              <a
                key={i}
                href={ref.url}
                className="text-xs text-[var(--blue-11)] hover:underline font-mono"
              >
                {ref.label} →
              </a>
            ))}
          </div>
        </div>
      )}

      {findings.length > 0 && (
        <div>
          <p className="text-xs font-normal uppercase tracking-wide text-[var(--gray-09)] mb-1">
            Findings
          </p>
          <ul className="space-y-1">
            {findings.map((f, i) => (
              <li key={i} className="text-xs text-[var(--gray-11)] flex items-start justify-between gap-3">
                <span className="flex items-start gap-1.5 min-w-0">
                  <span
                    className={`mt-0.5 shrink-0 font-mono ${
                      f.severity === "critical"
                        ? "text-[var(--red-11)]"
                        : f.severity === "major"
                        ? "text-[var(--orange-11)]"
                        : "text-[var(--yellow-11)]"
                    }`}
                  >
                    [{f.severity}]
                  </span>
                  <span>{f.description}</span>
                </span>
                <span className="shrink-0">
                  <CreateIssueButton
                    workspaceId={workspaceId}
                    gateId={gate.id}
                    findingIndex={i}
                  />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {gate.evaluatedAt && (
        <p className="text-xs text-[var(--gray-09)]" title={relTime(gate.evaluatedAt).title}>
          Evaluated {relTime(gate.evaluatedAt).label}
        </p>
      )}

      <div className="flex gap-3 pt-1">
        <a
          href={`/dashboard/${workspaceId}/runs/${gate.runId}`}
          className="text-xs text-[var(--blue-11)] hover:underline"
        >
          View run →
        </a>
        <a
          href={`/dashboard/${workspaceId}/review-gates/${gate.id}`}
          className="text-xs text-[var(--blue-11)] hover:underline"
        >
          Gate detail →
        </a>
      </div>
    </div>
  );
}

function buildColumns(): ColumnDef<ReviewGate, unknown>[] {
  return [
    {
      id: "status",
      header: "Status",
      accessorKey: "status",
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
      enableSorting: true,
    },
    {
      id: "gate",
      header: "Gate",
      accessorKey: "gateName",
      cell: ({ row }) => (
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm text-[var(--gray-12)] truncate">
            {row.original.gateName}
          </span>
          <span className="font-mono text-xs text-[var(--gray-09)] shrink-0">
            run:{row.original.runId.slice(0, 8)}
          </span>
        </div>
      ),
      enableSorting: true,
    },
    {
      id: "findings",
      header: "Findings",
      accessorFn: (row) => row.findings?.length ?? 0,
      cell: ({ row }) => (
        <FindingsCountBadge count={row.original.findings?.length ?? 0} />
      ),
      enableSorting: true,
    },
    {
      id: "evaluated",
      header: "Evaluated",
      accessorKey: "evaluatedAt",
      meta: { mono: true },
      cell: ({ row }) =>
        row.original.evaluatedAt ? (
          // No font-mono/size override needed here: this column already
          // declares meta: { mono: true } above, so DataTable's shared <td>
          // (apps/console/app/(dashboard)/components/data-table.tsx) already
          // applies "font-mono text-[13px]" — TASTE.md's literal mono-data
          // scale token. The old text-[13px] on this span was a redundant,
          // ad-hoc duplicate of that; dropping it lets the cell inherit
          // cleanly instead of re-asserting the same value two ways.
          <span className="text-[var(--gray-09)]" title={relTime(row.original.evaluatedAt).title}>
            {relTime(row.original.evaluatedAt).label}
          </span>
        ) : (
          <span className="text-[var(--gray-07)]">—</span>
        ),
      enableSorting: true,
    },
  ] satisfies ColumnDef<ReviewGate, unknown>[];
}

export default function ReviewGatesPage() {
  const params = useParams<{ workspaceId: string }>();
  const searchParams = useSearchParams();
  const { workspaceId } = params;
  const runIdFilter = searchParams.get("runId") ?? "";

  const [gates, setGates] = useState<ReviewGate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runIdInput, setRunIdInput] = useState(runIdFilter);

  const load = useCallback(
    async (runId: string) => {
      setLoading(true);
      setError(null);
      try {
        const url = runId
          ? `/api/v1/workspaces/${workspaceId}/review-gates?runId=${encodeURIComponent(runId)}`
          : `/api/v1/workspaces/${workspaceId}/review-gates`;
        const res = await fetch(url);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            (body as { error?: string }).error ?? `HTTP ${res.status}`
          );
        }
        const json = (await res.json()) as { gates: ReviewGate[] };
        setGates(json.gates);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load review gates");
      } finally {
        setLoading(false);
      }
    },
    [workspaceId]
  );

  useEffect(() => {
    load(runIdFilter);
  }, [load, runIdFilter]);

  function handleFilter(e: React.FormEvent) {
    e.preventDefault();
    const url = new URL(window.location.href);
    if (runIdInput) {
      url.searchParams.set("runId", runIdInput);
    } else {
      url.searchParams.delete("runId");
    }
    window.history.pushState({}, "", url.toString());
    load(runIdInput);
  }

  const columns = useMemo(() => buildColumns(), []);

  const stats = useMemo(() => {
    const passed = gates.filter((g) => g.status === "passed").length;
    const failed = gates.filter((g) => g.status === "failed").length;
    const pending = gates.filter((g) => g.status === "pending").length;
    return [
      { label: "Passed", value: passed, color: "green" as const },
      { label: "Failed", value: failed, color: "red" as const },
      { label: "Pending", value: pending, color: "yellow" as const },
    ].filter((s) => s.value > 0);
  }, [gates]);

  const emptyMessage = runIdFilter
    ? "No review gates found for this run."
    : "No review gates recorded yet.";

  const filterBar = (
    <form onSubmit={handleFilter} className="flex items-center gap-2">
      <input
        type="text"
        value={runIdInput}
        onChange={(e) => setRunIdInput(e.target.value)}
        placeholder="Filter by run ID…"
        className="h-8 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-3 text-sm font-mono text-[var(--gray-12)] placeholder-[var(--gray-08)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-text)] focus:ring-offset-2 focus:ring-offset-[var(--gray-00)]"
        style={{ minWidth: "260px" }}
      />
      <button
        type="submit"
        className="h-8 px-3 rounded border border-[var(--gray-06)] bg-[var(--gray-03)] text-sm text-[var(--gray-12)] hover:bg-[var(--gray-04)] transition-colors"
      >
        Filter
      </button>
      {runIdFilter && (
        <a
          href={`/dashboard/${workspaceId}/review-gates`}
          className="text-xs text-[var(--gray-09)] hover:text-[var(--gray-11)] transition-colors"
        >
          Clear
        </a>
      )}
    </form>
  );

  return (
    <div className="mx-auto max-w-[1440px] flex flex-col gap-4">
      <div>
        <h1 className="text-sm font-bold text-[var(--gray-12)]">
          Review Gates
        </h1>
        <p className="mt-1 text-xs text-[var(--gray-09)]">
          The evidence that decided whether each of Jace&apos;s changes was
          safe to merge.
        </p>
      </div>

      {loading ? (
        <LoadingState variant="list" rows={8} />
      ) : error ? (
        <ErrorState message={error} onRetry={() => load(runIdFilter)} />
      ) : gates.length === 0 ? (
        <>
          {filterBar}
          <EmptyState message={emptyMessage} />
        </>
      ) : (
        <>
          <StatHeader stats={stats} />
          <DataTable
            columns={columns}
            data={gates}
            filterBar={filterBar}
            rowKey={(gate) => gate.id}
            renderSubRow={(gate) => (
              <GateSubRow gate={gate} workspaceId={workspaceId} />
            )}
            emptyMessage={emptyMessage}
          />
        </>
      )}
    </div>
  );
}
