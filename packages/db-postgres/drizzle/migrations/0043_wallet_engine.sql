-- Issue #1290 (prepaid per-task wallet, Wave 5 / epic #1257; design locked
-- 2026-07-22). Additive only: the `billing_enabled` rollout-safety flag on
-- `workspaces` (default false), plus the new append-only `wallet_transactions`
-- ledger. Nothing here touches an existing table's data or an existing
-- column's type. With `billing_enabled` false (the default for every existing
-- AND future workspace) no wallet row is ever written and prod behavior is
-- byte-for-byte unchanged.
--
-- NOTE ON THIS FILE'S PROVENANCE: hand-authored, NOT `drizzle-kit generate`d.
-- `drizzle-kit generate` in this checkout only has snapshot files for
-- migrations 0000-0003 (drizzle/migrations/meta/*_snapshot.json) even though
-- the journal runs through 0042 — the snapshot chain is missing every entry
-- from 0004 onward, a PRE-EXISTING gap unrelated to this feature, so
-- `generate` diffs against a stale schema and is not safe to trust. This file
-- follows the exact idempotent statement shapes every other migration here
-- already uses (`ADD COLUMN IF NOT EXISTS`, enum `CREATE TYPE` guarded by a
-- `DO $$ ... EXCEPTION WHEN duplicate_object` block, `CREATE TABLE IF NOT
-- EXISTS`, an FK constraint in its own guarded `DO $$` block, `CREATE [UNIQUE]
-- INDEX IF NOT EXISTS`), so it is idempotent and safe to re-run exactly like
-- its siblings (mirrors 0042_goal_loop.sql).
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "billing_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."wallet_transaction_kind" AS ENUM('top_up', 'task_charge');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "wallet_transaction_kind" NOT NULL,
	"amount_usd_cents" integer NOT NULL,
	"run_id" uuid,
	"task_ref" text,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_transactions_workspace_id_idx" ON "wallet_transactions" USING btree ("workspace_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_transactions_task_charge_run_id_idx" ON "wallet_transactions" USING btree ("run_id") WHERE "wallet_transactions"."kind" = 'task_charge';
