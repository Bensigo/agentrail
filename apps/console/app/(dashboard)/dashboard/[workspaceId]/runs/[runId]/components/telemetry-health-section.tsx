"use client";

import { useState, useEffect } from "react";
import { Skeleton } from "../../../../../../components/loading-skeleton";

// Stable order of the eight named telemetry signals, mirroring SIGNALS in
// agentrail/server/telemetry_completeness.py. Rendered even when the API
// returns a partial set so the checklist is never short and a broken
// telemetry push stays visually distinct from "nothing happened".
const SIGNALS = [
  "run_start",
  "context_pack",
  "cost_event",
  "review_gate",
  "failure_event",
  "memory_items",
  "index_snapshot",
  "outbox_flush",
] as const;

// Matches the CheckResult dataclass serialized by the telemetry-health route.
interface SignalHealth {
  signal: string;
  present: boolean;
  missing_since: string | null;
}

interface TelemetryHealthResponse {
  signals: SignalHealth[];
}

interface TelemetryHealthSectionProps {
  workspaceId: string;
  runId: string;
}

function fmtTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function TelemetryHealthSection({
  workspaceId,
  runId,
}: TelemetryHealthSectionProps) {
  const [signals, setSignals] = useState<Map<string, SignalHealth>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    // Point-in-time snapshot: fetched once on mount, not polled.
    async function load() {
      setLoading(true);
      setError(false);
      try {
        const res = await fetch(
          `/api/v1/workspaces/${workspaceId}/runs/${runId}/telemetry-health`
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as TelemetryHealthResponse;
        const map = new Map<string, SignalHealth>();
        for (const s of json.signals ?? []) {
          map.set(s.signal, s);
        }
        setSignals(map);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [workspaceId, runId]);

  if (loading) {
    return (
      <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4">
        <div className="flex flex-col gap-2" aria-label="Loading">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4">
        <p className="text-sm text-[var(--gray-09)]">
          Telemetry health unavailable
        </p>
      </div>
    );
  }

  return (
    <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-[var(--gray-05)]">
            <th className="px-2 py-2 text-left font-medium uppercase tracking-wide text-[var(--gray-09)]">
              Signal
            </th>
            <th className="px-2 py-2 text-left font-medium uppercase tracking-wide text-[var(--gray-09)]">
              Status
            </th>
            <th className="px-2 py-2 text-left font-medium uppercase tracking-wide text-[var(--gray-09)]">
              Missing Since
            </th>
          </tr>
        </thead>
        <tbody>
          {SIGNALS.map((name) => {
            const health = signals.get(name);
            const present = health?.present ?? false;
            const missingSince = health?.missing_since ?? null;
            return (
              <tr
                key={name}
                className="border-b border-[var(--gray-04)] last:border-0"
              >
                <td className="px-2 py-2 font-mono text-[var(--gray-11)]">
                  {name}
                </td>
                <td className="px-2 py-2">
                  {present ? (
                    <span
                      className="inline-block rounded px-1.5 py-0.5 text-[11px] font-medium"
                      style={{
                        color: "var(--green-09)",
                        // #29a383 (--green-09, invariant) at the same 10.2%
                        // alpha the literal `#29a3831a` encoded — color-mix
                        // toward `transparent` only scales alpha, so this is
                        // pixel-identical to the hex8 literal it replaces.
                        backgroundColor:
                          "color-mix(in oklab, var(--green-09) 10.196%, transparent)",
                      }}
                    >
                      Present
                    </span>
                  ) : (
                    <span
                      className="inline-block rounded px-1.5 py-0.5 text-[11px] font-medium"
                      style={{
                        color: "var(--red-09)",
                        // Same technique as the "Present" branch above: #e5484d
                        // (--red-09, invariant) at the literal's 10.2% alpha.
                        backgroundColor:
                          "color-mix(in oklab, var(--red-09) 10.196%, transparent)",
                      }}
                    >
                      Missing
                    </span>
                  )}
                </td>
                <td className="px-2 py-2 font-mono text-xs text-[var(--gray-09)]">
                  {!present && missingSince ? (
                    fmtTimestamp(missingSince)
                  ) : (
                    <span className="text-[var(--gray-07)]">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
