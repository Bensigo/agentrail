import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

import {
  sessionCookieName,
  sessionCookieOptions,
  resolveUseSecureCookiesFromHeaders,
} from "./session-cookie";
import { headers } from "next/headers";

const mockHeaders = vi.mocked(headers);

function fakeHeaders(values: Record<string, string>) {
  return {
    get: (name: string) => values[name.toLowerCase()] ?? null,
  } as unknown as Awaited<ReturnType<typeof headers>>;
}

describe("sessionCookieName", () => {
  it("no prefix over http (dev) — matches the verify-console-ui skill's documented dev cookie name", () => {
    expect(sessionCookieName(false)).toBe("authjs.session-token");
  });

  it("__Secure- prefix over https (production) — matches Auth.js's own useSecureCookies convention", () => {
    expect(sessionCookieName(true)).toBe("__Secure-authjs.session-token");
  });
});

describe("sessionCookieOptions", () => {
  it("httpOnly + sameSite=lax + path=/ always, secure mirrors useSecureCookies, expires passed through", () => {
    const expires = new Date("2026-08-21T00:00:00Z");

    expect(sessionCookieOptions(false, expires)).toEqual({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: false,
      expires,
    });

    expect(sessionCookieOptions(true, expires)).toEqual({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: true,
      expires,
    });
  });
});

describe("resolveUseSecureCookiesFromHeaders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("true when x-forwarded-proto is https (production, behind a proxy)", async () => {
    mockHeaders.mockResolvedValue(fakeHeaders({ "x-forwarded-proto": "https" }));
    expect(await resolveUseSecureCookiesFromHeaders()).toBe(true);
  });

  it("false when x-forwarded-proto is http", async () => {
    mockHeaders.mockResolvedValue(fakeHeaders({ "x-forwarded-proto": "http" }));
    expect(await resolveUseSecureCookiesFromHeaders()).toBe(false);
  });

  it("false when x-forwarded-proto is absent (local dev, no proxy in front of next dev)", async () => {
    mockHeaders.mockResolvedValue(fakeHeaders({}));
    expect(await resolveUseSecureCookiesFromHeaders()).toBe(false);
  });

  it("uses only the FIRST hop of a comma-separated x-forwarded-proto chain (the client-facing one)", async () => {
    mockHeaders.mockResolvedValue(fakeHeaders({ "x-forwarded-proto": "https, http" }));
    expect(await resolveUseSecureCookiesFromHeaders()).toBe(true);
  });

  it("is case-insensitive", async () => {
    mockHeaders.mockResolvedValue(fakeHeaders({ "x-forwarded-proto": "HTTPS" }));
    expect(await resolveUseSecureCookiesFromHeaders()).toBe(true);
  });
});
