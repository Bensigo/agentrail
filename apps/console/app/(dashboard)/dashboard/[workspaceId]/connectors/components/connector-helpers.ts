/**
 * Pure model for the **Connectors** management surface (M038, AC3 + catalog
 * expansion; #1292 issue-source rename; gateways-page T4 strips chat channels
 * out of this surface entirely).
 *
 * A **Connector** (CONTEXT.md, ADR 0010) is the seam between an external tool and
 * AgentRail. The catalog groups the cards by ROLE (what the connector is FOR),
 * not by connect mechanism — the two groups are:
 *
 *   - **issue-source** — feeds the Issue Queue: a labeled issue from the source
 *     is admitted into the queue through the input-contract gate, and results
 *     post back. GitHub (connected at OAuth login) and Linear (a per-workspace
 *     API key + a real-time webhook — #1292) are both issue sources; Linear ALSO
 *     exposes its tools over MCP, but its PRIMARY role is ingest, so it lives
 *     here, next to GitHub, rather than being misfiled as a mere tool.
 *   - **mcp**    — Model-Context-Protocol tool servers the agent can call, with
 *     NO ingest. Figma, Context7: each stores a per-workspace API key/token
 *     (write-only) and exposes its tools to a run.
 *
 * Chat channels (Discord, Slack, Telegram) used to be a third `channel` group
 * here (the #1449 Gateway → Channels cutover). The owner ruled that where a
 * human talks to Jace (a **gateway**) is a different surface from a tool wired
 * into the factory (a **connector**), so channels now live entirely on their
 * own Gateways page/route (`gateways/components/gateway-helpers.ts` +
 * `api/v1/workspaces/[workspaceId]/gateways/route.ts`) — this module no longer
 * knows about them at all.
 *
 * This module is the pure projection the console reads (no I/O, unit-testable):
 * the catalog, the per-provider connect metadata, and how a connector's
 * *connected* state is derived from the workspace's stored config. The adapter
 * implementations live in `agentrail/connectors/`; this surface only lets a
 * team connect and manage them — it never decides admission (the
 * input-contract gate's job, server-side).
 */

import type { EvidenceVerb } from "../../../../../../lib/evidence/types";
import { splitCompositeSecret } from "../../../../../../lib/evidence/composite-secret";

/**
 * The external tools AgentRail can connect (M038 catalog), plus `factory` —
 * Task 5's `availability: "internal"` evidence-only entry (this console's
 * own runs/failure-events; nothing to connect, see
 * {@link ConnectorAvailability}'s own doc-comment) — `railway` (Task 7),
 * the first EXTERNAL evidence-only-role connector: deployments + logs for
 * the debugging investigator, over the workspace's Railway account/team
 * token — `langfuse` (Task P2, Evidence Providers Wave 2,
 * `.superpowers/sdd/plan-providers.md`), the first Wave-2 provider: traces +
 * observation-level signals over a per-workspace public/secret API key
 * pair — `sentry` (Task P3, Evidence Providers Wave 2), the second
 * Wave-2 provider: issue search + RED-shaped signals over a per-workspace
 * SINGLE auth token (org or user), scoped by org+project extra config — and
 * `datadog` (Task P4, Evidence Providers Wave 2), the third Wave-2 provider:
 * USE-shaped host signals + log search over a per-workspace apiKey+appKey
 * composite pair, scoped by a site extra config — and `prometheus` (Task P5,
 * Evidence Providers Wave 2), the fourth Wave-2 provider: RED/USE-shaped
 * instant-query signals over a per-workspace SINGLE secret (bearer token OR
 * `user:pass` for Basic auth, disambiguated at read time — no declared
 * composite split), scoped by a base-URL extra config — and `grafana`
 * (Task P6, Evidence Providers Wave 2), the fifth Wave-2 provider:
 * Grafana-managed alert state changes + annotations as `search_events`
 * (PIVOTED from the plan's believed `signals`-via-datasource-proxy shape —
 * see `lib/evidence/grafana.ts`'s own doc-comment, "PIVOT DECISION," for the
 * doc-verify trail) over a per-workspace SINGLE service-account-token
 * secret, scoped by a base-URL extra config — `vercel` (Task P7,
 * Evidence Providers Wave 2), the sixth Wave-2 provider: deployments as
 * `changes`, deployment build/runtime events as `search_events`, over a
 * per-workspace SINGLE Access Token, scoped by a required project id and
 * an OPTIONAL team id (the first Wave-2 provider with an optional extra
 * config field — a personal-account-scoped Vercel project has no team) —
 * and `cloudflare` (Task P8, Evidence Providers Wave 2), the FINAL Wave-2
 * provider: edge-traffic signals + firewall/security events as
 * `search_events`, both over Cloudflare's GraphQL Analytics API, a
 * per-workspace SINGLE API Token, scoped by a required zone id (no account
 * id needed — see `lib/evidence/cloudflare.ts`'s own doc-comment).
 */
export type ConnectorKind =
  | "github"
  | "linear"
  | "figma"
  | "context7"
  | "factory"
  | "railway"
  | "langfuse"
  | "sentry"
  | "datadog"
  | "prometheus"
  | "grafana"
  | "vercel"
  | "cloudflare";

/**
 * Which catalog group a connector belongs to (drives the page sections). Grouped
 * by ROLE: `issue-source` (GitHub, Linear — feed the Issue Queue), `mcp`
 * (Figma, Context7 — tools only), `observability` (Task 7: Railway — evidence
 * for debugging investigations, no ingest). (#1292 renamed the former
 * connect-mechanism `https` group to the role-based `issue-source`, and moved
 * Linear into it from `mcp`. Gateways-page T4 removed the third group,
 * `channel` — chat channels live on their own Gateways surface now, see the
 * module doc-comment.)
 */
export type ConnectorType = "issue-source" | "mcp" | "observability";

/**
 * How a connector's catalog entry is classified for its connect flow:
 *  - `oauth`   — comes online at login (GitHub); nothing to paste here.
 *  - `secret`  — store a per-workspace API key / token (Linear, Figma,
 *    Context7).
 */
export type ConnectorConnectMethod = "oauth" | "secret";

/**
 * Whether an adapter is implemented today, vs. planned in a follow-up, vs.
 * `"internal"` — a capability-only entry over this console's OWN data (Task
 * 5's `factory` evidence adapter: runs/failure-events, nothing to connect).
 * An `internal` entry exists in the catalog purely so `evidenceCapabilities`
 * (`lib/evidence/registry.ts`) can find its declared evidence verbs; it is
 * filtered OUT of the connectors page grid ({@link projectConnectors}) — a
 * card with no connect flow and nothing to show status for would only
 * confuse the surface it's not meant to appear on.
 */
export type ConnectorAvailability = "available" | "planned" | "internal";

/** A connector's connection state on this workspace. */
export type ConnectorStatus = "connected" | "disconnected";

/** The two-way capabilities a connector exposes (CONTEXT.md vocabulary). */
export interface ConnectorCapabilities {
  /** Pulls labeled issues into the Issue Queue through the input-contract gate. */
  ingest: boolean;
  /** Posts the run's terminal outcome back to the source issue. */
  postResult: boolean;
  /** Notifies a channel on completion / escalation. */
  notify: boolean;
  /** Exposes MCP tools / context to a run. */
  tools?: boolean;
  /**
   * The evidence verbs (debugging design spec) this connector can answer
   * once connected — read by `evidenceCapabilities` (`lib/evidence/registry.ts`)
   * to derive, per workspace, which providers can answer which question-shape.
   * Absent for every connector that isn't also an evidence source (this task
   * adds the field; no existing catalog entry populates it yet — Task 7 adds
   * the first real one).
   */
  evidence?: EvidenceVerb[];
}

