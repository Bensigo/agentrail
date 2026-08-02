-- Attribute a Slack installation to the AgentRail workspace that started it.
--
-- BUGFIX: the console's Gateways page showed "Add to Slack" forever. Slack is
-- the one gateway whose connect act is an OAuth INSTALL rather than a
-- conversation, and 0064 deliberately gave `slack_installations` no
-- `workspace_id` (an install can legitimately precede any AgentRail
-- workspace — see schema/slack_installations.ts). The cost of that choice was
-- that NOTHING linked a completed install back to the workspace whose page
-- rendered the button, so the page could never learn the install had
-- happened and kept rendering the CTA.
--
-- NULLABLE, and ON DELETE SET NULL, precisely to preserve 0064's property: an
-- App Directory install with no console session still stores fine with a null
-- here, and deleting a workspace must not delete a live Slack installation
-- (its bot token is still what Slack posts with — orphan it, don't drop it).
--
-- Hand-authored, NOT `drizzle-kit generate`d, following 0064's idempotent
-- statement shapes so it is safe to re-run.
ALTER TABLE "slack_installations"
	ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE SET NULL;
--> statement-breakpoint
-- The console reads installations BY workspace on every Gateways page load.
CREATE INDEX IF NOT EXISTS "slack_installations_workspace_id_idx"
	ON "slack_installations" ("workspace_id");
