import { createHmac, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  advanceConfirmedAcceptanceRecordPullRequestHead,
  reconcileConfirmedAcceptanceRecordPullRequestHead,
  getWorkspaceByGithubInstallationId,
  getInstallationToken,
  getRepositoryByName,
  invalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEvent,
  readChangeRecordByPr,
  recordSignedAcceptanceRecordMerge,
  triggerDependencyWatchesForPush,
  recordReviewEvent,
  SignedAcceptanceRecordMergeConflictError,
} from "@agentrail/db-postgres";
import { readCurrentGithubPullRequest } from "../../../../../lib/github-current-pr";

/**
 * GitHub-App `pull_request` webhook — the intake half of Arc B's reviewer of
 * record (spec docs/superpowers/specs/2026-07-31-reviewer-of-record-design.md
 * §1). Every admitted PR event becomes one durable `review_jobs` row
 * (`enqueueReviewJob`, `@agentrail/db-postgres`); a headless Jace worker
 * (a later task) claims rows and posts the one review of record. This route
 * only ADMITS — it never reviews. A signed stale head may make one bounded,
 * authenticated GitHub-App read to reconcile custody; it never trusts a
 * caller-supplied replacement head. Once auth passes it is never itself a
 * source of retries: GitHub redelivers on
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
 * opened|ready_for_review|reopened|synchronize, or a terminal `closed` event ->
 * every signed draft action still maintains exact-head custody, but only
 * `ready_for_review` admits its review job -> `installation.id`
 * must resolve to a workspace (`getWorkspaceByGithubInstallationId`) -> that
 * workspace must be in the `REVIEWER_OF_RECORD_WORKSPACES` rollout allowlist
 * (comma-separated, trimmed; empty/unset disables intake for EVERY
 * workspace — dogfood-only until the allowlist grows) -> `repository.full_name`
 * must be a repo the workspace has actually connected
 * (`getRepositoryByName`; never proxies an unconnected repo's events). Only
 * then does `advanceConfirmedAcceptanceRecordPullRequestHead` atomically bind
 * the signed head as the Record's current PR head, supersede obsolete work,
 * and admit that exact review job unless the PR is still draft. The signed
 * action and delivery id are part of that one transaction. A replayed signed
 * delivery id is a total no-op and comes back `deduped: true`
 * — still 200, never an error. Head-only identity would wrongly collapse an
 * A→B→A history, so receipt identity is the exact GitHub delivery id.
 */

const SIGNATURE_HEADER = "x-hub-signature-256";
const DELIVERY_HEADER = "x-github-delivery";
const EVENT_HEADER = "x-github-event";
const ENROLLED_WORKSPACES_ENV = "REVIEWER_OF_RECORD_WORKSPACES";
const ACCEPTANCE_RECORD_MARKER = /<!--\s*jace-acceptance-record\s*:\s*([\s\S]*?)\s*-->/gi;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GIT_SHA = /^[0-9a-f]{40}$/i;
const LOWER_GIT_SHA = /^[0-9a-f]{40}$/;
const GITHUB_ACTOR_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*|[A-Za-z0-9-]*\[bot\])$/;

// The four `pull_request` actions this intake handles (design spec §1). A
// draft synchronize advances custody without queue admission; every `closed`
// delivery invalidates attached exact-head work without queue admission.
type PullRequestTriggerAction =
  | "opened"
  | "ready_for_review"
  | "reopened"
  | "synchronize";

const TRIGGER_ACTIONS = new Set<PullRequestTriggerAction>([
  "opened",
  "ready_for_review",
  "reopened",
  "synchronize",
]);

function isPullRequestTriggerAction(
  value: string
): value is PullRequestTriggerAction {
  return TRIGGER_ACTIONS.has(value as PullRequestTriggerAction);
}

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

