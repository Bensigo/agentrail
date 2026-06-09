"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { RunDetailHeader } from "./components/run-detail-header";
import { RunTimeline } from "./components/run-timeline";
import type { RunDetail } from "./components/run-detail-header";
import type { TimelineEvent } from "./components/run-timeline";

interface RunDetailResponse {
  run: RunDetail;
  events: TimelineEvent[];
}

export default function RunDetailPage() {
  const params = useParams<{ workspaceId: string; runId: string }>();
  const { workspaceId, runId } = params;

  const [data, setData] = useState<RunDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/v1/workspaces/${workspaceId}/runs/${runId}`
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            (body as { error?: string }).error ?? `HTTP ${res.status}`
          );
        }
        const json = (await res.json()) as RunDetailResponse;
        setData(json);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load run");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [workspaceId, runId]);

  if (loading) {
    return (
      <div className="mx-auto max-w-[1440px]">
        <p className="text-sm text-[var(--gray-09)] animate-pulse py-8">
          Loading run…
        </p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="mx-auto max-w-[1440px]">
        <p className="text-sm text-[#ff9592] py-8">{error ?? "Not found"}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1440px]">
      <div className="mb-2 flex items-center gap-2 text-xs text-[var(--gray-09)]">
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

      <RunDetailHeader run={data.run} />

      <div className="mt-6">
        <h2 className="mb-4 text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
          Timeline
        </h2>
        <RunTimeline
          events={data.events}
          workspaceId={workspaceId}
          runId={runId}
        />
      </div>
    </div>
  );
}
