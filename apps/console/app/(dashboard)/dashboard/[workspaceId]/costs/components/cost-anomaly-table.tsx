"use client";

import { useEffect, useState } from "react";
import { SkeletonTableRows } from "../../../../../components/loading-skeleton";
import type { TimeRange } from "./cost-filters";
import {
  buildCostAnomaliesUrl,
  formatBaselineLabel,
  formatCostUsd,
  formatDeviationSigma,
  type CostAnomalyRow,
} from "./cost-anomaly-helpers";

interface CostAnomalyTableProps {
  workspaceId: string;
  timeRange: TimeRange;
}

function fmtTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso || "—";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function CostAnomalyTable({
  workspaceId,
  timeRange,
}: CostAnomalyTableProps) {
  const [rows, setRows] = useState<CostAnomalyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          buildCostAnomaliesUrl({
            workspaceId,
            timeRange,
            origin: window.location.origin,
          })
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            (body as { error?: string }).error ?? `HTTP ${res.status}`
          );
        }
        const json = (await res.json()) as { anomalies?: CostAnomalyRow[] };
        if (active) setRows(json.anomalies ?? []);
      } catch (e) {
        if (active) {
          setRows([]);
          setError(
            e instanceof Error ? e.message : "Failed to load cost anomalies"
          );
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    load();
    return () => {
      active = false;
    };
  }, [workspaceId, timeRange]);

  const baseline = rows[0] ? formatBaselineLabel(rows[0]) : null;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
          Cost anomalies
        </h2>
        {baseline && (
          <div className="flex min-w-[280px] items-center gap-2 text-xs text-[var(--gray-10)]">
            <span className="h-px flex-1 border-t border-dashed border-[var(--yellow-09)]/60" />
            <span className="font-mono">{baseline}</span>
          </div>
        )}
      </div>

      <div className="rounded border border-[var(--gray-05)] overflow-hidden">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-[var(--gray-05)] bg-[var(--gray-01)]">
              {["Run", "Model", "Phase", "Repository", "Cost (USD)", "Deviation (σ)", "Time"].map(
                (header) => (
                  <th
                    key={header}
                    className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]"
                  >
                    {header}
                  </th>
                )
              )}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <SkeletonTableRows columns={7} rows={5} />
            ) : error ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-3 py-8 text-center text-sm text-[var(--red-11)]"
                >
                  Cost anomalies unavailable
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-3 py-8 text-center text-sm text-[var(--gray-09)]"
                >
                  No cost anomalies in this period
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={`${row.run_id}:${row.occurred_at}`}
                  className="border-b border-[var(--gray-04)] hover:bg-[var(--gray-02)] transition-colors"
                  style={{ height: "34px" }}
                >
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-2">
                      <span className="rounded-sm bg-[var(--orange-09)]/[12.157%] px-1.5 py-0.5 text-xs font-medium text-[var(--orange-09)]">
                        Anomaly
                      </span>
                      <a
                        href={`/dashboard/${workspaceId}/runs/${row.run_id}`}
                        className="font-mono text-xs text-[var(--blue-11)] hover:underline"
                      >
                        {row.run_id}
                      </a>
                    </div>
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs text-[var(--gray-11)]">
                    {row.model || "—"}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs text-[var(--gray-11)]">
                    {row.phase || "—"}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs text-[var(--gray-11)]">
                    {row.repository_id || "—"}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs font-medium text-[var(--gray-12)]">
                    {formatCostUsd(row.cost_usd)}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs font-medium text-[var(--orange-09)]">
                    {formatDeviationSigma(row.deviation_sigmas)}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs text-[var(--gray-10)]">
                    {fmtTime(row.occurred_at)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