/**
 * A stale signed delivery has already revoked authority in the DB. This is the
 * only place we ask GitHub for a current head, using the workspace App token;
 * a public caller can never supply a replacement SHA. The DB repeats the
 * blocked tuple and authority-generation check under the same PR lock, so a
 * later signed push wins over this read/commit race.
 */
async function reconcileStalePullRequestDelivery(input: {
  workspaceId: string;
  recordId: string;
  repo: string;
  prNumber: number;
  stale: Extract<Awaited<ReturnType<typeof advanceConfirmedAcceptanceRecordPullRequestHead>>, { kind: "stale_delivery" }>;
}): Promise<NextResponse> {
  if (!input.stale.blockedCycleId) {
    return NextResponse.json({
      ok: true,
      ignored: true,
      enqueued: false,
      blocked: true,
      reason: "blocked head has no reconciliation cycle",
      superseded: input.stale.superseded,
    });
  }
  let token: string | null;
  try {
    token = await getInstallationToken(input.workspaceId);
  } catch {
    token = null;
  }
  if (!token) {
    return NextResponse.json({
      ok: true,
      ignored: true,
      enqueued: false,
      blocked: true,
      reason: "GitHub reconciliation is unavailable",
      superseded: input.stale.superseded,
    });
  }

  const current = await readCurrentGithubPullRequest({
    token,
    repo: input.repo,
    prNumber: input.prNumber,
  });
  if (!current.ok) {
    return NextResponse.json({
      ok: true,
      ignored: true,
      enqueued: false,
      blocked: true,
      reason: "current GitHub pull request is not proven",
      superseded: input.stale.superseded,
    });
  }

  const reconciled = await reconcileConfirmedAcceptanceRecordPullRequestHead({
    workspaceId: input.workspaceId,
    recordId: input.recordId,
    repo: input.repo,
    prNumber: input.prNumber,
    expectedBlockedHeadSha: input.stale.blockedHeadSha,
    expectedBlockedCycleId: input.stale.blockedCycleId,
    expectedBlockedAuthorityGeneration: input.stale.authorityGeneration,
    observedHeadSha: current.pullRequest.headSha,
    observedBaseSha: current.pullRequest.baseSha,
    observedState: current.pullRequest.state,
    observedDraft: current.pullRequest.draft,
    observedMerged: current.pullRequest.merged,
    source: "github_app_api",
  });
  if (reconciled.kind === "reconciled" || reconciled.kind === "already_current") {
    return NextResponse.json({
      ok: true,
      reconciled: reconciled.kind === "reconciled",
      alreadyCurrent: reconciled.kind === "already_current",
      enqueued: reconciled.jobAdmitted,
      blocked: false,
      superseded: input.stale.superseded,
    });
  }

  return NextResponse.json({
    ok: true,
    ignored: true,
    enqueued: false,
    reconciled: false,
    blocked: reconciled.kind === "closed"
      ? true
      : reconciled.kind === "blocked_precondition_changed"
        ? !reconciled.currentAuthoritative
        : true,
    reason: reconciled.kind === "closed"
      ? "current pull request is closed or merged"
      : "reconciliation precondition changed",
    superseded: input.stale.superseded,
  });
}

