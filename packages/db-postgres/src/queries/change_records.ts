import { createHash, randomUUID } from "crypto";
import { isDeepStrictEqual } from "util";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  changeRecordEvents,
  changeRecords,
  acceptanceBuilderRoutes,
  acceptanceContextPackSnapshots,
  acceptanceContracts,
  acceptanceIntakes,
  acceptanceIntakeMessages,
  type AcceptanceContractRow,
  type AcceptanceBuilderRouteRow,
  type AcceptanceContextPackSnapshotRow,
  type AcceptanceIntakeMessageRow,
  type AcceptanceIntakeRow,
  type ChangeRecordEventRow,
  type ChangeRecordRow,
} from "../schema/change_records.js";
import { reviewJobs } from "../schema/review_jobs.js";
import { repositories } from "../schema/repositories.js";
import { wikiPages } from "../schema/wiki_pages.js";

const NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

function uuid5Url(name: string): string {
  const ns = Buffer.from(NAMESPACE_URL.replace(/-/g, ""), "hex");
  const hash = createHash("sha1")
    .update(ns)
    .update(Buffer.from(name, "utf8"))
    .digest();
  const b = hash.subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(value as string);
}

function toDateOrNull(value: unknown): Date | null {
  return value == null ? null : toDate(value);
}

function normalizeHeadShas(headShas: readonly string[] | undefined): string[] {
  return Array.from(new Set((headShas ?? []).filter(Boolean))).sort();
}

function textArraySql(values: readonly string[]) {
  if (values.length === 0) return sql`ARRAY[]::text[]`;
  return sql`ARRAY[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::text[]`;
}

function mergeHeadShasSql(headShas: readonly string[]) {
  return sql`
    ARRAY(
      SELECT DISTINCT unnest(
        COALESCE(change_records.head_shas, ARRAY[]::text[]) || ${textArraySql(headShas)}
      )
      ORDER BY 1
    )
  `;
}

export type ChangeRecordAnchor = {
  workspaceId: string;
  repo: string;
  workKey?: string | null;
  issueNumber?: number | null;
  prNumber?: number | null;
};

export function changeRecordId(input: ChangeRecordAnchor): string {
  if (input.workKey != null && input.workKey.trim()) {
    return uuid5Url(
      `change-record:work:${input.workspaceId}:${input.repo}:${input.workKey.trim()}`
    );
  }
  if (input.issueNumber != null) {
    return uuid5Url(
      `change-record:issue:${input.workspaceId}:${input.repo}:${input.issueNumber}`
    );
  }
  if (input.prNumber != null) {
    return uuid5Url(
      `change-record:pr:${input.workspaceId}:${input.repo}:${input.prNumber}`
    );
  }
  throw new Error("changeRecordId requires workKey, issueNumber, or prNumber");
}

export function changeRecordEventId(input: {
  recordId: string;
  eventKey: string;
}): string {
  return uuid5Url(`change-record-event:${input.recordId}:${input.eventKey}`);
}

export function acceptanceContractId(input: {
  recordId: string;
  version: number;
}): string {
  return uuid5Url(`acceptance-contract:${input.recordId}:${input.version}`);
}

export function acceptanceIntakeId(input: {
  workspaceId: string;
  originChannel: string;
  conversationKey: string;
}): string {
  return uuid5Url(
    `acceptance-intake:${input.workspaceId}:${input.originChannel}:${input.conversationKey}`
  );
}

export function acceptanceIntakeMessageId(input: {
  intakeId: string;
  sourceKey: string;
}): string {
  return uuid5Url(`acceptance-intake-message:${input.intakeId}:${input.sourceKey}`);
}

function mapChangeRecordRow(row: Record<string, unknown>): ChangeRecordRow {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    repo: row.repo as string,
    workKey: (row.work_key as string | null) ?? null,
    originChannel: (row.origin_channel as string | null) ?? null,
    sourceReferences:
      (row.source_references as Record<string, unknown>[] | null) ?? [],
    issueNumber: (row.issue_number as number | null) ?? null,
    prNumber: (row.pr_number as number | null) ?? null,
    headShas: (row.head_shas as string[] | null) ?? [],
    mergedSha: (row.merged_sha as string | null) ?? null,
    state: row.state as string,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapChangeRecordEventRow(
  row: Record<string, unknown>
): ChangeRecordEventRow {
  return {
    id: row.id as string,
    recordId: row.record_id as string,
    eventKey: row.event_key as string,
    stage: row.stage as string,
    at: toDate(row.at),
    actor: row.actor as string,
    payloadRef: row.payload_ref as Record<string, unknown>,
    createdAt: toDate(row.created_at),
  };
}

export type FindOrCreateChangeRecordInput = ChangeRecordAnchor & {
  headShas?: readonly string[];
  mergedSha?: string | null;
  state?: string;
};

/**
 * Deterministically find or create a Change Record by issue and/or PR.
 *
 * When an issue-only record and PR-only record already exist for the same
 * workspace/repo change, the issue record is canonical: PR fields and events
 * are moved onto it, then the PR-only shell is deleted. That gives adapters a
 * stable way to write before they know both anchors, while later enrichment
 * still converges to one record.
 */
export async function findOrCreateChangeRecord(
  input: FindOrCreateChangeRecordInput
): Promise<ChangeRecordRow> {
  if (input.issueNumber == null && input.prNumber == null) {
    throw new Error("findOrCreateChangeRecord requires issueNumber or prNumber");
  }

  const headShas = normalizeHeadShas(input.headShas);
  const canonicalId = changeRecordId(input);
  const lockKey = `change-record:${input.workspaceId}:${input.repo}`;

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

    const issueRows =
      input.issueNumber == null
        ? []
        : Array.from(
            await tx.execute(sql`
              SELECT * FROM change_records
              WHERE workspace_id = ${input.workspaceId}
                AND repo = ${input.repo}
                AND issue_number = ${input.issueNumber}
              LIMIT 1
            `)
          );
    const prRows =
      input.prNumber == null
        ? []
        : Array.from(
            await tx.execute(sql`
              SELECT * FROM change_records
              WHERE workspace_id = ${input.workspaceId}
                AND repo = ${input.repo}
                AND pr_number = ${input.prNumber}
              LIMIT 1
            `)
          );

    const issueRecord = issueRows[0] as Record<string, unknown> | undefined;
    const prRecord = prRows[0] as Record<string, unknown> | undefined;

    if (issueRecord && prRecord && issueRecord.id !== prRecord.id) {
      await tx.execute(sql`
        DELETE FROM change_record_events old
        WHERE old.record_id = ${prRecord.id as string}
          AND EXISTS (
            SELECT 1 FROM change_record_events kept
            WHERE kept.record_id = ${issueRecord.id as string}
          AND kept.event_key = old.event_key
          )
      `);
      await tx.execute(sql`
        UPDATE change_record_events
        SET record_id = ${issueRecord.id as string}
        WHERE record_id = ${prRecord.id as string}
      `);
      await tx.execute(sql`
        DELETE FROM change_records
        WHERE id = ${prRecord.id as string}
      `);
      const mergedHeadShas = normalizeHeadShas([
        ...headShas,
        ...((prRecord.head_shas as string[] | null | undefined) ?? []),
      ]);
      await tx.execute(sql`
        UPDATE change_records
        SET pr_number = COALESCE(pr_number, ${input.prNumber ?? null}),
            head_shas = ${mergeHeadShasSql(mergedHeadShas)},
            merged_sha = COALESCE(${input.mergedSha ?? null}, merged_sha),
            state = COALESCE(${input.state ?? null}, state),
            updated_at = now()
        WHERE id = ${issueRecord.id as string}
      `);
      const rows = Array.from(
        await tx.execute(sql`
          SELECT * FROM change_records
          WHERE id = ${issueRecord.id as string}
          LIMIT 1
        `)
      ) as Array<Record<string, unknown>>;
      return mapChangeRecordRow(rows[0]!);
    }

    const existing = issueRecord ?? prRecord;
    if (existing) {
      const rows = Array.from(
        await tx.execute(sql`
          UPDATE change_records
          SET issue_number = COALESCE(issue_number, ${input.issueNumber ?? null}),
              pr_number = COALESCE(pr_number, ${input.prNumber ?? null}),
              head_shas = ${mergeHeadShasSql(headShas)},
              merged_sha = COALESCE(${input.mergedSha ?? null}, merged_sha),
              state = COALESCE(${input.state ?? null}, state),
              updated_at = now()
          WHERE id = ${existing.id as string}
          RETURNING *
        `)
      ) as Array<Record<string, unknown>>;
      return mapChangeRecordRow(rows[0]!);
    }

    const rows = Array.from(
      await tx.execute(sql`
        INSERT INTO change_records (
          id, workspace_id, repo, issue_number, pr_number, head_shas, merged_sha, state
        )
        VALUES (
          ${canonicalId},
          ${input.workspaceId},
          ${input.repo},
          ${input.issueNumber ?? null},
          ${input.prNumber ?? null},
          ${textArraySql(headShas)},
          ${input.mergedSha ?? null},
          ${input.state ?? "open"}
        )
        RETURNING *
      `)
    ) as Array<Record<string, unknown>>;
    return mapChangeRecordRow(rows[0]!);
  });
}

export type AppendChangeRecordEventInput = {
  recordId: string;
  eventKey: string;
  stage: string;
  actor: string;
  payloadRef: Record<string, unknown>;
  at?: Date;
};

export type AppendChangeRecordEventResult = {
  event: ChangeRecordEventRow;
  inserted: boolean;
};

export type AppendChangeRecordEventsAtomicallyInput = readonly AppendChangeRecordEventInput[];

export type AppendChangeRecordEventsAtomicallyResult = {
  events: AppendChangeRecordEventResult[];
};

async function appendChangeRecordEventsAtomicallyInTransaction(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  inputs: AppendChangeRecordEventsAtomicallyInput
): Promise<AppendChangeRecordEventsAtomicallyResult> {
  const events: AppendChangeRecordEventResult[] = [];
  for (const input of inputs) {
    const at = (input.at ?? new Date()).toISOString();
    const insertedRows = Array.from(await tx.execute(sql`
      INSERT INTO change_record_events (
        id, record_id, event_key, stage, at, actor, payload_ref
      )
      VALUES (
        ${changeRecordEventId({ recordId: input.recordId, eventKey: input.eventKey })},
        ${input.recordId},
        ${input.eventKey},
        ${input.stage},
        ${at},
        ${input.actor},
        ${JSON.stringify(input.payloadRef)}::jsonb
      )
      ON CONFLICT (record_id, event_key) DO NOTHING
      RETURNING *
    `)) as Array<Record<string, unknown>>;
    const rawEvent = (await tx.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, input.recordId),
      eq(changeRecordEvents.eventKey, input.eventKey),
    )).limit(1))[0];
    if (!rawEvent) {
      throw new Error("appendChangeRecordEventsAtomically: event was not inserted or found");
    }

    const event = rawEvent as ChangeRecordEventRow;
    if (
      event.stage !== input.stage
      || event.actor !== input.actor
      || !isDeepStrictEqual(event.payloadRef, input.payloadRef)
    ) {
      throw new Error(
        "appendChangeRecordEventsAtomically: event key is already bound to different stage, actor, or payloadRef"
      );
    }
    events.push({ event, inserted: insertedRows[0] != null });
  }
  return { events };
}

export async function appendChangeRecordEvent(
  input: AppendChangeRecordEventInput
): Promise<AppendChangeRecordEventResult> {
  const id = changeRecordEventId({
    recordId: input.recordId,
    eventKey: input.eventKey,
  });
  const payloadRefJson = JSON.stringify(input.payloadRef);
  const at = (input.at ?? new Date()).toISOString();
  const inserted = Array.from(
    await db.execute(sql`
      INSERT INTO change_record_events (
        id, record_id, event_key, stage, at, actor, payload_ref
      )
      VALUES (
        ${id},
        ${input.recordId},
        ${input.eventKey},
        ${input.stage},
        ${at},
        ${input.actor},
        ${payloadRefJson}::jsonb
      )
      ON CONFLICT (record_id, event_key) DO NOTHING
      RETURNING *
    `)
  ) as Array<Record<string, unknown>>;

  const raw =
    inserted[0] ??
    (
      await db
        .select()
        .from(changeRecordEvents)
        .where(
          and(
            eq(changeRecordEvents.recordId, input.recordId),
            eq(changeRecordEvents.eventKey, input.eventKey)
          )
        )
        .limit(1)
    )[0];
  if (!raw) {
    throw new Error("appendChangeRecordEvent: event was not inserted or found");
  }
  return {
    event:
      inserted[0] != null
        ? mapChangeRecordEventRow(inserted[0])
        : (raw as ChangeRecordEventRow),
    inserted: inserted[0] != null,
  };
}

/**
 * Append one bounded, single-Record event batch as one all-or-nothing write.
 *
 * A retry may reuse an event key only when it names the same immutable event
 * provenance. `at` deliberately does not participate in that comparison: a
 * retry can occur at a different wall-clock time while still referring to the
 * original event key.
 */
export async function appendChangeRecordEventsAtomically(
  inputs: AppendChangeRecordEventsAtomicallyInput
): Promise<AppendChangeRecordEventsAtomicallyResult> {
  if (inputs.length === 0) {
    throw new Error("appendChangeRecordEventsAtomically requires at least one event");
  }

  const recordId = inputs[0]!.recordId;
  const eventKeys = new Set<string>();
  for (const input of inputs) {
    if (input.recordId !== recordId) {
      throw new Error("appendChangeRecordEventsAtomically requires one recordId");
    }
    if (eventKeys.has(input.eventKey)) {
      throw new Error("appendChangeRecordEventsAtomically does not allow duplicate eventKeys");
    }
    eventKeys.add(input.eventKey);
  }

  return db.transaction(async (tx) => {
    return appendChangeRecordEventsAtomicallyInTransaction(tx, inputs);
  });
}

export type AttachConfirmedAcceptanceRecordToExternalPullRequestResult =
  | { kind: "attached"; record: ChangeRecordRow; inserted: boolean }
  | { kind: "not_found" | "not_confirmed" | "already_attached" };

