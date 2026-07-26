-- Issue #1415 (Stripe top-up, Wave 5 / epic #1257; #1290's deferred PR ③).
-- Additive only: a new `stripe_events` table recording every Stripe webhook
-- event id this app has processed, so a redelivered webhook can never credit
-- a wallet twice. Nothing here touches an existing table's data or an
-- existing column's type.
--
-- Hand-authored, NOT `drizzle-kit generate`d — same posture as every
-- migration since 0004 in this checkout (see 0043_wallet_engine.sql's own
-- provenance note): idempotent statement shapes (`CREATE TABLE IF NOT
-- EXISTS`, an FK constraint in its own guarded `DO $$` block, `CREATE UNIQUE
-- INDEX IF NOT EXISTS`), safe to re-run exactly like its siblings.
--
-- MIGRATION SLOT: journal idx 52 / file 0051 was reserved for this issue by
-- the parent orchestration (other concurrent worktrees own 0049/0050) — this
-- intentionally leaves a gap in `_journal.json` until those land; do not
-- renumber this file.
CREATE TABLE IF NOT EXISTS "stripe_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"workspace_id" uuid,
	"amount_usd_cents" integer,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stripe_events" ADD CONSTRAINT "stripe_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stripe_events_event_id_idx" ON "stripe_events" USING btree ("event_id");