function acceptanceRecordMarker(body: unknown):
  | { kind: "record"; recordId: string }
  | { kind: "missing" | "invalid" | "ambiguous" } {
  if (typeof body !== "string") return { kind: "missing" };
  const values = Array.from(body.matchAll(ACCEPTANCE_RECORD_MARKER), (match) => match[1]?.trim() ?? "");
  if (values.length === 0) return { kind: "missing" };
  if (values.length !== 1) return { kind: "ambiguous" };
  return UUID.test(values[0]!) ? { kind: "record", recordId: values[0]! } : { kind: "invalid" };
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

type SignedMergeMetadata = {
  baseSha: string;
  mergeSha: string;
  mergedAt: Date;
  prUrl: string;
  githubActor: {
    id: number;
    login: string;
    type: "User" | "Bot" | "Organization";
  };
};

function signedMergeMetadata(
  pr: JsonObject,
  body: JsonObject,
  expectedPrUrl: string,
  headSha: string,
): SignedMergeMetadata | null {
  const baseSha = asObject(pr.base)?.sha;
  const mergeSha = pr.merge_commit_sha;
  const mergedAtRaw = pr.merged_at;
  const prUrl = pr.html_url;
  const actor = asObject(body.sender);
  const actorId = actor?.id;
  const actorLogin = actor?.login;
  const actorType = actor?.type;
  const mergedAt = typeof mergedAtRaw === "string" ? new Date(mergedAtRaw) : null;
  if (!LOWER_GIT_SHA.test(headSha)
    || typeof baseSha !== "string" || !LOWER_GIT_SHA.test(baseSha)
    || typeof mergeSha !== "string" || !LOWER_GIT_SHA.test(mergeSha)
    || !mergedAt || Number.isNaN(mergedAt.valueOf())
    || prUrl !== expectedPrUrl
    || !Number.isSafeInteger(actorId) || (actorId as number) <= 0
    || typeof actorLogin !== "string" || actorLogin.length > 100
    || !GITHUB_ACTOR_LOGIN.test(actorLogin)
    || (actorType !== "User" && actorType !== "Bot" && actorType !== "Organization")) {
    return null;
  }
  return {
    baseSha,
    mergeSha,
    mergedAt,
    prUrl,
    githubActor: { id: actorId as number, login: actorLogin, type: actorType },
  };
}

async function terminalizeUnrecordedSignedMerge(input: {
  workspaceId: string;
  recordId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  deliveryId: string;
  reason: string;
}): Promise<NextResponse> {
  try {
    const invalidation =
      await invalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEvent({
        workspaceId: input.workspaceId,
        recordId: input.recordId,
        repo: input.repo,
        prNumber: input.prNumber,
        headSha: input.headSha,
        event: "merged",
        deliveryId: input.deliveryId,
        source: "github_webhook",
      });
    if (invalidation.kind !== "invalidated") {
      return NextResponse.json({
        ok: true,
        ignored: true,
        merged: true,
        recorded: false,
        invalidated: false,
        reason: `${input.reason}; acceptance record ${invalidation.kind}`,
      });
    }
    return NextResponse.json({
      ok: true,
      ignored: true,
      merged: true,
      recorded: false,
      invalidated: !invalidation.currentAuthoritative,
      reason: input.reason,
      superseded: invalidation.superseded,
      previewBootsTornDown: invalidation.previewBootsTornDown,
    });
  } catch (error) {
    console.error("[github-app/webhook] signed merge terminal invalidation failed:", error);
    return NextResponse.json({
      ok: true,
      ignored: true,
      merged: true,
      recorded: false,
      invalidated: false,
      reason: `${input.reason}; terminal invalidation unavailable`,
    });
  }
}

type SignedHeadTransition = {
  beforeHeadSha: string;
  afterHeadSha: string;
};

function signedHeadTransition(
  action: string,
  body: Record<string, unknown>,
  headSha: string
): { ok: true; value: SignedHeadTransition | null } | { ok: false } {
  if (action !== "synchronize") return { ok: true, value: null };
  const beforeHeadSha = body.before;
  const afterHeadSha = body.after;
  if (
    typeof beforeHeadSha !== "string" ||
    typeof afterHeadSha !== "string" ||
    !GIT_SHA.test(beforeHeadSha) ||
    !GIT_SHA.test(afterHeadSha) ||
    afterHeadSha !== headSha
  ) {
    return { ok: false };
  }
  return { ok: true, value: { beforeHeadSha, afterHeadSha } };
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
  if (
    !deliveryId ||
    deliveryId.length > 256 ||
    deliveryId !== deliveryId.trim() ||
    /[\u0000-\u001f\u007f]/u.test(deliveryId)
  ) {
    return ignored("invalid delivery id");
  }
  const prObj = asObject(body.pull_request);
  const reviewObj = asObject(body.review);
  const isTerminalClose = action === "closed";
  const isMergedClose = action === "closed" && prObj?.merged === true;
  const triggerAction = isPullRequestTriggerAction(action) ? action : null;

  if (
    githubEvent === "pull_request_review"
      ? action !== "submitted"
      : !triggerAction && !isTerminalClose
  ) {
    return ignored();
  }

  if (!prObj) {
    return ignored();
  }

  const admitReviewJob =
    triggerAction === "ready_for_review" || prObj.draft !== true;

  const head = prObj.head;
  const headSha =
    head && typeof head === "object"
      ? (head as Record<string, unknown>).sha
      : undefined;
  const prNumber = prObj.number;
  if (
    typeof headSha !== "string" ||
    !GIT_SHA.test(headSha) ||
    typeof prNumber !== "number" ||
    !Number.isInteger(prNumber) ||
    prNumber <= 0
  ) {
    return ignored();
  }
  const headTransition = signedHeadTransition(action, body, headSha);
  if (!headTransition.ok) return ignored("invalid head transition");

  const repoFullName = asObject(body.repository)?.full_name;
  if (typeof repoFullName !== "string") return ignored();
  const expectedPrUrl = `https://github.com/${repoFullName}/pull/${prNumber}`;
  const signedPrUrl = prObj.html_url;
  if (!isMergedClose && signedPrUrl != null && signedPrUrl !== expectedPrUrl) {
    return ignored("invalid pull request URL");
  }
  const prUrl = signedPrUrl === expectedPrUrl ? signedPrUrl : null;

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

  const connectedRepo = await getRepositoryByName(
    workspace.workspaceId,
    repoFullName
  );
  if (!connectedRepo) {
    return ignored();
  }

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

  const attachedRecord = githubEvent === "pull_request"
    ? await readChangeRecordByPr({
        workspaceId: workspace.workspaceId,
        repo: repoFullName,
        prNumber,
      })
    : null;

  if (isMergedClose) {
    const mergeMetadata = signedMergeMetadata(prObj, body, expectedPrUrl, headSha);
    if (mergeMetadata) {
      // Legacy R9.2 observation metric only. It is best-effort and never
      // establishes canonical Change Record merge or decision custody;
      // recordSignedAcceptanceRecordMerge is the sole authority for those facts.
      await recordWebhookReviewEvent({
        workspaceId: workspace.workspaceId,
        repo: repoFullName,
        prNumber,
        taskFamily: null,
        deliveryId,
        eventType: "merged",
        occurredAt: mergeMetadata.mergedAt,
        headSha,
        actorType: actorTypeFromGitHubUserType(mergeMetadata.githubActor.type),
        additions: numberOrNull(prObj.additions),
        deletions: numberOrNull(prObj.deletions),
        changedFiles: numberOrNull(prObj.changed_files),
      });
    }
    if (!attachedRecord) {
      return NextResponse.json({
        ok: true,
        ignored: true,
        merged: true,
        recorded: false,
        reason: "acceptance record missing",
      });
    }

    if (!mergeMetadata) {
      return terminalizeUnrecordedSignedMerge({
        workspaceId: workspace.workspaceId,
        recordId: attachedRecord.id,
        repo: repoFullName,
        prNumber,
        headSha,
        deliveryId,
        reason: "invalid signed merge metadata",
      });
    }

    try {
      const result = await recordSignedAcceptanceRecordMerge({
        workspaceId: workspace.workspaceId,
        recordId: attachedRecord.id,
        repo: repoFullName,
        prNumber,
        deliveryId,
        headSha,
        baseSha: mergeMetadata.baseSha,
        mergeSha: mergeMetadata.mergeSha,
        mergedAt: mergeMetadata.mergedAt,
        prUrl: mergeMetadata.prUrl,
        githubActor: mergeMetadata.githubActor,
        source: "github_webhook",
      });
      if (!("decisionAlignment" in result)) {
        return NextResponse.json({
          ok: true,
          ignored: true,
          merged: true,
          recorded: false,
          reason: `acceptance record ${result.kind}`,
        });
      }
      return NextResponse.json({
        ok: true,
        merged: true,
        recorded: true,
        acceptanceOutcomeRecorded: result.decisionAlignment.kind === "aligned",
        kind: result.kind,
        decisionAlignment: result.decisionAlignment.kind,
        superseded: result.superseded,
        previewBootsTornDown: result.previewBootsTornDown,
      });
    } catch (error) {
      if (error instanceof SignedAcceptanceRecordMergeConflictError) {
        return terminalizeUnrecordedSignedMerge({
          workspaceId: workspace.workspaceId,
          recordId: attachedRecord.id,
          repo: repoFullName,
          prNumber,
          headSha,
          deliveryId,
          reason: "signed merge conflicts with acceptance record custody",
        });
      }
      console.error("[github-app/webhook] signed merge record failed:", error);
      return terminalizeUnrecordedSignedMerge({
        workspaceId: workspace.workspaceId,
        recordId: attachedRecord.id,
        repo: repoFullName,
        prNumber,
        headSha,
        deliveryId,
        reason: "signed merge custody unavailable",
      });
    }
  }

  let terminalInvalidation: Awaited<
    ReturnType<typeof invalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEvent>
  > | null = null;
  if (isTerminalClose && attachedRecord) {
    terminalInvalidation =
      await invalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEvent({
        workspaceId: workspace.workspaceId,
        recordId: attachedRecord.id,
        repo: repoFullName,
        prNumber,
        headSha,
        event: "closed",
        deliveryId,
        source: "github_webhook",
      });
    if (terminalInvalidation.kind !== "invalidated") {
      return ignored(`acceptance record ${terminalInvalidation.kind}`);
    }
  }

  if (isTerminalClose) {
    return NextResponse.json({
      ok: true,
      closed: true,
      invalidated: terminalInvalidation?.kind === "invalidated",
      superseded:
        terminalInvalidation?.kind === "invalidated"
          ? terminalInvalidation.superseded
          : 0,
      previewBootsTornDown:
        terminalInvalidation?.kind === "invalidated"
          ? terminalInvalidation.previewBootsTornDown
          : 0,
    });
  }

  if (!triggerAction) return ignored();
  const marker = acceptanceRecordMarker(prObj.body);
  const recordId = attachedRecord?.id ??
    (marker.kind === "record" ? marker.recordId : null);
  if (!recordId) {
    return ignored(`acceptance record ${marker.kind}`);
  }
  const result = await advanceConfirmedAcceptanceRecordPullRequestHead({
    workspaceId: workspace.workspaceId,
    recordId,
    repo: repoFullName,
    prNumber,
    headSha,
    event: triggerAction,
    deliveryId,
    headTransition: headTransition.value,
    admitReviewJob,
    source: "github_webhook",
    prUrl,
  });
  if (result.kind === "delivery_replayed") {
    return NextResponse.json({
      ok: true,
      enqueued: false,
      deduped: true,
      replayed: true,
      blocked: !result.currentAuthoritative,
    });
  }
  if (result.kind === "stale_delivery") {
    return reconcileStalePullRequestDelivery({
      workspaceId: workspace.workspaceId,
      recordId,
      repo: repoFullName,
      prNumber,
      stale: result,
    });
  }
  if (result.kind !== "advanced") {
    return ignored(`acceptance record ${result.kind}`);
  }

  return NextResponse.json({
    ok: true,
    enqueued: result.jobAdmitted,
    deduped: result.deduped,
    superseded: result.superseded,
    previewBootsTornDown: result.previewBootsTornDown,
    headChanged: result.headChanged,
    previousHeadSha: result.previousHeadSha,
  });
}
