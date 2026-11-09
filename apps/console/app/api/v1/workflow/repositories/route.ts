import { NextRequest, NextResponse } from "next/server";
import { listWorkspaceRepositories } from "@agentrail/db-postgres";
import { workflowAuthority } from "../../../../../lib/workflow-api";
export async function GET(req: NextRequest) {
  const authority = await workflowAuthority(req);
  if (authority instanceof NextResponse) return authority;
  const repositories = await listWorkspaceRepositories(authority.workspaceId);
  return NextResponse.json({ repositories: repositories.map(r => ({ id: r.id, name: r.name, url: r.url, defaultBranch: r.defaultBranch })) });
}
