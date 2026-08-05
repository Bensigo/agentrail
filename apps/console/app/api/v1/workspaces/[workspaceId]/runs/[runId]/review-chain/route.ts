import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getRun,
  getWorkspaceMembership,
  listReviewEventsForPrHead,
  listReviewJobsForPrHead,
} from "@agentrail/db-postgres";
import { parseGithubPrUrl } from "../../../../../../../../lib/github-merge";

export type ReviewChainPrResolution =
  | {
      state: "resolved";
      repo: string;
      number: number;
    }
  | {
      state: "no_pr";
      repo: null;
      number: null;
    }
  | {
      state: "unknown";
      repo: null;
      number: null;
    };

export type ReviewChainEvidenceResolution =
  | { state: "head_bound"; headSha: string }
  | { state: "unknown"; headSha: null };

/**
 * Resolve a run's PR URL into the repo slug + PR number the chain queries need.
 * Empty / absent input is a real "no PR" state; malformed or foreign URLs stay
 * explicitly "unknown" so the route never guesses.
 */
export function resolveReviewChainPr(
  prUrl: string | null | undefined
): ReviewChainPrResolution {
  if (!prUrl) {
    return { state: "no_pr", repo: null, number: null };
  }

  const parsed = parseGithubPrUrl(prUrl);
  if (!parsed) {
    return { state: "unknown", repo: null, number: null };
  }

  return {
    state: "resolved",
    repo: `${parsed.owner}/${parsed.repo}`,
    number: parsed.number,
  };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; runId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId, runId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const run = await getRun(workspaceId, runId);
  if (!run) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const prResolution = resolveReviewChainPr(run.prUrl);
  const publishedHead = run.prHeadSha?.trim() || null;
  const evidenceResolution: ReviewChainEvidenceResolution = publishedHead
    ? { state: "head_bound", headSha: publishedHead }
    : { state: "unknown", headSha: null };
  let reviewJobs: Awaited<ReturnType<typeof listReviewJobsForPrHead>> = [];
  let reviewEvents: Awaited<ReturnType<typeof listReviewEventsForPrHead>> = [];

  if (prResolution.state === "resolved" && publishedHead) {
    try {
      [reviewJobs, reviewEvents] = await Promise.all([
        listReviewJobsForPrHead({
          workspaceId,
          repo: prResolution.repo,
          prNumber: prResolution.number,
          headSha: publishedHead,
        }),
        listReviewEventsForPrHead({
          workspaceId,
          repo: prResolution.repo,
          prNumber: prResolution.number,
          headSha: publishedHead,
        }),
      ]);
    } catch (err) {
      console.error("[review chain] failed to load review history:", err);
      return NextResponse.json(
        { error: "Failed to load review chain" },
        { status: 500 }
      );
    }
  }

  return NextResponse.json({
    run: {
      id: run.id,
      workspaceId: run.workspaceId,
      queueEntryId: run.queueEntryId ?? null,
      prUrl: run.prUrl || null,
      prHeadSha: publishedHead,
    },
    prResolution,
    evidenceResolution,
    reviewJobs,
    reviewEvents,
  });
}