/** Per-provider connect metadata the card renders (label, placeholder, how-to). */
export interface ConnectorConnectMeta {
  /** Field label for the credential input (e.g. "Linear API key", "Figma access token"). */
  credentialLabel: string;
  /** Placeholder hinting the expected shape (e.g. `lin_api_…`). */
  credentialPlaceholder: string;
  /** A one-line hint about the credential format, shown under the input. */
  credentialHint: string;
  /** Link to the provider's setup docs. */
  helpUrl: string;
  /** Short, ordered "how to create the app / key" steps. */
  setupSteps: string[];
  /**
   * Task P0 (generalizes Task 7's single `extraConfigField`, a
   * reviewer-flagged nit — the target derivation used to hardcode
   * `railwayProjectId`): the non-secret config fields the connect form
   * renders alongside the credential input, IN ORDER (Railway declares one
   * — its project id; the wave's other providers, P2-P8, declare one or
   * more — org, site, host, ids). Saved via the connectors PUT (config
   * path), NOT the secret route — the accept-list there is derived from
   * every catalog entry's declared keys generically (`extraConfigFieldKeys`
   * below), never hand-listed. `connectors-panel.tsx`'s `SecretManage`
   * renders N inputs off this array alone; `projectConnectors` derives a
   * connected card's displayed `target` from the FIRST declared field's
   * value (`firstExtraConfigValue`), also generically. Absent for every
   * provider that needs only the credential itself.
   */
  extraConfigFields?: Array<{
    key: string;
    label: string;
    placeholder: string;
    /** Defaults to required (true) when absent — matches Railway's
     * original always-required single field. Set `false` for an optional
     * companion field. */
    required?: boolean;
  }>;
  /**
   * Task P0: composite-secret display metadata — an entry declaring this
   * stores a TWO-OR-MORE-PART credential (Langfuse `pk-lf-…:sk-lf-…`,
   * Datadog `apiKey:appKey`, …) in the single `connectors.secret` column,
   * joined by `:` (see `apps/console/lib/evidence/composite-secret.ts`'s
   * own doc-comment for the full contract). `connectors-panel.tsx`'s
   * `SecretManage` renders one password input PER declared part instead of
   * the single credential input; the parts are joined client-side right
   * before the PUT. Absent (every provider before this wave) → the
   * original single-input behavior, unaffected.
   */
  secretParts?: Array<{ name: string }>;
  /**
   * Task P0: optional per-part validation, index-aligned with
   * {@link secretParts} — a RegExp SOURCE string (not a RegExp instance, so
   * catalog entries stay plain data) tested against each split part by
   * `validateConnectorCredential`'s generic composite path. A missing
   * entry at an index skips validation for that part (count/non-empty is
   * still enforced by `splitCompositeSecret`). This is what lets a NEW
   * composite (or even single-part) provider add its own credential-shape
   * check WITHOUT a hand-written switch case in `validateConnectorCredential`
   * — declare `secretParts` + `secretPartPatterns` and the generic path
   * handles it. The four providers that predate this wave
   * (linear/figma/context7/railway) declare neither and keep their
   * original hand-written `switch` cases, unaffected.
   */
  secretPartPatterns?: string[];
  /**
   * OAuth Connect Wave 3, W3-T2 (`.superpowers/sdd/plan-oauth.md`): one
   * calm sentence rendered above the OAuth "Connect {label}" primary button
   * when `oauthReady` is true (`connector-sheet.tsx`'s `SecretManage`) —
   * states what the OAuth grant actually covers so an admin clicking
   * "Connect" isn't surprised by the vendor's own consent screen, and
   * reminds them token-paste ("Use an API token instead", the disclosure
   * immediately below it) remains available. Absent for every provider
   * whose `oauthReady` can never be true yet (every provider before this
   * wave, and railway/sentry themselves before their own adapter merges) —
   * `SecretManage` simply renders nothing extra in that case. Provider-
   * specific prose lives here (catalog data), not hardcoded into the
   * component, mirroring every other per-provider string in this file
   * (`credentialHint`, `setupSteps`, …).
   */
  oauthHint?: string;
  /**
   * W3-T8 (owner-visible OAuth setup state, `.superpowers/sdd/plan-oauth.md`)
   * — a pointer to this provider's OWN registration surface (where the
   * deployment owner registers the vendor OAuth app/integration/client and
   * obtains the client id/secret this feature's env vars need), rendered
   * by `OauthSetupNotice` (`connector-sheet.tsx`) alongside the missing
   * env var names, for a provider that HAS a registered adapter but isn't
   * `oauthReady` yet. Doc-verified, not invented — every URL here is
   * either quoted verbatim from the corresponding oauth adapter's own
   * doc-comment, or the un-suffixed rendering of a doc path already named
   * there, confirmed live (2026-08-02):
   *   - railway: the doc page `lib/oauth/railway.ts`'s own doc-comment
   *     names as its "creating-an-app.md" source — confirmed live, titled
   *     around "Creating an app," and its own text is the exact source of
   *     the "Settings → Developer → New OAuth App" click-path ("To
   *     register a new OAuth app, go to your workspace settings, navigate
   *     to Developer, and click New OAuth App"). No workspace-agnostic
   *     in-app URL exists (OAuth apps are workspace-scoped — unlike
   *     Cloudflare's account-context `?to=/:account/...` shorthand below,
   *     Railway has no analogous URL shape), so this points at the doc
   *     page that names the exact steps instead of guessing an app URL.
   *   - sentry: the doc page `lib/oauth/sentry.ts`'s own doc-comment names
   *     as its "public-integration.md" source — confirmed live, titled
   *     "Public Integrations," documents the Redirect URL / Webhook URL
   *     fields this feature's registration needs. Same reasoning as
   *     railway: Sentry's own Developer Settings are org-scoped
   *     (`sentry.io/settings/<org-slug>/developer-settings/`), no
   *     org-agnostic URL exists to link directly.
   *   - cloudflare: taken VERBATIM from `lib/oauth/cloudflare.ts`'s own
   *     doc-comment ("REGISTRATION" section: "direct link
   *     `https://dash.cloudflare.com/?to=/:account/oauth-clients`"), which
   *     itself cites `create-an-oauth-client/index.md`'s "Manage Account >
   *     OAuth clients > Create client" path. Cloudflare's `?to=` shorthand
   *     resolves the caller's own account context, so — unlike
   *     railway/sentry — an actual in-app deep link exists and is used
   *     here directly rather than a docs page.
   * Absent for every provider without a registered adapter (nothing to
   * register) — `OauthSetupNotice` renders no link in that case rather
   * than a broken/invented href.
   */
  oauthRegistrationUrl?: string;
  /**
   * OAuth Connect Wave 3, W3-T4 (`.superpowers/sdd/plan-oauth.md`): one
   * calm sentence stating that API-token connect is this provider's
   * standard integration method — never a "coming soon"/apology framing.
   * UNLIKE {@link oauthHint}, this renders unconditionally in the shared
   * `tokenForm` value (`connector-sheet.tsx`'s `SecretManage`), not gated
   * on `oauthReady` — these four providers' `oauthReady` is never true, so
   * gating it the same way `oauthHint` is would mean it never rendered.
   * Declared by exactly the four providers this wave leaves token-only
   * (Grafana, Prometheus, Langfuse, Datadog — see the design spec's "Out
   * of scope"); absent for every other entry, including railway/sentry
   * (their own `oauthHint` already covers this ground) and every provider
   * that predates this wave.
   */
  tokenStandardNote?: string;
}

/** Static catalog entry for a connector kind. */
export interface ConnectorCatalogEntry {
  kind: ConnectorKind;
  type: ConnectorType;
  connectMethod: ConnectorConnectMethod;
  label: string;
  description: string;
  availability: ConnectorAvailability;
  capabilities: ConnectorCapabilities;
  /** Connect metadata — absent for oauth connectors (nothing to paste). */
  connect?: ConnectorConnectMeta;
}

/** Per-workspace stored configuration for one connector (subset persisted). */
export interface ConnectorConfigInput {
  kind: ConnectorKind;
  /** OAuth connectors (GitHub): truthy when the workspace has linked it. */
  connected?: boolean;
  /**
   * GitHub only: the Jace GitHub App is actually installed on the account
   * (`getGithubInstallation` returned a row) — distinct from `connected`,
   * which also goes true for a pre-App workspace whose repos were linked via
   * the old OAuth flow. Lets the card offer the install affordance even while
   * `connected` is already true. Defaults false when absent.
   */
  appInstalled?: boolean;
  /** Secret connectors (Linear, Figma, Context7, Railway): a credential is stored. */
  hasSecret?: boolean;
  /** The label a connector ingests issues by (GitHub: the AFK ready label). */
  ingestLabel?: string | null;
  /** Repo / project the connector is bound to, for display (GitHub OAuth). */
  target?: string | null;
  /**
   * Heartbeat trigger config, folded in from the standalone heartbeat config
   * (#816). Absent → defaults (enabled, 'ready-for-agent', 60s).
   */
  enabled?: boolean;
  triggerLabel?: string | null;
  pollIntervalSeconds?: number | null;
  /**
   * Task P0 (generalizes Task 7's single hand-typed `railwayProjectId`
   * field): a generic bag for a catalog entry's declared
   * `extraConfigFields` values, keyed by each field's `key` (e.g.
   * `railwayProjectId`, and — once P2-P8 land — `langfuseHost`,
   * `sentryOrg`, …). `projectConnectors` reads a provider's fields off THIS
   * index generically (`cfg?.[fields[0].key]`, see `firstExtraConfigValue`)
   * to derive `ConnectorView.target` — no provider-specific field needed
   * here, ever again. The connectors GET route populates it via
   * `projectExtraConfigValues`. Absent/undefined for a key the workspace
   * hasn't stored, or that no catalog entry declares.
   */
  [key: string]: unknown;
  /**
   * W3-T1 (OAuth Connect Wave 3, `.superpowers/sdd/plan-oauth.md`): whether
   * this provider is ready to offer the OAuth "Connect {label}" primary
   * button today — an adapter is registered for it AND its
   * `<PROVIDER>_OAUTH_CLIENT_ID`/`_OAUTH_CLIENT_SECRET` env pair is set (see
   * `apps/console/lib/oauth/types.ts`'s `oauthAdapterFor`/`oauthConfigFor`).
   * Computed server-side by the connectors GET route (an env read has no
   * business in this "no I/O" pure model — see the module doc-comment) and
   * passed in exactly like `hasSecret`/`enabled`. Absent → `false` (see
   * {@link ConnectorView.oauthReady}).
   */
  oauthReady?: boolean;
  /**
   * W3-T8 (owner-visible OAuth setup state, `.superpowers/sdd/plan-oauth.md`)
   * — the discoverability fix for `oauthReady` above: before this task, a
   * provider with a registered adapter but incomplete env rendered
   * BYTE-IDENTICAL to a provider with no adapter at all (the bare token
   * form, nothing more) — the deployment owner had zero in-product signal
   * one-click connect existed short of reading source (the user-reported
   * bug this task fixes). `capable: true` whenever a provider has a
   * REGISTERED adapter (`oauthAdapterFor(kind) !== null` — railway,
   * sentry, cloudflare today, never hardcoded here or in any component;
   * see {@link ConnectorView.oauthSetup}'s own doc-comment for why this
   * module never lists providers by name), `missingEnv` the NAMES (never
   * values) of every env var still unset
   * (`apps/console/lib/oauth/types.ts`'s `missingOauthEnv`), `[]` once the
   * provider is fully `oauthReady`. Computed server-side by the connectors
   * GET route — same "no I/O in this pure model" reasoning as
   * `oauthReady` — and ONLY populated when the CALLING USER is owner/admin
   * of the workspace (the SAME `membership.role === "owner" || "admin"`
   * check the route already uses to compute `canManage`; a member's
   * response carries `null` here — see the route's own doc-comment).
   * Absent → `null` (see {@link ConnectorView.oauthSetup}).
   */
  oauthSetup?: { capable: true; missingEnv: string[] } | null;
}