/**
 * Binds a PR discovered outside Jace to the already-confirmed Acceptance
 * Record it explicitly names. This never guesses by repository, branch, or
 * issue number: another Record already owning the PR, or this Record already
 * owning another PR, stays unmodified for a human to resolve.
 */
export async function attachConfirmedAcceptanceRecordToExternalPullRequest(input: {
  workspaceId: string;
  recordId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  source: "github_webhook" | "manual" | "mcp";
  prUrl?: string | null;
}): Promise<AttachConfirmedAcceptanceRecordToExternalPullRequestResult> {
  if (!Number.isInteger(input.prNumber) || input.prNumber <= 0 || !GIT_SHA.test(input.headSha)) {
    throw new Error("External pull request attachment requires a positive PR number and git head SHA");
  }
  const lockKey = `acceptance-record-pr:${input.workspaceId}:${input.repo}:${input.recordId}`;

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const record = (
      await tx
        .select()
        .from(changeRecords)
        .where(
          and(
            eq(changeRecords.workspaceId, input.workspaceId),
            eq(changeRecords.repo, input.repo),
            eq(changeRecords.id, input.recordId)
          )
        )
        .limit(1)
    )[0];
    if (!record) return { kind: "not_found" };

    const confirmed = await tx
      .select({ id: acceptanceContracts.id, version: acceptanceContracts.version })
      .from(acceptanceContracts)
      .where(
        and(
          eq(acceptanceContracts.recordId, input.recordId),
          eq(acceptanceContracts.status, "confirmed")
        )
      )
      .limit(1);
    if (!confirmed[0]) return { kind: "not_confirmed" };

    const existingPr = (
      await tx
        .select({ id: changeRecords.id })
        .from(changeRecords)
        .where(
          and(
            eq(changeRecords.workspaceId, input.workspaceId),
            eq(changeRecords.repo, input.repo),
            eq(changeRecords.prNumber, input.prNumber)
          )
        )
        .limit(1)
    )[0];
    if ((record.prNumber != null && record.prNumber !== input.prNumber) ||
        (existingPr && existingPr.id !== input.recordId)) {
      return { kind: "already_attached" };
    }

    const rows = await tx
      .update(changeRecords)
      .set({
        prNumber: input.prNumber,
        headShas: normalizeHeadShas([...record.headShas, input.headSha]),
        updatedAt: new Date(),
      })
      .where(eq(changeRecords.id, input.recordId))
      .returning();
    const attached = rows[0]!;
    const eventKey = `external-pr:attached:${input.prNumber}:${input.headSha}`;
    const eventId = changeRecordEventId({ recordId: input.recordId, eventKey });
    const inserted = await tx
      .insert(changeRecordEvents)
      .values({
        id: eventId,
        recordId: input.recordId,
        eventKey,
        stage: "external_pr",
        actor: input.source,
        payloadRef: {
          kind: "external_pr_attachment",
          repo: input.repo,
          prNumber: input.prNumber,
          headSha: input.headSha,
          prUrl: input.prUrl ?? null,
          acceptanceContractVersion: confirmed[0].version,
        },
      })
      .onConflictDoNothing()
      .returning({ id: changeRecordEvents.id });
    return { kind: "attached", record: attached, inserted: inserted.length === 1 };
  });
}

const GIT_SHA = /^[0-9a-f]{7,64}$/i;
const OUTCOME_REFERENCE_LIMIT = 1_024;
const OUTCOME_ENVIRONMENT_LIMIT = 160;

function boundedOutcomeReference(value: unknown, limit = OUTCOME_REFERENCE_LIMIT): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= limit
    && value === value.trim()
    && !/[\u0000-\u001F\u007F]/.test(value);
}

function gitSha(value: unknown): value is string {
  return typeof value === "string" && GIT_SHA.test(value);
}

export type AcceptancePostMergeOutcome =
  | {
      kind: "merged";
      prNumber: number;
      baseSha: string;
      headSha: string;
      mergeSha: string;
      mergeReference: string;
    }
  | {
      kind: "deployed";
      revisionSha: string;
      environment: string;
      deploymentReference: string;
    }
  | {
      kind: "incident";
      revisionSha: string;
      incidentReference: string;
    }
  | {
      kind: "reverted";
      revertedSha: string;
      revertSha: string;
      revertReference: string;
    };

export type RecordAcceptancePostMergeOutcomeInput = {
  workspaceId: string;
  recordId: string;
  recordedBy: string;
  outcome: AcceptancePostMergeOutcome;
  occurredAt?: Date;
};

/**
 * Accept only a bounded post-merge reference. This is deliberately not a
 * generic timeline write: each variant has a stable idempotency key and can
 * be checked against the Record's current PR/head/merge lineage.
 */
export function validateAcceptancePostMergeOutcome(
  value: unknown
): value is AcceptancePostMergeOutcome {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const outcome = value as Record<string, unknown>;
  if (outcome.kind === "merged") {
    return Number.isInteger(outcome.prNumber)
      && (outcome.prNumber as number) > 0
      && gitSha(outcome.baseSha)
      && gitSha(outcome.headSha)
      && gitSha(outcome.mergeSha)
      && boundedOutcomeReference(outcome.mergeReference);
  }
  if (outcome.kind === "deployed") {
    return gitSha(outcome.revisionSha)
      && boundedOutcomeReference(outcome.environment, OUTCOME_ENVIRONMENT_LIMIT)
      && boundedOutcomeReference(outcome.deploymentReference);
  }
  if (outcome.kind === "incident") {
    return gitSha(outcome.revisionSha)
      && boundedOutcomeReference(outcome.incidentReference);
  }
  if (outcome.kind === "reverted") {
    return gitSha(outcome.revertedSha)
      && gitSha(outcome.revertSha)
      && boundedOutcomeReference(outcome.revertReference);
  }
  return false;
}

function outcomeEventKey(outcome: AcceptancePostMergeOutcome): string {
  switch (outcome.kind) {
    case "merged":
      return `acceptance-post-merge:merged:${outcome.mergeSha}`;
    case "deployed":
      return `acceptance-post-merge:deployed:${outcome.deploymentReference}`;
    case "incident":
      return `acceptance-post-merge:incident:${outcome.incidentReference}`;
    case "reverted":
      return `acceptance-post-merge:reverted:${outcome.revertSha}`;
  }
}

function outcomePayload(record: ChangeRecordRow, outcome: AcceptancePostMergeOutcome): Record<string, unknown> {
  return { kind: "acceptance_post_merge_outcome", repository: record.repo, outcome };
}

/**
 * Append one human-authorized post-merge outcome to its canonical Acceptance
 * Record. The Record header is only a current summary; the event is the
 * immutable provenance of the merge, deployment, incident, or revert.
 */
export async function recordAcceptancePostMergeOutcome(
  input: RecordAcceptancePostMergeOutcomeInput
): Promise<{ event: ChangeRecordEventRow; inserted: boolean }> {
  if (!validateAcceptancePostMergeOutcome(input.outcome)) {
    throw new Error("Invalid Acceptance Record post-merge outcome");
  }
  if (!boundedOutcomeReference(input.recordedBy, 256)) {
    throw new Error("Invalid Acceptance Record outcome actor");
  }
  if (input.occurredAt != null && Number.isNaN(input.occurredAt.valueOf())) {
    throw new Error("Invalid Acceptance Record outcome timestamp");
  }

  const eventKey = outcomeEventKey(input.outcome);
  const at = (input.occurredAt ?? new Date()).toISOString();
  return db.transaction(async (tx) => {
    const records = Array.from(await tx.execute(sql`
      SELECT * FROM change_records
      WHERE id = ${input.recordId}
        AND workspace_id = ${input.workspaceId}
      FOR UPDATE
    `)) as Array<Record<string, unknown>>;
    const rawRecord = records[0];
    if (!rawRecord) throw new Error("Acceptance Record is missing or outside this workspace");
    const record = mapChangeRecordRow(rawRecord);
    const outcome = input.outcome;

    // A retry must return the immutable original event even if a later outcome
    // changed the Record summary (for example, a later revert). The event key
    // is derived from the immutable external reference, not its current state.
    const existing = (await tx.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, input.recordId),
      eq(changeRecordEvents.eventKey, eventKey),
    )).limit(1))[0];
    if (existing) {
      return { event: existing as ChangeRecordEventRow, inserted: false };
    }

    if (outcome.kind === "merged") {
      if (record.prNumber !== outcome.prNumber || !record.headShas.includes(outcome.headSha)) {
        throw new Error("Merge outcome does not match this Acceptance Record PR and exact head");
      }
      if (record.mergedSha != null && record.mergedSha !== outcome.mergeSha) {
        throw new Error("Acceptance Record already has a different merge SHA");
      }
      if (record.state === "reverted") {
        throw new Error("A reverted Acceptance Record cannot record another merge outcome");
      }
    } else if (outcome.kind === "deployed" || outcome.kind === "incident") {
      if (record.mergedSha == null || record.mergedSha !== outcome.revisionSha) {
        throw new Error("Post-merge outcome does not reference this Acceptance Record merge SHA");
      }
    } else if (record.mergedSha == null || record.mergedSha !== outcome.revertedSha) {
      throw new Error("Revert outcome does not reference this Acceptance Record merge SHA");
    }

    const inserted = Array.from(await tx.execute(sql`
      INSERT INTO change_record_events (
        id, record_id, event_key, stage, at, actor, payload_ref
      ) VALUES (
        ${changeRecordEventId({ recordId: input.recordId, eventKey })},
        ${input.recordId}, ${eventKey}, 'post_merge_outcome', ${at},
        ${input.recordedBy}, ${JSON.stringify(outcomePayload(record, outcome))}::jsonb
      )
      ON CONFLICT (record_id, event_key) DO NOTHING
      RETURNING *
    `)) as Array<Record<string, unknown>>;

    const rawEvent = inserted[0] ?? (await tx.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, input.recordId),
      eq(changeRecordEvents.eventKey, eventKey),
    )).limit(1))[0];
    if (!rawEvent) throw new Error("Acceptance Record post-merge outcome was not recorded");

    if (inserted[0] && outcome.kind === "merged") {
      await tx.execute(sql`
        UPDATE change_records
        SET merged_sha = ${outcome.mergeSha}, state = 'merged', updated_at = now()
        WHERE id = ${input.recordId}
      `);
    }
    if (inserted[0] && outcome.kind === "reverted") {
      await tx.execute(sql`
        UPDATE change_records
        SET state = 'reverted', updated_at = now()
        WHERE id = ${input.recordId}
      `);
    }

    return {
      event: mapChangeRecordEventRow(rawEvent as Record<string, unknown>),
      inserted: Boolean(inserted[0]),
    };
  });
}

export type ChangeRecordTimeline = {
  record: ChangeRecordRow;
  events: ChangeRecordEventRow[];
};

export type ListChangeRecordsInput = {
  workspaceId: string;
  repo?: string | null;
  limit?: number;
};

/** List record headers for the workspace index without loading timelines. */
export async function listChangeRecords(
  input: ListChangeRecordsInput
): Promise<ChangeRecordRow[]> {
  const predicates = [eq(changeRecords.workspaceId, input.workspaceId)];
  const repo = input.repo?.trim();
  if (repo) predicates.push(eq(changeRecords.repo, repo));

  return db
    .select()
    .from(changeRecords)
    .where(and(...predicates))
    .orderBy(desc(changeRecords.updatedAt), desc(changeRecords.createdAt))
    .limit(Math.min(Math.max(Math.trunc(input.limit ?? 100), 1), 200));
}

export async function readChangeRecordTimelineByPr(input: {
  workspaceId: string;
  repo: string;
  prNumber: number;
}): Promise<ChangeRecordTimeline | null> {
  const records = await db
    .select()
    .from(changeRecords)
    .where(
      and(
        eq(changeRecords.workspaceId, input.workspaceId),
        eq(changeRecords.repo, input.repo),
        eq(changeRecords.prNumber, input.prNumber)
      )
    )
    .limit(1);
  const record = records[0];
  if (!record) return null;

  const events = await db
    .select()
    .from(changeRecordEvents)
    .where(eq(changeRecordEvents.recordId, record.id))
    .orderBy(asc(changeRecordEvents.at), asc(changeRecordEvents.createdAt));

  return { record, events };
}
export async function readChangeRecordTimeline(input: {
  workspaceId: string;
  recordId: string;
}): Promise<ChangeRecordTimeline | null> {
  const records = await db
    .select()
    .from(changeRecords)
    .where(
      and(
        eq(changeRecords.workspaceId, input.workspaceId),
        eq(changeRecords.id, input.recordId)
      )
    )
    .limit(1);
  const record = records[0];
  if (!record) return null;

  const events = await db
    .select()
    .from(changeRecordEvents)
    .where(eq(changeRecordEvents.recordId, input.recordId))
    .orderBy(asc(changeRecordEvents.at), asc(changeRecordEvents.createdAt));

  return { record, events };
}

export type AcceptanceContractStatus = "draft" | "confirmed";

export type CreateDraftAcceptanceRecordInput = {
  workspaceId: string;
  repo: string;
  originChannel: string;
  sourceReferences?: Record<string, unknown>[];
  contract: Record<string, unknown>;
  createdBy: string;
  /** Reusing a work key makes draft creation safe to retry. */
  workKey?: string;
};

export type AcceptanceRecordDraft = {
  record: ChangeRecordRow;
  contract: AcceptanceContractRow;
};

export type CreateDraftAcceptanceRecordFromIntakeInput = {
  workspaceId: string;
  intakeId: string;
  repo: string;
  contract: Record<string, unknown>;
  createdBy: string;
};

export type AcceptanceRecordDraftFromIntake = AcceptanceRecordDraft & {
  intake: AcceptanceIntakeRow;
  /** True only when this request made the first durable Intake → Record link. */
  created: boolean;
};

export class AcceptanceIntakeDraftError extends Error {
  constructor(
    readonly code: "not_found" | "conflict",
    message: string
  ) {
    super(message);
    this.name = "AcceptanceIntakeDraftError";
  }
}

