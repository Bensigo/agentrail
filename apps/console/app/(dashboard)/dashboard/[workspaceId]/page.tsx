import { getWorkspace } from "@agentrail/db-postgres";
import { notFound } from "next/navigation";
import { getMembership, getSession } from "../../../../lib/cached";
import { PageHeader } from "../../../components/page-header";
import { DigestPanel } from "./components/digest-panel";
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

  return (
    <div className="mx-auto max-w-[1440px]">
      <PageHeader
        title={workspace.name}
        subtitle={`${workspace.slug} · ${workspace.id}`}
        actions={
          <span className="rounded-sm bg-[var(--gray-03)] px-1.5 py-0.5 text-xs font-medium text-[var(--gray-09)]">
            {membership.role}
          </span>
        }
      />

      <div className="mt-2 flex flex-col gap-6">
        <OnboardingBanner workspaceId={workspaceId} />
        <DigestPanel workspaceId={workspaceId} />
      </div>
    </div>
  );
}
