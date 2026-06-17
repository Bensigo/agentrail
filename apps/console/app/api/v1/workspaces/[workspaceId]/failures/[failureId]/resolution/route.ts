import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  getFailureResolution,
  upsertFailureResolution,
} from "@agentrail/db-postgres";
import { getFailureById } from "@agentrail/db-clickhouse";

// Resolution state ("is this fixed?") for a failure. The failure event lives in
// ClickHouse; we read it to derive the stable failure_key (fingerprint, or the
// event_id when there is no fingerprint) so the toggle resolves the whole
// recurring class, not just this one occurrence.
function failureKeyOf(f: { fingerprint?: string; event_id: string }): string {
  return f.fingerprint && f.fingerprint.trim() ? f.fingerprint : f.event_id;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; failureId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { workspaceId, failureId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let failure;
  try {
    failure = await getFailureById(workspaceId, failureId);
  } catch {
    return NextResponse.json(
      { error: "Failed to load failure" },
      { status: 502 }
    );
  }
  if (!failure) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const key = failureKeyOf(failure);
  const resolution = await getFailureResolution(workspaceId, key);
  return NextResponse.json({
    failureKey: key,
    status: resolution?.status ?? "open",
    note: resolution?.note ?? null,
    updatedAt: resolution?.updatedAt?.toISOString() ?? null,
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; failureId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { workspaceId, failureId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    status?: string;
    note?: string;
  };
  if (body.status !== "open" && body.status !== "fixed") {
    return NextResponse.json(
      { error: "status must be 'open' or 'fixed'" },
      { status: 400 }
    );
  }

  let failure;
  try {
    failure = await getFailureById(workspaceId, failureId);
  } catch {
    return NextResponse.json(
      { error: "Failed to load failure" },
      { status: 502 }
    );
  }
  if (!failure) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const key = failureKeyOf(failure);
  const resolution = await upsertFailureResolution({
    workspaceId,
    failureKey: key,
    status: body.status,
    note: body.note ?? null,
    resolvedByUserId: session.user.id,
  });

  return NextResponse.json({
    failureKey: resolution.failureKey,
    status: resolution.status,
    note: resolution.note,
    updatedAt: resolution.updatedAt.toISOString(),
  });
}
