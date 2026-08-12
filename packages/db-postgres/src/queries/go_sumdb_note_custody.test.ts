import { createHash } from "node:crypto";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state = {
    calls: [] as Array<{
      kind: "execute" | "select" | "insert" | "delete";
      value: unknown;
    }>,
    selectResultSets: [] as unknown[][],
    selectWhereExpressions: [] as unknown[],
    selectOrderByExpressions: [] as unknown[],
    insertReturningRows: [] as unknown[],
    insertReturningErrors: [] as unknown[],
    insertedValues: [] as unknown[],
    deleteReturningRows: [] as unknown[],
  };
  const tx = {
    execute: vi.fn(async (query: unknown) => {
      state.calls.push({ kind: "execute", value: query });
      return [];
    }),
    select: vi.fn((selection: unknown) => {
      state.calls.push({ kind: "select", value: selection });
      return {
        from: () => ({
          where: (whereExpression: unknown) => {
            state.selectWhereExpressions.push(whereExpression);
            const limit = async () => state.selectResultSets.shift() ?? [];
            return {
              limit,
              orderBy: (...orderByExpressions: unknown[]) => {
                state.selectOrderByExpressions.push(...orderByExpressions);
                return { limit };
              },
            };
          },
        }),
      };
    }),
    insert: vi.fn((table: unknown) => {
      state.calls.push({ kind: "insert", value: table });
      return {
        values: (values: unknown) => {
          state.insertedValues.push(values);
          const returning = async () => {
            if (state.insertReturningErrors.length > 0) {
              const error = state.insertReturningErrors.shift();
              throw error;
            }
            return state.insertReturningRows;
          };
          return {
            returning,
            onConflictDoNothing: () => ({ returning }),
          };
        },
      };
    }),
    delete: vi.fn((table: unknown) => {
      state.calls.push({ kind: "delete", value: table });
      return {
        where: () => ({
          returning: async () => state.deleteReturningRows,
        }),
      };
    }),
  };
  return {
    ...state,
    tx,
    transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) =>
      callback(tx)),
  };
});

vi.mock("../db.js", () => ({
  db: {
    transaction: mocks.transaction,
    select: mocks.tx.select,
  },
}));

import {
  deleteGoSumdbSignedTreeNoteCustodyForWatchTeardown,
  GoSumdbNoteCustodyConflictError,
  GoSumdbNoteCustodyValidationError,
  readCurrentGoSumdbSignedTreeNote,
  retainGoSumdbSignedTreeNote,
} from "./go_sumdb_note_custody.js";

const MAX_SIGNED_TREE_NOTE_BYTES = 4 * 1024;
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const WATCH_ID = "22222222-2222-4222-8222-222222222222";
const REPOSITORY_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_OBSERVATION_ID = "44444444-4444-4444-8444-444444444444";
const dialect = new PgDialect();

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function authorizedSourceObservation(): Record<string, unknown> {
  return {
    id: SOURCE_OBSERVATION_ID,
    workspaceId: WORKSPACE_ID,
    watchId: WATCH_ID,
    repositoryId: REPOSITORY_ID,
    sourceInventoryReceiptSha256: "b".repeat(64),
  };
}

function useBootstrapFixture(input: {
  workspaceId: string;
  watchId: string;
  repositoryId: string;
  sourceObservationId: string;
  expectedPriorSignedTreeNoteSha256: null;
  signedTreeNoteBase64: string;
  signedTreeNoteSha256: string;
}): void {
  mocks.selectResultSets.splice(
    0,
    mocks.selectResultSets.length,
    [authorizedSourceObservation()],
    [],
  );
  mocks.insertReturningRows.splice(
    0,
    mocks.insertReturningRows.length,
    {
      id: "55555555-5555-4555-8555-555555555555",
      ...input,
      sourceInventoryReceiptSha256: "b".repeat(64),
      formatProfile: "go_sumdb_v1_retained_signed_tree_note_bytes",
      expectedPriorGeneration: null,
      generation: 0,
      createdAt: new Date("2026-08-12T00:00:00.000Z"),
    },
  );
}

function sqlLiteralText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const raw = (value as { value?: unknown }).value;
  if (Array.isArray(raw)) return raw.filter((part) => typeof part === "string").join("");
  const chunks = (value as { queryChunks?: unknown[] }).queryChunks;
  return Array.isArray(chunks) ? chunks.map(sqlLiteralText).join("") : "";
}

