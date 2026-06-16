import { HealthRatesPanel } from "./components/health-rates-panel";

export default async function HealthPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  return (
    <div className="mx-auto max-w-[1440px]">
      <h1 className="mb-4 text-sm font-semibold text-[var(--gray-12)]">Health</h1>
      <HealthRatesPanel workspaceId={workspaceId} />
    </div>
  );
}
