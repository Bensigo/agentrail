import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  dependencyWatchGoSumdbSignedTreeNotes,
  dependencyWatchObservations,
  dependencyWatches,
  GO_SUMDB_SIGNED_TREE_NOTE_FORMAT_PROFILE,
  type DependencyWatchGoSumdbSignedTreeNoteRow,
} from "../schema/dependency_watches.js";

// A signed tree note is bounded custody metadata, not an artifact body.
export const MAX_GO_SUMDB_SIGNED_TREE_NOTE_BYTES = 4 * 1024;

const MAX_GO_SUMDB_SIGNED_TREE_NOTE_BASE64_BYTES =
  4 * Math.ceil(MAX_GO_SUMDB_SIGNED_TREE_NOTE_BYTES / 3);
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INPUT_KEYS = [
  "expectedPriorSignedTreeNoteSha256",
  "repositoryId",
  "signedTreeNoteBase64",
  "signedTreeNoteSha256",
  "sourceObservationId",
  "watchId",
  "workspaceId",
] as const;

export class GoSumdbNoteCustodyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoSumdbNoteCustodyValidationError";
  }
}

export class GoSumdbNoteCustodyAuthorizationError extends Error {
  constructor(message = "source observation custody is not authorized") {
    super(message);
    this.name = "GoSumdbNoteCustodyAuthorizationError";
  }
}

export class GoSumdbNoteCustodyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoSumdbNoteCustodyConflictError";
  }
}

export type RetainGoSumdbSignedTreeNoteInput = {
  workspaceId: string;
  watchId: string;
  repositoryId: string;
  sourceObservationId: string;
  expectedPriorSignedTreeNoteSha256: string | null;
  signedTreeNoteBase64: string;
  signedTreeNoteSha256: string;
};

export type RetainGoSumdbSignedTreeNoteResult = {
  recorded: boolean;
  note: DependencyWatchGoSumdbSignedTreeNoteRow;
};

export type ReadCurrentGoSumdbSignedTreeNoteInput = {
  workspaceId: string;
  watchId: string;
  repositoryId: string;
};

export type DeleteGoSumdbSignedTreeNoteCustodyResult = {
  deletedCount: number;
};

function isPostgresUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; cause?: unknown };
  if (record.code === "23505") return true;
  return typeof record.cause === "object"
    && record.cause !== null
    && (record.cause as { code?: unknown }).code === "23505";
}

function validatedUuid(name: string, value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new GoSumdbNoteCustodyValidationError(`${name} must be a lowercase UUID`);
  }
  return value;
}

function validatedReadInput(input: unknown): ReadCurrentGoSumdbSignedTreeNoteInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new GoSumdbNoteCustodyValidationError("note custody read must be an object");
  }
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  const expectedKeys = ["repositoryId", "watchId", "workspaceId"];
  if (
    keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new GoSumdbNoteCustodyValidationError(
      "note custody read must contain exactly workspace, watch, and repository IDs",
    );
  }
  return {
    workspaceId: validatedUuid("workspaceId", value["workspaceId"]),
    watchId: validatedUuid("watchId", value["watchId"]),
    repositoryId: validatedUuid("repositoryId", value["repositoryId"]),
  };
}

function validatedRawSignedTreeNote(input: unknown): RetainGoSumdbSignedTreeNoteInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new GoSumdbNoteCustodyValidationError("signed tree note custody must be an object");
  }
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== INPUT_KEYS.length
    || keys.some((key, index) => key !== INPUT_KEYS[index])
  ) {
    throw new GoSumdbNoteCustodyValidationError(
      "signed tree note custody must contain exactly the opaque custody keys",
    );
  }
  const workspaceId = validatedUuid("workspaceId", value["workspaceId"]);
  const watchId = validatedUuid("watchId", value["watchId"]);
  const repositoryId = validatedUuid("repositoryId", value["repositoryId"]);
  const sourceObservationId = validatedUuid(
    "sourceObservationId",
    value["sourceObservationId"],
  );
  const expectedPriorSignedTreeNoteSha256 = value["expectedPriorSignedTreeNoteSha256"];
  const signedTreeNoteBase64 = value["signedTreeNoteBase64"];
  const signedTreeNoteSha256 = value["signedTreeNoteSha256"];
  if (
    expectedPriorSignedTreeNoteSha256 !== null
    && (typeof expectedPriorSignedTreeNoteSha256 !== "string"
      || !SHA256.test(expectedPriorSignedTreeNoteSha256))
  ) {
    throw new GoSumdbNoteCustodyValidationError(
      "expected prior signed tree note SHA-256 must be null or lowercase hexadecimal",
    );
  }
  if (
    typeof signedTreeNoteBase64 !== "string"
    || signedTreeNoteBase64.length === 0
    || signedTreeNoteBase64.length > MAX_GO_SUMDB_SIGNED_TREE_NOTE_BASE64_BYTES
    || !CANONICAL_BASE64.test(signedTreeNoteBase64)
  ) {
    throw new GoSumdbNoteCustodyValidationError(
      "signed tree note must be bounded canonical base64",
    );
  }
  if (typeof signedTreeNoteSha256 !== "string" || !SHA256.test(signedTreeNoteSha256)) {
    throw new GoSumdbNoteCustodyValidationError(
      "signed tree note SHA-256 must be lowercase hexadecimal",
    );
  }

  const rawNote = Buffer.from(signedTreeNoteBase64, "base64");
  if (
    rawNote.length === 0
    || rawNote.length > MAX_GO_SUMDB_SIGNED_TREE_NOTE_BYTES
    || rawNote.toString("base64") !== signedTreeNoteBase64
  ) {
    throw new GoSumdbNoteCustodyValidationError(
      "signed tree note base64 is not canonical or exceeds the byte limit",
    );
  }
  const actualSha256 = createHash("sha256").update(rawNote).digest("hex");
  if (actualSha256 !== signedTreeNoteSha256) {
    throw new GoSumdbNoteCustodyValidationError(
      "signed tree note SHA-256 does not match its raw bytes",
    );
  }
  return {
    workspaceId,
    watchId,
    repositoryId,
    sourceObservationId,
    expectedPriorSignedTreeNoteSha256,
    signedTreeNoteBase64,
    signedTreeNoteSha256,
  };
}

