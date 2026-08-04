import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getRun,
  getWorkspaceMembership,
  listReviewEventsForPr,
  listReviewJobsForPr,
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
  let reviewJobs: Awaited<ReturnType<typeof listReviewJobsForPr>> = [];
  let reviewEvents: Awaited<ReturnType<typeof listReviewEventsForPr>> = [];

  if (prResolution.state === "resolved") {
    try {
      [reviewJobs, reviewEvents] = await Promise.all([
        listReviewJobsForPr({
          workspaceId,
          repo: prResolution.repo,
          prNumber: prResolution.number,
        }),
        listReviewEventsForPr({
          workspaceId,
          repo: prResolution.repo,
          prNumber: prResolution.number,
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
    },
    prResolution,
    reviewJobs,
    reviewEvents,
  });
}
