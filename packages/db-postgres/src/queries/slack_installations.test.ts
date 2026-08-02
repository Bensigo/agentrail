import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// Mocked db chain — same "mock the chain, control the terminal value" idiom
// as `jace_sessions-engagement.test.ts` / `__tests__/connectors.test.ts`;
// this package has no live-DB harness.
vi.mock("../db.js", () => ({
  db: {
    insert: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
  },
}));

import { db } from "../db.js";
import { slackInstallations } from "../schema/slack_installations.js";
import { encryptSecret, decryptSecret, isEncrypted } from "../crypto.js";
import {
  upsertSlackInstallation,
  getSlackInstallation,
  listSlackInstallationsForWorkspace,
  revokeSlackInstallation,
} from "./slack_installations.js";

const mockDb = vi.mocked(db);

const dialect = new PgDialect();
function renderCondition(condition: unknown) {
  return dialect.sqlToQuery(condition as Parameters<typeof dialect.sqlToQuery>[0]);
}

/** Chainable insert mock whose terminal `onConflictDoUpdate` resolves. */
function makeInsertChain() {
  const chain: Record<string, unknown> = {};
  chain.insert = vi.fn(() => chain);
  chain.values = vi.fn(() => chain);
  chain.onConflictDoUpdate = vi.fn(() => Promise.resolve(undefined));
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

/** Chainable select mock whose terminal `orderBy` resolves the given rows. */
function makeSelectOrderByChain(rows: unknown) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "from", "where"]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.orderBy = vi.fn(() => Promise.resolve(rows));
  return chain;
}

/** Chainable update mock whose terminal `where` resolves. */
function makeUpdateChain() {
  const chain: Record<string, unknown> = {};
  chain.update = vi.fn(() => chain);
  chain.set = vi.fn(() => chain);
  chain.where = vi.fn(() => Promise.resolve(undefined));
  return chain;
}

const TEAM_ID = "T0BLL0VNR9U";
const PLAINTEXT_TOKEN = "xoxb-plaintext-bot-token";
const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

beforeAll(() => {
  // Deterministic key material for the test (no real CONNECTOR_SECRET_KEY
  // needed) — same idiom as __tests__/connectors.test.ts.
  process.env["CONNECTOR_SECRET_KEY"] = "test-connector-secret-key-abc123456789";
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("upsertSlackInstallation", () => {
  it("encrypts botToken before write — stored value is NOT the plaintext and carries the enc:v1 prefix", async () => {
    const insertChain = makeInsertChain();
    mockDb.insert.mockReturnValue(insertChain as never);

    await upsertSlackInstallation({
      teamId: TEAM_ID,
      botToken: PLAINTEXT_TOKEN,
      botUserId: "U0BOTUSER",
    });

    const values = insertChain.values as ReturnType<typeof vi.fn>;
    const written = values.mock.calls[0]?.[0] as { botToken: string };
    expect(written.botToken).not.toBe(PLAINTEXT_TOKEN);
    expect(isEncrypted(written.botToken)).toBe(true);
    expect(written.botToken.startsWith("enc:v1:")).toBe(true);
  });

  it("clears revoked_at on both the insert values and the conflict-update set (a reinstall reactivates)", async () => {
    const insertChain = makeInsertChain();
    mockDb.insert.mockReturnValue(insertChain as never);

    await upsertSlackInstallation({
      teamId: TEAM_ID,
      botToken: PLAINTEXT_TOKEN,
      botUserId: "U0BOTUSER",
    });

    const values = insertChain.values as ReturnType<typeof vi.fn>;
    const written = values.mock.calls[0]?.[0] as { revokedAt: unknown };
    expect(written.revokedAt).toBeNull();

    const onConflict = insertChain.onConflictDoUpdate as ReturnType<typeof vi.fn>;
    const conflictArg = onConflict.mock.calls[0]?.[0] as {
      set: { revokedAt: unknown };
      target: unknown;
    };
    expect(conflictArg.set.revokedAt).toBeNull();
  });

  it("upserts on the team_id natural key", async () => {
    const insertChain = makeInsertChain();
    mockDb.insert.mockReturnValue(insertChain as never);

    await upsertSlackInstallation({
      teamId: TEAM_ID,
      botToken: PLAINTEXT_TOKEN,
      botUserId: "U0BOTUSER",
    });

    const onConflict = insertChain.onConflictDoUpdate as ReturnType<typeof vi.fn>;
    const conflictArg = onConflict.mock.calls[0]?.[0] as { target: unknown };
    expect(conflictArg.target).toBe(slackInstallations.teamId);
  });

  it("writes optional fields when provided and null when omitted", async () => {
    const insertChain = makeInsertChain();
    mockDb.insert.mockReturnValue(insertChain as never);

    await upsertSlackInstallation({
      teamId: TEAM_ID,
      teamName: "HeyJace",
      botToken: PLAINTEXT_TOKEN,
      botUserId: "U0BOTUSER",
      installedBySlackUserId: "U0INSTALLER",
      scopes: "chat:write,channels:read",
      enterpriseId: null,
    });

    const values = insertChain.values as ReturnType<typeof vi.fn>;
    const written = values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.teamId).toBe(TEAM_ID);
    expect(written.teamName).toBe("HeyJace");
    expect(written.botUserId).toBe("U0BOTUSER");
    expect(written.installedBySlackUserId).toBe("U0INSTALLER");
    expect(written.scopes).toBe("chat:write,channels:read");
    expect(written.enterpriseId).toBeNull();
  });

  it("defaults omitted optional fields to null (teamName, installedBySlackUserId, scopes, enterpriseId)", async () => {
    const insertChain = makeInsertChain();
    mockDb.insert.mockReturnValue(insertChain as never);

    await upsertSlackInstallation({
      teamId: TEAM_ID,
      botToken: PLAINTEXT_TOKEN,
      botUserId: "U0BOTUSER",
    });

    const values = insertChain.values as ReturnType<typeof vi.fn>;
    const written = values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.teamName).toBeNull();
    expect(written.installedBySlackUserId).toBeNull();
    expect(written.scopes).toBeNull();
    expect(written.enterpriseId).toBeNull();
  });
});

