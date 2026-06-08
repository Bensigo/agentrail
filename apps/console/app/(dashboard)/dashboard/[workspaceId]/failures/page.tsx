import { Suspense } from "react";
import { AlertTriangle } from "lucide-react";
import { LoadingSkeleton } from "../../../../components/loading-skeleton";
import { EmptyState } from "../../../../components/empty-state";

export default function FailuresPage() {
  return (
    <div>
      <h1 className="mb-4 text-sm font-semibold text-[var(--gray-12)]">Failures</h1>
      <Suspense fallback={<LoadingSkeleton />}>
        <FailuresContent />
      </Suspense>
    </div>
  );
}

function FailuresContent() {
  return (
    <EmptyState
      icon={AlertTriangle}
      title="No failures recorded"
      description="Agent failures and error events will be surfaced here for investigation."
    />
  );
}
