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

  it("uses trust-layer copy for GitHub provenance and evidence", () => {
    expect(source).toContain("GitHub provides repository, PR, and task provenance");
    expect(source).toContain("Jace records and reviews evidence on the exact attached PR");
    expect(source).toContain("GitHub can send repository and");
    expect(source).toContain("PR events and Jace can correlate PR evidence");
    expect(source).not.toContain("are ingested into the Issue Queue");
    expect(source).not.toContain("run results post back");
    expect(source).not.toContain("review, push");
    expect(source).not.toContain("open PRs as itself");
  });

  it("does not render heartbeat trigger controls", () => {
    expect(source).not.toContain("Radio");
    expect(source).not.toContain("TriggerControls");
    expect(source).not.toContain("Heartbeat");
    expect(source).not.toContain("heartbeat");
    expect(source).not.toContain("Trigger label");
    expect(source).not.toContain("Poll interval");
    expect(source).not.toContain("triggerLabel");
    expect(source).not.toContain("pollIntervalSeconds");
    expect(source).not.toContain('aria-label="Toggle heartbeat for this connector"');
  });
});
