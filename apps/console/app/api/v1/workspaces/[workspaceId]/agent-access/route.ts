import { createHash, randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  createApiKey,
  getWorkspaceMembership,
  listAgentMcpApiKeys,
} from "@agentrail/db-postgres";
import type { ApiKeyScope } from "@agentrail/db-postgres";

const ADMIN_ROLES = ["owner", "admin"] as const;
const ALLOWED_SCOPES: ApiKeyScope[] = [
  "acceptance:read",
  "acceptance:draft:write",
  "acceptance:context:write",
];

async function requireWorkspaceAdmin(workspaceId: string) {
  const session = await auth();
  if (!session?.user?.id) return null;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership || !ADMIN_ROLES.includes(membership.role as (typeof ADMIN_ROLES)[number])) {
    return false;
  }
  return true;
}

function toMetadata(key: Awaited<ReturnType<typeof listAgentMcpApiKeys>>[number]) {
  return {
    id: key.id,
    name: key.name,
    key_prefix: key.keyPrefix,
    scopes: key.scopes,
    created_at: key.createdAt.toISOString(),
    last_used_at: key.lastUsedAt?.toISOString() ?? null,
    revoked_at: key.revokedAt?.toISOString() ?? null,
  };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const authorized = await requireWorkspaceAdmin(workspaceId);
  if (authorized === null) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!authorized) return NextResponse.json({ error: "Admin or owner role required" }, { status: 403 });

  return NextResponse.json({ credentials: (await listAgentMcpApiKeys(workspaceId)).map(toMetadata) });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const authorized = await requireWorkspaceAdmin(workspaceId);
  if (authorized === null) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!authorized) return NextResponse.json({ error: "Admin or owner role required" }, { status: 403 });

  const body = await request.json().catch(() => ({})) as { name?: unknown; scopes?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const scopes = Array.isArray(body.scopes) && body.scopes.every((scope) => typeof scope === "string")
    ? [...new Set(body.scopes)]
    : null;
  if (!name || !scopes?.length || scopes.some((scope) => !ALLOWED_SCOPES.includes(scope as ApiKeyScope))) {
    return NextResponse.json({ error: "name and one or more valid scopes are required" }, { status: 400 });
  }

  const raw = randomBytes(32).toString("hex");
  const secret = `jace_mcp_${raw}`;
  const created = await createApiKey({
    workspaceId,
    teamId: null,
    name,
    keyPrefix: `jace_mcp_${raw.slice(0, 8)}`,
    keyHash: createHash("sha256").update(secret).digest("hex"),
    kind: "agent_mcp",
    scopes: scopes as ApiKeyScope[],
  });

  return NextResponse.json({ credential: toMetadata(created as never), secret }, { status: 201 });
}