export type RecordAcceptanceInboundIntakeInput = {
  workspaceId: string;
  originChannel: string;
  conversationKey: string;
  sourceReferences?: Record<string, unknown>[];
  sourceKey: string;
  text: string;
  metadata?: Record<string, unknown>;
};

/**
 * Persists one source-channel message before repository selection. It cannot
 * draft/confirm a Contract or authorize external implementation. A repeated
 * source key is safe only when it is the exact same message; a collision
 * fails closed instead of silently changing the Intake history.
 */
export async function recordAcceptanceInboundIntake(
  input: RecordAcceptanceInboundIntakeInput
): Promise<{
  intake: AcceptanceIntakeRow;
  message: AcceptanceIntakeMessageRow;
  inserted: boolean;
}> {
  const originChannel = input.originChannel.trim().toLowerCase();
  const conversationKey = input.conversationKey.trim();
  const sourceKey = input.sourceKey.trim();
  const text = input.text.trim();
  if (!originChannel || !conversationKey || !sourceKey || !text) {
    throw new Error(
      "Acceptance Intake requires channel, conversation, source key, and message"
    );
  }
  const intakeId = acceptanceIntakeId({
    workspaceId: input.workspaceId,
    originChannel,
    conversationKey,
  });
  const messageId = acceptanceIntakeMessageId({ intakeId, sourceKey });
  const sourceReferences = normalizeSourceReferences(input.sourceReferences);

  return db.transaction(async (tx) => {
    const intakes = await tx
      .insert(acceptanceIntakes)
      .values({
        id: intakeId,
        workspaceId: input.workspaceId,
        originChannel,
        conversationKey,
        sourceReferences,
      })
      .onConflictDoUpdate({
        target: [
          acceptanceIntakes.workspaceId,
          acceptanceIntakes.originChannel,
          acceptanceIntakes.conversationKey,
        ],
        set: { updatedAt: new Date() },
      })
      .returning();
    const intake = intakes[0]!;
    const insertedRows = await tx
      .insert(acceptanceIntakeMessages)
      .values({
        id: messageId,
        intakeId,
        sourceKey,
        direction: "inbound",
        text,
        metadata: input.metadata ?? {},
      })
      .onConflictDoNothing()
      .returning();
    const inserted = insertedRows.length === 1;
    const message =
      insertedRows[0] ??
      (await tx
        .select()
        .from(acceptanceIntakeMessages)
        .where(eq(acceptanceIntakeMessages.id, messageId))
        .limit(1))[0]!;
    if (!inserted && (message.direction !== "inbound" || message.text !== text)) {
      throw new Error("Acceptance Intake source key is already bound to different content");
    }
    return { intake, message, inserted };
  });
}

export type AcceptanceContractValidation =
  | { ok: true }
  | { ok: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasNamedText(item: unknown): item is Record<string, unknown> {
  return (
    isRecord(item) &&
    isNonBlankString(item["id"]) &&
    isNonBlankString(item["text"])
  );
}

function isAcceptanceCriterion(item: unknown): boolean {
  return hasNamedText(item) && typeof item["userVisible"] === "boolean";
}

/**
 * The durable acceptance shape is intentionally compact, but not arbitrary:
 * a draft must preserve the user's original request, the normalized scope,
 * machine-reviewable criteria, explicit boundaries, and its question state.
 * Empty boundary arrays are valid when the intake explicitly established none;
 * a missing field is not equivalent to an established empty value.
 */
export function validateAcceptanceContract(
  contract: Record<string, unknown>
): AcceptanceContractValidation {
  const errors: string[] = [];
  if (!isNonBlankString(contract["originalRequest"])) errors.push("originalRequest");
  if (!Array.isArray(contract["normalizedRequirements"])) {
    errors.push("normalizedRequirements");
  }
  const criteria = contract["acceptanceCriteria"];
  if (!Array.isArray(criteria) || criteria.length === 0 || !criteria.every(isAcceptanceCriterion)) {
    errors.push("acceptanceCriteria");
  }
  for (const field of ["nonGoals", "risks", "stops", "unresolvedQuestions"] as const) {
    if (!Array.isArray(contract[field])) errors.push(field);
  }
  if (!isRecord(contract["environment"])) errors.push("environment");
  const questions = contract["unresolvedQuestions"];
  if (Array.isArray(questions) && !questions.every(hasNamedText)) {
    errors.push("unresolvedQuestions");
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function assertValidAcceptanceContract(contract: Record<string, unknown>): void {
  const validation = validateAcceptanceContract(contract);
  if (!validation.ok) {
    throw new Error(
      `Acceptance Contract is incomplete: ${validation.errors.join(", ")}`
    );
  }
}

function normalizedWorkKey(value: string | undefined): string {
  const candidate = value?.trim();
  return candidate || randomUUID();
}

function normalizeSourceReferences(
  sourceReferences: Record<string, unknown>[] | undefined
): Record<string, unknown>[] {
  return Array.isArray(sourceReferences) ? sourceReferences : [];
}

async function appendContractEventInTransaction(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: {
    recordId: string;
    eventKey: string;
    stage: string;
    actor: string;
    payloadRef: Record<string, unknown>;
  }
): Promise<void> {
  const id = changeRecordEventId({
    recordId: input.recordId,
    eventKey: input.eventKey,
  });
  await tx.execute(sql`
    INSERT INTO change_record_events (
      id, record_id, event_key, stage, actor, payload_ref
    ) VALUES (
      ${id}, ${input.recordId}, ${input.eventKey}, ${input.stage},
      ${input.actor}, ${JSON.stringify(input.payloadRef)}::jsonb
    )
    ON CONFLICT (record_id, event_key) DO NOTHING
  `);
}

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function createDraftAcceptanceRecordInTransaction(
  tx: DbTransaction,
  input: CreateDraftAcceptanceRecordInput,
  workKey: string,
  sourceReferences: Record<string, unknown>[]
): Promise<AcceptanceRecordDraft> {
  const recordId = changeRecordId({
    workspaceId: input.workspaceId,
    repo: input.repo,
    workKey,
  });
  const contractId = acceptanceContractId({ recordId, version: 1 });
  const records = Array.from(
    await tx.execute(sql`
      INSERT INTO change_records (
        id, workspace_id, repo, work_key, origin_channel, source_references
      ) VALUES (
        ${recordId}, ${input.workspaceId}, ${input.repo}, ${workKey},
        ${input.originChannel}, ${JSON.stringify(sourceReferences)}::jsonb
      )
      ON CONFLICT (workspace_id, repo, work_key) WHERE work_key IS NOT NULL
      DO UPDATE SET updated_at = now()
      RETURNING *
    `)
  ) as Array<Record<string, unknown>>;
  const record = mapChangeRecordRow(records[0]!);

  const existing = await tx
    .select()
    .from(acceptanceContracts)
    .where(eq(acceptanceContracts.recordId, record.id))
    .orderBy(desc(acceptanceContracts.version))
    .limit(1);
  if (existing[0]) {
    return { record, contract: existing[0] };
  }

  const contracts = await tx
    .insert(acceptanceContracts)
    .values({
      id: contractId,
      recordId: record.id,
      version: 1,
      status: "draft",
      contract: input.contract,
      createdBy: input.createdBy,
    })
    .returning();
  const contract = contracts[0]!;
  await appendContractEventInTransaction(tx, {
    recordId: record.id,
    eventKey: `acceptance-contract:draft:${contract.version}`,
    stage: "acceptance_contract",
    actor: input.createdBy,
    payloadRef: {
      kind: "acceptance_contract",
      contractId: contract.id,
      version: contract.version,
      status: contract.status,
    },
  });
  return { record, contract };
}

/**
 * Starts the trust workflow before an issue or PR exists. A retry with the
 * same workKey returns the original immutable draft instead of creating a
 * second change record or contract version.
 */
export async function createDraftAcceptanceRecord(
  input: CreateDraftAcceptanceRecordInput
): Promise<AcceptanceRecordDraft> {
  assertValidAcceptanceContract(input.contract);
  const workKey = normalizedWorkKey(input.workKey);
  const sourceReferences = normalizeSourceReferences(input.sourceReferences);
  const lockKey = `acceptance-record:${input.workspaceId}:${input.repo}:${workKey}`;

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    return createDraftAcceptanceRecordInTransaction(
      tx,
      input,
      workKey,
      sourceReferences
    );
  });
}

/**
 * Binds one canonical Intake to its first draft Acceptance Record. The Intake
 * is locked with its own advisory key and the resulting Record has a
 * deterministic work key, so an accidental replay cannot create a second
 * Record or silently replace its immutable Contract or provenance.
 */
export async function createDraftAcceptanceRecordFromIntake(
  input: CreateDraftAcceptanceRecordFromIntakeInput
): Promise<AcceptanceRecordDraftFromIntake> {
  assertValidAcceptanceContract(input.contract);
  const repo = input.repo.trim();
  if (!repo) throw new Error("Acceptance Record requires a repository");
  const workKey = `acceptance-intake:${input.intakeId}`;
  const intakeLockKey = `acceptance-intake:${input.workspaceId}:${input.intakeId}`;
  const recordLockKey = `acceptance-record:${input.workspaceId}:${repo}:${workKey}`;

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${intakeLockKey}))`);
    const intake = (
      await tx
        .select()
        .from(acceptanceIntakes)
        .where(
          and(
            eq(acceptanceIntakes.workspaceId, input.workspaceId),
            eq(acceptanceIntakes.id, input.intakeId)
          )
        )
        .limit(1)
    )[0];
    if (!intake) {
      throw new AcceptanceIntakeDraftError("not_found", "Acceptance Intake not found");
    }

    const assertExistingDraft = async (
      recordId: string
    ): Promise<AcceptanceRecordDraftFromIntake> => {
      const record = (
        await tx
          .select()
          .from(changeRecords)
          .where(
            and(
              eq(changeRecords.workspaceId, input.workspaceId),
              eq(changeRecords.id, recordId)
            )
          )
          .limit(1)
      )[0];
      const contract = record
        ? (
            await tx
              .select()
              .from(acceptanceContracts)
              .where(eq(acceptanceContracts.recordId, record.id))
              .orderBy(desc(acceptanceContracts.version))
              .limit(1)
          )[0]
        : undefined;
      if (
        !record ||
        !contract ||
        record.repo !== repo ||
        record.workKey !== workKey ||
        record.originChannel !== intake.originChannel ||
        !isDeepStrictEqual(record.sourceReferences, intake.sourceReferences) ||
        !isDeepStrictEqual(contract.contract, input.contract)
      ) {
        throw new AcceptanceIntakeDraftError(
          "conflict",
          "Acceptance Intake is already bound to a different draft"
        );
      }
      return { intake, record, contract, created: false };
    };

    if (intake.recordId) return assertExistingDraft(intake.recordId);

    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${recordLockKey}))`);
    const draft = await createDraftAcceptanceRecordInTransaction(
      tx,
      {
        workspaceId: input.workspaceId,
        repo,
        workKey,
        originChannel: intake.originChannel,
        sourceReferences: intake.sourceReferences,
        contract: input.contract,
        createdBy: input.createdBy,
      },
      workKey,
      intake.sourceReferences
    );
    if (
      draft.record.originChannel !== intake.originChannel ||
      !isDeepStrictEqual(draft.record.sourceReferences, intake.sourceReferences) ||
      !isDeepStrictEqual(draft.contract.contract, input.contract)
    ) {
      throw new AcceptanceIntakeDraftError(
        "conflict",
        "Acceptance Intake work key is already bound to a different draft"
      );
    }
    const updated = await tx
      .update(acceptanceIntakes)
      .set({ recordId: draft.record.id, status: "drafted", updatedAt: new Date() })
      .where(
        and(
          eq(acceptanceIntakes.workspaceId, input.workspaceId),
          eq(acceptanceIntakes.id, input.intakeId),
          isNull(acceptanceIntakes.recordId)
        )
      )
      .returning();
    const linkedIntake = updated[0];
    if (!linkedIntake) {
      throw new AcceptanceIntakeDraftError(
        "conflict",
        "Acceptance Intake link changed during drafting"
      );
    }
    await appendContractEventInTransaction(tx, {
      recordId: draft.record.id,
      eventKey: `acceptance-intake:${intake.id}:drafted`,
      stage: "acceptance_intake",
      actor: input.createdBy,
      payloadRef: {
        kind: "acceptance_intake",
        intakeId: intake.id,
        originChannel: intake.originChannel,
        conversationKey: intake.conversationKey,
        sourceReferenceCount: intake.sourceReferences.length,
      },
    });
    return { intake: linkedIntake, ...draft, created: true };
  });
}

export type CreateDraftAcceptanceContractInput = {
  recordId: string;
  contract: Record<string, unknown>;
  createdBy: string;
};

/** Adds a new immutable draft version; confirmed versions are never edited. */
export async function createDraftAcceptanceContract(
  input: CreateDraftAcceptanceContractInput
): Promise<AcceptanceContractRow> {
  assertValidAcceptanceContract(input.contract);
  const lockKey = `acceptance-contract:${input.recordId}`;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const latest = await tx
      .select()
      .from(acceptanceContracts)
      .where(eq(acceptanceContracts.recordId, input.recordId))
      .orderBy(desc(acceptanceContracts.version))
      .limit(1);
    const version = (latest[0]?.version ?? 0) + 1;
    const rows = await tx
      .insert(acceptanceContracts)
      .values({
        id: acceptanceContractId({ recordId: input.recordId, version }),
        recordId: input.recordId,
        version,
        status: "draft",
        contract: input.contract,
        createdBy: input.createdBy,
      })
      .returning();
    const contract = rows[0]!;
    await appendContractEventInTransaction(tx, {
      recordId: input.recordId,
      eventKey: `acceptance-contract:draft:${contract.version}`,
      stage: "acceptance_contract",
      actor: input.createdBy,
      payloadRef: {
        kind: "acceptance_contract",
        contractId: contract.id,
        version: contract.version,
        status: contract.status,
      },
    });
    return contract;
  });
}

