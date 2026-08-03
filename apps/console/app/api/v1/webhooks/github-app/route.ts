import { createHmac, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  enqueueReviewJob,
  getWorkspaceByGithubInstallationId,
  getRepositoryByName,
  appendChangeRecordEvent,
  findOrCreateChangeRecord,
} from "@agentrail/db-postgres";

/**
 * GitHub-App `pull_request` webhook — the intake half of Arc B's reviewer of
 * record (spec docs/superpowers/specs/2026-07-31-reviewer-of-record-design.md
 * §1). Every admitted PR event becomes one durable `review_jobs` row
 * (`enqueueReviewJob`, `@agentrail/db-postgres`); a headless Jace worker
 * (a later task) claims rows and posts the one review of record. This route
 * only ADMITS — it never reviews, never calls GitHub back, and once auth
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
 * `pull_request` (checked off the header alone, no body parsing needed) ->
 * the body must parse as JSON -> `action` must be one of
 * opened|ready_for_review|reopened|synchronize -> a draft PR
 * (`pull_request.draft === true`) is skipped for opened/reopened/synchronize
 * (it (re-)enters once `ready_for_review` fires later; THAT action is never
 * draft-gated, regardless of the payload's `draft` value) -> `installation.id`
 * must resolve to a workspace (`getWorkspaceByGithubInstallationId`) -> that
 * workspace must be in the `REVIEWER_OF_RECORD_WORKSPACES` rollout allowlist
 * (comma-separated, trimmed; empty/unset disables intake for EVERY
 * workspace — dogfood-only until the allowlist grows) -> `repository.full_name`
 * must be a repo the workspace has actually connected
 * (`getRepositoryByName`; never proxies an unconnected repo's events). Only
 * then does `enqueueReviewJob` run, keyed by `headSha = pull_request.head.sha`
 * and `event = action` (the `review_jobs.event` column drives both the
 * worker prompt and the `synchronize` debounce — see that query's own
 * doc-comment). A replayed delivery for the same (workspace, repo, pr, head)
 * re-derives the SAME deterministic row id and comes back `deduped: true` —
 * still 200, never an error.
 */

const SIGNATURE_HEADER = "x-hub-signature-256";
const EVENT_HEADER = "x-github-event";
const ENROLLED_WORKSPACES_ENV = "REVIEWER_OF_RECORD_WORKSPACES";

// The four `pull_request` actions this queue admits (design spec §1).
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

  // Only `pull_request` deliveries carry work here — every other GitHub
  // event this App may be subscribed to (ping, issues, push, …) is a benign
  // ignore, decided off the header alone, no body parsing needed.
  if (request.headers.get(EVENT_HEADER) !== "pull_request") {
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

  const action = typeof body.action === "string" ? body.action : "";
  const isMergedClose = action === "closed" &&
    body.pull_request != null &&
    typeof body.pull_request === "object" &&
    (body.pull_request as Record<string, unknown>).merged === true;
  if (!TRIGGER_ACTIONS.has(action) && !isMergedClose) {
    return ignored();
  }

  const pr = body.pull_request;
  if (!pr || typeof pr !== "object") {
    return ignored();
  }
  const prObj = pr as Record<string, unknown>;

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

  const repository = body.repository;
  const repoFullName =
    repository && typeof repository === "object"
      ? (repository as Record<string, unknown>).full_name
      : undefined;
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
  const prNumber = prObj.number;

  if (typeof headSha !== "string" || typeof prNumber !== "number") {
    return ignored();
  }

  if (isMergedClose) {
    const mergeCommitSha =
      typeof prObj.merge_commit_sha === "string" ? prObj.merge_commit_sha : null;
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

  const result = await enqueueReviewJob({
    workspaceId: workspace.workspaceId,
    repo: repoFullName,
    prNumber,
    headSha,
    event: action,
  });

  return NextResponse.json({
    ok: true,
    enqueued: true,
    deduped: result.deduped,
    superseded: result.superseded,
  });
}
