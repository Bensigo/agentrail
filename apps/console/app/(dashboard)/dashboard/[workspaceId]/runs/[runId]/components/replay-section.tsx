"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  ReplayEvent,
  ReplayTimelineResponse,
} from "../../../../../../../lib/replay";
import {
  formatReplayDuration,
  replayDotColor,
} from "./replay-section-helpers";

interface ReplaySectionProps {
  workspaceId: string;
  runId: string;
}

function formatTimestamp(ts: string): string {
  const parsed = new Date(ts);
  if (Number.isNaN(parsed.getTime())) return ts;
  return parsed.toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function firstReplayEventHref(
  events: ReplayEvent[],
  predicate: (event: ReplayEvent) => boolean
): string | null {
  const index = events.findIndex(predicate);
  return index >= 0 ? `#replay-event-${index}` : null;
}

function HighlightLink({
  href,
  children,
}: {
  href: string | null;
  children: React.ReactNode;
}) {
  if (!href) return <>{children}</>;
  return (
    <a href={href} className="rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--blue-09)]">
      {children}
    </a>
  );
}

function ReplaySkeleton() {
  return (
    <div className="space-y-3 py-2" aria-label="Loading replay timeline">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex gap-3">
          <div className="flex w-4 flex-col items-center">
            <div className="mt-1 h-2 w-2 animate-pulse rounded-full bg-[var(--gray-04)]" />
            {i < 3 && <div className="mt-1 h-9 w-0.5 animate-pulse bg-[var(--gray-04)]" />}
          </div>
          <div className="flex-1 space-y-2 pb-2">
            <div className="h-3 w-32 animate-pulse rounded bg-[var(--gray-03)]" />
            <div className="h-4 w-52 animate-pulse rounded bg-[var(--gray-03)]" />
          </div>
        </div>
      ))}
    </div>
  );
}

function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "retry" | "digest";
}) {
  const classes =
    tone === "retry"
      ? "border-[rgba(255,230,41,0.35)] bg-[rgba(255,230,41,0.12)] text-[var(--yellow-11)]"
      : tone === "digest"
        ? "border-[rgba(229,72,77,0.35)] bg-[rgba(229,72,77,0.12)] text-[var(--red-11)]"
        : "border-[var(--gray-05)] bg-[var(--gray-03)] text-[var(--gray-10)]";
  return (
    <span className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 text-xs font-medium ${classes}`}>
      {children}
    </span>
  );
}

export function ReplaySection({ workspaceId, runId }: ReplaySectionProps) {
  const [timeline, setTimeline] = useState<ReplayTimelineResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    async function loadReplay() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/v1/workspaces/${workspaceId}/runs/${runId}/replay`,
          { cache: "no-store", signal: controller.signal }
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            (body as { error?: string }).error ?? `HTTP ${res.status}`
          );
        }
        setTimeline((await res.json()) as ReplayTimelineResponse);
      } catch (err) {
        if ((err as { name?: string }).name !== "AbortError") {
          setError(err instanceof Error ? err.message : "Failed to load replay timeline");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    loadReplay();
    return () => controller.abort();
  }, [workspaceId, runId]);

  const events = timeline?.events ?? [];
  const longestStallHref = useMemo(() => {
    if (!timeline?.highlights.longest_stall_ms) return null;
    return firstReplayEventHref(
      events,
      (event) =>
        event.slot === timeline.highlights.longest_stall_slot &&
        event.stall_before_ms === timeline.highlights.longest_stall_ms
    );
  }, [events, timeline]);
  const retryHref = useMemo(
    () => firstReplayEventHref(events, (event) => event.is_retry),
    [events]
  );
  const digestHref = useMemo(
    () => firstReplayEventHref(events, (event) => event.is_digest_mismatch),
    [events]
  );

  if (loading) return <ReplaySkeleton />;

  if (error) {
    return <p className="py-4 text-sm text-[#ff9592]">{error}</p>;
  }

  if (!timeline || events.length === 0) {
    return (
      <div className="rounded border border-[var(--gray-05)] py-6 text-center text-sm text-[var(--gray-09)]">
        No flight-recorder events for this run.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-3 py-2">
          <p className="mb-0.5 text-xs text-[var(--gray-09)]">Longest stall</p>
          <HighlightLink href={longestStallHref}>
            <p className="font-mono text-sm font-semibold text-[var(--gray-12)]">
              {timeline.highlights.longest_stall_ms === null
                ? "none"
                : `${formatReplayDuration(timeline.highlights.longest_stall_ms)} · slot ${timeline.highlights.longest_stall_slot}`}
            </p>
          </HighlightLink>
        </div>
        <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-3 py-2">
          <p className="mb-0.5 text-xs text-[var(--gray-09)]">Retry loops</p>
          <HighlightLink href={retryHref}>
            <p className="font-mono text-sm font-semibold text-[var(--yellow-11)]">
              {timeline.highlights.retry_loops.length}
            </p>
          </HighlightLink>
        </div>
        <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-3 py-2">
          <p className="mb-0.5 text-xs text-[var(--gray-09)]">Digest mismatches</p>
          <HighlightLink href={digestHref}>
            <p className="font-mono text-sm font-semibold text-[var(--red-11)]">
              {timeline.highlights.digest_mismatches.length}
            </p>
          </HighlightLink>
        </div>
      </div>

      <div className="space-y-0">
        {events.map((event, index) => (
          <div
            id={`replay-event-${index}`}
            key={`${event.ts}-${event.slot}-${event.event_type}-${index}`}
            className="flex scroll-mt-6 gap-3"
          >
            <div className="flex w-4 flex-col items-center">
              <span
                className="mt-1 h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: replayDotColor(event) }}
              />
              {index < events.length - 1 && (
                <span className="mt-1 w-0.5 flex-1 bg-[var(--gray-05)]" />
              )}
            </div>
            <div className="min-w-0 flex-1 pb-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-[var(--gray-09)]">
                  {formatTimestamp(event.ts)}
                </span>
                <span className="text-sm text-[var(--gray-12)]">
                  {event.event_type}
                </span>
                <Badge>slot {event.slot}</Badge>
                {event.stall_before_ms !== null && event.stall_before_ms >= 500 && (
                  <span className="font-mono text-xs text-orange-400">
                    +{formatReplayDuration(event.stall_before_ms)}
                  </span>
                )}
                {event.is_retry && <Badge tone="retry">retry</Badge>}
                {event.is_digest_mismatch && <Badge tone="digest">digest mismatch</Badge>}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-3 text-xs">
                <span className="font-mono text-[var(--gray-08)]">
                  digest {event.digest || "none"}
                </span>
                {event.payload_json && event.payload_json !== "{}" && (
                  <span className="min-w-0 truncate font-mono text-[var(--gray-09)]">
                    {event.payload_json}
                  </span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
