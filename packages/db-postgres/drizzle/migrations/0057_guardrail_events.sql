-- Jace input guardrails (spec:
-- docs/superpowers/specs/2026-07-28-jace-input-guardrails-design.md).
-- Additive only: a new `guardrail_events` table recording every finding the
-- inbound moderation / injection / PII layers produce at the
-- `channel-dispatch.ts` seam. Nothing here touches an existing table's data
-- or an existing column's type.
--
-- NO RAW MESSAGE TEXT IS STORED. `content_sha256` is a digest of the
-- normalized message and `match_types` holds subtypes + offsets only —
-- persisting the PII the redaction layer just removed would defeat the
-- guardrail. See the schema file's doc-comment for the full rationale.
--
-- Both anchor columns are nullable and there is deliberately NO CHECK
-- requiring one (unlike `channel_inbox`): an audit row must never fail to
-- write because attribution was unavailable. Losing the audit row is strictly
-- worse than losing the attribution.
--
-- Hand-authored, NOT `drizzle-kit generate`d — same posture as every migration
-- since 0004 in this checkout (see 0043_wallet_engine.sql's provenance note):
-- idempotent statement shapes (`CREATE TABLE IF NOT EXISTS`, FK constraints in
-- guarded `DO $$` blocks, `CREATE INDEX IF NOT EXISTS`), safe to re-run.
--
-- MIGRATION SLOT: journal idx 58 / file 0057. Slots 0055 and 0056 are reserved
-- by the concurrent briefs arc, so this intentionally leaves a gap in
-- `_journal.json` until those land — the same reservation pattern
-- 0051_stripe_events.sql documents for its own slot. Do not renumber this file.
CREATE TABLE IF NOT EXISTS "guardrail_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"chat_identity_id" uuid,
	"channel" text NOT NULL,
	"conversation_key" text NOT NULL,
	"category" text NOT NULL,
	"verdict" text NOT NULL,
	"detector" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"match_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"content_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "guardrail_events" ADD CONSTRAINT "guardrail_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "guardrail_events" ADD CONSTRAINT "guardrail_events_chat_identity_id_chat_identities_id_fk" FOREIGN KEY ("chat_identity_id") REFERENCES "public"."chat_identities"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "guardrail_events_workspace_created_idx" ON "guardrail_events" USING btree ("workspace_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "guardrail_events_category_verdict_idx" ON "guardrail_events" USING btree ("category","verdict");
