import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("authenticated Console Trust Layer authority copy", () => {
  const connectors = source("./dashboard/[workspaceId]/connectors/page.tsx");
  const reviewGates = source("./dashboard/[workspaceId]/review-gates/page.tsx");
  const permissions = [
    source("./dashboard/[workspaceId]/permissions/page.tsx"),
    source("./dashboard/[workspaceId]/permissions/components/merge-permission-toggle.tsx"),
  ].join("\n");
  const onboarding = source("./setup/components/github-step.tsx");

  it("presents connectors as provenance and context, not autonomous implementation", () => {
    expect(connectors).toContain("Connect repositories, context, and evidence");
    expect(connectors).not.toContain("Issue Queue");
    expect(connectors).not.toContain("autonomous Heartbeat");
  });

  it("presents Review Gates as historical evidence, not Jace's merge decision", () => {
    expect(reviewGates).toContain("Historical evidence only");
    expect(reviewGates).toContain("Decisions live on Acceptance Records");
    expect(reviewGates).not.toContain("Jace&apos;s changes");
    expect(reviewGates).not.toContain("safe to merge");
  });

  it("makes Permissions an explicit human-only merge boundary", () => {
    expect(permissions).toContain("Merge requires a human");
    expect(permissions).toContain("new grants are unavailable");
    expect(permissions).not.toContain("Jace opens PRs");
    expect(permissions).not.toContain("merges itself");
  });

  it("presents GitHub onboarding as exact-head custody, not builder authority", () => {
    expect(onboarding).toContain("repository and PR evidence");
    expect(onboarding).toContain("Jace does not push");
    expect(onboarding).not.toContain("lets Jace review, push");
    expect(onboarding).not.toContain("Jace should work in");
  });
});
