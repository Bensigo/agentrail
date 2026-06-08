import { Suspense } from "react";
import { Key } from "lucide-react";
import { LoadingSkeleton } from "../../../../components/loading-skeleton";
import { EmptyState } from "../../../../components/empty-state";

export default function ApiKeysPage() {
  return (
    <div>
      <h1 className="mb-4 text-sm font-semibold text-[var(--gray-12)]">API Keys</h1>
      <Suspense fallback={<LoadingSkeleton />}>
        <ApiKeysContent />
      </Suspense>
    </div>
  );
}

function ApiKeysContent() {
  return (
    <EmptyState
      icon={Key}
      title="No API keys yet"
      description="Workspace API keys for agent access will be managed here."
    />
  );
}
