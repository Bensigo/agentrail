import { Suspense } from "react";
import { BookOpen } from "lucide-react";
import { LoadingSkeleton } from "../../../../components/loading-skeleton";
import { EmptyState } from "../../../../components/empty-state";

export default function ContextPacksPage() {
  return (
    <div>
      <h1 className="mb-4 text-sm font-semibold text-[var(--gray-12)]">Context Packs</h1>
      <Suspense fallback={<LoadingSkeleton />}>
        <ContextPacksContent />
      </Suspense>
    </div>
  );
}

function ContextPacksContent() {
  return (
    <EmptyState
      icon={BookOpen}
      title="No context packs yet"
      description="Context packs generated for agent tasks will appear here."
    />
  );
}
