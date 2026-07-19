import { notFound } from "next/navigation";
import {
  ALIGNMENT_DENIED_PARK_REASON,
  ALIGNMENT_PARK_REASON,
  deadLettersForWorkspace,
  listQueueEntries,
  pendingApprovalsForWorkspace,
} from "@agentrail/db-postgres";

// The two alignment park-reason constants, imported ONCE here (a server
// component — `@agentrail/db-postgres` is safe to import server-side) and
// passed down as plain strings to the client `ParkedWorkList` below, which
// must NOT import that package directly (see `approvals-helpers.ts`'s
// header comment for why: it broke the client bundle on `node:crypto`).
const ALIGNMENT_PARK_REASONS = [ALIGNMENT_PARK_REASON, ALIGNMENT_DENIED_PARK_REASON] as const;
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

  const [pending, parked, deadLetters] = await Promise.all([
    pendingApprovalsForWorkspace(workspaceId),
    listQueueEntries(workspaceId, { states: ["parked"] }),
    deadLettersForWorkspace(workspaceId),
  ]);

  return (
    <div className="mx-auto max-w-[1440px]">
      <PageHeader
        title="Approvals"
        subtitle="Everything waiting on a human — approvals, parked work, and failed deliveries."
      />

      <div className="flex flex-col gap-6">
        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
            Pending approvals
          </h2>
          <PendingApprovalsList rows={pending} workspaceId={workspaceId} canManage={canManage} />
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
            Parked work
          </h2>
          <ParkedWorkList
            rows={parked}
            workspaceId={workspaceId}
            canManage={canManage}
            alignmentParkReasons={ALIGNMENT_PARK_REASONS}
          />
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
            Dead letters
          </h2>
          <DeadLettersList rows={deadLetters} workspaceId={workspaceId} canManage={canManage} />
        </section>
      </div>
    </div>
  );
}
