import Link from "next/link";
import { BookOpen } from "lucide-react";
import { getWorkspaceContextPacks } from "@agentrail/db-clickhouse";
import type { ContextPackRecord } from "@agentrail/db-clickhouse";
import { EmptyState } from "../../../../components/empty-state";

export default async function ContextPacksPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  let packs: ContextPackRecord[] = [];
  try {
    packs = await getWorkspaceContextPacks(workspaceId);
  } catch {
    // ClickHouse unavailable; render empty
  }

  return (
    <div className="mx-auto max-w-[1440px]">
      <h1 className="mb-4 text-sm font-semibold text-[var(--gray-12)]">Context Packs</h1>
      {packs.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title="No context packs yet"
          description="Context packs gathered for agent runs will appear here."
        />
      ) : (
        <div className="rounded border border-[var(--gray-05)] overflow-hidden">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-[var(--gray-05)] bg-[var(--gray-01)] text-left text-[var(--gray-10)]">
                <th className="px-3 py-2 font-medium">Run</th>
                <th className="px-3 py-2 font-medium text-right">Tokens used</th>
                <th className="px-3 py-2 font-medium text-right">Token budget</th>
                <th className="px-3 py-2 font-medium text-right">Sources</th>
                <th className="px-3 py-2 font-medium">Gathered</th>
              </tr>
            </thead>
            <tbody>
              {packs.map((p) => (
                <tr key={p.context_pack_id} className="border-b border-[var(--gray-05)]">
                  <td className="px-3 py-2">
                    <Link
                      href={`/dashboard/${workspaceId}/runs/${p.run_id}`}
                      className="font-mono text-[#70b8ff] hover:underline"
                    >
                      {p.run_id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{p.tokens_used.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right font-mono text-[var(--gray-10)]">
                    {p.token_budget ? p.token_budget.toLocaleString() : "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{p.sources_considered}</td>
                  <td className="px-3 py-2 font-mono text-[var(--gray-10)] text-xs">
                    {new Date(p.occurred_at).toISOString().slice(0, 16).replace("T", " ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
