import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getContextPacksForRun,
  getContextPackItems,
} from "@agentrail/db-clickhouse";
import type { ContextEventRecord } from "@agentrail/db-clickhouse";

function pct(used: number, budget: number): string {
  if (!budget) return "—";
  return `${Math.round((used / budget) * 100)}%`;
}

export default async function ContextPackDetailPage({
  params,
}: {
  params: Promise<{
    workspaceId: string;
    runId: string;
    packId: string;
  }>;
}) {
  const { workspaceId, runId, packId } = await params;

  let pack = null;
  let items: ContextEventRecord[] = [];

  try {
    const packs = await getContextPacksForRun(workspaceId, runId);
    pack = packs.find((p) => p.context_pack_id === packId) ?? null;
    if (pack) {
      items = await getContextPackItems(workspaceId, runId, packId);
    }
  } catch {
    // ClickHouse unavailable — render empty state below
  }

  if (pack === null) {
    notFound();
  }

  const included = items
    .filter((i) => i.included === 1)
    .sort((a, b) => b.score - a.score);
  const excluded = items.filter((i) => i.included === 0);

  return (
    <div className="mx-auto max-w-[1440px]">
      {/* Breadcrumb */}
      <nav className="mb-4 flex items-center gap-1 text-xs text-[var(--gray-09)]">
        <Link
          href={`/dashboard/${workspaceId}/runs`}
          className="hover:text-[var(--gray-12)] transition-colors"
        >
          Runs
        </Link>
        <span>/</span>
        <Link
          href={`/dashboard/${workspaceId}/runs/${runId}`}
          className="font-mono hover:text-[var(--gray-12)] transition-colors"
        >
          {runId}
        </Link>
        <span>/</span>
        <span className="text-[var(--gray-11)]">Context Pack</span>
        <span>/</span>
        <span className="font-mono text-[var(--gray-11)]">{packId}</span>
      </nav>

      {/* Pack metadata */}
      <div className="mb-6 rounded border border-[#6e56cf]/40 bg-[var(--gray-02)] p-4">
        <h1 className="mb-3 text-sm font-semibold text-[var(--gray-12)]">
          Context Pack
          <span className="ml-2 font-mono text-[var(--gray-09)] font-normal text-xs">
            {packId}
          </span>
        </h1>
        <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-xs sm:grid-cols-4">
          <div>
            <dt className="text-[var(--gray-09)] uppercase tracking-wide">Token budget</dt>
            <dd className="font-mono text-[var(--gray-12)] mt-0.5">
              {pack.token_budget.toLocaleString()}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--gray-09)] uppercase tracking-wide">Tokens used</dt>
            <dd className="font-mono text-[var(--gray-12)] mt-0.5">
              {pack.tokens_used.toLocaleString()}{" "}
              <span className="text-[var(--gray-09)]">
                ({pct(pack.tokens_used, pack.token_budget)})
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-[var(--gray-09)] uppercase tracking-wide">Anchors extracted</dt>
            <dd className="font-mono text-[var(--gray-12)] mt-0.5">
              {pack.anchors_extracted}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--gray-09)] uppercase tracking-wide">Sources considered</dt>
            <dd className="font-mono text-[var(--gray-12)] mt-0.5">
              {pack.sources_considered}
            </dd>
          </div>
        </dl>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Included items */}
        <section>
          <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--gray-09)]">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: "#1fd8a4" }}
            />
            Included
            <span className="rounded-sm bg-[#1a3a2e] px-1.5 py-0.5 text-[10px] text-[#1fd8a4] font-mono">
              {included.length}
            </span>
          </h2>
          <div className="rounded border border-[var(--gray-05)] overflow-hidden">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-[var(--gray-05)] bg-[var(--gray-01)]">
                  <th className="px-3 py-2 text-left font-medium uppercase tracking-wide text-[var(--gray-09)]">
                    Path
                  </th>
                  <th className="px-3 py-2 text-left font-medium uppercase tracking-wide text-[var(--gray-09)]">
                    Citation
                  </th>
                  <th className="px-3 py-2 text-left font-medium uppercase tracking-wide text-[var(--gray-09)]">
                    Reason
                  </th>
                  <th className="px-3 py-2 text-right font-medium uppercase tracking-wide text-[var(--gray-09)]">
                    Score
                  </th>
                </tr>
              </thead>
              <tbody>
                {included.length === 0 ? (
                  <tr>
                    <td
                      colSpan={4}
                      className="px-3 py-6 text-center text-[var(--gray-09)]"
                    >
                      No included items.
                    </td>
                  </tr>
                ) : (
                  included.map((item, idx) => (
                    <tr
                      key={idx}
                      className="border-b border-[var(--gray-04)] hover:bg-[var(--gray-03)] transition-colors"
                      style={{ height: "34px" }}
                    >
                      <td className="px-3 py-1.5 max-w-[200px]">
                        <span
                          className="font-mono text-[var(--gray-12)] block truncate"
                          title={item.item_path}
                          style={{
                            fontFamily:
                              '"Berkeley Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                          }}
                        >
                          {item.item_path}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 max-w-[160px]">
                        <span
                          className="text-[var(--gray-10)] block truncate"
                          title={item.citation}
                        >
                          {item.citation || "—"}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 max-w-[160px]">
                        <span
                          className="text-[var(--gray-10)] block truncate"
                          title={item.reason}
                        >
                          {item.reason || "—"}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <span className="font-mono text-[#baa7ff]">
                          {item.score.toFixed(2)}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Excluded items */}
        <section>
          <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--gray-09)]">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: "#ff9592" }}
            />
            Excluded
            <span className="rounded-sm bg-[#3a1a1a] px-1.5 py-0.5 text-[10px] text-[#ff9592] font-mono">
              {excluded.length}
            </span>
          </h2>
          <div className="rounded border border-[var(--gray-05)] overflow-hidden">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-[var(--gray-05)] bg-[var(--gray-01)]">
                  <th className="px-3 py-2 text-left font-medium uppercase tracking-wide text-[var(--gray-09)]">
                    Path
                  </th>
                  <th className="px-3 py-2 text-left font-medium uppercase tracking-wide text-[var(--gray-09)]">
                    Exclusion reason
                  </th>
                </tr>
              </thead>
              <tbody>
                {excluded.length === 0 ? (
                  <tr>
                    <td
                      colSpan={2}
                      className="px-3 py-6 text-center text-[var(--gray-09)]"
                    >
                      No excluded items.
                    </td>
                  </tr>
                ) : (
                  excluded.map((item, idx) => (
                    <tr
                      key={idx}
                      className="border-b border-[var(--gray-04)] hover:bg-[var(--gray-03)] transition-colors"
                      style={{ height: "34px" }}
                    >
                      <td className="px-3 py-1.5 max-w-[220px]">
                        <span
                          className="font-mono text-[var(--gray-11)] block truncate"
                          title={item.item_path}
                          style={{
                            fontFamily:
                              '"Berkeley Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                          }}
                        >
                          {item.item_path}
                        </span>
                      </td>
                      <td className="px-3 py-1.5">
                        <span
                          className="text-[var(--gray-10)] block truncate"
                          title={item.reason}
                        >
                          {item.reason || "—"}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
