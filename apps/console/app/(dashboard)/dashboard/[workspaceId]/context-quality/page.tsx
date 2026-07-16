import { getWorkspace } from "@agentrail/db-postgres";
import { QualityChartsClient } from "./components/quality-charts";
import { EvalMetricsPanel } from "./components/eval-metrics-panel";

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
        How solid the information Jace worked from has been, run over run.
      </p>

      {/* Eval results — the falsifiable signal (#942). Solve-rate,
          dollars-per-solved-task, and Objective Gate false-green rate from the
          latest eval run. These are the real, can-come-back-unfavorable numbers
          that stand in for the always-zero context-quality percentages above. */}
      <div className="mb-5">
        <EvalMetricsPanel workspaceId={workspaceId} />
      </div>

      <QualityChartsClient
        workspaceId={workspaceId}
        baselineWindowDays={baselineWindowDays}
      />
    </div>
  );
}
