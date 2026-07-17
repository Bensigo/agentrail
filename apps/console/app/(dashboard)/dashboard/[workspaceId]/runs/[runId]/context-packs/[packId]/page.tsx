import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getContextPacksForRun,
  getContextPackItems,
} from "@agentrail/db-clickhouse";
import type { ContextEventRecord } from "@agentrail/db-clickhouse";
import { getRun } from "@agentrail/db-postgres";

function pct(used: number, budget: number): string {
  if (!budget) return "—";
  return `${Math.round((used / budget) * 100)}%`;
}

// Engines that have a transcript vehicle for read harvesting (issue #1028).
// Anything else (cursor, hermes, …) can never produce read-grounded
// waste/miss, so the dashboard shows an explicit n/a instead of a fake zero.
const READ_GROUNDED_ENGINES = new Set(["claude"]);

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

  // The engine tag lives on the run row (Postgres), not on the pack — the
  // read-grounded scalar precision/recall have no ClickHouse column (that would
  // need a schema migration; see PR notes). Fetch it so the read-grounded
  // diagnostics can be honestly labelled n/a for engines without a transcript.
  // Also carries the run's title for the breadcrumb (#1232): names over IDs
  // — the run crumb shows the work item's title when one exists, falling
  // back to a short id like the run-detail breadcrumb does.
  let engine = "";
  let runTitle: string | null = null;
  try {
    const run = await getRun(workspaceId, runId);
    engine = (run?.agent ?? "").toLowerCase();
    runTitle = run?.title ?? null;
  } catch {
    // Postgres unavailable — leave engine blank; diagnostics fall back to n/a.
  }
  const readGrounded = engine !== "" && READ_GROUNDED_ENGINES.has(engine);

  // Read-grounded diagnostics (issue #1037) ride the context_events channel
  // tagged by reason, so they must be split out of the ordinary retrieval lists.
  const isLive = (r: string) => r === "live_waste" || r === "live_miss";
  const included = items
    .filter((i) => i.included === 1 && !isLive(i.reason))
    .sort((a, b) => b.score - a.score);
  const excluded = items.filter(
    (i) => i.included === 0 && !isLive(i.reason)
  );
  // Waste = pack files the executor never read (precision waste).
  // Miss  = files the executor fetched itself, absent from the pack (recall miss).
  const waste = items.filter((i) => i.reason === "live_waste");
  const miss = items.filter((i) => i.reason === "live_miss");

  return (
    <div className="mx-auto max-w-[1440px]">
      {/* Breadcrumb — extends the Work → run detail trail (#1231) into this
          run sub-page, so drilling from a work item never strands the user
          (#1232 AC2). The run crumb shows its title when one exists (names
          over IDs); the context pack itself has no name, so it stays id'd. */}
      <nav className="mb-4 flex items-center gap-1 text-xs text-[var(--gray-09)]">
        <Link
          href={`/dashboard/${workspaceId}/work`}
          className="hover:text-[var(--gray-12)] transition-colors"
        >
          Work
        </Link>
        <span>/</span>
        <Link
          href={`/dashboard/${workspaceId}/runs`}
          className="hover:text-[var(--gray-12)] transition-colors"
        >
          Runs
        </Link>
        <span>/</span>
        <Link
          href={`/dashboard/${workspaceId}/runs/${runId}`}
          className={`hover:text-[var(--gray-12)] transition-colors ${runTitle ? "" : "font-mono"}`}
        >
          {runTitle || runId.slice(0, 8)}
        </Link>
        <span>/</span>
        <span className="text-[var(--gray-11)]">Context Pack</span>
        <span>/</span>
        <span className="font-mono text-[var(--gray-11)]">
          {packId.slice(0, 8)}
        </span>
      </nav>

      {/* Pack metadata */}
      <div className="mb-6 rounded border border-[var(--purple-09)]/40 bg-[var(--gray-02)] p-4">
        <h1 className="mb-3 flex flex-wrap items-center gap-2 text-sm font-semibold text-[var(--gray-12)]">
          Context Pack
          <span className="font-mono text-[var(--gray-09)] font-normal text-xs">
            {packId}
          </span>
          {/* Engine tag (issue #1037): read-grounded metrics are only
              measurable for engines with a transcript vehicle. */}
          <span
            className="rounded-sm bg-[var(--gray-03)] px-1.5 py-0.5 font-mono text-[10px] font-normal uppercase tracking-wide text-[var(--gray-11)]"
            title="Executor engine for this run"
          >
            {engine || "engine n/a"}
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

      {/* Read-grounded diagnostics (issue #1037): what the executor actually
          read vs what the pack shipped. For engines without a transcript
          vehicle we show an explicit n/a — never a fabricated zero. */}
      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Precision waste — pack files the executor never opened. */}
        <section>
          <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--gray-09)]">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: "#ffb454" }}
            />
            Precision waste
            <span className="rounded-sm bg-[#3a2e12] px-1.5 py-0.5 text-[10px] text-[#ffb454] font-mono">
              {readGrounded ? waste.length : "n/a"}
            </span>
          </h2>
          <div className="rounded border border-[var(--gray-05)] overflow-hidden">
            {!readGrounded ? (
              <p className="px-3 py-4 text-xs text-[var(--gray-09)]">
                Read-grounded metrics are n/a for this engine
                {engine ? ` (${engine})` : ""} — no transcript to measure reads.
              </p>
            ) : waste.length === 0 ? (
              <p className="px-3 py-4 text-xs text-[var(--gray-09)]">
                Every pack file was read — no precision waste.
              </p>
            ) : (
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="border-b border-[var(--gray-05)] bg-[var(--gray-01)]">
                    <th className="px-3 py-2 text-left font-medium uppercase tracking-wide text-[var(--gray-09)]">
                      Pack file never read
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {waste.map((item, idx) => (
                    <tr
                      key={idx}
                      className="border-b border-[var(--gray-04)] hover:bg-[var(--gray-03)] transition-colors"
                      style={{ height: "34px" }}
                    >
                      <td className="px-3 py-1.5">
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
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        {/* Recall miss — files the executor fetched itself, absent from the pack. */}
        <section>
          <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--gray-09)]">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: "#7aa2ff" }}
            />
            Recall miss
            <span className="rounded-sm bg-[#12233a] px-1.5 py-0.5 text-[10px] text-[#7aa2ff] font-mono">
              {readGrounded ? miss.length : "n/a"}
            </span>
          </h2>
          <div className="rounded border border-[var(--gray-05)] overflow-hidden">
            {!readGrounded ? (
              <p className="px-3 py-4 text-xs text-[var(--gray-09)]">
                Read-grounded metrics are n/a for this engine
                {engine ? ` (${engine})` : ""} — no transcript to measure reads.
              </p>
            ) : miss.length === 0 ? (
              <p className="px-3 py-4 text-xs text-[var(--gray-09)]">
                The executor fetched nothing outside the pack — no recall miss.
              </p>
            ) : (
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="border-b border-[var(--gray-05)] bg-[var(--gray-01)]">
                    <th className="px-3 py-2 text-left font-medium uppercase tracking-wide text-[var(--gray-09)]">
                      File fetched outside the pack
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {miss.map((item, idx) => (
                    <tr
                      key={idx}
                      className="border-b border-[var(--gray-04)] hover:bg-[var(--gray-03)] transition-colors"
                      style={{ height: "34px" }}
                    >
                      <td className="px-3 py-1.5">
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
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Included items */}
        <section>
          <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--gray-09)]">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: "var(--green-11)" }}
            />
            Included
            <span className="rounded-sm bg-[#1a3a2e] px-1.5 py-0.5 text-[10px] text-[var(--green-11)] font-mono">
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
                        <span className="font-mono text-[var(--purple-11)]">
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
              style={{ backgroundColor: "var(--red-11)" }}
            />
            Excluded
            <span className="rounded-sm bg-[#3a1a1a] px-1.5 py-0.5 text-[10px] text-[var(--red-11)] font-mono">
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
