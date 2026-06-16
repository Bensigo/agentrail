"use client";

import { useEffect, useState } from "react";
import { Skeleton } from "../../../../../components/loading-skeleton";
import {
  ACCEPT_RATE_HEALTH_LINE,
  formatRate,
  resolveHealthState,
  type HealthData,
} from "./health-panel-helpers";

interface HealthRatesPanelProps {
  workspaceId: string;
}

const EMPTY_COPY = "No issue has reached a Run Outcome terminal yet";

/**
 * Falsifiable system-health surface (M034 / ADR 0009). Shows accept rate
 * (green ÷ attempted) against the > 50% health line and escalation rate
 * (escalated ÷ attempted). Both can come back below target — a losing loop
 * shows an accept rate under the 50% line, rendered in red — which is why they
 * obey the console display rule (no metric that cannot come back negative).
 */
export function HealthRatesPanel({ workspaceId }: HealthRatesPanelProps) {
  const [data, setData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/v1/workspaces/${workspaceId}/health/rates`
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
        }
        const json = (await res.json()) as HealthData;
        if (active) setData(json);
      } catch (e) {
        if (active) {
          setData(null);
          setError(e instanceof Error ? e.message : "Failed to load health rates");
        }
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => {
      active = false;
    };
  }, [workspaceId]);

  const state = resolveHealthState({ loading, error, data });
  const rates = data?.rates;
  const acceptPct =
    rates?.acceptRate !== null && rates?.acceptRate !== undefined
      ? Math.max(0, Math.min(1, rates.acceptRate)) * 100
      : 0;
  const linePct = ACCEPT_RATE_HEALTH_LINE * 100;
  const below = rates?.belowHealthLine ?? false;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
        System health
      </h2>

      <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-4 py-3">
        {state === "loading" && (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
        )}

        {state === "error" && (
          <p className="font-mono text-xs text-[#ff9592]">{error}</p>
        )}

        {state === "empty" && (
          <p className="font-mono text-xs text-[var(--gray-09)]">{EMPTY_COPY}</p>
        )}

        {state === "data" && rates && (
          <div className="flex flex-col gap-4">
            {/* Headline rate tiles. */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {/* Accept rate — falsifiable against the 50% health line. */}
              <div
                className={`flex flex-col gap-1 border-l-2 pl-3 ${
                  below ? "border-[#ff9592]" : "border-[#46a758]"
                }`}
              >
                <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--gray-09)]">
                  Accept rate
                </span>
                <span
                  className={`font-mono text-2xl font-semibold leading-none ${
                    below ? "text-[#ff9592]" : "text-[var(--gray-12)]"
                  }`}
                >
                  {formatRate(rates.acceptRate)}
                </span>
                <span className="font-mono text-[11px] text-[var(--gray-09)]">
                  {rates.green} green / {rates.attempted} attempted
                  {below ? " · below 50% line" : ""}
                </span>
              </div>

              {/* Escalation rate. */}
              <div className="flex flex-col gap-1 border-l-2 border-[var(--gray-06)] pl-3">
                <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--gray-09)]">
                  Escalation rate
                </span>
                <span className="font-mono text-2xl font-semibold leading-none text-[var(--gray-12)]">
                  {formatRate(rates.escalationRate)}
                </span>
                <span className="font-mono text-[11px] text-[var(--gray-09)]">
                  {rates.escalated} escalated to human / {rates.attempted} attempted
                </span>
              </div>
            </div>

            {/* Accept-rate bar with the 50% health-line marker. */}
            <div className="flex flex-col gap-1">
              <div className="relative h-2.5 w-full overflow-hidden rounded-sm bg-[var(--gray-04)]">
                <div
                  className={`h-full ${below ? "bg-[#ff9592]" : "bg-[#46a758]"}`}
                  style={{ width: `${acceptPct}%` }}
                  aria-hidden="true"
                />
                {/* The > 50% health-line reference marker. */}
                <div
                  className="absolute top-0 h-full w-px bg-[var(--gray-12)]"
                  style={{ left: `${linePct}%` }}
                  aria-hidden="true"
                />
              </div>
              <span className="font-mono text-[10px] text-[var(--gray-09)]">
                Health line: accept rate &gt; 50% is winning; below is losing
              </span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
