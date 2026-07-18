import { describe, expect, it } from "vitest";
import { resolveHostedBotUsername, telegramDeepLink } from "./channel-step-helpers";

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
