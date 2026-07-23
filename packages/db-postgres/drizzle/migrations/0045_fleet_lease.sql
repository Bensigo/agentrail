-- Single-active-fleet lease (issue #1390) — deploy-overlap safety.
--
-- One row per lease name (the fleet uses a single 'fleet-singleton' row) that
-- names the current holder and when its hold expires. The hosted fleet
-- (agentrail/runner/fleet_lease.py) acquires/renews/steals this row with one
-- atomic INSERT ... ON CONFLICT DO UPDATE ... WHERE (holder = me OR expires_at
-- <= now()) so that exactly ONE fleet instance is active (claims + token sync)
-- while overlapping deploy instances stand by. A crashed holder stops renewing;
-- the row self-expires after the TTL and a standby steals it — no manual unlock.
CREATE TABLE IF NOT EXISTS "fleet_leases" (
	"name" text PRIMARY KEY NOT NULL,
	"holder" text NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
