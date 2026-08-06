import { createHash, randomUUID } from "crypto";
import { and, asc, count, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db.js";
import { previewBoots } from "../schema/preview_boots.js";
import { repositories } from "../schema/repositories.js";
import {
  changeRecordEvents,
  changeRecords,
  acceptanceContracts,
  acceptanceContextPacks,
  acceptanceContextPackCompilations,
  acceptanceContextPackDeliveries,
  changeRecordPrs,
  changeRecordPrRevisions,
  acceptanceBuilderHandoffs,
  acceptanceIntakes,
  acceptanceIntakeMessages,
  evidenceReviews,
  evidenceVerificationPlans,
  evidenceVerificationArtifacts,
  evidenceVerificationExecutions,
  evidenceReviewCriteria,
  evidenceReviewCorrections,
  evidenceReviewCorrectionDeliveries,
  type AcceptanceContractRow,
  type AcceptanceContextPackDeliveryRow,
  type AcceptanceContextPackRow,
  type AcceptanceContextPackCompilationRow,
  type ChangeRecordEventRow,
  type ChangeRecordRow,
  type ChangeRecordPrRow,
  type ChangeRecordPrRevisionRow,
  type AcceptanceBuilderHandoffRow,
  type AcceptanceIntakeRow,
  type AcceptanceIntakeMessageRow,
  type EvidenceVerificationPlanRow,
  type EvidenceVerificationArtifactRow,
  type EvidenceVerificationExecutionRow,
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

export function acceptanceContextPackId(input: {
  recordId: string;
  contentHash: string;
}): string {
  return uuid5Url(`acceptance-context-pack:${input.recordId}:${input.contentHash}`);
}

export function acceptanceContextPackCompilationId(input: {
  recordId: string;
  acceptanceContractId: string;
  acceptanceContractVersion: number;
  repositoryId: string;
  phase: string;
}): string {
  return uuid5Url(
    `acceptance-context-pack-compilation:${input.recordId}:${input.acceptanceContractId}:${input.acceptanceContractVersion}:${input.repositoryId}:${input.phase}`
  );
}

export function acceptanceContextPackDeliveryId(input: {
  contextPackId: string;
  deliveryKey: string;
}): string {
  return uuid5Url(
    `acceptance-context-pack-delivery:${input.contextPackId}:${input.deliveryKey}`
  );
}

export function changeRecordPrId(input: { recordId: string; repositoryId: string; prNumber: number }): string {
  return uuid5Url(`change-record-pr:${input.recordId}:${input.repositoryId}:${input.prNumber}`);
}

export function changeRecordPrRevisionId(input: { prAttachmentId: string; headSha: string }): string {
  return uuid5Url(`change-record-pr-revision:${input.prAttachmentId}:${input.headSha}`);
}

export function acceptanceBuilderHandoffId(input: { recordId: string; taskContextKey: string }): string {
  return uuid5Url(`acceptance-builder-handoff:${input.recordId}:${input.taskContextKey}`);
}

export function acceptanceIntakeId(input: { workspaceId: string; originChannel: string; conversationKey: string }): string {
  return uuid5Url(`acceptance-intake:${input.workspaceId}:${input.originChannel}:${input.conversationKey}`);
}

export function acceptanceIntakeMessageId(input: { intakeId: string; sourceKey: string }): string {
  return uuid5Url(`acceptance-intake-message:${input.intakeId}:${input.sourceKey}`);
}

export function evidenceReviewId(input: { recordId: string; prRevisionId: string }): string {
  return uuid5Url(`evidence-review:${input.recordId}:${input.prRevisionId}`);
}

export function evidenceVerificationPlanId(input: { prRevisionId: string; criterionId: string }): string {
  return uuid5Url(`evidence-verification-plan:${input.prRevisionId}:${input.criterionId}`);
}

export function evidenceVerificationExecutionId(input: { verificationPlanId: string }): string {
  return uuid5Url(`evidence-verification-execution:${input.verificationPlanId}`);
}

export function correctionDeliveryId(input: { correctionId: string; deliveryKey: string }): string {
  return uuid5Url(`evidence-review-correction-delivery:${input.correctionId}:${input.deliveryKey}`);
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

export async function appendChangeRecordEvent(
  input: AppendChangeRecordEventInput
): Promise<{ event: ChangeRecordEventRow; inserted: boolean }> {
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
 * Records one source-channel message before repository selection. This never
 * drafts or confirms a contract and cannot start external implementation.
 */
export async function recordAcceptanceInboundIntake(
  input: RecordAcceptanceInboundIntakeInput
): Promise<{ intake: AcceptanceIntakeRow; message: AcceptanceIntakeMessageRow; inserted: boolean }> {
  const originChannel = input.originChannel.trim().toLowerCase();
  const conversationKey = input.conversationKey.trim();
  const sourceKey = input.sourceKey.trim();
  const text = input.text.trim();
  if (!originChannel || !conversationKey || !sourceKey || !text) throw new Error("Acceptance Intake requires channel, conversation, source key, and message");
  const intakeId = acceptanceIntakeId({ workspaceId: input.workspaceId, originChannel, conversationKey });
  const messageId = acceptanceIntakeMessageId({ intakeId, sourceKey });
  const sourceReferences = normalizeSourceReferences(input.sourceReferences);
  return db.transaction(async (tx) => {
    const intakes = await tx.execute(sql`
      INSERT INTO acceptance_intakes (id, workspace_id, origin_channel, conversation_key, source_references)
      VALUES (${intakeId}, ${input.workspaceId}, ${originChannel}, ${conversationKey}, ${JSON.stringify(sourceReferences)}::jsonb)
      ON CONFLICT (workspace_id, origin_channel, conversation_key)
      DO UPDATE SET updated_at = now()
      RETURNING *
    `) as unknown as Array<Record<string, unknown>>;
    const intake = intakes[0] as unknown as AcceptanceIntakeRow;
    const messages = await tx.insert(acceptanceIntakeMessages).values({
      id: messageId, intakeId, sourceKey, direction: "inbound", text,
      metadata: input.metadata ?? {},
    }).onConflictDoNothing().returning();
    const message = messages[0] ?? (await tx.select().from(acceptanceIntakeMessages).where(eq(acceptanceIntakeMessages.id, messageId)).limit(1))[0]!;
    return { intake, message, inserted: messages.length === 1 };
  });
}

export type AppendAcceptanceOutboundReplyInput = {
  workspaceId: string;
  intakeId: string;
  sourceKey: string;
  text: string;
  metadata?: Record<string, unknown>;
};

/**
 * Appends one Jace reply to an existing, workspace-owned Intake. This is
 * deliberately separate from inbound recording: it cannot create an Intake,
 * draft/confirm a Record, or change the Record link. A repeated source key is
 * idempotent only when it already names the same outbound message.
 */
export async function appendAcceptanceOutboundReply(
  input: AppendAcceptanceOutboundReplyInput,
): Promise<{ message: AcceptanceIntakeMessageRow; inserted: boolean } | null> {
  const workspaceId = input.workspaceId.trim();
  const intakeId = input.intakeId.trim();
  const sourceKey = input.sourceKey.trim();
  const text = input.text.trim();
  if (!workspaceId || !intakeId || !sourceKey || !text) {
    throw new Error("Acceptance Intake outbound reply requires workspace, intake, source key, and text");
  }

  return db.transaction(async (tx) => {
    const intake = await tx
      .select({ id: acceptanceIntakes.id })
      .from(acceptanceIntakes)
      .where(and(eq(acceptanceIntakes.id, intakeId), eq(acceptanceIntakes.workspaceId, workspaceId)))
      .limit(1);
    if (!intake[0]) return null;

    const messageId = acceptanceIntakeMessageId({ intakeId, sourceKey });
    const inserted = await tx
      .insert(acceptanceIntakeMessages)
      .values({
        id: messageId,
        intakeId,
        sourceKey,
        direction: "outbound",
        text,
        metadata: input.metadata ?? {},
      })
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) return { message: inserted[0], inserted: true };

    const existing = await tx
      .select()
      .from(acceptanceIntakeMessages)
      .where(and(eq(acceptanceIntakeMessages.intakeId, intakeId), eq(acceptanceIntakeMessages.sourceKey, sourceKey)))
      .limit(1);
    return existing[0] ? { message: existing[0], inserted: false } : null;
  });
}

/** Read one canonical intake and its append-only source-channel evidence. */
export async function readAcceptanceIntake(input: { workspaceId: string; intakeId: string }) {
  const intake = await db.select().from(acceptanceIntakes).where(and(
    eq(acceptanceIntakes.id, input.intakeId),
    eq(acceptanceIntakes.workspaceId, input.workspaceId),
  )).limit(1);
  if (!intake[0]) return null;
  const messages = await db.select().from(acceptanceIntakeMessages)
    .where(eq(acceptanceIntakeMessages.intakeId, input.intakeId))
    .orderBy(asc(acceptanceIntakeMessages.createdAt));
  return { intake: intake[0], messages };
}

export const ACCEPTANCE_INTAKE_READBACK_LIMITS = Object.freeze({
  messageText: 2_000,
  recentMessages: 8,
  contractText: 1_000,
  contractItems: 24,
});

type CompactContractItem = {
  id: string;
  text: string;
  required?: boolean;
  userVisible?: boolean;
  status?: string;
  resolution?: string;
};

function boundedText(value: unknown, limit: number): { value: string; truncated: boolean } {
  const text = typeof value === "string" ? value : "";
  return { value: text.slice(0, limit), truncated: text.length > limit };
}

function compactContractItems(value: unknown, kind: "criterion" | "question") {
  const items = Array.isArray(value) ? value : [];
  const included = items.slice(0, ACCEPTANCE_INTAKE_READBACK_LIMITS.contractItems).flatMap((item): CompactContractItem[] => {
    if (item == null || typeof item !== "object" || Array.isArray(item)) return [];
    const source = item as Record<string, unknown>;
    const id = boundedText(source.id, 256).value;
    const text = boundedText(source.text, ACCEPTANCE_INTAKE_READBACK_LIMITS.contractText).value;
    if (!id || !text) return [];
    if (kind === "criterion") {
      return [{ id, text, required: source.required !== false, userVisible: source.userVisible === true }];
    }
    const result: CompactContractItem = { id, text, status: source.status === "resolved" ? "resolved" : "open" };
    if (typeof source.resolution === "string" && source.resolution) {
      result.resolution = boundedText(source.resolution, ACCEPTANCE_INTAKE_READBACK_LIMITS.contractText).value;
    }
    return [result];
  });
  return {
    items: included,
    total: items.length,
    included: included.length,
    truncated: items.length > included.length,
  };
}

function compactAcceptanceContract(value: unknown) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const contract = value as Record<string, unknown>;
  return {
    acceptanceCriteria: compactContractItems(contract.acceptanceCriteria, "criterion"),
    openQuestions: compactContractItems(contract.openQuestions ?? contract.unresolvedQuestions, "question"),
  };
}

function compactIntakeMessage(row: AcceptanceIntakeMessageRow) {
  const text = boundedText(row.text, ACCEPTANCE_INTAKE_READBACK_LIMITS.messageText);
  return {
    id: row.id,
    direction: row.direction,
    text: text.value,
    textTruncated: text.truncated,
    createdAt: row.createdAt,
  };
}

export type AcceptanceIntakeReadback = {
  intake: {
    id: string;
    status: string;
    originChannel: string;
    recordId: string | null;
  };
  firstInbound: ReturnType<typeof compactIntakeMessage> | null;
  recentMessages: ReturnType<typeof compactIntakeMessage>[];
  messageCounts: { total: number; included: number; truncated: boolean };
  contract: {
    id: string;
    version: number;
    status: string;
    acceptanceCriteria: ReturnType<typeof compactContractItems>;
    openQuestions: ReturnType<typeof compactContractItems>;
  } | null;
};

/**
 * Read only the bounded evidence Jace needs to resume a compacted intake.
 * Workspace and intake are always part of the same lookup; source references,
 * message metadata, and the full contract never cross this boundary.
 */
export async function readAcceptanceIntakeReadback(input: {
  workspaceId: string;
  intakeId: string;
}): Promise<AcceptanceIntakeReadback | null> {
  const intakes = await db
    .select({ id: acceptanceIntakes.id, status: acceptanceIntakes.status, originChannel: acceptanceIntakes.originChannel, recordId: acceptanceIntakes.recordId })
    .from(acceptanceIntakes)
    .where(and(eq(acceptanceIntakes.id, input.intakeId), eq(acceptanceIntakes.workspaceId, input.workspaceId)))
    .limit(1);
  const intake = intakes[0];
  if (!intake) return null;

  const [totalRows, firstRows, recentRows, contracts] = await Promise.all([
    db.select({ total: count() }).from(acceptanceIntakeMessages).where(eq(acceptanceIntakeMessages.intakeId, input.intakeId)),
    db.select().from(acceptanceIntakeMessages)
      .where(and(eq(acceptanceIntakeMessages.intakeId, input.intakeId), eq(acceptanceIntakeMessages.direction, "inbound")))
      .orderBy(asc(acceptanceIntakeMessages.createdAt), asc(acceptanceIntakeMessages.id)).limit(1),
    db.select().from(acceptanceIntakeMessages)
      .where(eq(acceptanceIntakeMessages.intakeId, input.intakeId))
      .orderBy(desc(acceptanceIntakeMessages.createdAt), desc(acceptanceIntakeMessages.id))
      .limit(ACCEPTANCE_INTAKE_READBACK_LIMITS.recentMessages),
    intake.recordId
      ? db.select({ id: acceptanceContracts.id, version: acceptanceContracts.version, status: acceptanceContracts.status, contract: acceptanceContracts.contract })
        .from(acceptanceContracts)
        .where(eq(acceptanceContracts.recordId, intake.recordId))
        .orderBy(desc(acceptanceContracts.version)).limit(1)
      : Promise.resolve([]),
  ]);

  const firstInbound = firstRows[0] ? compactIntakeMessage(firstRows[0]) : null;
  const recentMessages = recentRows
    .slice()
    .reverse()
    .filter((row) => !firstRows[0] || row.id !== firstRows[0].id)
    .map(compactIntakeMessage);
  const total = Number(totalRows[0]?.total ?? 0);
  const included = (firstInbound ? 1 : 0) + recentMessages.length;
  const latestContract = contracts[0];

  return {
    intake: { id: intake.id, status: intake.status, originChannel: intake.originChannel, recordId: intake.recordId },
    firstInbound,
    recentMessages,
    messageCounts: { total, included, truncated: total > included },
    contract: latestContract
      ? { id: latestContract.id, version: latestContract.version, status: latestContract.status, ...compactAcceptanceContract(latestContract.contract)! }
      : null,
  };
}

/** Link an Intake once a draft Acceptance Record has been safely created. */
export async function linkAcceptanceIntakeToRecord(input: { workspaceId: string; intakeId: string; recordId: string }) {
  const rows = await db.update(acceptanceIntakes).set({ recordId: input.recordId, status: "drafted", updatedAt: new Date() })
    .where(and(eq(acceptanceIntakes.id, input.intakeId), eq(acceptanceIntakes.workspaceId, input.workspaceId), isNull(acceptanceIntakes.recordId)))
    .returning();
  return rows[0] ?? null;
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

/**
 * Starts the trust workflow before an issue or PR exists. A retry with the
 * same workKey returns the original immutable draft instead of creating a
 * second change record or contract version.
 */
export async function createDraftAcceptanceRecord(
  input: CreateDraftAcceptanceRecordInput
): Promise<AcceptanceRecordDraft> {
  const workKey = normalizedWorkKey(input.workKey);
  const recordId = changeRecordId({
    workspaceId: input.workspaceId,
    repo: input.repo,
    workKey,
  });
  const contractId = acceptanceContractId({ recordId, version: 1 });
  const sourceReferences = normalizeSourceReferences(input.sourceReferences);
  const lockKey = `acceptance-record:${input.workspaceId}:${input.repo}:${workKey}`;

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
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
  });
}

export type CreateDraftAcceptanceContractInput = {
  recordId: string;
  contract: Record<string, unknown>;
  createdBy: string;
};

/** Stored contracts must not be confirmable while any question is unresolved. */
export function hasOpenAcceptanceQuestions(contract: unknown): boolean {
  if (contract == null || typeof contract !== "object" || Array.isArray(contract)) return true;
  const value = contract as Record<string, unknown>;
  const questions = value.openQuestions ?? value.unresolvedQuestions;
  if (questions === undefined) return false;
  if (!Array.isArray(questions)) return true;
  return questions.some((question) => {
    if (question == null || typeof question !== "object" || Array.isArray(question)) return true;
    return (question as Record<string, unknown>).status !== "resolved";
  });
}

export type AttachExternalPullRequestInput = {
  workspaceId: string;
  recordId: string;
  repo: string;
  repositoryId: string;
  prNumber: number;
  prUrl: string;
  baseSha: string;
  headSha: string;
  attachedBy: string;
  /** Human attachment is the fallback; a correlated GitHub webhook says so. */
  source?: "human_declared" | "github_webhook";
};

/**
 * Bind a user-declared external-agent PR to an existing Acceptance Record.
 * The exact base/head pair is immutable event evidence; later pushes append a
 * new attachment rather than rewriting the reviewed commit.
 */
export async function attachExternalPullRequest(input: AttachExternalPullRequestInput): Promise<{
  record: ChangeRecordRow;
  attachment: ChangeRecordPrRow;
  revision: ChangeRecordPrRevisionRow;
}> {
  const lockKey = `change-record:${input.workspaceId}:${input.repo}`;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const records = await tx
      .select()
      .from(changeRecords)
      .where(and(eq(changeRecords.id, input.recordId), eq(changeRecords.workspaceId, input.workspaceId), eq(changeRecords.repo, input.repo)))
      .limit(1);
    const record = records[0];
    if (!record) throw new Error("Acceptance Record was not found in workspace repository");
    if (record.prNumber != null && record.prNumber !== input.prNumber) {
      throw new Error("Acceptance Record is already bound to a different pull request");
    }
    const rows = await tx
      .update(changeRecords)
      .set({ prNumber: input.prNumber, headShas: normalizeHeadShas([...record.headShas, input.headSha]), updatedAt: new Date() })
      .where(eq(changeRecords.id, input.recordId))
      .returning();
    const attached = rows[0]!;
    const existingAttachments = await tx.select().from(changeRecordPrs).where(
      and(eq(changeRecordPrs.workspaceId, input.workspaceId), eq(changeRecordPrs.repositoryId, input.repositoryId), eq(changeRecordPrs.prNumber, input.prNumber))
    ).limit(1);
    const existingAttachment = existingAttachments[0];
    if (existingAttachment && existingAttachment.recordId !== input.recordId) {
      throw new Error("Pull request is already attached to a different Acceptance Record");
    }
    const attachmentId = existingAttachment?.id ?? changeRecordPrId(input);
    if (!existingAttachment) {
      await tx.insert(changeRecordPrs).values({
        id: attachmentId, recordId: input.recordId, workspaceId: input.workspaceId,
        repositoryId: input.repositoryId, repositoryFullName: input.repo, prNumber: input.prNumber,
        prUrl: input.prUrl, attachedBy: input.attachedBy,
      });
    }
    const attachment = existingAttachment ?? (await tx.select().from(changeRecordPrs).where(eq(changeRecordPrs.id, attachmentId)).limit(1))[0]!;
    const revisionId = changeRecordPrRevisionId({ prAttachmentId: attachment.id, headSha: input.headSha });
    const existingRevisions = await tx.select().from(changeRecordPrRevisions)
      .where(eq(changeRecordPrRevisions.id, revisionId)).limit(1);
    let revision = existingRevisions[0];
    if (!revision) {
      await tx.update(changeRecordPrRevisions).set({ supersededAt: new Date() }).where(
        and(eq(changeRecordPrRevisions.prAttachmentId, attachment.id), sql`${changeRecordPrRevisions.supersededAt} IS NULL`)
      );
      const inserted = await tx.insert(changeRecordPrRevisions).values({
        id: revisionId, prAttachmentId: attachment.id, headSha: input.headSha,
        source: input.source ?? "human_declared",
      }).returning();
      revision = inserted[0]!;
    }
    await appendContractEventInTransaction(tx, {
      recordId: input.recordId,
      eventKey: `external-pr:${input.prNumber}:${input.headSha}`,
      stage: "external_pr",
      actor: input.attachedBy,
      payloadRef: {
        kind: "external_pull_request", repo: input.repo, prNumber: input.prNumber, prUrl: input.prUrl,
        baseSha: input.baseSha, headSha: input.headSha, source: input.source ?? "human_declared",
      },
    });
    return { record: attached, attachment, revision };
  });
}

