import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCEPTANCE_DEPENDENCY_OBSERVATION_BODY_BYTES,
  ACCEPTANCE_DEPENDENCY_OBSERVATION_BODY_TIMEOUT_MS,
  ACCEPTANCE_DEPENDENCY_COMPOSER_PROFILE,
  ACCEPTANCE_DEPENDENCY_NPM_PROFILE,
  ACCEPTANCE_DEPENDENCY_UV_PROFILE,
  ACCEPTANCE_DEPENDENCY_YARN_PROFILE,
  parseAcceptanceDependencyObservation,
  parseAcceptanceDependencyObservationForStorage,
  readBoundedAcceptanceDependencyObservationJson,
} from "./acceptance-dependency-observation";

afterEach(() => {
  vi.useRealTimers();
});

const VALID = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  recordId: "22222222-2222-4222-8222-222222222222",
  compiledPackId: "33333333-3333-4333-8333-333333333333",
  candidate: {
    identity: { ecosystem: "node", manager: "pnpm", profile: "pnpm_lockfile_only_v1" },
    package: "@acme/widget",
    dependencyKind: "dependencies",
    specifier: "^1.2.0",
    currentVersion: "1.2.3",
    targetVersion: "1.3.0",
  },
  runtime: {
    identity: { ecosystem: "node", manager: "pnpm", profile: "pnpm_lockfile_only_v1" },
    disposition: "safe",
    version: "22.14.0",
    evidenceSha256: "a".repeat(64),
  },
  packageManager: {
    disposition: "safe",
    name: "pnpm",
    version: "10.14.0",
    profile: "pnpm_lockfile_only_v1",
    updateArgv: [
      "pnpm",
      "update",
      "@acme/widget@1.3.0",
      "--lockfile-only",
      "--ignore-scripts",
    ],
    evidenceSha256: "b".repeat(64),
  },
  manifest: { path: "packages/widget/package.json", blobSha: "c".repeat(40) },
  lockfile: {
    disposition: "present",
    path: "pnpm-lock.yaml",
    blobSha: "d".repeat(40),
    evidenceSha256: "e".repeat(64),
  },
  baseline: { headSha: "f".repeat(40) },
  security: {
    identity: { ecosystem: "node", manager: "pnpm", profile: "pnpm_lockfile_only_v1" },
    disposition: "clear",
    provider: "osv",
    reference: "osv:npm:@acme/widget@1.3.0",
    reportSha256: "1".repeat(64),
  },
} as const;

function cloneValid(): Record<string, unknown> {
  return structuredClone(VALID) as unknown as Record<string, unknown>;
}

function validNpm(
  dependencyKind: "dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies" = "dependencies",
  saveFlag = "--save-prod",
): Record<string, unknown> {
  const value = cloneValid();
  const identity = { ecosystem: "node", manager: "npm", profile: ACCEPTANCE_DEPENDENCY_NPM_PROFILE };
  (value.candidate as Record<string, unknown>).identity = identity;
  (value.candidate as Record<string, unknown>).dependencyKind = dependencyKind;
  (value.runtime as Record<string, unknown>).identity = identity;
  Object.assign(value.packageManager as Record<string, unknown>, {
    name: "npm",
    profile: ACCEPTANCE_DEPENDENCY_NPM_PROFILE,
    updateArgv: [
      "npm", "install", "@acme/widget@1.3.0", "--package-lock-only",
      "--ignore-scripts", "--no-audit", saveFlag,
    ],
  });
  (value.manifest as Record<string, unknown>).path = "package.json";
  (value.lockfile as Record<string, unknown>).path = "package-lock.json";
  (value.security as Record<string, unknown>).identity = identity;
  return value;
}

function validYarn(
  dependencyKind: "dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies" = "dependencies",
  dependencyFlag: "--dev" | "--optional" | "--peer" | null = null,
): Record<string, unknown> {
  const value = cloneValid();
  const identity = { ecosystem: "node", manager: "yarn", profile: ACCEPTANCE_DEPENDENCY_YARN_PROFILE };
  (value.candidate as Record<string, unknown>).identity = identity;
  (value.candidate as Record<string, unknown>).dependencyKind = dependencyKind;
  (value.runtime as Record<string, unknown>).identity = identity;
  Object.assign(value.packageManager as Record<string, unknown>, {
    name: "yarn",
    version: "4.9.2",
    profile: ACCEPTANCE_DEPENDENCY_YARN_PROFILE,
    updateArgv: [
      "yarn", "add", "@acme/widget@1.3.0", "--mode=update-lockfile",
      ...(dependencyFlag ? [dependencyFlag] : []),
    ],
  });
  (value.manifest as Record<string, unknown>).path = "package.json";
  (value.lockfile as Record<string, unknown>).path = "yarn.lock";
  (value.security as Record<string, unknown>).identity = identity;
  return value;
}

