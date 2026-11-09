import Link from "next/link";
import { notFound } from "next/navigation";
import { listWorkflowTasks } from "@agentrail/db-postgres";
import { getSession, getMembership } from "../../../../../lib/cached";
import { WorkflowControls } from "./controls";
export default async function WorkPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const session = await getSession();
  if (!session?.user?.id || !await getMembership(session.user.id, workspaceId)) return notFound();
  const tasks = await listWorkflowTasks(workspaceId);
  return <main className="mx-auto flex max-w-6xl flex-col gap-6">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-xl font-bold">Work</h1><p className="mt-1 text-sm text-[var(--gray-09)]">Your coding agents, tasks and next actions.</p></div><WorkflowControls /></div>
    <div className="flex gap-5 text-sm"><Link className="underline" href={`/dashboard/${workspaceId}/agents`}>Connect your agent</Link><Link className="underline" href={`/dashboard/${workspaceId}/native-work`}>Native runner work</Link></div>
    {tasks.length === 0 ? <div className="rounded-lg border border-[var(--gray-05)] bg-[var(--gray-01)] p-8"><h2 className="font-normal">Start a task through your agent</h2><p className="mt-2 text-sm text-[var(--gray-09)]">Connect AgentRail through MCP, then ask your coding agent to start work. Progress and check reports will appear here.</p></div> : <div className="grid gap-3">{tasks.map(t => <Link key={String(t.id)} href={`/dashboard/${workspaceId}/work/${t.id}`} className="rounded-lg border border-[var(--gray-05)] bg-[var(--gray-01)] p-5 hover:border-[var(--gray-08)]">
      <div className="flex flex-wrap justify-between gap-3"><h2 className="font-normal">{String(t.title)}</h2><span className="rounded bg-[var(--gray-03)] px-2 py-1 text-xs">{String(t.phase).replaceAll("_", " ")}</span></div>
      <p className="mt-2 text-sm text-[var(--gray-09)]">{String(t.repository_name)} · {String(t.agent)} · {String(t.branch)}</p>
      {Boolean(t.summary) && <p className="mt-3 break-words text-sm">{String(t.summary)}</p>}
    </Link>)}</div>}
    <p className="text-xs text-[var(--gray-09)]">Latest 100 tasks. Progress and check results are agent-reported. You decide when to close each task.</p>
  </main>;
}
