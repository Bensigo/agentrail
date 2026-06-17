import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  insertMemoryItems,
  getRepository,
} from "@agentrail/db-postgres";
import { getFailureById } from "@agentrail/db-clickhouse";

// "Add to memory" from a failure: distil the failure into a durable lesson the
// retrieval layer can surface on future runs so the agent avoids repeating it.
export async function POST(
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

  // Optional caller-supplied note overrides the default distilled content.
  const body = (await request.json().catch(() => ({}))) as { note?: string };

  const content =
    body.note?.trim() ||
    [
      `Failure (${failure.failure_type}) in ${failure.phase} phase: ${failure.message}`,
      failure.normalized_error
        ? `Normalized error: ${failure.normalized_error}`
        : null,
      "Watch for this and avoid repeating it on future runs.",
    ]
      .filter(Boolean)
      .join("\n");

  // The failure record carries the ClickHouse repository_id string; resolve it
  // to a Postgres repository row when it is a real uuid so the memory item is
  // scoped to the repo. Non-uuid / unknown ids fall back to workspace scope.
  let repositoryId: string | null = null;
  if (failure.repository_id) {
    try {
      const repo = await getRepository(workspaceId, failure.repository_id);
      if (repo) repositoryId = repo.id;
    } catch {
      // best-effort scoping; workspace-level memory is still useful
    }
  }

  try {
    await insertMemoryItems({
      workspaceId,
      repositoryId,
      source: "failure",
      items: [
        {
          content,
          tags: [
            "failure",
            `failure_type:${failure.failure_type}`,
            `run:${failure.run_id}`,
            `severity:${failure.severity}`,
          ],
        },
      ],
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to save memory item" },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
