import { createHash, createHmac, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  findWorkspaceByRepo,
  getConnector,
  appendJudgmentEvent,
  enqueueGithubIssue,
  findQueueEntryByExternalId,
  getRepositoryByName,
  enqueueOnboard,
  findOnboardEntryStatus,
  ONBOARD_ALREADY_PENDING_REASON,
} from "@agentrail/db-postgres";
import {
  postAlignmentBrief,
  reconcileAlignmentBriefs,
  reviseAndRepostAlignmentBrief,
} from "../../../../../../lib/alignment-reconciler";

/**
 * GitHub `issues`/`push` webhook receiver — the trigger that fills the queue
 * AND (push) keeps the Repo Wiki current.
 *
 * In the self-hosted-runner model the backend owns the queue, so admitting a
 * GitHub issue is a SERVER job: GitHub POSTs an `issues` delivery here, and when
 * the issue carries the workspace's trigger label we enqueue it (through the
 * input-contract gate). The logged-in runner then claims it via
 * `/api/v1/runner/claim`. Mirrors `agentrail/heartbeat/webhook.py`.
 *
 * Locally, point a tunnel (smee.io / `gh webhook forward`) at this route; when
 * deployed it's the public webhook URL configured on the repo. HMAC
 * verification uses the delivering workspace's per-connector secret
 * (`connectors.config.webhookSecret`, written by the /setup wizard — #1233),
 * falling back to the global `GITHUB_WEBHOOK_SECRET` env var for local
 * dev/testing. Because the secret is per-workspace, the payload is parsed and
 * the workspace resolved BEFORE the signature check.
 *
 * ALSO handles `push` (owner ask: "the auto recompile feature for the llm
 * wiki when changes is made", flag `AGENTRAIL_WIKI_RECOMPILE_ON_PUSH`,
 * default OFF): a push to the repo's default branch force-re-enqueues its
 * `onboard` queue entry, the SAME job the console's manual wiki "Recompile"
 * button enqueues
 * (`apps/console/app/api/v1/workspaces/[workspaceId]/wiki/recompile/route.ts`).
 * See `handlePush` below for the full trigger/ignore matrix.
 */

// Actions that (re)admit work. `edited` is handled separately below (#1345
// PR③ / AC2 — it can re-brief a denied entry, never admit a new one); every
// other action (closed, assigned, …) is ignored.
const TRIGGER_ACTIONS = new Set(["opened", "reopened", "labeled"]);
const SIGNATURE_HEADER = "x-hub-signature-256";

// --- push → wiki recompile (owner ask: "auto recompile ... when changes is
// made") ------------------------------------------------------------------
//
// Default-OFF rollout flag — only the exact value "1" enables push-triggered
// recompile, same convention every other flag in this codebase uses
// (ONBOARD_ON_CONNECT_FLAG in workspaces/[workspaceId]/repos/route.ts,
// V2_FLAG in github_intake.ts). Ships dark; the owner flips it in Railway.
const WIKI_RECOMPILE_ON_PUSH_FLAG = "AGENTRAIL_WIKI_RECOMPILE_ON_PUSH";

// Minimum-interval guard: a repo whose onboard entry last changed (queued,
// ran, or just finished) less than this many seconds ago ignores a fresh
// push rather than force-re-arming another compile. This is NOT the primary
// debounce — that's `enqueueOnboard`'s own `state NOT IN ('queued',
// 'running')` guarded re-arm, which already collapses a BURST of pushes
// (while a compile is queued/running) into the one in-flight compile — see
// `route.push-recompile.test.ts`'s burst test. This guard instead bounds
// compile FREQUENCY for a repo pushed to faster than compiles finish: a push
// landing 1s after the prior compile completes would otherwise re-arm
// immediately, forever, since a just-finished row is neither 'queued' nor
// 'running'. No new timer/cron machinery — a plain read-then-decide check
// against the existing onboard row's `updatedAt` (findOnboardEntryStatus).
const PUSH_MIN_INTERVAL_ENV = "AGENTRAIL_WIKI_PUSH_MIN_INTERVAL_SECONDS";
const PUSH_MIN_INTERVAL_DEFAULT_SECONDS = 300;

