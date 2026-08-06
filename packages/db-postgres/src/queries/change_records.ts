import { createHash, randomUUID } from "crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  changeRecordEvents,
  changeRecords,
  acceptanceContracts,
  acceptanceContextPacks,
  acceptanceContextPackDeliveries,
  type AcceptanceContractRow,
  type AcceptanceContextPackDeliveryRow,
  type AcceptanceContextPackRow,
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

export function acceptanceContextPackId(input: {
  recordId: string;
  contentHash: string;
}): string {
  return uuid5Url(`acceptance-context-pack:${input.recordId}:${input.contentHash}`);
}

export function acceptanceContextPackDeliveryId(input: {
  contextPackId: string;
  deliveryKey: string;
}): string {
  return uuid5Url(
    `acceptance-context-pack-delivery:${input.contextPackId}:${input.deliveryKey}`
  );
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
    if (!contract) {
      throw new Error("Acceptance Contract draft was not found");
    }
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

function assertMetadataOnly(manifest: Record<string, unknown>): void {
  if (hasSourceContent(manifest)) {
    throw new Error("Acceptance Context Pack manifest must not contain source content");
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
  assertMetadataOnly(input.manifest);
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
