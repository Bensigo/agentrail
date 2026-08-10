import { beforeEach, describe, expect, it, vi } from "vitest";

type StoredEvent = {
  id: string;
  recordId: string;
  eventKey: string;
  stage: string;
  at: Date;
  actor: string;
  payloadRef: Record<string, unknown>;
  createdAt: Date;
};

const { database, state, transaction } = vi.hoisted(() => {
  const state = {
    committed: new Map<string, StoredEvent>(),
    active: undefined as Map<string, StoredEvent> | undefined,
    lastKey: "",
  };
  const rows = () => state.active ?? state.committed;
  const key = (recordId: string, eventKey: string) => `${recordId}:${eventKey}`;
  const sqlParams = (query: unknown): unknown[] => {
    const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
    return chunks
      .filter((chunk) => !(
        chunk && typeof chunk === "object" && Array.isArray((chunk as { value?: unknown }).value)
      ))
      .map((chunk) => (
        chunk && typeof chunk === "object" && "value" in chunk
          ? (chunk as { value: unknown }).value
          : chunk
      ));
  };
  const transaction = vi.fn(async (callback: (tx: unknown) => unknown) => {
    const snapshot = new Map(state.committed);
    state.active = snapshot;
    try {
      const result = await callback(tx);
      state.committed = snapshot;
      return result;
    } finally {
      state.active = undefined;
    }
  });
  const tx = {
    execute: async (query: unknown) => {
      const [id, recordId, eventKey, stage, at, actor, payloadRef] = sqlParams(query);
      if (
        typeof id !== "string" || typeof recordId !== "string" || typeof eventKey !== "string"
        || typeof stage !== "string" || typeof at !== "string" || typeof actor !== "string"
        || typeof payloadRef !== "string"
      ) {
        throw new Error("atomic append SQL did not bind the expected event values");
      }
      state.lastKey = key(recordId, eventKey);
      const currentRows = rows();
      if (currentRows.has(state.lastKey)) return [];
      const event: StoredEvent = {
        id,
        recordId,
        eventKey,
        stage,
        at: new Date(at),
        actor,
        payloadRef: JSON.parse(payloadRef),
        createdAt: new Date("2026-08-10T00:00:00.000Z"),
      };
      currentRows.set(state.lastKey, event);
      return [{
        id: event.id,
        record_id: event.recordId,
        event_key: event.eventKey,
        stage: event.stage,
        at: event.at,
        actor: event.actor,
        payload_ref: event.payloadRef,
        created_at: event.createdAt,
      }];
    },
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            const event = rows().get(state.lastKey);
            return event ? [event] : [];
          },
        }),
      }),
    }),
  };
  return { database: { transaction }, state, transaction };
});

vi.mock("../db.js", () => ({ db: database }));

import { appendChangeRecordEventsAtomically } from "./change_records.js";

const event = (overrides: Record<string, unknown> = {}) => ({
  recordId: "record-1",
  eventKey: "event-1",
  stage: "contract",
  actor: "console_user:user-1",
  payloadRef: { version: 1 },
  ...overrides,
});

beforeEach(() => {
  state.committed.clear();
  state.active = undefined;
  state.lastKey = "";
  transaction.mockClear();
});

describe("appendChangeRecordEventsAtomically", () => {
  it("inserts every event in input order and exactly replays it despite a new timestamp", async () => {
    const inputs = [
      event({ eventKey: "contract", at: new Date("2026-08-10T09:00:00.000Z") }),
      event({ eventKey: "evidence", stage: "evidence", payloadRef: { artifactKey: "proof.json" } }),
    ];

    const first = await appendChangeRecordEventsAtomically(inputs);
    expect(first.events.map((result) => result.event.eventKey)).toEqual(["contract", "evidence"]);
    expect(first.events.map((result) => result.inserted)).toEqual([true, true]);

    const replay = await appendChangeRecordEventsAtomically(inputs.map((input) => ({
      ...input,
      at: new Date("2026-08-10T10:00:00.000Z"),
    })));
    expect(replay.events.map((result) => result.inserted)).toEqual([false, false]);
    expect(replay.events.map((result) => result.event.id)).toEqual(
      first.events.map((result) => result.event.id)
    );
  });

  it.each(["stage", "actor", "payloadRef"] as const)(
    "rolls back prior inserts when one reused event key has a different %s",
    async (field) => {
    await appendChangeRecordEventsAtomically([event({ eventKey: "existing" })]);

    const conflict = event({ eventKey: "existing" });
    if (field === "stage") conflict.stage = "evidence";
    if (field === "actor") conflict.actor = "console_user:user-2";
    if (field === "payloadRef") conflict.payloadRef = { version: 2 };

    await expect(appendChangeRecordEventsAtomically([
      event({ eventKey: "new-before-conflict", stage: "evidence" }),
      conflict,
    ])).rejects.toThrow("already bound to different stage, actor, or payloadRef");

    expect([...state.committed.values()].map((stored) => stored.eventKey)).toEqual(["existing"]);
    }
  );

  it("returns false then true for an exact preexisting event followed by a new event", async () => {
    const preexisting = event({ eventKey: "existing" });
    await appendChangeRecordEventsAtomically([preexisting]);

    const result = await appendChangeRecordEventsAtomically([
      { ...preexisting, at: new Date("2026-08-10T10:00:00.000Z") },
      event({ eventKey: "new", stage: "evidence", payloadRef: { artifactKey: "proof.json" } }),
    ]);
    expect(result.events.map((entry) => entry.inserted)).toEqual([false, true]);
    expect([...state.committed.values()].map((stored) => stored.eventKey)).toEqual(["existing", "new"]);
  });
});

describe("appendChangeRecordEventsAtomically input validation", () => {
  it("rejects an empty batch before opening a transaction", async () => {
    await expect(appendChangeRecordEventsAtomically([])).rejects.toThrow("at least one event");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("atomically persists every event in a valid batch larger than 100", async () => {
    const result = await appendChangeRecordEventsAtomically(
      Array.from({ length: 101 }, (_, index) =>
        event({ eventKey: `event-${index}` })
      )
    );

    expect(result.events).toHaveLength(101);
    expect(result.events.every((entry) => entry.inserted)).toBe(true);
    expect(state.committed.size).toBe(101);
  });

  it("rejects duplicate event keys and mixed record IDs before opening a transaction", async () => {
    await expect(appendChangeRecordEventsAtomically([
      event(),
      event({ stage: "evidence" }),
    ])).rejects.toThrow("duplicate eventKeys");
    await expect(appendChangeRecordEventsAtomically([
      event(),
      event({ recordId: "record-2", eventKey: "event-2" }),
    ])).rejects.toThrow("one recordId");
    expect(transaction).not.toHaveBeenCalled();
  });
});
