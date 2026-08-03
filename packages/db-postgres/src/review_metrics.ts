import type {
  ReviewEventRow,
  ReviewEventType,
  HumanReviewSource,
} from "./schema/review_events.js";

export type ReviewMetricEvent = Pick<
  ReviewEventRow,
  | "workspaceId"
  | "repo"
  | "prNumber"
  | "taskFamily"
  | "deliveryId"
  | "eventType"
  | "occurredAt"
  | "headSha"
  | "reviewState"
  | "actorType"
  | "additions"
  | "deletions"
  | "changedFiles"
  | "humanReviewMinutes"
  | "humanReviewSource"
>;

export type ReviewMetricValue = {
  value: number | null;
  knownSampleSize: number;
};

export type ReviewMetrics = {
  workspaceId: string;
  taskFamily: string | null;
  dateRange: { from: Date; to: Date } | null;
  sampleSize: number;
  denominator: {
    openedPullRequests: number;
    terminalPullRequests: number;
    mergeRate: number;
  };
  medianTimeToFirstReviewSeconds: ReviewMetricValue;
  averageReviewCycles: ReviewMetricValue;
  medianPrSizeLines: ReviewMetricValue;
  mergeRate: ReviewMetricValue;
  postMergeReworkEvents: ReviewMetricValue;
  humanReviewMinutes: ReviewMetricValue;
  exclusions: string[];
  limitations: string[];
};

export type ReviewMetricComparison = {
  sampleSizeDelta: number;
  denominatorDelta: {
    openedPullRequests: number;
    terminalPullRequests: number;
    mergeRate: number;
  };
  medianTimeToFirstReviewSecondsDelta: number | null;
  averageReviewCyclesDelta: number | null;
  medianPrSizeLinesDelta: number | null;
  mergeRateDelta: number | null;
  postMergeReworkEventsDelta: number | null;
  humanReviewMinutesDelta: number | null;
};

export type ReviewMetricWindow = {
  from?: Date;
  to?: Date;
  /**
   * Required to turn "no observed rework event" into a known zero. Without
   * this boundary, post-merge rework stays null rather than pretending the
   * ledger was observed forever.
   */
  observedUntil?: Date;
};

type NormalizedEvent = ReviewMetricEvent & { occurredAt: Date };

