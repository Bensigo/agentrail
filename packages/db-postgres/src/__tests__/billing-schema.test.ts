import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { billingPlanEnum, billingAccounts } from "../schema/billing_accounts.js";
import { seats } from "../schema/seats.js";
import { upgradePromptEvents } from "../schema/upgrade_prompt_events.js";
import { workspaces } from "../schema/workspaces.js";
import { users } from "../schema/auth.js";

/**
 * Slice 1 schema (spec docs/superpowers/specs/2026-07-29-subscription-platform-design.md
 * §3 "Platform architecture", §5 "Seats and identity"). Mirrors
 * `workspace-grant-events-schema.test.ts` / `jace-messages-schema.test.ts`'s
 * idiom: assert against the schema OBJECT directly via `getTableConfig`, no
 * live-DB harness (this package has none).
 */
describe("billing_accounts schema", () => {
  it("billing_plan enum carries exactly the four plans, in order", () => {
    expect(billingPlanEnum.enumValues).toEqual([
      "trial",
      "starter",
      "growth",
      "enterprise",
    ]);
  });

  it("plan is NOT NULL and defaults to trial", () => {
    expect(billingAccounts.plan.notNull).toBe(true);
    expect(billingAccounts.plan.hasDefault).toBe(true);
  });

  it("trial_ends_at is NOT NULL with no DB default — the creating code computes it", () => {
    expect(billingAccounts.trialEndsAt.notNull).toBe(true);
    expect(billingAccounts.trialEndsAt.hasDefault).toBe(false);
  });

  it("policy_overrides is NOT NULL and defaults to {} — empty for every self-serve plan", () => {
    expect(billingAccounts.policyOverrides.notNull).toBe(true);
    expect(billingAccounts.policyOverrides.hasDefault).toBe(true);
  });

  it("stripe_customer_id is nullable — null until slice 3 wires checkout", () => {
    expect(billingAccounts.stripeCustomerId.notNull).toBe(false);
  });
});

describe("seats schema (spec §3, §5)", () => {
  it("carries the exactly-one-subject CHECK", () => {
    const config = getTableConfig(seats);
    const found = config.checks.find(
      (c) => c.name === "seats_exactly_one_subject"
    );
    expect(found).toBeDefined();
  });

  it("carries a partial unique index on (billing_account_id, user_id) scoped to active seats", () => {
    const config = getTableConfig(seats);
    const idx = config.indexes.find(
      (i) => i.config.name === "seats_active_user_idx"
    );
    expect(idx).toBeDefined();
    expect(idx!.config.unique).toBe(true);
    expect(idx!.config.where).toBeDefined();
    const columnNames = idx!.config.columns.map(
      (c) => (c as { name?: string }).name
    );
    expect(columnNames).toEqual(["billing_account_id", "user_id"]);
  });

  it("carries a partial unique index on (billing_account_id, chat_identity_id) scoped to active seats", () => {
    const config = getTableConfig(seats);
    const idx = config.indexes.find(
      (i) => i.config.name === "seats_active_identity_idx"
    );
    expect(idx).toBeDefined();
    expect(idx!.config.unique).toBe(true);
    expect(idx!.config.where).toBeDefined();
    const columnNames = idx!.config.columns.map(
      (c) => (c as { name?: string }).name
    );
    expect(columnNames).toEqual(["billing_account_id", "chat_identity_id"]);
  });

  it("user_id's column type matches users.id (uuid), and carries no FK — release is an application-level transaction (spec §5 rule 5)", () => {
    expect(seats.userId.columnType).toBe(users.id.columnType);
    const config = getTableConfig(seats);
    const fk = config.foreignKeys.find((f) =>
      f.reference().columns.some((c) => c.name === "user_id")
    );
    expect(fk).toBeUndefined();
  });

  it("billing_account_id is NOT NULL and CASCADEs on billing account delete", () => {
    expect(seats.billingAccountId.notNull).toBe(true);
    const config = getTableConfig(seats);
    const fk = config.foreignKeys.find((f) =>
      f.reference().columns.some((c) => c.name === "billing_account_id")
    );
    expect(fk).toBeDefined();
    expect(fk!.onDelete).toBe("cascade");
  });

  it("chat_identity_id CASCADEs on chat identity delete", () => {
    const config = getTableConfig(seats);
    const fk = config.foreignKeys.find((f) =>
      f.reference().columns.some((c) => c.name === "chat_identity_id")
    );
    expect(fk).toBeDefined();
    expect(fk!.onDelete).toBe("cascade");
  });

  it("claimed_via and claimed_at are NOT NULL; released_at is nullable", () => {
    expect(seats.claimedVia.notNull).toBe(true);
    expect(seats.claimedAt.notNull).toBe(true);
    expect(seats.releasedAt.notNull).toBe(false);
  });
});

