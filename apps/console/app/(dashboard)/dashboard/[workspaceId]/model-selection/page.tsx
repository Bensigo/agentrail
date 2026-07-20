import { ModelSelectionClient } from "./components/model-selection-client";

export default async function ModelSelectionPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  return (
    <div className="mx-auto max-w-[1440px]">
      <h1 className="text-sm font-bold text-[var(--gray-12)]">Model selection</h1>
      <p className="mb-4 mt-1 text-xs text-[var(--gray-09)]">
        Per-task-type breakdown of which execute model is winning on real run data
        (#1338) — the seed, every other eligible candidate, and their recorded
        success rate and cost. Read-only: this never changes which model gets
        picked.
      </p>
      <ModelSelectionClient workspaceId={workspaceId} />
    </div>
  );
}
