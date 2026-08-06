import { createHmac, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  attachExternalPullRequest,
  enqueueAcceptanceEvidenceReviewRequest,
  getWorkspaceByGithubInstallationId,
  getRepositoryByName,
  appendChangeRecordEvent,
  findAcceptanceBuilderHandoffForPullRequest,
  findOrCreateChangeRecord,
  markAcceptanceBuilderHandoffPrAttached,
  triggerDependencyWatchesForPush,
  recordReviewEvent,
} from "@agentrail/db-postgres";

/**
 * GitHub-App `pull_request` webhook — the intake boundary for the Acceptance
 * Record. It may attach only a pre-recorded external-builder handoff to its
 * exact repository and head; it never creates an advisory review job, reviews,
 * or calls GitHub back. Once auth
 * passes it is never itself a source of retries: GitHub redelivers on
 * anything but a 2xx, so EVERY post-auth outcome here is 200 (house
 * doctrine, `../../connectors/telegram/webhook/route.ts`) — the only 4xx
 * this route ever returns is an auth failure, before the payload is trusted
 * at all.
 *
 * Deliberately a NEW, App-scoped route — NOT an extension of the classic
 * per-repo `../../connectors/github/webhook/route.ts`, which resolves
 * workspaces by repo-name containment (a different model) and, worse, fails
 * OPEN when its signature secret is unset (that file's `verifySignature`:
 * "no secret configured -> skip (insecure but convenient)"). That is the
 * documented anti-pattern this route exists to NOT repeat: an unset
 * `GITHUB_APP_WEBHOOK_SECRET` here is a hard 401, mirroring
 * `telegram/webhook/route.ts`'s own FAIL-CLOSED doc-comment (:53-59) — this
 * endpoint is a public GitHub-facing URL reachable by anyone who guesses it,
 * so "secret unset" must never read as "open".
 *
 * AUTH ORDER (never reorder): (1) is a secret even configured -> else 401
 * BEFORE the body is read off the request stream at all; (2) does
 * `X-Hub-Signature-256` (HMAC-SHA256 of the RAW body bytes, `timingSafeEqual`
 * with a length guard so two different-length buffers never even reach the
 * constant-time compare) match -> else 401. The payload is `JSON.parse`d
 * only AFTER both checks pass — GitHub signs the exact bytes it sent, not a
 * re-serialized object, so verifying against anything but the raw text would
 * silently break on the first whitespace/key-order difference.
 *
 * ADMISSION CHAIN (every step's failure is a 200 ignore, never a throw —
 * webhooks are not an error surface): `X-GitHub-Event` must be
 * `pull_request`, `pull_request_review`, or the enrolled dependency-watch
 * `push` path (checked off the header alone, no body parsing needed) ->
 * the body must parse as JSON -> `action` must be one of
 * opened|ready_for_review|reopened|synchronize, or a merged `closed` event -> a draft PR
 * (`pull_request.draft === true`) is skipped for opened/reopened/synchronize
 * (it (re-)enters once `ready_for_review` fires later; THAT action is never
 * draft-gated, regardless of the payload's `draft` value) -> `installation.id`
 * must resolve to a workspace (`getWorkspaceByGithubInstallationId`) -> that
 * workspace must be in the `REVIEWER_OF_RECORD_WORKSPACES` rollout allowlist
 * (comma-separated, trimmed; empty/unset disables intake for EVERY
 * workspace — dogfood-only until the allowlist grows) -> `repository.full_name`
 * must be a repo the workspace has actually connected
 * (`getRepositoryByName`; never proxies an unconnected repo's events). Only
 * then does a pre-recorded builder handoff match on the exact workspace,
 * connected repository, and head branch. Only that match may attach the PR at
 * its exact head; no handoff is an explicit unlinked outcome, never an
 * advisory-review queue admission.
 */

const SIGNATURE_HEADER = "x-hub-signature-256";
const DELIVERY_HEADER = "x-github-delivery";
const EVENT_HEADER = "x-github-event";
const ENROLLED_WORKSPACES_ENV = "REVIEWER_OF_RECORD_WORKSPACES";

// The four `pull_request` actions this queue admits (design spec §1). A
// merged `closed` delivery is handled separately as a Change Record event.
const TRIGGER_ACTIONS = new Set([
  "opened",
  "ready_for_review",
  "reopened",
  "synchronize",
]);

