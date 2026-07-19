import { describe, expect, it } from "vitest";
import { resolveMessageJaceCta } from "./_cta";

describe("resolveMessageJaceCta", () => {
  it("resolves the Telegram deep-link CTA, built from the env helper, when the bot username is set", () => {
    const cta = resolveMessageJaceCta("jace_bot");
    expect(cta).toEqual({
      kind: "telegram",
      href: "https://t.me/jace_bot",
      botUsername: "jace_bot",
    });
  });

  it("trims a padded env value the same way the shared helper does", () => {
    const cta = resolveMessageJaceCta("  jace_bot  ");
    expect(cta.href).toBe("https://t.me/jace_bot");
  });

  it("falls back to sign-in (never a dead link) when the env var is undefined", () => {
    expect(resolveMessageJaceCta(undefined)).toEqual({ kind: "sign-in" });
  });

  it("falls back to sign-in when the env var is an empty string", () => {
    expect(resolveMessageJaceCta("")).toEqual({ kind: "sign-in" });
  });

  it("falls back to sign-in when the env var is whitespace only", () => {
    expect(resolveMessageJaceCta("   ")).toEqual({ kind: "sign-in" });
  });
});
