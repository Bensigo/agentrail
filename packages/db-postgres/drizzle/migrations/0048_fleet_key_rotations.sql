-- Fleet key self-heal (fix: the hosted fleet silently stops claiming for a
-- workspace whenever its container restarts — every Railway redeploy, or a
-- bare restart, wipes the on-disk fleet-credentials.json store while the
-- console still reports an active fleet key, so the ordinary sync route
-- refuses to mint a replacement). fleet_key_rotations is the audit trail +
-- cooldown source for POST /api/v1/fleet/workspace-tokens/self-heal: one row
-- per atomic revoke-old+mint-new rotation, naming which fleet instance asked
-- and when, so the route's cooldown guard (env-tunable,
-- FLEET_SELF_HEAL_COOLDOWN_SECONDS) can refuse a second rotation for the same
-- workspace too soon — the anti-ping-pong guard for two overlapping deploy
-- instances. See packages/db-postgres/src/schema/fleet_key_rotations.ts.
CREATE TABLE IF NOT EXISTS "fleet_key_rotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"fleet_instance_id" text NOT NULL,
	"old_key_id" uuid,
	"new_key_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fleet_key_rotations" ADD CONSTRAINT "fleet_key_rotations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fleet_key_rotations" ADD CONSTRAINT "fleet_key_rotations_old_key_id_api_keys_id_fk" FOREIGN KEY ("old_key_id") REFERENCES "public"."api_keys"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fleet_key_rotations" ADD CONSTRAINT "fleet_key_rotations_new_key_id_api_keys_id_fk" FOREIGN KEY ("new_key_id") REFERENCES "public"."api_keys"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fleet_key_rotations_workspace_id_created_at_idx" ON "fleet_key_rotations" USING btree ("workspace_id","created_at");