/** Default poll cadence, mirroring CONNECTOR_CONFIG_DEFAULTS (db-postgres). */
export const DEFAULT_POLL_INTERVAL_SECONDS = 60;

/** One connector row as the management surface renders it. */
export interface ConnectorView {
  kind: ConnectorKind;
  type: ConnectorType;
  connectMethod: ConnectorConnectMethod;
  label: string;
  description: string;
  availability: ConnectorAvailability;
  status: ConnectorStatus;
  capabilities: ConnectorCapabilities;
  ingestLabel: string | null;
  target: string | null;
  connect: ConnectorConnectMeta | null;
  /**
   * GitHub only: the Jace GitHub App is installed (see the doc-comment on
   * {@link ConnectorConfigInput.appInstalled}). False for every other kind.
   */
  appInstalled: boolean;
  /** Heartbeat trigger config the Connectors page manages (folded in #816). */
  enabled: boolean;
  triggerLabel: string;
  pollIntervalSeconds: number;
  /** W3-T1 (OAuth Connect Wave 3) — see
   * {@link ConnectorConfigInput.oauthReady}'s own doc-comment. Always
   * present (never optional) on a projected row: `false` for every
   * `oauth`-connectMethod entry (github — OAuth-native already, nothing
   * additive to offer) and for every `secret`-connectMethod entry until its
   * adapter + env are both ready. */
  oauthReady: boolean;
  /**
   * W3-T8 (owner-visible OAuth setup state) — see
   * {@link ConnectorConfigInput.oauthSetup}'s own doc-comment. Always
   * present (never optional) on a projected row, mirroring `oauthReady`:
   * `null` for every input that doesn't populate it — a member caller (the
   * route never sends it), a provider with no registered adapter (github,
   * linear, figma, context7, and every provider before its own adapter
   * task ships), or a `connectMethod: "oauth"` entry (github is
   * oauth-native already, nothing additive to set up). Distinct from
   * `oauthReady`: this answers "is one-click AVAILABLE to set up, and
   * what's left," independent of whether it's ready RIGHT NOW — a
   * provider can be `capable` with a non-empty `missingEnv` (not yet
   * ready) or `capable` with `missingEnv: []` (ready — `oauthReady` is
   * true for the same provider at that point). The sheet/tile COMBINE both
   * fields (`shouldShowOauthSetupHint` below) rather than the server
   * pre-combining them, so `oauthSetup`'s own presence stays a simple,
   * orthogonal "is this provider oauth-capable, for this caller" fact.
   */
  oauthSetup: { capable: true; missingEnv: string[] } | null;
}

/** Human-facing section metadata for each connector type. */
export const CONNECTOR_TYPE_META: Record<
  ConnectorType,
  { label: string; description: string }
> = {
  "issue-source": {
    label: "Issue sources",
    description:
      "Connect an issue tracker so its labeled issues flow into the Issue Queue and run results post back. GitHub delivers over its webhook; Linear over its own real-time webhook.",
  },
  mcp: {
    label: "MCP",
    description:
      "Model-Context-Protocol tool servers — codebase-level. Adding an API key writes the server into your repo's MCP config (.mcp.json) at run time, so the coding agent can call its tools during a run.",
  },
  observability: {
    label: "Observability",
    description:
      "Give the debugging investigator evidence about what shipped and what the logs say — deployments and log search, read-only, never used for ingest.",
  },
};

/**
 * The connector catalog, grouped by ROLE (issue-source → mcp). GitHub and
 * Linear are the issue sources (both feed the Issue Queue — Linear via its
 * real-time webhook, #1292); Figma / Context7 are tools-only MCP connectors.
 * Order here drives the page sections.
 */
