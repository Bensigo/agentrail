import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ inserted: [] as Array<{ id: string }> }));

vi.mock("../db.js", () => {
  const db = {
    insert: (_table: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: (_options: unknown) => ({
          returning: async () => (values.deliveryId ? state.inserted : []),
        }),
      }),
    }),
  };
  return { db };
});

import { recordHumanReviewTime, recordReviewEvent } from "./review_events.js";

const base = {
  workspaceId: "ws-1",
  repo: "ada/widgets",
  prNumber: 42,
  taskFamily: "dependency-upgrade",
  deliveryId: "gh-delivery-1",
  eventType: "opened" as const,
  occurredAt: new Date("2026-08-01T09:00:00Z"),
};

beforeEach(() => {
  state.inserted = [{ id: "event-1" }];
});

describe("review event recording", () => {
  it("records a new delivery", async () => {
    await expect(recordReviewEvent(base)).resolves.toEqual({
      recorded: true,
      eventId: "event-1",
    });
  });

  it("treats a duplicate delivery as an idempotent no-op", async () => {
    const first = await recordReviewEvent(base);
    state.inserted = [];
    const second = await recordReviewEvent(base);

    expect(first.recorded).toBe(true);
    expect(second).toEqual({ recorded: false, eventId: null });
  });

  it("refuses human minutes without an explicit source", async () => {
    await expect(
      recordReviewEvent({
        ...base,
        eventType: "human_review_time",
        humanReviewMinutes: 20,
      })
    ).rejects.toThrow("explicit human_input or timer source");
  });

  it("accepts explicit timer minutes without consulting lifecycle timestamps", async () => {
    await expect(
      recordHumanReviewTime({
        workspaceId: base.workspaceId,
        repo: base.repo,
        prNumber: base.prNumber,
        taskFamily: base.taskFamily,
        deliveryId: "timer-1",
        occurredAt: new Date("2026-08-01T10:00:00Z"),
        minutes: 12,
        source: "timer",
      })
    ).resolves.toEqual({ recorded: true, eventId: "event-1" });
  });
});
