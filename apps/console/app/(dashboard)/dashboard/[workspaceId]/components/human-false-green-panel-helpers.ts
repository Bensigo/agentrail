export type ProductionHumanFalseGreenData = {
  dateRange: { from: string; to: string };
  observedUntil: string;
  successfulRuns: number;
  knownSampleSize: number;
  falseGreenCount: number;
  falseGreenRate: number | null;
  unknown: {
    missingPrIdentity: number;
    missingPublishedHead: number;
    noMatchingHumanOutcome: number;
  };
  limitations: string[];
};

export function humanFalseGreenWindow(now = new Date()): {
  from: string;
  to: string;
  observedUntil: string;
} {
  const to = new Date(now);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 30);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    observedUntil: to.toISOString(),
  };
}

export function formatHumanFalseGreenRate(value: number | null): string {
  return value === null ? "unknown" : `${(value * 100).toFixed(1)}%`;
}

export function formatHumanFalseGreenRange(range: { from: string; to: string }): string {
  const format = (value: string) =>
    new Date(value).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
  return `${format(range.from)} – ${format(range.to)}`;
}

export function unknownHumanFalseGreenCount(
  unknown: ProductionHumanFalseGreenData["unknown"]
): number {
  return unknown.missingPrIdentity + unknown.missingPublishedHead + unknown.noMatchingHumanOutcome;
}
