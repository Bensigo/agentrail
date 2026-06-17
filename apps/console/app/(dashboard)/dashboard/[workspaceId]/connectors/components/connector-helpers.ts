/**
 * Pure model for the **Connectors** management surface (M038, AC3 + catalog
 * expansion).
 *
 * A **Connector** (CONTEXT.md, ADR 0010) is the seam between an external tool and
 * AgentRail. The catalog now spans three **connector types**, each with its own
 * connect mechanism — the surface groups the cards by type:
 *
 *   - **https**  — connected at OAuth login. GitHub: the workspace owner logs in
 *     with GitHub, so the connector is live once a repo is linked (no secret to
 *     paste). Two-way issue ingest + post-result.
 *   - **mcp**    — Model-Context-Protocol tool servers the agent can call. Linear,
 *     Figma, Context7: each stores a per-workspace API key/token (write-only) and
 *     exposes its tools to a run.
 *   - **gateway** — outbound communication channels (notify). Discord, Slack,
 *     Telegram: each posts run completion / escalation messages to a channel.
 *
 * This module is the pure projection the console reads (no I/O, unit-testable):
 * the catalog, the per-provider connect metadata, and how a connector's
 * *connected* state is derived from the workspace's stored config. The adapter
 * implementations live in `agentrail/connectors/`; this surface only lets a team
 * connect and manage them — it never decides admission (the input-contract gate's
 * job, server-side).
 */

/** The external tools AgentRail can connect (M038 catalog). */
export type ConnectorKind =
  | "github"
  | "linear"
  | "figma"
  | "context7"
  | "discord"
  | "slack"
  | "telegram";

/** Which catalog group a connector belongs to (drives the page sections). */
export type ConnectorType = "https" | "mcp" | "gateway";

/**
 * How a connector is connected:
 *  - `oauth`   — comes online at login (GitHub); nothing to paste here.
 *  - `secret`  — store a per-workspace API key / token (mcp + slack/telegram).
 *  - `webhook` — store a channel webhook URL on the workspace (Discord, legacy).
 */
export type ConnectorConnectMethod = "oauth" | "secret" | "webhook";

/** Whether an adapter is implemented today, vs. planned in a follow-up. */
export type ConnectorAvailability = "available" | "planned";

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
}

/** Per-provider connect metadata the card renders (label, placeholder, how-to). */
export interface ConnectorConnectMeta {
  /** Field label for the credential input (e.g. "API key", "Webhook URL"). */
  credentialLabel: string;
  /** Placeholder hinting the expected shape (e.g. `lin_api_…`). */
  credentialPlaceholder: string;
  /** A one-line hint about the credential format, shown under the input. */
  credentialHint: string;
  /** Link to the provider's setup docs. */
  helpUrl: string;
  /** Short, ordered "how to create the app / key" steps (gateway/mcp setup). */
  setupSteps: string[];
  /** Telegram also needs a target chat id alongside the bot token. */
  needsChatId?: boolean;
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
  /** Secret connectors (mcp + slack/telegram): a credential is stored. */
  hasSecret?: boolean;
  /** The label a connector ingests issues by (GitHub: the AFK ready label). */
  ingestLabel?: string | null;
  /** Repo / project / channel the connector is bound to, for display. */
  target?: string | null;
  /** Telegram gateway: the target chat id (non-secret; displayed). */
  chatId?: string | null;
  /**
   * Discord notify connector: the configured webhook URL. Present + non-empty
   * means the channel is wired. Never sent back to the client in full — the read
   * model masks it to a display target; see {@link maskWebhook}.
   */
  webhookUrl?: string | null;
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
  chatId: string | null;
  connect: ConnectorConnectMeta | null;
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
  https: {
    label: "HTTPS",
    description:
      "Connected at login over HTTPS — links your code host so labeled issues flow into the Issue Queue and results post back.",
  },
  mcp: {
    label: "MCP",
    description:
      "Model-Context-Protocol tool servers — codebase-level. Adding an API key writes the server into your repo's MCP config (.mcp.json) at run time, so the coding agent can call its tools during a run.",
  },
  gateway: {
    label: "Gateway",
    description:
      "Communication channels — platform-level. AgentRail (not your code) posts run completion and escalation-to-human notifications to the channel you connect.",
  },
};