export const CONNECTOR_CATALOG: ConnectorCatalogEntry[] = [
  // -- issue-source --------------------------------------------------------- //
  {
    kind: "github",
    type: "issue-source",
    connectMethod: "oauth",
    label: "GitHub",
    description:
      "Ingest labeled issues into the Issue Queue and post run results back on the issue.",
    availability: "available",
    capabilities: {
      ingest: true,
      postResult: true,
      notify: false,
      // Task 6: merged PRs + Actions workflow runs as "changes" evidence.
      // Read by `evidenceCapabilities` (`lib/evidence/registry.ts`) — see
      // that file's own doc-comment for why an oauth entry like this one
      // needs its own `connectMethod === "oauth"` credentialed branch
      // (this row never carries a stored `connectors.secret`).
      evidence: ["changes"],
    },
  },
  {
    kind: "linear",
    type: "issue-source",
    connectMethod: "secret",
    label: "Linear",
    description:
      "Ingest labeled Linear issues and let the agent read & update issues over Linear's MCP.",
    availability: "available",
    capabilities: { ingest: true, postResult: true, notify: false, tools: true },
    connect: {
      credentialLabel: "Linear API key",
      credentialPlaceholder: "lin_api_…",
      credentialHint: "A Linear personal API key — starts with lin_api_.",
      helpUrl: "https://linear.app/docs/mcp",
      setupSteps: [
        "Open Linear → Settings → Security & access → Personal API keys.",
        "Click “New API key”, name it “AgentRail”, and copy the lin_api_… value (shown once).",
        "Paste it here and connect — AgentRail reaches Linear's MCP at mcp.linear.app.",
      ],
    },
  },
  // -- mcp ------------------------------------------------------------------ //
  {
    kind: "figma",
    type: "mcp",
    connectMethod: "secret",
    label: "Figma",
    description:
      "Give the agent read access to your Figma files and frames over the Figma MCP.",
    availability: "available",
    capabilities: { ingest: false, postResult: false, notify: false, tools: true },
    connect: {
      credentialLabel: "Figma access token",
      credentialPlaceholder: "figd_…",
      credentialHint: "A Figma personal access token — starts with figd_.",
      helpUrl: "https://www.figma.com/developers/api#access-tokens",
      setupSteps: [
        "In Figma, open the account menu → Settings → Security → Personal access tokens.",
        "Click “Generate new token”; scope it to Current user + File content (read), name it “AgentRail”.",
        "Copy the figd_… value (shown once), paste it here and connect.",
      ],
    },
  },
  {
    kind: "context7",
    type: "mcp",
    connectMethod: "secret",
    label: "Context7",
    description:
      "Up-to-date library docs on demand — the agent pulls current API docs over the Context7 MCP.",
    availability: "available",
    capabilities: { ingest: false, postResult: false, notify: false, tools: true },
    connect: {
      credentialLabel: "Context7 API key",
      credentialPlaceholder: "ctx7sk-…",
      credentialHint: "A Context7 API key — starts with ctx7sk.",
      helpUrl: "https://context7.com/dashboard",
      setupSteps: [
        "Sign in at context7.com and open the Dashboard → API Keys.",
        "Click “Create API Key”, name it “AgentRail”, and copy the ctx7sk… value (shown once).",
        "Paste it here and connect.",
      ],
    },
  },
  // -- observability (Task 7, debugging design spec) ------------------------ //
  {
    kind: "railway",
    type: "observability",
    connectMethod: "secret",
    label: "Railway",
    description:
      "Give the debugging investigator visibility into your Railway project's deployments and logs.",
    availability: "available",
    capabilities: {
      ingest: false,
      postResult: false,
      notify: false,
      // The first EXTERNAL credentialed evidence provider (Task 5's factory
      // is internal; Task 6's github is oauth) — proves "add a provider =
      // catalog entry + adapter + credential pair" end to end. See
      // `lib/evidence/railway.ts`.
      evidence: ["changes", "search_events"],
    },
    connect: {
      credentialLabel: "Railway API token",
      credentialPlaceholder: "00000000-0000-0000-0000-000000000000",
      credentialHint: "A Railway Account or Team token — a UUID, created at railway.com/account/tokens.",
      helpUrl: "https://docs.railway.com/reference/public-api",
      setupSteps: [
        "Open Railway → your avatar → Account Settings → Tokens (railway.com/account/tokens).",
        "Click “Create Token”, name it “AgentRail”, and copy the token (shown once).",
        "Open your Railway project → Settings to find the project id, then paste both the token and the project id here and connect.",
      ],
      // OAuth Connect Wave 3, W3-T2 — see ConnectorConnectMeta.oauthHint's
      // own doc-comment. Wording echoes the disclosure toggle immediately
      // below it ("Use an API token instead") deliberately.
      oauthHint:
        "Connecting via Railway grants read-only access to your project's deployments and logs — you can use an API token instead if you'd rather not.",
      // W3-T8 — see ConnectorConnectMeta.oauthRegistrationUrl's own
      // doc-comment for the full citation trail (confirmed live
      // 2026-08-02).
      oauthRegistrationUrl: "https://docs.railway.com/integrations/oauth/creating-an-app",
      // Generic extra field (Task P0: array shape — see
      // ConnectorConnectMeta.extraConfigFields's own doc-comment) — the
      // token alone doesn't scope which project the investigator reads
      // from. Railway is the array shape's first (and, before this wave,
      // only) user; behavior-identical to the single-field shape it
      // replaces.
      extraConfigFields: [
        {
          key: "railwayProjectId",
          label: "Railway project ID",
          placeholder: "your Railway project id",
        },
      ],
    },
  },
  // -- observability (Task P2, Evidence Providers Wave 2) ------------------- //
  {
    kind: "langfuse",
    type: "observability",
    connectMethod: "secret",
    label: "Langfuse",
    description:
      "Give the debugging investigator visibility into your Langfuse traces and observation-level signals (error rate, latency).",
    availability: "available",
    capabilities: {
      ingest: false,
      postResult: false,
      notify: false,
      // The first Wave-2 evidence provider (Task P2) — proves the same
      // "add a provider = catalog entry + adapter" property Task 7 proved
      // for railway, now for a COMPOSITE-secret provider. See
      // `lib/evidence/langfuse.ts`.
      evidence: ["traces", "signals"],
    },
    connect: {
      credentialLabel: "Langfuse API keys",
      credentialPlaceholder: "pk-lf-… / sk-lf-…",
      credentialHint:
        "A Langfuse project's public + secret API key pair — pk-lf-… and sk-lf-….",
      helpUrl:
        "https://langfuse.com/docs/api-and-data-platform/features/public-api",
      setupSteps: [
        "Open your Langfuse project → Settings → API Keys.",
        "Click “Create new API keys” and copy both the pk-lf-… public key and the sk-lf-… secret key (shown once).",
        "Paste both here, along with your Langfuse host (e.g. https://cloud.langfuse.com, https://jp.cloud.langfuse.com, or your self-hosted origin), and connect.",
      ],
      // Task P0's composite-secret mechanism (see composite-secret.ts's own
      // doc-comment): Langfuse's public+secret key pair is stored as ONE
      // `publicKey:secretKey` string in `connectors.secret`, split back
      // apart generically by `validateConnectorCredential` (format gate)
      // and `verifyConnectorCredential` (live gate) — neither needs a
      // langfuse-specific parsing branch.
      secretParts: [{ name: "Public key" }, { name: "Secret key" }],
      secretPartPatterns: ["^pk-lf-", "^sk-lf-"],
      // OAuth Connect Wave 3, W3-T4 — see ConnectorConnectMeta.tokenStandardNote's
      // own doc-comment. Langfuse has no OAuth surface in this wave (see the
      // design spec's "Out of scope"); this states that plainly, no apology.
      tokenStandardNote:
        "API-token connect is the standard integration method for Langfuse.",
      // The workspace's Langfuse region/self-host origin — required (unlike
      // Railway's project id, every workspace needs SOME host; there is no
      // sensible default across cloud regions/self-host — see
      // `lib/evidence/langfuse.ts`'s own doc-comment). Scheme-gated at
      // write time by `validateUrlConfigString` (Task P0 Fix Round 1,
      // `packages/db-postgres/src/queries/connectors.ts`).
      extraConfigFields: [
        {
          key: "langfuseHost",
          label: "Langfuse host",
          placeholder: "https://cloud.langfuse.com",
          required: true,
        },
      ],
    },
  },
  // -- observability (Task P3, Evidence Providers Wave 2) ------------------- //
  {
    kind: "sentry",
    type: "observability",
    connectMethod: "secret",
    label: "Sentry",
    description:
      "Give the debugging investigator visibility into your Sentry error events and RED-shaped signals (error rate, p95 duration).",
    availability: "available",
    capabilities: {
      ingest: false,
      postResult: false,
      notify: false,
      // The second Wave-2 evidence provider (Task P3) — a SINGLE-secret
      // provider (unlike langfuse's composite pair), proving the catalog +
      // adapter pattern generalizes to that shape too. See
      // `lib/evidence/sentry.ts`.
      evidence: ["search_events", "signals"],
    },
    connect: {
      credentialLabel: "Sentry auth token",
      credentialPlaceholder: "sntrys_… or sntryu_…",
      credentialHint:
        "A Sentry organization or user auth token — starts with sntrys_ or sntryu_.",
      helpUrl: "https://docs.sentry.io/api/auth/",
      setupSteps: [
        "Open Sentry → Settings → Auth Tokens (organization-level) or your own User Settings → API Tokens (user-level).",
        "Create a token with event:read, project:read, and org:read scopes, and copy the sntrys_… or sntryu_… value (shown once).",
        "Paste it here, along with your Sentry organization slug and project slug, and connect.",
      ],
      // OAuth Connect Wave 3, W3-T3 — see ConnectorConnectMeta.oauthHint's
      // own doc-comment. LIVE (W3-T3 fix round): `oauthReady` reflects the
      // real three-env-var gate (`oauthConfigFor` + `sentryOauthAdapter`'s
      // own `envReady()`) once `SENTRY_OAUTH_CLIENT_ID`/`_CLIENT_SECRET`/
      // `_INTEGRATION_SLUG` are all set — Sentry's redirect can't carry a
      // vendor-echoed `state`, so the callback route resolves tenant
      // binding by the redeeming session's own user id instead (see
      // `lib/oauth/sentry.ts`'s own doc-comment, "SESSION-TRANSPORT TENANT
      // BINDING"). Wording echoes railway's own oauthHint's calm,
      // no-apology tone and its "use a token instead" pointer to the
      // disclosure immediately below.
      oauthHint:
        "Connecting via Sentry installs the integration with read-only access to your issues and events — you can use an API token instead if you'd rather not.",
      // W3-T8 — see ConnectorConnectMeta.oauthRegistrationUrl's own
      // doc-comment for the full citation trail (confirmed live
      // 2026-08-02).
      oauthRegistrationUrl: "https://docs.sentry.io/integrations/integration-platform/public-integration/",
      // Both required (Task P3's own pinned decision) — unlike Railway's
      // single project id, Sentry has no sensible default project within an
      // org, and the chosen verify/adapter endpoints need both to scope
      // every call — see `lib/evidence/sentry.ts`'s own doc-comment.
      extraConfigFields: [
        {
          key: "sentryOrg",
          label: "Sentry organization",
          placeholder: "your-org-slug",
          required: true,
        },
        {
          key: "sentryProject",
          label: "Sentry project",
          placeholder: "your-project-slug",
          required: true,
        },
      ],
    },
  },
  // -- observability (Task P4, Evidence Providers Wave 2) ------------------- //
  {
    kind: "datadog",
    type: "observability",
    connectMethod: "secret",
    label: "Datadog",
    description:
      "Give the debugging investigator visibility into your Datadog host signals (CPU, load, memory) and log search.",
    availability: "available",
    capabilities: {
      ingest: false,
      postResult: false,
      notify: false,
      // The third Wave-2 evidence provider (Task P4) — a COMPOSITE-secret
      // provider (like langfuse) that ALSO needs a non-secret companion
      // config value (like sentry, though only one — the account site). See
      // `lib/evidence/datadog.ts`.
      evidence: ["signals", "search_events"],
    },
    connect: {
      credentialLabel: "Datadog API keys",
      credentialPlaceholder: "32-hex API key / 40-hex Application key",
      credentialHint:
        "A Datadog API key (32 hex chars) and Application key (40 hex chars, or the newer ddapp_… form).",
      helpUrl: "https://docs.datadoghq.com/account_management/api-app-keys/",
      setupSteps: [
        "Open Datadog → Organization Settings → API Keys, create a key, and copy the 32-character value.",
        "Open Organization Settings → Application Keys, create a key, and copy its value (shown once).",
        "Paste both here, along with your Datadog site (e.g. datadoghq.com, us5.datadoghq.com), and connect.",
      ],
      // Task P0's composite-secret mechanism (see composite-secret.ts's own
      // doc-comment): Datadog's api+application key pair is stored as ONE
      // `apiKey:appKey` string in `connectors.secret`, split back apart
      // generically by `validateConnectorCredential` (format gate) and
      // `verifyConnectorCredential` (live gate) — neither needs a
      // datadog-specific parsing branch. Per-part patterns: the API key is
      // CONFIRMED 32 hex chars (docs.datadoghq.com/account_management/
      // api-app-keys/ itself does not state a format, but Datadog's own
      // AWS Secrets Manager partner integration doc and this task's own
      // believed shape agree); the Application key accepts EITHER the
      // confirmed-shape legacy 40-hex form OR the newer `ddapp_`-prefixed
      // form — Fix Round 1: tightened to the cited source's own fixed
      // length (`ddapp_` + 34 alphanumeric chars = 40 total, the SAME total
      // length as the legacy hex form) rather than an open-ended
      // `ddapp_[A-Za-z0-9]+` — the 34-char figure comes from the same
      // secondary source (Datadog's own AWS Secrets Manager partner
      // integration doc; Datadog's first-party docs page states no format
      // at all), so this is still "cheap format gate, not cryptographic
      // correctness" (same spirit as every pattern in this file), just
      // precise about the one concrete number that source actually gives —
      // see `lib/evidence/datadog.ts`'s own doc-comment for the full
      // citation trail.
      secretParts: [{ name: "API key" }, { name: "Application key" }],
      secretPartPatterns: ["^[0-9a-f]{32}$", "^([0-9a-f]{40}|ddapp_[A-Za-z0-9]{34})$"],
      // OAuth Connect Wave 3, W3-T4 — see ConnectorConnectMeta.tokenStandardNote's
      // own doc-comment. Datadog has no OAuth surface in this wave (see the
      // design spec's "Out of scope"); this states that plainly, no apology,
      // and names WHY the form asks for two values (the composite pair
      // declared via secretParts above), since that's the one genuinely
      // provider-specific fact worth surfacing here beyond the generic claim.
      tokenStandardNote:
        "API-token connect is the standard integration method for Datadog — its API splits access across a key and an application key, which is why this form asks for both.",
      // The workspace's Datadog site — required (every workspace needs
      // SOME site; there is no sensible default across Datadog's 9 regional
      // deployments). Unlike langfuseHost/prometheusUrl/grafanaUrl, this is
      // NOT one of `validateUrlConfigString`'s three scheme-gated fields
      // (confirmed by reading `packages/db-postgres/src/queries/
      // connectors.ts` directly — datadogSite goes through the plain
      // `validateSimpleConfigString`) — the adapter itself validates it
      // against a documented-site allowlist before ever using it as a
      // fetch target (see `lib/evidence/datadog.ts`'s own doc-comment,
      // "SITE ROUTING").
      extraConfigFields: [
        {
          key: "datadogSite",
          label: "Site",
          placeholder: "datadoghq.com",
          required: true,
        },
      ],
    },
  },
  // -- observability (Task P5, Evidence Providers Wave 2) ------------------- //
  {
    kind: "prometheus",
    type: "observability",
    connectMethod: "secret",
    label: "Prometheus",
    description:
      "Give the debugging investigator visibility into your Prometheus request rate, error rate, p95 latency, and target health (RED/USE-shaped signals).",
    availability: "available",
    capabilities: {
      ingest: false,
      postResult: false,
      notify: false,
      // The fourth Wave-2 evidence provider (Task P5) — `signals` ONLY (no
      // search_events/traces/changes: Prometheus is a time-series store,
      // not a log/event/deploy history). See `lib/evidence/prometheus.ts`.
      evidence: ["signals"],
    },
    connect: {
      credentialLabel: "Prometheus credential",
      credentialPlaceholder: "a bearer token, or user:pass for Basic auth",
      credentialHint:
        "A bearer token, OR a user:pass pair for HTTP Basic auth. If the value contains a colon, it's read as user:pass; otherwise as a bearer token (Authorization: Bearer <value>). Prometheus itself has no built-in login — this authenticates to whatever reverse proxy or web.yml basic_auth guards your instance. If your instance is unauthenticated, any non-empty value here works.",
      helpUrl: "https://prometheus.io/docs/prometheus/latest/querying/api/",
      setupSteps: [
        "Prometheus has no login system of its own — this credential authenticates to whatever sits in front of it (a reverse proxy's Basic auth, an oauth2-proxy bearer token, or Prometheus's own web.yml basic_auth users).",
        "If your instance is protected by HTTP Basic auth, paste it here as user:pass. If it's protected by a bearer token instead, paste the token alone.",
        "Paste your Prometheus base URL (e.g. https://prometheus.internal:9090) below and connect — AgentRail queries /api/v1/query for RED/USE-shaped signals.",
      ],
      // Task P5: a SINGLE secret field (NOT composite — unlike
      // langfuse/datadog's declared secretParts above). The adapter (and
      // verify.ts) decide bearer-vs-Basic-auth by inspecting the secret's
      // OWN shape at read time (does it contain a `:`?), never from a
      // second declared field — see `lib/evidence/prometheus.ts`'s own
      // doc-comment ("AUTH HEURISTIC") for the full reasoning and its
      // disclosed limitation. No secretParts/secretPartPatterns here; the
      // format gate lives in `validateConnectorCredential`'s own hand-written
      // `case "prometheus"` below (non-empty, ≤512 chars, no whitespace —
      // a shape both a bearer token and a user:pass pair satisfy).
      // OAuth Connect Wave 3, W3-T4 — see ConnectorConnectMeta.tokenStandardNote's
      // own doc-comment. Prometheus has no OAuth surface in this wave (see
      // the design spec's "Out of scope"); this states that plainly, no
      // apology.
      tokenStandardNote:
        "API-token connect is the standard integration method for Prometheus.",
      extraConfigFields: [
        {
          key: "prometheusUrl",
          label: "Base URL",
          placeholder: "https://prometheus.internal:9090",
          required: true,
        },
      ],
    },
  },
  // -- observability (Task P6, Evidence Providers Wave 2) ------------------- //
  {
    kind: "grafana",
    type: "observability",
    connectMethod: "secret",
    label: "Grafana",
    description:
      "Give the debugging investigator visibility into your Grafana alert state changes and annotations.",
    availability: "available",
    capabilities: {
      ingest: false,
      postResult: false,
      notify: false,
      // The fifth Wave-2 evidence provider (Task P6) — PIVOTED from the
      // plan's believed `signals` (datasource-proxy query via
      // /api/ds/query) to `search_events` over Grafana-managed alert state
      // changes + annotations (GET /api/annotations) — see
      // `lib/evidence/grafana.ts`'s own doc-comment ("PIVOT DECISION") for
      // the full doc-verify trail behind this switch.
      evidence: ["search_events"],
    },
    connect: {
      credentialLabel: "Grafana service account token",
      credentialPlaceholder: "glsa_…",
      credentialHint:
        "A Grafana service account token — starts with glsa_. A legacy API key (starts with eyJ, deprecated but still accepted by Grafana) also works. Viewer role is enough — this connector only reads alert and annotation events.",
      helpUrl: "https://grafana.com/docs/grafana/latest/administration/service-accounts/",
      setupSteps: [
        "Open Grafana → Administration → Users and access → Service accounts, and create one (Viewer role is enough for read-only evidence).",
        "Add a service account token to it and copy the glsa_… value (shown once).",
        "Paste it here, along with your Grafana base URL (e.g. https://grafana.example.com), and connect — AgentRail reads GET /api/annotations for alert and annotation events.",
      ],
      // Task P6: a SINGLE secret field (NOT composite — like prometheus
      // above, unlike langfuse/datadog). Both accepted token shapes (glsa_
      // service-account tokens and legacy eyJ… API keys) use the IDENTICAL
      // Authorization: Bearer scheme, so — unlike prometheus's
      // bearer-vs-Basic heuristic — no read-time disambiguation is needed
      // here at all; the format gate in `validateConnectorCredential`'s own
      // hand-written `case "grafana"` below just accepts either documented
      // prefix. See `lib/evidence/grafana.ts`'s own doc-comment for the
      // doc-verify trail behind both prefixes.
      // OAuth Connect Wave 3, W3-T4 — see ConnectorConnectMeta.tokenStandardNote's
      // own doc-comment. Grafana has no OAuth surface in this wave (see the
      // design spec's "Out of scope"); this states that plainly, no apology.
      tokenStandardNote:
        "API-token connect is the standard integration method for Grafana.",
      extraConfigFields: [
        {
          key: "grafanaUrl",
          label: "Grafana base URL",
          placeholder: "https://grafana.example.com",
          required: true,
        },
      ],
    },
  },
  // -- observability (Task P7, Evidence Providers Wave 2) ------------------- //
  {
    kind: "vercel",
    type: "observability",
    connectMethod: "secret",
    label: "Vercel",
    description:
      "Give the debugging investigator visibility into your Vercel deployments and build/runtime events.",
    availability: "available",
    capabilities: {
      ingest: false,
      postResult: false,
      notify: false,
      // The sixth Wave-2 evidence provider (Task P7) — deployments as
      // `changes`, deployment build/runtime events as `search_events`,
      // mirroring railway's own "deployments + logs" shape closely (the
      // task's own closest-sibling template). See `lib/evidence/vercel.ts`.
      evidence: ["changes", "search_events"],
    },
    connect: {
      credentialLabel: "Vercel access token",
      credentialPlaceholder: "your Vercel personal or team Access Token",
      credentialHint:
        "A Vercel Access Token (Settings → Tokens) — either the newer vcp_-prefixed format or an older, still-valid token without a prefix. Both are accepted here; the live check against api.vercel.com is the real gate.",
      helpUrl: "https://vercel.com/docs/rest-api/authentication",
      setupSteps: [
        "Open Vercel → Settings → Tokens (vercel.com/account/tokens), and create a token scoped to your personal account or the team this project belongs to.",
        "Copy the token (shown once).",
        "Open the project → Settings to find its Project ID (and, if it's team-owned, the Team ID), then paste the token and both ids here and connect.",
      ],
      // OAuth Connect Wave 3, W3-T9 — see ConnectorConnectMeta.oauthHint's
      // own doc-comment. Wording echoes railway's/sentry's/cloudflare's own
      // calm, no-apology tone and "use a token instead" pointer to the
      // disclosure immediately below it.
      oauthHint:
        "Connecting via Vercel grants read-only access to your project's deployments and build/runtime events — you can use an API token instead if you'd rather not.",
      // W3-T9 — see ConnectorConnectMeta.oauthRegistrationUrl's own
      // doc-comment for the sourcing convention. Confirmed live 2026-08-02:
      // this is the exact "Integrations Console" link `create-integration.md`
      // itself uses as a clickable reference ("View all integrations that
      // you have created on the Integrations Console") — Vercel's own
      // `/d?to=…` shorthand resolves to the caller's own current
      // account/team context, the same "account-agnostic direct link"
      // property cloudflare.ts's own `?to=/:account/...` citation relies on,
      // rather than a workspace-scoped URL this codebase would have to
      // guess. From there: team switcher → Integrations → Integrations
      // Console → Create.
      oauthRegistrationUrl: "https://vercel.com/d?to=%2Fdashboard%2Fintegrations%2Fconsole&title=Open+Integrations+Console",
      // Task P7's own pinned decision: TWO extra config fields — unlike
      // every prior Wave-2 provider (which declared either one required
      // field, like grafana/prometheus/langfuse above, or two BOTH-required
      // fields, like sentry above), vercelTeamId is the wave's first
      // OPTIONAL extra config field: a personal-account-scoped Vercel
      // project legitimately has no team id, and every API call this
      // adapter makes documents `teamId` as an optional query param (see
      // `lib/evidence/vercel.ts`'s own doc-comment, "TEAM SCOPING") — its
      // absence degrades nothing, it simply falls back to the token's own
      // personal/team-bound scope. `vercelProjectId` is first-declared
      // (drives `projectConnectors`' displayed card target, P0 mechanics)
      // and required — there is no sensible default project within an
      // account/team, mirroring railway's own single required project id.
      extraConfigFields: [
        {
          key: "vercelProjectId",
          label: "Project ID",
          placeholder: "prj_…",
          required: true,
        },
        {
          key: "vercelTeamId",
          label: "Team ID",
          placeholder: "team_… (optional for personal scope)",
          required: false,
        },
      ],
    },
  },
  // -- observability (Task P8, Evidence Providers Wave 2 — FINAL provider) - //
  {
    kind: "cloudflare",
    type: "observability",
    connectMethod: "secret",
    label: "Cloudflare",
    description:
      "Give the debugging investigator visibility into your Cloudflare edge traffic signals and firewall/security events.",
    availability: "available",
    capabilities: {
      ingest: false,
      postResult: false,
      notify: false,
      // The SEVENTH and final Wave-2 evidence provider (Task P8) — edge
      // request/error/byte signals as `signals`, firewall/security events as
      // `search_events`, both over Cloudflare's GraphQL Analytics API. See
      // `lib/evidence/cloudflare.ts`.
      evidence: ["signals", "search_events"],
    },
    connect: {
      credentialLabel: "Cloudflare API token",
      credentialPlaceholder: "your Cloudflare API token",
      credentialHint:
        "A Cloudflare API Token (My Profile → API Tokens) scoped to the zone's Analytics: Read permission. Both the newer cfut_-prefixed format and the older, still-valid unprefixed format are accepted here; the live check against api.cloudflare.com is the real gate.",
      helpUrl: "https://developers.cloudflare.com/fundamentals/api/get-started/create-token/",
      setupSteps: [
        "Open Cloudflare → My Profile → API Tokens (dash.cloudflare.com/profile/api-tokens), and create a token with Zone → Analytics → Read on the zone below.",
        "Copy the token (shown once).",
        "Open the zone's Overview page to find its Zone ID (right sidebar), then paste both the token and the zone id here and connect.",
      ],
      // OAuth Connect Wave 3, W3-T6 — see ConnectorConnectMeta.oauthHint's
      // own doc-comment. Wording echoes railway's/sentry's own calm,
      // no-apology tone and "use a token instead" pointer to the disclosure
      // immediately below it.
      oauthHint:
        "Connecting via Cloudflare grants read-only access to your zone's analytics and firewall events — you can use an API token instead if you'd rather not.",
      // W3-T8 — see ConnectorConnectMeta.oauthRegistrationUrl's own
      // doc-comment. Taken verbatim from lib/oauth/cloudflare.ts's own
      // "REGISTRATION" doc-comment, which cites this as a confirmed direct
      // link (Cloudflare's `?to=` shorthand resolves the caller's own
      // account context).
      oauthRegistrationUrl: "https://dash.cloudflare.com/?to=/:account/oauth-clients",
      // Task P8's own pinned decision: a SINGLE secret field (no
      // secretParts — like sentry/prometheus/grafana/vercel above), a
      // single REQUIRED extra config field. UNLIKE every provider above
      // that needed exactly one field, Cloudflare's schema ALSO already
      // carries a second, adjacent field (`cloudflareAccountId`, added by
      // Task P0 alongside `cloudflareZoneId`) — deliberately NOT declared
      // here: both GraphQL Analytics datasets this adapter reads
      // (`httpRequestsAdaptiveGroups`, `firewallEventsAdaptive`) are
      // confirmed reachable via `zoneTag` alone, no `accountTag` needed
      // (see `lib/evidence/cloudflare.ts`'s own doc-comment, "ACCOUNT TAG
      // NOT NEEDED"). `cloudflareAccountId` stays in `ConnectorConfig`,
      // validated and preservable, simply never read by this connector's
      // own connect form, adapter, or verify path — an intentional,
      // documented non-use of an already-provisioned schema field.
      extraConfigFields: [
        {
          key: "cloudflareZoneId",
          label: "Zone ID",
          placeholder: "your Cloudflare zone id",
          required: true,
        },
      ],
    },
  },
  // -- internal (evidence-only; never rendered — see ConnectorAvailability's
  // own doc-comment and projectConnectors' filter below) ------------------- //
  {
    kind: "factory",
    // `type`/`connectMethod` are inert for an `internal` entry — this row is
    // filtered out of the grid (projectConnectors) before either is ever
    // read; the values here mirror the shape connector-helpers.test.ts's own
    // internal-availability filter test uses (cloning an existing `mcp`/
    // `secret` entry), not a claim that factory IS an MCP tool server.
    type: "mcp",
    connectMethod: "secret",
    label: "Factory",
    description:
      "This console's own runs, failures, and events — no connection required.",
    availability: "internal",
    capabilities: {
      ingest: false,
      postResult: false,
      notify: false,
      evidence: ["changes", "search_events"],
    },
  },
];

