import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * `selfHealFleetKey` mirrors `setMergePermission`'s test idiom exactly (see
 * `workspace_grants.test.ts`): there is no live-DB harness in this package,
 * so `db.transaction` is mocked to run its callback against the same mock
 * `db`, capturing statement order/arguments and letting an injected error
 * propagate the way a real Postgres abort would. `select` is queue-based
 * (each terminal `.limit()` call pops the next scripted row-set, in the
 * exact order the function under test issues its reads) because — unlike
 * `setMergePermission`, which has one select shape — this function makes
 * THREE distinct reads (workspace, last rotation, active key) that must each
 * see a different scripted answer.
 *
 * `listStalledHostedWorkspaces` is a single raw `db.execute(sql...)` call,
 * so it only needs `mockState.executeResult` — no transaction, no queue.
 */

const mockState = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  updateCalls: [] as { table: unknown; set: unknown; where: unknown }[],
  insertCalls: [] as { table: unknown; values: unknown }[],
  insertReturningQueue: [] as unknown[][],
  insertError: undefined as (Error & { code?: string; cause?: { code?: string } }) | undefined,
  executeResult: [] as unknown[],
}));

vi.mock("../db.js", () => {
  function selectTerminal() {
    return Promise.resolve(mockState.selectQueue.shift() ?? []);
  }
  function makeSelectChain() {
    return {
      from: () => ({
        where: () => ({
          limit: () => selectTerminal(),
          orderBy: () => ({
            limit: () => selectTerminal(),
          }),
        }),
      }),
    };
  }
  const db = {
    transaction: async (cb: (tx: unknown) => unknown) => cb(db),
    select: () => makeSelectChain(),
    update: (table: unknown) => ({
      set: (set: unknown) => ({
        where: async (where: unknown) => {
          mockState.updateCalls.push({ table, set, where });
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: unknown) => ({
        returning: async () => {
          mockState.insertCalls.push({ table, values });
          if (mockState.insertError) throw mockState.insertError;
          return mockState.insertReturningQueue.shift() ?? [];
        },
      }),
    }),
    execute: async () => mockState.executeResult,
  };
  return { db };
});

import { apiKeys } from "../schema/api_keys.js";
import { fleetKeyRotations } from "../schema/fleet_key_rotations.js";
import {
  selfHealFleetKey,
  listStalledHostedWorkspaces,
  STALLED_WORKSPACE_DEFAULT_STALE_MINUTES,
} from "./index.js";

const dialect = new PgDialect();
function renderCondition(condition: unknown) {
  return dialect.sqlToQuery(condition as Parameters<typeof dialect.sqlToQuery>[0]);
}

const NOW = new Date("2026-07-25T00:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockState.selectQueue = [];
  mockState.updateCalls = [];
  mockState.insertCalls = [];
  mockState.insertReturningQueue = [];
  mockState.insertError = undefined;
  mockState.executeResult = [];
});

afterEach(() => {
  vi.useRealTimers();
});

const HOSTED_WORKSPACE = { id: "ws-1", slug: "acme", hostedExecution: true };

describe("selfHealFleetKey — guards", () => {
  it("returns not_found when the workspace doesn't resolve", async () => {
    mockState.selectQueue = [[]]; // workspace lookup: no rows

    const result = await selfHealFleetKey({
      workspaceId: "ws-missing",
      fleetInstanceId: "fleet-1",
      cooldownSeconds: 60,
    });

    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(mockState.insertCalls).toEqual([]);
  });

  it("returns not_hosted when hosted_execution is false — never resurrects a key the operator turned off", async () => {
    mockState.selectQueue = [[{ ...HOSTED_WORKSPACE, hostedExecution: false }]];

    const result = await selfHealFleetKey({
      workspaceId: "ws-1",
      fleetInstanceId: "fleet-1",
      cooldownSeconds: 60,
    });

    expect(result).toEqual({ ok: false, reason: "not_hosted" });
    expect(mockState.insertCalls).toEqual([]);
  });

  it("returns cooldown with retryAfterSeconds when the last rotation is still within the window", async () => {
    const rotatedAt = new Date(NOW.getTime() - 20_000); // 20s ago
    mockState.selectQueue = [
      [HOSTED_WORKSPACE], // workspace lookup
      [{ createdAt: rotatedAt }], // last rotation lookup
    ];

    const result = await selfHealFleetKey({
      workspaceId: "ws-1",
      fleetInstanceId: "fleet-1",
      cooldownSeconds: 60,
    });

    expect(result).toEqual({ ok: false, reason: "cooldown", retryAfterSeconds: 40 });
    // Never reaches the transaction — no revoke, no mint.
    expect(mockState.insertCalls).toEqual([]);
    expect(mockState.updateCalls).toEqual([]);
  });

  it("proceeds past the cooldown once the window has fully elapsed", async () => {
    const rotatedAt = new Date(NOW.getTime() - 61_000); // 61s ago, cooldown=60
    mockState.selectQueue = [
      [HOSTED_WORKSPACE],
      [{ createdAt: rotatedAt }],
      [], // active key lookup inside the transaction: none active
    ];
    mockState.insertReturningQueue = [[{ id: "key-new" }], [{ id: "rot-1" }]];

    const result = await selfHealFleetKey({
      workspaceId: "ws-1",
      fleetInstanceId: "fleet-1",
      cooldownSeconds: 60,
    });

    expect(result.ok).toBe(true);
  });

  it("proceeds immediately when there is no prior rotation at all (first self-heal for this workspace)", async () => {
    mockState.selectQueue = [
      [HOSTED_WORKSPACE],
      [], // no prior rotation
      [], // no active key
    ];
    mockState.insertReturningQueue = [[{ id: "key-new" }], [{ id: "rot-1" }]];

    const result = await selfHealFleetKey({
      workspaceId: "ws-1",
      fleetInstanceId: "fleet-1",
      cooldownSeconds: 60,
    });

    expect(result.ok).toBe(true);
  });
});

describe("selfHealFleetKey — rotation: revokes exactly the old key and mints one", () => {
  it("revokes the CURRENT active fleet key, scoped to its own id, then mints a fresh one", async () => {
    mockState.selectQueue = [
      [HOSTED_WORKSPACE],
      [], // no prior rotation -> no cooldown
      [{ id: "key-old" }], // the active key to revoke
    ];
    mockState.insertReturningQueue = [[{ id: "key-new" }], [{ id: "rot-1" }]];

    const result = await selfHealFleetKey({
      workspaceId: "ws-1",
      fleetInstanceId: "fleet-host-abc",
      cooldownSeconds: 60,
    });

    expect(mockState.updateCalls).toHaveLength(1);
    expect(mockState.updateCalls[0]!.table).toBe(apiKeys);
    expect(mockState.updateCalls[0]!.set).toEqual({ revokedAt: NOW });
    expect(renderCondition(mockState.updateCalls[0]!.where)).toEqual(
      renderCondition(eq(apiKeys.id, "key-old"))
    );

    expect(mockState.insertCalls).toHaveLength(2);
    expect(mockState.insertCalls[0]!.table).toBe(apiKeys);
    const mintValues = mockState.insertCalls[0]!.values as Record<string, unknown>;
    expect(mintValues.workspaceId).toBe("ws-1");
    expect(mintValues.kind).toBe("fleet");
    expect(mintValues.name).toBe("Hosted fleet");
    expect(typeof mintValues.keyHash).toBe("string");
    expect((mintValues.keyHash as string).length).toBe(64); // sha256 hex

    expect(mockState.insertCalls[1]!.table).toBe(fleetKeyRotations);
    expect(mockState.insertCalls[1]!.values).toEqual({
      workspaceId: "ws-1",
      fleetInstanceId: "fleet-host-abc",
      oldKeyId: "key-old",
      newKeyId: "key-new",
    });

    expect(result).toEqual({
      ok: true,
      workspaceId: "ws-1",
      slug: "acme",
      token: expect.stringMatching(/^ar_[0-9a-f]{64}$/),
      keyId: "key-new",
    });
  });

  it("mints without a revoke when there was no active fleet key (nothing to revoke, still records the rotation)", async () => {
    mockState.selectQueue = [[HOSTED_WORKSPACE], [], []];
    mockState.insertReturningQueue = [[{ id: "key-new" }], [{ id: "rot-1" }]];

    await selfHealFleetKey({
      workspaceId: "ws-1",
      fleetInstanceId: "fleet-host-abc",
      cooldownSeconds: 60,
    });

    expect(mockState.updateCalls).toEqual([]);
    expect(mockState.insertCalls[1]!.values).toEqual({
      workspaceId: "ws-1",
      fleetInstanceId: "fleet-host-abc",
      oldKeyId: null,
      newKeyId: "key-new",
    });
  });

  it("the returned token hashes to the exact keyHash persisted on the mint insert", async () => {
    mockState.selectQueue = [[HOSTED_WORKSPACE], [], []];
    mockState.insertReturningQueue = [[{ id: "key-new" }], [{ id: "rot-1" }]];

    const result = await selfHealFleetKey({
      workspaceId: "ws-1",
      fleetInstanceId: "fleet-1",
      cooldownSeconds: 60,
    });

    const { createHash } = await import("crypto");
    const mintValues = mockState.insertCalls[0]!.values as { keyHash: string };
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(createHash("sha256").update(result.token).digest("hex")).toBe(mintValues.keyHash);
    }
  });
});

