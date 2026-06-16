/**
 * Pure model for the **Connectors** management surface (M038, AC3).
 *
 * A **Connector** (CONTEXT.md, ADR 0010) is the two-way seam between an external
 * tool and the **Issue Queue**: it ingests human-created issues into the queue
 * and reports results back. This module is the pure projection the console reads
 * — the connector catalog and how a connector's *connected* state is derived
 * from the workspace's stored config. No I/O, unit-testable in isolation
 * (verification-contract-architecture.md: console surfaces are thin; keep the
 * logic falsifiable).
 *
 * The adapter implementations live in `agentrail/connectors/` (the GitHub
 * adapter is the one that actually ingests + posts). This surface only lets a
 * team *connect and manage* them; it never decides admission (that is the
 * input-contract gate's job, server-side).
 */

/** The external tools AgentRail can connect (M038 catalog). */
export type ConnectorKind = "github" | "linear" | "discord";

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
}

/** Static catalog entry for a connector kind. */
export interface ConnectorCatalogEntry {
  kind: ConnectorKind;
  label: string;
  description: string;
  availability: ConnectorAvailability;
  capabilities: ConnectorCapabilities;
}

/** Per-workspace stored configuration for one connector (subset persisted). */
export interface ConnectorConfigInput {
  kind: ConnectorKind;
  /** Present + truthy when the team has connected this connector. */
  connected: boolean;
  /** The label a connector ingests issues by (GitHub: the AFK ready label). */
  ingestLabel?: string | null;
  /** Repo / project / channel the connector is bound to, for display. */
  target?: string | null;
  /**
   * Discord notify connector: the configured webhook URL. Present + non-empty
   * means the channel is wired (the connector posts completion / escalation
   * notifications to it). Never sent back to the client in full — the read model
   * masks it to a display target; see {@link maskWebhook}.
   */
  webhookUrl?: string | null;
}

/** One connector row as the management surface renders it. */
export interface ConnectorView {
  kind: ConnectorKind;
  label: string;
  description: string;
  availability: ConnectorAvailability;
  status: ConnectorStatus;
  capabilities: ConnectorCapabilities;
  ingestLabel: string | null;
  target: string | null;
}

/**
 * The connector catalog. GitHub and Linear are implemented adapters (M038 AC2/AC3);
 * Discord is a planned follow-up (M038 AC4) — shown so the surface is honest about
 * what can be connected today vs. what is coming, never faking a capability that
 * does not exist.
 */
export const CONNECTOR_CATALOG: ConnectorCatalogEntry[] = [
  {
    kind: "github",
    label: "GitHub",
    description:
      "Ingest labeled issues into the Issue Queue and post run results back on the issue.",
    availability: "available",
    capabilities: { ingest: true, postResult: true, notify: false },
  },
  {
    kind: "linear",
    label: "Linear",
    description:
      "Ingest labeled Linear issues into the Issue Queue and post run results back on the issue.",
    availability: "available",
    capabilities: { ingest: true, postResult: true, notify: false },
  },
  {
    kind: "discord",
    label: "Discord",
    description:
      "Notify a channel on run completion or escalation-to-human via a webhook.",
    availability: "available",
    capabilities: { ingest: false, postResult: false, notify: true },
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

/**
 * Project the catalog against the workspace's stored connector config into the
 * rows the surface renders. Pure and total: a kind with no config row is
 * `disconnected`; only an `available` connector with `connected=true` shows
 * `connected` (a `planned` connector can never report connected — its adapter
 * does not exist yet).
 */
export function projectConnectors(
  configs: ConnectorConfigInput[]
): ConnectorView[] {
  const byKind = new Map<ConnectorKind, ConnectorConfigInput>();
  for (const c of configs) byKind.set(c.kind, c);

  return CONNECTOR_CATALOG.map((entry) => {
    const cfg = byKind.get(entry.kind);
    // Discord is a notify connector: it counts as connected when a webhook is
    // configured (its real, falsifiable signal), independent of the ingest
    // path. Other available connectors use the stored `connected` flag.
    const connected =
      entry.kind === "discord"
        ? Boolean(cfg?.webhookUrl)
        : Boolean(cfg?.connected);
    const status: ConnectorStatus =
      entry.availability === "available" && connected
        ? "connected"
        : "disconnected";
    // A notify-only connector has no ingest label; only ingest connectors do.
    const ingestLabel =
      status === "connected" && entry.capabilities.ingest
        ? cfg?.ingestLabel ?? DEFAULT_INGEST_LABEL
        : null;
    // Discord's display target is the masked webhook; others use the stored one.
    const target =
      entry.kind === "discord"
        ? maskWebhook(cfg?.webhookUrl)
        : cfg?.target ?? null;
    return {
      kind: entry.kind,
      label: entry.label,
      description: entry.description,
      availability: entry.availability,
      status,
      capabilities: entry.capabilities,
      ingestLabel,
      target,
    };
  });
}

/** Human label for a connector status (direct, no hype — TASTE.md). */
export function connectorStatusLabel(status: ConnectorStatus): string {
  return status === "connected" ? "Connected" : "Not connected";
}

/** Summarize a connector's two-way capabilities as a short, scannable string. */
export function capabilitySummary(caps: ConnectorCapabilities): string {
  const parts: string[] = [];
  if (caps.ingest) parts.push("Ingest");
  if (caps.postResult) parts.push("Post result");
  if (caps.notify) parts.push("Notify");
  return parts.join(" · ") || "—";
}
