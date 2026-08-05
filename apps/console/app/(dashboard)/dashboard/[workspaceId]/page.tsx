import { getWorkspace } from "@agentrail/db-postgres";
import { notFound } from "next/navigation";
import { getMembership, getSession } from "../../../../lib/cached";
import { loadPlanCardData } from "../../../../lib/plan-card-data";
import { PageHeader } from "../../../components/page-header";
import { CopyId } from "../../../components/copy-id";
import { DigestPanel } from "./components/digest-panel";
import { HealthRatesPanel } from "./components/health-rates-panel";
import { HumanFalseGreenPanel } from "./components/human-false-green-panel";
import { OnboardingBanner } from "./components/onboarding-banner";
import { ReviewMetricsPanel } from "./components/review-metrics-panel";

export default async function WorkspaceDashboardPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const session = await getSession();
  if (!session?.user?.id) return notFound();

  const [workspace, membership] = await Promise.all([
    getWorkspace(workspaceId),
    getMembership(session.user.id, workspaceId),
  ]);

  if (!workspace || !membership) return notFound();

  // Subscription slice 8 (2026-07-31 owner ruling — display swap goes
  // unconditional): loadPlanCardData no longer gates on a flag — it always
  // attempts a real read, failing open to undefined only for a degraded
  // workspace, no billing account, or a swallowed read error (see that
  // function's own doc-comment). This page just awaits it and threads the
  // result through as a prop. undefined means DigestPanel renders the
  // dollar-free PlanCardEmpty card — there is no cost card left to fall
  // back to.
  const planCard = await loadPlanCardData(workspaceId);

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
        <DigestPanel workspaceId={workspaceId} planCard={planCard} />
        <ReviewMetricsPanel workspaceId={workspaceId} />
        <HumanFalseGreenPanel workspaceId={workspaceId} />
        {/* Rides the same planCard value as the swap above: the health panel mounts together with the plan card as one coherent unit, not a separate toggle — both key off whether a real plan read resolved, no flag involved. */}
        {planCard !== undefined && <HealthRatesPanel workspaceId={workspaceId} />}
      </div>
    </div>
  );
}
