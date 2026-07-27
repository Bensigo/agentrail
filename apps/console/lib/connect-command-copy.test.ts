import { describe, it, expect } from "vitest";
import { renderConnectReply } from "./connect-command-copy";
import type { ConnectCommandAction } from "./connect-command";

describe("renderConnectReply", () => {
  const consoleUrl = "https://heyjace.com";

  it("send_link renders connection link with expiration", () => {
    const out = renderConnectReply(
      { kind: "send_link" },
      { linkUrl: "https://example.com/link", consoleUrl }
    );
    expect(out).toContain("https://example.com/link");
    expect(out).toContain("30 minutes");
  });

  it("send_link renders fallback when link unavailable", () => {
    const out = renderConnectReply({ kind: "send_link" }, { consoleUrl });
    expect(out).toContain("couldn't create");
    expect(out).toContain("Try /connect again");
  });

  it("no_workspaces instructs user to create workspace", () => {
    const out = renderConnectReply({ kind: "no_workspaces" }, { consoleUrl });
    expect(out).toContain("not in a workspace");
    expect(out).toContain(consoleUrl);
  });

  it("pin confirms connection to workspace", () => {
    const out = renderConnectReply(
      { kind: "pin", workspace: { id: "ws-1", name: "Engineering" } },
      { consoleUrl }
    );
    expect(out).toContain("Engineering");
    expect(out).toContain("Connected");
  });

  it("repin states both sides so the change is never silent", () => {
    const out = renderConnectReply(
      {
        kind: "repin",
        from: { id: "a", name: "alpha" },
        to: { id: "b", name: "beta" },
      },
      { consoleUrl }
    );
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
  });

  it("repin_refused names nothing about the current workspace", () => {
    const out = renderConnectReply(
      { kind: "repin_refused" },
      { consoleUrl }
    );
    expect(out).toContain("already connected to a workspace you're not a member of");
    expect(out).not.toMatch(/ws-|workspace [A-Za-z0-9-]+ ->/);
  });

  it("already_pinned with alternatives lists switch options", () => {
    const out = renderConnectReply(
      {
        kind: "already_pinned",
        workspace: { id: "ws-1", name: "Current" },
        alternatives: [
          { id: "ws-2", name: "Other" },
          { id: "ws-3", name: "Another" },
        ],
      },
      { consoleUrl }
    );
    expect(out).toContain("Current");
    expect(out).toContain("Other");
    expect(out).toContain("Another");
  });

  it("already_pinned with null workspace hides unreachable pin", () => {
    const out = renderConnectReply(
      {
        kind: "already_pinned",
        workspace: null,
        alternatives: [{ id: "ws-1", name: "Available" }],
      },
      { consoleUrl }
    );
    expect(out).toContain("a workspace");
    expect(out).toContain("Available");
  });

  it("already_pinned without alternatives confirms pin only", () => {
    const out = renderConnectReply(
      {
        kind: "already_pinned",
        workspace: { id: "ws-1", name: "Current" },
        alternatives: [],
      },
      { consoleUrl }
    );
    expect(out).toContain("Current");
    expect(out).not.toContain("switch");
  });

  it("choose lists workspace options", () => {
    const out = renderConnectReply(
      {
        kind: "choose",
        options: [
          { id: "ws-1", name: "First" },
          { id: "ws-2", name: "Second" },
        ],
      },
      { consoleUrl }
    );
    expect(out).toContain("Which workspace");
    expect(out).toContain("First");
    expect(out).toContain("Second");
  });

  it("unknown_workspace lists available workspaces", () => {
    const out = renderConnectReply(
      {
        kind: "unknown_workspace",
        options: [
          { id: "ws-1", name: "Valid" },
          { id: "ws-2", name: "Also" },
        ],
      },
      { consoleUrl }
    );
    expect(out).toContain("don't have a workspace");
    expect(out).toContain("Valid");
    expect(out).toContain("Also");
  });
});
