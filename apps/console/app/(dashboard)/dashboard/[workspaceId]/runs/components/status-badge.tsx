type RunStatus = "queued" | "running" | "success" | "failed";

const statusConfig: Record<RunStatus, { label: string; className: string }> = {
  success: {
    label: "success",
    className:
      "bg-[#29a383]/20 text-[#1fd8a4] border border-[#29a383]/30",
  },
  failed: {
    label: "failed",
    className:
      "bg-[#e5484d]/20 text-[#ff9592] border border-[#e5484d]/30",
  },
  running: {
    label: "running",
    className:
      "bg-[#f76b15]/20 text-[#ffa057] border border-[#f76b15]/30",
  },
  queued: {
    label: "queued",
    className:
      "bg-[var(--gray-04)] text-[var(--gray-10)] border border-[var(--gray-06)]",
  },
};

export function StatusBadge({ status }: { status: string }) {
  const config = statusConfig[status as RunStatus] ?? {
    label: status,
    className:
      "bg-[var(--gray-04)] text-[var(--gray-10)] border border-[var(--gray-06)]",
  };

  return (
    <span
      className={`inline-flex w-[4.5rem] shrink-0 items-center justify-center px-1.5 py-0.5 rounded-sm text-xs font-medium ${config.className}`}
    >
      {config.label}
    </span>
  );
}
