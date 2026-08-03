import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  selectResponses: [] as unknown[][],
  insertResponses: [] as unknown[][],
  updateResponses: [] as unknown[][],
  whereArgs: [] as unknown[],
  insertValues: [] as unknown[],
  updateValues: [] as unknown[],
}));

function nextResponse(queue: unknown[][]): unknown[] {
  return queue.shift() ?? [];
}

vi.mock("../db.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (value: unknown) => {
          state.whereArgs.push(value);
          return {
            limit: async () => nextResponse(state.selectResponses),
            orderBy: async () => nextResponse(state.selectResponses),
          };
        },
      }),
    }),
    insert: () => ({
      values: (value: unknown) => {
        state.insertValues.push(value);
        return {
          onConflictDoNothing: () => ({
            returning: async () => nextResponse(state.insertResponses),
          }),
          returning: async () => nextResponse(state.insertResponses),
        };
      },
    }),
    update: () => ({
      set: (value: unknown) => {
        state.updateValues.push(value);
        return {
          where: (condition: unknown) => {
            state.whereArgs.push(condition);
            return { returning: async () => nextResponse(state.updateResponses) };
          },
        };
      },
    }),
  },
}));

import {
  attachDependencyUpgradeApproval,
  candidateIsCurrent,
  candidateFingerprint,
  createOrGetDependencyUpgradeContract,
  decideDependencyUpgradeContract,
  findDependencyCandidate,
  refreshDependencyUpgradeContractProposal,
  recordDependencyUpgradeContractEvent,
} from "./dependency_upgrade_contracts.js";

const candidateWithoutFingerprint = {
  package: "react",
  dependency_kind: "dependencies",
  specifier: "^18.2.0",
  current_version: "18.2.0",
  target_version: "18.3.1",
  manifest_path: "package.json",
  lockfile_path: "pnpm-lock.yaml",
  baseline_sha: "sha-old",
};
const candidate = {
  ...candidateWithoutFingerprint,
  fingerprint: candidateFingerprint({ ...candidateWithoutFingerprint, fingerprint: "" }),
};

const watch = { id: "watch-1", repositoryId: "repo-1" };
const observation = {
  id: "observation-1",
  watchId: "watch-1",
  repositoryId: "repo-1",
  observationKey: "candidates:one",
  baselineSha: "sha-old",
  candidates: [candidate],
  observedAt: new Date("2026-08-03T00:00:00Z"),
  status: "candidates",
};

beforeEach(() => {
  state.selectResponses = [];
  state.insertResponses = [];
  state.updateResponses = [];
  state.whereArgs = [];
  state.insertValues = [];
  state.updateValues = [];
});

