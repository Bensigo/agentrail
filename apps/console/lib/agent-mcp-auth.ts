import { NextRequest, NextResponse } from "next/server";
import type { ApiKeyScope } from "@agentrail/db-postgres";
import { requireAgentMcpBearer } from "./bearer-auth";

/** Bind a scoped MCP credential to its own workspace, never merely a URL id. */
export async function requireAgentMcpWorkspace(
  request: NextRequest,
  workspaceId: string,
  scope: ApiKeyScope
) {
  const authorization = await requireAgentMcpBearer(request, scope);
  if (authorization instanceof NextResponse) return authorization;
  if (authorization.workspaceId !== workspaceId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return authorization;
}
