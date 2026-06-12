"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { RunDetailHeader } from "./components/run-detail-header";
import { RunTimeline } from "./components/run-timeline";
import { ReviewGatesSection } from "./components/review-gates-section";
import { CostSection } from "./components/cost-section";
import { ContextSection } from "./components/context-section";
import type { RunDetail } from "./components/run-detail-header";
import type { TimelineEvent } from "./components/run-timeline";

const POLL_INTERVAL_MS = 5000;

interface RunDetailResponse {
  run: RunDetail;
  events: TimelineEvent[];
}

interface EventsResponse {
  events: (TimelineEvent & { seq?: number })[];
}

export default function RunDetailPage() {
  const params = useParams<{ workspaceId: string; runId: string }>();
  const { workspaceId, runId } = params;
  const router = useRouter();

  const [run, setRun] = useState<RunDetail | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loadingRun, setLoadingRun] = useState(true);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const afterSeqRef = useRef<number>(-1);

  // Load run metadata once (may 404 for AFK-only sessions — non-fatal).
  useEffect(() => {
    async function loadRun() {
      setLoadingRun(true);
      try {
        const res = await fetch(
          `/api/v1/workspaces/${workspaceId}/runs/${runId}`
        );
        if (res.ok) {
          const json = (await res.json()) as RunDetailResponse;
          setRun(json.run);
        }
      } catch {
        // non-fatal
      } finally {
        setLoadingRun(false);
      }
    }
    loadRun();
  }, [workspaceId, runId]);

  // Poll events from the dedicated endpoint at POLL_INTERVAL_MS cadence.
  const pollEvents = useCallback(async () => {
    const afterSeq = afterSeqRef.current;
    const qs = afterSeq >= 0 ? `?after_seq=${afterSeq}` : "";
    const url = `/api/v1/workspaces/${workspaceId}/runs/${runId}/events${qs}`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          setError(`HTTP ${res.status}`);
        }
        return;
      }
      const json = (await res.json()) as EventsResponse;
      if (json.events.length > 0) {
        setEvents((prev) => {
          const existingIds = new Set(prev.map((e) => e.event_id));
          const incoming = json.events.filter(
            (e) => !existingIds.has(e.event_id)
          );
          if (incoming.length === 0) return prev;
          const maxSeq = Math.max(...json.events.map((e) => e.seq ?? 0));
          afterSeqRef.current = maxSeq;
          return [...prev, ...incoming];
        });
      }
    } catch {
      // network failure; will retry on next interval
    } finally {
      setLoadingEvents(false);
    }
  }, [workspaceId, runId]);

  useEffect(() => {
    pollEvents();
    const id = setInterval(pollEvents, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [pollEvents]);

  if (loadingRun && loadingEvents) {
    return (
      <div className="mx-auto max-w-[1440px]">
        <p className="text-sm text-[var(--gray-09)] animate-pulse py-8">
          Loading run…
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-[1440px]">
        <p className="text-sm text-[#ff9592] py-8">{error}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1440px]">
      <div className="mb-2 flex items-center gap-2 text-xs text-[var(--gray-09)]">
        <button
          onClick={() => router.push(`/dashboard/${workspaceId}/runs`)}
          className="flex items-center gap-1 rounded px-1.5 py-1 text-[var(--gray-11)] transition-colors hover:bg-[var(--gray-03)] hover:text-[var(--gray-12)]"
          aria-label="Back to runs"
        >
          <ArrowLeft size={14} />
          Back
        </button>
        <a
          href={`/dashboard/${workspaceId}/runs`}
          className="hover:text-[var(--gray-11)] transition-colors"
        >
          Runs
        </a>
        <span>/</span>
        <span className="font-mono">{runId.slice(0, 8)}</span>
      </div>

      <h1 className="mb-4 text-sm font-semibold text-[var(--gray-12)]">
        Run detail
      </h1>

      {run && <RunDetailHeader run={run} />}

      <div className="mt-6">
        <h2 className="mb-4 text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
          Cost &amp; tokens
        </h2>
        <CostSection workspaceId={workspaceId} runId={runId} />
      </div>

      <div className="mt-6">
        <h2 className="mb-4 text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
          Context
        </h2>
        <ContextSection workspaceId={workspaceId} runId={runId} />
      </div>

      <div className="mt-6">
        <h2 className="mb-4 text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
          Timeline
        </h2>
        <RunTimeline
          events={events}
          workspaceId={workspaceId}
          runId={runId}
          loading={loadingEvents}
        />
      </div>

      {run && (
        <div className="mt-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
              Review Gates
            </h2>
            <a
              href={`/dashboard/${workspaceId}/review-gates?runId=${runId}`}
              className="text-xs text-[#70b8ff] hover:underline"
            >
              View all →
            </a>
          </div>
          <ReviewGatesSection workspaceId={workspaceId} runId={runId} />
        </div>
      )}
    </div>
  );
}
