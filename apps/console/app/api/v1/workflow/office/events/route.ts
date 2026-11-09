import { NextRequest, NextResponse } from "next/server";
import { readWorkflowOffice } from "@agentrail/db-postgres";
import { workflowAuthority } from "../../../../../../lib/workflow-api";
import { officeStream } from "../../../../../../lib/office-stream";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(request: NextRequest) {
  const authority = await workflowAuthority(request);
  if (authority instanceof NextResponse) return authority;
  const stream = officeStream({
    signal: request.signal,
    authorized: async () => {
      const current = await workflowAuthority(request);
      return (
        !(current instanceof NextResponse) &&
        current.workspaceId === authority.workspaceId
      );
    },
    read: () => readWorkflowOffice(authority.workspaceId),
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "private, no-cache, no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