describe("selfHealFleetKey — idempotency: a concurrent-rotation race never 500s", () => {
  it("treats a unique-violation (err.code 23505) on mint as a cooldown-shaped refusal, not a thrown error", async () => {
    mockState.selectQueue = [[HOSTED_WORKSPACE], [], []];
    mockState.insertError = Object.assign(new Error("duplicate key"), { code: "23505" });

    const result = await selfHealFleetKey({
      workspaceId: "ws-1",
      fleetInstanceId: "fleet-1",
      cooldownSeconds: 60,
    });

    expect(result).toEqual({ ok: false, reason: "cooldown", retryAfterSeconds: 60 });
  });

  it("treats a DRIZZLE-WRAPPED unique-violation (err.cause.code 23505) the same way", async () => {
    mockState.selectQueue = [[HOSTED_WORKSPACE], [], []];
    mockState.insertError = Object.assign(new Error("failed query"), {
      cause: { code: "23505" },
    });

    const result = await selfHealFleetKey({
      workspaceId: "ws-1",
      fleetInstanceId: "fleet-1",
      cooldownSeconds: 60,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("cooldown");
  });

  it("a non-unique-violation error propagates (a genuine DB failure is not swallowed)", async () => {
    mockState.selectQueue = [[HOSTED_WORKSPACE], [], []];
    mockState.insertError = new Error("connection reset");

    await expect(
      selfHealFleetKey({ workspaceId: "ws-1", fleetInstanceId: "fleet-1", cooldownSeconds: 60 })
    ).rejects.toThrow("connection reset");
  });
});

describe("listStalledHostedWorkspaces", () => {
  it("maps raw snake_case execute() rows to the camelCase result shape", async () => {
    mockState.executeResult = [
      { workspace_id: "ws-stuck", slug: "stuck-co", stale_queued_count: "3", oldest_queued_minutes: "42" },
    ];

    const result = await listStalledHostedWorkspaces();

    expect(result).toEqual([
      { workspaceId: "ws-stuck", slug: "stuck-co", staleQueuedCount: 3, oldestQueuedMinutes: 42 },
    ]);
  });

  it("returns [] when nothing is stalled", async () => {
    mockState.executeResult = [];

    await expect(listStalledHostedWorkspaces()).resolves.toEqual([]);
  });

  it("exports a default staleness window of 15 minutes", () => {
    expect(STALLED_WORKSPACE_DEFAULT_STALE_MINUTES).toBe(15);
  });
});
