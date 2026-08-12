import type { AcceptanceBriefBindingRead } from "@agentrail/db-postgres";

export function AcceptanceBriefTransitionPanel({
  workspaceId,
  bindings,
}: {
  workspaceId: string;
  bindings: AcceptanceBriefBindingRead[];
}) {
  const hasBindings = bindings.length > 0;
  return (
    <section className="mb-4 rounded border border-[var(--gray-05)] bg-[var(--gray-02)]">
      <div className="border-b border-[var(--gray-05)] px-4 py-3">
        <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">
          Brief transition
        </h2>
      </div>
      <div className="flex flex-col gap-2 px-4 py-4 text-xs text-[var(--gray-09)]">
        {!hasBindings ? (
          <p>This editable Brief is still shaping work and no Acceptance Record is linked.</p>
        ) : (
          <>
            <p>This Brief transitioned into Acceptance Records.</p>
            <p>The transition captured immutable Brief provenance.</p>
            <ol className="flex list-decimal flex-col gap-1 pl-4">
              {bindings.map((binding, index) => (
                <li key={binding.record.id}>
                  <a
                    href={`/dashboard/${encodeURIComponent(workspaceId)}/changes/${binding.record.id}`}
                    className="text-[var(--blue-11)] hover:underline"
                  >
                    Acceptance Record
                  </a>
                  <span className="ml-1 text-[var(--gray-08)]">#{index + 1}</span>
                </li>
              ))}
            </ol>
            <p>
              The Brief stays editable, but later edits cannot rewrite any linked Acceptance
              Record&apos;s Contract, Context Pack, review evidence, or final decision.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
