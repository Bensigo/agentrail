import { describe, it, expect } from "vitest";
import { isConsoleChatEnabled } from "./feature-flags";

describe("isConsoleChatEnabled: off by default (the safety seam)", () => {
  it("neither env var set -> disabled for a normal workspace", () => {
    expect(isConsoleChatEnabled("ws-1", {})).toBe(false);
  });

  it("neither env var set -> disabled even with no workspaceId at all", () => {
    expect(isConsoleChatEnabled(undefined, {})).toBe(false);
    expect(isConsoleChatEnabled(null, {})).toBe(false);
  });

  it("an empty-string env value is treated as unset (disabled)", () => {
    expect(
      isConsoleChatEnabled("ws-1", {
        CONSOLE_CHAT_ENABLED: "",
        CONSOLE_CHAT_WORKSPACES: "",
      })
    ).toBe(false);
  });
});

describe("isConsoleChatEnabled: global switch", () => {
  it("CONSOLE_CHAT_ENABLED=true enables every workspace", () => {
    expect(isConsoleChatEnabled("ws-1", { CONSOLE_CHAT_ENABLED: "true" })).toBe(true);
    expect(isConsoleChatEnabled("ws-anything-else", { CONSOLE_CHAT_ENABLED: "true" })).toBe(true);
  });

  it("CONSOLE_CHAT_ENABLED=1 also enables (numeric truthy form)", () => {
    expect(isConsoleChatEnabled("ws-1", { CONSOLE_CHAT_ENABLED: "1" })).toBe(true);
  });

  it("is case-insensitive for the 'true' form", () => {
    expect(isConsoleChatEnabled("ws-1", { CONSOLE_CHAT_ENABLED: "TRUE" })).toBe(true);
  });

  it("any other value (e.g. 'false', 'yes', '0') does not enable the global switch", () => {
    for (const value of ["false", "yes", "0", "off"]) {
      expect(isConsoleChatEnabled("ws-1", { CONSOLE_CHAT_ENABLED: value })).toBe(false);
    }
  });
});

describe("isConsoleChatEnabled: per-workspace allowlist (additive to the global switch)", () => {
  it("enables only the listed workspace(s) when the global switch is off", () => {
    const env = { CONSOLE_CHAT_WORKSPACES: "ws-1,ws-2" };
    expect(isConsoleChatEnabled("ws-1", env)).toBe(true);
    expect(isConsoleChatEnabled("ws-2", env)).toBe(true);
    expect(isConsoleChatEnabled("ws-3", env)).toBe(false);
  });

  it("tolerates whitespace around comma-separated ids", () => {
    const env = { CONSOLE_CHAT_WORKSPACES: " ws-1 , ws-2 ,ws-3" };
    expect(isConsoleChatEnabled("ws-2", env)).toBe(true);
    expect(isConsoleChatEnabled("ws-3", env)).toBe(true);
  });

  it("a workspace not in the list stays disabled, even with an otherwise-non-empty allowlist", () => {
    expect(isConsoleChatEnabled("ws-unlisted", { CONSOLE_CHAT_WORKSPACES: "ws-1" })).toBe(false);
  });

  it("with no workspaceId, the allowlist alone never enables it (nothing to match against)", () => {
    expect(isConsoleChatEnabled(undefined, { CONSOLE_CHAT_WORKSPACES: "ws-1" })).toBe(false);
  });

  it("the global switch wins even if the allowlist doesn't include the workspace", () => {
    expect(
      isConsoleChatEnabled("ws-not-listed", {
        CONSOLE_CHAT_ENABLED: "true",
        CONSOLE_CHAT_WORKSPACES: "ws-other",
      })
    ).toBe(true);
  });
});

describe("isConsoleChatEnabled: defaults to reading the real process.env when no env override is given", () => {
  it("does not throw when called with only a workspaceId (exercises the process.env default param)", () => {
    expect(() => isConsoleChatEnabled("ws-1")).not.toThrow();
  });
});