// Workspace attribution (bugfix: the console's Gateways page could never see
// that a workspace had installed Slack, so "Add to Slack" never went away).
describe("upsertSlackInstallation — workspace attribution", () => {
  it("writes workspaceId when the install carried one", async () => {
    const insertChain = makeInsertChain();
    mockDb.insert.mockReturnValue(insertChain as never);

    await upsertSlackInstallation({
      teamId: TEAM_ID,
      botToken: PLAINTEXT_TOKEN,
      botUserId: "U0BOTUSER",
      workspaceId: WORKSPACE_ID,
    });

    const values = insertChain.values as ReturnType<typeof vi.fn>;
    const written = values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.workspaceId).toBe(WORKSPACE_ID);
  });

  it("defaults workspaceId to null for an install with no workspace context (Slack App Directory)", async () => {
    const insertChain = makeInsertChain();
    mockDb.insert.mockReturnValue(insertChain as never);

    await upsertSlackInstallation({
      teamId: TEAM_ID,
      botToken: PLAINTEXT_TOKEN,
      botUserId: "U0BOTUSER",
    });

    const values = insertChain.values as ReturnType<typeof vi.fn>;
    const written = values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.workspaceId).toBeNull();
  });

  it("never nulls an existing attribution on conflict — a later contextless reinstall keeps the stored workspace", async () => {
    const insertChain = makeInsertChain();
    mockDb.insert.mockReturnValue(insertChain as never);

    await upsertSlackInstallation({
      teamId: TEAM_ID,
      botToken: PLAINTEXT_TOKEN,
      botUserId: "U0BOTUSER",
    });

    const onConflict = insertChain.onConflictDoUpdate as ReturnType<typeof vi.fn>;
    const conflictArg = onConflict.mock.calls[0]?.[0] as {
      set: Record<string, unknown>;
    };
    // A plain `null` here would wipe the attribution the console depends on.
    expect(conflictArg.set.workspaceId).not.toBeNull();
    expect(renderCondition(conflictArg.set.workspaceId).sql).toContain("coalesce");
  });
});

describe("listSlackInstallationsForWorkspace", () => {
  it("returns the non-secret shape (teamId, teamName) — never the bot token", async () => {
    const selectChain = makeSelectOrderByChain([
      { teamId: TEAM_ID, teamName: "HeyJace" },
    ]);
    mockDb.select.mockReturnValue(selectChain as never);

    const result = await listSlackInstallationsForWorkspace(WORKSPACE_ID);

    expect(result).toEqual([{ teamId: TEAM_ID, teamName: "HeyJace" }]);
    const selected = mockDb.select.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(selected).sort()).toEqual(["teamName", "teamId"].sort());
  });

  it("scopes to the workspace AND excludes revoked installs — an uninstalled team stops counting as connected", async () => {
    const selectChain = makeSelectOrderByChain([]);
    mockDb.select.mockReturnValue(selectChain as never);

    await listSlackInstallationsForWorkspace(WORKSPACE_ID);

    const whereArgs = (selectChain.where as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(renderCondition(whereArgs)).toEqual(
      renderCondition(
        and(
          eq(slackInstallations.workspaceId, WORKSPACE_ID),
          isNull(slackInstallations.revokedAt)
        )
      )
    );
  });

  it("returns [] for a workspace with no installation", async () => {
    mockDb.select.mockReturnValue(makeSelectOrderByChain([]) as never);

    expect(await listSlackInstallationsForWorkspace(WORKSPACE_ID)).toEqual([]);
  });
});