// Of those four, the ones a draft PR is skipped for. `ready_for_review` is
// deliberately excluded from this set: that IS the action a draft graduates
// through, so it is never draft-gated regardless of the payload's own
// `draft` value.
const DRAFT_SKIP_ACTIONS = new Set(["opened", "reopened", "synchronize"]);

function verifySignature(
  raw: string,
  signature: string | null,
  secret: string
): boolean {
  if (!signature) return false;
  const expected =
    "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  // Length guard BEFORE timingSafeEqual: it throws on mismatched-length
  // buffers rather than returning false, and comparing lengths first is
  // itself not a timing oracle (the expected length is not secret).
  return (
    expectedBuf.length === actualBuf.length &&
    timingSafeEqual(expectedBuf, actualBuf)
  );
}

/**
 * Comma-separated, trimmed, empty entries dropped. An empty/unset env
 * disables intake for every workspace (dogfood-only until this grows).
 */
function enrolledWorkspaceIds(): Set<string> {
  const raw = process.env[ENROLLED_WORKSPACES_ENV] ?? "";
  return new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0)
  );
}

function ignored(reason?: string): NextResponse {
  return NextResponse.json(
    reason ? { ok: true, ignored: true, reason } : { ok: true, ignored: true }
  );
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" ? (value as JsonObject) : null;
}

