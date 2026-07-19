"use client";

import { useEffect, useState } from "react";
import { Skeleton } from "../../../../../components/loading-skeleton";
import type { TimeRange } from "./cost-filters";
import {
  EMPTY_STATE_COPY,
  buildMeterUrl,
  formatCacheRatio,
  formatCostUsd,
  formatTokens,
  resolveMeterState,
  type CostMeterData,
} from "./cost-meter-panel-helpers";

interface CostMeterPanelProps {
  workspaceId: string;
  timeRange: TimeRange;
}

/**
 * Falsifiable cost surface (M033 / ADR 0009). Shows Cost-per-Issue-to-Green
 * (the headline cost metric — total spend to take one issue to a passing
 * Objective Gate) and the cache read-to-creation ratio. Both can come back
 * negative/below target, which is why they replace the removed one-sided
 * "savings" widget.
 */
export function CostMeterPanel({ workspaceId, timeRange }: CostMeterPanelProps) {
  const [data, setData] = useState<CostMeterData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          buildMeterUrl({ workspaceId, timeRange, origin: window.location.origin })
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
        }
        const json = (await res.json()) as CostMeterData;
        if (active) setData(json);
      } catch (e) {
        if (active) {
          setData(null);
          setError(e instanceof Error ? e.message : "Failed to load cost meter");
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

  const state = resolveMeterState({ loading, error, data });

  return (
    <section className="flex flex-col gap-3">
      {/* Panel heading, not a th — bold per TASTE weight rule */}
      <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">
        Cost meter
      </h2>

      <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-4 py-3">
        {state === "loading" && (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
        )}

        {state === "error" && (
          <p className="font-mono text-xs text-[var(--red-11)]">{error}</p>
        )}

        {state === "empty" && (
          <p className="font-mono text-xs text-[var(--gray-09)]">
            {EMPTY_STATE_COPY}
          </p>
        )}

        {state === "data" && data && (
          <div className="flex flex-col gap-4">
            {/* Headline metric row: two dense stat tiles. */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {/* Cost-per-Issue-to-Green */}
              <div className="flex flex-col gap-1 border-l-2 border-[var(--yellow-09)] pl-3">
                {/* stat label caption, not heading/data → normal, no room constraint at 12px */}
                <span className="text-xs font-normal uppercase tracking-wide text-[var(--gray-09)]">
                  Cost-per-Issue-to-Green
                </span>
                <span className="font-mono text-2xl font-bold leading-none text-[var(--gray-12)]">
                  {data.costPerIssueToGreen.avgCostUsd === null
                    ? "—"
                    : formatCostUsd(data.costPerIssueToGreen.avgCostUsd)}
                </span>
                <span className="font-mono text-xs text-[var(--gray-09)]">
                  avg over {data.costPerIssueToGreen.greenIssueCount}{" "}
                  {data.costPerIssueToGreen.greenIssueCount === 1
                    ? "green issue"
                    : "green issues"}
                </span>
              </div>

              {/* Cache read-to-creation ratio */}
              <div className="flex flex-col gap-1 border-l-2 border-[var(--gray-06)] pl-3">
                {/* stat label caption, not heading/data → normal, no room constraint at 12px */}
                <span className="text-xs font-normal uppercase tracking-wide text-[var(--gray-09)]">
                  Cache read-to-creation ratio
                </span>
                <span
                  className={`font-mono text-2xl font-bold leading-none ${
                    data.cacheRatio.ratio !== null && data.cacheRatio.ratio < 1
                      ? "text-[var(--red-11)]"
                      : "text-[var(--gray-12)]"
                  }`}
                >
                  {formatCacheRatio(data.cacheRatio.ratio)}
                </span>
                <span className="font-mono text-xs text-[var(--gray-09)]">
                  {formatTokens(data.cacheRatio.cacheReadTokens)} read /{" "}
                  {formatTokens(data.cacheRatio.cacheCreationTokens)} created
                </span>
              </div>
            </div>

            {/* Per-issue drilldown — densest evidence of where cost went. */}
            {data.costPerIssueToGreen.issues.length > 0 && (
              <div className="rounded border border-[var(--gray-05)] overflow-hidden">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="border-b border-[var(--gray-05)] bg-[var(--gray-01)]">
                      <th className="px-3 py-1.5 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                        Issue (branch)
                      </th>
                      <th className="px-3 py-1.5 text-right text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                        Cost to Green
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.costPerIssueToGreen.issues.slice(0, 10).map((issue) => (
                      <tr
                        key={issue.issueKey}
                        className="border-b border-[var(--gray-04)] last:border-b-0"
                        style={{ height: "30px" }}
                      >
                        <td className="px-3 py-1 font-mono text-xs text-[var(--gray-11)] truncate max-w-[280px]">
                          {issue.issueKey}
                        </td>
                        {/* data value; color carries emphasis, not weight */}
                        <td className="px-3 py-1 text-right font-mono text-xs font-normal text-[var(--gray-12)]">
                          {formatCostUsd(issue.costUsd)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
