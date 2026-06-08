import { Suspense } from "react";
import { Users } from "lucide-react";
import { LoadingSkeleton } from "../../../../components/loading-skeleton";
import { EmptyState } from "../../../../components/empty-state";

export default function TeamsPage() {
  return (
    <div>
      <h1 className="mb-4 text-sm font-semibold text-[var(--gray-12)]">Teams</h1>
      <Suspense fallback={<LoadingSkeleton />}>
        <TeamsContent />
      </Suspense>
    </div>
  );
}

function TeamsContent() {
  return (
    <EmptyState
      icon={Users}
      title="No teams yet"
      description="Team members and their permissions within this workspace will be listed here."
    />
  );
}