function sqlBoundStrings(value: unknown): string[] {
  const chunks = (value as { queryChunks?: unknown[] })?.queryChunks ?? [];
  return chunks.filter((chunk): chunk is string => typeof chunk === "string");
}

function renderedSql(value: unknown): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(
    value as Parameters<typeof dialect.sqlToQuery>[0],
  );
}

describe("retainGoSumdbSignedTreeNote", () => {
  it("admits bounded canonical raw bytes with their recomputed SHA-256 and rejects malformed custody before a transaction", async () => {
    const rawNote = Buffer.from(
      "go.sum database tree\n1\n3q2+7w==\n\n— sum.golang.org signed-note\n",
      "utf8",
    );
    const validInput = {
      workspaceId: WORKSPACE_ID,
      watchId: WATCH_ID,
      repositoryId: REPOSITORY_ID,
      sourceObservationId: SOURCE_OBSERVATION_ID,
      expectedPriorSignedTreeNoteSha256: null,
      signedTreeNoteBase64: rawNote.toString("base64"),
      signedTreeNoteSha256: sha256(rawNote),
    };

    useBootstrapFixture(validInput);
    await retainGoSumdbSignedTreeNote(validInput);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);

    const oneByte = Buffer.from("a", "utf8");
    const oversized = Buffer.alloc(MAX_SIGNED_TREE_NOTE_BYTES + 1, 0x61);
    const invalidCases: Array<{ name: string; input: unknown }> = [
      {
        name: "base64 is the wrong type",
        input: { ...validInput, signedTreeNoteBase64: 123 },
      },
      {
        name: "SHA-256 is the wrong type",
        input: { ...validInput, signedTreeNoteSha256: null },
      },
      {
        name: "raw bytes are empty",
        input: {
          ...validInput,
          signedTreeNoteBase64: "",
          signedTreeNoteSha256: sha256(Buffer.alloc(0)),
        },
      },
      {
        name: "base64 is not canonical",
        input: {
          ...validInput,
          signedTreeNoteBase64: "YQ",
          signedTreeNoteSha256: sha256(oneByte),
        },
      },
      {
        name: "decoded raw bytes exceed the bound",
        input: {
          ...validInput,
          signedTreeNoteBase64: oversized.toString("base64"),
          signedTreeNoteSha256: sha256(oversized),
        },
      },
      {
        name: "declared SHA-256 does not match the raw bytes",
        input: { ...validInput, signedTreeNoteSha256: "0".repeat(64) },
      },
    ];

    for (const testCase of invalidCases) {
      mocks.transaction.mockClear();

      await expect(
        Promise.resolve().then(() =>
          retainGoSumdbSignedTreeNote(testCase.input as never),
        ),
        testCase.name,
      ).rejects.toBeInstanceOf(GoSumdbNoteCustodyValidationError);
      expect(mocks.transaction, testCase.name).not.toHaveBeenCalled();
    }
  });

  it("requires exact custody identity and a nullable lowercase prior-note SHA-256 before opening a transaction", async () => {
    const rawNote = Buffer.from("opaque signed Go checksum database note", "utf8");
    const validInput = {
      workspaceId: WORKSPACE_ID,
      watchId: WATCH_ID,
      repositoryId: REPOSITORY_ID,
      sourceObservationId: SOURCE_OBSERVATION_ID,
      expectedPriorSignedTreeNoteSha256: null,
      signedTreeNoteBase64: rawNote.toString("base64"),
      signedTreeNoteSha256: sha256(rawNote),
    };

    useBootstrapFixture(validInput);
    mocks.transaction.mockClear();
    await retainGoSumdbSignedTreeNote(validInput as never);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);

    const without = (field: keyof typeof validInput): Record<string, unknown> =>
      Object.fromEntries(Object.entries(validInput).filter(([key]) => key !== field));
    const invalidCases: Array<{ name: string; input: unknown }> = [
      ...([
        "workspaceId",
        "watchId",
        "repositoryId",
        "sourceObservationId",
      ] as const).flatMap((field) => [
        { name: `${field} has the wrong type`, input: { ...validInput, [field]: 7 } },
        { name: `${field} is missing`, input: without(field) },
        { name: `${field} is not a UUID`, input: { ...validInput, [field]: "not-a-uuid" } },
      ]),
      {
        name: "expectedPriorSignedTreeNoteSha256 has the wrong type",
        input: { ...validInput, expectedPriorSignedTreeNoteSha256: 7 },
      },
      {
        name: "expectedPriorSignedTreeNoteSha256 is missing",
        input: without("expectedPriorSignedTreeNoteSha256"),
      },
      {
        name: "expectedPriorSignedTreeNoteSha256 is uppercase",
        input: { ...validInput, expectedPriorSignedTreeNoteSha256: "A".repeat(64) },
      },
      {
        name: "expectedPriorSignedTreeNoteSha256 has the wrong length",
        input: { ...validInput, expectedPriorSignedTreeNoteSha256: "a".repeat(63) },
      },
      {
        name: "unknown parsed checkpoint field is forbidden",
        input: { ...validInput, treeSize: 1 },
      },
    ];

    for (const testCase of invalidCases) {
      mocks.transaction.mockClear();

      await expect(
        Promise.resolve().then(() =>
          retainGoSumdbSignedTreeNote(testCase.input as never),
        ),
        testCase.name,
      ).rejects.toThrow();
      expect(mocks.transaction, testCase.name).not.toHaveBeenCalled();
    }
  });

  it("locks workspace-watch custody before rejecting a missing source observation without inserting", async () => {
    const rawNote = Buffer.from("source-bound signed tree note", "utf8");
    const input = {
      workspaceId: WORKSPACE_ID,
      watchId: WATCH_ID,
      repositoryId: REPOSITORY_ID,
      sourceObservationId: SOURCE_OBSERVATION_ID,
      expectedPriorSignedTreeNoteSha256: null,
      signedTreeNoteBase64: rawNote.toString("base64"),
      signedTreeNoteSha256: sha256(rawNote),
    };
    mocks.calls.length = 0;
    mocks.selectResultSets.length = 0;
    mocks.transaction.mockClear();
    mocks.tx.execute.mockClear();
    mocks.tx.select.mockClear();
    mocks.tx.insert.mockClear();

    let rejection: unknown;
    try {
      await retainGoSumdbSignedTreeNote(input);
    } catch (error) {
      rejection = error;
    }

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.calls[0]?.kind).toBe("execute");
    const lockQuery = mocks.calls[0]?.value;
    expect(sqlLiteralText(lockQuery)).toContain("pg_advisory_xact_lock");
    expect(sqlLiteralText(lockQuery)).not.toContain("pg_try_advisory_xact_lock");
    expect(sqlBoundStrings(lockQuery)).toContain(
      `go-sumdb-note-custody:${WORKSPACE_ID}:${WATCH_ID}`,
    );
    expect(mocks.calls[1]?.kind).toBe("select");
    expect(rejection).toMatchObject({ name: "GoSumdbNoteCustodyAuthorizationError" });
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toMatch(/source.*(custody|authoriz)/i);
    expect(mocks.tx.insert).not.toHaveBeenCalled();
  });

  it("bootstraps an empty note ledger with generation zero under compare-and-set custody", async () => {
    const rawNote = Buffer.from("bootstrap signed Go checksum database note", "utf8");
    const input = {
      workspaceId: WORKSPACE_ID,
      watchId: WATCH_ID,
      repositoryId: REPOSITORY_ID,
      sourceObservationId: SOURCE_OBSERVATION_ID,
      expectedPriorSignedTreeNoteSha256: null,
      signedTreeNoteBase64: rawNote.toString("base64"),
      signedTreeNoteSha256: sha256(rawNote),
    };
    const insertedNote = {
      id: "55555555-5555-4555-8555-555555555555",
      ...input,
      formatProfile: "go_sumdb_v1_retained_signed_tree_note_bytes",
      expectedPriorGeneration: null,
      generation: 0,
      createdAt: new Date("2026-08-12T00:00:00.000Z"),
    };
    mocks.calls.length = 0;
    mocks.selectResultSets.splice(
      0,
      mocks.selectResultSets.length,
      [authorizedSourceObservation()],
      [],
    );
    mocks.insertReturningRows.splice(
      0,
      mocks.insertReturningRows.length,
      insertedNote,
    );
    mocks.insertedValues.length = 0;
    mocks.transaction.mockClear();
    mocks.tx.insert.mockClear();

    const result = await retainGoSumdbSignedTreeNote(input);

    expect(result).toEqual({ recorded: true, note: insertedNote });
    expect(mocks.calls.map((call) => call.kind)).toEqual([
      "execute",
      "select",
      "select",
      "insert",
    ]);
    expect(mocks.tx.insert).toHaveBeenCalledTimes(1);
    expect(mocks.insertedValues).toEqual([{
      workspaceId: WORKSPACE_ID,
      watchId: WATCH_ID,
      repositoryId: REPOSITORY_ID,
      sourceObservationId: SOURCE_OBSERVATION_ID,
      sourceInventoryReceiptSha256: "b".repeat(64),
      signedTreeNoteBase64: input.signedTreeNoteBase64,
      signedTreeNoteSha256: input.signedTreeNoteSha256,
      formatProfile: "go_sumdb_v1_retained_signed_tree_note_bytes",
      generation: 0,
      expectedPriorSignedTreeNoteSha256: null,
      expectedPriorGeneration: null,
    }]);
  });

  it("returns the current generation without inserting for an exact replay", async () => {
    const rawNote = Buffer.from("exact replay signed Go checksum database note", "utf8");
    const input = {
      workspaceId: WORKSPACE_ID,
      watchId: WATCH_ID,
      repositoryId: REPOSITORY_ID,
      sourceObservationId: SOURCE_OBSERVATION_ID,
      expectedPriorSignedTreeNoteSha256: null,
      signedTreeNoteBase64: rawNote.toString("base64"),
      signedTreeNoteSha256: sha256(rawNote),
    };
    const currentNote = {
      id: "66666666-6666-4666-8666-666666666666",
      workspaceId: WORKSPACE_ID,
      watchId: WATCH_ID,
      repositoryId: REPOSITORY_ID,
      sourceObservationId: SOURCE_OBSERVATION_ID,
      sourceInventoryReceiptSha256: "b".repeat(64),
      formatProfile: "go_sumdb_v1_retained_signed_tree_note_bytes",
      signedTreeNoteBase64: input.signedTreeNoteBase64,
      signedTreeNoteSha256: input.signedTreeNoteSha256,
      expectedPriorSignedTreeNoteSha256: null,
      expectedPriorGeneration: null,
      generation: 0,
      createdAt: new Date("2026-08-12T00:00:00.000Z"),
    };
    mocks.calls.length = 0;
    mocks.selectResultSets.splice(
      0,
      mocks.selectResultSets.length,
      [authorizedSourceObservation()],
      [currentNote],
    );
    mocks.insertReturningRows.length = 0;
    mocks.insertedValues.length = 0;
    mocks.tx.insert.mockClear();

    await expect(retainGoSumdbSignedTreeNote(input)).resolves.toEqual({
      recorded: false,
      note: currentNote,
    });
    expect(mocks.calls.map((call) => call.kind)).toEqual([
      "execute",
      "select",
      "select",
    ]);
    expect(mocks.tx.insert).not.toHaveBeenCalled();
    expect(mocks.insertedValues).toEqual([]);
  });

  it("appends generation one when the expected prior SHA matches the current note", async () => {
    const nextSourceObservationId = "77777777-7777-4777-8777-777777777777";
    const priorRawNote = Buffer.from("generation zero signed tree note", "utf8");
    const nextRawNote = Buffer.from("different generation one signed tree note", "utf8");
    const priorSha256 = sha256(priorRawNote);
    const input = {
      workspaceId: WORKSPACE_ID,
      watchId: WATCH_ID,
      repositoryId: REPOSITORY_ID,
      sourceObservationId: nextSourceObservationId,
      expectedPriorSignedTreeNoteSha256: priorSha256,
      signedTreeNoteBase64: nextRawNote.toString("base64"),
      signedTreeNoteSha256: sha256(nextRawNote),
    };
    const currentNote = {
      id: "66666666-6666-4666-8666-666666666666",
      workspaceId: WORKSPACE_ID,
      watchId: WATCH_ID,
      repositoryId: REPOSITORY_ID,
      sourceObservationId: SOURCE_OBSERVATION_ID,
      sourceInventoryReceiptSha256: "b".repeat(64),
      formatProfile: "go_sumdb_v1_retained_signed_tree_note_bytes",
      signedTreeNoteBase64: priorRawNote.toString("base64"),
      signedTreeNoteSha256: priorSha256,
      expectedPriorSignedTreeNoteSha256: null,
      expectedPriorGeneration: null,
      generation: 0,
      createdAt: new Date("2026-08-12T00:00:00.000Z"),
    };
    const insertedNote = {
      id: "88888888-8888-4888-8888-888888888888",
      ...input,
      sourceInventoryReceiptSha256: "c".repeat(64),
      formatProfile: "go_sumdb_v1_retained_signed_tree_note_bytes",
      expectedPriorGeneration: 0,
      generation: 1,
      createdAt: new Date("2026-08-12T00:01:00.000Z"),
    };
    mocks.calls.length = 0;
    mocks.selectResultSets.splice(
      0,
      mocks.selectResultSets.length,
      [{
        id: nextSourceObservationId,
        workspaceId: WORKSPACE_ID,
        watchId: WATCH_ID,
        repositoryId: REPOSITORY_ID,
        sourceInventoryReceiptSha256: "c".repeat(64),
      }],
      [currentNote],
    );
    mocks.insertReturningRows.splice(
      0,
      mocks.insertReturningRows.length,
      insertedNote,
    );
    mocks.insertedValues.length = 0;
    mocks.tx.insert.mockClear();

    await expect(retainGoSumdbSignedTreeNote(input)).resolves.toEqual({
      recorded: true,
      note: insertedNote,
    });
    expect(mocks.calls.map((call) => call.kind)).toEqual([
      "execute",
      "select",
      "select",
      "insert",
    ]);
    expect(mocks.insertedValues).toEqual([{
      workspaceId: WORKSPACE_ID,
      watchId: WATCH_ID,
      repositoryId: REPOSITORY_ID,
      sourceObservationId: nextSourceObservationId,
      sourceInventoryReceiptSha256: "c".repeat(64),
      formatProfile: "go_sumdb_v1_retained_signed_tree_note_bytes",
      signedTreeNoteBase64: input.signedTreeNoteBase64,
      signedTreeNoteSha256: input.signedTreeNoteSha256,
      expectedPriorSignedTreeNoteSha256: priorSha256,
      expectedPriorGeneration: 0,
      generation: 1,
    }]);
  });

  it("rejects stale, rebound, and self-successor lineage without inserting", async () => {
    const currentRawNote = Buffer.from("current generation one signed tree note", "utf8");
    const currentSha256 = sha256(currentRawNote);
    const generationZeroSha256 = sha256(Buffer.from("generation zero predecessor", "utf8"));
    const currentNote = {
      id: "88888888-8888-4888-8888-888888888888",
      workspaceId: WORKSPACE_ID,
      watchId: WATCH_ID,
      repositoryId: REPOSITORY_ID,
      sourceObservationId: SOURCE_OBSERVATION_ID,
      sourceInventoryReceiptSha256: "b".repeat(64),
      formatProfile: "go_sumdb_v1_retained_signed_tree_note_bytes",
      signedTreeNoteBase64: currentRawNote.toString("base64"),
      signedTreeNoteSha256: currentSha256,
      expectedPriorSignedTreeNoteSha256: generationZeroSha256,
      expectedPriorGeneration: 0,
      generation: 1,
      createdAt: new Date("2026-08-12T00:01:00.000Z"),
    };
    const otherSourceObservationId = "77777777-7777-4777-8777-777777777777";
    const differentRawNote = Buffer.from("proposed generation two signed tree note", "utf8");
    const cases = [
      {
        name: "stale expected prior",
        sourceObservationId: SOURCE_OBSERVATION_ID,
        sourceInventoryReceiptSha256: "b".repeat(64),
        expectedPriorSignedTreeNoteSha256: "d".repeat(64),
        signedTreeNoteBase64: differentRawNote.toString("base64"),
        signedTreeNoteSha256: sha256(differentRawNote),
      },
      {
        name: "same note rebound to different source custody",
        sourceObservationId: otherSourceObservationId,
        sourceInventoryReceiptSha256: "c".repeat(64),
        expectedPriorSignedTreeNoteSha256: generationZeroSha256,
        signedTreeNoteBase64: currentNote.signedTreeNoteBase64,
        signedTreeNoteSha256: currentSha256,
      },
      {
        name: "self-successor",
        sourceObservationId: SOURCE_OBSERVATION_ID,
        sourceInventoryReceiptSha256: "b".repeat(64),
        expectedPriorSignedTreeNoteSha256: currentSha256,
        signedTreeNoteBase64: currentNote.signedTreeNoteBase64,
        signedTreeNoteSha256: currentSha256,
      },
    ];

    for (const testCase of cases) {
      mocks.selectResultSets.splice(
        0,
        mocks.selectResultSets.length,
        [{
          id: testCase.sourceObservationId,
          workspaceId: WORKSPACE_ID,
          watchId: WATCH_ID,
          repositoryId: REPOSITORY_ID,
          sourceInventoryReceiptSha256: testCase.sourceInventoryReceiptSha256,
        }],
        [currentNote],
      );
      mocks.insertReturningRows.splice(0, mocks.insertReturningRows.length, {
        id: "99999999-9999-4999-8999-999999999999",
      });
      mocks.insertedValues.length = 0;
      mocks.tx.insert.mockClear();

      await expect(
        retainGoSumdbSignedTreeNote({
          workspaceId: WORKSPACE_ID,
          watchId: WATCH_ID,
          repositoryId: REPOSITORY_ID,
          sourceObservationId: testCase.sourceObservationId,
          expectedPriorSignedTreeNoteSha256:
            testCase.expectedPriorSignedTreeNoteSha256,
          signedTreeNoteBase64: testCase.signedTreeNoteBase64,
          signedTreeNoteSha256: testCase.signedTreeNoteSha256,
        }),
        testCase.name,
      ).rejects.toBeInstanceOf(GoSumdbNoteCustodyConflictError);
      expect(mocks.tx.insert, testCase.name).not.toHaveBeenCalled();
      expect(mocks.insertedValues, testCase.name).toEqual([]);
    }
  });

  it("maps reuse of an older retained note digest to the typed custody conflict", async () => {
    const generationZeroRaw = Buffer.from("retained generation zero", "utf8");
    const currentRaw = Buffer.from("retained generation one", "utf8");
    const generationZeroSha256 = sha256(generationZeroRaw);
    const currentSha256 = sha256(currentRaw);
    const currentNote = {
      id: "88888888-8888-4888-8888-888888888888",
      workspaceId: WORKSPACE_ID,
      watchId: WATCH_ID,
      repositoryId: REPOSITORY_ID,
      sourceObservationId: SOURCE_OBSERVATION_ID,
      sourceInventoryReceiptSha256: "b".repeat(64),
      formatProfile: "go_sumdb_v1_retained_signed_tree_note_bytes",
      signedTreeNoteBase64: currentRaw.toString("base64"),
      signedTreeNoteSha256: currentSha256,
      expectedPriorSignedTreeNoteSha256: generationZeroSha256,
      expectedPriorGeneration: 0,
      generation: 1,
      createdAt: new Date("2026-08-12T00:01:00.000Z"),
    };
    mocks.selectResultSets.splice(
      0,
      mocks.selectResultSets.length,
      [authorizedSourceObservation()],
      [currentNote],
    );
    mocks.insertReturningErrors.splice(
      0,
      mocks.insertReturningErrors.length,
      Object.assign(
        new Error("duplicate retained note digest"),
        { code: "23505" },
      ),
    );

    await expect(retainGoSumdbSignedTreeNote({
      workspaceId: WORKSPACE_ID,
      watchId: WATCH_ID,
      repositoryId: REPOSITORY_ID,
      sourceObservationId: SOURCE_OBSERVATION_ID,
      expectedPriorSignedTreeNoteSha256: currentSha256,
      signedTreeNoteBase64: generationZeroRaw.toString("base64"),
      signedTreeNoteSha256: generationZeroSha256,
    })).rejects.toBeInstanceOf(GoSumdbNoteCustodyConflictError);
  });
});

