import { describe, it, expect, vi, beforeEach } from "vitest";

// This repo's vitest config runs with `environment: "node"` — there is no
// DOM/render harness. `SignupPage` is an async SERVER component with no
// hooks of its own, so calling it directly returns a plain React element
// tree (the JSX transform's output objects) we can walk via `.type`/`.props`
// without a renderer — same pattern as
// app/(dashboard)/dashboard/[workspaceId]/page.test.ts.
//
// THIS FILE'S REASON TO EXIST (post-review anti-unfurl fix): an earlier
// version of `/signup/[token]` was a Route Handler that consumed the
// single-use token on a bare GET — which is exactly what Telegram/Slack/
// Discord's link-preview unfurl fetchers, browser prefetch, and corporate
// link scanners issue, BEFORE any human clicks. That burned the token
// before the real click, so the feature failed almost every time it was
// actually used over its real delivery channel. The FIRST test below is the
// explicit, first-class regression test for that: calling the page (the
// GET-render path) must NEVER call the atomic consume.

vi.mock("@agentrail/db-postgres", () => ({
  findChatIdentityBySignupToken: vi.fn(),
}));

// Partial mock: keep `buildSignupActionOutcome` REAL (it's pure and already
// has its own full test suite in signup-redeem.test.ts) — only
// `redeemSignupToken` (the DB-side-effecting atomic consume) is replaced,
// so this file's assertions exercise the REAL wiring between "what the
// action does" and "what buildSignupActionOutcome decides", not a
// re-implementation of it.
vi.mock("../../../../lib/signup-redeem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../lib/signup-redeem")>();
  return { ...actual, redeemSignupToken: vi.fn() };
});

// Partial mock, same reasoning: keep `sessionCookieName`/`sessionCookieOptions`
// REAL (buildSignupActionOutcome depends on them internally) — only
// `resolveUseSecureCookiesFromHeaders` (headers()-dependent) is replaced.
vi.mock("../../../../lib/session-cookie", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../lib/session-cookie")>();
  return { ...actual, resolveUseSecureCookiesFromHeaders: vi.fn() };
});

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

import SignupPage from "./page";
import { findChatIdentityBySignupToken } from "@agentrail/db-postgres";
import { redeemSignupToken } from "../../../../lib/signup-redeem";
import { resolveUseSecureCookiesFromHeaders } from "../../../../lib/session-cookie";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const mockPrecheck = vi.mocked(findChatIdentityBySignupToken);
const mockRedeem = vi.mocked(redeemSignupToken);
const mockUseSecureCookies = vi.mocked(resolveUseSecureCookiesFromHeaders);
const mockCookies = vi.mocked(cookies);
const mockRedirect = vi.mocked(redirect);

interface ReactElementLike {
  type: unknown;
  props: Record<string, unknown>;
}

function asElement(node: unknown): ReactElementLike {
  return node as ReactElementLike;
}

const TOKEN = "signup-token-abc123";

const MOCK_IDENTITY = {
  id: "chat-identity-1",
  platform: "telegram",
  platformUserId: "tg-123",
  displayName: "Ada",
  userId: null,
  workspaceId: null,
  linkToken: null,
  linkTokenExpiresAt: null,
  signupToken: TOKEN,
  signupTokenExpiresAt: new Date("2026-08-01T00:00:00Z"),
  createdAt: new Date("2026-07-22T00:00:00Z"),
  updatedAt: new Date("2026-07-22T00:00:00Z"),
};

async function renderPage() {
  return asElement(await SignupPage({ params: Promise.resolve({ token: TOKEN }) }));
}

/** Extract the `<form>` element from the "finish signing up" render. */
function findForm(root: ReactElementLike): ReactElementLike {
  const children = root.props.children as ReactElementLike[];
  const form = children.find((c) => c?.type === "form");
  if (!form) throw new Error("no <form> found in the rendered page — did the render branch change?");
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCookies.mockResolvedValue({
    set: vi.fn(),
  } as unknown as Awaited<ReturnType<typeof cookies>>);
});

