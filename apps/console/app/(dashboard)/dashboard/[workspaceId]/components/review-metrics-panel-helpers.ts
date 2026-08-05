export interface ReviewMetricValue {
  value: number | null;
  knownSampleSize: number;
}

export interface ReviewMetricsCohort {
  taskFamily: string;
  dateRange: { from: string; to: string } | null;
  sampleSize: number;
  denominator: { openedPullRequests: number; terminalPullRequests: number; mergeRate: number };
  medianTimeToFirstReviewSeconds: ReviewMetricValue;
  averageReviewCycles: ReviewMetricValue;
  mergeRate: ReviewMetricValue;
  postMergeReworkEvents: ReviewMetricValue;
  humanReviewMinutes: ReviewMetricValue;
  exclusions: string[];
  limitations: string[];
}

export interface ReviewMetricsData {
  cohorts: ReviewMetricsCohort[];
}

export function reviewMetricsWindow(now = new Date()): { from: string; to: string } {
  const to = new Date(now);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 30);
  return { from: from.toISOString(), to: to.toISOString() };
}

export function formatReviewMetric(value: number | null, kind: "minutes" | "seconds" | "cycles" | "percent" | "count"): string {
  if (value === null) return "unknown";
  if (kind === "minutes") return `${Math.round(value)} min`;
  if (kind === "seconds") return value < 3600 ? `${Math.round(value / 60)} min` : `${(value / 3600).toFixed(1)} hr`;
  if (kind === "percent") return `${Math.round(value * 100)}%`;
  if (kind === "cycles") return value.toFixed(1);
  return `${Math.round(value)}`;
}

export function formatKnownSampleSize(metric: ReviewMetricValue): string {
  return `n=${metric.knownSampleSize}`;
}

export function formatReviewDateRange(range: { from: string; to: string }): string {
  const format = (date: string) => new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  return `${format(range.from)} – ${format(range.to)}`;
}
