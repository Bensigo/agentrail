import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the db module before importing queries.
vi.mock("../db.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
}));

import { db } from "../db.js";
import {
  getHeartbeatConfig,
  setHeartbeatConfig,
  validateHeartbeatConfigUpdate,
  MIN_POLL_INTERVAL_SECONDS,
  MAX_POLL_INTERVAL_SECONDS,
} from "../queries/heartbeat-config.js";

const mockDb = vi.mocked(db);

/** Chainable select mock whose terminal `limit` resolves the given rows. */
function makeSelectChain(rows: unknown) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "from", "where"]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.limit = vi.fn(() => Promise.resolve(rows));
  return chain;
}

/** Chainable insert mock whose terminal `onConflictDoUpdate` resolves. */
function makeInsertChain() {
  const chain: Record<string, unknown> = {};
  chain.insert = vi.fn(() => chain);
  chain.values = vi.fn(() => chain);
  chain.onConflictDoUpdate = vi.fn(() => Promise.resolve(undefined));
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getHeartbeatConfig", () => {
  it("returns defaults (disabled, 60s, ready-for-agent) when no row exists", async () => {
    mockDb.select.mockReturnValue(makeSelectChain([]) as never);

    const cfg = await getHeartbeatConfig("ws-1");

    expect(cfg).toEqual({
      enabled: false,
      pollIntervalSeconds: 60,
      triggerLabel: "ready-for-agent",
      updatedAt: null,
    });
  });

  it("projects the stored row, ISO-formatting updatedAt", async () => {
    const when = new Date("2026-06-16T12:00:00.000Z");
    mockDb.select.mockReturnValue(
      makeSelectChain([
        {
          workspaceId: "ws-1",
          enabled: true,
          pollIntervalSeconds: 120,
          triggerLabel: "afk",
          updatedAt: when,
        },
      ]) as never
    );

    const cfg = await getHeartbeatConfig("ws-1");

    expect(cfg).toEqual({
      enabled: true,
      pollIntervalSeconds: 120,
      triggerLabel: "afk",
      updatedAt: "2026-06-16T12:00:00.000Z",
    });
  });
});

describe("setHeartbeatConfig", () => {
  it("upserts the provided fields and reads back the new view", async () => {
    const insertChain = makeInsertChain();
    mockDb.insert.mockReturnValue(insertChain as never);
    // The read-back after the upsert.
    mockDb.select.mockReturnValue(
      makeSelectChain([
        {
          workspaceId: "ws-1",
          enabled: true,
          pollIntervalSeconds: 30,
          triggerLabel: "ready-for-agent",
          updatedAt: new Date("2026-06-16T00:00:00.000Z"),
        },
      ]) as never
    );

    const cfg = await setHeartbeatConfig("ws-1", {
      enabled: true,
      pollIntervalSeconds: 30,
    });

    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    expect(insertChain.onConflictDoUpdate).toHaveBeenCalledTimes(1);
    expect(cfg.enabled).toBe(true);
    expect(cfg.pollIntervalSeconds).toBe(30);
  });
});

describe("validateHeartbeatConfigUpdate", () => {
  it("accepts a valid full update and trims the label", () => {
    const r = validateHeartbeatConfigUpdate({
      enabled: true,
      pollIntervalSeconds: 90,
      triggerLabel: "  ready-for-agent  ",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        enabled: true,
        pollIntervalSeconds: 90,
        triggerLabel: "ready-for-agent",
      });
    }
  });

  it("accepts a partial update (only enabled)", () => {
    const r = validateHeartbeatConfigUpdate({ enabled: false });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ enabled: false });
  });

  it("rejects a non-boolean enabled", () => {
    const r = validateHeartbeatConfigUpdate({
      enabled: "yes" as unknown as boolean,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a non-integer interval", () => {
    const r = validateHeartbeatConfigUpdate({ pollIntervalSeconds: 12.5 });
    expect(r.ok).toBe(false);
  });

  it("rejects an interval below the minimum", () => {
    const r = validateHeartbeatConfigUpdate({
      pollIntervalSeconds: MIN_POLL_INTERVAL_SECONDS - 1,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects an interval above the maximum", () => {
    const r = validateHeartbeatConfigUpdate({
      pollIntervalSeconds: MAX_POLL_INTERVAL_SECONDS + 1,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects an empty / whitespace label", () => {
    expect(validateHeartbeatConfigUpdate({ triggerLabel: "   " }).ok).toBe(
      false
    );
  });

  it("rejects a label over 50 characters", () => {
    const r = validateHeartbeatConfigUpdate({ triggerLabel: "x".repeat(51) });
    expect(r.ok).toBe(false);
  });
});
