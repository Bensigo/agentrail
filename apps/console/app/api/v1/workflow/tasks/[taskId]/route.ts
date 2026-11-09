import { NextRequest, NextResponse } from "next/server";
import { readWorkflowTask, updateWorkflowTask, WorkflowConflict, type WorkflowUpdate } from "@agentrail/db-postgres";
import { UUID, workflowAuthority, workflowBody, workflowUpdateValid } from "../../../../../../lib/workflow-api";

type Context = { params: Promise<{ taskId: string }> };
export async function GET(req: NextRequest, context: Context) {
  const authority = await workflowAuthority(req);
  if (authority instanceof NextResponse) return authority;
  const { taskId } = await context.params;
  if (!UUID.test(taskId)) return NextResponse.json({ error: "Invalid task" }, { status: 400 });
  const task = await readWorkflowTask(authority.workspaceId, taskId);
  return task ? NextResponse.json(task) : NextResponse.json({ error: "Not found" }, { status: 404 });
}
export async function POST(req: NextRequest, context: Context) {
  const authority = await workflowAuthority(req, true);
  if (authority instanceof NextResponse) return authority;
  const { taskId } = await context.params;
  const body = await workflowBody(req);
  if (!UUID.test(taskId) || !body || !workflowUpdateValid(body, authority.human)) return NextResponse.json({ error: "Invalid workflow event" }, { status: 400 });
  try {
    // Actor identity is server-derived, never accepted from an agent payload.
    const input = body as unknown as WorkflowUpdate;
    const result = await updateWorkflowTask(authority.workspaceId, taskId, input, authority.human, authority.actorId);
    return result ? NextResponse.json(result) : NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    if (error instanceof WorkflowConflict) return NextResponse.json({ error: error.message }, { status: 409 });
    console.error("Workflow update failed");
    return NextResponse.json({ error: "Workflow unavailable" }, { status: 500 });
  }
}
