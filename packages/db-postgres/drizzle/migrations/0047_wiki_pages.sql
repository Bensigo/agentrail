-- Repo Wiki: wiki_pages system of record (Repo Wiki spec §4.4, delivery plan
-- §7 row 4 — docs/superpowers/specs/2026-07-23-repo-wiki-compiled-repo-knowledge-design.md).
--
-- One row per compiled wiki page: a repo overview page (slug "wiki/overview")
-- plus one page per Codebase Unit (slug "wiki/unit/<unit-id>"). `body_md` is
-- the canonical compiled artifact agents (and, later, the console) consume;
-- `skeleton` holds the deterministic compile inputs so the compiler can
-- hash-diff without parsing markdown; `links` holds the [[slug]] page graph.
-- Pushed by the compiler (PR 2, still flag-OFF) via
-- POST /api/v1/ingest/wiki-pages, upsert-by-(repository_id, slug) semantics
-- mirroring memory_items' replace-by-writer idempotency. Deleting a
-- workspace or repository cascades — the wiki carries no knowledge
-- independent of its owning repo.
DO $$ BEGIN
 CREATE TYPE "public"."wiki_page_kind" AS ENUM('overview', 'unit');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wiki_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"kind" "wiki_page_kind" NOT NULL,
	"body_md" text NOT NULL,
	"skeleton" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"links" jsonb DEFAULT '{"related":[],"dependsOn":[],"dependedOnBy":[]}'::jsonb NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"commit_sha" text NOT NULL,
	"inputs_hash" text NOT NULL,
	"model" text,
	"written_by" text DEFAULT 'wiki-compiler' NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"stale" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wiki_pages_repository_id_slug_unique" UNIQUE("repository_id","slug")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- FTS index backing searchWikiPages' websearch_to_tsquery prefilter (mirrors
-- memory_items_content_fts_idx, 0026): the two-argument to_tsvector('english', …)
-- form is IMMUTABLE (pins the text-search config so it can be indexed),
-- unlike the one-arg form which is STABLE and reads the session-local config.
CREATE INDEX IF NOT EXISTS "wiki_pages_body_md_fts_idx"
  ON "wiki_pages"
  USING gin (to_tsvector('english', "body_md"));
