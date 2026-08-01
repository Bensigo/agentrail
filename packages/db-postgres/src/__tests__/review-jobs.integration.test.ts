import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db } from "../db.js";
import { workspaces } from "../schema/workspaces.js";
import { reviewJobs } from "../schema/review_jobs.js";
import { jaceSessions } from "../schema/jace_sessions.js";
import {
  reviewJobId,
  enqueueReviewJob,
  claimReviewJob,
  completeReviewJob,
  bindReviewJobSession,
} from "../queries/review_jobs.js";
import { getWorkspaceByGithubInstallationId } from "../queries/github-app-token.js";

/**
 * Arc B §2-§3 — DB-LEVEL INTEGRATION TESTS against a REAL Postgres (no mocks
 * of `db`), mirroring `queue-retry-backoff.integration.test.ts`'s own
 * DB_AVAILABLE skip-if pattern. The semantics under test here (the
 * EvalPlanQual-safe supersede, the SKIP LOCKED claim + per-workspace
 * running-job bound, the daily budget count, the fixed-backoff complete, the
 * real jace_sessions insert/re-bind, and the installation-id text-column
 * coercion) all LIVE in SQL or in cross-row correctness a mock cannot prove —
 * see `review-jobs.test.ts`'s own doc-comment for why those cases are not
 * duplicated there as hollow mock-based stand-ins.
 *
 * Requires a reachable Postgres at `DATABASE_URL`, migrated through
 * `0065_review_jobs`. Skips cleanly (not a failure) when no DB is reachable.
 *
 * Isolation: every describe block below creates a FRESH workspace per test
 * (beforeEach/afterEach) rather than sharing one across the file. This
 * matters specifically for `claimReviewJob`, whose "at most one running job
 * per workspace" and "today's non-superseded jobs for the workspace" budget
 * count are workspace-scoped invariants — a shared workspace would let one
 * test's leftover row silently change another test's claim/budget outcome.
 * `workspaces` cascades ON DELETE to both `review_jobs` and `jace_sessions`,
 * so deleting the per-test workspace in `afterEach` is sufficient cleanup.
 */