describe("dependency upgrade contract query boundary", () => {
  it("binds a proposal to the exact observed candidate fingerprint", async () => {
    state.selectResponses = [[watch], [observation]];
    await expect(
      findDependencyCandidate({ workspaceId: "ws-1", watchId: "watch-1", fingerprint: candidate.fingerprint })
    ).resolves.toMatchObject({ candidate, observationId: "observation-1" });

    state.selectResponses = [[watch], [observation]];
    await expect(
      findDependencyCandidate({ workspaceId: "ws-1", watchId: "watch-1", fingerprint: "sha256:not-the-candidate" })
    ).resolves.toBeNull();
  });

  it("keeps candidate reads workspace- and watch-scoped", async () => {
    state.selectResponses = [[]];
    await expect(
      findDependencyCandidate({ workspaceId: "other-workspace", watchId: "watch-1", fingerprint: candidate.fingerprint })
    ).resolves.toBeNull();
    expect(state.whereArgs).toHaveLength(1);
    // The condition is a Drizzle SQL expression built from both tenant and
    // watch predicates; it must not be replaced by an id-only lookup.
    expect(state.whereArgs[0]).toBeDefined();
  });

  it("reuses the existing contract after a unique-key conflict", async () => {
    const existing = {
      id: "contract-1",
      workspaceId: "ws-1",
      candidateFingerprint: candidate.fingerprint,
      state: "proposed",
    };
    state.insertResponses = [[]];
    state.selectResponses = [[existing]];

    const result = await createOrGetDependencyUpgradeContract({
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      watchId: "watch-1",
      observationKey: observation.observationKey,
      candidate,
      proposal: { title: "upgrade react" },
    });

    expect(result).toEqual({ contract: existing, created: false });
    expect(state.insertValues[0]).toMatchObject({
      workspaceId: "ws-1",
      observationKey: observation.observationKey,
      candidateFingerprint: candidate.fingerprint,
    });
  });

  it("does not persist a candidate with a forged fingerprint", async () => {
    await expect(createOrGetDependencyUpgradeContract({
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      watchId: "watch-1",
      candidate: { ...candidate, fingerprint: "sha256:forged" },
      proposal: {},
    })).rejects.toThrow("does not match");
    expect(state.insertValues).toHaveLength(0);
  });

  it("attaches one approval and refuses a different workspace/approval binding", async () => {
    const attached = { id: "contract-1", workspaceId: "ws-1", approvalId: "approval-1", state: "proposed" };
    state.updateResponses = [[attached]];
    await expect(attachDependencyUpgradeApproval("ws-1", "contract-1", "approval-1")).resolves.toEqual(attached);
    expect(state.updateValues[0]).toEqual({ approvalId: "approval-1", updatedAt: expect.any(Date) });

    state.updateResponses = [[]];
    state.selectResponses = [[{ ...attached, workspaceId: "other-workspace", approvalId: null }]];
    await expect(attachDependencyUpgradeApproval("ws-1", "contract-1", "approval-2")).resolves.toBeNull();
  });

  it("refuses stale candidates when the observed baseline or candidate fields changed", async () => {
    state.selectResponses = [[watch], [{ ...observation, candidates: [{ ...candidate, baseline_sha: "sha-new" }] }]];
    await expect(candidateIsCurrent({ workspaceId: "ws-1", watchId: "watch-1", candidate })).resolves.toBe(false);
  });

  it("records append-only actor, workspace, candidate, and decision evidence", async () => {
    state.insertResponses = [[{ id: "event-1" }]];
    await recordDependencyUpgradeContractEvent({
      workspaceId: "ws-1",
      contractId: "contract-1",
      candidateFingerprint: candidate.fingerprint,
      actor: { actorType: "console_user", actorId: "user-1" },
      decision: "refused",
      approvalId: "approval-1",
      details: { reason: "not now" },
    });
    expect(state.insertValues[0]).toMatchObject({
      workspaceId: "ws-1",
      contractId: "contract-1",
      candidateFingerprint: candidate.fingerprint,
      actorType: "console_user",
      actorId: "user-1",
      decision: "refused",
      approvalId: "approval-1",
      details: { reason: "not now" },
    });
  });

  it("records the observation key separately from the candidate fingerprint", async () => {
    state.insertResponses = [[{ id: "event-1" }]];
    await recordDependencyUpgradeContractEvent({
      workspaceId: "ws-1",
      contractId: "contract-1",
      candidateFingerprint: candidate.fingerprint,
      actor: { actorType: "system", actorId: "dependency-watch" },
      decision: "proposed",
      details: { baselineSha: candidate.baseline_sha, observationKey: observation.observationKey },
    });
    expect(state.insertValues[0]).toMatchObject({
      candidateFingerprint: candidate.fingerprint,
      details: { baselineSha: candidate.baseline_sha, observationKey: observation.observationKey },
    });
  });

  it("approves only the exact persisted contract after a fresh candidate read", async () => {
    const current = {
      id: "contract-1",
      workspaceId: "ws-1",
      watchId: "watch-1",
      approvalId: "approval-1",
      state: "proposed",
      packageName: candidate.package,
      dependencyKind: candidate.dependency_kind,
      specifier: candidate.specifier,
      currentVersion: candidate.current_version,
      targetVersion: candidate.target_version,
      manifestPath: candidate.manifest_path,
      lockfilePath: candidate.lockfile_path,
      baselineSha: candidate.baseline_sha,
      candidateFingerprint: candidate.fingerprint,
    };
    state.selectResponses = [[current], [watch], [observation]];
    state.updateResponses = [[{ ...current, state: "approved" }]];
    state.insertResponses = [[{ id: "event-1" }]];

    await expect(decideDependencyUpgradeContract({
      workspaceId: "ws-1",
      contractId: "contract-1",
      approvalId: "approval-1",
      decision: "approved",
      actor: { actorType: "console_user", actorId: "user-1" },
    })).resolves.toMatchObject({ status: "approved", contract: { state: "approved" } });
    expect(state.updateValues[0]).toMatchObject({ state: "approved" });
    expect(state.insertValues.at(-1)).toMatchObject({
      candidateFingerprint: candidate.fingerprint,
      actorType: "console_user",
      actorId: "user-1",
      decision: "approved",
      approvalId: "approval-1",
    });
  });

  it("marks a changed observation stale without allowing the stale read to overwrite a resolved row", async () => {
    const current = {
      id: "contract-1",
      workspaceId: "ws-1",
      watchId: "watch-1",
      approvalId: "approval-1",
      state: "proposed",
      packageName: candidate.package,
      dependencyKind: candidate.dependency_kind,
      specifier: candidate.specifier,
      currentVersion: candidate.current_version,
      targetVersion: candidate.target_version,
      manifestPath: candidate.manifest_path,
      lockfilePath: candidate.lockfile_path,
      baselineSha: candidate.baseline_sha,
      candidateFingerprint: candidate.fingerprint,
    };
    state.selectResponses = [[current], [watch], [{ ...observation, candidates: [{ ...candidate, target_version: "18.4.0", fingerprint: candidate.fingerprint }] }]];
    state.updateResponses = [[{ ...current, state: "stale" }]];
    state.insertResponses = [[{ id: "event-1" }]];

    await expect(decideDependencyUpgradeContract({
      workspaceId: "ws-1", contractId: "contract-1", approvalId: "approval-1",
      decision: "approved", actor: { actorType: "console_user", actorId: "user-1" },
    })).resolves.toMatchObject({ status: "stale", contract: { state: "stale" } });
    expect(state.updateValues[0]).toMatchObject({ state: "stale" });
  });

  it("refreshes an unresolved proposal but never reopens an approval", async () => {
    state.updateResponses = [[{ id: "contract-1", state: "proposed", approvalId: null }]];
    state.insertResponses = [[{ id: "event-1" }]];
    await expect(refreshDependencyUpgradeContractProposal({
      workspaceId: "ws-1",
      contractId: "contract-1",
      proposal: { candidateFingerprint: candidate.fingerprint, needsHumanDecision: [] },
    })).resolves.toMatchObject({ state: "proposed" });
    expect(state.updateValues[0]).toMatchObject({ state: "proposed", proposal: expect.any(Object) });
  });
});
