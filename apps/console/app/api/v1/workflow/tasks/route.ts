import { NextRequest, NextResponse } from "next/server";
import { listWorkflowTasks, startWorkflowTask, WorkflowConflict, type WorkflowStart } from "@agentrail/db-postgres";
import { workflowAuthority, workflowBody, workflowStartValid } from "../../../../../lib/workflow-api";

export async function GET(req: NextRequest) {
  const authority = await workflowAuthority(req);
  if (authority instanceof NextResponse) return authority;
  return NextResponse.json({ tasks: await listWorkflowTasks(authority.workspaceId), limit: 100 });
}
export async function POST(req: NextRequest) {
  const authority = await workflowAuthority(req, true);
  if (authority instanceof NextResponse) return authority;
  if (authority.human) return NextResponse.json({ error: "Start tasks through your connected coding agent" }, { status: 403 });
  const body = await workflowBody(req);
  if (!body || !workflowStartValid(body)) return NextResponse.json({ error: "Invalid workflow task" }, { status: 400 });
  try {
    return NextResponse.json({ task: await startWorkflowTask(authority.workspaceId, body as unknown as WorkflowStart, authority.actorId) }, { status: 201 });
  } catch (error) {
    if (error instanceof WorkflowConflict) return NextResponse.json({ error: error.message }, { status: 409 });
    console.error("Workflow start failed");
    return NextResponse.json({ error: "Workflow unavailable" }, { status: 500 });
  }
}