/** Default ingest label, matching the AFK CLI's ready label / GitHubConnector. */
export const DEFAULT_INGEST_LABEL = "ready-for-agent";

/** Look up a catalog entry by kind (total over the catalog). */
export function catalogEntry(kind: ConnectorKind): ConnectorCatalogEntry {
  // Safe: every ConnectorKind has exactly one catalog entry.
  return CONNECTOR_CATALOG.find((e) => e.kind === kind)!;
}

// --------------------------------------------------------------------------- //
// Generic `extraConfigFields` machinery (Task P0). These three pieces are what
// let P2-P8 add a provider needing one or more non-secret config companions
// (org, site, host, ids) as a CATALOG ENTRY ONLY — no route, no component
// branch, per provider. Each takes a minimal structural param (not the full
// `ConnectorCatalogEntry`) so a test can prove genericity with a synthetic
// multi-field fixture instead of needing a second real provider in the
// catalog.
// --------------------------------------------------------------------------- //

/** Minimal shape the `extraConfigFields` helpers need from a catalog entry —
 * looser than {@link ConnectorCatalogEntry} so a test can pass a fully
 * synthetic array without constructing every other catalog field. */
export interface ExtraConfigFieldsCarrier {
  connect?: { extraConfigFields?: ConnectorConnectMeta["extraConfigFields"] };
}

