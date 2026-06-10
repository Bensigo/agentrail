import { NextRequest, NextResponse } from "next/server";
import { createHash, randomBytes } from "crypto";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  listApiKeys,
  createApiKey,
} from "@agentrail/db-postgres";

const ADMIN_ROLES = ["owner", "admin"] as const;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const keys = await listApiKeys(workspaceId);

  const result = keys.map((k) => ({
    id: k.id,
    name: k.name,
    key_prefix: k.keyPrefix,
    team_id: k.teamId,
    created_at: k.createdAt.toISOString(),
    last_used_at: k.lastUsedAt ? k.lastUsedAt.toISOString() : null,
    is_revoked: k.revokedAt !== null,
    revoked_at: k.revokedAt ? k.revokedAt.toISOString() : null,
  }));

  return NextResponse.json({ api_keys: result });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!ADMIN_ROLES.includes(membership.role as (typeof ADMIN_ROLES)[number])) {
    return NextResponse.json(
      { error: "Admin or owner role required" },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => ({})) as { name?: string; team_id?: string };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const raw = randomBytes(32).toString("hex");
  const fullKey = `ar_${raw}`;
  const keyPrefix = `ar_${raw.slice(0, 8)}`;
  const keyHash = createHash("sha256").update(fullKey).digest("hex");

  const created = await createApiKey({
    workspaceId,
    teamId: typeof body.team_id === "string" ? body.team_id : null,
    name,
    keyPrefix,
    keyHash,
  });

  return NextResponse.json(
    {
      api_key: {
        id: created.id,
        name: created.name,
        key_prefix: created.keyPrefix,
        team_id: created.teamId,
        created_at: created.createdAt.toISOString(),
        last_used_at: null,
        is_revoked: false,
        revoked_at: null,
      },
      secret: fullKey,
    },
    { status: 201 }
  );
}
