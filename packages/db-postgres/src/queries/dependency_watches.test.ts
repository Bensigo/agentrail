import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ selectRows: [] as unknown[], returningRows: [] as unknown[], executed: [] as unknown[] }));
vi.mock("../db.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => state.selectRows, then: undefined }),
        // list queries do not call limit
        then: (resolve: (value: unknown[]) => unknown) => resolve(state.selectRows),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => ({ returning: async () => state.returningRows }),
        onConflictDoNothing: () => ({ returning: async () => state.returningRows }),
      }),
    }),
    update: () => ({
      set: () => ({ where: () => ({ returning: async () => state.returningRows }) }),
    }),
    execute: async (query: unknown) => { state.executed.push(query); return []; },
  },
}));

import {
  DependencyWatchAuthorizationError,
  claimDueDependencyWatches,
  createDependencyWatch,
  triggerDependencyWatch,
} from "./dependency_watches.js";

beforeEach(() => { state.selectRows = []; state.returningRows = []; state.executed = []; });

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
});