/**
 * Every non-secret config key ANY catalog entry declares via
 * `connect.extraConfigFields` — the connectors PUT route
 * (`api/v1/workspaces/[workspaceId]/connectors/route.ts`) accepts any key in
 * this set generically instead of hand-listing each provider's field name
 * (Task 7's `railwayProjectId` was the last hand-listed one). `catalog`
 * defaults to the real {@link CONNECTOR_CATALOG}.
 */
export function extraConfigFieldKeys(
  catalog: ExtraConfigFieldsCarrier[] = CONNECTOR_CATALOG
): Set<string> {
  return new Set(
    catalog.flatMap((entry) => entry.connect?.extraConfigFields?.map((f) => f.key) ?? [])
  );
}

/**
 * A catalog entry's declared `extraConfigFields` VALUES, read off a raw
 * stored config object and keyed the same way — the generic replacement for
 * Task 7's single hand-written `railwayProjectId: row?.config.railwayProjectId
 * ?? null` line in the connectors GET route. A declared field absent from
 * `config` (or present but not a string) projects as `null`; an entry with
 * no declared fields projects an empty bag. `config` is intentionally a
 * loose `Record<string, unknown>` (not the DB-only `ConnectorConfig` type)
 * so this pure-model module never has to import `packages/db-postgres`.
 */
