import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db } from "../db.js";
import { workspaces } from "../schema/workspaces.js";
import { queueEntries } from "../schema/queue_entries.js";
import {
  claimQueueEntry,
  recordRunnerResult,
  isClaimEligible,
} from "../queries/runner.js";
import { requeueParkedQueueEntry } from "../queries/github_intake.js";
import { listQueueAttempts } from "../queries/queue_attempts.js";

/**
 * #1389 — DB-LEVEL INTEGRATION TESTS against a REAL Postgres (no mocks of
 * `db`, unlike every other spec in this package). These are the actual
 * evidence for:
 *   - AC1: an entry that fails repeatedly shows strictly increasing gaps
 *     between successive claim timestamps.
 *   - AC2: an entry inside its backoff window is not claimable, but a human
 *     Requeue makes it claimable immediately.
 *   - AC4: the SQL claim path (`claimQueueEntry`) and the TS eligibility
 *     predicate (`isClaimEligible`) produce IDENTICAL claim/skip decisions
 *     across a fixture matrix — the #910 lockstep rule, proven against real
 *     behavior rather than asserted by convention.
 *
 * Requires a reachable Postgres at `DATABASE_URL` (defaults to
 * `postgres://agentrail:agentrail@localhost:5432/agentrail`, matching
 * `db.ts`), migrated at least through `0052_queue_retry_backoff`. CI's
 * `node` job provisions exactly this (see `.github/workflows/ci.yml`). When
 * no DB is reachable (e.g. a sandboxed environment with no Postgres at all),
 * the whole suite SKIPS cleanly via a top-level connectivity probe rather
 * than failing on a connection error — every other test file in this
 * package still runs unaffected.
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
  "queue retry backoff — real Postgres integration (#1389)",
  () => {
    let workspaceId: string;

    beforeAll(async () => {
      const rows = await db
        .insert(workspaces)
        .values({
          name: "queue-retry-backoff test workspace",
          slug: `test-1389-${randomUUID()}`,
        })
        .returning({ id: workspaces.id });
      workspaceId = rows[0]!.id;
    });

    afterAll(async () => {
      // Cascades to queue_entries -> queue_attempts (both ON DELETE CASCADE
      // off workspace_id / queue_entry_id respectively).
      if (workspaceId) {
        await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
      }
    });

    async function insertEntry(overrides: {
      state?: string;
      remainingBudget?: number;
      tier?: number;
      nextEligibleAt?: Date | null;
    } = {}): Promise<string> {
      const rows = await db
        .insert(queueEntries)
        .values({
          workspaceId,
          source: "github",
          externalId: `owner/repo#${Math.floor(Math.random() * 1_000_000)}`,
          title: "Test entry",
          body: "",
          tier: overrides.tier ?? 0,
          remainingBudget: overrides.remainingBudget ?? 5,
          state: overrides.state ?? "queued",
          nextEligibleAt: overrides.nextEligibleAt ?? null,
        })
        .returning({ id: queueEntries.id });
      return rows[0]!.id;
    }

    async function readEntry(id: string) {
      const rows = await db
        .select()
        .from(queueEntries)
        .where(eq(queueEntries.id, id));
      return rows[0]!;
    }

    async function deleteEntry(id: string) {
      await db.delete(queueEntries).where(eq(queueEntries.id, id));
    }

    // -------------------------------------------------------------------
    // AC1 — strictly increasing gaps across successive failed attempts.
    // -------------------------------------------------------------------
    it("AC1: repeated red results attach a strictly increasing backoff delay, observable in the attempt log", async () => {
      const id = await insertEntry({ remainingBudget: 5, tier: 0 });

      const delaysMs: number[] = [];
      // Budget 5 -> four requeues (budget 4,3,2,1) then escalation on the 5th.
      for (let i = 0; i < 4; i++) {
        const result = await recordRunnerResult({
          id,
          workspaceId,
          status: "red",
        });
        expect(result.updated).toBe(true);
        expect(result.terminalState).toBeNull(); // still requeuing

        const row = await readEntry(id);
        expect(row.state).toBe("queued");
        expect(row.nextEligibleAt).not.toBeNull();
        const delay =
          row.nextEligibleAt!.getTime() - row.updatedAt.getTime();
        expect(delay).toBeGreaterThan(0);
        delaysMs.push(delay);
      }

      // Strictly increasing — the AC1 requirement itself.
      for (let i = 1; i < delaysMs.length; i++) {
        expect(delaysMs[i]).toBeGreaterThan(delaysMs[i - 1]!);
      }

      // The 5th red exhausts the budget -> terminal escalation, no delay.
      const finalResult = await recordRunnerResult({ id, workspaceId, status: "red" });
      expect(finalResult.terminalState).toBe("escalated-to-human");
      const finalRow = await readEntry(id);
      expect(finalRow.state).toBe("escalated-to-human");
      expect(finalRow.nextEligibleAt).toBeNull();

      // The attempt log has exactly 5 rows (4 requeues + the final
      // escalation), all outcome='red', oldest first, tier growing with
      // each red (tier bumps on every red per nextQueueTransition).
      const attempts = await listQueueAttempts(workspaceId, id);
      expect(attempts).toHaveLength(5);
      for (const a of attempts) {
        expect(a.outcome).toBe("red");
      }
      const tiers = attempts.map((a) => a.tier);
      expect(tiers).toEqual([0, 1, 2, 2, 2]); // MAX_TIER caps at 2

      await deleteEntry(id);
    });

    // -------------------------------------------------------------------
    // AC2 — not claimable inside the backoff window; a human Requeue clears
    // it immediately.
    // -------------------------------------------------------------------
    it("AC2: an entry inside its backoff window is skipped by a claim sweep, but a human Requeue makes it claimable immediately", async () => {
      const delayedId = await insertEntry({
        nextEligibleAt: new Date(Date.now() + 5 * 60 * 1000), // 5 min out
      });

      // A claim sweep finds nothing — the only queued row is inside its
      // backoff window.
      const claimAttempt1 = await claimQueueEntry(workspaceId);
      expect(claimAttempt1).toBeNull();
      const stillQueued = await readEntry(delayedId);
      expect(stillQueued.state).toBe("queued"); // untouched by the sweep

      // Human Requeue clears the delay immediately.
      const requeueResult = await requeueParkedQueueEntry(workspaceId, delayedId);
      expect(requeueResult).toBe("requeued");
      const cleared = await readEntry(delayedId);
      expect(cleared.nextEligibleAt).toBeNull();
      expect(cleared.state).toBe("queued"); // still queued — Requeue only clears the delay

      // Now it claims immediately.
      const claimAttempt2 = await claimQueueEntry(workspaceId);
      expect(claimAttempt2).not.toBeNull();
      expect(claimAttempt2!.id).toBe(delayedId);

      await deleteEntry(delayedId);
    });

    // -------------------------------------------------------------------
    // AC4 — the SQL claim path and the TS eligibility predicate agree,
    // proven against real claim behavior for every fixture in the matrix.
    // -------------------------------------------------------------------
    const FIXTURES: Array<{
      label: string;
      state: string;
      nextEligibleAt: Date | null;
    }> = [
      { label: "queued, no delay", state: "queued", nextEligibleAt: null },
      {
        label: "queued, future delay",
        state: "queued",
        nextEligibleAt: new Date(Date.now() + 10 * 60 * 1000),
      },
      {
        label: "queued, delay already elapsed",
        state: "queued",
        nextEligibleAt: new Date(Date.now() - 10 * 60 * 1000),
      },
      {
        label: "queued, delay elapsed a moment ago",
        state: "queued",
        nextEligibleAt: new Date(Date.now() - 50),
      },
      { label: "running (never claimable)", state: "running", nextEligibleAt: null },
      { label: "parked (never claimable)", state: "parked", nextEligibleAt: null },
      {
        label: "escalated-to-human (never claimable)",
        state: "escalated-to-human",
        nextEligibleAt: null,
      },
    ];

    it.each(FIXTURES)(
      "AC4: claimQueueEntry and isClaimEligible agree — $label",
      async ({ state, nextEligibleAt }) => {
        const id = await insertEntry({ state, nextEligibleAt });
        const predicted = isClaimEligible({ state, nextEligibleAt });

        const claimed = await claimQueueEntry(workspaceId);

        if (predicted) {
          expect(claimed).not.toBeNull();
          expect(claimed!.id).toBe(id);
        } else {
          expect(claimed).toBeNull();
        }

        await deleteEntry(id);
      }
    );
  }
);
