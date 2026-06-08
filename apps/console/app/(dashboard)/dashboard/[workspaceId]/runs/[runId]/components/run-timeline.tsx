"use client";

import { useState } from "react";
import Link from "next/link";

export interface TimelineEvent {
  event_id: string;
  event_type: string;
  phase: string;
  severity: string;
  occurred_at: string | Date;
  payload: string;
}

const EVENT_TYPE_COLORS: Record<string, string> = {
  context_event: "#7c66dc",
  failure_event: "#e5484d",
  review_gate: "#f76b15",
  cost_event: "#0090ff",
  audit_event: "#ffa057",
};

function dotColor(event_type: string): string {
  return EVENT_TYPE_COLORS[event_type] ?? "#6f6f6f";
}

function formatTimestamp(ts: string | Date): string {
  const d = typeof ts === "string" ? new Date(ts) : ts;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function parsePayload(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function detailLink(
  event_type: string,
  workspaceId: string,
  runId: string
): string | null {
  if (event_type === "context_event")
    return `/dashboard/${workspaceId}/context-packs?runId=${runId}`;
  if (event_type === "failure_event")
    return `/dashboard/${workspaceId}/failures?runId=${runId}`;
  if (event_type === "review_gate")
    return `/dashboard/${workspaceId}/review-gates?runId=${runId}`;
  return null;
}

interface TimelineEntryProps {
  event: TimelineEvent;
  workspaceId: string;
  runId: string;
  isLast: boolean;
}

function TimelineEntry({
  event,
  workspaceId,
  runId,
  isLast,
}: TimelineEntryProps) {
  const [expanded, setExpanded] = useState(false);
  const color = dotColor(event.event_type);
  const link = detailLink(event.event_type, workspaceId, runId);
  const payload = parsePayload(event.payload);

  return (
    <div className="flex gap-3">
      {/* Left column: line + dot */}
      <div className="flex flex-col items-center" style={{ width: "16px" }}>
        <div
          className="rounded-full shrink-0"
          style={{
            width: "8px",
            height: "8px",
            backgroundColor: color,
            marginTop: "4px",
          }}
        />
        {!isLast && (
          <div
            className="flex-1 mt-1"
            style={{ width: "2px", backgroundColor: "var(--gray-05)" }}
          />
        )}
      </div>

      {/* Right column: content */}
      <div className="flex-1 pb-4">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="w-full text-left flex items-start justify-between gap-2 group"
        >
          <div className="flex flex-col gap-0.5">
            <span className="text-sm text-[var(--gray-12)] group-hover:text-white transition-colors">
              {event.event_type.replace(/_/g, " ")}
            </span>
            <span className="text-xs font-mono text-[var(--gray-09)]">
              {formatTimestamp(event.occurred_at)}
            </span>
          </div>
          <span className="text-xs text-[var(--gray-08)] mt-0.5 shrink-0">
            {expanded ? "▲" : "▼"}
          </span>
        </button>

        {expanded && (
          <div className="mt-2 space-y-2">
            <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-3 overflow-x-auto">
              <pre className="text-xs font-mono text-[var(--gray-11)] whitespace-pre-wrap break-words">
                {typeof payload === "string"
                  ? payload
                  : JSON.stringify(payload, null, 2)}
              </pre>
            </div>
            {link && (
              <Link
                href={link}
                className="inline-flex items-center gap-1 text-xs text-[#7c66dc] hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                View {event.event_type.replace(/_/g, " ")} detail →
              </Link>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface RunTimelineProps {
  events: TimelineEvent[];
  workspaceId: string;
  runId: string;
}

export function RunTimeline({ events, workspaceId, runId }: RunTimelineProps) {
  if (events.length === 0) {
    return (
      <p className="text-sm text-[var(--gray-09)] py-6">No events recorded.</p>
    );
  }

  return (
    <div className="flex flex-col">
      {events.map((event, i) => (
        <TimelineEntry
          key={event.event_id}
          event={event}
          workspaceId={workspaceId}
          runId={runId}
          isLast={i === events.length - 1}
        />
      ))}
    </div>
  );
}
