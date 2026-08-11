import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const state = vi.hoisted(() => ({
  selectRows: [] as unknown[],
  returningRows: [] as unknown[],
  executed: [] as unknown[],
  insertedValues: [] as unknown[],
  updatedValues: [] as unknown[],
}));
vi.mock("../db.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => state.selectRows,
          then: (resolve: (value: unknown[]) => unknown) => resolve(state.selectRows),
        }),
        then: (resolve: (value: unknown[]) => unknown) => resolve(state.selectRows),
      }),
    }),
    insert: () => ({
      values: (values: unknown) => {
        state.insertedValues.push(values);
        return {
          then: undefined,
          values,
          onConflictDoUpdate: () => ({ returning: async () => state.returningRows }),
          onConflictDoNothing: () => ({ returning: async () => state.returningRows }),
        };
      },
    }),
    update: () => ({
      set: (values: unknown) => ({
        where: () => ({
          returning: async () => {
            state.updatedValues.push(values);
            return state.returningRows;
          },
        }),
      }),
    }),
    execute: async (query: unknown) => { state.executed.push(query); return []; },
  },
}));

import {
  DependencyWatchAuthorizationError,
  DependencyWatchValidationError,
  claimDueDependencyWatches,
  createDependencyWatch,
  recordDependencyWatchObservation,
  triggerDependencyWatch,
  triggerDependencyWatchesForPush,
} from "./dependency_watches.js";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function goSourceReceipt(
  repository = "ada/widgets",
  extraEntries: Array<{ path: string; mode: string; type: string; objectSha: string }> = [],
) {
  const entries = [
    { path: "go.mod", mode: "100644", type: "blob", objectSha: "c".repeat(40) },
    { path: "go.sum", mode: "100644", type: "blob", objectSha: "d".repeat(40) },
    ...extraEntries,
  ].sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  const withoutIdentity = {
    kind: "github_exact_tree_dependency_source_inventory",
    schemaVersion: 1,
    identity: {
      ecosystem: "go",
      manager: "go-modules",
      profile: "go_github_exact_tree_source_inventory_v1",
    },
    authority: {
      provider: "github",
      method: "github_app_installation_api",
      apiOrigin: "https://api.github.com",
      repository,
      requestedRef: "main",
      commitSha: "a".repeat(40),
      rootTreeSha: "b".repeat(40),
    },
    inventory: {
      recursive: true,
      truncated: false,
      entryCount: entries.length,
      entries,
      entriesSha256: sha256(entries),
    },
    requiredFiles: [
      { path: "go.mod", mode: "100644", blobSha: "c".repeat(40), byteCount: 32, contentSha256: "e".repeat(64) },
      { path: "go.sum", mode: "100644", blobSha: "d".repeat(40), byteCount: 64, contentSha256: "f".repeat(64) },
    ],
    policy: { name: "go_root_source_inventory_v1", result: "admitted" },
  };
  const identitySha256 = sha256(withoutIdentity);
  return { receipt: { ...withoutIdentity, identitySha256 }, identitySha256 };
}

function sourceWatch(overrides: Record<string, unknown> = {}) {
  return {
    id: "watch-1",
    workspaceId: "ws-1",
    repositoryId: "repo-1",
    name: "Ada/Widgets",
    manifestPath: "go.mod",
    lockfilePath: "go.sum",
    ...overrides,
  };
}

function goCandidate(overrides: Record<string, unknown> = {}) {
  return {
    ecosystem: "go",
    package_manager: "go-modules",
    manifest_path: "go.mod",
    lockfile_path: "go.sum",
    baseline_sha: "a".repeat(40),
    ...overrides,
  };
}

beforeEach(() => {
  state.selectRows = [];
  state.returningRows = [];
  state.executed = [];
  state.insertedValues = [];
  state.updatedValues = [];
});