export async function readAcceptanceContracts(input: {
  workspaceId: string;
  recordId: string;
}): Promise<AcceptanceContractRow[] | null> {
  const records = await db
    .select({ id: changeRecords.id })
    .from(changeRecords)
    .where(
      and(
        eq(changeRecords.workspaceId, input.workspaceId),
        eq(changeRecords.id, input.recordId)
      )
    )
    .limit(1);
  if (!records[0]) return null;
  return db
    .select()
    .from(acceptanceContracts)
    .where(eq(acceptanceContracts.recordId, input.recordId))
    .orderBy(asc(acceptanceContracts.version));
}

const ACCEPTANCE_BUILDER_ROUTE_EVENT_KEY = "acceptance-builder-route:selected";
const ACCEPTANCE_BUILDER_ROUTE_PAYLOAD_VERSION = 1;
const ACCEPTANCE_BUILDER_ROUTE_SCOPE = "correction_delivery_only";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AcceptanceBuilderRouteAdapter =
  | "github_codex"
  | "github_claude"
  | "durable_github_fallback"
  | "durable_jace_fallback";

export type AcceptanceBuilderRouteStatus = "active" | "disabled";

/**
 * Public selection contains only the identifier of a server-registered route.
 * Builder configuration and task identity are never accepted from this input.
 */
export type AcceptanceBuilderRouteSelection = { routeId: string };

export type AcceptanceBuilderRouteSnapshot = {
  builder: {
    adapter: AcceptanceBuilderRouteAdapter;
    routeId: string;
  };
  protocol: "github_comment" | "durable_notice";
  capability: {
    availability: "unverified";
    activation: "github_mention" | "none";
    acknowledgement: "vendor_activity" | "human_ack";
    repairHead: "github_synchronize";
  };
  scopeBoundary: typeof ACCEPTANCE_BUILDER_ROUTE_SCOPE;
};

export type AcceptanceBuilderRouteSelectionResolution = {
  selection: AcceptanceBuilderRouteSelection;
  route: AcceptanceBuilderRouteRow;
  snapshot: AcceptanceBuilderRouteSnapshot;
  event: ChangeRecordEventRow;
};

export type RecordAcceptanceBuilderRouteSelectionInput = {
  workspaceId: string;
  recordId: string;
  selectedBy: string;
  routeId: string;
};

export type RegisterAcceptanceBuilderRouteInput = {
  id?: string;
  workspaceId: string;
  repo: string;
  adapter: AcceptanceBuilderRouteAdapter;
  status?: AcceptanceBuilderRouteStatus;
  configurationVersion: number;
  registeredBy: string;
};

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function isBuilderRouteActor(value: unknown, humanOnly = false): value is string {
  const prefix = humanOnly ? "user" : "(?:user|server)";
  return typeof value === "string"
    && value.length >= 6
    && value.length <= 256
    && new RegExp(`^${prefix}:[A-Za-z0-9][A-Za-z0-9._@+-]*$`).test(value);
}

function isBuilderRouteAdapter(value: unknown): value is AcceptanceBuilderRouteAdapter {
  return value === "github_codex" || value === "github_claude"
    || value === "durable_github_fallback" || value === "durable_jace_fallback";
}

export function validateAcceptanceBuilderRouteSelection(
  value: unknown
): value is AcceptanceBuilderRouteSelection {
  return isRecord(value) && hasExactKeys(value, ["routeId"]) && isUuid(value["routeId"]);
}

/** Returns a typed route only when it satisfies the closed variant schema. */
export function parseAcceptanceBuilderRouteSelection(
  value: unknown
): AcceptanceBuilderRouteSelection | null {
  return validateAcceptanceBuilderRouteSelection(value) ? value : null;
}

export type AcceptanceContextPackSnapshotStatus = "admitted" | "not_proven";

export type AcceptanceContextBaseIndexIdentity = {
  schemaVersion: 1;
  revisionSha256: string;
  backgroundOnly: true;
  pages: Array<{
    id: string;
    slug: string;
    commitSha: string;
    inputsHashSha256: string;
    stale: boolean;
  }>;
  gaps: string[];
};

/** v2 DB custody identity; distinct from the merged v1 compiler input. */
export type AcceptanceContextPackCustodyBaseIndexIdentity = {
  schemaVersion: 2;
  revisionSha256: string;
  backgroundOnly: true;
  pages: Array<{
    id: string;
    repositoryId: string;
    slug: string;
    commitSha: string;
    inputsHashSha256: string;
    pageBodySha256: string;
    stale: boolean;
  }>;
  gaps: string[];
};

export type AcceptanceContextOverlayManifestIdentity = {
  schemaVersion: 1;
  manifestSha256: string;
  baseSha: string;
  mergeBaseSha: string;
  headSha: string;
  files: Array<{
    path: string;
    status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed";
    blobSha: string | null;
    previousPath: string | null;
  }>;
};

/** v2 custody identity adds immutable patch and normalized head coordinates. */
export type AcceptanceContextPackCustodyOverlayManifestIdentity = {
  schemaVersion: 2;
  manifestSha256: string;
  baseSha: string;
  mergeBaseSha: string;
  headSha: string;
  files: Array<{
    path: string;
    status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed";
    blobSha: string | null;
    previousPath: string | null;
    /** Null only when the compare service proves no text patch is available. */
    patchSha256: string | null;
    patchByteCount: number | null;
    /** Normalized exact-head line coordinates represented by the admitted patch. */
    headRanges: Array<{ startLine: number; endLine: number; coordinateSha256: string }>;
  }>;
};

export type AcceptanceContextInclusionExclusionProvenance = {
  schemaVersion: 1;
  included: Array<{ path: string; source: "base_index" | "overlay"; reason: string }>;
  excluded: Array<{ path: string | null; source: "base_index" | "overlay"; reason: string }>;
};

export type AcceptanceContextPackSnapshotInput = {
  workspaceId: string;
  recordId: string;
  reviewJobId: string;
  acceptanceContractId: string;
  acceptanceContractVersion: number;
  acceptanceContractSha256: string;
  repo: string;
  prNumber: number;
  expectedHeadSha: string;
  baseSha: string | null;
  mergeBaseSha: string | null;
  headTreeSha: string | null;
  packetIds: string[];
  packetSetSha256: string;
  correctionPacketPayloadSetSha256: string;
  compilerVersion: string;
  baseIndex: AcceptanceContextPackCustodyBaseIndexIdentity | null;
  overlay: AcceptanceContextPackCustodyOverlayManifestIdentity | null;
  provenance: AcceptanceContextInclusionExclusionProvenance;
  status: AcceptanceContextPackSnapshotStatus;
  reason: string | null;
};

const EXACT_SHA1 = /^[a-f0-9]{40}$/i;
const EXACT_SHA256 = /^[a-f0-9]{64}$/i;
const CORRECTION_PACKET_ID = /^correction-[a-f0-9]{48}$/i;
const SAFE_REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SECRET_LIKE = /(?:\b(?:bearer|token|authorization)\s+|\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+))/i;
const MAX_CONTEXT_CUSTODY_COMPARE_FILES = 299;
const MAX_CONTEXT_CUSTODY_HEAD_RANGES = 128;
const MAX_CONTEXT_CUSTODY_HEAD_LINE = 1_000_000;
const MAX_CONTEXT_CUSTODY_PATCH_BYTES = 2 * 1024 * 1024;
const MAX_CONTEXT_CUSTODY_WIKI_PAGE_BYTES = 512 * 1024;
const MAX_CONTEXT_CUSTODY_WIKI_TOTAL_BYTES = 4 * 1024 * 1024;

function canonicalJson(value: unknown): string | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : null;
  if (Array.isArray(value)) {
    const items = value.map(canonicalJson);
    return items.some((item) => item === null) ? null : `[${items.join(",")}]`;
  }
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const entries: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const nested = canonicalJson(value[key]);
    if (nested === null) return null;
    entries.push(`${JSON.stringify(key)}:${nested}`);
  }
  return `{${entries.join(",")}}`;
}

function positiveBoundedInteger(value: unknown, max: number): value is number {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= max;
}

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Stable digest of an already-derived, sorted correction packet ID set. */
export function acceptanceContextPacketSetSha256(input: { packetIds: readonly string[] }): string {
  return canonicalSha256({ kind: "acceptance_context_packet_set", version: 1, packetIds: input.packetIds });
}

/**
 * Canonical digest of the complete persisted confirmed Contract. Criterion
 * IDs alone are insufficient: text, user visibility, scope, and unanswered
 * questions all affect what the compiler is allowed to claim.
 */
export function acceptanceContractSha256(input: {
  acceptanceContractId: string;
  acceptanceContractVersion: number;
  contract: Record<string, unknown>;
}): string {
  const canonical = canonicalJson({
    kind: "acceptance_contract_snapshot",
    version: 1,
    acceptanceContractId: input.acceptanceContractId,
    acceptanceContractVersion: input.acceptanceContractVersion,
    contract: input.contract,
  });
  if (canonical === null) throw new Error("Acceptance Contract snapshot is not canonical JSON");
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Canonical digest of every full R8.1 correction packet payload. IDs alone
 * are insufficient because the packet text and exact-head evidence matter.
 */
export function acceptanceCorrectionPacketPayloadSetSha256(input: {
  packets: readonly Record<string, unknown>[];
}): string {
  if (input.packets.length === 0 || input.packets.length > 100
    || !input.packets.every(validateReviewJobCorrectionPacketPayload)) {
    throw new Error("Correction packet payload set requires validated R8.1 packets");
  }
  const packets = [...input.packets].sort((left, right) =>
    String(left["packetId"]).localeCompare(String(right["packetId"]))
  );
  if (new Set(packets.map((packet) => packet["packetId"])).size !== packets.length) {
    throw new Error("Correction packet payload set requires unique packet IDs");
  }
  const canonical = canonicalJson({
    kind: "acceptance_correction_packet_payload_set",
    version: 1,
    packets,
  });
  if (canonical === null) throw new Error("Correction packet payload set is not canonical JSON");
  return createHash("sha256").update(canonical).digest("hex");
}

/** SHA-256 of the exact Wiki body stored by the server, never a caller claim. */
export function wikiPageBodySha256(bodyMd: string): string {
  return createHash("sha256").update(bodyMd, "utf8").digest("hex");
}

/** Stable digest of the page-level, background-only Wiki/index identity. */
export function acceptanceContextBaseIndexRevisionSha256(input: Omit<AcceptanceContextBaseIndexIdentity, "revisionSha256">): string {
  return canonicalSha256({
    kind: "acceptance_context_base_index", version: 1,
    backgroundOnly: input.backgroundOnly, pages: input.pages, gaps: input.gaps,
  });
}

/** Stable digest of the v2 Wiki identity resolved from `wiki_pages`. */
export function acceptanceContextPackCustodyBaseIndexRevisionSha256(
  input: Omit<AcceptanceContextPackCustodyBaseIndexIdentity, "revisionSha256">
): string {
  const canonical = canonicalJson({
    kind: "acceptance_context_pack_custody_base_index", version: 2,
    backgroundOnly: input.backgroundOnly, pages: input.pages, gaps: input.gaps,
  });
  if (canonical === null) throw new Error("Context Pack custody base index is not canonical JSON");
  return createHash("sha256").update(canonical).digest("hex");
}

/** Stable digest of the server-resolved GitHub compare manifest. */
export function acceptanceContextOverlayManifestSha256(input: Omit<AcceptanceContextOverlayManifestIdentity, "manifestSha256">): string {
  return canonicalSha256({
    kind: "acceptance_context_overlay_manifest", version: 1,
    baseSha: input.baseSha, mergeBaseSha: input.mergeBaseSha, headSha: input.headSha, files: input.files,
  });
}

/** Stable v2 exact-head patch/range custody digest. */
export function acceptanceContextPackCustodyOverlayManifestSha256(
  input: Omit<AcceptanceContextPackCustodyOverlayManifestIdentity, "manifestSha256">
): string {
  const canonical = canonicalJson({
    kind: "acceptance_context_pack_custody_overlay_manifest", version: 2,
    baseSha: input.baseSha, mergeBaseSha: input.mergeBaseSha, headSha: input.headSha, files: input.files,
  });
  if (canonical === null) throw new Error("Context Pack custody overlay manifest is not canonical JSON");
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Hashes patch-owned coordinates, not selected source bytes. Compiler excerpt
 * `rangeSha256` remains the byte hash of the actual selected text.
 */
export function acceptanceContextOverlayHeadRangeCoordinateSha256(input: {
  path: string;
  patchSha256: string;
  startLine: number;
  endLine: number;
}): string {
  const canonical = canonicalJson({ kind: "acceptance_context_overlay_head_range", version: 1, ...input });
  if (canonical === null) throw new Error("Context Pack overlay head range is not canonical JSON");
  return createHash("sha256").update(canonical).digest("hex");
}

/** Canonical identity shared by the R8.1 packet builder and R8.2 packet-set custody. */
export function reviewJobCorrectionPacketId(input: {
  jobId: string;
  criterionId: string;
  headSha: string;
  recordId: string;
  acceptanceContractId: string;
  acceptanceContractVersion: number;
}): string {
  return `correction-${canonicalSha256({
    jobId: input.jobId,
    criterionId: input.criterionId,
    headSha: input.headSha,
    recordId: input.recordId,
    acceptanceContractId: input.acceptanceContractId,
    acceptanceContractVersion: input.acceptanceContractVersion,
  }).slice(0, 48)}`;
}

function safeSnapshotText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
    && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value) && !SECRET_LIKE.test(value);
}

function safeRepoPath(value: unknown): value is string {
  return safeSnapshotText(value, 512)
    && !value.startsWith("/")
    && !value.includes("\\")
    && !value.split("/").some((segment) => !segment || segment === "." || segment === "..");
}

function safeRepo(value: unknown): value is string {
  return typeof value === "string" && SAFE_REPO.test(value)
    && value.split("/").every((segment) => segment !== "." && segment !== "..");
}

function uniqueStrings(values: unknown, predicate: (value: unknown) => boolean, max: number): values is string[] {
  return Array.isArray(values) && values.length > 0 && values.length <= max
    && values.every(predicate) && new Set(values).size === values.length;
}

