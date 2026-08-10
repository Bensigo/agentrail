import { isDeepStrictEqual } from "node:util";
import { NextRequest, NextResponse } from "next/server";
import {
  appendChangeRecordEvent,
  getInstallationToken,
  getJaceSessionByEveSessionId,
  getRepositoryByName,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../../lib/jace-console-auth";
import { postGithubAdvisoryReview } from "../../../../../../../lib/github-advisory-review";
import {
  type CriterionResult,
  REVIEW_JOB_POST_ACTOR,
  REVIEW_JOB_POST_STAGE,
  findMatchingPostAttempt,
  findMatchingPostedAttestation,
  parseCriterionResults,
  resolveExactReviewJobProof,
  reviewOutcomeDigest,
  reviewPostAttemptEventKey,
  reviewPostAttemptPayload,
  reviewPostPayloadDigest,
  reviewPostedAttestationEventKey,
  reviewPostedAttestationPayload,
} from "../../../../../../../lib/review-job-proof-attestation";

interface ReviewComment {
  path: string;
  line: number;
  body: string;
}

interface PostReviewBody {
  eveSessionId: string;
  summary: string;
  comments: ReviewComment[];
  criterionResults: CriterionResult[];
  verdict: string;
  summaryLine: string;
  evidenceKeys?: string[];
}

function nonBlank(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function parseComment(value: unknown): ReviewComment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (!exactKeys(input, ["path", "line", "body"])) return null;
  const path = nonBlank(input.path);
  const body = nonBlank(input.body);
  if (
    !path ||
    !body ||
    typeof input.line !== "number" ||
    !Number.isInteger(input.line) ||
    input.line <= 0
  ) {
    return null;
  }
  return { path, line: input.line, body };
}

function parseBody(value: unknown): PostReviewBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const expectedKeys = [
    "eveSessionId",
    "summary",
    "comments",
    "criterionResults",
    "verdict",
    "summaryLine",
    ...(input.evidenceKeys === undefined ? [] : ["evidenceKeys"]),
  ];
  if (!exactKeys(input, expectedKeys)) return null;

  const eveSessionId = nonBlank(input.eveSessionId);
  const verdict = nonBlank(input.verdict);
  const summaryLine = nonBlank(input.summaryLine);
  if (
    !eveSessionId ||
    !verdict ||
    !summaryLine ||
    typeof input.summary !== "string" ||
    !Array.isArray(input.comments)
  ) {
    return null;
  }
  const comments = input.comments.map(parseComment);
  if (comments.some((comment) => !comment)) return null;
  if (!input.summary.trim() && comments.length === 0) return null;

  const criterionResults = parseCriterionResults(input.criterionResults);
  if (!criterionResults) return null;
  let evidenceKeys: string[] | undefined;
  if (input.evidenceKeys !== undefined) {
    if (
      !Array.isArray(input.evidenceKeys) ||
      input.evidenceKeys.some((key) => !nonBlank(key))
    ) {
      return null;
    }
    evidenceKeys = input.evidenceKeys.map((key) => (key as string).trim());
  }
  return {
    eveSessionId,
    summary: input.summary,
    comments: comments as ReviewComment[],
    criterionResults,
    verdict,
    summaryLine,
    ...(evidenceKeys === undefined ? {} : { evidenceKeys }),
  };
}

function existingEvent(
  events: Array<{ eventKey: string }>,
  eventKey: string
): boolean {
  return events.some((event) => event.eventKey === eventKey);
}

function replayResponse(
  body: PostReviewBody,
  attestation: Record<string, unknown> & { postedReviewUrl: string }
): NextResponse {
  const commentsFolded = attestation.commentsFolded === true;
  return NextResponse.json(
    {
      posted: true,
      replayed: true,
      reviewUrl: attestation.postedReviewUrl,
      summary: body.summary,
      inlineCommentsPosted:
        typeof attestation.inlineCommentsPosted === "number"
          ? attestation.inlineCommentsPosted
          : commentsFolded
            ? 0
            : body.comments.length,
      foldedComments: commentsFolded ? body.comments : [],
    },
    { status: 200 }
  );
}

