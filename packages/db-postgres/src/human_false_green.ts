import type { ReviewEventRow } from "./schema/review_events.js";

export type SuccessfulRunForHumanFalseGreen = {
  id: string;
  workspaceId: string;
  status: "success" | "queued" | "running" | "failed";
  finishedAt: Date | null;
  prUrl: string | null;
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
    missingPr: number;
    missingPublishedHead: number;
    malformedPr: number;
    noMatchingHumanOutcome: number;
  };
  limitations: string[];
};

type PullRequestIdentity = { repo: string; prNumber: number };

function parsePullRequest(url: string | null): PullRequestIdentity | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") return null;
  const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)$/);
  if (!match) return null;
  const prNumber = Number(match[3]);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return null;
  return { repo: `${match[1]}/${match[2]}`.toLowerCase(), prNumber };
}

function canonicalCommit(value: string | null): string | null {
  if (!value || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value)) return null;
  return value.toLowerCase();
}

function isExplicitHumanDecision(event: ReviewEventRow): boolean {
  if (event.eventType !== "review_submitted" || event.actorType !== "human") {
    return false;
  }
  const state = event.reviewState?.toLowerCase();
  return state === "approved" || state === "changes_requested";
}

/**
 * Compute the production human false-green metric from two durable ledgers.
 *
 * This deliberately does not look at offline evaluations, generic GitHub
 * pushes, commit messages, or elapsed calendar time. A known denominator row
 * needs: a successful completed run, a canonical PR, its exact published
 * commit, and an explicit human approval/change-request on that same tuple.
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
      run.status === "success" &&
      run.finishedAt !== null &&
      run.finishedAt >= window.from &&
      run.finishedAt < window.to
  );
  let missingPr = 0;
  let missingPublishedHead = 0;
  let malformedPr = 0;
  let noMatchingHumanOutcome = 0;
  let knownSampleSize = 0;
  let falseGreenCount = 0;

  for (const run of successfulRuns) {
    if (!run.prUrl) {
      missingPr += 1;
      continue;
    }
    const pr = parsePullRequest(run.prUrl);
    if (!pr) {
      malformedPr += 1;
      continue;
    }
    const headSha = canonicalCommit(run.prHeadSha);
    if (!headSha) {
      missingPublishedHead += 1;
      continue;
    }

    const matchingDecisions = reviewEvents.filter((event) => {
      const eventHead = canonicalCommit(event.headSha);
      return (
        event.workspaceId === run.workspaceId &&
        event.repo.toLowerCase() === pr.repo &&
        event.prNumber === pr.prNumber &&
        eventHead === headSha &&
        event.occurredAt >= run.finishedAt! &&
        event.occurredAt <= window.observedUntil &&
        isExplicitHumanDecision(event)
      );
    });
    if (matchingDecisions.length === 0) {
      noMatchingHumanOutcome += 1;
      continue;
    }

    knownSampleSize += 1;
    if (
      matchingDecisions.some(
        (event) => event.reviewState?.toLowerCase() === "changes_requested"
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
      missingPr,
      missingPublishedHead,
      malformedPr,
      noMatchingHumanOutcome,
    },
    limitations: [
      "Only explicit human APPROVED or CHANGES_REQUESTED review submissions are outcomes; generic pushes, commit messages, and inferred reverts are excluded.",
      "A human outcome is attributable only when workspace, repository, PR number, and exact published head SHA all match the successful run.",
      "A run without a matching explicit human outcome remains unknown; it is never counted as an approval or a zero false-green result.",
      "This production metric is separate from offline hidden-test false-green evaluation results.",
    ],
  };
}
