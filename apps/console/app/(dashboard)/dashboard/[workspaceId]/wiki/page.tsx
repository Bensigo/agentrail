import { WikiClient } from "./components/wiki-client";

interface WikiPageProps {
  params: Promise<{ workspaceId: string }>;
}

export default async function WikiPage({ params }: WikiPageProps) {
  const { workspaceId } = await params;

  return (
    <div className="mx-auto flex max-w-[1440px] flex-col gap-4">
      <div>
        <h1 className="text-sm font-semibold text-[var(--gray-12)]">Wiki</h1>
      </div>
      <WikiClient workspaceId={workspaceId} />
    </div>
  );
}
