import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  listWorkspaceRepositories,
  listChatIdentitiesForWorkspace,
  getConnectors,
  getGithubInstallation,
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
 * Connection signal: GitHub counts as connected once the Jace GitHub App is
 * installed on the workspace's account (spec 2026-07-24-jace-github-app-
 * identity §5) OR ≥1 repo is linked — the OR keeps a workspace that connected
 * before the App migration (repo-linked, no installation row) reading as
 * connected, and a freshly-installed workspace with zero repos yet reading as
 * connected too, instead of dead-ending on "not installed" copy until it
 * happens to link a repo. Linear/Figma/Context7 count as connected once their
 * API key/token is stored (`hasSecret`). Channel kinds — Discord, Slack,
 * Telegram (Gateway → Channels cutover) — have no credential to store here at
 * all: each counts as connected once the workspace has ≥1 linked chat identity
 * for that platform (`listChatIdentitiesForWorkspace`), recorded when someone
 * DMs the shared Jace bot. The stored connector row, where one exists, still
 * overlays the enabled/label/interval Heartbeat config the daemon reads.
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
    const [repos, identities, storedConnectors, githubInstallation] =
      await Promise.all([
        listWorkspaceRepositories(workspaceId),
        listChatIdentitiesForWorkspace(workspaceId),
        getConnectors(workspaceId),
        getGithubInstallation(workspaceId),
      ]);
    const byProvider = new Map(storedConnectors.map((c) => [c.provider, c]));
    const githubRow = byProvider.get("github");

    // Connected once the App is installed OR a repo is linked — see the
    // module doc-comment above for why this is an OR, not a replacement.
    const githubConnected = githubInstallation !== null || repos.length > 0;

    // Project a credential (mcp) connector from its stored row: connected iff
    // a credential is stored (`hasSecret`), with the folded-in trigger config.
    // The raw secret never leaves the DB layer. Channel kinds (discord/slack/
    // telegram) never derive `connected` this way — see `triggerConfig` below.
    const secretConfig = (
      kind: ConnectorConfigInput["kind"]
    ): ConnectorConfigInput => {
      const row = byProvider.get(kind);
      return {
        kind,
        hasSecret: Boolean(row?.hasSecret),
        ingestLabel: row?.config.triggerLabel ?? "ready-for-agent",
        enabled: row?.enabled,
        triggerLabel: row?.config.triggerLabel,
        pollIntervalSeconds: row?.config.pollIntervalSeconds,
      };
    };

    // A channel kind (discord/slack/telegram) may still have a connector row
    // (e.g. telegram's onboarding `channelSkippedAt`) carrying Heartbeat
    // trigger config — but that row no longer contributes `connected` state:
    // `projectConnectors` derives a channel kind's `connected` solely from
    // `identities` below. Pass the trigger-config fields through generically,
    // the same shape any provider's row carries.
    const triggerConfig = (
      kind: ConnectorConfigInput["kind"]
    ): ConnectorConfigInput => {
      const row = byProvider.get(kind);
      return {
        kind,
        enabled: row?.enabled,
        triggerLabel: row?.config.triggerLabel,
        pollIntervalSeconds: row?.config.pollIntervalSeconds,
      };
    };

    const configs: ConnectorConfigInput[] = [
      {
        kind: "github",
        connected: githubConnected,
        // Distinct from `githubConnected`: the App may not actually be
        // installed for a pre-App workspace connected only via linked repos
        // (see the module doc-comment). Lets the card still offer the
        // install affordance in that case instead of dead-ending on prose.
        appInstalled: githubInstallation !== null,
        // The label the GitHub adapter ingests by (afk/github.list_queue_issues).
        ingestLabel: githubRow?.config.triggerLabel ?? "ready-for-agent",
        // Prefer the repo count/name once any are linked; an installed-but-
        // no-repos-yet workspace shows the installed account instead of a
        // misleading "0 repositories".
        target:
          repos.length > 0
            ? repos.length === 1
              ? repos[0].name
              : `${repos.length} repositories`
            : (githubInstallation?.accountLogin ?? null),
        // Heartbeat trigger config folded in from the connector row (#816).
        enabled: githubRow?.enabled,
        triggerLabel: githubRow?.config.triggerLabel,
        pollIntervalSeconds: githubRow?.config.pollIntervalSeconds,
      },
      // MCP key connectors — connected once an API key is stored.
      secretConfig("linear"),
      secretConfig("figma"),
      secretConfig("context7"),
      // Channels — Jace-native chat; `connected` derives from a linked chat
      // identity (`identities`, passed to `projectConnectors` below), never
      // from a stored credential or webhook.
      triggerConfig("discord"),
      triggerConfig("slack"),
      triggerConfig("telegram"),
    ];
    return NextResponse.json({
      connectors: projectConnectors(
        configs,
        // Map to the fields `projectConnectors` actually consumes — never
        // forward `platformUserId` into the response (`linkedIdentities` is a
        // display-name-only surface; see `ConnectorView`).
        identities.map((identity) => ({
          platform: identity.platform,
          displayName: identity.displayName,
        }))
      ),
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
