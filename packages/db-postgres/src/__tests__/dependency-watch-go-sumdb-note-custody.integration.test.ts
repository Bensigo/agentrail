import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../db.js";
import { changeRecords } from "../schema/change_records.js";
import {
  dependencyWatchGoSumdbSignedTreeNotes,
  dependencyWatchObservations,
  dependencyWatches,
  GO_SUMDB_SIGNED_TREE_NOTE_FORMAT_PROFILE,
  type GoDependencySourceInventoryEntry,
  type GoDependencySourceInventoryReceipt,
} from "../schema/dependency_watches.js";
import { repositories } from "../schema/repositories.js";
import { workspaces } from "../schema/workspaces.js";
import { recordDependencyWatchObservation } from "../queries/dependency_watches.js";
import {
  deleteGoSumdbSignedTreeNoteCustodyForWatchTeardown,
  GoSumdbNoteCustodyAuthorizationError,
  GoSumdbNoteCustodyConflictError,
  readCurrentGoSumdbSignedTreeNote,
  retainGoSumdbSignedTreeNote,
} from "../queries/go_sumdb_note_custody.js";

describe("0099 Go checksum-database signed-tree-note custody migration", () => {
  it("registers opaque, byte-exact, source-bound CAS custody immediately after 0098", async () => {
    const [migration, journalText] = await Promise.all([
      readFile(new URL(
        "../../drizzle/migrations/0099_dependency_watch_go_sumdb_note_custody.sql",
        import.meta.url,
      ), "utf8"),
      readFile(new URL(
        "../../drizzle/migrations/meta/_journal.json",
        import.meta.url,
      ), "utf8"),
    ]);
    const compact = migration.replace(/\s+/gu, " ").trim();
    const journal = JSON.parse(journalText) as {
      entries: Array<{
        idx: number;
        version: string;
        tag: string;
        breakpoints: boolean;
      }>;
    };
    const journalIndex = journal.entries.findIndex(
      (entry) => entry.tag === "0099_dependency_watch_go_sumdb_note_custody",
    );

    expect(journal.entries[journalIndex]).toMatchObject({
      idx: 104,
      version: "7",
      breakpoints: true,
    });
    expect(journal.entries[journalIndex - 1]?.tag)
      .toBe("0098_dependency_watch_source_inventory_receipts");

    expect(compact).toContain(
      'CREATE TABLE IF NOT EXISTS "dependency_watch_go_sumdb_signed_tree_notes"',
    );
    expect(compact).toContain(
      '"format_profile" text NOT NULL',
    );
    expect(compact).toContain(
      "'go_sumdb_v1_retained_signed_tree_note_bytes'",
    );
    expect(compact).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "dependency_watch_observations_source_custody_unique_idx" ON "dependency_watch_observations" ("id", "workspace_id", "watch_id", "repository_id", "source_inventory_receipt_sha256")',
    );
    expect(compact).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "dependency_watches_custody_identity_idx" ON "dependency_watches" ("id", "workspace_id", "repository_id")',
    );
    expect(compact).toContain(
      'FOREIGN KEY ("watch_id", "workspace_id", "repository_id") REFERENCES "dependency_watches"("id", "workspace_id", "repository_id") ON DELETE RESTRICT',
    );
    expect(compact).toContain(
      'FOREIGN KEY ("source_observation_id", "workspace_id", "watch_id", "repository_id", "source_inventory_receipt_sha256") REFERENCES "dependency_watch_observations"("id", "workspace_id", "watch_id", "repository_id", "source_inventory_receipt_sha256") ON DELETE RESTRICT',
    );

    expect(compact).toContain(
      '"signed_tree_note_base64" ~ \'^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$\'',
    );
    expect(compact).toContain(
      'octet_length("signed_tree_note_base64") BETWEEN 4 AND 5464',
    );
    expect(compact).toContain(
      'octet_length(decode("signed_tree_note_base64", \'base64\')) BETWEEN 1 AND 4096',
    );
    expect(compact).toContain(
      'replace(encode(decode("signed_tree_note_base64", \'base64\'), \'base64\'), E\'\\n\', \'\') = "signed_tree_note_base64"',
    );
    expect(compact).toContain(
      'encode(sha256(decode("signed_tree_note_base64", \'base64\')), \'hex\') = "signed_tree_note_sha256"',
    );

    expect(compact).toContain(
      '("generation" = 0 AND "expected_prior_signed_tree_note_sha256" IS NULL AND "expected_prior_generation" IS NULL)',
    );
    expect(compact).toContain(
      '"expected_prior_generation" = "generation" - 1',
    );
    expect(compact).toContain(
      '"expected_prior_signed_tree_note_sha256" <> "signed_tree_note_sha256"',
    );
    expect(compact).toContain(
      'UNIQUE ("watch_id", "generation")',
    );
    expect(compact).toContain(
      'UNIQUE ("watch_id", "signed_tree_note_sha256")',
    );
    expect(compact).toContain(
      'UNIQUE ("workspace_id", "watch_id", "repository_id", "signed_tree_note_sha256", "generation")',
    );
    expect(compact).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "dependency_watch_go_sumdb_notes_watch_prior_idx" ON "dependency_watch_go_sumdb_signed_tree_notes" ("watch_id", "expected_prior_signed_tree_note_sha256") WHERE "expected_prior_signed_tree_note_sha256" IS NOT NULL',
    );
    expect(compact).toContain(
      'FOREIGN KEY ("workspace_id", "watch_id", "repository_id", "expected_prior_signed_tree_note_sha256", "expected_prior_generation") REFERENCES "dependency_watch_go_sumdb_signed_tree_notes"("workspace_id", "watch_id", "repository_id", "signed_tree_note_sha256", "generation")',
    );

    expect(migration).not.toMatch(/\b(tree_size|tree_root|tree_hash|root_hash|parsed_tree)\b/iu);
    expect(migration).not.toMatch(
      /\b(acceptance|approval|evidence|context_pack|draft|issue_queue|execution|merge_permission|pull_request|authority)\b/iu,
    );
  });

  it("exports only opaque custody queries without downstream authority or parsed tree fields", async () => {
    const [barrel, querySource, schemaSource] = await Promise.all([
      readFile(new URL("../queries/index.ts", import.meta.url), "utf8"),
      readFile(new URL(
        "../queries/go_sumdb_note_custody.ts",
        import.meta.url,
      ), "utf8"),
      readFile(new URL("../schema/dependency_watches.ts", import.meta.url), "utf8"),
    ]);

    expect(barrel).toContain('export * from "./go_sumdb_note_custody.js";');
    expect(querySource).toContain("pg_advisory_xact_lock");
    expect(querySource).not.toContain("pg_try_advisory_xact_lock");
    expect(querySource).toContain("GO_SUMDB_SIGNED_TREE_NOTE_FORMAT_PROFILE");
    expect(schemaSource).toContain(
      '"go_sumdb_v1_retained_signed_tree_note_bytes" as const',
    );
    expect(querySource).not.toMatch(
      /\b(acceptance(?:_records?)?|change_records?|draft|evidence|approval|pack|builder|delivery|issue|pull[_ -]?request|pr|merge|execution)\b/iu,
    );

    const tableStart = schemaSource.indexOf(
      "export const dependencyWatchGoSumdbSignedTreeNotes = pgTable(",
    );
    const tableEnd = schemaSource.indexOf(
      "export type DependencyWatchRow",
      tableStart,
    );
    expect(tableStart).toBeGreaterThanOrEqual(0);
    expect(tableEnd).toBeGreaterThan(tableStart);
    const tableSource = schemaSource.slice(tableStart, tableEnd);
    expect(tableSource).toContain("GO_SUMDB_SIGNED_TREE_NOTE_FORMAT_PROFILE");
    expect(tableSource).toContain("signedTreeNoteBase64");
    expect(tableSource).toContain("signedTreeNoteSha256");
    expect(tableSource).not.toMatch(
      /\b(treeSize|treeRoot|treeHash|rootHash|parsedTree|tree_size|tree_root|tree_hash|root_hash|parsed_tree)\b/u,
    );

    const tableConfig = getTableConfig(dependencyWatchGoSumdbSignedTreeNotes);
    expect(tableConfig.uniqueConstraints.map((constraint) => constraint.name).sort())
      .toEqual([
        "dependency_watch_go_sumdb_notes_lineage_identity_unique",
        "dependency_watch_go_sumdb_notes_watch_generation_unique",
        "dependency_watch_go_sumdb_notes_watch_note_unique",
      ]);
    expect(tableConfig.indexes.map((index) => index.config.name)).toEqual([
      "dependency_watch_go_sumdb_notes_watch_prior_idx",
    ]);
  });
});

