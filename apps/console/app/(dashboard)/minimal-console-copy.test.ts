import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("authenticated Console minimal copy", () => {
  it("keeps primary trust surfaces free of redundant page lectures", () => {
    const sources = [
      source("./dashboard/[workspaceId]/changes/page.tsx"),
      source("./dashboard/[workspaceId]/briefs/page.tsx"),
      source("./dashboard/[workspaceId]/approvals/page.tsx"),
      source("./dashboard/[workspaceId]/memory/page.tsx"),
      source("./dashboard/[workspaceId]/wiki/page.tsx"),
      source("./dashboard/[workspaceId]/permissions/page.tsx"),
    ].join("\n");

    expect(sources).not.toContain("One lifecycle record for each change");
    expect(sources).not.toContain("durable understanding of each product idea");
    expect(sources).not.toContain("Everything waiting on a human");
    expect(sources).not.toContain("What Jace has learned");
    expect(sources).not.toContain("What Jace has compiled");
    expect(sources).not.toContain("implementation and merge remain outside Jace");
  });

  it("retains critical receipt and human-authority distinctions", () => {
    const records = source("./dashboard/[workspaceId]/components/acceptance-record-summary-list.tsx");
    const outcomes = source("./dashboard/[workspaceId]/components/acceptance-outcome-metrics-panel.tsx");
    const permissions = source("./dashboard/[workspaceId]/permissions/components/merge-permission-toggle.tsx");

    expect(records).toContain("Not recorded means no canonical receipt");
    expect(records).toContain("not a known negative");
    expect(outcomes).toContain("Unknown / excluded ≠ zero");
    expect(permissions).toContain("Merge requires a human");
    expect(permissions).toContain("Revocation is permanent");
  });

  it("keeps setup actions and errors while removing repeated instructions", () => {
    const github = source("./setup/components/github-step.tsx");
    const setup = source("./setup/page.tsx");

    expect(github).toContain("Connect GitHub App");
    expect(github).toContain("Create webhook automatically");
    expect(github).toContain("Jace does not push or merge");
    expect(github).not.toContain("Choose repositories, then create the webhook");
    expect(setup).not.toContain("Every step below is optional");
  });
});
