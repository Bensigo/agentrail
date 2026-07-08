import { describe, it, expect, vi } from "vitest";

// The db module is mocked so importing the query module is side-effect free; the
// kill-switch gate under test is pure and never touches it.
vi.mock("../db.js", () => ({ db: {} }));

import {
  jaceInboundAllowed,
  jaceOwnsTelegramNotify,
  jaceOwnsDiscordNotify,
  jaceOwnsSlackNotify,
} from "../queries/jace_intake.js";

/**
 * The Jace kill switch (AC4): inbound Jace conversations proceed iff a `jace`
 * connector row exists AND it is enabled. Disabling the jace connector HALTS
 * inbound Jace, while the AgentRail factory — a SEPARATE `github` provider row —
 * is untouched, so already-queued issues keep running.
 */
describe("jaceInboundAllowed (kill switch)", () => {
  it("allows inbound when the jace connector is enabled", () => {
    const result = jaceInboundAllowed({ provider: "jace", enabled: true });
    expect(result.allowed).toBe(true);
  });

  it("HALTS inbound when the jace connector is disabled (the kill switch)", () => {
    const result = jaceInboundAllowed({ provider: "jace", enabled: false });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toMatch(/disabled/);
  });

  it("HALTS inbound when there is no jace connector row (null)", () => {
    const result = jaceInboundAllowed(null);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toMatch(/no jace connector/);
  });

  it("HALTS inbound when there is no jace connector row (undefined)", () => {
    const result = jaceInboundAllowed(undefined);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toMatch(/no jace connector/);
  });

  it("HALTS inbound for a wrong-provider row (the factory's github row)", () => {
    // AC4: the factory is a SEPARATE `github` provider row. It never satisfies
    // the jace gate, so the kill switch reasons only about the `jace` row and
    // toggling jace cannot admit — or block — factory intake.
    const result = jaceInboundAllowed({ provider: "github", enabled: true });
    expect(result.allowed).toBe(false);
  });
});

/**
 * Outbound Telegram routing (#1047, AC1). Jace owns the outbound channel — so a
 * terminal run outcome is delivered THROUGH Jace instead of the legacy sender —
 * iff a `jace` connector is enabled AND `config.telegramNotify` is explicitly
 * opted in. Default OFF keeps the legacy path, so the migration never goes dark
 * or double-fires before per-workspace cutover.
 */
describe("jaceOwnsTelegramNotify (outbound route)", () => {
  it("owns Telegram when the jace connector is enabled AND opted in", () => {
    expect(
      jaceOwnsTelegramNotify({
        provider: "jace",
        enabled: true,
        config: { telegramNotify: true },
      })
    ).toBe(true);
  });

  it("does NOT own Telegram when opted in but the connector is DISABLED (kill switch reverts to legacy)", () => {
    expect(
      jaceOwnsTelegramNotify({
        provider: "jace",
        enabled: false,
        config: { telegramNotify: true },
      })
    ).toBe(false);
  });

  it("does NOT own Telegram when enabled but the opt-in is OFF (default, pre-cutover)", () => {
    expect(
      jaceOwnsTelegramNotify({
        provider: "jace",
        enabled: true,
        config: { telegramNotify: false },
      })
    ).toBe(false);
  });

  it("does NOT own Telegram when enabled but the opt-in is ABSENT (default)", () => {
    expect(
      jaceOwnsTelegramNotify({ provider: "jace", enabled: true, config: {} })
    ).toBe(false);
    expect(
      jaceOwnsTelegramNotify({ provider: "jace", enabled: true })
    ).toBe(false);
  });

  it("does NOT own Telegram for a wrong-provider row even if it carries the flag", () => {
    expect(
      jaceOwnsTelegramNotify({
        provider: "telegram",
        enabled: true,
        config: { telegramNotify: true },
      })
    ).toBe(false);
  });

  it("does NOT own Telegram for a null / undefined connector", () => {
    expect(jaceOwnsTelegramNotify(null)).toBe(false);
    expect(jaceOwnsTelegramNotify(undefined)).toBe(false);
  });
});

