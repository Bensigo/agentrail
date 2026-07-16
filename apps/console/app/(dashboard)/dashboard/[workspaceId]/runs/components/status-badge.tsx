import { runStatusLabel, type RunStatus } from "./run-status-label";

const statusClassName: Record<RunStatus, string> = {
  success: "bg-[#29a383]/20 text-[#1fd8a4] border border-[#29a383]/30",
  failed: "bg-[#e5484d]/20 text-[#ff9592] border border-[#e5484d]/30",
  running: "bg-[#f76b15]/20 text-[#ffa057] border border-[#f76b15]/30",
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
