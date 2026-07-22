import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@agentrail/db-postgres", () => ({
  consumeChatIdentitySignupToken: vi.fn(),
  createUserForSignup: vi.fn(),
  createConsoleSession: vi.fn(),
  bindChatIdentityUser: vi.fn(),
}));
vi.mock("./connect-owner-elect-completion", () => ({
  completeConnectOwnerElect: vi.fn(),
  buildOwnerElectCompletionLine: vi.fn(),
}));
vi.mock("./signup-confirmation", () => ({
  sendSignupConfirmation: vi.fn(),
}));

import {
  redeemSignupToken,
  buildSignupActionOutcome,
  SIGNUP_COMPLETE_PATH,
} from "./signup-redeem";
import {
  consumeChatIdentitySignupToken,
  createUserForSignup,
  createConsoleSession,
  bindChatIdentityUser,
} from "@agentrail/db-postgres";
import {
  completeConnectOwnerElect,
  buildOwnerElectCompletionLine,
} from "./connect-owner-elect-completion";
import { sendSignupConfirmation } from "./signup-confirmation";

const mockConsume = vi.mocked(consumeChatIdentitySignupToken);
const mockCreateUser = vi.mocked(createUserForSignup);
const mockCreateSession = vi.mocked(createConsoleSession);
const mockBindUser = vi.mocked(bindChatIdentityUser);
const mockCompleteOwnerElect = vi.mocked(completeConnectOwnerElect);
const mockBuildLine = vi.mocked(buildOwnerElectCompletionLine);
const mockSendConfirmation = vi.mocked(sendSignupConfirmation);

const NOW = new Date("2026-07-22T00:00:00.000Z");

