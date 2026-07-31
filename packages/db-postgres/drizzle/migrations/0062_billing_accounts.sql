-- Slice 1 of the subscription platform (spec
-- docs/superpowers/specs/2026-07-29-subscription-platform-design.md §3
-- "Platform architecture", §5 "Seats and identity"). Billing moves ABOVE
-- workspaces: a `billing_accounts` row owns the plan, the Stripe
-- subscription, and the seats; `seats` gates one unique human per account
-- (never a per-platform identity); `upgrade_prompt_events` is the CAS dedup
-- + audit trail for the seat-limit/capacity upgrade nudge. `workspaces`
-- gets a new `billing_account_id` FK — nullable here on purpose: SET NOT
-- NULL is a later slice's job (new workspaces only start getting accounts
-- at creation time from slice 3 onward), and the policy resolver
-- (`resolvePolicyForWorkspace`, a later slice) treats a NULL account
-- exactly like a fresh trial in the meantime.
--
-- Every EXISTING workspace is backfilled with exactly one trial account
-- (`plan = 'trial'`, `trial_ends_at = now() + 14 days`, named after the
-- workspace) — founders convert real accounts by hand at launch (spec §9);
-- no live paying customer exists to migrate. A plain INSERT...SELECT can't
-- tell the backfill UPDATE which new account belongs to which workspace
-- (and workspace names can collide), so the backfill adds a temporary
-- `seed_workspace_id` column on `billing_accounts`, inserts with it set to
-- the source workspace's id, stamps `workspaces.billing_account_id` by
-- joining on it, then drops the column — it never survives past this
-- migration.
--
-- NOTE ON THIS FILE'S PROVENANCE: hand-authored, NOT `drizzle-kit
-- generate`d — same pre-existing snapshot-chain gap (only 0000-0003 have
-- meta snapshots) documented in 0043_wallet_engine.sql. This file follows
-- that migration's exact idempotent statement shapes (`ADD COLUMN IF NOT
-- EXISTS`, enum `CREATE TYPE` guarded by a `DO $$ ... EXCEPTION WHEN
-- duplicate_object` block, `CREATE TABLE IF NOT EXISTS`, FK constraints in
-- their own guarded `DO $$` blocks, `CREATE [UNIQUE] INDEX IF NOT EXISTS`),
-- plus `IS NULL`-guarded backfill statements, so every statement here —
-- including the backfill — is safe to re-run.
DO $$ BEGIN
 CREATE TYPE "public"."billing_plan" AS ENUM('trial', 'starter', 'growth', 'enterprise');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"plan" "billing_plan" DEFAULT 'trial' NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"subscription_status" text,
	"current_period_end" timestamp with time zone,
	"trial_ends_at" timestamp with time zone NOT NULL,
	"policy_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"billing_account_id" uuid NOT NULL,
	"user_id" uuid,
	"chat_identity_id" uuid,
	"claimed_via" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "seats_exactly_one_subject" CHECK (("seats"."user_id" IS NOT NULL) <> ("seats"."chat_identity_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "upgrade_prompt_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"billing_account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"conversation_key" text NOT NULL,
	"channel" text NOT NULL,
	"period_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "seats" ADD CONSTRAINT "seats_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "seats" ADD CONSTRAINT "seats_chat_identity_id_chat_identities_id_fk" FOREIGN KEY ("chat_identity_id") REFERENCES "public"."chat_identities"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "upgrade_prompt_events" ADD CONSTRAINT "upgrade_prompt_events_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "seats_active_user_idx" ON "seats" USING btree ("billing_account_id","user_id") WHERE "seats"."released_at" IS NULL AND "seats"."user_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "seats_active_identity_idx" ON "seats" USING btree ("billing_account_id","chat_identity_id") WHERE "seats"."released_at" IS NULL AND "seats"."chat_identity_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "upgrade_prompt_dedup_idx" ON "upgrade_prompt_events" USING btree ("billing_account_id","kind","conversation_key","period_key");
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "billing_account_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Backfill step 1/4: temporary correlation column, dropped at the end of
-- this migration (step 4/4). Re-running after a completed prior run just
-- re-adds an empty column that step 2 leaves empty (nothing matches its
-- WHERE clause once every workspace is stamped) and step 4 drops again.
ALTER TABLE "billing_accounts" ADD COLUMN IF NOT EXISTS "seed_workspace_id" uuid;
--> statement-breakpoint
-- Backfill step 2/4: one trial account per workspace that doesn't have one
-- yet. The WHERE clause is what makes this idempotent — once a workspace is
-- stamped (step 3), it never matches again, so a second run inserts zero
-- rows. The NOT EXISTS clause additionally guards a narrower window: a
-- crash between this INSERT committing and step 3's UPDATE running (this
-- file's statement-level IF NOT EXISTS/duplicate_object guards throughout
-- assume exactly this kind of resumable, statement-at-a-time execution). On
-- resume, `billing_account_id IS NULL` alone would re-match the same
-- workspaces and insert a SECOND seed row per workspace — step 3's
-- UPDATE...FROM would then multi-match and pick one arbitrarily, and step 4
-- would drop the only column that could ever identify the orphaned
-- duplicate. Excluding workspaces that already have a pending (unlinked)
-- seed row makes this INSERT idempotent against its own re-execution, not
-- just against a completed backfill.
INSERT INTO "billing_accounts" ("name", "plan", "trial_ends_at", "seed_workspace_id")
  SELECT "w"."name", 'trial', now() + interval '14 days', "w"."id"
  FROM "workspaces" "w"
  WHERE "w"."billing_account_id" IS NULL
    AND NOT EXISTS (SELECT 1 FROM "billing_accounts" "ba" WHERE "ba"."seed_workspace_id" = "w"."id");
--> statement-breakpoint
-- Backfill step 3/4: stamp each workspace with the account seeded from it.
-- The extra `billing_account_id IS NULL` guard is defense in depth — step 2
-- already ensures nothing here matches a workspace that's already stamped.
UPDATE "workspaces"
   SET "billing_account_id" = "ba"."id"
  FROM "billing_accounts" "ba"
 WHERE "ba"."seed_workspace_id" = "workspaces"."id"
   AND "workspaces"."billing_account_id" IS NULL;
--> statement-breakpoint
-- Backfill step 4/4: the pairing column served its purpose; nothing past
-- this migration ever reads it.
ALTER TABLE "billing_accounts" DROP COLUMN IF EXISTS "seed_workspace_id";