function pushMinIntervalSeconds(): number {
  const raw = process.env[PUSH_MIN_INTERVAL_ENV];
  if (raw) {
    const val = Number.parseInt(raw, 10);
    if (Number.isFinite(val) && val >= 0) return val;
  }
  return PUSH_MIN_INTERVAL_DEFAULT_SECONDS;
}

function verifySignature(
  raw: string,
  signature: string | null,
  secret: string | undefined
): boolean {
  if (!secret) return true; // no secret configured → skip (insecure but convenient)
  if (!signature) return false;
  const expected =
    "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

function labelNames(issue: Record<string, unknown>): Set<string> {
  const labels = issue.labels;
  const names = new Set<string>();
  if (Array.isArray(labels)) {
    for (const lab of labels) {
      if (typeof lab === "string") names.add(lab);
      else if (lab && typeof lab === "object" && typeof (lab as Record<string, unknown>).name === "string") {
        names.add((lab as Record<string, string>).name);
      }
    }
  }
  return names;
}

/**
 * #1345 PR③ / AC2 — has an `issues` `edited` delivery's `changes` object
 * recorded an ACTUAL title or body edit? GitHub's payload for the `edited`
 * action includes a `changes` object with a `title` and/or `body` key (each
 * shaped `{ from: <previous value> }`) — but ONLY for the field(s) that
 * genuinely changed. A label-only edit is its own `labeled`/`unlabeled`
 * action (never `edited` with a `changes.title`/`changes.body` key at all),
 * and an assignee change is its own `assigned`/`unassigned` action — so
 * checking for the mere PRESENCE of either key on `changes` is sufficient
 * to gate "did the content this brief was composed from actually change";
 * this never reads the `.from` value itself, only whether the key exists.
 */
function issueContentChanged(payload: Record<string, unknown>): boolean {
  const changes = payload.changes;
  if (!changes || typeof changes !== "object") return false;
  const c = changes as Record<string, unknown>;
  return "title" in c || "body" in c;
}

const MAX_REQUIREMENT_TEXT_LENGTH = 16_000;
const MAX_REVERT_MESSAGE_LENGTH = 4_000;

function boundedText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.slice(0, MAX_REQUIREMENT_TEXT_LENGTH);
}

function boundedRevertMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.slice(0, MAX_REVERT_MESSAGE_LENGTH);
}

function requirementCorrectionEventKey(
  repo: string,
  issueNumber: number,
  deliveryId: string | null,
  payload: Record<string, unknown>
): string {
  const stableInput = deliveryId ?? JSON.stringify({ repo, issueNumber, changes: payload.changes });
  const digest = createHash("sha256").update(stableInput).digest("hex").slice(0, 24);
  return `requirement-correction:issue:${issueNumber}:${digest}`;
}

async function appendRequirementCorrection(
  payload: Record<string, unknown>,
  repo: string,
  workspaceId: string,
  issueNumber: number,
  deliveryId: string | null
): Promise<void> {
  const issue = payload.issue as Record<string, unknown>;
  const changes = payload.changes as Record<string, unknown>;
  const changedFields = ["title", "body"].filter((field) => field in changes);
  const sender = payload.sender as Record<string, unknown> | undefined;
  const actorId = typeof sender?.login === "string" ? sender.login : undefined;
  const title = boundedText(issue.title);
  const body = boundedText(issue.body);
  const previousTitle = boundedText((changes.title as Record<string, unknown> | undefined)?.from);
  const previousBody = boundedText((changes.body as Record<string, unknown> | undefined)?.from);

  try {
    await appendJudgmentEvent({
      workspaceId,
      repo,
      eventKey: requirementCorrectionEventKey(repo, issueNumber, deliveryId, payload),
      type: "requirement_correction",
      refs: { issueNumber },
      payload: {
        issueNumber,
        changedFields,
        title,
        body,
        previousTitle,
        previousBody,
        textTruncated:
          (typeof issue.title === "string" && issue.title.length > MAX_REQUIREMENT_TEXT_LENGTH) ||
          (typeof issue.body === "string" && issue.body.length > MAX_REQUIREMENT_TEXT_LENGTH) ||
          (typeof (changes.title as Record<string, unknown> | undefined)?.from === "string" &&
            ((changes.title as Record<string, unknown>).from as string).length > MAX_REQUIREMENT_TEXT_LENGTH) ||
          (typeof (changes.body as Record<string, unknown> | undefined)?.from === "string" &&
            ((changes.body as Record<string, unknown>).from as string).length > MAX_REQUIREMENT_TEXT_LENGTH),
      },
      actorRef: { kind: "github_user", ...(actorId ? { id: actorId } : {}) },
      sourceRef: { kind: "github_webhook", ...(deliveryId ? { id: deliveryId } : {}) },
    });
  } catch (err) {
    console.error("[github/webhook] requirement correction capture failed:", err);
  }
}