describe("getSlackInstallation", () => {
  it("returns null for an unknown team", async () => {
    mockDb.select.mockReturnValue(makeSelectLimitChain([]) as never);

    const result = await getSlackInstallation("no-such-team");

    expect(result).toBeNull();
  });

  it("scopes the lookup to team_id", async () => {
    const selectChain = makeSelectLimitChain([]);
    mockDb.select.mockReturnValue(selectChain as never);

    await getSlackInstallation(TEAM_ID);

    const whereArgs = (selectChain.where as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(renderCondition(whereArgs)).toEqual(
      renderCondition(eq(slackInstallations.teamId, TEAM_ID))
    );
  });

  it("returns null for a revoked team — fails closed without callers needing to check revoked_at themselves", async () => {
    mockDb.select.mockReturnValue(
      makeSelectLimitChain([
        {
          teamId: TEAM_ID,
          teamName: "HeyJace",
          botToken: encryptSecret(PLAINTEXT_TOKEN),
          botUserId: "U0BOTUSER",
          enterpriseId: null,
          revokedAt: new Date("2026-07-29T00:00:00Z"),
        },
      ]) as never
    );

    const result = await getSlackInstallation(TEAM_ID);

    expect(result).toBeNull();
  });

  it("decrypts botToken on read — a decrypt round-trip returns the original plaintext", async () => {
    const encrypted = encryptSecret(PLAINTEXT_TOKEN);
    mockDb.select.mockReturnValue(
      makeSelectLimitChain([
        {
          teamId: TEAM_ID,
          teamName: "HeyJace",
          botToken: encrypted,
          botUserId: "U0BOTUSER",
          enterpriseId: null,
          revokedAt: null,
        },
      ]) as never
    );

    const result = await getSlackInstallation(TEAM_ID);

    expect(result).not.toBeNull();
    expect(result?.botToken).toBe(PLAINTEXT_TOKEN);
    expect(result?.botToken).toBe(decryptSecret(encrypted));
  });

  it("returns the full non-secret shape (teamId, teamName, botUserId, enterpriseId) alongside the decrypted token", async () => {
    mockDb.select.mockReturnValue(
      makeSelectLimitChain([
        {
          teamId: TEAM_ID,
          teamName: "HeyJace",
          botToken: encryptSecret(PLAINTEXT_TOKEN),
          botUserId: "U0BOTUSER",
          enterpriseId: "E0ENTERPRISE",
          revokedAt: null,
        },
      ]) as never
    );

    const result = await getSlackInstallation(TEAM_ID);

    expect(result).toEqual({
      teamId: TEAM_ID,
      teamName: "HeyJace",
      botToken: PLAINTEXT_TOKEN,
      botUserId: "U0BOTUSER",
      enterpriseId: "E0ENTERPRISE",
    });
  });
});

describe("revokeSlackInstallation", () => {
  it("sets revoked_at (never deletes the row) scoped to team_id", async () => {
    const updateChain = makeUpdateChain();
    mockDb.update.mockReturnValue(updateChain as never);

    await revokeSlackInstallation(TEAM_ID);

    expect(mockDb.update).toHaveBeenCalledWith(slackInstallations);

    const setCalls = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls;
    const setArg = setCalls[0]?.[0] as { revokedAt: unknown };
    expect(setArg.revokedAt).toBeInstanceOf(Date);

    const whereArgs = (updateChain.where as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(renderCondition(whereArgs)).toEqual(
      renderCondition(eq(slackInstallations.teamId, TEAM_ID))
    );
  });
});

describe("reinstall reactivation (upsert -> revoke -> upsert)", () => {
  it("a reinstall after a revoke clears revoked_at back to null via the conflict-update set", async () => {
    // Revoke first.
    const updateChain = makeUpdateChain();
    mockDb.update.mockReturnValue(updateChain as never);
    await revokeSlackInstallation(TEAM_ID);
    const revokedAtSet = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      revokedAt: Date;
    };
    expect(revokedAtSet.revokedAt).toBeInstanceOf(Date);

    // Reinstall (upsert) must clear it back to null.
    const insertChain = makeInsertChain();
    mockDb.insert.mockReturnValue(insertChain as never);
    await upsertSlackInstallation({
      teamId: TEAM_ID,
      botToken: PLAINTEXT_TOKEN,
      botUserId: "U0BOTUSER",
    });

    const onConflict = insertChain.onConflictDoUpdate as ReturnType<typeof vi.fn>;
    const conflictArg = onConflict.mock.calls[0]?.[0] as { set: { revokedAt: unknown } };
    expect(conflictArg.set.revokedAt).toBeNull();
  });
});
