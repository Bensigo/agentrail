-- Self-hosted runner device-authorization (OAuth device-flow) records.
-- The runner CLI starts a device flow, shows the operator a short user_code,
-- then polls for a token until a logged-in operator approves it in /activate.
-- On the first poll after approval an api_keys row is minted (the runner token)
-- and stamped here; the code is single-use (consumed_at) and short-lived
-- (expires_at). Additive only.

CREATE TABLE IF NOT EXISTS "device_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_code" text NOT NULL,
	"user_code" text NOT NULL,
	"workspace_id" uuid,
	"api_key_id" uuid,
	"approved" boolean DEFAULT false NOT NULL,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_codes_device_code_unique" UNIQUE("device_code"),
	CONSTRAINT "device_codes_user_code_unique" UNIQUE("user_code")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "device_codes" ADD CONSTRAINT "device_codes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "device_codes" ADD CONSTRAINT "device_codes_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
