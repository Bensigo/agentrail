import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { db } from "../db.js";
import { workspaces } from "../schema/workspaces.js";
import { repositories } from "../schema/repositories.js";
import {
  dependencyWatchObservations,
  dependencyWatches,
  type GoDependencySourceInventoryEntry,
  type GoDependencySourceInventoryReceipt,
} from "../schema/dependency_watches.js";
import { changeRecords } from "../schema/change_records.js";
import {
  DependencyWatchValidationError,
  recordDependencyWatchObservation,
} from "../queries/dependency_watches.js";
import {
  createDraftAcceptanceRecordFromDependencyObservation,
  type DependencyObservationDraftError,
} from "../queries/dependency_observation_acceptance_records.js";

const DB_AVAILABLE: boolean = await (async () => {
  try {
    const rows = Array.from(await db.execute(sql`
      SELECT to_regclass('public.dependency_watches') AS watches,
             to_regclass('public.dependency_watch_observations') AS observations,
             COUNT(*) FILTER (
               WHERE column_name IN ('source_inventory_receipt', 'source_inventory_receipt_sha256')
             )::int AS receipt_columns
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'dependency_watch_observations'
      GROUP BY 1, 2
    `)) as Array<Record<string, string | number | null>>;
    return rows[0]?.watches === "dependency_watches"
      && rows[0]?.observations === "dependency_watch_observations"
      && rows[0]?.receipt_columns === 2;
  } catch {
    return false;
  }
})();

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean"
    || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function goSourceReceipt(repository = "ada/widgets"): {
  receipt: GoDependencySourceInventoryReceipt;
  identitySha256: string;
} {
  const entries: GoDependencySourceInventoryEntry[] = [
    { path: "go.mod", mode: "100644", type: "blob", objectSha: "c".repeat(40) },
    { path: "go.sum", mode: "100644", type: "blob", objectSha: "d".repeat(40) },
  ];
  const withoutIdentity: Omit<GoDependencySourceInventoryReceipt, "identitySha256"> = {
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

const GO_CANDIDATE = {
  package: "github.com/acme/lib",
  ecosystem: "go",
  package_manager: "go-modules",
  dependency_kind: "require",
  specifier: "v1.2.0",
  current_version: "v1.2.0",
  target_version: "v1.3.0",
  manifest_path: "go.mod",
  lockfile_path: "go.sum",
  baseline_sha: "a".repeat(40),
  fingerprint: `sha256:${"9".repeat(64)}`,
  package_manager_version: null,
  verification_commands: ["go test ./..."],
  manager_commands: {
    version: "go version",
    install: "go mod download",
    update: "go get github.com/acme/lib@v1.3.0",
  },
};

describe.skipIf(!DB_AVAILABLE)("Go exact-tree source-inventory custody — real Postgres", () => {
  let workspaceId: string;
  let repositoryId: string;
  let watchId: string;

  beforeEach(async () => {
    workspaceId = (await db.insert(workspaces).values({
      name: "Go source receipt test",
      slug: `go-source-receipt-${randomUUID()}`,
    }).returning({ id: workspaces.id }))[0]!.id;
    repositoryId = (await db.insert(repositories).values({
      workspaceId,
      name: "ada/widgets",
      url: "https://github.com/ada/widgets",
    }).returning({ id: repositories.id }))[0]!.id;
    watchId = (await db.insert(dependencyWatches).values({
      workspaceId,
      repositoryId,
      manifestPath: "go.mod",
      lockfilePath: "go.sum",
    }).returning({ id: dependencyWatches.id }))[0]!.id;
  });

  afterEach(async () => {
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  });

  function inputFor(source = goSourceReceipt()) {
    return {
      workspaceId,
      watchId,
      repositoryId,
      trigger: "manual" as const,
      baselineSha: "a".repeat(40),
      selectedFileHashes: { "go.mod": "e".repeat(64), "go.sum": "f".repeat(64) },
      observationKey: `candidates:${"8".repeat(64)}:source:${source.identitySha256}`,
      candidateFingerprint: GO_CANDIDATE.fingerprint,
      status: "candidates" as const,
      candidates: [GO_CANDIDATE],
      sourceInventoryReceipt: source.receipt,
      sourceInventoryReceiptSha256: source.identitySha256,
    };
  }

  it("stores one append-only receipt and makes an exact retry idempotent", async () => {
    const input = inputFor();

    await expect(recordDependencyWatchObservation(input)).resolves.toMatchObject({ recorded: true });
    await expect(recordDependencyWatchObservation(input)).resolves.toMatchObject({ recorded: false });

    const rows = await db.select().from(dependencyWatchObservations).where(
      eq(dependencyWatchObservations.watchId, watchId),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceInventoryReceipt: input.sourceInventoryReceipt,
      sourceInventoryReceiptSha256: input.sourceInventoryReceiptSha256,
    });
  });

  it("rejects altered valid receipt identity at both the query and SQL constraints", async () => {
    const original = inputFor();
    const altered = goSourceReceipt("ada/other-widgets");
    const alteredWithOldKey = {
      ...inputFor(altered),
      observationKey: original.observationKey,
    };

    await expect(recordDependencyWatchObservation(alteredWithOldKey)).rejects.toBeInstanceOf(
      DependencyWatchValidationError,
    );
    await expect(db.insert(dependencyWatchObservations).values({
      workspaceId,
      watchId,
      repositoryId,
      trigger: "manual",
      baselineSha: "a".repeat(40),
      selectedFileHashes: { "go.mod": "e".repeat(64), "go.sum": "f".repeat(64) },
      observationKey: original.observationKey,
      sourceInventoryReceipt: altered.receipt,
      sourceInventoryReceiptSha256: altered.identitySha256,
      status: "failed",
      candidates: [],
      observedAt: new Date(),
    })).rejects.toThrow();
    await expect(db.select().from(dependencyWatchObservations).where(
      eq(dependencyWatchObservations.watchId, watchId),
    )).resolves.toHaveLength(0);
  });

  it.each([
    ["baseline", { baselineSha: "b".repeat(40) }],
    ["selected hashes", {
      selectedFileHashes: { "go.mod": "0".repeat(64), "go.sum": "f".repeat(64) },
    }],
  ])("rejects direct SQL receipt %s mismatch", async (_name, changed) => {
    const source = goSourceReceipt();
    await expect(db.insert(dependencyWatchObservations).values({
      workspaceId,
      watchId,
      repositoryId,
      trigger: "manual",
      baselineSha: "a".repeat(40),
      selectedFileHashes: { "go.mod": "e".repeat(64), "go.sum": "f".repeat(64) },
      observationKey: `failed:${randomUUID()}:source:${source.identitySha256}`,
      sourceInventoryReceipt: source.receipt,
      sourceInventoryReceiptSha256: source.identitySha256,
      status: "failed",
      candidates: [],
      observedAt: new Date(),
      ...changed,
    })).rejects.toThrow();
  });

  it("keeps a receipt-bearing Go candidate outside draft and downstream authority", async () => {
    const input = inputFor();
    await recordDependencyWatchObservation(input);

    await expect(createDraftAcceptanceRecordFromDependencyObservation({
      workspaceId,
      watchId,
      candidateFingerprint: GO_CANDIDATE.fingerprint,
    })).rejects.toMatchObject({
      code: "unsupported_manager",
    } satisfies Partial<DependencyObservationDraftError>);
    await expect(db.select().from(changeRecords).where(eq(changeRecords.workspaceId, workspaceId)))
      .resolves.toHaveLength(0);
  });
});

describe("Go source-inventory query authority", () => {
  it("appends migration 0098 immediately after gated-issue approval custody", () => {
    const journal = JSON.parse(readFileSync(
      new URL("../../drizzle/migrations/meta/_journal.json", import.meta.url),
      "utf8",
    )) as { entries: Array<{ idx: number; version: string; tag: string; breakpoints: boolean }> };
    const migrationIndex = journal.entries.findIndex(
      (entry) => entry.tag === "0098_dependency_watch_source_inventory_receipts",
    );
    expect(journal.entries[migrationIndex]).toMatchObject({
      idx: 103,
      version: "7",
      breakpoints: true,
    });
    expect(journal.entries[migrationIndex - 1]?.tag)
      .toBe("0097_acceptance_gated_issue_approval_custody");
  });

  it("has no draft, approval, Pack, queue, PR, or execution imports", () => {
    const source = readFileSync(new URL("../queries/dependency_watches.ts", import.meta.url), "utf8");
    for (const forbidden of [
      "createDraftAcceptanceRecordFromDependencyObservation",
      "recordApprovalRequest",
      "createAcceptanceContextPack",
      "enqueueGithubIssue",
      "createPullRequest",
      "mergePullRequest",
      "executeDependencyUpgrade",
    ]) expect(source).not.toContain(forbidden);
  });
});
