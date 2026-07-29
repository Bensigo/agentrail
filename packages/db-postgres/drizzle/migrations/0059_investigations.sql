-- Investigations: Jace's durable, server-side record of ONE production
-- incident (docs/superpowers/specs/2026-07-29-jace-debugging-agent-design.md,
-- spec PR #1501).
--
-- `investigations` is the top-level artifact (one row per incident, keyed
-- (workspace_id, slug), reopened rather than forked on recurrence — see the
-- schema file's doc-comment). `investigation_items` is the ledger: every
-- timeline note, evidence capture, hypothesis, finding, verdict, and draft
-- lesson, as one typed row shape (mirrors `brief_items`' typed-row-over-
-- prose shape). `investigation_links` records investigation-to-investigation
-- edges (`recurrence_of`/`related`); `investigation_issue_links` records
-- which issues an investigation's handoff actually produced (mirrors
-- `brief_work_links`). Deleting a workspace cascades through
-- investigations → investigation_items/investigation_links/
-- investigation_issue_links; deleting a repository only detaches it (SET
-- NULL) — an investigation outlives the repo connection that happened to
-- exist when it was opened.
--
-- Hand-authored, NOT `drizzle-kit generate`d — same posture as every
-- migration since 0004 in this checkout (see 0043_wallet_engine.sql's own
-- provenance note): idempotent statement shapes (`CREATE TABLE IF NOT
-- EXISTS`, FK constraints in guarded `DO $$` blocks, `CREATE INDEX IF NOT
-- EXISTS`), safe to re-run.
--
-- MIGRATION SLOT: journal idx 60 / file 0059. Originally pre-assigned slot
-- 0058 (spec PR #1501 / plan.md Global Constraints, at a time when
-- `0057_guardrail_events` — journal idx 58 — was the tip). By the time this
-- migration was authored, `0058_thread_engagement.sql` (PR #1500, "threads
-- stay one-on-one until Jace is re-mentioned") had already landed on main
-- and claimed both file-number 0058 AND journal idx 59. Per this
-- checkout's own reservation-collision precedent (see
-- `0051_stripe_events.sql` and `0057_guardrail_events.sql`'s own "MIGRATION
-- SLOT" notes: an already-landed migration's slot is permanent, never
-- renumbered), this migration takes the next free slot instead. Do not
-- renumber this file.
DO $$ BEGIN
 CREATE TYPE "public"."investigation_status" AS ENUM('open', 'investigating', 'concluded', 'handed_off');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."investigation_severity" AS ENUM('low', 'medium', 'high', 'critical');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."investigation_opened_by" AS ENUM('chat', 'run-outcome', 'alert');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."investigation_verdict" AS ENUM('root_caused', 'undetermined');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."verdict_confidence" AS ENUM('confirmed', 'probable', 'circumstantial');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."investigation_item_kind" AS ENUM('timeline_event', 'evidence', 'hypothesis', 'finding', 'verdict', 'lesson_candidate');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."hypothesis_state" AS ENUM('open', 'supported', 'refuted', 'inconclusive');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."investigation_authority" AS ENUM('human', 'jace');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."investigation_link_role" AS ENUM('recurrence_of', 'related');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."investigation_issue_role" AS ENUM('mitigative', 'preventative');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "investigations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"repository_id" uuid,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"status" "investigation_status" DEFAULT 'open' NOT NULL,
	"severity" "investigation_severity" DEFAULT 'medium' NOT NULL,
	"opened_by" "investigation_opened_by" DEFAULT 'chat' NOT NULL,
	"symptom_statement" text NOT NULL,
	"symptom_signature" text DEFAULT '' NOT NULL,
	"affected_surface" text DEFAULT '' NOT NULL,
	"first_seen_at" timestamp with time zone,
	"verdict" "investigation_verdict",
	"confidence" "verdict_confidence",
	"depth_budget" integer DEFAULT 8 NOT NULL,
	"jace_session_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investigations_workspace_id_slug_unique" UNIQUE("workspace_id","slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "investigation_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"investigation_id" uuid NOT NULL,
	"kind" "investigation_item_kind" NOT NULL,
	"body" text NOT NULL,
	"mechanism" text DEFAULT '' NOT NULL,
	"state" "hypothesis_state",
	"evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"authority" "investigation_authority" DEFAULT 'jace' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "investigation_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"investigation_id" uuid NOT NULL,
	"target_investigation_id" uuid NOT NULL,
	"role" "investigation_link_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "investigation_issue_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"investigation_id" uuid NOT NULL,
	"repo" text NOT NULL,
	"issue_number" integer NOT NULL,
	"role" "investigation_issue_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "investigations" ADD CONSTRAINT "investigations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "investigations" ADD CONSTRAINT "investigations_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "investigation_items" ADD CONSTRAINT "investigation_items_investigation_id_investigations_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "investigation_links" ADD CONSTRAINT "investigation_links_investigation_id_investigations_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Constraint name shortened from the mechanical
-- <table>_<col>_<foreignTable>_<foreignCol>_fk template (every other FK
-- below follows it verbatim) because the full form —
-- investigation_links_target_investigation_id_investigations_id_fk — is 64
-- bytes, one over Postgres's 63-byte NAMEDATALEN identifier limit.
-- drizzle-orm's own ForeignKey.getName() (pg-core/foreign-keys.ts) has no
-- truncation guard either, so `drizzle-kit generate` would silently hit the
-- same Postgres truncation this migration was caught applying by hand
-- (verified against a real apply, not just inspection) — this is not a
-- hand-authoring-specific gap. Drops only the redundant trailing "_id" off
-- the referenced column mention (a FK's target is always "id" in this
-- schema) so the local column name — the more useful grep target — stays
-- fully spelled out.
DO $$ BEGIN
 ALTER TABLE "investigation_links" ADD CONSTRAINT "investigation_links_target_investigation_id_investigations_fk" FOREIGN KEY ("target_investigation_id") REFERENCES "public"."investigations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "investigation_issue_links" ADD CONSTRAINT "investigation_issue_links_investigation_id_investigations_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Postgres does not index a foreign key automatically. These four are hit by
-- getInvestigationBySlug/computeVerdictEligibility ("WHERE investigation_id
-- = …") and by every cascade delete off investigations — plain b-tree, no
-- functional expression needed (mirrors brief_items_brief_id_idx, 0055).
CREATE INDEX IF NOT EXISTS "investigation_items_investigation_id_idx" ON "investigation_items" USING btree ("investigation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "investigation_links_investigation_id_idx" ON "investigation_links" USING btree ("investigation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "investigation_links_target_investigation_id_idx" ON "investigation_links" USING btree ("target_investigation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "investigation_issue_links_investigation_id_idx" ON "investigation_issue_links" USING btree ("investigation_id");
--> statement-breakpoint
-- FTS indexes backing searchInvestigations' websearch_to_tsquery prefilter
-- (mirrors briefs_title_fts_idx / brief_items_statement_fts_idx, 0055): the
-- two-argument to_tsvector('english', …) form is IMMUTABLE so it can be
-- indexed, unlike the one-arg form which is STABLE and reads the
-- session-local config. investigations_title_fts_idx covers title AND
-- symptom_signature in one expression so recurrence search matches either;
-- item-body matching (the third leg of searchInvestigations' FTS surface)
-- runs the same to_tsvector expression uncached via a LEFT JOIN +
-- string_agg per query, same posture as briefs' item-statement matching.
CREATE INDEX IF NOT EXISTS "investigations_title_fts_idx"
  ON "investigations"
  USING gin (to_tsvector('english', "title" || ' ' || "symptom_signature"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "investigation_items_body_fts_idx"
  ON "investigation_items"
  USING gin (to_tsvector('english', "body"));