function isCustodyBaseIndexIdentity(value: unknown): value is AcceptanceContextPackCustodyBaseIndexIdentity {
  if (!isRecord(value)
    || !hasExactKeys(value, ["schemaVersion", "revisionSha256", "backgroundOnly", "pages", "gaps"])
    || value["schemaVersion"] !== 2
    || value["backgroundOnly"] !== true
    || typeof value["revisionSha256"] !== "string" || !EXACT_SHA256.test(value["revisionSha256"])
    || !Array.isArray(value["pages"]) || value["pages"].length > 100
    || !Array.isArray(value["gaps"]) || value["gaps"].length > 100
    || !value["gaps"].every((gap) => safeSnapshotText(gap, 1_024))
    || new Set(value["gaps"]).size !== value["gaps"].length
  ) return false;
  const pages = value["pages"];
  if (!pages.every((page) => isRecord(page)
    && hasExactKeys(page, ["id", "repositoryId", "slug", "commitSha", "inputsHashSha256", "pageBodySha256", "stale"])
    && isUuid(page["id"])
    && isUuid(page["repositoryId"])
    && safeRepoPath(page["slug"])
    && typeof page["commitSha"] === "string" && EXACT_SHA1.test(page["commitSha"])
    && typeof page["inputsHashSha256"] === "string" && EXACT_SHA256.test(page["inputsHashSha256"])
    && typeof page["pageBodySha256"] === "string" && EXACT_SHA256.test(page["pageBodySha256"])
    && typeof page["stale"] === "boolean"
  )) return false;
  if (pages.length === 0 && value["gaps"].length === 0) return false;
  if (!pages.every((page, index) => index === 0
    || `${pages[index - 1]!["slug"]}\u0000${pages[index - 1]!["id"]}`
      < `${page["slug"]}\u0000${page["id"]}`)) return false;
  if (!(value["gaps"] as string[]).every((gap, index, gaps) => index === 0 || gaps[index - 1]! < gap)) return false;
  return value["revisionSha256"] === acceptanceContextPackCustodyBaseIndexRevisionSha256({
    schemaVersion: 2, backgroundOnly: true, pages: pages as AcceptanceContextPackCustodyBaseIndexIdentity["pages"], gaps: value["gaps"] as string[],
  });
}

function isCustodyOverlayIdentity(value: unknown): value is AcceptanceContextPackCustodyOverlayManifestIdentity {
  if (!isRecord(value)
    || !hasExactKeys(value, ["schemaVersion", "manifestSha256", "baseSha", "mergeBaseSha", "headSha", "files"])
    || value["schemaVersion"] !== 2
    || typeof value["manifestSha256"] !== "string" || !EXACT_SHA256.test(value["manifestSha256"])
    || typeof value["baseSha"] !== "string" || !EXACT_SHA1.test(value["baseSha"])
    || typeof value["mergeBaseSha"] !== "string" || !EXACT_SHA1.test(value["mergeBaseSha"])
    || typeof value["headSha"] !== "string" || !EXACT_SHA1.test(value["headSha"])
    || !Array.isArray(value["files"]) || value["files"].length === 0
    || value["files"].length > MAX_CONTEXT_CUSTODY_COMPARE_FILES
  ) return false;
  const files = value["files"];
  if (!files.every((file) => isRecord(file)
    && hasExactKeys(file, ["path", "status", "blobSha", "previousPath", "patchSha256", "patchByteCount", "headRanges"])
    && safeRepoPath(file["path"])
    && (file["status"] === "added" || file["status"] === "modified" || file["status"] === "removed"
      || file["status"] === "renamed" || file["status"] === "copied" || file["status"] === "changed")
    && (file["status"] === "removed"
      ? (file["blobSha"] === null || (typeof file["blobSha"] === "string" && EXACT_SHA1.test(file["blobSha"])))
      : typeof file["blobSha"] === "string" && EXACT_SHA1.test(file["blobSha"]))
    && (file["status"] === "renamed"
      ? safeRepoPath(file["previousPath"]) && file["previousPath"] !== file["path"]
      : file["previousPath"] === null)
    && ((file["patchSha256"] === null && file["patchByteCount"] === null && Array.isArray(file["headRanges"])
      && file["headRanges"].length === 0)
      || (typeof file["patchSha256"] === "string" && EXACT_SHA256.test(file["patchSha256"])
        && positiveBoundedInteger(file["patchByteCount"], MAX_CONTEXT_CUSTODY_PATCH_BYTES)
        && Array.isArray(file["headRanges"]) && file["headRanges"].length > 0
        && file["headRanges"].length <= MAX_CONTEXT_CUSTODY_HEAD_RANGES
        && file["headRanges"].every((range) => isRecord(range)
          && hasExactKeys(range, ["startLine", "endLine", "coordinateSha256"])
          && positiveBoundedInteger(range["startLine"], MAX_CONTEXT_CUSTODY_HEAD_LINE)
          && positiveBoundedInteger(range["endLine"], MAX_CONTEXT_CUSTODY_HEAD_LINE)
          && (range["startLine"] as number) <= (range["endLine"] as number)
          && typeof range["coordinateSha256"] === "string" && EXACT_SHA256.test(range["coordinateSha256"])
          && range["coordinateSha256"] === acceptanceContextOverlayHeadRangeCoordinateSha256({
            path: file["path"] as string,
            patchSha256: file["patchSha256"] as string,
            startLine: range["startLine"] as number,
            endLine: range["endLine"] as number,
          }))))
  )) return false;
  if (!files.every((file) => {
    const ranges = file["headRanges"] as Array<Record<string, unknown>>;
    return ranges.every((range, index) => index === 0
      || (ranges[index - 1]!["endLine"] as number) < (range["startLine"] as number));
  })) return false;
  if (!files.every((file, index) => index === 0 || files[index - 1]!["path"] < file["path"])) return false;
  return value["manifestSha256"] === acceptanceContextPackCustodyOverlayManifestSha256({
    schemaVersion: 2, baseSha: value["baseSha"], mergeBaseSha: value["mergeBaseSha"], headSha: value["headSha"],
    files: files as AcceptanceContextPackCustodyOverlayManifestIdentity["files"],
  });
}

function isProvenance(value: unknown): value is AcceptanceContextInclusionExclusionProvenance {
  if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "included", "excluded"])
    || value["schemaVersion"] !== 1 || !Array.isArray(value["included"]) || !Array.isArray(value["excluded"])
    || value["included"].length > 1_000 || value["excluded"].length > 1_000
  ) return false;
  const included = value["included"];
  const excluded = value["excluded"];
  return included.every((item) => isRecord(item)
    && hasExactKeys(item, ["path", "source", "reason"])
    && safeRepoPath(item["path"])
    && (item["source"] === "base_index" || item["source"] === "overlay")
    && safeSnapshotText(item["reason"], 1_024))
    && excluded.every((item) => isRecord(item)
      && hasExactKeys(item, ["path", "source", "reason"])
      && (item["path"] === null || safeRepoPath(item["path"]))
      && (item["source"] === "base_index" || item["source"] === "overlay")
      && safeSnapshotText(item["reason"], 1_024));
}

function hasCompleteAdmittedSourceProvenance(input: {
  baseIndex: AcceptanceContextPackCustodyBaseIndexIdentity;
  overlay: AcceptanceContextPackCustodyOverlayManifestIdentity;
  provenance: AcceptanceContextInclusionExclusionProvenance;
}): boolean {
  const expected = new Map<string, number>();
  for (const page of input.baseIndex.pages) expected.set(`base_index\u0000${page.slug}`, 0);
  for (const file of input.overlay.files) expected.set(`overlay\u0000${file.path}`, 0);
  const baseGapReasons: string[] = [];
  for (const item of [...input.provenance.included, ...input.provenance.excluded]) {
    if (item.path === null) {
      if (item.source !== "base_index") return false;
      baseGapReasons.push(item.reason);
      continue;
    }
    const key = `${item.source}\u0000${item.path}`;
    const count = expected.get(key);
    if (count === undefined || count !== 0) return false;
    expected.set(key, 1);
  }
  return [...expected.values()].every((count) => count === 1)
    && isDeepStrictEqual([...baseGapReasons].sort(), [...input.baseIndex.gaps].sort());
}

function hasFailClosedUnavailableProvenance(
  provenance: AcceptanceContextInclusionExclusionProvenance,
  reason: string
): boolean {
  return provenance.included.length === 0
    && provenance.excluded.length > 0
    && provenance.excluded.every((item) => item.path === null)
    && provenance.excluded.some((item) => item.reason === reason);
}

function isCorrectionApiRequest(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ["method", "path", "expectedStatus"])
    && value["method"] === "GET"
    && safeSnapshotText(value["path"], 2_048)
    && Number.isInteger(value["expectedStatus"])
    && (value["expectedStatus"] as number) >= 100
    && (value["expectedStatus"] as number) <= 599;
}

function isCorrectionDataRequest(value: unknown): boolean {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      "method", "path", "expectedStatus", "digestAlgorithm", "digestKeyId", "digestContext", "expectedJson",
    ])
    || value["method"] !== "GET"
    || !safeSnapshotText(value["path"], 2_048)
    || !Number.isInteger(value["expectedStatus"])
    || (value["expectedStatus"] as number) < 100
    || (value["expectedStatus"] as number) > 599
    || value["digestAlgorithm"] !== "hmac-sha256-v1"
    || !safeSnapshotText(value["digestKeyId"], 64)
    || typeof value["digestContext"] !== "string"
    || !EXACT_SHA256.test(value["digestContext"])
    || !Array.isArray(value["expectedJson"])
    || value["expectedJson"].length === 0
    || value["expectedJson"].length > 12
  ) return false;
  return value["expectedJson"].every((assertion) => isRecord(assertion)
    && hasExactKeys(assertion, ["pointer", "equalsType", "equalsHmacSha256"])
    && safeSnapshotText(assertion["pointer"], 1_024)
    && (assertion["equalsType"] === "null" || assertion["equalsType"] === "boolean"
      || assertion["equalsType"] === "number" || assertion["equalsType"] === "string")
    && typeof assertion["equalsHmacSha256"] === "string"
    && EXACT_SHA256.test(assertion["equalsHmacSha256"]));
}

function isCorrectionReproduction(value: unknown, modality: string): boolean {
  if (!isRecord(value) || value["modality"] !== modality) return false;
  if (modality === "api") {
    return hasExactKeys(value, ["modality", "request"]) && isCorrectionApiRequest(value["request"]);
  }
  if (modality === "data") {
    return hasExactKeys(value, ["modality", "request"]) && isCorrectionDataRequest(value["request"]);
  }
  if (modality === "job") {
    if (!hasExactKeys(value, ["modality", "request"]) || !isRecord(value["request"])
      || !hasExactKeys(value["request"], ["trigger", "readback"]) || !isRecord(value["request"]["trigger"])
      || !hasExactKeys(value["request"]["trigger"], ["method", "path", "expectedStatus"])
      || value["request"]["trigger"]["method"] !== "POST"
      || !safeSnapshotText(value["request"]["trigger"]["path"], 2_048)
      || !Number.isInteger(value["request"]["trigger"]["expectedStatus"])
      || (value["request"]["trigger"]["expectedStatus"] as number) < 100
      || (value["request"]["trigger"]["expectedStatus"] as number) > 599
    ) return false;
    return isCorrectionDataRequest(value["request"]["readback"]);
  }
  if (modality !== "ui" || !hasExactKeys(value, ["modality", "steps"])
    || !Array.isArray(value["steps"]) || value["steps"].length === 0 || value["steps"].length > 12) return false;
  return value["steps"].every((step) => {
    if (!isRecord(step) || typeof step["action"] !== "string") return false;
    switch (step["action"]) {
      case "open": return hasExactKeys(step, ["action", "path"]) && safeSnapshotText(step["path"], 2_048);
      case "click": return hasExactKeys(step, ["action", "selector"]) && safeSnapshotText(step["selector"], 2_048);
      case "fill": return hasExactKeys(step, ["action", "selector", "value"])
        && safeSnapshotText(step["selector"], 2_048) && step["value"] === "[REDACTED_FILL]";
      case "press": return hasExactKeys(step, ["action", "key"]) && safeSnapshotText(step["key"], 128);
      case "expect_text": return hasExactKeys(step, ["action", "text"]) && safeSnapshotText(step["text"], 2_048);
      case "screenshot": return hasExactKeys(step, ["action", "label"]) && safeSnapshotText(step["label"], 512);
      default: return false;
    }
  });
}