export type CreateAcceptanceBuilderHandoffInput = {
  workspaceId: string;
  recordId: string;
  repositoryId: string;
  builder: string;
  taskContextKey: string;
  branchName: string;
  contractId: string;
  contractVersion: number;
  contextPackId: string;
  createdBy: string;
};

export type EnqueueAcceptanceContextPackCompilationInput = {
  workspaceId: string;
  recordId: string;
  repositoryId: string;
  contractId: string;
  contractVersion: number;
  phase: "plan" | "execute" | "verify" | "review";
  createdBy: string;
};

/**
 * Admits exactly one compiler job for a confirmed contract and its connected
 * repository. The ref is copied from the connected repository inside this
 * transaction; callers cannot supply a branch or source payload.
 */
export async function enqueueAcceptanceContextPackCompilation(
  input: EnqueueAcceptanceContextPackCompilationInput
): Promise<{ compilation: AcceptanceContextPackCompilationRow; inserted: boolean }> {
  const id = acceptanceContextPackCompilationId({
    recordId: input.recordId,
    acceptanceContractId: input.contractId,
    acceptanceContractVersion: input.contractVersion,
    repositoryId: input.repositoryId,
    phase: input.phase,
  });
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`acceptance-context-pack-compilation:${id}`}))`);
    const binding = await tx.select({ repositoryRef: repositories.defaultBranch })
      .from(changeRecords)
      .innerJoin(acceptanceContracts, eq(acceptanceContracts.recordId, changeRecords.id))
      .innerJoin(repositories, and(
        eq(repositories.id, input.repositoryId),
        eq(repositories.workspaceId, input.workspaceId),
        eq(repositories.name, changeRecords.repo)
      ))
      .where(and(
        eq(changeRecords.id, input.recordId),
        eq(changeRecords.workspaceId, input.workspaceId),
        eq(acceptanceContracts.id, input.contractId),
        eq(acceptanceContracts.version, input.contractVersion),
        eq(acceptanceContracts.status, "confirmed")
      ))
      .limit(1);
    if (!binding[0]) {
      throw new Error("Confirmed Acceptance Contract and connected repository must be bound to the Acceptance Record");
    }
    const existing = await tx.select().from(acceptanceContextPackCompilations)
      .where(eq(acceptanceContextPackCompilations.id, id)).limit(1);
    if (existing[0]) return { compilation: existing[0], inserted: false };
    const rows = await tx.insert(acceptanceContextPackCompilations).values({
      id,
      workspaceId: input.workspaceId,
      recordId: input.recordId,
      repositoryId: input.repositoryId,
      repositoryRef: binding[0].repositoryRef,
      acceptanceContractId: input.contractId,
      acceptanceContractVersion: input.contractVersion,
      phase: input.phase,
      createdBy: input.createdBy,
    }).returning();
    const compilation = rows[0]!;
    await appendContractEventInTransaction(tx, {
      recordId: input.recordId,
      eventKey: `acceptance-context-pack-compilation:${compilation.id}`,
      stage: "context_pack_compilation",
      actor: input.createdBy,
      payloadRef: {
        kind: "acceptance_context_pack_compilation",
        compilationId: compilation.id,
        acceptanceContractId: compilation.acceptanceContractId,
        acceptanceContractVersion: compilation.acceptanceContractVersion,
        repositoryId: compilation.repositoryId,
        repositoryRef: compilation.repositoryRef,
        phase: compilation.phase,
      },
    });
    return { compilation, inserted: true };
  });
}

/**
 * Atomically claims the oldest admitted compilation. It returns no source
 * content: only the confirmed contract and the repository/ref the worker must
 * clone into its disposable environment.
 */
export async function claimAcceptanceContextPackCompilation(input: { workerId: string }): Promise<{
  compilation: AcceptanceContextPackCompilationRow;
  repository: { id: string; name: string; url: string | null; ref: string };
  contract: Pick<AcceptanceContractRow, "id" | "version" | "contract">;
} | null> {
  const claimed = Array.from(await db.execute(sql`
    WITH expired AS (
      UPDATE acceptance_context_pack_compilations
      SET status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'queued' END,
          worker_id = NULL,
          claimed_at = NULL,
          reason = CASE WHEN attempts >= 3 THEN 'compiler claim lease expired after 3 attempts' ELSE reason END,
          updated_at = now()
      WHERE status = 'claimed'
        AND claimed_at < now() - interval '15 minutes'
    ),
    candidate AS (
      SELECT id FROM acceptance_context_pack_compilations
      WHERE status = 'queued'
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE acceptance_context_pack_compilations
    SET status = 'claimed', worker_id = ${input.workerId}, claimed_at = now(),
        attempts = attempts + 1, updated_at = now()
    WHERE id = (SELECT id FROM candidate)
    RETURNING id
  `)) as Array<Record<string, unknown>>;
  const id = claimed[0]?.id as string | undefined;
  if (!id) return null;
  const rows = await db.select({
    compilation: acceptanceContextPackCompilations,
    repository: repositories,
    contract: acceptanceContracts,
  })
    .from(acceptanceContextPackCompilations)
    .innerJoin(repositories, eq(acceptanceContextPackCompilations.repositoryId, repositories.id))
    .innerJoin(acceptanceContracts, eq(acceptanceContextPackCompilations.acceptanceContractId, acceptanceContracts.id))
    .where(and(
      eq(acceptanceContextPackCompilations.id, id),
      eq(acceptanceContextPackCompilations.workerId, input.workerId),
      eq(acceptanceContextPackCompilations.status, "claimed"),
      eq(acceptanceContracts.version, acceptanceContextPackCompilations.acceptanceContractVersion),
      eq(acceptanceContracts.status, "confirmed")
    ))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    compilation: row.compilation,
    repository: {
      id: row.repository.id,
      name: row.repository.name,
      url: row.repository.url,
      ref: row.compilation.repositoryRef,
    },
    contract: { id: row.contract.id, version: row.contract.version, contract: row.contract.contract },
  };
}

export type ClaimedAcceptanceContextPackCompilation = {
  compilation: AcceptanceContextPackCompilationRow;
  contract: Pick<AcceptanceContractRow, "id" | "version" | "contract">;
};

/** Read one still-claimed compilation only for its owning worker's report. */
export async function readClaimedAcceptanceContextPackCompilation(input: {
  compilationId: string;
  workerId: string;
}): Promise<ClaimedAcceptanceContextPackCompilation | null> {
  const rows = await db.select({
    compilation: acceptanceContextPackCompilations,
    contract: acceptanceContracts,
  })
    .from(acceptanceContextPackCompilations)
    .innerJoin(acceptanceContracts, eq(acceptanceContextPackCompilations.acceptanceContractId, acceptanceContracts.id))
    .where(and(
      eq(acceptanceContextPackCompilations.id, input.compilationId),
      eq(acceptanceContextPackCompilations.workerId, input.workerId),
      eq(acceptanceContextPackCompilations.status, "claimed"),
      eq(acceptanceContracts.version, acceptanceContextPackCompilations.acceptanceContractVersion),
      eq(acceptanceContracts.status, "confirmed")
    ))
    .limit(1);
  const row = rows[0];
  return row ? {
    compilation: row.compilation,
    contract: { id: row.contract.id, version: row.contract.version, contract: row.contract.contract },
  } : null;
}

/**
 * Terminally records the worker result only if it still owns the claim. A
 * compiled result must point at a Pack that belongs to the exact Record.
 */
export async function reportAcceptanceContextPackCompilation(input: {
  compilationId: string;
  workerId: string;
  status: "compiled" | "not_proven" | "failed";
  contextPackId?: string | null;
  reason?: string | null;
}): Promise<AcceptanceContextPackCompilationRow | null> {
  if (input.status === "compiled" && !input.contextPackId) {
    throw new Error("A compiled Context Pack job requires its recorded Context Pack");
  }
  if (input.status !== "compiled" && input.contextPackId) {
    throw new Error("A failed or not_proven Context Pack job cannot claim a Context Pack");
  }
  return db.transaction(async (tx) => {
    const jobs = await tx.select()
      .from(acceptanceContextPackCompilations)
      .where(and(
        eq(acceptanceContextPackCompilations.id, input.compilationId),
        eq(acceptanceContextPackCompilations.workerId, input.workerId),
        eq(acceptanceContextPackCompilations.status, "claimed")
      ))
      .limit(1);
    const job = jobs[0];
    if (!job) return null;
    if (input.contextPackId) {
      const packs = await tx.select({ id: acceptanceContextPacks.id })
        .from(acceptanceContextPacks)
        .where(and(
          eq(acceptanceContextPacks.id, input.contextPackId),
          eq(acceptanceContextPacks.recordId, job.recordId)
        ))
        .limit(1);
      if (!packs[0]) throw new Error("Compiled Context Pack must belong to the claimed Acceptance Record");
    }
    const rows = await tx.update(acceptanceContextPackCompilations).set({
      status: input.status,
      contextPackId: input.contextPackId ?? null,
      reason: input.reason?.trim() || null,
      updatedAt: new Date(),
    }).where(and(
      eq(acceptanceContextPackCompilations.id, input.compilationId),
      eq(acceptanceContextPackCompilations.workerId, input.workerId),
      eq(acceptanceContextPackCompilations.status, "claimed")
    )).returning();
    const compilation = rows[0] ?? null;
    if (!compilation) return null;
    await appendContractEventInTransaction(tx, {
      recordId: job.recordId,
      eventKey: `acceptance-context-pack-compilation:result:${compilation.id}`,
      stage: "context_pack_compilation",
      actor: `worker:${input.workerId}`,
      payloadRef: {
        kind: "acceptance_context_pack_compilation_result",
        compilationId: compilation.id,
        status: compilation.status,
        contextPackId: compilation.contextPackId,
        reason: compilation.reason,
      },
    });
    return compilation;
  });
}

/**
 * Records the approved builder route before implementation starts. The
 * repository + branch key is intentionally globally unique within a workspace
 * so webhook correlation can fail closed instead of selecting a candidate.
 */
export async function createAcceptanceBuilderHandoff(
  input: CreateAcceptanceBuilderHandoffInput
): Promise<{ handoff: AcceptanceBuilderHandoffRow; inserted: boolean }> {
  const lockKey = `acceptance-builder-handoff:${input.workspaceId}:${input.repositoryId}:${input.branchName}`;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const contract = await tx
      .select({ id: acceptanceContracts.id })
      .from(acceptanceContracts)
      .innerJoin(changeRecords, eq(acceptanceContracts.recordId, changeRecords.id))
      .where(and(
        eq(acceptanceContracts.id, input.contractId),
        eq(acceptanceContracts.recordId, input.recordId),
        eq(acceptanceContracts.version, input.contractVersion),
        eq(acceptanceContracts.status, "confirmed"),
        eq(changeRecords.workspaceId, input.workspaceId)
      ))
      .limit(1);
    if (!contract[0]) throw new Error("Confirmed Acceptance Contract does not match builder handoff");
    const pack = await tx
      .select({ id: acceptanceContextPacks.id })
      .from(acceptanceContextPacks)
      .innerJoin(acceptanceContextPackCompilations, eq(acceptanceContextPackCompilations.contextPackId, acceptanceContextPacks.id))
      .where(and(
        eq(acceptanceContextPacks.id, input.contextPackId),
        eq(acceptanceContextPacks.recordId, input.recordId),
        eq(acceptanceContextPacks.phase, "execute"),
        eq(acceptanceContextPackCompilations.recordId, input.recordId),
        eq(acceptanceContextPackCompilations.repositoryId, input.repositoryId),
        eq(acceptanceContextPackCompilations.acceptanceContractId, input.contractId),
        eq(acceptanceContextPackCompilations.acceptanceContractVersion, input.contractVersion),
        eq(acceptanceContextPackCompilations.phase, "execute"),
        eq(acceptanceContextPackCompilations.status, "compiled")
      ))
      .limit(1);
    if (!pack[0]) throw new Error("A compiled execute Context Pack must match the selected confirmed contract and repository");
    const record = await tx
      .select({ id: changeRecords.id, repo: changeRecords.repo })
      .from(changeRecords)
      .where(and(eq(changeRecords.id, input.recordId), eq(changeRecords.workspaceId, input.workspaceId)))
      .limit(1);
    if (!record[0]) throw new Error("Acceptance Record was not found in workspace");

    const existingTask = await tx.select().from(acceptanceBuilderHandoffs).where(and(
      eq(acceptanceBuilderHandoffs.recordId, input.recordId),
      eq(acceptanceBuilderHandoffs.taskContextKey, input.taskContextKey)
    )).limit(1);
    if (existingTask[0]) return { handoff: existingTask[0], inserted: false };
    const existingBranch = await tx.select().from(acceptanceBuilderHandoffs).where(and(
      eq(acceptanceBuilderHandoffs.workspaceId, input.workspaceId),
      eq(acceptanceBuilderHandoffs.repositoryId, input.repositoryId),
      eq(acceptanceBuilderHandoffs.branchName, input.branchName)
    )).limit(1);
    if (existingBranch[0]) throw new Error("Builder branch is already bound to a different task context");

    const rows = await tx.insert(acceptanceBuilderHandoffs).values({
      id: acceptanceBuilderHandoffId(input), recordId: input.recordId, workspaceId: input.workspaceId,
      repositoryId: input.repositoryId, builder: input.builder, taskContextKey: input.taskContextKey,
      branchName: input.branchName, acceptanceContractId: input.contractId,
      acceptanceContractVersion: input.contractVersion, contextPackId: input.contextPackId,
      createdBy: input.createdBy,
    }).returning();
    const handoff = rows[0]!;
    await appendContractEventInTransaction(tx, {
      recordId: input.recordId,
      eventKey: `builder-handoff:${handoff.id}`,
      stage: "builder_handoff",
      actor: input.createdBy,
      payloadRef: {
        kind: "acceptance_builder_handoff", handoffId: handoff.id, builder: handoff.builder,
        taskContextKey: handoff.taskContextKey, branchName: handoff.branchName,
        acceptanceContractId: handoff.acceptanceContractId,
        acceptanceContractVersion: handoff.acceptanceContractVersion,
        contextPackId: handoff.contextPackId,
      },
    });
    return { handoff, inserted: true };
  });
}

/**
 * Correlates only a pre-recorded builder handoff. `null` means unlinked: the
 * webhook caller must not attach or launch an Acceptance Record review.
 */
export async function findAcceptanceBuilderHandoffForPullRequest(input: {
  workspaceId: string;
  repositoryId: string;
  branchName: string;
}): Promise<AcceptanceBuilderHandoffRow | null> {
  const rows = await db.select().from(acceptanceBuilderHandoffs).where(and(
    eq(acceptanceBuilderHandoffs.workspaceId, input.workspaceId),
    eq(acceptanceBuilderHandoffs.repositoryId, input.repositoryId),
    eq(acceptanceBuilderHandoffs.branchName, input.branchName)
  )).limit(2);
  // The database uniqueness constraint makes >1 impossible in a healthy DB;
  // retain the guard so corrupted legacy data still fails closed.
  return rows.length === 1 ? rows[0]! : null;
}

export type AcceptanceBuilderTaskRead = {
  handoff: {
    id: string;
    recordId: string;
    workspaceId: string;
    repositoryId: string;
    builder: string;
    taskContextKey: string;
    branchName: string;
    status: string;
    createdAt: Date;
    prAttachedAt: Date | null;
  };
  record: {
    id: string;
    repo: string;
    originChannel: string | null;
    sourceReferences: Record<string, unknown>[];
  };
  contract: {
    id: string;
    version: number;
    status: string;
    contract: Record<string, unknown>;
    confirmedAt: Date | null;
  };
  contextPack: {
    id: string;
    version: number;
    phase: string;
    contentHash: string;
    compilerVersion: string;
    manifest: Record<string, unknown>;
    custody: Record<string, unknown>;
    freshness: Record<string, unknown>;
    jsonArtifactRef: string | null;
    markdownArtifactRef: string | null;
  };
};

/**
 * Resolve exactly one recorded builder task and its selected trust artifacts.
 * The joins intentionally revalidate workspace/record ownership, the
 * handoff-selected contract/version, confirmation, and selected pack. No
 * artifact content is read here; callers receive durable metadata and refs.
 */
export async function readAcceptanceBuilderTask(input: {
  workspaceId: string;
  builder: string;
  taskContextKey: string;
}): Promise<AcceptanceBuilderTaskRead | null> {
  const builder = input.builder.trim().toLowerCase();
  if (!builder || !input.taskContextKey) return null;

  const rows = await db
    .select({
      handoff: acceptanceBuilderHandoffs,
      record: changeRecords,
      contract: acceptanceContracts,
      contextPack: acceptanceContextPacks,
    })
    .from(acceptanceBuilderHandoffs)
    .innerJoin(changeRecords, and(
      eq(acceptanceBuilderHandoffs.recordId, changeRecords.id),
      eq(acceptanceBuilderHandoffs.workspaceId, changeRecords.workspaceId),
      eq(changeRecords.workspaceId, input.workspaceId),
    ))
    .innerJoin(acceptanceContracts, and(
      eq(acceptanceContracts.id, acceptanceBuilderHandoffs.acceptanceContractId),
      eq(acceptanceContracts.recordId, changeRecords.id),
      eq(acceptanceContracts.version, acceptanceBuilderHandoffs.acceptanceContractVersion),
      eq(acceptanceContracts.status, "confirmed"),
    ))
    .innerJoin(acceptanceContextPacks, and(
      eq(acceptanceContextPacks.id, acceptanceBuilderHandoffs.contextPackId),
      eq(acceptanceContextPacks.recordId, changeRecords.id),
    ))
    .where(and(
      eq(acceptanceBuilderHandoffs.workspaceId, input.workspaceId),
      sql`lower(trim(${acceptanceBuilderHandoffs.builder})) = ${builder}`,
      eq(acceptanceBuilderHandoffs.taskContextKey, input.taskContextKey),
    ))
    .limit(2);

  if (rows.length !== 1) return null;
  const row = rows[0]!;
  return {
    handoff: {
      id: row.handoff.id,
      recordId: row.handoff.recordId,
      workspaceId: row.handoff.workspaceId,
      repositoryId: row.handoff.repositoryId,
      builder: row.handoff.builder,
      taskContextKey: row.handoff.taskContextKey,
      branchName: row.handoff.branchName,
      status: row.handoff.status,
      createdAt: row.handoff.createdAt,
      prAttachedAt: row.handoff.prAttachedAt,
    },
    record: {
      id: row.record.id,
      repo: row.record.repo,
      originChannel: row.record.originChannel,
      sourceReferences: row.record.sourceReferences,
    },
    contract: {
      id: row.contract.id,
      version: row.contract.version,
      status: row.contract.status,
      contract: row.contract.contract,
      confirmedAt: row.contract.confirmedAt,
    },
    contextPack: {
      id: row.contextPack.id,
      version: row.contextPack.version,
      phase: row.contextPack.phase,
      contentHash: row.contextPack.contentHash,
      compilerVersion: row.contextPack.compilerVersion,
      manifest: row.contextPack.manifest,
      custody: row.contextPack.custody,
      freshness: row.contextPack.freshness,
      jsonArtifactRef: row.contextPack.jsonArtifactRef,
      markdownArtifactRef: row.contextPack.markdownArtifactRef,
    },
  };
}

/** Resolve only one recorded, PR-attached builder task for this current revision. */
export async function findAcceptanceBuilderHandoffForPrRevision(input: {
  workspaceId: string; recordId: string; prRevisionId: string;
}): Promise<AcceptanceBuilderHandoffRow | null> {
  const rows = await db.select({ handoff: acceptanceBuilderHandoffs })
    .from(changeRecordPrRevisions)
    .innerJoin(changeRecordPrs, eq(changeRecordPrRevisions.prAttachmentId, changeRecordPrs.id))
    .innerJoin(acceptanceBuilderHandoffs, and(
      eq(acceptanceBuilderHandoffs.recordId, changeRecordPrs.recordId),
      eq(acceptanceBuilderHandoffs.repositoryId, changeRecordPrs.repositoryId),
    ))
    .where(and(
      eq(changeRecordPrRevisions.id, input.prRevisionId),
      eq(changeRecordPrs.workspaceId, input.workspaceId),
      eq(changeRecordPrs.recordId, input.recordId),
      eq(acceptanceBuilderHandoffs.workspaceId, input.workspaceId),
      eq(acceptanceBuilderHandoffs.status, "pr_attached"),
      isNull(changeRecordPrRevisions.supersededAt),
    ))
    .limit(2);
  return rows.length === 1 ? rows[0]!.handoff : null;
}

export async function markAcceptanceBuilderHandoffPrAttached(input: {
  handoffId: string;
  workspaceId: string;
}): Promise<void> {
  await db.update(acceptanceBuilderHandoffs).set({ status: "pr_attached", prAttachedAt: new Date() }).where(and(
    eq(acceptanceBuilderHandoffs.id, input.handoffId),
    eq(acceptanceBuilderHandoffs.workspaceId, input.workspaceId)
  ));
}

export type RecordEvidenceReviewInput = {
  workspaceId: string; recordId: string; prRevisionId: string; headSha: string;
  contractId: string; contractVersion: number; overallStatus: string;
  diffIdentity: Record<string, unknown>; staticFindings: Record<string, unknown>[];
  testResults: Record<string, unknown>[]; independentVerifier: Record<string, unknown>;
  reviewabilityResult: Record<string, unknown>; environmentRung: string; refusalReason?: string | null;
  verifierName: string; verifierVersion: string; promptVersion: string;
  criteria: Array<{ criterionId: string; criterionTextSnapshot: string; required: boolean; status: string; observedBehavior: string; expectedBehavior: string; evidenceRefs: Record<string, unknown>[]; runtimeEvidence: Record<string, unknown>[]; reason: string }>;
  corrections: Array<{ criterionId?: string | null; observedBehavior: string; expectedBehavior: string; evidenceRefs: Record<string, unknown>[]; reproductionSteps?: string[]; likelyAffectedUnits?: string[]; contextRefs?: Record<string, unknown>[]; scopeBoundary: string; concreteImpact: string; requiredCorrection: string; reverification: string; repairPath?: string | null }>;
};

/** The recorded human decision never changes Jace's independent verdict. */
export type AcceptancePrDecision =
  | "approved"
  | "changes_requested"
  | "rejected"
  | "approved_with_exception";

const ACCEPTANCE_PR_DECISIONS = new Set<AcceptancePrDecision>([
  "approved",
  "changes_requested",
  "rejected",
  "approved_with_exception",
]);

export function validateAcceptancePrDecision(input: {
  decision: unknown;
  rationale?: unknown;
}): input is { decision: AcceptancePrDecision; rationale?: string } {
  if (typeof input.decision !== "string" || !ACCEPTANCE_PR_DECISIONS.has(input.decision as AcceptancePrDecision)) {
    return false;
  }
  const rationale = input.rationale;
  if (rationale !== undefined && (typeof rationale !== "string" || rationale.trim().length > 4_000)) {
    return false;
  }
  return input.decision !== "approved_with_exception" || (typeof rationale === "string" && rationale.trim().length > 0);
}

export type AcceptanceEvidenceReviewSummary = {
  id: string;
  prRevisionId: string;
  headSha: string;
  repositoryFullName: string;
  prNumber: number;
  overallStatus: string;
  contractId: string;
  contractVersion: number;
  createdAt: Date;
  supersededAt: Date | null;
};

/**
 * The Console needs the immutable review identity before a human can make a
 * final decision. This is intentionally a summary: criteria and correction
 * packets remain on their evidence-specific surfaces.
 */
export async function readAcceptanceEvidenceReviewSummaries(input: {
  workspaceId: string;
  recordId: string;
}): Promise<AcceptanceEvidenceReviewSummary[]> {
  const rows = await db
    .select({
      review: evidenceReviews,
      revision: changeRecordPrRevisions,
      attachment: changeRecordPrs,
    })
    .from(evidenceReviews)
    .innerJoin(changeRecordPrRevisions, eq(evidenceReviews.prRevisionId, changeRecordPrRevisions.id))
    .innerJoin(changeRecordPrs, eq(changeRecordPrRevisions.prAttachmentId, changeRecordPrs.id))
    .where(and(
      eq(evidenceReviews.recordId, input.recordId),
      eq(changeRecordPrs.workspaceId, input.workspaceId),
      eq(changeRecordPrs.recordId, input.recordId),
    ))
    .orderBy(desc(evidenceReviews.createdAt));
  return rows.map((row) => ({
    id: row.review.id,
    prRevisionId: row.review.prRevisionId,
    headSha: row.review.headSha,
    repositoryFullName: row.attachment.repositoryFullName,
    prNumber: row.attachment.prNumber,
    overallStatus: row.review.overallStatus,
    contractId: row.review.acceptanceContractId,
    contractVersion: row.review.acceptanceContractVersion,
    createdAt: row.review.createdAt,
    supersededAt: row.revision.supersededAt,
  }));
}

export type RecordAcceptancePrDecisionInput = {
  workspaceId: string;
  recordId: string;
  reviewId: string;
  decision: AcceptancePrDecision;
  rationale?: string;
  decidedBy: string;
  decidedAt?: Date;
};

/**
 * Append the final human PR decision only for the current exact-head review.
 * A normal approval is impossible while Jace's review is anything but
 * `proven`; a human may still make a deliberate, explained exception without
 * overwriting or relabelling the independent evidence.
 */
export async function recordAcceptancePrDecision(
  input: RecordAcceptancePrDecisionInput
): Promise<{ event: ChangeRecordEventRow; inserted: boolean }> {
  if (!validateAcceptancePrDecision(input)) {
    throw new Error("Invalid Acceptance Record PR decision");
  }
  const eventKey = `acceptance-pr-decision:${input.reviewId}`;
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        review: evidenceReviews,
        revision: changeRecordPrRevisions,
        attachment: changeRecordPrs,
      })
      .from(evidenceReviews)
      .innerJoin(changeRecordPrRevisions, eq(evidenceReviews.prRevisionId, changeRecordPrRevisions.id))
      .innerJoin(changeRecordPrs, eq(changeRecordPrRevisions.prAttachmentId, changeRecordPrs.id))
      .where(and(
        eq(evidenceReviews.id, input.reviewId),
        eq(evidenceReviews.recordId, input.recordId),
        eq(changeRecordPrs.workspaceId, input.workspaceId),
        eq(changeRecordPrs.recordId, input.recordId),
        isNull(changeRecordPrRevisions.supersededAt),
      ))
      .limit(1);
    const review = rows[0];
    if (!review) throw new Error("Evidence review is missing, outside this Acceptance Record, or no longer current");
    if (input.decision === "approved" && review.review.overallStatus !== "proven") {
      throw new Error("Only a proven exact-head review can be approved without an explicit exception");
    }

    const at = input.decidedAt ?? new Date();
    const payloadRef = {
      kind: "acceptance_pr_decision",
      decision: input.decision,
      reviewId: review.review.id,
      prRevisionId: review.review.prRevisionId,
      headSha: review.review.headSha,
      repository: review.attachment.repositoryFullName,
      prNumber: review.attachment.prNumber,
      reviewOverallStatus: review.review.overallStatus,
      ...(input.rationale?.trim() ? { rationale: input.rationale.trim() } : {}),
    };
    const inserted = Array.from(await tx.execute(sql`
      INSERT INTO change_record_events (
        id, record_id, event_key, stage, at, actor, payload_ref
      ) VALUES (
        ${changeRecordEventId({ recordId: input.recordId, eventKey })},
        ${input.recordId}, ${eventKey}, 'human_pr_decision',
        ${at.toISOString()}, ${input.decidedBy}, ${JSON.stringify(payloadRef)}::jsonb
      )
      ON CONFLICT (record_id, event_key) DO NOTHING
      RETURNING *
    `)) as Array<Record<string, unknown>>;
    const raw = inserted[0] ?? (await tx.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, input.recordId),
      eq(changeRecordEvents.eventKey, eventKey),
    )).limit(1))[0];
    if (!raw) throw new Error("Acceptance Record PR decision was not recorded");
    return {
      event: mapChangeRecordEventRow(raw as Record<string, unknown>),
      inserted: Boolean(inserted[0]),
    };
  });
}

export type RecordEvidenceVerificationPlansInput = {
  workspaceId: string;
  recordId: string;
  prRevisionId: string;
  contractId: string;
  contractVersion: number;
  plannedBy: string;
  plans: Array<{
    criterionId: string;
    criterionTextSnapshot: string;
    modality: string;
    environmentId?: string | null;
    flow?: string | null;
    apiRequest?: { method: "GET"; path: string; expectedStatus: number } | null;
    expectedBehavior: string;
    status: "planned" | "not_testable";
    notTestableReason?: string | null;
  }>;
};

/** Persist plans only for the current exact PR head and confirmed contract. */
export async function recordEvidenceVerificationPlans(input: RecordEvidenceVerificationPlansInput): Promise<{
  plans: EvidenceVerificationPlanRow[];
  inserted: boolean;
}> {
  return db.transaction(async (tx) => {
    const revisions = await tx.select({ revision: changeRecordPrRevisions })
      .from(changeRecordPrRevisions)
      .innerJoin(changeRecordPrs, eq(changeRecordPrRevisions.prAttachmentId, changeRecordPrs.id))
      .where(and(
        eq(changeRecordPrRevisions.id, input.prRevisionId),
        eq(changeRecordPrs.recordId, input.recordId),
        eq(changeRecordPrs.workspaceId, input.workspaceId),
        sql`${changeRecordPrRevisions.supersededAt} IS NULL`
      )).limit(1);
    if (!revisions[0]) throw new Error("PR revision is missing or superseded");
    const contracts = await tx.select({ id: acceptanceContracts.id })
      .from(acceptanceContracts)
      .where(and(
        eq(acceptanceContracts.id, input.contractId),
        eq(acceptanceContracts.recordId, input.recordId),
        eq(acceptanceContracts.version, input.contractVersion),
        eq(acceptanceContracts.status, "confirmed")
      )).limit(1);
    if (!contracts[0]) throw new Error("Confirmed Acceptance Contract does not match verification plan");
    const ids = input.plans.map((plan) => evidenceVerificationPlanId({ prRevisionId: input.prRevisionId, criterionId: plan.criterionId }));
    const existing = ids.length === 0 ? [] : await tx.select().from(evidenceVerificationPlans)
      .where(sql`${evidenceVerificationPlans.id} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
    if (existing.length) return { plans: existing, inserted: false };
    const rows = await tx.insert(evidenceVerificationPlans).values(input.plans.map((plan) => ({
      id: evidenceVerificationPlanId({ prRevisionId: input.prRevisionId, criterionId: plan.criterionId }),
      recordId: input.recordId, prRevisionId: input.prRevisionId,
      acceptanceContractId: input.contractId, acceptanceContractVersion: input.contractVersion,
      criterionId: plan.criterionId, criterionTextSnapshot: plan.criterionTextSnapshot,
      modality: plan.modality, environmentId: plan.environmentId ?? null, flow: plan.flow ?? null,
      apiRequest: plan.apiRequest ?? null,
      expectedBehavior: plan.expectedBehavior, status: plan.status,
      notTestableReason: plan.notTestableReason ?? null, plannedBy: input.plannedBy,
    }))).returning();
    return { plans: rows, inserted: true };
  });
}