const UNBOUND_IDENTITY = {
  id: "chat-identity-1",
  platform: "telegram",
  platformUserId: "tg-123",
  displayName: "Ada",
  userId: null,
  workspaceId: null,
  linkToken: null,
  linkTokenExpiresAt: null,
  signupToken: null,
  signupTokenExpiresAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockCompleteOwnerElect.mockResolvedValue({ completed: false, workspaceName: null });
  mockBuildLine.mockReturnValue(null);
  mockSendConfirmation.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("redeemSignupToken", () => {
  it("AC3 (expiry/single-use): an expired-or-already-consumed token yields expired_or_used and touches NOTHING else — no user, no bind, no session, no confirmation", async () => {
    mockConsume.mockResolvedValue(null);

    const result = await redeemSignupToken("stale-or-reused-token");

    expect(result).toEqual({ kind: "expired_or_used" });
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(mockBindUser).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockCompleteOwnerElect).not.toHaveBeenCalled();
    expect(mockSendConfirmation).not.toHaveBeenCalled();
  });

  it("AC3 (server-derived identity): the token string is the ONLY input — consumeChatIdentitySignupToken is called with exactly the given token, nothing else can steer which identity resolves", async () => {
    mockConsume.mockResolvedValue(UNBOUND_IDENTITY as never);
    mockCreateUser.mockResolvedValue({ id: "user-new-1", name: "Ada", email: null, emailVerified: null, image: null } as never);

    await redeemSignupToken("the-exact-token");

    expect(mockConsume).toHaveBeenCalledTimes(1);
    expect(mockConsume).toHaveBeenCalledWith("the-exact-token");
  });

  it("new user path: identity.userId null creates a user with the identity's displayName, binds it, and mints a session for the NEW user", async () => {
    mockConsume.mockResolvedValue(UNBOUND_IDENTITY as never);
    mockCreateUser.mockResolvedValue({ id: "user-new-1", name: "Ada", email: null, emailVerified: null, image: null } as never);

    const result = await redeemSignupToken("tok-abc");

    expect(mockCreateUser).toHaveBeenCalledWith("Ada");
    expect(mockBindUser).toHaveBeenCalledWith("chat-identity-1", "user-new-1");
    expect(mockCreateSession).toHaveBeenCalledWith(
      "user-new-1",
      expect.any(String),
      expect.any(Date)
    );
    expect(result.kind).toBe("signed_up");
  });

  it("new user path: a null displayName is passed through to createUserForSignup unchanged (never fabricated)", async () => {
    mockConsume.mockResolvedValue({ ...UNBOUND_IDENTITY, displayName: null } as never);
    mockCreateUser.mockResolvedValue({ id: "user-new-2", name: null, email: null, emailVerified: null, image: null } as never);

    await redeemSignupToken("tok-abc");

    expect(mockCreateUser).toHaveBeenCalledWith(null);
  });

  it("existing user path: identity.userId already set — reuses it, never creates a second user or re-binds", async () => {
    mockConsume.mockResolvedValue({ ...UNBOUND_IDENTITY, userId: "user-existing-1" } as never);

    const result = await redeemSignupToken("tok-abc");

    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(mockBindUser).not.toHaveBeenCalled();
    expect(mockCreateSession).toHaveBeenCalledWith(
      "user-existing-1",
      expect.any(String),
      expect.any(Date)
    );
    expect(result.kind).toBe("signed_up");
  });

  it("mints a 64-hex-char session token and a ~30-day expiry", async () => {
    mockConsume.mockResolvedValue(UNBOUND_IDENTITY as never);
    mockCreateUser.mockResolvedValue({ id: "user-new-1", name: "Ada", email: null, emailVerified: null, image: null } as never);

    const result = await redeemSignupToken("tok-abc");

    expect(result.kind).toBe("signed_up");
    if (result.kind !== "signed_up") throw new Error("unreachable");
    expect(result.sessionToken).toMatch(/^[0-9a-f]{64}$/);
    expect(result.sessionExpires.getTime()).toBe(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);
    expect(mockCreateSession).toHaveBeenCalledWith(
      "user-new-1",
      result.sessionToken,
      result.sessionExpires
    );
  });

  it("mints a DIFFERENT session token on every call (never reused across redemptions)", async () => {
    mockConsume.mockResolvedValue(UNBOUND_IDENTITY as never);
    mockCreateUser.mockResolvedValue({ id: "user-new-1", name: "Ada", email: null, emailVerified: null, image: null } as never);

    const first = await redeemSignupToken("tok-1");
    const second = await redeemSignupToken("tok-2");

    if (first.kind !== "signed_up" || second.kind !== "signed_up") throw new Error("unreachable");
    expect(first.sessionToken).not.toBe(second.sessionToken);
  });

  it("runs owner-elect completion with the pre-mutation workspaceId captured from the consumed row, and the resolved userId", async () => {
    mockConsume.mockResolvedValue({ ...UNBOUND_IDENTITY, workspaceId: "ws-legacy-owner-elect" } as never);
    mockCreateUser.mockResolvedValue({ id: "user-new-1", name: "Ada", email: null, emailVerified: null, image: null } as never);
    mockCompleteOwnerElect.mockResolvedValue({ completed: true, workspaceName: "Acme" });
    mockBuildLine.mockReturnValue("You now own Acme.");

    const result = await redeemSignupToken("tok-abc");

    expect(mockCompleteOwnerElect).toHaveBeenCalledWith({
      workspaceId: "ws-legacy-owner-elect",
      userId: "user-new-1",
    });
    expect(result.kind).toBe("signed_up");
    if (result.kind !== "signed_up") throw new Error("unreachable");
    expect(result.ownerElectCompletionLine).toBe("You now own Acme.");
  });

  it("identity.workspaceId null: still calls completeConnectOwnerElect (its own contract is safe/no-op on null), and the completion line is null", async () => {
    mockConsume.mockResolvedValue(UNBOUND_IDENTITY as never);
    mockCreateUser.mockResolvedValue({ id: "user-new-1", name: "Ada", email: null, emailVerified: null, image: null } as never);

    const result = await redeemSignupToken("tok-abc");

    expect(mockCompleteOwnerElect).toHaveBeenCalledWith({ workspaceId: null, userId: "user-new-1" });
    expect(result.kind).toBe("signed_up");
    if (result.kind !== "signed_up") throw new Error("unreachable");
    expect(result.ownerElectCompletionLine).toBeNull();
  });

  it("fires the in-thread confirmation with the resolved chatIdentityId, accountLabel, and ownerElectCompletion", async () => {
    mockConsume.mockResolvedValue(UNBOUND_IDENTITY as never);
    mockCreateUser.mockResolvedValue({ id: "user-new-1", name: "Ada", email: null, emailVerified: null, image: null } as never);
    mockCompleteOwnerElect.mockResolvedValue({ completed: false, workspaceName: null });

    await redeemSignupToken("tok-abc");

    expect(mockSendConfirmation).toHaveBeenCalledWith({
      chatIdentityId: "chat-identity-1",
      accountLabel: "Ada",
      ownerElectCompletion: { completed: false, workspaceName: null },
    });
  });

  it("accountLabel falls back to 'there' when the identity has no displayName", async () => {
    mockConsume.mockResolvedValue({ ...UNBOUND_IDENTITY, displayName: null } as never);
    mockCreateUser.mockResolvedValue({ id: "user-new-1", name: null, email: null, emailVerified: null, image: null } as never);

    const result = await redeemSignupToken("tok-abc");

    expect(result.kind).toBe("signed_up");
    if (result.kind !== "signed_up") throw new Error("unreachable");
    expect(result.accountLabel).toBe("there");
  });

  it("never lets a failed/rejected confirmation send propagate out of redeemSignupToken", async () => {
    mockConsume.mockResolvedValue(UNBOUND_IDENTITY as never);
    mockCreateUser.mockResolvedValue({ id: "user-new-1", name: "Ada", email: null, emailVerified: null, image: null } as never);
    mockSendConfirmation.mockRejectedValue(new Error("telegram down"));

    await expect(redeemSignupToken("tok-abc")).resolves.toMatchObject({ kind: "signed_up" });
  });
});