/**
 * The connector catalog, grouped by type (https → mcp → gateway). GitHub is the
 * OAuth-login connector; Linear / Figma / Context7 are MCP key connectors;
 * Discord / Slack / Telegram are gateway notify channels. Order here drives the
 * page sections.
 */
export const CONNECTOR_CATALOG: ConnectorCatalogEntry[] = [
  // -- https ---------------------------------------------------------------- //
  {
    kind: "github",
    type: "https",
    connectMethod: "oauth",
    label: "GitHub",
    description:
      "Ingest labeled issues into the Issue Queue and post run results back on the issue.",
    availability: "available",
    capabilities: { ingest: true, postResult: true, notify: false },
  },
  // -- mcp ------------------------------------------------------------------ //
  {
    kind: "linear",
    type: "mcp",
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
  // -- gateway -------------------------------------------------------------- //
  {
    kind: "discord",
    type: "gateway",
    connectMethod: "webhook",
    label: "Discord",
    description:
      "Notify a channel on run completion or escalation-to-human via a webhook.",
    availability: "available",
    capabilities: { ingest: false, postResult: false, notify: true },
    connect: {
      credentialLabel: "Channel webhook URL",
      credentialPlaceholder: "https://discord.com/api/webhooks/…",
      credentialHint: "A Discord channel webhook — under discord.com/api/webhooks/.",
      helpUrl:
        "https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks",
      setupSteps: [
        "In Discord, open the target channel → Edit Channel → Integrations → Webhooks.",
        "Click “New Webhook”, pick the channel, then “Copy Webhook URL”.",
        "Paste it here and connect.",
      ],
    },
  },
  {
    kind: "slack",
    type: "gateway",
    connectMethod: "secret",
    label: "Slack",
    description:
      "Notify a Slack channel on run completion or escalation-to-human via an incoming webhook.",
    availability: "available",
    capabilities: { ingest: false, postResult: false, notify: true },
    connect: {
      credentialLabel: "Incoming webhook URL",
      credentialPlaceholder: "https://hooks.slack.com/services/…",
      credentialHint: "A Slack incoming webhook — under hooks.slack.com/services/.",
      helpUrl: "https://api.slack.com/messaging/webhooks",
      setupSteps: [
        "Go to api.slack.com/apps → Create New App → From scratch, pick your workspace.",
        "Open “Incoming Webhooks”, toggle it on, then “Add New Webhook to Workspace”.",
        "Choose the channel, Authorize, then copy the hooks.slack.com/services/… URL.",
        "Paste it here and connect.",
      ],
    },
  },
  {
    kind: "telegram",
    type: "gateway",
    connectMethod: "secret",
    label: "Telegram",
    description:
      "Notify a Telegram chat on run completion or escalation-to-human via a bot.",
    availability: "available",
    capabilities: { ingest: false, postResult: false, notify: true },
    connect: {
      credentialLabel: "Bot token",
      credentialPlaceholder: "123456789:ABCdef…",
      credentialHint: "A BotFather token (digits:token) plus the target chat id.",
      helpUrl: "https://core.telegram.org/bots#how-do-i-create-a-bot",
      needsChatId: true,
      setupSteps: [
        "In Telegram, message @BotFather → /newbot, set a name + username, copy the token.",
        "Add the bot to your group/channel (or DM it), then send it any message.",
        "Open https://api.telegram.org/bot<token>/getUpdates and copy chat.id.",
        "Paste the token + chat id here and connect.",
      ],
    },
  },
];

/** Default ingest label, matching the AFK CLI's ready label / GitHubConnector. */
export const DEFAULT_INGEST_LABEL = "ready-for-agent";

/**
 * Mask a Discord webhook URL into a safe, recognizable display target — never
 * leak the secret token. A Discord webhook looks like
 * `https://discord.com/api/webhooks/<id>/<token>`; we show the id and elide the
 * token. Falsy / unparseable input yields `null` (nothing to display).
 */
export function maskWebhook(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/\/webhooks\/(\d+)\//);
  if (m) return `webhook ${m[1]}`;
  return "webhook configured";
}

/** Look up a catalog entry by kind (total over the catalog). */
export function catalogEntry(kind: ConnectorKind): ConnectorCatalogEntry {
  // Safe: every ConnectorKind has exactly one catalog entry.
  return CONNECTOR_CATALOG.find((e) => e.kind === kind)!;
}

/**
 * Derive whether a connector is connected from its stored config, by connect
 * method. OAuth → the `connected` flag (GitHub repos linked); webhook → a webhook
 * is set; secret → a credential is stored (`hasSecret`).
 */
function isConnected(
  entry: ConnectorCatalogEntry,
  cfg: ConnectorConfigInput | undefined
): boolean {
  switch (entry.connectMethod) {
    case "oauth":
      return Boolean(cfg?.connected);
    case "webhook":
      return Boolean(cfg?.webhookUrl);
    case "secret":
      return Boolean(cfg?.hasSecret);
  }
}

/**
 * Project the catalog against the workspace's stored connector config into the
 * rows the surface renders. Pure and total: a kind with no config row is
 * `disconnected`; only an `available` connector that is actually connected (per
 * its connect method) shows `connected`.
 */
export function projectConnectors(
  configs: ConnectorConfigInput[]
): ConnectorView[] {
  const byKind = new Map<ConnectorKind, ConnectorConfigInput>();
  for (const c of configs) byKind.set(c.kind, c);

  return CONNECTOR_CATALOG.map((entry) => {
    const cfg = byKind.get(entry.kind);
    const connected = entry.availability === "available" && isConnected(entry, cfg);
    const status: ConnectorStatus = connected ? "connected" : "disconnected";

    // A notify-only / tools-only connector has no ingest label; only ingest does.
    const ingestLabel =
      status === "connected" && entry.capabilities.ingest
        ? cfg?.ingestLabel ?? DEFAULT_INGEST_LABEL
        : null;

    // Display target by connect method: webhook → masked; telegram → chat id;
    // oauth → the stored target (repo); other secret connectors → none.
    let target: string | null = null;
    if (entry.connectMethod === "webhook") {
      target = maskWebhook(cfg?.webhookUrl);
    } else if (entry.kind === "telegram") {
      target = status === "connected" ? cfg?.chatId ?? null : null;
    } else if (entry.connectMethod === "oauth") {
      target = cfg?.target ?? null;
    }

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
      chatId: cfg?.chatId ?? null,
      connect: entry.connect ?? null,
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

/** Is `url` a Slack incoming webhook (https, hooks.slack.com/services/…)? */
export function isSlackWebhook(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      u.hostname.toLowerCase() === "hooks.slack.com" &&
      u.pathname.startsWith("/services/")
    );
  } catch {
    return false;
  }
}

/** Is `token` shaped like a BotFather token (`<digits>:<35+ token chars>`)? */
export function isTelegramToken(token: string): boolean {
  return /^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(token.trim());
}

/** Is `id` a plausible Telegram chat id (numeric, optionally -100…, or @name)? */
export function isTelegramChatId(id: string): boolean {
  const v = id.trim();
  return /^-?\d{1,32}$/.test(v) || /^@[A-Za-z0-9_]{4,}$/.test(v);
}

/**
 * Validate a connector's credential for connect. `secret` is the API key / token
 * / webhook URL; `chatId` is required for Telegram. Returns `{ok:true}` or a
 * human error. OAuth connectors (GitHub) have no credential to validate here.
 */
export function validateConnectorCredential(
  kind: ConnectorKind,
  secret: string,
  chatId?: string
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
    case "slack":
      return isSlackWebhook(s)
        ? { ok: true }
        : { ok: false, error: "Provide a Slack hooks.slack.com/services/… URL." };
    case "telegram": {
      if (!isTelegramToken(s))
        return { ok: false, error: "Provide a BotFather token (digits:token)." };
      if (!chatId || !isTelegramChatId(chatId))
        return {
          ok: false,
          error: "Provide a valid chat id (numeric or @channel).",
        };
      return { ok: true };
    }
    case "discord":
    case "github":
      // Discord uses its dedicated webhook route; GitHub is OAuth — no secret here.
      return { ok: false, error: "This connector is not credential-based." };
  }
}
