import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
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
  pnpmObservationCandidateFingerprint,
  validatePnpmObservationProposalCandidate,
  type DependencyObservationDraftError,
} from "../queries/dependency_observation_acceptance_records.js";

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

type PnpmProducerCandidate = Omit<
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
      manifestPath: "package.json",
      lockfilePath: "pnpm-lock.yaml",
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

  it("does not disclose watches across tenants", async () => {
    const source = await observe();
    const foreign = (await db.insert(workspaces).values({
      name: "foreign dependency proposal", slug: `foreign-proposal-${randomUUID()}`,
    }).returning({ id: workspaces.id }))[0]!.id;
    await expect(createDraftAcceptanceRecordFromDependencyObservation({
      workspaceId: foreign, watchId: source.watch.id, candidateFingerprint: fingerprintOf(source.candidate),
    })).rejects.toMatchObject({ code: "not_found" } satisfies Partial<DependencyObservationDraftError>);
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

  it("rejects extra caller authority and an unbounded hash map", async () => {
    const source = await observe();
    await expect(createDraftAcceptanceRecordFromDependencyObservation({
      ...locator(source), repositoryId: source.repository.id,
    } as never)).rejects.toMatchObject({ code: "unsafe_custody" } satisfies Partial<DependencyObservationDraftError>);

    const hashes = { "package.json": MANIFEST_HASH, "pnpm-lock.yaml": LOCKFILE_HASH } as Record<string, string>;
    for (let i = 0; i < 15; i += 1) hashes[`extra-${i}.txt`] = "e".repeat(64);
    const oversized = await observe({ hashes });
    await expect(createDraftAcceptanceRecordFromDependencyObservation(locator(oversized))).rejects.toMatchObject({
      code: "unsafe_custody",
    } satisfies Partial<DependencyObservationDraftError>);
  });

  it.each<[string, string, string]>([
    ["npm", "node", "npm"], ["Yarn", "node", "yarn"], ["Bun", "node", "bun"],
    ["pip", "python", "pip"], ["Poetry", "python", "poetry"], ["uv", "python", "uv"],
    ["Maven", "jvm", "maven"], ["Gradle", "jvm", "gradle"], ["dotnet", "dotnet", "dotnet"],
    ["Composer", "php", "composer"], ["Cargo", "rust", "cargo"], ["Go", "go", "go"],
  ])("refuses detected-only %s managers", async (_name, ecosystem, manager) => {
    const source = await observe({
      candidate: pnpmCandidate({ ecosystem, package_manager: manager }),
    });
    await expect(createDraftAcceptanceRecordFromDependencyObservation(locator(source))).rejects.toMatchObject({
      code: "unsupported_manager",
    } satisfies Partial<DependencyObservationDraftError>);
  });
});
