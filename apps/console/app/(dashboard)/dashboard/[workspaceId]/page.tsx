import {
  ACCEPTANCE_WORKSPACE_OUTCOME_RANGES,
  getWorkspace,
  listChangeRecords,
  readAcceptanceWorkspaceOutcomeSummary,
  type AcceptanceWorkspaceOutcomeRange,
} from "@agentrail/db-postgres";
import { notFound } from "next/navigation";
import { getMembership, getSession } from "../../../../lib/cached";
import { PageHeader } from "../../../components/page-header";
import { CopyId } from "../../../components/copy-id";
import { AcceptanceEvidencePanel } from "./components/acceptance-evidence-panel";
import {
  AcceptanceOutcomeSummaryPanel,
} from "./components/acceptance-outcome-summary";
import { OnboardingBanner } from "./components/onboarding-banner";

export default async function WorkspaceDashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ range?: string | string[] }>;
}) {
  const { workspaceId } = await params;
  const requestedRange = (await searchParams).range;
  const outcomeRange: AcceptanceWorkspaceOutcomeRange =
    typeof requestedRange === "string" &&
    ACCEPTANCE_WORKSPACE_OUTCOME_RANGES.includes(
      requestedRange as AcceptanceWorkspaceOutcomeRange
    )
      ? (requestedRange as AcceptanceWorkspaceOutcomeRange)
      : "30d";
  const session = await getSession();
  if (!session?.user?.id) return notFound();

  const [workspace, membership] = await Promise.all([
    getWorkspace(workspaceId),
    getMembership(session.user.id, workspaceId),
  ]);

  if (!workspace || !membership) return notFound();

  const [records, outcomeSummary] = await Promise.all([
    listChangeRecords({ workspaceId, limit: 5 }),
    readAcceptanceWorkspaceOutcomeSummary({
      workspaceId,
      range: outcomeRange,
    }),
  ]);

  return (
    <div className="mx-auto max-w-[1440px]">
      <PageHeader
        title={workspace.name}
        subtitle={workspace.slug}
        actions={
          <div className="flex items-center gap-2">
            <CopyId id={workspace.id} label="ID" />
            <span className="rounded-sm bg-[var(--gray-03)] px-1.5 py-0.5 text-xs font-medium text-[var(--gray-09)]">
              {membership.role}
            </span>
          </div>
        }
      />

      <div className="mt-2 flex flex-col gap-6">
        <OnboardingBanner workspaceId={workspaceId} />
        <AcceptanceOutcomeSummaryPanel
          summary={outcomeSummary}
          activeRange={outcomeRange}
        />
        <AcceptanceEvidencePanel workspaceId={workspaceId} records={records} />
      </div>
    </div>
  );
}