describe("dependency watch database authorization and claims", () => {
  it("rejects configuration when the repository is not in the workspace", async () => {
    await expect(createDependencyWatch({ workspaceId: "ws-1", repositoryId: "repo-other" }))
      .rejects.toBeInstanceOf(DependencyWatchAuthorizationError);
  });

  it("rejects a manual trigger for a watch outside the workspace", async () => {
    await expect(triggerDependencyWatch("ws-1", "watch-other", "manual"))
      .rejects.toBeInstanceOf(DependencyWatchAuthorizationError);
  });

  it("uses an atomic, workspace-scoped SKIP LOCKED due-watch claim", async () => {
    await claimDueDependencyWatches("ws-1", new Date("2026-08-03T00:00:00Z"));
    expect(state.executed).toHaveLength(1);
    const query = state.executed[0] as { queryChunks?: unknown[] };
    expect(query).toBeDefined();
  });

  it("stores the actual candidate fingerprint separately from the observation key", async () => {
    state.selectRows = [{
      id: "watch-1",
      workspaceId: "ws-1",
      repositoryId: "repo-1",
    }];
    state.returningRows = [{ id: "observation-1" }, { id: "watch-1" }];

    await recordDependencyWatchObservation({
      workspaceId: "ws-1",
      watchId: "watch-1",
      repositoryId: "repo-1",
      trigger: "manual",
      baselineSha: "sha-1",
      selectedFileHashes: { "package.json": "hash" },
      observationKey: "candidates:dedupe-key",
      candidateFingerprint: "sha256:candidate-1",
      status: "candidates",
      candidates: [{ fingerprint: "sha256:candidate-1" }],
      observedAt: new Date("2026-08-03T00:00:00Z"),
    });

    expect(state.updatedValues).toHaveLength(1);
    expect((state.updatedValues[0] as { candidateFingerprint?: string }).candidateFingerprint).toBe("sha256:candidate-1");
    expect(state.insertedValues[0]).toMatchObject({
      sourceInventoryReceipt: null,
      sourceInventoryReceiptSha256: null,
    });
  });

  it("stores one recomputable source receipt only when its declared identity matches", async () => {
    state.selectRows = [sourceWatch()];
    state.returningRows = [{ id: "observation-1" }, { id: "watch-1" }];
    const source = goSourceReceipt();

    await recordDependencyWatchObservation({
      workspaceId: "ws-1",
      watchId: "watch-1",
      repositoryId: "repo-1",
      trigger: "manual",
      baselineSha: "a".repeat(40),
      selectedFileHashes: { "go.mod": "e".repeat(64), "go.sum": "f".repeat(64) },
      observationKey: `candidates:source:${source.identitySha256}`,
      status: "candidates",
      candidates: [goCandidate()],
      sourceInventoryReceipt: source.receipt,
      sourceInventoryReceiptSha256: source.identitySha256,
    });

    expect(state.insertedValues[0]).toMatchObject({
      sourceInventoryReceipt: source.receipt,
      sourceInventoryReceiptSha256: source.identitySha256,
    });
    expect(state.updatedValues[0]).not.toHaveProperty("sourceInventoryReceipt");
  });

  it("refuses a caller-declared receipt digest that is not recomputable", async () => {
    state.selectRows = [{ id: "watch-1", workspaceId: "ws-1", repositoryId: "repo-1" }];
    const source = goSourceReceipt();

    await expect(recordDependencyWatchObservation({
      workspaceId: "ws-1",
      watchId: "watch-1",
      repositoryId: "repo-1",
      trigger: "manual",
      baselineSha: "a".repeat(40),
      selectedFileHashes: {},
      observationKey: "forged",
      status: "candidates",
      sourceInventoryReceipt: source.receipt,
      sourceInventoryReceiptSha256: "0".repeat(64),
    })).rejects.toBeInstanceOf(DependencyWatchValidationError);

    expect(state.insertedValues).toHaveLength(0);
  });

  it("refuses a valid altered receipt when its identity is not bound to the observation key", async () => {
    state.selectRows = [{ id: "watch-1", workspaceId: "ws-1", repositoryId: "repo-1" }];
    const original = goSourceReceipt();
    const altered = goSourceReceipt("ada/other-widgets");

    await expect(recordDependencyWatchObservation({
      workspaceId: "ws-1",
      watchId: "watch-1",
      repositoryId: "repo-1",
      trigger: "manual",
      baselineSha: "a".repeat(40),
      selectedFileHashes: {},
      observationKey: `candidates:source:${original.identitySha256}`,
      status: "candidates",
      sourceInventoryReceipt: altered.receipt,
      sourceInventoryReceiptSha256: altered.identitySha256,
    })).rejects.toBeInstanceOf(DependencyWatchValidationError);

    expect(state.insertedValues).toHaveLength(0);
  });

  it.each([
    ["wrong repository", { watch: { name: "other/widgets" } }],
    ["wrong commit", { input: { baselineSha: "b".repeat(40) } }],
    ["extra selected file", { input: { selectedFileHashes: {
      "go.mod": "e".repeat(64), "go.sum": "f".repeat(64), "go.work": "1".repeat(64),
    } } }],
    ["wrong selected hash", { input: { selectedFileHashes: {
      "go.mod": "0".repeat(64), "go.sum": "f".repeat(64),
    } } }],
    ["non-root watch", { watch: { manifestPath: "nested/go.mod" } }],
    ["empty candidates", { input: { candidates: [] } }],
    ["non-Go candidate", { input: { candidates: [goCandidate({ ecosystem: "node" })] } }],
    ["wrong candidate baseline", { input: { candidates: [goCandidate({ baseline_sha: "b".repeat(40) })] } }],
    ["non-candidate with candidates", { input: { status: "failed", candidates: [goCandidate()] } }],
  ] as const)("rejects receipt row binding with %s", async (_name, changes) => {
    const source = goSourceReceipt();
    state.selectRows = [sourceWatch(changes.watch ?? {})];
    const base = {
      workspaceId: "ws-1",
      watchId: "watch-1",
      repositoryId: "repo-1",
      trigger: "manual" as const,
      baselineSha: "a".repeat(40),
      selectedFileHashes: { "go.mod": "e".repeat(64), "go.sum": "f".repeat(64) },
      observationKey: `candidates:source:${source.identitySha256}`,
      status: "candidates" as const,
      candidates: [goCandidate()],
      sourceInventoryReceipt: source.receipt,
      sourceInventoryReceiptSha256: source.identitySha256,
    };

    await expect(recordDependencyWatchObservation({
      ...base,
      ...(changes.input ?? {}),
    } as typeof base)).rejects.toBeInstanceOf(DependencyWatchValidationError);
    expect(state.insertedValues).toHaveLength(0);
  });

  it("rejects a canonical receipt whose aggregate ASCII path bytes exceed 8 MiB", async () => {
    const tail = "a".repeat(4070);
    const source = goSourceReceipt("ada/widgets", Array.from({ length: 2059 }, (_, index) => ({
      path: `p${String(index).padStart(4, "0")}/${tail}`,
      mode: "100644",
      type: "blob",
      objectSha: "9".repeat(40),
    })));
    state.selectRows = [sourceWatch()];

    await expect(recordDependencyWatchObservation({
      workspaceId: "ws-1", watchId: "watch-1", repositoryId: "repo-1",
      trigger: "manual", baselineSha: "a".repeat(40),
      selectedFileHashes: { "go.mod": "e".repeat(64), "go.sum": "f".repeat(64) },
      observationKey: `candidates:source:${source.identitySha256}`,
      status: "candidates", candidates: [goCandidate()],
      sourceInventoryReceipt: source.receipt,
      sourceInventoryReceiptSha256: source.identitySha256,
    })).rejects.toBeInstanceOf(DependencyWatchValidationError);
    expect(state.insertedValues).toHaveLength(0);
  });

  it.each([
    ["non-ASCII path", "café/file.go"],
    ["workspace file", "go.work"],
    ["nested module", "nested/go.sum"],
    ["vendor", "src/vendor/lib.go"],
    ["credential config", "home/.netrc"],
    ["Git config", "tools/.gitconfig"],
    ["Go env", "nested/.goenv"],
    ["Go env file", "go.env"],
    ["XDG Go env", "nested/.config/go/env"],
  ])("rejects source receipt %s before insert", async (_name, path) => {
    const source = goSourceReceipt("ada/widgets", [{
      path, mode: "100644", type: "blob", objectSha: "9".repeat(40),
    }]);
    state.selectRows = [sourceWatch()];

    await expect(recordDependencyWatchObservation({
      workspaceId: "ws-1", watchId: "watch-1", repositoryId: "repo-1",
      trigger: "manual", baselineSha: "a".repeat(40),
      selectedFileHashes: { "go.mod": "e".repeat(64), "go.sum": "f".repeat(64) },
      observationKey: `candidates:source:${source.identitySha256}`,
      status: "candidates", candidates: [goCandidate()],
      sourceInventoryReceipt: source.receipt,
      sourceInventoryReceiptSha256: source.identitySha256,
    })).rejects.toBeInstanceOf(DependencyWatchValidationError);
    expect(state.insertedValues).toHaveLength(0);
  });

  it("triggers auto watches when the selected dependency files changed", async () => {
    state.selectRows = [{
      id: "watch-1",
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      manifestPath: "auto",
      lockfilePath: "auto",
      selectedFileHashes: { "package.json": "hash-1", "pnpm-lock.yaml": "hash-2" },
    }];
    state.returningRows = [{
      id: "watch-1",
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      manifestPath: "auto",
      lockfilePath: "auto",
    }];

    const triggered = await triggerDependencyWatchesForPush("ws-1", "repo-1", ["./package.json"]);

    expect(triggered).toHaveLength(1);
  });

  it("does not trigger auto watches for unrelated push paths", async () => {
    state.selectRows = [{
      id: "watch-1",
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      manifestPath: "auto",
      lockfilePath: "auto",
      selectedFileHashes: { "package.json": "hash-1", "pnpm-lock.yaml": "hash-2" },
    }];

    const triggered = await triggerDependencyWatchesForPush("ws-1", "repo-1", ["README.md"]);

    expect(triggered).toHaveLength(0);
    expect(state.updatedValues).toHaveLength(0);
  });
});
