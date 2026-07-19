import { describe, expect, it } from "vitest";
import { resolveHostedBotUsername, telegramDeepLink } from "./telegram-bot";

// Canonical-location coverage for the functions lifted out of the setup
// wizard's channel-step-helpers.ts (#1279 PR ①). channel-step-helpers.test.ts
// keeps its own pre-existing coverage untouched (zero churn) — this file is
// the new source of truth now that both the wizard's channel step AND the
// landing page's Message-Jace CTA depend on this module.

describe("resolveHostedBotUsername", () => {
  it("is null when the env var is undefined (self-host default)", () => {
    expect(resolveHostedBotUsername(undefined)).toBeNull();
  });

  it("is null when the env var is an empty string", () => {
    expect(resolveHostedBotUsername("")).toBeNull();
  });

  it("is null when the env var is whitespace only", () => {
    expect(resolveHostedBotUsername("   ")).toBeNull();
  });

  it("returns the trimmed username when set", () => {
    expect(resolveHostedBotUsername("  jace_bot  ")).toBe("jace_bot");
  });
});

describe("telegramDeepLink", () => {
  it("builds a t.me deep link for the bot username", () => {
    expect(telegramDeepLink("jace_bot")).toBe("https://t.me/jace_bot");
  });
});