function validUv(): Record<string, unknown> {
  const value = cloneValid();
  const identity = { ecosystem: "python", manager: "uv", profile: ACCEPTANCE_DEPENDENCY_UV_PROFILE };
  Object.assign(value.candidate as Record<string, unknown>, {
    identity,
    package: "typing-extensions",
    dependencyKind: "dependencies",
    specifier: ">=4.10.0",
    currentVersion: "4.11.0",
    targetVersion: "4.12.2",
  });
  Object.assign(value.runtime as Record<string, unknown>, {
    identity,
    version: "3.12.8",
  });
  Object.assign(value.packageManager as Record<string, unknown>, {
    name: "uv",
    version: "0.12.1",
    profile: ACCEPTANCE_DEPENDENCY_UV_PROFILE,
    updateArgv: [
      "uv", "lock", "--no-cache", "--no-config", "--no-python-downloads",
      "--no-sources", "--no-build", "--upgrade-package", "typing-extensions==4.12.2",
    ],
  });
  (value.manifest as Record<string, unknown>).path = "pyproject.toml";
  (value.lockfile as Record<string, unknown>).path = "uv.lock";
  Object.assign(value.security as Record<string, unknown>, {
    identity,
    reference: "osv:PyPI:typing-extensions@4.12.2",
  });
  return value;
}

function validCargo(): Record<string, unknown> {
  const value = cloneValid();
  const identity = { ecosystem: "rust", manager: "cargo", profile: "cargo_lock_registry_only_v1" };
  Object.assign(value.candidate as Record<string, unknown>, {
    identity,
    package: "serde",
    dependencyKind: "dependencies",
    specifier: "^1.0.203",
    currentVersion: "1.0.203",
    targetVersion: "1.0.204",
  });
  Object.assign(value.runtime as Record<string, unknown>, {
    identity,
    version: "1.97.1",
  });
  Object.assign(value.packageManager as Record<string, unknown>, {
    name: "cargo",
    version: "1.97.1",
    profile: "cargo_lock_registry_only_v1",
    updateArgv: [
      "cargo", "update", "--manifest-path", "Cargo.toml",
      "registry+https://github.com/rust-lang/crates.io-index#serde@1.0.203",
      "--precise", "1.0.204",
    ],
  });
  (value.manifest as Record<string, unknown>).path = "Cargo.toml";
  (value.lockfile as Record<string, unknown>).path = "Cargo.lock";
  Object.assign(value.security as Record<string, unknown>, {
    identity,
    reference: "osv:crates.io:serde@1.0.204",
  });
  return value;
}

