import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { randomUUID } from "crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../db.js";
import { workspaces } from "../schema/workspaces.js";
import { previewBoots, type PreviewBootRow } from "../schema/preview_boots.js";

/**
 * B2b Task 1 (plan docs/superpowers/plans/2026-08-02-b2b-sandbox-boot.md;
 * spec docs/superpowers/specs/2026-08-02-b2-behavioral-evidence-design.md
 * §B2b §4-5) — schema/migration agreement coverage for the boot plane's
 * dedicated `preview_boots` queue. No query layer exists yet (that's Task
 * 2); this file only proves the table itself is right.
 *
 * The live-Postgres round trip below is the load-bearing half: migration
 * 0068 is hand-authored, not `drizzle-kit generate`d (the same pre-existing
 * snapshot-chain gap as 0066_review_jobs.sql/0067's own provenance notes),
 * so nothing else proves the DDL this migration writes actually matches
 * what this Drizzle schema file claims — a schema-object-only assertion
 * would happily "pass" against a table that was never really created with
 * these columns. Mirrors `review-jobs.integration.test.ts`'s DB_AVAILABLE
 * skip-if pattern so this suite degrades gracefully with no local Postgres,
 * but still runs for real in CI (`ci.yml` migrates the service Postgres
 * before `vitest run`).
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
  "preview_boots — live Postgres schema agreement (B2b Task 1)",
  () => {
    let wsId: string;

    beforeEach(async () => {
      const rows = await db
        .insert(workspaces)
        .values({
          name: "preview-boots test workspace",
          slug: `test-preview-boots-${randomUUID()}`,
        })
        .returning({ id: workspaces.id });
      wsId = rows[0]!.id;
    });

    afterEach(async () => {
      // Cascades to preview_boots (workspace_id ON DELETE CASCADE).
      await db.delete(workspaces).where(eq(workspaces.id, wsId));
    });

    it("inserts a row with EVERY column populated and selects it back exactly", async () => {
      const id = randomUUID();
      const claimedAt = new Date("2026-08-02T10:00:00.000Z");
      const expiresAt = new Date("2026-08-02T10:12:00.000Z");
      const lastLivenessAt = new Date("2026-08-02T10:05:00.000Z");
      const nextEligibleAt = new Date("2026-08-02T10:06:00.000Z");

      await db.insert(previewBoots).values({
        id,
        workspaceId: wsId,
        repo: "acme/widgets",
        prNumber: 42,
        headSha: "abc123def456abc123def456abc123def456abcd",
        // Deliberately different from headSha so this proves `ref` is its
        // own column, not an alias/typo of head_sha.
        ref: "refs/pull/42/head",
        status: "ready",
        workerId: "worker-1",
        claimedAt,
        url: "http://127.0.0.1:41234",
        port: 41234,
        reason: "test-reason",
        attempts: 3,
        expiresAt,
        lastLivenessAt,
        nextEligibleAt,
      });

      const rows = await db
        .select()
        .from(previewBoots)
        .where(eq(previewBoots.id, id));
      expect(rows).toHaveLength(1);
      const row: PreviewBootRow = rows[0]!;

      expect(row.id).toBe(id);
      expect(row.workspaceId).toBe(wsId);
      expect(row.repo).toBe("acme/widgets");
      expect(row.prNumber).toBe(42);
      expect(row.headSha).toBe("abc123def456abc123def456abc123def456abcd");
      expect(row.ref).toBe("refs/pull/42/head");
      expect(row.status).toBe("ready");
      expect(row.workerId).toBe("worker-1");
      expect(row.claimedAt?.getTime()).toBe(claimedAt.getTime());
      expect(row.url).toBe("http://127.0.0.1:41234");
      expect(row.port).toBe(41234);
      expect(row.reason).toBe("test-reason");
      expect(row.attempts).toBe(3);
      expect(row.expiresAt?.getTime()).toBe(expiresAt.getTime());
      expect(row.lastLivenessAt?.getTime()).toBe(lastLivenessAt.getTime());
      expect(row.nextEligibleAt?.getTime()).toBe(nextEligibleAt.getTime());
      expect(row.createdAt).toBeInstanceOf(Date);
      expect(row.updatedAt).toBeInstanceOf(Date);
    });

    it("a minimal insert (only the NOT NULL, no-default columns) applies every default and leaves the rest null", async () => {
      const id = randomUUID();
      await db.insert(previewBoots).values({
        id,
        workspaceId: wsId,
        repo: "acme/widgets",
        prNumber: 7,
        headSha: "deadbeef",
        ref: "deadbeef",
      });

      const rows = await db
        .select()
        .from(previewBoots)
        .where(eq(previewBoots.id, id));
      expect(rows).toHaveLength(1);
      const row = rows[0]!;

      expect(row.status).toBe("pending");
      expect(row.attempts).toBe(0);
      expect(row.workerId).toBeNull();
      expect(row.claimedAt).toBeNull();
      expect(row.url).toBeNull();
      expect(row.port).toBeNull();
      expect(row.reason).toBeNull();
      expect(row.expiresAt).toBeNull();
      expect(row.lastLivenessAt).toBeNull();
      expect(row.nextEligibleAt).toBeNull();
      expect(row.createdAt).toBeInstanceOf(Date);
      expect(row.updatedAt).toBeInstanceOf(Date);
    });

    it("cascades on workspace delete — no orphaned preview_boots row survives", async () => {
      const id = randomUUID();
      await db.insert(previewBoots).values({
        id,
        workspaceId: wsId,
        repo: "acme/widgets",
        prNumber: 1,
        headSha: "sha-1",
        ref: "sha-1",
      });

      await db.delete(workspaces).where(eq(workspaces.id, wsId));

      const rows = await db
        .select()
        .from(previewBoots)
        .where(eq(previewBoots.id, id));
      expect(rows).toHaveLength(0);
    });
  }
);

describe("preview_boots schema — declarations (no DB required)", () => {
  it("status is NOT NULL, defaults to 'pending', and is a plain text column (NOT a pg enum)", () => {
    expect(previewBoots.status.notNull).toBe(true);
    expect(previewBoots.status.hasDefault).toBe(true);
    expect(previewBoots.status.getSQLType()).toBe("text");
  });

  it("attempts is NOT NULL and defaults to 0", () => {
    expect(previewBoots.attempts.notNull).toBe(true);
    expect(previewBoots.attempts.hasDefault).toBe(true);
  });

  it("id carries NO default — caller-supplied deterministic id (Task 2's previewBootId)", () => {
    expect(previewBoots.id.hasDefault).toBe(false);
  });

  it("workspace_id is NOT NULL and CASCADEs on workspace delete", () => {
    expect(previewBoots.workspaceId.notNull).toBe(true);
    const config = getTableConfig(previewBoots);
    const fk = config.foreignKeys.find((f) =>
      f.reference().columns.some((c) => c.name === "workspace_id")
    );
    expect(fk).toBeDefined();
    expect(fk!.onDelete).toBe("cascade");
  });

  it("workerId/claimedAt/url/port/reason/expiresAt/lastLivenessAt/nextEligibleAt are all nullable", () => {
    expect(previewBoots.workerId.notNull).toBe(false);
    expect(previewBoots.claimedAt.notNull).toBe(false);
    expect(previewBoots.url.notNull).toBe(false);
    expect(previewBoots.port.notNull).toBe(false);
    expect(previewBoots.reason.notNull).toBe(false);
    expect(previewBoots.expiresAt.notNull).toBe(false);
    expect(previewBoots.lastLivenessAt.notNull).toBe(false);
    expect(previewBoots.nextEligibleAt.notNull).toBe(false);
  });

  it("carries a partial index on created_at scoped to status='pending' (the claim query's hot path)", () => {
    const config = getTableConfig(previewBoots);
    const idx = config.indexes.find(
      (i) => i.config.name === "preview_boots_pending_idx"
    );
    expect(idx).toBeDefined();
    expect(idx!.config.where).toBeDefined();
    const columnNames = idx!.config.columns.map(
      (c) => (c as { name?: string }).name
    );
    expect(columnNames).toEqual(["created_at"]);
  });

  it("carries the (workspace_id, repo, pr_number) lookup index", () => {
    const config = getTableConfig(previewBoots);
    const idx = config.indexes.find(
      (i) => i.config.name === "preview_boots_pr_idx"
    );
    expect(idx).toBeDefined();
    const columnNames = idx!.config.columns.map(
      (c) => (c as { name?: string }).name
    );
    expect(columnNames).toEqual(["workspace_id", "repo", "pr_number"]);
  });
});

/**
 * 0068_preview_boots migration — mirrors `billing-schema.test.ts`'s idiom:
 * read the actual migration SQL and journal off disk rather than only
 * re-asserting the Drizzle schema objects above, since that is what catches
 * drift between the hand-authored SQL and the schema file it is supposed to
 * mirror, plus the idempotency guards no schema-object assertion can see.
 */
