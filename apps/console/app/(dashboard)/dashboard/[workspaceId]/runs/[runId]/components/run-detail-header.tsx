import { StatusBadge } from "../../components/status-badge";

export interface RunDetail {
  id: string;
  workspaceId: string;
  repositoryId: string;
  agent: string;
  branch: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  duration: number | null;
  total_cost: number;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
        {label}
      </span>
      <div className="text-sm text-[var(--gray-12)]">{children}</div>
    </div>
  );
}

export function RunDetailHeader({ run }: { run: RunDetail }) {
  return (
    <div className="rounded border border-[var(--gray-05)] divide-y divide-[var(--gray-05)]">
      <div className="flex items-center justify-between px-4 py-3">
        <span className="font-mono text-sm text-[var(--gray-12)]">
          {run.id}
        </span>
        <StatusBadge status={run.status} />
      </div>
      <div className="grid grid-cols-2 gap-4 px-4 py-3 sm:grid-cols-3">
        <Field label="Repository">
          <span className="font-mono">{run.repositoryId}</span>
        </Field>
        <Field label="Agent">
          <span className="font-mono">{run.agent}</span>
        </Field>
        <Field label="Branch">
          <span className="font-mono">{run.branch}</span>
        </Field>
        <Field label="Started">
          <span className="font-mono text-xs text-[var(--gray-10)]">
            {formatDate(run.startedAt)}
          </span>
        </Field>
        <Field label="Finished">
          <span className="font-mono text-xs text-[var(--gray-10)]">
            {formatDate(run.finishedAt)}
          </span>
        </Field>
        <Field label="Duration">
          <span className="font-mono text-xs text-[var(--gray-10)]">
            {formatDuration(run.duration)}
          </span>
        </Field>
        <Field label="Cost">
          <span className="font-mono text-xs text-[var(--gray-10)]">
            {run.total_cost > 0 ? `$${run.total_cost.toFixed(4)}` : "—"}
          </span>
        </Field>
      </div>
    </div>
  );
}
