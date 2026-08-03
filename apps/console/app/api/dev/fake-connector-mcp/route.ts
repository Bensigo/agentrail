import { NextRequest, NextResponse } from "next/server";
import { canUseConnectorTool } from "../../../../lib/connection-broker";
import type { SubagentKind } from "../../../../lib/connection-broker";

/** Local-only MCP endpoint used to verify the disposable OAuth smoke account. */
export async function POST(request: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer codex-smoke-")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const subagent = request.headers.get("x-jace-subagent") as SubagentKind | null;
  if (!subagent || !["debugger", "reviewer", "implementer", "researcher", "qa"].includes(subagent)) {
    return NextResponse.json({ error: "Missing subagent grant" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    id?: string | number;
    method?: string;
    params?: { name?: string };
  } | null;
  const isWrite = body?.method === "tools/call" && body?.params?.name === "update_write";
  const allowed = canUseConnectorTool({
    subagent,
    toolset: isWrite ? "write" : "read",
    mutates: isWrite,
    approvalGranted: request.headers.get("x-jace-approval") === "granted",
  });
  if (!allowed) return NextResponse.json({ error: "Subagent grant denied" }, { status: 403 });
  if (body?.method === "tools/list") {
    return NextResponse.json({
      jsonrpc: "2.0",
      id: body.id ?? null,
      result: {
        tools: [
          { name: "search_read", annotations: { readOnlyHint: true } },
          { name: "update_write", annotations: { destructiveHint: false } },
        ],
      },
    });
  }
  return NextResponse.json({
    jsonrpc: "2.0",
    id: body?.id ?? null,
    result: { content: [{ type: "text", text: "fake connector ok" }] },
  });
}
