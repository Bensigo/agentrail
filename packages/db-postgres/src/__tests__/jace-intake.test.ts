import { describe, it, expect, vi } from "vitest";

// The db module is mocked so importing the query module is side-effect free; the
// kill-switch gate under test is pure and never touches it.
vi.mock("../db.js", () => ({ db: {} }));

import {
  jaceInboundAllowed,
  jaceOwnsTelegramNotify,
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
