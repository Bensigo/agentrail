import { describe, expect, it } from "vitest";
import {
  resolveHostedBotUsername,
  telegramDeepLink,
  messageJaceTarget,
} from "./channel-step-helpers";

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

describe("messageJaceTarget (#1281 AC2 — Home/Work dead-end copy)", () => {
  const WORKSPACE_ID = "ws-123";

  it("deep-links the hosted shared bot directly when the env is set", () => {
    expect(messageJaceTarget("jace_bot", WORKSPACE_ID)).toEqual({
      href: "https://t.me/jace_bot",
      external: true,
    });
  });

  it("falls back to the setup wizard, workspace-scoped, when the env is unset (self-host default)", () => {
    expect(messageJaceTarget(undefined, WORKSPACE_ID)).toEqual({
      href: "/setup?workspace=ws-123",
      external: false,
    });
  });

  it("falls back to setup when the env is blank/whitespace, same as resolveHostedBotUsername", () => {
    expect(messageJaceTarget("   ", WORKSPACE_ID)).toEqual({
      href: "/setup?workspace=ws-123",
      external: false,
    });
  });

  it("Work's empty state and Home's digest card resolve identically for the same inputs (point the same way)", () => {
    const fromWork = messageJaceTarget("jace_bot", WORKSPACE_ID);
    const fromHome = messageJaceTarget("jace_bot", WORKSPACE_ID);
    expect(fromWork).toEqual(fromHome);
  });
});
