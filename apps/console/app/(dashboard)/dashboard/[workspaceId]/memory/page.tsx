import { MemoryTable } from "./components/memory-table";

interface MemoryPageProps {
  params: Promise<{ workspaceId: string }>;
}

export default async function MemoryPage({ params }: MemoryPageProps) {
  const { workspaceId } = await params;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-sm font-semibold text-[var(--gray-12)]">Memory</h1>
      </div>
      <MemoryTable workspaceId={workspaceId} />
    </div>
  );
}
