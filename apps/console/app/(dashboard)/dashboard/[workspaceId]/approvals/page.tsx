import { ApprovalsTable } from "./components/approvals-table";

export default async function ApprovalsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  return (
    <div className="mx-auto max-w-[1440px]">
      <h1 className="mb-1 text-sm font-semibold text-[var(--gray-12)]">
        Merge Approvals
      </h1>
      <p className="mb-4 max-w-[80ch] text-xs leading-relaxed text-[var(--gray-09)]">
        Irreversible actions (merge, deploy, protected-target push) held for
        human approval. Approving one records an Audit Event with who approved.
        This gate is off by default; it only holds actions when the approval
        policy is enabled.
      </p>
      <ApprovalsTable workspaceId={workspaceId} />
    </div>
  );
}
