import { CostsTable } from "./components/costs-table";

export default async function CostsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  return (
    <div className="mx-auto max-w-[1440px]">
      <h1 className="mb-4 text-sm font-semibold text-[var(--gray-12)]">
        Costs
      </h1>
      <CostsTable workspaceId={workspaceId} />
    </div>
  );
}
