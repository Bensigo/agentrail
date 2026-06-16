import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  getHeartbeatConfig,
  setHeartbeatConfig,
  validateHeartbeatConfigUpdate,
  type HeartbeatConfigUpdate,
} from "@agentrail/db-postgres";

/**
 * Heartbeat trigger management (MVP, #4).
 *
 * The **Heartbeat** is the autonomous loop that polls GitHub for issues labeled
 * the workspace's `triggerLabel` every `pollIntervalSeconds` and admits them
 * into the Issue Queue. This route is its control surface: GET reads the config
 * (any member), PUT writes it (owner/admin only). The live daemon READS the same
 * config from Postgres; whether it may actually run is still governed by the
 * capability gate (agentrail/heartbeat/gate.py) — `enabled` here is intent.
 */
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

  try {
    const config = await getHeartbeatConfig(workspaceId);
    return NextResponse.json({ config, role: membership.role });
  } catch (err) {
    console.error("[heartbeat] failed to read config:", err);
    return NextResponse.json(
      { error: "Failed to load heartbeat config" },
      { status: 500 }
    );
  }
}

export async function PUT(
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
  if (membership.role !== "owner" && membership.role !== "admin") {
    return NextResponse.json(
      { error: "Only an owner or admin can manage the heartbeat" },
      { status: 403 }
    );
  }

  let body: HeartbeatConfigUpdate;
  try {
    body = (await request.json()) as HeartbeatConfigUpdate;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const result = validateHeartbeatConfigUpdate(body ?? {});
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  try {
    const config = await setHeartbeatConfig(workspaceId, result.value);
    return NextResponse.json({ config });
  } catch (err) {
    console.error("[heartbeat] failed to save config:", err);
    return NextResponse.json(
      { error: "Failed to save heartbeat config" },
      { status: 500 }
    );
  }
}
