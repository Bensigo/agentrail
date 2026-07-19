"use client";

import { useEffect, useState } from "react";
import { SkeletonTableRows } from "../../../../../components/loading-skeleton";
import type { TimeRange } from "./cost-filters";
import {
  buildMeterUrl,
  deriveAgentRow,
  normalizeAgentBreakdown,
  type AgentBreakdownEntry,
  type AgentBreakdownRow,
} from "./agent-breakdown-helpers";

interface AgentBreakdownProps {
  workspaceId: string;
  timeRange: TimeRange;
}

const COLUMNS = 3; // Agent, Cost, Events

export function AgentBreakdown({ workspaceId, timeRange }: AgentBreakdownProps) {
  const [rows, setRows] = useState<AgentBreakdownRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const url = buildMeterUrl({
          workspaceId,
          timeRange,
          origin: window.location.origin,
        });
        const res = await fetch(url);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            (body as { error?: string }).error ?? `HTTP ${res.status}`
          );
        }
        const json = (await res.json()) as {
          agentBreakdown?: AgentBreakdownEntry[];
        };
        if (active) {
          const normalized = normalizeAgentBreakdown(json.agentBreakdown ?? []);
          setRows(normalized.map(deriveAgentRow));
        }
      } catch (e) {
        if (active) {
          setRows([]);
          setError(
            e instanceof Error ? e.message : "Failed to load agent breakdown"
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

  return (
    <section className="flex flex-col gap-3">
      {/* Panel heading, not a th — bold per TASTE weight rule */}
      <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">
        Agent breakdown
      </h2>

      <div className="rounded border border-[var(--gray-05)] overflow-hidden">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-[var(--gray-05)] bg-[var(--gray-01)]">
              {["Agent", "Cost", "Events"].map((header) => (
                <th
                  key={header}
                  className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]"
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <SkeletonTableRows columns={COLUMNS} rows={3} />
            ) : error ? (
              <tr>
                <td
                  colSpan={COLUMNS}
                  className="px-3 py-6 text-center text-sm text-[var(--red-11)]"
                >
                  Agent breakdown unavailable
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={row.agent}
                  className="border-b border-[var(--gray-04)] last:border-b-0"
                  style={{ height: "34px" }}
                >
                  <td className="px-3 py-1.5">
                    <span
                      className={`font-mono text-xs ${
                        row.muted
                          ? "text-[var(--gray-09)]"
                          : "text-[var(--gray-12)]"
                      }`}
                    >
                      {row.agent}
                    </span>
                  </td>
                  <td className="px-3 py-1.5">
                    <span
                      className={`font-mono text-xs ${
                        row.muted
                          ? "text-[var(--gray-09)]"
                          : "text-[var(--gray-12)] font-normal" /* data value; color carries emphasis */
                      }`}
                    >
                      {row.cost}
                    </span>
                  </td>
                  <td className="px-3 py-1.5">
                    <span
                      className={`font-mono text-xs ${
                        row.muted
                          ? "text-[var(--gray-09)]"
                          : "text-[var(--gray-10)]"
                      }`}
                    >
                      {row.eventCount === 0 ? "—" : row.eventCount.toLocaleString()}
                    </span>
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