/**
 * Validate one review job's exact Contract plan and runtime evidence before
 * reserving and performing its one external GitHub write. The request names
 * no repo, PR, or head; all three come from the bound running job.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const unauthorized = requireJaceConsoleSecret(request);
  if (unauthorized) return unauthorized;

  const body = parseBody(await request.json().catch(() => null));
  const jobId = (await params).jobId?.trim();
  if (!body || !jobId) {
    return NextResponse.json(
      {
        error:
          "eveSessionId, summary, comments, criterionResults, verdict, summaryLine, and optional evidenceKeys are required and no target fields are accepted",
      },
      { status: 400 }
    );
  }

  // Resolve the bound job session before looking up the job id, so this seam
  // does not become an existence oracle for arbitrary review jobs.
  const session = await getJaceSessionByEveSessionId(body.eveSessionId);
  if (
    !session ||
    session.eveSessionId !== body.eveSessionId ||
    session.channel !== "review-job" ||
    session.conversationKey !== `review-job:${jobId}` ||
    session.status !== "active"
  ) {
    return NextResponse.json(
      { error: "review session is not bound to this job" },
      { status: 409 }
    );
  }

  const proof = await resolveExactReviewJobProof({
    jobId,
    criterionResults: body.criterionResults,
    verdict: body.verdict,
    evidenceKeys: body.evidenceKeys,
  });
  if (
    !proof ||
    !session.workspaceId ||
    session.workspaceId !== proof.job.workspaceId
  ) {
    return NextResponse.json(
      {
        error:
          "review result does not exactly cover the confirmed Contract plan with server-attested exact-head criterion evidence",
      },
      { status: 409 }
    );
  }

  const outcomeDigest = reviewOutcomeDigest({
    criterionResults: body.criterionResults,
    verdict: body.verdict,
    summaryLine: body.summaryLine,
    evidenceKeys: body.evidenceKeys,
  });
  const marker = `<!-- agentrail-review-job:${jobId}:${outcomeDigest} -->`;
  const attestedStatus = `**AgentRail exact-head verification: ${body.verdict}.**`;
  const githubSummary = body.summary.trim()
    ? `${attestedStatus}\n\n${body.summary}\n\n${marker}`
    : `${attestedStatus}\n\n${marker}`;
  const postPayloadDigest = reviewPostPayloadDigest({
    outcomeDigest,
    summary: githubSummary,
    comments: body.comments,
  });

  const postedEventKey = reviewPostedAttestationEventKey(jobId);
  const priorPosted = findMatchingPostedAttestation({
    proof,
    outcomeDigest,
    postPayloadDigest,
  });
  if (priorPosted) return replayResponse(body, priorPosted);
  if (existingEvent(proof.timeline.events, postedEventKey)) {
    return NextResponse.json(
      { error: "this review job already posted a different attested review" },
      { status: 409 }
    );
  }

  const attemptEventKey = reviewPostAttemptEventKey(jobId);
  if (
    findMatchingPostAttempt({ proof, outcomeDigest, postPayloadDigest }) ||
    existingEvent(proof.timeline.events, attemptEventKey)
  ) {
    return NextResponse.json(
      {
        error:
          "a prior GitHub post attempt has an unknown outcome; automatic retry is held to prevent a duplicate review",
      },
      { status: 409 }
    );
  }

  const repo = await getRepositoryByName(proof.job.workspaceId, proof.job.repo);
  if (!repo) {
    return NextResponse.json(
      { error: "review job repository is not connected to its workspace" },
      { status: 409 }
    );
  }
  const token = await getInstallationToken(proof.job.workspaceId);
  if (!token) {
    return NextResponse.json(
      {
        error:
          "GitHub is not connected for this workspace — install the Jace GitHub App first",
      },
      { status: 409 }
    );
  }

  // This append-only reservation is deliberately before fetch. Once it is
  // durable, an ambiguous network outcome is held for reconciliation rather
  // than retried into a duplicate external review.
  const attemptPayload = reviewPostAttemptPayload({
    proof,
    outcomeDigest,
    postPayloadDigest,
  });
  let attempt: Awaited<ReturnType<typeof appendChangeRecordEvent>>;
  try {
    attempt = await appendChangeRecordEvent({
      recordId: proof.timeline.record.id,
      eventKey: attemptEventKey,
      stage: REVIEW_JOB_POST_STAGE,
      actor: REVIEW_JOB_POST_ACTOR,
      payloadRef: attemptPayload,
    });
  } catch {
    return NextResponse.json(
      { error: "could not reserve the GitHub review attempt" },
      { status: 503 }
    );
  }
  if (!attempt.inserted || !isDeepStrictEqual(attempt.event.payloadRef, attemptPayload)) {
    return NextResponse.json(
      { error: "GitHub post attempt is already reserved for this review job" },
      { status: 409 }
    );
  }

  const posted = await postGithubAdvisoryReview({
    repo: proof.job.repo,
    prNumber: proof.job.prNumber,
    headSha: proof.job.headSha,
    token,
    summary: githubSummary,
    comments: body.comments,
  });
  if (!posted.ok) {
    return NextResponse.json({ error: posted.error }, { status: posted.status });
  }

  const postedPayload = reviewPostedAttestationPayload({
    proof,
    outcomeDigest,
    postPayloadDigest,
    postedReviewUrl: posted.reviewUrl,
    inlineCommentsPosted: posted.inlineCommentsPosted,
    commentsFolded: posted.foldedComments.length > 0,
  });
  let recorded: Awaited<ReturnType<typeof appendChangeRecordEvent>>;
  try {
    recorded = await appendChangeRecordEvent({
      recordId: proof.timeline.record.id,
      eventKey: postedEventKey,
      stage: REVIEW_JOB_POST_STAGE,
      actor: REVIEW_JOB_POST_ACTOR,
      payloadRef: postedPayload,
    });
  } catch {
    return NextResponse.json(
      {
        error:
          "GitHub accepted the review but its posted receipt could not be stored; automatic retry is held",
      },
      { status: 503 }
    );
  }
  if (!isDeepStrictEqual(recorded.event.payloadRef, postedPayload)) {
    return NextResponse.json(
      { error: "posted review attestation conflicts with the existing receipt" },
      { status: 409 }
    );
  }

  return NextResponse.json(
    {
      posted: true,
      replayed: false,
      reviewUrl: posted.reviewUrl,
      summary: posted.summary,
      inlineCommentsPosted: posted.inlineCommentsPosted,
      foldedComments: posted.foldedComments,
    },
    { status: 201 }
  );
}
