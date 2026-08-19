import { describe, expect, it } from "vitest";
import { renderAcceptanceDependencyBuilderHandoff } from "./acceptance-dependency-builder-renderer.js";

const id = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const input = {
  deliveryId: id("1"), deliveryIdentitySha256: "1".repeat(64), recordId: id("2"),
  repo: "acme/widgets", prNumber: 42, deliveredHeadSha: "a".repeat(40),
  deliveredHeadCycleId: id("3"), authorityGeneration: 1,
  acceptanceContractId: id("4"), acceptanceContractVersion: 2, acceptanceContractSha256: "2".repeat(64),
  compiledPackId: id("5"), compiledPackSha256: "3".repeat(64), sourceCustodyIdentitySha256: "4".repeat(64),
  externalBuilderPackId: id("6"), externalBuilderPackEventId: id("7"), externalBuilderPackIdentitySha256: "5".repeat(64),
  candidateFingerprint: `sha256:${"6".repeat(64)}`, routeId: id("8"), routeConfigurationVersion: 1,
  capabilitySnapshotSha256: "7".repeat(64),
  candidate: { package: "@scope/widget", dependencyKind: "dependencies", specifier: "^1.0.0", currentVersion: "1.0.0", targetVersion: "1.1.0" },
  packageManager: { name: "pnpm", version: "10.14.0", updateArgv: ["pnpm", "update", "@scope/widget@1.1.0", "--lockfile-only"] },
  manifest: { path: "package.json", blobSha: "b".repeat(40) },
  lockfile: { path: "pnpm-lock.yaml", blobSha: "c".repeat(40) },
};

describe("renderAcceptanceDependencyBuilderHandoff", () => {
  it("renders deterministic bounded metadata with exactly one selected mention", () => {
    const first = renderAcceptanceDependencyBuilderHandoff(input);
    const second = renderAcceptanceDependencyBuilderHandoff(input);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ ok: true, bodySha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    if (!first.ok) throw new Error("expected rendering");
    expect(first.body.match(/@/g)).toHaveLength(1);
    expect(first.body).toContain("＠scope/widget");
    expect(first.body).toContain("not passing proof");
    expect(first.renderedByteCount).toBeLessThanOrEqual(12_288);
  });

  it("fails closed for control text instead of emitting a body", () => {
    expect(renderAcceptanceDependencyBuilderHandoff({
      ...input,
      candidate: { ...input.candidate, package: "bad\u0000package" },
    })).toEqual({ ok: false, reason: "invalid_binding" });
    expect(renderAcceptanceDependencyBuilderHandoff({
      ...input,
      candidate: { ...input.candidate, specifier: `github_pat_${"A".repeat(24)}` },
    })).toEqual({ ok: false, reason: "invalid_binding" });
  });
});
