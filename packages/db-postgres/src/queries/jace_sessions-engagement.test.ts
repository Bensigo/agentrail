import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// Mocked db chain, same "mock the chain, control the terminal value" idiom as
// jace_sessions.brief-anchor.test.ts / jace_sessions-by-id.test.ts — there is
// no live-DB harness in this package.
vi.mock("../db.js", () => ({
  db: {
    update: vi.fn(),
    select: vi.fn(),
  },
}));

import { db } from "../db.js";
import { jaceSessions } from "../schema/jace_sessions.js";
import { getThreadEngagement, setThreadEngagement } from "./jace_sessions.js";

const mockDb = vi.mocked(db);

/** A chainable mock: every method returns the chain except `terminalMethod`, which resolves `finalValue`. */
function makeChain(terminalMethod: string, finalValue: unknown) {
  const chain: Record<string, unknown> = {};
  const methods = ["where", "set", "from", "limit"];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  chain[terminalMethod] = vi.fn(() => Promise.resolve(finalValue));
  return chain;
}

const dialect = new PgDialect();
function renderCondition(condition: unknown) {
  return dialect.sqlToQuery(condition as Parameters<typeof dialect.sqlToQuery>[0]);
}

const CHANNEL = "discord";
const CONVERSATION_KEY = "thread-123";
const SPEAKER_ID = "speaker-1";
const DORMANT_SINCE = new Date("2026-07-28T00:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getThreadEngagement", () => {
  it("returns null when no session row exists for (channel, conversationKey)", async () => {
    const selectChain = makeChain("limit", []);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await getThreadEngagement({
      channel: CHANNEL,
      conversationKey: CONVERSATION_KEY,
    });

    expect(result).toBeNull();

    const whereArgs = (selectChain.where as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    // Keyed on (channel, conversation_key) ONLY — what
    // jace_sessions_channel_conversation_idx serves. No workspace scoping.
    expect(renderCondition(whereArgs)).toEqual(
      renderCondition(
        and(
          eq(jaceSessions.channel, CHANNEL),
          eq(jaceSessions.conversationKey, CONVERSATION_KEY)
        )
      )
    );
  });

  it("returns {dormantSince: null, engagedSpeakerId: null} for a row that exists with both columns null — the DIFFERENT 'never engaged' case", async () => {
    const selectChain = makeChain("limit", [
      { dormantSince: null, engagedSpeakerId: null },
    ]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await getThreadEngagement({
      channel: CHANNEL,
      conversationKey: CONVERSATION_KEY,
    });

    expect(result).toEqual({ dormantSince: null, engagedSpeakerId: null });
    expect(result).not.toBeNull();
  });

  it("returns the stored dormantSince Date and engagedSpeakerId", async () => {
    const selectChain = makeChain("limit", [
      { dormantSince: DORMANT_SINCE, engagedSpeakerId: SPEAKER_ID },
    ]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await getThreadEngagement({
      channel: CHANNEL,
      conversationKey: CONVERSATION_KEY,
    });

    expect(result).toEqual({
      dormantSince: DORMANT_SINCE,
      engagedSpeakerId: SPEAKER_ID,
    });
  });
});

describe("setThreadEngagement", () => {
  it("updates jace_sessions with a Date and an id, scoped to (channel, conversationKey)", async () => {
    const updateChain = makeChain("where", undefined);
    mockDb.update = vi.fn(() => updateChain as ReturnType<typeof db.update>);

    await setThreadEngagement({
      channel: CHANNEL,
      conversationKey: CONVERSATION_KEY,
      dormantSince: DORMANT_SINCE,
      engagedSpeakerId: SPEAKER_ID,
    });

    expect(mockDb.update).toHaveBeenCalledWith(jaceSessions);
    const setCalls = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls;
    expect(setCalls[0]?.[0]).toMatchObject({
      engagementDormantSince: DORMANT_SINCE,
      engagedSpeakerId: SPEAKER_ID,
    });
    expect(setCalls[0]?.[0]?.updatedAt).toBeInstanceOf(Date);

    const whereArgs = (updateChain.where as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(renderCondition(whereArgs)).toEqual(
      renderCondition(
        and(
          eq(jaceSessions.channel, CHANNEL),
          eq(jaceSessions.conversationKey, CONVERSATION_KEY)
        )
      )
    );
  });

  it("clears both columns back to null", async () => {
    const updateChain = makeChain("where", undefined);
    mockDb.update = vi.fn(() => updateChain as ReturnType<typeof db.update>);

    await setThreadEngagement({
      channel: CHANNEL,
      conversationKey: CONVERSATION_KEY,
      dormantSince: null,
      engagedSpeakerId: null,
    });

    const setCalls = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls;
    expect(setCalls[0]?.[0]?.engagementDormantSince).toBeNull();
    expect(setCalls[0]?.[0]?.engagedSpeakerId).toBeNull();
  });

  it("is a silent no-op when no session matches (channel, conversationKey) — does not throw or insert", async () => {
    const updateChain = makeChain("where", undefined);
    mockDb.update = vi.fn(() => updateChain as ReturnType<typeof db.update>);

    await expect(
      setThreadEngagement({
        channel: CHANNEL,
        conversationKey: "no-such-conversation",
        dormantSince: DORMANT_SINCE,
        engagedSpeakerId: SPEAKER_ID,
      })
    ).resolves.toBeUndefined();

    // Only update was touched — never insert.
    expect(mockDb.update).toHaveBeenCalledTimes(1);
  });

  it("round-trips a Date and an id: the write shape setThreadEngagement sends is exactly what getThreadEngagement reads back", async () => {
    const updateChain = makeChain("where", undefined);
    mockDb.update = vi.fn(() => updateChain as ReturnType<typeof db.update>);

    await setThreadEngagement({
      channel: CHANNEL,
      conversationKey: CONVERSATION_KEY,
      dormantSince: DORMANT_SINCE,
      engagedSpeakerId: SPEAKER_ID,
    });

    const written = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];

    const selectChain = makeChain("limit", [
      {
        dormantSince: written.engagementDormantSince,
        engagedSpeakerId: written.engagedSpeakerId,
      },
    ]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await getThreadEngagement({
      channel: CHANNEL,
      conversationKey: CONVERSATION_KEY,
    });

    expect(result).toEqual({
      dormantSince: DORMANT_SINCE,
      engagedSpeakerId: SPEAKER_ID,
    });
  });
});
