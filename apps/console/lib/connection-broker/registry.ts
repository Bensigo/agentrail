import type {
  BrokerConnectorKind,
  ConnectorConnectionDefinition,
  SubagentConnectionGrant,
  SubagentKind,
} from "./types";

/**
 * Provider capabilities are deliberately separate from the existing catalog.
 * The catalog describes product role; this registry describes how Jace obtains
 * and scopes a connection for a subagent.
 */
export const CONNECTION_DEFINITIONS: Record<
  BrokerConnectorKind,
  ConnectorConnectionDefinition
> = {
  github: {
    kind: "github",
    label: "GitHub",
    mode: "direct-oauth",
    oneClick: true,
    manualFallback: false,
    supportedDeployments: ["hosted"],
  },
  linear: {
    kind: "linear",
    label: "Linear",
    mode: "remote-mcp-oauth",
    oneClick: true,
    remoteMcp: { url: "https://mcp.linear.app/mcp", deployment: "hosted" },
    manualFallback: true,
    supportedDeployments: ["hosted"],
  },
  figma: {
    kind: "figma",
    label: "Figma",
    mode: "remote-mcp-oauth",
    oneClick: true,
    remoteMcp: { url: "https://mcp.figma.com/mcp", deployment: "hosted" },
    manualFallback: true,
    supportedDeployments: ["hosted"],
  },
  context7: {
    kind: "context7",
    label: "Context7",
    mode: "remote-mcp-oauth",
    oneClick: true,
    remoteMcp: {
      url: "https://mcp.context7.com/mcp/oauth",
      deployment: "hosted",
    },
    manualFallback: true,
    supportedDeployments: ["hosted"],
  },
  railway: {
    kind: "railway",
    label: "Railway",
    mode: "direct-oauth",
    oneClick: true,
    manualFallback: true,
    supportedDeployments: ["hosted"],
  },
  langfuse: {
    kind: "langfuse",
    label: "Langfuse",
    mode: "manual",
    oneClick: false,
    remoteMcp: {
      url: "https://cloud.langfuse.com/api/public/mcp",
      deployment: "hosted",
    },
    manualFallback: true,
    supportedDeployments: ["hosted", "self-hosted"],
  },
  sentry: {
    kind: "sentry",
    label: "Sentry",
    mode: "direct-oauth",
    oneClick: true,
    manualFallback: true,
    supportedDeployments: ["hosted"],
  },
  datadog: {
    kind: "datadog",
    label: "Datadog",
    mode: "remote-mcp-oauth",
    oneClick: true,
    remoteMcp: {
      url: "https://mcp.datadoghq.com/v1/mcp",
      defaultQuery: "toolsets=core",
      deployment: "hosted",
    },
    manualFallback: true,
    supportedDeployments: ["hosted"],
  },
  prometheus: {
    kind: "prometheus",
    label: "Prometheus",
    mode: "manual",
    oneClick: false,
    manualFallback: true,
    supportedDeployments: ["self-hosted"],
  },
  grafana: {
    kind: "grafana",
    label: "Grafana",
    mode: "remote-mcp-oauth",
    oneClick: true,
    remoteMcp: {
      url: "https://mcp.grafana.com/mcp",
      deployment: "hosted",
    },
    manualFallback: true,
    supportedDeployments: ["hosted", "self-hosted"],
  },
  vercel: {
    kind: "vercel",
    label: "Vercel",
    mode: "direct-oauth",
    oneClick: true,
    remoteMcp: { url: "https://mcp.vercel.com", deployment: "hosted" },
    manualFallback: true,
    supportedDeployments: ["hosted"],
  },
  cloudflare: {
    kind: "cloudflare",
    label: "Cloudflare",
    mode: "direct-oauth",
    oneClick: true,
    remoteMcp: {
      url: "https://mcp.cloudflare.com/mcp",
      deployment: "hosted",
    },
    manualFallback: true,
    supportedDeployments: ["hosted"],
  },
};

const SUBAGENT_GRANTS: Record<SubagentKind, SubagentConnectionGrant> = {
  debugger: {
    subagent: "debugger",
    canRead: true,
    writePolicy: "none",
    allowedToolsets: ["read", "observability", "search"],
  },
  reviewer: {
    subagent: "reviewer",
    canRead: true,
    writePolicy: "approval-required",
    allowedToolsets: ["read", "observability", "search", "review"],
  },
  implementer: {
    subagent: "implementer",
    canRead: true,
    writePolicy: "approval-required",
    allowedToolsets: ["read", "observability", "search", "review", "write"],
  },
  researcher: {
    subagent: "researcher",
    canRead: true,
    writePolicy: "none",
    allowedToolsets: ["read", "search", "docs"],
  },
  qa: {
    subagent: "qa",
    canRead: true,
    writePolicy: "none",
    allowedToolsets: ["read", "browser", "observability"],
  },
};

export function connectionDefinitionFor(
  kind: BrokerConnectorKind
): ConnectorConnectionDefinition {
  return CONNECTION_DEFINITIONS[kind];
}

export function isBrokerConnectorKind(kind: string): kind is BrokerConnectorKind {
  return Object.prototype.hasOwnProperty.call(CONNECTION_DEFINITIONS, kind);
}

export function subagentGrantFor(
  subagent: SubagentKind
): SubagentConnectionGrant {
  return SUBAGENT_GRANTS[subagent];
}