/** Resolve a current planned criterion of one explicit proof modality. */
export async function resolveEvidenceVerificationPlanForArtifact(input: {
  workspaceId: string;
  recordId: string;
  prRevisionId: string;
  verificationPlanId: string;
  modality?: "ui" | "api";
}): Promise<{
  plan: EvidenceVerificationPlanRow;
  repositoryFullName: string;
  prNumber: number;
  headSha: string;
} | null> {
  const rows = await db.select({
    plan: evidenceVerificationPlans,
    attachment: changeRecordPrs,
    revision: changeRecordPrRevisions,
  })
    .from(evidenceVerificationPlans)
    .innerJoin(changeRecordPrRevisions, eq(evidenceVerificationPlans.prRevisionId, changeRecordPrRevisions.id))
    .innerJoin(changeRecordPrs, eq(changeRecordPrRevisions.prAttachmentId, changeRecordPrs.id))
    .where(and(
      eq(evidenceVerificationPlans.id, input.verificationPlanId),
      eq(evidenceVerificationPlans.recordId, input.recordId),
      eq(evidenceVerificationPlans.prRevisionId, input.prRevisionId),
      input.modality ? eq(evidenceVerificationPlans.modality, input.modality) : sql`${evidenceVerificationPlans.modality} IN ('ui', 'api')`,
      eq(evidenceVerificationPlans.status, "planned"),
      eq(changeRecordPrs.workspaceId, input.workspaceId),
      sql`${changeRecordPrRevisions.supersededAt} IS NULL`
    ))
    .limit(1);
  const row = rows[0];
  return row ? {
    plan: row.plan,
    repositoryFullName: row.attachment.repositoryFullName,
    prNumber: row.attachment.prNumber,
    headSha: row.revision.headSha,
  } : null;
}

