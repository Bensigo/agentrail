import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const state = vi.hoisted(() => ({
  inserted: [] as Array<{ id: string }>,
  selectRows: [] as unknown[],
  lastWhere: null as unknown,
  lastOrderBy: [] as unknown[],
}));

vi.mock("../db.js", () => {
  const db = {
    insert: (_table: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: (_options: unknown) => ({
          returning: async () => (values.deliveryId ? state.inserted : []),
        }),
      }),
    }),
    select: () => {
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn(() => chain);
      chain.where = vi.fn((condition: unknown) => {
        state.lastWhere = condition;
        return chain;
      });
      chain.orderBy = vi.fn((...args: unknown[]) => {
        state.lastOrderBy = args;
        return Promise.resolve(state.selectRows);
      });
      return chain;
    },
  };
  return { db };
});

import { reviewEvents } from "../schema/review_events.js";
import { recordHumanReviewTime, recordReviewEvent, listReviewEventsForPr, listReviewEventsForPrHead } from "./review_events.js";

const dialect = new PgDialect();
function renderCondition(condition: unknown) {
  return dialect.sqlToQuery(condition as Parameters<typeof dialect.sqlToQuery>[0]);
}

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
  state.selectRows = [];
  state.lastWhere = null;
  state.lastOrderBy = [];
  vi.clearAllMocks();
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

  it("requires a human actor and exact head for explicit rework/revert outcomes", async () => {
    await expect(
      recordReviewEvent({ ...base, eventType: "reverted", actorType: "agent", headSha: "a".repeat(40) })
    ).rejects.toThrow("explicit human actor");
    await expect(
      recordReviewEvent({ ...base, eventType: "post_merge_rework", actorType: "human" })
    ).rejects.toThrow("exact head SHA");
    await expect(
      recordReviewEvent({
        ...base,
        eventType: "post_merge_rework",
        actorType: "human",
        headSha: "a".repeat(40),
      })
    ).resolves.toEqual({ recorded: true, eventId: "event-1" });
  });
});

describe("listReviewEventsForPr", () => {
  it("filters by workspace, repo, and prNumber, oldest first", async () => {
    const rows = [
      {
        id: "event-1",
        workspaceId: "ws-1",
        repo: "ada/widgets",
        prNumber: 42,
        taskFamily: "dependency-upgrade",
        deliveryId: "delivery-1",
        eventType: "opened",
        occurredAt: new Date("2026-08-01T09:00:00Z"),
        headSha: null,
        reviewState: null,
        actorType: null,
        additions: null,
        deletions: null,
        changedFiles: null,
        humanReviewMinutes: null,
        humanReviewSource: null,
        createdAt: new Date("2026-08-01T09:00:01Z"),
      },
    ];
    state.selectRows = rows;

    await expect(
      listReviewEventsForPr({ workspaceId: "ws-1", repo: "ada/widgets", prNumber: 42 })
    ).resolves.toEqual(rows);

    expect(renderCondition(state.lastWhere)).toEqual(
      renderCondition(
        and(
          eq(reviewEvents.workspaceId, "ws-1"),
          eq(reviewEvents.repo, "ada/widgets"),
          eq(reviewEvents.prNumber, 42)
        )
      )
    );
    expect(state.lastOrderBy).toEqual([reviewEvents.occurredAt, reviewEvents.createdAt]);
  });
});

describe("listReviewEventsForPrHead", () => {
  it("filters by workspace, repo, PR number, and exact head", async () => {
    await listReviewEventsForPrHead({
      workspaceId: "ws-1", repo: "ada/widgets", prNumber: 42, headSha: "head-a",
    });

    expect(renderCondition(state.lastWhere)).toEqual(
      renderCondition(and(
        eq(reviewEvents.workspaceId, "ws-1"),
        eq(reviewEvents.repo, "ada/widgets"),
        eq(reviewEvents.prNumber, 42),
        eq(reviewEvents.headSha, "head-a")
      ))
    );
  });
});
