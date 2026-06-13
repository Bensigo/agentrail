"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Skeleton } from "../../../../../../components/loading-skeleton";

export const TELEMETRY_HEALTH_SIGNALS = [
  "run_start",
  "context_pack",
  "cost_event",
  "review_gate",
  "failure_event",
  "memory_items",
  "index_snapshot",
  "outbox_flush",
] as const;

export type TelemetryHealthSignalName =
  (typeof TELEMETRY_HEALTH_SIGNALS)[number];

export interface TelemetryHealthSignal {
  signal: TelemetryHealthSignalName;
  present: boolean;
  missing_since: string | null;
}

interface TelemetryHealthResponse {
  signals?: TelemetryHealthSignal[];
}

interface TelemetryHealthSectionProps {
  workspaceId: string;
  runId: string;
}

const PRESENT_BADGE_STYLE = {
  backgroundColor: "rgba(41, 163, 131, 0.12)",
  borderColor: "rgba(41, 163, 131, 0.35)",
  color: "#29a383",
};

const MISSING_BADGE_STYLE = {
  backgroundColor: "rgba(229, 72, 77, 0.12)",
  borderColor: "rgba(229, 72, 77, 0.35)",
  color: "#e5484d",
};

function isSignalName(value: string): value is TelemetryHealthSignalName {
  return TELEMETRY_HEALTH_SIGNALS.includes(
    value as TelemetryHealthSignalName
  );
}

function normalizeSignals(
  signals: TelemetryHealthResponse["signals"]
): TelemetryHealthSignal[] {
  const bySignal = new Map<TelemetryHealthSignalName, TelemetryHealthSignal>();

  for (const row of signals ?? []) {
    if (isSignalName(row.signal)) {
      bySignal.set(row.signal, {
        signal: row.signal,
        present: Boolean(row.present),
        missing_since: row.missing_since ?? null,
      });
    }
  }

  return TELEMETRY_HEALTH_SIGNALS.map(
    (signal) =>
      bySignal.get(signal) ?? {
        signal,
        present: false,
        missing_since: null,
      }
  );
}

function TelemetryHealthCard({ children }: { children: ReactNode }) {
  return (
    <section className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4">
      <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
        Telemetry Health
      </h2>
      {children}
    </section>
  );
}

function StatusBadge({ present }: { present: boolean }) {
  return (
    <span
      className="inline-flex items-center rounded-sm border px-1.5 py-0.5 text-xs font-medium"
      style={present ? PRESENT_BADGE_STYLE : MISSING_BADGE_STYLE}
    >
      {present ? "Present" : "Missing"}
    </span>
  );
}

export function TelemetryHealthTable({
  rows,
}: {
  rows: TelemetryHealthSignal[];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-[var(--gray-05)]">
            <th className="px-3 py-2 text-left font-medium uppercase tracking-wide text-[var(--gray-09)]">
              Signal
            </th>
            <th className="px-3 py-2 text-left font-medium uppercase tracking-wide text-[var(--gray-09)]">
              Status
            </th>
            <th className="px-3 py-2 text-left font-medium uppercase tracking-wide text-[var(--gray-09)]">
              Missing Since
            </th>
          </tr>
        </thead>
        <tbody>
          {normalizeSignals(rows).map((row) => (
            <tr
              key={row.signal}
              data-signal={row.signal}
              className="border-b border-[var(--gray-04)] last:border-0"
            >
              <td className="px-3 py-2 font-mono text-xs text-[var(--gray-11)]">
                {row.signal}
              </td>
              <td className="px-3 py-2">
                <StatusBadge present={row.present} />
              </td>
              <td className="px-3 py-2 font-mono text-xs text-[var(--gray-11)]">
                {row.present ? (
                  <span className="text-[var(--gray-07)]">-</span>
                ) : (
                  row.missing_since ?? (
                    <span className="text-[var(--gray-07)]">-</span>
                  )
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TelemetryHealthSkeleton() {
  return (
    <div className="overflow-x-auto" aria-busy="true" aria-label="Loading">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-[var(--gray-05)]">
            <th className="px-3 py-2 text-left font-medium uppercase tracking-wide text-[var(--gray-09)]">
              Signal
            </th>
            <th className="px-3 py-2 text-left font-medium uppercase tracking-wide text-[var(--gray-09)]">
              Status
            </th>
            <th className="px-3 py-2 text-left font-medium uppercase tracking-wide text-[var(--gray-09)]">
              Missing Since
            </th>
          </tr>
        </thead>
        <tbody>
          {TELEMETRY_HEALTH_SIGNALS.map((signal, index) => (
            <tr
              key={signal}
              data-skeleton-row={signal}
              className="border-b border-[var(--gray-04)] last:border-0"
            >
              <td className="px-3 py-2">
                <Skeleton
                  className="h-3"
                  style={{ width: `${[88, 76, 84, 92][index % 4]}px` }}
                />
              </td>
              <td className="px-3 py-2">
                <Skeleton className="h-5 w-14" />
              </td>
              <td className="px-3 py-2">
                <Skeleton className="h-3 w-40" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TelemetryHealthError() {
  return (
    <p className="py-4 text-sm text-[var(--gray-09)]">
      Telemetry health unavailable
    </p>
  );
}

export function TelemetryHealthSection({
  workspaceId,
  runId,
}: TelemetryHealthSectionProps) {
  const [rows, setRows] = useState<TelemetryHealthSignal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(false);

      try {
        const res = await fetch(
          `/api/v1/workspaces/${workspaceId}/runs/${runId}/telemetry-health`
        );
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const json = (await res.json()) as TelemetryHealthResponse;
        if (!cancelled) {
          setRows(normalizeSignals(json.signals));
        }
      } catch {
        if (!cancelled) {
          setError(true);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [workspaceId, runId]);

  return (
    <TelemetryHealthCard>
      {loading ? (
        <TelemetryHealthSkeleton />
      ) : error ? (
        <TelemetryHealthError />
      ) : (
        <TelemetryHealthTable rows={rows} />
      )}
    </TelemetryHealthCard>
  );
}
