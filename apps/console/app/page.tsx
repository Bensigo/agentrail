import type { RunStatus, Workspace } from "@agentrail/contracts";
import { Button } from "@agentrail/ui";

const placeholderWorkspace: Workspace = {
  id: "ws_001",
  name: "Default Workspace",
  slug: "default",
  createdAt: new Date().toISOString(),
};

const placeholderStatus: RunStatus = "completed";

export default function Home() {
  return (
    <div className="min-h-screen bg-[var(--gray-00)] p-8">
      <div className="mx-auto max-w-[1440px]">
        <h1 className="text-3xl font-bold tracking-tight text-[var(--gray-12)]">
          AgentRail Console
        </h1>
        <p className="mt-2 text-sm text-[var(--gray-11)]">
          Agent operations dashboard — runs, context packs, failures, review
          gates, costs, and teams.
        </p>

        <div className="mt-8 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-wide text-[var(--gray-09)]">
                Workspace
              </p>
              <p className="mt-1 font-mono text-sm text-[var(--gray-12)]">
                {placeholderWorkspace.name}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center rounded-sm bg-[var(--green-09)] px-1.5 py-0.5 text-xs font-medium text-white">
                {placeholderStatus}
              </span>
              <Button size="sm">View Runs</Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
