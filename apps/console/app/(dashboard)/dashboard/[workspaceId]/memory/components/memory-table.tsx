"use client";

import { useState, useEffect } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

export interface MemoryItemRecord {
  id: string;
  source: string;
  content_preview: string;
  content: string;
  tags: string[];
  created_at: string;
  last_used_at: string | null;
}

interface MemoryTableProps {
  workspaceId: string;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function MemoryTable({ workspaceId }: MemoryTableProps) {
  const [data, setData] = useState<MemoryItemRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    async function fetchMemory() {
      try {
        const res = await fetch(
          `/api/v1/workspaces/${workspaceId}/memory`,
          { cache: "no-store" }
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            (body as { error?: string }).error ?? `HTTP ${res.status}`
          );
        }
        const json = (await res.json()) as { items: MemoryItemRecord[] };
        setData(json.items);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load memory items");
      } finally {
        setLoading(false);
      }
    }
    fetchMemory();
  }, [workspaceId]);

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  const COLS = 4; // source, content preview, created_at, last_used_at

  return (
    <div className="rounded border border-[var(--gray-05)] overflow-hidden">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-[var(--gray-05)] bg-[var(--gray-01)]">
            <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)] w-6" />
            <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
              Source
            </th>
            <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
              Content preview
            </th>
            <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)] whitespace-nowrap">
              Created
            </th>
            <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)] whitespace-nowrap">
              Last used
            </th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td
                colSpan={COLS + 1}
                className="px-3 py-8 text-center text-sm text-[var(--gray-09)]"
              >
                <span className="animate-pulse">Loading memory…</span>
              </td>
            </tr>
          ) : error ? (
            <tr>
              <td
                colSpan={COLS + 1}
                className="px-3 py-8 text-center text-sm text-[#ff9592]"
              >
                {error}
              </td>
            </tr>
          ) : data.length === 0 ? (
            <tr>
              <td
                colSpan={COLS + 1}
                className="px-3 py-8 text-center text-sm text-[var(--gray-09)]"
              >
                No memory items found
              </td>
            </tr>
          ) : (
            data.map((item) => {
              const expanded = expandedIds.has(item.id);
              return (
                <>
                  <tr
                    key={item.id}
                    onClick={() => toggleExpand(item.id)}
                    className="border-b border-[var(--gray-04)] hover:bg-[var(--gray-02)] cursor-pointer transition-colors"
                    style={{ height: "34px" }}
                  >
                    <td className="px-3 py-1.5 text-[var(--gray-09)]">
                      {expanded ? (
                        <ChevronDown size={12} />
                      ) : (
                        <ChevronRight size={12} />
                      )}
                    </td>
                    <td className="px-3 py-1.5 max-w-[240px]">
                      <span className="font-mono text-xs text-[var(--gray-11)] truncate block">
                        {item.source}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 max-w-[400px]">
                      <span className="text-[var(--gray-12)] text-xs truncate block">
                        {item.content_preview}
                        {item.content.length > 200 && !expanded && "…"}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      <span className="font-mono text-xs text-[var(--gray-10)]">
                        {formatDate(item.created_at)}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      <span className="font-mono text-xs text-[var(--gray-10)]">
                        {formatDate(item.last_used_at)}
                      </span>
                    </td>
                  </tr>
                  {expanded && (
                    <tr
                      key={`${item.id}-expanded`}
                      className="border-b border-[var(--gray-04)] bg-[var(--gray-01)]"
                    >
                      <td />
                      <td colSpan={COLS} className="px-3 py-3">
                        <div className="flex flex-col gap-2">
                          {item.tags.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {item.tags.map((tag) => (
                                <span
                                  key={tag}
                                  className="inline-flex items-center px-1.5 py-0.5 rounded-sm text-xs font-medium bg-[var(--gray-04)] text-[var(--gray-10)] border border-[var(--gray-06)]"
                                >
                                  {tag}
                                </span>
                              ))}
                            </div>
                          )}
                          <pre className="font-mono text-xs text-[var(--gray-11)] whitespace-pre-wrap break-words leading-relaxed">
                            {item.content}
                          </pre>
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