/** Closed structural and deterministic-identity check shared by R8.1 and R8.2 custody. */
export function validateReviewJobCorrectionPacketPayload(payload: unknown): payload is Record<string, unknown> {
  if (!isRecord(payload)
    || !hasExactKeys(payload, [
      "kind", "version", "packetId", "workspaceId", "repo", "prNumber", "headSha", "recordId", "jobId",
      "acceptanceContract", "criterion", "basis", "state", "expected", "observed", "affectedContext", "evidence",
      "scopeBoundary", "impact", "requiredCorrection", "reverification",
    ])
    || payload["kind"] !== "review_job_correction_packet"
    || payload["version"] !== 1
    || !safeSnapshotText(payload["workspaceId"], 512)
    || !safeRepo(payload["repo"])
    || !Number.isInteger(payload["prNumber"])
    || (payload["prNumber"] as number) <= 0
    || typeof payload["headSha"] !== "string"
    || !EXACT_SHA1.test(payload["headSha"])
    || !safeSnapshotText(payload["recordId"], 512)
    || !safeSnapshotText(payload["jobId"], 512)
    || !isRecord(payload["acceptanceContract"])
    || !hasExactKeys(payload["acceptanceContract"], ["id", "version"])
    || !safeSnapshotText(payload["acceptanceContract"]["id"], 512)
    || !Number.isInteger(payload["acceptanceContract"]["version"])
    || (payload["acceptanceContract"]["version"] as number) <= 0
    || !isRecord(payload["criterion"])
    || !hasExactKeys(payload["criterion"], ["id", "snapshot"])
    || !safeSnapshotText(payload["criterion"]["id"], 512)
    || !safeSnapshotText(payload["criterion"]["snapshot"], 2_000)
    || payload["basis"] !== "acceptance_contract"
    || (payload["state"] !== "failed" && payload["state"] !== "not_proven")
    || payload["expected"] !== payload["criterion"]["snapshot"]
    || !safeSnapshotText(payload["expected"], 2_000)
    || !safeSnapshotText(payload["observed"], 2_000)
    || !isRecord(payload["affectedContext"])
    || !hasExactKeys(payload["affectedContext"], ["modality", "environmentKind", "flow", "reproduction"])
    || (payload["affectedContext"]["modality"] !== "ui" && payload["affectedContext"]["modality"] !== "api"
      && payload["affectedContext"]["modality"] !== "data" && payload["affectedContext"]["modality"] !== "job")
    || (payload["affectedContext"]["environmentKind"] !== null
      && payload["affectedContext"]["environmentKind"] !== "isolated_preview")
    || !safeSnapshotText(payload["affectedContext"]["flow"], 2_000)
    || !isCorrectionReproduction(
      payload["affectedContext"]["reproduction"],
      payload["affectedContext"]["modality"] as string
    )
    || !isRecord(payload["evidence"])
    || !Object.keys(payload["evidence"]).every((key) =>
      key === "evidenceRef" || key === "artifactKey" || key === "executionId" || key === "previewBootId")
    || !hasOwn(payload["evidence"], "evidenceRef")
    || !hasOwn(payload["evidence"], "previewBootId")
    || !safeSnapshotText(payload["evidence"]["evidenceRef"], 2_000)
    || !safeSnapshotText(payload["evidence"]["previewBootId"], 512)
    || (hasOwn(payload["evidence"], "artifactKey") && !safeSnapshotText(payload["evidence"]["artifactKey"], 2_000))
    || (hasOwn(payload["evidence"], "executionId") && !safeSnapshotText(payload["evidence"]["executionId"], 512))
    || !safeSnapshotText(payload["scopeBoundary"], 2_000)
    || !safeSnapshotText(payload["impact"], 2_000)
    || !safeSnapshotText(payload["requiredCorrection"], 2_000)
    || !safeSnapshotText(payload["reverification"], 2_000)
  ) return false;
  const criterionId = payload["criterion"]["id"] as string;
  return payload["packetId"] === reviewJobCorrectionPacketId({
    jobId: payload["jobId"] as string,
    criterionId,
    headSha: payload["headSha"] as string,
    recordId: payload["recordId"] as string,
    acceptanceContractId: payload["acceptanceContract"]["id"] as string,
    acceptanceContractVersion: payload["acceptanceContract"]["version"] as number,
  });
}

function correctionPacketIdForSnapshotEvent(
  event: ChangeRecordEventRow,
  input: AcceptanceContextPackSnapshotInput,
  confirmedCriteria: ReadonlyMap<string, string>
): string | null {
  const payload = event.payloadRef;
  if (!validateReviewJobCorrectionPacketPayload(payload)
    || payload["workspaceId"] !== input.workspaceId
    || payload["repo"] !== input.repo
    || payload["prNumber"] !== input.prNumber
    || payload["headSha"] !== input.expectedHeadSha
    || payload["recordId"] !== input.recordId
    || payload["jobId"] !== input.reviewJobId
    || !isRecord(payload["acceptanceContract"])
    || payload["acceptanceContract"]["id"] !== input.acceptanceContractId
    || payload["acceptanceContract"]["version"] !== input.acceptanceContractVersion
    || !isRecord(payload["criterion"])
  ) return null;
  const criterionId = payload["criterion"]["id"] as string;
  if (confirmedCriteria.get(criterionId) !== payload["criterion"]["snapshot"]) return null;
  const packetId = payload["packetId"] as string;
  const eventKey = `review:correction:${input.reviewJobId}:${criterionId}`;
  return event.eventKey === eventKey && event.stage === "review" && event.actor === "reviewer-of-record"
    ? packetId
    : null;
}

function correctionPacketPayloadsForSnapshotEvents(
  events: readonly ChangeRecordEventRow[],
  input: AcceptanceContextPackSnapshotInput,
  confirmedCriteria: ReadonlyMap<string, string>
): { packetIds: string[]; packets: Record<string, unknown>[] } | null {
  const pairs = events.map((event) => {
    const packetId = correctionPacketIdForSnapshotEvent(event, input, confirmedCriteria);
    return packetId === null || !validateReviewJobCorrectionPacketPayload(event.payloadRef)
      ? null
      : { packetId, payload: event.payloadRef };
  });
  if (pairs.some((pair) => pair === null)) return null;
  const ordered = (pairs as Array<{ packetId: string; payload: Record<string, unknown> }>).sort((left, right) =>
    left.packetId.localeCompare(right.packetId)
  );
  if (new Set(ordered.map((pair) => pair.packetId)).size !== ordered.length) return null;
  return { packetIds: ordered.map((pair) => pair.packetId), packets: ordered.map((pair) => pair.payload) };
}

async function recheckWikiBaseIndex(
  tx: DbTransaction,
  input: Pick<AcceptanceContextPackSnapshotInput, "workspaceId" | "repo" | "baseIndex">
): Promise<void> {
  const baseIndex = input.baseIndex;
  if (!baseIndex || baseIndex.pages.length === 0) return;
  const repositoryIds = [...new Set(baseIndex.pages.map((page) => page.repositoryId))];
  if (repositoryIds.length !== 1) throw new Error("Context Pack Wiki pages span multiple repositories");
  const repository = (await tx.select().from(repositories).where(and(
    eq(repositories.id, repositoryIds[0]!),
    eq(repositories.workspaceId, input.workspaceId),
    eq(repositories.name, input.repo),
  )).limit(1))[0];
  if (!repository) throw new Error("Context Pack Wiki repository is missing or outside this workspace");
  const pageIds = baseIndex.pages.map((page) => page.id);
  const rows = await tx.select().from(wikiPages).where(and(
    eq(wikiPages.workspaceId, input.workspaceId),
    eq(wikiPages.repositoryId, repository.id),
    inArray(wikiPages.id, pageIds),
  ));
  if (rows.length !== pageIds.length) throw new Error("Context Pack Wiki page is missing or outside this repository");
  const persisted = new Map(rows.map((page) => [page.id, page]));
  let totalBodyBytes = 0;
  for (const page of baseIndex.pages) {
    const actual = persisted.get(page.id);
    const bodyBytes = actual ? Buffer.byteLength(actual.bodyMd, "utf8") : 0;
    totalBodyBytes += bodyBytes;
    if (!actual || bodyBytes === 0 || bodyBytes > MAX_CONTEXT_CUSTODY_WIKI_PAGE_BYTES
      || totalBodyBytes > MAX_CONTEXT_CUSTODY_WIKI_TOTAL_BYTES
      || actual.repositoryId !== page.repositoryId || actual.slug !== page.slug
      || actual.commitSha.toLowerCase() !== page.commitSha.toLowerCase()
      || actual.inputsHash.toLowerCase() !== page.inputsHashSha256.toLowerCase()
      || wikiPageBodySha256(actual.bodyMd) !== page.pageBodySha256.toLowerCase()
      || actual.stale !== page.stale) {
      throw new Error("Context Pack Wiki page identity no longer matches the database");
    }
  }
}

export type AcceptanceConfirmedContractProjection = {
  originalRequest: string;
  normalizedRequirements: string[];
  acceptanceCriteria: Array<{
    id: string;
    text: string;
    userVisible: boolean;
    modality?: "ui" | "api" | "data" | "job";
  }>;
  nonGoals: string[];
  risks: string[];
  stops: string[];
  environment: Record<string, unknown>;
  unresolvedQuestions: Array<{ id: string; text: string }>;
};

function safeContractValue(value: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return safeSnapshotText(value, 2_000);
  if (Array.isArray(value)) return value.length <= 64 && value.every((item) => safeContractValue(item, depth + 1));
  if (!isRecord(value) || Object.keys(value).length > 32) return false;
  return Object.entries(value).every(([key, nested]) => safeSnapshotText(key, 128)
    && safeContractValue(nested, depth + 1));
}

function safeContractStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 100 && value.every((item) => safeSnapshotText(item, 2_000));
}

/**
 * The compiler gets this closed projection, never the arbitrary Contract JSON.
 * The full persisted JSON remains part of the custody hash above.
 */
export function projectConfirmedAcceptanceContract(
  contract: Record<string, unknown>
): AcceptanceConfirmedContractProjection | null {
  const criteria = contract["acceptanceCriteria"];
  const questions = contract["unresolvedQuestions"];
  const environment = contract["environment"];
  if (!safeSnapshotText(contract["originalRequest"], 4_000)
    || !safeContractStringArray(contract["normalizedRequirements"])
    || !safeContractStringArray(contract["nonGoals"])
    || !safeContractStringArray(contract["risks"])
    || !safeContractStringArray(contract["stops"])
    || !isRecord(environment) || !safeContractValue(environment)
    || !Array.isArray(criteria) || criteria.length === 0 || criteria.length > 100
    || !Array.isArray(questions) || questions.length > 100) return null;
  const projectedCriteria: AcceptanceConfirmedContractProjection["acceptanceCriteria"] = [];
  for (const criterion of criteria) {
    if (!isRecord(criterion) || !hasExactKeys(criterion, ["id", "text", "userVisible"])
      && !(isRecord(criterion) && hasExactKeys(criterion, ["id", "text", "userVisible", "modality"]))) return null;
    if (!safeSnapshotText(criterion["id"], 512) || !safeSnapshotText(criterion["text"], 2_000)
      || typeof criterion["userVisible"] !== "boolean"
      || (hasOwn(criterion, "modality") && criterion["modality"] !== "ui" && criterion["modality"] !== "api"
        && criterion["modality"] !== "data" && criterion["modality"] !== "job")) return null;
    projectedCriteria.push({
      id: criterion["id"], text: criterion["text"], userVisible: criterion["userVisible"],
      ...(hasOwn(criterion, "modality") ? { modality: criterion["modality"] as "ui" | "api" | "data" | "job" } : {}),
    });
  }
  if (new Set(projectedCriteria.map((criterion) => criterion.id)).size !== projectedCriteria.length) return null;
  const projectedQuestions: AcceptanceConfirmedContractProjection["unresolvedQuestions"] = [];
  for (const question of questions) {
    if (!isRecord(question) || !hasExactKeys(question, ["id", "text"])
      || !safeSnapshotText(question["id"], 512) || !safeSnapshotText(question["text"], 2_000)) return null;
    projectedQuestions.push({ id: question["id"], text: question["text"] });
  }
  if (new Set(projectedQuestions.map((question) => question.id)).size !== projectedQuestions.length) return null;
  return {
    originalRequest: contract["originalRequest"],
    normalizedRequirements: [...contract["normalizedRequirements"]],
    acceptanceCriteria: projectedCriteria,
    nonGoals: [...contract["nonGoals"]],
    risks: [...contract["risks"]],
    stops: [...contract["stops"]],
    environment: structuredClone(environment),
    unresolvedQuestions: projectedQuestions,
  };
}

export type ResolveAcceptanceContextPackCustodyInput = {
  workspaceId: string;
  sourceSnapshotId: string;
};

export type AcceptanceContextPackCustodyResolution = {
  sourceSnapshot: Pick<AcceptanceContextPackSnapshotInput,
    "recordId" | "reviewJobId" | "acceptanceContractId" | "acceptanceContractVersion" | "repo" | "prNumber"
    | "expectedHeadSha" | "baseSha" | "mergeBaseSha" | "headTreeSha" | "packetIds" | "packetSetSha256"
    | "correctionPacketPayloadSetSha256" | "compilerVersion" | "baseIndex" | "overlay" | "provenance"
  > & { id: string };
  contract: AcceptanceConfirmedContractProjection;
  acceptanceContractSha256: string;
  correctionPackets: Record<string, unknown>[];
  correctionPacketPayloadSetSha256: string;
  wikiPages: Array<{
    id: string;
    repositoryId: string;
    slug: string;
    commitSha: string;
    inputsHashSha256: string;
    pageBodySha256: string;
    stale: boolean;
    bodyMd: string;
  }>;
};

/**
 * Server-only post-admission resolver. Its sole authority is one persisted
 * source snapshot; it never accepts caller page IDs, Contract, or packet sets.
 */
