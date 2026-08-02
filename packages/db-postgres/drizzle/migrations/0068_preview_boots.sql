-- The boot plane's dedicated queue: preview_boots (B2b Task 1, plan
-- docs/superpowers/plans/2026-08-02-b2b-sandbox-boot.md; spec
-- docs/superpowers/specs/2026-08-02-b2-behavioral-evidence-design.md §B2b
-- §4-5). Gives a PR head with no preview URL something to browse — an
-- out-of-process worker clones the head, boots a supervised child process,
-- health-checks it, and reports a private URL back through this table.
--
-- DELIBERATELY NOT `queue_entries` (the plan's topology ruling): the
-- generic queue hardcodes `ref='main'`, is terminal-only, and its `green`
-- path attempts a PR squash-merge — none of which fit a boot that only
-- needs to serve and unconditionally tear down. `id` is caller-supplied
-- (deterministic uuid5 of workspace/repo/pr/head, computed at the call
-- site in the query layer — the `review_jobs.id`/`reviewJobId` precedent,
-- see schema/preview_boots.ts) — deliberately no DEFAULT, so this
-- migration does not stamp one either.
--
-- NOTE ON THIS FILE'S PROVENANCE: hand-authored, NOT `drizzle-kit
-- generate`d — the same pre-existing snapshot-chain gap documented in
-- 0046_github_app_installation.sql, 0064_slack_installations.sql,
-- 0066_review_jobs.sql, and 0067_review_jobs_evidence_keys.sql's own
-- provenance notes (the snapshot chain in `drizzle/migrations/meta/` only
-- covers migrations 0000-0003, so `generate` has no accurate baseline to
-- diff against and drizzle-kit's enum-conflict resolver falls back to an
-- interactive prompt that fails immediately outside a TTY). Follows those
-- migrations' idempotent statement shapes (`CREATE TABLE IF NOT EXISTS`,
-- the FK in its own guarded `DO $$ ... EXCEPTION WHEN duplicate_object`
-- block, `CREATE INDEX IF NOT EXISTS`), so it is safe to re-run.
CREATE TABLE IF NOT EXISTS "preview_boots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"repo" text NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"ref" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"worker_id" text,
	"claimed_at" timestamp with time zone,
	"url" text,
	"port" integer,
	"reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"last_liveness_at" timestamp with time zone,
	"next_eligible_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "preview_boots" ADD CONSTRAINT "preview_boots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "preview_boots_pending_idx" ON "preview_boots" USING btree ("created_at") WHERE "preview_boots"."status" = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "preview_boots_pr_idx" ON "preview_boots" USING btree ("workspace_id","repo","pr_number");