const DB_REQUIRED = process.env["CI"] === "true"
  || typeof process.env["DATABASE_URL"] === "string";
const DB_AVAILABLE: boolean = await (async () => {
  try {
    const rows = Array.from(await db.execute(sql`
      SELECT to_regclass('public.dependency_watch_go_sumdb_signed_tree_notes') AS notes,
             to_regclass('public.dependency_watch_observations') AS observations
    `)) as Array<{ notes: string | null; observations: string | null }>;
    const available = rows[0]?.notes === "dependency_watch_go_sumdb_signed_tree_notes"
      && rows[0]?.observations === "dependency_watch_observations";
    if (DB_REQUIRED && !available) {
      throw new Error("required 0099 Go sumdb note custody schema is unavailable");
    }
    return available;
  } catch (error) {
    if (DB_REQUIRED) throw error;
    return false;
  }
})();

function canonicalJson(value: unknown): string {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || typeof value === "number"
  ) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function bytesSha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function goSourceReceipt(): {
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
      repository: "ada/widgets",
      requestedRef: "main",
      commitSha: "a".repeat(40),
      rootTreeSha: "b".repeat(40),
    },
    inventory: {
      recursive: true,
      truncated: false,
      entryCount: entries.length,
      entries,
      entriesSha256: canonicalSha256(entries),
    },
    requiredFiles: [
      {
        path: "go.mod",
        mode: "100644",
        blobSha: "c".repeat(40),
        byteCount: 32,
        contentSha256: "e".repeat(64),
      },
      {
        path: "go.sum",
        mode: "100644",
        blobSha: "d".repeat(40),
        byteCount: 64,
        contentSha256: "f".repeat(64),
      },
    ],
    policy: { name: "go_root_source_inventory_v1", result: "admitted" },
  };
  const identitySha256 = canonicalSha256(withoutIdentity);
  return { receipt: { ...withoutIdentity, identitySha256 }, identitySha256 };
}

