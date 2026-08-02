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
  type ConnectorProvider,
} from "@agentrail/db-postgres";
import {
  CONNECTOR_CATALOG,
  extraConfigFieldKeys,
  projectConnectors,
  projectExtraConfigValues,
  type ConnectorConfigInput,
} from "../../../../../../app/(dashboard)/dashboard/[workspaceId]/connectors/components/connector-helpers";
import { oauthAdapterFor, oauthConfigFor, missingOauthEnv } from "../../../../../../lib/oauth/types";
// W3-T2: registers the `railway` OAuth adapter — see the oauth callback
// route's identical import for the full "REACHABILITY" reasoning (this GET
// route is the third and last place `oauthAdapterFor`/`oauthConfigFor` are
// called at runtime, deriving `oauthReady` below). W3-T3: `lib/oauth/
// sentry.ts` registers the same way. W3-T6: `lib/oauth/cloudflare.ts`
// registers the same way.
import "../../../../../../lib/oauth/railway";
import "../../../../../../lib/oauth/sentry";
import "../../../../../../lib/oauth/cloudflare";

/**
 * Every non-secret config key any catalog entry declares via
 * `connect.extraConfigFields` (Task P0, generalizes Task 7's single
 * hand-listed `railwayProjectId`) — computed once at module load, mirroring
 * `secret/route.ts`'s `CREDENTIAL_PROVIDERS`. The PUT handler below accepts
 * any key in this set generically instead of hand-listing each provider's
 * field name, so a NEW provider's field (P2-P8) reaches
 * `validateConnectorUpdate` with zero route changes.
 */
const EXTRA_CONFIG_KEYS = extraConfigFieldKeys();

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
  // Hoisted once so both `oauthSetup`'s own per-provider gate below AND the
  // response's own `canManage` field read the EXACT same boolean — W3-T8's
  // own brief calls for "the role check matches how the connectors page
  // already gates admin-only actions," so this is that check, reused, not
  // a second hand-copied comparison that could drift from it.
  const canManage = membership.role === "owner" || membership.role === "admin";

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

    // Project every credential (mcp/observability) connector from its
    // stored row, generically (Task P0 generalization of Task 7's
    // hand-picked secretConfig("linear")/("figma")/("context7")/("railway")
    // call sites — the exact hand-list gap that task's own brief called
    // out): connected iff a credential is stored (`hasSecret`), with the
    // folded-in trigger config, plus whatever `extraConfigFields` values its
    // row's config carries (`projectExtraConfigValues`). A NEW provider
    // (P2-P8) needs only its catalog entry + `connectorProviderEnum` member
    // for this to project it correctly — no route change. The raw secret
    // never leaves the DB layer.
    const secretConnectors: ConnectorConfigInput[] = CONNECTOR_CATALOG.filter(
      (entry) => entry.connectMethod === "secret" && entry.availability !== "internal"
    ).map((entry) => {
      // Safe cast: filtered to real credential-based, non-internal catalog
      // entries above — exactly the ConnectorProvider members `byProvider`
      // is keyed by. (Task 5's internal-only `factory` kind — NOT a real
      // ConnectorProvider — is excluded by the `availability !== "internal"`
      // filter just above, so it never reaches `byProvider.get`.)
      const row = byProvider.get(entry.kind as ConnectorProvider);
      return {
        kind: entry.kind,
        hasSecret: Boolean(row?.hasSecret),
        ingestLabel: row?.config.triggerLabel ?? "ready-for-agent",
        enabled: row?.enabled,
        triggerLabel: row?.config.triggerLabel,
        pollIntervalSeconds: row?.config.pollIntervalSeconds,
        ...projectExtraConfigValues(entry, row?.config as Record<string, unknown> | undefined),
        // W3-T1 (OAuth Connect Wave 3, `.superpowers/sdd/plan-oauth.md`):
        // derived, env-computed-server-side — a registered adapter
        // (`oauthAdapterFor`) AND the provider's generic
        // `<KIND>_OAUTH_CLIENT_ID`/`_OAUTH_CLIENT_SECRET` env pair
        // (`oauthConfigFor`) AND — W3-T3 fix round — the adapter's OWN
        // optional `envReady()` (Sentry's third var,
        // `SENTRY_OAUTH_INTEGRATION_SLUG`; absent on an adapter defaults to
        // ready, matching every provider before Sentry) must ALL be
        // present. Never hardcoded client-side — see `connector-helpers.ts`'s
        // `ConnectorConfigInput.oauthReady` doc-comment for why these
        // checks, not env alone.
        oauthReady:
          oauthAdapterFor(entry.kind) !== null &&
          oauthConfigFor(entry.kind) !== null &&
          (oauthAdapterFor(entry.kind)?.envReady?.() ?? true),
        // W3-T8 (owner-visible OAuth setup state, `.superpowers/sdd/
        // plan-oauth.md`) — the discoverability fix: `oauthReady` above
        // renders a provider with a registered-but-unconfigured adapter
        // BYTE-IDENTICAL to one with no adapter at all, so the deployment
        // owner had no signal one-click connect existed short of reading
        // source (the user-reported bug this task fixes). `capable: true`
        // iff a registered adapter exists (`oauthAdapterFor` — the set of
        // oauth-CAPABLE providers, derived from the SAME registry
        // `oauthReady` already reads, never a hardcoded list here or in any
        // component); `missingEnv` the env var NAMES still unset
        // (`missingOauthEnv`, never values — metadata, not secrets).
        // ONLY computed for an owner/admin caller (`canManage`, hoisted
        // above from the SAME role check this route already uses to gate
        // `canManage` in the response below) — a member gets `null`, same
        // as a provider with no adapter at all; this route never leaks
        // deployment-shape env var names to a non-admin. Not gated on
        // `oauthReady` itself: `missingEnv` naturally becomes `[]` once
        // every var is set, so `oauthSetup`'s presence answers "is this
        // provider oauth-capable, for this caller" independent of "is it
        // ready right now" — see `connector-helpers.ts`'s
        // `ConnectorConfigInput.oauthSetup` doc-comment for why the two
        // stay orthogonal rather than one suppressing the other here.
        oauthSetup:
          canManage && oauthAdapterFor(entry.kind) !== null
            ? { capable: true as const, missingEnv: missingOauthEnv(entry.kind) }
            : null,
      };
    });

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
      ...secretConnectors,
    ];
    return NextResponse.json({
      connectors: projectConnectors(configs),
      canManage,
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
    // Task P0: any catalog-declared extraConfigFields key (railwayProjectId,
    // and — once P2-P8 land — langfuseHost, sentryOrg, …) arrives here
    // generically; see EXTRA_CONFIG_KEYS above.
    [key: string]: unknown;
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
  // Generic extra-config acceptance (Task P0 generalization of Task 7's
  // single hand-listed `railwayProjectId` check): every key ANY catalog
  // entry declares via `connect.extraConfigFields` is accepted here,
  // generically — a NEW provider's field (P2-P8) reaches
  // `validateConnectorUpdate` with zero route changes. See
  // connector-helpers.ts's own doc-comment on
  // `ConnectorConnectMeta.extraConfigFields`.
  for (const key of EXTRA_CONFIG_KEYS) {
    if (body[key] !== undefined) config[key] = body[key];
  }
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
