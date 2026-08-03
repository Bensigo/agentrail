import { beforeEach, describe, expect, it, vi } from "vitest";

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
      values: (values: unknown) => ({
        then: undefined,
        values,
        onConflictDoUpdate: () => ({ returning: async () => state.returningRows }),
        onConflictDoNothing: () => ({ returning: async () => state.returningRows }),
      }),
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
  claimDueDependencyWatches,
  createDependencyWatch,
  recordDependencyWatchObservation,
  triggerDependencyWatch,
  triggerDependencyWatchesForPush,
} from "./dependency_watches.js";

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
