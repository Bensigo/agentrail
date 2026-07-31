import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * OAuth Connect Wave 3, W3-T3 fix round (coordinator ruling on the
 * state-round-trip finding — `.superpowers/sdd/task-W3T3-report.md`) —
 * `clearPendingConnectorOauthStatesForUser`/
 * `consumeConnectorOauthStateBySessionUser` (`connectors.ts`).
 *
 * A SEPARATE file from `connectors.test.ts` deliberately: that file's own
 * `vi.mock("../db.js", ...)` is the minimal `{ insert: vi.fn(), update:
 * vi.fn() }` shape `mintConnectorOauthState`/`consumeConnectorOauthState`'s
 * fluent-builder calls need — these two NEW functions use raw
 * `db.execute(sql\`...\`)`/`db.transaction(async (tx) => ...)` instead (see
 * `connectors.ts`'s own doc-comment on both for why: no single-row WHERE
 * key exists to pin a fluent `.update().where()` to when the lookup is by
 * `(provider, userId)` rather than a unique `state` token). Mirrors
 * `wiki.test.ts`'s own `db.execute`-dispatch-by-rendered-SQL-text mock
 * style (`transaction: async (cb) => cb(db)` — a mock `tx` IS just `db`
 * again, same reasoning that file's own doc-comment gives) rather than
 * retrofitting `connectors.test.ts`'s simpler mock.
 *
 * These are SQL-SHAPE and BRANCHING-LOGIC proofs (mocked, no real
 * concurrency) — the actual ATOMICITY/race claim is proven against a REAL
 * Postgres in `__tests__/oauth-state-consume-race.integration.test.ts`
 * (extended by this same fix round), matching this package's own doctrine
 * that a mock can prove a function's own decision logic but never a
 * multi-connection race.
 */

const renderSql = (q: unknown): string => new PgDialect().sqlToQuery(q as never).sql;

const mockState = vi.hoisted(() => ({
  executeCalls: [] as unknown[],
  // Queued return values for successive db.execute calls, consumed in order.
  executeReturns: [] as unknown[][],
}));

vi.mock("../db.js", () => {
  const db = {
    execute: vi.fn(async (query: unknown) => {
      mockState.executeCalls.push(query);
      return mockState.executeReturns.shift() ?? [];
    }),
    transaction: async (cb: (tx: unknown) => unknown) => cb(db),
  };
  return { db };
});

import { db } from "../db.js";
import { clearPendingConnectorOauthStatesForUser, consumeConnectorOauthStateBySessionUser } from "./connectors.js";

const mockExecute = vi.mocked(db).execute;

beforeEach(() => {
  vi.clearAllMocks();
  mockState.executeCalls = [];
  mockState.executeReturns = [];
});

describe("clearPendingConnectorOauthStatesForUser", () => {
  it("issues ONE UPDATE, filtered on provider + oauthUserId + oauthState IS NOT NULL, clearing oauthState/oauthStateExpiresAt", async () => {
    await clearPendingConnectorOauthStatesForUser("sentry", "user-1");

    expect(mockExecute).toHaveBeenCalledTimes(1);
    const sql = renderSql(mockState.executeCalls[0]);
    expect(sql).toContain("UPDATE connectors");
    expect(sql).toContain("provider =");
    expect(sql).toContain("oauthUserId");
    expect(sql).toContain("oauthState");
    expect(sql).toContain("IS NOT NULL");
    expect(sql).toContain("- 'oauthState'");
    expect(sql).toContain("- 'oauthStateExpiresAt'");
    // Deliberately does NOT clear oauthUserId/oauthPkceVerifier — same
    // disclosed leftover shape as consumeConnectorOauthState's own clear
    // (see connectors.ts's own doc-comment).
    expect(sql).not.toContain("- 'oauthUserId'");
    expect(sql).not.toContain("- 'oauthPkceVerifier'");
  });

  it("does not throw when nothing matches (a no-op UPDATE is a normal, successful zero-row statement)", async () => {
    await expect(clearPendingConnectorOauthStatesForUser("sentry", "no-such-user")).resolves.toBeUndefined();
  });
});

describe("consumeConnectorOauthStateBySessionUser", () => {
  function candidateRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "row-1",
      workspace_id: "ws-1",
      config: { oauthUserId: "user-1", oauthState: "some-state", oauthStateExpiresAt: "2099-01-01T00:00:00.000Z" },
      ...overrides,
    };
  }

  it("runs inside db.transaction (a locking SELECT then an UPDATE — see connectors.ts's own doc-comment)", async () => {
    mockState.executeReturns = [[candidateRow()], [{ id: "row-1" }]];
    await consumeConnectorOauthStateBySessionUser("sentry", "user-1");
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it("the FIRST statement is a SELECT ... FOR UPDATE filtered on provider + oauthUserId + oauthState IS NOT NULL + unexpired", async () => {
    mockState.executeReturns = [[candidateRow()], [{ id: "row-1" }]];
    await consumeConnectorOauthStateBySessionUser("sentry", "user-1");
    const sql = renderSql(mockState.executeCalls[0]);
    expect(sql).toContain("SELECT");
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("provider =");
    expect(sql).toContain("oauthUserId");
    expect(sql).toContain("oauthState");
    expect(sql).toContain("IS NOT NULL");
    expect(sql).toContain("oauthStateExpiresAt");
  });

  it("zero candidates -> null, and the SECOND statement (the UPDATE) is never issued", async () => {
    mockState.executeReturns = [[]];
    const result = await consumeConnectorOauthStateBySessionUser("sentry", "user-1");
    expect(result).toBeNull();
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("MULTIPLE candidates (same-user, two-workspace ambiguity) -> null, and the UPDATE is never issued — ambiguity must not consume", async () => {
    mockState.executeReturns = [
      [candidateRow({ id: "row-1", workspace_id: "ws-1" }), candidateRow({ id: "row-2", workspace_id: "ws-2" })],
    ];
    const result = await consumeConnectorOauthStateBySessionUser("sentry", "user-1");
    expect(result).toBeNull();
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("EXACTLY ONE candidate -> issues the second (UPDATE-by-id) statement, guarded on id + oauthState IS NOT NULL", async () => {
    mockState.executeReturns = [[candidateRow({ id: "row-42" })], [{ id: "row-42" }]];
    await consumeConnectorOauthStateBySessionUser("sentry", "user-1");
    expect(mockExecute).toHaveBeenCalledTimes(2);
    const sql = renderSql(mockState.executeCalls[1]);
    expect(sql).toContain("UPDATE connectors");
    expect(sql).toContain("- 'oauthState'");
    expect(sql).toContain("- 'oauthStateExpiresAt'");
    expect(sql).toContain("oauthState");
    expect(sql).toContain("IS NOT NULL");
  });

  it("resolves {workspaceId, userId, codeVerifier} from the locked candidate row on success", async () => {
    mockState.executeReturns = [
      [candidateRow({ workspace_id: "ws-resolved", config: { oauthUserId: "user-1", oauthPkceVerifier: "verifier-x" } })],
      [{ id: "row-1" }],
    ];
    const result = await consumeConnectorOauthStateBySessionUser("sentry", "user-1");
    expect(result).toEqual({ workspaceId: "ws-resolved", userId: "user-1", codeVerifier: "verifier-x" });
  });

  it("codeVerifier is null when the candidate's config carries none (the common case — session-transport providers typically have no PKCE)", async () => {
    mockState.executeReturns = [[candidateRow({ config: { oauthUserId: "user-1" } })], [{ id: "row-1" }]];
    const result = await consumeConnectorOauthStateBySessionUser("sentry", "user-1");
    expect(result?.codeVerifier).toBeNull();
  });

  it("the resolved userId is ALWAYS the argument passed in (the lookup was keyed by it) — never re-derived from the row's own config", async () => {
    mockState.executeReturns = [[candidateRow()], [{ id: "row-1" }]];
    const result = await consumeConnectorOauthStateBySessionUser("sentry", "the-caller-supplied-id");
    expect(result?.userId).toBe("the-caller-supplied-id");
  });

  it("defensive: if the guarded UPDATE somehow matches zero rows, returns null rather than a partial result", async () => {
    mockState.executeReturns = [[candidateRow()], []];
    const result = await consumeConnectorOauthStateBySessionUser("sentry", "user-1");
    expect(result).toBeNull();
  });
});
