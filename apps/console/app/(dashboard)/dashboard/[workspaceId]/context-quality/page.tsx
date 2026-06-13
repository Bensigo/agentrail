import { getWorkspace } from "@agentrail/db-postgres";
import { QualityChartsClient } from "./components/quality-charts";

export default async function ContextQualityPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  let baselineWindowDays = 30;
  try {
    const workspace = await getWorkspace(workspaceId);
    if (workspace) {
      baselineWindowDays = workspace.baselineWindowDays;
    }
  } catch {
    // fallback to 30 if workspace fetch fails
  }

  return (
    <div className="mx-auto max-w-[1440px]">
      <h1 className="mb-1 text-sm font-semibold text-[var(--gray-12)]">
        Context Quality
      </h1>
      <p className="mb-4 text-xs text-[var(--gray-09)]">
        Precision, citation coverage, staleness, and denied-source counts across
        runs for this workspace.
      </p>
      <QualityChartsClient
        workspaceId={workspaceId}
        baselineWindowDays={baselineWindowDays}
      />
    </div>
  );
}