function validComposer(): Record<string, unknown> {
  const value = cloneValid();
  const identity = {
    ecosystem: "php",
    manager: "composer",
    profile: ACCEPTANCE_DEPENDENCY_COMPOSER_PROFILE,
  };
  Object.assign(value.candidate as Record<string, unknown>, {
    identity,
    package: "ralouphie/getallheaders",
    dependencyKind: "dependencies",
    specifier: "^3.0.0",
    currentVersion: "3.0.3",
    targetVersion: "3.0.4",
  });
  Object.assign(value.runtime as Record<string, unknown>, {
    identity,
    version: "8.5.9",
  });
  Object.assign(value.packageManager as Record<string, unknown>, {
    name: "composer",
    version: "2.10.2",
    profile: ACCEPTANCE_DEPENDENCY_COMPOSER_PROFILE,
    updateArgv: [
      "composer", "--no-interaction", "--no-plugins", "--no-scripts", "--no-cache",
      "update", "ralouphie/getallheaders:3.0.4", "--with-dependencies",
      "--minimal-changes", "--no-dev", "--no-install", "--no-audit", "--no-progress",
    ],
  });
  (value.manifest as Record<string, unknown>).path = "composer.json";
  (value.lockfile as Record<string, unknown>).path = "composer.lock";
  Object.assign(value.security as Record<string, unknown>, {
    identity,
    reference: "osv:Packagist:ralouphie/getallheaders@3.0.4",
  });
  return value;
}
describe("parseAcceptanceDependencyObservation", () => {
  it("normalizes the bounded fixed pnpm profile without claiming approval", () => {
    const raw = cloneValid();
    raw.workspaceId = (raw.workspaceId as string).toUpperCase();
    (raw.baseline as { headSha: string }).headSha = "F".repeat(40);
    const result = parseAcceptanceDependencyObservation(raw);
    expect(result).toEqual({
      input: {
        ...VALID,
        workspaceId: VALID.workspaceId,
        baseline: { headSha: "f".repeat(40) },
      },
      boundaryAssessment: "candidate_for_server_verification",
    });
    expect(JSON.stringify(result)).not.toMatch(/approv/iu);
  });

  it.each([
    ["dependencies", "--save-prod"],
    ["devDependencies", "--save-dev"],
    ["optionalDependencies", "--save-optional"],
    ["peerDependencies", "--save-peer"],
  ] as const)("normalizes the npm %s profile with its exact save flag", (kind, saveFlag) => {
    const raw = validNpm(kind, saveFlag);
    const result = parseAcceptanceDependencyObservation(raw);
    expect(result?.boundaryAssessment).toBe("candidate_for_server_verification");
    expect(result?.input).toEqual(raw);
  });

  it.each([
    ["dependencies", null],
    ["devDependencies", "--dev"],
    ["optionalDependencies", "--optional"],
    ["peerDependencies", "--peer"],
  ] as const)("normalizes the bounded Yarn 4 %s profile", (kind, dependencyFlag) => {
    const raw = validYarn(kind, dependencyFlag);
    const result = parseAcceptanceDependencyObservation(raw);
    expect(result?.boundaryAssessment).toBe("candidate_for_server_verification");
    expect(result?.input).toEqual(raw);
    expect(result?.input).not.toHaveProperty("yarnConfiguration");
  });

  it.each(["1.2.3", "^1.2.3", "~1.2.3"])(
    "accepts the Yarn registry semver specifier %s",
    (specifier) => {
      const raw = validYarn();
      (raw.candidate as { specifier: string }).specifier = specifier;
      expect(parseAcceptanceDependencyObservation(raw)?.boundaryAssessment)
        .toBe("candidate_for_server_verification");
    }
  );

  it("normalizes the bounded uv project lockfile-only profile", () => {
    const raw = validUv();
    const result = parseAcceptanceDependencyObservation(raw);
    expect(result).toEqual({
      input: raw,
      boundaryAssessment: "candidate_for_server_verification",
    });
    expect(JSON.stringify(result)).not.toMatch(/install|execute|approv|deliver/iu);
  });

  it("stores the withdrawn Cargo profile only as an unsupported refusal", () => {
    const raw = validCargo();
    expect(parseAcceptanceDependencyObservation(raw)).toEqual({
      input: raw,
      boundaryAssessment: "refused_unsupported_profile",
    });
    expect(parseAcceptanceDependencyObservationForStorage(raw)).toEqual({
      kind: "current",
      input: raw,
      boundaryAssessment: "refused_unsupported_profile",
    });
    expect(JSON.stringify(parseAcceptanceDependencyObservation(raw)))
      .not.toMatch(/execute|approv|deliver|dispatch/iu);
  });

  it("normalizes the bounded Composer public-Packagist lockfile profile", () => {
    const raw = validComposer();
    expect(parseAcceptanceDependencyObservation(raw)).toEqual({
      input: raw,
      boundaryAssessment: "candidate_for_server_verification",
    });
    expect(JSON.stringify(parseAcceptanceDependencyObservation(raw)))
      .not.toMatch(/execute|approv|deliver|dispatch/iu);
  });

  it("accepts one compatible Composer tilde transition", () => {
    const raw = validComposer();
    Object.assign(raw.candidate as Record<string, unknown>, {
      specifier: "~3.0.0", currentVersion: "3.0.3", targetVersion: "3.0.9",
    });
    (raw.packageManager as { updateArgv: string[] }).updateArgv[6] =
      "ralouphie/getallheaders:3.0.9";
    (raw.security as { reference: string }).reference =
      "osv:Packagist:ralouphie/getallheaders@3.0.9";
    expect(parseAcceptanceDependencyObservation(raw)?.boundaryAssessment)
      .toBe("candidate_for_server_verification");
  });

  it.each([
    ["uppercase package", (raw: Record<string, unknown>) => {
      (raw.candidate as { package: string }).package = "Ralouphie/getallheaders";
    }],
    ["development dependency", (raw: Record<string, unknown>) => {
      (raw.candidate as { dependencyKind: string }).dependencyKind = "devDependencies";
    }],
    ["partial constraint", (raw: Record<string, unknown>) => {
      (raw.candidate as { specifier: string }).specifier = "^3.0";
    }],
    ["exact constraint cannot move", (raw: Record<string, unknown>) => {
      (raw.candidate as { specifier: string }).specifier = "3.0.3";
    }],
    ["target outside caret", (raw: Record<string, unknown>) => {
      (raw.candidate as { targetVersion: string }).targetVersion = "4.0.0";
    }],
    ["version component exceeds the source parser cap", (raw: Record<string, unknown>) => {
      Object.assign(raw.candidate as Record<string, unknown>, {
        specifier: "^1000000000.0.0",
        currentVersion: "1000000000.0.0",
        targetVersion: "1000000000.0.1",
      });
      (raw.packageManager as { updateArgv: string[] }).updateArgv[6] =
        "ralouphie/getallheaders:1000000000.0.1";
      (raw.security as { reference: string }).reference =
        "osv:Packagist:ralouphie/getallheaders@1000000000.0.1";
    }],
    ["different PHP patch", (raw: Record<string, unknown>) => {
      (raw.runtime as { version: string | null }).version = "8.5.8";
    }],
    ["different Composer patch", (raw: Record<string, unknown>) => {
      (raw.packageManager as { version: string | null }).version = "2.10.1";
    }],
    ["nested manifest", (raw: Record<string, unknown>) => {
      (raw.manifest as { path: string }).path = "packages/app/composer.json";
    }],
    ["nested lockfile", (raw: Record<string, unknown>) => {
      (raw.lockfile as { path: string }).path = "packages/app/composer.lock";
    }],
    ["wrong OSV ecosystem", (raw: Record<string, unknown>) => {
      (raw.security as { reference: string }).reference =
        "osv:packagist:ralouphie/getallheaders@3.0.4";
    }],
  ] as const)("keeps bounded invalid Composer evidence only on the historical replay seam: %s", (_label, mutate) => {
    const raw = validComposer();
    mutate(raw);
    expect(parseAcceptanceDependencyObservation(raw)).toBeNull();
    expect(parseAcceptanceDependencyObservationForStorage(raw)?.kind)
      .toBe("historical_replay_candidate");
  });

  it.each([
    ["missing no-plugins", "--no-plugins"],
    ["missing no-scripts", "--no-scripts"],
    ["missing no-install", "--no-install"],
    ["missing no-audit", "--no-audit"],
  ] as const)("records bounded Composer command drift as refused unsafe evidence: %s", (_label, flag) => {
    const raw = validComposer();
    const argv = (raw.packageManager as { updateArgv: string[] }).updateArgv;
    argv.splice(argv.indexOf(flag), 1);
    expect(parseAcceptanceDependencyObservation(raw)?.boundaryAssessment)
      .toBe("refused_unsafe_runtime");
  });
  it.each([
    ["non-canonical package", (raw: Record<string, unknown>) => {
      (raw.candidate as { package: string }).package = "typing_extensions";
    }],
    ["non-production dependency kind", (raw: Record<string, unknown>) => {
      (raw.candidate as { dependencyKind: string }).dependencyKind = "devDependencies";
    }],
    ["non-lower-bound specifier", (raw: Record<string, unknown>) => {
      (raw.candidate as { specifier: string }).specifier = "^4.10.0";
    }],
    ["prerelease candidate", (raw: Record<string, unknown>) => {
      (raw.candidate as { targetVersion: string }).targetVersion = "4.12.2rc1";
    }],
    ["target below current", (raw: Record<string, unknown>) => {
      (raw.candidate as { targetVersion: string }).targetVersion = "4.10.1";
    }],
    ["current below declared bound", (raw: Record<string, unknown>) => {
      (raw.candidate as { specifier: string }).specifier = ">=4.12.0";
    }],
    ["Python 2", (raw: Record<string, unknown>) => {
      (raw.runtime as { version: string | null }).version = "2.7.18";
    }],
    ["prerelease Python", (raw: Record<string, unknown>) => {
      (raw.runtime as { version: string | null }).version = "3.13.0-rc.1";
    }],
    ["uv below range", (raw: Record<string, unknown>) => {
      (raw.packageManager as { version: string | null }).version = "0.11.9";
    }],
    ["uv above range", (raw: Record<string, unknown>) => {
      (raw.packageManager as { version: string | null }).version = "0.13.0";
    }],
    ["nested manifest", (raw: Record<string, unknown>) => {
      (raw.manifest as { path: string }).path = "python/pyproject.toml";
    }],
    ["nested lockfile", (raw: Record<string, unknown>) => {
      (raw.lockfile as { path: string }).path = "python/uv.lock";
    }],
    ["wrong OSV namespace", (raw: Record<string, unknown>) => {
      (raw.security as { reference: string }).reference = "osv:npm:typing-extensions@4.12.2";
    }],
  ] as const)("keeps bounded invalid uv evidence only on the historical replay seam: %s", (_label, mutate) => {
    const raw = validUv();
    mutate(raw);
    expect(parseAcceptanceDependencyObservation(raw)).toBeNull();
    expect(parseAcceptanceDependencyObservationForStorage(raw)?.kind)
      .toBe("historical_replay_candidate");
  });

  it.each([
    ["missing no-build", (raw: Record<string, unknown>) => {
      const argv = (raw.packageManager as { updateArgv: string[] }).updateArgv;
      argv.splice(argv.indexOf("--no-build"), 1);
    }],
    ["reordered flags", (raw: Record<string, unknown>) => {
      (raw.packageManager as { updateArgv: string[] }).updateArgv = [
        "uv", "lock", "--no-config", "--no-cache", "--no-python-downloads",
        "--no-sources", "--no-build", "--upgrade-package", "typing-extensions==4.12.2",
      ];
    }],
    ["arbitrary command expansion", (raw: Record<string, unknown>) => {
      (raw.packageManager as { updateArgv: string[] }).updateArgv.push("--script");
    }],
  ] as const)("records bounded uv command drift as refused unsafe evidence: %s", (_label, mutate) => {
    const raw = validUv();
    mutate(raw);
    expect(parseAcceptanceDependencyObservation(raw)?.boundaryAssessment)
      .toBe("refused_unsafe_runtime");
  });

  it("records bounded uv identity drift as refused unsupported evidence", () => {
    const raw = validUv();
    (raw.runtime as Record<string, unknown>).identity = {
      ecosystem: "python", manager: "pip", profile: ACCEPTANCE_DEPENDENCY_UV_PROFILE,
    };
    expect(parseAcceptanceDependencyObservation(raw)?.boundaryAssessment)
      .toBe("refused_unsupported_profile");
  });

  it.each([
    ["npm alias", "npm:@acme/real-widget@1.2.3"],
    ["workspace", "workspace:^"],
    ["range", ">=1.2.3"],
    ["tag", "latest"],
    ["patch", "patch:@acme/widget@1.2.3#./widget.patch"],
  ])("keeps a bounded invalid Yarn %s only on the historical replay seam", (_label, specifier) => {
    const raw = validYarn();
    (raw.candidate as { specifier: string }).specifier = specifier;
    expect(parseAcceptanceDependencyObservation(raw)).toBeNull();
    expect(parseAcceptanceDependencyObservationForStorage(raw)?.kind)
      .toBe("historical_replay_candidate");
  });

  it.each([
    ["Node below the floor", "runtime", "18.11.9"],
    ["prerelease Node", "runtime", "22.0.0-rc.1"],
    ["Yarn 3", "packageManager", "3.8.7"],
    ["Yarn 5", "packageManager", "5.0.0"],
    ["prerelease Yarn", "packageManager", "4.0.0-rc.1"],
  ] as const)("keeps %s only on the historical replay seam", (_label, field, version) => {
    const raw = validYarn();
    (raw[field] as { version: string | null }).version = version;
    expect(parseAcceptanceDependencyObservation(raw)).toBeNull();
    expect(parseAcceptanceDependencyObservationForStorage(raw)?.kind)
      .toBe("historical_replay_candidate");
  });

  it.each([
    ["nested manifest", "packages/widget/package.json", "yarn.lock"],
    ["nested lockfile", "package.json", "packages/widget/yarn.lock"],
  ])("keeps Yarn source-scope drift only on the historical replay seam: %s", (_label, manifestPath, lockfilePath) => {
    const raw = validYarn();
    (raw.manifest as { path: string }).path = manifestPath;
    (raw.lockfile as { path: string }).path = lockfilePath;
    expect(parseAcceptanceDependencyObservation(raw)).toBeNull();
    expect(parseAcceptanceDependencyObservationForStorage(raw)?.kind)
      .toBe("historical_replay_candidate");
  });

  it("records bounded Yarn command drift as refused unsafe runtime evidence", () => {
    const raw = validYarn("devDependencies", "--dev");
    (raw.packageManager as { updateArgv: string[] }).updateArgv = [
      "yarn", "up", "@acme/widget@1.3.0", "--mode=update-lockfile",
    ];
    expect(parseAcceptanceDependencyObservation(raw)?.boundaryAssessment)
      .toBe("refused_unsafe_runtime");
  });

  it.each([
    ["wrong save kind", validNpm("devDependencies", "--save-prod")],
    ["missing no-audit", (() => {
      const raw = validNpm();
      (raw.packageManager as { updateArgv: string[] }).updateArgv.splice(5, 1);
      return raw;
    })()],
    ["save-exact expansion", (() => {
      const raw = validNpm();
      (raw.packageManager as { updateArgv: string[] }).updateArgv.push("--save-exact");
      return raw;
    })()],
    ["reordered flags", (() => {
      const raw = validNpm();
      (raw.packageManager as { updateArgv: string[] }).updateArgv = [
        "npm", "install", "@acme/widget@1.3.0", "--ignore-scripts",
        "--package-lock-only", "--no-audit", "--save-prod",
      ];
      return raw;
    })()],
  ])("records npm command drift as refused evidence: %s", (_label, raw) => {
    expect(parseAcceptanceDependencyObservation(raw)?.boundaryAssessment).toBe("refused_unsafe_runtime");
  });

  it("keeps npm aliases valid for pnpm but rejects them for the npm profile", () => {
    const pnpm = cloneValid();
    (pnpm.candidate as { specifier: string }).specifier = "npm:@acme/real-widget@^1.2.0";
    expect(parseAcceptanceDependencyObservation(pnpm)?.boundaryAssessment)
      .toBe("candidate_for_server_verification");

    const npm = validNpm();
    (npm.candidate as { specifier: string }).specifier = "npm:@acme/real-widget@^1.2.0";
    expect(parseAcceptanceDependencyObservation(npm)).toBeNull();
    expect(parseAcceptanceDependencyObservationForStorage(npm)?.kind)
      .toBe("historical_replay_candidate");
  });

  it("passes only a bounded former npm profile as a historical replay candidate", () => {
    const historical = validNpm();
    Object.assign(historical.candidate as Record<string, unknown>, {
      specifier: "npm:@acme/real-widget@^1.2.0",
      currentVersion: "release-1",
      targetVersion: "release-2",
    });
    Object.assign(historical.runtime as Record<string, unknown>, {
      version: "node-current",
    });
    Object.assign(historical.packageManager as Record<string, unknown>, {
      version: "npm-current",
      updateArgv: ["npm", "update", "@acme/widget"],
    });
    (historical.manifest as { path: string }).path = "legacy/package.json";
    (historical.lockfile as { path: string }).path = "legacy/package-lock.json";
    Object.assign(historical.security as Record<string, unknown>, {
      provider: "legacy-provider",
      reference: "opaque:historical-query",
    });

    expect(parseAcceptanceDependencyObservation(historical)).toBeNull();
    expect(parseAcceptanceDependencyObservationForStorage(historical)).toEqual({
      kind: "historical_replay_candidate",
      input: historical,
    });

    (historical.candidate as { specifier: string }).specifier =
      "token=github_pat_abcdefghijklmnopqrstuvwxyz";
    expect(parseAcceptanceDependencyObservationForStorage(historical)).toBeNull();
  });

  it.each([
    ["nested manifest", "packages/widget/package.json", "package-lock.json"],
    ["nested lockfile", "package.json", "packages/widget/package-lock.json"],
    ["npm shrinkwrap", "package.json", "npm-shrinkwrap.json"],
  ])("rejects npm v1 source scope drift: %s", (_label, manifestPath, lockfilePath) => {
    const raw = validNpm();
    (raw.manifest as { path: string }).path = manifestPath;
    (raw.lockfile as { path: string }).path = lockfilePath;
    expect(parseAcceptanceDependencyObservation(raw)).toBeNull();
  });

  it.each([
    ["arbitrary command", ["pnpm", "exec", "postinstall"]],
    ["script-enabled update", ["pnpm", "update", "@acme/widget@1.3.0", "--lockfile-only"]],
    ["competing install", ["npm", "install", "@acme/widget@1.3.0"]],
  ])("records a bounded %s as refused unsafe runtime evidence", (_label, updateArgv) => {
    const raw = cloneValid();
    (raw.packageManager as { updateArgv: string[] }).updateArgv = updateArgv;
    expect(parseAcceptanceDependencyObservation(raw)?.boundaryAssessment).toBe("refused_unsafe_runtime");
  });

  it("records an explicitly unsafe runtime as refused unsafe runtime evidence", () => {
    const raw = cloneValid();
    Object.assign(raw.runtime as object, { disposition: "unsafe", version: "latest" });
    expect(parseAcceptanceDependencyObservation(raw)?.boundaryAssessment).toBe("refused_unsafe_runtime");
  });

  it.each(["missing", "uncommitted", "unavailable", "ambiguous"] as const)(
    "records a %s lockfile as refused lockfile evidence",
    (disposition) => {
      const raw = cloneValid();
      Object.assign(raw.lockfile as object, { disposition, blobSha: null });
      expect(parseAcceptanceDependencyObservation(raw)?.boundaryAssessment).toBe("refused_lockfile");
    }
  );

  it.each(["affected", "unavailable", "ambiguous"] as const)(
    "records %s security as refused security evidence",
    (disposition) => {
      const raw = cloneValid();
      (raw.security as { disposition: string }).disposition = disposition;
      expect(parseAcceptanceDependencyObservation(raw)?.boundaryAssessment).toBe("refused_security");
    }
  );

  it.each(["runtime", "packageManager"] as const)(
    "records unavailable %s evidence as not proven",
    (field) => {
      const raw = cloneValid();
      Object.assign(raw[field] as object, {
        disposition: "unavailable",
        ...(field === "runtime" ? { version: null } : { version: null }),
      });
      expect(parseAcceptanceDependencyObservation(raw)?.boundaryAssessment).toBe("not_proven");
    }
  );

  it.each([
    ["unknown top-level field", (raw: Record<string, unknown>) => { raw.repo = "acme/widget"; }],
    ["unknown nested field", (raw: Record<string, unknown>) => { (raw.candidate as Record<string, unknown>).headSha = "a".repeat(40); }],
    ["unsafe path", (raw: Record<string, unknown>) => { (raw.manifest as { path: string }).path = "../package.json"; }],
    ["wrong manifest", (raw: Record<string, unknown>) => { (raw.manifest as { path: string }).path = "packages/widget/package-lock.json"; }],
    ["wrong lockfile", (raw: Record<string, unknown>) => { (raw.lockfile as { path: string }).path = "package-lock.json"; }],
    ["same version", (raw: Record<string, unknown>) => { (raw.candidate as { targetVersion: string }).targetVersion = "1.2.3"; }],
    ["non-semver candidate", (raw: Record<string, unknown>) => { (raw.candidate as { targetVersion: string }).targetVersion = "latest"; }],
    ["unsafe candidate specifier", (raw: Record<string, unknown>) => { (raw.candidate as { specifier: string }).specifier = "workspace:*"; }],
    ["unsafe package-manager name", (raw: Record<string, unknown>) => { (raw.packageManager as { name: string }).name = "PNPM"; }],
    ["wrong security provider", (raw: Record<string, unknown>) => { (raw.security as { provider: string }).provider = "github"; }],
    ["external security reference", (raw: Record<string, unknown>) => { (raw.security as { reference: string }).reference = "https://osv.dev/report"; }],
    ["secret-shaped evidence", (raw: Record<string, unknown>) => { (raw.candidate as { specifier: string }).specifier = "token=github_pat_abcdefghijklmnopqrstuvwxyz"; }],
  ])("rejects malformed input: %s", (_label, mutate) => {
    const raw = cloneValid();
    mutate(raw);
    expect(parseAcceptanceDependencyObservation(raw)).toBeNull();
  });

  it.each([
    ["python", "poetry", "poetry_lock_v1"], ["python", "uv", "uv_lock_v1"],
    ["python", "pip", "pip_requirements_v1"], ["rust", "cargo", "cargo_lock_v1"],
    ["go", "go-modules", "go_1_26_root_mod_sum_public_proxy_v1"], ["node", "yarn", "yarn_lock_v1"],
    ["node", "bun", "bun_lock_v1"], ["jvm", "maven", "maven_lock_v1"],
    ["jvm", "gradle", "gradle_lock_v1"], ["dotnet", "dotnet", "nuget_lock_v1"],
    ["php", "composer", "composer_lock_v1"],
  ])("accepts bounded unsupported %s/%s identity for server refusal", (ecosystem, manager, profile) => {
    const raw = cloneValid();
    for (const field of [raw.candidate, raw.runtime, raw.security] as Array<Record<string, unknown>>) {
      field.identity = { ecosystem, manager, profile };
    }
    (raw.candidate as Record<string, unknown>).currentVersion = "release-1";
    (raw.candidate as Record<string, unknown>).targetVersion = "release-2";
    (raw.runtime as Record<string, unknown>).version = "runtime-unknown";
    Object.assign(raw.packageManager as Record<string, unknown>, {
      name: manager,
      version: "manager-version-unknown",
      profile,
      updateArgv: [manager, "update", "example-package"],
    });
    (raw.manifest as Record<string, unknown>).path = "ecosystem/manifest.file";
    (raw.lockfile as Record<string, unknown>).path = "ecosystem/lock.file";
    (raw.security as Record<string, unknown>).provider = "unknown-provider";
    (raw.security as Record<string, unknown>).reference = "opaque:server-verified-only";
    const parsed = parseAcceptanceDependencyObservation(raw);
    expect(parsed?.boundaryAssessment).toBe("refused_unsupported_profile");
    expect(parsed?.input.packageManager).toMatchObject({ name: manager, profile });
    expect(JSON.stringify(parsed)).not.toContain("pnpm");
  });

  it("rejects legacy v1 runner bodies instead of inferring a manager identity", () => {
    const raw = cloneValid();
    delete (raw.candidate as Record<string, unknown>).identity;
    delete (raw.runtime as Record<string, unknown>).identity;
    (raw.runtime as Record<string, unknown>).nodeVersion = (raw.runtime as Record<string, unknown>).version;
    delete (raw.runtime as Record<string, unknown>).version;
    delete (raw.security as Record<string, unknown>).identity;
    expect(parseAcceptanceDependencyObservation(raw)).toBeNull();
  });
});