describe("readCurrentGoSumdbSignedTreeNote", () => {
  it("validates exact custody identity and returns only the scoped highest-generation opaque row or null", async () => {
    const input = {
      workspaceId: WORKSPACE_ID,
      watchId: WATCH_ID,
      repositoryId: REPOSITORY_ID,
    };
    const currentNote = {
      id: "99999999-9999-4999-8999-999999999999",
      workspaceId: WORKSPACE_ID,
      watchId: WATCH_ID,
      repositoryId: REPOSITORY_ID,
      sourceObservationId: SOURCE_OBSERVATION_ID,
      sourceInventoryReceiptSha256: "b".repeat(64),
      formatProfile: "go_sumdb_v1_retained_signed_tree_note_bytes",
      signedTreeNoteBase64: Buffer.from("opaque current signed tree note", "utf8")
        .toString("base64"),
      signedTreeNoteSha256: sha256(
        Buffer.from("opaque current signed tree note", "utf8"),
      ),
      expectedPriorSignedTreeNoteSha256: "a".repeat(64),
      expectedPriorGeneration: 3,
      generation: 4,
      createdAt: new Date("2026-08-12T00:04:00.000Z"),
    };
    mocks.selectResultSets.splice(0, mocks.selectResultSets.length, [currentNote]);
    mocks.selectWhereExpressions.length = 0;
    mocks.selectOrderByExpressions.length = 0;
    mocks.tx.select.mockClear();

    await expect(readCurrentGoSumdbSignedTreeNote(input)).resolves.toEqual(currentNote);
    expect(mocks.tx.select).toHaveBeenCalledTimes(1);
    const where = renderedSql(mocks.selectWhereExpressions[0]);
    expect(where.params).toEqual([WORKSPACE_ID, WATCH_ID, REPOSITORY_ID]);
    expect(where.sql).toMatch(/workspace_id.*watch_id.*repository_id/iu);
    const orderBy = renderedSql(mocks.selectOrderByExpressions[0]);
    expect(orderBy.sql).toMatch(/generation.*desc/iu);
    expect(currentNote).not.toHaveProperty("treeSize");
    expect(currentNote).not.toHaveProperty("treeRoot");

    mocks.selectResultSets.splice(0, mocks.selectResultSets.length, []);
    await expect(readCurrentGoSumdbSignedTreeNote(input)).resolves.toBeNull();

    const without = (field: keyof typeof input): Record<string, unknown> =>
      Object.fromEntries(Object.entries(input).filter(([key]) => key !== field));
    const invalidInputs = [
      ...(["workspaceId", "watchId", "repositoryId"] as const).flatMap((field) => [
        { ...input, [field]: 7 },
        { ...input, [field]: "not-a-uuid" },
        without(field),
      ]),
      { ...input, treeSize: 4 },
    ];
    for (const invalidInput of invalidInputs) {
      mocks.tx.select.mockClear();
      await expect(
        Promise.resolve().then(() =>
          readCurrentGoSumdbSignedTreeNote(invalidInput as never),
        ),
      ).rejects.toThrow();
      expect(mocks.tx.select).not.toHaveBeenCalled();
    }
  });
});