// ---------------------------------------------------------------------------
// buildSignupActionOutcome — the Server Action's own decision logic, pulled
// out so it's testable without cookies()/redirect()/a real Next.js request
// (post-review anti-unfurl fix: page.tsx's Server Action is now the ONLY
// caller of redeemSignupToken's atomic consume; this is what it does with
// the result). Uses the REAL sessionCookieName/sessionCookieOptions (not
// mocked) — these are simple, deterministic, dependency-free, so letting
// them run for real keeps these assertions meaningful.
// ---------------------------------------------------------------------------

describe("buildSignupActionOutcome", () => {
  const SESSION_EXPIRES = new Date("2026-08-21T00:00:00Z");
  const SIGNED_UP_RESULT = {
    kind: "signed_up" as const,
    sessionToken: "session-tok-abc",
    sessionExpires: SESSION_EXPIRES,
    accountLabel: "Ada",
    ownerElectCompletionLine: null,
  };
  const EXPIRED_RESULT = { kind: "expired_or_used" as const };

  it("signed_up over http (dev): unprefixed cookie name, secure:false, redirects to the static complete page", () => {
    const outcome = buildSignupActionOutcome(SIGNED_UP_RESULT, "tok-abc", false);

    expect(outcome).toEqual({
      kind: "signed_up",
      cookie: {
        name: "authjs.session-token",
        value: "session-tok-abc",
        options: { httpOnly: true, sameSite: "lax", path: "/", secure: false, expires: SESSION_EXPIRES },
      },
      redirectTo: SIGNUP_COMPLETE_PATH,
    });
    expect(SIGNUP_COMPLETE_PATH).toBe("/signup/complete");
  });

  it("signed_up over https (production): __Secure- prefixed cookie name, secure:true", () => {
    const outcome = buildSignupActionOutcome(SIGNED_UP_RESULT, "tok-abc", true);

    expect(outcome.cookie).toEqual({
      name: "__Secure-authjs.session-token",
      value: "session-tok-abc",
      options: { httpOnly: true, sameSite: "lax", path: "/", secure: true, expires: SESSION_EXPIRES },
    });
  });

  it("expired_or_used: NO cookie field at all — never sets any cookie for a dead/replayed token", () => {
    const outcome = buildSignupActionOutcome(EXPIRED_RESULT, "dead-token", false);

    expect(outcome).toEqual({ kind: "expired_or_used", redirectTo: "/signup/dead-token" });
    expect(outcome.cookie).toBeUndefined();
  });

  it("expired_or_used redirects back to the SAME token's own /signup/<token> URL, not a distinct 'expired' route — the page's own precheck independently reaches the same verdict on re-render", () => {
    const outcome = buildSignupActionOutcome(EXPIRED_RESULT, "some-other-token-xyz", true);

    expect(outcome.redirectTo).toBe("/signup/some-other-token-xyz");
  });

  it("the cookie's session token value is exactly the one redeemSignupToken produced — never re-derived or truncated", () => {
    const outcome = buildSignupActionOutcome(
      { ...SIGNED_UP_RESULT, sessionToken: "a-totally-different-64-char-token" },
      "tok-abc",
      false
    );

    expect(outcome.cookie?.value).toBe("a-totally-different-64-char-token");
  });
});