describe.skipIf(!DB_AVAILABLE)(
  "Go checksum-database signed-tree-note custody — real Postgres",
  () => {
    let workspaceId: string;
    let repositoryId: string;
    let watchId: string;

    beforeEach(async () => {
      workspaceId = (await db.insert(workspaces).values({
        name: "Go sumdb note custody test",
        slug: `go-sumdb-note-${randomUUID()}`,
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
      try {
        await expect(db.select().from(changeRecords).where(
          eq(changeRecords.workspaceId, workspaceId),
        )).resolves.toHaveLength(0);
      } finally {
        await deleteGoSumdbSignedTreeNoteCustodyForWatchTeardown({
          workspaceId,
          watchId,
          repositoryId,
        });
        await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
      }
    });

    async function createObservation(options: { withReceipt?: boolean } = {}): Promise<{
      id: string;
      sourceInventoryReceiptSha256: string | null;
    }> {
      const withReceipt = options.withReceipt ?? true;
      const source = goSourceReceipt();
      const result = await recordDependencyWatchObservation({
        workspaceId,
        watchId,
        repositoryId,
        trigger: "manual",
        baselineSha: "a".repeat(40),
        selectedFileHashes: {
          "go.mod": "e".repeat(64),
          "go.sum": "f".repeat(64),
        },
        observationKey: withReceipt
          ? `failed:${randomUUID()}:source:${source.identitySha256}`
          : `failed:${randomUUID()}`,
        sourceInventoryReceipt: withReceipt ? source.receipt : undefined,
        sourceInventoryReceiptSha256: withReceipt
          ? source.identitySha256
          : undefined,
        status: "failed",
        candidates: [],
      });
      if (!result.observation) throw new Error("source observation fixture was not inserted");
      return {
        id: result.observation.id,
        sourceInventoryReceiptSha256:
          result.observation.sourceInventoryReceiptSha256,
      };
    }

    function noteInput(
      sourceObservationId: string,
      rawNote: Uint8Array,
      expectedPriorSignedTreeNoteSha256: string | null,
    ) {
      return {
        workspaceId,
        watchId,
        repositoryId,
        sourceObservationId,
        expectedPriorSignedTreeNoteSha256,
        signedTreeNoteBase64: Buffer.from(rawNote).toString("base64"),
        signedTreeNoteSha256: bytesSha256(rawNote),
      };
    }

    it("bootstraps, exactly replays, appends a successor, and reads current opaque custody", async () => {
      const bootstrapSource = await createObservation();
      const bootstrapInput = noteInput(
        bootstrapSource.id,
        Buffer.from("bootstrap opaque signed tree note", "utf8"),
        null,
      );
      const bootstrap = await retainGoSumdbSignedTreeNote(bootstrapInput);
      expect(bootstrap).toMatchObject({
        recorded: true,
        note: {
          generation: 0,
          sourceObservationId: bootstrapSource.id,
          sourceInventoryReceiptSha256:
            bootstrapSource.sourceInventoryReceiptSha256,
          signedTreeNoteBase64: bootstrapInput.signedTreeNoteBase64,
          signedTreeNoteSha256: bootstrapInput.signedTreeNoteSha256,
          expectedPriorSignedTreeNoteSha256: null,
          expectedPriorGeneration: null,
          formatProfile: GO_SUMDB_SIGNED_TREE_NOTE_FORMAT_PROFILE,
        },
      });

      await expect(retainGoSumdbSignedTreeNote(bootstrapInput)).resolves.toEqual({
        recorded: false,
        note: bootstrap.note,
      });

      const successorSource = await createObservation();
      const successorInput = noteInput(
        successorSource.id,
        Buffer.from("different successor opaque signed tree note", "utf8"),
        bootstrap.note.signedTreeNoteSha256,
      );
      const successor = await retainGoSumdbSignedTreeNote(successorInput);
      expect(successor).toMatchObject({
        recorded: true,
        note: {
          generation: 1,
          sourceObservationId: successorSource.id,
          sourceInventoryReceiptSha256:
            successorSource.sourceInventoryReceiptSha256,
          signedTreeNoteBase64: successorInput.signedTreeNoteBase64,
          signedTreeNoteSha256: successorInput.signedTreeNoteSha256,
          expectedPriorSignedTreeNoteSha256:
            bootstrap.note.signedTreeNoteSha256,
          expectedPriorGeneration: 0,
          formatProfile: GO_SUMDB_SIGNED_TREE_NOTE_FORMAT_PROFILE,
        },
      });
      await expect(readCurrentGoSumdbSignedTreeNote({
        workspaceId,
        watchId,
        repositoryId,
      })).resolves.toEqual(successor.note);
      expect(successor.note).not.toHaveProperty("treeSize");
      expect(successor.note).not.toHaveProperty("treeRoot");
    });

    it("rejects stale and self-successor lineage without changing current custody", async () => {
      const source = await createObservation();
      const bootstrapInput = noteInput(
        source.id,
        Buffer.from("lineage bootstrap note", "utf8"),
        null,
      );
      const bootstrap = await retainGoSumdbSignedTreeNote(bootstrapInput);
      const nextSource = await createObservation();
      await expect(retainGoSumdbSignedTreeNote(noteInput(
        nextSource.id,
        Buffer.from("stale successor note", "utf8"),
        "0".repeat(64),
      ))).rejects.toBeInstanceOf(GoSumdbNoteCustodyConflictError);
      await expect(retainGoSumdbSignedTreeNote({
        ...bootstrapInput,
        expectedPriorSignedTreeNoteSha256: bootstrap.note.signedTreeNoteSha256,
      })).rejects.toBeInstanceOf(GoSumdbNoteCustodyConflictError);
      await expect(db.select().from(dependencyWatchGoSumdbSignedTreeNotes).where(
        eq(dependencyWatchGoSumdbSignedTreeNotes.watchId, watchId),
      )).resolves.toHaveLength(1);
    });

    it("serializes concurrent identical bootstrap into one insert and one exact replay", async () => {
      const source = await createObservation();
      const input = noteInput(
        source.id,
        Buffer.from("concurrent identical bootstrap note", "utf8"),
        null,
      );
      const results = await Promise.all([
        retainGoSumdbSignedTreeNote(input),
        retainGoSumdbSignedTreeNote(input),
      ]);
      expect(results.map((result) => result.recorded).sort()).toEqual([false, true]);
      expect(new Set(results.map((result) => result.note.id)).size).toBe(1);
      await expect(db.select().from(dependencyWatchGoSumdbSignedTreeNotes).where(
        eq(dependencyWatchGoSumdbSignedTreeNotes.watchId, watchId),
      )).resolves.toHaveLength(1);
    });

    it("allows only one of two concurrent different successors from the same prior", async () => {
      const bootstrapSource = await createObservation();
      const bootstrap = await retainGoSumdbSignedTreeNote(noteInput(
        bootstrapSource.id,
        Buffer.from("concurrent successor bootstrap", "utf8"),
        null,
      ));
      const [sourceA, sourceB] = await Promise.all([
        createObservation(),
        createObservation(),
      ]);
      const settled = await Promise.allSettled([
        retainGoSumdbSignedTreeNote(noteInput(
          sourceA.id,
          Buffer.from("concurrent successor A", "utf8"),
          bootstrap.note.signedTreeNoteSha256,
        )),
        retainGoSumdbSignedTreeNote(noteInput(
          sourceB.id,
          Buffer.from("concurrent successor B", "utf8"),
          bootstrap.note.signedTreeNoteSha256,
        )),
      ]);
      const fulfilled = settled.filter(
        (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof retainGoSumdbSignedTreeNote>>> =>
          result.status === "fulfilled",
      );
      const rejected = settled.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      expect(fulfilled).toHaveLength(1);
      expect(fulfilled[0]!.value).toMatchObject({ recorded: true, note: { generation: 1 } });
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toBeInstanceOf(GoSumdbNoteCustodyConflictError);
      await expect(db.select().from(dependencyWatchGoSumdbSignedTreeNotes).where(
        eq(dependencyWatchGoSumdbSignedTreeNotes.watchId, watchId),
      )).resolves.toHaveLength(2);
    });

    it("rejects wrong source coordinates and observations without a source receipt", async () => {
      const source = await createObservation();
      const withoutReceipt = await createObservation({ withReceipt: false });
      const base = noteInput(
        source.id,
        Buffer.from("source authorization note", "utf8"),
        null,
      );
      const cases = [
        { ...base, workspaceId: randomUUID() },
        { ...base, watchId: randomUUID() },
        { ...base, repositoryId: randomUUID() },
        { ...base, sourceObservationId: randomUUID() },
        { ...base, sourceObservationId: withoutReceipt.id },
      ];
      for (const candidate of cases) {
        await expect(retainGoSumdbSignedTreeNote(candidate))
          .rejects.toBeInstanceOf(GoSumdbNoteCustodyAuthorizationError);
      }
      await expect(db.select().from(dependencyWatchGoSumdbSignedTreeNotes).where(
        eq(dependencyWatchGoSumdbSignedTreeNotes.watchId, watchId),
      )).resolves.toHaveLength(0);
    });

    it("restricts source deletion until the explicit whole-watch teardown removes the timeline", async () => {
      const bootstrapSource = await createObservation();
      const bootstrap = await retainGoSumdbSignedTreeNote(noteInput(
        bootstrapSource.id,
        Buffer.from("source deletion bootstrap note", "utf8"),
        null,
      ));
      const successorSource = await createObservation();
      const successor = await retainGoSumdbSignedTreeNote(noteInput(
        successorSource.id,
        Buffer.from("source deletion successor note", "utf8"),
        bootstrap.note.signedTreeNoteSha256,
      ));

      await expect(db.delete(dependencyWatchObservations).where(
        eq(dependencyWatchObservations.id, successorSource.id),
      )).rejects.toThrow();
      await expect(readCurrentGoSumdbSignedTreeNote({
        workspaceId,
        watchId,
        repositoryId,
      })).resolves.toEqual(successor.note);

      await expect(deleteGoSumdbSignedTreeNoteCustodyForWatchTeardown({
        workspaceId,
        watchId,
        repositoryId,
      })).resolves.toEqual({ deletedCount: 2 });
      await expect(db.delete(dependencyWatchObservations).where(
        eq(dependencyWatchObservations.id, successorSource.id),
      )).resolves.toBeDefined();
      await expect(readCurrentGoSumdbSignedTreeNote({
        workspaceId,
        watchId,
        repositoryId,
      })).resolves.toBeNull();
    });

    it("rejects a direct-SQL generation jump even when the named predecessor exists", async () => {
      const source = await createObservation();
      const rawNote = Buffer.from("direct SQL generation-zero note", "utf8");
      const bootstrap = await db.insert(dependencyWatchGoSumdbSignedTreeNotes).values({
        workspaceId,
        watchId,
        repositoryId,
        sourceObservationId: source.id,
        sourceInventoryReceiptSha256: source.sourceInventoryReceiptSha256!,
        formatProfile: GO_SUMDB_SIGNED_TREE_NOTE_FORMAT_PROFILE,
        signedTreeNoteBase64: rawNote.toString("base64"),
        signedTreeNoteSha256: bytesSha256(rawNote),
        expectedPriorSignedTreeNoteSha256: null,
        expectedPriorGeneration: null,
        generation: 0,
      }).returning();
      const jumped = Buffer.from("direct SQL generation-seven note", "utf8");
      await expect(db.insert(dependencyWatchGoSumdbSignedTreeNotes).values({
        workspaceId,
        watchId,
        repositoryId,
        sourceObservationId: source.id,
        sourceInventoryReceiptSha256: source.sourceInventoryReceiptSha256!,
        formatProfile: GO_SUMDB_SIGNED_TREE_NOTE_FORMAT_PROFILE,
        signedTreeNoteBase64: jumped.toString("base64"),
        signedTreeNoteSha256: bytesSha256(jumped),
        expectedPriorSignedTreeNoteSha256: bootstrap[0]!.signedTreeNoteSha256,
        expectedPriorGeneration: 0,
        generation: 7,
      })).rejects.toThrow();
      await expect(db.select().from(dependencyWatchGoSumdbSignedTreeNotes).where(
        eq(dependencyWatchGoSumdbSignedTreeNotes.watchId, watchId),
      )).resolves.toHaveLength(1);
    });

    it("enforces byte, lineage, self-link, and composite source custody in direct SQL", async () => {
      const source = await createObservation();
      const sourceReceiptSha256 = source.sourceInventoryReceiptSha256!;
      const rawNote = Buffer.from("direct SQL constrained note", "utf8");
      const base = {
        workspaceId,
        watchId,
        repositoryId,
        sourceObservationId: source.id,
        sourceInventoryReceiptSha256: sourceReceiptSha256,
        formatProfile: GO_SUMDB_SIGNED_TREE_NOTE_FORMAT_PROFILE,
        signedTreeNoteBase64: rawNote.toString("base64"),
        signedTreeNoteSha256: bytesSha256(rawNote),
        expectedPriorSignedTreeNoteSha256: null as string | null,
        expectedPriorGeneration: null as number | null,
        generation: 0,
      };
      const oversized = Buffer.alloc((4 * 1024) + 1, 0x61);
      const invalidRows = [
        {
          ...base,
          signedTreeNoteBase64: "YQ",
          signedTreeNoteSha256: bytesSha256(Buffer.from("a", "utf8")),
        },
        {
          ...base,
          signedTreeNoteBase64: oversized.toString("base64"),
          signedTreeNoteSha256: bytesSha256(oversized),
        },
        { ...base, signedTreeNoteSha256: "0".repeat(64) },
        { ...base, generation: 1 },
        {
          ...base,
          generation: 7,
          expectedPriorSignedTreeNoteSha256: "7".repeat(64),
          expectedPriorGeneration: 0,
        },
        {
          ...base,
          expectedPriorSignedTreeNoteSha256: "a".repeat(64),
        },
        {
          ...base,
          generation: 1,
          expectedPriorSignedTreeNoteSha256: base.signedTreeNoteSha256,
          expectedPriorGeneration: 0,
        },
        {
          ...base,
          sourceInventoryReceiptSha256: "9".repeat(64),
        },
      ];
      for (const invalidRow of invalidRows) {
        await expect(db.insert(dependencyWatchGoSumdbSignedTreeNotes).values(invalidRow))
          .rejects.toThrow();
      }
      await expect(db.select().from(dependencyWatchGoSumdbSignedTreeNotes).where(
        eq(dependencyWatchGoSumdbSignedTreeNotes.watchId, watchId),
      )).resolves.toHaveLength(0);
      await expect(db.select().from(dependencyWatchObservations).where(
        eq(dependencyWatchObservations.id, source.id),
      )).resolves.toHaveLength(1);
    });
  },
);
