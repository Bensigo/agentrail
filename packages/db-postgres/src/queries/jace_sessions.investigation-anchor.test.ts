import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// Mocked db chain — mirrors `jace_sessions.brief-anchor.test.ts` exactly
// (same "mock the chain, control the terminal value" idiom; there is no
// live-DB harness in this package).
vi.mock("../db.js", () => ({
  db: {
    update: vi.fn(),
    select: vi.fn(),
  },
}));

import { db } from "../db.js";
import { jaceSessions } from "../schema/jace_sessions.js";
import {
  setSessionInvestigationAnchor,
  clearSessionInvestigationAnchor,
  getSessionInvestigationAnchor,
} from "./jace_sessions.js";

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

const SESSION_ID = "session-1";
const INVESTIGATION_ID = "inv-1";
const OTHER_INVESTIGATION_ID = "inv-2";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("setSessionInvestigationAnchor", () => {
  it("updates jace_sessions and returns true on the happy path", async () => {
    const updateChain = makeChain("returning", [{ id: SESSION_ID }]);
    mockDb.update = vi.fn(() => updateChain as ReturnType<typeof db.update>);

    const result = await setSessionInvestigationAnchor(SESSION_ID, INVESTIGATION_ID);

    expect(result).toBe(true);
    expect(mockDb.update).toHaveBeenCalledWith(jaceSessions);
    const setCalls = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls;
    expect(setCalls[0]?.[0]).toMatchObject({ anchoredInvestigationId: INVESTIGATION_ID });
    expect(setCalls[0]?.[0]?.updatedAt).toBeInstanceOf(Date);
    // Must not disturb the table's OWN (tenant) anchor pair, or the brief anchor.
    expect(setCalls[0]?.[0]).not.toHaveProperty("workspaceId");
    expect(setCalls[0]?.[0]).not.toHaveProperty("chatIdentityId");
    expect(setCalls[0]?.[0]).not.toHaveProperty("anchoredBriefId");

    const whereArgs = (updateChain.where as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(renderCondition(whereArgs)).toEqual(renderCondition(eq(jaceSessions.id, SESSION_ID)));
  });

  it("is idempotent: setting the same investigation id twice succeeds both times with the same write shape", async () => {
    const firstChain = makeChain("returning", [{ id: SESSION_ID }]);
    const secondChain = makeChain("returning", [{ id: SESSION_ID }]);
    mockDb.update = vi
      .fn()
      .mockReturnValueOnce(firstChain as ReturnType<typeof db.update>)
      .mockReturnValueOnce(secondChain as ReturnType<typeof db.update>);

    const first = await setSessionInvestigationAnchor(SESSION_ID, INVESTIGATION_ID);
    const second = await setSessionInvestigationAnchor(SESSION_ID, INVESTIGATION_ID);

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect((firstChain.set as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.anchoredInvestigationId).toBe(
      INVESTIGATION_ID
    );
    expect((secondChain.set as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.anchoredInvestigationId).toBe(
      INVESTIGATION_ID
    );
  });

  it("re-setting to a DIFFERENT investigation id overwrites the anchor rather than merging", async () => {
    const updateChain = makeChain("returning", [{ id: SESSION_ID }]);
    mockDb.update = vi.fn(() => updateChain as ReturnType<typeof db.update>);

    await setSessionInvestigationAnchor(SESSION_ID, OTHER_INVESTIGATION_ID);

    const setCalls = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls;
    expect(setCalls[0]?.[0]?.anchoredInvestigationId).toBe(OTHER_INVESTIGATION_ID);
  });

  it("returns false when no session matches sessionId", async () => {
    const updateChain = makeChain("returning", []);
    mockDb.update = vi.fn(() => updateChain as ReturnType<typeof db.update>);

    const result = await setSessionInvestigationAnchor("does-not-exist", INVESTIGATION_ID);

    expect(result).toBe(false);
  });
});

describe("clearSessionInvestigationAnchor", () => {
  it("nulls the anchor and returns true", async () => {
    const updateChain = makeChain("returning", [{ id: SESSION_ID }]);
    mockDb.update = vi.fn(() => updateChain as ReturnType<typeof db.update>);

    const result = await clearSessionInvestigationAnchor(SESSION_ID);

    expect(result).toBe(true);
    const setCalls = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls;
    expect(setCalls[0]?.[0]?.anchoredInvestigationId).toBeNull();
    expect(setCalls[0]?.[0]).not.toHaveProperty("workspaceId");
    expect(setCalls[0]?.[0]).not.toHaveProperty("chatIdentityId");
  });

  it("clearing an already-clear anchor is a harmless idempotent no-op", async () => {
    const firstChain = makeChain("returning", [{ id: SESSION_ID }]);
    const secondChain = makeChain("returning", [{ id: SESSION_ID }]);
    mockDb.update = vi
      .fn()
      .mockReturnValueOnce(firstChain as ReturnType<typeof db.update>)
      .mockReturnValueOnce(secondChain as ReturnType<typeof db.update>);

    const first = await clearSessionInvestigationAnchor(SESSION_ID);
    const second = await clearSessionInvestigationAnchor(SESSION_ID);

    expect(first).toBe(true);
    expect(second).toBe(true);
  });

  it("returns false when no session matches sessionId", async () => {
    const updateChain = makeChain("returning", []);
    mockDb.update = vi.fn(() => updateChain as ReturnType<typeof db.update>);

    const result = await clearSessionInvestigationAnchor("does-not-exist");

    expect(result).toBe(false);
  });
});

describe("getSessionInvestigationAnchor", () => {
  it("returns the anchored investigation id when one is set", async () => {
    const selectChain = makeChain("limit", [{ anchoredInvestigationId: INVESTIGATION_ID }]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await getSessionInvestigationAnchor(SESSION_ID);

    expect(result).toBe(INVESTIGATION_ID);
    expect(mockDb.select).toHaveBeenCalled();
    const whereArgs = (selectChain.where as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(renderCondition(whereArgs)).toEqual(renderCondition(eq(jaceSessions.id, SESSION_ID)));
  });

  it("returns null when the session has never had an anchor set", async () => {
    const selectChain = makeChain("limit", [{ anchoredInvestigationId: null }]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await getSessionInvestigationAnchor(SESSION_ID);

    expect(result).toBeNull();
  });

  it("returns null after the anchor was explicitly cleared", async () => {
    const selectChain = makeChain("limit", [{ anchoredInvestigationId: null }]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await getSessionInvestigationAnchor(SESSION_ID);

    expect(result).toBeNull();
  });

  it("returns null when the anchored investigation was deleted (ON DELETE SET NULL already ran at the DB level — this just reads the resulting null)", async () => {
    const selectChain = makeChain("limit", [{ anchoredInvestigationId: null }]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await getSessionInvestigationAnchor(SESSION_ID);

    expect(result).toBeNull();
  });

  it("returns null when sessionId matches no row at all", async () => {
    const selectChain = makeChain("limit", []);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await getSessionInvestigationAnchor("does-not-exist");

    expect(result).toBeNull();
  });
});
