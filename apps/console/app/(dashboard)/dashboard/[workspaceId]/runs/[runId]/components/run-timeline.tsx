"use client";

import { useState } from "react";
import Link from "next/link";
import {
  groupTimelineEvents,
  parseActivityEntry,
} from "./group-timeline-events";
import type { ActivityEntryView } from "./group-timeline-events";

export interface TimelineEvent {
  event_id: string;
  event_type: string;
  phase: string;
  severity: string;
  occurred_at: string | Date;
  payload: string;
  /** AFK telemetry: action type (e.g. "EnqueueIssue") */
  kind?: string;
  /** AFK telemetry: human-readable label */
  label?: string;
  /** AFK telemetry: short digest for display */
  digest?: string;
}

const EVENT_TYPE_COLORS: Record<string, string> = {
  context_event: "var(--timeline-context)",
  failure_event: "var(--red-09)",
  review_gate: "var(--orange-09)",
  cost_event: "var(--blue-09)",
  audit_event: "var(--orange-11)",
  agent_activity: "var(--timeline-activity)",
  // AFK action types map to teal / semantic colors
  EnqueueIssue: "var(--teal-09)",
  ClaimIssue: "var(--teal-09)",
  SetStatus: "var(--teal-09)",
  SetPr: "var(--teal-09)",
  RecordFailure: "var(--red-09)",
  ReleaseIssue: "var(--purple-09)",
  RequeueIssue: "var(--orange-09)",
  IncrementReviewRound: "var(--orange-09)",
  FreeSlot: "var(--purple-09)",
};

function dotColor(event_type: string, kind?: string): string {
  const key = kind ?? event_type;
  return (
    EVENT_TYPE_COLORS[key] ??
    EVENT_TYPE_COLORS[event_type] ??
    "var(--timeline-neutral)"
  );
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
  // The context pack is rendered in the Context section on this same run page,
  // so deep-link to that anchor rather than a separate page.
  if (event_type === "context_event") return "#context";
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
  const color = dotColor(event.event_type, event.kind);
  const link = detailLink(event.event_type, workspaceId, runId);
  const payload = parsePayload(event.payload);

  // Prefer AFK telemetry label, fall back to prettified event_type.
  const displayLabel = event.label ?? event.event_type.replace(/_/g, " ");
  const displayDigest = event.digest ?? event.event_id.slice(0, 8);

  return (
    <div id={`event-${event.event_id}`} className="flex scroll-mt-6 gap-3">
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
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm text-[var(--gray-12)] group-hover:text-white transition-colors">
                {displayLabel}
              </span>
              {event.kind && (
                <span className="text-xs px-1 py-0.5 rounded-sm bg-[var(--gray-03)] text-[var(--gray-09)] font-mono">
                  {event.kind}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs font-mono text-[var(--gray-09)]">
                {formatTimestamp(event.occurred_at)}
              </span>
              <span className="text-xs font-mono text-[var(--gray-07)]">
                {displayDigest}
              </span>
            </div>
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
                className="inline-flex items-center gap-1 text-xs text-[var(--timeline-context)] hover:underline"
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

interface ActivityGroupProps {
  phase: string;
  events: TimelineEvent[];
  isLast: boolean;
}

function ActivityGroup({ phase, events, isLast }: ActivityGroupProps) {
  const [expanded, setExpanded] = useState(false);
  const color = EVENT_TYPE_COLORS.agent_activity;

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
        <div aria-hidden="true" className="sr-only">
          {events.map((event) => (
            <span
              key={event.event_id}
              id={`event-${event.event_id}`}
              className="scroll-mt-6"
            />
          ))}
        </div>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="w-full text-left flex items-start justify-between gap-2 group"
        >
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm text-[var(--gray-12)] group-hover:text-white transition-colors">
                Agent activity ({events.length})
              </span>
              {phase && (
                <span className="text-xs px-1 py-0.5 rounded-sm bg-[var(--gray-03)] text-[var(--gray-09)] font-mono">
                  {phase}
                </span>
              )}
            </div>
            <span className="text-xs font-mono text-[var(--gray-09)]">
              {formatTimestamp(events[0].occurred_at)}
            </span>
          </div>
          <span className="text-xs text-[var(--gray-08)] mt-0.5 shrink-0">
            {expanded ? "▲" : "▼"}
          </span>
        </button>

        {expanded && (
          <div className="mt-2 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] divide-y divide-[var(--gray-04)]">
            {events.map((event) => (
              <ActivityEntryRow
                key={event.event_id}
                eventId={event.event_id}
                entry={parseActivityEntry(event.payload)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ActivityEntryRow({
  eventId,
  entry,
}: {
  eventId: string;
  entry: ActivityEntryView;
}) {
  const [showFull, setShowFull] = useState(false);

  return (
    <div className="p-3 flex flex-col gap-1.5">
      {entry.summary && (
        <p className="text-xs text-[var(--gray-11)] whitespace-pre-wrap break-words">
          {showFull && entry.fullText ? entry.fullText : entry.summary}
        </p>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        {entry.tools.map((tool, i) => (
          <span
            key={`${eventId}-${tool}-${i}`}
            className="text-xs px-1 py-0.5 rounded-sm bg-[var(--gray-03)] text-[var(--gray-09)] font-mono"
          >
            {tool}
          </span>
        ))}
        {entry.fullText && (
          <button
            onClick={() => setShowFull((v) => !v)}
            className="text-xs text-[var(--blue-11)] hover:underline"
          >
            {showFull ? "Show less" : "Show full text"}
          </button>
        )}
      </div>
    </div>
  );
}

interface RunTimelineProps {
  events: TimelineEvent[];
  workspaceId: string;
  runId: string;
  /** Show pulsing "loading" text when no events have arrived yet */
  loading?: boolean;
}

export function RunTimeline({
  events,
  workspaceId,
  runId,
  loading,
}: RunTimelineProps) {
  if (loading && events.length === 0) {
    return (
      <p className="text-sm text-[var(--gray-09)] animate-pulse py-6">
        Loading events…
      </p>
    );
  }

  if (events.length === 0) {
    return (
      <p className="text-sm text-[var(--gray-09)] py-6">No events yet.</p>
    );
  }

  const items = groupTimelineEvents(events);

  return (
    <div className="flex flex-col">
      {items.map((item, i) =>
        item.type === "activity" ? (
          <ActivityGroup
            key={item.events[0].event_id}
            phase={item.phase}
            events={item.events}
            isLast={i === items.length - 1}
          />
        ) : (
          <TimelineEntry
            key={item.event.event_id}
            event={item.event}
            workspaceId={workspaceId}
            runId={runId}
            isLast={i === items.length - 1}
          />
        )
      )}
    </div>
  );
}
