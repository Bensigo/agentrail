import { NextRequest, NextResponse } from "next/server";
import {
  getWorkspace,
  getRepository,
  touchApiKeyLastUsed,
} from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

export async function POST(request: NextRequest) {
  // AC4: verify bearer auth (401 for missing/malformed/invalid/revoked)
  const auth = await requireBearer(request);
  if (auth instanceof NextResponse) {
    return auth;
  }

  const body = await request.json().catch(() => ({})) as {
    workspace_id?: string;
    repository_id?: string;
  };

  const { workspace_id, repository_id } = body;

  if (!workspace_id || !repository_id) {
    return NextResponse.json(
      { error: "workspace_id and repository_id are required" },
      { status: 400 }
    );
  }

  // AC4: key belongs to a different workspace → 403
  if (auth.workspaceId !== workspace_id) {
    return NextResponse.json(
      { error: "API key does not belong to the specified workspace" },
      { status: 403 }
    );
  }

  const workspace = await getWorkspace(workspace_id);
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  // AC4: repository not found in that workspace → 404
  const repo = await getRepository(workspace_id, repository_id);
  if (!repo) {
    return NextResponse.json(
      { error: "Repository not found in this workspace" },
      { status: 404 }
    );
  }

  // AC4: update last_used_at on success
  await touchApiKeyLastUsed(auth.apiKeyId);

  return NextResponse.json({
    workspace: {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
    },
    repository: {
      id: repo.id,
      name: repo.name,
    },
  });
}
