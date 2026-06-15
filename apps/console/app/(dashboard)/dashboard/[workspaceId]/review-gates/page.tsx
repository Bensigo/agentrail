"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { type ColumnDef } from "@tanstack/react-table";
import { DataTable } from "../../../components/data-table";
import { StatHeader } from "../../../components/stat-header";
import { EmptyState } from "../../../components/empty-state";
import { ErrorState } from "../../../components/error-state";
import { LoadingState } from "../../../components/loading-state";

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
  blockingReasons: string[];
  evidenceRefs: EvidenceRef[];
  findings: ReviewGateFinding[] | null;
  evaluatedAt: string | null;
}

function StatusBadge({ status }: { status: ReviewGate["status"] }) {
  const styles: Record<ReviewGate["status"], string> = {
    passed: "bg-[#1a3d33] text-[#1fd8a4]",
    failed: "bg-[#3d1a1a] text-[#ff9592]",
    pending: "bg-[#3d3a1a] text-[#f5e147]",
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
      title={`${count} bug${count === 1 ? "" : "s"} found`}
      className="px-1.5 py-0.5 rounded-sm text-xs font-medium shrink-0 bg-[#3d1a1a] text-[#ff9592]"
    >
      {count} bug{count === 1 ? "" : "s"}
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
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--gray-09)] mb-1">
            Conditions
          </p>
          <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-3 overflow-x-auto">
            <pre className="text-xs font-mono text-[var(--gray-11)] whitespace-pre-wrap break-words">
              {JSON.stringify(gate.conditions, null, 2)}
            </pre>
          </div>
        </div>
      )}

      {gate.blockingReasons.length > 0 && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--gray-09)] mb-1">
            Blocking reasons
          </p>
          <ul className="space-y-1">
            {gate.blockingReasons.map((reason, i) => (
              <li
                key={i}
                className="text-xs font-mono text-[#ff9592] flex items-start gap-1.5"
              >
                <span className="mt-0.5 shrink-0">✕</span>
                <span>{reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {gate.evidenceRefs.length > 0 && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--gray-09)] mb-1">
            Evidence
          </p>
          <div className="flex flex-wrap gap-2">
            {gate.evidenceRefs.map((ref, i) => (
              <a
                key={i}
                href={ref.url}
                className="text-xs text-[#70b8ff] hover:underline font-mono"
              >
                {ref.label} →
              </a>
            ))}
          </div>
        </div>
      )}

      {findings.length > 0 && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--gray-09)] mb-1">
            Findings
          </p>
          <ul className="space-y-1">
            {findings.map((f, i) => (
              <li key={i} className="text-xs text-[var(--gray-11)] flex items-start gap-1.5">
                <span
                  className={`mt-0.5 shrink-0 font-mono ${
                    f.severity === "critical"
                      ? "text-[#ff9592]"
                      : f.severity === "major"
                      ? "text-[#ffa057]"
                      : "text-[#f5e147]"
                  }`}
                >
                  [{f.severity}]
                </span>
                <span>{f.description}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {gate.evaluatedAt && (
        <p className="text-xs font-mono text-[var(--gray-09)]">
          Evaluated:{" "}
          {new Date(gate.evaluatedAt).toLocaleString("en-US", {
            month: "short",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
          })}
        </p>
      )}

      <div className="flex gap-3 pt-1">
        <a
          href={`/dashboard/${workspaceId}/runs/${gate.runId}`}
          className="text-xs text-[#70b8ff] hover:underline"
        >
          View run →
        </a>
        <a
          href={`/dashboard/${workspaceId}/review-gates/${gate.id}`}
          className="text-xs text-[#70b8ff] hover:underline"
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
          <span className="font-mono text-[13px] text-[var(--gray-09)]">
            {new Date(row.original.evaluatedAt).toLocaleString("en-US", {
              month: "short",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            })}
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
        className="h-8 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-3 text-sm font-mono text-[var(--gray-12)] placeholder-[var(--gray-08)] focus:outline-none focus:ring-2 focus:ring-[#ffe629] focus:ring-offset-2 focus:ring-offset-[var(--gray-00)]"
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
      <h1 className="text-sm font-semibold text-[var(--gray-12)]">
        Review Gates
      </h1>

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
