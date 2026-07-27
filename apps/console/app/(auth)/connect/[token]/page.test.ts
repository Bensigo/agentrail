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

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
}));

vi.mock("@agentrail/db-postgres", () => ({
  consumeChatIdentityLinkToken: vi.fn(),
  bindChatIdentityUser: vi.fn(),
  bindChatIdentityWorkspace: vi.fn(),
  listWorkspacesForUser: vi.fn(),
}));

import ConnectPage from "./page";
import { auth } from "@agentrail/auth";
import { consumeChatIdentityLinkToken } from "@agentrail/db-postgres";

const mockAuth = vi.mocked(auth);
const mockConsume = vi.mocked(consumeChatIdentityLinkToken);

interface ReactElementLike {
  type: unknown;
  props: Record<string, unknown>;
}

function asElement(node: unknown): ReactElementLike {
  return node as ReactElementLike;
}

const TOKEN = "connect-token-abc123";

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
