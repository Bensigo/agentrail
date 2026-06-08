import { Suspense } from "react";
import { Activity } from "lucide-react";
import { LoadingSkeleton } from "../../../../components/loading-skeleton";
import { EmptyState } from "../../../../components/empty-state";

export default function RunsPage() {
  return (
    <div>
      <h1 className="mb-4 text-sm font-semibold text-[var(--gray-12)]">Runs</h1>
      <Suspense fallback={<LoadingSkeleton />}>
        <RunsContent />
      </Suspense>
    </div>
  );
}

function RunsContent() {
  return (
    <EmptyState
      icon={Activity}
      title="No runs yet"
      description="Agent runs will appear here once your workspace starts executing tasks."
    />
  );
}