describe("SignupPage — GET render (anti-unfurl regression, issue #1364)", () => {
  it("FIRST-CLASS REGRESSION: rendering the page (the GET path) NEVER calls the atomic consume — only the non-consuming precheck", async () => {
    mockPrecheck.mockResolvedValue(MOCK_IDENTITY as never);

    await renderPage();

    expect(mockPrecheck).toHaveBeenCalledWith(TOKEN);
    expect(mockRedeem).not.toHaveBeenCalled();
  });

  it("a token an unfurl bot 'GETs' 5 times in a row is still valid: 5 renders, still zero consumes", async () => {
    mockPrecheck.mockResolvedValue(MOCK_IDENTITY as never);

    await renderPage();
    await renderPage();
    await renderPage();
    await renderPage();
    await renderPage();

    expect(mockPrecheck).toHaveBeenCalledTimes(5);
    expect(mockRedeem).not.toHaveBeenCalled();
  });

  it("valid token: renders the 'finish signing up' form, not the expired message", async () => {
    mockPrecheck.mockResolvedValue(MOCK_IDENTITY as never);

    const root = await renderPage();

    expect(root.type).toBe("main");
    const form = findForm(root);
    expect(typeof form.props.action).toBe("function");
  });

  it("dead/unknown token (precheck returns null): renders the expired message, no form, still never consumes", async () => {
    mockPrecheck.mockResolvedValue(null);

    const root = await renderPage();

    expect(root.props.title).toBe("Link expired or already used");
    expect(root.props.body).toBe("Ask Jace for a fresh sign-up link in the chat.");
    expect(mockRedeem).not.toHaveBeenCalled();
  });
});

describe("SignupPage — the Server Action (button press, the ONLY path that may consume)", () => {
  it("success: sets the cookie via cookies().set(...) with the exact name/value/options buildSignupActionOutcome computes, then redirects to /signup/complete", async () => {
    mockPrecheck.mockResolvedValue(MOCK_IDENTITY as never);
    const sessionExpires = new Date("2026-08-21T00:00:00Z");
    mockRedeem.mockResolvedValue({
      kind: "signed_up",
      sessionToken: "minted-session-token",
      sessionExpires,
      accountLabel: "Ada",
      ownerElectCompletionLine: null,
    });
    mockUseSecureCookies.mockResolvedValue(false);
    const setSpy = vi.fn();
    mockCookies.mockResolvedValue({ set: setSpy } as unknown as Awaited<ReturnType<typeof cookies>>);

    const root = await renderPage();
    const form = findForm(root);
    await (form.props.action as () => Promise<void>)();

    expect(mockRedeem).toHaveBeenCalledWith(TOKEN);
    expect(setSpy).toHaveBeenCalledWith(
      "authjs.session-token",
      "minted-session-token",
      { httpOnly: true, sameSite: "lax", path: "/", secure: false, expires: sessionExpires }
    );
    expect(mockRedirect).toHaveBeenCalledWith("/signup/complete");
  });

  it("success over https: sets the __Secure--prefixed cookie with secure:true", async () => {
    mockPrecheck.mockResolvedValue(MOCK_IDENTITY as never);
    mockRedeem.mockResolvedValue({
      kind: "signed_up",
      sessionToken: "minted-session-token",
      sessionExpires: new Date("2026-08-21T00:00:00Z"),
      accountLabel: "Ada",
      ownerElectCompletionLine: null,
    });
    mockUseSecureCookies.mockResolvedValue(true);
    const setSpy = vi.fn();
    mockCookies.mockResolvedValue({ set: setSpy } as unknown as Awaited<ReturnType<typeof cookies>>);

    const root = await renderPage();
    const form = findForm(root);
    await (form.props.action as () => Promise<void>)();

    const [cookieName, , cookieOptions] = setSpy.mock.calls[0] as [string, string, { secure: boolean }];
    expect(cookieName).toBe("__Secure-authjs.session-token");
    expect(cookieOptions.secure).toBe(true);
  });

  it("expired/used (e.g. a race with a concurrent redemption between the precheck and the click): sets NO cookie, redirects back to /signup/<token>", async () => {
    mockPrecheck.mockResolvedValue(MOCK_IDENTITY as never);
    mockRedeem.mockResolvedValue({ kind: "expired_or_used" });
    mockUseSecureCookies.mockResolvedValue(false);
    const setSpy = vi.fn();
    mockCookies.mockResolvedValue({ set: setSpy } as unknown as Awaited<ReturnType<typeof cookies>>);

    const root = await renderPage();
    const form = findForm(root);
    await (form.props.action as () => Promise<void>)();

    expect(setSpy).not.toHaveBeenCalled();
    expect(mockRedirect).toHaveBeenCalledWith(`/signup/${TOKEN}`);
  });

  it("the action calls redeemSignupToken with the EXACT token from the URL — no other identity input exists (AC3)", async () => {
    mockPrecheck.mockResolvedValue(MOCK_IDENTITY as never);
    mockRedeem.mockResolvedValue({ kind: "expired_or_used" });
    mockUseSecureCookies.mockResolvedValue(false);

    const root = await renderPage();
    const form = findForm(root);
    await (form.props.action as () => Promise<void>)();

    expect(mockRedeem).toHaveBeenCalledExactlyOnceWith(TOKEN);
  });
});
