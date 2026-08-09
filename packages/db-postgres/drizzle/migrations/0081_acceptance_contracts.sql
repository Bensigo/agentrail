ALTER TABLE "change_records" ADD COLUMN IF NOT EXISTS "work_key" text;
ALTER TABLE "change_records" ADD COLUMN IF NOT EXISTS "origin_channel" text;
ALTER TABLE "change_records" ADD COLUMN IF NOT EXISTS "source_references" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "change_records_work_key" ON "change_records" USING btree ("workspace_id","repo","work_key") WHERE "change_records"."work_key" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "acceptance_contracts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"record_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"contract" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "acceptance_contracts" ADD CONSTRAINT "acceptance_contracts_record_id_change_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."change_records"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_contracts_record_version_key" ON "acceptance_contracts" USING btree ("record_id","version");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_contracts_one_confirmed_per_record" ON "acceptance_contracts" USING btree ("record_id") WHERE "acceptance_contracts"."status" = 'confirmed';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptance_contracts_record_created_idx" ON "acceptance_contracts" USING btree ("record_id","created_at");
