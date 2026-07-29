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

/** The external tools AgentRail can connect (M038 catalog). */
export type ConnectorKind = "github" | "linear" | "figma" | "context7";

/**
 * Which catalog group a connector belongs to (drives the page sections). Grouped
 * by ROLE: `issue-source` (GitHub, Linear — feed the Issue Queue), `mcp`
 * (Figma, Context7 — tools only). (#1292 renamed the former connect-mechanism
 * `https` group to the role-based `issue-source`, and moved Linear into it
 * from `mcp`. Gateways-page T4 removed the third group, `channel` — chat
 * channels live on their own Gateways surface now, see the module doc-comment.)
 */
export type ConnectorType = "issue-source" | "mcp";

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
  /** Secret connectors (Linear, Figma, Context7): a credential is stored. */
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
    capabilities: { ingest: true, postResult: true, notify: false },
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
];

/** Default ingest label, matching the AFK CLI's ready label / GitHubConnector. */
export const DEFAULT_INGEST_LABEL = "ready-for-agent";

/** Look up a catalog entry by kind (total over the catalog). */
export function catalogEntry(kind: ConnectorKind): ConnectorCatalogEntry {
  // Safe: every ConnectorKind has exactly one catalog entry.
  return CONNECTOR_CATALOG.find((e) => e.kind === kind)!;
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

      // Display target: oauth → the stored target (repo); everything else → none.
      const target = entry.connectMethod === "oauth" ? cfg?.target ?? null : null;

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
 * Validate a connector's credential for connect. `secret` is the API key /
 * token. Returns `{ok:true}` or a human error. OAuth (GitHub) has no
 * credential to validate here.
 */
export function validateConnectorCredential(
  kind: ConnectorKind,
  secret: string
): CredentialCheck {
  const s = secret.trim();
  if (s.length === 0) return { ok: false, error: "A credential is required." };
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
    case "github":
      // GitHub is OAuth — nothing to paste here.
      return { ok: false, error: "This connector is not credential-based." };
  }
}
