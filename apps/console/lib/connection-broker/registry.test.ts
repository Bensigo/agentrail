import { describe, expect, it } from "vitest";
import {
  CONNECTION_DEFINITIONS,
  connectionDefinitionFor,
  subagentGrantFor,
} from "./registry";

describe("connection broker registry", () => {
  it("marks hosted OAuth/MCP providers as one-click", () => {
    for (const kind of [
      "github",
      "linear",
      "figma",
      "context7",
      "railway",
      "sentry",
      "datadog",
      "grafana",
      "vercel",
      "cloudflare",
    ] as const) {
      expect(connectionDefinitionFor(kind).oneClick).toBe(true);
    }
  });

  it("keeps API-key/self-hosted providers honest", () => {
    expect(connectionDefinitionFor("langfuse").oneClick).toBe(false);
    expect(connectionDefinitionFor("prometheus").oneClick).toBe(false);
    expect(connectionDefinitionFor("prometheus").supportedDeployments).toEqual([
      "self-hosted",
    ]);
  });

  it("defines a remote MCP endpoint for every remote MCP provider", () => {
    for (const definition of Object.values(CONNECTION_DEFINITIONS)) {
      if (definition.mode === "remote-mcp-oauth") {
        expect(definition.remoteMcp?.url).toMatch(/^https:\/\//);
      }
    }
  });

  it("keeps debugger read-only and requires approval for writes", () => {
    expect(subagentGrantFor("debugger")).toMatchObject({
      canRead: true,
      writePolicy: "none",
    });
    expect(subagentGrantFor("reviewer").writePolicy).toBe("approval-required");
    expect(subagentGrantFor("implementer").writePolicy).toBe("approval-required");
  });
});