export function projectExtraConfigValues(
  entry: ExtraConfigFieldsCarrier,
  config: Record<string, unknown> | undefined
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const field of entry.connect?.extraConfigFields ?? []) {
    const v = config?.[field.key];
    out[field.key] = typeof v === "string" ? v : null;
  }
  return out;
}

/**
 * The value of a catalog entry's FIRST declared `extraConfigFields` entry,
 * read off an already-projected `ConnectorConfigInput` bag — used by
 * `projectConnectors` to derive `ConnectorView.target` generically (see that
 * function's own doc-comment). No declared fields → null.
 */
function firstExtraConfigValue(
  entry: ExtraConfigFieldsCarrier,
  cfg: ConnectorConfigInput | undefined
): string | null {
  const fields = entry.connect?.extraConfigFields;
  if (!fields || fields.length === 0) return null;
  const value = cfg?.[fields[0].key];
  return typeof value === "string" ? value : null;
}

/**
 * Derive whether a connector is connected from its stored config, by connect
 * method. OAuth → the `connected` flag (GitHub repos linked); secret → a
 * credential is stored (`hasSecret`).
 */
function isConnected(
  entry: ConnectorCatalogEntry,
  cfg: ConnectorConfigInput | undefined
): boolean {
  switch (entry.connectMethod) {
    case "oauth":
      return Boolean(cfg?.connected);
    case "secret":
      return Boolean(cfg?.hasSecret);
  }
}

/**
 * Project the catalog against the workspace's stored connector config into the
 * rows the surface renders. Pure and total: a kind with no config is
 * `disconnected`; only an `available` connector that is actually connected per
 * its connect method shows `connected`.
 *
 * `availability: "internal"` entries (Task 5's `factory` evidence adapter) are
 * filtered OUT here — they exist in the catalog purely for
 * `evidenceCapabilities` to find, never to render as a card on this page (see
 * {@link ConnectorAvailability}'s doc-comment). `catalog` defaults to the real
 * {@link CONNECTOR_CATALOG} — the optional param exists only so a test can
 * inject a synthetic `internal` entry before Task 5 adds a real one; every
 * production call site keeps calling `projectConnectors(configs)` unchanged.
 */
export function projectConnectors(
  configs: ConnectorConfigInput[],
  catalog: ConnectorCatalogEntry[] = CONNECTOR_CATALOG
): ConnectorView[] {
  const byKind = new Map<ConnectorKind, ConnectorConfigInput>();
  for (const c of configs) byKind.set(c.kind, c);

  return catalog
    .filter((entry) => entry.availability !== "internal")
    .map((entry) => {
      const cfg = byKind.get(entry.kind);

      const connected =
        entry.availability === "available" && isConnected(entry, cfg);
      const status: ConnectorStatus = connected ? "connected" : "disconnected";

      // A notify-only / tools-only connector has no ingest label; only ingest
      // does.
      const ingestLabel =
        status === "connected" && entry.capabilities.ingest
          ? cfg?.ingestLabel ?? DEFAULT_INGEST_LABEL
          : null;

      // Display target: oauth → the stored target (repo); a secret-connected
      // entry that declares extraConfigFields → the FIRST declared field's
      // stored value (Task P0 — generalizes Fix Round 1 FIX 3's
      // Railway-specific `cfg?.railwayProjectId`, the reviewer-flagged
      // hardcoding this task fixes; same generic render slot in
      // `SecretManage`'s connected-state summary, no new UI code needed per
      // provider); every other kind → none. `firstExtraConfigValue` reads
      // generically off `cfg`'s bag, so a future provider WITHOUT any
      // declared field never accidentally surfaces an unrelated stored
      // value here.
      const target =
        entry.connectMethod === "oauth"
          ? cfg?.target ?? null
          : firstExtraConfigValue(entry, cfg);

      return {
        kind: entry.kind,
        type: entry.type,
        connectMethod: entry.connectMethod,
        label: entry.label,
        description: entry.description,
        availability: entry.availability,
        status,
        capabilities: entry.capabilities,
        ingestLabel,
        target,
        connect: entry.connect ?? null,
        appInstalled: entry.kind === "github" && Boolean(cfg?.appInstalled),
        // Heartbeat trigger config the card manages (folded in #816). Defaults when
        // no connector row exists: a connector defaults enabled once connected.
        enabled: cfg?.enabled ?? connected,
        triggerLabel: cfg?.triggerLabel ?? DEFAULT_INGEST_LABEL,
        pollIntervalSeconds:
          cfg?.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS,
        // W3-T1 (OAuth Connect Wave 3) — see ConnectorConfigInput.oauthReady's
        // own doc-comment. Absent input → false.
        oauthReady: cfg?.oauthReady ?? false,
        // W3-T8 (owner-visible OAuth setup state) — see
        // ConnectorConfigInput.oauthSetup's own doc-comment. Absent input
        // (a member caller, or a route that predates this task) → null.
        oauthSetup: cfg?.oauthSetup ?? null,
      };
    });
}

/**
 * W3-T8 (owner-visible OAuth setup state, `.superpowers/sdd/plan-oauth.md`)
 * — whether the "one-click connect available, not yet configured" nudge
 * should show for this connector: a registered adapter for it
 * (`oauthSetup` non-null — the connectors GET route already gated this on
 * the caller being owner/admin, see {@link ConnectorView.oauthSetup}'s own
 * doc-comment, so this function never needs a separate role check of its
 * own), not yet `oauthReady`, and not already connected (a connected
 * provider has nothing left to set up, regardless of env state —
 * token-paste already got it there). Shared by `connector-sheet.tsx`'s
 * `SecretManage` (the setup section above the token form) and
 * `connectors-panel.tsx`'s `ConnectorTile` (the small "Setup" tag) so both
 * surfaces agree on exactly one definition of "should this nudge appear,"
 * rather than two hand-copied boolean expressions drifting apart over
 * time.
 */
export function shouldShowOauthSetupHint(connector: ConnectorView): boolean {
  return (
    connector.oauthSetup !== null &&
    !connector.oauthReady &&
    connector.status !== "connected"
  );
}

/** The connectors counted as actively driving the heartbeat (connected + enabled). */
export function activeHeartbeatConnectors(
  views: ConnectorView[]
): ConnectorView[] {
  // Only ingest connectors actually drive the heartbeat loop; a notify/tools
  // connector being connected doesn't poll for work.
  return views.filter(
    (v) => v.status === "connected" && v.enabled && v.capabilities.ingest
  );
}

/** Human label for a connector status (direct, no hype — TASTE.md). */
export function connectorStatusLabel(status: ConnectorStatus): string {
  return status === "connected" ? "Connected" : "Not connected";
}

/** Summarize a connector's capabilities as a short, scannable string. */
export function capabilitySummary(caps: ConnectorCapabilities): string {
  const parts: string[] = [];
  if (caps.ingest) parts.push("Ingest");
  if (caps.postResult) parts.push("Post result");
  if (caps.notify) parts.push("Notify");
  if (caps.tools) parts.push("Tools");
  return parts.join(" · ") || "—";
}

// --------------------------------------------------------------------------- //
// Credential validation — pure, shared by the client form (pre-submit) and the
// server route (the real gate). A connector's connect must be falsifiable: we
// only accept a credential that has the upstream's real shape, never an
// arbitrary string that would never authenticate.
// --------------------------------------------------------------------------- //

export type CredentialCheck = { ok: true } | { ok: false; error: string };

/**
 * Generic UUID SHAPE (8-4-4-4-12 hex), not RFC4122-version-specific — Railway
 * does not publicly document which UUID version its Account/Team tokens use
 * (confirmed shape only: displayed as a UUID at railway.com/account/tokens),
 * so this validates the shape, not a specific version's bit pattern. Matches
 * this function's own "cheap format gate, not a claim of cryptographic
 * correctness" spirit for every other provider below.
 */
const UUID_SHAPE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate a connector's credential for connect. `secret` is the API key /
 * token (single-secret providers) or the client-joined `partA:partB`
 * composite (see `apps/console/lib/evidence/composite-secret.ts`). Returns
 * `{ok:true}` or a human error. OAuth (GitHub) has no credential to
 * validate here.
 *
 * Task P0: a catalog entry declaring `connect.secretParts` is validated
 * GENERICALLY — split via `splitCompositeSecret`, then each part checked
 * against the index-aligned `connect.secretPartPatterns` (a part with no
 * pattern at its index is accepted on count/non-empty alone). This is the
 * mechanism that lets a NEW provider (single- or multi-part) validate its
 * credential shape as CATALOG DATA, with no switch case added here. The
 * four providers below that predate this wave declare neither
 * `secretParts` nor `secretPartPatterns` and keep their original
 * hand-written cases, unaffected. `catalog` defaults to the real
 * {@link CONNECTOR_CATALOG} — the optional param exists so a test can
 * prove the generic path with a synthetic entry, without a second real
 * composite provider in the catalog (P0 adds none).
 */