/** Queue only a current planned criterion; completion cannot be inferred here. */
export async function enqueueEvidenceVerificationExecution(input: {
  workspaceId: string;
  recordId: string;
  prRevisionId: string;
  verificationPlanId: string;
}): Promise<{ execution: EvidenceVerificationExecutionRow; inserted: boolean }> {
  const plan = await resolveEvidenceVerificationPlanForArtifact(input);
  if (!plan) throw new Error("Current planned UI or API criterion was not found for this record and PR revision");
  const id = evidenceVerificationExecutionId({ verificationPlanId: plan.plan.id });
  const rows = await db.insert(evidenceVerificationExecutions).values({
    id,
    verificationPlanId: plan.plan.id,
    status: "queued",
  }).onConflictDoNothing().returning();
  if (rows[0]) return { execution: rows[0], inserted: true };
  const existing = await db.select().from(evidenceVerificationExecutions).where(eq(evidenceVerificationExecutions.id, id)).limit(1);
  if (!existing[0]) throw new Error("Verification execution was not recorded");
  return { execution: existing[0], inserted: false };
}

export async function reportEvidenceVerificationExecution(input: {
  executionId: string;
  workerId: string;
  status: "proven" | "not_proven" | "not_testable" | "failed";
  observedBehavior?: string | null;
  artifactIds?: string[];
  resultReason?: string | null;
}): Promise<EvidenceVerificationExecutionRow | null> {
  if (input.status === "proven" && (!input.observedBehavior?.trim() || !input.artifactIds?.length)) {
    throw new Error("A proven criterion requires observed behavior and verification artifacts");
  }
  const rows = await db.select({ execution: evidenceVerificationExecutions, artifact: evidenceVerificationArtifacts })
    .from(evidenceVerificationExecutions)
    .innerJoin(evidenceVerificationArtifacts, eq(evidenceVerificationExecutions.verificationPlanId, evidenceVerificationArtifacts.verificationPlanId))
    .where(and(eq(evidenceVerificationExecutions.id, input.executionId), eq(evidenceVerificationExecutions.workerId, input.workerId)));
  const availableArtifacts = new Set(rows.map((row) => row.artifact.id));
  if (input.status === "proven" && input.artifactIds?.some((id) => !availableArtifacts.has(id))) {
    throw new Error("Every claimed verification artifact must belong to the execution plan");
  }
  const updated = await db.update(evidenceVerificationExecutions).set({
    status: input.status, observedBehavior: input.observedBehavior ?? null,
    artifactIds: input.artifactIds ?? [], resultReason: input.resultReason ?? null, updatedAt: new Date(),
  }).where(and(eq(evidenceVerificationExecutions.id, input.executionId), eq(evidenceVerificationExecutions.workerId, input.workerId), eq(evidenceVerificationExecutions.status, "claimed"))).returning();
  return updated[0] ?? null;
}

