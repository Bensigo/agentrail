import { describe, expect, it } from "vitest";
import { recordAcceptanceDependencyObservation } from "./change_records.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const RECORD_ID = "22222222-2222-4222-8222-222222222222";
const PACK_ID = "33333333-3333-4333-8333-333333333333";
const HEAD_SHA = "a".repeat(40);
const SHA256 = "b".repeat(64);

const valid = {
  workspaceId: WORKSPACE_ID,
  recordId: RECORD_ID,
  compiledPackId: PACK_ID,
  candidate: {
    package: "@agentrail/example",
    dependencyKind: "dependencies" as const,
    specifier: "^1.2.3",
    currentVersion: "1.2.3",
    targetVersion: "1.3.0",
  },
  runtime: { disposition: "safe" as const, nodeVersion: "22.17.0", evidenceSha256: SHA256 },
  packageManager: {
    disposition: "safe" as const,
    name: "pnpm",
    version: "10.14.0",
    profile: "pnpm_lockfile_only_v1",
    updateArgv: [
      "pnpm", "update", "@agentrail/example@1.3.0", "--lockfile-only", "--ignore-scripts",
    ],
    evidenceSha256: SHA256,
  },
  manifest: { path: "package.json", blobSha: "c".repeat(40) },
  lockfile: {
    disposition: "present" as const,
    path: "pnpm-lock.yaml",
    blobSha: "d".repeat(40),
    evidenceSha256: SHA256,
  },
  baseline: { headSha: HEAD_SHA },
  security: {
    disposition: "clear" as const,
    provider: "osv",
    reference: "osv:npm:@agentrail/example@1.3.0",
    reportSha256: SHA256,
  },
};

describe("Acceptance dependency observation input boundary", () => {
  it("rejects caller-supplied authority, status, fingerprint, and execution side effects", async () => {
    for (const extra of [
      { repo: "acme/widgets" },
      { prNumber: 7 },
      { headCycleId: RECORD_ID },
      { authorityGeneration: 2 },
      { candidateFingerprint: `sha256:${SHA256}` },
      { status: "observed" },
      { watch: true },
      { queue: "dependency_update" },
      { approvalId: RECORD_ID },
      { issueNumber: 10 },
      { install: true },
    ]) {
      await expect(recordAcceptanceDependencyObservation({ ...valid, ...extra } as never))
        .rejects.toThrow("exact bounded runner evidence");
    }
  });

  it("keeps the npm candidate and exact-head source references canonical", async () => {
    for (const candidate of [
      { ...valid.candidate, package: "UPPERCASE" },
      { ...valid.candidate, dependencyKind: "runtime" },
      { ...valid.candidate, specifier: "workspace:*" },
      { ...valid.candidate, currentVersion: "latest" },
      { ...valid.candidate, targetVersion: valid.candidate.currentVersion },
    ]) {
      await expect(recordAcceptanceDependencyObservation({ ...valid, candidate } as never))
        .rejects.toThrow("exact bounded runner evidence");
    }
    await expect(recordAcceptanceDependencyObservation({
      ...valid,
      manifest: { path: "README.md", blobSha: valid.manifest.blobSha },
    } as never)).rejects.toThrow("exact bounded runner evidence");
    await expect(recordAcceptanceDependencyObservation({
      ...valid,
      lockfile: { ...valid.lockfile, path: "package-lock.json" },
    } as never)).rejects.toThrow("exact bounded runner evidence");
  });

  it("requires coherent runtime evidence, fixed OSV identity, and bounded shell-free argv", async () => {
    await expect(recordAcceptanceDependencyObservation({
      ...valid,
      runtime: { ...valid.runtime, disposition: "unavailable", nodeVersion: "22.17.0" },
    } as never)).rejects.toThrow("exact bounded runner evidence");
    await expect(recordAcceptanceDependencyObservation({
      ...valid,
      packageManager: { ...valid.packageManager, name: "PNPM" },
    } as never)).rejects.toThrow("exact bounded runner evidence");
    await expect(recordAcceptanceDependencyObservation({
      ...valid,
      packageManager: { ...valid.packageManager, updateArgv: ["pnpm", "token secret"] },
    } as never)).rejects.toThrow("exact bounded runner evidence");
    await expect(recordAcceptanceDependencyObservation({
      ...valid,
      candidate: { ...valid.candidate, specifier: `^1.2.3\u202e` },
    } as never)).rejects.toThrow("exact bounded runner evidence");
    await expect(recordAcceptanceDependencyObservation({
      ...valid,
      security: { ...valid.security, provider: "npm" },
    } as never)).rejects.toThrow("exact bounded runner evidence");
    await expect(recordAcceptanceDependencyObservation({
      ...valid,
      security: { ...valid.security, reference: "https://osv.dev/vulnerability/GHSA-test" },
    } as never)).rejects.toThrow("exact bounded runner evidence");
    await expect(recordAcceptanceDependencyObservation({
      ...valid,
      lockfile: { ...valid.lockfile, disposition: "missing", blobSha: valid.lockfile.blobSha },
    } as never)).rejects.toThrow("exact bounded runner evidence");
  });
});
