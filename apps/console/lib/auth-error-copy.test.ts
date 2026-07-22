import { describe, it, expect } from "vitest";
import { authErrorCopy } from "./auth-error-copy";

describe("authErrorCopy (branded auth error mapping)", () => {
  it("speaks to a denied consent (AccessDenied) and reassures nothing changed", () => {
    const { title, body } = authErrorCopy("AccessDenied");
    expect(title).toMatch(/didn't finish/i);
    expect(body).toMatch(/nothing changed/i);
  });

  it("frames a Configuration failure as on our end", () => {
    const { body } = authErrorCopy("Configuration");
    expect(body).toMatch(/on us/i);
  });

  it("maps OAuthCallbackError to a GitHub-handoff message", () => {
    expect(authErrorCopy("OAuthCallbackError").title).toMatch(/github/i);
  });

  it("maps Verification to an expired-link message", () => {
    expect(authErrorCopy("Verification").title).toMatch(/expired/i);
  });

  it("falls back to the neutral default for unknown codes", () => {
    const fallback = authErrorCopy("SomethingBrandNew");
    expect(fallback).toEqual(authErrorCopy("Default"));
    expect(fallback.title).toMatch(/didn't work/i);
  });

  it("falls back to the default when no code is present", () => {
    expect(authErrorCopy(undefined)).toEqual(authErrorCopy(null));
    expect(authErrorCopy(undefined).title).toMatch(/didn't work/i);
  });

  it("never leaks a raw error code into the body copy", () => {
    for (const code of [
      "AccessDenied",
      "Configuration",
      "OAuthCallbackError",
      "Verification",
      "Default",
    ]) {
      expect(authErrorCopy(code).body).not.toContain(code);
      expect(authErrorCopy(code).body).not.toMatch(/error:/i);
    }
  });
});