function revertedCommitSha(message: string): string | null {
  const match = message.match(/\bThis reverts commit ([0-9a-f]{7,40})\b/i);
  return match?.[1] ?? null;
}

function revertedPullRequestNumber(message: string): number | null {
  const match = message.match(/\(#(\d+)\)/) ?? message.match(/\bPR #(\d+)\b/i);
  if (!match?.[1]) return null;
  const num = Number(match[1]);
  return Number.isSafeInteger(num) && num > 0 ? num : null;
}

async function appendFalseGreenEventsFromPush(
  payload: Record<string, unknown>,
  repo: string,
  workspaceId: string,
  deliveryId: string | null
): Promise<void> {
  const commits = payload.commits;
  if (!Array.isArray(commits)) return;

  const sender = payload.sender as Record<string, unknown> | undefined;
  const actorId = typeof sender?.login === "string" ? sender.login : undefined;

  for (const rawCommit of commits) {
    if (!rawCommit || typeof rawCommit !== "object") continue;
    const commit = rawCommit as Record<string, unknown>;
    const message = typeof commit.message === "string" ? commit.message : "";
    const revertedSha = revertedCommitSha(message);
    if (!revertedSha) continue;

    const commitSha = typeof commit.id === "string" ? commit.id : undefined;
    if (!commitSha) continue;

    const prNumber = revertedPullRequestNumber(message);
    const occurredAt =
      typeof commit.timestamp === "string" && !Number.isNaN(Date.parse(commit.timestamp))
        ? new Date(commit.timestamp)
        : undefined;

    try {
      await appendJudgmentEvent({
        workspaceId,
        repo,
        eventKey: `false-green:revert:${commitSha}`,
        type: "false_green",
        refs: {
          revertCommitSha: commitSha,
          revertedCommitSha: revertedSha,
          ...(prNumber ? { pullRequestNumber: prNumber } : {}),
        },
        payload: {
          gateOutcome: "reverted",
          revertCommitSha: commitSha,
          revertedCommitSha: revertedSha,
          ...(prNumber ? { pullRequestNumber: prNumber } : {}),
          message: boundedRevertMessage(message),
          messageTruncated: message.length > MAX_REVERT_MESSAGE_LENGTH,
        },
        actorRef: { kind: "github_user", ...(actorId ? { id: actorId } : {}) },
        sourceRef: { kind: "github_webhook", ...(deliveryId ? { id: deliveryId } : {}) },
        ...(occurredAt ? { occurredAt } : {}),
      });
    } catch (err) {
      console.error("[github/webhook] false-green capture failed:", err);
    }
  }
}

/**
 * #1345 PR③ / AC2 — a human hand-editing the GitHub issue's title/body
 * DIRECTLY (no chat, no Jace tool call involved): if this issue maps to a
 * queue entry CURRENTLY denied for alignment, supersede that denial with a
 * fresh brief exactly like the tool-triggered console revise route does
 * (`apps/console/app/api/v1/runner/queue-entries/revise/route.ts`, PR②) —
 * reusing the SAME shared helper, `reviseAndRepostAlignmentBrief`
 * (`lib/alignment-reconciler.ts`), so "revise an entry + post the fresh
 * brief" has exactly one implementation regardless of which trigger fired it.
 *
 * Every non-actionable outcome — content unchanged (a label-only/assignee
 * edit would never even reach this branch, but a title/body-unrelated
 * `edited` delivery still can't be ruled out defensively), no workspace owns
 * the repo, no matching queue entry, or the entry exists but isn't currently
 * denied — is a benign 200 no-op, NEVER a 500: mirrors the admission
 * branch's own non-fatal posture (see this route's header comment) for
 * exactly the same reason — a GitHub webhook delivery that doesn't need
 * action is the overwhelmingly common case, not a failure.
 */
async function handleIssuesEdited(
  payload: Record<string, unknown>,
  repoFullNameRaw: unknown,
  workspaceId: string | null,
  deliveryId: string | null
): Promise<NextResponse> {
  if (!issueContentChanged(payload)) {
    return NextResponse.json({ matched: false, reason: "edited but title/body unchanged" });
  }

  const issue = payload.issue;
  if (!issue || typeof issue !== "object" || typeof repoFullNameRaw !== "string") {
    return NextResponse.json({ matched: false, reason: "missing issue or repository" });
  }
  const repoFullName = repoFullNameRaw;
  if (!workspaceId) {
    return NextResponse.json({ matched: false, reason: "no workspace owns this repo" });
  }

  const issueObj = issue as Record<string, unknown>;
  const number = Number(issueObj.number ?? 0);
  const title = typeof issueObj.title === "string" ? issueObj.title : "";
  const body = typeof issueObj.body === "string" ? issueObj.body : "";

  let responseBody: Record<string, unknown>;
  const entry = await findQueueEntryByExternalId(workspaceId, repoFullName, number);
  if (!entry) {
    responseBody = { matched: true, revised: false, reason: "not_found" };
  } else {
    await appendRequirementCorrection(payload, repoFullName, workspaceId, number, deliveryId);
    const result = await reviseAndRepostAlignmentBrief({
      workspaceId,
      queueEntryId: entry.id,
      title,
      body,
      repoFullName,
      number,
    });
    responseBody = { matched: true, ...result };
  }

  // #1345 (crash-window liveness gap): treat this edit, too, as "next queue
  // activity" and opportunistically sweep for OTHER stale entries in this
  // workspace — both the admission-recovery candidates AND the revise-
  // recovery ones (`reconcileAlignmentBriefs` sweeps both). Runs AFTER the
  // direct attempt above, never before — same ordering rule the admission
  // branch documents at its own call site below, for the same reason (a
  // just-revised-and-reposted entry already carries a fresh pending approval
  // row by the time this runs, so it can never double-match either
  // candidate query — but keeping one obvious owner-per-entry-per-request is
  // still the cleaner geometry). Bounded, best-effort, NON-FATAL.
  try {
    await reconcileAlignmentBriefs(workspaceId, 5);
  } catch (err) {
    console.error("[github/webhook] alignment-reconciler sweep failed:", err);
  }

  return NextResponse.json(responseBody);
}

/**
 * `push` event handler (owner ask: "the auto recompile feature for the llm
 * wiki when changes is made"). Force-re-enqueues the repo's `onboard` queue
 * entry — the SAME job the console's manual wiki "Recompile" button enqueues
 * (`.../wiki/recompile/route.ts`, `enqueueOnboard(..., { force: true })`) —
 * so a runner re-clones, re-indexes, and re-composes the Repo Wiki.
 *
 * Cost stays low even at push frequency: the compile is module-grain
 * (#1447) and only regenerates pages whose `inputsHash` actually changed, so
 * a typical push costs cents rather than repricing the whole wiki — and the
 * compile's own cost ceiling still applies on top of that.
 *
 * Every non-actionable outcome is a 202 `{ event: "push", status:
 * "ignored:<reason>" }`, never a throw or a 4xx/5xx — a push delivery that
 * doesn't need action is the overwhelmingly common case (most pushes are to
 * feature branches), not a failure. Mirrors this route's `issues` admission
 * branch's own non-fatal posture.
 *
 * Trigger/ignore matrix:
 *  - flag off (`AGENTRAIL_WIKI_RECOMPILE_ON_PUSH` unset/not "1") → ignored:flag_off
 *  - repo unresolvable (no workspace owns it, or no `repositories` row) → ignored:unknown_repo
 *  - pushed ref is not `refs/heads/<repo.defaultBranch>` → ignored:non_default_branch
 *  - `deleted: true` (the ref/branch was deleted) → ignored:deleted
 *  - `commits: []` (no new commits — e.g. a branch pointed at an already-known commit) → ignored:zero_commit
 *  - within the minimum-interval window since the repo's onboard row last changed → ignored:min_interval
 *  - `enqueueOnboard` throws, or (defensively unreachable) returns neither
 *    enqueued NOR the already-pending reason → ignored:enqueue_failed
 *  - otherwise → `queued` (fresh/re-armed compile) or `already_pending`
 *    (compile already queued/running) — matching `.../wiki/recompile/route.ts`'s
 *    own two success outcomes exactly.
 */
async function handlePush(
  payload: Record<string, unknown>,
  repoFullNameRaw: unknown,
  workspaceId: string | null,
  deliveryId: string | null
): Promise<NextResponse> {
  if (typeof repoFullNameRaw !== "string") {
    return NextResponse.json({ event: "push", status: "ignored:unknown_repo" }, { status: 202 });
  }
  const repoFullName = repoFullNameRaw;
  if (!workspaceId) {
    return NextResponse.json({ event: "push", status: "ignored:unknown_repo" }, { status: 202 });
  }

  // Resolve WITHIN this workspace only — never trust the payload beyond
  // what `findWorkspaceByRepo` already scoped it to (no cross-workspace
  // existence oracle, same posture every other route in this file takes).
  const repo = await getRepositoryByName(workspaceId, repoFullName);
  if (!repo) {
    return NextResponse.json({ event: "push", status: "ignored:unknown_repo" }, { status: 202 });
  }

  const ref = typeof payload.ref === "string" ? payload.ref : "";
  if (ref !== `refs/heads/${repo.defaultBranch}`) {
    return NextResponse.json(
      { event: "push", status: "ignored:non_default_branch" },
      { status: 202 }
    );
  }

  if (payload.deleted === true) {
    return NextResponse.json({ event: "push", status: "ignored:deleted" }, { status: 202 });
  }

  const commits = payload.commits;
  if (Array.isArray(commits) && commits.length === 0) {
    return NextResponse.json({ event: "push", status: "ignored:zero_commit" }, { status: 202 });
  }

  await appendFalseGreenEventsFromPush(payload, repoFullName, workspaceId, deliveryId);

  if (process.env[WIKI_RECOMPILE_ON_PUSH_FLAG] !== "1") {
    console.log("[github/webhook] push: AGENTRAIL_WIKI_RECOMPILE_ON_PUSH is off, ignoring");
    return NextResponse.json({ event: "push", status: "ignored:flag_off" }, { status: 202 });
  }

  // Minimum-interval guard — see PUSH_MIN_INTERVAL_ENV's own comment above.
  // Advisory only: enqueueOnboard's guarded UPDATE remains the sole
  // correctness boundary, so a race here can only ever cost one harmless
  // extra `already_pending` round trip, never a double-run.
  const entryStatus = await findOnboardEntryStatus(workspaceId, repoFullName);
  if (entryStatus && entryStatus.state !== "queued" && entryStatus.state !== "running") {
    const elapsedSeconds = (Date.now() - entryStatus.updatedAt.getTime()) / 1000;
    const minIntervalSeconds = pushMinIntervalSeconds();
    if (elapsedSeconds < minIntervalSeconds) {
      console.log(
        `[github/webhook] push: ${repoFullName} onboard entry changed ` +
          `${Math.round(elapsedSeconds)}s ago (< ${minIntervalSeconds}s min interval), ignoring`
      );
      return NextResponse.json(
        { event: "push", status: "ignored:min_interval" },
        { status: 202 }
      );
    }
  }

  let result;
  try {
    result = await enqueueOnboard({ workspaceId, repoFullName, force: true });
  } catch (err) {
    console.error("[github/webhook] push: enqueueOnboard failed:", err);
    return NextResponse.json(
      { event: "push", status: "ignored:enqueue_failed" },
      { status: 202 }
    );
  }

  if (result.enqueued) {
    console.log(`[github/webhook] push: recompile queued for ${repoFullName} (${result.id})`);
    return NextResponse.json(
      { event: "push", status: "queued", id: result.id },
      { status: 202 }
    );
  }
  if (result.reason === ONBOARD_ALREADY_PENDING_REASON) {
    return NextResponse.json({ event: "push", status: "already_pending" }, { status: 202 });
  }
  // Defensive: force:true always takes the "enqueued" or "already_pending"
  // branch in enqueueOnboard — unreachable in practice (mirrors
  // wiki/recompile/route.ts's own identical defensive branch), but never
  // silently fabricate "queued" for a write that didn't happen.
  console.error("[github/webhook] push: unexpected enqueueOnboard reason:", result.reason);
  return NextResponse.json(
    { event: "push", status: "ignored:enqueue_failed" },
    { status: 202 }
  );
}

export async function POST(request: NextRequest) {
  const raw = await request.text();
  const signature = request.headers.get(SIGNATURE_HEADER);

  // Parse FIRST: the signing secret is per-workspace (#1233), resolvable only
  // from `repository.full_name` in the payload. An unparseable body still gets
  // signature-checked against the global fallback below.
  let payload: Record<string, unknown> | null = null;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    payload = null;
  }

  const repository = payload?.repository;
  const repoFullName =
    repository && typeof repository === "object"
      ? (repository as Record<string, unknown>).full_name
      : undefined;

  // Resolve which workspace owns this repo (via its GitHub connector).
  let workspaceId: string | null = null;
  let connector: Awaited<ReturnType<typeof getConnector>> = null;
  if (typeof repoFullName === "string") {
    workspaceId = await findWorkspaceByRepo(repoFullName);
    if (workspaceId) {
      connector = await getConnector(workspaceId, "github");
    }
  }

  // Per-workspace secret wins; the global env var is the local-dev fallback.
  const secret =
    connector?.config.webhookSecret ?? process.env["GITHUB_WEBHOOK_SECRET"];
  if (!verifySignature(raw, signature, secret)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  // `issues` and `push` events carry work; ack ping / others.
  const event = request.headers.get("x-github-event") ?? "";

  if (event === "push") {
    if (!payload) {
      return NextResponse.json({ error: "invalid json" }, { status: 400 });
    }
    return handlePush(payload, repoFullName, workspaceId, request.headers.get("x-github-delivery"));
  }

  if (event !== "issues") {
    return NextResponse.json({ ignored: event || "unknown" });
  }

  if (!payload) {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const action = payload.action;

  // #1345 PR③ / AC2: `edited` is not an admission trigger (it never enqueues
  // — that's what `opened`/`reopened`/`labeled` are for) but it CAN re-brief
  // a denied entry a human hand-edited directly on GitHub. Branches out
  // BEFORE the trigger-action check below (which would otherwise just
  // report it as "not a trigger" and drop it, exactly as it did before this
  // PR) since it needs its own gating (content-changed) and response shape.
  if (action === "edited") {
    return handleIssuesEdited(
      payload,
      repoFullName,
      workspaceId,
      request.headers.get("x-github-delivery")
    );
  }

  if (typeof action !== "string" || !TRIGGER_ACTIONS.has(action)) {
    return NextResponse.json({ matched: false, reason: `action ${String(action)} not a trigger` });
  }

  const issue = payload.issue;
  if (!issue || typeof issue !== "object" || !repository || typeof repository !== "object") {
    return NextResponse.json({ matched: false, reason: "missing issue or repository" });
  }
  const issueObj = issue as Record<string, unknown>;
  if (typeof repoFullName !== "string") {
    return NextResponse.json({ matched: false, reason: "missing repository.full_name" });
  }

  if (!workspaceId) {
    return NextResponse.json({ matched: false, reason: "no workspace owns this repo" });
  }

  // The trigger label is the connector's configured label.
  const triggerLabel = connector?.config.triggerLabel;
  if (!triggerLabel || !labelNames(issueObj).has(triggerLabel)) {
    return NextResponse.json({ matched: false, reason: "trigger label not on issue" });
  }

  const number = Number(issueObj.number ?? 0);
  const title = typeof issueObj.title === "string" ? issueObj.title : "";
  const body = typeof issueObj.body === "string" ? issueObj.body : "";
  const result = await enqueueGithubIssue({
    workspaceId,
    repoFullName,
    number,
    title,
    body,
  });

  let responseBody: Record<string, unknown>;
  if (!result.enqueued) {
    responseBody = { matched: true, enqueued: 0, reason: result.reason };
  } else if (result.state === "parked" && result.parkedFor === "awaiting_alignment") {
    // #1274 finding-1 fix (STALE COMMENT CORRECTED, #1341): `parkedFor` fires
    // whenever alignment IS required and unconfirmed for this issue,
    // REGARDLESS of whether this same enqueue ALSO parked the row for an
    // unmet dependency — a dependency park keeps its own "Waiting on #N"
    // `state`/reason in the DB while STILL carrying `parkedFor` here (see
    // `EnqueueResult.parkedFor`'s own doc-comment in github_intake.ts). Only a
    // v2-guardrail park (injection/dup/rate-limit) never sets `parkedFor` —
    // that path has no automatic unpark and is out of the alignment gate's
    // scope entirely. So this branch composes+posts Jace's alignment brief
    // for BOTH a clean alignment-only park and a dependency-park-that-also-
    // needs-a-brief. The entry is ALREADY durably parked at this point
    // (enqueueGithubIssue's insert already committed), so any failure below
    // is caught inside postAlignmentBrief itself and never turns into a
    // silently-queued row.
    const alignmentBrief = await postAlignmentBrief({
      workspaceId,
      queueEntryId: result.id,
      repoFullName,
      number,
      title,
      body,
    });
    responseBody = { matched: true, enqueued: 1, id: result.id, alignmentBrief };
  } else {
    responseBody = { matched: true, enqueued: 1, id: result.id };
  }

  // #1274 PR③: this admission attempt is a "next queue activity" trigger to
  // sweep for OTHER stale, brief-less parked entries IN THIS WORKSPACE
  // (workspace-scoped by the sweep itself — I2 fix round; see
  // findAlignmentBriefCandidates' own doc-comment) — Python-admitted rows,
  // a prior postAlignmentBrief failure, a v2-guardrail park
  // unparkDependents relabeled. Runs AFTER the branch above, not before:
  // the branch above already gave the row THIS request just admitted its
  // own explicit postAlignmentBrief attempt — running the sweep first would
  // let it race that same call for the SAME entry within this one request
  // (the I1 created-gate now ALSO covers cross-request races at the send
  // itself, but keeping this request's own two calls ordered stays the
  // cleaner geometry: one obvious owner per entry per request). Bounded,
  // best-effort, and NON-FATAL: a reconciler failure must never fail this
  // webhook's response, so it is caught here regardless of what caused it
  // (findAlignmentBriefCandidates itself is also defensive, but this is
  // the outer belt-and-suspenders).
  try {
    await reconcileAlignmentBriefs(workspaceId, 5);
  } catch (err) {
    console.error("[github/webhook] alignment-reconciler sweep failed:", err);
  }

  return NextResponse.json(responseBody);
}
