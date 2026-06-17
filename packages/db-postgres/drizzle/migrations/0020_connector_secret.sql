-- Connector credentials (https / mcp / gateway catalog expansion).
-- Credential-based connectors (mcp: linear/figma/context7; gateway: slack/telegram)
-- store a per-workspace, write-only credential here: the MCP API key or the gateway
-- secret (slack webhook URL, telegram bot token). The value is NEVER returned to the
-- client — the read model exposes only `hasSecret` + a masked target; the daemon reads
-- the raw value via getConnectorSecret. Discord keeps its legacy workspaces.discord_webhook_url;
-- GitHub (https) carries no secret (it connects at OAuth login). Additive, nullable.
ALTER TABLE "connectors" ADD COLUMN IF NOT EXISTS "secret" text;
