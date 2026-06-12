/**
 * Grouping logic for the run-detail timeline.
 *
 * Consecutive `agent_activity` events from the same phase are folded into a
 * single collapsible group so the main timeline stays readable; every other
 * event passes through untouched. Kept as a pure module so it can be unit
 * tested without rendering React.
 */
import type { TimelineEvent } from "./run-timeline";

export type TimelineItem =
  | { type: "event"; event: TimelineEvent }
  | { type: "activity"; phase: string; events: TimelineEvent[] };

export interface ActivityEntryView {
  summary: string;
  tools: string[];
  /** Fuller turn text (CLI caps it); empty when the summary already carries everything. */
  fullText: string;
}

export function groupTimelineEvents(events: TimelineEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const event of events) {
    if (event.event_type === "agent_activity") {
      const last = items[items.length - 1];
      if (last && last.type === "activity" && last.phase === event.phase) {
        last.events.push(event);
      } else {
        items.push({ type: "activity", phase: event.phase, events: [event] });
      }
    } else {
      items.push({ type: "event", event });
    }
  }
  return items;
}

/** Parse an agent_activity payload into a display entry (defensive). */
export function parseActivityEntry(raw: string): ActivityEntryView {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const o = parsed as Record<string, unknown>;
      return {
        summary: typeof o.summary === "string" ? o.summary : "",
        tools: Array.isArray(o.tools)
          ? o.tools.filter((t): t is string => typeof t === "string")
          : [],
        fullText: typeof o.full_text === "string" ? o.full_text : "",
      };
    }
  } catch {
    // fall through
  }
  return { summary: raw, tools: [], fullText: "" };
}