describe("upgrade_prompt_events schema", () => {
  it("carries the four-column dedup unique index (one prompt/conversation/day)", () => {
    const config = getTableConfig(upgradePromptEvents);
    const idx = config.indexes.find(
      (i) => i.config.name === "upgrade_prompt_dedup_idx"
    );
    expect(idx).toBeDefined();
    expect(idx!.config.unique).toBe(true);
    const columnNames = idx!.config.columns.map(
      (c) => (c as { name?: string }).name
    );
    expect(columnNames).toEqual([
      "billing_account_id",
      "kind",
      "conversation_key",
      "period_key",
    ]);
  });

  it("billing_account_id is NOT NULL and CASCADEs on billing account delete", () => {
    const config = getTableConfig(upgradePromptEvents);
    const fk = config.foreignKeys.find((f) =>
      f.reference().columns.some((c) => c.name === "billing_account_id")
    );
    expect(fk).toBeDefined();
    expect(fk!.onDelete).toBe("cascade");
  });
});

describe("workspaces schema — billing_account_id (spec §3)", () => {
  it("exists, is nullable (backfill happens in the next task's migration)", () => {
    expect(workspaces.billingAccountId).toBeDefined();
    expect(workspaces.billingAccountId.notNull).toBe(false);
  });

  it("SET NULLs on billing account delete — losing the account must never take the workspace down with it", () => {
    const config = getTableConfig(workspaces);
    const fk = config.foreignKeys.find((f) =>
      f.reference().columns.some((c) => c.name === "billing_account_id")
    );
    expect(fk).toBeDefined();
    expect(fk!.onDelete).toBe("set null");
  });
});

/**
 * 0062_billing_accounts migration (spec §3, §7 "Trial"). Mirrors
 * `counting-indexes-schema.test.ts`'s idiom: read the actual migration SQL
 * and journal off disk rather than re-asserting the drizzle schema objects
 * above — this is what catches drift between the hand-authored SQL and the
 * schema files it's supposed to mirror, plus the idempotency guards no
 * schema-object assertion can see.
 */
describe("0062_billing_accounts migration", () => {
  const MIGRATION = join(
    __dirname,
    "../../drizzle/migrations/0062_billing_accounts.sql"
  );

  it("creates billing_accounts idempotently", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "billing_accounts"');
  });

  it("creates seats and upgrade_prompt_events idempotently", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "seats"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "upgrade_prompt_events"');
  });

  it("guards the billing_plan enum creation against a second run", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    expect(sql).toContain(
      'CREATE TYPE "public"."billing_plan" AS ENUM(\'trial\', \'starter\', \'growth\', \'enterprise\')'
    );
    expect(sql).toContain("WHEN duplicate_object THEN null");
  });

  it("creates both seats partial unique indexes, scoped to active AND non-null subject rows", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "seats_active_user_idx" ON "seats" USING btree ("billing_account_id","user_id") WHERE "seats"."released_at" IS NULL AND "seats"."user_id" IS NOT NULL'
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "seats_active_identity_idx" ON "seats" USING btree ("billing_account_id","chat_identity_id") WHERE "seats"."released_at" IS NULL AND "seats"."chat_identity_id" IS NOT NULL'
    );
  });

  it("adds workspaces.billing_account_id idempotently, without SET NOT NULL", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    expect(sql).toContain(
      'ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "billing_account_id" uuid'
    );
    expect(sql).not.toContain("SET NOT NULL");
  });

  it("backfills one trial billing account per workspace lacking one, via the seed-column pairing pattern", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    // Temporary correlation column: added idempotently, dropped at the end.
    expect(sql).toContain(
      'ALTER TABLE "billing_accounts" ADD COLUMN IF NOT EXISTS "seed_workspace_id" uuid'
    );
    expect(sql).toContain(
      'ALTER TABLE "billing_accounts" DROP COLUMN IF EXISTS "seed_workspace_id"'
    );
    // The backfill insert: one trial account per un-stamped workspace, ALSO
    // excluding a workspace that already has a pending (unlinked) seed row —
    // required for idempotency against the INSERT's own re-execution (a
    // resume after a crash between this INSERT committing and the pairing
    // UPDATE below), not just against a fully completed backfill.
    expect(sql).toMatch(
      /INSERT INTO "billing_accounts"[\s\S]*SELECT[\s\S]*FROM "workspaces" "w"\s*\n\s*WHERE "w"\."billing_account_id" IS NULL\s*\n\s*AND NOT EXISTS \(SELECT 1 FROM "billing_accounts" "ba" WHERE "ba"\."seed_workspace_id" = "w"\."id"\)/
    );
    expect(sql).toContain("'trial'");
    expect(sql).toContain("interval '14 days'");
    // The stamping update: joins back on the seed column, re-guarded by
    // billing_account_id IS NULL so a second run touches zero rows.
    expect(sql).toMatch(
      /UPDATE "workspaces"[\s\S]*SET "billing_account_id" = "ba"\."id"[\s\S]*WHERE "ba"\."seed_workspace_id" = "workspaces"\."id"[\s\S]*AND "workspaces"\."billing_account_id" IS NULL/
    );
  });

  it("is registered in the journal at idx 63 (unjournaled migrations are silently skipped)", () => {
    const journal = JSON.parse(
      readFileSync(
        join(__dirname, "../../drizzle/migrations/meta/_journal.json"),
        "utf8"
      )
    );
    const entry = journal.entries.find(
      (e: { tag: string }) => e.tag === "0062_billing_accounts"
    );
    expect(entry).toBeDefined();
    expect(entry.idx).toBe(63);
    expect(entry.when).toBe(1786500000000);
    expect(entry.version).toBe("7");
    expect(entry.breakpoints).toBe(true);
  });
});