describe("deleteGoSumdbSignedTreeNoteCustodyForWatchTeardown", () => {
  it("locks and deletes the entire scoped timeline only for an exact existing watch", async () => {
    const input = {
      workspaceId: WORKSPACE_ID,
      watchId: WATCH_ID,
      repositoryId: REPOSITORY_ID,
    };
    mocks.calls.length = 0;
    mocks.selectResultSets.splice(0, mocks.selectResultSets.length, [{ id: WATCH_ID }]);
    mocks.deleteReturningRows.splice(
      0,
      mocks.deleteReturningRows.length,
      { id: "55555555-5555-4555-8555-555555555555" },
      { id: "66666666-6666-4666-8666-666666666666" },
    );
    mocks.tx.delete.mockClear();

    await expect(
      deleteGoSumdbSignedTreeNoteCustodyForWatchTeardown(input),
    ).resolves.toEqual({ deletedCount: 2 });
    expect(mocks.calls.map((call) => call.kind)).toEqual([
      "execute",
      "select",
      "delete",
    ]);

    mocks.calls.length = 0;
    mocks.selectResultSets.splice(0, mocks.selectResultSets.length, []);
    mocks.tx.delete.mockClear();
    await expect(
      deleteGoSumdbSignedTreeNoteCustodyForWatchTeardown(input),
    ).rejects.toMatchObject({ name: "GoSumdbNoteCustodyAuthorizationError" });
    expect(mocks.tx.delete).not.toHaveBeenCalled();
  });
});
