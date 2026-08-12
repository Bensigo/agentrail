import Link from "next/link";

export type ChatAcceptanceContext = {
  intake_id: string;
  status: string;
  record_id?: string;
  brief?: {
    slug: string;
    title: string;
    status: string;
    updated_at: string;
  };
};

/**
 * A deliberately small projection of the canonical Acceptance Intake. It is
 * display-only: this strip never creates, binds, or edits an Intake, Record,
 * Contract, Pack, or Brief.
 */
export function AcceptanceContextStrip({
  workspaceId,
  acceptance,
}: {
  workspaceId: string;
  acceptance: ChatAcceptanceContext | null;
}) {
  if (!acceptance) return null;

  return (
    <aside
      aria-label="Task context"
      className="rounded-xl border border-[var(--gray-05)] bg-[var(--gray-02)] px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--gray-09)]">
        <span className="font-medium text-[var(--gray-11)]">Task context</span>
        <span aria-label="Acceptance Intake status">Intake: {acceptance.status}</span>
      </div>

      {!acceptance.record_id ? (
        <p className="mt-1.5 text-sm text-[var(--gray-10)]">
          This task is still shaping. No Acceptance Record exists yet.
        </p>
      ) : !acceptance.brief ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="text-[var(--gray-10)]">No Brief is linked to this Acceptance Record yet.</span>
          <Link
            href={`/dashboard/${workspaceId}/changes/${acceptance.record_id}`}
            className="font-medium text-[var(--accent-text)] underline-offset-2 hover:underline"
          >
            Open Acceptance Record
          </Link>
        </div>
      ) : (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="text-[var(--gray-10)]">{acceptance.brief.title}</span>
          <Link
            href={`/dashboard/${workspaceId}/briefs/${encodeURIComponent(acceptance.brief.slug)}`}
            className="font-medium text-[var(--accent-text)] underline-offset-2 hover:underline"
          >
            Open and edit Brief
          </Link>
          <Link
            href={`/dashboard/${workspaceId}/changes/${acceptance.record_id}`}
            className="font-medium text-[var(--accent-text)] underline-offset-2 hover:underline"
          >
            Open Acceptance Record
          </Link>
        </div>
      )}
    </aside>
  );
}