describe("0068_preview_boots migration", () => {
  const MIGRATION = join(
    __dirname,
    "../../drizzle/migrations/0068_preview_boots.sql"
  );

  it("creates preview_boots idempotently", () => {
    const sqlText = readFileSync(MIGRATION, "utf8");
    expect(sqlText).toContain('CREATE TABLE IF NOT EXISTS "preview_boots"');
  });

  it("guards the workspace_id FK against a second run", () => {
    const sqlText = readFileSync(MIGRATION, "utf8");
    expect(sqlText).toContain(
      "preview_boots_workspace_id_workspaces_id_fk"
    );
    expect(sqlText).toContain("WHEN duplicate_object THEN null");
  });

  it("creates both indexes idempotently, matching the Drizzle declarations exactly", () => {
    const sqlText = readFileSync(MIGRATION, "utf8");
    expect(sqlText).toContain(
      'CREATE INDEX IF NOT EXISTS "preview_boots_pending_idx" ON "preview_boots" USING btree ("created_at") WHERE "preview_boots"."status" = \'pending\''
    );
    expect(sqlText).toContain(
      'CREATE INDEX IF NOT EXISTS "preview_boots_pr_idx" ON "preview_boots" USING btree ("workspace_id","repo","pr_number")'
    );
  });

  it("is registered in the journal at idx 72 (unjournaled migrations are silently skipped)", () => {
    const journal = JSON.parse(
      readFileSync(
        join(__dirname, "../../drizzle/migrations/meta/_journal.json"),
        "utf8"
      )
    );
    const entry = journal.entries.find(
      (e: { tag: string }) => e.tag === "0068_preview_boots"
    );
    expect(entry).toBeDefined();
    expect(entry.idx).toBe(72);
    expect(entry.version).toBe("7");
    expect(entry.breakpoints).toBe(true);
  });
});