export async function claimEvidenceVerificationExecution(input: { workerId: string }): Promise<{
  execution: EvidenceVerificationExecutionRow;
  plan: EvidenceVerificationPlanRow;
  repositoryFullName: string;
  prNumber: number;
  headSha: string;
  previewUrl: string | null;
} | null> {
  // A queued execution must never be claimed before its exact-head preview is
  // actually ready.  A boot in pending/claimed/booting is a transient state,
  // not evidence that the criterion is untestable.  Conversely, a superseded
  // revision or a missing/terminal preview can never become runnable, so close
  // it honestly before selecting work rather than leaving a permanent queued
  // row for a worker to rediscover forever.
  await db.execute(sql`
    UPDATE evidence_verification_executions AS execution
    SET status = 'not_testable',
        result_reason = 'Exact PR head was superseded or its safe preview became unavailable before execution',
        updated_at = now()
    FROM evidence_verification_plans AS plan
    INNER JOIN change_record_pr_revisions AS revision ON revision.id = plan.pr_revision_id
    INNER JOIN change_record_prs AS attachment ON attachment.id = revision.pr_attachment_id
    LEFT JOIN preview_boots AS preview ON preview.id = plan.environment_id
    WHERE execution.verification_plan_id = plan.id
      AND execution.status = 'queued'
      AND (
        revision.superseded_at IS NOT NULL
        OR preview.id IS NULL
        OR preview.workspace_id <> attachment.workspace_id
        OR preview.repo <> attachment.repository_full_name
        OR preview.pr_number <> attachment.pr_number
        OR preview.head_sha <> revision.head_sha
        OR preview.status IN ('failed', 'torn_down')
      )
  `);
  const claimed = Array.from(await db.execute(sql`
    UPDATE evidence_verification_executions
    SET status = 'claimed', worker_id = ${input.workerId}, claimed_at = now(), updated_at = now()
    WHERE id = (
      SELECT execution.id
      FROM evidence_verification_executions AS execution
      INNER JOIN evidence_verification_plans AS plan ON plan.id = execution.verification_plan_id
      INNER JOIN change_record_pr_revisions AS revision ON revision.id = plan.pr_revision_id
      INNER JOIN change_record_prs AS attachment ON attachment.id = revision.pr_attachment_id
      INNER JOIN preview_boots AS preview ON preview.id = plan.environment_id
      WHERE execution.status = 'queued'
        AND plan.status = 'planned'
        AND plan.modality IN ('ui', 'api')
        AND revision.superseded_at IS NULL
        AND preview.workspace_id = attachment.workspace_id
        AND preview.repo = attachment.repository_full_name
        AND preview.pr_number = attachment.pr_number
        AND preview.head_sha = revision.head_sha
        AND preview.status = 'ready'
        AND preview.url IS NOT NULL
      ORDER BY execution.created_at ASC
      LIMIT 1
      FOR UPDATE OF execution SKIP LOCKED
    )
    RETURNING id
  `)) as Array<Record<string, unknown>>;
  const id = claimed[0]?.id as string | undefined;
  if (!id) return null;
  const rows = await db.select({ execution: evidenceVerificationExecutions, plan: evidenceVerificationPlans, attachment: changeRecordPrs, revision: changeRecordPrRevisions })
    .from(evidenceVerificationExecutions)
    .innerJoin(evidenceVerificationPlans, eq(evidenceVerificationExecutions.verificationPlanId, evidenceVerificationPlans.id))
    .innerJoin(changeRecordPrRevisions, eq(evidenceVerificationPlans.prRevisionId, changeRecordPrRevisions.id))
    .innerJoin(changeRecordPrs, eq(changeRecordPrRevisions.prAttachmentId, changeRecordPrs.id))
    .where(and(eq(evidenceVerificationExecutions.id, id), eq(evidenceVerificationExecutions.workerId, input.workerId), sql`${changeRecordPrRevisions.supersededAt} IS NULL`)).limit(1);
  const row = rows[0];
  if (!row) {
    // A push/teardown can win the race after the guarded UPDATE but before the
    // read projection.  Do not strand that claim forever; it can no longer be
    // proved on the exact head, so record the terminal honest outcome.
    await db.update(evidenceVerificationExecutions).set({
      status: "not_testable",
      resultReason: "Exact PR head or safe preview changed while execution was being claimed",
      updatedAt: new Date(),
    }).where(and(
      eq(evidenceVerificationExecutions.id, id),
      eq(evidenceVerificationExecutions.workerId, input.workerId),
      eq(evidenceVerificationExecutions.status, "claimed"),
    ));
    return null;
  }
  const previews = row.plan.environmentId ? await db.select({ url: previewBoots.url })
    .from(previewBoots)
    .where(and(eq(previewBoots.id, row.plan.environmentId), eq(previewBoots.workspaceId, row.attachment.workspaceId), eq(previewBoots.repo, row.attachment.repositoryFullName), eq(previewBoots.prNumber, row.attachment.prNumber), eq(previewBoots.headSha, row.revision.headSha), eq(previewBoots.status, "ready")))
    .limit(1) : [];
  return { execution: row.execution, plan: row.plan, repositoryFullName: row.attachment.repositoryFullName, prNumber: row.attachment.prNumber, headSha: row.revision.headSha, previewUrl: previews[0]?.url ?? null };
}