/**
 * Outbound Discord routing (#1050). Same contract as Telegram, keyed on the
 * Discord opt-in: Jace owns Discord outbound iff a `jace` connector is enabled AND
 * `config.discordNotify` is explicitly true. Default OFF reverts to the legacy
 * Discord webhook sender, so the migration never goes dark or double-fires.
 */
describe("jaceOwnsDiscordNotify (outbound route)", () => {
  it("owns Discord when the jace connector is enabled AND opted in", () => {
    expect(
      jaceOwnsDiscordNotify({
        provider: "jace",
        enabled: true,
        config: { discordNotify: true },
      })
    ).toBe(true);
  });

  it("does NOT own Discord when opted in but the connector is DISABLED (kill switch reverts to legacy)", () => {
    expect(
      jaceOwnsDiscordNotify({
        provider: "jace",
        enabled: false,
        config: { discordNotify: true },
      })
    ).toBe(false);
  });

  it("does NOT own Discord when enabled but the opt-in is OFF (default, pre-cutover)", () => {
    expect(
      jaceOwnsDiscordNotify({
        provider: "jace",
        enabled: true,
        config: { discordNotify: false },
      })
    ).toBe(false);
  });

  it("does NOT own Discord when enabled but the opt-in is ABSENT (default)", () => {
    expect(
      jaceOwnsDiscordNotify({ provider: "jace", enabled: true, config: {} })
    ).toBe(false);
    expect(
      jaceOwnsDiscordNotify({ provider: "jace", enabled: true })
    ).toBe(false);
  });

  it("does NOT own Discord when only the telegram opt-in is set (channels are independent)", () => {
    expect(
      jaceOwnsDiscordNotify({
        provider: "jace",
        enabled: true,
        config: { telegramNotify: true },
      })
    ).toBe(false);
  });

  it("does NOT own Discord for a wrong-provider row even if it carries the flag", () => {
    expect(
      jaceOwnsDiscordNotify({
        provider: "discord",
        enabled: true,
        config: { discordNotify: true },
      })
    ).toBe(false);
  });

  it("does NOT own Discord for a null / undefined connector", () => {
    expect(jaceOwnsDiscordNotify(null)).toBe(false);
    expect(jaceOwnsDiscordNotify(undefined)).toBe(false);
  });
});

/**
 * Outbound Slack routing (#1050). Slack is GREENFIELD — a `false` result means
 * "no Slack notification", not "fall back to a legacy path". Jace owns Slack
 * outbound iff a `jace` connector is enabled AND `config.slackNotify` is
 * explicitly true. Default OFF.
 */
describe("jaceOwnsSlackNotify (outbound route)", () => {
  it("owns Slack when the jace connector is enabled AND opted in", () => {
    expect(
      jaceOwnsSlackNotify({
        provider: "jace",
        enabled: true,
        config: { slackNotify: true },
      })
    ).toBe(true);
  });

  it("does NOT own Slack when opted in but the connector is DISABLED (kill switch)", () => {
    expect(
      jaceOwnsSlackNotify({
        provider: "jace",
        enabled: false,
        config: { slackNotify: true },
      })
    ).toBe(false);
  });

  it("does NOT own Slack when enabled but the opt-in is OFF / ABSENT (default)", () => {
    expect(
      jaceOwnsSlackNotify({
        provider: "jace",
        enabled: true,
        config: { slackNotify: false },
      })
    ).toBe(false);
    expect(
      jaceOwnsSlackNotify({ provider: "jace", enabled: true, config: {} })
    ).toBe(false);
    expect(jaceOwnsSlackNotify({ provider: "jace", enabled: true })).toBe(false);
  });

  it("does NOT own Slack when only another channel's opt-in is set (channels are independent)", () => {
    expect(
      jaceOwnsSlackNotify({
        provider: "jace",
        enabled: true,
        config: { discordNotify: true },
      })
    ).toBe(false);
  });

  it("does NOT own Slack for a wrong-provider row even if it carries the flag", () => {
    expect(
      jaceOwnsSlackNotify({
        provider: "slack",
        enabled: true,
        config: { slackNotify: true },
      })
    ).toBe(false);
  });

  it("does NOT own Slack for a null / undefined connector", () => {
    expect(jaceOwnsSlackNotify(null)).toBe(false);
    expect(jaceOwnsSlackNotify(undefined)).toBe(false);
  });
});
