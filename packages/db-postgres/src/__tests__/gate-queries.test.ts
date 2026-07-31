import { describe, it, expect, beforeEach, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * Slice 5 Task 1 gate queries (spec
 * docs/superpowers/specs/2026-07-29-subscription-platform-design.md §6
 * "Enforcement seams"). Five functions, three different testing shapes
 * depending on the module convention each one matches:
 *
 * - `hasActiveSeat` / `countActiveIdentitySeats` (queries/seats.ts) and
 *   `countAccountRunsStartedInWindow` (queries/capacity.ts) all take `db` as
 *   an explicit parameter and issue raw `db.execute(sql\`...\`)` — the same
 *   "capture the SQL object, render it with drizzle's `PgDialect`" technique
 *   as `seats-queries.test.ts` / `billing-accounts-queries.test.ts`, so a
 *   plain captured-SQL mock is passed directly at the call site, no
 *   `vi.mock("../db.js")` required.
 *
 * - `recordUpgradePromptOnce` (queries/upgrade_prompts.ts) ALSO takes `db`
 *   as an explicit parameter, but issues a FLUENT Drizzle chain
 *   (`.insert().values().onConflictDoNothing().returning()`), not a raw
 *   `sql` template — so there is no `SQL` object to hand `PgDialect`. There
 *   is no existing precedent in this package for rendering a fluent chain's
 *   final SQL text (the "capture + PgDialect" harness only ever wraps raw
 *   `sql` templates), so this file instead captures each call's REAL
 *   arguments as the chain is built — the table reference, the values
 *   object, and (load-bearing) the `onConflictDoNothing` target array
 *   compared by reference against the schema's own column objects. That is
 *   strictly more precise than a text/regex match would be: it proves the
 *   insert targets the exact four dedup columns (not just SQL text that
 *   happens to look right), in the exact order the unique index
 *   (`upgrade_prompt_dedup_idx`) declares them.
 *
 * - `latestChatSessionForWorkspace` (queries/jace_sessions.ts) matches ITS
 *   module's own convention instead: the imported singleton `db`, fluent
 *   builder, same shape as `latestTelegramSessionForWorkspace`. Testing it
 *   needs `vi.mock("../db.js")` (the `has-active-runner.test.ts` /
 *   `runner-stats.test.ts` precedent for singleton-db functions), with a
 *   hand-rolled chain mock that captures each stage's argument — hoisted
 *   ABOVE every import in this file (including the other four functions'
 *   imports below), matching that precedent's ordering. This has no effect
 *   on the other four functions: they take `db` as an explicit parameter and
 *   never import the `../db.js` singleton at runtime (only its `Db` TYPE,
 *   erased at compile time), so mocking that module file-wide is inert for
 *   them. The mocked chain's `.where(...)` and `.orderBy(...)` arguments,
 *   though, are THEMSELVES genuine drizzle `SQL` objects (built by
 *   `and`/`eq`/`inArray`/`desc` against real column refs, no live connection
 *   needed) — so THOSE two are rendered with the same `PgDialect` technique
 *   as the raw-SQL functions above, getting real rendered SQL text for the
 *   meaningful parts after all.
 */

const chatSessionMockState = vi.hoisted(() => ({
  rows: [] as Array<{ channel: string; conversationKey: string }>,
  capturedSelect: undefined as unknown,
  capturedWhere: undefined as unknown,
  capturedOrderBy: undefined as unknown,
  capturedLimit: undefined as number | undefined,
}));

vi.mock("../db.js", () => ({
  db: {
    select: (selection: unknown) => ({
      from: () => ({
        where: (condition: unknown) => ({
          orderBy: (order: unknown) => ({
            limit: async (n: number) => {
              chatSessionMockState.capturedSelect = selection;
              chatSessionMockState.capturedWhere = condition;
              chatSessionMockState.capturedOrderBy = order;
              chatSessionMockState.capturedLimit = n;
              return chatSessionMockState.rows;
            },
          }),
        }),
      }),
    }),
  },
}));

import { hasActiveSeat, countActiveIdentitySeats } from "../queries/seats.js";
import { recordUpgradePromptOnce } from "../queries/upgrade_prompts.js";
import { countAccountRunsStartedInWindow } from "../queries/capacity.js";
import { latestChatSessionForWorkspace } from "../queries/jace_sessions.js";
import type { Db } from "../db.js";
import { upgradePromptEvents } from "../schema/upgrade_prompt_events.js";
import { jaceSessions } from "../schema/jace_sessions.js";

const render = (q: unknown) => new PgDialect().sqlToQuery(q as never).sql;
const renderParams = (q: unknown) => new PgDialect().sqlToQuery(q as never).params;

// ---------------------------------------------------------------------------
// hasActiveSeat / countActiveIdentitySeats (queries/seats.ts) —
// explicit `db: Db` param, raw SQL.
// ---------------------------------------------------------------------------

const captured: unknown[] = [];

/** `resolveWith` is what `db.execute(...)` resolves to — the raw driver rows. */
function mockDbCapturing(calls: unknown[], resolveWith: unknown[]): Db {
  return {
    execute: (q: unknown) => {
      calls.push(q);
      return Promise.resolve(resolveWith);
    },
  } as unknown as Db;
}

beforeEach(() => {
  captured.length = 0;
});

describe("hasActiveSeat", () => {
  describe("user subject", () => {
    it("selects from seats scoped to billing_account_id, released_at IS NULL, and user_id", async () => {
      const db = mockDbCapturing(captured, []);
      await hasActiveSeat(db, {
        billingAccountId: "acct-1",
        subject: { userId: "user-1" },
      });
      expect(captured).toHaveLength(1);
      const sql = render(captured[0]);
      expect(sql).toMatch(/select\s+1/i);
      expect(sql).toMatch(/from\s+seats/i);
      expect(sql).toMatch(/where.*billing_account_id\s*=/is);
      expect(sql).toMatch(/released_at\s+is\s+null/i);
      expect(sql).toMatch(/\buser_id\s*=/i);
      expect(sql).toMatch(/limit\s+1/i);
    });

    it("never mentions chat_identity_id — this branch only ever filters on user_id", async () => {
      const db = mockDbCapturing(captured, []);
      await hasActiveSeat(db, {
        billingAccountId: "acct-1",
        subject: { userId: "user-1" },
      });
      const sql = render(captured[0]);
      expect(sql).not.toMatch(/chat_identity_id/i);
    });

    it("binds billingAccountId and userId as parameters, never string-interpolated", async () => {
      const db = mockDbCapturing(captured, []);
      await hasActiveSeat(db, {
        billingAccountId: "acct-1",
        subject: { userId: "user-1" },
      });
      const sql = render(captured[0]);
      const params = renderParams(captured[0]);
      expect(params).toEqual(["acct-1", "user-1"]);
      expect(sql).not.toContain("acct-1");
      expect(sql).not.toContain("user-1");
    });

    it("returns true when a matching active seat row exists", async () => {
      const db = mockDbCapturing(captured, [{ "?column?": 1 }]);
      const result = await hasActiveSeat(db, {
        billingAccountId: "acct-1",
        subject: { userId: "user-1" },
      });
      expect(result).toBe(true);
    });

    it("returns false when no matching row exists", async () => {
      const db = mockDbCapturing(captured, []);
      const result = await hasActiveSeat(db, {
        billingAccountId: "acct-1",
        subject: { userId: "user-1" },
      });
      expect(result).toBe(false);
    });
  });

  describe("chat identity subject", () => {
    it("selects from seats scoped to billing_account_id, released_at IS NULL, and chat_identity_id", async () => {
      const db = mockDbCapturing(captured, []);
      await hasActiveSeat(db, {
        billingAccountId: "acct-1",
        subject: { chatIdentityId: "ci-1" },
      });
      expect(captured).toHaveLength(1);
      const sql = render(captured[0]);
      expect(sql).toMatch(/select\s+1/i);
      expect(sql).toMatch(/from\s+seats/i);
      expect(sql).toMatch(/where.*billing_account_id\s*=/is);
      expect(sql).toMatch(/released_at\s+is\s+null/i);
      expect(sql).toMatch(/chat_identity_id\s*=/i);
      expect(sql).toMatch(/limit\s+1/i);
    });

    it("never mentions a bare user_id column — this branch only ever filters on chat_identity_id", async () => {
      const db = mockDbCapturing(captured, []);
      await hasActiveSeat(db, {
        billingAccountId: "acct-1",
        subject: { chatIdentityId: "ci-1" },
      });
      const sql = render(captured[0]);
      expect(sql).not.toMatch(/\buser_id\b/i);
    });

    it("binds billingAccountId and chatIdentityId as parameters, never string-interpolated", async () => {
      const db = mockDbCapturing(captured, []);
      await hasActiveSeat(db, {
        billingAccountId: "acct-1",
        subject: { chatIdentityId: "ci-1" },
      });
      const sql = render(captured[0]);
      const params = renderParams(captured[0]);
      expect(params).toEqual(["acct-1", "ci-1"]);
      expect(sql).not.toContain("acct-1");
      expect(sql).not.toContain("ci-1");
    });

    it("returns true when a matching active seat row exists", async () => {
      const db = mockDbCapturing(captured, [{ "?column?": 1 }]);
      const result = await hasActiveSeat(db, {
        billingAccountId: "acct-1",
        subject: { chatIdentityId: "ci-1" },
      });
      expect(result).toBe(true);
    });

    it("returns false when no matching row exists", async () => {
      const db = mockDbCapturing(captured, []);
      const result = await hasActiveSeat(db, {
        billingAccountId: "acct-1",
        subject: { chatIdentityId: "ci-1" },
      });
      expect(result).toBe(false);
    });
  });
});

describe("countActiveIdentitySeats", () => {
  it("selects count(*)::int from seats scoped to billing_account_id, released_at IS NULL, and chat_identity_id IS NOT NULL", async () => {
    const db = mockDbCapturing(captured, [{ count: 0 }]);
    await countActiveIdentitySeats(db, "acct-1");

    expect(captured).toHaveLength(1);
    const sql = render(captured[0]);
    expect(sql).toMatch(/count\(\*\)::int/i);
    expect(sql).toMatch(/from\s+seats/i);
    expect(sql).toMatch(/where.*billing_account_id\s*=/is);
    expect(sql).toMatch(/released_at\s+is\s+null/i);
    expect(sql).toMatch(/chat_identity_id\s+is\s+not\s+null/i);
  });

  it("binds billingAccountId as a parameter, never string-interpolated", async () => {
    const db = mockDbCapturing(captured, [{ count: 0 }]);
    await countActiveIdentitySeats(db, "acct-1");
    const sql = render(captured[0]);
    const params = renderParams(captured[0]);
    expect(params).toContain("acct-1");
    expect(sql).not.toContain("acct-1");
  });

  it("returns the count as a real number", async () => {
    const db = mockDbCapturing(captured, [{ count: 3 }]);
    const result = await countActiveIdentitySeats(db, "acct-1");
    expect(result).toBe(3);
  });

  it("returns 0 for an account with no active identity seats", async () => {
    const db = mockDbCapturing(captured, []);
    const result = await countActiveIdentitySeats(db, "acct-empty");
    expect(result).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// recordUpgradePromptOnce (queries/upgrade_prompts.ts) —
// explicit `db: Db` param, fluent Drizzle chain.
// ---------------------------------------------------------------------------

interface CapturedUpgradePromptCall {
  table?: unknown;
  values?: unknown;
  conflict?: unknown;
  returning?: unknown;
}

function mockDbForUpgradePrompt(resolveWith: Array<{ id: string }>): {
  db: Db;
  calls: CapturedUpgradePromptCall;
} {
  const calls: CapturedUpgradePromptCall = {};
  const db = {
    insert: (table: unknown) => {
      calls.table = table;
      return {
        values: (values: unknown) => {
          calls.values = values;
          return {
            onConflictDoNothing: (config: unknown) => {
              calls.conflict = config;
              return {
                returning: (selection: unknown) => {
                  calls.returning = selection;
                  return Promise.resolve(resolveWith);
                },
              };
            },
          };
        },
      };
    },
  } as unknown as Db;
  return { db, calls };
}

const VALID_UPGRADE_PROMPT_ARGS = {
  billingAccountId: "acct-1",
  kind: "seat_limit" as const,
  conversationKey: "conv-1",
  channel: "telegram",
  periodKey: "2026-07-31",
};

describe("recordUpgradePromptOnce", () => {
  it("inserts into upgrade_prompt_events with exactly the given fields", async () => {
    const { db, calls } = mockDbForUpgradePrompt([]);
    await recordUpgradePromptOnce(db, VALID_UPGRADE_PROMPT_ARGS);

    expect(calls.table).toBe(upgradePromptEvents);
    expect(calls.values).toEqual({
      billingAccountId: "acct-1",
      kind: "seat_limit",
      conversationKey: "conv-1",
      channel: "telegram",
      periodKey: "2026-07-31",
    });
  });

  it("guards the insert with onConflictDoNothing targeting the exact 4-column dedup key, in the unique index's own order", async () => {
    const { db, calls } = mockDbForUpgradePrompt([]);
    await recordUpgradePromptOnce(db, VALID_UPGRADE_PROMPT_ARGS);

    expect(calls.conflict).toEqual({
      target: [
        upgradePromptEvents.billingAccountId,
        upgradePromptEvents.kind,
        upgradePromptEvents.conversationKey,
        upgradePromptEvents.periodKey,
      ],
    });
  });

  it("does NOT target channel — channel rides along but is deliberately outside the dedup key", async () => {
    const { db, calls } = mockDbForUpgradePrompt([]);
    await recordUpgradePromptOnce(db, VALID_UPGRADE_PROMPT_ARGS);

    const target = (calls.conflict as { target: unknown[] }).target;
    expect(target).not.toContain(upgradePromptEvents.channel);
    expect(target).toHaveLength(4);
  });

  it("returns true when this call's insert wins the slot (returning yields a row)", async () => {
    const { db } = mockDbForUpgradePrompt([{ id: "evt-1" }]);
    const result = await recordUpgradePromptOnce(db, VALID_UPGRADE_PROMPT_ARGS);
    expect(result).toBe(true);
  });

  it("returns false when a prior prompt already occupies this slot (returning yields nothing)", async () => {
    const { db } = mockDbForUpgradePrompt([]);
    const result = await recordUpgradePromptOnce(db, VALID_UPGRADE_PROMPT_ARGS);
    expect(result).toBe(false);
  });

  it("accepts all three kinds (seat_limit, capacity, capacity_warning)", async () => {
    for (const kind of ["seat_limit", "capacity", "capacity_warning"] as const) {
      const { db, calls } = mockDbForUpgradePrompt([{ id: "evt-1" }]);
      await recordUpgradePromptOnce(db, { ...VALID_UPGRADE_PROMPT_ARGS, kind });
      expect((calls.values as { kind: string }).kind).toBe(kind);
    }
  });
});

// ---------------------------------------------------------------------------
// countAccountRunsStartedInWindow (queries/capacity.ts) —
// explicit `db: Db` param, raw SQL.
// ---------------------------------------------------------------------------

describe("countAccountRunsStartedInWindow", () => {
  it("selects count(*)::int from runs JOIN workspaces on workspace_id", async () => {
    const db = mockDbCapturing(captured, [{ count: 0 }]);
    await countAccountRunsStartedInWindow(db, {
      billingAccountId: "acct-1",
      fromIso: "2026-07-01T00:00:00.000Z",
      toIso: "2026-08-01T00:00:00.000Z",
    });

    expect(captured).toHaveLength(1);
    const sql = render(captured[0]);
    expect(sql).toMatch(/count\(\*\)::int/i);
    expect(sql).toMatch(/from\s+runs/i);
    expect(sql).toMatch(/join\s+workspaces/i);
    expect(sql).toMatch(/workspace_id/i);
  });

  it("joins on the correct, correctly-directed predicate — w.id = r.workspace_id as ONE unit, not independently-satisfiable fragments (a wrong pairing like w.billing_account_id = r.workspace_id must fail this)", async () => {
    const db = mockDbCapturing(captured, [{ count: 0 }]);
    await countAccountRunsStartedInWindow(db, {
      billingAccountId: "acct-1",
      fromIso: "2026-07-01T00:00:00.000Z",
      toIso: "2026-08-01T00:00:00.000Z",
    });
    const sql = render(captured[0]);
    expect(sql).toMatch(/on\s+w\.id\s*=\s*r\.workspace_id/i);
  });

  it("scopes by billing_account_id (through the workspaces join), not a single workspace", async () => {
    const db = mockDbCapturing(captured, [{ count: 0 }]);
    await countAccountRunsStartedInWindow(db, {
      billingAccountId: "acct-1",
      fromIso: "2026-07-01T00:00:00.000Z",
      toIso: "2026-08-01T00:00:00.000Z",
    });
    const sql = render(captured[0]);
    expect(sql).toMatch(/billing_account_id\s*=/i);
  });

  it("windows on created_at as a half-open interval: >= fromIso AND < toIso", async () => {
    const db = mockDbCapturing(captured, [{ count: 0 }]);
    await countAccountRunsStartedInWindow(db, {
      billingAccountId: "acct-1",
      fromIso: "2026-07-01T00:00:00.000Z",
      toIso: "2026-08-01T00:00:00.000Z",
    });
    const sql = render(captured[0]);
    expect(sql).toMatch(/created_at\s*>=/i);
    expect(sql).toMatch(/created_at\s*</i);
    expect(sql).not.toMatch(/created_at\s*<=/i);
  });

  it("binds billingAccountId/fromIso/toIso as the exact ISO strings passed in, never wrapped in a Date object", async () => {
    const db = mockDbCapturing(captured, [{ count: 0 }]);
    await countAccountRunsStartedInWindow(db, {
      billingAccountId: "acct-1",
      fromIso: "2026-07-01T00:00:00.000Z",
      toIso: "2026-08-01T00:00:00.000Z",
    });
    const sql = render(captured[0]);
    const params = renderParams(captured[0]);
    expect(params).toEqual([
      "acct-1",
      "2026-07-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
    ]);
    for (const p of params) {
      expect(typeof p).toBe("string");
    }
    expect(sql).not.toContain("acct-1");
    expect(sql).not.toContain("2026-07-01T00:00:00.000Z");
  });

  it("returns the count as a real number", async () => {
    const db = mockDbCapturing(captured, [{ count: 12 }]);
    const result = await countAccountRunsStartedInWindow(db, {
      billingAccountId: "acct-1",
      fromIso: "2026-07-01T00:00:00.000Z",
      toIso: "2026-08-01T00:00:00.000Z",
    });
    expect(result).toBe(12);
  });

  it("returns 0 for an account with no runs claimed in the window", async () => {
    const db = mockDbCapturing(captured, []);
    const result = await countAccountRunsStartedInWindow(db, {
      billingAccountId: "acct-empty",
      fromIso: "2026-07-01T00:00:00.000Z",
      toIso: "2026-08-01T00:00:00.000Z",
    });
    expect(result).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// latestChatSessionForWorkspace (queries/jace_sessions.ts) — singleton `db`,
// fluent builder (mocked file-wide above, before every import in this file).
// ---------------------------------------------------------------------------

describe("latestChatSessionForWorkspace", () => {
  beforeEach(() => {
    chatSessionMockState.rows = [];
    chatSessionMockState.capturedSelect = undefined;
    chatSessionMockState.capturedWhere = undefined;
    chatSessionMockState.capturedOrderBy = undefined;
    chatSessionMockState.capturedLimit = undefined;
  });

  it("scopes to the workspace id and a channel IN-list, bound not interpolated", async () => {
    await latestChatSessionForWorkspace("ws-1");

    const sql = render(chatSessionMockState.capturedWhere);
    const params = renderParams(chatSessionMockState.capturedWhere);
    // The fluent builder renders quoted, table-prefixed identifiers
    // (`"jace_sessions"."workspace_id"`), unlike the raw sql`` templates
    // elsewhere in this file (hand-written, unquoted column names) — the
    // optional `"?` accounts for the closing quote landing right before the
    // operator/keyword.
    expect(sql).toMatch(/workspace_id"?\s*=/i);
    expect(sql).toMatch(/channel"?\s+in\s*\(/i);
    expect(params).toEqual(
      expect.arrayContaining(["ws-1", "telegram", "discord", "slack"])
    );
    expect(sql).not.toContain("ws-1");
  });

  it("the IN-list is exactly telegram/discord/slack — console is never a candidate", async () => {
    await latestChatSessionForWorkspace("ws-1");
    const params = renderParams(chatSessionMockState.capturedWhere) as unknown[];
    expect(params).not.toContain("console");
    // workspaceId + 3 channels, nothing else.
    expect(params).toHaveLength(4);
  });

  it("orders by last_activity_at descending", async () => {
    await latestChatSessionForWorkspace("ws-1");
    const sql = render(chatSessionMockState.capturedOrderBy);
    expect(sql).toMatch(/last_activity_at/i);
    expect(sql).toMatch(/desc/i);
  });

  it("caps at one row", async () => {
    await latestChatSessionForWorkspace("ws-1");
    expect(chatSessionMockState.capturedLimit).toBe(1);
  });

  it("selects only channel and conversation_key, not the whole row", async () => {
    await latestChatSessionForWorkspace("ws-1");
    const selection = chatSessionMockState.capturedSelect as Record<string, unknown>;
    expect(Object.keys(selection).sort()).toEqual(["channel", "conversationKey"]);
  });

  it("maps each selected key to the CORRECT column — column identity by reference, not just key names (a swapped channel<->conversationKey mapping must fail this)", async () => {
    await latestChatSessionForWorkspace("ws-1");
    const selection = chatSessionMockState.capturedSelect as {
      channel: unknown;
      conversationKey: unknown;
    };
    expect(selection.channel).toBe(jaceSessions.channel);
    expect(selection.conversationKey).toBe(jaceSessions.conversationKey);
  });

  it("returns null when the workspace has no telegram/discord/slack session", async () => {
    chatSessionMockState.rows = [];
    const result = await latestChatSessionForWorkspace("ws-1");
    expect(result).toBeNull();
  });

  it("returns { channel, conversationKey } when a session matches", async () => {
    chatSessionMockState.rows = [{ channel: "discord", conversationKey: "chan-42" }];
    const result = await latestChatSessionForWorkspace("ws-1");
    expect(result).toEqual({ channel: "discord", conversationKey: "chan-42" });
  });
});
