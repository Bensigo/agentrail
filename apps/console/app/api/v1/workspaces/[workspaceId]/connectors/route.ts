import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  listWorkspaceRepositories,
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
 * API key/token is stored (`hasSecret`).
 *
 * Chat channels (Discord, Slack, Telegram) are no longer projected by this
 * route — gateways-page T4 moved them to their own surface entirely
 * (`api/v1/workspaces/[workspaceId]/gateways/route.ts`, which reads
 * `listChatIdentitiesForWorkspace` directly).
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
    const [repos, storedConnectors, githubInstallation] = await Promise.all([
      listWorkspaceRepositories(workspaceId),
      getConnectors(workspaceId),
      getGithubInstallation(workspaceId),
    ]);
    const byProvider = new Map(storedConnectors.map((c) => [c.provider, c]));
    const githubRow = byProvider.get("github");

    // Connected once the App is installed OR a repo is linked — see the
    // module doc-comment above for why this is an OR, not a replacement.
    const githubConnected = githubInstallation !== null || repos.length > 0;

    // Project a credential (mcp/observability) connector from its stored
    // row: connected iff a credential is stored (`hasSecret`), with the
    // folded-in trigger config. The raw secret never leaves the DB layer.
    const secretConfig = (
      // Narrower than ConnectorConfigInput["kind"] (== ConnectorKind)
      // deliberately: this helper's call sites are the credential-connected
      // kinds below, and `byProvider` is a `Map<ConnectorProvider, …>` (the
      // DB-level enum, which does not and will never include Task 5's
      // internal-only `"factory"` — see `runner/evidence/route.ts`'s own
      // doc-comment on that decoupling). Widening this to the full
      // `ConnectorKind` union would let a future caller pass `"factory"`
      // here and mis-key `byProvider.get(...)`. Task 7 widens it to include
      // `"railway"` — now a real `ConnectorProvider` member (see
      // `schema/connectors.ts`'s `connectorProviderEnum`), so this stays a
      // deliberate, hand-picked list of REAL provider rows, not a blanket
      // `ConnectorKind`.
      kind: "linear" | "figma" | "context7" | "railway"
    ): ConnectorConfigInput => {
      const row = byProvider.get(kind);
      return {
        kind,
        hasSecret: Boolean(row?.hasSecret),
        ingestLabel: row?.config.triggerLabel ?? "ready-for-agent",
        enabled: row?.enabled,
        triggerLabel: row?.config.triggerLabel,
        pollIntervalSeconds: row?.config.pollIntervalSeconds,
        // Task 7: harmless (always undefined→null) for linear/figma/context7
        // rows, whose ConnectorConfig never carries this field — populated
        // only for the railway row.
        railwayProjectId: row?.config.railwayProjectId ?? null,
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
      // Observability (Task 7) — same connected-once-credentialed shape;
      // without this row the railway card would always project
      // disconnected regardless of a stored token (the exact hand-list gap
      // this task's brief calls out — see secret/route.ts's own
      // "THE BEHAVIOR-DRIVING CHANGE" doc-comment for its twin).
      secretConfig("railway"),
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
    railwayProjectId?: unknown;
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
  // Task 7: the railway connect card's project-id field — see
  // connector-helpers.ts's ConnectorConnectMeta.extraConfigField doc-comment
  // for why this saves here (config path) rather than the secret route.
  if (body.railwayProjectId !== undefined) config.railwayProjectId = body.railwayProjectId;
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
