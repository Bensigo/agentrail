import { describe, expect, it } from "vitest";
import {
  AcceptanceDependencyObservationInvalidEvidenceError,
  recordAcceptanceDependencyObservation,
} from "./change_records.js";

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
    identity: { ecosystem: "node", manager: "pnpm", profile: "pnpm_lockfile_only_v1" },
    package: "@agentrail/example",
    dependencyKind: "dependencies" as const,
    specifier: "^1.2.3",
    currentVersion: "1.2.3",
    targetVersion: "1.3.0",
  },
  runtime: { identity: { ecosystem: "node", manager: "pnpm", profile: "pnpm_lockfile_only_v1" }, disposition: "safe" as const, version: "22.17.0", evidenceSha256: SHA256 },
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
    identity: { ecosystem: "node", manager: "pnpm", profile: "pnpm_lockfile_only_v1" },
    disposition: "clear" as const,
    provider: "osv",
    reference: "osv:npm:@agentrail/example@1.3.0",
    reportSha256: SHA256,
  },
};

const yarnIdentity = {
  ecosystem: "node",
  manager: "yarn",
  profile: "yarn_berry_v4_root_lockfile_only_v1",
};
const validYarn = {
  ...valid,
  candidate: { ...valid.candidate, identity: yarnIdentity },
  runtime: { ...valid.runtime, identity: yarnIdentity },
  packageManager: {
    ...valid.packageManager,
    name: "yarn",
    version: "4.18.0",
    profile: "yarn_berry_v4_root_lockfile_only_v1",
    updateArgv: [
      "yarn", "add", "@agentrail/example@1.3.0", "--mode=update-lockfile",
    ],
  },
  lockfile: { ...valid.lockfile, path: "yarn.lock" },
  security: { ...valid.security, identity: yarnIdentity },
};

const uvIdentity = {
  ecosystem: "python",
  manager: "uv",
  profile: "uv_project_lockfile_only_v1",
};
const validUv = {
  ...valid,
  candidate: {
    identity: uvIdentity,
    package: "httpx",
    dependencyKind: "dependencies" as const,
    specifier: ">=0.27.0",
    currentVersion: "0.27.0",
    targetVersion: "0.28.1",
  },
  runtime: {
    ...valid.runtime,
    identity: uvIdentity,
    version: "3.12.8",
  },
  packageManager: {
    ...valid.packageManager,
    name: "uv",
    version: "0.12.0",
    profile: "uv_project_lockfile_only_v1",
    updateArgv: [
      "uv", "lock", "--no-cache", "--no-config", "--no-python-downloads",
      "--no-sources", "--no-build", "--upgrade-package", "httpx==0.28.1",
    ],
  },
  manifest: { ...valid.manifest, path: "pyproject.toml" },
  lockfile: { ...valid.lockfile, path: "uv.lock" },
  security: {
    ...valid.security,
    identity: uvIdentity,
    reference: "osv:PyPI:httpx@0.28.1",
  },
};

const cargoIdentity = {
  ecosystem: "rust",
  manager: "cargo",
  profile: "cargo_lock_registry_only_v1",
};
const validCargo = {
  ...valid,
  candidate: {
    identity: cargoIdentity,
    package: "serde",
    dependencyKind: "dependencies" as const,
    specifier: "^1.0.203",
    currentVersion: "1.0.203",
    targetVersion: "1.0.204",
  },
  runtime: {
    ...valid.runtime,
    identity: cargoIdentity,
    version: "1.97.1",
  },
  packageManager: {
    ...valid.packageManager,
    name: "cargo",
    version: "1.97.1",
    profile: "cargo_lock_registry_only_v1",
    updateArgv: [
      "cargo", "update", "--manifest-path", "Cargo.toml",
      "registry+https://github.com/rust-lang/crates.io-index#serde@1.0.203",
      "--precise", "1.0.204",
    ],
  },
  manifest: { ...valid.manifest, path: "Cargo.toml" },
  lockfile: { ...valid.lockfile, path: "Cargo.lock" },
  security: {
    ...valid.security,
    identity: cargoIdentity,
    reference: "osv:crates.io:serde@1.0.204",
  },
};

