import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { db } from "../db.js";
import { workspaces } from "../schema/workspaces.js";
import { repositories } from "../schema/repositories.js";
import {
  dependencyWatchObservations,
  dependencyWatches,
} from "../schema/dependency_watches.js";
import {
  acceptanceContracts,
  changeRecordEvents,
  changeRecords,
} from "../schema/change_records.js";
import type { DependencyUpgradeCandidate } from "../queries/dependency_upgrade_contracts.js";
import {
  createDraftAcceptanceRecordFromDependencyObservation,
  npmObservationConstraintMatches,
  npmObservationCandidateFingerprint,
  pnpmObservationCandidateFingerprint,
  resolveDependencyObservationProposalCandidate,
  validateNpmObservationProposalCandidate,
  validatePnpmObservationProposalCandidate,
  type DependencyObservationDraftError,
} from "../queries/dependency_observation_acceptance_records.js";
import { readDependencyDraftProposalDetail } from "../queries/dependency_draft_proposal_detail.js";

const DB_AVAILABLE: boolean = await (async () => {
  try {
    const rows = Array.from(await db.execute(sql`
      SELECT to_regclass('public.dependency_watches') AS watches,
             to_regclass('public.dependency_watch_observations') AS observations,
             to_regclass('public.change_records') AS records,
             to_regclass('public.acceptance_contracts') AS contracts,
             to_regclass('public.change_record_events') AS events
    `)) as Array<Record<string, string | null>>;
    return rows[0]?.watches === "dependency_watches"
      && rows[0]?.observations === "dependency_watch_observations"
      && rows[0]?.records === "change_records"
      && rows[0]?.contracts === "acceptance_contracts"
      && rows[0]?.events === "change_record_events";
  } catch {
    return false;
  }
})();

const BASELINE = "a".repeat(40);
const MANIFEST_HASH = "b".repeat(64);
const LOCKFILE_HASH = "c".repeat(64);
const PYTHON_PNPM_VECTOR = "sha256:f2f29eb6be01ee390848b166892b9d056984d9d546cc6850a30675a836860e12";
const PYTHON_NPM_VECTOR = "sha256:a1eaaa6137da52ec1a0fd92c3713676898313044f2166fc6b8f420f427dd623e";

type PnpmProducerCandidate = Omit<
  DependencyUpgradeCandidate,
  "package_manager_version"
> & { package_manager_version: null };
type NpmProducerCandidate = Omit<
  DependencyUpgradeCandidate,
  "package_manager_version"
> & { package_manager_version: null };

/** Exact asdict output shape of the live pnpm.py:_make_candidate path. */
function pnpmCandidate(overrides: Partial<PnpmProducerCandidate> = {}): PnpmProducerCandidate {
  const candidate: PnpmProducerCandidate = {
    package: "@agentrail/widget",
    ecosystem: "node",
    package_manager: "pnpm",
    dependency_kind: "dependencies",
    specifier: "^1.0.0",
    current_version: "1.0.0",
    target_version: "1.1.0",
    manifest_path: "package.json",
    lockfile_path: "pnpm-lock.yaml",
    baseline_sha: BASELINE,
    fingerprint: "",
    package_manager_version: null,
    verification_commands: ["pnpm install --frozen-lockfile", "pnpm test"],
    manager_commands: {
      version: "pnpm --version",
      install: "pnpm install --frozen-lockfile",
      update: "pnpm update --lockfile-only --ignore-scripts @agentrail/widget@1.1.0",
    },
    ...overrides,
  };
  return { ...candidate, fingerprint: pnpmObservationCandidateFingerprint(candidate) };
}

/** Exact 14-key output of dependency_runtime._legacy_candidate_payload. */
function npmCandidate(overrides: Partial<NpmProducerCandidate> = {}): NpmProducerCandidate {
  const candidate: NpmProducerCandidate = {
    package: "lodash",
    ecosystem: "node",
    package_manager: "npm",
    dependency_kind: "dependencies",
    specifier: "^4.17.21",
    current_version: "4.17.21",
    target_version: "4.17.22",
    manifest_path: "package.json",
    lockfile_path: "package-lock.json",
    baseline_sha: BASELINE,
    fingerprint: "",
    package_manager_version: null,
    verification_commands: ["npm test"],
    manager_commands: {
      version: "npm --version",
      install: "npm ci --ignore-scripts",
      update: "npm install lodash@4.17.22 --package-lock-only --ignore-scripts --no-audit --save-prod",
    },
    ...overrides,
  };
  return { ...candidate, fingerprint: npmObservationCandidateFingerprint(candidate) };
}

function npmRangeCandidate(
  specifier: string,
  currentVersion: string,
  targetVersion: string,
): NpmProducerCandidate {
  return npmCandidate({
    specifier,
    current_version: currentVersion,
    target_version: targetVersion,
    manager_commands: {
      version: "npm --version",
      install: "npm ci --ignore-scripts",
      update: `npm install lodash@${targetVersion} --package-lock-only --ignore-scripts --no-audit --save-prod`,
    },
  });
}