/** Record the immutable reference and digest for a stored UI evidence artifact. */
export async function recordEvidenceVerificationArtifact(input: {
  verificationPlanId: string;
  artifactKey: string;
  contentType: "image/png" | "image/jpeg" | "application/json";
  contentSha256: string;
  collectedBy: string;
}): Promise<EvidenceVerificationArtifactRow> {
  const rows = await db.insert(evidenceVerificationArtifacts).values({
    id: randomUUID(),
    verificationPlanId: input.verificationPlanId,
    artifactKey: input.artifactKey,
    contentType: input.contentType,
    contentSha256: input.contentSha256,
    collectedBy: input.collectedBy,
  }).returning();
  return rows[0]!;
}

/** Persist a fully validated review only when its exact revision is current. */
export async function recordEvidenceReview(input: RecordEvidenceReviewInput) {
  const id = evidenceReviewId(input);
  return db.transaction(async (tx) => {
    const revisions = await tx.select({ revision: changeRecordPrRevisions, attachment: changeRecordPrs })
      .from(changeRecordPrRevisions).innerJoin(changeRecordPrs, eq(changeRecordPrRevisions.prAttachmentId, changeRecordPrs.id))
      .where(and(eq(changeRecordPrRevisions.id, input.prRevisionId), eq(changeRecordPrs.recordId, input.recordId), eq(changeRecordPrs.workspaceId, input.workspaceId)))
      .limit(1);
    const revision = revisions[0];
    if (!revision || revision.revision.headSha !== input.headSha || revision.revision.supersededAt) throw new Error("PR revision is missing, mismatched, or superseded");
    const contracts = await tx.select().from(acceptanceContracts).where(and(eq(acceptanceContracts.id, input.contractId), eq(acceptanceContracts.recordId, input.recordId), eq(acceptanceContracts.version, input.contractVersion), eq(acceptanceContracts.status, "confirmed"))).limit(1);
    if (!contracts[0]) throw new Error("Confirmed Acceptance Contract does not match review");
    const inserted = await tx.insert(evidenceReviews).values({
      id, recordId: input.recordId, prRevisionId: input.prRevisionId, acceptanceContractId: input.contractId,
      acceptanceContractVersion: input.contractVersion, headSha: input.headSha, diffIdentity: input.diffIdentity,
      overallStatus: input.overallStatus, staticFindings: input.staticFindings, testResults: input.testResults,
      independentVerifier: input.independentVerifier, reviewabilityResult: input.reviewabilityResult,
      environmentRung: input.environmentRung, refusalReason: input.refusalReason ?? null,
      verifierName: input.verifierName, verifierVersion: input.verifierVersion, promptVersion: input.promptVersion,
    }).onConflictDoNothing().returning();
    if (!inserted[0]) {
      const corrections = await tx.select().from(evidenceReviewCorrections)
        .where(eq(evidenceReviewCorrections.reviewId, id));
      return { id, inserted: false, corrections };
    }
    await tx.insert(evidenceReviewCriteria).values(input.criteria.map((criterion) => ({
      id: randomUUID(), reviewId: id, ...criterion,
    })));
    const corrections = input.corrections.length ? await tx.insert(evidenceReviewCorrections).values(input.corrections.map((correction) => ({
      id: randomUUID(), reviewId: id, criterionId: correction.criterionId ?? null,
      observedBehavior: correction.observedBehavior, expectedBehavior: correction.expectedBehavior,
      evidenceRefs: correction.evidenceRefs, reproductionSteps: correction.reproductionSteps ?? [],
      likelyAffectedUnits: correction.likelyAffectedUnits ?? [], contextRefs: correction.contextRefs ?? [], scopeBoundary: correction.scopeBoundary,
      concreteImpact: correction.concreteImpact, requiredCorrection: correction.requiredCorrection,
      reverification: correction.reverification, repairPath: correction.repairPath ?? null,
    }))).returning() : [];
    return { id, inserted: true, corrections };
  });
}