export function validateConnectorCredential(
  kind: ConnectorKind,
  secret: string,
  catalog: ConnectorCatalogEntry[] = CONNECTOR_CATALOG
): CredentialCheck {
  const s = secret.trim();
  if (s.length === 0) return { ok: false, error: "A credential is required." };

  const entry = catalog.find((e) => e.kind === kind);
  const connectMeta = entry?.connect;
  const partSpecs = connectMeta?.secretParts ?? [];
  if (connectMeta && partSpecs.length > 0) {
    const split = splitCompositeSecret(connectMeta, s);
    if (!split.ok) return { ok: false, error: split.error };
    const patterns = connectMeta.secretPartPatterns;
    if (patterns) {
      for (let i = 0; i < split.parts.length; i++) {
        const pattern = patterns[i];
        if (!pattern) continue;
        if (!new RegExp(pattern).test(split.parts[i])) {
          return {
            ok: false,
            error: `${partSpecs[i].name} has an unexpected format.`,
          };
        }
      }
    }
    return { ok: true };
  }

  switch (kind) {
    case "linear":
      return s.startsWith("lin_api_")
        ? { ok: true }
        : { ok: false, error: "Linear keys start with lin_api_." };
    case "figma":
      return s.startsWith("figd_")
        ? { ok: true }
        : { ok: false, error: "Figma tokens start with figd_." };
    case "context7":
      return /^ctx7sk[-_]/.test(s)
        ? { ok: true }
        : { ok: false, error: "Context7 keys start with ctx7sk." };
    case "railway":
      // Task 7: Railway Account/Team tokens are UUIDs.
      return UUID_SHAPE_RE.test(s)
        ? { ok: true }
        : { ok: false, error: "Railway tokens are UUIDs." };
    case "langfuse":
      // Task P2: the real catalog entry declares `secretParts` (two parts),
      // so every real call is intercepted by the generic composite-secret
      // branch ABOVE this switch and never reaches this case — this is this
      // function's own defense in depth regardless (same reasoning as
      // `factory` below): the switch must stay total over every
      // ConnectorKind, and this is the operative rejection for a direct
      // caller (this module's own tests included, or a hypothetical future
      // catalog edit that strips `secretParts`) that reaches it anyway.
      return {
        ok: false,
        error: "Langfuse requires both API keys (public + secret).",
      };
    case "sentry":
      // Task P3: a SINGLE secret (no secretParts) — org auth tokens
      // (`sntrys_…`) and user auth tokens (`sntryu_…`) are both accepted;
      // confirmed prefixes against Sentry's own source
      // (`src/sentry/types/token.py`: USER="sntryu_", ORG="sntrys_",
      // also USER_APP="sntrya_"/INTEGRATION="sntryi_", both DELIBERATELY
      // out of scope for v1 — see `lib/evidence/sentry.ts`'s own
      // doc-comment for why only these two, most-common-for-this-use-case
      // kinds are accepted).
      return s.startsWith("sntrys_") || s.startsWith("sntryu_")
        ? { ok: true }
        : {
            ok: false,
            error: "Sentry tokens start with sntrys_ (organization) or sntryu_ (user).",
          };
    case "datadog":
      // Task P4: the real catalog entry declares `secretParts` (two parts),
      // so every real call is intercepted by the generic composite-secret
      // branch ABOVE this switch and never reaches this case — this is this
      // function's own defense in depth regardless (same reasoning as
      // `langfuse` above): the switch must stay total over every
      // ConnectorKind, and this is the operative rejection for a direct
      // caller (this module's own tests included, or a hypothetical future
      // catalog edit that strips `secretParts`) that reaches it anyway.
      return {
        ok: false,
        error: "Datadog requires both an API key and an application key.",
      };
    case "prometheus": {
      // Task P5: a SINGLE secret — EITHER a bearer token OR a `user:pass`
      // composite for Basic auth, disambiguated at READ time (see
      // `lib/evidence/prometheus.ts`'s own doc-comment, "AUTH HEURISTIC") —
      // NOT a declared `secretParts` composite, so (unlike langfuse/datadog
      // above) this case IS the operative gate for every real call, not
      // just a defensive fallback. Prometheus itself defines no fixed token
      // shape for either form (a bearer token could be anything a reverse
      // proxy/oauth2-proxy issues; a Basic-auth pair is just two operator-
      // chosen strings), so the format gate is the widest cheap check both
      // shapes legitimately share: no embedded whitespace (a real token
      // never contains any; a real user:pass pair's own parts shouldn't
      // either) and a generous ≤512-char bound (well above any realistic
      // token or credential pair). Real security lives at Gate 2 (live
      // verify), unaffected by this format gate's own permissiveness.
      if (/\s/.test(s)) {
        return { ok: false, error: "Prometheus credentials must not contain whitespace." };
      }
      if (s.length > 512) {
        return { ok: false, error: "Prometheus credentials must be at most 512 characters." };
      }
      return { ok: true };
    }
    case "grafana":
      // Task P6: a SINGLE secret, EITHER a service-account token (`glsa_`
      // prefix, confirmed current — see `lib/evidence/grafana.ts`'s own
      // doc-comment) OR a legacy API key (`eyJ` prefix, confirmed
      // deprecated but still functioning per Grafana's own migration docs:
      // "will continue working as before"). Unlike prometheus's
      // shape-agnostic whitespace/length gate above, both Grafana token
      // generations DO have confirmed, documented prefixes — mirrors
      // sentry's simpler prefix-only gate rather than prometheus's own
      // wider one.
      return s.startsWith("glsa_") || s.startsWith("eyJ")
        ? { ok: true }
        : {
            ok: false,
            error: "Grafana tokens start with glsa_ (service account) or eyJ (legacy API key).",
          };
    case "vercel": {
      // Task P7 (Fix Round 1 correction — see `lib/evidence/vercel.ts`'s
      // own doc-comment, "AUTH," for the full citation trail): Vercel's
      // Feb 2026 changelog DOES now document a prefix for freshly-created
      // tokens (`vcp_`, "personal access tokens"), but the LEGACY,
      // unprefixed personal/team Access Token shape this connector has
      // always accepted remains independently valid — Vercel did not
      // retire or reissue existing tokens. This gate stays shape-agnostic
      // DELIBERATELY (not from an absence of documentation): requiring
      // `vcp_` would reject every still-valid legacy token a workspace may
      // already hold. Mirrors prometheus's identical "no single confirmed
      // shape to gate on" precedent: no embedded whitespace, a generous
      // ≤512-char bound wide enough for either generation. Real security
      // lives at Gate 2 (live verify), unaffected by this format gate's
      // own permissiveness.
      if (/\s/.test(s)) {
        return { ok: false, error: "Vercel tokens must not contain whitespace." };
      }
      if (s.length > 512) {
        return { ok: false, error: "Vercel tokens must be at most 512 characters." };
      }
      return { ok: true };
    }
    case "cloudflare": {
      // Task P8 (see `lib/evidence/cloudflare.ts`'s own doc-comment, "AUTH"
      // for the full citation trail): Cloudflare's own token-formats page
      // documents TWO new scannable, checksummed prefixes covering the
      // credential type this connector asks for — `cfut_` (User API Token)
      // and `cfat_` (Account API Token), both just "an API Token" from this
      // connector's point of view — but the LEGACY, UNPREFIXED 40-char
      // shape "continue[s] to work" per that same page; Cloudflare did not
      // retire or reissue existing tokens. This gate stays shape-agnostic
      // DELIBERATELY (not from an absence of documentation, and not from
      // only ONE prefix being ambiguous — TWO independently-valid new
      // prefixes exist here): requiring either would reject every
      // still-valid legacy token a workspace may already hold. Mirrors
      // vercel's/prometheus's identical "no single confirmed shape to gate
      // on" precedent: no embedded whitespace, a generous ≤512-char bound
      // wide enough for either generation. Real security lives at Gate 2
      // (live verify), unaffected by this format gate's own permissiveness.
      if (/\s/.test(s)) {
        return { ok: false, error: "Cloudflare tokens must not contain whitespace." };
      }
      if (s.length > 512) {
        return { ok: false, error: "Cloudflare tokens must be at most 512 characters." };
      }
      return { ok: true };
    }
    case "github":
      // GitHub is OAuth — nothing to paste here.
      return { ok: false, error: "This connector is not credential-based." };
    case "factory":
      // Internal (Task 5) — no credential exists to validate. Never reaches
      // the connect flow in practice through TWO independent gates: (1)
      // `projectConnectors` filters `availability: "internal"` entries out
      // of the grid entirely, so there is no card to submit from; (2)
      // secret/route.ts's CREDENTIAL_PROVIDERS allowlist (catalog-derived,
      // Task 7) itself excludes `availability: "internal"` entries
      // structurally (Fix Round 1, FIX 4) — the allowlist rejects "factory"
      // before this function is ever called through the route. THIS case is
      // this function's own defense in depth regardless: the switch must
      // stay total over every ConnectorKind, and this is the format gate's
      // own operative rejection for a direct caller (this module's own
      // tests included) that reaches it anyway, bypassing the route.
      return { ok: false, error: "This connector is not credential-based." };
  }
}
