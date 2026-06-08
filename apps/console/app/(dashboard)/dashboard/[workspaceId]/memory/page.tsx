import { Suspense } from "react";
import { Brain } from "lucide-react";
import { LoadingSkeleton } from "../../../../components/loading-skeleton";
import { EmptyState } from "../../../../components/empty-state";

export default function MemoryPage() {
  return (
    <div>
      <h1 className="mb-4 text-sm font-semibold text-[var(--gray-12)]">Memory</h1>
      <Suspense fallback={<LoadingSkeleton />}>
        <MemoryContent />
      </Suspense>
    </div>
  );
}

function MemoryContent() {
  return (
    <EmptyState
      icon={Brain}
      title="No memory items yet"
      description="Context memory from prior decisions, lessons, and failure patterns will appear here."
    />
  );
}
