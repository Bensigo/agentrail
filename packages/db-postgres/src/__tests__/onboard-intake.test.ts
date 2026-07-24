import { createHash } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The db module is mocked so importing the query module is side-effect free and
// `enqueueOnboard` never touches a real Postgres. The plain (non-force) path makes
// exactly one db call:
//   insert → db.insert().values(v).onConflictDoNothing().returning() → rows
// `.values()` captures its argument for assertions, and `.returning()` resolves to
// a configurable array so a suite can drive both the "row inserted" (first connect)
// and the "no row → deduped" (reconnect) branches.
//
// A FORCED call that hits the dedupe makes a SECOND db call — the conditional
// re-arm `db.execute(sql\`UPDATE ... RETURNING id\`)` — so the mock also stubs
// `execute`, resolving to a configurable `executeResult` and capturing the query
// for param assertions via `extractSqlParams` (the same drizzle-SQL-introspection
// idiom `github-intake-park-reason.test.ts` / `github-intake-alignment-gate.test.ts`
// already established elsewhere in this package).
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
  // The array `db.execute(...)` resolves to (the force re-arm UPDATE's RETURNING).
  executeResult: [] as Array<{ id: string }>,
  // Every query passed to `db.execute(...)`, in call order.
  executeCalls: [] as unknown[],
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
    execute: async (query: unknown) => {
      mockState.executeCalls.push(query);
      return mockState.executeResult;
    },
  },
}));

import {
  enqueueOnboard,
  ONBOARD_EXTERNAL_ID_PREFIX,
  ONBOARD_FORCE_BODY,
  ONBOARD_ALREADY_PENDING_REASON,
} from "../queries/github_intake.js";

/** Extracts the bound (non-literal-array) template values off a drizzle `sql`
 * query, in template order — mirrors `github-intake-park-reason.test.ts`'s
 * identically-named helper (each test file in this package keeps its own
 * copy rather than sharing one across files). */
function extractSqlParams(query: unknown): unknown[] {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks ?? [];
  return chunks.filter(
    (c) => !(c && typeof c === "object" && Array.isArray((c as { value?: unknown[] }).value))
  );
}

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
    mockState.executeResult = [];
    mockState.executeCalls = [];
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
    // Non-force: body stays "" (byte-identical to pre-force behavior).
    expect(mockState.capturedValues?.body).toBe("");
    // And no force re-arm round trip ever happens on the plain insert path.
    expect(mockState.executeCalls).toHaveLength(0);
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
    // Non-force dedupe never attempts the force re-arm round trip.
    expect(mockState.executeCalls).toHaveLength(0);
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

describe("enqueueOnboard — force re-arm (console 'Recompile' button, spec §4.5)", () => {
  beforeEach(() => {
    mockState.returning = [];
    mockState.capturedValues = undefined;
    mockState.executeResult = [];
    mockState.executeCalls = [];
  });

  it("force + no prior row: takes the plain insert path, stamps the force marker, never touches execute", async () => {
    mockState.returning = [{ id: "row-id" }]; // a genuinely fresh insert

    const result = await enqueueOnboard({
      workspaceId: "ws-1",
      repoFullName: "acme/widgets",
      force: true,
    });

    const id = expectedOnboardId("ws-1", "acme/widgets");
    expect(result).toEqual({ enqueued: true, id, state: "queued", blockedBy: [] });
    // Even on a fresh insert, force stamps the marker (harmless — a fresh
    // repo has no prior freshness record for it to bypass anyway; keeping
    // the stamp unconditional on `force` is simpler than conditioning on
    // insert-vs-rearm).
    expect(mockState.capturedValues?.body).toBe(ONBOARD_FORCE_BODY);
    expect(mockState.executeCalls).toHaveLength(0);
  });

  it("force + an existing TERMINAL row: re-arms it to queued via the conditional UPDATE", async () => {
    mockState.returning = []; // INSERT conflicts — a row already exists
    mockState.executeResult = [{ id: "row-id" }]; // UPDATE matched (row was terminal)

    const result = await enqueueOnboard({
      workspaceId: "ws-1",
      repoFullName: "acme/widgets",
      force: true,
    });

    const id = expectedOnboardId("ws-1", "acme/widgets");
    expect(result).toEqual({ enqueued: true, id, state: "queued", blockedBy: [] });
    expect(mockState.executeCalls).toHaveLength(1);

    // The UPDATE's bound params, in template order: body marker, then id.
    const params = extractSqlParams(mockState.executeCalls[0]);
    expect(params).toContain(ONBOARD_FORCE_BODY);
    expect(params).toContain(id);
  });

  it("force + an existing ACTIVE (queued/running) row: reports already_pending, never fabricates queued", async () => {
    mockState.returning = []; // INSERT conflicts — a row already exists
    mockState.executeResult = []; // UPDATE matched NOTHING (state IN queued/running)

    const result = await enqueueOnboard({
      workspaceId: "ws-1",
      repoFullName: "acme/widgets",
      force: true,
    });

    expect(result).toEqual({
      enqueued: false,
      reason: ONBOARD_ALREADY_PENDING_REASON,
    });
  });

  it("non-force dedupe never attempts the force re-arm, even though force-rearm mock data is primed", async () => {
    mockState.returning = []; // INSERT conflicts
    mockState.executeResult = [{ id: "row-id" }]; // would succeed IF called — must not be

    const result = await enqueueOnboard({
      workspaceId: "ws-1",
      repoFullName: "acme/widgets",
      // force omitted
    });

    expect(result).toEqual({
      enqueued: false,
      reason: "already onboarded (deduped)",
    });
    expect(mockState.executeCalls).toHaveLength(0);
  });
});
