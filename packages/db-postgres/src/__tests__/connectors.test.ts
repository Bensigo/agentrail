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
  getConnectors,
  getConnector,
  upsertConnector,
  validateConnectorUpdate,
  isConnectorProvider,
  MIN_POLL_INTERVAL_SECONDS,
  MAX_POLL_INTERVAL_SECONDS,
} from "../queries/connectors.js";

const mockDb = vi.mocked(db);

/** Chainable select mock whose terminal `orderBy` resolves the given rows. */
function makeSelectOrderChain(rows: unknown) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "from", "where"]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.orderBy = vi.fn(() => Promise.resolve(rows));
  return chain;
}

/** Chainable select mock whose terminal `limit` resolves the given rows. */
function makeSelectLimitChain(rows: unknown) {
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

describe("isConnectorProvider", () => {
  it("accepts known providers", () => {
    expect(isConnectorProvider("github")).toBe(true);
    expect(isConnectorProvider("linear")).toBe(true);
    expect(isConnectorProvider("discord")).toBe(true);
  });
  it("rejects unknown values", () => {
    expect(isConnectorProvider("slack")).toBe(false);
    expect(isConnectorProvider(42)).toBe(false);
    expect(isConnectorProvider(undefined)).toBe(false);
  });
});

describe("getConnectors", () => {
  it("returns [] when the workspace has no connectors", async () => {
    mockDb.select.mockReturnValue(makeSelectOrderChain([]) as never);
    expect(await getConnectors("ws-1")).toEqual([]);
  });

  it("projects rows, completing config and ISO-formatting updatedAt", async () => {
    const when = new Date("2026-06-16T12:00:00.000Z");
    mockDb.select.mockReturnValue(
      makeSelectOrderChain([
        {
          provider: "github",
          enabled: true,
          config: { repos: ["o/r"], triggerLabel: "afk", pollIntervalSeconds: 120 },
          updatedAt: when,
        },
        {
          // Partial stored config: completeConfig fills the missing keys.
          provider: "linear",
          enabled: false,
          config: { triggerLabel: "ready-for-agent" },
          updatedAt: null,
        },
      ]) as never
    );

    const rows = await getConnectors("ws-1");

    expect(rows[0]).toEqual({
      provider: "github",
      enabled: true,
      config: { repos: ["o/r"], triggerLabel: "afk", pollIntervalSeconds: 120 },
      updatedAt: "2026-06-16T12:00:00.000Z",
    });
    expect(rows[1]).toEqual({
      provider: "linear",
      enabled: false,
      config: { repos: [], triggerLabel: "ready-for-agent", pollIntervalSeconds: 60 },
      updatedAt: null,
    });
  });
});

describe("getConnector", () => {
  it("returns null when the provider isn't connected", async () => {
    mockDb.select.mockReturnValue(makeSelectLimitChain([]) as never);
    expect(await getConnector("ws-1", "github")).toBeNull();
  });
});

describe("upsertConnector", () => {
  it("creates an enabled row with defaults on first connect", async () => {
    // No existing row.
    mockDb.select.mockReturnValue(makeSelectLimitChain([]) as never);
    const insertChain = makeInsertChain();
    mockDb.insert.mockReturnValue(insertChain as never);

    const view = await upsertConnector("ws-1", "github");

    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    expect(insertChain.onConflictDoUpdate).toHaveBeenCalledTimes(1);
    expect(view.enabled).toBe(true);
    expect(view.config).toEqual({
      repos: [],
      triggerLabel: "ready-for-agent",
      pollIntervalSeconds: 60,
    });
  });

  it("seeds repos + enabled from the connect call", async () => {
    mockDb.select.mockReturnValue(makeSelectLimitChain([]) as never);
    const insertChain = makeInsertChain();
    mockDb.insert.mockReturnValue(insertChain as never);

    const view = await upsertConnector("ws-1", "github", {
      enabled: true,
      config: { repos: ["bensigo/agentrail"] },
    });

    expect(view.config.repos).toEqual(["bensigo/agentrail"]);
    expect(view.config.triggerLabel).toBe("ready-for-agent");
  });

  it("merges config key-by-key over the stored row, preserving other keys", async () => {
    // Existing row has repos + custom label; we only change the interval.
    mockDb.select.mockReturnValue(
      makeSelectLimitChain([
        {
          provider: "github",
          enabled: true,
          config: { repos: ["o/r"], triggerLabel: "afk", pollIntervalSeconds: 60 },
          updatedAt: new Date("2026-06-16T00:00:00.000Z"),
        },
      ]) as never
    );
    const insertChain = makeInsertChain();
    mockDb.insert.mockReturnValue(insertChain as never);

    const view = await upsertConnector("ws-1", "github", {
      config: { pollIntervalSeconds: 300 },
    });

    expect(view.config).toEqual({
      repos: ["o/r"],
      triggerLabel: "afk",
      pollIntervalSeconds: 300,
    });
    // enabled preserved from the existing row when not provided.
    expect(view.enabled).toBe(true);
  });

  it("can disable a connected connector without touching config", async () => {
    mockDb.select.mockReturnValue(
      makeSelectLimitChain([
        {
          provider: "discord",
          enabled: true,
          config: { repos: [], triggerLabel: "ready-for-agent", pollIntervalSeconds: 60 },
          updatedAt: new Date("2026-06-16T00:00:00.000Z"),
        },
      ]) as never
    );
    mockDb.insert.mockReturnValue(makeInsertChain() as never);

    const view = await upsertConnector("ws-1", "discord", { enabled: false });
    expect(view.enabled).toBe(false);
  });
});

describe("validateConnectorUpdate", () => {
  it("accepts a valid full update and trims label + repos", () => {
    const r = validateConnectorUpdate({
      enabled: true,
      config: {
        pollIntervalSeconds: 90,
        triggerLabel: "  ready-for-agent  ",
        repos: [" o/r ", "", "a/b"],
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        enabled: true,
        config: {
          pollIntervalSeconds: 90,
          triggerLabel: "ready-for-agent",
          repos: ["o/r", "a/b"],
        },
      });
    }
  });

  it("accepts a partial update (only enabled)", () => {
    const r = validateConnectorUpdate({ enabled: false });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ enabled: false });
  });

  it("rejects a non-boolean enabled", () => {
    expect(
      validateConnectorUpdate({ enabled: "yes" as unknown as boolean }).ok
    ).toBe(false);
  });

  it("rejects a non-integer interval", () => {
    expect(
      validateConnectorUpdate({ config: { pollIntervalSeconds: 12.5 } }).ok
    ).toBe(false);
  });

  it("rejects an interval out of bounds", () => {
    expect(
      validateConnectorUpdate({
        config: { pollIntervalSeconds: MIN_POLL_INTERVAL_SECONDS - 1 },
      }).ok
    ).toBe(false);
    expect(
      validateConnectorUpdate({
        config: { pollIntervalSeconds: MAX_POLL_INTERVAL_SECONDS + 1 },
      }).ok
    ).toBe(false);
  });

  it("rejects an empty / whitespace label", () => {
    expect(
      validateConnectorUpdate({ config: { triggerLabel: "   " } }).ok
    ).toBe(false);
  });

  it("rejects a label over 50 characters", () => {
    expect(
      validateConnectorUpdate({ config: { triggerLabel: "x".repeat(51) } }).ok
    ).toBe(false);
  });

  it("rejects repos that aren't an array of strings", () => {
    expect(
      validateConnectorUpdate({
        config: { repos: [1, 2] as unknown as string[] },
      }).ok
    ).toBe(false);
  });
});
