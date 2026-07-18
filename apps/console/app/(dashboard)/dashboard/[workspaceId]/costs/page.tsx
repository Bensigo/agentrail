import Link from "next/link";
import { CostsClient } from "./components/costs-client";

export default async function CostsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  return (
    <div className="mx-auto max-w-[1440px]">
      <h1 className="text-sm font-semibold text-[var(--gray-12)]">Costs</h1>
      <p className="mb-4 mt-1 text-xs text-[var(--gray-09)]">
        What Jace&apos;s work has cost you, broken down by run and by model. See also:{" "}
        <Link
          href={`/dashboard/${workspaceId}/budget`}
          className="text-[var(--blue-11)] hover:underline"
        >
          Budget
        </Link>{" "}
        — this workspace&apos;s monthly ceiling and cap status.
      </p>
      <CostsClient workspaceId={workspaceId} />
    </div>
  );
}