export async function resolveAcceptanceContextPackCustody(
  input: ResolveAcceptanceContextPackCustodyInput
): Promise<AcceptanceContextPackCustodyResolution> {
  return db.transaction(async (tx) => {
    const snapshot = (await tx.select().from(acceptanceContextPackSnapshots).where(and(
      eq(acceptanceContextPackSnapshots.id, input.sourceSnapshotId),
      eq(acceptanceContextPackSnapshots.workspaceId, input.workspaceId),
    )).limit(1))[0];
    if (!snapshot || snapshot.status !== "admitted"
      || !isCustodyBaseIndexIdentity(snapshot.baseIndex) || !isCustodyOverlayIdentity(snapshot.overlay)
      || typeof snapshot.acceptanceContractSha256 !== "string"
      || typeof snapshot.correctionPacketPayloadSetSha256 !== "string") {
      throw new Error("Context Pack custody snapshot is missing, legacy, or not admitted");
    }
    const baseIndex = snapshot.baseIndex;
    const overlay = snapshot.overlay;
    const snapshotInput: AcceptanceContextPackSnapshotInput = {
      workspaceId: snapshot.workspaceId, recordId: snapshot.recordId, reviewJobId: snapshot.reviewJobId,
      acceptanceContractId: snapshot.acceptanceContractId, acceptanceContractVersion: snapshot.acceptanceContractVersion,
      acceptanceContractSha256: snapshot.acceptanceContractSha256, repo: snapshot.repo, prNumber: snapshot.prNumber,
      expectedHeadSha: snapshot.expectedHeadSha, baseSha: snapshot.baseSha, mergeBaseSha: snapshot.mergeBaseSha,
      headTreeSha: snapshot.headTreeSha, packetIds: snapshot.packetIds, packetSetSha256: snapshot.packetSetSha256,
      correctionPacketPayloadSetSha256: snapshot.correctionPacketPayloadSetSha256,
      compilerVersion: snapshot.compilerVersion, baseIndex, overlay, provenance: snapshot.provenance as AcceptanceContextInclusionExclusionProvenance,
      status: snapshot.status, reason: snapshot.reason,
    };
    const records = await tx.select().from(changeRecords).where(and(
      eq(changeRecords.id, snapshot.recordId), eq(changeRecords.workspaceId, input.workspaceId),
      eq(changeRecords.repo, snapshot.repo), eq(changeRecords.prNumber, snapshot.prNumber),
    )).limit(1);
    if (!records[0] || !records[0].headShas.includes(snapshot.expectedHeadSha)) {
      throw new Error("Context Pack custody Record is not anchored to the exact head");
    }
    const jobs = await tx.select().from(reviewJobs).where(and(
      eq(reviewJobs.id, snapshot.reviewJobId), eq(reviewJobs.workspaceId, input.workspaceId),
      eq(reviewJobs.repo, snapshot.repo), eq(reviewJobs.prNumber, snapshot.prNumber),
      eq(reviewJobs.headSha, snapshot.expectedHeadSha),
    )).limit(1);
    if (jobs.length !== 1) throw new Error("Context Pack custody review job is not anchored to the exact head");
    const contracts = await tx.select().from(acceptanceContracts).where(and(
      eq(acceptanceContracts.id, snapshot.acceptanceContractId), eq(acceptanceContracts.recordId, snapshot.recordId),
      eq(acceptanceContracts.version, snapshot.acceptanceContractVersion), eq(acceptanceContracts.status, "confirmed"),
    )).limit(1);
    const confirmed = contracts[0];
    const contract = confirmed && projectConfirmedAcceptanceContract(confirmed.contract);
    if (!confirmed || !contract) throw new Error("Context Pack custody Contract is missing, unconfirmed, or unsafe");
    const confirmedContractSha256 = acceptanceContractSha256({
      acceptanceContractId: confirmed.id, acceptanceContractVersion: confirmed.version, contract: confirmed.contract,
    });
    if (snapshot.acceptanceContractSha256 !== confirmedContractSha256) {
      throw new Error("Context Pack custody Contract hash no longer matches the admitted snapshot");
    }
    const criteria = new Map(contract.acceptanceCriteria.map((criterion) => [criterion.id, criterion.text]));
    const events = await tx.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, snapshot.recordId),
      sql`${changeRecordEvents.eventKey} LIKE ${`review:correction:${snapshot.reviewJobId}:%`}`,
    )).orderBy(asc(changeRecordEvents.eventKey));
    const packets = correctionPacketPayloadsForSnapshotEvents(events, snapshotInput, criteria);
    if (!packets) throw new Error("Context Pack custody contains an invalid R8.1 correction packet");
    const correctionPacketPayloadSetSha256 = acceptanceCorrectionPacketPayloadSetSha256({ packets: packets.packets });
    if (!isDeepStrictEqual(packets.packetIds, snapshot.packetIds)
      || snapshot.packetSetSha256 !== acceptanceContextPacketSetSha256({ packetIds: packets.packetIds })
      || snapshot.correctionPacketPayloadSetSha256 !== correctionPacketPayloadSetSha256) {
      throw new Error("Context Pack custody packets no longer match the admitted snapshot");
    }
    const repositoriesForRepo = await tx.select().from(repositories).where(and(
      eq(repositories.workspaceId, input.workspaceId), eq(repositories.name, snapshot.repo),
    ));
    if (repositoriesForRepo.length !== 1) throw new Error("Context Pack custody repository is missing or ambiguous");
    const pageIds = baseIndex.pages.map((page) => page.id);
    if (pageIds.length > 100 || new Set(pageIds).size !== pageIds.length) {
      throw new Error("Context Pack custody snapshot has an invalid Wiki page set");
    }
    const pages = await tx.select().from(wikiPages).where(and(
      eq(wikiPages.workspaceId, input.workspaceId), eq(wikiPages.repositoryId, repositoriesForRepo[0]!.id),
      inArray(wikiPages.id, pageIds),
    )).orderBy(asc(wikiPages.slug), asc(wikiPages.id));
    if (pages.length !== pageIds.length) throw new Error("Context Pack custody Wiki page is missing or outside this repository");
    const persisted = new Map(pages.map((page) => [page.id, page]));
    let totalBodyBytes = 0;
    for (const page of baseIndex.pages) {
      const actual = persisted.get(page.id);
      const bodyBytes = actual ? Buffer.byteLength(actual.bodyMd, "utf8") : 0;
      totalBodyBytes += bodyBytes;
      if (!actual || bodyBytes === 0 || bodyBytes > MAX_CONTEXT_CUSTODY_WIKI_PAGE_BYTES
        || totalBodyBytes > MAX_CONTEXT_CUSTODY_WIKI_TOTAL_BYTES
        || actual.repositoryId !== page.repositoryId || actual.slug !== page.slug
        || actual.commitSha.toLowerCase() !== page.commitSha.toLowerCase()
        || actual.inputsHash.toLowerCase() !== page.inputsHashSha256.toLowerCase()
        || wikiPageBodySha256(actual.bodyMd) !== page.pageBodySha256.toLowerCase()
        || actual.stale !== page.stale) {
        throw new Error("Context Pack custody Wiki page identity or body bounds no longer match the snapshot");
      }
    }
    return {
      sourceSnapshot: {
        id: snapshot.id, recordId: snapshot.recordId, reviewJobId: snapshot.reviewJobId,
        acceptanceContractId: snapshot.acceptanceContractId, acceptanceContractVersion: snapshot.acceptanceContractVersion,
        repo: snapshot.repo, prNumber: snapshot.prNumber, expectedHeadSha: snapshot.expectedHeadSha,
        baseSha: snapshot.baseSha, mergeBaseSha: snapshot.mergeBaseSha, headTreeSha: snapshot.headTreeSha,
        packetIds: snapshot.packetIds, packetSetSha256: snapshot.packetSetSha256,
        correctionPacketPayloadSetSha256: snapshot.correctionPacketPayloadSetSha256,
        compilerVersion: snapshot.compilerVersion, baseIndex, overlay, provenance: snapshotInput.provenance,
      },
      contract,
      acceptanceContractSha256: confirmedContractSha256,
      correctionPackets: packets.packets,
      correctionPacketPayloadSetSha256,
      wikiPages: pages.map((page) => ({
        id: page.id, repositoryId: page.repositoryId, slug: page.slug, commitSha: page.commitSha,
        inputsHashSha256: page.inputsHash, pageBodySha256: wikiPageBodySha256(page.bodyMd),
        stale: page.stale, bodyMd: page.bodyMd,
      })),
    };
  });
}

/** Closed, metadata-only identity for one exact review-job/head Context Pack snapshot. */
export function validateAcceptanceContextPackSnapshotInput(
  value: unknown
): value is AcceptanceContextPackSnapshotInput {
  if (!isRecord(value) || !hasExactKeys(value, [
    "workspaceId", "recordId", "reviewJobId", "acceptanceContractId", "acceptanceContractVersion",
    "acceptanceContractSha256", "repo", "prNumber", "expectedHeadSha", "baseSha", "mergeBaseSha", "headTreeSha", "packetIds", "packetSetSha256", "correctionPacketPayloadSetSha256",
    "compilerVersion", "baseIndex", "overlay", "provenance", "status", "reason",
  ])) return false;
  if (!isUuid(value["workspaceId"]) || !isUuid(value["recordId"]) || !isUuid(value["reviewJobId"])
    || !isUuid(value["acceptanceContractId"]) || !Number.isInteger(value["acceptanceContractVersion"])
    || (value["acceptanceContractVersion"] as number) <= 0 || typeof value["repo"] !== "string"
    || typeof value["acceptanceContractSha256"] !== "string" || !EXACT_SHA256.test(value["acceptanceContractSha256"])
    || !safeRepo(value["repo"]) || !Number.isInteger(value["prNumber"]) || (value["prNumber"] as number) <= 0
    || typeof value["expectedHeadSha"] !== "string" || !EXACT_SHA1.test(value["expectedHeadSha"])
    || !uniqueStrings(value["packetIds"], (packet) => typeof packet === "string" && CORRECTION_PACKET_ID.test(packet), 100)
    || !(value["packetIds"] as string[]).every((packet, index, packets) => index === 0 || packets[index - 1]! < packet)
    || typeof value["packetSetSha256"] !== "string" || !EXACT_SHA256.test(value["packetSetSha256"])
    || value["packetSetSha256"] !== acceptanceContextPacketSetSha256({ packetIds: value["packetIds"] as string[] })
    || typeof value["correctionPacketPayloadSetSha256"] !== "string" || !EXACT_SHA256.test(value["correctionPacketPayloadSetSha256"])
    || !safeSnapshotText(value["compilerVersion"], 128)
    || (value["baseIndex"] !== null && !isCustodyBaseIndexIdentity(value["baseIndex"]))
    || (value["overlay"] !== null && !isCustodyOverlayIdentity(value["overlay"]))
    || !isProvenance(value["provenance"])
    || (value["status"] !== "admitted" && value["status"] !== "not_proven")
    || (value["reason"] !== null && !safeSnapshotText(value["reason"], 2_000))
  ) return false;
  const sourceResolved = typeof value["baseSha"] === "string" && EXACT_SHA1.test(value["baseSha"])
    && typeof value["mergeBaseSha"] === "string" && EXACT_SHA1.test(value["mergeBaseSha"])
    && typeof value["headTreeSha"] === "string" && EXACT_SHA1.test(value["headTreeSha"])
    && value["baseIndex"] !== null && value["overlay"] !== null
    && value["overlay"].baseSha === value["baseSha"]
    && value["overlay"].mergeBaseSha === value["mergeBaseSha"]
    && value["overlay"].headSha === value["expectedHeadSha"]
    && hasCompleteAdmittedSourceProvenance({
      baseIndex: value["baseIndex"],
      overlay: value["overlay"],
      provenance: value["provenance"],
    })
    && value["reason"] === null;
  return value["status"] === "admitted"
    ? sourceResolved
    : value["baseSha"] === null && value["mergeBaseSha"] === null && value["headTreeSha"] === null
      && value["baseIndex"] === null && value["overlay"] === null && value["reason"] !== null
      && hasFailClosedUnavailableProvenance(value["provenance"], value["reason"]);
}

export function parseAcceptanceContextPackSnapshotInput(
  value: unknown
): AcceptanceContextPackSnapshotInput | null {
  return validateAcceptanceContextPackSnapshotInput(value) ? value : null;
}

export function acceptanceContextPackSnapshotId(input: {
  reviewJobId: string;
  compilerVersion: string;
  packetSetSha256: string;
}): string {
  return uuid5Url(
    `acceptance-context-pack-snapshot:${input.reviewJobId}:${input.compilerVersion}:${input.packetSetSha256}`
  );
}

function snapshotComparable(snapshot: AcceptanceContextPackSnapshotRow | AcceptanceContextPackSnapshotInput) {
  return {
    workspaceId: snapshot.workspaceId,
    recordId: snapshot.recordId,
    reviewJobId: snapshot.reviewJobId,
    acceptanceContractId: snapshot.acceptanceContractId,
    acceptanceContractVersion: snapshot.acceptanceContractVersion,
    acceptanceContractSha256: snapshot.acceptanceContractSha256,
    repo: snapshot.repo,
    prNumber: snapshot.prNumber,
    expectedHeadSha: snapshot.expectedHeadSha,
    baseSha: snapshot.baseSha,
    mergeBaseSha: snapshot.mergeBaseSha,
    headTreeSha: snapshot.headTreeSha,
    packetIds: snapshot.packetIds,
    packetSetSha256: snapshot.packetSetSha256,
    correctionPacketPayloadSetSha256: snapshot.correctionPacketPayloadSetSha256,
    compilerVersion: snapshot.compilerVersion,
    baseIndex: snapshot.baseIndex,
    overlay: snapshot.overlay,
    provenance: snapshot.provenance,
    status: snapshot.status,
    reason: snapshot.reason,
  };
}

/**
 * Records one immutable exact-head Context Pack source snapshot. This is an
 * admission boundary only: it neither compiles source nor exposes a Pack.
 * Replays are accepted only when every durable field is identical.
 */
