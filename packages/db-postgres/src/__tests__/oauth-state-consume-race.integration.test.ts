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
  clearPendingConnectorOauthStatesForUser,
  consumeConnectorOauthStateBySessionUser,
  SESSION_TRANSPORT_OAUTH_STATE_TTL_MS,
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
      expect(wins[0]).toEqual({ workspaceId, userId: "user-race", codeVerifier: null });

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
      expect(resultB).toEqual({ workspaceId, userId: "user-B", codeVerifier: null });

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
        codeVerifier: null,
      });

      await deleteConnectorRow(provider);
    });

    it("the read model never surfaces oauthState/oauthStateExpiresAt/oauthUserId/oauthPkceVerifier even though storage now preserves them (toClientSafeConfig)", async () => {
      const provider = "datadog";
      await deleteConnectorRow(provider);
      await mintConnectorOauthState(workspaceId, provider, "user-leak-check", "verifier-leak-check");

      const view = await getConnector(workspaceId, provider);
      expect(view).not.toBeNull();
      expect(view!.config).not.toHaveProperty("oauthState");
      expect(view!.config).not.toHaveProperty("oauthStateExpiresAt");
      expect(view!.config).not.toHaveProperty("oauthUserId");
      expect(view!.config).not.toHaveProperty("oauthPkceVerifier");

      // Also true through upsertConnector's OWN returned view (a second,
      // independent code path that also merges + returns config).
      const upserted = await upsertConnector(workspaceId, provider, { config: { triggerLabel: "x" } });
      expect(upserted.config).not.toHaveProperty("oauthState");
      expect(upserted.config).not.toHaveProperty("oauthStateExpiresAt");
      expect(upserted.config).not.toHaveProperty("oauthUserId");
      expect(upserted.config).not.toHaveProperty("oauthPkceVerifier");

      await deleteConnectorRow(provider);
    });

    // -------------------------------------------------------------------
    // W3-T2 fix round (PKCE upgrade) — the codeVerifier round-trip through
    // a REAL Postgres jsonb patch (mocked-unit coverage in
    // queries/connectors.test.ts proves the SQL shape; this proves the
    // actual round-trip value survives a real multi-line jsonb_build_object
    // + `||` merge + later `->>` read, the same "don't trust a mock alone
    // for a multi-step storage round-trip" doctrine this file's own
    // doc-comment states for IMPORTANT-1 above).
    // -------------------------------------------------------------------
    it("a PKCE codeVerifier minted alongside state round-trips through consume against real Postgres, and survives an unrelated upsertConnector write in between", async () => {
      const provider = "grafana";
      await deleteConnectorRow(provider);
      const state = await mintConnectorOauthState(workspaceId, provider, "user-pkce", "verifier-real-pg-roundtrip");

      await upsertConnector(workspaceId, provider, { config: { triggerLabel: "unrelated-write" } });

      expect(await consumeConnectorOauthState(provider, state)).toEqual({
        workspaceId,
        userId: "user-pkce",
        codeVerifier: "verifier-real-pg-roundtrip",
      });

      await deleteConnectorRow(provider);
    });

    it("re-minting for the same (workspace, provider) without a codeVerifier overwrites a PRIOR mint's stale verifier — the second, live state carries no leftover verifier", async () => {
      const provider = "vercel";
      await deleteConnectorRow(provider);
      await mintConnectorOauthState(workspaceId, provider, "user-a", "stale-verifier-should-not-survive");
      const secondState = await mintConnectorOauthState(workspaceId, provider, "user-b");

      expect(await consumeConnectorOauthState(provider, secondState)).toEqual({
        workspaceId,
        userId: "user-b",
        codeVerifier: null,
      });

      await deleteConnectorRow(provider);
    });

    // -------------------------------------------------------------------
    // OAuth Connect Wave 3, W3-T3 fix round (coordinator ruling) —
    // SESSION-TRANSPORT tenant binding: the same single-use/race guarantees
    // as `consumeConnectorOauthState` above, but resolved by (provider,
    // userId) instead of an opaque `state` token — proven against a REAL
    // Postgres, not just the mocked SQL-shape coverage in
    // `connectors-session-transport.test.ts`. Uses a SECOND workspace
    // (`workspaceId2`) alongside the describe block's own `workspaceId` so
    // the "same-user, two-workspace ambiguity" scenario has two genuinely
    // different rows to be ambiguous BETWEEN.
    // -------------------------------------------------------------------
    describe("session-transport (W3-T3 fix round) — consumeConnectorOauthStateBySessionUser / clearPendingConnectorOauthStatesForUser", () => {
      let workspaceId2: string;

      beforeAll(async () => {
        const rows = await db
          .insert(workspaces)
          .values({
            name: "oauth-session-transport test workspace 2",
            slug: `test-oauth-session-transport-2-${randomUUID()}`,
          })
          .returning({ id: workspaces.id });
        workspaceId2 = rows[0]!.id;
      });

      afterAll(async () => {
        if (workspaceId2) {
          await db.delete(workspaces).where(eq(workspaces.id, workspaceId2));
        }
      });

      it("N genuinely concurrent session-transport consumes of the SAME single pending record resolve exactly once — the rest see null (mirrors the param-transport race above)", async () => {
        const provider = "sentry";
        await deleteConnectorRow(provider);
        await mintConnectorOauthState(workspaceId, provider, "user-session-race");

        const CONCURRENCY = 6;
        const results = await Promise.all(
          Array.from({ length: CONCURRENCY }, () =>
            consumeConnectorOauthStateBySessionUser(provider, "user-session-race")
          )
        );

        const wins = results.filter((r) => r !== null);
        expect(wins).toHaveLength(1);
        expect(wins[0]).toEqual({ workspaceId, userId: "user-session-race", codeVerifier: null });

        // Genuinely gone afterward — a later, non-concurrent attempt also
        // sees null.
        expect(await consumeConnectorOauthStateBySessionUser(provider, "user-session-race")).toBeNull();

        await deleteConnectorRow(provider);
      });

      it("zero pending records for this user resolves null, no throw", async () => {
        const provider = "sentry";
        await deleteConnectorRow(provider);
        expect(await consumeConnectorOauthStateBySessionUser(provider, "user-nothing-pending")).toBeNull();
      });

      it("same-user, two-workspace ambiguity: TWO pending records for the SAME (provider, userId) resolve null and consume NEITHER", async () => {
        const provider = "sentry";
        await deleteConnectorRow(provider);
        await db.delete(connectors).where(sql`${connectors.workspaceId} = ${workspaceId2} AND ${connectors.provider} = ${provider}`);

        await mintConnectorOauthState(workspaceId, provider, "user-ambiguous");
        await mintConnectorOauthState(workspaceId2, provider, "user-ambiguous");

        expect(await consumeConnectorOauthStateBySessionUser(provider, "user-ambiguous")).toBeNull();

        // Neither was consumed — BOTH still resolve via the param-transport
        // path if their real state token is known (proving the rows were
        // genuinely untouched, not just "the function returned null while
        // secretly picking one").
        const view1 = await getConnector(workspaceId, provider);
        const view2 = await getConnector(workspaceId2, provider);
        // toClientSafeConfig strips oauthState from the read model, but
        // hasSecret/enabled being unaffected plus a direct raw check below
        // confirms the row wasn't silently cleared.
        expect(view1).not.toBeNull();
        expect(view2).not.toBeNull();
        const raw1 = await db.select().from(connectors).where(sql`${connectors.workspaceId} = ${workspaceId} AND ${connectors.provider} = ${provider}`);
        const raw2 = await db.select().from(connectors).where(sql`${connectors.workspaceId} = ${workspaceId2} AND ${connectors.provider} = ${provider}`);
        expect((raw1[0]?.config as Record<string, unknown> | undefined)?.["oauthState"]).toBeTruthy();
        expect((raw2[0]?.config as Record<string, unknown> | undefined)?.["oauthState"]).toBeTruthy();

        await deleteConnectorRow(provider);
        await db.delete(connectors).where(sql`${connectors.workspaceId} = ${workspaceId2} AND ${connectors.provider} = ${provider}`);
      });

      it("clearPendingConnectorOauthStatesForUser (last-mint-wins): clears a prior pending record in ANOTHER workspace, so a fresh mint resolves cleanly instead of hitting the ambiguity above", async () => {
        const provider = "sentry";
        await deleteConnectorRow(provider);
        await db.delete(connectors).where(sql`${connectors.workspaceId} = ${workspaceId2} AND ${connectors.provider} = ${provider}`);

        // An earlier, still-pending attempt in workspace 2...
        await mintConnectorOauthState(workspaceId2, provider, "user-last-mint-wins");

        // ...the link route's own sequence for a session-transport provider:
        // clear-then-mint, for a NEW attempt in workspace 1.
        await clearPendingConnectorOauthStatesForUser(provider, "user-last-mint-wins");
        await mintConnectorOauthState(workspaceId, provider, "user-last-mint-wins");

        // Resolves cleanly to the NEW (workspace 1) attempt — no ambiguity,
        // because the stale workspace-2 record was cleared first.
        expect(await consumeConnectorOauthStateBySessionUser(provider, "user-last-mint-wins")).toEqual({
          workspaceId,
          userId: "user-last-mint-wins",
          codeVerifier: null,
        });

        await deleteConnectorRow(provider);
        await db.delete(connectors).where(sql`${connectors.workspaceId} = ${workspaceId2} AND ${connectors.provider} = ${provider}`);
      });

      it("clearPendingConnectorOauthStatesForUser does not touch a DIFFERENT user's pending record for the same provider", async () => {
        const provider = "sentry";
        await deleteConnectorRow(provider);
        await db.delete(connectors).where(sql`${connectors.workspaceId} = ${workspaceId2} AND ${connectors.provider} = ${provider}`);

        await mintConnectorOauthState(workspaceId, provider, "user-untouched");
        await clearPendingConnectorOauthStatesForUser(provider, "a-totally-different-user");

        expect(await consumeConnectorOauthStateBySessionUser(provider, "user-untouched")).toEqual({
          workspaceId,
          userId: "user-untouched",
          codeVerifier: null,
        });
      });

      // ---------------------------------------------------------------
      // W3-T3 SECOND fix round (independent review Finding 1) —
      // per-transport TTL, proven end-to-end against real Postgres: a
      // session-transport mint using the shorter TTL is correctly
      // excluded by the SAME generic expiry check
      // consumeConnectorOauthStateBySessionUser already uses (no
      // transport-conditional logic there — see connectors.ts's own
      // doc-comment). Uses a negative ttlMs (already-expired the instant
      // it's minted) rather than a real 10-minute wait, to prove the
      // MECHANISM without a slow test.
      // ---------------------------------------------------------------
      it("mintConnectorOauthState's ttlMs override is honored — an already-expired (negative-ttlMs) session-transport mint resolves null, not the false-negative a hardcoded 30-min assumption would produce", async () => {
        const provider = "sentry";
        await deleteConnectorRow(provider);

        await mintConnectorOauthState(workspaceId, provider, "user-short-ttl", undefined, -1000);

        expect(await consumeConnectorOauthStateBySessionUser(provider, "user-short-ttl")).toBeNull();
      });

      it("a mint using SESSION_TRANSPORT_OAUTH_STATE_TTL_MS (10 min) still resolves normally when unexpired — the shorter default doesn't break the happy path", async () => {
        const provider = "sentry";
        await deleteConnectorRow(provider);

        await mintConnectorOauthState(
          workspaceId,
          provider,
          "user-normal-short-ttl",
          undefined,
          SESSION_TRANSPORT_OAUTH_STATE_TTL_MS
        );

        expect(await consumeConnectorOauthStateBySessionUser(provider, "user-normal-short-ttl")).toEqual({
          workspaceId,
          userId: "user-normal-short-ttl",
          codeVerifier: null,
        });
      });
    });

    // -------------------------------------------------------------------
    // OAuth Connect Wave 3, W3-T3 — sentryInstallationId is declared
    // NON-ephemeral (unlike oauthState/oauthStateExpiresAt/oauthUserId/
    // oauthPkceVerifier above): it must survive an unrelated write (same as
    // railwayProjectId always has) AND stay VISIBLE in the client-safe view
    // — the opposite of the "never leaks" proof just above for the four
    // ephemeral keys. A mocked `db` (connectors.test.ts) can prove the
    // validator/completeConfig SOURCE LINES exist; only a real multi-step
    // Postgres round-trip proves the merge actually behaves this way in
    // practice (the exact class of bug review IMPORTANT-1 caught for the
    // ephemeral keys — the same doctrine applied here in the other
    // direction).
    // -------------------------------------------------------------------
    it("sentryInstallationId survives an unrelated upsertConnector write AND stays visible in the client-safe view (non-ephemeral, unlike oauthState/etc.)", async () => {
      const provider = "sentry";
      await deleteConnectorRow(provider);

      await upsertConnector(workspaceId, provider, {
        config: { sentryInstallationId: "01635075-m30w-4f96-8fc8-ff9680780a13" },
      });

      // An unrelated write (re-saving org/project, or a trigger-label edit)
      // lands on the SAME row afterward.
      await upsertConnector(workspaceId, provider, {
        config: { triggerLabel: "unrelated-write", sentryOrg: "acme" },
      });

      const view = await getConnector(workspaceId, provider);
      expect(view).not.toBeNull();
      // Survived the unrelated write...
      expect(view!.config.sentryInstallationId).toBe("01635075-m30w-4f96-8fc8-ff9680780a13");
      expect(view!.config.triggerLabel).toBe("unrelated-write");
      expect(view!.config.sentryOrg).toBe("acme");
      // ...and unlike oauthState/oauthStateExpiresAt/oauthUserId/
      // oauthPkceVerifier, it is NOT stripped — genuinely present in the
      // read model a route hands back to a browser (already proven present
      // above via `.toBe(...)`; this is the same fact stated as a property
      // check for symmetry with the ephemeral-key test's own
      // `.not.toHaveProperty` assertions).
      expect(view!.config).toHaveProperty("sentryInstallationId");

      await deleteConnectorRow(provider);
    });
  }
);
