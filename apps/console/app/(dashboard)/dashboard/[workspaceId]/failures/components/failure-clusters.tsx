"use client";

import { useCallback, useEffect, useState } from "react";
import { createColumnHelper, type ColumnDef } from "@tanstack/react-table";
import { DataTable } from "../../../../components/data-table";
import { StatHeader } from "../../../../components/stat-header";
import {
  buildRunDetailHref,
  formatClusterTime,
  truncateFingerprint,
} from "./failure-clusters.helpers";

export interface FailureCluster {
  fingerprint: string;
  phase: string;
  failure_type: string;
  count: number;
  first_seen: string;
  last_seen: string;
  run_ids: string[];
}

interface FailureClustersProps {
  workspaceId: string;
}

function FailureTypeBadge({ value }: { value: string }) {
  return (
    <span className="inline-flex items-center rounded-sm border border-[#e5484d]/30 bg-[#e5484d]/20 px-1.5 py-0.5 text-xs font-medium text-[#ff9592]">
      {value || "failure"}
    </span>
  );
}

const columnHelper = createColumnHelper<FailureCluster>();

const columns: ColumnDef<FailureCluster, unknown>[] = [
  columnHelper.accessor("fingerprint", {
    header: "Fingerprint",
    meta: { mono: true },
    cell: (info) => (
      <span
        className="block max-w-[280px] truncate text-[var(--gray-12)]"
        title={info.getValue()}
      >
        {truncateFingerprint(info.getValue() || "unfingerprinted")}
      </span>
    ),
  }),
  columnHelper.accessor("phase", {
    header: "Phase",
    meta: { mono: true },
    cell: (info) => (
      <span className="text-[var(--gray-10)]">{info.getValue() || "-"}</span>
    ),
  }),
  columnHelper.accessor("failure_type", {
    header: "Type",
    cell: (info) => <FailureTypeBadge value={info.getValue()} />,
  }),
  columnHelper.accessor("count", {
    header: "Count",
    meta: { mono: true },
    cell: (info) => (
      <span className="text-[var(--gray-12)]">{info.getValue()}</span>
    ),
  }),
  columnHelper.accessor("first_seen", {
    header: "First Seen",
    meta: { mono: true },
    cell: (info) => (
      <span className="text-[var(--gray-10)]">
        {formatClusterTime(info.getValue())}
      </span>
    ),
  }),
  columnHelper.accessor("last_seen", {
    header: "Last Seen",
    meta: { mono: true },
    cell: (info) => (
      <span className="text-[var(--gray-10)]">
        {formatClusterTime(info.getValue())}
      </span>
    ),
  }),
] as ColumnDef<FailureCluster, unknown>[];

export function FailureClusters({ workspaceId }: FailureClustersProps) {
  const [clusters, setClusters] = useState<FailureCluster[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchClusters = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/workspaces/${workspaceId}/failures/clusters`
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as FailureCluster[];
      setClusters(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load clusters");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchClusters();
  }, [fetchClusters]);

  const totalFailures = clusters.reduce((sum, c) => sum + c.count, 0);

  return (
    <section className="mb-6">
      <h2 className="mb-3 text-sm font-semibold text-[var(--gray-12)]">
        Failure Clusters
      </h2>
      {!loading && !error && (
        <div className="mb-3">
          <StatHeader
            stats={[
              { label: "Clusters", value: clusters.length },
              { label: "Total failures", value: totalFailures, color: "red" },
            ]}
          />
        </div>
      )}
      <DataTable
        columns={columns}
        data={clusters}
        loading={loading}
        error={error}
        emptyMessage="No failure clusters found."
        rowKey={(c) => `${c.fingerprint}:${c.phase}:${c.failure_type}`}
        renderSubRow={(c) => (
          <div className="flex flex-wrap gap-2">
            {c.run_ids.map((runId) => (
              <a
                key={runId}
                href={buildRunDetailHref(workspaceId, runId)}
                className="font-mono text-xs text-[#70b8ff] underline-offset-2 hover:text-[#ffe629] hover:underline"
              >
                {runId}
              </a>
            ))}
          </div>
        )}
        onRetry={fetchClusters}
        skeletonRows={4}
      />
    </section>
  );
}
