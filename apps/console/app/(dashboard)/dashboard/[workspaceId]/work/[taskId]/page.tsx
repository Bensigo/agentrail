import Link from "next/link";
import { notFound } from "next/navigation";
import { readWorkflowTask, type DeliveryState } from "@agentrail/db-postgres";
import { getSession, getMembership } from "../../../../../../lib/cached";
import { UUID } from "../../../../../../lib/workflow-api";
import { WorkflowControls } from "../controls";
export default async function TaskPage({
  params,
}: {
  params: Promise<{ workspaceId: string; taskId: string }>;
}) {
  const { workspaceId, taskId } = await params;
  const session = await getSession();
  if (!session?.user?.id || !UUID.test(taskId)) return notFound();
  const membership = await getMembership(session.user.id, workspaceId);
  if (!membership) return notFound();
  const record = await readWorkflowTask(workspaceId, taskId);
  if (!record) return notFound();
  const task = record.task;
  const delivery = task.delivery as DeliveryState | null;
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6">
      <Link
        href={`/dashboard/${workspaceId}/work`}
        className="text-sm underline"
      >
        ← Work
      </Link>
      <div>
        <p className="text-xs uppercase text-[var(--gray-09)]">
          {task.phase === "closed"
            ? "Closed"
            : delivery?.stage === "verified"
              ? "Release verified"
              : String(task.phase).replaceAll("_", " ")}
        </p>
        <h1 className="mt-2 text-2xl font-bold">{String(task.title)}</h1>
        <p className="mt-2 text-sm text-[var(--gray-09)]">
          {String(task.repository_name)} · {String(task.branch)} ·{" "}
          {String(task.agent)}
        </p>
      </div>
      <WorkflowControls
        workspaceId={workspaceId}
        taskId={taskId}
        revision={Number(task.revision)}
        phase={String(task.phase)}
        activeCheck={Boolean(task.active_check_key)}
        canManage={["owner", "admin"].includes(membership.role)}
        canClose={
          !delivery ||
          (delivery.endpoint === "release"
            ? delivery.stage === "verified"
            : delivery.stage === "review" && Boolean(delivery.reviewHead))
        }
        canResume={Boolean(
          delivery && task.phase !== "closed" && delivery.stage !== "verified",
        )}
      />
      {delivery && (
        <section
          aria-label="Delivery"
          className="grid gap-4 rounded-lg border border-[var(--gray-05)] p-5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-normal">Delivery</h2>
            <span className="text-sm text-[var(--gray-09)]">
              {delivery.endpoint === "release"
                ? "Target: verified release"
                : "Target: review"}
            </span>
          </div>
          <p className="whitespace-pre-wrap break-words text-sm">
            {delivery.brief}
          </p>
          {delivery.criteria && (
            <div>
              <h3 className="text-sm font-bold">Acceptance criteria</h3>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                {delivery.criteria.map((criterion, index) => (
                  <li key={index} className="break-words">
                    {criterion}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(delivery.issueUrl || delivery.planPath || delivery.reviewHead) && (
            <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
              {delivery.issueUrl && (
                <a
                  className="underline"
                  href={delivery.issueUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  GitHub issue
                </a>
              )}
              {delivery.planPath && (
                <span className="break-all">
                  Plan <code>{delivery.planPath}</code>
                </span>
              )}
              {delivery.reviewHead && (
                <span>
                  Reported review head{" "}
                  <code title={delivery.reviewHead}>
                    {delivery.reviewHead.slice(0, 12)}
                  </code>
                </span>
              )}
            </div>
          )}
          {delivery.release && (
            <div className="border-t border-[var(--gray-05)] pt-4 text-sm">
              <p>
                {delivery.release.verifiedAt
                  ? "Configured live check passed"
                  : "Waiting for live verification"}{" "}
                ·{" "}
                <code title={delivery.release.commitSha}>
                  {delivery.release.commitSha.slice(0, 12)}
                </code>
              </p>
              {!delivery.release.url && (
                <p className="mt-2 break-all">
                  Target {delivery.release.targetUrl}
                </p>
              )}
              {delivery.release.url && (
                <a
                  className="mt-2 inline-block break-all underline"
                  href={delivery.release.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open verified deployment
                </a>
              )}
              {delivery.followUpIssueUrl && (
                <a
                  className="mt-2 block break-all underline"
                  href={delivery.followUpIssueUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Follow-up issue
                </a>
              )}
            </div>
          )}
        </section>
      )}
      {Boolean(task.pr_url) && (
        <a
          className="text-sm underline"
          href={String(task.pr_url)}
          target="_blank"
          rel="noreferrer"
        >
          Open pull request
        </a>
      )}
      <section className="rounded-lg border border-[var(--gray-05)] p-5">
        <h2 className="font-normal">Latest update</h2>
        <p className="mt-2 whitespace-pre-wrap break-words text-sm">
          {String(
            task.summary ||
              "Task started. Waiting for your agent’s first update.",
          )}
        </p>
        <p className="mt-3 text-xs text-[var(--gray-09)]">
          Progress comes from the agent. Check receipts show the command result
          and commit.
        </p>
      </section>
      <section>
        <h2 className="mb-4 font-normal">History</h2>
        <ol className="flex flex-col gap-3">
          {record.events.map((e) => {
            const payload = e.payload as Record<string, unknown>;
            const check = payload.check as
              | {
                  name: string;
                  passed: boolean;
                  exitCode: number;
                  commitSha: string;
                  dirty: boolean;
                }
              | undefined;
            return (
              <li
                key={Number(e.revision)}
                className="rounded-lg border border-[var(--gray-05)] p-4"
              >
                <div className="text-xs text-[var(--gray-09)]">
                  Revision {Number(e.revision)} ·{" "}
                  {e.kind === "human_decision"
                    ? "Human decision"
                    : e.kind === "release_verifier"
                      ? "Release verifier"
                      : "Agent-reported"}
                </div>
                <p className="mt-2 whitespace-pre-wrap break-words text-sm">
                  {String(
                    payload.summary ||
                      payload.title ||
                      payload.decision ||
                      "Update",
                  )}
                </p>
                {check && (
                  <p className="mt-2 text-sm">
                    {check.name}:{" "}
                    {check.passed ? "reported passed" : "reported failed"} ·
                    exit {check.exitCode} ·{" "}
                    <code title={check.commitSha}>
                      {check.commitSha?.slice(0, 12)}
                    </code>
                    {check.dirty ? " · dirty checkout" : ""}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
        <p className="mt-3 text-xs text-[var(--gray-09)]">
          Latest 100 events. Full history is retained in the database.
        </p>
      </section>
    </main>
  );
}