const DB_AVAILABLE: boolean = await (async () => {
  try {
    await db.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!DB_AVAILABLE)(
  "review_jobs queries — real Postgres integration (Arc B §2-§3)",
  () => {
    async function createWorkspace(
      overrides: { githubInstallationId?: string } = {}
    ): Promise<string> {
      const rows = await db
        .insert(workspaces)
        .values({
          name: "review-jobs test workspace",
          slug: `test-review-jobs-${randomUUID()}`,
          ...overrides,
        })
        .returning({ id: workspaces.id });
      return rows[0]!.id;
    }

    async function deleteWorkspace(id: string): Promise<void> {
      // Cascades to review_jobs (workspace_id) and jace_sessions
      // (workspace_id) — both declared ON DELETE CASCADE.
      await db.delete(workspaces).where(eq(workspaces.id, id));
    }

    async function insertReviewJob(
      workspaceId: string,
      overrides: Partial<{
        repo: string;
        prNumber: number;
        headSha: string;
        event: string;
        state: string;
        attempts: number;
        claimedBy: string | null;
        claimedAt: Date | null;
        nextEligibleAt: Date | null;
        createdAt: Date;
      }> = {}
    ): Promise<string> {
      const repo = overrides.repo ?? "acme/widgets";
      const prNumber = overrides.prNumber ?? 1;
      const headSha = overrides.headSha ?? randomUUID().replace(/-/g, "");
      const id = reviewJobId({ workspaceId, repo, prNumber, headSha });
      await db.insert(reviewJobs).values({
        id,
        workspaceId,
        repo,
        prNumber,
        headSha,
        event: overrides.event ?? "opened",
        state: overrides.state ?? "queued",
        attempts: overrides.attempts ?? 0,
        claimedBy: overrides.claimedBy ?? null,
        claimedAt: overrides.claimedAt ?? null,
        nextEligibleAt: overrides.nextEligibleAt ?? null,
        ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
      });
      return id;
    }

    async function readReviewJob(id: string) {
      const rows = await db
        .select()
        .from(reviewJobs)
        .where(eq(reviewJobs.id, id));
      return rows[0]!;
    }

    // -----------------------------------------------------------------
    // enqueueReviewJob — dedupe + debounce + EvalPlanQual-safe supersede
    // -----------------------------------------------------------------
    describe("enqueueReviewJob", () => {
      let wsId: string;
      beforeEach(async () => {
        wsId = await createWorkspace();
      });
      afterEach(async () => {
        await deleteWorkspace(wsId);
      });

      it("deterministic id: the same event re-delivered dedupes (ON CONFLICT DO NOTHING)", async () => {
        const input = {
          workspaceId: wsId,
          repo: "acme/widgets",
          prNumber: 1,
          headSha: "sha-a",
          event: "opened",
        };
        const first = await enqueueReviewJob(input);
        expect(first.deduped).toBe(false);
        expect(first.id).toBe(reviewJobId(input));

        const second = await enqueueReviewJob(input);
        expect(second.id).toBe(first.id);
        expect(second.deduped).toBe(true);

        const rows = await db
          .select()
          .from(reviewJobs)
          .where(eq(reviewJobs.id, first.id));
        expect(rows).toHaveLength(1); // still exactly one row, not two
      });

      it("'synchronize' seeds next_eligible_at ~60s out; 'opened' leaves it eligible immediately", async () => {
        const opened = await enqueueReviewJob({
          workspaceId: wsId,
          repo: "acme/widgets",
          prNumber: 2,
          headSha: "sha-open",
          event: "opened",
        });
        const openedRow = await readReviewJob(opened.id);
        expect(openedRow.nextEligibleAt).toBeNull();

        const before = Date.now();
        const synced = await enqueueReviewJob({
          workspaceId: wsId,
          repo: "acme/widgets",
          prNumber: 2,
          headSha: "sha-sync",
          event: "synchronize",
        });
        const syncedRow = await readReviewJob(synced.id);
        expect(syncedRow.nextEligibleAt).not.toBeNull();
        const deltaMs = syncedRow.nextEligibleAt!.getTime() - before;
        expect(deltaMs).toBeGreaterThan(55_000);
        expect(deltaMs).toBeLessThan(65_000);
      });

      it("supersedes ONLY still-'queued' siblings for the same PR — a 'running' sibling is untouched (EvalPlanQual pin)", async () => {
        const runningSibling = await enqueueReviewJob({
          workspaceId: wsId,
          repo: "acme/widgets",
          prNumber: 3,
          headSha: "sha-1",
          event: "opened",
        });
        // Simulate an in-flight claim directly — claimReviewJob's own
        // semantics are covered separately below.
        await db
          .update(reviewJobs)
          .set({ state: "running" })
          .where(eq(reviewJobs.id, runningSibling.id));

        const stillQueuedSibling = await enqueueReviewJob({
          workspaceId: wsId,
          repo: "acme/widgets",
          prNumber: 3,
          headSha: "sha-2",
          event: "opened",
        });

        const latest = await enqueueReviewJob({
          workspaceId: wsId,
          repo: "acme/widgets",
          prNumber: 3,
          headSha: "sha-3",
          event: "opened",
        });

        // Only sha-2's still-queued row supersedes; sha-1 is 'running' and
        // excluded by the `state = 'queued'` predicate on the UPDATE's own
        // WHERE.
        expect(latest.superseded).toBe(1);

        const runningRow = await readReviewJob(runningSibling.id);
        expect(runningRow.state).toBe("running"); // untouched

        const supersededRow = await readReviewJob(stillQueuedSibling.id);
        expect(supersededRow.state).toBe("superseded");
      });

      it("never supersedes a DIFFERENT PR or a DIFFERENT repo's queued job", async () => {
        const otherPr = await enqueueReviewJob({
          workspaceId: wsId,
          repo: "acme/widgets",
          prNumber: 10,
          headSha: "sha-other-pr",
          event: "opened",
        });
        const otherRepo = await enqueueReviewJob({
          workspaceId: wsId,
          repo: "acme/other-repo",
          prNumber: 4,
          headSha: "sha-other-repo",
          event: "opened",
        });

        const result = await enqueueReviewJob({
          workspaceId: wsId,
          repo: "acme/widgets",
          prNumber: 4,
          headSha: "sha-4",
          event: "opened",
        });
        expect(result.superseded).toBe(0);

        expect((await readReviewJob(otherPr.id)).state).toBe("queued");
        expect((await readReviewJob(otherRepo.id)).state).toBe("queued");
      });
    });

    // -----------------------------------------------------------------
    // claimReviewJob — SKIP LOCKED, per-workspace running bound, budget
    // -----------------------------------------------------------------
    describe("claimReviewJob", () => {
      let wsId: string;
      beforeEach(async () => {
        wsId = await createWorkspace();
      });
      afterEach(async () => {
        await deleteWorkspace(wsId);
      });

      it("returns null when nothing is queued", async () => {
        expect(await claimReviewJob({ workerId: "w1", dailyBudget: 100 })).toBeNull();
      });

      it("skips a queued job whose next_eligible_at is still in the future", async () => {
        await insertReviewJob(wsId, {
          nextEligibleAt: new Date(Date.now() + 10 * 60 * 1000),
        });
        expect(await claimReviewJob({ workerId: "w1", dailyBudget: 100 })).toBeNull();
      });

      it("claims a queued job whose next_eligible_at has already elapsed", async () => {
        const id = await insertReviewJob(wsId, {
          nextEligibleAt: new Date(Date.now() - 1000),
        });
        const claimed = await claimReviewJob({ workerId: "w1", dailyBudget: 100 });
        expect(claimed?.id).toBe(id);
        expect(claimed?.state).toBe("running");
        expect(claimed?.claimedBy).toBe("w1");
        expect(claimed?.claimedAt).not.toBeNull();
      });

      it("claims a queued job with a null next_eligible_at immediately", async () => {
        const id = await insertReviewJob(wsId, { nextEligibleAt: null });
        const claimed = await claimReviewJob({ workerId: "w1", dailyBudget: 100 });
        expect(claimed?.id).toBe(id);
      });

      it("skips every candidate in a workspace that already has a running job", async () => {
        await insertReviewJob(wsId, {
          prNumber: 1,
          state: "running",
          claimedAt: new Date(),
          claimedBy: "already-running",
        });
        await insertReviewJob(wsId, { prNumber: 2, state: "queued" });

        expect(await claimReviewJob({ workerId: "w1", dailyBudget: 100 })).toBeNull();
      });

      it("claims the oldest eligible job first, leaving a newer one queued", async () => {
        const older = await insertReviewJob(wsId, {
          prNumber: 1,
          createdAt: new Date(Date.now() - 10_000),
        });
        const newer = await insertReviewJob(wsId, {
          prNumber: 2,
          createdAt: new Date(),
        });

        const claimed = await claimReviewJob({ workerId: "w1", dailyBudget: 100 });
        expect(claimed?.id).toBe(older);

        const newerRow = await readReviewJob(newer);
        expect(newerRow.state).toBe("queued");
      });

      it("two concurrent claims on the SAME single queued job produce exactly one winner (SKIP LOCKED)", async () => {
        const id = await insertReviewJob(wsId);

        const [a, b] = await Promise.all([
          claimReviewJob({ workerId: "w1", dailyBudget: 100 }),
          claimReviewJob({ workerId: "w2", dailyBudget: 100 }),
        ]);

        const winners = [a, b].filter((r) => r !== null);
        expect(winners).toHaveLength(1);
        expect(winners[0]!.id).toBe(id);

        const row = await readReviewJob(id);
        expect(row.state).toBe("running");
        expect(["w1", "w2"]).toContain(row.claimedBy);
      });

      it("requeues a stale (>15min) running job with attempts bumped, and can reclaim it immediately", async () => {
        const id = await insertReviewJob(wsId, {
          state: "running",
          claimedAt: new Date(Date.now() - 16 * 60 * 1000),
          claimedBy: "dead-worker",
          attempts: 0,
        });

        const claimed = await claimReviewJob({ workerId: "w2", dailyBudget: 100 });
        expect(claimed?.id).toBe(id);
        expect(claimed?.attempts).toBe(1); // bumped by the stale-requeue pre-pass
        expect(claimed?.claimedBy).toBe("w2"); // re-claimed by the NEW worker
      });

      it("does not touch a running job inside its 15-minute grace window", async () => {
        await insertReviewJob(wsId, {
          state: "running",
          claimedAt: new Date(Date.now() - 5 * 60 * 1000),
          claimedBy: "still-alive-worker",
        });
        // Nothing else queued, and the running job is not stale enough to
        // requeue — no eligible candidate exists.
        expect(await claimReviewJob({ workerId: "w2", dailyBudget: 100 })).toBeNull();
      });

      it("escalates a queued job already over the attempts budget to terminal 'failed', never reclaiming it", async () => {
        const id = await insertReviewJob(wsId, { state: "queued", attempts: 3 });

        expect(await claimReviewJob({ workerId: "w1", dailyBudget: 100 })).toBeNull();

        const row = await readReviewJob(id);
        expect(row.state).toBe("failed");
        expect(row.skipReason).toBe("stale after retries");
      });

      it("budget exhaustion: a claimed candidate over today's non-superseded count flips to 'skipped' with a visible reason", async () => {
        const id = await insertReviewJob(wsId);

        expect(await claimReviewJob({ workerId: "w1", dailyBudget: 0 })).toBeNull();

        const row = await readReviewJob(id);
        expect(row.state).toBe("skipped");
        expect(row.skipReason).toBe("daily budget exhausted");
      });

      it("budget boundary: exactly dailyBudget jobs today does NOT trip the skip (strictly '>', not '>=')", async () => {
        const id = await insertReviewJob(wsId);

        const claimed = await claimReviewJob({ workerId: "w1", dailyBudget: 1 });
        expect(claimed?.id).toBe(id);
        expect(claimed?.state).toBe("running");
      });

      it("budget exhaustion skips past an over-budget workspace to claim an eligible job in a different workspace", async () => {
        const overBudgetJob = await insertReviewJob(wsId);
        const otherWs = await createWorkspace();
        try {
          const otherJob = await insertReviewJob(otherWs, { prNumber: 1 });

          // dailyBudget: 0 exhausts wsId's single job (count=1 > 0) but
          // otherWs's own count is independently 1 > 0 too... so use a
          // budget that only wsId has already spent (simulate via a
          // pre-existing superseded+non-superseded mix is unnecessary here:
          // set dailyBudget high enough for otherWs's fresh workspace (1
          // job today) but insert TWO jobs in wsId so wsId is over budget
          // while otherWs (1 job) is not).
          await insertReviewJob(wsId, { prNumber: 99 });

          const claimed = await claimReviewJob({ workerId: "w1", dailyBudget: 1 });
          // wsId now has 2 non-superseded jobs today (over budget=1);
          // otherWs has exactly 1 (at budget, not over) — the claim must
          // skip past wsId's candidates and land on otherWs's job.
          expect(claimed?.id).toBe(otherJob);
          expect(claimed?.workspaceId).toBe(otherWs);

          const overBudgetRow = await readReviewJob(overBudgetJob);
          expect(overBudgetRow.state).toBe("skipped");
        } finally {
          await deleteWorkspace(otherWs);
        }
      });
    });

    // -----------------------------------------------------------------
    // completeReviewJob — guarded resolve, fixed 5-minute backoff
    // -----------------------------------------------------------------
    describe("completeReviewJob", () => {
      let wsId: string;
      beforeEach(async () => {
        wsId = await createWorkspace();
      });
      afterEach(async () => {
        await deleteWorkspace(wsId);
      });

      it("outcome 'posted' resolves the job with url+verdict recorded", async () => {
        const id = await insertReviewJob(wsId, { state: "running" });

        const result = await completeReviewJob({
          jobId: id,
          outcome: "posted",
          postedReviewUrl: "https://github.com/acme/widgets/pull/1#pullrequestreview-1",
          verdict: "approve",
        });

        expect(result?.state).toBe("posted");
        expect(result?.postedReviewUrl).toBe(
          "https://github.com/acme/widgets/pull/1#pullrequestreview-1"
        );
        expect(result?.verdict).toBe("approve");
      });

      it("outcome 'failed' with attempts <= 2 goes back to 'queued' with a ~5 minute backoff and clears skip_reason", async () => {
        const id = await insertReviewJob(wsId, { state: "running", attempts: 0 });
        const before = Date.now();

        const result = await completeReviewJob({
          jobId: id,
          outcome: "failed",
          error: "transient GitHub 502",
        });

        expect(result?.state).toBe("queued");
        expect(result?.attempts).toBe(1);
        expect(result?.skipReason).toBeNull();
        const deltaMs = result!.nextEligibleAt!.getTime() - before;
        expect(deltaMs).toBeGreaterThan(4.5 * 60 * 1000);
        expect(deltaMs).toBeLessThan(5.5 * 60 * 1000);
      });

      it("outcome 'failed' escalates to terminal 'failed' once attempts exceeds 2, recording the error in skip_reason", async () => {
        const id = await insertReviewJob(wsId, { state: "running", attempts: 2 });

        const result = await completeReviewJob({
          jobId: id,
          outcome: "failed",
          error: "third strike",
        });

        expect(result?.state).toBe("failed");
        expect(result?.attempts).toBe(3);
        expect(result?.skipReason).toBe("third strike");
        expect(result?.nextEligibleAt).toBeNull();
      });

      it("terminal 'failed' with no error supplied still records a non-null skip_reason (never silent)", async () => {
        const id = await insertReviewJob(wsId, { state: "running", attempts: 2 });

        const result = await completeReviewJob({ jobId: id, outcome: "failed" });

        expect(result?.state).toBe("failed");
        expect(result?.skipReason).toBeTruthy();
      });

      it("is guarded: a second complete on an already-resolved job no-ops (returns null; first result stands)", async () => {
        const id = await insertReviewJob(wsId, { state: "running" });

        const first = await completeReviewJob({
          jobId: id,
          outcome: "posted",
          postedReviewUrl: "url-1",
          verdict: "approve",
        });
        expect(first?.state).toBe("posted");

        const second = await completeReviewJob({
          jobId: id,
          outcome: "posted",
          postedReviewUrl: "url-2",
          verdict: "reject",
        });
        expect(second).toBeNull();

        const row = await readReviewJob(id);
        expect(row.postedReviewUrl).toBe("url-1");
        expect(row.verdict).toBe("approve");
      });

      it("is guarded against completing a job that was never running (e.g. already 'queued')", async () => {
        const id = await insertReviewJob(wsId, { state: "queued" });
        expect(
          await completeReviewJob({ jobId: id, outcome: "posted", postedReviewUrl: "x", verdict: "approve" })
        ).toBeNull();
      });
    });

    // -----------------------------------------------------------------
    // bindReviewJobSession — jace_sessions insert + re-bind on conflict
    // -----------------------------------------------------------------
    describe("bindReviewJobSession", () => {
      let wsId: string;
      beforeEach(async () => {
        wsId = await createWorkspace();
      });
      afterEach(async () => {
        await deleteWorkspace(wsId);
      });

      it("inserts the exact jace_sessions shape: workspaceId/channel/conversationKey/eveSessionId", async () => {
        const jobId = await insertReviewJob(wsId);

        await bindReviewJobSession({ jobId, eveSessionId: "sess-1" });

        const rows = await db
          .select()
          .from(jaceSessions)
          .where(eq(jaceSessions.conversationKey, `review-job:${jobId}`));
        expect(rows).toHaveLength(1);
        const row = rows[0]!;
        expect(row.workspaceId).toBe(wsId);
        expect(row.channel).toBe("review-job");
        expect(row.conversationKey).toBe(`review-job:${jobId}`);
        expect(row.eveSessionId).toBe("sess-1");
        expect(row.status).toBe("active");
      });

      it("re-binds on conflict: a second bind for the same job updates eve_session_id on the SAME row, not a second insert", async () => {
        const jobId = await insertReviewJob(wsId);

        await bindReviewJobSession({ jobId, eveSessionId: "sess-1" });
        await bindReviewJobSession({ jobId, eveSessionId: "sess-2" });

        const rows = await db
          .select()
          .from(jaceSessions)
          .where(eq(jaceSessions.conversationKey, `review-job:${jobId}`));
        expect(rows).toHaveLength(1);
        expect(rows[0]!.eveSessionId).toBe("sess-2");
      });
    });

    // -----------------------------------------------------------------
    // getWorkspaceByGithubInstallationId — real row, proves the
    // number -> text coercion at the query boundary
    // -----------------------------------------------------------------
    describe("getWorkspaceByGithubInstallationId", () => {
      it("finds the workspace whose text column matches String(installationId)", async () => {
        const installationId = Math.floor(Date.now() % 1_000_000_000) + 1000;
        const wsId = await createWorkspace({
          githubInstallationId: String(installationId),
        });
        try {
          expect(await getWorkspaceByGithubInstallationId(installationId)).toEqual({
            workspaceId: wsId,
          });
        } finally {
          await deleteWorkspace(wsId);
        }
      });

      it("returns null for an installation id no workspace has bound", async () => {
        const neverBound = Math.floor(Date.now() % 1_000_000_000) + 2_000_000_000;
        expect(await getWorkspaceByGithubInstallationId(neverBound)).toBeNull();
      });
    });
  }
);
