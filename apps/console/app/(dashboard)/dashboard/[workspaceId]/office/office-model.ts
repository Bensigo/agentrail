export interface OfficeTask {
  id: string;
  agent: string;
  title: string;
  branch: string;
  phase: string;
  summary: string;
  revision: number;
  repository_name: string;
  updated_at: string;
  reported_at: string | null;
  reported_phase: string | null;
  context_at: string | null;
  usage_at: string | null;
  context: {
    summary: string;
    sources: string[];
    tokens: number | null;
    windowTokens: number | null;
  } | null;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
  } | null;
}
export interface OfficeSnapshot {
  tasks: OfficeTask[];
  observedAt: string;
  limit: number;
}
export const phaseName: Record<string, string> = {
  planning: "Planning",
  implementing: "Building",
  testing: "Testing",
  reviewing: "Reviewing",
  blocked: "Blocked",
  needs_review: "Needs your review",
  closed: "Closed",
};
export function recentlyReporting(task: OfficeTask, now: number) {
  return (
    ["planning", "implementing", "testing", "reviewing"].includes(task.phase) &&
    ["planning", "implementing", "testing", "reviewing"].includes(
      task.reported_phase || "",
    ) &&
    !!task.reported_at &&
    now - new Date(task.reported_at).getTime() < 120000
  );
}
export function usageSubtotal(tasks: OfficeTask[]) {
  return tasks.reduce(
    (sum, t) => ({
      usd: sum.usd + (t.usage?.costUsd ?? 0),
      known: sum.known + (t.usage?.costUsd != null ? 1 : 0),
      unknown: sum.unknown + (t.usage?.costUsd == null ? 1 : 0),
    }),
    { usd: 0, known: 0, unknown: 0 },
  );
}
export function age(value: string | null, now: number) {
  if (!value) return "No report";
  const seconds = Math.max(
    0,
    Math.floor((now - new Date(value).getTime()) / 1000),
  );
  return seconds < 60
    ? "Just now"
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ago`
      : seconds < 86400
        ? `${Math.floor(seconds / 3600)}h ago`
        : `${Math.floor(seconds / 86400)}d ago`;
}
const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
export const usd = (value: number) => currency.format(value);
