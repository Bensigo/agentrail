import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getRun,
  getRunQueueEntryIdentity,
  getQueueEntryBriefReference,
  getWorkspaceMembership,
  listReviewEventsForPrHead,
  listReviewJobsForPrHead,
} from "@agentrail/db-postgres";
import { resolveReviewChainPr } from "./review-chain";

function trustedQueueRepository(externalId: string | null | undefined): string | null {
  if (!externalId) return null;
  const separator = externalId.lastIndexOf("#");
  const repo = separator > 0 ? externalId.slice(0, separator) : "";
  return repo.includes("/") ? repo : null;
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
  const evidenceResolution = publishedHead
    ? { state: "head_bound" as const, headSha: publishedHead }
    : { state: "unknown" as const, headSha: null };
  type AlignmentBriefResolution =
    | { state: "linked"; id: string }
    | { state: "absent"; id: null }
    | { state: "unknown"; id: null };
  let alignmentBrief: AlignmentBriefResolution = { state: "absent", id: null };
  if (run.queueEntryId) {
    try {
      const briefReference = await getQueueEntryBriefReference(
        workspaceId,
        run.queueEntryId
      );
      alignmentBrief = briefReference?.alignmentBriefId
        ? { state: "linked", id: briefReference.alignmentBriefId }
        : { state: "unknown", id: null };
    } catch (err) {
      console.error("[review chain] failed to load alignment brief reference:", err);
      return NextResponse.json(
        { error: "Failed to load review chain" },
        { status: 500 }
      );
    }
  }

  if (prResolution.state === "resolved") {
    const queueIdentity = await getRunQueueEntryIdentity(workspaceId, runId);
    const trustedRepo = trustedQueueRepository(queueIdentity?.externalId);
    if (!trustedRepo) {
      return NextResponse.json({
        run: {
          id: run.id,
          workspaceId: run.workspaceId,
          queueEntryId: run.queueEntryId ?? null,
          prUrl: run.prUrl || null,
          prHeadSha: publishedHead,
        },
        prResolution: {
          state: "unknown",
          repo: null,
          number: null,
          reason: "missing_trusted_repository",
        },
        alignmentBrief,
        evidenceResolution,
        reviewJobs: [],
        reviewEvents: [],
      });
    }
    if (trustedRepo.toLowerCase() !== prResolution.repo.toLowerCase()) {
      return NextResponse.json({
        run: {
          id: run.id,
          workspaceId: run.workspaceId,
          queueEntryId: run.queueEntryId ?? null,
          prUrl: run.prUrl || null,
          prHeadSha: publishedHead,
        },
        prResolution: {
          state: "unknown",
          repo: null,
          number: null,
          reason: "repository_mismatch",
        },
        alignmentBrief,
        evidenceResolution,
        reviewJobs: [],
        reviewEvents: [],
      });
    }
  }

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
    alignmentBrief,
    prResolution,
    evidenceResolution,
    reviewJobs,
    reviewEvents,
  });
}
