import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, recordReviewEvent } from "@agentrail/db-postgres";

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HEAD_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;
const OUTCOMES = new Set(["reverted", "post_merge_rework"]);

type HumanOutcomeInput = {
  repo?: unknown;
  prNumber?: unknown;
  headSha?: unknown;
  outcome?: unknown;
  occurredAt?: unknown;
  idempotencyKey?: unknown;
};

function parseInput(value: unknown):
  | {
      repo: string;
      prNumber: number;
      headSha: string;
      outcome: "reverted" | "post_merge_rework";
      occurredAt: Date;
      idempotencyKey: string;
    }
  | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as HumanOutcomeInput;
  if (typeof input.repo !== "string" || !REPO.test(input.repo)) return null;
  const prNumber = input.prNumber;
  if (typeof prNumber !== "number" || !Number.isSafeInteger(prNumber) || prNumber <= 0) {
    return null;
  }
  if (typeof input.headSha !== "string" || !HEAD_SHA.test(input.headSha)) return null;
  if (typeof input.outcome !== "string" || !OUTCOMES.has(input.outcome)) return null;
  if (
    typeof input.idempotencyKey !== "string" ||
    !IDEMPOTENCY_KEY.test(input.idempotencyKey)
  ) {
    return null;
  }
  const occurredAt =
    input.occurredAt === undefined ? new Date() : new Date(String(input.occurredAt));
  if (Number.isNaN(occurredAt.getTime())) return null;

  return {
    repo: input.repo,
    prNumber,
    headSha: input.headSha.toLowerCase(),
    outcome: input.outcome as "reverted" | "post_merge_rework",
    occurredAt,
    idempotencyKey: input.idempotencyKey,
  };
}

/**
 * Append explicit human evidence that a successful PR head was reverted or
 * required post-merge rework. This is intentionally an operator input: a
 * generic push, commit message, or elapsed time must never create this event.
 *
 * The logged-in member is the actor. The client supplies a scoped idempotency
 * key so a retried submission cannot inflate the false-green numerator.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const input = parseInput(body);
  if (!input) {
    return NextResponse.json(
      {
        error:
          "repo, positive integer prNumber, exact 40/64-character headSha, reverted or post_merge_rework outcome, and 8-128 character idempotencyKey are required",
      },
      { status: 400 }
    );
  }

  const result = await recordReviewEvent({
    workspaceId,
    repo: input.repo,
    prNumber: input.prNumber,
    deliveryId: `human-outcome:${workspaceId}:${session.user.id}:${input.idempotencyKey}`,
    eventType: input.outcome,
    occurredAt: input.occurredAt,
    headSha: input.headSha,
    actorType: "human",
  });
  return NextResponse.json({ ...result, duplicate: !result.recorded });
}
