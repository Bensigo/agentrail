import { notFound } from "next/navigation";
import {
  deadLettersForWorkspace,
  listQueueEntries,
  pendingApprovalsForWorkspace,
} from "@agentrail/db-postgres";
import { getMembership, getSession } from "../../../../../lib/cached";
import { PageHeader } from "../../../../components/page-header";
import { PendingApprovalsList } from "./components/pending-approvals-list";
import { ParkedWorkList } from "./components/parked-work-list";
import { DeadLettersList } from "./components/dead-letters-list";

/**
 * Workspace Approvals page (#1276 PR ①, read-only): the ONE console surface
 * for everything currently waiting on a human, across every channel and the
 * queue — pending tool-call approvals, parked work, and dead-lettered channel
 * messages. A server component reading the queries directly (Budget-page
 * precedent, `budget/page.tsx`'s own doc-comment: "no client fetch, no new
 * API route") — all three list sources already exist and needed zero new
 * query work (recon annex §1a: `pendingApprovalsForWorkspace`,
 * `listQueueEntries(ws, {states:["parked"]})`, `deadLettersForWorkspace`).
 *
 * Console Approve resolves through the exact same seam a Telegram tap does
 * (`resolveApproval` + `applyAlignmentDecision`) — that's PR ②. This PR is
 * deliberately read-only so the rendering (three lists, empty states,
 * per-tool summaries, the unknown-tool fallback, `_brief` tolerance) lands
 * and is browser-verified on its own before any mutation path is added.
 *
 * Auth mirrors the sibling workspace pages exactly (plain membership gate,
 * view-only — same as `budget/page.tsx`): the workspace layout already
 * guards session + membership, this re-checks defensively. Role gating for
 * the mutating actions (owner/admin act, members/viewers read-only) is PR
 * ②'s concern, once there's an action to gate.
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
          <PendingApprovalsList rows={pending} />
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
            Parked work
          </h2>
          <ParkedWorkList rows={parked} />
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
            Dead letters
          </h2>
          <DeadLettersList rows={deadLetters} />
        </section>
      </div>
    </div>
  );
}
