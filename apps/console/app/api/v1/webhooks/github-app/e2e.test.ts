import { createHmac } from "crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Arc B — reviewer of record, console cross-boundary e2e (Task 9, spec
 * docs/superpowers/specs/2026-07-31-reviewer-of-record-design.md). Walks a
 * signed GitHub-App webhook delivery through the full queue lifecycle by
 * calling the four already-unit-tested routes IN SEQUENCE — webhook
 * (./route.ts) -> claim (../../runner/review-jobs/claim/route.ts) -> bind
 * (.../bind/route.ts) -> complete (.../complete/route.ts) — the same call
 * chain the headless Jace review worker makes in production.
 *
 * MOCKING BOUNDARY (full disclosure in task-9-report.md): this repo has no
 * real-Postgres integration mode at the console ROUTE layer — only
 * `packages/db-postgres/src/__tests__/review-jobs.integration.test.ts`
 * exercises real SQL, at the query-FUNCTION layer (a `DB_AVAILABLE` skip-if
 * against a real local Postgres, see that file's own doc-comment), and it is
 * not wired into `apps/console/vitest.config.ts` at all — no console route
 * test anywhere in this repo touches a real db. So this test mocks
 * `@agentrail/db-postgres` at the SAME module boundary each of the four
 * routes' own colocated `route.test.ts` already mocks it at — but where each
 * of THOSE tests wires a bare `vi.fn()` per call with a hand-set
 * `mockResolvedValue` per test (proving ONE route calls its own mock
 * correctly, in isolation), this file backs the SAME functions with ONE
 * shared in-memory store (`vi.hoisted`, below) so the row the webhook's
 * the atomic head-advance creates is the SAME row `claimReviewJob` finds,
 * `bindReviewJobSession` attaches a session to, and `completeReviewJob`
 * resolves — proving the ROUTES' wiring composes end to end, not just that
 * each one calls its own mock correctly (already covered by the four
 * `route.test.ts` files; this file does not re-litigate any single-route
 * branch already proven there).
 *
 * The fake reimplements only as much of each function's real state-machine
 * contract as this flow exercises (queued -> running -> posted, plus the
 * synchronize-debounce supersede for the storm variant). It deliberately does
 * NOT model SKIP LOCKED concurrency, the daily-budget skip path, or the
 * advisory-lock mutual-supersede guard — those are genuine SQL-level
 * properties already proven by the real-Postgres integration test named
 * above; re-proving them against an in-memory Map would be a false floor,
 * not a stronger one.
 */

// --- shared in-memory store ---------------------------------------------------
// Declared via vi.hoisted so both the vi.mock factory below AND the test
// bodies reference the SAME Map instances — a plain top-level `const` here
// would be hoisted-above by vi.mock's own transform and throw a
// "Cannot access before initialization" the moment the factory (which runs
// first) tried to close over it.

interface FakeJobRow {
  id: string;
  workspaceId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  event: string;
  state: string;
  attempts: number;
  claimedBy: string | null;
  claimedAt: Date | null;
  nextEligibleAt: Date | null;
  postedReviewUrl: string | null;
  verdict: string | null;
  skipReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface FakeSessionRow {
  workspaceId: string;
  channel: string;
  conversationKey: string;
  eveSessionId: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

interface FakeRepoRow {
  id: string;
  workspaceId: string;
  name: string;
  url: string;
  defaultBranch: string;
}

const { jobs, sessions, currentHeads, workspacesByInstallation, reposByWorkspace, resetStore, repoKey } =
  vi.hoisted(() => {
    const jobs = new Map<string, FakeJobRow>();
    const sessions = new Map<string, FakeSessionRow>();
    const currentHeads = new Map<string, string>();
    const workspacesByInstallation = new Map<number, { workspaceId: string }>();
    const reposByWorkspace = new Map<string, FakeRepoRow>();

    function repoKey(workspaceId: string, name: string): string {
      return `${workspaceId}:${name.toLowerCase()}`;
    }

    return {
      jobs,
      sessions,
      currentHeads,
      workspacesByInstallation,
      reposByWorkspace,
      repoKey,
      resetStore: () => {
        jobs.clear();
        sessions.clear();
        currentHeads.clear();
        workspacesByInstallation.clear();
        reposByWorkspace.clear();
      },
    };
  });

vi.mock("@agentrail/db-postgres", () => ({
  appendChangeRecordEvent: vi.fn(),
  findOrCreateChangeRecord: vi.fn(),
  recordReviewEvent: vi.fn(async () => ({ recorded: true, eventId: "review-event-e2e" })),
  readChangeRecordByPr: vi.fn(async (input: {
    workspaceId: string;
    repo: string;
    prNumber: number;
  }) => currentHeads.has(`${input.workspaceId}:${input.repo}:${input.prNumber}`)
    ? { id: "11111111-1111-4111-8111-111111111111" }
    : null),
  invalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEvent: vi.fn(
    async (input: {
      workspaceId: string;
      repo: string;
      prNumber: number;
    }) => {
      let superseded = 0;
      for (const job of jobs.values()) {
        if (
          job.workspaceId === input.workspaceId &&
          job.repo === input.repo &&
          job.prNumber === input.prNumber &&
          (job.state === "queued" || job.state === "running")
        ) {
          job.state = "superseded";
          job.updatedAt = new Date();
          superseded += 1;
        }
      }
      return {
        kind: "invalidated",
        inserted: true,
        provenanceEventId: "terminal-event-e2e",
        superseded,
        previewBootsTornDown: 0,
        currentHeadSha:
          currentHeads.get(`${input.workspaceId}:${input.repo}:${input.prNumber}`) ?? null,
        currentHeadCycleId: null,
      };
    }
  ),
  triggerDependencyWatchesForPush: vi.fn(async () => []),
  getWorkspaceByGithubInstallationId: vi.fn(async (installationId: number) => {
    return workspacesByInstallation.get(installationId) ?? null;
  }),

  getRepositoryByName: vi.fn(async (workspaceId: string, name: string) => {
    return reposByWorkspace.get(repoKey(workspaceId, name)) ?? null;
  }),

  // Mirrors the webhook's one atomic DB boundary: advance the Record's
  // current signed PR head, deterministic job dedupe, and same-PR
  // supersession. This fake deliberately keeps the state in one function so
  // the cross-route test cannot accidentally prove the former split calls.
  advanceConfirmedAcceptanceRecordPullRequestHead: vi.fn(
    async (input: {
      workspaceId: string;
      recordId: string;
      repo: string;
      prNumber: number;
      headSha: string;
      event: string;
      headTransition: {
        beforeHeadSha: string;
        afterHeadSha: string;
      } | null;
      admitReviewJob: boolean;
    }) => {
      const prKey = `${input.workspaceId}:${input.repo}:${input.prNumber}`;
      const previousHeadSha = currentHeads.get(prKey) ?? null;
      const headChanged = previousHeadSha !== input.headSha;
      if (
        previousHeadSha !== null &&
        headChanged &&
        (input.event !== "synchronize" ||
          input.headTransition?.beforeHeadSha !== previousHeadSha)
      ) {
        let superseded = 0;
        for (const job of jobs.values()) {
          if (
            job.workspaceId === input.workspaceId &&
            job.repo === input.repo &&
            job.prNumber === input.prNumber &&
            (job.state === "queued" || job.state === "running")
          ) {
            job.state = "superseded";
            job.updatedAt = new Date();
            superseded += 1;
          }
        }
        return { kind: "stale_delivery", superseded };
      }
      currentHeads.set(prKey, input.headSha);
      const id = `job:${prKey}:${input.headSha}`;
      let insertedJob = false;
      if (input.admitReviewJob && !jobs.has(id)) {
        const now = new Date();
        jobs.set(id, {
          id,
          workspaceId: input.workspaceId,
          repo: input.repo,
          prNumber: input.prNumber,
          headSha: input.headSha,
          event: input.event,
          state: "queued",
          attempts: 0,
          claimedBy: null,
          claimedAt: null,
          nextEligibleAt:
            input.event === "synchronize" ? new Date(now.getTime() + 60_000) : null,
          postedReviewUrl: null,
          verdict: null,
          skipReason: null,
          createdAt: now,
          updatedAt: now,
        });
        insertedJob = true;
      }

      let superseded = 0;
      for (const other of jobs.values()) {
        if (
          other.id !== id &&
          other.workspaceId === input.workspaceId &&
          other.repo === input.repo &&
          other.prNumber === input.prNumber &&
          other.headSha !== input.headSha &&
          (other.state === "queued" || other.state === "running")
        ) {
          other.state = "superseded";
          other.updatedAt = new Date();
          superseded++;
        }
      }
      return {
        kind: "advanced",
        record: { id: input.recordId },
        jobId: id,
        jobAdmitted: input.admitReviewJob,
        deduped: !headChanged && !insertedJob,
        superseded,
        previousHeadSha,
        headChanged,
      };
    }
  ),

  // Mirrors claimReviewJob's oldest-eligible-first + per-workspace running
  // bound. Does NOT model SKIP LOCKED concurrency or the daily-budget skip —
  // this flow never exercises either (see the file doc-comment above).
  claimReviewJob: vi.fn(async (input: { workerId: string; dailyBudget: number }) => {
    const now = Date.now();
    const runningWorkspaces = new Set(
      Array.from(jobs.values())
        .filter((j) => j.state === "running")
        .map((j) => j.workspaceId)
    );
    const candidates = Array.from(jobs.values())
      .filter(
        (j) =>
          j.state === "queued" &&
          (j.nextEligibleAt === null || j.nextEligibleAt.getTime() <= now) &&
          !runningWorkspaces.has(j.workspaceId)
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    const row = candidates[0];
    if (!row) return null;
    row.state = "running";
    row.claimedBy = input.workerId;
    row.claimedAt = new Date();
    row.updatedAt = new Date();
    return { ...row };
  }),

  getReviewJobState: vi.fn(async (jobId: string) => {
    return jobs.get(jobId)?.state ?? null;
  }),

  // Mirrors bindReviewJobSession's real contract: throws for an unknown
  // jobId, upserts on (workspaceId, channel, conversationKey).
  bindReviewJobSession: vi.fn(async (input: { jobId: string; eveSessionId: string }) => {
    const job = jobs.get(input.jobId);
    if (!job) {
      throw new Error(`bindReviewJobSession: no review_jobs row for id ${input.jobId}`);
    }
    const conversationKey = `review-job:${input.jobId}`;
    const now = new Date();
    const existing = sessions.get(conversationKey);
    if (existing) {
      existing.eveSessionId = input.eveSessionId;
      existing.updatedAt = now;
    } else {
      sessions.set(conversationKey, {
        workspaceId: job.workspaceId,
        channel: "review-job",
        conversationKey,
        eveSessionId: input.eveSessionId,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
    }
  }),

  releaseReviewJob: vi.fn(async (input: { jobId: string }) => {
    const job = jobs.get(input.jobId);
    if (job && job.state === "running") {
      job.state = "queued";
      job.claimedBy = null;
      job.claimedAt = null;
      job.updatedAt = new Date();
    }
  }),

  // Mirrors completeReviewJob's guarded WHERE id = $1 AND state = 'running'.
  completeReviewJob: vi.fn(
    async (input: {
      jobId: string;
      outcome: "posted" | "failed";
      postedReviewUrl?: string | null;
      verdict?: string | null;
      error?: string | null;
    }) => {
      const job = jobs.get(input.jobId);
      if (!job || job.state !== "running") return null;

      if (input.outcome === "posted") {
        job.state = "posted";
        job.postedReviewUrl = input.postedReviewUrl ?? null;
        job.verdict = input.verdict ?? null;
        job.updatedAt = new Date();
        return { ...job };
      }

      job.attempts += 1;
      if (job.attempts > 2) {
        job.state = "failed";
        job.nextEligibleAt = null;
        job.skipReason = input.error ?? "review failed (no error detail)";
      } else {
        job.state = "queued";
        job.nextEligibleAt = new Date(Date.now() + 5 * 60 * 1000);
        job.skipReason = null;
        job.claimedBy = null;
        job.claimedAt = null;
      }
      job.updatedAt = new Date();
      return { ...job };
    }
  ),
}));

// The notify module is mocked wholesale, same convention as
// runner/review-jobs/complete/route.test.ts's own
// `vi.mock("../../result/notify", ...)` — that specifier is relative to
// complete/route.ts's OWN location (api/v1/runner/review-jobs/complete/,
// three levels below api/v1, sharing the `runner/` ancestor with notify.ts,
// hence its "../../result/notify"). This file lives at
// api/v1/webhooks/github-app/ instead — two levels below api/v1, sharing NO
// ancestor with notify.ts below that point — so the equivalent specifier
// here is "../../runner/result/notify". Both strings resolve to the exact
// same absolute module (verified), which is what makes Vitest's module
// interception apply to complete/route.ts's own import too.
vi.mock("../../runner/result/notify", () => ({
  sendWorkspaceNotification: vi.fn(),
}));

import { POST as webhookPost } from "./route";
import { POST as claimPost } from "../../runner/review-jobs/claim/route";
import { POST as bindPost } from "../../runner/review-jobs/bind/route";
import { POST as completePost } from "../../runner/review-jobs/complete/route";
import { sendWorkspaceNotification } from "../../runner/result/notify";

const mockNotify = vi.mocked(sendWorkspaceNotification);

// --- env fixtures --------------------------------------------------------------
const WEBHOOK_SECRET_ENV = "GITHUB_APP_WEBHOOK_SECRET";
const ENROLL_ENV = "REVIEWER_OF_RECORD_WORKSPACES";
const JACE_TOKEN_ENV = "JACE_CONSOLE_TOKEN";

const WEBHOOK_SECRET = "gh-app-webhook-secret-e2e";
const JACE_SECRET = "jace-shared-secret-e2e";

const ORIGINAL_WEBHOOK_SECRET = process.env[WEBHOOK_SECRET_ENV];
const ORIGINAL_ENROLL = process.env[ENROLL_ENV];
const ORIGINAL_JACE_TOKEN = process.env[JACE_TOKEN_ENV];

const WORKSPACE_ID = "ws-e2e-1";
const INSTALLATION_ID = 778899;
const REPO_FULL_NAME = "ada/widgets";

// --- webhook request helpers (mirrors ./route.test.ts's own sign/makeRequest recipe) --
function sign(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

function webhookRequest(body: string): NextRequest {
  return new NextRequest("http://localhost/api/v1/webhooks/github-app", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": "delivery-e2e-1",
      "x-hub-signature-256": sign(body, WEBHOOK_SECRET),
    },
    body,
  });
}

function prPayload(opts: {
  action: string;
  headSha: string;
  prNumber: number;
  beforeHeadSha?: string;
  draft?: boolean;
  merged?: boolean;
}): Record<string, unknown> {
  const { action, headSha, prNumber } = opts;
  return {
    action,
    ...(action === "synchronize"
      ? {
          before: opts.beforeHeadSha ?? "0".repeat(40),
          after: headSha,
        }
      : {}),
    number: prNumber,
    pull_request: {
      number: prNumber,
      draft: opts.draft ?? false,
      head: { sha: headSha },
      merged: opts.merged ?? false,
      merge_commit_sha: opts.merged ? "f".repeat(40) : null,
      html_url: `https://github.com/${REPO_FULL_NAME}/pull/${prNumber}`,
      body: "<!-- jace-acceptance-record: 11111111-1111-4111-8111-111111111111 -->",
    },
    repository: { full_name: REPO_FULL_NAME },
    installation: { id: INSTALLATION_ID },
  };
}

// --- Jace-coordinator request helpers (mirrors claim/bind/complete's own postReq) ------
function jaceRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${JACE_SECRET}`,
    },
    body: JSON.stringify(body),
  });
}

function claimRequest(body: unknown): NextRequest {
  return jaceRequest("http://localhost/api/v1/runner/review-jobs/claim", body);
}
function bindRequest(body: unknown): NextRequest {
  return jaceRequest("http://localhost/api/v1/runner/review-jobs/bind", body);
}
function completeRequest(body: unknown): NextRequest {
  return jaceRequest("http://localhost/api/v1/runner/review-jobs/complete", body);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  process.env[WEBHOOK_SECRET_ENV] = WEBHOOK_SECRET;
  process.env[ENROLL_ENV] = WORKSPACE_ID;
  process.env[JACE_TOKEN_ENV] = JACE_SECRET;
  workspacesByInstallation.set(INSTALLATION_ID, { workspaceId: WORKSPACE_ID });
  reposByWorkspace.set(repoKey(WORKSPACE_ID, REPO_FULL_NAME), {
    id: "repo-e2e-1",
    workspaceId: WORKSPACE_ID,
    name: REPO_FULL_NAME,
    url: `https://github.com/${REPO_FULL_NAME}`,
    defaultBranch: "main",
  });
  mockNotify.mockResolvedValue(undefined);
});

afterEach(() => {
  if (ORIGINAL_WEBHOOK_SECRET === undefined) delete process.env[WEBHOOK_SECRET_ENV];
  else process.env[WEBHOOK_SECRET_ENV] = ORIGINAL_WEBHOOK_SECRET;
  if (ORIGINAL_ENROLL === undefined) delete process.env[ENROLL_ENV];
  else process.env[ENROLL_ENV] = ORIGINAL_ENROLL;
  if (ORIGINAL_JACE_TOKEN === undefined) delete process.env[JACE_TOKEN_ENV];
  else process.env[JACE_TOKEN_ENV] = ORIGINAL_JACE_TOKEN;
});

describe("Arc B reviewer-of-record — console cross-boundary e2e (Task 9)", () => {
  it("webhook -> claim -> bind -> failed completion preserves one atomic intake lifecycle", async () => {
    const prNumber = 42;
    const headSha = "a".repeat(40);

    // 1. signed pull_request webhook (opened, enrolled workspace, connected repo)
    const webhookRes = await webhookPost(
      webhookRequest(JSON.stringify(prPayload({ action: "opened", headSha, prNumber })))
    );
    expect(webhookRes.status).toBe(200);
    expect(await webhookRes.json()).toEqual({
      ok: true,
      enqueued: true,
      deduped: false,
      superseded: 0,
      headChanged: true,
      previousHeadSha: null,
    });

    // -> job row exists, queued
    expect(jobs.size).toBe(1);
    const queuedRow = Array.from(jobs.values())[0]!;
    expect(queuedRow).toMatchObject({
      workspaceId: WORKSPACE_ID,
      repo: REPO_FULL_NAME,
      prNumber,
      headSha,
      event: "opened",
      state: "queued",
    });

    // 2. claim {workerId} — no session yet, claim-first restructure
    const claimRes = await claimPost(claimRequest({ workerId: "worker-1" }));
    expect(claimRes.status).toBe(200);
    const claimBody = await claimRes.json();
    expect(claimBody).toEqual({
      job: {
        id: queuedRow.id,
        repo: REPO_FULL_NAME,
        prNumber,
        headSha,
        event: "opened",
        workspaceId: WORKSPACE_ID,
      },
    });
    const jobId: string = claimBody.job.id;

    // -> claim's own workerId was threaded through to the persisted row, not
    // just echoed in the response (queuedRow is the SAME object the store
    // holds, so this reads the post-claim state).
    expect(queuedRow.claimedBy).toBe("worker-1");
    expect(queuedRow.state).toBe("running");

    // 3. bind {jobId, eveSessionId}
    const eveSessionId = "eve-session-e2e-1";
    const bindRes = await bindPost(bindRequest({ jobId, eveSessionId }));
    expect(bindRes.status).toBe(200);
    expect(await bindRes.json()).toEqual({ ok: true });

    // -> jace_sessions binding row shape
    const sessionRow = sessions.get(`review-job:${jobId}`);
    expect(sessionRow).toBeDefined();
    expect(sessionRow).toMatchObject({
      workspaceId: WORKSPACE_ID,
      channel: "review-job",
      conversationKey: `review-job:${jobId}`,
      eveSessionId,
    });

    // 4. A failed worker attempt may requeue only while this exact job is
    // still running. Posted completion has a separate exact-proof e2e lane.
    const completeRes = await completePost(
      completeRequest({
        jobId,
        outcome: "failed",
        error: "transient GitHub 502",
      })
    );
    expect(completeRes.status).toBe(200);
    expect(await completeRes.json()).toEqual({ ok: true });

    // -> same job becomes retryable; failed completion never fabricates a
    // posted receipt or human notification.
    expect(jobs.get(jobId)).toMatchObject({
      state: "queued",
      attempts: 1,
      postedReviewUrl: null,
      verdict: null,
    });
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("opened A -> draft synchronize B -> ready B invalidates A before admitting B", async () => {
    const prNumber = 55;
    const headA = "d".repeat(40);
    const headB = "e".repeat(40);

    const opened = await webhookPost(webhookRequest(JSON.stringify(
      prPayload({ action: "opened", headSha: headA, prNumber })
    )));
    expect(await opened.json()).toEqual(expect.objectContaining({
      enqueued: true,
      deduped: false,
      headChanged: true,
    }));

    const draftAdvance = await webhookPost(webhookRequest(JSON.stringify(
      prPayload({
        action: "synchronize",
        headSha: headB,
        prNumber,
        beforeHeadSha: headA,
        draft: true,
      })
    )));
    expect(await draftAdvance.json()).toEqual({
      ok: true,
      enqueued: false,
      deduped: false,
      superseded: 1,
      headChanged: true,
      previousHeadSha: headA,
    });
    expect(currentHeads.get(`${WORKSPACE_ID}:${REPO_FULL_NAME}:${prNumber}`))
      .toBe(headB);
    expect(Array.from(jobs.values()).find((job) => job.headSha === headA)?.state)
      .toBe("superseded");
    expect(Array.from(jobs.values()).some((job) => job.headSha === headB)).toBe(false);

    const draftReplay = await webhookPost(webhookRequest(JSON.stringify(
      prPayload({
        action: "synchronize",
        headSha: headB,
        prNumber,
        beforeHeadSha: headA,
        draft: true,
      })
    )));
    expect(await draftReplay.json()).toEqual({
      ok: true,
      enqueued: false,
      deduped: true,
      superseded: 0,
      headChanged: false,
      previousHeadSha: headB,
    });

    const ready = await webhookPost(webhookRequest(JSON.stringify(
      prPayload({
        action: "ready_for_review",
        headSha: headB,
        prNumber,
        draft: true,
      })
    )));
    expect(await ready.json()).toEqual({
      ok: true,
      enqueued: true,
      deduped: false,
      superseded: 0,
      headChanged: false,
      previousHeadSha: headB,
    });
    expect(Array.from(jobs.values()).find((job) => job.headSha === headB))
      .toMatchObject({ state: "queued", event: "ready_for_review" });
  });

  it("draft opened A -> draft reopened B blocks authority instead of leaving A live", async () => {
    const prNumber = 56;
    const headA = "1".repeat(40);
    const headB = "2".repeat(40);

    const opened = await webhookPost(webhookRequest(JSON.stringify(
      prPayload({ action: "opened", headSha: headA, prNumber, draft: true })
    )));
    expect(await opened.json()).toEqual(expect.objectContaining({
      enqueued: false,
    }));
    expect(jobs.size).toBe(0);

    const reopened = await webhookPost(webhookRequest(JSON.stringify(
      prPayload({ action: "reopened", headSha: headB, prNumber, draft: true })
    )));
    expect(await reopened.json()).toEqual({
      ok: true,
      ignored: true,
      enqueued: false,
      blocked: true,
      reason: "stale delivery; current head requires reconciliation",
      superseded: 0,
    });
    expect(currentHeads.get(`${WORKSPACE_ID}:${REPO_FULL_NAME}:${prNumber}`))
      .toBe(headA);
    expect(jobs.size).toBe(0);
  });

  it("terminal close supersedes the attached current job without moving its head", async () => {
    const prNumber = 57;
    const headSha = "3".repeat(40);

    await webhookPost(webhookRequest(JSON.stringify(
      prPayload({ action: "opened", headSha, prNumber })
    )));
    const queued = Array.from(jobs.values()).find(
      (job) => job.prNumber === prNumber
    )!;
    expect(queued.state).toBe("queued");

    const closed = await webhookPost(webhookRequest(JSON.stringify(
      prPayload({ action: "closed", headSha, prNumber, merged: false })
    )));

    expect(await closed.json()).toEqual({
      ok: true,
      closed: true,
      invalidated: true,
      superseded: 1,
      previewBootsTornDown: 0,
    });
    expect(queued.state).toBe("superseded");
    expect(currentHeads.get(`${WORKSPACE_ID}:${REPO_FULL_NAME}:${prNumber}`))
      .toBe(headSha);
    expect((await claimPost(claimRequest({ workerId: "worker-closed" }))).status)
      .toBe(204);
  });

  it("push storm: two synchronize deliveries for successive heads — first superseded, second present but eligible-deferred", async () => {
    const prNumber = 77;
    const headA = "b".repeat(40);
    const headB = "c".repeat(40);

    const firstRes = await webhookPost(
      webhookRequest(
        JSON.stringify(prPayload({ action: "synchronize", headSha: headA, prNumber }))
      )
    );
    expect(firstRes.status).toBe(200);
    expect(await firstRes.json()).toEqual({
      ok: true,
      enqueued: true,
      deduped: false,
      superseded: 0,
      headChanged: true,
      previousHeadSha: null,
    });

    const replayRes = await webhookPost(
      webhookRequest(
        JSON.stringify(prPayload({ action: "synchronize", headSha: headA, prNumber }))
      )
    );
    expect(replayRes.status).toBe(200);
    expect(await replayRes.json()).toEqual({
      ok: true,
      enqueued: true,
      deduped: true,
      superseded: 0,
      headChanged: false,
      previousHeadSha: headA,
    });
    expect(jobs.size).toBe(1);

    const secondRes = await webhookPost(
      webhookRequest(
        JSON.stringify(
          prPayload({
            action: "synchronize",
            headSha: headB,
            prNumber,
            beforeHeadSha: headA,
          })
        )
      )
    );
    expect(secondRes.status).toBe(200);
    expect(await secondRes.json()).toEqual({
      ok: true,
      enqueued: true,
      deduped: false,
      superseded: 1,
      headChanged: true,
      previousHeadSha: headA,
    });

    expect(jobs.size).toBe(2);
    const rowA = Array.from(jobs.values()).find((j) => j.headSha === headA);
    const rowB = Array.from(jobs.values()).find((j) => j.headSha === headB);

    // first (headA) is superseded by the second delivery's newer head ...
    expect(rowA?.state).toBe("superseded");

    const staleFailure = await completePost(
      completeRequest({
        jobId: rowA!.id,
        outcome: "failed",
        error: "late worker failure",
      })
    );
    expect(staleFailure.status).toBe(409);
    expect(rowA?.state).toBe("superseded");

    // ... second (headB) is present and queued, but eligible-deferred: the
    // synchronize debounce seeds a future next_eligible_at, not immediately
    // claimable.
    expect(rowB?.state).toBe("queued");
    expect(rowB?.nextEligibleAt).not.toBeNull();
    expect(rowB!.nextEligibleAt!.getTime()).toBeGreaterThan(Date.now());

    // The claim route itself agrees: nothing is eligible right now (204).
    const claimRes = await claimPost(claimRequest({ workerId: "worker-1" }));
    expect(claimRes.status).toBe(204);

    const delayedOldHead = await webhookPost(
      webhookRequest(
        JSON.stringify(
          prPayload({
            action: "synchronize",
            headSha: headA,
            prNumber,
            beforeHeadSha: "0".repeat(40),
          })
        )
      )
    );
    expect(delayedOldHead.status).toBe(200);
    expect(await delayedOldHead.json()).toEqual({
      ok: true,
      ignored: true,
      enqueued: false,
      blocked: true,
      reason: "stale delivery; current head requires reconciliation",
      superseded: 1,
    });
    expect(currentHeads.get(`${WORKSPACE_ID}:${REPO_FULL_NAME}:${prNumber}`))
      .toBe(headB);
    expect(rowB?.state).toBe("superseded");
  });
});
