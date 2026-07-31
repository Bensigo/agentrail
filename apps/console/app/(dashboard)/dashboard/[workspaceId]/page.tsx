import { getWorkspace } from "@agentrail/db-postgres";
import { notFound } from "next/navigation";
import { getMembership, getSession } from "../../../../lib/cached";
import { loadPlanCardData } from "../../../../lib/plan-card-data";
import { PageHeader } from "../../../components/page-header";
import { CopyId } from "../../../components/copy-id";
import { DigestPanel } from "./components/digest-panel";
import { HealthRatesPanel } from "./components/health-rates-panel";
import { OnboardingBanner } from "./components/onboarding-banner";

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

  // Subscription slice 6 plan (Task 3): loadPlanCardData does its own
  // flag/degraded/error handling and fails open to undefined — this page
  // just awaits it and threads the result through as a prop. undefined
  // means DigestPanel renders exactly today's cost card (flag off,
  // degraded workspace, or a swallowed read error).
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
        {/* Rides the same planCard value as the swap above: the health panel mounts together with the plan card as one coherent flag-on change, not a separate toggle. */}
        {planCard !== undefined && <HealthRatesPanel workspaceId={workspaceId} />}
      </div>
    </div>
  );
}
