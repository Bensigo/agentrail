import { Suspense } from "react";
import { Database } from "lucide-react";
import { LoadingSkeleton } from "../../../../components/loading-skeleton";
import { EmptyState } from "../../../../components/empty-state";

export default function ReposPage() {
  return (
    <div>
      <h1 className="mb-4 text-sm font-semibold text-[var(--gray-12)]">Repos &amp; Health</h1>
      <Suspense fallback={<LoadingSkeleton />}>
        <ReposContent />
      </Suspense>
    </div>
  );
}

function ReposContent() {
  return (
    <EmptyState
      icon={Database}
      title="No repositories indexed"
      description="Connected repositories and their indexing health will be shown here."
    />
  );
}
