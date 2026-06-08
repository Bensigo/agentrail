"use client";

import { useEffect, useState } from "react";

interface RunEvent {
  event_id: string;
  event_type: string;
  phase: string;
  severity: string;
  occurred_at: string;
  payload: string;
}

const severityColors: Record<string, string> = {
  info: "bg-[var(--blue-09)]",
  warning: "bg-[#f76b15]",
  error: "bg-[#e5484d]",
  critical: "bg-[#e5484d]",
};

export function EventTimeline({
  workspaceId,
  runId,
}: {
  workspaceId: string;
  runId: string;
}) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch(`/api/v1/workspaces/${workspaceId}/runs/${runId}`)
      .then((r) => r.json())
      .then((data) => {
        setEvents(data.events ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [workspaceId, runId]);

  if (loading) {
    return (
      <div className="mt-4 space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-8 animate-pulse rounded bg-[var(--gray-03)]" />
        ))}
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <p className="mt-4 text-sm text-[var(--gray-09)]">
        No events recorded for this run.
      </p>
    );
  }

  return (
    <div className="relative mt-4 pl-6">
      <div className="absolute left-2 top-0 h-full w-0.5 bg-[var(--gray-05)]" />
      {events.map((evt) => {
        const isExpanded = expanded.has(evt.event_id);
        return (
          <div key={evt.event_id} className="relative mb-4">
            <div
              className={`absolute -left-4 top-1.5 h-2 w-2 rounded-full ${severityColors[evt.severity] ?? "bg-[var(--gray-07)]"}`}
            />
            <button
              onClick={() => {
                const next = new Set(expanded);
                if (isExpanded) next.delete(evt.event_id);
                else next.add(evt.event_id);
                setExpanded(next);
              }}
              className="flex w-full items-center gap-3 text-left"
            >
              <span className="font-mono text-xs text-[var(--gray-09)]">
                {new Date(evt.occurred_at).toLocaleTimeString()}
              </span>
              <span className="text-sm text-[var(--gray-12)]">
                {evt.event_type}
              </span>
              <span className="rounded-sm bg-[var(--gray-03)] px-1 py-0.5 text-xs text-[var(--gray-09)]">
                {evt.phase}
              </span>
            </button>
            {isExpanded && (
              <pre className="mt-2 overflow-x-auto rounded border border-[var(--gray-04)] bg-[var(--gray-02)] p-3 font-mono text-xs text-[var(--gray-11)]">
                {(() => {
                  try {
                    return JSON.stringify(JSON.parse(evt.payload), null, 2);
                  } catch {
                    return evt.payload;
                  }
                })()}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}
