"use client";

import { useEffect, useState } from "react";
import { StatusBadge } from "../../components/status-badge";
import { nameOrShortId } from "../../../../../../components/id-display";

export interface RunDetail {
  id: string;
  repositoryId: string;
  repository_name: string | null;
  branch: string;
  agent: string;
  /** The issue/task title (claim-time copy of queue_entries.title); null for
   * runs that predate the durable queue or weren't claimed from it. */
  title?: string | null;
  status: string;
  duration: number | null;
  total_cost: number;
  startedAt: string | null;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/** Live elapsed seconds for a running run; null when not applicable. */
function useLiveElapsed(run: RunDetail): number | null {
  const running = run.status === "running" && !!run.startedAt;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  if (!running) return null;
  return Math.max(0, Math.round((now - new Date(run.startedAt!).getTime()) / 1000));
}

export function RunDetailHeader({ run }: { run: RunDetail }) {
  const liveElapsed = useLiveElapsed(run);
  const repo = nameOrShortId(run.repository_name, run.repositoryId);
  return (
    <div className="flex flex-wrap items-start gap-6 py-4 border-b border-[var(--gray-05)]">
      <div className="flex flex-col gap-0.5 min-w-[140px]">
        <span className="text-xs text-[var(--gray-09)] uppercase tracking-wide">
          Repo
        </span>
        <span
          className="text-sm text-[var(--gray-12)] truncate max-w-[260px]"
          title={repo.title}
        >
          {repo.text}
        </span>
      </div>

      <div className="flex flex-col gap-0.5 min-w-[100px]">
        <span className="text-xs text-[var(--gray-09)] uppercase tracking-wide">
          Branch
        </span>
        <span className="text-sm text-[var(--gray-12)] font-mono truncate max-w-[200px]">
          {run.branch}
        </span>
      </div>

      <div className="flex flex-col gap-0.5 min-w-[80px]">
        <span className="text-xs text-[var(--gray-09)] uppercase tracking-wide">
          Agent
        </span>
        <span className="text-sm text-[var(--gray-11)]">{run.agent}</span>
      </div>

      <div className="flex flex-col gap-0.5">
        <span className="text-xs text-[var(--gray-09)] uppercase tracking-wide">
          Status
        </span>
        <StatusBadge status={run.status} />
      </div>

      <div className="flex flex-col gap-0.5 min-w-[60px]">
        <span className="text-xs text-[var(--gray-09)] uppercase tracking-wide">
          Duration
        </span>
        <span className="text-sm font-mono text-[var(--gray-11)]">
          {liveElapsed !== null ? `${formatDuration(liveElapsed)}…` : formatDuration(run.duration)}
        </span>
      </div>

      <div className="flex flex-col gap-0.5 min-w-[60px]">
        <span className="text-xs text-[var(--gray-09)] uppercase tracking-wide">
          Cost
        </span>
        <span className="text-sm font-mono text-[var(--gray-11)]">
          {run.total_cost > 0 ? `$${run.total_cost.toFixed(4)}` : "—"}
        </span>
      </div>
    </div>
  );
}