export async function queueEvidenceReviewCorrectionDelivery(input: {
  workspaceId: string; recordId: string; correctionId: string; deliveryKey: string; channel: string; target: Record<string, unknown>;
}) {
  const id = correctionDeliveryId(input);
  return db.transaction(async (tx) => {
    if (input.channel === "mcp_task_context") {
      const builder = typeof input.target.builder === "string" ? input.target.builder : "";
      const taskContextKey = typeof input.target.taskContextKey === "string" ? input.target.taskContextKey : "";
      const handoff = await tx.select({ id: acceptanceBuilderHandoffs.id })
        .from(acceptanceBuilderHandoffs)
        .where(and(
          eq(acceptanceBuilderHandoffs.workspaceId, input.workspaceId),
          eq(acceptanceBuilderHandoffs.recordId, input.recordId),
          eq(acceptanceBuilderHandoffs.builder, builder),
          eq(acceptanceBuilderHandoffs.taskContextKey, taskContextKey),
        ))
        .limit(1);
      if (!handoff[0]) throw new Error("Correction delivery target does not match the recorded builder handoff");
    }
    const scoped = await tx.select({ review: evidenceReviews, record: changeRecords })
      .from(evidenceReviewCorrections)
      .innerJoin(evidenceReviews, eq(evidenceReviewCorrections.reviewId, evidenceReviews.id))
      .innerJoin(changeRecords, eq(evidenceReviews.recordId, changeRecords.id))
      .where(and(
        eq(evidenceReviewCorrections.id, input.correctionId),
        eq(changeRecords.workspaceId, input.workspaceId),
        eq(evidenceReviews.recordId, input.recordId)
      ))
      .limit(1);
    const item = scoped[0];
    if (!item) throw new Error("Correction packet was not found in workspace");
    const inserted = await tx.insert(evidenceReviewCorrectionDeliveries).values({
      id, correctionId: input.correctionId, deliveryKey: input.deliveryKey, channel: input.channel,
      target: input.target, reviewRevisionId: item.review.prRevisionId, attempt: 0, outcome: "queued",
    }).onConflictDoNothing().returning();
    return { id, inserted: Boolean(inserted[0]), reviewRevisionId: item.review.prRevisionId };
  });
}

/**
 * Durable correction inbox for one recorded external-builder task context.
 * Reading a packet does not acknowledge it or claim that the builder resumed.
 */
export async function readEvidenceReviewCorrectionDeliveriesForTask(input: {
  workspaceId: string; builder: string; taskContextKey: string;
}) {
  const rows = await db.select({
    delivery: evidenceReviewCorrectionDeliveries,
    correction: evidenceReviewCorrections,
    review: evidenceReviews,
    criterion: evidenceReviewCriteria,
    revision: changeRecordPrRevisions,
    pr: changeRecordPrs,
  }).from(evidenceReviewCorrectionDeliveries)
    .innerJoin(evidenceReviewCorrections, eq(evidenceReviewCorrectionDeliveries.correctionId, evidenceReviewCorrections.id))
    .innerJoin(evidenceReviews, eq(evidenceReviewCorrections.reviewId, evidenceReviews.id))
    .leftJoin(evidenceReviewCriteria, and(
      eq(evidenceReviewCriteria.reviewId, evidenceReviews.id),
      eq(evidenceReviewCriteria.criterionId, evidenceReviewCorrections.criterionId),
    ))
    .innerJoin(changeRecordPrRevisions, eq(evidenceReviewCorrectionDeliveries.reviewRevisionId, changeRecordPrRevisions.id))
    .innerJoin(changeRecordPrs, eq(changeRecordPrRevisions.prAttachmentId, changeRecordPrs.id))
    .where(and(
      eq(evidenceReviewCorrectionDeliveries.channel, "mcp_task_context"),
      eq(changeRecordPrs.workspaceId, input.workspaceId),
      eq(evidenceReviews.recordId, changeRecordPrs.recordId),
      sql`${evidenceReviewCorrectionDeliveries.target}->>'builder' = ${input.builder}`,
      sql`${evidenceReviewCorrectionDeliveries.target}->>'taskContextKey' = ${input.taskContextKey}`,
    ))
    .orderBy(asc(evidenceReviewCorrectionDeliveries.queuedAt));
  return rows;
}

/**
 * Atomically reserves one current-head GitHub fallback delivery. The caller
 * must report the actual carrier result with `report...GithubDispatch`.
 */
export async function claimEvidenceReviewCorrectionDeliveryForGithubDispatch(input: {
  workspaceId: string; deliveryId: string;
}) {
  return db.transaction(async (tx) => {
    const rows = await tx.select({
      delivery: evidenceReviewCorrectionDeliveries,
      correction: evidenceReviewCorrections,
      review: evidenceReviews,
      criterion: evidenceReviewCriteria,
      revision: changeRecordPrRevisions,
      pr: changeRecordPrs,
    }).from(evidenceReviewCorrectionDeliveries)
      .innerJoin(evidenceReviewCorrections, eq(evidenceReviewCorrectionDeliveries.correctionId, evidenceReviewCorrections.id))
      .innerJoin(evidenceReviews, eq(evidenceReviewCorrections.reviewId, evidenceReviews.id))
      .leftJoin(evidenceReviewCriteria, and(
        eq(evidenceReviewCriteria.reviewId, evidenceReviews.id),
        eq(evidenceReviewCriteria.criterionId, evidenceReviewCorrections.criterionId),
      ))
      .innerJoin(changeRecordPrRevisions, eq(evidenceReviewCorrectionDeliveries.reviewRevisionId, changeRecordPrRevisions.id))
      .innerJoin(changeRecordPrs, eq(changeRecordPrRevisions.prAttachmentId, changeRecordPrs.id))
      .where(and(
        eq(evidenceReviewCorrectionDeliveries.id, input.deliveryId),
        eq(evidenceReviewCorrectionDeliveries.channel, "github_pull_request"),
        eq(evidenceReviewCorrectionDeliveries.outcome, "queued"),
        eq(changeRecordPrs.workspaceId, input.workspaceId),
        eq(evidenceReviews.recordId, changeRecordPrs.recordId),
        isNull(changeRecordPrRevisions.supersededAt),
      ))
      .limit(1);
    const item = rows[0];
    if (!item) return null;
    const now = new Date();
    const updated = await tx.update(evidenceReviewCorrectionDeliveries).set({
      outcome: "dispatching", attempt: sql`${evidenceReviewCorrectionDeliveries.attempt} + 1`, attemptedAt: now,
    }).where(and(
      eq(evidenceReviewCorrectionDeliveries.id, item.delivery.id),
      eq(evidenceReviewCorrectionDeliveries.outcome, "queued"),
    )).returning({ id: evidenceReviewCorrectionDeliveries.id, attempt: evidenceReviewCorrectionDeliveries.attempt });
    if (!updated[0]) return null;
    return { ...item, attempt: updated[0].attempt };
  });
}

/** Records a real GitHub carrier result; it cannot acknowledge or merge anything. */
export async function reportEvidenceReviewCorrectionGithubDispatch(input: {
  workspaceId: string; deliveryId: string; reviewRevisionId: string;
  outcome: "delivered" | "failed"; detail?: string | null;
}) {
  const rows = await db.update(evidenceReviewCorrectionDeliveries).set({
    outcome: input.outcome, outcomeDetail: input.detail ?? null,
  }).where(and(
    eq(evidenceReviewCorrectionDeliveries.id, input.deliveryId),
    eq(evidenceReviewCorrectionDeliveries.reviewRevisionId, input.reviewRevisionId),
    eq(evidenceReviewCorrectionDeliveries.outcome, "dispatching"),
    sql`EXISTS (
      SELECT 1 FROM evidence_review_corrections c
      JOIN evidence_reviews r ON r.id = c.review_id
      JOIN change_records cr ON cr.id = r.record_id
      WHERE c.id = ${evidenceReviewCorrectionDeliveries.correctionId}
        AND cr.workspace_id = ${input.workspaceId}
    )`,
  )).returning();
  return rows[0] ?? null;
}