/**
 * Retain opaque signed-tree-note bytes without claiming that Postgres verified
 * their signature, tree, inclusion proof, or consistency proof.
 */
export async function retainGoSumdbSignedTreeNote(
  input: RetainGoSumdbSignedTreeNoteInput,
): Promise<RetainGoSumdbSignedTreeNoteResult> {
  const validated = validatedRawSignedTreeNote(input);
  return db.transaction(async (tx) => {
    const lockKey = `go-sumdb-note-custody:${validated.workspaceId}:${validated.watchId}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

    const [sourceObservation] = await tx
      .select({
        id: dependencyWatchObservations.id,
        sourceInventoryReceiptSha256:
          dependencyWatchObservations.sourceInventoryReceiptSha256,
      })
      .from(dependencyWatchObservations)
      .where(and(
        eq(dependencyWatchObservations.id, validated.sourceObservationId),
        eq(dependencyWatchObservations.workspaceId, validated.workspaceId),
        eq(dependencyWatchObservations.watchId, validated.watchId),
        eq(dependencyWatchObservations.repositoryId, validated.repositoryId),
      ))
      .limit(1);
    if (!sourceObservation?.sourceInventoryReceiptSha256) {
      throw new GoSumdbNoteCustodyAuthorizationError(
        "source observation custody is missing or not authorized",
      );
    }

    const [currentNote] = await tx
      .select()
      .from(dependencyWatchGoSumdbSignedTreeNotes)
      .where(and(
        eq(dependencyWatchGoSumdbSignedTreeNotes.workspaceId, validated.workspaceId),
        eq(dependencyWatchGoSumdbSignedTreeNotes.watchId, validated.watchId),
        eq(dependencyWatchGoSumdbSignedTreeNotes.repositoryId, validated.repositoryId),
      ))
      .orderBy(desc(dependencyWatchGoSumdbSignedTreeNotes.generation))
      .limit(1);
    if (currentNote) {
      if (
        currentNote.workspaceId === validated.workspaceId
        && currentNote.watchId === validated.watchId
        && currentNote.repositoryId === validated.repositoryId
        && currentNote.sourceObservationId === validated.sourceObservationId
        && currentNote.sourceInventoryReceiptSha256
          === sourceObservation.sourceInventoryReceiptSha256
        && currentNote.formatProfile === GO_SUMDB_SIGNED_TREE_NOTE_FORMAT_PROFILE
        && currentNote.signedTreeNoteBase64 === validated.signedTreeNoteBase64
        && currentNote.signedTreeNoteSha256 === validated.signedTreeNoteSha256
        && currentNote.expectedPriorSignedTreeNoteSha256
          === validated.expectedPriorSignedTreeNoteSha256
      ) {
        return { recorded: false, note: currentNote };
      }
      if (
        validated.expectedPriorSignedTreeNoteSha256 === null
        || validated.expectedPriorSignedTreeNoteSha256
          !== currentNote.signedTreeNoteSha256
        || validated.signedTreeNoteSha256
          === validated.expectedPriorSignedTreeNoteSha256
        || !Number.isInteger(currentNote.generation)
        || currentNote.generation < 0
      ) {
        throw new GoSumdbNoteCustodyConflictError(
          "signed tree note successor does not match the current generation",
        );
      }
      let successor: DependencyWatchGoSumdbSignedTreeNoteRow | undefined;
      try {
        [successor] = await tx
          .insert(dependencyWatchGoSumdbSignedTreeNotes)
          .values({
            workspaceId: validated.workspaceId,
            watchId: validated.watchId,
            repositoryId: validated.repositoryId,
            sourceObservationId: validated.sourceObservationId,
            sourceInventoryReceiptSha256:
              sourceObservation.sourceInventoryReceiptSha256,
            formatProfile: GO_SUMDB_SIGNED_TREE_NOTE_FORMAT_PROFILE,
            signedTreeNoteBase64: validated.signedTreeNoteBase64,
            signedTreeNoteSha256: validated.signedTreeNoteSha256,
            expectedPriorSignedTreeNoteSha256:
              validated.expectedPriorSignedTreeNoteSha256,
            expectedPriorGeneration: currentNote.generation,
            generation: currentNote.generation + 1,
          })
          .returning();
      } catch (error) {
        if (isPostgresUniqueViolation(error)) {
          throw new GoSumdbNoteCustodyConflictError(
            "signed tree note successor conflicts with retained custody",
          );
        }
        throw error;
      }
      if (!successor) {
        throw new GoSumdbNoteCustodyConflictError(
          "signed tree note successor did not create custody",
        );
      }
      return { recorded: true, note: successor };
    }
    if (validated.expectedPriorSignedTreeNoteSha256 !== null) {
      throw new GoSumdbNoteCustodyConflictError(
        "signed tree note bootstrap requires a null expected prior digest",
      );
    }

    const [inserted] = await tx
      .insert(dependencyWatchGoSumdbSignedTreeNotes)
      .values({
        workspaceId: validated.workspaceId,
        watchId: validated.watchId,
        repositoryId: validated.repositoryId,
        sourceObservationId: validated.sourceObservationId,
        sourceInventoryReceiptSha256:
          sourceObservation.sourceInventoryReceiptSha256,
        formatProfile: GO_SUMDB_SIGNED_TREE_NOTE_FORMAT_PROFILE,
        signedTreeNoteBase64: validated.signedTreeNoteBase64,
        signedTreeNoteSha256: validated.signedTreeNoteSha256,
        expectedPriorSignedTreeNoteSha256: null,
        expectedPriorGeneration: null,
        generation: 0,
      })
      .returning();
    if (!inserted) {
      throw new GoSumdbNoteCustodyConflictError(
        "signed tree note bootstrap did not create custody",
      );
    }
    return { recorded: true, note: inserted };
  });
}

/** Read the latest opaque note bytes; callers must re-authenticate them. */
export async function readCurrentGoSumdbSignedTreeNote(
  input: ReadCurrentGoSumdbSignedTreeNoteInput,
): Promise<DependencyWatchGoSumdbSignedTreeNoteRow | null> {
  const validated = validatedReadInput(input);
  const [row] = await db
    .select()
    .from(dependencyWatchGoSumdbSignedTreeNotes)
    .where(and(
      eq(dependencyWatchGoSumdbSignedTreeNotes.workspaceId, validated.workspaceId),
      eq(dependencyWatchGoSumdbSignedTreeNotes.watchId, validated.watchId),
      eq(dependencyWatchGoSumdbSignedTreeNotes.repositoryId, validated.repositoryId),
    ))
    .orderBy(desc(dependencyWatchGoSumdbSignedTreeNotes.generation))
    .limit(1);
  return row ?? null;
}

/**
 * Explicitly remove an entire watch timeline before intentional watch or
 * workspace teardown. Ordinary source-observation deletion remains restricted
 * so it cannot roll current custody back to an earlier generation.
 */
export async function deleteGoSumdbSignedTreeNoteCustodyForWatchTeardown(
  input: ReadCurrentGoSumdbSignedTreeNoteInput,
): Promise<DeleteGoSumdbSignedTreeNoteCustodyResult> {
  const validated = validatedReadInput(input);
  return db.transaction(async (tx) => {
    const lockKey = `go-sumdb-note-custody:${validated.workspaceId}:${validated.watchId}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

    const [watch] = await tx
      .select({ id: dependencyWatches.id })
      .from(dependencyWatches)
      .where(and(
        eq(dependencyWatches.id, validated.watchId),
        eq(dependencyWatches.workspaceId, validated.workspaceId),
        eq(dependencyWatches.repositoryId, validated.repositoryId),
      ))
      .limit(1);
    if (!watch) {
      throw new GoSumdbNoteCustodyAuthorizationError(
        "watch custody is missing or not authorized for teardown",
      );
    }

    const deleted = await tx
      .delete(dependencyWatchGoSumdbSignedTreeNotes)
      .where(and(
        eq(dependencyWatchGoSumdbSignedTreeNotes.workspaceId, validated.workspaceId),
        eq(dependencyWatchGoSumdbSignedTreeNotes.watchId, validated.watchId),
        eq(dependencyWatchGoSumdbSignedTreeNotes.repositoryId, validated.repositoryId),
      ))
      .returning({ id: dependencyWatchGoSumdbSignedTreeNotes.id });
    return { deletedCount: deleted.length };
  });
}
