import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { parseAcceptanceContract } from "@agentrail/contracts";
import {
  createDraftAcceptanceRecord,
  getRepositoryByName,
  getWorkspaceMembership,
  listChangeRecords,
} from "@agentrail/db-postgres";

function serializeRecord(record: Awaited<ReturnType<typeof listChangeRecords>>[number]) {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    repo: record.repo,
    issueNumber: record.issueNumber,
    prNumber: record.prNumber,
    headShas: record.headShas,
    mergedSha: record.mergedSha,
    state: record.state,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function parseSourceReferences(value: unknown): Record<string, unknown>[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) return null;
  return value.every(isPlainObject) ? value : null;
}

function serializeDraft(
  draft: Awaited<ReturnType<typeof createDraftAcceptanceRecord>>
) {
  return {
    record: {
      ...serializeRecord(draft.record),
      workKey: draft.record.workKey,
      originChannel: draft.record.originChannel,
      sourceReferences: draft.record.sourceReferences,
    },
    contract: {
      id: draft.contract.id,
      recordId: draft.contract.recordId,
      version: draft.contract.version,
      status: draft.contract.status,
      contract: draft.contract.contract,
      createdBy: draft.contract.createdBy,
      confirmedBy: draft.contract.confirmedBy,
      confirmedAt: draft.contract.confirmedAt?.toISOString() ?? null,
      createdAt: draft.contract.createdAt.toISOString(),
    },
  };
}

export async function GET(
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

  const repo = request.nextUrl.searchParams.get("repo")?.trim() || null;
  const records = await listChangeRecords({ workspaceId, repo });
  return NextResponse.json({ records: records.map(serializeRecord), repo });
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

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const repo = typeof body.repo === "string" ? body.repo.trim() : "";
  const originChannel =
    typeof body.originChannel === "string" ? body.originChannel.trim() : "";
  const workKey = typeof body.workKey === "string" ? body.workKey.trim() : undefined;
  const sourceReferences = parseSourceReferences(body.sourceReferences);
  const errors: Record<string, string> = {};
  if (!repo) errors.repo = "repo is required";
  if (!originChannel) errors.originChannel = "originChannel is required";
  if (sourceReferences == null) {
    errors.sourceReferences = "sourceReferences must be an array of at most 32 objects";
  }
  if (Object.keys(errors).length > 0) {
    return NextResponse.json({ errors }, { status: 400 });
  }
  const parsedContract = parseAcceptanceContract(body.contract);
  if (!parsedContract.ok) {
    return NextResponse.json({ errors: parsedContract.errors }, { status: 400 });
  }

  try {
    if (!(await getRepositoryByName(workspaceId, repo))) {
      return NextResponse.json({ error: "Repository not found" }, { status: 404 });
    }
    const draft = await createDraftAcceptanceRecord({
      workspaceId,
      repo,
      originChannel,
      sourceReferences: sourceReferences!,
      contract: parsedContract.value,
      createdBy: `user:${session.user.id}`,
      workKey,
    });
    return NextResponse.json(serializeDraft(draft), { status: 201 });
  } catch (err) {
    console.error("[change-records] failed to create Acceptance Record:", err);
    return NextResponse.json(
      { error: "Failed to create Acceptance Record" },
      { status: 500 }
    );
  }
}
