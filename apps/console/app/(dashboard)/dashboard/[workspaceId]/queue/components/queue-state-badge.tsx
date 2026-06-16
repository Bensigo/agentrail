import { queueStateLabel, type QueueState } from "./queue-helpers";

// Severity mapping from TASTE.md: green=passed, orange=running, red=failed/
// escalated, gray=queued/inactive, yellow=blocked (parked, awaiting a blocker).
const stateClassName: Record<QueueState, string> = {
  green: "bg-[#29a383]/20 text-[#1fd8a4] border border-[#29a383]/30",
  running: "bg-[#f76b15]/20 text-[#ffa057] border border-[#f76b15]/30",
  "escalated-to-human": "bg-[#e5484d]/20 text-[#ff9592] border border-[#e5484d]/30",
  blocked: "bg-[#ffe629]/15 text-[#f5e147] border border-[#ffe629]/30",
  queued: "bg-[var(--gray-04)] text-[var(--gray-10)] border border-[var(--gray-06)]",
};

export function QueueStateBadge({ state }: { state: QueueState }) {
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded-sm text-xs font-medium ${stateClassName[state]}`}
    >
      {queueStateLabel(state)}
    </span>
  );
}
