import { subagentGrantFor } from "./registry";
import type { SubagentKind } from "./types";

export interface ConnectorToolRequest {
  subagent: SubagentKind;
  toolset: string;
  mutates: boolean;
  approvalGranted?: boolean;
}
/**
 * Enforce the broker's subagent boundary before a connector tool call leaves
 * Jace. The model may request a tool, but it cannot widen its grant or turn an
 * approval-required write into an unapproved write.
 */
export function canUseConnectorTool(request: ConnectorToolRequest): boolean {
  const grant = subagentGrantFor(request.subagent);
  if (!grant.canRead || !grant.allowedToolsets.includes(request.toolset)) return false;
  if (!request.mutates) return true;
  if (grant.writePolicy === "none") return false;
  if (grant.writePolicy === "approval-required" && !request.approvalGranted) return false;
  return true;
}
