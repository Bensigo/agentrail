import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db } from "../db.js";
import { workspaces } from "../schema/workspaces.js";
import { connectors } from "../schema/connectors.js";
import {
  mintConnectorOauthState,
  consumeConnectorOauthState,
  upsertConnector,
  getConnector,
} from "../queries/connectors.js";

/**
 * OAuth Connect Wave 3, W3-T1 fix round — DB-LEVEL INTEGRATION TESTS
 * against a REAL Postgres (no mocks of `db`), mirroring
 * `queue-retry-backoff.integration.test.ts`'s own established pattern
 * (`.integration.test.ts` naming, a top-level connectivity probe with
 * `describe.skipIf`, real query functions, exact-id cleanup) — the house
 * convention this package uses whenever a claim can only be proven against
 * real Postgres concurrency/atomicity, not a mocked `db`.
 *
 * These are the automated evidence for two review findings
 * (`.superpowers/sdd/review-W3T1.md`) that were previously only manually
 * verified:
 *
 *   - CRITICAL-1 / atomicity: `consumeConnectorOauthState`'s single-use
 *     guarantee under GENUINE concurrent contention (two real client
 *     connections racing the identical state), not just the mocked
 *     call-shape assertions in `connectors.test.ts`.
 *   - IMPORTANT-1: a pending OAuth state now SURVIVES an unrelated
 *     `upsertConnector` write landing on the same row (the fix —
 *     `completeConfig` preserving the three ephemeral keys — is a
 *     multi-step storage round-trip a mocked unit test can't meaningfully
 *     prove; this is the real proof).
 *
 * Requires a reachable Postgres at `DATABASE_URL` (defaults to
 * `postgres://agentrail:agentrail@localhost:5432/agentrail`, matching
 * `db.ts`), migrated (the `connectors` table predates this task — no new
 * migration is needed for the jsonb config fields this task adds). CI's
 * `node` job provisions exactly this (see `.github/workflows/ci.yml`,
 * `queue-retry-backoff.integration.test.ts`'s own doc-comment). When no DB
 * is reachable, the whole suite SKIPS cleanly via the same connectivity
 * probe — every other test file in this package still runs unaffected.
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
  "OAuth state mint/consume — real Postgres integration (W3-T1 fix round)",
  () => {
    let workspaceId: string;

    beforeAll(async () => {
      const rows = await db
        .insert(workspaces)
        .values({
          name: "oauth-state-race test workspace",
          slug: `test-oauth-state-race-${randomUUID()}`,
        })
        .returning({ id: workspaces.id });
      workspaceId = rows[0]!.id;
    });

    afterAll(async () => {
      // Cascades to `connectors` (ON DELETE cascade off workspace_id).
      if (workspaceId) {
        await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
      }
    });

    async function deleteConnectorRow(provider: string) {
      await db
        .delete(connectors)
        .where(sql`${connectors.workspaceId} = ${workspaceId} AND ${connectors.provider} = ${provider}`);
    }

    // -------------------------------------------------------------------
    // Review item 5 — automate the reviewer's manual race verification.
    // -------------------------------------------------------------------
    it("N genuinely concurrent consumes of the SAME state resolve exactly once — the rest see null", async () => {
      const provider = "railway";
      await deleteConnectorRow(provider);
      const state = await mintConnectorOauthState(workspaceId, provider, "user-race");

      const CONCURRENCY = 6;
      const results = await Promise.all(
        Array.from({ length: CONCURRENCY }, () => consumeConnectorOauthState(provider, state))
      );

      const wins = results.filter((r) => r !== null);
      expect(wins).toHaveLength(1);
      expect(wins[0]).toEqual({ workspaceId, userId: "user-race" });

      // The state is genuinely gone afterward — a LATER, non-concurrent
      // attempt also sees null (not just "the other N-1 concurrent callers
      // happened to lose").
      expect(await consumeConnectorOauthState(provider, state)).toBeNull();

      await deleteConnectorRow(provider);
    });

    it("two DIFFERENT states (different mints) for the same (workspace, provider) never both resolve — re-minting invalidates the prior one", async () => {
      const provider = "sentry";
      await deleteConnectorRow(provider);
      const stateA = await mintConnectorOauthState(workspaceId, provider, "user-A");
      const stateB = await mintConnectorOauthState(workspaceId, provider, "user-B");
      expect(stateA).not.toBe(stateB);

      const [resultA, resultB] = await Promise.all([
        consumeConnectorOauthState(provider, stateA),
        consumeConnectorOauthState(provider, stateB),
      ]);

      // stateA was overwritten by the second mint — only stateB (the LIVE
      // one) can possibly resolve.
      expect(resultA).toBeNull();
      expect(resultB).toEqual({ workspaceId, userId: "user-B" });

      await deleteConnectorRow(provider);
    });

    // -------------------------------------------------------------------
    // Review item 2 (IMPORTANT-1) — an unrelated config write during a
    // pending state must not silently wipe it.
    // -------------------------------------------------------------------
    it("an unrelated upsertConnector write during a pending state does not clobber it — consume still resolves afterward", async () => {
      const provider = "figma";
      await deleteConnectorRow(provider);
      const state = await mintConnectorOauthState(workspaceId, provider, "user-clobber-check");

      // Simulates the realistic repro from the review: while a Railway
      // consent tab is open, something else (a teammate, or the same
      // sheet's own "use an API token instead" disclosure) hits the
      // connectors config PUT path for the SAME (workspace, provider) row,
      // touching a completely unrelated field.
      await upsertConnector(workspaceId, provider, { config: { triggerLabel: "changed-mid-flow" } });

      // The unrelated field DID change...
      const afterUnrelatedWrite = await getConnector(workspaceId, provider);
      expect(afterUnrelatedWrite?.config.triggerLabel).toBe("changed-mid-flow");
      // ...but the pending state SURVIVED it — consume still resolves.
      expect(await consumeConnectorOauthState(provider, state)).toEqual({
        workspaceId,
        userId: "user-clobber-check",
      });

      await deleteConnectorRow(provider);
    });

    it("the read model never surfaces oauthState/oauthStateExpiresAt/oauthUserId even though storage now preserves them (toClientSafeConfig)", async () => {
      const provider = "datadog";
      await deleteConnectorRow(provider);
      await mintConnectorOauthState(workspaceId, provider, "user-leak-check");

      const view = await getConnector(workspaceId, provider);
      expect(view).not.toBeNull();
      expect(view!.config).not.toHaveProperty("oauthState");
      expect(view!.config).not.toHaveProperty("oauthStateExpiresAt");
      expect(view!.config).not.toHaveProperty("oauthUserId");

      // Also true through upsertConnector's OWN returned view (a second,
      // independent code path that also merges + returns config).
      const upserted = await upsertConnector(workspaceId, provider, { config: { triggerLabel: "x" } });
      expect(upserted.config).not.toHaveProperty("oauthState");
      expect(upserted.config).not.toHaveProperty("oauthStateExpiresAt");
      expect(upserted.config).not.toHaveProperty("oauthUserId");

      await deleteConnectorRow(provider);
    });
  }
);
