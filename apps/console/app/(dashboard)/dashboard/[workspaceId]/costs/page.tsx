import { Suspense } from "react";
import { DollarSign } from "lucide-react";
import { LoadingSkeleton } from "../../../../components/loading-skeleton";
import { EmptyState } from "../../../../components/empty-state";

export default function CostsPage() {
  return (
    <div>
      <h1 className="mb-4 text-sm font-semibold text-[var(--gray-12)]">Costs</h1>
      <Suspense fallback={<LoadingSkeleton />}>
        <CostsContent />
      </Suspense>
    </div>
  );
}

function CostsContent() {
  return (
    <EmptyState
      icon={DollarSign}
      title="No cost events yet"
      description="Token usage, model calls, and metered cost events will appear here."
    />
  );
}
