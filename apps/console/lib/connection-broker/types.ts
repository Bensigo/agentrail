/**
 * The connection contract shared by the connectors UI and Jace subagents.
 *
 * A connector is a workspace-level authorization. Subagents receive a scoped
 * grant to use that connection; they never receive the refresh token or the
 * provider's raw credential.
 */
export type BrokerConnectorKind =
  | "github"
  | "linear"
  | "figma"
  | "context7"
  | "railway"
  | "langfuse"
  | "sentry"
  | "datadog"
  | "prometheus"
  | "grafana"
  | "vercel"
  | "cloudflare";

export type ConnectionMode = "direct-oauth" | "remote-mcp-oauth" | "manual";

export type DeploymentMode = "hosted" | "self-hosted";

export type SubagentKind =
  | "debugger"
  | "reviewer"
  | "implementer"
  | "researcher"
  | "qa";

export type WritePolicy = "none" | "approval-required" | "allowed";

export interface RemoteMcpDefinition {
  url: string;
  /** Optional query string used to keep discovery/tool loading bounded. */
  defaultQuery?: string;
  deployment: DeploymentMode;
}

export interface ConnectorConnectionDefinition {
  kind: BrokerConnectorKind;
  label: string;
  mode: ConnectionMode;
  /** Whether the provider's hosted connection is available without manual values. */
  oneClick: boolean;
  remoteMcp?: RemoteMcpDefinition;
  /** Manual credentials remain an explicit advanced path, never the primary UI. */
  manualFallback: boolean;
  supportedDeployments: DeploymentMode[];
}

export interface SubagentConnectionGrant {
  subagent: SubagentKind;
  canRead: boolean;
  writePolicy: WritePolicy;
  /** Tool calls are filtered before they reach the model/runtime. */
  allowedToolsets: string[];
}
