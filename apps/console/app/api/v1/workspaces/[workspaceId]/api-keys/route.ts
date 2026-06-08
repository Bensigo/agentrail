import { NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, listApiKeys, createApiKey } from "@agentrail/db-postgres";
import { randomBytes, createHash } from "crypto";

export async function GET(
  _request: Request,
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
  return NextResponse.json({
    keys: keys.map((k) => ({
      ...k,
      isRevoked: !!k.revokedAt,
    })),
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership || !["owner", "admin"].includes(membership.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const name = body.name;
  if (!name || typeof name !== "string") {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const secret = `atr_${randomBytes(32).toString("hex")}`;
  const keyPrefix = secret.slice(0, 12);
  const keyHash = createHash("sha256").update(secret).digest("hex");

  const key = await createApiKey({
    workspaceId,
    name,
    keyPrefix,
    keyHash,
    teamId: body.teamId,
  });

  return NextResponse.json({ key: { ...key, secret } }, { status: 201 });
}
