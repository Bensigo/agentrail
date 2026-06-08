"use client";

import { useEffect, useState } from "react";

interface MemoryItem {
  id: string;
  source: string;
  content: string;
  contentPreview: string;
  tags: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export function MemoryList({ workspaceId }: { workspaceId: string }) {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch(`/api/v1/workspaces/${workspaceId}/memory`)
      .then((r) => r.json())
      .then((data) => {
        setItems(data.items ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [workspaceId]);

  if (loading) {
    return (
      <div className="mt-4 space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-8 animate-pulse rounded bg-[var(--gray-03)]" />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <p className="mt-4 text-sm text-[var(--gray-09)]">No memory items found.</p>
    );
  }

  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--gray-04)] text-left text-xs uppercase text-[var(--gray-09)]">
            <th className="px-3 py-2">Source</th>
            <th className="px-3 py-2">Content</th>
            <th className="px-3 py-2">Tags</th>
            <th className="px-3 py-2">Created</th>
            <th className="px-3 py-2">Last Used</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const isExpanded = expanded.has(item.id);
            return (
              <>
                <tr
                  key={item.id}
                  onClick={() => {
                    const next = new Set(expanded);
                    if (isExpanded) next.delete(item.id);
                    else next.add(item.id);
                    setExpanded(next);
                  }}
                  className="cursor-pointer border-b border-[var(--gray-03)] hover:bg-[var(--gray-02)]"
                >
                  <td className="px-3 py-2 font-mono text-xs text-[var(--gray-12)]">
                    {item.source}
                  </td>
                  <td className="max-w-[400px] truncate px-3 py-2 text-xs text-[var(--gray-11)]">
                    {item.contentPreview}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {item.tags?.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-sm bg-[var(--gray-03)] px-1 py-0.5 text-xs text-[var(--gray-09)]"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-[var(--gray-09)]">
                    {new Date(item.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-[var(--gray-09)]">
                    {item.lastUsedAt
                      ? new Date(item.lastUsedAt).toLocaleDateString()
                      : "Never"}
                  </td>
                </tr>
                {isExpanded && (
                  <tr key={`${item.id}-detail`}>
                    <td colSpan={5} className="bg-[var(--gray-01)] px-3 py-4">
                      <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs text-[var(--gray-11)]">
                        {item.content}
                      </pre>
                    </td>
                  </tr>
                )}
              </>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