const composerIdentity = {
  ecosystem: "php",
  manager: "composer",
  profile: "composer_lock_public_packagist_v1",
};
const validComposer = {
  ...valid,
  candidate: {
    identity: composerIdentity,
    package: "ralouphie/getallheaders",
    dependencyKind: "dependencies" as const,
    specifier: "^3.0.0",
    currentVersion: "3.0.3",
    targetVersion: "3.0.4",
  },
  runtime: {
    ...valid.runtime,
    identity: composerIdentity,
    version: "8.5.9",
  },
  packageManager: {
    ...valid.packageManager,
    name: "composer",
    version: "2.10.2",
    profile: "composer_lock_public_packagist_v1",
    updateArgv: [
      "composer", "--no-interaction", "--no-plugins", "--no-scripts", "--no-cache",
      "update", "ralouphie/getallheaders:3.0.4", "--with-dependencies",
      "--minimal-changes", "--no-dev", "--no-install", "--no-audit", "--no-progress",
    ],
  },
  manifest: { ...valid.manifest, path: "composer.json" },
  lockfile: { ...valid.lockfile, path: "composer.lock" },
  security: {
    ...valid.security,
    identity: composerIdentity,
    reference: "osv:Packagist:ralouphie/getallheaders@3.0.4",
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
        .rejects.toBeInstanceOf(AcceptanceDependencyObservationInvalidEvidenceError);
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
  });

  it("requires coherent runtime evidence, fixed OSV identity, and bounded shell-free argv", async () => {
    await expect(recordAcceptanceDependencyObservation({
      ...valid,
      runtime: { ...valid.runtime, disposition: "unavailable", version: "22.17.0" },
    } as never)).rejects.toThrow("exact bounded runner evidence");
    await expect(recordAcceptanceDependencyObservation({
      ...valid,
      packageManager: { ...valid.packageManager, name: "PNPM" },
    } as never)).rejects.toThrow("exact bounded runner evidence");
    await expect(recordAcceptanceDependencyObservation({
      ...valid,
      candidate: { ...valid.candidate, specifier: `^1.2.3\u202e` },
    } as never)).rejects.toThrow("exact bounded runner evidence");
    await expect(recordAcceptanceDependencyObservation({
      ...valid,
      lockfile: { ...valid.lockfile, disposition: "missing", blobSha: valid.lockfile.blobSha },
    } as never)).rejects.toThrow("exact bounded runner evidence");
  });

  it("rejects malformed Yarn evidence at the exact DB input boundary", async () => {
    for (const malformed of [
      { ...validYarn, yarnConfiguration: { present: false } },
      {
        ...validYarn,
        candidate: { ...validYarn.candidate, specifier: `^1.2.3\u202e` },
      },
      {
        ...validYarn,
        runtime: { ...validYarn.runtime, disposition: "unavailable", version: "22.17.0" },
      },
      {
        ...validYarn,
        packageManager: { ...validYarn.packageManager, name: "Yarn" },
      },
      {
        ...validYarn,
        candidate: {
          ...validYarn.candidate,
          identity: { ...validYarn.candidate.identity, manager: "Yarn" },
        },
      },
    ]) {
      await expect(recordAcceptanceDependencyObservation(malformed as never))
        .rejects.toBeInstanceOf(AcceptanceDependencyObservationInvalidEvidenceError);
    }
  });

  it("rejects structurally unsafe uv evidence before historical replay lookup", async () => {
    for (const malformed of [
      { ...validUv, candidate: { ...validUv.candidate, package: `httpx\u202e` } },
      { ...validUv, candidate: { ...validUv.candidate, package: "x".repeat(215) } },
      {
        ...validUv,
        candidate: {
          ...validUv.candidate,
          identity: { ...validUv.candidate.identity, ecosystem: "Python" },
        },
      },
      {
        ...validUv,
        packageManager: {
          ...validUv.packageManager,
          updateArgv: [...validUv.packageManager.updateArgv, `--index-url\u2066`],
        },
      },
      { ...validUv, manifest: { ...validUv.manifest, path: "../pyproject.toml" } },
      { ...validUv, security: { ...validUv.security, reportSha256: "not-a-digest" } },
    ]) {
      await expect(recordAcceptanceDependencyObservation(malformed as never))
        .rejects.toBeInstanceOf(AcceptanceDependencyObservationInvalidEvidenceError);
    }
  });

  it("rejects caller-supplied Cargo source grammar, configuration, and unsafe text", async () => {
    for (const malformed of [
      { ...validCargo, manifestContent: "[dependencies]" },
      { ...validCargo, lockfileContent: "version = 4" },
      { ...validCargo, cargoConfiguration: { absent: true } },
      { ...validCargo, candidate: { ...validCargo.candidate, package: `serde\u202e` } },
      {
        ...validCargo,
        packageManager: {
          ...validCargo.packageManager,
          updateArgv: [...validCargo.packageManager.updateArgv, `--config\u2066`],
        },
      },
      { ...validCargo, manifest: { ...validCargo.manifest, path: "../Cargo.toml" } },
      { ...validCargo, security: { ...validCargo.security, reportSha256: "not-a-digest" } },
    ]) {
      await expect(recordAcceptanceDependencyObservation(malformed as never))
        .rejects.toBeInstanceOf(AcceptanceDependencyObservationInvalidEvidenceError);
    }
  });

  it("rejects structurally unsafe Composer evidence before historical replay lookup", async () => {
    for (const malformed of [
      { ...validComposer, composerJson: { require: {} } },
      { ...validComposer, composerLock: { packages: [] } },
      { ...validComposer, packagistResponse: { trusted: true } },
      { ...validComposer, candidate: { ...validComposer.candidate, package: `vendor/package\u202e` } },
      { ...validComposer, candidate: { ...validComposer.candidate, package: "x".repeat(215) } },
      {
        ...validComposer,
        candidate: {
          ...validComposer.candidate,
          identity: { ...validComposer.candidate.identity, ecosystem: "PHP" },
        },
      },
      { ...validComposer, manifest: { ...validComposer.manifest, path: "../composer.json" } },
      { ...validComposer, security: { ...validComposer.security, reportSha256: "not-a-digest" } },
    ]) {
      await expect(recordAcceptanceDependencyObservation(malformed as never))
        .rejects.toBeInstanceOf(AcceptanceDependencyObservationInvalidEvidenceError);
    }
  });
  it("rejects legacy v1 runner bodies while durable v1 events remain replay-compatible", async () => {
    const { identity: _candidateIdentity, ...candidate } = valid.candidate;
    const { identity: _runtimeIdentity, version, ...runtime } = valid.runtime;
    const { identity: _securityIdentity, ...security } = valid.security;
    await expect(recordAcceptanceDependencyObservation({
      ...valid,
      candidate,
      runtime: { ...runtime, nodeVersion: version },
      security,
    } as never)).rejects.toThrow("exact bounded runner evidence");
  });
});
