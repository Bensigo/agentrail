-- Briefs: Jace's durable, server-side understanding of ONE product idea
-- (docs/superpowers/specs/2026-07-28-jace-briefs-durable-idea-understanding-design.md,
-- spec PR #1487).
--
-- Replaces the `grill-me` skill's old instruction to write CONTEXT.md into
-- the repo — impossible in the hosted deployment (no git checkout), so those
-- writes died in an ephemeral sandbox and a grilling session never survived
-- past its own conversation. `briefs` is long-lived and keyed
-- (workspace_id, slug): reopening the same idea months later upserts the
-- SAME row rather than forking a new brief. `brief_items` is the typed,
-- per-requirement content (mirrors memory_items' typed-row-over-prose
-- shape); `brief_work_links` records which issues a brief actually produced,
-- since that link is the only way to later answer "what shipped for this
-- idea". Deleting a workspace cascades through both child tables; deleting
-- a repository only detaches it (SET NULL) — a brief outlives the repo
-- connection that happened to exist when it was written.
DO $$ BEGIN
 CREATE TYPE "public"."brief_status" AS ENUM('draft', 'ready');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."brief_area" AS ENUM('problem', 'users', 'constraints', 'scope', 'success-signal');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."brief_item_kind" AS ENUM('required', 'optional', 'unknown', 'out-of-scope');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."brief_item_state" AS ENUM('open', 'resolved');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."brief_item_resolution" AS ENUM('implemented', 'deferred', 'rejected', 'satisfied-elsewhere');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."brief_authority" AS ENUM('human', 'jace');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."brief_work_link_role" AS ENUM('epic-parent', 'slice');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "briefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"repository_id" uuid,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"status" "brief_status" DEFAULT 'draft' NOT NULL,
	"open_question" text DEFAULT '' NOT NULL,
	"grounding" jsonb DEFAULT '{"wikiPageSlugs":[],"memoryItemIds":[],"commitSha":null}'::jsonb NOT NULL,
	"jace_session_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "briefs_workspace_id_slug_unique" UNIQUE("workspace_id","slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "brief_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brief_id" uuid NOT NULL,
	"area" "brief_area" NOT NULL,
	"statement" text NOT NULL,
	"evidence" text DEFAULT '' NOT NULL,
	"kind" "brief_item_kind" NOT NULL,
	"state" "brief_item_state" DEFAULT 'open' NOT NULL,
	"resolution" "brief_item_resolution",
	"authority" "brief_authority" DEFAULT 'jace' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "brief_work_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brief_id" uuid NOT NULL,
	"brief_item_id" uuid,
	"repo" text NOT NULL,
	"issue_number" integer NOT NULL,
	"role" "brief_work_link_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "briefs" ADD CONSTRAINT "briefs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "briefs" ADD CONSTRAINT "briefs_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "brief_items" ADD CONSTRAINT "brief_items_brief_id_briefs_id_fk" FOREIGN KEY ("brief_id") REFERENCES "public"."briefs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "brief_work_links" ADD CONSTRAINT "brief_work_links_brief_id_briefs_id_fk" FOREIGN KEY ("brief_id") REFERENCES "public"."briefs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "brief_work_links" ADD CONSTRAINT "brief_work_links_brief_item_id_brief_items_id_fk" FOREIGN KEY ("brief_item_id") REFERENCES "public"."brief_items"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Postgres does not index a foreign key automatically. These three are hit
-- by getBriefBySlug/computeBriefReadiness ("WHERE brief_id = …") and by
-- every cascade delete off briefs/brief_items — plain b-tree, no functional
-- expression needed (mirrors run_outcomes_workspace_id_idx, 0038).
CREATE INDEX IF NOT EXISTS "brief_items_brief_id_idx" ON "brief_items" USING btree ("brief_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brief_work_links_brief_id_idx" ON "brief_work_links" USING btree ("brief_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brief_work_links_brief_item_id_idx" ON "brief_work_links" USING btree ("brief_item_id");
--> statement-breakpoint
-- FTS index backing searchBriefs' websearch_to_tsquery prefilter over
-- title alone (mirrors wiki_pages_body_md_fts_idx, 0047): the two-argument
-- to_tsvector('english', …) form is IMMUTABLE so it can be indexed, unlike
-- the one-arg form which is STABLE and reads the session-local config.
-- Item-statement matching runs the same to_tsvector expression uncached
-- (LEFT JOIN + string_agg per query — briefs are small by construction, see
-- the design spec's "Retrieval" section), so no separate index is needed
-- for that half of the search.
CREATE INDEX IF NOT EXISTS "briefs_title_fts_idx"
  ON "briefs"
  USING gin (to_tsvector('english', "title"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brief_items_statement_fts_idx"
  ON "brief_items"
  USING gin (to_tsvector('english', "statement"));