export async function recordAcceptanceContextPackSnapshot(
  input: AcceptanceContextPackSnapshotInput
): Promise<{ snapshot: AcceptanceContextPackSnapshotRow; inserted: boolean }> {
  if (!validateAcceptanceContextPackSnapshotInput(input)) {
    throw new Error("Invalid exact-head Context Pack snapshot");
  }
  if (input.packetIds.some((id, index) => index > 0 && input.packetIds[index - 1]! >= id)) {
    throw new Error("Context Pack snapshot packetIds must be sorted and unique");
  }
  const id = acceptanceContextPackSnapshotId(input);
  const lockKey = `acceptance-context-pack-snapshot:${input.reviewJobId}:${input.compilerVersion}:${input.packetSetSha256}`;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const records = await tx.select().from(changeRecords).where(and(
      eq(changeRecords.id, input.recordId),
      eq(changeRecords.workspaceId, input.workspaceId),
      eq(changeRecords.repo, input.repo),
      eq(changeRecords.prNumber, input.prNumber),
    )).limit(1);
    const record = records[0];
    if (!record || !record.headShas.includes(input.expectedHeadSha)) {
      throw new Error("Context Pack snapshot Record is not anchored to the exact head");
    }
    const jobs = await tx.select().from(reviewJobs).where(and(
      eq(reviewJobs.id, input.reviewJobId),
      eq(reviewJobs.workspaceId, input.workspaceId),
      eq(reviewJobs.repo, input.repo),
      eq(reviewJobs.prNumber, input.prNumber),
      eq(reviewJobs.headSha, input.expectedHeadSha),
    )).limit(1);
    if (jobs.length !== 1) {
      throw new Error("Context Pack snapshot review job is not anchored to the exact Record head");
    }
    const confirmed = await tx.select().from(acceptanceContracts).where(and(
      eq(acceptanceContracts.recordId, input.recordId),
      eq(acceptanceContracts.status, "confirmed"),
    )).orderBy(asc(acceptanceContracts.version));
    if (confirmed.length !== 1
      || confirmed[0]!.id !== input.acceptanceContractId
      || confirmed[0]!.version !== input.acceptanceContractVersion
    ) {
      throw new Error("Context Pack snapshot requires the Record's exact confirmed Contract");
    }
    if (input.acceptanceContractSha256 !== acceptanceContractSha256({
      acceptanceContractId: confirmed[0]!.id,
      acceptanceContractVersion: confirmed[0]!.version,
      contract: confirmed[0]!.contract,
    })) {
      throw new Error("Context Pack snapshot Contract hash is not the exact confirmed Contract");
    }
    const rawCriteria = confirmed[0]!.contract["acceptanceCriteria"];
    if (!Array.isArray(rawCriteria)) {
      throw new Error("Context Pack snapshot requires the confirmed Contract's exact criteria");
    }
    const confirmedCriteria = new Map<string, string>();
    for (const criterion of rawCriteria) {
      if (!isRecord(criterion) || !safeSnapshotText(criterion["id"], 512)
        || !safeSnapshotText(criterion["text"], 2_000) || confirmedCriteria.has(criterion["id"])) {
        throw new Error("Context Pack snapshot requires the confirmed Contract's exact criteria");
      }
      confirmedCriteria.set(criterion["id"], criterion["text"]);
    }
    const correctionPrefix = `review:correction:${input.reviewJobId}:%`;
    const correctionEvents = await tx.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, input.recordId),
      sql`${changeRecordEvents.eventKey} LIKE ${correctionPrefix}`,
    )).orderBy(asc(changeRecordEvents.eventKey));
    const persistedPackets = correctionPacketPayloadsForSnapshotEvents(
      correctionEvents, input, confirmedCriteria
    );
    if (!persistedPackets
      || !isDeepStrictEqual(persistedPackets.packetIds, input.packetIds)
      || input.correctionPacketPayloadSetSha256 !== acceptanceCorrectionPacketPayloadSetSha256({
        packets: persistedPackets.packets,
      })
    ) {
      throw new Error("Context Pack snapshot packets are not the complete exact R8.1 payload set");
    }
    await recheckWikiBaseIndex(tx, input);
    const existing = await tx.select().from(acceptanceContextPackSnapshots).where(and(
      eq(acceptanceContextPackSnapshots.reviewJobId, input.reviewJobId),
      eq(acceptanceContextPackSnapshots.compilerVersion, input.compilerVersion),
      eq(acceptanceContextPackSnapshots.packetSetSha256, input.packetSetSha256),
    )).limit(1);
    if (existing[0]) {
      if (!isDeepStrictEqual(snapshotComparable(existing[0]), snapshotComparable(input))) {
        throw new Error("Context Pack snapshot replay identity is already bound to different provenance");
      }
      return { snapshot: existing[0], inserted: false };
    }
    const rows = await tx.insert(acceptanceContextPackSnapshots).values({ id, ...input }).returning();
    return { snapshot: rows[0]!, inserted: true };
  });
}

function mapAcceptanceBuilderRouteRow(row: Record<string, unknown>): AcceptanceBuilderRouteRow {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    repo: row.repo as string,
    adapter: row.adapter as string,
    status: row.status as string,
    configurationVersion: row.configuration_version as number,
    registeredBy: row.registered_by as string,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function builderRouteSnapshot(route: AcceptanceBuilderRouteRow): AcceptanceBuilderRouteSnapshot {
  const github = route.adapter === "github_codex" || route.adapter === "github_claude";
  const capability = github
    ? { activation: "github_mention" as const, acknowledgement: "vendor_activity" as const }
    : { activation: "none" as const, acknowledgement: "human_ack" as const };
  return {
    builder: { adapter: route.adapter as AcceptanceBuilderRouteAdapter, routeId: route.id },
    protocol: github ? "github_comment" : "durable_notice",
    capability: {
      availability: "unverified",
      ...capability, repairHead: "github_synchronize",
    },
    scopeBoundary: ACCEPTANCE_BUILDER_ROUTE_SCOPE,
  };
}

function builderRoutePayload(input: {
  record: ChangeRecordRow;
  contract: AcceptanceContractRow;
  route: AcceptanceBuilderRouteRow;
}): Record<string, unknown> {
  const selection = { routeId: input.route.id };
  return {
    kind: "acceptance_builder_route_selection",
    version: ACCEPTANCE_BUILDER_ROUTE_PAYLOAD_VERSION,
    workspaceId: input.record.workspaceId,
    repository: input.record.repo,
    recordId: input.record.id,
    contract: { id: input.contract.id, version: input.contract.version, status: "confirmed" },
    selection,
    route: {
      id: input.route.id,
      adapter: input.route.adapter,
      configurationVersion: input.route.configurationVersion,
      status: "active",
    },
    snapshot: builderRouteSnapshot(input.route),
  };
}

function parseAcceptanceBuilderRoutePayload(
  value: unknown
): { workspaceId: string; repository: string; recordId: string; contractId: string; contractVersion: number; routeId: string; routeAdapter: AcceptanceBuilderRouteAdapter; routeConfigurationVersion: number; selection: AcceptanceBuilderRouteSelection; snapshot: AcceptanceBuilderRouteSnapshot } | null {
  if (!isRecord(value) || !hasExactKeys(value, ["kind", "version", "workspaceId", "repository", "recordId", "contract", "selection", "route", "snapshot"])
    || value["kind"] !== "acceptance_builder_route_selection"
    || value["version"] !== ACCEPTANCE_BUILDER_ROUTE_PAYLOAD_VERSION
    || !isUuid(value["workspaceId"])
    || typeof value["repository"] !== "string"
    || !isUuid(value["recordId"])
    || !isRecord(value["contract"])
    || !hasExactKeys(value["contract"], ["id", "version", "status"])
    || !isUuid(value["contract"]["id"])
    || !Number.isInteger(value["contract"]["version"])
    || (value["contract"]["version"] as number) <= 0
    || value["contract"]["status"] !== "confirmed"
    || !parseAcceptanceBuilderRouteSelection(value["selection"])
    || !isRecord(value["route"])
    || !hasExactKeys(value["route"], ["id", "adapter", "configurationVersion", "status"])
    || !isUuid(value["route"]["id"])
    || !isBuilderRouteAdapter(value["route"]["adapter"])
    || !Number.isInteger(value["route"]["configurationVersion"])
    || (value["route"]["configurationVersion"] as number) <= 0
    || value["route"]["status"] !== "active"
    || !isRecord(value["snapshot"])
  ) return null;
  const selection = parseAcceptanceBuilderRouteSelection(value["selection"]);
  if (!selection) return null;
  const route: AcceptanceBuilderRouteRow = {
    id: value["route"]["id"], workspaceId: value["workspaceId"], repo: value["repository"],
    adapter: value["route"]["adapter"], status: "active",
    configurationVersion: value["route"]["configurationVersion"] as number,
    registeredBy: "server:payload-parser", createdAt: new Date(0), updatedAt: new Date(0),
  };
  if (selection.routeId !== route.id) return null;
  const snapshot = builderRouteSnapshot(route);
  if (!isDeepStrictEqual(value["snapshot"], snapshot)) return null;
  return {
    workspaceId: value["workspaceId"], repository: value["repository"], recordId: value["recordId"],
    contractId: value["contract"]["id"], contractVersion: value["contract"]["version"] as number,
    routeId: route.id, routeAdapter: route.adapter as AcceptanceBuilderRouteAdapter,
    routeConfigurationVersion: route.configurationVersion, selection, snapshot,
  };
}

/**
 * Register a route from trusted server configuration. No public route calls
 * this helper in R8.2a, and no vendor task/thread/credential value is stored.
 */
export async function registerAcceptanceBuilderRoute(
  input: RegisterAcceptanceBuilderRouteInput
): Promise<{ route: AcceptanceBuilderRouteRow; inserted: boolean }> {
  const id = input.id ?? randomUUID();
  const status = input.status ?? "active";
  if (!isUuid(id) || !isUuid(input.workspaceId) || !isBuilderRouteAdapter(input.adapter)
    || (status !== "active" && status !== "disabled")
    || !Number.isInteger(input.configurationVersion) || input.configurationVersion <= 0
    || !isBuilderRouteActor(input.registeredBy)
    || !input.repo.trim() || input.repo.trim() !== input.repo
    || input.repo.length > 512 || /[\u0000-\u001f\u007f]/.test(input.repo)
  ) throw new Error("Invalid Acceptance Builder route registration");

  const insertedRows = await db.insert(acceptanceBuilderRoutes).values({
    id, workspaceId: input.workspaceId, repo: input.repo, adapter: input.adapter,
    status, configurationVersion: input.configurationVersion, registeredBy: input.registeredBy,
  }).onConflictDoNothing().returning();
  const route = insertedRows[0] ?? (await db.select().from(acceptanceBuilderRoutes).where(
    eq(acceptanceBuilderRoutes.id, id)
  ).limit(1))[0];
  if (!route) throw new Error("Acceptance Builder route registration was not persisted");
  const expected = {
    workspaceId: input.workspaceId, repo: input.repo, adapter: input.adapter, status,
    configurationVersion: input.configurationVersion, registeredBy: input.registeredBy,
  };
  if (!isDeepStrictEqual({
    workspaceId: route.workspaceId, repo: route.repo, adapter: route.adapter, status: route.status,
    configurationVersion: route.configurationVersion, registeredBy: route.registeredBy,
  }, expected)) throw new Error("Acceptance Builder route id is already bound to different configuration");
  return { route, inserted: insertedRows.length === 1 };
}

/**
 * Persist the sole configured route for future correction delivery. No
 * transport is attempted here. Reusing this deterministic key is permitted
 * only for byte-equivalent provenance through the generic atomic append.
 */
export async function recordAcceptanceBuilderRouteSelection(
  input: RecordAcceptanceBuilderRouteSelectionInput
): Promise<{ event: ChangeRecordEventRow; inserted: boolean }> {
  const selection = { routeId: input.routeId };
  if (!validateAcceptanceBuilderRouteSelection(selection)) {
    throw new Error("Invalid Acceptance Builder route selection");
  }
  if (!isBuilderRouteActor(input.selectedBy, true)) {
    throw new Error("Invalid Acceptance Builder route actor");
  }
  return db.transaction(async (tx) => {
    const records = Array.from(await tx.execute(sql`
      SELECT * FROM change_records
      WHERE id = ${input.recordId} AND workspace_id = ${input.workspaceId}
      FOR UPDATE
    `)) as Array<Record<string, unknown>>;
    if (records.length !== 1) throw new Error("Acceptance Record is missing or outside this workspace");
    const record = mapChangeRecordRow(records[0]!);
    const confirmed = await tx.select().from(acceptanceContracts).where(and(
      eq(acceptanceContracts.recordId, input.recordId),
      eq(acceptanceContracts.status, "confirmed"),
    )).orderBy(asc(acceptanceContracts.version));
    if (confirmed.length !== 1) {
      throw new Error("Acceptance Builder route requires exactly one confirmed Contract");
    }
    const routeRows = Array.from(await tx.execute(sql`
      SELECT * FROM acceptance_builder_routes
      WHERE id = ${input.routeId}
        AND workspace_id = ${input.workspaceId}
        AND repo = ${record.repo}
        AND status = 'active'
      FOR SHARE
    `)) as Array<Record<string, unknown>>;
    if (routeRows.length !== 1) throw new Error("Acceptance Builder route is unavailable for this Record");
    const route = mapAcceptanceBuilderRouteRow(routeRows[0]!);
    if (!isBuilderRouteAdapter(route.adapter)) throw new Error("Acceptance Builder route adapter is unsupported");
    const payloadRef = builderRoutePayload({ record, contract: confirmed[0]!, route });
    const result = await appendChangeRecordEventsAtomicallyInTransaction(tx, [{
      recordId: input.recordId,
      eventKey: ACCEPTANCE_BUILDER_ROUTE_EVENT_KEY,
      stage: "builder_handoff",
      actor: input.selectedBy,
      payloadRef,
    }]);
    return result.events[0]!;
  });
}

/** Read only a route event whose stored provenance still matches this exact workspace Record and Contract. */
export async function readAcceptanceBuilderRouteSelection(input: {
  workspaceId: string;
  recordId: string;
}): Promise<AcceptanceBuilderRouteSelectionResolution | null> {
  const records = await db.select().from(changeRecords).where(and(
    eq(changeRecords.workspaceId, input.workspaceId), eq(changeRecords.id, input.recordId),
  )).limit(1);
  const record = records[0];
  if (!record) return null;
  const confirmed = await db.select().from(acceptanceContracts).where(and(
    eq(acceptanceContracts.recordId, input.recordId), eq(acceptanceContracts.status, "confirmed"),
  )).orderBy(asc(acceptanceContracts.version));
  if (confirmed.length !== 1) return null;
  const events = await db.select().from(changeRecordEvents).where(and(
    eq(changeRecordEvents.recordId, input.recordId),
    eq(changeRecordEvents.eventKey, ACCEPTANCE_BUILDER_ROUTE_EVENT_KEY),
  )).limit(1);
  const event = events[0];
  if (!event || event.stage !== "builder_handoff" || !isBuilderRouteActor(event.actor, true)) return null;
  const parsed = parseAcceptanceBuilderRoutePayload(event.payloadRef);
  if (!parsed
    || parsed.workspaceId !== record.workspaceId
    || parsed.repository !== record.repo
    || parsed.recordId !== record.id
    || parsed.contractId !== confirmed[0]!.id
    || parsed.contractVersion !== confirmed[0]!.version
  ) return null;
  const routes = await db.select().from(acceptanceBuilderRoutes).where(and(
    eq(acceptanceBuilderRoutes.id, parsed.routeId),
    eq(acceptanceBuilderRoutes.workspaceId, input.workspaceId),
    eq(acceptanceBuilderRoutes.repo, record.repo),
    eq(acceptanceBuilderRoutes.status, "active"),
  )).limit(1);
  const route = routes[0];
  if (!route || !isBuilderRouteAdapter(route.adapter)
    || route.adapter !== parsed.routeAdapter
    || route.configurationVersion !== parsed.routeConfigurationVersion
    || !isDeepStrictEqual(builderRouteSnapshot(route), parsed.snapshot)
  ) return null;
  return { selection: parsed.selection, route, snapshot: parsed.snapshot, event };
}
