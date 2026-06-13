export function buildRunDetailHref(workspaceId: string, runId: string): string {
  return `/dashboard/${workspaceId}/runs/${runId}`;
}

export function truncateFingerprint(value: string, maxChars = 24): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...`;
}

export function formatClusterTime(value: string): string {
  if (!value) return "-";
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
