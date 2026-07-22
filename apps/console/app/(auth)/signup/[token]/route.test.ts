import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("../../../../lib/signup-redeem", () => ({
  redeemSignupToken: vi.fn(),
}));

import { GET } from "./route";
import { redeemSignupToken } from "../../../../lib/signup-redeem";

const mockRedeem = vi.mocked(redeemSignupToken);

function req(url: string): NextRequest {
  return new NextRequest(url, { method: "GET" });
}

function params(token: string) {
  return { params: Promise.resolve({ token }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /signup/[token]", () => {
  it("passes the token straight through to redeemSignupToken, unmodified", async () => {
    mockRedeem.mockResolvedValue({ kind: "expired_or_used" });

    await GET(req("http://localhost/signup/exact-token-value"), params("exact-token-value"));

    expect(mockRedeem).toHaveBeenCalledWith("exact-token-value");
  });

  it("expired_or_used: 200 with the expired/used message, and sets NO cookie", async () => {
    mockRedeem.mockResolvedValue({ kind: "expired_or_used" });

    const res = await GET(req("http://localhost/signup/stale-token"), params("stale-token"));
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("Link expired or already used");
    expect(html).toContain("Ask Jace for a fresh sign-up link in the chat.");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("signed_up over http (dev): sets the UNPREFIXED authjs.session-token cookie", async () => {
    const sessionExpires = new Date("2026-08-21T00:00:00Z");
    mockRedeem.mockResolvedValue({
      kind: "signed_up",
      sessionToken: "session-token-value",
      sessionExpires,
      accountLabel: "Ada",
      ownerElectCompletionLine: null,
    });

    const res = await GET(req("http://localhost/signup/tok-abc"), params("tok-abc"));

    expect(res.status).toBe(200);
    const cookie = res.cookies.get("authjs.session-token");
    expect(cookie?.value).toBe("session-token-value");
    expect(res.cookies.get("__Secure-authjs.session-token")).toBeUndefined();

    const setCookieHeader = res.headers.get("set-cookie") ?? "";
    expect(setCookieHeader).toContain("HttpOnly");
    expect(setCookieHeader).toContain("SameSite=lax");
    expect(setCookieHeader).not.toContain("Secure");
  });

  it("signed_up over https (production): sets the __Secure-prefixed cookie with the Secure flag", async () => {
    mockRedeem.mockResolvedValue({
      kind: "signed_up",
      sessionToken: "session-token-value",
      sessionExpires: new Date("2026-08-21T00:00:00Z"),
      accountLabel: "Ada",
      ownerElectCompletionLine: null,
    });

    const res = await GET(req("https://heyjace.com/signup/tok-abc"), params("tok-abc"));

    const cookie = res.cookies.get("__Secure-authjs.session-token");
    expect(cookie?.value).toBe("session-token-value");
    expect(res.cookies.get("authjs.session-token")).toBeUndefined();

    const setCookieHeader = res.headers.get("set-cookie") ?? "";
    expect(setCookieHeader).toContain("Secure");
    expect(setCookieHeader).toContain("HttpOnly");
  });

  it("signed_up with no owner-elect completion: shows the 'ask Jace to set up your workspace' invitation", async () => {
    mockRedeem.mockResolvedValue({
      kind: "signed_up",
      sessionToken: "tok",
      sessionExpires: new Date("2026-08-21T00:00:00Z"),
      accountLabel: "Ada",
      ownerElectCompletionLine: null,
    });

    const res = await GET(req("http://localhost/signup/tok-abc"), params("tok-abc"));
    const html = await res.text();

    expect(html).toContain("You're signed up");
    expect(html).toContain("ask Jace to set up your workspace");
  });

  it("signed_up WITH an owner-elect completion line: shows that line instead of the generic invitation", async () => {
    mockRedeem.mockResolvedValue({
      kind: "signed_up",
      sessionToken: "tok",
      sessionExpires: new Date("2026-08-21T00:00:00Z"),
      accountLabel: "Ada",
      ownerElectCompletionLine: "You now own Acme.",
    });

    const res = await GET(req("http://localhost/signup/tok-abc"), params("tok-abc"));
    const html = await res.text();

    expect(html).toContain("You now own Acme.");
    expect(html).not.toContain("ask Jace to set up your workspace");
  });

  it("escapes HTML-significant characters in rendered text (defensive; current inputs are all server-authored, never redeemer-influenced)", async () => {
    mockRedeem.mockResolvedValue({
      kind: "signed_up",
      sessionToken: "tok",
      sessionExpires: new Date("2026-08-21T00:00:00Z"),
      accountLabel: "Ada",
      ownerElectCompletionLine: "You now own <script>alert(1)</script>.",
    });

    const res = await GET(req("http://localhost/signup/tok-abc"), params("tok-abc"));
    const html = await res.text();

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
