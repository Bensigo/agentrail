import Link from "next/link";
import { notFound } from "next/navigation";
import { readWorkflowTask } from "@agentrail/db-postgres";
import { getSession, getMembership } from "../../../../../../lib/cached";
import { UUID } from "../../../../../../lib/workflow-api";
import { WorkflowControls } from "../controls";
export default async function TaskPage({ params }: { params: Promise<{ workspaceId: string; taskId: string }> }) {
  const { workspaceId, taskId } = await params;
  const session = await getSession();
  if (!session?.user?.id || !UUID.test(taskId)) return notFound();
  const membership = await getMembership(session.user.id, workspaceId);
  if (!membership) return notFound();
  const record = await readWorkflowTask(workspaceId, taskId);
  if (!record) return notFound();
  const task = record.task;
  return <main className="mx-auto flex max-w-4xl flex-col gap-6">
    <Link href={`/dashboard/${workspaceId}/work`} className="text-sm underline">← Work</Link>
    <div><p className="text-xs uppercase text-[var(--gray-09)]">{String(task.phase).replaceAll("_", " ")}</p><h1 className="mt-2 text-2xl font-bold">{String(task.title)}</h1><p className="mt-2 text-sm text-[var(--gray-09)]">{String(task.repository_name)} · {String(task.branch)} · {String(task.agent)}</p></div>
    <WorkflowControls workspaceId={workspaceId} taskId={taskId} revision={Number(task.revision)} phase={String(task.phase)} activeCheck={Boolean(task.active_check_key)} canManage={["owner", "admin"].includes(membership.role)} />
    {Boolean(task.pr_url) && <a className="text-sm underline" href={String(task.pr_url)} target="_blank" rel="noreferrer">Open pull request</a>}
    <section className="rounded-lg border border-[var(--gray-05)] p-5"><h2 className="font-normal">Latest update</h2><p className="mt-2 whitespace-pre-wrap break-words text-sm">{String(task.summary || "Task started. Waiting for your agent’s first update.")}</p><p className="mt-3 text-xs text-[var(--gray-09)]">Agent reports and local check receipts are not independently verified acceptance evidence. Costs are not recorded by this MCP workflow.</p></section>
    <section><h2 className="mb-4 font-normal">History</h2><ol className="flex flex-col gap-3">{record.events.map(e => {
      const payload = e.payload as Record<string, unknown>;
      const check = payload.check as { name: string; passed: boolean; exitCode: number } | undefined;
      return <li key={Number(e.revision)} className="rounded-lg border border-[var(--gray-05)] p-4"><div className="text-xs text-[var(--gray-09)]">Revision {Number(e.revision)} · {e.kind === "human_decision" ? "Human decision" : "Agent-reported"}</div><p className="mt-2 whitespace-pre-wrap break-words text-sm">{String(payload.summary || payload.title || payload.decision || "Update")}</p>{check && <p className="mt-2 text-sm">{check.name}: {check.passed ? "reported passed" : "reported failed"} · exit {check.exitCode}</p>}</li>;
    })}</ol><p className="mt-3 text-xs text-[var(--gray-09)]">Latest 100 events. Full history is retained in the database.</p></section>
  </main>;
}
