import { beforeEach, describe, expect, it, vi } from "vitest";

// db mocked so importing the query module never touches a real Postgres.
// mintApiKey's only DB call is insert(apiKeys).values({...}).returning() —
// `.values(...)` is captured for the structural assertion below (the ONE
// thing #1267 PR ① changes: an optional `kind`, defaulted to 'self_hosted').
const mockState = vi.hoisted(() => ({
  capturedValues: undefined as Record<string, unknown> | undefined,
  returnedRow: { id: "key-1" } as { id: string },
}));

vi.mock("../db.js", () => ({
  db: {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        mockState.capturedValues = v;
        return {
          returning: async () => [mockState.returnedRow],
        };
      },
    }),
  },
}));

import { mintApiKey } from "../queries/runner.js";

beforeEach(() => {
  mockState.capturedValues = undefined;
  mockState.returnedRow = { id: "key-1" };
});

describe("mintApiKey — optional `kind`, defaulted to 'self_hosted' (#1267 PR ①)", () => {
  it("defaults kind to 'self_hosted' when the caller omits it (existing callers byte-stable)", async () => {
    await mintApiKey({ workspaceId: "ws-1", name: "Self-hosted runner" });

    expect(mockState.capturedValues?.kind).toBe("self_hosted");
  });

  it("passes kind: 'fleet' through untouched when the caller supplies it", async () => {
    await mintApiKey({ workspaceId: "ws-1", name: "Hosted fleet", kind: "fleet" });

    expect(mockState.capturedValues?.kind).toBe("fleet");
  });

  it("still returns {id, rawKey, keyPrefix} — the return shape is unchanged by the new param", async () => {
    mockState.returnedRow = { id: "key-42" };

    const result = await mintApiKey({ workspaceId: "ws-1", name: "Hosted fleet", kind: "fleet" });

    expect(result.id).toBe("key-42");
    expect(result.rawKey).toMatch(/^ar_[0-9a-f]{64}$/);
    expect(result.keyPrefix).toBe(`ar_${result.rawKey.slice(3, 11)}`);
  });

  it("the raw key is never part of the captured insert values (only its hash/prefix are persisted)", async () => {
    const result = await mintApiKey({ workspaceId: "ws-1", name: "Hosted fleet", kind: "fleet" });

    const values = mockState.capturedValues!;
    expect(Object.values(values)).not.toContain(result.rawKey);
    expect(values.keyHash).not.toBe(result.rawKey);
  });
});
