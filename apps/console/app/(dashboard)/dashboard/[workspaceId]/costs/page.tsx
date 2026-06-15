import { PageHeader } from "../../../../components/page-header";
import { CostsClient } from "./components/costs-client";

export default async function CostsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  return (
    <div className="mx-auto max-w-[1440px]">
      <PageHeader title="Costs" />
      <CostsClient workspaceId={workspaceId} />
    </div>
  );
}
