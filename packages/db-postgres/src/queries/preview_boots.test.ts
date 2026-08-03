import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db } from "../db.js";
import { workspaces } from "../schema/workspaces.js";
import { previewBoots } from "../schema/preview_boots.js";
import {
  previewBootId,
  enqueuePreviewBoot,
  claimPreviewBoot,
  reportPreviewBoot,
  setPreviewBootLogKey,
  getPreviewBoot,
  expireStalePreviewBoots,
} from "./preview_boots.js";

/**
 * B2b Task 2 — the `preview_boots` query layer (plan
 * docs/superpowers/plans/2026-08-02-b2b-sandbox-boot.md Task 2; spec
 * docs/superpowers/specs/2026-08-02-b2-behavioral-evidence-design.md §B2b).
 * Modeled directly on `review_jobs.ts`'s own test coverage
 * (`__tests__/review-jobs.integration.test.ts`): every function here is
 * proven against a REAL Postgres (no mocked `db`) because the correctness
 * lives in the SQL itself (the advisory-lock supersede, the SKIP LOCKED
 * claim, the guarded per-status report transitions) — a mock that returns
 * canned rows regardless of the WHERE clause cannot tell a correct claim/
 * report query from a broken one.
 *
 * `previewBootId`'s pure determinism is exercised inline below too (not
 * split into a separate mocked-db file) since Task 2's brief asks for one
 * test file covering every function.
 *
 * Requires a reachable Postgres at DATABASE_URL, migrated through
 * `0068_preview_boots`. Skips cleanly (not a failure) when no DB is
 * reachable — mirrors every other *.integration-style suite in this
 * package.
 */
