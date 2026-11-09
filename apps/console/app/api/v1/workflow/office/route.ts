import { NextRequest, NextResponse } from "next/server";
import { readWorkflowOffice } from "@agentrail/db-postgres";
import { workflowAuthority } from "../../../../../lib/workflow-api";
export async function GET(request: NextRequest) {
  const authority = await workflowAuthority(request);
  if (authority instanceof NextResponse) return authority;
  return NextResponse.json(await readWorkflowOffice(authority.workspaceId), {
    headers: { "cache-control": "private, no-store" },
  });
}
