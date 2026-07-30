import { describe, it, expect, vi, beforeEach } from "vitest";

// This repo's vitest config runs with `environment: "node"` — there is no
// DOM/render harness. `ConnectPage` is an async SERVER component with no
// hooks of its own, so calling it directly returns a plain React element
// tree (the JSX transform's output objects) we can walk via `.type`/`.props`
// without a renderer — same pattern as
// app/(auth)/signup/[token]/page.test.ts.
//
// THIS FILE'S REASON TO EXIST: the signed-out early return (line ~31) MUST
// run before `consumeChatIdentityLinkToken` (line ~90) — Telegram unfurls
// links in chat, unauthenticated, and a link-preview crawler is never signed
// in. If a refactor ever reordered those two, every connect link would burn
// on unfurl before the human ever tapped it, and the user's very first
// attempt would show "Link expired or already used." Nothing else in the
// codebase currently guards that order — this test is the guard.
//
// The "seat collapse on fresh bind" describe block below (slice 4 Task 4)
// extends this same file rather than adding a new one: exercising it needs
// the full signed-in + valid-token render path this file already sets up.

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
}));

vi.mock("@agentrail/db-postgres", () => ({
  consumeChatIdentityLinkToken: vi.fn(),
  bindChatIdentityUser: vi.fn(),
  bindChatIdentityWorkspace: vi.fn(),
  listWorkspacesForUser: vi.fn(),
  collapseIdentitySeatsForUser: vi.fn(),
  db: {},
}));

import ConnectPage from "./page";
import { auth } from "@agentrail/auth";
import {
  consumeChatIdentityLinkToken,
  bindChatIdentityUser,
  bindChatIdentityWorkspace,
  listWorkspacesForUser,
  collapseIdentitySeatsForUser,
  db,
} from "@agentrail/db-postgres";

const mockAuth = vi.mocked(auth);
const mockConsume = vi.mocked(consumeChatIdentityLinkToken);
const mockBind = vi.mocked(bindChatIdentityUser);
const mockBindWorkspace = vi.mocked(bindChatIdentityWorkspace);
const mockListWorkspaces = vi.mocked(listWorkspacesForUser);
const mockCollapse = vi.mocked(collapseIdentitySeatsForUser);

interface ReactElementLike {
  type: unknown;
  props: Record<string, unknown>;
}

function asElement(node: unknown): ReactElementLike {
  return node as ReactElementLike;
}

const TOKEN = "connect-token-abc123";
const SESSION_USER_ID = "user-1";

// A never-before-linked identity — `userId: null` is what drives
// decideConnectIdentityBind (connect-bind-decision.ts) to `fresh_bind`, the
// ONLY branch that calls bindChatIdentityUser and, per this task, the seat
// collapse hooked immediately after it. `workspaceId: null` keeps
// completeConnectOwnerElect a zero-DB-call no-op (see
// connect-owner-elect-completion.ts's own `input.workspaceId == null` guard)
// so these tests stay focused on the collapse hook instead of incidentally
// exercising owner-elect completion too.
const MOCK_IDENTITY = {
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
  createdAt: new Date("2026-07-22T00:00:00Z"),
  updatedAt: new Date("2026-07-22T00:00:00Z"),
};

// Exactly ONE membership — decideConnectWorkspaceBind (connect-bind-decision.ts)
// only returns `{ action: "bind" }` for a single unambiguous membership (zero
// means nothing to bind to, two+ means ambiguous and skipped). This is what
// makes `bindChatIdentityWorkspace` actually fire in the tests below, which
// is the whole point: proving the seat-collapse hook's outcome doesn't
// disturb the workspace-bind step that runs right after it.
const MOCK_MEMBERSHIP = {
  id: "workspace-1",
  name: "Acme",
  slug: "acme",
  createdAt: new Date("2026-07-01T00:00:00Z"),
  updatedAt: new Date("2026-07-01T00:00:00Z"),
  role: "member" as const,
};

