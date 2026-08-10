import { describe, expect, it } from "vitest";
import { PANELS } from "./_channels";

describe("landing integration panels", () => {
  it("leads with MCP-compatible coding agents", () => {
    expect(PANELS[0]).toEqual({
      id: "coding-agents",
      name: "Coding agents",
      line: "Connect Jace to your MCP-compatible coding agent.",
      buttonLabel: "Add Jace to your project",
    });
  });

  it("keeps chat channels secondary and does not claim named agent support", () => {
    expect(PANELS.map(({ id }) => id)).toEqual([
      "coding-agents",
      "slack",
      "discord",
      "telegram",
    ]);
    expect(PANELS.map(({ line }) => line).join(" ")).not.toMatch(/Codex|Claude Code/i);
  });
});
