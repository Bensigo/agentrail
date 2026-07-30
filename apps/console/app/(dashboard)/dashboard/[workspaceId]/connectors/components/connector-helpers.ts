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
 * composite pair, scoped by a site extra config.
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
  | "datadog";

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
      };
    });
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
