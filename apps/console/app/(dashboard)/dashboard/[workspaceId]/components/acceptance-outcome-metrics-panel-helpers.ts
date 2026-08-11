export type AcceptanceOutcomeCounts = {
  eligible: number;
  approved: number;
  approvedWithException: number;
  changesRequested: number;
  rejected: number;
  notRecorded: number;
  excludedUnknown: number;
  signedMerged: number;
  deploymentObserved: number;
  incidentObserved: number;
  reverted: number;
};

export type AcceptanceOutcomeMetricsData = {
  cohort: { from: string; to: string; observedUntil: string };
  counts: AcceptanceOutcomeCounts;
};

export function acceptanceOutcomeMetricsWindow(now = new Date()): {
  from: string;
  to: string;
  observedUntil: string;
} {
  const observedUntil = new Date(now);
  const from = new Date(observedUntil);
  from.setUTCDate(from.getUTCDate() - 30);
  return {
    from: from.toISOString(),
    to: observedUntil.toISOString(),
    observedUntil: observedUntil.toISOString(),
  };
}

/** Keeps the client request bounded to a single immutable observation cutoff. */
export function acceptanceOutcomeMetricsUrl(
  workspaceId: string,
  window: { from: string; to: string; observedUntil: string }
): string {
  const search = new URLSearchParams(window);
  return `/api/v1/workspaces/${workspaceId}/acceptance-outcome-metrics?${search}`;
}

export function formatAcceptanceOutcomeDateRange(range: { from: string; to: string }): string {
  const format = (date: string) => new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  return `${format(range.from)} – ${format(range.to)}`;
}
