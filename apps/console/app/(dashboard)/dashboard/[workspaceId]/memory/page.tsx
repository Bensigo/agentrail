import { MemoryTable } from "./components/memory-table";

interface MemoryPageProps {
  params: Promise<{ workspaceId: string }>;
}

export default async function MemoryPage({ params }: MemoryPageProps) {
  const { workspaceId } = await params;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="flex items-center justify-between">
          <h1 className="text-sm font-semibold text-[var(--gray-12)]">
            Memory
          </h1>
          <p className="text-xs text-[var(--gray-09)]">
            Memory is managed via the AgentRail CLI.
          </p>
        </div>
        <p className="mt-1 text-xs text-[var(--gray-09)]">
          What Jace has learned about your codebase, and where each memory
          came from.
        </p>
      </div>
      <MemoryTable workspaceId={workspaceId} />
    </div>
  );
}
