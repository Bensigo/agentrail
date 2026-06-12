import { describe, it, expect } from "vitest";
import {
  groupTimelineEvents,
  parseActivityEntry,
} from "./group-timeline-events";
import type { TimelineEvent } from "./run-timeline";

function ev(overrides: Partial<TimelineEvent>): TimelineEvent {
  return {
    event_id: `ev-${Math.random().toString(36).slice(2)}`,
    event_type: "cost_event",
    phase: "execute",
    severity: "info",
    occurred_at: "2026-06-12T10:00:00.000Z",
    payload: "{}",
    ...overrides,
  };
}

function activity(phase: string, summary = "thinking", tools: string[] = []) {
  return ev({
    event_type: "agent_activity",
    phase,
    payload: JSON.stringify({
      type: "agent_activity",
      phase,
      summary,
      tools,
    }),
  });
}

describe("groupTimelineEvents", () => {
  it("passes non-activity events through unchanged and in order", () => {
    const events = [ev({ event_type: "cost_event" }), ev({ event_type: "review_gate" })];
    const items = groupTimelineEvents(events);

    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ type: "event", event: events[0] });
    expect(items[1]).toEqual({ type: "event", event: events[1] });
  });

  it("folds consecutive agent_activity events of the same phase into one group with a count", () => {
    const events = [
      ev({ event_type: "cost_event" }),
      activity("plan", "turn 1"),
      activity("plan", "turn 2"),
      activity("plan", "turn 3"),
      ev({ event_type: "review_gate" }),
    ];
    const items = groupTimelineEvents(events);

    expect(items).toHaveLength(3);
    expect(items[0].type).toBe("event");
    expect(items[1]).toMatchObject({ type: "activity", phase: "plan" });
    if (items[1].type === "activity") {
      expect(items[1].events).toHaveLength(3);
    }
    expect(items[2].type).toBe("event");
  });

  it("starts a new group when the phase changes", () => {
    const items = groupTimelineEvents([
      activity("plan"),
      activity("plan"),
      activity("execute"),
    ]);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ type: "activity", phase: "plan" });
    expect(items[1]).toMatchObject({ type: "activity", phase: "execute" });
  });

  it("does not merge activity groups across an interleaved event", () => {
    const items = groupTimelineEvents([
      activity("execute"),
      ev({ event_type: "failure_event" }),
      activity("execute"),
    ]);

    expect(items.map((i) => i.type)).toEqual(["activity", "event", "activity"]);
  });

  it("returns an empty list for no events", () => {
    expect(groupTimelineEvents([])).toEqual([]);
  });
});

describe("parseActivityEntry", () => {
  it("extracts summary and tool names from the payload", () => {
    const entry = parseActivityEntry(
      JSON.stringify({
        type: "agent_activity",
        phase: "execute",
        summary: "Let me read the config first.",
        tools: ["Read", "Grep"],
      })
    );

    expect(entry.summary).toBe("Let me read the config first.");
    expect(entry.tools).toEqual(["Read", "Grep"]);
  });

  it("is defensive about malformed payloads", () => {
    expect(parseActivityEntry("not json")).toEqual({
      summary: "not json",
      tools: [],
    });
    expect(parseActivityEntry(JSON.stringify({ tools: [1, "Bash"] }))).toEqual({
      summary: "",
      tools: ["Bash"],
    });
  });
});
