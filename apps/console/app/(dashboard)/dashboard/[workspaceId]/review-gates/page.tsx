import { Suspense } from "react";
import { ShieldCheck } from "lucide-react";
import { LoadingSkeleton } from "../../../../components/loading-skeleton";
import { EmptyState } from "../../../../components/empty-state";

export default function ReviewGatesPage() {
  return (
    <div>
      <h1 className="mb-4 text-sm font-semibold text-[var(--gray-12)]">Review Gates</h1>
      <Suspense fallback={<LoadingSkeleton />}>
        <ReviewGatesContent />
      </Suspense>
    </div>
  );
}

function ReviewGatesContent() {
  return (
    <EmptyState
      icon={ShieldCheck}
      title="No review gates yet"
      description="Policy checkpoints and review gate decisions will be listed here."
    />
  );
}