/** An agent acknowledgement is the only transition that proves it received a packet. */
export async function acknowledgeEvidenceReviewCorrectionDelivery(input: {
  workspaceId: string; deliveryId: string; detail?: string | null;
}) {
  const rows = await db.update(evidenceReviewCorrectionDeliveries).set({
    outcome: "acknowledged", outcomeDetail: input.detail ?? null, confirmedAt: new Date(),
  }).where(and(
    eq(evidenceReviewCorrectionDeliveries.id, input.deliveryId),
    sql`EXISTS (
      SELECT 1 FROM evidence_review_corrections c
      JOIN evidence_reviews r ON r.id = c.review_id
      JOIN change_records cr ON cr.id = r.record_id
      WHERE c.id = ${evidenceReviewCorrectionDeliveries.correctionId}
        AND cr.workspace_id = ${input.workspaceId}
    )`,
    sql`${evidenceReviewCorrectionDeliveries.confirmedAt} IS NULL`,
  )).returning();
  return rows[0] ?? null;
}

/** Adds a new immutable draft version; confirmed versions are never edited. */
export async function createDraftAcceptanceContract(
  input: CreateDraftAcceptanceContractInput
): Promise<AcceptanceContractRow> {
  const lockKey = `acceptance-contract:${input.recordId}`;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const latest = await tx
      .select()
      .from(acceptanceContracts)
      .where(eq(acceptanceContracts.recordId, input.recordId))
      .orderBy(desc(acceptanceContracts.version))
      .limit(1);
    if (latest[0]?.status === "confirmed") {
      throw new Error("A confirmed Acceptance Contract is immutable");
    }
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

export async function confirmAcceptanceContract(input: {
  workspaceId: string;
  recordId: string;
  version: number;
  confirmedBy: string;
}): Promise<AcceptanceContractRow> {
  const lockKey = `acceptance-contract:${input.recordId}`;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const records = await tx
      .select({ id: changeRecords.id })
      .from(changeRecords)
      .where(
        and(
          eq(changeRecords.id, input.recordId),
          eq(changeRecords.workspaceId, input.workspaceId)
        )
      )
      .limit(1);
    if (!records[0]) {
      throw new Error("Acceptance Record was not found in workspace");
    }
    const confirmed = await tx
      .select()
      .from(acceptanceContracts)
      .where(
        and(
          eq(acceptanceContracts.recordId, input.recordId),
          eq(acceptanceContracts.status, "confirmed")
        )
      )
      .limit(1);
    if (confirmed[0]) {
      if (confirmed[0].version === input.version) return confirmed[0];
      throw new Error("another Acceptance Contract version is already confirmed");
    }

    const draft = await tx
      .select()
      .from(acceptanceContracts)
      .where(
        and(
          eq(acceptanceContracts.recordId, input.recordId),
          eq(acceptanceContracts.version, input.version),
          eq(acceptanceContracts.status, "draft")
        )
      )
      .limit(1);
    if (!draft[0]) {
      throw new Error("Acceptance Contract draft was not found");
    }
    if (hasOpenAcceptanceQuestions(draft[0].contract)) {
      throw new Error("Acceptance Contract cannot be confirmed while open questions remain");
    }

    const rows = await tx
      .update(acceptanceContracts)
      .set({
        status: "confirmed",
        confirmedBy: input.confirmedBy,
        confirmedAt: new Date(),
      })
      .where(
        and(
          eq(acceptanceContracts.recordId, input.recordId),
          eq(acceptanceContracts.version, input.version),
          eq(acceptanceContracts.status, "draft")
        )
      )
      .returning();
    const contract = rows[0];
    if (!contract) throw new Error("Acceptance Contract draft was not found");
    await appendContractEventInTransaction(tx, {
      recordId: input.recordId,
      eventKey: `acceptance-contract:confirmed:${contract.version}`,
      stage: "acceptance_contract",
      actor: input.confirmedBy,
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

function hasSourceContent(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSourceContent);
  if (value == null || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) => {
    const normalized = key.toLowerCase();
    return normalized === "content" || normalized === "fullsource" || hasSourceContent(nested);
  });
}

function assertMetadataOnly(value: Record<string, unknown>, field: string): void {
  if (hasSourceContent(value)) {
    throw new Error(`Acceptance Context Pack ${field} must not contain source content`);
  }
}

export type RecordAcceptanceContextPackInput = {
  workspaceId: string;
  recordId: string;
  phase: "plan" | "execute" | "verify" | "review";
  contentHash: string;
  compilerVersion: string;
  manifest: Record<string, unknown>;
  custody: Record<string, unknown>;
  freshness: Record<string, unknown>;
  jsonArtifactRef?: string | null;
  markdownArtifactRef?: string | null;
  createdBy: string;
};

/**
 * Adds one immutable metadata-only Context Pack version to an Acceptance
 * Record. Same record/content hash is replay-safe; raw source content is
 * rejected before it reaches the central database.
 */
export async function recordAcceptanceContextPack(
  input: RecordAcceptanceContextPackInput
): Promise<{ pack: AcceptanceContextPackRow; inserted: boolean }> {
  if (!/^sha256:[a-f0-9]{64}$/i.test(input.contentHash)) {
    throw new Error("Acceptance Context Pack contentHash must be a sha256 hash");
  }
  assertMetadataOnly(input.manifest, "manifest");
  assertMetadataOnly(input.custody, "custody");
  assertMetadataOnly(input.freshness, "freshness");
  const lockKey = `acceptance-context-pack:${input.recordId}`;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const records = await tx
      .select({ id: changeRecords.id })
      .from(changeRecords)
      .where(
        and(
          eq(changeRecords.workspaceId, input.workspaceId),
          eq(changeRecords.id, input.recordId)
        )
      )
      .limit(1);
    if (!records[0]) throw new Error("Acceptance Record was not found in workspace");

    const existing = await tx
      .select()
      .from(acceptanceContextPacks)
      .where(
        and(
          eq(acceptanceContextPacks.recordId, input.recordId),
          eq(acceptanceContextPacks.contentHash, input.contentHash)
        )
      )
      .limit(1);
    if (existing[0]) return { pack: existing[0], inserted: false };

    const latest = await tx
      .select({ version: acceptanceContextPacks.version })
      .from(acceptanceContextPacks)
      .where(eq(acceptanceContextPacks.recordId, input.recordId))
      .orderBy(desc(acceptanceContextPacks.version))
      .limit(1);
    const version = (latest[0]?.version ?? 0) + 1;
    const rows = await tx
      .insert(acceptanceContextPacks)
      .values({
        id: acceptanceContextPackId({
          recordId: input.recordId,
          contentHash: input.contentHash,
        }),
        recordId: input.recordId,
        version,
        phase: input.phase,
        contentHash: input.contentHash,
        compilerVersion: input.compilerVersion,
        manifest: input.manifest,
        custody: input.custody,
        freshness: input.freshness,
        jsonArtifactRef: input.jsonArtifactRef ?? null,
        markdownArtifactRef: input.markdownArtifactRef ?? null,
        createdBy: input.createdBy,
      })
      .returning();
    const pack = rows[0]!;
    await appendContractEventInTransaction(tx, {
      recordId: input.recordId,
      eventKey: `acceptance-context-pack:built:${pack.version}`,
      stage: "context_pack",
      actor: input.createdBy,
      payloadRef: {
        kind: "acceptance_context_pack",
        contextPackId: pack.id,
        version: pack.version,
        phase: pack.phase,
        contentHash: pack.contentHash,
        compilerVersion: pack.compilerVersion,
      },
    });
    return { pack, inserted: true };
  });
}

export async function readAcceptanceContextPacks(input: {
  workspaceId: string;
  recordId: string;
}): Promise<AcceptanceContextPackRow[] | null> {
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
    .from(acceptanceContextPacks)
    .where(eq(acceptanceContextPacks.recordId, input.recordId))
    .orderBy(desc(acceptanceContextPacks.version));
}

export type RecordAcceptanceContextPackDeliveryInput = {
  workspaceId: string;
  recordId: string;
  contextPackId: string;
  deliveryKey: string;
  method: "mcp" | "copy" | "download" | "local_bridge";
  recipient?: string | null;
  metadata?: Record<string, unknown>;
  deliveredBy: string;
};

/** Records access without confusing context delivery for implementation proof. */
export async function recordAcceptanceContextPackDelivery(
  input: RecordAcceptanceContextPackDeliveryInput
): Promise<{ delivery: AcceptanceContextPackDeliveryRow; inserted: boolean }> {
  const lockKey = `acceptance-context-pack-delivery:${input.contextPackId}:${input.deliveryKey}`;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const packs = await tx
      .select({ id: acceptanceContextPacks.id })
      .from(acceptanceContextPacks)
      .innerJoin(changeRecords, eq(acceptanceContextPacks.recordId, changeRecords.id))
      .where(
        and(
          eq(acceptanceContextPacks.id, input.contextPackId),
          eq(acceptanceContextPacks.recordId, input.recordId),
          eq(changeRecords.workspaceId, input.workspaceId)
        )
      )
      .limit(1);
    if (!packs[0]) throw new Error("Acceptance Context Pack was not found in workspace");

    const existing = await tx
      .select()
      .from(acceptanceContextPackDeliveries)
      .where(
        and(
          eq(acceptanceContextPackDeliveries.contextPackId, input.contextPackId),
          eq(acceptanceContextPackDeliveries.deliveryKey, input.deliveryKey)
        )
      )
      .limit(1);
    if (existing[0]) return { delivery: existing[0], inserted: false };

    const rows = await tx
      .insert(acceptanceContextPackDeliveries)
      .values({
        id: acceptanceContextPackDeliveryId({
          contextPackId: input.contextPackId,
          deliveryKey: input.deliveryKey,
        }),
        contextPackId: input.contextPackId,
        deliveryKey: input.deliveryKey,
        method: input.method,
        recipient: input.recipient ?? null,
        metadata: input.metadata ?? {},
        deliveredBy: input.deliveredBy,
      })
      .returning();
    const delivery = rows[0]!;
    await appendContractEventInTransaction(tx, {
      recordId: input.recordId,
      eventKey: `acceptance-context-pack:delivery:${delivery.id}`,
      stage: "context_delivery",
      actor: input.deliveredBy,
      payloadRef: {
        kind: "acceptance_context_pack_delivery",
        contextPackId: input.contextPackId,
        deliveryId: delivery.id,
        method: delivery.method,
        recipient: delivery.recipient,
      },
    });
    return { delivery, inserted: true };
  });
}
