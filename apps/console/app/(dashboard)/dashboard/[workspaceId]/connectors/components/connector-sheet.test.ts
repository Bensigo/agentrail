import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./connector-sheet.tsx", import.meta.url)),
  "utf8"
);

describe("connector sheet connection-path contract", () => {
  it("keeps one entry point while selecting OAuth or credential flow", () => {
    expect(source).toContain("if (isConnected)");
    expect(source).toContain("<OauthConnectButton");
    expect(source).toContain("/connectors/oauth/link");
    expect(source).toContain("connection?.manualFallback");
    expect(source).toContain('mode === "manual"');
    expect(source).toContain("type=\"password\"");
  });

  it("explains deployment capability and keeps setup behind Connect", () => {
    expect(source).toContain("ConnectionPathSummary");
    expect(source).toContain("Hosted MCP · credential fallback");
    expect(source).toContain("Self-hosted endpoint");
    expect(source).toContain("OAuth is not enabled on this deployment");
    expect(source).toContain("How to connect");
  });

  it("keeps disconnect available for an existing connection", () => {
    expect(source).toContain('save(null)');
    expect(source).toContain('Disconnecting…');
  });

  it("keeps implementation and merge authority outside Jace", () => {
    expect(source).not.toContain("TriggerControls");
    expect(source).not.toContain("Heartbeat trigger");
    expect(source).not.toContain("review, push");
    expect(source).not.toContain("open PRs");
    expect(source).not.toContain("Issue Queue");
    expect(source).toContain("Repository and PR evidence connected");
    expect(source).toContain("Install the GitHub App for repository and PR updates");
  });
});
