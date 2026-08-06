CREATE TABLE IF NOT EXISTS "acceptance_context_packs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"record_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"phase" text NOT NULL,
	"content_hash" text NOT NULL,
	"compiler_version" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"custody" jsonb NOT NULL,
	"freshness" jsonb NOT NULL,
	"json_artifact_ref" text,
	"markdown_artifact_ref" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "acceptance_context_packs" ADD CONSTRAINT "acceptance_context_packs_record_id_change_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."change_records"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_context_packs_record_version_key" ON "acceptance_context_packs" USING btree ("record_id","version");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_context_packs_record_content_hash_key" ON "acceptance_context_packs" USING btree ("record_id","content_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptance_context_packs_record_created_idx" ON "acceptance_context_packs" USING btree ("record_id","created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "acceptance_context_pack_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"context_pack_id" uuid NOT NULL,
	"delivery_key" text NOT NULL,
	"method" text NOT NULL,
	"recipient" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"delivered_by" text NOT NULL,
	"delivered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "acceptance_context_pack_deliveries" ADD CONSTRAINT "acceptance_context_pack_deliveries_context_pack_id_acceptance_context_packs_id_fk" FOREIGN KEY ("context_pack_id") REFERENCES "public"."acceptance_context_packs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_context_pack_deliveries_pack_key" ON "acceptance_context_pack_deliveries" USING btree ("context_pack_id","delivery_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptance_context_pack_deliveries_pack_delivered_idx" ON "acceptance_context_pack_deliveries" USING btree ("context_pack_id","delivered_at");
