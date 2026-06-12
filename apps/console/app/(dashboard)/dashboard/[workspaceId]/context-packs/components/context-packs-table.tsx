"use client";

import { useState, useCallback, useEffect } from "react";
import Link from "next/link";
import { BookOpen } from "lucide-react";
import { StatusBadge } from "../../runs/components/status-badge";
import { SkeletonTableRows } from "../../../../../components/loading-skeleton";
import { EmptyState } from "../../../../../components/empty-state";

export interface ContextPackRow {
  context_pack_id: string;
  run_id: string;
  run_title: string | null;
  run_status: string | null;
  repository_name: string | null;
  token_budget: number;
  tokens_used: number;
  tokens_saved: number;
  anchors_extracted: number;
  sources_considered: number;
  occurred_at: string;
}

interface ContextPacksTableProps {
  workspaceId: string;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/** "2h ago"-style relative time; falls back to a short date beyond 30 days. */
function timeAgo(iso: string): string {
  const date = new Date(iso);
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days <= 30) return `${days}d ago`;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

function retrievedSummary(p: ContextPackRow): string {
  const parts: string[] = [];
  if (p.sources_considered > 0) {
    parts.push(`${p.sources_considered} source${p.sources_considered === 1 ? "" : "s"}`);
  }
  if (p.anchors_extracted > 0) {
    parts.push(`${p.anchors_extracted} anchor${p.anchors_extracted === 1 ? "" : "s"}`);
  }
  return parts.length > 0 ? parts.join(", ") : "—";
}

export function ContextPacksTable({ workspaceId }: ContextPacksTableProps) {
  const [data, setData] = useState<ContextPackRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPacks = useCallback(
    async (cursor?: string, append = false) => {
      if (!append) {
        setLoading(true);
        setError(null);
      } else {
        setLoadingMore(true);
      }
      try {
        const url = new URL(
          `/api/v1/workspaces/${workspaceId}/context-packs`,
          window.location.origin
        );
        if (cursor) url.searchParams.set("cursor", cursor);
        const res = await fetch(url.toString());
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
        }
        const json = (await res.json()) as {
          packs: ContextPackRow[];
          nextCursor: string | null;
        };
        setData((prev) => (append ? [...prev, ...json.packs] : json.packs));
        setNextCursor(json.nextCursor ?? null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load context packs");
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [workspaceId]
  );

  useEffect(() => {
    fetchPacks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadMore = () => {
    if (nextCursor) fetchPacks(nextCursor, true);
  };

  const COLS = 5;

  if (error) {
    return (
      <p className="py-8 text-center text-sm text-[#ff9592]">{error}</p>
    );
  }

  if (!loading && data.length === 0) {
    return (
      <EmptyState
        icon={BookOpen}
        title="No context packs yet"
        description="Context packs gathered for agent runs will appear here."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded border border-[var(--gray-05)] overflow-hidden">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-[var(--gray-05)] bg-[var(--gray-01)]">
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                Run
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                Repository
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                Retrieved
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                Tokens
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                Gathered
              </th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <SkeletonTableRows columns={COLS} rows={10} />
            ) : (
              data.map((p) => {
                const repoName = p.repository_name;
                return (
                  <tr
                    key={p.context_pack_id}
                    className="border-b border-[var(--gray-04)] last:border-0"
                  >
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/dashboard/${workspaceId}/runs/${p.run_id}`}
                          className="text-[#70b8ff] hover:underline"
                        >
                          {p.run_title || (
                            <span className="font-mono">{p.run_id.slice(0, 8)}</span>
                          )}
                        </Link>
                        {p.run_status && <StatusBadge status={p.run_status} />}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-[var(--gray-11)]">
                      {repoName ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-[var(--gray-11)]">
                      {retrievedSummary(p)}
                    </td>
                    <td className="px-3 py-2">
                      {p.tokens_used > 0 || p.token_budget > 0 ? (
                        <div>
                          <span className="font-mono text-[var(--gray-12)]">
                            {fmt(p.tokens_used)}
                          </span>{" "}
                          <span className="text-[var(--gray-09)]">
                            used
                            {p.token_budget > 0 && (
                              <> of {fmt(p.token_budget)} budget</>
                            )}
                          </span>
                          {p.tokens_saved > 0 && (
                            <p className="text-xs text-[var(--gray-09)]">
                              <span className="font-mono text-[#1fd8a4]">
                                {fmt(p.tokens_saved)}
                              </span>{" "}
                              saved
                            </p>
                          )}
                        </div>
                      ) : (
                        <span className="text-[var(--gray-07)]">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-[var(--gray-10)]">
                      {timeAgo(p.occurred_at)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {nextCursor && !loading && (
        <div className="flex justify-center pt-1">
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="h-8 px-4 rounded bg-[var(--gray-03)] border border-[var(--gray-06)] text-sm text-[var(--gray-12)] hover:border-[var(--gray-08)] disabled:opacity-50 transition-colors"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
