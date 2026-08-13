import { notFound } from "next/navigation";
import {
  pendingApprovalsForWorkspace,
  readAcceptanceRecordSummaries,
} from "@agentrail/db-postgres";
import { getMembership, getSession } from "../../../../../lib/cached";
import { PageHeader } from "../../../../components/page-header";
import { AcceptanceReviewList } from "./components/acceptance-review-list";
import { PendingApprovalsList } from "./components/pending-approvals-list";

/**
 * Human review starts from canonical Acceptance Records. Generic tool
 * confirmations remain available as a secondary list, but queue recovery and
 * delivery failures are operational concerns and do not belong in this
 * customer decision surface.
 */
export default async function ApprovalsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  const session = await getSession();
  if (!session?.user?.id) return notFound();

  const membership = await getMembership(session.user.id, workspaceId);
  if (!membership) return notFound();

  const canManage = membership.role === "owner" || membership.role === "admin";
  const [summaries, pending] = await Promise.all([
    readAcceptanceRecordSummaries({ workspaceId, limit: 200 }),
    pendingApprovalsForWorkspace(workspaceId),
  ]);
  const reviews = summaries.records.filter(
    (record) => record.neededDecision.kind === "required",
  );
  const reviewScanTruncated = summaries.records.length === 200;

  return (
    <div className="mx-auto max-w-[1100px]">
      <PageHeader title="Approvals" />

      <div className="flex flex-col gap-8">
        <section aria-labelledby="review-decisions-heading" className="flex flex-col gap-2">
          <h2
            id="review-decisions-heading"
            className="text-xs font-normal uppercase tracking-wide text-[var(--gray-09)]"
          >
            Review decisions
          </h2>
          <AcceptanceReviewList
            records={reviews}
            workspaceId={workspaceId}
            scanTruncated={reviewScanTruncated}
          />
        </section>

        {pending.length > 0 ? (
          <section aria-labelledby="other-approvals-heading" className="flex flex-col gap-2">
            <h2
              id="other-approvals-heading"
              className="text-xs font-normal uppercase tracking-wide text-[var(--gray-09)]"
            >
              Other approvals
            </h2>
            <PendingApprovalsList
              rows={pending}
              workspaceId={workspaceId}
              canManage={canManage}
              hideDollars
            />
          </section>
        ) : null}
      </div>
    </div>
  );
}
