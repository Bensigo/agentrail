import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocked db chain: same "mock the chain, control the terminal value" approach
// as chat_identities.test.ts.
vi.mock("../db.js", () => ({
  db: {
    insert: vi.fn(),
  },
}));

import { db } from "../db.js";
import { createUserForSignup, createConsoleSession } from "./signup_account.js";

const mockDb = vi.mocked(db);

function makeChain(terminalMethod: string, finalValue: unknown) {
  const chain: Record<string, unknown> = {};
  const methods = ["values", "returning"];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  chain[terminalMethod] = vi.fn(() => Promise.resolve(finalValue));
  return chain;
}

const NOW = new Date("2026-07-22T00:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createUserForSignup", () => {
  it("inserts a users row with the given name and no email, and returns it", async () => {
    const newUser = {
      id: "user-new-1",
      name: "Ada",
      email: null,
      emailVerified: null,
      image: null,
    };
    const insertChain = makeChain("returning", [newUser]);
    mockDb.insert = vi.fn(() => insertChain as ReturnType<typeof db.insert>);

    const result = await createUserForSignup("Ada");

    expect(mockDb.insert).toHaveBeenCalled();
    const valuesCalls = (insertChain.values as ReturnType<typeof vi.fn>).mock.calls;
    // SECURITY / AC3-adjacent: only `name` is ever written here — no email,
    // no id, nothing that could let a caller steer which account this
    // becomes or collide with an existing one. Postgres tolerates many NULL
    // emails under the unique index (NULL <> NULL), so this is correct, not
    // a placeholder.
    expect(valuesCalls[0]?.[0]).toEqual({ name: "Ada" });
    expect(result).toEqual(newUser);
  });

  it("passes a null name through unchanged (a Telegram identity with no display name)", async () => {
    const newUser = { id: "user-new-2", name: null, email: null, emailVerified: null, image: null };
    const insertChain = makeChain("returning", [newUser]);
    mockDb.insert = vi.fn(() => insertChain as ReturnType<typeof db.insert>);

    await createUserForSignup(null);

    const valuesCalls = (insertChain.values as ReturnType<typeof vi.fn>).mock.calls;
    expect(valuesCalls[0]?.[0]).toEqual({ name: null });
  });

  it("throws when the insert returns no row (unreachable in practice)", async () => {
    const insertChain = makeChain("returning", []);
    mockDb.insert = vi.fn(() => insertChain as ReturnType<typeof db.insert>);

    await expect(createUserForSignup("Ada")).rejects.toThrow(
      /createUserForSignup: insert returned no row/
    );
  });
});

describe("createConsoleSession", () => {
  it("inserts a sessions row with exactly the given sessionToken, userId, and expires", async () => {
    const insertChain = makeChain("values", undefined);
    // .values() itself is the terminal call here (no .returning()) — mirror
    // that by making "values" resolve directly.
    insertChain["values"] = vi.fn(() => Promise.resolve(undefined));
    mockDb.insert = vi.fn(() => insertChain as ReturnType<typeof db.insert>);

    await createConsoleSession("user-1", "session-tok-abc", NOW);

    expect(mockDb.insert).toHaveBeenCalled();
    const valuesCalls = (insertChain.values as ReturnType<typeof vi.fn>).mock.calls;
    expect(valuesCalls[0]?.[0]).toEqual({
      sessionToken: "session-tok-abc",
      userId: "user-1",
      expires: NOW,
    });
  });
});