function actorTypeFromGitHubUserType(value: unknown): "human" | "agent" | "unknown" {
  if (value === "User") return "human";
  if (typeof value === "string" && value.toLowerCase().includes("bot")) return "agent";
  return "unknown";
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function reviewEventTypeForPullRequestAction(
  action: string,
  merged: boolean
): "opened" | "head_updated" | "reopened" | "merged" | "closed" | null {
  if (action === "opened" || action === "ready_for_review") return "opened";
  if (action === "reopened") return "reopened";
  if (action === "synchronize") return "head_updated";
  if (action === "closed") return merged ? "merged" : "closed";
  return null;
}

async function recordWebhookReviewEvent(input: {
  workspaceId: string;
  repo: string;
  prNumber: number;
  taskFamily?: string | null;
  deliveryId: string | null;
  eventType:
    | "opened"
    | "head_updated"
    | "reopened"
    | "merged"
    | "closed"
    | "review_submitted";
  occurredAt: Date;
  headSha?: string | null;
  reviewState?: string | null;
  actorType?: "human" | "agent" | "unknown" | null;
  additions?: number | null;
  deletions?: number | null;
  changedFiles?: number | null;
}): Promise<void> {
  if (!input.deliveryId) return;

  try {
    await recordReviewEvent({
      workspaceId: input.workspaceId,
      repo: input.repo,
      prNumber: input.prNumber,
      taskFamily: input.taskFamily ?? null,
      deliveryId: input.deliveryId,
      eventType: input.eventType,
      occurredAt: input.occurredAt,
      headSha: input.headSha ?? null,
      reviewState: input.reviewState ?? null,
      actorType: input.actorType ?? null,
      additions: input.additions ?? null,
      deletions: input.deletions ?? null,
      changedFiles: input.changedFiles ?? null,
    });
  } catch (error) {
    console.error("[github-app/webhook] review-event record failed:", error);
  }
}

async function handleDependencyPush(body: Record<string, unknown>): Promise<NextResponse> {
  const installation = body.installation;
  const repository = body.repository;
  const installationId = installation && typeof installation === "object"
    ? (installation as Record<string, unknown>).id
    : undefined;
  const fullName = repository && typeof repository === "object"
    ? (repository as Record<string, unknown>).full_name
    : undefined;
  if (typeof installationId !== "number" || typeof fullName !== "string") return ignored();

  const workspace = await getWorkspaceByGithubInstallationId(installationId);
  if (!workspace || !enrolledWorkspaceIds().has(workspace.workspaceId)) return ignored();
  const connectedRepo = await getRepositoryByName(workspace.workspaceId, fullName);
  if (!connectedRepo) return ignored();

  const changedPaths = new Set<string>();
  for (const commit of Array.isArray(body.commits) ? body.commits : []) {
    if (!commit || typeof commit !== "object") continue;
    for (const key of ["added", "modified", "removed"] as const) {
      const paths = (commit as Record<string, unknown>)[key];
      if (Array.isArray(paths)) {
        for (const path of paths) if (typeof path === "string") changedPaths.add(path);
      }
    }
  }
  const triggered = await triggerDependencyWatchesForPush(
    workspace.workspaceId,
    connectedRepo.id,
    [...changedPaths],
  );
  return NextResponse.json({ ok: true, dependency_watches_triggered: triggered.length, observation_only: true });
}

export async function POST(request: NextRequest) {
  // (1) fail closed BEFORE the body is even read off the stream.
  const secret = process.env["GITHUB_APP_WEBHOOK_SECRET"];
  if (!secret) {
    return NextResponse.json(
      { error: "webhook secret not configured" },
      { status: 401 }
    );
  }

  const raw = await request.text();

  // (2) verify BEFORE the payload is parsed/trusted — GitHub signs the RAW
  // bytes, so this must run against `raw`, never a re-serialized object.
  if (!verifySignature(raw, request.headers.get(SIGNATURE_HEADER), secret)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  // Only `pull_request`, `pull_request_review`, and enrolled dependency-watch
  // `push` deliveries carry work here — every other GitHub event this App may
  // be subscribed to (ping, issues, …) is a benign ignore, decided off the
  // header alone, no body parsing needed.
  const githubEvent = request.headers.get(EVENT_HEADER);
  if (githubEvent !== "pull_request" && githubEvent !== "pull_request_review" && githubEvent !== "push") {
    return ignored();
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Webhooks are never an error surface once auth has passed (house
    // doctrine) — a malformed body after a valid signature is just ignored.
    return ignored();
  }
  if (!payload || typeof payload !== "object") {
    return ignored();
  }
  const body = payload as Record<string, unknown>;

  if (githubEvent === "push") return handleDependencyPush(body);

  const action = typeof body.action === "string" ? body.action : "";
  const deliveryId = request.headers.get(DELIVERY_HEADER);
  const prObj = asObject(body.pull_request);
  const reviewObj = asObject(body.review);
  const isMergedClose = action === "closed" && prObj?.merged === true;

  if (
    githubEvent === "pull_request_review"
      ? action !== "submitted"
      : !TRIGGER_ACTIONS.has(action) && !isMergedClose
  ) {
    return ignored();
  }

  if (!prObj) {
    return ignored();
  }

  if (prObj.draft === true && DRAFT_SKIP_ACTIONS.has(action)) {
    return ignored();
  }

  const installation = body.installation;
  const installationId =
    installation && typeof installation === "object"
      ? (installation as Record<string, unknown>).id
      : undefined;
  if (typeof installationId !== "number") {
    return ignored();
  }

  const workspace = await getWorkspaceByGithubInstallationId(installationId);
  if (!workspace) {
    return ignored();
  }

  if (!enrolledWorkspaceIds().has(workspace.workspaceId)) {
    return ignored("not enrolled");
  }

  const repoFullName = asObject(body.repository)?.full_name;
  if (typeof repoFullName !== "string") {
    return ignored();
  }

  const connectedRepo = await getRepositoryByName(
    workspace.workspaceId,
    repoFullName
  );
  if (!connectedRepo) {
    return ignored();
  }

  const head = prObj.head;
  const headSha =
    head && typeof head === "object"
      ? (head as Record<string, unknown>).sha
      : undefined;
  const headRef =
    head && typeof head === "object"
      ? (head as Record<string, unknown>).ref
      : undefined;
  const baseSha =
    prObj.base && typeof prObj.base === "object"
      ? (prObj.base as Record<string, unknown>).sha
      : undefined;
  const prUrl = prObj.html_url;
  const prNumber = prObj.number;
  const occurredAt =
    githubEvent === "pull_request_review" &&
    typeof reviewObj?.submitted_at === "string"
      ? new Date(reviewObj.submitted_at)
      : isMergedClose && typeof prObj.merged_at === "string"
        ? new Date(prObj.merged_at)
        : action === "closed" && typeof prObj.closed_at === "string"
          ? new Date(prObj.closed_at)
      : typeof prObj.created_at === "string"
        ? new Date(prObj.created_at)
        : new Date();

  if (typeof headSha !== "string" || typeof prNumber !== "number" || !Number.isSafeInteger(prNumber) || prNumber < 1) {
    return ignored();
  }

  const reviewEventType =
    githubEvent === "pull_request_review"
      ? "review_submitted"
      : reviewEventTypeForPullRequestAction(action, isMergedClose);

  if (reviewEventType && !(githubEvent === "pull_request" && isMergedClose)) {
    const reviewUser = githubEvent === "pull_request_review" ? asObject(reviewObj?.user) : asObject(body.sender);
    await recordWebhookReviewEvent({
      workspaceId: workspace.workspaceId,
      repo: repoFullName,
      prNumber,
      taskFamily: null,
      deliveryId,
      eventType: reviewEventType,
      occurredAt,
      headSha,
      reviewState:
        githubEvent === "pull_request_review" && typeof reviewObj?.state === "string"
          ? reviewObj.state
          : null,
      actorType: actorTypeFromGitHubUserType(reviewUser?.type),
      additions: numberOrNull(prObj.additions),
      deletions: numberOrNull(prObj.deletions),
      changedFiles: numberOrNull(prObj.changed_files),
    });
  }

  if (githubEvent === "pull_request_review") {
    return NextResponse.json({ ok: true, recorded: reviewEventType === "review_submitted" });
  }

  if (isMergedClose) {
    const mergeCommitSha =
      typeof prObj.merge_commit_sha === "string" ? prObj.merge_commit_sha : null;
    await recordWebhookReviewEvent({
      workspaceId: workspace.workspaceId,
      repo: repoFullName,
      prNumber,
      taskFamily: null,
      deliveryId,
      eventType: "merged",
      occurredAt,
      headSha,
      actorType: actorTypeFromGitHubUserType(asObject(body.sender)?.type),
      additions: numberOrNull(prObj.additions),
      deletions: numberOrNull(prObj.deletions),
      changedFiles: numberOrNull(prObj.changed_files),
    });
    try {
      const record = await findOrCreateChangeRecord({
        workspaceId: workspace.workspaceId,
        repo: repoFullName,
        prNumber,
        headShas: [headSha],
        mergedSha: mergeCommitSha,
        state: "merged",
      });
      await appendChangeRecordEvent({
        recordId: record.id,
        eventKey: `merge:pr:${prNumber}:merged`,
        stage: "merge",
        actor: "github-webhook",
        payloadRef: {
          kind: "merge",
          repo: repoFullName,
          prNumber,
          url:
            typeof prObj.html_url === "string" ? prObj.html_url : null,
          mergeCommitSha,
          outcome: "merged",
        },
      });
    } catch (error) {
      // A signed webhook is acknowledged even when the durable attachment is
      // temporarily unavailable; GitHub may redeliver, and the event key is
      // idempotent when it does.
      console.error("[github-app/webhook] merge change-record attach failed:", error);
    }
    return NextResponse.json({ ok: true, merged: true });
  }

  if (typeof headRef !== "string" || !headRef || typeof baseSha !== "string" || !baseSha || typeof prUrl !== "string" || !prUrl) {
    return ignored("missing canonical PR identity");
  }
  const handoff = await findAcceptanceBuilderHandoffForPullRequest({
    workspaceId: workspace.workspaceId,
    repositoryId: connectedRepo.id,
    branchName: headRef,
  });
  if (!handoff) return ignored("no matching builder handoff");
  try {
    const attachment = await attachExternalPullRequest({
      workspaceId: workspace.workspaceId,
      recordId: handoff.recordId,
      repo: repoFullName,
      repositoryId: connectedRepo.id,
      prNumber,
      prUrl,
      baseSha,
      headSha,
      attachedBy: "github-webhook",
      source: "github_webhook",
    });
    await markAcceptanceBuilderHandoffPrAttached({
      handoffId: handoff.id,
      workspaceId: workspace.workspaceId,
    });
    try {
      const reviewRequest = await enqueueAcceptanceEvidenceReviewRequest({
        workspaceId: workspace.workspaceId,
        recordId: handoff.recordId,
        prRevisionId: attachment.revision.id,
        headSha: attachment.revision.headSha,
        contractId: handoff.acceptanceContractId,
        contractVersion: handoff.acceptanceContractVersion,
        requestedBy: "github-webhook",
      });
      return NextResponse.json({
        ok: true,
        linked: true,
        recordId: handoff.recordId,
        prRevisionId: attachment.revision.id,
        exactHeadSha: attachment.revision.headSha,
        reviewWorker: reviewRequest.request.status,
      });
    } catch (error) {
      // The PR attachment remains durable, but an unavailable request queue is
      // never disguised as a queued review. GitHub receives a normal webhook
      // acknowledgement; the Record remains visibly unreviewed for recovery.
      console.error("[github-app/webhook] evidence review request admission failed:", error);
      return NextResponse.json({
        ok: true,
        linked: true,
        recordId: handoff.recordId,
        prRevisionId: attachment.revision.id,
        exactHeadSha: attachment.revision.headSha,
        reviewWorker: "not_queued",
      });
    }
  } catch (error) {
    console.error("[github-app/webhook] builder handoff attach failed:", error);
    return ignored("builder handoff attachment failed");
  }
}
