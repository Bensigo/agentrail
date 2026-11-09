import { createHash, randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createApiKey } from "@agentrail/db-postgres";
import { workflowAuthority } from "../../../../../lib/workflow-api";
export async function POST(req: NextRequest) {
  const authority = await workflowAuthority(req, true);
  if (authority instanceof NextResponse) return authority;
  if (!authority.human) return NextResponse.json({ error: "Owner/admin Console session required" }, { status: 403 });
  const secret = `ar_${randomBytes(32).toString("hex")}`;
  const key = await createApiKey({ workspaceId: authority.workspaceId, teamId: null, name: "Coding agent workflow MCP", kind: "workflow_mcp", keyPrefix: secret.slice(0, 11), keyHash: createHash("sha256").update(secret).digest("hex") });
  return NextResponse.json({ id: key.id, secret }, { status: 201, headers: { "cache-control": "no-store" } });
}
