import { describe, it, expect } from "vitest";
import { sessionCookieName, sessionCookieOptions } from "./session-cookie";

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