function asDate(value: Date | string): Date | null {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function average(values: number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function value(value: number | null, knownSampleSize: number): ReviewMetricValue {
  return { value, knownSampleSize };
}

function taskFamilyKey(taskFamily: string | null | undefined): string {
  return taskFamily ?? "__unknown__";
}

function normalizeAndDeduplicate(events: ReviewMetricEvent[]): {
  events: NormalizedEvent[];
  conflictingDeliveries: Set<string>;
  invalidEvents: number;
} {
  const byDelivery = new Map<string, NormalizedEvent>();
  const conflictingDeliveries = new Set<string>();
  let invalidEvents = 0;

  for (const event of events) {
    const occurredAt = asDate(event.occurredAt);
    if (!occurredAt) {
      invalidEvents += 1;
      continue;
    }
    const normalized = { ...event, occurredAt };
    const previous = byDelivery.get(event.deliveryId);
    if (!previous) {
      byDelivery.set(event.deliveryId, normalized);
      continue;
    }
    // A replay with the same identity is harmless. The database's unique key
    // normally prevents the conflicting branch, but keeping it here makes
    // offline reports fail closed too.
    if (
      previous.eventType !== normalized.eventType ||
      previous.repo !== normalized.repo ||
      previous.prNumber !== normalized.prNumber ||
      previous.occurredAt.getTime() !== normalized.occurredAt.getTime()
    ) {
      conflictingDeliveries.add(event.deliveryId);
    }
  }

  return {
    events: [...byDelivery.values()].sort(
      (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()
    ),
    conflictingDeliveries,
    invalidEvents,
  };
}

type PullRequestRollup = {
  key: string;
  workspaceId: string;
  taskFamily: string | null;
  events: NormalizedEvent[];
  conflicting: boolean;
};

function lifecycleIsComplete(events: NormalizedEvent[]): boolean {
  let status: "open" | "merged" | "closed" | "unknown" = "unknown";
  for (const event of events) {
    if (event.eventType === "opened") status = "open";
    if (event.eventType === "reopened") status = "open";
    if (event.eventType === "merged") status = "merged";
    if (event.eventType === "closed") status = "closed";
  }
  return status === "merged" || status === "closed";
}

function hasLifecycleConflict(events: NormalizedEvent[]): boolean {
  const openedAt = events.find((event) => event.eventType === "opened")?.occurredAt;
  if (!openedAt) return true;

  let lastTerminalAt: number | null = null;
  for (const event of events) {
    if (event.occurredAt.getTime() < openedAt.getTime()) return true;
    if (event.eventType === "review_submitted" && event.occurredAt < openedAt) {
      return true;
    }
    if (event.eventType === "merged" || event.eventType === "closed") {
      lastTerminalAt = event.occurredAt.getTime();
    }
    if (event.eventType === "reverted" || event.eventType === "post_merge_rework") {
      if (lastTerminalAt === null || event.occurredAt.getTime() < lastTerminalAt) {
        return true;
      }
    }
  }
  return false;
}

function buildRollups(events: ReviewMetricEvent[]): {
  rollups: PullRequestRollup[];
  conflictingDeliveries: number;
  invalidEvents: number;
} {
  const normalized = normalizeAndDeduplicate(events);
  const byPr = new Map<string, PullRequestRollup>();
  const conflictKeys = new Set<string>();

  for (const event of normalized.events) {
    const key = `${event.workspaceId}:${event.repo}:${event.prNumber}`;
    const existing = byPr.get(key);
    if (existing) {
      existing.events.push(event);
      if (existing.taskFamily !== (event.taskFamily ?? null)) existing.conflicting = true;
    } else {
      byPr.set(key, {
        key,
        workspaceId: event.workspaceId,
        taskFamily: event.taskFamily ?? null,
        events: [event],
        conflicting: false,
      });
    }
    if (normalized.conflictingDeliveries.has(event.deliveryId)) conflictKeys.add(key);
  }

  for (const rollup of byPr.values()) {
    if (hasLifecycleConflict(rollup.events)) rollup.conflicting = true;
    if (conflictKeys.has(rollup.key)) rollup.conflicting = true;
  }

  return {
    rollups: [...byPr.values()],
    conflictingDeliveries: normalized.conflictingDeliveries.size,
    invalidEvents: normalized.invalidEvents,
  };
}

function metricEventsForWindow(
  events: ReviewMetricEvent[],
  window: ReviewMetricWindow
): ReviewMetricEvent[] {
  return events.filter((event) => {
    const date = asDate(event.occurredAt);
    if (!date) return true; // keep it so the report can count it as invalid
    if (window.from && date < window.from) return false;
    if (window.to && date >= window.to) return false;
    return true;
  });
}

/**
 * Compute dated, falsifiable review metrics from append-only evidence.
 *
 * Definitions are intentionally conservative:
 * - time-to-first-review is the median from `opened` to the first submitted
 *   review after it;
 * - review cycles is the average number of submitted reviews per PR;
 * - merge rate is merged / (merged + closed), excluding still-open PRs;
 * - PR size is the median additions + deletions from the latest complete size
 *   snapshot;
 * - rework is the count of explicit `reverted` and `post_merge_rework` events;
 * - human review minutes are the sum of explicit `human_review_time` events.
 *
 * A null value means the evidence is not sufficient. In particular, elapsed
 * calendar time is never used as human review time.
 */
export function computeReviewMetrics(
  inputEvents: ReviewMetricEvent[],
  window: ReviewMetricWindow = {}
): ReviewMetrics[] {
  const filtered = metricEventsForWindow(inputEvents, window);
  const { rollups, conflictingDeliveries, invalidEvents } = buildRollups(filtered);
  const groups = new Map<string, PullRequestRollup[]>();

  for (const rollup of rollups) {
    const key = `${rollup.workspaceId}:${taskFamilyKey(rollup.taskFamily)}`;
    const group = groups.get(key) ?? [];
    group.push(rollup);
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => {
    const workspaceId = group[0]!.workspaceId;
    const taskFamily = group[0]!.taskFamily;
    const eligible = group.filter((rollup) => !rollup.conflicting);
    const opened = eligible.filter((rollup) =>
      rollup.events.some((event) => event.eventType === "opened")
    );
    const terminal = opened.filter((rollup) => lifecycleIsComplete(rollup.events));
    const merged = terminal.filter((rollup) =>
      rollup.events.some((event) => event.eventType === "merged")
    );

    const timeToReview: number[] = [];
    const cycleCounts: number[] = [];
    const sizes: number[] = [];
    const reworkCounts: number[] = [];
    const humanMinutes: number[] = [];

    for (const rollup of opened) {
      const openedEvent = rollup.events.find((event) => event.eventType === "opened");
      if (!openedEvent) continue;
      const reviews = rollup.events.filter((event) => event.eventType === "review_submitted");
      const validReviews = reviews.filter(
        (event) => event.occurredAt.getTime() >= openedEvent.occurredAt.getTime()
      );
      if (validReviews.length > 0 && validReviews.length === reviews.length) {
        timeToReview.push(
          (validReviews[0]!.occurredAt.getTime() - openedEvent.occurredAt.getTime()) / 1000
        );
      }

      // A terminal PR, or a report with an explicit observation boundary, is
      // the only case where zero submitted reviews is a known zero.
      if (terminal.includes(rollup) || window.observedUntil) cycleCounts.push(reviews.length);

      const sizeEvent = [...rollup.events]
        .reverse()
        .find(
          (event) =>
            typeof event.additions === "number" && typeof event.deletions === "number"
        );
      if (sizeEvent) sizes.push(sizeEvent.additions! + sizeEvent.deletions!);

      const mergedEvent = rollup.events.find((event) => event.eventType === "merged");
      if (mergedEvent && window.observedUntil && window.observedUntil >= mergedEvent.occurredAt) {
        reworkCounts.push(
          rollup.events.filter(
            (event) =>
              (event.eventType === "reverted" || event.eventType === "post_merge_rework") &&
              event.occurredAt >= mergedEvent.occurredAt
          ).length
        );
      }

      const explicitMinutes = rollup.events
        .filter(
          (event) =>
            event.eventType === "human_review_time" &&
            typeof event.humanReviewMinutes === "number" &&
            event.humanReviewMinutes >= 0 &&
            (event.humanReviewSource === "human_input" || event.humanReviewSource === "timer")
        )
        .reduce((total, event) => total + event.humanReviewMinutes!, 0);
      if (rollup.events.some((event) => event.eventType === "human_review_time")) {
        humanMinutes.push(explicitMinutes);
      }
    }

    const limitations = [
      "Reverts and post-merge rework are counted only when an explicit event is recorded; generic pushes are not interpreted as either.",
      "Human review minutes come only from explicit human_input or timer events; calendar elapsed time is excluded.",
    ];
    const exclusions: string[] = [];
    if (conflictingDeliveries > 0) exclusions.push(`${conflictingDeliveries} conflicting delivery replay(s)`);
    if (invalidEvents > 0) exclusions.push(`${invalidEvents} event(s) with invalid timestamps`);
    if (group.length !== eligible.length) exclusions.push(`${group.length - eligible.length} PR(s) with missing or conflicting lifecycle evidence`);
    if (opened.length !== group.length) exclusions.push(`${group.length - opened.length} PR(s) without an opened event`);

    const from = window.from ?? null;
    const to = window.to ?? window.observedUntil ?? null;
    return {
      workspaceId,
      taskFamily,
      dateRange: from && to ? { from, to } : null,
      sampleSize: opened.length,
      denominator: {
        openedPullRequests: opened.length,
        terminalPullRequests: terminal.length,
        mergeRate: terminal.length,
      },
      medianTimeToFirstReviewSeconds: value(median(timeToReview), timeToReview.length),
      averageReviewCycles: value(average(cycleCounts), cycleCounts.length),
      medianPrSizeLines: value(median(sizes), sizes.length),
      mergeRate: value(terminal.length > 0 ? merged.length / terminal.length : null, terminal.length),
      postMergeReworkEvents: value(
        reworkCounts.length > 0 ? reworkCounts.reduce((sum, count) => sum + count, 0) : null,
        reworkCounts.length
      ),
      humanReviewMinutes: value(
        humanMinutes.length > 0 ? humanMinutes.reduce((sum, minutes) => sum + minutes, 0) : null,
        humanMinutes.length
      ),
      exclusions,
      limitations,
    };
  });
}

export function isReviewEventType(value: string): value is ReviewEventType {
  return [
    "opened",
    "head_updated",
    "review_submitted",
    "merged",
    "closed",
    "reopened",
    "reverted",
    "post_merge_rework",
    "human_review_time",
  ].includes(value);
}

export function isHumanReviewSource(value: string): value is HumanReviewSource {
  return value === "human_input" || value === "timer";
}

function deltaValue(current: number | null, baseline: number | null): number | null {
  if (current === null || baseline === null) return null;
  return current - baseline;
}

export function compareReviewMetrics(
  current: ReviewMetrics,
  baseline: ReviewMetrics
): ReviewMetricComparison {
  return {
    sampleSizeDelta: current.sampleSize - baseline.sampleSize,
    denominatorDelta: {
      openedPullRequests:
        current.denominator.openedPullRequests - baseline.denominator.openedPullRequests,
      terminalPullRequests:
        current.denominator.terminalPullRequests - baseline.denominator.terminalPullRequests,
      mergeRate: current.denominator.mergeRate - baseline.denominator.mergeRate,
    },
    medianTimeToFirstReviewSecondsDelta: deltaValue(
      current.medianTimeToFirstReviewSeconds.value,
      baseline.medianTimeToFirstReviewSeconds.value
    ),
    averageReviewCyclesDelta: deltaValue(
      current.averageReviewCycles.value,
      baseline.averageReviewCycles.value
    ),
    medianPrSizeLinesDelta: deltaValue(
      current.medianPrSizeLines.value,
      baseline.medianPrSizeLines.value
    ),
    mergeRateDelta: deltaValue(current.mergeRate.value, baseline.mergeRate.value),
    postMergeReworkEventsDelta: deltaValue(
      current.postMergeReworkEvents.value,
      baseline.postMergeReworkEvents.value
    ),
    humanReviewMinutesDelta: deltaValue(
      current.humanReviewMinutes.value,
      baseline.humanReviewMinutes.value
    ),
  };
}
