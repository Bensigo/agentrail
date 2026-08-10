import { createHash, randomUUID } from "crypto";
import { isDeepStrictEqual } from "util";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  changeRecordEvents,
  changeRecords,
  acceptanceContracts,
  acceptanceIntakes,
  acceptanceIntakeMessages,
  type AcceptanceContractRow,
  type AcceptanceIntakeMessageRow,
  type AcceptanceIntakeRow,
  type ChangeRecordEventRow,
  type ChangeRecordRow,
} from "../schema/change_records.js";

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
