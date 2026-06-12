"use client";

import { StatusBadge } from "../../components/status-badge";

export interface RunDetail {
  id: string;
  repositoryId: string;
  branch: string;
  agent: string;
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

export function RunDetailHeader({ run }: { run: RunDetail }) {
  return (
    <div className="flex flex-wrap items-start gap-6 py-4 border-b border-[var(--gray-05)]">
      <div className="flex flex-col gap-0.5 min-w-[140px]">
        <span className="text-xs text-[var(--gray-09)] uppercase tracking-wide">
          Repo
        </span>
        <span className="text-sm text-[var(--gray-12)] font-mono truncate max-w-[260px]">
          {run.repositoryId}
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
          {formatDuration(run.duration)}
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