const DB_AVAILABLE: boolean = await (async () => {
  try {
    await db.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
})();

describe("previewBootId (pure, deterministic uuid5)", () => {
  const BASE = {
    workspaceId: "ws-1",
    repo: "acme/widgets",
    prNumber: 42,
    headSha: "a".repeat(40),
  };

  it("is stable: the same (workspaceId, repo, prNumber, headSha) always maps to the same id", () => {
    expect(previewBootId(BASE)).toBe(previewBootId({ ...BASE }));
  });

  it("is a valid RFC 4122 v5 uuid (version nibble '5', variant nibble in 8-b)", () => {
    const id = previewBootId(BASE);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it("changes when workspaceId differs, all else equal", () => {
    expect(previewBootId(BASE)).not.toBe(
      previewBootId({ ...BASE, workspaceId: "ws-2" })
    );
  });

  it("changes when repo differs, all else equal", () => {
    expect(previewBootId(BASE)).not.toBe(
      previewBootId({ ...BASE, repo: "acme/other" })
    );
  });

  it("changes when prNumber differs, all else equal", () => {
    expect(previewBootId(BASE)).not.toBe(
      previewBootId({ ...BASE, prNumber: 43 })
    );
  });

  it("changes when headSha differs, all else equal — this is what makes each push its own row", () => {
    expect(previewBootId(BASE)).not.toBe(
      previewBootId({ ...BASE, headSha: "b".repeat(40) })
    );
  });
});

describe.skipIf(!DB_AVAILABLE)(
  "preview_boots queries — real Postgres integration (B2b Task 2)",
  () => {
    async function createWorkspace(): Promise<string> {
      const rows = await db
        .insert(workspaces)
        .values({
          name: "preview-boots test workspace",
          slug: `test-preview-boots-${randomUUID()}`,
        })
        .returning({ id: workspaces.id });
      return rows[0]!.id;
    }

    async function deleteWorkspace(id: string): Promise<void> {
      // Cascades to preview_boots (workspace_id ON DELETE CASCADE).
      await db.delete(workspaces).where(eq(workspaces.id, id));
    }

    async function insertPreviewBoot(
      workspaceId: string,
      overrides: Partial<{
        repo: string;
        prNumber: number;
        headSha: string;
        ref: string;
        status: string;
        workerId: string | null;
        claimedAt: Date | null;
        url: string | null;
        port: number | null;
        bootLogKey: string | null;
        reason: string | null;
        attempts: number;
        expiresAt: Date | null;
        lastLivenessAt: Date | null;
        nextEligibleAt: Date | null;
        createdAt: Date;
      }> = {}
    ): Promise<string> {
      const repo = overrides.repo ?? "acme/widgets";
      const prNumber = overrides.prNumber ?? 1;
      const headSha = overrides.headSha ?? randomUUID().replace(/-/g, "");
      const id = previewBootId({ workspaceId, repo, prNumber, headSha });
      await db.insert(previewBoots).values({
        id,
        workspaceId,
        repo,
        prNumber,
        headSha,
        ref: overrides.ref ?? headSha,
        status: overrides.status ?? "pending",
        workerId: overrides.workerId ?? null,
        claimedAt: overrides.claimedAt ?? null,
        url: overrides.url ?? null,
        port: overrides.port ?? null,
        bootLogKey: overrides.bootLogKey ?? null,
        reason: overrides.reason ?? null,
        attempts: overrides.attempts ?? 0,
        expiresAt: overrides.expiresAt ?? null,
        lastLivenessAt: overrides.lastLivenessAt ?? null,
        nextEligibleAt: overrides.nextEligibleAt ?? null,
        ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
      });
      return id;
    }

    async function readPreviewBoot(id: string) {
      const rows = await db
        .select()
        .from(previewBoots)
        .where(eq(previewBoots.id, id));
      return rows[0]!;
    }

    // -----------------------------------------------------------------
    // enqueuePreviewBoot — dedupe + advisory-lock-guarded supersede
    // -----------------------------------------------------------------
    describe("enqueuePreviewBoot", () => {
      let wsId: string;
      beforeEach(async () => {
        wsId = await createWorkspace();
      });
      afterEach(async () => {
        await deleteWorkspace(wsId);
      });

      it("deterministic id: the same input dedupes (ON CONFLICT DO NOTHING), never creates a second row", async () => {
        const input = {
          workspaceId: wsId,
          repo: "acme/widgets",
          prNumber: 1,
          headSha: "sha-a",
          ref: "sha-a",
        };
        const first = await enqueuePreviewBoot(input);
        expect(first.deduped).toBe(false);
        expect(first.id).toBe(previewBootId(input));
        expect(first.superseded).toBe(0);

        const second = await enqueuePreviewBoot(input);
        expect(second.id).toBe(first.id);
        expect(second.deduped).toBe(true);
        expect(second.superseded).toBe(0);

        const rows = await db
          .select()
          .from(previewBoots)
          .where(eq(previewBoots.id, first.id));
        expect(rows).toHaveLength(1);
      });

      it("a new row starts 'pending' with the given ref, and next_eligible_at unset (eligible immediately)", async () => {
        const id = (
          await enqueuePreviewBoot({
            workspaceId: wsId,
            repo: "acme/widgets",
            prNumber: 2,
            headSha: "sha-b",
            ref: "refs/pull/2/head",
          })
        ).id;
        const row = await readPreviewBoot(id);
        expect(row.status).toBe("pending");
        expect(row.ref).toBe("refs/pull/2/head");
        expect(row.nextEligibleAt).toBeNull();
      });

      it("supersedes an older still-in-flight head for the same (workspace, repo, pr): torn_down/reason=superseded, superseded:1", async () => {
        const older = await enqueuePreviewBoot({
          workspaceId: wsId,
          repo: "acme/widgets",
          prNumber: 3,
          headSha: "sha-1",
          ref: "sha-1",
        });

        const newer = await enqueuePreviewBoot({
          workspaceId: wsId,
          repo: "acme/widgets",
          prNumber: 3,
          headSha: "sha-2",
          ref: "sha-2",
        });

        expect(newer.superseded).toBe(1);
        const olderRow = await readPreviewBoot(older.id);
        expect(olderRow.status).toBe("torn_down");
        expect(olderRow.reason).toBe("superseded");

        const newerRow = await readPreviewBoot(newer.id);
        expect(newerRow.status).toBe("pending");
      });

      it("supersedes a claimed/booting/ready older head too — supersede is not limited to 'pending'", async () => {
        const older = await enqueuePreviewBoot({
          workspaceId: wsId,
          repo: "acme/widgets",
          prNumber: 30,
          headSha: "sha-ready",
          ref: "sha-ready",
        });
        await db
          .update(previewBoots)
          .set({ status: "ready" })
          .where(eq(previewBoots.id, older.id));

        const newer = await enqueuePreviewBoot({
          workspaceId: wsId,
          repo: "acme/widgets",
          prNumber: 30,
          headSha: "sha-newer",
          ref: "sha-newer",
        });

        expect(newer.superseded).toBe(1);
        expect((await readPreviewBoot(older.id)).status).toBe("torn_down");
      });

      it("does NOT re-supersede an already-terminal sibling (failed/torn_down are excluded from the supersede WHERE)", async () => {
        const deadSibling = await enqueuePreviewBoot({
          workspaceId: wsId,
          repo: "acme/widgets",
          prNumber: 31,
          headSha: "sha-dead",
          ref: "sha-dead",
        });
        await db
          .update(previewBoots)
          .set({ status: "failed", reason: "boot error" })
          .where(eq(previewBoots.id, deadSibling.id));

        const newer = await enqueuePreviewBoot({
          workspaceId: wsId,
          repo: "acme/widgets",
          prNumber: 31,
          headSha: "sha-newer-2",
          ref: "sha-newer-2",
        });

        // The already-failed sibling is untouched — its own reason survives,
        // it is not counted or relabeled 'superseded'.
        expect(newer.superseded).toBe(0);
        const deadRow = await readPreviewBoot(deadSibling.id);
        expect(deadRow.status).toBe("failed");
        expect(deadRow.reason).toBe("boot error");
      });

      it("never supersedes a DIFFERENT PR or a DIFFERENT repo's in-flight boot", async () => {
        const otherPr = await enqueuePreviewBoot({
          workspaceId: wsId,
          repo: "acme/widgets",
          prNumber: 40,
          headSha: "sha-other-pr",
          ref: "sha-other-pr",
        });
        const otherRepo = await enqueuePreviewBoot({
          workspaceId: wsId,
          repo: "acme/other-repo",
          prNumber: 4,
          headSha: "sha-other-repo",
          ref: "sha-other-repo",
        });

        const result = await enqueuePreviewBoot({
          workspaceId: wsId,
          repo: "acme/widgets",
          prNumber: 4,
          headSha: "sha-4",
          ref: "sha-4",
        });
        expect(result.superseded).toBe(0);

        expect((await readPreviewBoot(otherPr.id)).status).toBe("pending");
        expect((await readPreviewBoot(otherRepo.id)).status).toBe("pending");
      });

      it("a redelivered/duplicate request for an already-superseded head is deduped and supersedes nothing (never resurrects or re-flips the survivor)", async () => {
        const prNumber = 50;
        const a = await enqueuePreviewBoot({
          workspaceId: wsId,
          repo: "acme/widgets",
          prNumber,
          headSha: "dead-head-a",
          ref: "dead-head-a",
        });
        const b = await enqueuePreviewBoot({
          workspaceId: wsId,
          repo: "acme/widgets",
          prNumber,
          headSha: "live-head-b",
          ref: "live-head-b",
        });
        expect(b.superseded).toBe(1);
        expect((await readPreviewBoot(a.id)).status).toBe("torn_down");
        expect((await readPreviewBoot(b.id)).status).toBe("pending");

        // A duplicate/redelivered request for the now-dead head A.
        const redelivered = await enqueuePreviewBoot({
          workspaceId: wsId,
          repo: "acme/widgets",
          prNumber,
          headSha: "dead-head-a",
          ref: "dead-head-a",
        });

        expect(redelivered).toEqual({ id: a.id, deduped: true, superseded: 0 });
        expect((await readPreviewBoot(b.id)).status).toBe("pending"); // untouched
        expect((await readPreviewBoot(a.id)).status).toBe("torn_down"); // still dead
      });

      // Fix round 1 (task-2 review, Important #2): looped 5x with a fresh PR
      // number per iteration to give the race a real chance to land —
      // Promise.all starts both calls in the same tick, but a single
      // unlucky iteration proves nothing either way. Mirrors
      // review-jobs.integration.test.ts's own analogous test ("concurrent
      // enqueues for the SAME PR never mutually-supersede") byte-for-byte in
      // structure and intent — this is the single test most directly
      // guarding against the historical mutual-supersede bug the advisory
      // lock exists to prevent.
      it("concurrent enqueues for the SAME PR never mutually-supersede — exactly one survivor every time", async () => {
        for (let i = 0; i < 5; i++) {
          const prNumber = 900 + i;
          const [a, b] = await Promise.all([
            enqueuePreviewBoot({
              workspaceId: wsId,
              repo: "acme/widgets",
              prNumber,
              headSha: `race-a-${i}`,
              ref: `race-a-${i}`,
            }),
            enqueuePreviewBoot({
              workspaceId: wsId,
              repo: "acme/widgets",
              prNumber,
              headSha: `race-b-${i}`,
              ref: `race-b-${i}`,
            }),
          ]);

          const rowA = await readPreviewBoot(a.id);
          const rowB = await readPreviewBoot(b.id);
          const statuses = [rowA.status, rowB.status].sort();
          // Exactly one survivor — either order is fine, but NEVER both
          // 'torn_down' (the mutual-supersede bug) and NEVER both 'pending'
          // (would mean the supersede silently failed to run at all).
          expect(statuses).toEqual(["pending", "torn_down"]);
        }
      });
    });

    // -----------------------------------------------------------------
    // claimPreviewBoot — SKIP LOCKED, oldest-first, TTL expiry seed
    // -----------------------------------------------------------------
    describe("claimPreviewBoot", () => {
      let wsId: string;
      beforeEach(async () => {
        wsId = await createWorkspace();
      });
      afterEach(async () => {
        await deleteWorkspace(wsId);
      });

      it("returns null when nothing is pending", async () => {
        expect(
          await claimPreviewBoot({ workerId: "w1", ttlSeconds: 600 })
        ).toBeNull();
      });

      it("claims a pending row: sets status=claimed, worker_id, claimed_at, expires_at (~ttlSeconds out), last_liveness_at", async () => {
        const id = await insertPreviewBoot(wsId);
        const before = Date.now();

        const claimed = await claimPreviewBoot({
          workerId: "w1",
          ttlSeconds: 600,
        });

        expect(claimed?.id).toBe(id);
        expect(claimed?.status).toBe("claimed");
        expect(claimed?.workerId).toBe("w1");
        expect(claimed?.claimedAt).not.toBeNull();
        expect(claimed?.lastLivenessAt).not.toBeNull();
        expect(claimed?.expiresAt).not.toBeNull();
        // Fix round 1 (task-2 review, Minor #1): explicit type check so a
        // regression to a raw wire string (unmapped timestamptz) fails here
        // with a clear message, not an incidental TypeError from .getTime().
        expect(claimed?.expiresAt).toBeInstanceOf(Date);
        const deltaMs = claimed!.expiresAt!.getTime() - before;
        expect(deltaMs).toBeGreaterThan(595_000);
        expect(deltaMs).toBeLessThan(605_000);
      });

      it("skips a pending row whose next_eligible_at is still in the future", async () => {
        await insertPreviewBoot(wsId, {
          nextEligibleAt: new Date(Date.now() + 10 * 60 * 1000),
        });
        expect(
          await claimPreviewBoot({ workerId: "w1", ttlSeconds: 600 })
        ).toBeNull();
      });

      it("claims a pending row whose next_eligible_at has already elapsed", async () => {
        const id = await insertPreviewBoot(wsId, {
          nextEligibleAt: new Date(Date.now() - 1000),
        });
        const claimed = await claimPreviewBoot({
          workerId: "w1",
          ttlSeconds: 600,
        });
        expect(claimed?.id).toBe(id);
      });

      it("claims the oldest pending row first, leaving a newer one pending", async () => {
        const older = await insertPreviewBoot(wsId, {
          prNumber: 1,
          createdAt: new Date(Date.now() - 10_000),
        });
        const newer = await insertPreviewBoot(wsId, {
          prNumber: 2,
          createdAt: new Date(),
        });

        const claimed = await claimPreviewBoot({
          workerId: "w1",
          ttlSeconds: 600,
        });
        expect(claimed?.id).toBe(older);

        const newerRow = await readPreviewBoot(newer);
        expect(newerRow.status).toBe("pending");
      });

      it("two concurrent claims on the SAME single pending row produce exactly one winner (SKIP LOCKED)", async () => {
        const id = await insertPreviewBoot(wsId);

        const [a, b] = await Promise.all([
          claimPreviewBoot({ workerId: "w1", ttlSeconds: 600 }),
          claimPreviewBoot({ workerId: "w2", ttlSeconds: 600 }),
        ]);

        const winners = [a, b].filter((r) => r !== null);
        expect(winners).toHaveLength(1);
        expect(winners[0]!.id).toBe(id);

        const row = await readPreviewBoot(id);
        expect(row.status).toBe("claimed");
        expect(["w1", "w2"]).toContain(row.workerId);
      });

      it("never claims a non-pending row (claimed/booting/ready/failed/torn_down are all ineligible)", async () => {
        await insertPreviewBoot(wsId, { status: "claimed", workerId: "someone" });
        expect(
          await claimPreviewBoot({ workerId: "w1", ttlSeconds: 600 })
        ).toBeNull();
      });
    });

    // -----------------------------------------------------------------
    // reportPreviewBoot — guarded per-target-status transitions
    // -----------------------------------------------------------------
    describe("reportPreviewBoot", () => {
      let wsId: string;
      beforeEach(async () => {
        wsId = await createWorkspace();
      });
      afterEach(async () => {
        await deleteWorkspace(wsId);
      });

      it("'booting' is allowed from 'claimed' and bumps last_liveness_at", async () => {
        const id = await insertPreviewBoot(wsId, {
          status: "claimed",
          workerId: "w1",
          lastLivenessAt: new Date(Date.now() - 60_000),
        });

        const result = await reportPreviewBoot({
          id,
          workerId: "w1",
          status: "booting",
        });

        expect(result?.status).toBe("booting");
        expect(result?.lastLivenessAt).toBeInstanceOf(Date);
        expect(result!.lastLivenessAt!.getTime()).toBeGreaterThan(
          Date.now() - 5000
        );
      });

      it("'booting' is idempotent from 'booting' (re-report while still booting)", async () => {
        const id = await insertPreviewBoot(wsId, {
          status: "booting",
          workerId: "w1",
        });

        const result = await reportPreviewBoot({
          id,
          workerId: "w1",
          status: "booting",
        });
        expect(result?.status).toBe("booting");
      });

      it("'booting' is REJECTED from 'ready' (no going backwards) — null no-op", async () => {
        const id = await insertPreviewBoot(wsId, {
          status: "ready",
          workerId: "w1",
          url: "http://127.0.0.1:9",
          port: 9,
        });

        const result = await reportPreviewBoot({
          id,
          workerId: "w1",
          status: "booting",
        });
        expect(result).toBeNull();
        expect((await readPreviewBoot(id)).status).toBe("ready");
      });

      it("'ready' is allowed from 'booting' and writes url+port on the first ready", async () => {
        const id = await insertPreviewBoot(wsId, {
          status: "booting",
          workerId: "w1",
        });

        const result = await reportPreviewBoot({
          id,
          workerId: "w1",
          status: "ready",
          url: "http://127.0.0.1:41234",
          port: 41234,
        });

        expect(result?.status).toBe("ready");
        expect(result?.url).toBe("http://127.0.0.1:41234");
        expect(result?.port).toBe(41234);
      });

      it("'ready' is allowed from 'claimed' directly (a boot that reports ready without an intermediate booting report)", async () => {
        const id = await insertPreviewBoot(wsId, {
          status: "claimed",
          workerId: "w1",
        });

        const result = await reportPreviewBoot({
          id,
          workerId: "w1",
          status: "ready",
          url: "http://127.0.0.1:1",
          port: 1,
        });
        expect(result?.status).toBe("ready");
      });

      it("'ready' -> 'ready' is the idempotent liveness re-report: bumps last_liveness_at, preserves url/port when omitted, no bogus transition", async () => {
        const id = await insertPreviewBoot(wsId, {
          status: "ready",
          workerId: "w1",
          url: "http://127.0.0.1:5000",
          port: 5000,
          lastLivenessAt: new Date(Date.now() - 30_000),
        });

        const result = await reportPreviewBoot({ id, workerId: "w1", status: "ready" });

        expect(result?.status).toBe("ready");
        expect(result?.url).toBe("http://127.0.0.1:5000");
        expect(result?.port).toBe(5000);
        expect(result?.lastLivenessAt).toBeInstanceOf(Date);
        expect(result!.lastLivenessAt!.getTime()).toBeGreaterThan(
          Date.now() - 5000
        );
      });

      // Fix round 1 (task-2 review, Minor #2): pins the CURRENT, intentional
      // behavior — an explicit `null` is indistinguishable from an omitted
      // `undefined` (COALESCE treats both as "keep the existing value").
      // There is no way to clear an already-set url/port via this function.
      it("'ready' report with explicit null url/port preserves existing values — identical to omitting them", async () => {
        const id = await insertPreviewBoot(wsId, {
          status: "ready",
          workerId: "w1",
          url: "http://127.0.0.1:6000",
          port: 6000,
        });

        const result = await reportPreviewBoot({
          id,
          workerId: "w1",
          status: "ready",
          url: null,
          port: null,
        });

        expect(result?.status).toBe("ready");
        expect(result?.url).toBe("http://127.0.0.1:6000");
        expect(result?.port).toBe(6000);
      });

      it("'ready' is REJECTED from 'pending' (never claimed) — null no-op", async () => {
        const id = await insertPreviewBoot(wsId, { status: "pending" });

        const result = await reportPreviewBoot({
          id,
          workerId: "w1",
          status: "ready",
        });
        expect(result).toBeNull();
        expect((await readPreviewBoot(id)).status).toBe("pending");
      });

      it("a foreign workerId (not the row's claimant) is a null no-op — never transitions someone else's boot", async () => {
        const id = await insertPreviewBoot(wsId, {
          status: "claimed",
          workerId: "w1",
        });

        const result = await reportPreviewBoot({
          id,
          workerId: "w2",
          status: "booting",
        });

        expect(result).toBeNull();
        const row = await readPreviewBoot(id);
        expect(row.status).toBe("claimed");
        expect(row.workerId).toBe("w1");
      });

      it.each(["pending", "claimed", "booting", "ready"] as const)(
        "'failed' is allowed from any non-terminal status (%s)",
        async (fromStatus) => {
          const id = await insertPreviewBoot(wsId, {
            status: fromStatus,
            workerId: fromStatus === "pending" ? null : "w1",
          });
          // A 'pending' row has no worker_id yet, so nothing can report
          // against it via the worker_id-scoped guard — this is the
          // structurally-impossible case the guard's own WHERE (worker_id =
          // $workerId, and worker_id IS NULL while pending) excludes without
          // needing special-case code. Skip the assertion for that one case
          // and instead confirm it is (correctly) a no-op.
          const result = await reportPreviewBoot({
            id,
            workerId: "w1",
            status: "failed",
            reason: "boot error",
          });

          if (fromStatus === "pending") {
            expect(result).toBeNull();
            expect((await readPreviewBoot(id)).status).toBe("pending");
          } else {
            expect(result?.status).toBe("failed");
            expect(result?.reason).toBe("boot error");
          }
        }
      );

      it("'torn_down' is allowed from any non-terminal status and records the reason", async () => {
        const id = await insertPreviewBoot(wsId, {
          status: "ready",
          workerId: "w1",
        });

        const result = await reportPreviewBoot({
          id,
          workerId: "w1",
          status: "torn_down",
          reason: "ttl expired",
        });

        expect(result?.status).toBe("torn_down");
        expect(result?.reason).toBe("ttl expired");
      });

      it("'failed'/'torn_down' are REJECTED once already terminal — a second failure report no-ops, first reason stands", async () => {
        const id = await insertPreviewBoot(wsId, {
          status: "claimed",
          workerId: "w1",
        });
        const first = await reportPreviewBoot({
          id,
          workerId: "w1",
          status: "failed",
          reason: "first failure",
        });
        expect(first?.status).toBe("failed");

        const second = await reportPreviewBoot({
          id,
          workerId: "w1",
          status: "torn_down",
          reason: "second call",
        });
        expect(second).toBeNull();

        const row = await readPreviewBoot(id);
        expect(row.status).toBe("failed");
        expect(row.reason).toBe("first failure");
      });

      it("reporting against an unknown id is a null no-op (never throws)", async () => {
        const result = await reportPreviewBoot({
          id: randomUUID(),
          workerId: "w1",
          status: "failed",
          reason: "x",
        });
        expect(result).toBeNull();
      });
    });

    // -----------------------------------------------------------------
    // setPreviewBootLogKey — best-effort evidence attachment
    // -----------------------------------------------------------------
    describe("setPreviewBootLogKey", () => {
      let wsId: string;
      beforeEach(async () => {
        wsId = await createWorkspace();
      });
      afterEach(async () => {
        await deleteWorkspace(wsId);
      });

      it("attaches a boot log key for the owning worker without changing status", async () => {
        const id = await insertPreviewBoot(wsId, {
          status: "ready",
          workerId: "w1",
        });

        const result = await setPreviewBootLogKey({
          id,
          workerId: "w1",
          bootLogKey: "review-evidence/ws-1/acme__widgets/1/sha/boot.log",
        });

        expect(result?.id).toBe(id);
        expect(result?.status).toBe("ready");
        expect(result?.bootLogKey).toBe(
          "review-evidence/ws-1/acme__widgets/1/sha/boot.log"
        );
        expect((await readPreviewBoot(id)).bootLogKey).toBe(
          "review-evidence/ws-1/acme__widgets/1/sha/boot.log"
        );
      });

      it("returns null and leaves the row untouched for a foreign worker", async () => {
        const id = await insertPreviewBoot(wsId, {
          status: "ready",
          workerId: "owner-worker",
        });

        const result = await setPreviewBootLogKey({
          id,
          workerId: "foreign-worker",
          bootLogKey: "review-evidence/ws-1/acme__widgets/1/sha/boot.log",
        });

        expect(result).toBeNull();
        expect((await readPreviewBoot(id)).bootLogKey).toBeNull();
      });
    });

    // -----------------------------------------------------------------
    // getPreviewBoot — plain lookup by id
    // -----------------------------------------------------------------
    describe("getPreviewBoot", () => {
      let wsId: string;
      beforeEach(async () => {
        wsId = await createWorkspace();
      });
      afterEach(async () => {
        await deleteWorkspace(wsId);
      });

      it("returns the row when it exists", async () => {
        const id = await insertPreviewBoot(wsId, { status: "ready" });
        const row = await getPreviewBoot(id);
        expect(row?.id).toBe(id);
        expect(row?.status).toBe("ready");
        expect(row?.workspaceId).toBe(wsId);
      });

      it("returns null for an unknown id", async () => {
        expect(await getPreviewBoot(randomUUID())).toBeNull();
      });
    });

    // -----------------------------------------------------------------
    // expireStalePreviewBoots — stale-liveness sweep
    // -----------------------------------------------------------------
    describe("expireStalePreviewBoots", () => {
      let wsId: string;
      beforeEach(async () => {
        wsId = await createWorkspace();
      });
      afterEach(async () => {
        await deleteWorkspace(wsId);
      });

      it.each(["claimed", "booting", "ready"] as const)(
        "flips a '%s' row whose last_liveness_at is older than the stale threshold to 'failed'/'stale'",
        async (status) => {
          const id = await insertPreviewBoot(wsId, {
            status,
            workerId: "w1",
            lastLivenessAt: new Date(Date.now() - 200_000), // > 180s
          });

          await expireStalePreviewBoots();

          const row = await readPreviewBoot(id);
          expect(row.status).toBe("failed");
          expect(row.reason).toBe("stale");
        }
      );

      it("does NOT touch a row whose last_liveness_at is within the stale threshold", async () => {
        const id = await insertPreviewBoot(wsId, {
          status: "ready",
          workerId: "w1",
          lastLivenessAt: new Date(Date.now() - 10_000), // well under 180s
        });

        await expireStalePreviewBoots();

        const row = await readPreviewBoot(id);
        expect(row.status).toBe("ready");
      });

      it("does NOT touch a fresh 'pending' row (well within the pending-stale threshold)", async () => {
        const id = await insertPreviewBoot(wsId, {
          status: "pending",
          createdAt: new Date(Date.now() - 10_000), // 10s old, well under 600s
        });

        await expireStalePreviewBoots();

        const row = await readPreviewBoot(id);
        expect(row.status).toBe("pending");
      });

      // Fix round 1 (task-2 review, Important #1): a 'pending' row that no
      // worker ever claims previously had no automatic terminal state — it
      // would sit 'pending' forever. This pins the new age-based sweep.
      it("flips a 'pending' row older than the pending-stale threshold to 'failed'/'never_claimed' — nobody ever claimed it", async () => {
        const id = await insertPreviewBoot(wsId, {
          status: "pending",
          createdAt: new Date(Date.now() - 700_000), // > 600s
        });

        await expireStalePreviewBoots();

        const row = await readPreviewBoot(id);
        expect(row.status).toBe("failed");
        expect(row.reason).toBe("never_claimed");
      });

      it("does NOT touch an already-terminal row (failed/torn_down are excluded from the sweep's own WHERE)", async () => {
        const id = await insertPreviewBoot(wsId, {
          status: "torn_down",
          reason: "superseded",
          workerId: "w1",
          lastLivenessAt: new Date(Date.now() - 200_000),
        });

        await expireStalePreviewBoots();

        const row = await readPreviewBoot(id);
        expect(row.status).toBe("torn_down");
        expect(row.reason).toBe("superseded"); // not overwritten with 'stale'
      });

      it("is what claimPreviewBoot's own pre-pass runs — a stale 'claimed' row is failed before the claim's own SELECT runs", async () => {
        await insertPreviewBoot(wsId, {
          status: "claimed",
          workerId: "dead-worker",
          lastLivenessAt: new Date(Date.now() - 200_000),
        });
        const freshPending = await insertPreviewBoot(wsId, { prNumber: 2 });

        const claimed = await claimPreviewBoot({
          workerId: "w2",
          ttlSeconds: 600,
        });

        // The stale claim was swept to 'failed' (not reclaimed — preview
        // boots are single-attempt, no back-to-pending retry), so the only
        // claimable candidate is the fresh pending row.
        expect(claimed?.id).toBe(freshPending);
      });
    });
  }
);