describe("readBoundedAcceptanceDependencyObservationJson", () => {
  it("reads fatal UTF-8 JSON within the fixed limit", async () => {
    const request = new Request("http://localhost/observation", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(VALID),
    });
    await expect(readBoundedAcceptanceDependencyObservationJson(request)).resolves.toEqual({
      ok: true,
      value: VALID,
    });
  });

  it("rejects a declared oversize body before parsing it", async () => {
    const request = new Request("http://localhost/observation", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(ACCEPTANCE_DEPENDENCY_OBSERVATION_BODY_BYTES + 1),
      },
      body: "{}",
    });
    await expect(readBoundedAcceptanceDependencyObservationJson(request)).resolves.toEqual({
      ok: false,
      reason: "invalid_length",
    });
  });

  it("cancels a streamed body that crosses the fixed limit", async () => {
    let cancelled = false;
    const request = new Request("http://localhost/observation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(ACCEPTANCE_DEPENDENCY_OBSERVATION_BODY_BYTES + 1));
        },
        cancel() { cancelled = true; },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expect(readBoundedAcceptanceDependencyObservationJson(request)).resolves.toEqual({
      ok: false,
      reason: "invalid_length",
    });
    expect(cancelled).toBe(true);
  });

  it("rejects fatal UTF-8 and non-JSON media types", async () => {
    const badUtf8 = new Request("http://localhost/observation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Uint8Array([0xc3, 0x28]),
    });
    await expect(readBoundedAcceptanceDependencyObservationJson(badUtf8)).resolves.toEqual({
      ok: false,
      reason: "invalid_json",
    });
    let cancelled = false;
    const wrongType = new Request("http://localhost/observation", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new TextEncoder().encode("{}")); },
        cancel() { cancelled = true; },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expect(readBoundedAcceptanceDependencyObservationJson(wrongType)).resolves.toEqual({
      ok: false,
      reason: "invalid_content_type",
    });
    expect(cancelled).toBe(true);
  });

  it("distinguishes a request stream failure from invalid JSON", async () => {
    const request = new Request("http://localhost/observation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        pull(controller) { controller.error(new Error("socket closed")); },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expect(readBoundedAcceptanceDependencyObservationJson(request)).resolves.toEqual({
      ok: false,
      reason: "body_unavailable",
    });
  });

  it("times out and cancels a stalled request body at the fixed deadline", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn().mockResolvedValue(undefined);
    const request = {
      headers: new Headers({ "content-type": "application/json" }),
      body: {
        getReader: () => ({
          read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined),
          cancel,
        }),
      },
    } as unknown as Request;
    const result = readBoundedAcceptanceDependencyObservationJson(request);
    await vi.advanceTimersByTimeAsync(ACCEPTANCE_DEPENDENCY_OBSERVATION_BODY_TIMEOUT_MS);
    await expect(result).resolves.toEqual({ ok: false, reason: "timeout" });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
