import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  listWorkspaceRepositories,
  getDiscordWebhookUrl,
  getConnectors,
  upsertConnector,
  validateConnectorUpdate,
  isConnectorProvider,
  type ConnectorUpdate,
} from "@agentrail/db-postgres";
import {
  projectConnectors,
  type ConnectorConfigInput,
} from "../../../../../../app/(dashboard)/dashboard/[workspaceId]/connectors/components/connector-helpers";

/**
 * Connectors read + management surface (M038 AC3; heartbeat folded in, #816).
 *
 * A **Connector** (CONTEXT.md) is the two-way seam between an external tool and
 * the Issue Queue. Adding a connector ALSO configures the autonomous Heartbeat:
 * the `connectors` table carries each connector's trigger config (enabled,
 * label, poll interval) — the standalone heartbeat config is gone, the daemon
 * reads connectors. This route is the surface: GET projects the catalog against
 * the workspace's connection state + stored connector rows (any member); PUT
 * writes a connector's trigger config (owner/admin only).
 *
 * Connection signal: GitHub counts as connected when ≥1 repo is linked; Discord
 * when a webhook is set; Linear once a key is stored (not yet). The stored
 * connector row overlays the enabled/label/interval config the daemon reads.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const [repos, discordWebhookUrl, storedConnectors] = await Promise.all([
      listWorkspaceRepositories(workspaceId),
      getDiscordWebhookUrl(workspaceId),
      getConnectors(workspaceId),
    ]);
    const byProvider = new Map(storedConnectors.map((c) => [c.provider, c]));
    const githubRow = byProvider.get("github");
    const discordRow = byProvider.get("discord");
    const linearRow = byProvider.get("linear");

    const githubConnected = repos.length > 0;
    const configs: ConnectorConfigInput[] = [
      {
        kind: "github",
        connected: githubConnected,
        // The label the GitHub adapter ingests by (afk/github.list_queue_issues).
        ingestLabel: githubRow?.config.triggerLabel ?? "ready-for-agent",
        target: githubConnected
          ? repos.length === 1
            ? repos[0].name
            : `${repos.length} repositories`
          : null,
        // Heartbeat trigger config folded in from the connector row (#816).
        enabled: githubRow?.enabled,
        triggerLabel: githubRow?.config.triggerLabel,
        pollIntervalSeconds: githubRow?.config.pollIntervalSeconds,
      },
      {
        // Discord notify connector: connected iff a webhook is set. The read
        // model only ever exposes the masked target, never the token.
        kind: "discord",
        connected: Boolean(discordWebhookUrl),
        webhookUrl: discordWebhookUrl,
        enabled: discordRow?.enabled,
        triggerLabel: discordRow?.config.triggerLabel,
        pollIntervalSeconds: discordRow?.config.pollIntervalSeconds,
      },
      {
        // Linear adapter (agentrail/connectors/linear.py). No durable Linear API
        // key store yet, so this is honestly not-connected until one exists.
        kind: "linear",
        connected: false,
        ingestLabel: linearRow?.config.triggerLabel ?? "ready-for-agent",
        target: null,
        enabled: linearRow?.enabled,
        triggerLabel: linearRow?.config.triggerLabel,
        pollIntervalSeconds: linearRow?.config.pollIntervalSeconds,
      },
    ];
    return NextResponse.json({
      connectors: projectConnectors(configs),
      canManage: membership.role === "owner" || membership.role === "admin",
    });
  } catch (err) {
    console.error("[connectors] failed to project connectors:", err);
    return NextResponse.json(
      { error: "Failed to load connectors" },
      { status: 500 }
    );
  }
}

/**
 * Manage a connector's Heartbeat trigger config (enabled / label / interval).
 * Owner/admin only. Body: `{ provider, enabled?, triggerLabel?, pollIntervalSeconds? }`.
 * This is the control surface that replaced the standalone Heartbeat page (#816):
 * the daemon reads these connector rows via list_active_connectors.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (membership.role !== "owner" && membership.role !== "admin") {
    return NextResponse.json(
      { error: "Only an owner or admin can manage connectors" },
      { status: 403 }
    );
  }

  let body: {
    provider?: unknown;
    enabled?: unknown;
    triggerLabel?: unknown;
    pollIntervalSeconds?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!isConnectorProvider(body.provider)) {
    return NextResponse.json(
      { error: "provider must be one of github, linear, discord" },
      { status: 400 }
    );
  }

  // Build a connector update from the flat body and validate it.
  const update: ConnectorUpdate = {};
  if (body.enabled !== undefined) update.enabled = body.enabled as boolean;
  const config: Record<string, unknown> = {};
  if (body.triggerLabel !== undefined) config.triggerLabel = body.triggerLabel;
  if (body.pollIntervalSeconds !== undefined)
    config.pollIntervalSeconds = body.pollIntervalSeconds;
  if (Object.keys(config).length > 0)
    update.config = config as ConnectorUpdate["config"];

  const result = validateConnectorUpdate(update);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  try {
    const connector = await upsertConnector(
      workspaceId,
      body.provider,
      result.value
    );
    return NextResponse.json({ connector });
  } catch (err) {
    console.error("[connectors] failed to save connector config:", err);
    return NextResponse.json(
      { error: "Failed to save connector config" },
      { status: 500 }
    );
  }
}
