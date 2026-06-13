"use client";

import { useState, useEffect } from "react";
import { Skeleton } from "../../../../../../components/loading-skeleton";

interface ReplayEvent {
  event_type: string;
  ts: string;
  slot: number;
  stall_before_ms: number;
  is_retry: boolean;
  is_digest_mismatch: boolean;
}

interface ReplayResponse {
  events: ReplayEvent[];
}

interface ReplaySectionProps {
  workspaceId: string;
  runId: string;
}

function fmtTs(iso: string): string {
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

function fmtDuration(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${ms}ms`;
}

function dotColor(event: ReplayEvent): string {
  if (event.is_digest_mismatch) return "#e5484d";
  if (event.is_retry) return "#f76b15";
  return "#29a383";
}

export function ReplaySection({ workspaceId, runId }: ReplaySectionProps) {
  const [events, setEvents] = useState<ReplayEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [empty, setEmpty] = useState(false);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setEmpty(false);
      try {
        const res = await fetch(
          `/api/v1/workspaces/${workspaceId}/runs/${runId}/replay`
        );
        if (res.status === 404 || res.status === 204) {
          setEmpty(true);
          return;
        }
        if (!res.ok) {
          setEmpty(true);
          return;
        }
        const json = (await res.json()) as ReplayResponse;
        const sorted = (json.events ?? []).sort(
          (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime()
        );
        if (sorted.length === 0) {
          setEmpty(true);
        } else {
          setEvents(sorted);
        }
      } catch {
        setEmpty(true);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [workspaceId, runId]);

  if (loading) {
    return (
      <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4">
        <div className="flex flex-col gap-3" aria-label="Loading">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (empty) {
    return (
      <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4 flex items-center justify-center">
        <p className="text-sm text-[var(--gray-09)]">
          No flight-recorder events for this run.
        </p>
      </div>
    );
  }

  // Compute highlights
  const longestStallEvent = events.reduce<ReplayEvent | null>(
    (best, e) => (e.stall_before_ms > (best?.stall_before_ms ?? 0) ? e : best),
    null
  );
  const retryCount = events.filter((e) => e.is_retry).length;
  const digestMismatchCount = events.filter((e) => e.is_digest_mismatch).length;
  const hasHighlights =
    (longestStallEvent && longestStallEvent.stall_before_ms >= 500) ||
    retryCount > 0 ||
    digestMismatchCount > 0;

  return (
    <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4">
      {/* Highlights panel */}
      {hasHighlights && (
        <div className="mb-4 flex flex-wrap gap-3 border-b border-[var(--gray-05)] pb-4">
          {longestStallEvent && longestStallEvent.stall_before_ms >= 500 && (
            <a
              href={`#replay-event-${longestStallEvent.ts}`}
              className="flex items-center gap-1.5 rounded border border-[var(--gray-05)] bg-[var(--gray-03)] px-2.5 py-1.5 text-xs transition-colors hover:bg-[var(--gray-04)]"
            >
              <span className="text-orange-400 font-mono font-semibold">
                {fmtDuration(longestStallEvent.stall_before_ms)}
              </span>
              <span className="text-[var(--gray-09)]">
                longest stall · slot {longestStallEvent.slot}
              </span>
            </a>
          )}
          {retryCount > 0 && (
            <div className="flex items-center gap-1.5 rounded border border-[var(--gray-05)] bg-[var(--gray-03)] px-2.5 py-1.5 text-xs">
              <span
                className="inline-block h-2 w-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: "#f76b15" }}
              />
              <span className="font-mono font-semibold text-[var(--gray-11)]">
                {retryCount}
              </span>
              <span className="text-[var(--gray-09)]">retry loop{retryCount !== 1 ? "s" : ""}</span>
            </div>
          )}
          {digestMismatchCount > 0 && (
            <div className="flex items-center gap-1.5 rounded border border-[var(--gray-05)] bg-[var(--gray-03)] px-2.5 py-1.5 text-xs">
              <span
                className="inline-block h-2 w-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: "#e5484d" }}
              />
              <span className="font-mono font-semibold text-[var(--gray-11)]">
                {digestMismatchCount}
              </span>
              <span className="text-[var(--gray-09)]">
                digest mismatch{digestMismatchCount !== 1 ? "es" : ""}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Vertical timeline */}
      <div className="relative pl-5">
        {/* 2px left border */}
        <div
          className="absolute left-[7px] top-0 bottom-0 w-[2px]"
          style={{ backgroundColor: "var(--gray-05)" }}
        />
        <div className="flex flex-col gap-4">
          {events.map((event, idx) => {
            const color = dotColor(event);
            const showStall = event.stall_before_ms >= 500;
            return (
              <div
                key={`${event.ts}-${idx}`}
                id={`replay-event-${event.ts}`}
                className="relative flex flex-col gap-0.5"
              >
                {/* Color-coded dot */}
                <span
                  className="absolute -left-5 top-1 h-2 w-2 rounded-full flex-shrink-0"
                  style={{
                    backgroundColor: color,
                    marginLeft: "-1px",
                  }}
                />
                <div className="flex flex-wrap items-center gap-2">
                  {/* Timestamp */}
                  <span className="font-mono text-xs text-[var(--gray-09)]">
                    {fmtTs(event.ts)}
                  </span>
                  {/* Event type */}
                  <span className="text-sm text-[var(--gray-11)]">
                    {event.event_type}
                  </span>
                  {/* Slot badge */}
                  <span className="px-1.5 py-0.5 rounded-sm text-xs font-medium bg-[var(--gray-03)] text-[var(--gray-10)]">
                    slot {event.slot}
                  </span>
                  {/* Retry badge */}
                  {event.is_retry && (
                    <span
                      className="px-1.5 py-0.5 rounded-sm text-xs font-medium"
                      style={{
                        backgroundColor: "#f76b151a",
                        color: "#f76b15",
                      }}
                    >
                      retry
                    </span>
                  )}
                  {/* Digest mismatch badge */}
                  {event.is_digest_mismatch && (
                    <span
                      className="px-1.5 py-0.5 rounded-sm text-xs font-medium"
                      style={{
                        backgroundColor: "#e5484d1a",
                        color: "#e5484d",
                      }}
                    >
                      digest mismatch
                    </span>
                  )}
                  {/* Stall indicator */}
                  {showStall && (
                    <span className="text-orange-400 font-mono text-xs">
                      +{fmtDuration(event.stall_before_ms)} stall
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
