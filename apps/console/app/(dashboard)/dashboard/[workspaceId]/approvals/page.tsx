import { notFound } from "next/navigation";
import {
  ALIGNMENT_DENIED_PARK_REASON,
  deadLettersForWorkspace,
  getWorkspace,
  listQueueEntries,
  pendingApprovalsForWorkspace,
} from "@agentrail/db-postgres";
import { isAlignmentLocked } from "./approvals-helpers";
import { getMembership, getSession } from "../../../../../lib/cached";
import { PageHeader } from "../../../../components/page-header";
import { PendingApprovalsList } from "./components/pending-approvals-list";
import { ParkedWorkList } from "./components/parked-work-list";
import { DeadLettersList } from "./components/dead-letters-list";

/**
 * Workspace Approvals page (#1276): the ONE console surface for everything
 * currently waiting on a human, across every channel and the queue — pending
 * tool-call approvals, parked work, and dead-lettered channel messages. A
 * server component reading the queries directly (Budget-page precedent,
 * `budget/page.tsx`'s own doc-comment: "no client fetch, no new API route")
 * — all three list sources already exist and needed zero new query work
 * (recon annex §1a: `pendingApprovalsForWorkspace`,
 * `listQueueEntries(ws, {states:["parked"]})`, `deadLettersForWorkspace`).
 *
 * PR ② — Approve/Deny/Requeue resolve through the exact same seam a Telegram
 * tap does (`resolveApproval` + `applyAlignmentDecision`, shared via
 * `lib/approval-decision.ts`). `canManage` (owner/admin — repos-page
 * precedent, `repos/page.tsx`) is computed here, server-side, and passed
 * down; each list component also independently re-checks server-side on the
 * actual mutating API route, since a client-hidden button is not a security
 * boundary — see `annex-1276-1278-recon.md` §1d.
 *
 * Auth mirrors the sibling workspace pages exactly (plain membership gate):
 * the workspace layout already guards session + membership, this re-checks
 * defensively.
 *
 * Subscription-platform fast-follow (owner ruling 2026-07-31): `hideDollars`
 * is unconditionally `true` — threaded down as a prop into
 * `PendingApprovalsList` only (the other two lists never render a dollar
 * amount). See that component's own prop comment and `approvals-helpers.ts`'s
 * header comment for the (still flag-free) `opts` machinery this reuses.
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

  // #1276 PR ②: owner/admin act, members/viewers get read-only UI (the
  // matching server-side rejection lives on each mutating API route, not
  // here — see this page's own doc-comment).
  const canManage = membership.role === "owner" || membership.role === "admin";

  // Unconditional since 2026-07-31 owner ruling (scope vocabulary always wins).
  const hideDollars = true;

  const [pending, parked, deadLetters, workspace] = await Promise.all([
    pendingApprovalsForWorkspace(workspaceId),
    listQueueEntries(workspaceId, { states: ["parked"] }),
    deadLettersForWorkspace(workspaceId),
    getWorkspace(workspaceId),
  ]);

  // #1276 fix round (review C1): per-row "alignment-held" is computed HERE,
  // server-side, with the SAME predicate `requeueParkedQueueEntry` enforces
  // (kind / estimatedBudgetUsd / require_alignment, denial unconditional —
  // NOT a parkReason string match), so the UI renders those rows' Requeue
  // disabled instead of offering a button whose request would 409. A missing
  // workspace row fails toward gating (`?? true`), mirroring
  // `workspaceRequiresAlignment`'s own default. The client component can't
  // compute this itself: the denied-reason constant lives in
  // `@agentrail/db-postgres`, which must not enter the client bundle (see
  // `approvals-helpers.ts`'s header comment).
  const requireAlignment = workspace?.requireAlignment ?? true;
  const parkedRows = parked.map((row) => ({
    ...row,
    alignmentLocked: isAlignmentLocked(row, requireAlignment, ALIGNMENT_DENIED_PARK_REASON),
  }));

  return (
    <div className="mx-auto max-w-[1440px]">
      <PageHeader title="Approvals" />

      <div className="flex flex-col gap-6">
        {/* font-normal on all three section titles below: card-title label
            idiom (matches StatHeader's clean text-xs/uppercase/gray-09
            "label" pattern) — not the Data Table header exception (these
            aren't <th>s) and not a true heading. */}
        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-normal uppercase tracking-wide text-[var(--gray-09)]">
            Pending approvals
          </h2>
          <PendingApprovalsList
            rows={pending}
            workspaceId={workspaceId}
            canManage={canManage}
            hideDollars={hideDollars}
          />
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-normal uppercase tracking-wide text-[var(--gray-09)]">
            Parked work
          </h2>
          <ParkedWorkList rows={parkedRows} workspaceId={workspaceId} canManage={canManage} />
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-normal uppercase tracking-wide text-[var(--gray-09)]">
            Dead letters
          </h2>
          <DeadLettersList rows={deadLetters} workspaceId={workspaceId} canManage={canManage} />
        </section>
      </div>
    </div>
  );
}
