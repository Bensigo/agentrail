"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { SkeletonTableRows } from "../../../../../components/loading-skeleton";
import {
  buildRunDetailHref,
  formatClusterTime,
  truncateFingerprint,
} from "./failure-clusters.helpers";

export interface FailureCluster {
  fingerprint: string;
  /** Representative error message for the cluster — the human-readable cause. */
  sample_message: string;
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
    <span className="inline-flex min-w-[112px] items-center justify-center rounded-sm border border-[var(--red-09)]/30 bg-[var(--red-09)]/20 px-1.5 py-0.5 text-xs font-medium text-[var(--red-11)]">
      {value || "failure"}
    </span>
  );
}

export function FailureClusters({ workspaceId }: FailureClustersProps) {
  const [clusters, setClusters] = useState<FailureCluster[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
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

  return (
    <section className="mb-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--gray-12)]">
          Failure Clusters
        </h2>
        <span className="font-mono text-xs text-[var(--gray-09)]">
          {clusters.length} clusters
        </span>
      </div>
      <div className="overflow-hidden rounded border border-[var(--gray-05)]">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-[var(--gray-05)] bg-[var(--gray-01)]">
              <th className="w-8 px-2 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]" />
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                Cause
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                Phase
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                Type
              </th>
              <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                Count
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                First Seen
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                Last Seen
              </th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <SkeletonTableRows columns={7} rows={4} />
            ) : error ? (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-sm text-[var(--red-11)]">
                  {error}
                </td>
              </tr>
            ) : clusters.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-sm text-[var(--gray-09)]">
                  No failure clusters found
                </td>
              </tr>
            ) : (
              clusters.map((cluster) => {
                const key = `${cluster.fingerprint}:${cluster.phase}:${cluster.failure_type}`;
                const isExpanded = expanded === key;
                return (
                  <Fragment key={key}>
                    <tr
                      className="border-b border-[var(--gray-04)] hover:bg-[var(--gray-02)]"
                      style={{ height: "34px" }}
                    >
                      <td className="px-2 py-1.5">
                        <button
                          type="button"
                          aria-label={isExpanded ? "Collapse cluster" : "Expand cluster"}
                          onClick={() => setExpanded(isExpanded ? null : key)}
                          className="flex h-6 w-6 items-center justify-center rounded text-[var(--gray-10)] hover:bg-[var(--gray-03)] hover:text-[var(--gray-12)]"
                        >
                          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                      </td>
                      <td className="px-3 py-1.5">
                        <span
                          className="block max-w-[360px] truncate text-xs text-[var(--gray-12)]"
                          title={
                            cluster.fingerprint
                              ? `${cluster.sample_message}\n\nfingerprint: ${cluster.fingerprint}`
                              : cluster.sample_message
                          }
                        >
                          {cluster.sample_message ||
                            truncateFingerprint(
                              cluster.fingerprint || "Unknown cause"
                            )}
                        </span>
                      </td>
                      <td className="px-3 py-1.5">
                        <span className="font-mono text-xs text-[var(--gray-10)]">
                          {cluster.phase || "-"}
                        </span>
                      </td>
                      <td className="px-3 py-1.5">
                        <FailureTypeBadge value={cluster.failure_type} />
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <span className="font-mono text-xs text-[var(--gray-12)]">
                          {cluster.count}
                        </span>
                      </td>
                      <td className="px-3 py-1.5">
                        <span className="font-mono text-xs text-[var(--gray-10)]">
                          {formatClusterTime(cluster.first_seen)}
                        </span>
                      </td>
                      <td className="px-3 py-1.5">
                        <span className="font-mono text-xs text-[var(--gray-10)]">
                          {formatClusterTime(cluster.last_seen)}
                        </span>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="border-b border-[var(--gray-04)] bg-[var(--gray-01)]">
                        <td />
                        <td colSpan={6} className="px-3 py-2">
                          <div className="flex flex-wrap gap-2">
                            {cluster.run_ids.map((runId) => (
                              <a
                                key={runId}
                                href={buildRunDetailHref(workspaceId, runId)}
                                className="font-mono text-xs text-[var(--gray-11)] underline-offset-2 hover:text-[var(--yellow-09)] hover:underline"
                              >
                                {runId}
                              </a>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
