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
  setConnectorSecret,
  getConnectorSecret,
  getMcpConnectorKeys,
  validateConnectorUpdate,
  isConnectorProvider,
  MIN_POLL_INTERVAL_SECONDS,
  MAX_POLL_INTERVAL_SECONDS,
} from "../queries/connectors.js";
import { encryptSecret, isEncrypted } from "../crypto.js";

const mockDb = vi.mocked(db);

// Encryption key for the at-rest tests (no real AUTH_SECRET needed in CI).
process.env["CONNECTOR_SECRET_KEY"] = "test-connector-secret-key-abc123456789";

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
  it("accepts known providers (https + mcp + gateway catalog)", () => {
    expect(isConnectorProvider("github")).toBe(true);
    expect(isConnectorProvider("linear")).toBe(true);
    expect(isConnectorProvider("figma")).toBe(true);
    expect(isConnectorProvider("context7")).toBe(true);
    expect(isConnectorProvider("discord")).toBe(true);
    expect(isConnectorProvider("slack")).toBe(true);
    expect(isConnectorProvider("telegram")).toBe(true);
  });
  it("rejects unknown values", () => {
    expect(isConnectorProvider("jira")).toBe(false);
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
      hasSecret: false,
      updatedAt: "2026-06-16T12:00:00.000Z",
    });
    expect(rows[1]).toEqual({
      provider: "linear",
      enabled: false,
      config: { repos: [], triggerLabel: "ready-for-agent", pollIntervalSeconds: 60 },
      hasSecret: false,
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

describe("connector secret encryption at rest", () => {
  it("setConnectorSecret stores an ENCRYPTED value, never plaintext", async () => {
    mockDb.select.mockReturnValue(makeSelectLimitChain([]) as never);
    const insertChain = makeInsertChain();
    mockDb.insert.mockReturnValue(insertChain as never);

    await setConnectorSecret("ws-1", "context7", "ctx7sk-plaintext-key");

    const values = insertChain.values as ReturnType<typeof vi.fn>;
    const stored = (values.mock.calls[0][0] as { secret: string }).secret;
    expect(stored).not.toBe("ctx7sk-plaintext-key");
    expect(isEncrypted(stored)).toBe(true);
  });

  it("clearing the secret stores null (disconnect)", async () => {
    mockDb.select.mockReturnValue(makeSelectLimitChain([]) as never);
    const insertChain = makeInsertChain();
    mockDb.insert.mockReturnValue(insertChain as never);

    const view = await setConnectorSecret("ws-1", "context7", null);
    const values = insertChain.values as ReturnType<typeof vi.fn>;
    expect((values.mock.calls[0][0] as { secret: unknown }).secret).toBeNull();
    expect(view.hasSecret).toBe(false);
    expect(view.enabled).toBe(false);
  });

  it("getMcpConnectorKeys returns decrypted keys only for connected MCP providers", async () => {
    // getMcpConnectorKeys reads linear, figma, context7 in order (one select
    // each). linear + context7 are connected (ciphertext); figma is not (null).
    mockDb.select
      .mockReturnValueOnce(
        makeSelectLimitChain([{ secret: encryptSecret("lin_api_v") }]) as never
      )
      .mockReturnValueOnce(makeSelectLimitChain([{ secret: null }]) as never)
      .mockReturnValueOnce(
        makeSelectLimitChain([{ secret: encryptSecret("ctx7sk-v") }]) as never
      );

    const keys = await getMcpConnectorKeys("ws-1");
    // Only connected providers appear, decrypted; figma (no secret) is absent.
    expect(keys).toEqual({ linear: "lin_api_v", context7: "ctx7sk-v" });
  });

  it("getConnectorSecret decrypts the stored ciphertext back to plaintext", async () => {
    // First call: setConnectorSecret produces the ciphertext we then "store".
    mockDb.select.mockReturnValueOnce(makeSelectLimitChain([]) as never);
    const insertChain = makeInsertChain();
    mockDb.insert.mockReturnValue(insertChain as never);
    await setConnectorSecret("ws-1", "linear", "lin_api_secret_value");
    const values = insertChain.values as ReturnType<typeof vi.fn>;
    const ciphertext = (values.mock.calls[0][0] as { secret: string }).secret;

    // Now getConnectorSecret reads that ciphertext and must decrypt it.
    mockDb.select.mockReturnValue(
      makeSelectLimitChain([{ secret: ciphertext }]) as never
    );
    expect(await getConnectorSecret("ws-1", "linear")).toBe("lin_api_secret_value");
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
