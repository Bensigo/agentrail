import type { ReviewEventRow } from "./schema/review_events.js";

export type SuccessfulRunForHumanFalseGreen = {
  id: string;
  workspaceId: string;
  finishedAt: Date | null;
  prRepo: string | null;
  prNumber: number | null;
  prHeadSha: string | null;
};

export type HumanFalseGreenWindow = {
  from: Date;
  to: Date;
  /**
   * Explicit observation cutoff. A result after this time is intentionally
   * unknown to this report rather than silently treated as a human approval.
   */
  observedUntil: Date;
};

export type ProductionHumanFalseGreenReport = {
  dateRange: { from: Date; to: Date };
  observedUntil: Date;
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

function canonicalCommit(value: string | null): string | null {
  if (!value || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value)) return null;
  return value.toLowerCase();
}

function isExplicitHumanOutcome(event: ReviewEventRow): boolean {
  if (event.actorType !== "human") {
    return false;
  }
  if (event.eventType === "reverted" || event.eventType === "post_merge_rework") return true;
  if (event.eventType !== "review_submitted") return false;
  const state = event.reviewState?.toLowerCase();
  return state === "approved" || state === "changes_requested";
}

/**
 * Compute the production human false-green metric from two durable ledgers.
 *
 * This deliberately does not look at offline evaluations, generic GitHub
 * pushes, commit messages, or elapsed calendar time. A known denominator row
 * needs: a successful terminal run outcome, normalized PR identity, its exact
 * published commit, and an explicit human outcome on that same tuple.
 */
export function computeProductionHumanFalseGreen(
  runs: SuccessfulRunForHumanFalseGreen[],
  reviewEvents: ReviewEventRow[],
  window: HumanFalseGreenWindow
): ProductionHumanFalseGreenReport {
  if (window.to <= window.from) {
    throw new Error("human false-green metrics require a non-empty date range");
  }
  if (window.observedUntil < window.to) {
    throw new Error("human false-green observedUntil must not precede the report end");
  }

  const successfulRuns = runs.filter(
    (run) =>
      run.finishedAt !== null &&
      run.finishedAt >= window.from &&
      run.finishedAt < window.to
  );
  let missingPrIdentity = 0;
  let missingPublishedHead = 0;
  let noMatchingHumanOutcome = 0;
  let knownSampleSize = 0;
  let falseGreenCount = 0;

  for (const run of successfulRuns) {
    if (!run.prRepo || !run.prNumber || !Number.isSafeInteger(run.prNumber) || run.prNumber <= 0) {
      missingPrIdentity += 1;
      continue;
    }
    const repo = run.prRepo.toLowerCase();
    const headSha = canonicalCommit(run.prHeadSha);
    if (!headSha) {
      missingPublishedHead += 1;
      continue;
    }

    const matchingDecisions = reviewEvents.filter((event) => {
      const eventHead = canonicalCommit(event.headSha);
      return (
        event.workspaceId === run.workspaceId &&
        event.repo.toLowerCase() === repo &&
        event.prNumber === run.prNumber &&
        eventHead === headSha &&
        event.occurredAt >= run.finishedAt! &&
        event.occurredAt <= window.observedUntil &&
        isExplicitHumanOutcome(event)
      );
    });
    if (matchingDecisions.length === 0) {
      noMatchingHumanOutcome += 1;
      continue;
    }

    knownSampleSize += 1;
    if (
      matchingDecisions.some(
        (event) =>
          event.reviewState?.toLowerCase() === "changes_requested" ||
          event.eventType === "reverted" ||
          event.eventType === "post_merge_rework"
      )
    ) {
      falseGreenCount += 1;
    }
  }

  return {
    dateRange: { from: window.from, to: window.to },
    observedUntil: window.observedUntil,
    successfulRuns: successfulRuns.length,
    knownSampleSize,
    falseGreenCount,
    falseGreenRate: knownSampleSize > 0 ? falseGreenCount / knownSampleSize : null,
    unknown: {
      missingPrIdentity,
      missingPublishedHead,
      noMatchingHumanOutcome,
    },
    limitations: [
      "Only explicit human APPROVED or CHANGES_REQUESTED reviews and explicit human rework/revert events are outcomes; generic pushes, commit messages, and inferred reverts are excluded.",
      "A human outcome is attributable only when workspace, repository, PR number, and exact published head SHA all match the successful run.",
      "A run without a matching explicit human outcome remains unknown; it is never counted as an approval or a zero false-green result.",
      "This production metric is separate from offline hidden-test false-green evaluation results.",
    ],
  };
}