async function renderPage() {
  return asElement(await ConnectPage({ params: Promise.resolve({ token: TOKEN }) }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ConnectPage — signed-out render (anti-unfurl regression, #1263)", () => {
  it("FIRST-CLASS REGRESSION: no session means the sign-in screen renders and the atomic consume is NEVER called", async () => {
    mockAuth.mockResolvedValue(null as never);

    const root = await renderPage();

    expect(root.type).toBe("main");
    expect(mockConsume).not.toHaveBeenCalled();
  });

  it("a token an unfurl bot 'GETs' 5 times in a row while signed out is still valid: 5 renders, still zero consumes", async () => {
    mockAuth.mockResolvedValue(null as never);

    await renderPage();
    await renderPage();
    await renderPage();
    await renderPage();
    await renderPage();

    expect(mockAuth).toHaveBeenCalledTimes(5);
    expect(mockConsume).not.toHaveBeenCalled();
  });

  it("a session with no user.id (edge shape) is treated as signed out: still never consumes", async () => {
    mockAuth.mockResolvedValue({ user: {} } as never);

    await renderPage();

    expect(mockConsume).not.toHaveBeenCalled();
  });
});

// Slice 4 Task 4 — spec §5 rule 3 / §5.3's "linking nudge" made real: a
// freshly-bound identity's identity-seats collapse into the signed-in user's
// seat. Only `fresh_bind` calls `bindChatIdentityUser` (see
// connect-bind-decision.ts's own doc-comment on `already_yours` skipping it
// as a same-value no-op), so that is the only branch under test here.
describe("ConnectPage — seat collapse on fresh bind (slice 4 Task 4, spec §5 rule 3 / §5.3)", () => {
  beforeEach(() => {
    mockAuth.mockResolvedValue({ user: { id: SESSION_USER_ID } } as never);
    mockConsume.mockResolvedValue(MOCK_IDENTITY as never);
    // Exactly one membership so decideConnectWorkspaceBind resolves to
    // `{ action: "bind" }` and bindChatIdentityWorkspace actually runs in
    // every test below — see MOCK_MEMBERSHIP's own doc-comment.
    mockListWorkspaces.mockResolvedValue([MOCK_MEMBERSHIP] as never);
  });

  it("successful bind: collapses seats with exactly {chatIdentityId, userId} against the shared db handle, and the workspace-bind step that follows still runs", async () => {
    mockBind.mockResolvedValue(undefined);
    mockCollapse.mockResolvedValue(undefined);

    const root = await renderPage();

    expect(mockBind).toHaveBeenCalledWith(MOCK_IDENTITY.id, SESSION_USER_ID);
    expect(mockCollapse).toHaveBeenCalledExactlyOnceWith(db, {
      chatIdentityId: MOCK_IDENTITY.id,
      userId: SESSION_USER_ID,
    });
    expect(mockBindWorkspace).toHaveBeenCalledExactlyOnceWith(
      MOCK_IDENTITY.id,
      MOCK_MEMBERSHIP.id
    );
    expect(root.type).toBe("main");
  });

  it("collapse rejects: the bind already recorded stays recorded, the page still renders success (no throw), the failure is logged loudly with a namespaced prefix rather than swallowed silently, AND the workspace-bind step still runs after it with the same args as the success case — proof the collapse's outcome doesn't disturb what follows", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockBind.mockResolvedValue(undefined);
    mockCollapse.mockRejectedValue(new Error("seats table is on fire"));

    const root = await renderPage();

    expect(mockBind).toHaveBeenCalledWith(MOCK_IDENTITY.id, SESSION_USER_ID);
    expect(mockCollapse).toHaveBeenCalledExactlyOnceWith(db, {
      chatIdentityId: MOCK_IDENTITY.id,
      userId: SESSION_USER_ID,
    });
    expect(mockBindWorkspace).toHaveBeenCalledExactlyOnceWith(
      MOCK_IDENTITY.id,
      MOCK_MEMBERSHIP.id
    );
    expect(root.type).toBe("main");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[connect]"),
      expect.anything()
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("collapseIdentitySeatsForUser"),
      expect.anything()
    );
  });

  it("bind fails: the collapse hook is never reached, and the whole render rejects before the (unrelated) workspace-bind step below it too", async () => {
    mockBind.mockRejectedValue(new Error("bind boom"));

    await expect(renderPage()).rejects.toThrow("bind boom");

    expect(mockCollapse).not.toHaveBeenCalled();
    expect(mockBindWorkspace).not.toHaveBeenCalled();
  });
});
