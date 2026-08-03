import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./connector-sheet.tsx", import.meta.url)),
  "utf8"
);

describe("connector sheet one-click contract", () => {
  it("routes disconnected connectors through the broker action", () => {
    expect(source).toContain("if (!isConnected)");
    expect(source).toContain("<OauthConnectButton");
    expect(source).toContain("/connectors/oauth/link");
  });

  it("does not expose credential collection or setup instructions", () => {
    expect(source).not.toContain('type="password"');
    expect(source).not.toContain("Use an API token instead");
    expect(source).not.toContain("Connect {connector.label} manually");
    expect(source).not.toContain("Missing:");
    expect(source).not.toContain("OauthSetupNotice");
  });

  it("keeps disconnect available for an existing connection", () => {
    expect(source).toContain('secret: null');
    expect(source).toContain('Disconnecting…');
  });
});