describe("dependency observation proposal producer compatibility", () => {
  it("matches the canonical Python pnpm candidate fingerprint", () => {
    expect(pnpmCandidate().fingerprint).toBe(PYTHON_PNPM_VECTOR);
  });

  it("accepts the exact live pnpm asdict command and null-version shape", () => {
    expect(validatePnpmObservationProposalCandidate(pnpmCandidate())).toMatchObject({
      package: "@agentrail/widget",
      package_manager: "pnpm",
      fingerprint: PYTHON_PNPM_VECTOR,
      manager_commands: {
        version: "pnpm --version",
        install: "pnpm install --frozen-lockfile",
        update: "pnpm update --lockfile-only --ignore-scripts @agentrail/widget@1.1.0",
      },
    });
  });

  it("matches and admits the authentic 14-key Python npm watcher vector", () => {
    const candidate = npmCandidate();

    expect(candidate.fingerprint).toBe(PYTHON_NPM_VECTOR);
    expect(Object.keys(candidate)).toHaveLength(14);
    expect(candidate).not.toHaveProperty("adapter_profile");
    expect(candidate).not.toHaveProperty("adapter_identity_fingerprint");
    expect(validateNpmObservationProposalCandidate(candidate)).toEqual(candidate);
    expect(resolveDependencyObservationProposalCandidate(candidate)).toMatchObject({
      candidate,
      manifestPath: "package.json",
      lockfilePath: "package-lock.json",
      profile: {
        ecosystem: "node",
        manager: "npm",
        profile: "npm_package_lock_only_v1",
        capability: "proposal_observation_only",
      },
    });
  });

  it.each([
    ["1.2.3", "1.2.3", true],
    ["1.2.3", "1.2.4", false],
    [">=1.2.3 <2.0.0", "1.9.9", true],
    [">=1.2.3 <2.0.0", "2.0.0", false],
    ["^3.0.0 || ^4.17.21", "4.17.22", true],
    ["^0.2.3", "0.2.9", true],
    ["^0.2.3", "0.3.0", false],
    ["^0.0.3", "0.0.4", false],
    ["~4.17.21", "4.18.0", false],
    ["*", "4.17.22", true],
    ["4.x", "4.17.22", true],
    ["4.17", "4.18.0", false],
    ["4.17.21 - 4.17.30", "4.17.30", true],
    ["latest", "4.17.22", null],
    ["npm:underscore@1.13.6", "4.17.22", null],
    ["github:lodash/lodash", "4.17.22", null],
  ] as const)("matches the Python npm semver parity vector %s at %s", (specifier, version, expected) => {
    expect(npmObservationConstraintMatches(specifier, version)).toBe(expected);
  });

  it.each([
    [">=4.17.0 <5.0.0", "4.17.21", "4.18.0"],
    ["^3.0.0 || ^4.17.21", "4.17.21", "4.18.0"],
    ["^0.2.3", "0.2.3", "0.2.9"],
    ["~4.17.21", "4.17.21", "4.17.22"],
    ["4.17.x", "4.17.21", "4.17.22"],
    ["4.17", "4.17.21", "4.17.22"],
    ["4.17.21 - 4.17.30", "4.17.21", "4.17.30"],
  ] as const)(
    "admits the Python npm constraint subset for current and target: %s",
    (specifier, currentVersion, targetVersion) => {
      const candidate = npmRangeCandidate(specifier, currentVersion, targetVersion);
      expect(validateNpmObservationProposalCandidate(candidate)).toEqual(candidate);
    },
  );

  it.each([
    ["exact target escape", "4.17.21", "4.17.21", "4.17.22"],
    ["current and target outside caret", "^1.0.0", "2.0.0", "2.1.0"],
    ["target outside caret", "^1.0.0", "1.5.0", "2.0.0"],
    ["current outside caret", "^1.0.0", "0.9.0", "1.1.0"],
    ["tag", "latest", "4.17.21", "4.17.22"],
    ["unknown syntax", ">=4.17.0 <5", "4.17.21", "4.17.22"],
    ["alias", "npm:underscore@1.13.6", "4.17.21", "4.17.22"],
    ["repository ref", "github:lodash/lodash", "4.17.21", "4.17.22"],
  ] as const)(
    "refuses npm %s instead of widening the producer constraint",
    (_name, specifier, currentVersion, targetVersion) => {
      expect(validateNpmObservationProposalCandidate(
        npmRangeCandidate(specifier, currentVersion, targetVersion),
      )).toBeNull();
    },
  );

  it("compares npm semver cores without Number precision loss", () => {
    const candidate = npmRangeCandidate(
      ">=9007199254740992.0.0 <9007199254740994.0.0",
      "9007199254740992.0.0",
      "9007199254740993.0.0",
    );

    expect(validateNpmObservationProposalCandidate(candidate)).toEqual(candidate);
  });

  it("orders an admitted npm prerelease before its release", () => {
    const candidate = npmRangeCandidate(
      "^1.2.3-beta.1",
      "1.2.3-beta.1",
      "1.2.3",
    );

    expect(validateNpmObservationProposalCandidate(candidate)).toEqual(candidate);
  });

  it.each([
    ["dependencies", "--save-prod"],
    ["devDependencies", "--save-dev"],
    ["optionalDependencies", "--save-optional"],
    ["peerDependencies", "--save-peer"],
  ] as const)("binds the npm %s producer command", (dependencyKind, saveFlag) => {
    const candidate = npmCandidate({
      dependency_kind: dependencyKind,
      manager_commands: {
        version: "npm --version",
        install: "npm ci --ignore-scripts",
        update: `npm install lodash@4.17.22 --package-lock-only --ignore-scripts --no-audit ${saveFlag}`,
      },
    });

    expect(validateNpmObservationProposalCandidate(candidate)).toEqual(candidate);
  });

  it.each([
    ["path", npmCandidate({ lockfile_path: "packages/app/package-lock.json" })],
    ["older target", npmCandidate({
      target_version: "4.17.20",
      manager_commands: {
        version: "npm --version",
        install: "npm ci --ignore-scripts",
        update: "npm install lodash@4.17.20 --package-lock-only --ignore-scripts --no-audit --save-prod",
      },
    })],
    ["command", npmCandidate({
      manager_commands: {
        version: "npm --version",
        install: "npm ci --ignore-scripts",
        update: "npm install lodash@4.17.22 --package-lock-only --ignore-scripts --no-audit --save-dev",
      },
    })],
    ["package-manager version", { ...npmCandidate(), package_manager_version: "10.8.2" }],
    ["adapter profile", { ...npmCandidate(), adapter_profile: "npm_package_lock_only_v1" }],
    ["adapter digest", { ...npmCandidate(), adapter_identity_fingerprint: `sha256:${"f".repeat(64)}` }],
  ] as const)("refuses npm producer %s drift", (_name, candidate) => {
    expect(validateNpmObservationProposalCandidate(candidate)).toBeNull();
  });

  it("does not coerce an unsupported Node manager to npm", () => {
    const yarn = {
      ...npmCandidate(),
      package_manager: "yarn",
      lockfile_path: "yarn.lock",
    };

    expect(resolveDependencyObservationProposalCandidate(yarn)).toBeNull();
  });

  it("keeps the proposal query free of approval, Pack, queue, PR, and merge authority", () => {
    const source = readFileSync(
      new URL("../queries/dependency_observation_acceptance_records.ts", import.meta.url),
      "utf8",
    );
    for (const forbidden of [
      "recordApprovalRequest",
      "attachDependencyUpgradeApproval",
      "latestTelegramSessionForWorkspace",
      "createAcceptanceContextPack",
      "enqueueGithubIssue",
      "createPullRequest",
      "mergePullRequest",
    ]) expect(source).not.toContain(forbidden);
  });

  it("locks the tenant-scoped watch before reading the current observation", () => {
    const source = readFileSync(
      new URL("../queries/dependency_observation_acceptance_records.ts", import.meta.url),
      "utf8",
    );
    const custodyRead = source.indexOf("async function readCustody");
    const watchLock = source.indexOf("FOR UPDATE OF watch", custodyRead);
    const observationRead = source.indexOf(".from(dependencyWatchObservations)", custodyRead);
    const lockQuery = source.slice(custodyRead, watchLock);

    expect(custodyRead).toBeGreaterThan(-1);
    expect(watchLock).toBeGreaterThan(custodyRead);
    expect(watchLock).toBeLessThan(observationRead);
    expect(lockQuery).toContain("watch.workspace_id = ${input.workspaceId}");
    expect(lockQuery).toContain("watch.id = ${input.watchId}");
    expect(lockQuery).toContain("repository.workspace_id = ${input.workspaceId}");
  });

  it("requires one untouched draft lifecycle for an ordinary replay", () => {
    const source = readFileSync(
      new URL("../queries/dependency_observation_acceptance_records.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("storedContracts.length !== 1");
    expect(source).toContain("storedEvents.length !== 1");
    expect(source).toContain("storedContract.confirmedBy !== null");
    expect(source).toContain("storedContract.confirmedAt !== null");
    expect(source).toContain('existing.state !== "open"');
    expect(source).toContain("existing.prNumber !== null");
    expect(source).toContain("existing.mergedSha !== null");
  });
});

describe.skipIf(!DB_AVAILABLE)("dependency observation proposal custody — real Postgres", () => {
  let workspaceId: string;

  beforeEach(async () => {
    workspaceId = (await db.insert(workspaces).values({
      name: "dependency proposal test",
      slug: `dependency-proposal-${randomUUID()}`,
    }).returning({ id: workspaces.id }))[0]!.id;
  });

  afterEach(async () => {
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  });

  async function observe(input: {
    candidate?: DependencyUpgradeCandidate | Record<string, unknown>;
    baselineSha?: string | null;
    hashes?: Record<string, string>;
    status?: "candidates" | "unchanged" | "failed";
    observedAt?: Date;
    watchManifestPath?: string;
    watchLockfilePath?: string;
  } = {}) {
    const candidate = input.candidate ?? pnpmCandidate();
    const repository = (await db.insert(repositories).values({
      workspaceId,
      name: `acme/proposal-${randomUUID()}`,
      url: `https://github.com/acme/proposal-${randomUUID()}`,
    }).returning())[0]!;
    const watch = (await db.insert(dependencyWatches).values({
      workspaceId,
      repositoryId: repository.id,
      manifestPath: input.watchManifestPath ?? "package.json",
      lockfilePath: input.watchLockfilePath ?? "pnpm-lock.yaml",
    }).returning())[0]!;
    const observation = await addObservation({
      watch,
      candidate,
      baselineSha: input.baselineSha,
      hashes: input.hashes,
      status: input.status,
      observedAt: input.observedAt,
    });
    return { repository, watch, observation, candidate };
  }

  async function addObservation(input: {
    watch: { id: string; repositoryId: string };
    candidate?: DependencyUpgradeCandidate | Record<string, unknown>;
    baselineSha?: string | null;
    hashes?: Record<string, string>;
    status?: "candidates" | "unchanged" | "failed";
    observedAt?: Date;
  }) {
    const candidate = input.candidate ?? pnpmCandidate();
    const fingerprint = typeof candidate.fingerprint === "string" ? candidate.fingerprint : null;
    return (await db.insert(dependencyWatchObservations).values({
      workspaceId,
      watchId: input.watch.id,
      repositoryId: input.watch.repositoryId,
      trigger: "scheduled",
      baselineSha: input.baselineSha === undefined ? BASELINE : input.baselineSha,
      selectedFileHashes: input.hashes ?? { "package.json": MANIFEST_HASH, "pnpm-lock.yaml": LOCKFILE_HASH },
      observationKey: `candidate:${randomUUID()}`,
      candidateFingerprint: input.status === "candidates" || input.status === undefined ? fingerprint : null,
      status: input.status ?? "candidates",
      candidates: input.status === "candidates" || input.status === undefined ? [candidate] : [],
      observedAt: input.observedAt ?? new Date(),
    }).returning())[0]!;
  }

  function fingerprintOf(candidate: unknown): string {
    const fingerprint = (candidate as Record<string, unknown>).fingerprint;
    if (typeof fingerprint !== "string") throw new Error("fixture candidate has no fingerprint");
    return fingerprint;
  }

  function locator(source: { watch: { id: string }; candidate: unknown }) {
    return { workspaceId, watchId: source.watch.id, candidateFingerprint: fingerprintOf(source.candidate) };
  }

  async function createProposalDraft() {
    const source = await observe();
    return createDraftAcceptanceRecordFromDependencyObservation(locator(source));
  }

  async function observeNpm(input: {
    candidate?: DependencyUpgradeCandidate | Record<string, unknown>;
    baselineSha?: string | null;
    hashes?: Record<string, string>;
    observedAt?: Date;
    watchManifestPath?: string;
    watchLockfilePath?: string;
  } = {}) {
    return observe({
      candidate: input.candidate ?? npmCandidate(),
      baselineSha: input.baselineSha,
      hashes: input.hashes ?? {
        "package.json": MANIFEST_HASH,
        "package-lock.json": LOCKFILE_HASH,
      },
      observedAt: input.observedAt,
      watchManifestPath: input.watchManifestPath,
      watchLockfilePath: input.watchLockfilePath ?? "package-lock.json",
    });
  }

  it("creates one draft Record, v1 Contract, and immutable exact pnpm proposal custody", async () => {
    const source = await observe({
      hashes: {
        "package.json": MANIFEST_HASH,
        "pnpm-lock.yaml": LOCKFILE_HASH,
        "unrelated.txt": "d".repeat(64),
      },
    });
    const result = await createDraftAcceptanceRecordFromDependencyObservation(locator(source));

    expect(result).toMatchObject({
      created: true,
      record: { repo: source.repository.name, originChannel: "dependency_watch" },
      contract: { status: "draft", version: 1 },
      observation: { id: source.observation.id, key: source.observation.observationKey },
      profile: {
        ecosystem: "node", manager: "pnpm", profile: "pnpm_lockfile_only_v1", capability: "proposal_observation_only",
      },
    });
    expect(result.contract.contract).toMatchObject({
      environment: {
        candidateFingerprint: fingerprintOf(source.candidate),
        candidate: source.candidate,
        baselineSha: BASELINE,
        selectedFileHashes: { "package.json": MANIFEST_HASH, "pnpm-lock.yaml": LOCKFILE_HASH },
      },
    });
    expect((result.contract.contract.environment as Record<string, unknown>).selectedFileHashes).not.toHaveProperty("unrelated.txt");
    expect(result.event.payloadRef).toMatchObject({
      candidateFingerprint: fingerprintOf(source.candidate),
      proposalCustodyIdentity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      authority: "draft_only",
      evidenceAdmission: "unresolved",
      repositorySourceVerification: "watch_observation_only",
      independentSourceProof: "not_proven",
    });
  });

  it("creates and projects one exact npm observation-proposal draft with no delivery authority", async () => {
    const source = await observeNpm({
      hashes: {
        "package.json": MANIFEST_HASH,
        "package-lock.json": LOCKFILE_HASH,
        "unrelated.txt": "d".repeat(64),
      },
    });

    const result = await createDraftAcceptanceRecordFromDependencyObservation(locator(source));

    expect(result).toMatchObject({
      created: true,
      record: { repo: source.repository.name, originChannel: "dependency_watch" },
      contract: { status: "draft", version: 1, confirmedBy: null, confirmedAt: null },
      observation: { id: source.observation.id, key: source.observation.observationKey },
      profile: {
        ecosystem: "node",
        manager: "npm",
        profile: "npm_package_lock_only_v1",
        capability: "proposal_observation_only",
      },
    });
    expect(result.record.sourceReferences).toEqual([expect.objectContaining({
      candidate: source.candidate,
      baselineSha: BASELINE,
      manifestPath: "package.json",
      lockfilePath: "package-lock.json",
      selectedFileHashes: {
        "package.json": MANIFEST_HASH,
        "package-lock.json": LOCKFILE_HASH,
      },
      independentSourceProof: "not_proven",
    })]);
    expect(result.event.payloadRef).toMatchObject({
      candidate: source.candidate,
      authority: "draft_only",
      evidenceAdmission: "unresolved",
      independentSourceProof: "not_proven",
    });
    const contract = result.contract.contract as Record<string, unknown>;
    for (const unresolved of [
      "release", "usage", "runtime", "target-lock", "security", "human-confirmation",
      "context-pack", "delivery", "pull-request", "merge",
    ]) {
      expect(contract.risks).toContain(`${unresolved} evidence is unresolved and blocking.`);
      expect(contract.stops).toContain(`${unresolved} evidence remains unresolved.`);
    }
    await expect(readDependencyDraftProposalDetail({
      workspaceId,
      recordId: result.record.id,
    })).resolves.toMatchObject({
      kind: "draft",
      proposal: {
        candidate: {
          package: "lodash",
          currentVersion: "4.17.21",
          targetVersion: "4.17.22",
          dependencyKind: "dependencies",
        },
        files: {
          manifest: { path: "package.json", sha256: MANIFEST_HASH },
          lockfile: { path: "package-lock.json", sha256: LOCKFILE_HASH },
        },
        profile: { ecosystem: "node", manager: "npm", profile: "npm_package_lock_only_v1" },
        evidenceAdmission: "unresolved",
        independentSourceProof: "not_proven",
      },
    });
  });

  it.each([
    ["nested manifest", "packages/app/package.json", "pnpm-lock.yaml"],
    ["nested lockfile", "package.json", "packages/app/pnpm-lock.yaml"],
    ["mixed auto manifest", "auto", "pnpm-lock.yaml"],
    ["mixed auto lockfile", "package.json", "auto"],
  ])("refuses %s watch custody before creating a draft", async (_name, manifestPath, lockfilePath) => {
    const source = await observe({
      watchManifestPath: manifestPath,
      watchLockfilePath: lockfilePath,
    });

    await expect(createDraftAcceptanceRecordFromDependencyObservation(locator(source)))
      .rejects.toMatchObject({ code: "unsafe_custody" } satisfies Partial<DependencyObservationDraftError>);
    await expect(db.select().from(changeRecords).where(eq(changeRecords.workspaceId, workspaceId)))
      .resolves.toHaveLength(0);
  });

  it("admits an auto/auto watch only through the candidate's exact root pnpm paths", async () => {
    const source = await observe({ watchManifestPath: "auto", watchLockfilePath: "auto" });

    const result = await createDraftAcceptanceRecordFromDependencyObservation(locator(source));
    expect(result).toMatchObject({
      created: true,
      contract: {
        contract: {
          environment: { manifestPath: "package.json", lockfilePath: "pnpm-lock.yaml" },
        },
      },
      event: {
        payloadRef: { manifestPath: "package.json", lockfilePath: "pnpm-lock.yaml" },
      },
    });
  });

  it("refuses replay after the persisted watch path drifts from the root pnpm profile", async () => {
    const source = await observe();
    const first = await createDraftAcceptanceRecordFromDependencyObservation(locator(source));
    await db.update(dependencyWatches).set({ lockfilePath: "packages/app/pnpm-lock.yaml" })
      .where(eq(dependencyWatches.id, source.watch.id));

    await expect(createDraftAcceptanceRecordFromDependencyObservation(locator(source)))
      .rejects.toMatchObject({ code: "unsafe_custody" } satisfies Partial<DependencyObservationDraftError>);
    await expect(db.select().from(changeRecords).where(eq(changeRecords.id, first.record.id)))
      .resolves.toHaveLength(1);
    await expect(db.select().from(acceptanceContracts).where(eq(acceptanceContracts.recordId, first.record.id)))
      .resolves.toHaveLength(1);
    await expect(db.select().from(changeRecordEvents).where(eq(changeRecordEvents.recordId, first.record.id)))
      .resolves.toHaveLength(1);
  });

  it("serializes concurrent exact requests into one create and one replay", async () => {
    const source = await observe();

    const results = await Promise.all([
      createDraftAcceptanceRecordFromDependencyObservation(locator(source)),
      createDraftAcceptanceRecordFromDependencyObservation(locator(source)),
    ]);

    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(new Set(results.map((result) => result.record.id))).toEqual(
      new Set([results[0]!.record.id])
    );
    expect(new Set(results.map((result) => result.contract.id))).toEqual(
      new Set([results[0]!.contract.id])
    );
    expect(new Set(results.map((result) => result.event.id))).toEqual(
      new Set([results[0]!.event.id])
    );
  });

  it("serializes draft minting behind a newer heartbeat observation and watch update", async () => {
    const source = await observeNpm();
    let markWriterLocked!: () => void;
    let releaseWriter!: () => void;
    const writerLocked = new Promise<void>((resolve) => { markWriterLocked = resolve; });
    const writerCanCommit = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const observedAt = new Date(source.observation.observedAt.getTime() + 1_000);
    const writer = db.transaction(async (tx) => {
      await tx.insert(dependencyWatchObservations).values({
        workspaceId,
        watchId: source.watch.id,
        repositoryId: source.repository.id,
        trigger: "scheduled",
        baselineSha: BASELINE,
        selectedFileHashes: {
          "package.json": MANIFEST_HASH,
          "package-lock.json": LOCKFILE_HASH,
        },
        observationKey: `unchanged:${randomUUID()}`,
        candidateFingerprint: null,
        status: "unchanged",
        candidates: [],
        observedAt,
      });
      await tx.update(dependencyWatches).set({
        status: "unchanged",
        candidateFingerprint: null,
        lastCheckedAt: observedAt,
        updatedAt: observedAt,
      }).where(and(
        eq(dependencyWatches.workspaceId, workspaceId),
        eq(dependencyWatches.id, source.watch.id),
      ));
      markWriterLocked();
      await writerCanCommit;
    });

    await writerLocked;
    const draft = createDraftAcceptanceRecordFromDependencyObservation(locator(source)).then(
      (value) => ({ kind: "resolved" as const, value }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    try {
      await expect(Promise.race([
        draft.then(() => "settled" as const),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 75)),
      ])).resolves.toBe("pending");
    } finally {
      releaseWriter();
      await writer;
    }

    await expect(draft).resolves.toMatchObject({
      kind: "rejected",
      error: { code: "not_found" },
    });
    await expect(db.select().from(changeRecords).where(eq(changeRecords.workspaceId, workspaceId)))
      .resolves.toHaveLength(0);
  });

  it("replays exact npm custody and conflicts on a stored profile drift", async () => {
    const source = await observeNpm();
    const first = await createDraftAcceptanceRecordFromDependencyObservation(locator(source));
    await expect(createDraftAcceptanceRecordFromDependencyObservation(locator(source))).resolves.toMatchObject({
      created: false,
      record: { id: first.record.id },
      profile: { manager: "npm", profile: "npm_package_lock_only_v1" },
    });

    const sourceReference = first.record.sourceReferences[0]!;
    await db.update(changeRecords).set({
      sourceReferences: [{
        ...sourceReference,
        profile: {
          ecosystem: "node",
          manager: "pnpm",
          profile: "pnpm_lockfile_only_v1",
          capability: "proposal_observation_only",
        },
      }],
    }).where(eq(changeRecords.id, first.record.id));

    await expect(createDraftAcceptanceRecordFromDependencyObservation(locator(source))).rejects.toMatchObject({
      code: "conflict",
    } satisfies Partial<DependencyObservationDraftError>);
    await expect(readDependencyDraftProposalDetail({
      workspaceId,
      recordId: first.record.id,
    })).resolves.toEqual({ kind: "invalid_custody" });
  });

  it.each(["record", "contract", "event"] as const)("replay validates the full immutable %s", async (part) => {
    const source = await observe();
    const first = await createDraftAcceptanceRecordFromDependencyObservation(locator(source));
    await expect(createDraftAcceptanceRecordFromDependencyObservation(locator(source))).resolves.toMatchObject({
      created: false,
      record: { id: first.record.id }, contract: { id: first.contract.id }, event: { id: first.event.id },
    });
    if (part === "record") {
      await db.update(changeRecords).set({ sourceReferences: [{ kind: "tampered" }] })
        .where(eq(changeRecords.id, first.record.id));
    } else if (part === "contract") {
      await db.update(acceptanceContracts).set({ contract: { kind: "tampered" } })
        .where(eq(acceptanceContracts.id, first.contract.id));
    } else {
      await db.update(changeRecordEvents).set({ payloadRef: { kind: "tampered" } })
        .where(eq(changeRecordEvents.id, first.event.id));
    }
    await expect(createDraftAcceptanceRecordFromDependencyObservation(locator(source))).rejects.toMatchObject({
      code: "conflict",
    } satisfies Partial<DependencyObservationDraftError>);
  });

  it.each([
    "extra earlier Contract",
    "later Contract",
    "extra event",
    "confirmedBy metadata",
    "confirmedAt metadata",
    "closed Record state",
    "PR-bound Record state",
  ] as const)("replay conflicts on %s", async (drift) => {
    const source = await observeNpm();
    const first = await createDraftAcceptanceRecordFromDependencyObservation(locator(source));

    if (drift === "extra earlier Contract" || drift === "later Contract") {
      await db.insert(acceptanceContracts).values({
        id: randomUUID(),
        recordId: first.record.id,
        version: drift === "extra earlier Contract" ? 0 : 2,
        status: "draft",
        contract: first.contract.contract,
        createdBy: "server:dependency-observation-proposal",
      });
    } else if (drift === "extra event") {
      await db.insert(changeRecordEvents).values({
        id: randomUUID(),
        recordId: first.record.id,
        eventKey: "dependency-observation-proposal:unexpected-later-event",
        stage: "dependency_observation_proposal",
        actor: "server:dependency-observation-proposal",
        payloadRef: first.event.payloadRef,
      });
    } else if (drift === "confirmedBy metadata") {
      await db.update(acceptanceContracts).set({ confirmedBy: "user:test" })
        .where(eq(acceptanceContracts.id, first.contract.id));
    } else if (drift === "confirmedAt metadata") {
      await db.update(acceptanceContracts).set({ confirmedAt: new Date() })
        .where(eq(acceptanceContracts.id, first.contract.id));
    } else if (drift === "closed Record state") {
      await db.update(changeRecords).set({ state: "closed" })
        .where(eq(changeRecords.id, first.record.id));
    } else {
      await db.update(changeRecords).set({ prNumber: 42 })
        .where(eq(changeRecords.id, first.record.id));
    }

    await expect(createDraftAcceptanceRecordFromDependencyObservation(locator(source))).rejects.toMatchObject({
      code: "conflict",
    } satisfies Partial<DependencyObservationDraftError>);
  });

  it("does not disclose watches across tenants", async () => {
    const source = await observe();
    const foreign = (await db.insert(workspaces).values({
      name: "foreign dependency proposal", slug: `foreign-proposal-${randomUUID()}`,
    }).returning({ id: workspaces.id }))[0]!.id;
    await expect(createDraftAcceptanceRecordFromDependencyObservation({
      workspaceId: foreign, watchId: source.watch.id, candidateFingerprint: fingerprintOf(source.candidate),
    })).rejects.toMatchObject({ code: "not_found" } satisfies Partial<DependencyObservationDraftError>);
  });

  it("does not disclose an npm watch across tenants", async () => {
    const source = await observeNpm();
    const foreign = (await db.insert(workspaces).values({
      name: "foreign npm dependency proposal",
      slug: `foreign-npm-proposal-${randomUUID()}`,
    }).returning({ id: workspaces.id }))[0]!.id;
    try {
      await expect(createDraftAcceptanceRecordFromDependencyObservation({
        workspaceId: foreign,
        watchId: source.watch.id,
        candidateFingerprint: fingerprintOf(source.candidate),
      })).rejects.toMatchObject({ code: "not_found" } satisfies Partial<DependencyObservationDraftError>);
      await expect(db.select().from(changeRecords).where(eq(changeRecords.workspaceId, foreign)))
        .resolves.toHaveLength(0);
    } finally {
      await db.delete(workspaces).where(eq(workspaces.id, foreign));
    }
  });

  it("projects only exact draft proposal custody and refuses an additional event", async () => {
    const source = await observe();
    const draft = await createDraftAcceptanceRecordFromDependencyObservation(locator(source));

    await expect(readDependencyDraftProposalDetail({ workspaceId, recordId: draft.record.id })).resolves.toMatchObject({
      kind: "draft",
      record: { id: draft.record.id, contractId: draft.contract.id, contractVersion: 1 },
      proposal: {
        candidate: { package: "@agentrail/widget", currentVersion: "1.0.0", targetVersion: "1.1.0" },
        files: {
          manifest: { path: "package.json", sha256: MANIFEST_HASH },
          lockfile: { path: "pnpm-lock.yaml", sha256: LOCKFILE_HASH },
        },
        profile: { ecosystem: "node", manager: "pnpm", capability: "proposal_observation_only" },
        evidenceAdmission: "unresolved",
        laterEvidence: { confirmation: "not_recorded", delivery: "not_recorded", result: "not_recorded" },
      },
    });
    const projection = await readDependencyDraftProposalDetail({ workspaceId, recordId: draft.record.id });
    expect(JSON.stringify(projection)).not.toContain("manager_commands");
    expect(JSON.stringify(projection)).not.toContain("verification_commands");

    await db.insert(changeRecordEvents).values({
      id: randomUUID(), recordId: draft.record.id, eventKey: "unexpected-later-event",
      stage: "unexpected", actor: "server:test", payloadRef: {},
    });
    await expect(readDependencyDraftProposalDetail({ workspaceId, recordId: draft.record.id })).resolves.toEqual({
      kind: "invalid_custody",
    });
  });

  it("does not disclose a draft proposal across tenants", async () => {
    const draft = await createProposalDraft();
    const foreignWorkspaceId = (await db.insert(workspaces).values({
      name: "foreign dependency proposal reader",
      slug: `foreign-proposal-reader-${randomUUID()}`,
    }).returning({ id: workspaces.id }))[0]!.id;
    try {
      await expect(readDependencyDraftProposalDetail({
        workspaceId: foreignWorkspaceId,
        recordId: draft.record.id,
      })).resolves.toEqual({ kind: "not_found" });
    } finally {
      await db.delete(workspaces).where(eq(workspaces.id, foreignWorkspaceId));
    }
  });

  it("fails closed when the proposal source reference is tampered", async () => {
    const draft = await createProposalDraft();
    const sourceReference = draft.record.sourceReferences[0]!;
    await db.update(changeRecords).set({
      sourceReferences: [{
        ...sourceReference,
        proposalCustodyIdentity: `sha256:${"f".repeat(64)}`,
      }],
    }).where(eq(changeRecords.id, draft.record.id));

    await expect(readDependencyDraftProposalDetail({
      workspaceId,
      recordId: draft.record.id,
    })).resolves.toEqual({ kind: "invalid_custody" });
  });

  it("recomputes custody and rejects coherent source, Contract, and event tampering", async () => {
    const draft = await createProposalDraft();
    const candidate = pnpmCandidate({
      package: "@agentrail/forged-widget",
      current_version: "2.0.0",
      target_version: "2.1.0",
      specifier: "^2.0.0",
      manager_commands: {
        version: "pnpm --version",
        install: "pnpm install --frozen-lockfile",
        update: "pnpm update --lockfile-only --ignore-scripts @agentrail/forged-widget@2.1.0",
      },
    });
    const sourceReference = draft.record.sourceReferences[0]!;
    const environment = (draft.contract.contract.environment as Record<string, unknown>);
    await db.update(changeRecords).set({
      sourceReferences: [{
        ...sourceReference,
        candidate,
        candidateFingerprint: candidate.fingerprint,
      }],
    }).where(eq(changeRecords.id, draft.record.id));
    await db.update(acceptanceContracts).set({
      contract: {
        ...draft.contract.contract,
        originalRequest: "Assess observed dependency candidate @agentrail/forged-widget from 2.0.0 to 2.1.0.",
        environment: {
          ...environment,
          candidate,
          candidateFingerprint: candidate.fingerprint,
        },
      },
    }).where(eq(acceptanceContracts.id, draft.contract.id));
    await db.update(changeRecordEvents).set({
      payloadRef: {
        ...draft.event.payloadRef,
        candidate,
        candidateFingerprint: candidate.fingerprint,
      },
    }).where(eq(changeRecordEvents.id, draft.event.id));

    await expect(readDependencyDraftProposalDetail({
      workspaceId,
      recordId: draft.record.id,
    })).resolves.toEqual({ kind: "invalid_custody" });
  });

  it("rejects a coherently replaced deterministic Contract identity", async () => {
    const draft = await createProposalDraft();
    const forgedContractId = randomUUID();
    await db.update(acceptanceContracts).set({ id: forgedContractId })
      .where(eq(acceptanceContracts.id, draft.contract.id));
    await db.update(changeRecordEvents).set({
      payloadRef: {
        ...draft.event.payloadRef,
        acceptanceContractId: forgedContractId,
      },
    }).where(eq(changeRecordEvents.id, draft.event.id));

    await expect(readDependencyDraftProposalDetail({
      workspaceId,
      recordId: draft.record.id,
    })).resolves.toEqual({ kind: "invalid_custody" });
  });

  it("fails closed when the draft Contract is tampered", async () => {
    const draft = await createProposalDraft();
    await db.update(acceptanceContracts).set({
      contract: {
        ...draft.contract.contract,
        originalRequest: "Assess a different dependency candidate.",
      },
    }).where(eq(acceptanceContracts.id, draft.contract.id));

    await expect(readDependencyDraftProposalDetail({
      workspaceId,
      recordId: draft.record.id,
    })).resolves.toEqual({ kind: "invalid_custody" });
  });

  it("fails closed when the proposal event is tampered", async () => {
    const draft = await createProposalDraft();
    await db.update(changeRecordEvents).set({
      payloadRef: { ...draft.event.payloadRef, evidenceAdmission: "admitted" },
    }).where(eq(changeRecordEvents.id, draft.event.id));

    await expect(readDependencyDraftProposalDetail({
      workspaceId,
      recordId: draft.record.id,
    })).resolves.toEqual({ kind: "invalid_custody" });
  });

  it("fails closed when a duplicate Contract row exists", async () => {
    const draft = await createProposalDraft();
    await db.insert(acceptanceContracts).values({
      id: randomUUID(),
      recordId: draft.record.id,
      version: 0,
      status: "draft",
      contract: draft.contract.contract,
      createdBy: "server:dependency-observation-proposal",
    });

    await expect(readDependencyDraftProposalDetail({
      workspaceId,
      recordId: draft.record.id,
    })).resolves.toEqual({ kind: "invalid_custody" });
  });

  it("fails closed when a later-version Contract exists", async () => {
    const draft = await createProposalDraft();
    await db.insert(acceptanceContracts).values({
      id: randomUUID(),
      recordId: draft.record.id,
      version: 2,
      status: "draft",
      contract: draft.contract.contract,
      createdBy: "server:dependency-observation-proposal",
    });

    await expect(readDependencyDraftProposalDetail({
      workspaceId,
      recordId: draft.record.id,
    })).resolves.toEqual({ kind: "invalid_custody" });
  });

  it("does not reuse a candidate after newer failed or unchanged observations", async () => {
    const source = await observe({ observedAt: new Date("2026-01-01T00:00:00.000Z") });
    await addObservation({ watch: source.watch, status: "failed", observedAt: new Date("2026-01-01T00:00:01.000Z") });
    await expect(createDraftAcceptanceRecordFromDependencyObservation(locator(source))).rejects.toMatchObject({
      code: "not_found",
    } satisfies Partial<DependencyObservationDraftError>);
    await addObservation({ watch: source.watch, status: "unchanged", observedAt: new Date("2026-01-01T00:00:02.000Z") });
    await expect(createDraftAcceptanceRecordFromDependencyObservation(locator(source))).rejects.toMatchObject({
      code: "not_found",
    } satisfies Partial<DependencyObservationDraftError>);
  });

  it.each([
    ["baseline", { candidate: pnpmCandidate({ baseline_sha: "d".repeat(40) }) }],
    ["hash", { hashes: { "package.json": MANIFEST_HASH, "pnpm-lock.yaml": "wrong" } }],
    ["path", { candidate: pnpmCandidate({ manifest_path: "packages/app/package.json" }) }],
    ["non-null package-manager version", { candidate: { ...pnpmCandidate(), package_manager_version: "10.14.0" } }],
    ["extra candidate key", { candidate: { ...pnpmCandidate(), untrusted: "authority" } }],
  ])("fails closed for bad %s custody", async (_name, input) => {
    const source = await observe(input);
    await expect(createDraftAcceptanceRecordFromDependencyObservation(locator(source))).rejects.toMatchObject({
      code: "unsafe_custody",
    } satisfies Partial<DependencyObservationDraftError>);
  });

  it.each([
    ["baseline drift", npmCandidate({ baseline_sha: "d".repeat(40) }), undefined],
    ["selected hash drift", npmCandidate(), {
      "package.json": MANIFEST_HASH,
      "package-lock.json": "wrong",
    }],
    ["manifest path drift", npmCandidate({ manifest_path: "packages/app/package.json" }), undefined],
    ["manager version drift", { ...npmCandidate(), package_manager_version: "10.8.2" }, undefined],
    ["update command drift", npmCandidate({
      manager_commands: {
        version: "npm --version",
        install: "npm ci --ignore-scripts",
        update: "npm install lodash@4.17.22 --package-lock-only --ignore-scripts --no-audit --save-dev",
      },
    }), undefined],
    ["injected adapter profile", { ...npmCandidate(), adapter_profile: "npm_package_lock_only_v1" }, undefined],
    ["injected adapter digest", { ...npmCandidate(), adapter_identity_fingerprint: `sha256:${"f".repeat(64)}` }, undefined],
  ] as const)("fails closed for npm %s", async (_name, candidate, hashes) => {
    const source = await observeNpm({ candidate, ...(hashes ? { hashes } : {}) });

    await expect(createDraftAcceptanceRecordFromDependencyObservation(locator(source))).rejects.toMatchObject({
      code: "unsafe_custody",
    } satisfies Partial<DependencyObservationDraftError>);
    await expect(db.select().from(changeRecords).where(eq(changeRecords.workspaceId, workspaceId)))
      .resolves.toHaveLength(0);
  });

  it("rejects duplicate npm candidates with one fingerprint as ambiguous custody", async () => {
    const source = await observeNpm();
    await db.update(dependencyWatchObservations).set({
      candidates: [source.candidate, source.candidate],
    }).where(eq(dependencyWatchObservations.id, source.observation.id));

    await expect(createDraftAcceptanceRecordFromDependencyObservation(locator(source))).rejects.toMatchObject({
      code: "unsafe_custody",
    } satisfies Partial<DependencyObservationDraftError>);
    await expect(db.select().from(changeRecords).where(eq(changeRecords.workspaceId, workspaceId)))
      .resolves.toHaveLength(0);
  });

  it("rejects extra caller authority and an unbounded hash map", async () => {
    const source = await observe();
    await expect(createDraftAcceptanceRecordFromDependencyObservation({
      ...locator(source), repositoryId: source.repository.id,
    } as never)).rejects.toMatchObject({ code: "unsafe_custody" } satisfies Partial<DependencyObservationDraftError>);
    await expect(createDraftAcceptanceRecordFromDependencyObservation({
      ...locator(source), manifestPath: "package.json", lockfilePath: "pnpm-lock.yaml",
    } as never)).rejects.toMatchObject({ code: "unsafe_custody" } satisfies Partial<DependencyObservationDraftError>);

    const hashes = { "package.json": MANIFEST_HASH, "pnpm-lock.yaml": LOCKFILE_HASH } as Record<string, string>;
    for (let i = 0; i < 15; i += 1) hashes[`extra-${i}.txt`] = "e".repeat(64);
    const oversized = await observe({ hashes });
    await expect(createDraftAcceptanceRecordFromDependencyObservation(locator(oversized))).rejects.toMatchObject({
      code: "unsafe_custody",
    } satisfies Partial<DependencyObservationDraftError>);
  });

  it.each<[string, string, string]>([
    ["Yarn", "node", "yarn"], ["Bun", "node", "bun"],
    ["pip", "python", "pip"], ["Poetry", "python", "poetry"], ["uv", "python", "uv"],
    ["Maven", "java", "maven"], ["Gradle", "java", "gradle"], ["dotnet", "dotnet", "dotnet"],
    ["Composer", "php", "composer"], ["Cargo", "rust", "cargo"], ["Go", "go", "go-modules"],
  ])("refuses %s managers without a legacy pre-PR draft profile", async (_name, ecosystem, manager) => {
    const source = await observe({
      candidate: pnpmCandidate({ ecosystem, package_manager: manager }),
    });
    await expect(createDraftAcceptanceRecordFromDependencyObservation(locator(source))).rejects.toMatchObject({
      code: "unsupported_manager",
    } satisfies Partial<DependencyObservationDraftError>);
  });
});
