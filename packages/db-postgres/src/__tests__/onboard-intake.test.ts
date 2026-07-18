import { createHash } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The db module is mocked so importing the query module is side-effect free and
// `enqueueOnboard` never touches a real Postgres. It makes exactly one db call:
//   insert → db.insert().values(v).onConflictDoNothing().returning() → rows
// `.values()` captures its argument for assertions, and `.returning()` resolves to
// a configurable array so a suite can drive both the "row inserted" (first connect)
// and the "no row → deduped" (reconnect) branches.
//
// vi.mock is hoisted above the file body, so the factory may not close over a
// top-level `let`. `vi.hoisted` gives us a mutable holder that IS hoisted with the
// mock, so the factory and the test body share the same object (the existing
// github-intake-v2 test uses a non-configurable inline factory; this one needs the
// returning() value to vary per test, hence the hoisted holder).
const mockState = vi.hoisted(() => ({
  // The array `.returning()` resolves to; each test sets it before calling.
  returning: [] as Array<{ id: string }>,
  // The object passed to `.values()` — captured for field assertions.
  capturedValues: undefined as Record<string, unknown> | undefined,
}));

vi.mock("../db.js", () => ({
  db: {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        mockState.capturedValues = v;
        return {
          onConflictDoNothing: () => ({
            returning: async () => mockState.returning,
          }),
        };
      },
    }),
  },
}));

import {
  enqueueOnboard,
  ONBOARD_EXTERNAL_ID_PREFIX,
} from "../queries/github_intake.js";

// ---------------------------------------------------------------------------
// Independent oracle for the deterministic row id. `entryId` / `uuid5Url` are
// PRIVATE in the source, so we re-derive the expected id with the same algorithm
// (uuid5 over the URL namespace) here — a divergence between this oracle and the
// source id computation fails the test rather than silently agreeing.
// ---------------------------------------------------------------------------
const NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

function uuid5Url(name: string): string {
  const ns = Buffer.from(NAMESPACE_URL.replace(/-/g, ""), "hex");
  const hash = createHash("sha1")
    .update(ns)
    .update(Buffer.from(name, "utf8"))
    .digest();
  const b = hash.subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x50; // version 5
  b[8] = (b[8]! & 0x3f) | 0x80; // variant
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** entryId(workspaceId, "github", `${ONBOARD_EXTERNAL_ID_PREFIX}${repoFullName}`) re-derived. */
function expectedOnboardId(workspaceId: string, repoFullName: string): string {
  return uuid5Url(
    `agentrail-queue:${workspaceId}:github:${ONBOARD_EXTERNAL_ID_PREFIX}${repoFullName}`
  );
}

describe("enqueueOnboard — one-shot onboard admission (kind='onboard')", () => {
  beforeEach(() => {
    mockState.returning = [];
    mockState.capturedValues = undefined;
  });

  it("enqueues onboard entry on first connect", async () => {
    mockState.returning = [{ id: "row-id" }]; // insert took a fresh row

    const result = await enqueueOnboard({
      workspaceId: "ws-1",
      repoFullName: "acme/widgets",
    });

    const id = expectedOnboardId("ws-1", "acme/widgets");
    expect(result).toEqual({
      enqueued: true,
      id,
      state: "queued",
      blockedBy: [],
    });

    // The persisted row carries the onboard-specific fields.
    expect(mockState.capturedValues).toMatchObject({
      kind: "onboard",
      source: "github",
      externalId: `${ONBOARD_EXTERNAL_ID_PREFIX}acme/widgets`,
      title: "Onboard acme/widgets",
      state: "queued",
      tier: 0,
      remainingBudget: 3,
      blockedBy: [],
    });
    // And the row id equals the deterministic id it returns.
    expect(mockState.capturedValues?.id).toBe(id);
  });

  it("dedups on reconnect", async () => {
    mockState.returning = []; // ON CONFLICT DO NOTHING → no row returned

    const result = await enqueueOnboard({
      workspaceId: "ws-1",
      repoFullName: "acme/widgets",
    });

    expect(result).toEqual({
      enqueued: false,
      reason: "already onboarded (deduped)",
    });
  });

  it("id is deterministic and unique per repo", async () => {
    mockState.returning = [{ id: "row-id" }];

    const a = await enqueueOnboard({
      workspaceId: "ws-1",
      repoFullName: "acme/widgets",
    });
    const b = await enqueueOnboard({
      workspaceId: "ws-1",
      repoFullName: "acme/widgets",
    });
    const c = await enqueueOnboard({
      workspaceId: "ws-1",
      repoFullName: "acme/other",
    });

    expect(a.enqueued).toBe(true);
    expect(b.enqueued).toBe(true);
    expect(c.enqueued).toBe(true);
    if (a.enqueued && b.enqueued && c.enqueued) {
      // Same {workspaceId, repoFullName} → same id (deterministic).
      expect(a.id).toBe(b.id);
      expect(a.id).toBe(expectedOnboardId("ws-1", "acme/widgets"));
      // A different repoFullName → a different id (unique per repo).
      expect(c.id).not.toBe(a.id);
    }
  });
});
