import { runStatusLabel, type RunStatus } from "./run-status-label";

const statusClassName: Record<RunStatus, string> = {
  success: "bg-[var(--green-09)]/20 text-[var(--green-11)] border border-[var(--green-09)]/30",
  failed: "bg-[var(--red-09)]/20 text-[var(--red-11)] border border-[var(--red-09)]/30",
  running: "bg-[var(--orange-09)]/20 text-[var(--orange-11)] border border-[var(--orange-09)]/30",
  queued:
    "bg-[var(--gray-04)] text-[var(--gray-10)] border border-[var(--gray-06)]",
};

const FALLBACK_CLASSNAME =
  "bg-[var(--gray-04)] text-[var(--gray-10)] border border-[var(--gray-06)]";

export function StatusBadge({ status }: { status: string }) {
  const className = statusClassName[status as RunStatus] ?? FALLBACK_CLASSNAME;

  return (
    <span
      className={`inline-flex w-[5.5rem] shrink-0 items-center justify-center px-1.5 py-0.5 rounded-sm text-xs font-medium ${className}`}
    >
      {runStatusLabel(status)}
    </span>
  );
}
