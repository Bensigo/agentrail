"use client";

import { Fragment, useState, useEffect } from "react";

interface MemoryItem {
  id: string;
  source: string;
  content_preview: string;
  content: string;
  tags: string[];
  created_at: string;
  last_used_at: string | null;
}

interface MemorySectionProps {
  workspaceId: string;
  runId: string;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function MemorySection({ workspaceId, runId }: MemorySectionProps) {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(
          `/api/v1/workspaces/${workspaceId}/runs/${runId}/memory`,
          { cache: "no-store" }
        );
        if (res.ok) {
          const json = (await res.json()) as { items: MemoryItem[] };
          setItems(json.items);
        }
      } catch {
        // non-fatal
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [workspaceId, runId]);

  // Only render when there are items to show
  if (loading || items.length === 0) {
    return null;
  }

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

  return (
    <div className="mt-8">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
          Memory
        </h2>
        <a
          href={`/dashboard/${workspaceId}/memory`}
          className="text-xs text-[var(--blue-11)] hover:underline"
        >
          View all →
        </a>
      </div>
      <div className="rounded border border-[var(--gray-05)] overflow-hidden">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-[var(--gray-05)] bg-[var(--gray-01)]">
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)] w-6" />
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                Content
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)] whitespace-nowrap">
                Created
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const expanded = expandedIds.has(item.id);
              return (
                <Fragment key={item.id}>
                  <tr
                    onClick={() => toggleExpand(item.id)}
                    className="border-b border-[var(--gray-04)] hover:bg-[var(--gray-02)] cursor-pointer transition-colors"
                    style={{ height: "34px" }}
                  >
                    <td className="px-3 py-1.5 text-[var(--gray-09)] text-xs">
                      {expanded ? "▾" : "▸"}
                    </td>
                    <td className="px-3 py-1.5 max-w-[560px]">
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
                  </tr>
                  {expanded && (
                    <tr
                      key={`${item.id}-expanded`}
                      className="border-b border-[var(--gray-04)] bg-[var(--gray-01)]"
                    >
                      <td />
                      <td colSpan={2} className="px-3 py-3">
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
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
