import { createHash, randomUUID } from "crypto";
import { isDeepStrictEqual } from "util";
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  changeRecordEvents,
  changeRecords,
  acceptanceBuilderRouteCapabilityProfiles,
  acceptanceBuilderRouteGithubClaudeAckProfiles,
  acceptanceBuilderRoutes,
  acceptanceCompiledContextPacks,
  acceptanceCorrectionDispatches,
  acceptanceCorrectionDispatchGithubPreflights,
  acceptanceCorrectionDispatchGithubFindingPublications,
  acceptanceCorrectionDispatchGithubActivations,
  acceptanceCorrectionDispatchGithubClaudeAckReceipts,
  acceptanceCorrectionDispatchGithubClaudeRepairObservations,
  acceptanceContextPackSnapshots,
  acceptanceContracts,
  acceptanceIntakes,
  acceptanceIntakeMessages,
  type AcceptanceContractRow,
  type AcceptanceBuilderRouteCapabilityProfileRow,
  type AcceptanceBuilderRouteGithubClaudeAckProfileRow,
  type AcceptanceBuilderRouteRow,
  type AcceptanceCompiledContextPackRow,
  type AcceptanceCorrectionDispatchRow,
  type AcceptanceCorrectionDispatchGithubPreflightRow,
  type AcceptanceCorrectionDispatchGithubFindingPublicationRow,
  type AcceptanceCorrectionDispatchGithubActivationRow,
  type AcceptanceCorrectionDispatchGithubClaudeAckReceiptRow,
  type AcceptanceCorrectionDispatchGithubClaudeRepairObservationRow,
  type AcceptanceContextPackSnapshotRow,
  type AcceptanceIntakeMessageRow,
  type AcceptanceIntakeRow,
  type ChangeRecordEventRow,
  type ChangeRecordRow,
} from "../schema/change_records.js";
import { workspaces } from "../schema/workspaces.js";
import { reviewJobs, type ReviewJobRow } from "../schema/review_jobs.js";
import { previewBoots } from "../schema/preview_boots.js";
import { previewBootId, type EnqueuePreviewBootResult } from "./preview_boots.js";
import { repositories } from "../schema/repositories.js";
import { wikiPages } from "../schema/wiki_pages.js";
import {
  exactGitTreeInclusionProofIdentity,
  verifyExactGitTreeInclusionProof,
  type ExactGitTreeInclusionProof,
} from "../exact-git-tree-path-proof.js";
import {
  GITHUB_CORRECTION_ACTIVATION_BINDING_KIND,
  GITHUB_CORRECTION_ACTIVATION_BINDING_VERSION,
  GITHUB_CORRECTION_DISPATCH_BINDING_KIND,
  GITHUB_CORRECTION_DISPATCH_BINDING_VERSION,
  renderGitHubCorrectionActivation,
  renderGitHubCorrectionFinding,
  type GitHubCorrectionActivationBinding,
  type GitHubCorrectionDispatchBinding,
  type GitHubCorrectionPacketPayload,
} from "../github-correction-dispatch-renderer.js";

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
    currentPrHeadSha: (row.current_pr_head_sha as string | null) ?? null,
    currentPrHeadCycleId: (row.current_pr_head_cycle_id as string | null) ?? null,
    currentPrHeadAuthoritative:
      (row.current_pr_head_authoritative as boolean | null) ?? false,
    currentPrHeadAuthorityGeneration:
      (row.current_pr_head_authority_generation as number | null) ?? 0,
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
 * Resolve the unique Change Record already bound to one workspace PR. This is
 * a header-only webhook bootstrap read: no timeline, Contract, or event rows
 * are exposed, and the atomic head transition rechecks ownership under lock.
 */
export async function readChangeRecordByPr(input: {
  workspaceId: string;
  repo: string;
  prNumber: number;
}): Promise<ChangeRecordRow | null> {
  if (!Number.isInteger(input.prNumber) || input.prNumber <= 0) return null;
  const rows = await db.select().from(changeRecords).where(and(
    eq(changeRecords.workspaceId, input.workspaceId),
    eq(changeRecords.repo, input.repo),
    eq(changeRecords.prNumber, input.prNumber),
  )).limit(1);
  return rows[0] ?? null;
}

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
            current_pr_head_sha = COALESCE(
              current_pr_head_sha,
              ${(prRecord.current_pr_head_sha as string | null | undefined) ?? null}
            ),
            current_pr_head_cycle_id = COALESCE(
              current_pr_head_cycle_id,
              ${(prRecord.current_pr_head_cycle_id as string | null | undefined) ?? null}
            ),
            current_pr_head_authoritative = CASE
              WHEN current_pr_head_sha IS NOT NULL THEN current_pr_head_authoritative
              ELSE ${(prRecord.current_pr_head_authoritative as boolean | null | undefined) ?? false}
            END,
            current_pr_head_authority_generation = CASE
              WHEN current_pr_head_sha IS NOT NULL THEN current_pr_head_authority_generation
              ELSE ${(prRecord.current_pr_head_authority_generation as number | null | undefined) ?? 0}
            END,
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
  | {
      kind:
        | "not_found"
        | "not_confirmed"
        | "already_attached"
        | "head_advance_required";
    };

export type AcceptanceRecordPullRequestSource =
  | "github_webhook"
  | "manual"
  | "mcp";

function acceptanceRecordPullRequestLockKey(input: {
  workspaceId: string;
  recordId: string;
  repo: string;
  prNumber: number;
}): string {
  return `acceptance-record-pr:${input.workspaceId}:${input.repo}:${input.prNumber}:${input.recordId}`;
}

/** One signed occurrence of a PR head; revisiting the same SHA creates a new cycle. */
export function acceptanceRecordPullRequestHeadCycleId(input: {
  workspaceId: string;
  recordId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  event: string;
  deliveryId: string;
  headTransition: { beforeHeadSha: string; afterHeadSha: string } | null;
}): string {
  return uuid5Url(`acceptance-record-pr-head-cycle:${JSON.stringify([
    input.workspaceId,
    input.recordId,
    input.repo,
    input.prNumber,
    input.headSha,
    input.event,
    input.deliveryId,
    input.headTransition?.beforeHeadSha ?? null,
    input.headTransition?.afterHeadSha ?? null,
  ])}`);
}

function acceptanceRecordPullRequestReconciliationCycleId(input: {
  workspaceId: string;
  recordId: string;
  repo: string;
  prNumber: number;
  expectedBlockedHeadSha: string;
  expectedBlockedCycleId: string;
  expectedBlockedAuthorityGeneration: number;
  observedHeadSha: string;
  observedBaseSha: string;
}): string {
  return uuid5Url(`acceptance-record-pr-head-reconciliation-cycle:${JSON.stringify([
    input.workspaceId,
    input.recordId,
    input.repo,
    input.prNumber,
    input.expectedBlockedHeadSha,
    input.expectedBlockedCycleId,
    input.expectedBlockedAuthorityGeneration,
    input.observedHeadSha,
    input.observedBaseSha,
  ])}`);
}

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
  source: AcceptanceRecordPullRequestSource;
  prUrl?: string | null;
}): Promise<AttachConfirmedAcceptanceRecordToExternalPullRequestResult> {
  if (!Number.isInteger(input.prNumber) || input.prNumber <= 0 || !GIT_SHA.test(input.headSha)) {
    throw new Error("External pull request attachment requires a positive PR number and git head SHA");
  }
  const lockKey = acceptanceRecordPullRequestLockKey(input);

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
    if (record.currentPrHeadSha != null
      && (!record.currentPrHeadAuthoritative || record.currentPrHeadSha !== input.headSha)) {
      return { kind: "head_advance_required" };
    }
    if (record.prNumber != null && !record.headShas.includes(input.headSha)) {
      return { kind: "head_advance_required" };
    }

    let attached = record;
    if (record.prNumber == null) {
      const rows = await tx
        .update(changeRecords)
        .set({
          prNumber: input.prNumber,
          headShas: normalizeHeadShas([...record.headShas, input.headSha]),
          updatedAt: new Date(),
        })
        .where(eq(changeRecords.id, input.recordId))
        .returning();
      attached = rows[0]!;
    }
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
const EXACT_GITHUB_HEAD_SHA = /^[0-9a-f]{40}$/i;
const ACCEPTANCE_RECORD_HEAD_EVENTS = new Set([
  "opened",
  "ready_for_review",
  "reopened",
  "synchronize",
]);
const ACCEPTANCE_RECORD_TERMINAL_HEAD_EVENTS = new Set([
  "closed",
  "merged",
]);

function boundedPullRequestProvenanceText(
  value: unknown,
  limit: number
): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= limit
    && value === value.trim()
    && !/[\u0000-\u001F\u007F]/.test(value);
}

export type AdvanceConfirmedAcceptanceRecordPullRequestHeadInput = {
  workspaceId: string;
  recordId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  event: "opened" | "ready_for_review" | "reopened" | "synchronize";
  deliveryId: string;
  admitReviewJob: boolean;
  headTransition: {
    beforeHeadSha: string;
    afterHeadSha: string;
  } | null;
  source: "github_webhook";
  prUrl?: string | null;
};

export type AdvanceConfirmedAcceptanceRecordPullRequestHeadResult =
  | {
      kind: "advanced";
      record: ChangeRecordRow;
      jobId: string;
      jobAdmitted: boolean;
      deduped: boolean;
      superseded: number;
      previewBootsTornDown: number;
      previousHeadSha: string | null;
      headChanged: boolean;
    }
  | { kind: "not_found" | "not_confirmed" | "already_attached" }
  | {
      kind: "stale_delivery";
      provenanceEventId: string;
      blockedHeadSha: string;
      blockedCycleId: string | null;
      authorityGeneration: number;
      replayed: boolean;
      currentAuthoritative: boolean;
      superseded: number;
      previewBootsTornDown: number;
    }
  | {
      kind: "delivery_replayed";
      currentHeadSha: string | null;
      currentHeadCycleId: string | null;
      currentAuthoritative: boolean;
      authorityGeneration: number;
    };

/**
 * Establish or advance the mutable exact PR tip for one confirmed Acceptance
 * Record. The historical `headShas` union is append-only, while this pointer,
 * its immutable provenance event, deterministic review job admission, and
 * old-head invalidation commit in one advisory-locked transaction.
 */
export async function advanceConfirmedAcceptanceRecordPullRequestHead(
  input: AdvanceConfirmedAcceptanceRecordPullRequestHeadInput
): Promise<AdvanceConfirmedAcceptanceRecordPullRequestHeadResult> {
  const expectedPrUrl = `https://github.com/${input.repo}/pull/${input.prNumber}`;
  if (!Number.isInteger(input.prNumber) || input.prNumber <= 0 || !EXACT_GITHUB_HEAD_SHA.test(input.headSha)
    || !ACCEPTANCE_RECORD_HEAD_EVENTS.has(input.event)
    || !boundedPullRequestProvenanceText(input.deliveryId, 256)
    || typeof input.admitReviewJob !== "boolean"
    || input.source !== "github_webhook"
    || (input.prUrl != null && input.prUrl !== expectedPrUrl)
    || (input.event === "synchronize"
      ? input.headTransition === null
        || !EXACT_GITHUB_HEAD_SHA.test(input.headTransition.beforeHeadSha)
        || !EXACT_GITHUB_HEAD_SHA.test(input.headTransition.afterHeadSha)
        || input.headTransition.afterHeadSha !== input.headSha
      : input.headTransition !== null)) {
    throw new Error("PR head advance requires bounded exact PR provenance");
  }
  const lockKey = acceptanceRecordPullRequestLockKey(input);

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const record = (await tx.select().from(changeRecords).where(and(
      eq(changeRecords.workspaceId, input.workspaceId),
      eq(changeRecords.id, input.recordId),
      eq(changeRecords.repo, input.repo),
    )).limit(1))[0];
    if (!record) return { kind: "not_found" };

    const confirmed = await tx.select({
      id: acceptanceContracts.id,
      version: acceptanceContracts.version,
    }).from(acceptanceContracts).where(and(
      eq(acceptanceContracts.recordId, input.recordId),
      eq(acceptanceContracts.status, "confirmed"),
    )).limit(1);
    if (!confirmed[0]) return { kind: "not_confirmed" };

    const existingPr = (await tx.select({ id: changeRecords.id }).from(changeRecords).where(and(
      eq(changeRecords.workspaceId, input.workspaceId),
      eq(changeRecords.repo, input.repo),
      eq(changeRecords.prNumber, input.prNumber),
    )).limit(1))[0];
    if ((record.prNumber != null && record.prNumber !== input.prNumber)
      || (existingPr && existingPr.id !== input.recordId)) {
      return { kind: "already_attached" };
    }

    // Receipt the immutable signed delivery before consulting mutable head
    // state. A replay must be a total no-op even if a later push/reconciliation
    // has changed the current pointer since the original processing.
    const heldEventKey = `external-pr:head-transition-held:${input.prNumber}:${input.deliveryId}`;
    const deliveryEventKey = `external-pr:delivery:${input.prNumber}:${input.deliveryId}`;
    const deliveryReceipt = await appendChangeRecordEventsAtomicallyInTransaction(tx, [{
      recordId: input.recordId,
      eventKey: deliveryEventKey,
      stage: "external_pr",
      actor: input.source,
      payloadRef: {
        kind: "external_pr_delivery",
        repo: input.repo,
        prNumber: input.prNumber,
        headSha: input.headSha,
        event: input.event,
        deliveryId: input.deliveryId,
        headTransition: input.headTransition,
        admitReviewJob: input.admitReviewJob,
        prUrl: input.prUrl ?? null,
      },
    }]);
    if (!deliveryReceipt.events[0]!.inserted) {
      const held = (await tx.select().from(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, input.recordId),
        eq(changeRecordEvents.eventKey, heldEventKey),
      )).limit(1))[0];
      const heldPayload = held?.payloadRef;
      const heldGenerationAfter = typeof heldPayload?.["authorityGenerationAfter"] === "number"
        ? heldPayload["authorityGenerationAfter"]
        : null;
      const heldGenerationBefore = typeof heldPayload?.["authorityGenerationBefore"] === "number"
        ? heldPayload["authorityGenerationBefore"]
        : null;
      const heldHead = typeof heldPayload?.["currentHeadSha"] === "string"
        ? heldPayload["currentHeadSha"]
        : null;
      const heldCycle = typeof heldPayload?.["currentHeadCycleId"] === "string"
        ? heldPayload["currentHeadCycleId"]
        : null;
      const exactHeldReceipt = held?.stage === "external_pr"
        && held.actor === "github_webhook"
        && heldPayload?.["kind"] === "external_pr_head_transition_held"
        && heldPayload["observedHeadSha"] === input.headSha
        && heldPayload["event"] === input.event
        && heldPayload["deliveryId"] === input.deliveryId
        && isDeepStrictEqual(heldPayload["headTransition"], input.headTransition)
        && heldPayload["acceptanceContractVersion"] === confirmed[0].version
        && Number.isInteger(heldGenerationBefore)
        && heldGenerationBefore! >= 0
        && heldGenerationAfter === heldGenerationBefore! + 1;
      if (exactHeldReceipt && held && heldHead && !record.currentPrHeadAuthoritative
        && record.currentPrHeadSha === heldHead
        && record.currentPrHeadCycleId === heldCycle
        && record.currentPrHeadAuthorityGeneration === heldGenerationAfter) {
        return {
          kind: "stale_delivery",
          provenanceEventId: held.id,
          blockedHeadSha: heldHead,
          blockedCycleId: heldCycle,
          authorityGeneration: heldGenerationAfter,
          replayed: true,
          currentAuthoritative: false,
          superseded: 0,
          previewBootsTornDown: 0,
        };
      }
      return {
        kind: "delivery_replayed",
        currentHeadSha: record.currentPrHeadSha,
        currentHeadCycleId: record.currentPrHeadCycleId,
        currentAuthoritative: record.currentPrHeadAuthoritative,
        authorityGeneration: record.currentPrHeadAuthorityGeneration,
      };
    }

    const previousHeadSha = record.currentPrHeadSha;
    const observedCycleId = acceptanceRecordPullRequestHeadCycleId(input);
    if (previousHeadSha != null && (
      !record.currentPrHeadAuthoritative
      || (previousHeadSha === input.headSha
        ? input.event !== "ready_for_review" && observedCycleId !== record.currentPrHeadCycleId
        : input.event !== "synchronize"
          || input.headTransition === null
          || input.headTransition.beforeHeadSha !== previousHeadSha)
    )) {
      const held = await appendChangeRecordEventsAtomicallyInTransaction(tx, [{
        recordId: input.recordId,
        eventKey: heldEventKey,
        stage: "external_pr",
        actor: "github_webhook",
        payloadRef: {
          kind: "external_pr_head_transition_held",
          currentHeadSha: previousHeadSha,
          currentHeadCycleId: record.currentPrHeadCycleId,
          authorityGenerationBefore: record.currentPrHeadAuthorityGeneration,
          authorityGenerationAfter: record.currentPrHeadAuthorityGeneration + 1,
          observedHeadSha: input.headSha,
          event: input.event,
          deliveryId: input.deliveryId,
          headTransition: input.headTransition,
          acceptanceContractVersion: confirmed[0].version,
        },
      }]);
      const authorityGeneration = record.currentPrHeadAuthorityGeneration + (held.events[0]!.inserted ? 1 : 0);
      if (held.events[0]!.inserted) {
        await tx.update(changeRecords).set({
          currentPrHeadAuthoritative: false,
          currentPrHeadAuthorityGeneration: sql`${changeRecords.currentPrHeadAuthorityGeneration} + 1`,
          updatedAt: new Date(),
        }).where(and(
          eq(changeRecords.id, input.recordId),
          eq(changeRecords.workspaceId, input.workspaceId),
        ));
      }
      const blocked = held.events[0]!.inserted ? Array.from(await tx.execute(sql`
        UPDATE review_jobs
        SET state = 'superseded', updated_at = now()
        WHERE workspace_id = ${input.workspaceId}
          AND repo = ${input.repo}
          AND pr_number = ${input.prNumber}
          AND state IN ('queued', 'running')
        RETURNING id
      `)) : [];
      const tornDownBoots = held.events[0]!.inserted ? Array.from(await tx.execute(sql`
        UPDATE preview_boots
        SET status = 'torn_down', reason = 'acceptance record head transition held', updated_at = now()
        WHERE workspace_id = ${input.workspaceId}
          AND repo = ${input.repo}
          AND pr_number = ${input.prNumber}
          AND status IN ('pending', 'claimed', 'booting', 'ready')
        RETURNING id
      `)) : [];
      if (held.events[0]!.inserted) {
        await invalidateAcceptanceCorrectionDispatchForHeadInTransaction(tx, {
          workspaceId: input.workspaceId, recordId: input.recordId,
          headSha: previousHeadSha, headCycleId: record.currentPrHeadCycleId,
          reason: "authority_blocked",
        });
      }
      return {
        kind: "stale_delivery",
        provenanceEventId: held.events[0]!.event.id,
        blockedHeadSha: previousHeadSha,
        blockedCycleId: record.currentPrHeadCycleId,
        authorityGeneration,
        replayed: false,
        currentAuthoritative: false,
        superseded: blocked.length,
        previewBootsTornDown: tornDownBoots.length,
      };
    }
    const headChanged = previousHeadSha !== input.headSha;
    const wasAttached = record.prNumber != null;
    const cycleId = headChanged
      ? observedCycleId
      : record.currentPrHeadCycleId;
    if (!cycleId) {
      throw new Error("Authoritative PR head is missing its current cycle");
    }
    let authorityEventInserted = false;
    if (headChanged || !wasAttached) {
      const eventKey = wasAttached
        ? `external-pr:head-advanced:${input.prNumber}:${cycleId}`
        : `external-pr:attached:${input.prNumber}:${cycleId}`;
      const provenance = await appendChangeRecordEventsAtomicallyInTransaction(tx, [{
        recordId: input.recordId,
        eventKey,
        stage: "external_pr",
        actor: input.source,
        payloadRef: {
          kind: wasAttached ? "external_pr_head_advanced" : "external_pr_attachment",
          repo: input.repo,
          prNumber: input.prNumber,
          previousHeadSha,
          headSha: input.headSha,
          headCycleId: cycleId,
          event: input.event,
          deliveryId: input.deliveryId,
          headTransition: input.headTransition,
          prUrl: input.prUrl ?? null,
          acceptanceContractVersion: confirmed[0].version,
        },
      }]);
      authorityEventInserted = provenance.events[0]!.inserted;
    }

    let advanced = record;
    if (headChanged || !wasAttached) {
      const rows = await tx.update(changeRecords).set({
        prNumber: input.prNumber,
        currentPrHeadSha: input.headSha,
        currentPrHeadCycleId: cycleId,
        currentPrHeadAuthoritative: true,
        currentPrHeadAuthorityGeneration:
          sql`${changeRecords.currentPrHeadAuthorityGeneration} + ${authorityEventInserted ? 1 : 0}`,
        headShas: normalizeHeadShas([...record.headShas, input.headSha]),
        updatedAt: new Date(),
      }).where(and(
        eq(changeRecords.id, input.recordId),
        eq(changeRecords.workspaceId, input.workspaceId),
      )).returning();
      advanced = rows[0]!;
    }

    const jobId = cycleId;
    let jobInserted = false;
    let jobDeduped = false;
    if (input.admitReviewJob) {
      const inserted = Array.from(await tx.execute(sql`
        INSERT INTO review_jobs (
          id, workspace_id, repo, pr_number, head_sha, event, next_eligible_at
        )
        VALUES (
          ${jobId}, ${input.workspaceId}, ${input.repo}, ${input.prNumber}, ${input.headSha}, ${input.event},
          CASE WHEN ${input.event} = 'synchronize' THEN now() + interval '60 seconds' ELSE NULL END
        )
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `));
      jobInserted = inserted.length === 1;
      jobDeduped = !jobInserted;
    }

    let superseded = 0;
    if (headChanged || jobInserted) {
      const supersededRows = Array.from(await tx.execute(sql`
        UPDATE review_jobs
        SET state = 'superseded', updated_at = now()
        WHERE workspace_id = ${input.workspaceId}
          AND repo = ${input.repo}
          AND pr_number = ${input.prNumber}
          AND id <> ${jobId}
          AND state IN ('queued', 'running')
        RETURNING id
      `));
      superseded = supersededRows.length;
    }

    let previewBootsTornDown = 0;
    if (headChanged) {
      const tornDownBoots = Array.from(await tx.execute(sql`
        UPDATE preview_boots
        SET status = 'torn_down', reason = 'acceptance record head advanced', updated_at = now()
        WHERE workspace_id = ${input.workspaceId}
          AND repo = ${input.repo}
          AND pr_number = ${input.prNumber}
          AND status IN ('pending', 'claimed', 'booting', 'ready')
        RETURNING id
      `));
      previewBootsTornDown = tornDownBoots.length;
      await invalidateAcceptanceCorrectionDispatchForHeadInTransaction(tx, {
        workspaceId: input.workspaceId, recordId: input.recordId,
        headSha: previousHeadSha, headCycleId: record.currentPrHeadCycleId,
        reason: "head_advanced", successorHeadSha: input.headSha, successorHeadCycleId: cycleId,
      });
    }

    return {
      kind: "advanced",
      record: advanced,
      jobId,
      jobAdmitted: input.admitReviewJob,
      deduped: !(headChanged || !wasAttached || jobInserted)
        && (!input.admitReviewJob || jobDeduped),
      superseded,
      previewBootsTornDown,
      previousHeadSha,
      headChanged,
    };
  });
}

export type InvalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEventInput = {
  workspaceId: string;
  recordId: string;
  repo: string;
  prNumber: number;
  /** Exact head observed in the signed terminal GitHub delivery. */
  headSha: string;
  event: "closed" | "merged";
  deliveryId: string;
  source: "github_webhook";
};

export type InvalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEventResult =
  | {
      kind: "invalidated";
      inserted: boolean;
      provenanceEventId: string;
      superseded: number;
      previewBootsTornDown: number;
      currentHeadSha: string | null;
      currentHeadCycleId: string | null;
      authorityGeneration: number;
      currentAuthoritative: boolean;
    }
  | { kind: "not_found" | "not_confirmed" | "not_attached" };

/**
 * Fail closed when a signed terminal PR delivery arrives. A merge may report
 * a head that cannot be chained to the last synchronize delivery, so this
 * operation deliberately does not promote the observed head or rewrite
 * immutable history. It only revokes operational authority, terminalizes
 * active review/preview work, and records why under the same PR lock.
 */
export async function invalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEvent(
  input: InvalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEventInput
): Promise<InvalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEventResult> {
  if (!Number.isInteger(input.prNumber) || input.prNumber <= 0
    || !EXACT_GITHUB_HEAD_SHA.test(input.headSha)
    || !ACCEPTANCE_RECORD_TERMINAL_HEAD_EVENTS.has(input.event)
    || !boundedPullRequestProvenanceText(input.deliveryId, 256)
    || input.source !== "github_webhook") {
    throw new Error("Terminal PR head invalidation requires bounded exact GitHub provenance");
  }
  const lockKey = acceptanceRecordPullRequestLockKey(input);

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const record = (await tx.select().from(changeRecords).where(and(
      eq(changeRecords.workspaceId, input.workspaceId),
      eq(changeRecords.id, input.recordId),
      eq(changeRecords.repo, input.repo),
    )).limit(1))[0];
    if (!record) return { kind: "not_found" };

    const confirmed = await tx.select({
      id: acceptanceContracts.id,
      version: acceptanceContracts.version,
    }).from(acceptanceContracts).where(and(
      eq(acceptanceContracts.recordId, input.recordId),
      eq(acceptanceContracts.status, "confirmed"),
    )).limit(1);
    if (!confirmed[0]) return { kind: "not_confirmed" };
    if (record.prNumber !== input.prNumber) return { kind: "not_attached" };

    const deliveryEventKey = `external-pr:delivery:${input.prNumber}:${input.deliveryId}`;
    const deliveryReceipt = await appendChangeRecordEventsAtomicallyInTransaction(tx, [{
      recordId: input.recordId,
      eventKey: deliveryEventKey,
      stage: "external_pr",
      actor: input.source,
      payloadRef: {
        kind: "external_pr_delivery",
        repo: input.repo,
        prNumber: input.prNumber,
        headSha: input.headSha,
        event: input.event,
        deliveryId: input.deliveryId,
        headTransition: null,
        admitReviewJob: false,
        prUrl: null,
      },
    }]);
    if (!deliveryReceipt.events[0]!.inserted) {
      return {
        kind: "invalidated",
        inserted: false,
        provenanceEventId: deliveryReceipt.events[0]!.event.id,
        superseded: 0,
        previewBootsTornDown: 0,
        currentHeadSha: record.currentPrHeadSha,
        currentHeadCycleId: record.currentPrHeadCycleId,
        authorityGeneration: record.currentPrHeadAuthorityGeneration,
        currentAuthoritative: record.currentPrHeadAuthoritative,
      };
    }

    const terminalEventKey = `external-pr:head-invalidated:${input.prNumber}:${input.deliveryId}`;
    const existingTerminal = (await tx.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, input.recordId),
      eq(changeRecordEvents.eventKey, terminalEventKey),
    )).limit(1))[0];
    if (existingTerminal) {
      return {
        kind: "invalidated",
        inserted: false,
        provenanceEventId: existingTerminal.id,
        superseded: 0,
        previewBootsTornDown: 0,
        currentHeadSha: record.currentPrHeadSha,
        currentHeadCycleId: record.currentPrHeadCycleId,
        authorityGeneration: record.currentPrHeadAuthorityGeneration,
        currentAuthoritative: record.currentPrHeadAuthoritative,
      };
    }

    const provenance = await appendChangeRecordEventsAtomicallyInTransaction(tx, [{
      recordId: input.recordId,
      eventKey: terminalEventKey,
      stage: "external_pr",
      actor: "github_webhook",
      payloadRef: {
        kind: "external_pr_head_invalidated_terminal",
        repo: input.repo,
        prNumber: input.prNumber,
        currentHeadSha: record.currentPrHeadSha,
        currentHeadCycleId: record.currentPrHeadCycleId,
        observedHeadSha: input.headSha,
        event: input.event,
        deliveryId: input.deliveryId,
        acceptanceContractVersion: confirmed[0].version,
      },
    }]);

    const authorityGeneration = record.currentPrHeadAuthorityGeneration
      + (provenance.events[0]!.inserted ? 1 : 0);
    if (provenance.events[0]!.inserted) {
      await tx.update(changeRecords).set({
        currentPrHeadAuthoritative: false,
        currentPrHeadAuthorityGeneration: sql`${changeRecords.currentPrHeadAuthorityGeneration} + 1`,
        updatedAt: new Date(),
      }).where(and(
        eq(changeRecords.id, input.recordId),
        eq(changeRecords.workspaceId, input.workspaceId),
      ));
    }
    const blocked = provenance.events[0]!.inserted ? Array.from(await tx.execute(sql`
      UPDATE review_jobs
      SET state = 'superseded', updated_at = now()
      WHERE workspace_id = ${input.workspaceId}
        AND repo = ${input.repo}
        AND pr_number = ${input.prNumber}
        AND state IN ('queued', 'running')
      RETURNING id
    `)) : [];
    const tornDownBoots = provenance.events[0]!.inserted ? Array.from(await tx.execute(sql`
      UPDATE preview_boots
      SET status = 'torn_down', reason = 'acceptance record PR closed or merged', updated_at = now()
      WHERE workspace_id = ${input.workspaceId}
        AND repo = ${input.repo}
        AND pr_number = ${input.prNumber}
        AND status IN ('pending', 'claimed', 'booting', 'ready')
      RETURNING id
    `)) : [];
    if (provenance.events[0]!.inserted) {
      await invalidateAcceptanceCorrectionDispatchForHeadInTransaction(tx, {
        workspaceId: input.workspaceId, recordId: input.recordId,
        headSha: record.currentPrHeadSha, headCycleId: record.currentPrHeadCycleId,
        reason: "terminal",
      });
    }

    return {
      kind: "invalidated",
      inserted: provenance.events[0]!.inserted,
      provenanceEventId: provenance.events[0]!.event.id,
      superseded: blocked.length,
      previewBootsTornDown: tornDownBoots.length,
      currentHeadSha: record.currentPrHeadSha,
      currentHeadCycleId: record.currentPrHeadCycleId,
      authorityGeneration,
      currentAuthoritative: false,
    };
  });
}

export type ReconcileConfirmedAcceptanceRecordPullRequestHeadInput = {
  workspaceId: string;
  recordId: string;
  repo: string;
  prNumber: number;
  expectedBlockedHeadSha: string;
  expectedBlockedCycleId: string;
  expectedBlockedAuthorityGeneration: number;
  observedHeadSha: string;
  observedBaseSha: string;
  observedState: "open" | "closed";
  observedDraft: boolean;
  observedMerged: boolean;
  source: "github_app_api";
};

export type ReconcileConfirmedAcceptanceRecordPullRequestHeadResult =
  | {
      kind: "reconciled" | "already_current";
      record: ChangeRecordRow;
      jobId: string | null;
      jobAdmitted: boolean;
      deduped: boolean;
      observedHeadSha: string;
      currentHeadCycleId: string;
      authorityGeneration: number;
      superseded: number;
      previewBootsTornDown: number;
    }
  | {
      kind: "closed";
      currentHeadSha: string | null;
      currentHeadCycleId: string | null;
      currentAuthoritative: boolean;
      authorityGeneration: number;
      superseded: number;
      previewBootsTornDown: number;
    }
  | {
      kind: "blocked_precondition_changed";
      currentHeadSha: string | null;
      currentHeadCycleId: string | null;
      currentAuthoritative: boolean;
      authorityGeneration: number;
    }
  | { kind: "not_found" | "not_confirmed" | "not_attached" };

/**
 * Restore exact-head authority only after the authenticated GitHub API has
 * read the PR's current open tip. The caller supplies the blocked tuple it
 * observed; the monotonic generation makes every later signed observation win
 * over an in-flight API request under the same advisory lock.
 */
export async function reconcileConfirmedAcceptanceRecordPullRequestHead(
  input: ReconcileConfirmedAcceptanceRecordPullRequestHeadInput
): Promise<ReconcileConfirmedAcceptanceRecordPullRequestHeadResult> {
  if (!Number.isInteger(input.prNumber) || input.prNumber <= 0
    || !EXACT_GITHUB_HEAD_SHA.test(input.expectedBlockedHeadSha)
    || !isUuid(input.expectedBlockedCycleId)
    || !Number.isInteger(input.expectedBlockedAuthorityGeneration)
    || input.expectedBlockedAuthorityGeneration < 0
    || !EXACT_GITHUB_HEAD_SHA.test(input.observedHeadSha)
    || !EXACT_GITHUB_HEAD_SHA.test(input.observedBaseSha)
    || (input.observedState !== "open" && input.observedState !== "closed")
    || typeof input.observedDraft !== "boolean"
    || typeof input.observedMerged !== "boolean"
    || input.source !== "github_app_api") {
    throw new Error("GitHub current-head reconciliation requires bounded exact authenticated provenance");
  }
  const lockKey = acceptanceRecordPullRequestLockKey(input);
  const cycleId = acceptanceRecordPullRequestReconciliationCycleId(input);

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const record = (await tx.select().from(changeRecords).where(and(
      eq(changeRecords.workspaceId, input.workspaceId),
      eq(changeRecords.id, input.recordId),
      eq(changeRecords.repo, input.repo),
    )).limit(1))[0];
    if (!record) return { kind: "not_found" };

    const confirmed = await tx.select({
      id: acceptanceContracts.id,
      version: acceptanceContracts.version,
    }).from(acceptanceContracts).where(and(
      eq(acceptanceContracts.recordId, input.recordId),
      eq(acceptanceContracts.status, "confirmed"),
    )).limit(1);
    if (!confirmed[0]) return { kind: "not_confirmed" };
    if (record.prNumber !== input.prNumber) return { kind: "not_attached" };

    const preconditionChanged = () => ({
      kind: "blocked_precondition_changed" as const,
      currentHeadSha: record.currentPrHeadSha,
      currentHeadCycleId: record.currentPrHeadCycleId,
      currentAuthoritative: record.currentPrHeadAuthoritative,
      authorityGeneration: record.currentPrHeadAuthorityGeneration,
    });
    const reconciliationEventKey = `external-pr:head-reconciled:${input.prNumber}:${cycleId}`;
    const reconciliationPayload = {
      kind: "external_pr_head_reconciled",
      repo: input.repo,
      prNumber: input.prNumber,
      expectedBlockedHeadSha: input.expectedBlockedHeadSha,
      expectedBlockedCycleId: input.expectedBlockedCycleId,
      expectedBlockedAuthorityGeneration: input.expectedBlockedAuthorityGeneration,
      observedHeadSha: input.observedHeadSha,
      observedBaseSha: input.observedBaseSha,
      observedState: input.observedState,
      observedDraft: input.observedDraft,
      observedMerged: input.observedMerged,
      headCycleId: cycleId,
      acceptanceContractVersion: confirmed[0].version,
    };
    if (input.observedState === "open" && !input.observedMerged
      && record.currentPrHeadAuthoritative
      && record.currentPrHeadSha === input.observedHeadSha
      && record.currentPrHeadCycleId === cycleId
      && record.currentPrHeadAuthorityGeneration === input.expectedBlockedAuthorityGeneration + 1) {
      const event = (await tx.select().from(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, input.recordId),
        eq(changeRecordEvents.eventKey, reconciliationEventKey),
      )).limit(1))[0];
      const job = (await tx.select({
        id: reviewJobs.id,
        headSha: reviewJobs.headSha,
        event: reviewJobs.event,
      }).from(reviewJobs).where(and(
        eq(reviewJobs.id, cycleId),
        eq(reviewJobs.workspaceId, input.workspaceId),
        eq(reviewJobs.repo, input.repo),
        eq(reviewJobs.prNumber, input.prNumber),
      )).limit(1))[0];
      // A draft reconciliation deliberately admits no job. A later signed
      // ready_for_review delivery may validly admit this same exact cycle
      // without advancing authority generation; preserve that state on an
      // API retry while rejecting every other job shape.
      const jobMatches = input.observedDraft
        ? job == null || (job?.headSha === input.observedHeadSha && job.event === "ready_for_review")
        : job?.headSha === input.observedHeadSha && job.event === "reconciled";
      if (event?.stage === "external_pr" && event.actor === input.source
        && isDeepStrictEqual(event.payloadRef, reconciliationPayload)
        && jobMatches) {
        return {
          kind: "already_current",
          record,
          jobId: job?.id ?? null,
          jobAdmitted: job != null,
          deduped: true,
          observedHeadSha: input.observedHeadSha,
          currentHeadCycleId: cycleId,
          authorityGeneration: record.currentPrHeadAuthorityGeneration,
          superseded: 0,
          previewBootsTornDown: 0,
        };
      }
      return preconditionChanged();
    }

    const closedEventKey = `external-pr:head-reconciliation-closed:${input.prNumber}:${cycleId}`;
    const closedPayload = {
      kind: "external_pr_head_reconciliation_closed",
      repo: input.repo,
      prNumber: input.prNumber,
      expectedBlockedHeadSha: input.expectedBlockedHeadSha,
      expectedBlockedCycleId: input.expectedBlockedCycleId,
      expectedBlockedAuthorityGeneration: input.expectedBlockedAuthorityGeneration,
      observedHeadSha: input.observedHeadSha,
      observedBaseSha: input.observedBaseSha,
      observedState: input.observedState,
      observedDraft: input.observedDraft,
      observedMerged: input.observedMerged,
      headCycleId: cycleId,
      acceptanceContractVersion: confirmed[0].version,
    };
    const existingClosed = input.observedState !== "open" || input.observedMerged
      ? (await tx.select().from(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, input.recordId),
        eq(changeRecordEvents.eventKey, closedEventKey),
      )).limit(1))[0]
      : null;
    if (existingClosed
      && !record.currentPrHeadAuthoritative
      && record.currentPrHeadSha === input.expectedBlockedHeadSha
      && record.currentPrHeadCycleId === input.expectedBlockedCycleId
      && record.currentPrHeadAuthorityGeneration === input.expectedBlockedAuthorityGeneration + 1
      && existingClosed.stage === "external_pr"
      && existingClosed.actor === input.source
      && isDeepStrictEqual(existingClosed.payloadRef, closedPayload)) {
      return {
        kind: "closed",
        currentHeadSha: record.currentPrHeadSha,
        currentHeadCycleId: record.currentPrHeadCycleId,
        currentAuthoritative: record.currentPrHeadAuthoritative,
        authorityGeneration: record.currentPrHeadAuthorityGeneration,
        superseded: 0,
        previewBootsTornDown: 0,
      };
    }
    if (record.currentPrHeadSha !== input.expectedBlockedHeadSha
      || record.currentPrHeadCycleId !== input.expectedBlockedCycleId
      || record.currentPrHeadAuthoritative
      || record.currentPrHeadAuthorityGeneration !== input.expectedBlockedAuthorityGeneration) {
      return preconditionChanged();
    }

    if (input.observedState !== "open" || input.observedMerged) {
      const receipt = await appendChangeRecordEventsAtomicallyInTransaction(tx, [{
        recordId: input.recordId,
        eventKey: closedEventKey,
        stage: "external_pr",
        actor: input.source,
        payloadRef: closedPayload,
      }]);
      if (!receipt.events[0]!.inserted) throw new Error("Closed reconciliation provenance insertion unexpectedly replayed");
      const rows = await tx.update(changeRecords).set({
        currentPrHeadAuthoritative: false,
        currentPrHeadAuthorityGeneration: sql`${changeRecords.currentPrHeadAuthorityGeneration} + 1`,
        updatedAt: new Date(),
      }).where(and(
        eq(changeRecords.id, input.recordId),
        eq(changeRecords.workspaceId, input.workspaceId),
        eq(changeRecords.currentPrHeadSha, input.expectedBlockedHeadSha),
        eq(changeRecords.currentPrHeadCycleId, input.expectedBlockedCycleId),
        eq(changeRecords.currentPrHeadAuthoritative, false),
        eq(changeRecords.currentPrHeadAuthorityGeneration, input.expectedBlockedAuthorityGeneration),
      )).returning();
      if (!rows[0]) throw new Error("Closed reconciliation lost its locked precondition");
      const blocked = Array.from(await tx.execute(sql`
        UPDATE review_jobs SET state = 'superseded', updated_at = now()
        WHERE workspace_id = ${input.workspaceId} AND repo = ${input.repo} AND pr_number = ${input.prNumber}
          AND state IN ('queued', 'running') RETURNING id
      `));
      const boots = Array.from(await tx.execute(sql`
        UPDATE preview_boots SET status = 'torn_down', reason = 'acceptance record reconciliation observed closed PR', updated_at = now()
        WHERE workspace_id = ${input.workspaceId} AND repo = ${input.repo} AND pr_number = ${input.prNumber}
          AND status IN ('pending', 'claimed', 'booting', 'ready') RETURNING id
      `));
      await invalidateAcceptanceCorrectionDispatchForHeadInTransaction(tx, {
        workspaceId: input.workspaceId, recordId: input.recordId,
        headSha: input.expectedBlockedHeadSha, headCycleId: input.expectedBlockedCycleId,
        reason: "authority_blocked",
      });
      return {
        kind: "closed",
        currentHeadSha: rows[0].currentPrHeadSha,
        currentHeadCycleId: rows[0].currentPrHeadCycleId,
        currentAuthoritative: false,
        authorityGeneration: rows[0].currentPrHeadAuthorityGeneration,
        superseded: blocked.length,
        previewBootsTornDown: boots.length,
      };
    }

    const existingEvent = (await tx.select({ id: changeRecordEvents.id }).from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, input.recordId),
      eq(changeRecordEvents.eventKey, reconciliationEventKey),
    )).limit(1))[0];
    if (existingEvent) return preconditionChanged();

    const provenance = await appendChangeRecordEventsAtomicallyInTransaction(tx, [{
      recordId: input.recordId,
      eventKey: reconciliationEventKey,
      stage: "external_pr",
      actor: input.source,
      payloadRef: reconciliationPayload,
    }]);
    if (!provenance.events[0]!.inserted) {
      throw new Error("Current-head reconciliation provenance insertion unexpectedly replayed");
    }

    const rows = await tx.update(changeRecords).set({
      currentPrHeadSha: input.observedHeadSha,
      currentPrHeadCycleId: cycleId,
      currentPrHeadAuthoritative: true,
      currentPrHeadAuthorityGeneration: sql`${changeRecords.currentPrHeadAuthorityGeneration} + 1`,
      headShas: normalizeHeadShas([...record.headShas, input.observedHeadSha]),
      updatedAt: new Date(),
    }).where(and(
      eq(changeRecords.id, input.recordId),
      eq(changeRecords.workspaceId, input.workspaceId),
      eq(changeRecords.currentPrHeadSha, input.expectedBlockedHeadSha),
      eq(changeRecords.currentPrHeadCycleId, input.expectedBlockedCycleId),
      eq(changeRecords.currentPrHeadAuthoritative, false),
      eq(changeRecords.currentPrHeadAuthorityGeneration, input.expectedBlockedAuthorityGeneration),
    )).returning();
    const reconciled = rows[0];
    if (!reconciled) throw new Error("Current-head reconciliation lost its locked precondition");

    let jobId: string | null = null;
    let jobAdmitted = false;
    if (!input.observedDraft) {
      const inserted = Array.from(await tx.execute(sql`
        INSERT INTO review_jobs (
          id, workspace_id, repo, pr_number, head_sha, event
        ) VALUES (
          ${cycleId}, ${input.workspaceId}, ${input.repo}, ${input.prNumber}, ${input.observedHeadSha}, 'reconciled'
        ) ON CONFLICT (id) DO NOTHING
        RETURNING id
      `));
      jobId = cycleId;
      jobAdmitted = inserted.length === 1;
      if (!jobAdmitted) {
        throw new Error("Current-head reconciliation review job unexpectedly replayed");
      }
    }

    const supersededRows = Array.from(await tx.execute(sql`
      UPDATE review_jobs
      SET state = 'superseded', updated_at = now()
      WHERE workspace_id = ${input.workspaceId}
        AND repo = ${input.repo}
        AND pr_number = ${input.prNumber}
        AND id <> ${cycleId}
        AND state IN ('queued', 'running')
      RETURNING id
    `));
    const tornDownBoots = Array.from(await tx.execute(sql`
      UPDATE preview_boots
      SET status = 'torn_down', reason = 'acceptance record head reconciled', updated_at = now()
      WHERE workspace_id = ${input.workspaceId}
        AND repo = ${input.repo}
        AND pr_number = ${input.prNumber}
        AND status IN ('pending', 'claimed', 'booting', 'ready')
      RETURNING id
    `));
    await invalidateAcceptanceCorrectionDispatchForHeadInTransaction(tx, {
      workspaceId: input.workspaceId, recordId: input.recordId,
      headSha: input.expectedBlockedHeadSha, headCycleId: input.expectedBlockedCycleId,
      reason: "reconciled", successorHeadSha: input.observedHeadSha, successorHeadCycleId: cycleId,
    });

    return {
      kind: "reconciled",
      record: reconciled,
      jobId,
      jobAdmitted,
      deduped: false,
      observedHeadSha: input.observedHeadSha,
      currentHeadCycleId: cycleId,
      authorityGeneration: reconciled.currentPrHeadAuthorityGeneration,
      superseded: supersededRows.length,
      previewBootsTornDown: tornDownBoots.length,
    };
  });
}

export type CurrentReviewJobNotCurrentReason =
  | "record_not_current"
  | "job_not_running";

/** Stable trust-boundary rejection; storage/transport failures use other errors. */
export class CurrentReviewJobNotCurrentError extends Error {
  readonly code = "CURRENT_REVIEW_JOB_NOT_CURRENT" as const;

  constructor(readonly reason: CurrentReviewJobNotCurrentReason) {
    super(reason === "record_not_current"
      ? "Acceptance Record tuple is not the current PR head"
      : "Acceptance Record tuple does not own a running review job");
    this.name = "CurrentReviewJobNotCurrentError";
  }
}

export type AppendCurrentReviewJobEventsAtomicallyInput = {
  workspaceId: string;
  recordId: string;
  jobId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  events: ReadonlyArray<Omit<AppendChangeRecordEventInput, "recordId">>;
};

/**
 * Append a post-review reservation/correction batch only while its exact job
 * still owns the Record's current PR head. A push and an append use the same
 * advisory lock, so no obsolete-head event can commit after head advancement.
 */
export async function appendCurrentReviewJobEventsAtomically(
  input: AppendCurrentReviewJobEventsAtomicallyInput
): Promise<AppendChangeRecordEventsAtomicallyResult> {
  if (!Number.isInteger(input.prNumber) || input.prNumber <= 0
    || !EXACT_GITHUB_HEAD_SHA.test(input.headSha) || input.events.length === 0) {
    throw new Error("Current review job append requires one exact-head event batch");
  }
  const events = input.events.map((event) => ({ ...event, recordId: input.recordId }));
  const eventKeys = new Set<string>();
  for (const event of events) {
    if (eventKeys.has(event.eventKey)) {
      throw new Error("Current review job append does not allow duplicate eventKeys");
    }
    eventKeys.add(event.eventKey);
  }
  const lockKey = acceptanceRecordPullRequestLockKey(input);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const record = (await tx.select({ id: changeRecords.id }).from(changeRecords).where(and(
      eq(changeRecords.workspaceId, input.workspaceId),
      eq(changeRecords.id, input.recordId),
      eq(changeRecords.repo, input.repo),
      eq(changeRecords.prNumber, input.prNumber),
      eq(changeRecords.currentPrHeadAuthoritative, true),
      eq(changeRecords.currentPrHeadSha, input.headSha),
      eq(changeRecords.currentPrHeadCycleId, input.jobId),
    )).limit(1))[0];
    if (!record) throw new CurrentReviewJobNotCurrentError("record_not_current");

    const job = (await tx.select({ id: reviewJobs.id }).from(reviewJobs).where(and(
      eq(reviewJobs.id, input.jobId),
      eq(reviewJobs.workspaceId, input.workspaceId),
      eq(reviewJobs.repo, input.repo),
      eq(reviewJobs.prNumber, input.prNumber),
      eq(reviewJobs.headSha, input.headSha),
      eq(reviewJobs.state, "running"),
    )).limit(1))[0];
    if (!job) throw new CurrentReviewJobNotCurrentError("job_not_running");

    return appendChangeRecordEventsAtomicallyInTransaction(tx, events);
  });
}

export type EnqueueCurrentReviewJobPreviewBootInput = {
  workspaceId: string;
  recordId: string;
  jobId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  ref: string;
};

/**
 * Admit one cycle-bound preview boot only while the exact running review job
 * still owns the authoritative current head. Head advance uses the same lock,
 * closing the route-check/enqueue race and tearing down prior-cycle boots.
 */
export async function enqueueCurrentReviewJobPreviewBoot(
  input: EnqueueCurrentReviewJobPreviewBootInput
): Promise<EnqueuePreviewBootResult> {
  const pullRef = `refs/pull/${input.prNumber}/head`;
  if (!Number.isInteger(input.prNumber) || input.prNumber <= 0
    || !isUuid(input.workspaceId) || !isUuid(input.recordId) || !isUuid(input.jobId)
    || !EXACT_GITHUB_HEAD_SHA.test(input.headSha)
    || (input.ref !== input.headSha && input.ref !== pullRef)) {
    throw new Error("Current review preview boot requires one exact PR ref");
  }
  const lockKey = acceptanceRecordPullRequestLockKey(input);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const record = (await tx.select({ id: changeRecords.id }).from(changeRecords).where(and(
      eq(changeRecords.workspaceId, input.workspaceId),
      eq(changeRecords.id, input.recordId),
      eq(changeRecords.repo, input.repo),
      eq(changeRecords.prNumber, input.prNumber),
      eq(changeRecords.currentPrHeadAuthoritative, true),
      eq(changeRecords.currentPrHeadSha, input.headSha),
      eq(changeRecords.currentPrHeadCycleId, input.jobId),
    )).limit(1))[0];
    if (!record) throw new CurrentReviewJobNotCurrentError("record_not_current");

    const job = (await tx.select({ id: reviewJobs.id }).from(reviewJobs).where(and(
      eq(reviewJobs.id, input.jobId),
      eq(reviewJobs.workspaceId, input.workspaceId),
      eq(reviewJobs.repo, input.repo),
      eq(reviewJobs.prNumber, input.prNumber),
      eq(reviewJobs.headSha, input.headSha),
      eq(reviewJobs.state, "running"),
    )).limit(1))[0];
    if (!job) throw new CurrentReviewJobNotCurrentError("job_not_running");

    const id = previewBootId({
      workspaceId: input.workspaceId,
      repo: input.repo,
      prNumber: input.prNumber,
      headSha: input.headSha,
      cycleId: input.jobId,
    });
    const inserted = Array.from(await tx.execute(sql`
      INSERT INTO preview_boots (id, workspace_id, repo, pr_number, head_sha, ref)
      VALUES (${id}, ${input.workspaceId}, ${input.repo}, ${input.prNumber}, ${input.headSha}, ${input.ref})
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `));
    const existing = (await tx.select().from(previewBoots).where(
      eq(previewBoots.id, id)
    ).limit(1))[0];
    if (!existing
      || existing.workspaceId !== input.workspaceId
      || existing.repo !== input.repo
      || existing.prNumber !== input.prNumber
      || existing.headSha !== input.headSha
      || existing.ref !== input.ref) {
      throw new Error("Current review preview boot id is bound to different provenance");
    }

    const superseded = Array.from(await tx.execute(sql`
      UPDATE preview_boots
      SET status = 'torn_down', reason = 'superseded by current Acceptance Record cycle', updated_at = now()
      WHERE workspace_id = ${input.workspaceId}
        AND repo = ${input.repo}
        AND pr_number = ${input.prNumber}
        AND id <> ${id}
        AND status IN ('pending', 'claimed', 'booting', 'ready')
      RETURNING id
    `));
    return { id, deduped: inserted.length === 0, superseded: superseded.length };
  });
}

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

export type HumanAcceptancePostMergeOutcome = Exclude<
  AcceptancePostMergeOutcome,
  { kind: "merged" }
>;

export type RecordAcceptancePostMergeOutcomeInput = {
  workspaceId: string;
  recordId: string;
  recordedBy: string;
  outcome: HumanAcceptancePostMergeOutcome;
  occurredAt?: Date;
};

/**
 * Accept only a bounded post-merge reference. This is deliberately not a
 * generic timeline write: each variant has a stable idempotency key and can
 * be checked against the Record's current PR/head/merge lineage.
 */
export function validateAcceptancePostMergeOutcome(
  value: unknown
): value is HumanAcceptancePostMergeOutcome {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const outcome = value as Record<string, unknown>;
  // A merge is authoritative only when it comes through the authenticated
  // GitHub webhook convergence API. The manual outcome lane cannot mint it.
  if (outcome.kind === "merged") return false;
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

function outcomeEventKey(outcome: HumanAcceptancePostMergeOutcome): string {
  switch (outcome.kind) {
    case "deployed":
      return `acceptance-post-merge:deployed:${outcome.deploymentReference}`;
    case "incident":
      return `acceptance-post-merge:incident:${outcome.incidentReference}`;
    case "reverted":
      return `acceptance-post-merge:reverted:${outcome.revertSha}`;
  }
}

function outcomePayload(
  record: ChangeRecordRow,
  outcome: HumanAcceptancePostMergeOutcome,
  signedMerge: { event: ChangeRecordEventRow; payload: SignedAcceptanceRecordMergePayload }
): Record<string, unknown> {
  return {
    kind: "acceptance_post_merge_outcome",
    repository: record.repo,
    signedMergeEventId: signedMerge.event.id,
    signedMergeDeliveryEventId: signedMerge.payload.deliveryEventId,
    signedMergeSha: signedMerge.payload.mergeSha,
    outcome,
  };
}

/**
 * Append one human-authorized post-merge outcome to its canonical Acceptance
 * Record. The Record header is only a current summary; the event is the
 * immutable provenance of the merge, deployment, incident, or revert.
 */
export async function recordAcceptancePostMergeOutcome(
  input: RecordAcceptancePostMergeOutcomeInput
): Promise<{ event: ChangeRecordEventRow; inserted: boolean }> {
  const untrustedOutcome: unknown = input.outcome;
  if (isRecord(untrustedOutcome) && untrustedOutcome["kind"] === "merged") {
    throw new Error("Acceptance Record merge outcomes require the signed GitHub webhook boundary");
  }
  if (!validateAcceptancePostMergeOutcome(untrustedOutcome)) {
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

    const signedMerge = await resolveStoredSignedAcceptanceRecordMergeInTransaction(tx, record);
    if (!signedMerge) {
      throw new Error("Post-merge outcome requires canonical signed merge custody");
    }
    const expectedPayload = outcomePayload(record, outcome, signedMerge);

    // A retry must return the immutable original event even if a later outcome
    // changed the Record summary (for example, a later revert). The event key
    // is derived from the immutable external reference, not its current state.
    const existing = (await tx.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, input.recordId),
      eq(changeRecordEvents.eventKey, eventKey),
    )).limit(1))[0];
    if (existing) {
      if (existing.id !== changeRecordEventId({ recordId: input.recordId, eventKey })
        || existing.stage !== "post_merge_outcome" || existing.actor !== input.recordedBy
        || !isDeepStrictEqual(existing.payloadRef, expectedPayload)) {
        throw new Error("Acceptance Record post-merge outcome replay conflicts with immutable custody");
      }
      return { event: existing as ChangeRecordEventRow, inserted: false };
    }

    if (outcome.kind === "deployed" || outcome.kind === "incident") {
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
        ${input.recordedBy}, ${JSON.stringify(expectedPayload)}::jsonb
      )
      ON CONFLICT (record_id, event_key) DO NOTHING
      RETURNING *
    `)) as Array<Record<string, unknown>>;

    const rawEvent = inserted[0] ?? (await tx.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, input.recordId),
      eq(changeRecordEvents.eventKey, eventKey),
    )).limit(1))[0];
    if (!rawEvent) throw new Error("Acceptance Record post-merge outcome was not recorded");
    const recordedEvent = mapChangeRecordEventRow(rawEvent as Record<string, unknown>);
    if (recordedEvent.id !== changeRecordEventId({ recordId: input.recordId, eventKey })
      || recordedEvent.stage !== "post_merge_outcome" || recordedEvent.actor !== input.recordedBy
      || !isDeepStrictEqual(recordedEvent.payloadRef, expectedPayload)) {
      throw new Error("Acceptance Record post-merge outcome custody could not be revalidated");
    }
    if (inserted[0] && outcome.kind === "reverted") {
      await tx.execute(sql`
        UPDATE change_records
        SET state = 'reverted', updated_at = now()
        WHERE id = ${input.recordId}
      `);
    }

    return {
      event: recordedEvent,
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

export type ReadAcceptanceRecordSummariesInput = {
  workspaceId: string;
  repo?: string | null;
  limit?: number;
};

export type AcceptanceRecordSummaryContractIdentity = {
  id: string;
  version: number;
  sha256: string;
};

export type AcceptanceRecordSummaryRequestedWork =
  | {
      kind: "confirmed";
      originalRequest: string;
      acceptanceContract: AcceptanceRecordSummaryContractIdentity;
    }
  | { kind: "unknown" };

export type AcceptanceRecordSummarySourceSnapshotIdentity = {
  id: string;
  headSha: string;
  headCycleId: string;
  compilerVersion: string;
  packetSetSha256: string;
};

export type AcceptanceRecordSummaryCompiledPackIdentity = {
  id: string;
  sha256: string;
  sourceCustodyIdentitySha256: string;
  compilerVersion: string;
  policyVersion: string;
};

export type AcceptanceRecordSummarySuppliedContext =
  | {
      kind: "compiled";
      sourceSnapshot: AcceptanceRecordSummarySourceSnapshotIdentity;
      compiledPack: AcceptanceRecordSummaryCompiledPackIdentity;
    }
  | {
      kind: "admitted" | "not_proven";
      sourceSnapshot: AcceptanceRecordSummarySourceSnapshotIdentity;
    }
  | { kind: "unknown" };

export type AcceptanceRecordSummaryHeadOccurrence = {
  kind: "current" | "merged";
  sha: string;
  headCycleId: string;
  authorityGeneration: number;
};

export type AcceptanceRecordSummaryPullRequest =
  | { kind: "not_attached" }
  | {
      kind: "attached";
      prNumber: number;
      head: AcceptanceRecordSummaryHeadOccurrence | { kind: "unknown" };
    };

export type AcceptanceRecordSummaryProof =
  | {
      kind: "recorded";
      reviewJobId: string;
      verdict: "proven" | "failed" | "not_proven" | "not_testable";
      postedReviewUrl: string;
      postedAttestationEventId: string;
    }
  | { kind: "unknown" };

export type AcceptanceRecordSummaryNeededDecision =
  | { kind: "required"; choices: AcceptancePrDecision[] }
  | {
      kind: "recorded";
      eventId: string;
      decision: AcceptancePrDecision;
      decidedAt: Date;
    }
  | { kind: "not_required"; reason: "pr_not_attached" | "merged" | "reverted" }
  | { kind: "unknown" };

export type AcceptanceRecordSummaryPostMergeEvidence = "recorded" | "not_recorded";

export type AcceptanceRecordSummaryOutcome =
  | { kind: "not_recorded" }
  | {
      kind: "signed_merge";
      mergeEventId: string;
      mergeSha: string;
      mergedAt: Date;
      decisionAlignment: SignedAcceptanceRecordMergeDecisionAlignment["kind"];
      /** `not_recorded` is absence of canonical evidence, never a known negative. */
      postMerge: {
        deployment: AcceptanceRecordSummaryPostMergeEvidence;
        incident: AcceptanceRecordSummaryPostMergeEvidence;
        revert: AcceptanceRecordSummaryPostMergeEvidence;
      };
    }
  | { kind: "unknown" };

export type AcceptanceRecordSummaryUnknownReason =
  | "requested_work_not_confirmed"
  | "invalid_contract_custody"
  | "head_occurrence_not_authoritative"
  | "invalid_head_custody"
  | "context_not_recorded"
  | "ambiguous_context_custody"
  | "invalid_context_custody"
  | "proof_not_recorded"
  | "invalid_review_custody"
  | "decision_not_recorded"
  | "invalid_decision_custody"
  | "outcome_not_recorded"
  | "invalid_merge_custody"
  | "invalid_post_merge_custody"
  | "summary_custody_limit";

export type AcceptanceRecordSummary = {
  recordId: string;
  workspaceId: string;
  repo: string;
  issueNumber: number | null;
  createdAt: Date;
  updatedAt: Date;
  requestedWork: AcceptanceRecordSummaryRequestedWork;
  suppliedContext: AcceptanceRecordSummarySuppliedContext;
  pullRequest: AcceptanceRecordSummaryPullRequest;
  proof: AcceptanceRecordSummaryProof;
  unknownReasons: AcceptanceRecordSummaryUnknownReason[];
  neededDecision: AcceptanceRecordSummaryNeededDecision;
  outcome: AcceptanceRecordSummaryOutcome;
};

export type ReadAcceptanceRecordSummariesResult = {
  kind: "records";
  records: AcceptanceRecordSummary[];
};

export type ReadAcceptanceRecordDetailInput = {
  workspaceId: string;
  recordId: string;
};

export type AcceptanceRecordDetailContract = {
  identity: AcceptanceRecordSummaryContractIdentity;
  confirmedBy: string;
  confirmedAt: Date;
  contract: AcceptanceConfirmedContractProjection;
};

export type AcceptanceRecordDetailReviewJobState =
  | "queued"
  | "running"
  | "posted"
  | "failed"
  | "superseded"
  | "skipped";

export type AcceptanceRecordDetailReviewJob =
  | { kind: "not_recorded" }
  | {
      kind: "recorded";
      id: string;
      state: AcceptanceRecordDetailReviewJobState;
      createdAt: Date;
      updatedAt: Date;
    };

export type AcceptanceRecordDetailOccurrenceIdentity = {
  repo: string;
  prNumber: number;
  headSha: string;
  headCycleId: string;
};

export type AcceptanceRecordDetailCurrentOccurrence =
  AcceptanceRecordDetailOccurrenceIdentity & {
    kind: "current";
    authorityGeneration: number;
    reviewJob: AcceptanceRecordDetailReviewJob;
  };

export type AcceptanceRecordDetailMergedOccurrence =
  AcceptanceRecordDetailOccurrenceIdentity & {
    kind: "merged";
    authorityGeneration: number;
    mergeEventId: string;
    mergeSha: string;
    mergedAt: Date;
    reviewJob: AcceptanceRecordDetailReviewJob;
  };

/** Historical occurrences deliberately omit authorityGeneration: old jobs and
 * posted attestations did not persist that value. The cycle UUID is the
 * durable A-B-A discriminator. */
export type AcceptanceRecordDetailHistoricalOccurrence =
  AcceptanceRecordDetailOccurrenceIdentity & {
    kind: "historical";
    reviewJob: AcceptanceRecordDetailReviewJob;
  };

export type AcceptanceRecordDetailOccurrence =
  | AcceptanceRecordDetailCurrentOccurrence
  | AcceptanceRecordDetailMergedOccurrence
  | AcceptanceRecordDetailHistoricalOccurrence;

export type AcceptanceRecordDetailPullRequest =
  | { kind: "not_attached"; occurrences: [] }
  | {
      kind: "attached";
      prNumber: number;
      current: AcceptanceRecordDetailCurrentOccurrence | null;
      merged: AcceptanceRecordDetailMergedOccurrence | null;
      occurrences: AcceptanceRecordDetailOccurrence[];
    };

export type AcceptanceRecordDetailSourceSnapshot = {
  id: string;
  occurrence: AcceptanceRecordDetailOccurrenceIdentity & {
    kind: "current" | "merged" | "historical";
  };
  binding: {
    workspaceId: string;
    recordId: string;
    reviewJobId: string;
    acceptanceContract: AcceptanceRecordSummaryContractIdentity;
    repo: string;
    prNumber: number;
    expectedHeadSha: string;
  };
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
  createdAt: Date;
  updatedAt: Date;
};

export type AcceptanceRecordDetailCompiledPackBinding = {
  sourceSnapshotId: string;
  workspaceId: string;
  recordId: string;
  reviewJobId: string;
  acceptanceContractId: string;
  acceptanceContractVersion: number;
  acceptanceContractSha256: string;
  repo: string;
  prNumber: number;
  baseSha: string;
  mergeBaseSha: string;
  headSha: string;
  headTreeSha: string;
  packetSetSha256: string;
  correctionPacketPayloadSetSha256: string;
  sourceSnapshotCompilerVersion: string;
  baseIndexRevisionSha256: string;
  overlayManifestSha256: string;
};

export type AcceptanceRecordDetailCompiledPackSource =
  | {
      kind: "exact_head_overlay";
      path: string;
      blobSha: string;
      fullContentSha256: string;
      startLine: number;
      endLine: number;
      rangeSha256: string;
      byteCount: number;
      reason: "exact_patch_head_range";
      citation: string;
    }
  | {
      kind: "exact_head_dependency";
      path: string;
      blobSha: string;
      fullContentSha256: string;
      startLine: number;
      endLine: number;
      rangeSha256: string;
      byteCount: number;
      reason: "static_relative_import" | "static_python_import" | "static_shell_source";
      citation: string;
    }
  | {
      kind: "base_index_background";
      pageId: string;
      slug: string;
      commitSha: string;
      inputsHashSha256: string;
      pageBodySha256: string;
      stale: false;
      startLine: number;
      endLine: number;
      rangeSha256: string;
      byteCount: number;
      reason: "background_only";
      citation: string;
    };

export type AcceptanceRecordDetailCompiledPackExclusionReason =
  | "removed_at_exact_head"
  | "missing_patch_ranges"
  | "range_byte_limit"
  | "range_byte_or_secret_limit"
  | "unsupported_dependency_expression"
  | "dependency_limit"
  | "dependency_not_found"
  | "base_index_gap"
  | "base_index_stale"
  | "base_index_content_limit"
  | "base_index_secret_policy"
  | "base_index_page_limit"
  | "pack_budget"
  | `dependency_${AcceptanceRecordDetailDirectReadNotProvenReason}`;

export type AcceptanceRecordDetailCompiledPackExclusion = {
  source: "exact_head_overlay" | "exact_head_dependency" | "base_index_background";
  path: string | null;
  reason: AcceptanceRecordDetailCompiledPackExclusionReason;
  identitySha256?: string;
};

export type AcceptanceRecordDetailSourceCustodyFile = {
  path: string;
  blobSha: string;
  previousPath: null;
  contentSha256: string;
  byteCount: number;
  lineCount: number;
  source: "exact_head_overlay" | "exact_head_tree_fallback";
  reason: "exact_base_to_head_compare" | "exact_head_tree_path";
};

export type AcceptanceRecordDetailSourceCustodyExclusion = {
  path: string;
  source: "exact_head_overlay" | "exact_head_tree_fallback";
  blobSha: string | null;
  byteCount: number | null;
  reason: "removed_at_exact_head" | "secret_path_policy" | "secret_content_policy";
  secretKinds: string[];
  findingCount: number;
};

export type AcceptanceRecordDetailDirectReadNotProvenReason =
  | "invalid_input"
  | "github_unavailable"
  | "github_rejected"
  | "invalid_tree"
  | "tree_limit"
  | "call_limit"
  | "invalid_blob"
  | "path_not_found"
  | "content_limit"
  | "unsafe_content"
  | "unsafe_path";

export type AcceptanceRecordDetailDirectReadReceipt =
  | {
      requestedPath: string;
      headSha: string;
      headTreeSha: string;
      outcome: "record";
      record: AcceptanceRecordDetailSourceCustodyFile;
    }
  | {
      requestedPath: string;
      headSha: string;
      headTreeSha: string;
      outcome: "not_proven";
      reason: AcceptanceRecordDetailDirectReadNotProvenReason;
      exclusion?: AcceptanceRecordDetailSourceCustodyExclusion;
    };

export type AcceptanceRecordDetailSelectedExactRange = {
  kind: "exact_head_overlay" | "exact_head_dependency";
  path: string;
  blobSha: string;
  fullContentSha256: string;
  startLine: number;
  endLine: number;
  rangeSha256: string;
  byteCount: number;
};

export type AcceptanceRecordDetailCompiledPack = {
  id: string;
  sourceSnapshotId: string;
  compilerVersion: string;
  policyVersion: string;
  packSha256: string;
  sourceCustodyIdentitySha256: string;
  representations: {
    jsonSha256: string;
    markdownSha256: string;
    renderedByteCount: number;
  };
  binding: AcceptanceRecordDetailCompiledPackBinding;
  manifest: {
    acceptanceCriterionIds: string[];
    unresolvedQuestionIds: string[];
    packetIds: string[];
    sources: AcceptanceRecordDetailCompiledPackSource[];
    exclusions: AcceptanceRecordDetailCompiledPackExclusion[];
    sourceCount: number;
    exclusionCount: number;
    architectureBoundaries: string[];
    tests: string[];
    decisions: string[];
    custody: {
      fullSourceUploadAllowed: false;
      rawSourcePersisted: false;
      snippetsPersisted: false;
    };
  };
  sourceCustody: {
    kind: "exact_head_source_custody";
    schemaVersion: 2;
    repo: string;
    prNumber: number;
    baseSha: string;
    mergeBaseSha: string;
    headSha: string;
    headTreeSha: string;
    manifestSha256: string;
    identitySha256: string;
    changedManifest: Array<{
      path: string;
      status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed";
      blobSha: string | null;
      previousPath: string | null;
      headRanges: Array<{ startLine: number; endLine: number }>;
      patchSha256: string | null;
      patchByteCount: number | null;
    }>;
    records: AcceptanceRecordDetailSourceCustodyFile[];
    exclusions: AcceptanceRecordDetailSourceCustodyExclusion[];
    directReadReceipts: AcceptanceRecordDetailDirectReadReceipt[];
    selectedExactRanges: AcceptanceRecordDetailSelectedExactRange[];
    changedFileCount: number;
    recordCount: number;
    exclusionCount: number;
    directReadReceiptCount: number;
    selectedExactRangeCount: number;
  };
  exactHeadDependencyTreeProofs: AcceptanceCompiledContextPackDependencyTreeProof[];
  createdAt: Date;
};

export type AcceptanceRecordDetailContextPack = {
  occurrence: AcceptanceRecordDetailOccurrenceIdentity & {
    kind: "current" | "merged" | "historical";
  };
  sourceSnapshot: AcceptanceRecordDetailSourceSnapshot;
  /** Every entry is a separately valid compiler/policy variant. No variant is
   * projected as selected when the summary view reports ambiguity. */
  compiledPacks: AcceptanceRecordDetailCompiledPack[];
};

export type AcceptanceRecordDetailReview =
  | { kind: "not_recorded" }
  | {
      kind: "not_posted";
      reviewJobId: string;
      state: Exclude<AcceptanceRecordDetailReviewJobState, "posted">;
    }
  | {
      kind: "posted";
      reviewJobId: string;
      verdict: "proven" | "failed" | "not_proven" | "not_testable";
      postedReviewUrl: string;
      postedAttestationEventId: string;
      reviewedAt: Date;
    };

export type AcceptanceRecordDetailCriterionUnknownReason =
  | "review_not_recorded"
  | "review_not_posted"
  | "criterion_result_not_durably_rederivable";

export type AcceptanceRecordDetailCorrectionPacket =
  Omit<GitHubCorrectionPacketPayload, "affectedContext" | "evidence"> & {
    affectedContext: Omit<GitHubCorrectionPacketPayload["affectedContext"], "flow" | "reproduction"> & {
      flow: string;
      reproduction: NonNullable<GitHubCorrectionPacketPayload["affectedContext"]["reproduction"]>;
    };
    evidence: GitHubCorrectionPacketPayload["evidence"] & { previewBootId: string };
  };

export type AcceptanceRecordDetailCriterionProof =
  | {
      kind: "correction_packet";
      state: "failed" | "not_proven";
      packet: AcceptanceRecordDetailCorrectionPacket;
    }
  | {
      kind: "unknown";
      reason: AcceptanceRecordDetailCriterionUnknownReason;
    };

export type AcceptanceRecordDetailProofCycle = {
  occurrence: AcceptanceRecordDetailOccurrenceIdentity & {
    kind: "current" | "merged" | "historical";
  };
  review: AcceptanceRecordDetailReview;
  criteria: Array<{
    criterion: AcceptanceConfirmedContractProjection["acceptanceCriteria"][number];
    proof: AcceptanceRecordDetailCriterionProof;
  }>;
};

export type AcceptanceRecordDetail = {
  summary: AcceptanceRecordSummary;
  contract: AcceptanceRecordDetailContract;
  pullRequest: AcceptanceRecordDetailPullRequest;
  contextPacks: AcceptanceRecordDetailContextPack[];
  proofMatrix: AcceptanceRecordDetailProofCycle[];
  artifactCustody: {
    kind: "unknown";
    reason: "artifact_custody_not_available";
  };
  gatedIssue: {
    kind: "unknown";
    reason: "gated_issue_custody_not_available";
  };
};

export type AcceptanceRecordDetailUnavailableReason =
  | "invalid_record_custody"
  | "confirmed_contract_unavailable"
  | "event_custody_limit"
  | "snapshot_custody_limit"
  | "compiled_pack_custody_limit"
  | "detail_output_limit"
  | "invalid_occurrence_custody"
  | "invalid_review_custody"
  | "invalid_context_custody"
  | "invalid_compiled_pack_custody";

export type ReadAcceptanceRecordDetailResult =
  | { kind: "record"; detail: AcceptanceRecordDetail }
  | { kind: "not_found" }
  | { kind: "unavailable"; reason: AcceptanceRecordDetailUnavailableReason };

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

export type GithubNativeAcceptanceBuilderRouteAdapter =
  | "github_codex"
  | "github_claude";

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

/**
 * Closed, metadata-only policy for a later GitHub-native correction carrier.
 * It permits a future carrier attempt; it does not assert the vendor is
 * installed, accepted the carrier, started, acknowledged, or repaired.
 */
export type AcceptanceBuilderRouteCapabilityProfileSnapshot = {
  kind: "acceptance_builder_route_capability_profile";
  version: 1;
  workspaceId: string;
  repo: string;
  routeId: string;
  adapter: GithubNativeAcceptanceBuilderRouteAdapter;
  routeConfigurationVersion: number;
  carrier: "github_issue_comment";
  carrierIdentity: "workspace_github_app_installation";
  findingPublication: "individual_no_vendor_mentions";
  activation: "single_final_vendor_mention";
  recipient: "codex" | "claude";
  configuration: "configuration_bound";
  preflight: "required";
  vendorAvailability: "not_asserted";
  vendorActivity: "required";
  repairHead: "github_synchronize";
  scopeBoundary: "correction_delivery_only";
  githubInstallationIdentitySha256: string;
};

/** Public shape has no caller-controlled adapter, recipient, or carrier data. */
export type RecordAcceptanceBuilderRouteCapabilityProfileInput = {
  workspaceId: string;
  routeId: string;
  recordedBy: string;
};

export const GITHUB_CLAUDE_ACK_OIDC_ISSUER =
  "https://token.actions.githubusercontent.com" as const;
export const GITHUB_CLAUDE_ACK_OIDC_AUDIENCE_PREFIX =
  "agentrail://correction-dispatch/github-claude/ack/v1" as const;
export const GITHUB_CLAUDE_ACK_OIDC_AUDIENCE_CONTRACT =
  "activation_comment_run_attempt_sha256_v1" as const;
export const GITHUB_CLAUDE_ACK_OIDC_SUBJECT_CONTRACT =
  "default_repo_ref_legacy_or_immutable_v1" as const;
export const GITHUB_CLAUDE_ACK_WORKFLOW_CONTRACT =
  "github_claude_action_success_session_v1" as const;
export const GITHUB_CLAUDE_ACK_APPROVED_ACTION_SHA =
  "6b082c41935b4c8a3b8b0ef85ba4ba4d9eeb8975" as const;
const GITHUB_CLAUDE_ACK_PROTOCOL_VERSION = 1 as const;
export const GITHUB_CLAUDE_REPAIR_OBSERVATION_OIDC_AUDIENCE_PREFIX =
  "agentrail://correction-dispatch/github-claude/repair-observation/v1" as const;
const GITHUB_CLAUDE_REPAIR_OBSERVATION_PROTOCOL_VERSION = 1 as const;

export type AcceptanceBuilderRouteGithubClaudeAckProfileSnapshot = {
  kind: "acceptance_builder_route_github_claude_ack_profile";
  version: 1;
  workspaceId: string;
  repo: string;
  routeId: string;
  adapter: "github_claude";
  routeConfigurationVersion: number;
  capabilityProfile: { id: string; snapshotSha256: string };
  provider: "anthropic_claude_code_action";
  acknowledgement: "action_success_with_session";
  githubRepository: { id: string; ownerId: string };
  triggerActor: { id: string; login: string };
  oidc: {
    issuer: typeof GITHUB_CLAUDE_ACK_OIDC_ISSUER;
    audienceContract: typeof GITHUB_CLAUDE_ACK_OIDC_AUDIENCE_CONTRACT;
    subjectContract: typeof GITHUB_CLAUDE_ACK_OIDC_SUBJECT_CONTRACT;
    eventName: "issue_comment";
    callerWorkflowRef: string;
    jobWorkflowRef: string;
    jobWorkflowSha: string;
  };
  claudeActionSha: string;
  workflowContract: typeof GITHUB_CLAUDE_ACK_WORKFLOW_CONTRACT;
  scopeBoundary: "agent_acknowledgement_only";
};

/** Server-only policy registration; no secret or provider session is accepted. */
export type RecordAcceptanceBuilderRouteGithubClaudeAckProfileInput = {
  workspaceId: string;
  routeId: string;
  githubRepositoryId: string;
  githubRepositoryOwnerId: string;
  githubAppBotUserId: string;
  githubAppBotLogin: string;
  callerWorkflowRef: string;
  jobWorkflowRef: string;
  jobWorkflowSha: string;
  claudeActionSha: string;
  recordedBy: string;
};

/** Signature/time verification happens at the Console boundary before normalization. */
export type GithubClaudeAckNormalizedOidcClaims = {
  issuer: typeof GITHUB_CLAUDE_ACK_OIDC_ISSUER;
  audience: string;
  subject: string;
  subjectSha256: string;
  jtiSha256: string;
  issuedAt: number;
  notBefore: number;
  expiresAt: number;
  repository: string;
  repositoryId: string;
  repositoryOwner: string;
  repositoryOwnerId: string;
  actor: string;
  actorId: string;
  eventName: "issue_comment";
  ref: string;
  workflowRef: string;
  workflowSha: string;
  jobWorkflowRef: string;
  jobWorkflowSha: string;
  runId: string;
  runAttempt: 1;
  checkRunId: string;
};

export type RecordGithubClaudeAgentAcknowledgementInput = {
  activationCommentId: string;
  activationBodySha256: string;
  conclusion: "success";
  providerSessionId: string;
  oidc: GithubClaudeAckNormalizedOidcClaims;
};

export type RecordGithubClaudeAgentAcknowledgementResult =
  | { kind: "recorded"; receipt: AcceptanceCorrectionDispatchGithubClaudeAckReceiptRow }
  | { kind: "replayed"; receipt: AcceptanceCorrectionDispatchGithubClaudeAckReceiptRow }
  | { kind: "not_admitted" };

/** A valid callback identity was already consumed by different receipt data. */
export class GithubClaudeAgentAcknowledgementConflictError extends Error {
  readonly code = "GITHUB_CLAUDE_ACK_CONFLICT" as const;

  constructor() {
    super("GitHub Claude acknowledgement is already bound to different receipt data");
    this.name = "GithubClaudeAgentAcknowledgementConflictError";
  }
}

export type RecordGithubClaudeRepairObservationInput = {
  activationCommentId: string;
  activationBodySha256: string;
  beforeHeadSha: string;
  afterHeadSha: string;
  providerSessionId: string;
  oidc: GithubClaudeAckNormalizedOidcClaims;
};

export type RecordGithubClaudeRepairObservationResult =
  | { kind: "recorded"; observation: AcceptanceCorrectionDispatchGithubClaudeRepairObservationRow }
  | { kind: "replayed"; observation: AcceptanceCorrectionDispatchGithubClaudeRepairObservationRow }
  | { kind: "not_admitted" };

/** A valid repair-observation identity was already consumed by other data. */
export class GithubClaudeRepairObservationConflictError extends Error {
  readonly code = "GITHUB_CLAUDE_REPAIR_OBSERVATION_CONFLICT" as const;

  constructor() {
    super("GitHub Claude repair observation is already bound to different receipt data");
    this.name = "GithubClaudeRepairObservationConflictError";
  }
}

export type GithubClaudeRepairHeadEvidence = {
  kind: "github_claude_repair_head_evidence";
  version: 1;
  workspaceId: string;
  recordId: string;
  repo: string;
  prNumber: number;
  dispatchId: string;
  dispatchIdentitySha256: string;
  activationId: string;
  activationIdentitySha256: string;
  acknowledgementReceiptId: string;
  acknowledgementReceiptIdentitySha256: string;
  observationId: string;
  observationIdentitySha256: string;
  originalHeadSha: string;
  originalHeadCycleId: string;
  repairHeadSha: string;
  repairHeadCycleId: string;
  githubDeliveryId: string;
  githubDeliveryEventId: string;
  githubHeadAdvanceEventId: string;
  reviewJobId: string;
  providerSessionIdSha256: string;
  oidcRunId: string;
  oidcRunAttempt: 1;
  oidcCheckRunId: string;
  attribution: "selected_run_observed_successor";
  authorship: "not_independently_proven";
  reviewRequirement: "exact_head_r7_reentry";
  evidenceIdentitySha256: string;
};

/** Shared with Console so the verified JWT audience cannot drift from DB admission. */
export function githubClaudeAcknowledgementAudience(input: {
  activationCommentId: string;
  runId: string;
  runAttempt: number;
}): string | null {
  if (!/^[1-9][0-9]{0,39}$/.test(input.activationCommentId)
    || !/^[1-9][0-9]{0,39}$/.test(input.runId)
    || input.runAttempt !== 1) return null;
  const binding = [
    "github_claude_ack", "1", input.activationCommentId, input.runId, "1",
  ].join(":");
  return `${GITHUB_CLAUDE_ACK_OIDC_AUDIENCE_PREFIX}/${createHash("sha256")
    .update(binding, "utf8").digest("hex")}`;
}

/**
 * Shared by Console and Postgres so the second OIDC token is bound to the
 * exact activation, original head, observed successor, run, and first attempt.
 */
export function githubClaudeRepairObservationAudience(input: {
  activationCommentId: string;
  activationBodySha256: string;
  beforeHeadSha: string;
  afterHeadSha: string;
  runId: string;
  runAttempt: number;
}): string | null {
  if (!/^[1-9][0-9]{0,39}$/.test(input.activationCommentId)
    || !EXACT_SHA256.test(input.activationBodySha256)
    || !EXACT_GITHUB_HEAD_SHA.test(input.beforeHeadSha)
    || !EXACT_GITHUB_HEAD_SHA.test(input.afterHeadSha)
    || input.beforeHeadSha.toLowerCase() === input.afterHeadSha.toLowerCase()
    || !/^[1-9][0-9]{0,39}$/.test(input.runId)
    || input.runAttempt !== 1) return null;
  const binding = [
    "github_claude_repair_observation",
    "1",
    input.activationCommentId,
    input.activationBodySha256.toLowerCase(),
    input.beforeHeadSha.toLowerCase(),
    input.afterHeadSha.toLowerCase(),
    input.runId,
    "1",
  ].join(":");
  return `${GITHUB_CLAUDE_REPAIR_OBSERVATION_OIDC_AUDIENCE_PREFIX}/${createHash("sha256")
    .update(binding, "utf8").digest("hex")}`;
}

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

function isServerBuilderRouteActor(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 8
    && value.length <= 256
    && /^server:[A-Za-z0-9][A-Za-z0-9._@+-]*$/.test(value);
}

function isBuilderRouteAdapter(value: unknown): value is AcceptanceBuilderRouteAdapter {
  return value === "github_codex" || value === "github_claude"
    || value === "durable_github_fallback" || value === "durable_jace_fallback";
}

export function isGithubNativeBuilderRouteAdapter(
  value: unknown
): value is GithubNativeAcceptanceBuilderRouteAdapter {
  return value === "github_codex" || value === "github_claude";
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

/**
 * Canonical JSON for the compiled-Pack trust boundary. Unlike legacy snapshot
 * identities, keys are ordered by their UTF-8 bytes so Node and DB consumers
 * can re-hash the exact compiler/source-custody payload without locale drift.
 */
export function acceptanceContextPackCanonicalJson(value: unknown): string {
  const encode = (item: unknown): string => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new Error("Context Pack canonical JSON cannot encode a non-finite number");
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) return `[${item.map(encode).join(",")}]`;
    if (!isRecord(item) || Object.getPrototypeOf(item) !== Object.prototype) {
      throw new Error("Context Pack canonical JSON requires plain JSON values");
    }
    const keys = Object.keys(item).sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
    return `{${keys.map((key) => {
      const nested = item[key];
      if (nested === undefined) throw new Error("Context Pack canonical JSON cannot encode undefined");
      return `${JSON.stringify(key)}:${encode(nested)}`;
    }).join(",")}}`;
  };
  return encode(value);
}

/** SHA-256 counterpart of {@link acceptanceContextPackCanonicalJson}. */
export function acceptanceContextPackCanonicalSha256(value: unknown): string {
  return createHash("sha256").update(acceptanceContextPackCanonicalJson(value), "utf8").digest("hex");
}

function positiveBoundedInteger(value: unknown, max: number): value is number {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= max;
}

function nonNegativeBoundedInteger(value: unknown, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= max;
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

type ReviewJobCorrectionPacketCustodyBinding = {
  workspaceId: string;
  recordId: string;
  reviewJobId: string;
  acceptanceContractId: string;
  acceptanceContractVersion: number;
  repo: string;
  prNumber: number;
  expectedHeadSha: string;
};

function correctionPacketIdForSnapshotEvent(
  event: ChangeRecordEventRow,
  input: ReviewJobCorrectionPacketCustodyBinding,
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
  return event.id === changeRecordEventId({ recordId: input.recordId, eventKey })
    && event.recordId === input.recordId
    && event.eventKey === eventKey && event.stage === "review" && event.actor === "reviewer-of-record"
    ? packetId
    : null;
}

function correctionPacketPayloadsForSnapshotEvents(
  events: readonly ChangeRecordEventRow[],
  input: ReviewJobCorrectionPacketCustodyBinding,
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

export type ReadCurrentAcceptanceCorrectionPacketsInput = {
  workspaceId: string;
  recordId: string;
};

export type CurrentAcceptanceCorrectionPackets = {
  binding: {
    workspaceId: string;
    recordId: string;
    reviewJobId: string;
    repo: string;
    prNumber: number;
    headSha: string;
    headCycleId: string;
    authorityGeneration: number;
    acceptanceContract: {
      id: string;
      version: number;
      sha256: string;
    };
  };
  packetIds: string[];
  packetSetSha256: string;
  correctionPacketPayloadSetSha256: string;
  packets: Record<string, unknown>[];
};

export type ReadCurrentAcceptanceCorrectionPacketsNotReadyReason =
  | "review_job_unavailable"
  | "confirmed_contract_unavailable"
  | "no_correction_packets"
  | "invalid_packet_custody";

export type ReadCurrentAcceptanceCorrectionPacketsResult =
  | ({ kind: "current" } & CurrentAcceptanceCorrectionPackets)
  | { kind: "not_found" }
  | { kind: "not_current" }
  | { kind: "not_ready"; reason: ReadCurrentAcceptanceCorrectionPacketsNotReadyReason };

/**
 * Returns only the immutable R8.1 packets for the Record's server-derived
 * current authoritative head cycle. Historical packet events remain in the
 * timeline for audit, but can never be selected by this operational read.
 */
export async function readCurrentAcceptanceCorrectionPackets(
  input: ReadCurrentAcceptanceCorrectionPacketsInput
): Promise<ReadCurrentAcceptanceCorrectionPacketsResult> {
  if (!isRecord(input) || !hasExactKeys(input, ["workspaceId", "recordId"])
    || !isUuid(input.workspaceId) || !isUuid(input.recordId)) {
    throw new Error("Current correction packet read requires only workspace and Record");
  }

  const candidate = (await db.select().from(changeRecords).where(and(
    eq(changeRecords.id, input.recordId),
    eq(changeRecords.workspaceId, input.workspaceId),
  )).limit(1))[0];
  if (!candidate) return { kind: "not_found" };
  if (candidate.prNumber == null) return { kind: "not_current" };

  const lockKey = acceptanceRecordPullRequestLockKey({
    workspaceId: input.workspaceId,
    recordId: input.recordId,
    repo: candidate.repo,
    prNumber: candidate.prNumber,
  });
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const record = (await tx.select().from(changeRecords).where(and(
      eq(changeRecords.id, input.recordId),
      eq(changeRecords.workspaceId, input.workspaceId),
    )).limit(1))[0];
    if (!record) return { kind: "not_found" };
    if (record.repo !== candidate.repo || record.prNumber !== candidate.prNumber
      || record.prNumber == null || !record.currentPrHeadAuthoritative
      || typeof record.currentPrHeadSha !== "string" || !EXACT_SHA1.test(record.currentPrHeadSha)
      || !isUuid(record.currentPrHeadCycleId)
      || !record.headShas.includes(record.currentPrHeadSha)) {
      return { kind: "not_current" };
    }

    const headSha = record.currentPrHeadSha;
    const headCycleId = record.currentPrHeadCycleId;
    const job = (await tx.select().from(reviewJobs).where(and(
      eq(reviewJobs.id, headCycleId),
      eq(reviewJobs.workspaceId, input.workspaceId),
      eq(reviewJobs.repo, record.repo),
      eq(reviewJobs.prNumber, record.prNumber),
      eq(reviewJobs.headSha, headSha),
    )).limit(1))[0];
    if (!job) return { kind: "not_ready", reason: "review_job_unavailable" };

    const confirmedRows = await tx.select().from(acceptanceContracts).where(and(
      eq(acceptanceContracts.recordId, record.id),
      eq(acceptanceContracts.status, "confirmed"),
    )).orderBy(asc(acceptanceContracts.version));
    if (confirmedRows.length !== 1) {
      return { kind: "not_ready", reason: "confirmed_contract_unavailable" };
    }
    const confirmed = confirmedRows[0]!;
    const contract = projectConfirmedAcceptanceContract(confirmed.contract);
    if (!contract) return { kind: "not_ready", reason: "invalid_packet_custody" };
    const criteria = new Map(contract.acceptanceCriteria.map((criterion) => [criterion.id, criterion.text]));

    const events = await tx.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, record.id),
      sql`${changeRecordEvents.eventKey} LIKE ${`review:correction:${headCycleId}:%`}`,
    )).orderBy(asc(changeRecordEvents.eventKey));
    if (events.length === 0) return { kind: "not_ready", reason: "no_correction_packets" };
    if (events.length > 100) return { kind: "not_ready", reason: "invalid_packet_custody" };

    const packetSet = correctionPacketPayloadsForSnapshotEvents(events, {
      workspaceId: input.workspaceId,
      recordId: record.id,
      reviewJobId: job.id,
      acceptanceContractId: confirmed.id,
      acceptanceContractVersion: confirmed.version,
      repo: record.repo,
      prNumber: record.prNumber,
      expectedHeadSha: headSha,
    }, criteria);
    if (!packetSet || packetSet.packetIds.length === 0) {
      return { kind: "not_ready", reason: "invalid_packet_custody" };
    }

    let acceptanceContractDigest: string;
    let packetPayloadSetDigest: string;
    try {
      acceptanceContractDigest = acceptanceContractSha256({
        acceptanceContractId: confirmed.id,
        acceptanceContractVersion: confirmed.version,
        contract: confirmed.contract,
      });
      packetPayloadSetDigest = acceptanceCorrectionPacketPayloadSetSha256({ packets: packetSet.packets });
    } catch {
      return { kind: "not_ready", reason: "invalid_packet_custody" };
    }

    return {
      kind: "current",
      binding: {
        workspaceId: record.workspaceId,
        recordId: record.id,
        reviewJobId: job.id,
        repo: record.repo,
        prNumber: record.prNumber,
        headSha,
        headCycleId,
        authorityGeneration: record.currentPrHeadAuthorityGeneration,
        acceptanceContract: {
          id: confirmed.id,
          version: confirmed.version,
          sha256: acceptanceContractDigest,
        },
      },
      packetIds: packetSet.packetIds,
      packetSetSha256: acceptanceContextPacketSetSha256({ packetIds: packetSet.packetIds }),
      correctionPacketPayloadSetSha256: packetPayloadSetDigest,
      packets: packetSet.packets,
    };
  });
}

/** The human decision never rewrites Jace's independently posted verdict. */
export type AcceptancePrDecision =
  | "approved"
  | "changes_requested"
  | "rejected"
  | "approved_with_exception";

export type AcceptancePrDecisionRole = "owner" | "admin";

export type CurrentAcceptancePrDecisionBinding = {
  /** Opaque optimistic-concurrency binding issued by the current-cycle read. */
  bindingId: string;
  workspaceId: string;
  recordId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  headCycleId: string;
  authorityGeneration: number;
  reviewJobId: string;
  reviewVerdict: "proven" | "failed" | "not_proven" | "not_testable";
  postedReviewUrl: string;
  postedAttestationEventId: string;
  acceptanceContract: {
    id: string;
    version: number;
    sha256: string;
  };
};

export type CurrentAcceptancePrDecision = {
  eventId: string;
  eventKey: string;
  decision: AcceptancePrDecision;
  rationale: string | null;
  decidedBy: string;
  decidedRole: AcceptancePrDecisionRole;
  decidedAt: Date;
};

export type ReadCurrentAcceptancePrDecisionInput = {
  workspaceId: string;
  recordId: string;
};

export type ReadCurrentAcceptancePrDecisionNotReadyReason =
  | "review_job_unavailable"
  | "confirmed_contract_unavailable"
  | "posted_attestation_unavailable"
  | "invalid_review_custody"
  | "invalid_decision_custody";

export type CurrentAcceptancePrDecisionState = {
  binding: CurrentAcceptancePrDecisionBinding;
  decision: CurrentAcceptancePrDecision | null;
};

export type ReadCurrentAcceptancePrDecisionResult =
  | ({ kind: "current" } & CurrentAcceptancePrDecisionState)
  | { kind: "not_found" }
  | { kind: "not_current" }
  | { kind: "not_ready"; reason: ReadCurrentAcceptancePrDecisionNotReadyReason };

export type RecordAcceptancePrDecisionInput = {
  workspaceId: string;
  recordId: string;
  bindingId: string;
  decision: AcceptancePrDecision;
  rationale?: string;
  decidedBy: string;
};

export type RecordAcceptancePrDecisionResult =
  | ({ kind: "recorded" | "replayed" } & {
      binding: CurrentAcceptancePrDecisionBinding;
      decision: CurrentAcceptancePrDecision;
    })
  | { kind: "not_found" }
  | { kind: "not_current" }
  | { kind: "not_authorized" }
  | { kind: "not_ready"; reason: ReadCurrentAcceptancePrDecisionNotReadyReason }
  | { kind: "decision_not_allowed"; reason: "approval_requires_proven" };

/** Stable business conflict; database/storage failures remain ordinary errors. */
export class AcceptancePrDecisionConflictError extends Error {
  readonly code = "ACCEPTANCE_PR_DECISION_CONFLICT" as const;

  constructor() {
    super("The current PR head cycle already has a different human decision");
    this.name = "AcceptancePrDecisionConflictError";
  }
}

const ACCEPTANCE_PR_DECISION_KIND = "acceptance_pr_decision";
const ACCEPTANCE_PR_DECISION_VERSION = 1;
const ACCEPTANCE_PR_DECISION_STAGE = "human_pr_decision";
const REVIEW_JOB_POSTED_ATTESTATION_KIND = "review_job_github_posted";
const REVIEW_JOB_POSTED_ATTESTATION_STAGE = "review";
const REVIEW_JOB_POSTED_ATTESTATION_ACTOR = "reviewer-of-record";
const ACCEPTANCE_PR_DECISION_RATIONALE_LIMIT = 4_000;
const LOWER_SHA256 = /^[a-f0-9]{64}$/;
const HUMAN_DECISION_ACTOR = /^user:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

function acceptancePrDecisionEventKey(headCycleId: string): string {
  return `acceptance-pr-decision:${headCycleId}`;
}

function reviewJobPostedAttestationEventKey(reviewJobId: string): string {
  return `review:github-posted:${reviewJobId}`;
}

function isAcceptancePrDecision(value: unknown): value is AcceptancePrDecision {
  return value === "approved" || value === "changes_requested"
    || value === "rejected" || value === "approved_with_exception";
}

function canonicalAcceptancePrDecisionRationale(value: unknown): string | null | undefined {
  if (value === undefined) return null;
  if (typeof value !== "string") return undefined;
  const rationale = value.trim();
  if (!rationale) return null;
  return safeSnapshotText(rationale, ACCEPTANCE_PR_DECISION_RATIONALE_LIMIT)
    ? rationale
    : undefined;
}

function parseAcceptancePrDecisionInput(input: unknown): {
  workspaceId: string;
  recordId: string;
  bindingId: string;
  decision: AcceptancePrDecision;
  rationale: string | null;
  decidedBy: string;
  decidedByUserId: string;
} | null {
  if (!isRecord(input)) return null;
  const keys = hasOwn(input, "rationale")
    ? ["workspaceId", "recordId", "bindingId", "decision", "rationale", "decidedBy"]
    : ["workspaceId", "recordId", "bindingId", "decision", "decidedBy"];
  if (!hasExactKeys(input, keys) || !isUuid(input["workspaceId"])
    || !isUuid(input["recordId"]) || !isUuid(input["bindingId"])
    || !isAcceptancePrDecision(input["decision"])
    || typeof input["decidedBy"] !== "string") return null;
  const actorMatch = HUMAN_DECISION_ACTOR.exec(input["decidedBy"]);
  const rationale = canonicalAcceptancePrDecisionRationale(input["rationale"]);
  if (!actorMatch || rationale === undefined
    || (input["decision"] === "approved_with_exception" && rationale === null)) return null;
  return {
    workspaceId: input["workspaceId"], recordId: input["recordId"],
    bindingId: input["bindingId"] as string,
    decision: input["decision"], rationale,
    decidedBy: `user:${actorMatch[1]!.toLowerCase()}`,
    decidedByUserId: actorMatch[1]!.toLowerCase(),
  };
}

function isAcceptanceReviewVerdict(
  value: unknown
): value is CurrentAcceptancePrDecisionBinding["reviewVerdict"] {
  return value === "proven" || value === "failed"
    || value === "not_proven" || value === "not_testable";
}

function acceptancePrDecisionBindingId(
  input: Omit<CurrentAcceptancePrDecisionBinding, "bindingId">
): string {
  return uuid5Url([
    "acceptance-pr-decision-binding",
    input.workspaceId,
    input.recordId,
    input.repo,
    input.prNumber,
    input.headSha,
    input.headCycleId,
    input.authorityGeneration,
    input.reviewJobId,
    input.reviewVerdict,
    input.postedReviewUrl,
    input.postedAttestationEventId,
    input.acceptanceContract.id,
    input.acceptanceContract.version,
    input.acceptanceContract.sha256,
  ].join(":"));
}

function isCanonicalGithubReviewUrl(value: unknown, repo: string, prNumber: number): value is string {
  if (typeof value !== "string" || value.length > 2_048 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com"
      && url.username === "" && url.password === "" && url.port === ""
      && url.pathname === `/${repo}/pull/${prNumber}` && url.search === ""
      && /^#pullrequestreview-[1-9][0-9]*$/.test(url.hash);
  } catch {
    return false;
  }
}

function matchesCanonicalPostedReviewAttestation(input: {
  event: ChangeRecordEventRow;
  binding: Omit<CurrentAcceptancePrDecisionBinding,
    "bindingId" | "reviewVerdict" | "postedReviewUrl" | "postedAttestationEventId">;
  postedReviewUrl: string;
}): boolean {
  const { event, binding } = input;
  const payload = event.payloadRef;
  const requiredKeys = [
    "kind", "jobId", "workspaceId", "repo", "prNumber", "headSha", "recordId",
    "acceptanceContractId", "acceptanceContractVersion", "outcomeDigest",
    "postPayloadDigest", "postedReviewUrl",
  ];
  const allowedShape = hasExactKeys(payload, requiredKeys)
    || hasExactKeys(payload, [...requiredKeys, "inlineCommentsPosted"])
    || hasExactKeys(payload, [...requiredKeys, "commentsFolded"])
    || hasExactKeys(payload, [...requiredKeys, "inlineCommentsPosted", "commentsFolded"]);
  const expectedEventKey = reviewJobPostedAttestationEventKey(binding.reviewJobId);
  return allowedShape
    && event.id === changeRecordEventId({ recordId: binding.recordId, eventKey: expectedEventKey })
    && event.recordId === binding.recordId && event.eventKey === expectedEventKey
    && event.stage === REVIEW_JOB_POSTED_ATTESTATION_STAGE
    && event.actor === REVIEW_JOB_POSTED_ATTESTATION_ACTOR
    && payload["kind"] === REVIEW_JOB_POSTED_ATTESTATION_KIND
    && payload["jobId"] === binding.reviewJobId
    && payload["workspaceId"] === binding.workspaceId
    && payload["repo"] === binding.repo && payload["prNumber"] === binding.prNumber
    && payload["headSha"] === binding.headSha && payload["recordId"] === binding.recordId
    && payload["acceptanceContractId"] === binding.acceptanceContract.id
    && payload["acceptanceContractVersion"] === binding.acceptanceContract.version
    && typeof payload["outcomeDigest"] === "string" && LOWER_SHA256.test(payload["outcomeDigest"])
    && typeof payload["postPayloadDigest"] === "string" && LOWER_SHA256.test(payload["postPayloadDigest"])
    && payload["postedReviewUrl"] === input.postedReviewUrl
    && isCanonicalGithubReviewUrl(payload["postedReviewUrl"], binding.repo, binding.prNumber)
    && (!hasOwn(payload, "inlineCommentsPosted")
      || (Number.isInteger(payload["inlineCommentsPosted"])
        && (payload["inlineCommentsPosted"] as number) >= 0
        && (payload["inlineCommentsPosted"] as number) <= 100))
    && (!hasOwn(payload, "commentsFolded") || typeof payload["commentsFolded"] === "boolean");
}

function acceptancePrDecisionPayload(input: {
  binding: CurrentAcceptancePrDecisionBinding;
  decision: AcceptancePrDecision;
  rationale: string | null;
  decidedBy: string;
  decidedRole: AcceptancePrDecisionRole;
}): Record<string, unknown> {
  return {
    kind: ACCEPTANCE_PR_DECISION_KIND,
    version: ACCEPTANCE_PR_DECISION_VERSION,
    bindingId: input.binding.bindingId,
    workspaceId: input.binding.workspaceId,
    recordId: input.binding.recordId,
    repo: input.binding.repo,
    prNumber: input.binding.prNumber,
    headSha: input.binding.headSha,
    headCycleId: input.binding.headCycleId,
    authorityGeneration: input.binding.authorityGeneration,
    reviewJobId: input.binding.reviewJobId,
    reviewVerdict: input.binding.reviewVerdict,
    postedReviewUrl: input.binding.postedReviewUrl,
    postedAttestationEventId: input.binding.postedAttestationEventId,
    acceptanceContract: { ...input.binding.acceptanceContract },
    decision: input.decision,
    rationale: input.rationale,
    decidedBy: input.decidedBy,
    decidedRole: input.decidedRole,
  };
}

function parseCurrentAcceptancePrDecisionEvent(input: {
  event: ChangeRecordEventRow;
  binding: CurrentAcceptancePrDecisionBinding;
}): CurrentAcceptancePrDecision | null {
  const { event, binding } = input;
  const payload = event.payloadRef;
  const eventKey = acceptancePrDecisionEventKey(binding.headCycleId);
  if (event.id !== changeRecordEventId({ recordId: binding.recordId, eventKey })
    || event.recordId !== binding.recordId || event.eventKey !== eventKey
    || event.stage !== ACCEPTANCE_PR_DECISION_STAGE
    || !hasExactKeys(payload, [
      "kind", "version", "bindingId", "workspaceId", "recordId", "repo", "prNumber", "headSha",
      "headCycleId", "authorityGeneration", "reviewJobId", "reviewVerdict",
      "postedReviewUrl", "postedAttestationEventId", "acceptanceContract", "decision",
      "rationale", "decidedBy", "decidedRole",
    ])
    || payload["kind"] !== ACCEPTANCE_PR_DECISION_KIND
    || payload["version"] !== ACCEPTANCE_PR_DECISION_VERSION
    || payload["bindingId"] !== binding.bindingId
    || payload["workspaceId"] !== binding.workspaceId || payload["recordId"] !== binding.recordId
    || payload["repo"] !== binding.repo || payload["prNumber"] !== binding.prNumber
    || payload["headSha"] !== binding.headSha || payload["headCycleId"] !== binding.headCycleId
    || payload["authorityGeneration"] !== binding.authorityGeneration
    || payload["reviewJobId"] !== binding.reviewJobId
    || payload["reviewVerdict"] !== binding.reviewVerdict
    || payload["postedReviewUrl"] !== binding.postedReviewUrl
    || payload["postedAttestationEventId"] !== binding.postedAttestationEventId
    || !isRecord(payload["acceptanceContract"])
    || !hasExactKeys(payload["acceptanceContract"], ["id", "version", "sha256"])
    || payload["acceptanceContract"]["id"] !== binding.acceptanceContract.id
    || payload["acceptanceContract"]["version"] !== binding.acceptanceContract.version
    || payload["acceptanceContract"]["sha256"] !== binding.acceptanceContract.sha256
    || !isAcceptancePrDecision(payload["decision"])
    || (payload["rationale"] !== null && canonicalAcceptancePrDecisionRationale(payload["rationale"]) !== payload["rationale"])
    || (payload["decision"] === "approved_with_exception" && payload["rationale"] === null)
    || (payload["decision"] === "approved" && binding.reviewVerdict !== "proven")
    || typeof payload["decidedBy"] !== "string" || !HUMAN_DECISION_ACTOR.test(payload["decidedBy"])
    || event.actor !== payload["decidedBy"]
    || (payload["decidedRole"] !== "owner" && payload["decidedRole"] !== "admin")
    || !(event.at instanceof Date) || Number.isNaN(event.at.valueOf())) return null;
  return {
    eventId: event.id,
    eventKey: event.eventKey,
    decision: payload["decision"],
    rationale: payload["rationale"] as string | null,
    decidedBy: payload["decidedBy"],
    decidedRole: payload["decidedRole"],
    decidedAt: event.at,
  };
}

type ResolveCurrentAcceptancePrDecisionResult = ReadCurrentAcceptancePrDecisionResult & {
  rawDecisionEvent?: ChangeRecordEventRow | null;
};

async function resolveCurrentAcceptancePrDecisionInTransaction(
  tx: DbTransaction,
  input: ReadCurrentAcceptancePrDecisionInput,
  candidate: { repo: string; prNumber: number }
): Promise<ResolveCurrentAcceptancePrDecisionResult> {
  const record = (await tx.select().from(changeRecords).where(and(
    eq(changeRecords.id, input.recordId),
    eq(changeRecords.workspaceId, input.workspaceId),
  )).limit(1))[0];
  if (!record) return { kind: "not_found" };
  if (record.repo !== candidate.repo || record.prNumber !== candidate.prNumber
    || record.prNumber == null || record.state !== "open" || record.mergedSha !== null
    || !record.currentPrHeadAuthoritative
    || typeof record.currentPrHeadSha !== "string" || !EXACT_SHA1.test(record.currentPrHeadSha)
    || !isUuid(record.currentPrHeadCycleId) || !record.headShas.includes(record.currentPrHeadSha)
    || !Number.isInteger(record.currentPrHeadAuthorityGeneration)
    || record.currentPrHeadAuthorityGeneration < 0) return { kind: "not_current" };

  const headSha = record.currentPrHeadSha;
  const headCycleId = record.currentPrHeadCycleId;
  const job = (await tx.select().from(reviewJobs).where(and(
    eq(reviewJobs.id, headCycleId), eq(reviewJobs.workspaceId, input.workspaceId),
    eq(reviewJobs.repo, record.repo), eq(reviewJobs.prNumber, record.prNumber),
    eq(reviewJobs.headSha, headSha),
  )).limit(1))[0];
  if (!job || job.state !== "posted") {
    return { kind: "not_ready", reason: "review_job_unavailable" };
  }

  const confirmedRows = await tx.select().from(acceptanceContracts).where(and(
    eq(acceptanceContracts.recordId, record.id),
    eq(acceptanceContracts.status, "confirmed"),
  )).orderBy(asc(acceptanceContracts.version));
  if (confirmedRows.length !== 1) {
    return { kind: "not_ready", reason: "confirmed_contract_unavailable" };
  }
  const confirmed = confirmedRows[0]!;
  if (!isNonBlankString(confirmed.confirmedBy) || !(confirmed.confirmedAt instanceof Date)
    || Number.isNaN(confirmed.confirmedAt.valueOf())
    || !projectConfirmedAcceptanceContract(confirmed.contract)) {
    return { kind: "not_ready", reason: "invalid_review_custody" };
  }
  let contractSha256: string;
  try {
    contractSha256 = acceptanceContractSha256({
      acceptanceContractId: confirmed.id,
      acceptanceContractVersion: confirmed.version,
      contract: confirmed.contract,
    });
  } catch {
    return { kind: "not_ready", reason: "invalid_review_custody" };
  }

  if (!isAcceptanceReviewVerdict(job.verdict)
    || !isCanonicalGithubReviewUrl(job.postedReviewUrl, record.repo, record.prNumber)) {
    return { kind: "not_ready", reason: "invalid_review_custody" };
  }
  const acceptanceContract = { id: confirmed.id, version: confirmed.version, sha256: contractSha256 };
  const attestationEventKey = reviewJobPostedAttestationEventKey(job.id);
  const attestation = (await tx.select().from(changeRecordEvents).where(and(
    eq(changeRecordEvents.recordId, record.id),
    eq(changeRecordEvents.eventKey, attestationEventKey),
  )).limit(1))[0] as ChangeRecordEventRow | undefined;
  if (!attestation) return { kind: "not_ready", reason: "posted_attestation_unavailable" };

  const baseBinding: Omit<CurrentAcceptancePrDecisionBinding, "bindingId"> = {
    workspaceId: record.workspaceId,
    recordId: record.id,
    repo: record.repo,
    prNumber: record.prNumber,
    headSha,
    headCycleId,
    authorityGeneration: record.currentPrHeadAuthorityGeneration,
    reviewJobId: job.id,
    reviewVerdict: job.verdict,
    postedReviewUrl: job.postedReviewUrl,
    postedAttestationEventId: attestation.id,
    acceptanceContract,
  };
  const binding: CurrentAcceptancePrDecisionBinding = {
    bindingId: acceptancePrDecisionBindingId(baseBinding),
    ...baseBinding,
  };
  if (!matchesCanonicalPostedReviewAttestation({
    event: attestation,
    binding: {
      workspaceId: binding.workspaceId, recordId: binding.recordId, repo: binding.repo,
      prNumber: binding.prNumber, headSha: binding.headSha, headCycleId: binding.headCycleId,
      authorityGeneration: binding.authorityGeneration, reviewJobId: binding.reviewJobId,
      acceptanceContract: binding.acceptanceContract,
    },
    postedReviewUrl: binding.postedReviewUrl,
  })) return { kind: "not_ready", reason: "invalid_review_custody" };

  const decisionEventKey = acceptancePrDecisionEventKey(headCycleId);
  const rawDecisionEvent = (await tx.select().from(changeRecordEvents).where(and(
    eq(changeRecordEvents.recordId, record.id),
    eq(changeRecordEvents.eventKey, decisionEventKey),
  )).limit(1))[0] as ChangeRecordEventRow | undefined;
  if (!rawDecisionEvent) {
    return { kind: "current", binding, decision: null, rawDecisionEvent: null };
  }
  const decision = parseCurrentAcceptancePrDecisionEvent({ event: rawDecisionEvent, binding });
  if (!decision) return {
    kind: "not_ready", reason: "invalid_decision_custody", rawDecisionEvent,
  };
  return { kind: "current", binding, decision, rawDecisionEvent };
}

function assertReadCurrentAcceptancePrDecisionInput(
  input: unknown
): asserts input is ReadCurrentAcceptancePrDecisionInput {
  if (!isRecord(input) || !hasExactKeys(input, ["workspaceId", "recordId"])
    || !isUuid(input["workspaceId"]) || !isUuid(input["recordId"])) {
    throw new Error("Current Acceptance PR decision read requires only workspace and Record");
  }
}

async function currentAcceptancePrDecisionCandidate(
  input: ReadCurrentAcceptancePrDecisionInput
): Promise<{ repo: string; prNumber: number } | null | "not_current"> {
  const candidate = (await db.select({
    repo: changeRecords.repo,
    prNumber: changeRecords.prNumber,
  }).from(changeRecords).where(and(
    eq(changeRecords.id, input.recordId),
    eq(changeRecords.workspaceId, input.workspaceId),
  )).limit(1))[0];
  if (!candidate) return null;
  return candidate.prNumber == null
    ? "not_current"
    : { repo: candidate.repo, prNumber: candidate.prNumber };
}

/** Derives `decision: null` for the current proven custody; it never persists `not_recorded`. */
export async function readCurrentAcceptancePrDecision(
  input: ReadCurrentAcceptancePrDecisionInput
): Promise<ReadCurrentAcceptancePrDecisionResult> {
  assertReadCurrentAcceptancePrDecisionInput(input);
  const candidate = await currentAcceptancePrDecisionCandidate(input);
  if (candidate === null) return { kind: "not_found" };
  if (candidate === "not_current") return { kind: "not_current" };
  const lockKey = acceptanceRecordPullRequestLockKey({ ...input, ...candidate });
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const resolved = await resolveCurrentAcceptancePrDecisionInTransaction(tx, input, candidate);
    // Project the internal resolver onto the closed public result union. In
    // particular, never expose the raw malformed event retained only so the
    // writer can distinguish an immutable-custody conflict.
    if (resolved.kind === "not_found") return { kind: "not_found" };
    if (resolved.kind === "not_current") return { kind: "not_current" };
    if (resolved.kind === "not_ready") {
      return { kind: "not_ready", reason: resolved.reason };
    }
    return { kind: "current", binding: resolved.binding, decision: resolved.decision };
  });
}

/**
 * Appends one human final decision for the exact current posted review. This
 * never merges the PR, mutates the review verdict, or projects a Record state.
 */
export async function recordAcceptancePrDecision(
  input: RecordAcceptancePrDecisionInput
): Promise<RecordAcceptancePrDecisionResult> {
  const parsed = parseAcceptancePrDecisionInput(input);
  if (!parsed) throw new Error("Invalid Acceptance Record PR decision input");
  const candidate = await currentAcceptancePrDecisionCandidate(parsed);
  if (candidate === null) return { kind: "not_found" };
  if (candidate === "not_current") return { kind: "not_current" };
  const lockKey = acceptanceRecordPullRequestLockKey({
    workspaceId: parsed.workspaceId,
    recordId: parsed.recordId,
    ...candidate,
  });
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    // Serialize a role change/revocation with this write so `decidedRole` is
    // an authoritative commit-time snapshot, not a stale authorization read.
    const membership = (Array.from(await tx.execute(sql`
      SELECT role
      FROM workspace_memberships
      WHERE user_id = ${parsed.decidedByUserId}
        AND workspace_id = ${parsed.workspaceId}
      FOR SHARE
    `)) as Array<{ role: string }>)[0];
    if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
      return { kind: "not_authorized" };
    }

    const resolved = await resolveCurrentAcceptancePrDecisionInTransaction(tx, parsed, candidate);
    if (resolved.kind !== "current") {
      if (resolved.kind === "not_ready" && resolved.reason === "invalid_decision_custody") {
        throw new AcceptancePrDecisionConflictError();
      }
      if (resolved.kind === "not_found") return { kind: "not_found" };
      if (resolved.kind === "not_current") return { kind: "not_current" };
      // A binding is issued only after the current cycle's review job is
      // posted. If the locked current cycle has no posted job, the caller's
      // binding necessarily belongs to an earlier cycle (or was forged).
      if (resolved.reason === "review_job_unavailable") return { kind: "not_current" };
      return { kind: "not_ready", reason: resolved.reason };
    }

    // The user action must target the exact cycle that the UI read. A stale
    // click may never be silently reinterpreted as a decision for a successor
    // head, including an A→B→A SHA revisit with a new cycle UUID.
    if (parsed.bindingId !== resolved.binding.bindingId) {
      return { kind: "not_current" };
    }

    if (resolved.decision) {
      if (resolved.decision.decision !== parsed.decision
        || resolved.decision.rationale !== parsed.rationale
        || resolved.decision.decidedBy !== parsed.decidedBy) {
        throw new AcceptancePrDecisionConflictError();
      }
      return { kind: "replayed", binding: resolved.binding, decision: resolved.decision };
    }
    if (parsed.decision === "approved" && resolved.binding.reviewVerdict !== "proven") {
      return { kind: "decision_not_allowed", reason: "approval_requires_proven" };
    }

    const eventKey = acceptancePrDecisionEventKey(resolved.binding.headCycleId);
    let appended: AppendChangeRecordEventsAtomicallyResult;
    try {
      appended = await appendChangeRecordEventsAtomicallyInTransaction(tx, [{
        recordId: parsed.recordId,
        eventKey,
        stage: ACCEPTANCE_PR_DECISION_STAGE,
        actor: parsed.decidedBy,
        payloadRef: acceptancePrDecisionPayload({
          binding: resolved.binding,
          decision: parsed.decision,
          rationale: parsed.rationale,
          decidedBy: parsed.decidedBy,
          decidedRole: membership.role,
        }),
      }]);
    } catch (error) {
      if (error instanceof Error
        && error.message.includes("event key is already bound to different")) {
        throw new AcceptancePrDecisionConflictError();
      }
      throw error;
    }
    const recorded = parseCurrentAcceptancePrDecisionEvent({
      event: appended.events[0]!.event,
      binding: resolved.binding,
    });
    if (!recorded) throw new Error("Acceptance Record PR decision custody could not be revalidated");
    return {
      kind: appended.events[0]!.inserted ? "recorded" : "replayed",
      binding: resolved.binding,
      decision: recorded,
    };
  });
}

export type AcceptancePrReviewEffort = {
  eventId: string;
  eventKey: string;
  source: "human_input";
  minutes: number;
  recordedBy: string;
  recordedRole: AcceptancePrDecisionRole;
  recordedAt: Date;
};

export type RecordAcceptancePrReviewEffortInput = {
  workspaceId: string;
  recordId: string;
  bindingId: string;
  minutes: number;
  recordedBy: string;
};

export type RecordAcceptancePrReviewEffortResult =
  | {
      kind: "recorded" | "replayed";
      binding: CurrentAcceptancePrDecisionBinding;
      effort: AcceptancePrReviewEffort;
    }
  | { kind: "not_found" }
  | { kind: "not_current" }
  | { kind: "not_authorized" }
  | { kind: "not_ready"; reason: ReadCurrentAcceptancePrDecisionNotReadyReason };

/** Stable same-cycle conflict; storage failures remain ordinary errors. */
export class AcceptancePrReviewEffortConflictError extends Error {
  readonly code = "ACCEPTANCE_PR_REVIEW_EFFORT_CONFLICT" as const;

  constructor() {
    super("The current PR head cycle already has different human review effort");
    this.name = "AcceptancePrReviewEffortConflictError";
  }
}

const ACCEPTANCE_PR_REVIEW_EFFORT_KIND = "acceptance_pr_review_effort";
const ACCEPTANCE_PR_REVIEW_EFFORT_VERSION = 1;
const ACCEPTANCE_PR_REVIEW_EFFORT_STAGE = "human_review_effort";
const ACCEPTANCE_PR_REVIEW_EFFORT_MAX_MINUTES = 1_440;

function acceptancePrReviewEffortEventKey(headCycleId: string): string {
  return `acceptance-pr-review-effort:${headCycleId}`;
}

function parseAcceptancePrReviewEffortInput(
  input: unknown
): (RecordAcceptancePrReviewEffortInput & { recordedByUserId: string }) | null {
  if (!isRecord(input) || !hasExactKeys(input, [
    "workspaceId", "recordId", "bindingId", "minutes", "recordedBy",
  ]) || !isUuid(input["workspaceId"]) || !isUuid(input["recordId"])
    || !isUuid(input["bindingId"]) || !Number.isSafeInteger(input["minutes"])
    || (input["minutes"] as number) < 1
    || (input["minutes"] as number) > ACCEPTANCE_PR_REVIEW_EFFORT_MAX_MINUTES
    || typeof input["recordedBy"] !== "string") return null;
  const actor = HUMAN_DECISION_ACTOR.exec(input["recordedBy"]);
  if (!actor) return null;
  return {
    workspaceId: input["workspaceId"],
    recordId: input["recordId"],
    bindingId: input["bindingId"],
    minutes: input["minutes"] as number,
    recordedBy: `user:${actor[1]!.toLowerCase()}`,
    recordedByUserId: actor[1]!.toLowerCase(),
  };
}

function acceptancePrReviewEffortPayload(input: {
  binding: CurrentAcceptancePrDecisionBinding;
  minutes: number;
  recordedBy: string;
  recordedRole: AcceptancePrDecisionRole;
}): Record<string, unknown> {
  return {
    kind: ACCEPTANCE_PR_REVIEW_EFFORT_KIND,
    version: ACCEPTANCE_PR_REVIEW_EFFORT_VERSION,
    bindingId: input.binding.bindingId,
    workspaceId: input.binding.workspaceId,
    recordId: input.binding.recordId,
    repo: input.binding.repo,
    prNumber: input.binding.prNumber,
    headSha: input.binding.headSha,
    headCycleId: input.binding.headCycleId,
    authorityGeneration: input.binding.authorityGeneration,
    reviewJobId: input.binding.reviewJobId,
    reviewVerdict: input.binding.reviewVerdict,
    postedReviewUrl: input.binding.postedReviewUrl,
    postedAttestationEventId: input.binding.postedAttestationEventId,
    acceptanceContract: { ...input.binding.acceptanceContract },
    source: "human_input",
    minutes: input.minutes,
    recordedBy: input.recordedBy,
    recordedRole: input.recordedRole,
  };
}

function parseAcceptancePrReviewEffortEvent(input: {
  event: ChangeRecordEventRow;
  binding: CurrentAcceptancePrDecisionBinding;
}): AcceptancePrReviewEffort | null {
  const { event, binding } = input;
  const payload = event.payloadRef;
  const eventKey = acceptancePrReviewEffortEventKey(binding.headCycleId);
  if (event.id !== changeRecordEventId({ recordId: binding.recordId, eventKey })
    || event.recordId !== binding.recordId || event.eventKey !== eventKey
    || event.stage !== ACCEPTANCE_PR_REVIEW_EFFORT_STAGE
    || !hasExactKeys(payload, [
      "kind", "version", "bindingId", "workspaceId", "recordId", "repo", "prNumber",
      "headSha", "headCycleId", "authorityGeneration", "reviewJobId", "reviewVerdict",
      "postedReviewUrl", "postedAttestationEventId", "acceptanceContract", "source", "minutes",
      "recordedBy", "recordedRole",
    ]) || payload["kind"] !== ACCEPTANCE_PR_REVIEW_EFFORT_KIND
    || payload["version"] !== ACCEPTANCE_PR_REVIEW_EFFORT_VERSION
    || payload["bindingId"] !== binding.bindingId
    || payload["workspaceId"] !== binding.workspaceId || payload["recordId"] !== binding.recordId
    || payload["repo"] !== binding.repo || payload["prNumber"] !== binding.prNumber
    || payload["headSha"] !== binding.headSha || payload["headCycleId"] !== binding.headCycleId
    || payload["authorityGeneration"] !== binding.authorityGeneration
    || payload["reviewJobId"] !== binding.reviewJobId
    || payload["reviewVerdict"] !== binding.reviewVerdict
    || payload["postedReviewUrl"] !== binding.postedReviewUrl
    || payload["postedAttestationEventId"] !== binding.postedAttestationEventId
    || !isDeepStrictEqual(payload["acceptanceContract"], binding.acceptanceContract)
    || payload["source"] !== "human_input"
    || !Number.isSafeInteger(payload["minutes"]) || (payload["minutes"] as number) < 1
    || (payload["minutes"] as number) > ACCEPTANCE_PR_REVIEW_EFFORT_MAX_MINUTES
    || typeof payload["recordedBy"] !== "string" || !HUMAN_DECISION_ACTOR.test(payload["recordedBy"])
    || event.actor !== payload["recordedBy"]
    || (payload["recordedRole"] !== "owner" && payload["recordedRole"] !== "admin")
    || !(event.at instanceof Date) || Number.isNaN(event.at.valueOf())) return null;
  return {
    eventId: event.id,
    eventKey: event.eventKey,
    source: "human_input",
    minutes: payload["minutes"] as number,
    recordedBy: payload["recordedBy"],
    recordedRole: payload["recordedRole"],
    recordedAt: event.at,
  };
}

/** Records one explicit non-zero human review-effort sample for the current posted cycle. */
export async function recordAcceptancePrReviewEffort(
  input: RecordAcceptancePrReviewEffortInput
): Promise<RecordAcceptancePrReviewEffortResult> {
  const parsed = parseAcceptancePrReviewEffortInput(input);
  if (!parsed) throw new Error("Invalid Acceptance Record PR review effort input");
  const candidate = await currentAcceptancePrDecisionCandidate(parsed);
  if (candidate === null) return { kind: "not_found" };
  if (candidate === "not_current") return { kind: "not_current" };
  const lockKey = acceptanceRecordPullRequestLockKey({
    workspaceId: parsed.workspaceId,
    recordId: parsed.recordId,
    ...candidate,
  });
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const membership = (Array.from(await tx.execute(sql`
      SELECT role
      FROM workspace_memberships
      WHERE user_id = ${parsed.recordedByUserId}
        AND workspace_id = ${parsed.workspaceId}
      FOR SHARE
    `)) as Array<{ role: string }>)[0];
    if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
      return { kind: "not_authorized" };
    }

    const resolved = await resolveCurrentAcceptancePrDecisionInTransaction(tx, parsed, candidate);
    if (resolved.kind !== "current") {
      if (resolved.kind === "not_found") return { kind: "not_found" };
      if (resolved.kind === "not_current") return { kind: "not_current" };
      if (resolved.reason === "review_job_unavailable") return { kind: "not_current" };
      return { kind: "not_ready", reason: resolved.reason };
    }
    if (parsed.bindingId !== resolved.binding.bindingId) return { kind: "not_current" };

    const eventKey = acceptancePrReviewEffortEventKey(resolved.binding.headCycleId);
    const existing = (await tx.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, parsed.recordId),
      eq(changeRecordEvents.eventKey, eventKey),
    )).limit(1))[0] as ChangeRecordEventRow | undefined;
    if (existing) {
      const effort = parseAcceptancePrReviewEffortEvent({ event: existing, binding: resolved.binding });
      if (!effort || effort.minutes !== parsed.minutes || effort.recordedBy !== parsed.recordedBy) {
        throw new AcceptancePrReviewEffortConflictError();
      }
      return { kind: "replayed", binding: resolved.binding, effort };
    }

    let appended: AppendChangeRecordEventsAtomicallyResult;
    try {
      appended = await appendChangeRecordEventsAtomicallyInTransaction(tx, [{
        recordId: parsed.recordId,
        eventKey,
        stage: ACCEPTANCE_PR_REVIEW_EFFORT_STAGE,
        actor: parsed.recordedBy,
        payloadRef: acceptancePrReviewEffortPayload({
          binding: resolved.binding,
          minutes: parsed.minutes,
          recordedBy: parsed.recordedBy,
          recordedRole: membership.role,
        }),
      }]);
    } catch (error) {
      if (error instanceof Error && error.message.includes("event key is already bound")) {
        throw new AcceptancePrReviewEffortConflictError();
      }
      throw error;
    }
    const effort = parseAcceptancePrReviewEffortEvent({
      event: appended.events[0]!.event,
      binding: resolved.binding,
    });
    if (!effort) throw new Error("Acceptance Record PR review effort custody could not be revalidated");
    return {
      kind: appended.events[0]!.inserted ? "recorded" : "replayed",
      binding: resolved.binding,
      effort,
    };
  });
}

export type SignedAcceptanceRecordMergeGithubActor = {
  id: number;
  login: string;
  type: "User" | "Bot" | "Organization";
};

export type SignedAcceptanceRecordMergeDecisionAlignment =
  | {
      kind: "aligned";
      decision: "approved" | "approved_with_exception";
      decisionEventId: string;
      binding: CurrentAcceptancePrDecisionBinding;
    }
  | {
      kind: "decision_conflicts_merge";
      decision: "changes_requested" | "rejected";
      decisionEventId: string;
      binding: CurrentAcceptancePrDecisionBinding;
    }
  | {
      kind: "not_recorded";
      binding: CurrentAcceptancePrDecisionBinding;
    }
  | {
      kind: "not_current";
      currentHeadSha: string | null;
      currentHeadCycleId: string | null;
      authorityGeneration: number;
      currentBinding: CurrentAcceptancePrDecisionBinding | null;
      currentDecision: AcceptancePrDecision | null;
      currentDecisionEventId: string | null;
    }
  | {
      kind: "custody_unavailable";
      reason: ReadCurrentAcceptancePrDecisionNotReadyReason;
      currentHeadSha: string | null;
      currentHeadCycleId: string | null;
      authorityGeneration: number;
    };

export type RecordSignedAcceptanceRecordMergeInput = {
  workspaceId: string;
  recordId: string;
  repo: string;
  prNumber: number;
  deliveryId: string;
  headSha: string;
  baseSha: string;
  mergeSha: string;
  mergedAt: Date;
  prUrl: string;
  githubActor: SignedAcceptanceRecordMergeGithubActor;
  source: "github_webhook";
};

export type RecordSignedAcceptanceRecordMergeResult =
  | {
      kind: "recorded" | "replayed";
      mergeEventId: string;
      deliveryEventId: string;
      decisionAlignment: SignedAcceptanceRecordMergeDecisionAlignment;
      superseded: number;
      previewBootsTornDown: number;
      correctionDispatchesInvalidated: number;
    }
  | { kind: "not_found" | "not_attached" };

/** Stable immutable-custody conflict; database outages remain ordinary errors. */
export class SignedAcceptanceRecordMergeConflictError extends Error {
  readonly code = "SIGNED_ACCEPTANCE_RECORD_MERGE_CONFLICT" as const;

  constructor() {
    super("The Acceptance Record is already bound to different signed merge custody");
    this.name = "SignedAcceptanceRecordMergeConflictError";
  }
}

const SIGNED_ACCEPTANCE_RECORD_MERGE_KIND = "signed_acceptance_record_merge";
const SIGNED_ACCEPTANCE_RECORD_MERGE_DELIVERY_KIND = "signed_acceptance_record_merge_delivery";
const SIGNED_ACCEPTANCE_RECORD_MERGE_VERSION = 1;
const SIGNED_ACCEPTANCE_RECORD_MERGE_STAGE = "merge";
const SIGNED_ACCEPTANCE_RECORD_MERGE_ACTOR = "github_webhook";
const EXACT_LOWER_GITHUB_SHA = /^[0-9a-f]{40}$/;
const GITHUB_ACTOR_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*|[A-Za-z0-9-]*\[bot\])$/;

function signedAcceptanceRecordMergeDeliveryEventKey(input: {
  prNumber: number;
  deliveryId: string;
}): string {
  return `external-pr:signed-merge:${input.prNumber}:${input.deliveryId}`;
}

function signedAcceptanceRecordMergeEventKey(mergeSha: string): string {
  return `acceptance-pr:signed-merge:${mergeSha}`;
}

function canonicalSignedAcceptanceRecordMergePrUrl(
  value: unknown,
  repo: string,
  prNumber: number
): value is string {
  return typeof value === "string" && value === `https://github.com/${repo}/pull/${prNumber}`;
}

function isSignedAcceptanceRecordMergeGithubActor(
  value: unknown
): value is SignedAcceptanceRecordMergeGithubActor {
  return isRecord(value)
    && hasExactKeys(value, ["id", "login", "type"])
    && Number.isSafeInteger(value["id"]) && (value["id"] as number) > 0
    && typeof value["login"] === "string" && value["login"].length <= 100
    && GITHUB_ACTOR_LOGIN.test(value["login"])
    && (value["type"] === "User" || value["type"] === "Bot" || value["type"] === "Organization");
}

function parseRecordSignedAcceptanceRecordMergeInput(
  value: unknown
): RecordSignedAcceptanceRecordMergeInput | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "workspaceId", "recordId", "repo", "prNumber", "deliveryId", "headSha",
    "baseSha", "mergeSha", "mergedAt", "prUrl", "githubActor", "source",
  ])) return null;
  if (!isUuid(value["workspaceId"]) || !isUuid(value["recordId"])
    || !safeRepo(value["repo"]) || (value["repo"] as string).length > 201
    || !(value["repo"] as string).split("/").every((segment) => segment.length <= 100)
    || !Number.isInteger(value["prNumber"]) || (value["prNumber"] as number) <= 0
    || !boundedPullRequestProvenanceText(value["deliveryId"], 256)
    || typeof value["headSha"] !== "string" || !EXACT_LOWER_GITHUB_SHA.test(value["headSha"])
    || typeof value["baseSha"] !== "string" || !EXACT_LOWER_GITHUB_SHA.test(value["baseSha"])
    || typeof value["mergeSha"] !== "string" || !EXACT_LOWER_GITHUB_SHA.test(value["mergeSha"])
    || !(value["mergedAt"] instanceof Date) || Number.isNaN(value["mergedAt"].valueOf())
    || !canonicalSignedAcceptanceRecordMergePrUrl(
      value["prUrl"], value["repo"] as string, value["prNumber"] as number
    )
    || !isSignedAcceptanceRecordMergeGithubActor(value["githubActor"])
    || value["source"] !== "github_webhook") return null;
  return value as RecordSignedAcceptanceRecordMergeInput;
}

function parseSignedMergeDecisionBinding(
  value: unknown
): CurrentAcceptancePrDecisionBinding | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "bindingId", "workspaceId", "recordId", "repo", "prNumber", "headSha",
    "headCycleId", "authorityGeneration", "reviewJobId", "reviewVerdict",
    "postedReviewUrl", "postedAttestationEventId", "acceptanceContract",
  ]) || !isUuid(value["bindingId"]) || !isUuid(value["workspaceId"])
    || !isUuid(value["recordId"]) || !safeRepo(value["repo"])
    || !Number.isInteger(value["prNumber"]) || (value["prNumber"] as number) <= 0
    || typeof value["headSha"] !== "string" || !EXACT_SHA1.test(value["headSha"])
    || !isUuid(value["headCycleId"]) || !Number.isInteger(value["authorityGeneration"])
    || (value["authorityGeneration"] as number) < 0 || !isUuid(value["reviewJobId"])
    || !isAcceptanceReviewVerdict(value["reviewVerdict"])
    || !isUuid(value["postedAttestationEventId"])
    || !isRecord(value["acceptanceContract"])
    || !hasExactKeys(value["acceptanceContract"], ["id", "version", "sha256"])
    || !isUuid(value["acceptanceContract"]["id"])
    || !Number.isInteger(value["acceptanceContract"]["version"])
    || (value["acceptanceContract"]["version"] as number) <= 0
    || typeof value["acceptanceContract"]["sha256"] !== "string"
    || !LOWER_SHA256.test(value["acceptanceContract"]["sha256"])
    || !canonicalSignedAcceptanceRecordMergePrUrl(
      value["postedReviewUrl"], value["repo"] as string, value["prNumber"] as number
    ) && !isCanonicalGithubReviewUrl(
      value["postedReviewUrl"], value["repo"] as string, value["prNumber"] as number
    )) return null;
  const binding = value as CurrentAcceptancePrDecisionBinding;
  const { bindingId, ...base } = binding;
  return acceptancePrDecisionBindingId(base) === bindingId ? binding : null;
}

function isAcceptancePrDecisionNotReadyReason(
  value: unknown
): value is ReadCurrentAcceptancePrDecisionNotReadyReason {
  return value === "review_job_unavailable"
    || value === "confirmed_contract_unavailable"
    || value === "posted_attestation_unavailable"
    || value === "invalid_review_custody"
    || value === "invalid_decision_custody";
}

function signedMergeDecisionAlignment(input: {
  resolved: ResolveCurrentAcceptancePrDecisionResult;
  record: ChangeRecordRow;
  signedHeadSha: string;
}): SignedAcceptanceRecordMergeDecisionAlignment {
  const { resolved, record } = input;
  // Head occurrence alignment is independently known from the locked Record
  // snapshot. Do not let missing review/attestation custody on a newer head
  // blur a signed A merge into a generic custody failure for current B.
  if (record.currentPrHeadSha !== input.signedHeadSha) {
    return {
      kind: "not_current",
      currentHeadSha: record.currentPrHeadSha,
      currentHeadCycleId: record.currentPrHeadCycleId,
      authorityGeneration: record.currentPrHeadAuthorityGeneration,
      currentBinding: resolved.kind === "current" ? resolved.binding : null,
      currentDecision: resolved.kind === "current" ? resolved.decision?.decision ?? null : null,
      currentDecisionEventId: resolved.kind === "current" ? resolved.decision?.eventId ?? null : null,
    };
  }
  if (resolved.kind === "current") {
    if (resolved.binding.headSha !== input.signedHeadSha) {
      return {
        kind: "not_current",
        currentHeadSha: record.currentPrHeadSha,
        currentHeadCycleId: record.currentPrHeadCycleId,
        authorityGeneration: record.currentPrHeadAuthorityGeneration,
        currentBinding: resolved.binding,
        currentDecision: resolved.decision?.decision ?? null,
        currentDecisionEventId: resolved.decision?.eventId ?? null,
      };
    }
    if (!resolved.decision) return { kind: "not_recorded", binding: resolved.binding };
    if (resolved.decision.decision === "approved"
      || resolved.decision.decision === "approved_with_exception") {
      return {
        kind: "aligned",
        decision: resolved.decision.decision,
        decisionEventId: resolved.decision.eventId,
        binding: resolved.binding,
      };
    }
    return {
      kind: "decision_conflicts_merge",
      decision: resolved.decision.decision,
      decisionEventId: resolved.decision.eventId,
      binding: resolved.binding,
    };
  }
  if (resolved.kind === "not_ready") {
    return {
      kind: "custody_unavailable",
      reason: resolved.reason,
      currentHeadSha: record.currentPrHeadSha,
      currentHeadCycleId: record.currentPrHeadCycleId,
      authorityGeneration: record.currentPrHeadAuthorityGeneration,
    };
  }
  return {
    kind: "not_current",
    currentHeadSha: record.currentPrHeadSha,
    currentHeadCycleId: record.currentPrHeadCycleId,
    authorityGeneration: record.currentPrHeadAuthorityGeneration,
    currentBinding: null,
    currentDecision: null,
    currentDecisionEventId: null,
  };
}

function parseSignedMergeDecisionAlignment(
  value: unknown,
  signedHeadSha: string
): SignedAcceptanceRecordMergeDecisionAlignment | null {
  if (!isRecord(value) || typeof value["kind"] !== "string") return null;
  if (value["kind"] === "aligned" || value["kind"] === "decision_conflicts_merge") {
    if (!hasExactKeys(value, ["kind", "decision", "decisionEventId", "binding"])
      || !isUuid(value["decisionEventId"])) return null;
    const binding = parseSignedMergeDecisionBinding(value["binding"]);
    if (!binding || binding.headSha !== signedHeadSha) return null;
    if (value["kind"] === "aligned"
      ? value["decision"] !== "approved" && value["decision"] !== "approved_with_exception"
      : value["decision"] !== "changes_requested" && value["decision"] !== "rejected") return null;
    return { ...value, binding } as SignedAcceptanceRecordMergeDecisionAlignment;
  }
  if (value["kind"] === "not_recorded") {
    if (!hasExactKeys(value, ["kind", "binding"])) return null;
    const binding = parseSignedMergeDecisionBinding(value["binding"]);
    return binding?.headSha === signedHeadSha ? { kind: "not_recorded", binding } : null;
  }
  if (value["kind"] === "not_current") {
    if (!hasExactKeys(value, [
      "kind", "currentHeadSha", "currentHeadCycleId", "authorityGeneration",
      "currentBinding", "currentDecision", "currentDecisionEventId",
    ]) || (value["currentHeadSha"] !== null
      && (typeof value["currentHeadSha"] !== "string" || !EXACT_SHA1.test(value["currentHeadSha"])))
      || (value["currentHeadCycleId"] !== null && !isUuid(value["currentHeadCycleId"]))
      || !Number.isInteger(value["authorityGeneration"]) || (value["authorityGeneration"] as number) < 0
      || (value["currentDecision"] !== null && !isAcceptancePrDecision(value["currentDecision"]))
      || (value["currentDecisionEventId"] !== null && !isUuid(value["currentDecisionEventId"]))) return null;
    const currentBinding = value["currentBinding"] === null
      ? null : parseSignedMergeDecisionBinding(value["currentBinding"]);
    if (value["currentBinding"] !== null && !currentBinding) return null;
    if (currentBinding) {
      if (currentBinding.headSha === signedHeadSha
        || currentBinding.headSha !== value["currentHeadSha"]
        || currentBinding.headCycleId !== value["currentHeadCycleId"]
        || currentBinding.authorityGeneration !== value["authorityGeneration"]
        || (value["currentDecision"] === null) !== (value["currentDecisionEventId"] === null)) return null;
    } else if (value["currentDecision"] !== null || value["currentDecisionEventId"] !== null) return null;
    return { ...value, currentBinding } as SignedAcceptanceRecordMergeDecisionAlignment;
  }
  if (value["kind"] === "custody_unavailable") {
    if (!hasExactKeys(value, [
      "kind", "reason", "currentHeadSha", "currentHeadCycleId", "authorityGeneration",
    ]) || !isAcceptancePrDecisionNotReadyReason(value["reason"])
      || (value["currentHeadSha"] !== null
        && (typeof value["currentHeadSha"] !== "string" || !EXACT_SHA1.test(value["currentHeadSha"])))
      || (value["currentHeadCycleId"] !== null && !isUuid(value["currentHeadCycleId"]))
      || !Number.isInteger(value["authorityGeneration"])
      || (value["authorityGeneration"] as number) < 0) return null;
    return value as SignedAcceptanceRecordMergeDecisionAlignment;
  }
  return null;
}

async function revalidateSignedMergeDecisionAlignmentInTransaction(
  tx: DbTransaction,
  alignment: SignedAcceptanceRecordMergeDecisionAlignment
): Promise<boolean> {
  if (alignment.kind === "custody_unavailable") return true;
  if (alignment.kind === "not_current" && !alignment.currentBinding) return true;
  const binding = alignment.kind === "not_current"
    ? alignment.currentBinding!
    : alignment.binding;

  const job = (await tx.select().from(reviewJobs).where(and(
    eq(reviewJobs.id, binding.reviewJobId), eq(reviewJobs.workspaceId, binding.workspaceId),
    eq(reviewJobs.repo, binding.repo), eq(reviewJobs.prNumber, binding.prNumber),
    eq(reviewJobs.headSha, binding.headSha),
  )).limit(1))[0];
  if (!job || job.state !== "posted" || job.verdict !== binding.reviewVerdict
    || job.postedReviewUrl !== binding.postedReviewUrl) return false;

  const contract = (await tx.select().from(acceptanceContracts).where(and(
    eq(acceptanceContracts.id, binding.acceptanceContract.id),
    eq(acceptanceContracts.recordId, binding.recordId),
    eq(acceptanceContracts.version, binding.acceptanceContract.version),
    eq(acceptanceContracts.status, "confirmed"),
  )).limit(1))[0];
  if (!contract || !isNonBlankString(contract.confirmedBy)
    || !(contract.confirmedAt instanceof Date) || Number.isNaN(contract.confirmedAt.valueOf())
    || !projectConfirmedAcceptanceContract(contract.contract)) return false;
  let contractSha256: string;
  try {
    contractSha256 = acceptanceContractSha256({
      acceptanceContractId: contract.id,
      acceptanceContractVersion: contract.version,
      contract: contract.contract,
    });
  } catch {
    return false;
  }
  if (contractSha256 !== binding.acceptanceContract.sha256) return false;

  const attestation = (await tx.select().from(changeRecordEvents).where(and(
    eq(changeRecordEvents.id, binding.postedAttestationEventId),
    eq(changeRecordEvents.recordId, binding.recordId),
    eq(changeRecordEvents.eventKey, reviewJobPostedAttestationEventKey(binding.reviewJobId)),
  )).limit(1))[0] as ChangeRecordEventRow | undefined;
  if (!attestation || !matchesCanonicalPostedReviewAttestation({
    event: attestation,
    binding: {
      workspaceId: binding.workspaceId, recordId: binding.recordId, repo: binding.repo,
      prNumber: binding.prNumber, headSha: binding.headSha, headCycleId: binding.headCycleId,
      authorityGeneration: binding.authorityGeneration, reviewJobId: binding.reviewJobId,
      acceptanceContract: binding.acceptanceContract,
    },
    postedReviewUrl: binding.postedReviewUrl,
  })) return false;

  const decisionEvent = (await tx.select().from(changeRecordEvents).where(and(
    eq(changeRecordEvents.recordId, binding.recordId),
    eq(changeRecordEvents.eventKey, acceptancePrDecisionEventKey(binding.headCycleId)),
  )).limit(1))[0] as ChangeRecordEventRow | undefined;
  const decision = decisionEvent
    ? parseCurrentAcceptancePrDecisionEvent({ event: decisionEvent, binding })
    : null;
  if (decisionEvent && !decision) return false;
  if (alignment.kind === "not_recorded") return decision === null;
  if (alignment.kind === "not_current") {
    return (decision?.decision ?? null) === alignment.currentDecision
      && (decision?.eventId ?? null) === alignment.currentDecisionEventId;
  }
  return decision != null
    && decision.decision === alignment.decision
    && decision.eventId === alignment.decisionEventId;
}

type SignedAcceptanceRecordMergePayload = {
  kind: typeof SIGNED_ACCEPTANCE_RECORD_MERGE_KIND;
  version: typeof SIGNED_ACCEPTANCE_RECORD_MERGE_VERSION;
  workspaceId: string;
  recordId: string;
  repo: string;
  prNumber: number;
  deliveryId: string;
  headSha: string;
  baseSha: string;
  mergeSha: string;
  mergedAt: string;
  prUrl: string;
  githubActor: SignedAcceptanceRecordMergeGithubActor;
  source: "github_webhook";
  deliveryEventId: string;
  currentHeadSha: string | null;
  currentHeadCycleId: string | null;
  currentHeadAuthoritative: boolean;
  authorityGenerationBefore: number;
  authorityGenerationAfter: number;
  decisionAlignment: SignedAcceptanceRecordMergeDecisionAlignment;
  superseded: number;
  previewBootsTornDown: number;
  correctionDispatchesInvalidated: number;
};

function signedAcceptanceRecordMergeMetadata(
  input: RecordSignedAcceptanceRecordMergeInput
): Omit<SignedAcceptanceRecordMergePayload,
  | "kind" | "version" | "deliveryEventId" | "currentHeadSha" | "currentHeadCycleId"
  | "currentHeadAuthoritative" | "authorityGenerationBefore" | "authorityGenerationAfter"
  | "decisionAlignment" | "superseded" | "previewBootsTornDown"
  | "correctionDispatchesInvalidated"> {
  return {
    workspaceId: input.workspaceId,
    recordId: input.recordId,
    repo: input.repo,
    prNumber: input.prNumber,
    deliveryId: input.deliveryId,
    headSha: input.headSha,
    baseSha: input.baseSha,
    mergeSha: input.mergeSha,
    mergedAt: input.mergedAt.toISOString(),
    prUrl: input.prUrl,
    githubActor: { ...input.githubActor },
    source: input.source,
  };
}

function signedAcceptanceRecordMergeDeliveryPayload(
  metadata: ReturnType<typeof signedAcceptanceRecordMergeMetadata>
): Record<string, unknown> {
  return {
    kind: SIGNED_ACCEPTANCE_RECORD_MERGE_DELIVERY_KIND,
    version: SIGNED_ACCEPTANCE_RECORD_MERGE_VERSION,
    ...metadata,
  };
}

function signedAcceptanceRecordMergeCanonicalTupleMatches(
  payload: SignedAcceptanceRecordMergePayload,
  input: RecordSignedAcceptanceRecordMergeInput
): boolean {
  const metadata = signedAcceptanceRecordMergeMetadata(input);
  return isDeepStrictEqual({
    workspaceId: payload.workspaceId,
    recordId: payload.recordId,
    repo: payload.repo,
    prNumber: payload.prNumber,
    headSha: payload.headSha,
    baseSha: payload.baseSha,
    mergeSha: payload.mergeSha,
    mergedAt: payload.mergedAt,
    prUrl: payload.prUrl,
    githubActor: payload.githubActor,
    source: payload.source,
  }, {
    workspaceId: metadata.workspaceId,
    recordId: metadata.recordId,
    repo: metadata.repo,
    prNumber: metadata.prNumber,
    headSha: metadata.headSha,
    baseSha: metadata.baseSha,
    mergeSha: metadata.mergeSha,
    mergedAt: metadata.mergedAt,
    prUrl: metadata.prUrl,
    githubActor: metadata.githubActor,
    source: metadata.source,
  });
}

async function readExactSignedAcceptanceRecordMergeDeliveryInTransaction(
  tx: DbTransaction,
  input: RecordSignedAcceptanceRecordMergeInput
): Promise<ChangeRecordEventRow | null> {
  const eventKey = signedAcceptanceRecordMergeDeliveryEventKey(input);
  const event = (await tx.select().from(changeRecordEvents).where(and(
    eq(changeRecordEvents.recordId, input.recordId),
    eq(changeRecordEvents.eventKey, eventKey),
  )).limit(1))[0] as ChangeRecordEventRow | undefined;
  const payload = signedAcceptanceRecordMergeDeliveryPayload(
    signedAcceptanceRecordMergeMetadata(input)
  );
  return event
    && event.id === changeRecordEventId({ recordId: input.recordId, eventKey })
    && event.stage === SIGNED_ACCEPTANCE_RECORD_MERGE_STAGE
    && event.actor === SIGNED_ACCEPTANCE_RECORD_MERGE_ACTOR
    && isDeepStrictEqual(event.payloadRef, payload)
    ? event : null;
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function parseSignedAcceptanceRecordMergePayload(
  event: ChangeRecordEventRow,
  record: ChangeRecordRow
): SignedAcceptanceRecordMergePayload | null {
  const payload = event.payloadRef;
  if (event.stage !== SIGNED_ACCEPTANCE_RECORD_MERGE_STAGE
    || event.actor !== SIGNED_ACCEPTANCE_RECORD_MERGE_ACTOR
    || !isRecord(payload) || !hasExactKeys(payload, [
      "kind", "version", "workspaceId", "recordId", "repo", "prNumber", "deliveryId",
      "headSha", "baseSha", "mergeSha", "mergedAt", "prUrl", "githubActor", "source",
      "deliveryEventId", "currentHeadSha", "currentHeadCycleId", "currentHeadAuthoritative",
      "authorityGenerationBefore", "authorityGenerationAfter", "decisionAlignment",
      "superseded", "previewBootsTornDown", "correctionDispatchesInvalidated",
    ]) || payload["kind"] !== SIGNED_ACCEPTANCE_RECORD_MERGE_KIND
    || payload["version"] !== SIGNED_ACCEPTANCE_RECORD_MERGE_VERSION
    || payload["workspaceId"] !== record.workspaceId || payload["recordId"] !== record.id
    || payload["repo"] !== record.repo || payload["prNumber"] !== record.prNumber
    || typeof payload["deliveryId"] !== "string"
    || !boundedPullRequestProvenanceText(payload["deliveryId"], 256)
    || typeof payload["headSha"] !== "string" || !EXACT_LOWER_GITHUB_SHA.test(payload["headSha"])
    || typeof payload["baseSha"] !== "string" || !EXACT_LOWER_GITHUB_SHA.test(payload["baseSha"])
    || typeof payload["mergeSha"] !== "string" || !EXACT_LOWER_GITHUB_SHA.test(payload["mergeSha"])
    || !isCanonicalIsoTimestamp(payload["mergedAt"])
    || !canonicalSignedAcceptanceRecordMergePrUrl(payload["prUrl"], record.repo, record.prNumber!)
    || !isSignedAcceptanceRecordMergeGithubActor(payload["githubActor"])
    || payload["source"] !== "github_webhook" || !isUuid(payload["deliveryEventId"])
    || (payload["currentHeadSha"] !== null
      && (typeof payload["currentHeadSha"] !== "string" || !EXACT_SHA1.test(payload["currentHeadSha"])))
    || (payload["currentHeadCycleId"] !== null && !isUuid(payload["currentHeadCycleId"]))
    || typeof payload["currentHeadAuthoritative"] !== "boolean"
    || !Number.isInteger(payload["authorityGenerationBefore"])
    || (payload["authorityGenerationBefore"] as number) < 0
    || !Number.isInteger(payload["authorityGenerationAfter"])
    || payload["authorityGenerationAfter"] !== (payload["authorityGenerationBefore"] as number)
      + (payload["currentHeadAuthoritative"] ? 1 : 0)
    || !Number.isInteger(payload["superseded"]) || (payload["superseded"] as number) < 0
    || !Number.isInteger(payload["previewBootsTornDown"])
    || (payload["previewBootsTornDown"] as number) < 0
    || !Number.isInteger(payload["correctionDispatchesInvalidated"])
    || (payload["correctionDispatchesInvalidated"] as number) < 0) return null;
  const decisionAlignment = parseSignedMergeDecisionAlignment(
    payload["decisionAlignment"], payload["headSha"]
  );
  if (!decisionAlignment) return null;
  const snapshotMatches = decisionAlignment.kind === "aligned"
    || decisionAlignment.kind === "decision_conflicts_merge"
    || decisionAlignment.kind === "not_recorded"
    ? payload["currentHeadAuthoritative"] === true
      && decisionAlignment.binding.headSha === payload["currentHeadSha"]
      && decisionAlignment.binding.headCycleId === payload["currentHeadCycleId"]
      && decisionAlignment.binding.authorityGeneration === payload["authorityGenerationBefore"]
    : decisionAlignment.kind === "not_current"
      ? decisionAlignment.currentHeadSha === payload["currentHeadSha"]
        && decisionAlignment.currentHeadCycleId === payload["currentHeadCycleId"]
        && decisionAlignment.authorityGeneration === payload["authorityGenerationBefore"]
      : decisionAlignment.currentHeadSha === payload["currentHeadSha"]
        && decisionAlignment.currentHeadCycleId === payload["currentHeadCycleId"]
        && decisionAlignment.authorityGeneration === payload["authorityGenerationBefore"];
  if (!snapshotMatches) return null;
  const parsed = { ...payload, decisionAlignment } as SignedAcceptanceRecordMergePayload;
  const eventKey = signedAcceptanceRecordMergeEventKey(parsed.mergeSha);
  return event.id === changeRecordEventId({ recordId: record.id, eventKey })
    && event.eventKey === eventKey ? parsed : null;
}

async function resolveStoredSignedAcceptanceRecordMergeInTransaction(
  tx: DbTransaction,
  record: ChangeRecordRow,
  expected?: RecordSignedAcceptanceRecordMergeInput
): Promise<{
  event: ChangeRecordEventRow;
  payload: SignedAcceptanceRecordMergePayload;
} | null> {
  const mergeSha = expected?.mergeSha ?? record.mergedSha;
  if (!mergeSha || !EXACT_LOWER_GITHUB_SHA.test(mergeSha)) return null;
  const eventKey = signedAcceptanceRecordMergeEventKey(mergeSha);
  const event = (await tx.select().from(changeRecordEvents).where(and(
    eq(changeRecordEvents.recordId, record.id), eq(changeRecordEvents.eventKey, eventKey),
  )).limit(1))[0] as ChangeRecordEventRow | undefined;
  if (!event) return null;
  const payload = parseSignedAcceptanceRecordMergePayload(event, record);
  // A delayed signed delivery can raise the now-terminal authority generation,
  // but it cannot replace the immutable merge SHA or restore authority.
  if (!payload || record.mergedSha !== payload.mergeSha
    || record.currentPrHeadAuthoritative
    || record.currentPrHeadAuthorityGeneration < payload.authorityGenerationAfter) return null;
  if (expected) {
    const metadata = signedAcceptanceRecordMergeMetadata(expected);
    if (!isDeepStrictEqual({
      workspaceId: payload.workspaceId, recordId: payload.recordId, repo: payload.repo,
      prNumber: payload.prNumber, deliveryId: payload.deliveryId, headSha: payload.headSha,
      baseSha: payload.baseSha, mergeSha: payload.mergeSha, mergedAt: payload.mergedAt,
      prUrl: payload.prUrl, githubActor: payload.githubActor, source: payload.source,
    }, metadata)) return null;
  }
  const deliveryEventKey = signedAcceptanceRecordMergeDeliveryEventKey({
    prNumber: payload.prNumber, deliveryId: payload.deliveryId,
  });
  const delivery = (await tx.select().from(changeRecordEvents).where(and(
    eq(changeRecordEvents.id, payload.deliveryEventId),
    eq(changeRecordEvents.recordId, record.id),
    eq(changeRecordEvents.eventKey, deliveryEventKey),
  )).limit(1))[0] as ChangeRecordEventRow | undefined;
  const deliveryPayload = signedAcceptanceRecordMergeDeliveryPayload({
    workspaceId: payload.workspaceId, recordId: payload.recordId, repo: payload.repo,
    prNumber: payload.prNumber, deliveryId: payload.deliveryId, headSha: payload.headSha,
    baseSha: payload.baseSha, mergeSha: payload.mergeSha, mergedAt: payload.mergedAt,
    prUrl: payload.prUrl, githubActor: payload.githubActor, source: payload.source,
  });
  if (!delivery
    || delivery.id !== changeRecordEventId({ recordId: record.id, eventKey: deliveryEventKey })
    || delivery.stage !== SIGNED_ACCEPTANCE_RECORD_MERGE_STAGE
    || delivery.actor !== SIGNED_ACCEPTANCE_RECORD_MERGE_ACTOR
    || !isDeepStrictEqual(delivery.payloadRef, deliveryPayload)
    || !await revalidateSignedMergeDecisionAlignmentInTransaction(tx, payload.decisionAlignment)) {
    return null;
  }
  return { event, payload };
}

/**
 * A bounded historical projection of exact Acceptance Record reviews. This is
 * deliberately separate from the current-head resolver: a later B head (or a
 * later return to A) must not erase the immutable evidence for an earlier
 * head-cycle.
 */
export type ReadAcceptanceOutcomeHistoryInput = {
  workspaceId: string;
  from: Date;
  to: Date;
  observedUntil: Date;
};

export type AcceptanceOutcomeHistoryClassification =
  | "approved"
  | "approved_with_exception"
  | "changes_requested"
  | "rejected"
  | "not_recorded"
  | "excluded_unknown";

export type AcceptanceOutcomeHistorySample = {
  recordId: string;
  reviewJobId: string;
  repo: string;
  prNumber: number;
  headSha: string | null;
  reviewedAt: Date;
  classification: AcceptanceOutcomeHistoryClassification;
  decision: CurrentAcceptancePrDecision | null;
  exclusionReason: "invalid_posted_review_custody" | "ambiguous_review_custody"
    | "invalid_decision_custody" | "invalid_lineage_custody" | null;
  lineage: {
    signedMerged: boolean;
    deploymentObserved: boolean;
    incidentObserved: boolean;
    reverted: boolean;
  };
};

export type AcceptanceOutcomeHistory = {
  cohort: { from: Date; to: Date; observedUntil: Date };
  counts: {
    eligible: number;
    approved: number;
    approvedWithException: number;
    changesRequested: number;
    rejected: number;
    notRecorded: number;
    excludedUnknown: number;
    signedMerged: number;
    deploymentObserved: number;
    incidentObserved: number;
    reverted: number;
  };
  samples: AcceptanceOutcomeHistorySample[];
};

const ACCEPTANCE_OUTCOME_HISTORY_MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1_000;

function assertReadAcceptanceOutcomeHistoryInput(
  input: unknown
): asserts input is ReadAcceptanceOutcomeHistoryInput {
  if (!isRecord(input) || !hasExactKeys(input, ["workspaceId", "from", "to", "observedUntil"])
    || !isUuid(input["workspaceId"]) || !(input["from"] instanceof Date)
    || !(input["to"] instanceof Date) || !(input["observedUntil"] instanceof Date)) {
    throw new Error("Acceptance outcome history requires a workspace and bounded UTC Date window");
  }
  const from = input["from"].valueOf();
  const to = input["to"].valueOf();
  const observedUntil = input["observedUntil"].valueOf();
  if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(observedUntil)
    || from >= to || to > observedUntil
    || to - from > ACCEPTANCE_OUTCOME_HISTORY_MAX_WINDOW_MS
    || observedUntil - to > ACCEPTANCE_OUTCOME_HISTORY_MAX_WINDOW_MS) {
    throw new Error("Acceptance outcome history requires a workspace and bounded UTC Date window");
  }
}

function acceptanceOutcomeReviewJobId(eventKey: string): string | null {
  const match = /^review:github-posted:([0-9a-f-]{36})$/i.exec(eventKey);
  return match && isUuid(match[1]) ? match[1].toLowerCase() : null;
}

type HistoricalPostedReviewAttestation = {
  reviewJobId: string;
  headSha: string;
  acceptanceContractId: string;
  acceptanceContractVersion: number;
  postedReviewUrl: string;
  eventId: string;
  reviewedAt: Date;
};

/** Validate the standalone immutable review receipt without consulting mutable job/current-head state. */
function parseHistoricalPostedReviewAttestation(
  event: ChangeRecordEventRow,
  record: ChangeRecordRow,
  reviewJobId: string
): HistoricalPostedReviewAttestation | null {
  const payload = event.payloadRef;
  const requiredKeys = [
    "kind", "jobId", "workspaceId", "repo", "prNumber", "headSha", "recordId",
    "acceptanceContractId", "acceptanceContractVersion", "outcomeDigest",
    "postPayloadDigest", "postedReviewUrl",
  ];
  const allowedShape = hasExactKeys(payload, requiredKeys)
    || hasExactKeys(payload, [...requiredKeys, "inlineCommentsPosted"])
    || hasExactKeys(payload, [...requiredKeys, "commentsFolded"])
    || hasExactKeys(payload, [...requiredKeys, "inlineCommentsPosted", "commentsFolded"]);
  if (!allowedShape || event.id !== changeRecordEventId({ recordId: record.id, eventKey: event.eventKey })
    || event.recordId !== record.id || event.eventKey !== reviewJobPostedAttestationEventKey(reviewJobId)
    || event.stage !== REVIEW_JOB_POSTED_ATTESTATION_STAGE
    || event.actor !== REVIEW_JOB_POSTED_ATTESTATION_ACTOR
    || payload["kind"] !== REVIEW_JOB_POSTED_ATTESTATION_KIND
    || payload["jobId"] !== reviewJobId || payload["workspaceId"] !== record.workspaceId
    || payload["recordId"] !== record.id || payload["repo"] !== record.repo
    || payload["prNumber"] !== record.prNumber
    || typeof payload["headSha"] !== "string" || !EXACT_SHA1.test(payload["headSha"])
    || !isUuid(payload["acceptanceContractId"])
    || !Number.isInteger(payload["acceptanceContractVersion"])
    || (payload["acceptanceContractVersion"] as number) <= 0
    || typeof payload["outcomeDigest"] !== "string" || !LOWER_SHA256.test(payload["outcomeDigest"])
    || typeof payload["postPayloadDigest"] !== "string" || !LOWER_SHA256.test(payload["postPayloadDigest"])
    || !isCanonicalGithubReviewUrl(payload["postedReviewUrl"], record.repo, record.prNumber!)
    || (!hasOwn(payload, "inlineCommentsPosted")
      || (Number.isInteger(payload["inlineCommentsPosted"])
        && (payload["inlineCommentsPosted"] as number) >= 0
        && (payload["inlineCommentsPosted"] as number) <= 100)) === false
    || (!hasOwn(payload, "commentsFolded") || typeof payload["commentsFolded"] === "boolean") === false) {
    return null;
  }
  return {
    reviewJobId,
    headSha: (payload["headSha"] as string).toLowerCase(),
    acceptanceContractId: payload["acceptanceContractId"],
    acceptanceContractVersion: payload["acceptanceContractVersion"] as number,
    postedReviewUrl: payload["postedReviewUrl"],
    eventId: event.id,
    reviewedAt: event.at,
  };
}

function historicalReviewServerCustody(input: {
  record: ChangeRecordRow;
  attestation: HistoricalPostedReviewAttestation;
  job: ReviewJobRow | undefined;
  contract: AcceptanceContractRow | undefined;
}): { contractSha256: string; reviewVerdict: CurrentAcceptancePrDecisionBinding["reviewVerdict"] } | null {
  const { record, attestation, job, contract } = input;
  if (!job || job.workspaceId !== record.workspaceId || job.id !== attestation.reviewJobId
    || job.repo !== record.repo || job.prNumber !== record.prNumber
    || job.headSha.toLowerCase() !== attestation.headSha || job.state !== "posted"
    || !(job.createdAt instanceof Date) || Number.isNaN(job.createdAt.valueOf())
    || job.createdAt > attestation.reviewedAt
    || !isAcceptanceReviewVerdict(job.verdict) || job.postedReviewUrl !== attestation.postedReviewUrl
    || !contract || contract.recordId !== record.id || contract.id !== attestation.acceptanceContractId
    || contract.version !== attestation.acceptanceContractVersion || contract.status !== "confirmed"
    || !isNonBlankString(contract.confirmedBy) || !(contract.confirmedAt instanceof Date)
    || Number.isNaN(contract.confirmedAt.valueOf()) || contract.confirmedAt > attestation.reviewedAt
    || !projectConfirmedAcceptanceContract(contract.contract)) {
    return null;
  }
  try {
    return { contractSha256: acceptanceContractSha256({
      acceptanceContractId: contract.id,
      acceptanceContractVersion: contract.version,
      contract: contract.contract,
    }), reviewVerdict: job.verdict };
  } catch {
    return null;
  }
}

function historicalDecisionBinding(
  event: ChangeRecordEventRow,
  record: ChangeRecordRow,
  attestation: HistoricalPostedReviewAttestation
): CurrentAcceptancePrDecisionBinding | null {
  const payload = event.payloadRef;
  const binding = parseSignedMergeDecisionBinding({
    bindingId: payload["bindingId"], workspaceId: payload["workspaceId"], recordId: payload["recordId"],
    repo: payload["repo"], prNumber: payload["prNumber"], headSha: payload["headSha"],
    headCycleId: payload["headCycleId"], authorityGeneration: payload["authorityGeneration"],
    reviewJobId: payload["reviewJobId"], reviewVerdict: payload["reviewVerdict"],
    postedReviewUrl: payload["postedReviewUrl"], postedAttestationEventId: payload["postedAttestationEventId"],
    acceptanceContract: payload["acceptanceContract"],
  });
  return event.at >= attestation.reviewedAt
    && binding && binding.workspaceId === record.workspaceId && binding.recordId === record.id
    && binding.repo === record.repo && binding.prNumber === record.prNumber
    && binding.reviewJobId === attestation.reviewJobId
    && binding.headCycleId === attestation.reviewJobId
    && binding.headSha === attestation.headSha
    && binding.acceptanceContract.id === attestation.acceptanceContractId
    && binding.acceptanceContract.version === attestation.acceptanceContractVersion
    && binding.postedReviewUrl === attestation.postedReviewUrl
    && binding.postedAttestationEventId === attestation.eventId
    ? binding : null;
}

function historicalSignedMergeMatchesReview(
  payload: SignedAcceptanceRecordMergePayload,
  record: ChangeRecordRow,
  attestation: HistoricalPostedReviewAttestation,
  contractSha256: string,
  reviewVerdict: CurrentAcceptancePrDecisionBinding["reviewVerdict"]
): boolean {
  const alignment = payload.decisionAlignment;
  if (alignment.kind === "not_current" || alignment.kind === "custody_unavailable") return false;
  return alignment.binding.workspaceId === record.workspaceId && alignment.binding.recordId === record.id
    && alignment.binding.repo === record.repo && alignment.binding.prNumber === record.prNumber
    && alignment.binding.reviewJobId === attestation.reviewJobId
    && alignment.binding.headCycleId === attestation.reviewJobId
    && alignment.binding.headSha === attestation.headSha
    && alignment.binding.reviewVerdict === reviewVerdict
    && alignment.binding.postedReviewUrl === attestation.postedReviewUrl
    && alignment.binding.postedAttestationEventId === attestation.eventId
    && alignment.binding.acceptanceContract.id === attestation.acceptanceContractId
    && alignment.binding.acceptanceContract.version === attestation.acceptanceContractVersion
    && alignment.binding.acceptanceContract.sha256 === contractSha256;
}

function historicalPostMergeOutcome(
  event: ChangeRecordEventRow,
  record: ChangeRecordRow,
  signedMerge: { event: ChangeRecordEventRow; payload: SignedAcceptanceRecordMergePayload }
): HumanAcceptancePostMergeOutcome | null {
  const payload = event.payloadRef;
  if (event.at < signedMerge.event.at
    || event.id !== changeRecordEventId({ recordId: record.id, eventKey: event.eventKey })
    || event.stage !== "post_merge_outcome" || !HUMAN_DECISION_ACTOR.test(event.actor)
    || !hasExactKeys(payload, [
      "kind", "repository", "signedMergeEventId", "signedMergeDeliveryEventId", "signedMergeSha", "outcome",
    ]) || payload["kind"] !== "acceptance_post_merge_outcome"
    || payload["repository"] !== record.repo || payload["signedMergeEventId"] !== signedMerge.event.id
    || payload["signedMergeDeliveryEventId"] !== signedMerge.payload.deliveryEventId
    || payload["signedMergeSha"] !== signedMerge.payload.mergeSha
    || !validateAcceptancePostMergeOutcome(payload["outcome"])) return null;
  const outcome = payload["outcome"];
  return event.eventKey === outcomeEventKey(outcome) ? outcome : null;
}

function historicalSignedMergeCustody(input: {
  event: ChangeRecordEventRow;
  record: ChangeRecordRow;
  evidence: Array<{ event: ChangeRecordEventRow; record: ChangeRecordRow }>;
  attestation: HistoricalPostedReviewAttestation;
  decision: CurrentAcceptancePrDecision | null;
  contractSha256: string;
  reviewVerdict: CurrentAcceptancePrDecisionBinding["reviewVerdict"];
}): { event: ChangeRecordEventRow; payload: SignedAcceptanceRecordMergePayload } | null {
  if (input.event.at < input.attestation.reviewedAt) return null;
  const payload = parseSignedAcceptanceRecordMergePayload(input.event, input.record);
  if (!payload) return null;
  const expectedEventKey = signedAcceptanceRecordMergeEventKey(payload.mergeSha);
  if (input.event.eventKey !== expectedEventKey
    || input.event.id !== changeRecordEventId({ recordId: input.record.id, eventKey: expectedEventKey })
    || !historicalSignedMergeMatchesReview(
    payload, input.record, input.attestation, input.contractSha256, input.reviewVerdict
  )) return null;
  const deliveryKey = signedAcceptanceRecordMergeDeliveryEventKey({
    prNumber: payload.prNumber, deliveryId: payload.deliveryId,
  });
  const delivery = input.evidence.find(({ event }) => event.id === payload.deliveryEventId
    && event.eventKey === deliveryKey);
  if (!delivery || delivery.event.id !== changeRecordEventId({
    recordId: input.record.id, eventKey: deliveryKey,
  }) || delivery.event.stage !== SIGNED_ACCEPTANCE_RECORD_MERGE_STAGE
    || delivery.event.actor !== SIGNED_ACCEPTANCE_RECORD_MERGE_ACTOR
    || !isDeepStrictEqual(delivery.event.payloadRef, signedAcceptanceRecordMergeDeliveryPayload({
      workspaceId: payload.workspaceId, recordId: payload.recordId, repo: payload.repo,
      prNumber: payload.prNumber, deliveryId: payload.deliveryId, headSha: payload.headSha,
      baseSha: payload.baseSha, mergeSha: payload.mergeSha, mergedAt: payload.mergedAt,
      prUrl: payload.prUrl, githubActor: payload.githubActor, source: payload.source,
    }))) return null;
  const alignment = payload.decisionAlignment;
  if (alignment.kind === "not_recorded") {
    if (input.decision !== null) return null;
  } else if (alignment.kind === "aligned" || alignment.kind === "decision_conflicts_merge") {
    if (!input.decision || alignment.decisionEventId !== input.decision.eventId
      || alignment.decision !== input.decision.decision) return null;
  } else return null;
  return { event: input.event, payload };
}

/** A same-SHA later cycle is not evidence about an earlier A occurrence. */
function signedMergeClaimsHistoricalReview(
  event: ChangeRecordEventRow,
  attestation: HistoricalPostedReviewAttestation
): boolean {
  const payload = event.payloadRef;
  if (payload["headSha"] !== attestation.headSha || !isRecord(payload["decisionAlignment"])) return false;
  const alignment = payload["decisionAlignment"];
  if (!isRecord(alignment["binding"])) return false;
  const binding = alignment["binding"];
  return binding["reviewJobId"] === attestation.reviewJobId
    || binding["headCycleId"] === attestation.reviewJobId;
}

/**
 * Projects one immutable posted-review cohort as known decisions, explicit
 * not-recorded decisions, or excluded/unknown custody. Current-head state is
 * intentionally never consulted, preserving A->B->A review cycles.
 */
export async function readAcceptanceOutcomeHistory(
  input: ReadAcceptanceOutcomeHistoryInput
): Promise<AcceptanceOutcomeHistory> {
  assertReadAcceptanceOutcomeHistoryInput(input);
  const candidates = await db.select({ event: changeRecordEvents, record: changeRecords })
    .from(changeRecordEvents)
    .innerJoin(changeRecords, eq(changeRecordEvents.recordId, changeRecords.id))
    .where(and(
      eq(changeRecords.workspaceId, input.workspaceId),
      gte(changeRecordEvents.at, input.from),
      lt(changeRecordEvents.at, input.to),
      sql`(${changeRecordEvents.eventKey} LIKE 'review:github-posted:%'
        OR ${changeRecordEvents.payloadRef}->>'kind' = ${REVIEW_JOB_POSTED_ATTESTATION_KIND})`,
    ));

  const recordIds = [...new Set(candidates.map(({ record }) => record.id))];
  const related = recordIds.length === 0 ? [] : await db.select({
    event: changeRecordEvents, record: changeRecords,
  }).from(changeRecordEvents).innerJoin(changeRecords, eq(changeRecordEvents.recordId, changeRecords.id))
    .where(and(
      eq(changeRecords.workspaceId, input.workspaceId),
      inArray(changeRecordEvents.recordId, recordIds),
      lte(changeRecordEvents.at, input.observedUntil),
      sql`(${changeRecordEvents.eventKey} LIKE 'acceptance-pr-decision:%'
        OR ${changeRecordEvents.eventKey} LIKE 'acceptance-pr:signed-merge:%'
        OR ${changeRecordEvents.eventKey} LIKE 'external-pr:signed-merge:%'
        OR ${changeRecordEvents.eventKey} LIKE 'acceptance-post-merge:%'
        OR ${changeRecordEvents.stage} = ${ACCEPTANCE_PR_DECISION_STAGE}
        OR ${changeRecordEvents.stage} = ${SIGNED_ACCEPTANCE_RECORD_MERGE_STAGE}
        OR ${changeRecordEvents.stage} = 'post_merge_outcome'
        OR ${changeRecordEvents.payloadRef}->>'kind' = ${ACCEPTANCE_PR_DECISION_KIND}
        OR ${changeRecordEvents.payloadRef}->>'kind' = ${SIGNED_ACCEPTANCE_RECORD_MERGE_KIND}
        OR ${changeRecordEvents.payloadRef}->>'kind' = ${SIGNED_ACCEPTANCE_RECORD_MERGE_DELIVERY_KIND}
        OR ${changeRecordEvents.payloadRef}->>'kind' = 'acceptance_post_merge_outcome')`,
    ));
  const reviewJobIds = [...new Set(candidates.flatMap(({ event }) => {
    const id = acceptanceOutcomeReviewJobId(event.eventKey);
    return id ? [id] : [];
  }))];
  const jobs = reviewJobIds.length === 0 ? [] : await db.select().from(reviewJobs).where(and(
    eq(reviewJobs.workspaceId, input.workspaceId), inArray(reviewJobs.id, reviewJobIds),
  ));
  const contracts = recordIds.length === 0 ? [] : await db.select().from(acceptanceContracts).where(and(
    inArray(acceptanceContracts.recordId, recordIds),
    eq(acceptanceContracts.status, "confirmed"),
  ));
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const contractsByIdentity = new Map(contracts.map((contract) => [
    `${contract.recordId}:${contract.id}:${contract.version}`, contract,
  ]));
  const confirmedContractCounts = new Map<string, number>();
  for (const contract of contracts) {
    confirmedContractCounts.set(
      contract.recordId, (confirmedContractCounts.get(contract.recordId) ?? 0) + 1
    );
  }

  const relatedByRecord = new Map<string, Array<{ event: ChangeRecordEventRow; record: ChangeRecordRow }>>();
  for (const row of related) {
    const rows = relatedByRecord.get(row.record.id) ?? [];
    rows.push(row);
    relatedByRecord.set(row.record.id, rows);
  }
  const candidateCounts = new Map<string, number>();
  for (const { event } of candidates) {
    const jobId = acceptanceOutcomeReviewJobId(event.eventKey);
    if (jobId) candidateCounts.set(jobId, (candidateCounts.get(jobId) ?? 0) + 1);
  }

  const samples = candidates.map(({ event, record }): AcceptanceOutcomeHistorySample => {
    const reviewJobId = acceptanceOutcomeReviewJobId(event.eventKey);
    const blankLineage = { signedMerged: false, deploymentObserved: false, incidentObserved: false, reverted: false };
    if (!reviewJobId) return {
      recordId: record.id, reviewJobId: "", repo: record.repo, prNumber: record.prNumber ?? 0,
      headSha: null, reviewedAt: event.at, classification: "excluded_unknown", decision: null,
      exclusionReason: "invalid_posted_review_custody", lineage: blankLineage,
    };
    if ((candidateCounts.get(reviewJobId) ?? 0) !== 1) return {
      recordId: record.id, reviewJobId, repo: record.repo, prNumber: record.prNumber ?? 0,
      headSha: null, reviewedAt: event.at, classification: "excluded_unknown", decision: null,
      exclusionReason: "ambiguous_review_custody", lineage: blankLineage,
    };
    const attestation = parseHistoricalPostedReviewAttestation(event, record, reviewJobId);
    if (!attestation) return {
      recordId: record.id, reviewJobId, repo: record.repo, prNumber: record.prNumber ?? 0,
      headSha: null, reviewedAt: event.at, classification: "excluded_unknown", decision: null,
      exclusionReason: "invalid_posted_review_custody", lineage: blankLineage,
    };
    const serverCustody = historicalReviewServerCustody({
      record, attestation, job: jobsById.get(reviewJobId),
      contract: contractsByIdentity.get(
        `${record.id}:${attestation.acceptanceContractId}:${attestation.acceptanceContractVersion}`
      ),
    });
    if (!serverCustody || confirmedContractCounts.get(record.id) !== 1) return {
      recordId: record.id, reviewJobId, repo: record.repo, prNumber: record.prNumber!,
      headSha: attestation.headSha, reviewedAt: event.at, classification: "excluded_unknown", decision: null,
      exclusionReason: "invalid_posted_review_custody", lineage: blankLineage,
    };
    const evidence = relatedByRecord.get(record.id) ?? [];
    const decisionEventKey = acceptancePrDecisionEventKey(reviewJobId);
    const decisionEvents = evidence.filter(({ event: relatedEvent }) => {
      const payload = relatedEvent.payloadRef;
      const relevant = relatedEvent.eventKey.startsWith("acceptance-pr-decision:")
        || relatedEvent.stage === ACCEPTANCE_PR_DECISION_STAGE
        || payload["kind"] === ACCEPTANCE_PR_DECISION_KIND;
      return relevant && (relatedEvent.eventKey === decisionEventKey
        || payload["reviewJobId"] === reviewJobId || payload["headCycleId"] === reviewJobId);
    });
    if (decisionEvents.length > 1) return {
      recordId: record.id, reviewJobId, repo: record.repo, prNumber: record.prNumber!,
      headSha: attestation.headSha, reviewedAt: event.at, classification: "excluded_unknown", decision: null,
      exclusionReason: "invalid_decision_custody", lineage: blankLineage,
    };
    const decisionEvent = decisionEvents[0];
    let decision: CurrentAcceptancePrDecision | null = null;
    if (decisionEvent) {
      const binding = historicalDecisionBinding(decisionEvent.event, record, attestation);
      decision = binding ? parseCurrentAcceptancePrDecisionEvent({ event: decisionEvent.event, binding }) : null;
      if (!decision || binding!.acceptanceContract.sha256 !== serverCustody.contractSha256) return {
        recordId: record.id, reviewJobId, repo: record.repo, prNumber: record.prNumber!,
        headSha: attestation.headSha, reviewedAt: event.at, classification: "excluded_unknown", decision: null,
        exclusionReason: "invalid_decision_custody", lineage: blankLineage,
      };
    }
    const mergeCandidates = evidence.filter(({ event: relatedEvent }) =>
      (relatedEvent.eventKey.startsWith("acceptance-pr:signed-merge:")
        || relatedEvent.payloadRef["kind"] === SIGNED_ACCEPTANCE_RECORD_MERGE_KIND)
      && signedMergeClaimsHistoricalReview(relatedEvent, attestation));
    const signedMerges = mergeCandidates.flatMap(({ event: relatedEvent, record: relatedRecord }) => {
      const merge = historicalSignedMergeCustody({
        event: relatedEvent, record: relatedRecord, evidence, attestation, decision,
        contractSha256: serverCustody.contractSha256, reviewVerdict: serverCustody.reviewVerdict,
      });
      return merge ? [merge] : [];
    });
    if (mergeCandidates.length !== signedMerges.length) return {
      recordId: record.id, reviewJobId, repo: record.repo, prNumber: record.prNumber!,
      headSha: attestation.headSha, reviewedAt: event.at, classification: "excluded_unknown", decision: null,
      exclusionReason: "invalid_lineage_custody", lineage: blankLineage,
    };
    const postMergeEvents = evidence.filter(({ event: relatedEvent }) =>
      (relatedEvent.eventKey.startsWith("acceptance-post-merge:")
        || relatedEvent.stage === "post_merge_outcome"
        || relatedEvent.payloadRef["kind"] === "acceptance_post_merge_outcome")
      && signedMerges.some((merge) => relatedEvent.payloadRef["signedMergeEventId"] === merge.event.id));
    const postMergeOutcomes = signedMerges.flatMap((merge) => postMergeEvents.flatMap(({ event: relatedEvent, record: relatedRecord }) => {
      const outcome = historicalPostMergeOutcome(relatedEvent, relatedRecord, merge);
      return outcome ? [outcome] : [];
    }));
    if (postMergeOutcomes.length !== postMergeEvents.length) return {
      recordId: record.id, reviewJobId, repo: record.repo, prNumber: record.prNumber!,
      headSha: attestation.headSha, reviewedAt: event.at, classification: "excluded_unknown", decision: null,
      exclusionReason: "invalid_lineage_custody", lineage: blankLineage,
    };
    const lineage = {
      signedMerged: signedMerges.length > 0,
      deploymentObserved: postMergeOutcomes.some((outcome) => outcome.kind === "deployed"),
      incidentObserved: postMergeOutcomes.some((outcome) => outcome.kind === "incident"),
      reverted: postMergeOutcomes.some((outcome) => outcome.kind === "reverted"),
    };
    const classification: AcceptanceOutcomeHistoryClassification = decision?.decision ?? "not_recorded";
    return {
      recordId: record.id, reviewJobId, repo: record.repo, prNumber: record.prNumber!,
      headSha: attestation.headSha, reviewedAt: event.at, classification, decision,
      exclusionReason: null, lineage,
    };
  }).sort((a, b) => a.reviewedAt.valueOf() - b.reviewedAt.valueOf()
    || a.recordId.localeCompare(b.recordId) || a.reviewJobId.localeCompare(b.reviewJobId));

  const counts = {
    eligible: 0, approved: 0, approvedWithException: 0, changesRequested: 0, rejected: 0,
    notRecorded: 0, excludedUnknown: 0, signedMerged: 0, deploymentObserved: 0,
    incidentObserved: 0, reverted: 0,
  };
  for (const sample of samples) {
    if (sample.classification === "excluded_unknown") {
      counts.excludedUnknown++;
      continue;
    }
    counts.eligible++;
    if (sample.classification === "approved") counts.approved++;
    else if (sample.classification === "approved_with_exception") counts.approvedWithException++;
    else if (sample.classification === "changes_requested") counts.changesRequested++;
    else if (sample.classification === "rejected") counts.rejected++;
    else counts.notRecorded++;
    if (sample.lineage.signedMerged) counts.signedMerged++;
    if (sample.lineage.deploymentObserved) counts.deploymentObserved++;
    if (sample.lineage.incidentObserved) counts.incidentObserved++;
    if (sample.lineage.reverted) counts.reverted++;
  }
  return { cohort: { from: input.from, to: input.to, observedUntil: input.observedUntil }, counts, samples };
}

/**
 * Converges one authenticated GitHub `pull_request.closed+merged` delivery
 * onto its tracked Acceptance Record. This records the signed merge fact even
 * when no aligned approval exists; it never treats merge as human approval.
 */
export async function recordSignedAcceptanceRecordMerge(
  input: RecordSignedAcceptanceRecordMergeInput
): Promise<RecordSignedAcceptanceRecordMergeResult> {
  const parsed = parseRecordSignedAcceptanceRecordMergeInput(input);
  if (!parsed) throw new Error("Signed Acceptance Record merge requires exact GitHub webhook provenance");
  const lockKey = acceptanceRecordPullRequestLockKey(parsed);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const rawRecord = (Array.from(await tx.execute(sql`
      SELECT * FROM change_records
      WHERE id = ${parsed.recordId}
        AND workspace_id = ${parsed.workspaceId}
        AND repo = ${parsed.repo}
      FOR UPDATE
    `)) as Array<Record<string, unknown>>)[0];
    if (!rawRecord) return { kind: "not_found" };
    const record = mapChangeRecordRow(rawRecord);
    if (record.prNumber !== parsed.prNumber) return { kind: "not_attached" };

    const deliveryEventKey = signedAcceptanceRecordMergeDeliveryEventKey(parsed);
    const deliveryEventId = changeRecordEventId({ recordId: record.id, eventKey: deliveryEventKey });
    const existingDelivery = (await tx.select({ id: changeRecordEvents.id }).from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, record.id), eq(changeRecordEvents.eventKey, deliveryEventKey),
    )).limit(1))[0];
    if (existingDelivery) {
      const stored = await resolveStoredSignedAcceptanceRecordMergeInTransaction(tx, record);
      const exactDelivery = await readExactSignedAcceptanceRecordMergeDeliveryInTransaction(tx, parsed);
      if (!stored || !exactDelivery
        || !signedAcceptanceRecordMergeCanonicalTupleMatches(stored.payload, parsed)) {
        throw new SignedAcceptanceRecordMergeConflictError();
      }
      return {
        kind: "replayed",
        mergeEventId: stored.event.id,
        deliveryEventId,
        decisionAlignment: stored.payload.decisionAlignment,
        superseded: stored.payload.superseded,
        previewBootsTornDown: stored.payload.previewBootsTornDown,
        correctionDispatchesInvalidated: stored.payload.correctionDispatchesInvalidated,
      };
    }

    const storedMerge = await resolveStoredSignedAcceptanceRecordMergeInTransaction(tx, record);
    if (storedMerge) {
      if (!signedAcceptanceRecordMergeCanonicalTupleMatches(storedMerge.payload, parsed)) {
        throw new SignedAcceptanceRecordMergeConflictError();
      }
      let replayDelivery: AppendChangeRecordEventsAtomicallyResult;
      try {
        replayDelivery = await appendChangeRecordEventsAtomicallyInTransaction(tx, [{
          recordId: record.id,
          eventKey: deliveryEventKey,
          stage: SIGNED_ACCEPTANCE_RECORD_MERGE_STAGE,
          actor: SIGNED_ACCEPTANCE_RECORD_MERGE_ACTOR,
          at: parsed.mergedAt,
          payloadRef: signedAcceptanceRecordMergeDeliveryPayload(
            signedAcceptanceRecordMergeMetadata(parsed)
          ),
        }]);
      } catch (error) {
        if (error instanceof Error && error.message.includes("event key is already bound")) {
          throw new SignedAcceptanceRecordMergeConflictError();
        }
        throw error;
      }
      if (!replayDelivery.events[0]!.inserted
        || replayDelivery.events[0]!.event.id !== deliveryEventId) {
        throw new SignedAcceptanceRecordMergeConflictError();
      }
      return {
        kind: "replayed",
        mergeEventId: storedMerge.event.id,
        deliveryEventId,
        decisionAlignment: storedMerge.payload.decisionAlignment,
        superseded: storedMerge.payload.superseded,
        previewBootsTornDown: storedMerge.payload.previewBootsTornDown,
        correctionDispatchesInvalidated: storedMerge.payload.correctionDispatchesInvalidated,
      };
    }

    const existingSignedMerge = (await tx.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, record.id),
      eq(changeRecordEvents.stage, SIGNED_ACCEPTANCE_RECORD_MERGE_STAGE),
    ))).some((event) => event.payloadRef["kind"] === SIGNED_ACCEPTANCE_RECORD_MERGE_KIND);
    if (existingSignedMerge || record.mergedSha !== null || record.state !== "open") {
      throw new SignedAcceptanceRecordMergeConflictError();
    }

    const resolvedDecision = await resolveCurrentAcceptancePrDecisionInTransaction(
      tx, { workspaceId: parsed.workspaceId, recordId: parsed.recordId },
      { repo: parsed.repo, prNumber: parsed.prNumber }
    );
    const decisionAlignment = signedMergeDecisionAlignment({
      resolved: resolvedDecision,
      record,
      signedHeadSha: parsed.headSha,
    });
    const metadata = signedAcceptanceRecordMergeMetadata(parsed);
    let receipt: AppendChangeRecordEventsAtomicallyResult;
    try {
      receipt = await appendChangeRecordEventsAtomicallyInTransaction(tx, [{
        recordId: record.id,
        eventKey: deliveryEventKey,
        stage: SIGNED_ACCEPTANCE_RECORD_MERGE_STAGE,
        actor: SIGNED_ACCEPTANCE_RECORD_MERGE_ACTOR,
        at: parsed.mergedAt,
        payloadRef: signedAcceptanceRecordMergeDeliveryPayload(metadata),
      }]);
    } catch (error) {
      if (error instanceof Error && error.message.includes("event key is already bound")) {
        throw new SignedAcceptanceRecordMergeConflictError();
      }
      throw error;
    }
    if (!receipt.events[0]!.inserted || receipt.events[0]!.event.id !== deliveryEventId) {
      throw new SignedAcceptanceRecordMergeConflictError();
    }

    const superseded = Array.from(await tx.execute(sql`
      UPDATE review_jobs
      SET state = 'superseded', updated_at = now()
      WHERE workspace_id = ${parsed.workspaceId}
        AND repo = ${parsed.repo}
        AND pr_number = ${parsed.prNumber}
        AND state IN ('queued', 'running')
      RETURNING id
    `)).length;
    const previewBootsTornDown = Array.from(await tx.execute(sql`
      UPDATE preview_boots
      SET status = 'torn_down', reason = 'acceptance record PR merged', updated_at = now()
      WHERE workspace_id = ${parsed.workspaceId}
        AND repo = ${parsed.repo}
        AND pr_number = ${parsed.prNumber}
        AND status IN ('pending', 'claimed', 'booting', 'ready')
      RETURNING id
    `)).length;
    const correctionDispatchesInvalidated = await invalidateAcceptanceCorrectionDispatchForHeadInTransaction(tx, {
      workspaceId: parsed.workspaceId,
      recordId: parsed.recordId,
      headSha: record.currentPrHeadSha,
      headCycleId: record.currentPrHeadCycleId,
      reason: "terminal",
    });
    const authorityGenerationAfter = record.currentPrHeadAuthorityGeneration
      + (record.currentPrHeadAuthoritative ? 1 : 0);
    const updated = await tx.update(changeRecords).set({
      mergedSha: parsed.mergeSha,
      state: "merged",
      currentPrHeadAuthoritative: false,
      currentPrHeadAuthorityGeneration: authorityGenerationAfter,
      updatedAt: new Date(),
    }).where(and(
      eq(changeRecords.id, record.id),
      eq(changeRecords.workspaceId, parsed.workspaceId),
      isNull(changeRecords.mergedSha),
      eq(changeRecords.state, record.state),
      eq(changeRecords.currentPrHeadAuthorityGeneration, record.currentPrHeadAuthorityGeneration),
    )).returning({ id: changeRecords.id });
    if (updated.length !== 1) throw new SignedAcceptanceRecordMergeConflictError();

    const mergeEventKey = signedAcceptanceRecordMergeEventKey(parsed.mergeSha);
    const mergeEventId = changeRecordEventId({ recordId: record.id, eventKey: mergeEventKey });
    const payload: SignedAcceptanceRecordMergePayload = {
      kind: SIGNED_ACCEPTANCE_RECORD_MERGE_KIND,
      version: SIGNED_ACCEPTANCE_RECORD_MERGE_VERSION,
      ...metadata,
      deliveryEventId,
      currentHeadSha: record.currentPrHeadSha,
      currentHeadCycleId: record.currentPrHeadCycleId,
      currentHeadAuthoritative: record.currentPrHeadAuthoritative,
      authorityGenerationBefore: record.currentPrHeadAuthorityGeneration,
      authorityGenerationAfter,
      decisionAlignment,
      superseded,
      previewBootsTornDown,
      correctionDispatchesInvalidated,
    };
    let mergeEvent: AppendChangeRecordEventsAtomicallyResult;
    try {
      mergeEvent = await appendChangeRecordEventsAtomicallyInTransaction(tx, [{
        recordId: record.id,
        eventKey: mergeEventKey,
        stage: SIGNED_ACCEPTANCE_RECORD_MERGE_STAGE,
        actor: SIGNED_ACCEPTANCE_RECORD_MERGE_ACTOR,
        at: parsed.mergedAt,
        payloadRef: payload,
      }]);
    } catch (error) {
      if (error instanceof Error && error.message.includes("event key is already bound")) {
        throw new SignedAcceptanceRecordMergeConflictError();
      }
      throw error;
    }
    if (!mergeEvent.events[0]!.inserted || mergeEvent.events[0]!.event.id !== mergeEventId) {
      throw new SignedAcceptanceRecordMergeConflictError();
    }
    const storedRecord = (await tx.select().from(changeRecords).where(eq(changeRecords.id, record.id)).limit(1))[0]!;
    const stored = await resolveStoredSignedAcceptanceRecordMergeInTransaction(tx, storedRecord, parsed);
    if (!stored) throw new Error("Signed Acceptance Record merge custody could not be revalidated");
    return {
      kind: "recorded",
      mergeEventId,
      deliveryEventId,
      decisionAlignment,
      superseded,
      previewBootsTornDown,
      correctionDispatchesInvalidated,
    };
  });
}

export type AcceptancePrReviewMetricsCycleBinding = {
  workspaceId: string;
  recordId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  headCycleId: string;
  reviewJobId: string;
  reviewVerdict: CurrentAcceptancePrDecisionBinding["reviewVerdict"];
  postedReviewUrl: string;
  postedAttestationEventId: string;
  acceptanceContract: CurrentAcceptancePrDecisionBinding["acceptanceContract"];
};

export type AcceptancePrReviewMetricsSignedMerge = {
  mergeEventId: string;
  deliveryEventId: string;
  mergeSha: string;
  mergedAt: Date;
  decisionAlignment: "aligned" | "decision_conflicts_merge" | "not_recorded";
};

export type AcceptancePrReviewMetricsPostMergeOutcome = {
  eventId: string;
  eventKey: string;
  outcome: HumanAcceptancePostMergeOutcome;
  recordedBy: string;
  recordedAt: Date;
};

export type AcceptancePrReviewMetricsCycle = {
  binding: AcceptancePrReviewMetricsCycleBinding;
  current: boolean;
  reviewedAt: Date;
  effort: { kind: "known"; value: AcceptancePrReviewEffort } | { kind: "unknown" };
  decision: { kind: "known"; value: CurrentAcceptancePrDecision } | { kind: "unknown" };
  signedMerge: { kind: "known"; value: AcceptancePrReviewMetricsSignedMerge } | { kind: "unknown" };
  postMergeOutcomes:
    | { kind: "known"; values: AcceptancePrReviewMetricsPostMergeOutcome[] }
    | { kind: "unknown" };
};

export type AcceptancePrReviewMetricSamples = {
  eligible: number;
  known: number;
  unknown: number;
};

export type AcceptancePrReviewMetricsSummary = {
  reviewEffort: AcceptancePrReviewMetricSamples & {
    totalMinutes: number | null;
    averageMinutes: number | null;
  };
  decisions: AcceptancePrReviewMetricSamples;
  signedMerges: AcceptancePrReviewMetricSamples;
  postMergeOutcomes: AcceptancePrReviewMetricSamples;
};

export type ReadAcceptancePrReviewMetricsInput = {
  workspaceId: string;
  recordId: string;
};

export type ReadAcceptancePrReviewMetricsUnavailableReason =
  | "record_not_attached"
  | "invalid_record_custody"
  | "confirmed_contract_unavailable"
  | "invalid_review_custody"
  | "invalid_effort_custody"
  | "invalid_decision_custody"
  | "invalid_merge_custody"
  | "invalid_post_merge_custody";

export type ReadAcceptancePrReviewMetricsResult =
  | {
      kind: "record";
      workspaceId: string;
      recordId: string;
      repo: string;
      prNumber: number;
      currentCycle: {
        headSha: string;
        headCycleId: string;
        authorityGeneration: number;
      } | null;
      cycles: AcceptancePrReviewMetricsCycle[];
      summary: AcceptancePrReviewMetricsSummary;
    }
  | { kind: "not_found" }
  | { kind: "unavailable"; reason: ReadAcceptancePrReviewMetricsUnavailableReason };

function historicalMetricsBindingMatchesCurrentBinding(
  historical: AcceptancePrReviewMetricsCycleBinding,
  current: CurrentAcceptancePrDecisionBinding
): boolean {
  return current.workspaceId === historical.workspaceId
    && current.recordId === historical.recordId
    && current.repo === historical.repo
    && current.prNumber === historical.prNumber
    && current.headSha === historical.headSha
    && current.headCycleId === historical.headCycleId
    && current.reviewJobId === historical.reviewJobId
    && current.reviewVerdict === historical.reviewVerdict
    && current.postedReviewUrl === historical.postedReviewUrl
    && current.postedAttestationEventId === historical.postedAttestationEventId
    && isDeepStrictEqual(current.acceptanceContract, historical.acceptanceContract);
}

function currentAcceptancePrDecisionBindingFromFlatPayload(
  payload: Record<string, unknown>
): CurrentAcceptancePrDecisionBinding | null {
  return parseSignedMergeDecisionBinding({
    bindingId: payload["bindingId"],
    workspaceId: payload["workspaceId"],
    recordId: payload["recordId"],
    repo: payload["repo"],
    prNumber: payload["prNumber"],
    headSha: payload["headSha"],
    headCycleId: payload["headCycleId"],
    authorityGeneration: payload["authorityGeneration"],
    reviewJobId: payload["reviewJobId"],
    reviewVerdict: payload["reviewVerdict"],
    postedReviewUrl: payload["postedReviewUrl"],
    postedAttestationEventId: payload["postedAttestationEventId"],
    acceptanceContract: payload["acceptanceContract"],
  });
}

function parseHistoricalAcceptancePrReviewEffortEvent(input: {
  event: ChangeRecordEventRow;
  historical: AcceptancePrReviewMetricsCycleBinding;
}): AcceptancePrReviewEffort | null {
  const binding = currentAcceptancePrDecisionBindingFromFlatPayload(input.event.payloadRef);
  if (!binding || !historicalMetricsBindingMatchesCurrentBinding(input.historical, binding)) return null;
  return parseAcceptancePrReviewEffortEvent({ event: input.event, binding });
}

function parseHistoricalAcceptancePrDecisionEvent(input: {
  event: ChangeRecordEventRow;
  historical: AcceptancePrReviewMetricsCycleBinding;
}): CurrentAcceptancePrDecision | null {
  const binding = currentAcceptancePrDecisionBindingFromFlatPayload(input.event.payloadRef);
  if (!binding || !historicalMetricsBindingMatchesCurrentBinding(input.historical, binding)) return null;
  return parseCurrentAcceptancePrDecisionEvent({ event: input.event, binding });
}

function postedReviewAttestationShape(payload: Record<string, unknown>): boolean {
  const required = [
    "kind", "jobId", "workspaceId", "repo", "prNumber", "headSha", "recordId",
    "acceptanceContractId", "acceptanceContractVersion", "outcomeDigest",
    "postPayloadDigest", "postedReviewUrl",
  ];
  return hasExactKeys(payload, required)
    || hasExactKeys(payload, [...required, "inlineCommentsPosted"])
    || hasExactKeys(payload, [...required, "commentsFolded"])
    || hasExactKeys(payload, [...required, "inlineCommentsPosted", "commentsFolded"]);
}

function parseAcceptancePrReviewMetricsCycle(input: {
  event: ChangeRecordEventRow;
  job: typeof reviewJobs.$inferSelect | undefined;
  record: ChangeRecordRow;
  acceptanceContract: CurrentAcceptancePrDecisionBinding["acceptanceContract"];
}): { binding: AcceptancePrReviewMetricsCycleBinding; reviewedAt: Date } | null {
  const { event, job, record, acceptanceContract } = input;
  const payload = event.payloadRef;
  if (!job || job.state !== "posted" || !isAcceptanceReviewVerdict(job.verdict)
    || !isUuid(job.id) || !EXACT_SHA1.test(job.headSha)
    || !isCanonicalGithubReviewUrl(job.postedReviewUrl, record.repo, record.prNumber!)
    || !postedReviewAttestationShape(payload)
    || payload["kind"] !== REVIEW_JOB_POSTED_ATTESTATION_KIND
    || payload["jobId"] !== job.id || payload["workspaceId"] !== record.workspaceId
    || payload["recordId"] !== record.id || payload["repo"] !== record.repo
    || payload["prNumber"] !== record.prNumber || payload["headSha"] !== job.headSha
    || payload["acceptanceContractId"] !== acceptanceContract.id
    || payload["acceptanceContractVersion"] !== acceptanceContract.version
    || payload["postedReviewUrl"] !== job.postedReviewUrl
    || typeof payload["outcomeDigest"] !== "string" || !LOWER_SHA256.test(payload["outcomeDigest"])
    || typeof payload["postPayloadDigest"] !== "string" || !LOWER_SHA256.test(payload["postPayloadDigest"])
    || (hasOwn(payload, "inlineCommentsPosted")
      && (!Number.isInteger(payload["inlineCommentsPosted"])
        || (payload["inlineCommentsPosted"] as number) < 0
        || (payload["inlineCommentsPosted"] as number) > 100))
    || (hasOwn(payload, "commentsFolded") && typeof payload["commentsFolded"] !== "boolean")
    || event.recordId !== record.id
    || event.eventKey !== reviewJobPostedAttestationEventKey(job.id)
    || event.id !== changeRecordEventId({
      recordId: record.id,
      eventKey: reviewJobPostedAttestationEventKey(job.id),
    })
    || event.stage !== REVIEW_JOB_POSTED_ATTESTATION_STAGE
    || event.actor !== REVIEW_JOB_POSTED_ATTESTATION_ACTOR
    || !(event.at instanceof Date) || Number.isNaN(event.at.valueOf())) return null;
  return {
    binding: {
      workspaceId: record.workspaceId,
      recordId: record.id,
      repo: record.repo,
      prNumber: record.prNumber!,
      headSha: job.headSha,
      headCycleId: job.id,
      reviewJobId: job.id,
      reviewVerdict: job.verdict,
      postedReviewUrl: job.postedReviewUrl!,
      postedAttestationEventId: event.id,
      acceptanceContract: { ...acceptanceContract },
    },
    reviewedAt: event.at,
  };
}

function metricsSampleCounts(eligible: number, known: number): AcceptancePrReviewMetricSamples {
  return { eligible, known, unknown: eligible - known };
}

function assertReadAcceptancePrReviewMetricsInput(
  input: unknown
): asserts input is ReadAcceptancePrReviewMetricsInput {
  if (!isRecord(input) || !hasExactKeys(input, ["workspaceId", "recordId"])
    || !isUuid(input["workspaceId"]) || !isUuid(input["recordId"])) {
    throw new Error("Acceptance PR review metrics read requires only workspace and Record");
  }
}

/** Reads sample-honest historical metrics from canonical Acceptance Record custody only. */
export async function readAcceptancePrReviewMetrics(
  input: ReadAcceptancePrReviewMetricsInput
): Promise<ReadAcceptancePrReviewMetricsResult> {
  assertReadAcceptancePrReviewMetricsInput(input);
  const candidate = (await db.select({
    repo: changeRecords.repo,
    prNumber: changeRecords.prNumber,
  }).from(changeRecords).where(and(
    eq(changeRecords.id, input.recordId),
    eq(changeRecords.workspaceId, input.workspaceId),
  )).limit(1))[0];
  if (!candidate) return { kind: "not_found" };
  if (candidate.prNumber == null) return { kind: "unavailable", reason: "record_not_attached" };
  const lockedCandidate = { repo: candidate.repo, prNumber: candidate.prNumber as number };
  const lockKey = acceptanceRecordPullRequestLockKey({ ...input, ...lockedCandidate });
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const record = (await tx.select().from(changeRecords).where(and(
      eq(changeRecords.id, input.recordId),
      eq(changeRecords.workspaceId, input.workspaceId),
    )).limit(1))[0];
    if (!record) return { kind: "not_found" };
    if (record.repo !== lockedCandidate.repo || record.prNumber !== lockedCandidate.prNumber
      || record.prNumber == null || !safeRepo(record.repo)
      || !Number.isSafeInteger(record.prNumber) || record.prNumber <= 0
      || !Number.isInteger(record.currentPrHeadAuthorityGeneration)
      || record.currentPrHeadAuthorityGeneration < 0
      || ((record.currentPrHeadSha == null) !== (record.currentPrHeadCycleId == null))
      || (record.currentPrHeadSha != null && !EXACT_SHA1.test(record.currentPrHeadSha))
      || (record.currentPrHeadCycleId != null && !isUuid(record.currentPrHeadCycleId))
      || (record.currentPrHeadAuthoritative && (
        record.state !== "open" || record.mergedSha !== null
        || record.currentPrHeadSha == null
        || !record.headShas.includes(record.currentPrHeadSha)
      ))) {
      return { kind: "unavailable", reason: "invalid_record_custody" };
    }

    const confirmedRows = await tx.select().from(acceptanceContracts).where(and(
      eq(acceptanceContracts.recordId, record.id),
      eq(acceptanceContracts.status, "confirmed"),
    )).orderBy(asc(acceptanceContracts.version));
    if (confirmedRows.length !== 1) {
      return { kind: "unavailable", reason: "confirmed_contract_unavailable" };
    }
    const confirmed = confirmedRows[0]!;
    if (!isNonBlankString(confirmed.confirmedBy) || !(confirmed.confirmedAt instanceof Date)
      || Number.isNaN(confirmed.confirmedAt.valueOf())
      || !projectConfirmedAcceptanceContract(confirmed.contract)) {
      return { kind: "unavailable", reason: "confirmed_contract_unavailable" };
    }
    let contractSha256: string;
    try {
      contractSha256 = acceptanceContractSha256({
        acceptanceContractId: confirmed.id,
        acceptanceContractVersion: confirmed.version,
        contract: confirmed.contract,
      });
    } catch {
      return { kind: "unavailable", reason: "confirmed_contract_unavailable" };
    }
    const acceptanceContract = {
      id: confirmed.id,
      version: confirmed.version,
      sha256: contractSha256,
    };

    const events = (await tx.select().from(changeRecordEvents).where(
      eq(changeRecordEvents.recordId, record.id)
    ).orderBy(asc(changeRecordEvents.at), asc(changeRecordEvents.id))) as ChangeRecordEventRow[];
    const attestationEvents = events.filter((event) =>
      event.eventKey.startsWith("review:github-posted:")
      || event.payloadRef["kind"] === REVIEW_JOB_POSTED_ATTESTATION_KIND
    );
    const jobs = await tx.select().from(reviewJobs).where(and(
      eq(reviewJobs.workspaceId, record.workspaceId),
      eq(reviewJobs.repo, record.repo),
      eq(reviewJobs.prNumber, record.prNumber),
    ));
    const jobById = new Map(jobs.map((job) => [job.id, job]));
    const parsedCycles: Array<{
      binding: AcceptancePrReviewMetricsCycleBinding;
      reviewedAt: Date;
    }> = [];
    const seenCycleIds = new Set<string>();
    for (const event of attestationEvents) {
      const jobId = typeof event.payloadRef["jobId"] === "string"
        ? event.payloadRef["jobId"] : "";
      const cycle = parseAcceptancePrReviewMetricsCycle({
        event,
        job: jobById.get(jobId),
        record,
        acceptanceContract,
      });
      if (!cycle || seenCycleIds.has(cycle.binding.headCycleId)) {
        return { kind: "unavailable", reason: "invalid_review_custody" };
      }
      seenCycleIds.add(cycle.binding.headCycleId);
      parsedCycles.push(cycle);
    }

    const currentCycle = record.currentPrHeadAuthoritative
      ? record.currentPrHeadSha != null && record.currentPrHeadCycleId != null
        ? {
            headSha: record.currentPrHeadSha,
            headCycleId: record.currentPrHeadCycleId,
            authorityGeneration: record.currentPrHeadAuthorityGeneration,
          }
        : null
      : null;
    if (record.currentPrHeadAuthoritative && currentCycle == null) {
      return { kind: "unavailable", reason: "invalid_record_custody" };
    }

    const cycles: AcceptancePrReviewMetricsCycle[] = parsedCycles.map((cycle) => ({
      ...cycle,
      current: currentCycle?.headSha === cycle.binding.headSha
        && currentCycle.headCycleId === cycle.binding.headCycleId,
      effort: { kind: "unknown" },
      decision: { kind: "unknown" },
      signedMerge: { kind: "unknown" },
      postMergeOutcomes: { kind: "unknown" },
    }));
    const cycleById = new Map(cycles.map((cycle) => [cycle.binding.headCycleId, cycle]));

    const effortEvents = events.filter((event) =>
      event.eventKey.startsWith("acceptance-pr-review-effort:")
      || event.stage === ACCEPTANCE_PR_REVIEW_EFFORT_STAGE
      || event.payloadRef["kind"] === ACCEPTANCE_PR_REVIEW_EFFORT_KIND
    );
    for (const event of effortEvents) {
      const headCycleId = event.eventKey.slice("acceptance-pr-review-effort:".length);
      const cycle = cycleById.get(headCycleId);
      const effort = cycle && parseHistoricalAcceptancePrReviewEffortEvent({
        event,
        historical: cycle.binding,
      });
      if (!cycle || !effort || cycle.effort.kind === "known") {
        return { kind: "unavailable", reason: "invalid_effort_custody" };
      }
      cycle.effort = { kind: "known", value: effort };
    }

    const decisionEvents = events.filter((event) =>
      event.eventKey.startsWith("acceptance-pr-decision:")
      || event.stage === ACCEPTANCE_PR_DECISION_STAGE
      || event.payloadRef["kind"] === ACCEPTANCE_PR_DECISION_KIND
    );
    for (const event of decisionEvents) {
      const headCycleId = event.eventKey.slice("acceptance-pr-decision:".length);
      const cycle = cycleById.get(headCycleId);
      const decision = cycle && parseHistoricalAcceptancePrDecisionEvent({
        event,
        historical: cycle.binding,
      });
      if (!cycle || !decision || cycle.decision.kind === "known") {
        return { kind: "unavailable", reason: "invalid_decision_custody" };
      }
      cycle.decision = { kind: "known", value: decision };
    }

    const mergeEvents = events.filter((event) =>
      event.eventKey.startsWith("acceptance-pr:signed-merge:")
      || event.payloadRef["kind"] === SIGNED_ACCEPTANCE_RECORD_MERGE_KIND
    );
    let storedMerge: Awaited<ReturnType<typeof resolveStoredSignedAcceptanceRecordMergeInTransaction>> = null;
    let mergeCycle: AcceptancePrReviewMetricsCycle | null = null;
    if (mergeEvents.length > 0 || record.mergedSha != null) {
      storedMerge = await resolveStoredSignedAcceptanceRecordMergeInTransaction(tx, record);
      if (mergeEvents.length !== 1 || !storedMerge) {
        return { kind: "unavailable", reason: "invalid_merge_custody" };
      }
      const alignment = storedMerge.payload.decisionAlignment;
      if (alignment.kind === "aligned" || alignment.kind === "decision_conflicts_merge"
        || alignment.kind === "not_recorded") {
        mergeCycle = cycleById.get(alignment.binding.headCycleId) ?? null;
        if (!mergeCycle
          || !historicalMetricsBindingMatchesCurrentBinding(mergeCycle.binding, alignment.binding)) {
          return { kind: "unavailable", reason: "invalid_merge_custody" };
        }
        mergeCycle.signedMerge = {
          kind: "known",
          value: {
            mergeEventId: storedMerge.event.id,
            deliveryEventId: storedMerge.payload.deliveryEventId,
            mergeSha: storedMerge.payload.mergeSha,
            mergedAt: new Date(storedMerge.payload.mergedAt),
            decisionAlignment: alignment.kind,
          },
        };
      } else {
        // A signed merge receipt exists, but these alignment variants carry
        // no exact reviewed-cycle lineage for the merged head. Reporting the
        // cycle as merely unknown would falsely imply that no receipt exists.
        return { kind: "unavailable", reason: "invalid_merge_custody" };
      }
    }

    const postMergeEvents = events.filter((event) =>
      event.eventKey.startsWith("acceptance-post-merge:")
      || event.stage === "post_merge_outcome"
      || event.payloadRef["kind"] === "acceptance_post_merge_outcome"
    );
    if (postMergeEvents.length > 0 && (!storedMerge || !mergeCycle)) {
      return { kind: "unavailable", reason: "invalid_post_merge_custody" };
    }
    const postMergeValues: AcceptancePrReviewMetricsPostMergeOutcome[] = [];
    for (const event of postMergeEvents) {
      const payload = event.payloadRef;
      const outcome = payload["outcome"];
      const exactOutcome = isRecord(outcome) && validateAcceptancePostMergeOutcome(outcome)
        && (outcome["kind"] === "deployed"
          ? hasExactKeys(outcome, ["kind", "revisionSha", "environment", "deploymentReference"])
          : outcome["kind"] === "incident"
            ? hasExactKeys(outcome, ["kind", "revisionSha", "incidentReference"])
            : hasExactKeys(outcome, ["kind", "revertedSha", "revertSha", "revertReference"]));
      if (!storedMerge || !mergeCycle || !exactOutcome
        || !hasExactKeys(payload, [
          "kind", "repository", "signedMergeEventId", "signedMergeDeliveryEventId",
          "signedMergeSha", "outcome",
        ]) || payload["kind"] !== "acceptance_post_merge_outcome"
        || payload["repository"] !== record.repo
        || payload["signedMergeEventId"] !== storedMerge.event.id
        || payload["signedMergeDeliveryEventId"] !== storedMerge.payload.deliveryEventId
        || payload["signedMergeSha"] !== storedMerge.payload.mergeSha
        || event.eventKey !== outcomeEventKey(outcome)
        || event.id !== changeRecordEventId({ recordId: record.id, eventKey: event.eventKey })
        || event.stage !== "post_merge_outcome"
        || !boundedOutcomeReference(event.actor, 256)
        || !(event.at instanceof Date) || Number.isNaN(event.at.valueOf())) {
        return { kind: "unavailable", reason: "invalid_post_merge_custody" };
      }
      postMergeValues.push({
        eventId: event.id,
        eventKey: event.eventKey,
        outcome: outcome as HumanAcceptancePostMergeOutcome,
        recordedBy: event.actor,
        recordedAt: event.at,
      });
    }
    if (mergeCycle && postMergeValues.length > 0) {
      mergeCycle.postMergeOutcomes = { kind: "known", values: postMergeValues };
    }

    const eligible = cycles.length;
    const effortValues = cycles.flatMap((cycle) =>
      cycle.effort.kind === "known" ? [cycle.effort.value.minutes] : []
    );
    const effortTotal = effortValues.length > 0
      ? effortValues.reduce((total, minutes) => total + minutes, 0)
      : null;
    const effortKnown = effortValues.length;
    const decisionKnown = cycles.filter((cycle) => cycle.decision.kind === "known").length;
    const mergeKnown = cycles.filter((cycle) => cycle.signedMerge.kind === "known").length;
    const postMergeKnown = cycles.filter((cycle) => cycle.postMergeOutcomes.kind === "known").length;
    return {
      kind: "record",
      workspaceId: record.workspaceId,
      recordId: record.id,
      repo: record.repo,
      prNumber: record.prNumber,
      currentCycle,
      cycles,
      summary: {
        reviewEffort: {
          ...metricsSampleCounts(eligible, effortKnown),
          totalMinutes: effortTotal,
          averageMinutes: effortTotal == null ? null : effortTotal / effortKnown,
        },
        decisions: metricsSampleCounts(eligible, decisionKnown),
        signedMerges: metricsSampleCounts(eligible, mergeKnown),
        postMergeOutcomes: metricsSampleCounts(mergeKnown, postMergeKnown),
      },
    };
  });
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
    "workspaceId" | "recordId" | "reviewJobId" | "acceptanceContractId" | "acceptanceContractVersion" | "repo" | "prNumber"
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
  return db.transaction((tx) => resolveAcceptanceContextPackCustodyInTransaction(tx, input));
}

/** Shared transaction-scoped authority check for custody resolution and Pack persistence. */
async function resolveAcceptanceContextPackCustodyInTransaction(
  tx: DbTransaction,
  input: ResolveAcceptanceContextPackCustodyInput
): Promise<AcceptanceContextPackCustodyResolution> {
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
    if (!records[0]
      || !records[0].currentPrHeadAuthoritative
      || records[0].currentPrHeadSha !== snapshot.expectedHeadSha
      || records[0].currentPrHeadCycleId !== snapshot.reviewJobId
      || !records[0].headShas.includes(snapshot.expectedHeadSha)) {
      throw new Error("Context Pack custody Record head is no longer current");
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
        id: snapshot.id, workspaceId: snapshot.workspaceId, recordId: snapshot.recordId, reviewJobId: snapshot.reviewJobId,
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
}

const COMPILED_PACK_BYTE_BUDGET = 65_536;
const COMPILED_PACK_MAX_SOURCES = 64;
const COMPILED_PACK_MAX_SELECTED_RANGES = 64;
const SOURCE_CUSTODY_MAX_RECORDS = 128;
const SOURCE_CUSTODY_MAX_FILE_BYTES = 256 * 1024;
const SOURCE_CUSTODY_MAX_RECORD_BYTES = 1024 * 1024;
const SOURCE_CUSTODY_MAX_DIRECT_READS = 16;
const SOURCE_CUSTODY_MAX_DIRECT_BYTES = 512 * 1024;

export type AcceptanceCompiledContextPackInput = {
  kind: "compiled_acceptance_context_pack";
  version: 1;
  binding: Record<string, unknown>;
  compiler: Record<string, unknown>;
  manifest: Record<string, unknown>;
  sourceCustodyReceipt: Record<string, unknown>;
  /** Durable handles only; native Git tree bodies remain transient. */
  exactHeadDependencyTreeProofs: AcceptanceCompiledContextPackDependencyTreeProof[];
  representations: Record<string, unknown>;
  renderedByteCount: number;
  packSha256: string;
};

/**
 * Metadata retained for each selected exact-head dependency. Its matching
 * native Git tree inclusion proof is supplied only at the write boundary.
 */
export type AcceptanceCompiledContextPackDependencyTreeProof = {
  path: string;
  blobSha: string;
  proofIdentitySha256: string;
};

/**
 * Ephemeral exact-source bytes used only to rederive Git/range identities at
 * the write boundary. These bytes are never inserted into Postgres.
 */
export type AcceptanceCompiledContextPackExactSourceProof = {
  kind: "exact_head_overlay" | "exact_head_dependency";
  path: string;
  content: string;
};

export type RecordAcceptanceCompiledContextPackInput = {
  workspaceId: string;
  sourceSnapshotId: string;
  compiled: unknown;
  exactSourceProofs: readonly AcceptanceCompiledContextPackExactSourceProof[];
  /** Transient full native-tree proofs; raw tree bodies are never persisted. */
  exactGitTreeInclusionProofs: readonly ExactGitTreeInclusionProof[];
};

export type ResolveAcceptanceCompiledContextPackInput = {
  workspaceId: string;
  sourceSnapshotId: string;
  compilerVersion: string;
  policyVersion: string;
};

type ParsedCompiledPack = AcceptanceCompiledContextPackInput & {
  binding: Record<string, unknown>;
  compiler: Record<string, unknown>;
  manifest: Record<string, unknown>;
  sourceCustodyReceipt: Record<string, unknown>;
  representations: Record<string, unknown>;
};

function isSha256(value: unknown): value is string {
  return typeof value === "string" && EXACT_SHA256.test(value);
}

function isSha1(value: unknown): value is string {
  return typeof value === "string" && EXACT_SHA1.test(value);
}

function isExactHeadDependencyTreeProofMetadata(value: unknown): value is AcceptanceCompiledContextPackDependencyTreeProof {
  return isRecord(value) && hasExactKeys(value, ["path", "blobSha", "proofIdentitySha256"])
    && safeRepoPath(value["path"]) && isSha1(value["blobSha"]) && isSha256(value["proofIdentitySha256"]);
}

function dependencyTreeProofKey(value: Pick<AcceptanceCompiledContextPackDependencyTreeProof, "path" | "blobSha">): string {
  return `${value.path}\u0000${value.blobSha}`;
}

function hasCanonicalDependencyTreeProofMetadata(value: unknown): value is AcceptanceCompiledContextPackDependencyTreeProof[] {
  return Array.isArray(value) && value.length <= SOURCE_CUSTODY_MAX_DIRECT_READS
    && value.every(isExactHeadDependencyTreeProofMetadata)
    && value.every((item, index, items) => index === 0 || compareUtf8Text(
      dependencyTreeProofKey(items[index - 1]!), dependencyTreeProofKey(item),
    ) < 0);
}

function isPositiveLine(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_CONTEXT_CUSTODY_HEAD_LINE;
}

function isPackText(value: unknown, max = 2_000): value is string {
  return safeSnapshotText(value, max);
}

function compareUtf8Text(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function hasForbiddenPackMetadata(value: unknown): boolean {
  const forbiddenKeys = new Set([
    "content", "body", "bodymd", "sourcetext", "rawsource", "rendered", "json", "markdown", "patch",
    "snippet", "url", "uri", "token", "authorization", "secret", "password",
  ]);
  const visit = (item: unknown): boolean => {
    if (typeof item === "string") return SECRET_LIKE.test(item) || /https?:\/\//iu.test(item);
    if (item === null || typeof item === "boolean" || typeof item === "number") return false;
    if (Array.isArray(item)) return item.some(visit);
    if (!isRecord(item) || Object.getPrototypeOf(item) !== Object.prototype) return true;
    return Object.entries(item).some(([key, nested]) => forbiddenKeys.has(key.toLowerCase()) || visit(nested));
  };
  return visit(value);
}

function hasSortedUniqueStrings(value: unknown, max: number): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every((item) => isPackText(item, 2_000))
    && value.every((item, index, items) => index === 0 || compareUtf8Text(items[index - 1]!, item) < 0)
    && new Set(value).size === value.length;
}

function isManifestExclusion(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !["exact_head_overlay", "exact_head_dependency", "base_index_background"].includes(value["source"] as string)
    || !isManifestExclusionReason(value["reason"]) || (value["path"] !== null && !safeRepoPath(value["path"]))) return false;
  return (hasExactKeys(value, ["source", "path", "reason"])
    || (hasExactKeys(value, ["source", "path", "reason", "identitySha256"]) && isSha256(value["identitySha256"])));
}

function isManifestExclusionReason(value: unknown): value is string {
  return value === "removed_at_exact_head" || value === "missing_patch_ranges"
    || value === "range_byte_limit" || value === "range_byte_or_secret_limit"
    || value === "unsupported_dependency_expression" || value === "dependency_limit"
    || value === "dependency_not_found" || value === "base_index_gap"
    || value === "base_index_stale"
    || value === "base_index_content_limit" || value === "base_index_secret_policy"
    || value === "base_index_page_limit" || value === "pack_budget"
    || (typeof value === "string"
      && /^dependency_(?:invalid_input|github_unavailable|github_rejected|invalid_tree|tree_limit|call_limit|invalid_blob|path_not_found|content_limit|unsafe_content|unsafe_path)$/u.test(value));
}

function manifestExclusionKey(value: Record<string, unknown>): string {
  return `${value["source"]}\u0000${value["path"] ?? ""}\u0000${value["reason"]}\u0000${value["identitySha256"] ?? ""}`;
}

function isSourceCustodyExclusion(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, ["path", "source", "blobSha", "byteCount", "reason", "secretKinds", "findingCount"])
    || !safeRepoPath(value["path"])
    || (value["source"] !== "exact_head_overlay" && value["source"] !== "exact_head_tree_fallback")
    || (value["blobSha"] !== null && !isSha1(value["blobSha"]))
    || (value["byteCount"] !== null && !nonNegativeBoundedInteger(value["byteCount"], SOURCE_CUSTODY_MAX_FILE_BYTES))
    || (value["reason"] !== "removed_at_exact_head" && value["reason"] !== "secret_path_policy" && value["reason"] !== "secret_content_policy")
    || !Array.isArray(value["secretKinds"]) || value["secretKinds"].length > 16
    || !value["secretKinds"].every((kind) => isPackText(kind, 128))
    || !value["secretKinds"].every((kind, index, kinds) => index === 0 || compareUtf8Text(kinds[index - 1] as string, kind as string) < 0)
    || new Set(value["secretKinds"]).size !== value["secretKinds"].length
    || !Number.isSafeInteger(value["findingCount"]) || (value["findingCount"] as number) < 0 || (value["findingCount"] as number) > 1024) return false;
  const secretKinds = value["secretKinds"] as string[];
  const findingCount = value["findingCount"] as number;
  if (value["reason"] === "removed_at_exact_head") {
    return value["source"] === "exact_head_overlay" && value["blobSha"] === null
      && value["byteCount"] === null && secretKinds.length === 0 && findingCount === 0;
  }
  if (value["reason"] === "secret_path_policy") {
    return value["byteCount"] === null && secretKinds.length === 0 && findingCount === 0;
  }
  return value["blobSha"] !== null && value["byteCount"] !== null && secretKinds.length > 0 && findingCount > 0;
}

function sourceCustodyExclusionKey(value: Record<string, unknown>): string {
  return `${value["source"]}\u0000${value["path"]}\u0000${value["reason"]}\u0000${value["blobSha"] ?? ""}`;
}

function sourceCustodyReadKey(value: Record<string, unknown>): string {
  const record = isRecord(value["record"]) ? value["record"] : null;
  return `${value["requestedPath"]}\u0000${value["outcome"]}\u0000${record?.["blobSha"] ?? value["reason"] ?? ""}`;
}

function exactSourceReasonMatches(value: Record<string, unknown>): boolean {
  return value["kind"] === "exact_head_overlay"
    ? value["reason"] === "exact_patch_head_range"
    : value["reason"] === "static_relative_import" || value["reason"] === "static_python_import" || value["reason"] === "static_shell_source";
}

function exactSourceCitationMatches(value: Record<string, unknown>): boolean {
  return value["citation"] === `${value["path"]}@${value["blobSha"]}#L${value["startLine"]}-L${value["endLine"]}`;
}

function isExactPackSource(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && hasExactKeys(value, [
    "kind", "path", "blobSha", "fullContentSha256", "startLine", "endLine", "rangeSha256", "byteCount", "reason", "citation",
  ]) && (value["kind"] === "exact_head_overlay" || value["kind"] === "exact_head_dependency")
    && safeRepoPath(value["path"]) && isSha1(value["blobSha"]) && isSha256(value["fullContentSha256"])
    && isPositiveLine(value["startLine"]) && isPositiveLine(value["endLine"])
    && (value["startLine"] as number) <= (value["endLine"] as number)
    && isSha256(value["rangeSha256"]) && positiveBoundedInteger(value["byteCount"], 12 * 1024)
    && exactSourceReasonMatches(value) && exactSourceCitationMatches(value);
}

function isWikiPackSource(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && hasExactKeys(value, [
    "kind", "pageId", "slug", "commitSha", "inputsHashSha256", "pageBodySha256", "stale", "startLine", "endLine", "rangeSha256", "byteCount", "reason", "citation",
  ]) && value["kind"] === "base_index_background" && isUuid(value["pageId"])
    && safeRepoPath(value["slug"]) && isSha1(value["commitSha"]) && isSha256(value["inputsHashSha256"])
    && isSha256(value["pageBodySha256"]) && value["stale"] === false
    && isPositiveLine(value["startLine"]) && isPositiveLine(value["endLine"])
    && (value["startLine"] as number) <= (value["endLine"] as number)
    && isSha256(value["rangeSha256"]) && positiveBoundedInteger(value["byteCount"], 12 * 1024)
    && value["reason"] === "background_only"
    && value["citation"] === `wiki:${value["slug"]}@${value["commitSha"]}#L${value["startLine"]}-L${value["endLine"]}`;
}

function packSourceKey(value: Record<string, unknown>): string {
  const identifier = value["kind"] === "base_index_background" ? value["slug"] : value["path"];
  return `${value["kind"]}\u0000${identifier}\u0000${String(value["startLine"]).padStart(10, "0")}\u0000${String(value["endLine"]).padStart(10, "0")}`;
}

function isSelectedExactRange(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && hasExactKeys(value, [
    "kind", "path", "blobSha", "fullContentSha256", "startLine", "endLine", "rangeSha256", "byteCount",
  ]) && (value["kind"] === "exact_head_overlay" || value["kind"] === "exact_head_dependency")
    && safeRepoPath(value["path"]) && isSha1(value["blobSha"]) && isSha256(value["fullContentSha256"])
    && isPositiveLine(value["startLine"]) && isPositiveLine(value["endLine"])
    && (value["startLine"] as number) <= (value["endLine"] as number)
    && isSha256(value["rangeSha256"]) && positiveBoundedInteger(value["byteCount"], 12 * 1024);
}

function selectedExactRangeKey(value: Record<string, unknown>): string {
  return [value["kind"], value["path"], value["blobSha"], value["fullContentSha256"], value["startLine"], value["endLine"], value["rangeSha256"], value["byteCount"]].join("\u0000");
}

function selectedExactRangeReceiptKey(value: Record<string, unknown>): string {
  return [value["kind"], value["path"], value["blobSha"], value["fullContentSha256"], value["startLine"], value["endLine"]].join("\u0000");
}

function isSourceCustodyReceipt(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, [
    "kind", "schemaVersion", "repo", "prNumber", "baseSha", "mergeBaseSha", "headSha", "headTreeSha", "manifestSha256",
    "changedManifest", "records", "exclusions", "directReadReceipts", "selectedExactRanges", "identitySha256",
  ]) || value["kind"] !== "exact_head_source_custody" || value["schemaVersion"] !== 2
    || !safeRepo(value["repo"]) || !Number.isInteger(value["prNumber"]) || (value["prNumber"] as number) <= 0
    || !isSha1(value["baseSha"]) || !isSha1(value["mergeBaseSha"]) || !isSha1(value["headSha"]) || !isSha1(value["headTreeSha"])
    || !isSha256(value["manifestSha256"]) || !isSha256(value["identitySha256"])
    || !Array.isArray(value["changedManifest"]) || value["changedManifest"].length === 0 || value["changedManifest"].length > MAX_CONTEXT_CUSTODY_COMPARE_FILES
    || !Array.isArray(value["records"]) || value["records"].length > SOURCE_CUSTODY_MAX_RECORDS
    || !Array.isArray(value["exclusions"]) || value["exclusions"].length > MAX_CONTEXT_CUSTODY_COMPARE_FILES
    || !Array.isArray(value["directReadReceipts"]) || value["directReadReceipts"].length > SOURCE_CUSTODY_MAX_DIRECT_READS
    || !Array.isArray(value["selectedExactRanges"]) || value["selectedExactRanges"].length > COMPILED_PACK_MAX_SELECTED_RANGES
  ) return false;
  const changed = value["changedManifest"];
  if (!changed.every((item) => isRecord(item) && hasExactKeys(item, ["path", "status", "blobSha", "previousPath", "headRanges", "patchSha256", "patchByteCount"])
    && safeRepoPath(item["path"]) && (item["status"] === "added" || item["status"] === "modified" || item["status"] === "removed"
      || item["status"] === "renamed" || item["status"] === "copied" || item["status"] === "changed")
    && (item["blobSha"] === null || isSha1(item["blobSha"])) && (item["previousPath"] === null || safeRepoPath(item["previousPath"]))
    && Array.isArray(item["headRanges"]) && item["headRanges"].length <= MAX_CONTEXT_CUSTODY_HEAD_RANGES
    && item["headRanges"].every((range) => isRecord(range) && hasExactKeys(range, ["startLine", "endLine"])
      && isPositiveLine(range["startLine"]) && isPositiveLine(range["endLine"]) && (range["startLine"] as number) <= (range["endLine"] as number))
    && ((item["patchSha256"] === null && item["patchByteCount"] === null && item["headRanges"].length === 0)
      || (isSha256(item["patchSha256"]) && positiveBoundedInteger(item["patchByteCount"], MAX_CONTEXT_CUSTODY_PATCH_BYTES) && item["headRanges"].length > 0))
  ) || !changed.every((item, index) => index === 0 || compareUtf8Text(
    (changed[index - 1] as Record<string, unknown>)["path"] as string,
    (item as Record<string, unknown>)["path"] as string,
  ) < 0)) return false;
  const records = value["records"];
  const recordIdentity = (record: unknown): record is Record<string, unknown> => isRecord(record)
    && hasExactKeys(record, ["path", "blobSha", "previousPath", "contentSha256", "byteCount", "lineCount", "source", "reason"])
    && safeRepoPath(record["path"]) && isSha1(record["blobSha"]) && record["previousPath"] === null
    && isSha256(record["contentSha256"]) && nonNegativeBoundedInteger(record["byteCount"], SOURCE_CUSTODY_MAX_FILE_BYTES)
    && isPositiveLine(record["lineCount"]);
  const topLevelRecord = (record: unknown): record is Record<string, unknown> =>
    recordIdentity(record) && record["source"] === "exact_head_overlay" && record["reason"] === "exact_base_to_head_compare";
  const directReadRecord = (record: unknown): record is Record<string, unknown> =>
    recordIdentity(record) && record["source"] === "exact_head_tree_fallback" && record["reason"] === "exact_head_tree_path";
  if (!records.every(topLevelRecord)
    || records.reduce((total, record) => total + ((record as Record<string, unknown>)["byteCount"] as number), 0) > SOURCE_CUSTODY_MAX_RECORD_BYTES
    || !records.every((record, index) => index === 0 || compareUtf8Text(
      ((records[index - 1] as Record<string, unknown>)["path"] as string),
      ((record as Record<string, unknown>)["path"] as string),
    ) < 0)) return false;
  const exclusions = value["exclusions"];
  if (!exclusions.every((exclusion) => isSourceCustodyExclusion(exclusion)
    && (exclusion as Record<string, unknown>)["source"] === "exact_head_overlay")
    || !exclusions.every((exclusion, index) => index === 0 || compareUtf8Text(
      sourceCustodyExclusionKey(exclusions[index - 1] as Record<string, unknown>),
      sourceCustodyExclusionKey(exclusion as Record<string, unknown>),
    ) < 0)) return false;
  const reads = value["directReadReceipts"];
  if (!reads.every((item) => isRecord(item) && typeof item["requestedPath"] === "string" && safeRepoPath(item["requestedPath"])
    && item["headSha"] === value["headSha"] && item["headTreeSha"] === value["headTreeSha"]
    && ((hasExactKeys(item, ["requestedPath", "headSha", "headTreeSha", "outcome", "record"])
      && item["outcome"] === "record" && directReadRecord(item["record"]))
      || (item["outcome"] === "not_proven" && (hasExactKeys(item, ["requestedPath", "headSha", "headTreeSha", "outcome", "reason"])
        || (hasExactKeys(item, ["requestedPath", "headSha", "headTreeSha", "outcome", "reason", "exclusion"])
          && isSourceCustodyExclusion(item["exclusion"])
          && (item["exclusion"] as Record<string, unknown>)["source"] === "exact_head_tree_fallback"))
        && (item["reason"] === "invalid_input" || item["reason"] === "github_unavailable" || item["reason"] === "github_rejected"
          || item["reason"] === "invalid_tree" || item["reason"] === "tree_limit" || item["reason"] === "call_limit"
          || item["reason"] === "invalid_blob" || item["reason"] === "path_not_found" || item["reason"] === "content_limit"
          || item["reason"] === "unsafe_content" || item["reason"] === "unsafe_path"))))) return false;
  if (new Set(reads.map((read) => (read as Record<string, unknown>)["requestedPath"])).size !== reads.length
    || !reads.every((read, index) => index === 0 || compareUtf8Text(
    sourceCustodyReadKey(reads[index - 1] as Record<string, unknown>),
    sourceCustodyReadKey(read as Record<string, unknown>),
  ) < 0)
    || reads.reduce((total, read) => total + (isRecord((read as Record<string, unknown>)["record"])
      ? ((read as Record<string, unknown>)["record"] as Record<string, unknown>)["byteCount"] as number : 0), 0) > SOURCE_CUSTODY_MAX_DIRECT_BYTES) return false;
  const selected = value["selectedExactRanges"];
  if (!selected.every(isSelectedExactRange)
    || !selected.every((item, index) => index === 0 || compareUtf8Text(
      selectedExactRangeReceiptKey(selected[index - 1] as Record<string, unknown>),
      selectedExactRangeReceiptKey(item as Record<string, unknown>),
    ) < 0)
    || !selected.some((item) => (item as Record<string, unknown>)["kind"] === "exact_head_overlay")) return false;
  try {
    return Buffer.byteLength(acceptanceContextPackCanonicalJson(value), "utf8") <= COMPILED_PACK_BYTE_BUDGET;
  } catch {
    return false;
  }
}

function parseCompiledAcceptanceContextPack(value: unknown): ParsedCompiledPack | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "kind", "version", "binding", "compiler", "manifest", "sourceCustodyReceipt", "exactHeadDependencyTreeProofs", "representations", "renderedByteCount", "packSha256",
  ]) || value["kind"] !== "compiled_acceptance_context_pack" || value["version"] !== 1
    || !isRecord(value["binding"]) || !isRecord(value["compiler"]) || !isRecord(value["manifest"])
    || !isSourceCustodyReceipt(value["sourceCustodyReceipt"]) || !hasCanonicalDependencyTreeProofMetadata(value["exactHeadDependencyTreeProofs"])
    || !isRecord(value["representations"])
    || !positiveBoundedInteger(value["renderedByteCount"], COMPILED_PACK_BYTE_BUDGET) || !isSha256(value["packSha256"])
    || hasForbiddenPackMetadata(value)
  ) return null;
  const binding = value["binding"];
  if (!hasExactKeys(binding, [
    "sourceSnapshotId", "workspaceId", "recordId", "reviewJobId", "acceptanceContractId", "acceptanceContractVersion", "acceptanceContractSha256",
    "repo", "prNumber", "baseSha", "mergeBaseSha", "headSha", "headTreeSha", "packetSetSha256", "correctionPacketPayloadSetSha256",
    "sourceSnapshotCompilerVersion", "baseIndexRevisionSha256", "overlayManifestSha256",
  ]) || !isUuid(binding["sourceSnapshotId"]) || !isUuid(binding["workspaceId"]) || !isUuid(binding["recordId"]) || !isUuid(binding["reviewJobId"])
    || !isUuid(binding["acceptanceContractId"]) || !Number.isInteger(binding["acceptanceContractVersion"]) || (binding["acceptanceContractVersion"] as number) <= 0
    || !isSha256(binding["acceptanceContractSha256"]) || !safeRepo(binding["repo"]) || !Number.isInteger(binding["prNumber"]) || (binding["prNumber"] as number) <= 0
    || !isSha1(binding["baseSha"]) || !isSha1(binding["mergeBaseSha"]) || !isSha1(binding["headSha"]) || !isSha1(binding["headTreeSha"])
    || !isSha256(binding["packetSetSha256"]) || !isSha256(binding["correctionPacketPayloadSetSha256"])
    || !isPackText(binding["sourceSnapshotCompilerVersion"], 128) || !isSha256(binding["baseIndexRevisionSha256"]) || !isSha256(binding["overlayManifestSha256"])
  ) return null;
  const compiler = value["compiler"];
  if (!hasExactKeys(compiler, ["version", "policyVersion", "byteCounter", "byteBudget"])
    || !isPackText(compiler["version"], 128) || !isPackText(compiler["policyVersion"], 128)
    || compiler["byteCounter"] !== "utf8_byte_upper_bound_v1" || compiler["byteBudget"] !== COMPILED_PACK_BYTE_BUDGET) return null;
  const representations = value["representations"];
  if (!hasExactKeys(representations, ["jsonSha256", "markdownSha256"])
    || !isSha256(representations["jsonSha256"]) || !isSha256(representations["markdownSha256"])) return null;
  const manifest = value["manifest"];
  if (!hasExactKeys(manifest, [
    "version", "acceptanceCriterionIds", "unresolvedQuestionIds", "packetIds", "sources", "architectureBoundaries", "tests", "decisions", "exclusions", "sourceCustody", "budget", "custody",
  ]) || manifest["version"] !== 1 || !hasSortedUniqueStrings(manifest["acceptanceCriterionIds"], 100)
    || !hasSortedUniqueStrings(manifest["unresolvedQuestionIds"], 100) || !hasSortedUniqueStrings(manifest["packetIds"], 100)
    || !Array.isArray(manifest["sources"]) || manifest["sources"].length === 0 || manifest["sources"].length > COMPILED_PACK_MAX_SOURCES
    || !manifest["sources"].every((source) => isExactPackSource(source) || isWikiPackSource(source))
    || !manifest["sources"].every((source, index, sources) => index === 0
      || compareUtf8Text(packSourceKey(sources[index - 1] as Record<string, unknown>), packSourceKey(source as Record<string, unknown>)) < 0)
    || !hasSortedUniqueStrings(manifest["architectureBoundaries"], 100) || !hasSortedUniqueStrings(manifest["tests"], 100)
    || !hasSortedUniqueStrings(manifest["decisions"], 100) || !Array.isArray(manifest["exclusions"]) || manifest["exclusions"].length > COMPILED_PACK_MAX_SOURCES
    || !manifest["exclusions"].every(isManifestExclusion)
    || !manifest["exclusions"].every((item, index, exclusions) => index === 0
      || compareUtf8Text(manifestExclusionKey(exclusions[index - 1] as Record<string, unknown>), manifestExclusionKey(item as Record<string, unknown>)) < 0)
    || !isRecord(manifest["sourceCustody"]) || !hasExactKeys(manifest["sourceCustody"], ["kind", "schemaVersion", "identitySha256"])
    || manifest["sourceCustody"]["kind"] !== "exact_head_source_custody" || manifest["sourceCustody"]["schemaVersion"] !== 2 || !isSha256(manifest["sourceCustody"]["identitySha256"])
    || !isRecord(manifest["budget"]) || !hasExactKeys(manifest["budget"], ["counter", "limitBytes"])
    || manifest["budget"]["counter"] !== "utf8_byte_upper_bound_v1" || manifest["budget"]["limitBytes"] !== COMPILED_PACK_BYTE_BUDGET
    || !isRecord(manifest["custody"]) || !hasExactKeys(manifest["custody"], ["fullSourceUploadAllowed", "rawSourcePersisted", "snippetsPersisted"])
    || manifest["custody"]["fullSourceUploadAllowed"] !== false || manifest["custody"]["rawSourcePersisted"] !== false || manifest["custody"]["snippetsPersisted"] !== false
  ) return null;
  return value as ParsedCompiledPack;
}

/** Closed parser for the metadata-only compiled Pack transport boundary. */
export function validateAcceptanceCompiledContextPackInput(value: unknown): value is AcceptanceCompiledContextPackInput {
  return parseCompiledAcceptanceContextPack(value) !== null;
}

function receiptCore(receipt: Record<string, unknown>): Record<string, unknown> {
  const { identitySha256: _identitySha256, ...core } = receipt;
  return core;
}

function compiledPackIdentity(pack: ParsedCompiledPack): string {
  return acceptanceContextPackCanonicalSha256({
    kind: pack.kind,
    version: pack.version,
    binding: pack.binding,
    compiler: pack.compiler,
    manifest: pack.manifest,
    sourceCustodyReceipt: {
      kind: pack.sourceCustodyReceipt["kind"],
      schemaVersion: pack.sourceCustodyReceipt["schemaVersion"],
      identitySha256: pack.sourceCustodyReceipt["identitySha256"],
    },
    exactHeadDependencyTreeProofs: pack.exactHeadDependencyTreeProofs,
    representations: pack.representations,
    renderedByteCount: pack.renderedByteCount,
  });
}

function exactGitTreeInclusionProofsMatch(
  pack: ParsedCompiledPack,
  proofs: readonly ExactGitTreeInclusionProof[],
): boolean {
  if (!Array.isArray(proofs)) return false;
  const expected = new Map<string, AcceptanceCompiledContextPackDependencyTreeProof>();
  for (const source of (pack.manifest["sources"] as Record<string, unknown>[]).filter(isExactPackSource)) {
    if (source["kind"] !== "exact_head_dependency") continue;
    const metadata = { path: source["path"] as string, blobSha: source["blobSha"] as string };
    expected.set(dependencyTreeProofKey(metadata), { ...metadata, proofIdentitySha256: "" });
  }
  const declared = pack.exactHeadDependencyTreeProofs;
  if (expected.size !== declared.length || proofs.length !== declared.length) return false;
  const declaredByKey = new Map<string, AcceptanceCompiledContextPackDependencyTreeProof>();
  for (const metadata of declared) {
    const key = dependencyTreeProofKey(metadata);
    if (!expected.has(key) || declaredByKey.has(key)) return false;
    declaredByKey.set(key, metadata);
  }
  const seen = new Set<string>();
  for (const proof of proofs) {
    if (!verifyExactGitTreeInclusionProof(proof) || proof.headTreeSha !== pack.binding["headTreeSha"]
      || proof.paths.length !== 1) return false;
    const path = proof.paths[0]!;
    const key = dependencyTreeProofKey(path);
    const metadata = declaredByKey.get(key);
    if (!metadata || seen.has(key) || exactGitTreeInclusionProofIdentity(proof) !== metadata.proofIdentitySha256) return false;
    seen.add(key);
  }
  return seen.size === declaredByKey.size;
}

function sourceRangeText(body: string, startLine: number, endLine: number): string {
  return body.split("\n").slice(startLine - 1, endLine).join("\n");
}

function gitBlobSha1(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${bytes.length}\0`, "utf8").update(bytes).digest("hex");
}

function exactSourceProofsMatch(
  pack: ParsedCompiledPack,
  proofs: readonly AcceptanceCompiledContextPackExactSourceProof[],
): boolean {
  if (!Array.isArray(proofs) || proofs.length < 1 || proofs.length > COMPILED_PACK_MAX_SOURCES) return false;
  const sources = (pack.manifest["sources"] as Record<string, unknown>[]).filter(isExactPackSource);
  const sourceKeys = new Set(sources.map((source) => `${source["kind"]}\u0000${source["path"]}`));
  if (sourceKeys.size !== proofs.length) return false;
  const proofMap = new Map<string, AcceptanceCompiledContextPackExactSourceProof>();
  let overlayBytes = 0;
  let dependencyBytes = 0;
  for (const proof of proofs) {
    if (!isRecord(proof) || !hasExactKeys(proof, ["kind", "path", "content"])
      || (proof.kind !== "exact_head_overlay" && proof.kind !== "exact_head_dependency")
      || !safeRepoPath(proof.path) || typeof proof.content !== "string" || proof.content.includes("\0")) return false;
    const bytes = Buffer.from(proof.content, "utf8");
    if (bytes.length < 1 || bytes.length > SOURCE_CUSTODY_MAX_FILE_BYTES || bytes.toString("utf8") !== proof.content) return false;
    if (proof.kind === "exact_head_overlay") overlayBytes += bytes.length;
    else dependencyBytes += bytes.length;
    const key = `${proof.kind}\u0000${proof.path}`;
    if (!sourceKeys.has(key) || proofMap.has(key)) return false;
    proofMap.set(key, { kind: proof.kind, path: proof.path, content: proof.content });
  }
  if (overlayBytes > SOURCE_CUSTODY_MAX_RECORD_BYTES || dependencyBytes > SOURCE_CUSTODY_MAX_DIRECT_BYTES) return false;
  for (const source of sources) {
    const proof = proofMap.get(`${source["kind"]}\u0000${source["path"]}`);
    if (!proof) return false;
    const bytes = Buffer.from(proof.content, "utf8");
    const lines = proof.content.split("\n");
    const startLine = source["startLine"] as number;
    const endLine = source["endLine"] as number;
    if (endLine > lines.length || gitBlobSha1(proof.content) !== source["blobSha"]
      || createHash("sha256").update(bytes).digest("hex") !== source["fullContentSha256"]) return false;
    const range = sourceRangeText(proof.content, startLine, endLine);
    if (Buffer.byteLength(range, "utf8") !== source["byteCount"]
      || createHash("sha256").update(range, "utf8").digest("hex") !== source["rangeSha256"]) return false;
  }
  return true;
}

/** Pure validation for the transient source proof accepted by the DB writer. */
export function validateAcceptanceCompiledContextPackExactSourceProofs(input: {
  compiled: unknown;
  exactSourceProofs: readonly AcceptanceCompiledContextPackExactSourceProof[];
}): boolean {
  const parsed = parseCompiledAcceptanceContextPack(input?.compiled);
  return parsed !== null && exactSourceProofsMatch(parsed, input.exactSourceProofs);
}

/** Pure validation for transient native-Git-tree proofs of selected dependencies. */
export function validateAcceptanceCompiledContextPackExactGitTreeInclusionProofs(input: {
  compiled: unknown;
  exactGitTreeInclusionProofs: readonly ExactGitTreeInclusionProof[];
}): boolean {
  const parsed = parseCompiledAcceptanceContextPack(input?.compiled);
  return parsed !== null && exactGitTreeInclusionProofsMatch(parsed, input.exactGitTreeInclusionProofs);
}

function bindingMatchesCustody(binding: Record<string, unknown>, custody: AcceptanceContextPackCustodyResolution): boolean {
  const source = custody.sourceSnapshot;
  return binding["sourceSnapshotId"] === source.id && binding["workspaceId"] === source.workspaceId
    && binding["recordId"] === source.recordId && binding["reviewJobId"] === source.reviewJobId
    && binding["acceptanceContractId"] === source.acceptanceContractId && binding["acceptanceContractVersion"] === source.acceptanceContractVersion
    && binding["acceptanceContractSha256"] === custody.acceptanceContractSha256 && binding["repo"] === source.repo
    && binding["prNumber"] === source.prNumber && binding["baseSha"] === source.baseSha && binding["mergeBaseSha"] === source.mergeBaseSha
    && binding["headSha"] === source.expectedHeadSha && binding["headTreeSha"] === source.headTreeSha
    && binding["packetSetSha256"] === source.packetSetSha256 && binding["correctionPacketPayloadSetSha256"] === custody.correctionPacketPayloadSetSha256
    && binding["sourceSnapshotCompilerVersion"] === source.compilerVersion && binding["baseIndexRevisionSha256"] === source.baseIndex!.revisionSha256
    && binding["overlayManifestSha256"] === source.overlay!.manifestSha256;
}

function receiptMatchesCustody(receipt: Record<string, unknown>, custody: AcceptanceContextPackCustodyResolution): boolean {
  const source = custody.sourceSnapshot;
  const overlay = source.overlay!;
  if (receipt["repo"] !== source.repo || receipt["prNumber"] !== source.prNumber || receipt["baseSha"] !== source.baseSha
    || receipt["mergeBaseSha"] !== source.mergeBaseSha || receipt["headSha"] !== source.expectedHeadSha || receipt["headTreeSha"] !== source.headTreeSha
    || receipt["identitySha256"] !== acceptanceContextPackCanonicalSha256(receiptCore(receipt))) return false;
  const expectedChanged = overlay.files.map((file) => ({
    path: file.path, status: file.status, blobSha: file.blobSha, previousPath: file.previousPath,
    headRanges: file.headRanges.map((range) => ({ startLine: range.startLine, endLine: range.endLine })),
    patchSha256: file.patchSha256, patchByteCount: file.patchByteCount,
  }));
  const receiptChanged = receipt["changedManifest"] as Record<string, unknown>[];
  if (!isDeepStrictEqual(receiptChanged, expectedChanged)) return false;
  const v1ManifestSha256 = acceptanceContextOverlayManifestSha256({
    schemaVersion: 1,
    baseSha: overlay.baseSha,
    mergeBaseSha: overlay.mergeBaseSha,
    headSha: overlay.headSha,
    files: overlay.files.map((file) => ({
      path: file.path, status: file.status, blobSha: file.blobSha, previousPath: file.previousPath,
    })),
  });
  return receipt["manifestSha256"] === v1ManifestSha256;
}

function sourcesMatchCustody(pack: ParsedCompiledPack, custody: AcceptanceContextPackCustodyResolution): boolean {
  const manifest = pack.manifest;
  const receipt = pack.sourceCustodyReceipt;
  const overlay = custody.sourceSnapshot.overlay!;
  const selected = receipt["selectedExactRanges"] as Record<string, unknown>[];
  const selectedByKey = new Map(selected.map((range) => [selectedExactRangeKey(range), range]));
  const sources = manifest["sources"] as Record<string, unknown>[];
  const exactSources = sources.filter(isExactPackSource);
  if (selectedByKey.size !== selected.length || exactSources.length !== selected.length
    || new Set(exactSources.map(selectedExactRangeKey)).size !== exactSources.length) return false;
  const records = new Map((receipt["records"] as Record<string, unknown>[]).map((record) => [record["path"] as string, record]));
  const directReads = receipt["directReadReceipts"] as Record<string, unknown>[];
  for (const source of exactSources) {
    if (!selectedByKey.has(selectedExactRangeKey(source))) return false;
    const path = source["path"] as string;
    if (source["kind"] === "exact_head_overlay") {
      const admitted = overlay.files.find((file) => file.path === path);
      const record = records.get(path);
      if (!admitted || !record || record["source"] !== "exact_head_overlay"
        || record["blobSha"] !== source["blobSha"] || record["contentSha256"] !== source["fullContentSha256"]
        || (source["endLine"] as number) > (record["lineCount"] as number)
        || !admitted.headRanges.some((range) => (source["startLine"] as number) >= range.startLine && (source["endLine"] as number) <= range.endLine)) return false;
    } else {
      const read = directReads.find((candidate) => candidate["requestedPath"] === path && candidate["outcome"] === "record");
      if (!read || read["headSha"] !== custody.sourceSnapshot.expectedHeadSha || read["headTreeSha"] !== custody.sourceSnapshot.headTreeSha
        || !isRecord(read["record"]) || read["record"]["blobSha"] !== source["blobSha"]
        || read["record"]["contentSha256"] !== source["fullContentSha256"]
        || (source["endLine"] as number) > (read["record"]["lineCount"] as number)) return false;
    }
  }
  const pages = new Map(custody.wikiPages.map((page) => [page.id, page]));
  for (const source of sources.filter(isWikiPackSource)) {
    const page = pages.get(source["pageId"] as string);
    if (!page || source["slug"] !== page.slug || source["commitSha"] !== page.commitSha
      || source["inputsHashSha256"] !== page.inputsHashSha256 || source["pageBodySha256"] !== page.pageBodySha256
      || source["stale"] !== false) return false;
    const range = sourceRangeText(page.bodyMd, source["startLine"] as number, source["endLine"] as number);
    if (Buffer.byteLength(range, "utf8") !== source["byteCount"] || wikiPageBodySha256(range) !== source["rangeSha256"]) return false;
  }
  return true;
}

function receiptExclusionsMatchManifest(pack: ParsedCompiledPack, custody: AcceptanceContextPackCustodyResolution): boolean {
  const exclusions = pack.manifest["exclusions"] as Record<string, unknown>[];
  const hasExclusion = (source: string, path: string | null, reason: string, identitySha256?: string) =>
    exclusions.some((item) => item["source"] === source && item["path"] === path && item["reason"] === reason
      && (identitySha256 === undefined || item["identitySha256"] === identitySha256));
  const receiptExclusions = pack.sourceCustodyReceipt["exclusions"] as Record<string, unknown>[];
  if (!receiptExclusions.every((item) => hasExclusion(
    "exact_head_overlay",
    item["path"] as string,
    item["reason"] as string,
  ))) return false;
  return custody.sourceSnapshot.baseIndex!.gaps.every((gap) => hasExclusion(
    "base_index_background",
    null,
    "base_index_gap",
    createHash("sha256").update(gap, "utf8").digest("hex"),
  ));
}

function manifestMatchesCustody(pack: ParsedCompiledPack, custody: AcceptanceContextPackCustodyResolution): boolean {
  const manifest = pack.manifest;
  const sortedUnique = (values: readonly string[]) => [...new Set(values)].sort(compareUtf8Text);
  const contractCriterionIds = sortedUnique(custody.contract.acceptanceCriteria.map((criterion) => criterion.id));
  const questionIds = sortedUnique(custody.contract.unresolvedQuestions.map((question) => question.id));
  const sources = manifest["sources"] as Record<string, unknown>[];
  const expectedArchitectureBoundaries = sortedUnique([
    ...custody.contract.nonGoals.map((value) => `non_goal:${value}`),
    ...custody.contract.stops.map((value) => `stop:${value}`),
  ]);
  const expectedTests = sortedUnique(sources.flatMap((source) => isExactPackSource(source)
    && /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|(?:\.test|\.spec)\.[^.]+$/u.test(source["path"] as string)
    ? [source["citation"] as string] : []));
  return isDeepStrictEqual(manifest["acceptanceCriterionIds"], contractCriterionIds)
    && isDeepStrictEqual(manifest["unresolvedQuestionIds"], questionIds)
    && isDeepStrictEqual(manifest["packetIds"], custody.sourceSnapshot.packetIds)
    && isDeepStrictEqual(manifest["architectureBoundaries"], expectedArchitectureBoundaries)
    && isDeepStrictEqual(manifest["tests"], expectedTests)
    && isDeepStrictEqual(manifest["decisions"], [])
    && (manifest["sourceCustody"] as Record<string, unknown>)["identitySha256"] === pack.sourceCustodyReceipt["identitySha256"]
    && sourcesMatchCustody(pack, custody)
    && receiptExclusionsMatchManifest(pack, custody);
}

function compiledPackComparable(row: AcceptanceCompiledContextPackRow) {
  return {
    workspaceId: row.workspaceId,
    sourceSnapshotId: row.sourceSnapshotId,
    compilerVersion: row.compilerVersion,
    policyVersion: row.policyVersion,
    packSha256: row.packSha256,
    sourceCustodyIdentitySha256: row.sourceCustodyIdentitySha256,
    jsonSha256: row.jsonSha256,
    markdownSha256: row.markdownSha256,
    renderedByteCount: row.renderedByteCount,
    binding: row.binding,
    manifest: row.manifest,
    sourceCustodyReceipt: row.sourceCustodyReceipt,
    exactHeadDependencyTreeProofs: row.exactHeadDependencyTreeProofs,
  };
}

function compiledPackInputComparable(pack: ParsedCompiledPack, workspaceId: string, sourceSnapshotId: string) {
  return {
    workspaceId,
    sourceSnapshotId,
    compilerVersion: pack.compiler["version"],
    policyVersion: pack.compiler["policyVersion"],
    packSha256: pack.packSha256,
    sourceCustodyIdentitySha256: pack.sourceCustodyReceipt["identitySha256"],
    jsonSha256: pack.representations["jsonSha256"],
    markdownSha256: pack.representations["markdownSha256"],
    renderedByteCount: pack.renderedByteCount,
    binding: pack.binding,
    manifest: pack.manifest,
    sourceCustodyReceipt: pack.sourceCustodyReceipt,
    exactHeadDependencyTreeProofs: pack.exactHeadDependencyTreeProofs,
  };
}

export function acceptanceCompiledContextPackId(input: Pick<ResolveAcceptanceCompiledContextPackInput, "sourceSnapshotId" | "compilerVersion" | "policyVersion">): string {
  return uuid5Url(`acceptance-compiled-context-pack:${input.sourceSnapshotId}:${input.compilerVersion}:${input.policyVersion}`);
}

/**
 * Persists one fully revalidated, source-free compiled Pack. Replays are
 * idempotent only if the complete metadata payload is identical.
 */
export async function recordAcceptanceCompiledContextPack(
  input: RecordAcceptanceCompiledContextPackInput
): Promise<{ pack: AcceptanceCompiledContextPackRow; inserted: boolean }> {
  if (!isUuid(input?.workspaceId) || !isUuid(input?.sourceSnapshotId)) throw new Error("Invalid compiled Context Pack scope");
  const compiled = parseCompiledAcceptanceContextPack(input.compiled);
  if (!compiled || compiled.binding["workspaceId"] !== input.workspaceId || compiled.binding["sourceSnapshotId"] !== input.sourceSnapshotId) {
    throw new Error("Invalid compiled Context Pack");
  }
  if (!exactSourceProofsMatch(compiled, input.exactSourceProofs)) {
    throw new Error("Compiled Context Pack exact-source proof is invalid");
  }
  if (!exactGitTreeInclusionProofsMatch(compiled, input.exactGitTreeInclusionProofs)) {
    throw new Error("Compiled Context Pack exact dependency tree proof is invalid");
  }
  const compilerVersion = compiled.compiler["version"] as string;
  const policyVersion = compiled.compiler["policyVersion"] as string;
  const id = acceptanceCompiledContextPackId({ sourceSnapshotId: input.sourceSnapshotId, compilerVersion, policyVersion });
  const lockKey = `acceptance-compiled-context-pack:${input.sourceSnapshotId}:${compilerVersion}:${policyVersion}`;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const custody = await resolveAcceptanceContextPackCustodyInTransaction(tx, input);
    if (!bindingMatchesCustody(compiled.binding, custody) || !receiptMatchesCustody(compiled.sourceCustodyReceipt, custody)
      || !manifestMatchesCustody(compiled, custody) || compiled.packSha256 !== compiledPackIdentity(compiled)) {
      throw new Error("Compiled Context Pack custody does not match the authoritative snapshot");
    }
    const values = {
      id, workspaceId: input.workspaceId, sourceSnapshotId: input.sourceSnapshotId, compilerVersion, policyVersion,
      packSha256: compiled.packSha256, sourceCustodyIdentitySha256: compiled.sourceCustodyReceipt["identitySha256"] as string,
      jsonSha256: compiled.representations["jsonSha256"] as string, markdownSha256: compiled.representations["markdownSha256"] as string,
      renderedByteCount: compiled.renderedByteCount, binding: compiled.binding, manifest: compiled.manifest,
      sourceCustodyReceipt: compiled.sourceCustodyReceipt,
      exactHeadDependencyTreeProofs: compiled.exactHeadDependencyTreeProofs,
    };
    const existing = await tx.select().from(acceptanceCompiledContextPacks).where(and(
      eq(acceptanceCompiledContextPacks.sourceSnapshotId, input.sourceSnapshotId),
      eq(acceptanceCompiledContextPacks.compilerVersion, compilerVersion),
      eq(acceptanceCompiledContextPacks.policyVersion, policyVersion),
    )).limit(1);
    if (existing[0]) {
      if (!isDeepStrictEqual(compiledPackComparable(existing[0]), compiledPackInputComparable(compiled, input.workspaceId, input.sourceSnapshotId))) {
        throw new Error("Compiled Context Pack replay identity is already bound to different metadata");
      }
      return { pack: existing[0], inserted: false };
    }
    const rows = await tx.insert(acceptanceCompiledContextPacks).values(values).returning();
    return { pack: rows[0]!, inserted: true };
  });
}

/** Workspace-scoped immutable Pack read; no unbounded listing API is exposed. */
export async function resolveAcceptanceCompiledContextPack(
  input: ResolveAcceptanceCompiledContextPackInput
): Promise<AcceptanceCompiledContextPackRow | null> {
  if (!isUuid(input?.workspaceId) || !isUuid(input?.sourceSnapshotId)
    || !isPackText(input?.compilerVersion, 128) || !isPackText(input?.policyVersion, 128)) return null;
  const rows = await db.select({ pack: acceptanceCompiledContextPacks })
    .from(acceptanceCompiledContextPacks)
    .innerJoin(
      acceptanceContextPackSnapshots,
      eq(acceptanceCompiledContextPacks.sourceSnapshotId, acceptanceContextPackSnapshots.id)
    )
    .innerJoin(changeRecords, and(
      eq(changeRecords.id, acceptanceContextPackSnapshots.recordId),
      eq(changeRecords.workspaceId, acceptanceCompiledContextPacks.workspaceId),
      eq(changeRecords.repo, acceptanceContextPackSnapshots.repo),
      eq(changeRecords.prNumber, acceptanceContextPackSnapshots.prNumber),
      eq(changeRecords.currentPrHeadAuthoritative, true),
      eq(changeRecords.currentPrHeadSha, acceptanceContextPackSnapshots.expectedHeadSha),
      eq(changeRecords.currentPrHeadCycleId, acceptanceContextPackSnapshots.reviewJobId),
    ))
    .where(and(
      eq(acceptanceCompiledContextPacks.workspaceId, input.workspaceId),
      eq(acceptanceCompiledContextPacks.sourceSnapshotId, input.sourceSnapshotId),
      eq(acceptanceCompiledContextPacks.compilerVersion, input.compilerVersion),
      eq(acceptanceCompiledContextPacks.policyVersion, input.policyVersion),
    )).limit(1);
  return rows[0]?.pack ?? null;
}

export type AcceptanceDependencyObservationStatus =
  | "observed"
  | "refused_unsupported_profile"
  | "refused_unsafe_runtime"
  | "refused_lockfile"
  | "refused_baseline"
  | "refused_security"
  | "not_proven";

export type AcceptanceDependencyObservationReason =
  | "unsupported_manager_profile"
  | "baseline_head_mismatch"
  | "manifest_source_not_proven"
  | "lockfile_source_not_proven"
  | "unsafe_runtime"
  | "unsafe_package_manager"
  | "unsafe_package_manager_profile"
  | "unsafe_package_manager_argv"
  | "unsafe_yarn_configuration_present"
  | "yarn_configuration_absence_not_proven"
  | "runtime_evidence_unavailable"
  | "runtime_evidence_ambiguous"
  | "package_manager_evidence_unavailable"
  | "package_manager_evidence_ambiguous"
  | "lockfile_missing"
  | "lockfile_uncommitted"
  | "lockfile_evidence_unavailable"
  | "lockfile_evidence_ambiguous"
  | "security_affected"
  | "security_evidence_unavailable"
  | "security_evidence_ambiguous";

export type AcceptanceDependencyCandidate = {
  identity: AcceptanceDependencyProfileIdentity;
  package: string;
  dependencyKind: string;
  specifier: string;
  currentVersion: string;
  targetVersion: string;
};

export type AcceptanceDependencyRuntimeEvidence = {
  identity: AcceptanceDependencyProfileIdentity;
  disposition: "safe" | "unsafe" | "unavailable" | "ambiguous";
  version: string | null;
  evidenceSha256: string;
};

export type AcceptanceDependencyPackageManagerEvidence = {
  disposition: "safe" | "unsafe" | "unavailable" | "ambiguous";
  name: string;
  version: string | null;
  profile: string;
  updateArgv: string[];
  evidenceSha256: string;
};

export type AcceptanceDependencyManifestEvidence = {
  path: string;
  blobSha: string;
};

export type AcceptanceDependencyLockfileEvidence = {
  disposition: "present" | "missing" | "uncommitted" | "unavailable" | "ambiguous";
  path: string;
  blobSha: string | null;
  evidenceSha256: string;
};

export type AcceptanceDependencyBaselineEvidence = { headSha: string };

export type AcceptanceDependencySecurityEvidence = {
  identity: AcceptanceDependencyProfileIdentity;
  disposition: "clear" | "affected" | "unavailable" | "ambiguous";
  provider: string;
  reference: string;
  reportSha256: string;
};

/** Explicit identity; the server never infers Node, npm, pnpm, or an OSV namespace. */
export type AcceptanceDependencyProfileIdentity = {
  ecosystem: string;
  manager: string;
  profile: string;
};

export type RecordAcceptanceDependencyObservationInput = {
  workspaceId: string;
  recordId: string;
  compiledPackId: string;
  candidate: AcceptanceDependencyCandidate;
  runtime: AcceptanceDependencyRuntimeEvidence;
  packageManager: AcceptanceDependencyPackageManagerEvidence;
  manifest: AcceptanceDependencyManifestEvidence;
  lockfile: AcceptanceDependencyLockfileEvidence;
  baseline: AcceptanceDependencyBaselineEvidence;
  security: AcceptanceDependencySecurityEvidence;
};

export type AcceptanceDependencyObservationBinding = {
  workspaceId: string;
  recordId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  headCycleId: string;
  authorityGeneration: number;
  reviewJobId: string;
  acceptanceContract: { id: string; version: number; sha256: string };
  compiledPack: {
    id: string;
    sha256: string;
    sourceSnapshotId: string;
    sourceCustodyIdentitySha256: string;
    compilerVersion: string;
    policyVersion: string;
    exactHeadDependencyTreeProofsSha256: string;
  };
};

export type AcceptanceDependencyObservation = {
  eventId: string;
  eventKey: string;
  status: AcceptanceDependencyObservationStatus;
  reasons: AcceptanceDependencyObservationReason[];
  candidateFingerprint: string;
  candidate: AcceptanceDependencyCandidate;
  runtime: AcceptanceDependencyRuntimeEvidence;
  packageManager: AcceptanceDependencyPackageManagerEvidence;
  manifest: AcceptanceDependencyManifestEvidence;
  lockfile: AcceptanceDependencyLockfileEvidence;
  baseline: AcceptanceDependencyBaselineEvidence;
  security: AcceptanceDependencySecurityEvidence;
  observedAt: Date;
};

export type RecordAcceptanceDependencyObservationNotReadyReason =
  | "confirmed_contract_unavailable"
  | "compiled_pack_unavailable"
  | "invalid_compiled_pack_custody";

export type RecordAcceptanceDependencyObservationResult =
  | {
      kind: "recorded" | "replayed";
      binding: AcceptanceDependencyObservationBinding;
      observation: AcceptanceDependencyObservation;
    }
  | { kind: "not_found" | "not_current" }
  | { kind: "not_ready"; reason: RecordAcceptanceDependencyObservationNotReadyReason };

/** Stable immutable-event conflict; storage failures remain ordinary errors. */
export class AcceptanceDependencyObservationConflictError extends Error {
  readonly code = "ACCEPTANCE_DEPENDENCY_OBSERVATION_CONFLICT" as const;

  constructor() {
    super("The current dependency candidate is already bound to different observation evidence");
    this.name = "AcceptanceDependencyObservationConflictError";
  }
}

/** Stable bounded-input rejection; storage failures remain ordinary errors. */
export class AcceptanceDependencyObservationInvalidEvidenceError extends Error {
  readonly code = "ACCEPTANCE_DEPENDENCY_OBSERVATION_INVALID_EVIDENCE" as const;

  constructor() {
    super("Acceptance dependency observation requires exact bounded runner evidence");
    this.name = "AcceptanceDependencyObservationInvalidEvidenceError";
  }
}

const ACCEPTANCE_DEPENDENCY_OBSERVATION_KIND = "acceptance_dependency_observation";
const ACCEPTANCE_DEPENDENCY_OBSERVATION_LEGACY_VERSION = 1;
const ACCEPTANCE_DEPENDENCY_OBSERVATION_VERSION = 2;
const ACCEPTANCE_DEPENDENCY_OBSERVATION_STAGE = "dependency_observation";
const ACCEPTANCE_DEPENDENCY_OBSERVATION_ACTOR = "server:dependency-observation";
const ACCEPTANCE_DEPENDENCY_PNPM_PROFILE = "pnpm_lockfile_only_v1";
const ACCEPTANCE_DEPENDENCY_NPM_PROFILE = "npm_package_lock_only_v1";
const ACCEPTANCE_DEPENDENCY_YARN_PROFILE = "yarn_berry_v4_root_lockfile_only_v1";
const ACCEPTANCE_DEPENDENCY_PNPM_IDENTITY: AcceptanceDependencyProfileIdentity = {
  ecosystem: "node", manager: "pnpm", profile: ACCEPTANCE_DEPENDENCY_PNPM_PROFILE,
};
const ACCEPTANCE_DEPENDENCY_NPM_IDENTITY: AcceptanceDependencyProfileIdentity = {
  ecosystem: "node", manager: "npm", profile: ACCEPTANCE_DEPENDENCY_NPM_PROFILE,
};
const ACCEPTANCE_DEPENDENCY_YARN_IDENTITY: AcceptanceDependencyProfileIdentity = {
  ecosystem: "node", manager: "yarn", profile: ACCEPTANCE_DEPENDENCY_YARN_PROFILE,
};
const NPM_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const EXACT_SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SAFE_PACKAGE_MANAGER_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const UNSAFE_NPM_SPECIFIER = /^(?:file|link|workspace|git\+|git|path|https?):/i;
const NPM_ALIAS_SPECIFIER = /^npm:/i;
const DEPENDENCY_EVIDENCE_BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const ACCEPTANCE_DEPENDENCY_KINDS = [
  "dependencies", "devDependencies", "optionalDependencies", "peerDependencies",
] as const;
const ACCEPTANCE_DEPENDENCY_NPM_SAVE_FLAGS: Record<
  (typeof ACCEPTANCE_DEPENDENCY_KINDS)[number],
  "--save-prod" | "--save-dev" | "--save-optional" | "--save-peer"
> = {
  dependencies: "--save-prod",
  devDependencies: "--save-dev",
  optionalDependencies: "--save-optional",
  peerDependencies: "--save-peer",
};
const ACCEPTANCE_DEPENDENCY_YARN_KIND_FLAGS: Record<
  (typeof ACCEPTANCE_DEPENDENCY_KINDS)[number],
  null | "--dev" | "--optional" | "--peer"
> = {
  dependencies: null,
  devDependencies: "--dev",
  optionalDependencies: "--optional",
  peerDependencies: "--peer",
};

function safeDependencyEvidenceText(value: unknown, max: number): value is string {
  return safeSnapshotText(value, max) && !DEPENDENCY_EVIDENCE_BIDI.test(value);
}

function safeDependencyEvidencePath(value: unknown): value is string {
  return safeRepoPath(value) && !DEPENDENCY_EVIDENCE_BIDI.test(value);
}

function acceptanceDependencySecurityReference(candidate: AcceptanceDependencyCandidate): string {
  return `osv:npm:${candidate.package}@${candidate.targetVersion}`;
}

function stableSemverTuple(value: string): [number, number, number] | null {
  const matched = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(value);
  if (!matched) return null;
  const tuple = matched.slice(1).map(Number) as [number, number, number];
  return tuple.every(Number.isSafeInteger) ? tuple : null;
}

function stableSemverAtLeast(value: string, minimum: [number, number, number]): boolean {
  const tuple = stableSemverTuple(value);
  if (!tuple) return false;
  for (let index = 0; index < tuple.length; index += 1) {
    if (tuple[index]! > minimum[index]!) return true;
    if (tuple[index]! < minimum[index]!) return false;
  }
  return true;
}

function yarnCandidateSpecifierIsValid(value: string): boolean {
  const exact = value.startsWith("^") || value.startsWith("~") ? value.slice(1) : value;
  return EXACT_SEMVER.test(exact);
}

function parseAcceptanceDependencyProfileIdentity(value: unknown): AcceptanceDependencyProfileIdentity | null {
  if (!isRecord(value) || !hasExactKeys(value, ["ecosystem", "manager", "profile"])
    || !safeDependencyEvidenceText(value["ecosystem"], 64)
    || !safeDependencyEvidenceText(value["manager"], 64)
    || !safeDependencyEvidenceText(value["profile"], 64)
    || !SAFE_PACKAGE_MANAGER_NAME.test(value["ecosystem"])
    || !SAFE_PACKAGE_MANAGER_NAME.test(value["manager"])
    || !SAFE_PACKAGE_MANAGER_NAME.test(value["profile"])) return null;
  return {
    ecosystem: value["ecosystem"], manager: value["manager"], profile: value["profile"],
  };
}

function sameAcceptanceDependencyProfile(
  left: AcceptanceDependencyProfileIdentity,
  right: AcceptanceDependencyProfileIdentity,
): boolean {
  return left.ecosystem === right.ecosystem && left.manager === right.manager && left.profile === right.profile;
}

type AcceptanceDependencyObservationProfile = {
  identity: AcceptanceDependencyProfileIdentity;
  candidateIsValid(candidate: AcceptanceDependencyCandidate): boolean;
  runtimeVersionIsValid(version: string): boolean;
  packageManagerVersionIsValid(version: string): boolean;
  manifestPathIsValid(path: string): boolean;
  lockfilePathIsValid(path: string): boolean;
  securityIsValid(security: AcceptanceDependencySecurityEvidence, candidate: AcceptanceDependencyCandidate): boolean;
  expectedArgv(candidate: AcceptanceDependencyCandidate): string[];
};

/** Closed server-owned capability registry. Adding a manager requires one new profile contract. */
const ACCEPTANCE_DEPENDENCY_OBSERVATION_PROFILES = new Map<string, AcceptanceDependencyObservationProfile>([
  ["node:pnpm:pnpm_lockfile_only_v1", {
    identity: ACCEPTANCE_DEPENDENCY_PNPM_IDENTITY,
    candidateIsValid: (candidate) => NPM_PACKAGE_NAME.test(candidate.package)
      && !UNSAFE_NPM_SPECIFIER.test(candidate.specifier)
      && EXACT_SEMVER.test(candidate.currentVersion) && EXACT_SEMVER.test(candidate.targetVersion)
      && ACCEPTANCE_DEPENDENCY_KINDS.includes(
        candidate.dependencyKind as (typeof ACCEPTANCE_DEPENDENCY_KINDS)[number],
      ),
    runtimeVersionIsValid: (version) => EXACT_SEMVER.test(version),
    packageManagerVersionIsValid: (version) => EXACT_SEMVER.test(version),
    manifestPathIsValid: (path) => path === "package.json" || path.endsWith("/package.json"),
    lockfilePathIsValid: (path) => path === "pnpm-lock.yaml" || path.endsWith("/pnpm-lock.yaml"),
    securityIsValid: (security, candidate) => security.provider === "osv"
      && security.reference === acceptanceDependencySecurityReference(candidate),
    expectedArgv: (candidate) => [
      "pnpm", "update", `${candidate.package}@${candidate.targetVersion}`,
      "--lockfile-only", "--ignore-scripts",
    ],
  }],
  ["node:npm:npm_package_lock_only_v1", {
    identity: ACCEPTANCE_DEPENDENCY_NPM_IDENTITY,
    candidateIsValid: (candidate) => NPM_PACKAGE_NAME.test(candidate.package)
      && !UNSAFE_NPM_SPECIFIER.test(candidate.specifier)
      && !NPM_ALIAS_SPECIFIER.test(candidate.specifier)
      && EXACT_SEMVER.test(candidate.currentVersion) && EXACT_SEMVER.test(candidate.targetVersion)
      && ACCEPTANCE_DEPENDENCY_KINDS.includes(
        candidate.dependencyKind as (typeof ACCEPTANCE_DEPENDENCY_KINDS)[number],
      ),
    runtimeVersionIsValid: (version) => EXACT_SEMVER.test(version),
    packageManagerVersionIsValid: (version) => EXACT_SEMVER.test(version),
    manifestPathIsValid: (path) => path === "package.json",
    lockfilePathIsValid: (path) => path === "package-lock.json",
    securityIsValid: (security, candidate) => security.provider === "osv"
      && security.reference === acceptanceDependencySecurityReference(candidate),
    expectedArgv: (candidate) => [
      "npm", "install", `${candidate.package}@${candidate.targetVersion}`,
      "--package-lock-only", "--ignore-scripts", "--no-audit",
      ACCEPTANCE_DEPENDENCY_NPM_SAVE_FLAGS[
        candidate.dependencyKind as (typeof ACCEPTANCE_DEPENDENCY_KINDS)[number]
      ],
    ],
  }],
  ["node:yarn:yarn_berry_v4_root_lockfile_only_v1", {
    identity: ACCEPTANCE_DEPENDENCY_YARN_IDENTITY,
    candidateIsValid: (candidate) => NPM_PACKAGE_NAME.test(candidate.package)
      && yarnCandidateSpecifierIsValid(candidate.specifier)
      && EXACT_SEMVER.test(candidate.currentVersion) && EXACT_SEMVER.test(candidate.targetVersion)
      && ACCEPTANCE_DEPENDENCY_KINDS.includes(
        candidate.dependencyKind as (typeof ACCEPTANCE_DEPENDENCY_KINDS)[number],
      ),
    runtimeVersionIsValid: (version) => stableSemverAtLeast(version, [18, 12, 0]),
    packageManagerVersionIsValid: (version) => stableSemverTuple(version)?.[0] === 4,
    manifestPathIsValid: (path) => path === "package.json",
    lockfilePathIsValid: (path) => path === "yarn.lock",
    securityIsValid: (security, candidate) => security.provider === "osv"
      && security.reference === acceptanceDependencySecurityReference(candidate),
    expectedArgv: (candidate) => {
      const argv = [
        "yarn", "add", `${candidate.package}@${candidate.targetVersion}`,
        "--mode=update-lockfile",
      ];
      const flag = ACCEPTANCE_DEPENDENCY_YARN_KIND_FLAGS[
        candidate.dependencyKind as (typeof ACCEPTANCE_DEPENDENCY_KINDS)[number]
      ];
      return flag ? [...argv, flag] : argv;
    },
  }],
]);

function isStrictCurrentAcceptanceDependencyProfile(
  identity: AcceptanceDependencyProfileIdentity,
): boolean {
  return sameAcceptanceDependencyProfile(identity, ACCEPTANCE_DEPENDENCY_NPM_IDENTITY)
    || sameAcceptanceDependencyProfile(identity, ACCEPTANCE_DEPENDENCY_YARN_IDENTITY);
}

function isFrozenReplayEligibleAcceptanceDependencyProfile(
  identity: AcceptanceDependencyProfileIdentity,
): boolean {
  return sameAcceptanceDependencyProfile(identity, ACCEPTANCE_DEPENDENCY_NPM_IDENTITY)
    || sameAcceptanceDependencyProfile(identity, ACCEPTANCE_DEPENDENCY_YARN_IDENTITY);
}

function acceptanceDependencyObservationProfile(identity: AcceptanceDependencyProfileIdentity): AcceptanceDependencyObservationProfile | null {
  const profile = ACCEPTANCE_DEPENDENCY_OBSERVATION_PROFILES.get(
    `${identity.ecosystem}:${identity.manager}:${identity.profile}`
  );
  return profile && sameAcceptanceDependencyProfile(profile.identity, identity) ? profile : null;
}

function parseRecordAcceptanceDependencyObservationInput(
  input: unknown,
  options: { freezeUnsupportedProfile?: boolean } = {},
): RecordAcceptanceDependencyObservationInput | null {
  if (!isRecord(input) || !hasExactKeys(input, [
    "workspaceId", "recordId", "compiledPackId", "candidate", "runtime",
    "packageManager", "manifest", "lockfile", "baseline", "security",
  ]) || !isUuid(input["workspaceId"]) || !isUuid(input["recordId"])
    || !isUuid(input["compiledPackId"]) || !isRecord(input["candidate"])
    || !isRecord(input["runtime"]) || !isRecord(input["packageManager"])
    || !isRecord(input["manifest"]) || !isRecord(input["lockfile"])
    || !isRecord(input["baseline"]) || !isRecord(input["security"])) return null;

  const candidate = input["candidate"];
  const candidateIdentity = parseAcceptanceDependencyProfileIdentity(candidate["identity"]);
  if (!hasExactKeys(candidate, ["identity", "package", "dependencyKind", "specifier", "currentVersion", "targetVersion"])
    || typeof candidate["package"] !== "string" || candidate["package"].length > 214
    || !candidateIdentity || !safeDependencyEvidenceText(candidate["package"], 214)
    || !safeDependencyEvidenceText(candidate["dependencyKind"], 64)
    || !safeDependencyEvidenceText(candidate["specifier"], 256)
    || !safeDependencyEvidenceText(candidate["currentVersion"], 128)
    || !safeDependencyEvidenceText(candidate["targetVersion"], 128)
    || candidate["currentVersion"] === candidate["targetVersion"]
    || (!options.freezeUnsupportedProfile
      && acceptanceDependencyObservationProfile(candidateIdentity) !== null
      && !acceptanceDependencyObservationProfile(candidateIdentity)!.candidateIsValid(candidate as AcceptanceDependencyCandidate))) return null;

  const runtime = input["runtime"];
  const runtimeIdentity = parseAcceptanceDependencyProfileIdentity(runtime["identity"]);
  if (!hasExactKeys(runtime, ["identity", "disposition", "version", "evidenceSha256"])
    || (runtime["disposition"] !== "safe" && runtime["disposition"] !== "unsafe"
      && runtime["disposition"] !== "unavailable" && runtime["disposition"] !== "ambiguous")
    || !runtimeIdentity || (runtime["version"] !== null && !safeDependencyEvidenceText(runtime["version"], 64))
    || (runtime["disposition"] === "safe"
      ? typeof runtime["version"] !== "string"
      : (runtime["disposition"] === "unavailable" || runtime["disposition"] === "ambiguous")
        && runtime["version"] !== null)
    || !isSha256(runtime["evidenceSha256"])) return null;

  const packageManager = input["packageManager"];
  if (!hasExactKeys(packageManager, [
    "disposition", "name", "version", "profile", "updateArgv", "evidenceSha256",
  ]) || (packageManager["disposition"] !== "safe"
      && packageManager["disposition"] !== "unsafe"
      && packageManager["disposition"] !== "unavailable"
      && packageManager["disposition"] !== "ambiguous")
    || typeof packageManager["name"] !== "string"
    || !SAFE_PACKAGE_MANAGER_NAME.test(packageManager["name"])
    || (packageManager["version"] !== null && !safeDependencyEvidenceText(packageManager["version"], 64))
    || (packageManager["disposition"] === "safe"
      ? typeof packageManager["version"] !== "string"
      : (packageManager["disposition"] === "unavailable" || packageManager["disposition"] === "ambiguous")
        && packageManager["version"] !== null)
    || !safeDependencyEvidenceText(packageManager["profile"], 64)
    || !Array.isArray(packageManager["updateArgv"]) || packageManager["updateArgv"].length < 1
    || packageManager["updateArgv"].length > 16
    || !packageManager["updateArgv"].every((token) => safeDependencyEvidenceText(token, 256))
    || !isSha256(packageManager["evidenceSha256"])) return null;

  const manifest = input["manifest"];
  if (!hasExactKeys(manifest, ["path", "blobSha"])
    || !safeDependencyEvidencePath(manifest["path"])
    || !isSha1(manifest["blobSha"])) return null;

  const lockfile = input["lockfile"];
  if (!hasExactKeys(lockfile, ["disposition", "path", "blobSha", "evidenceSha256"])
    || (lockfile["disposition"] !== "present" && lockfile["disposition"] !== "missing"
      && lockfile["disposition"] !== "uncommitted" && lockfile["disposition"] !== "unavailable"
      && lockfile["disposition"] !== "ambiguous")
    || !safeDependencyEvidencePath(lockfile["path"])
    || !isSha256(lockfile["evidenceSha256"])
    || (lockfile["disposition"] === "present"
      ? !isSha1(lockfile["blobSha"])
      : lockfile["blobSha"] !== null)) return null;

  const baseline = input["baseline"];
  if (!hasExactKeys(baseline, ["headSha"]) || !isSha1(baseline["headSha"])) return null;

  const security = input["security"];
  const securityIdentity = parseAcceptanceDependencyProfileIdentity(security["identity"]);
  if (!hasExactKeys(security, ["identity", "disposition", "provider", "reference", "reportSha256"])
    || (security["disposition"] !== "clear" && security["disposition"] !== "affected"
      && security["disposition"] !== "unavailable" && security["disposition"] !== "ambiguous")
    || !securityIdentity || !safeDependencyEvidenceText(security["provider"], 64)
    || !safeDependencyEvidenceText(security["reference"], 512)
    || !isSha256(security["reportSha256"])) return null;

  const liveProfile = options.freezeUnsupportedProfile
    ? null : acceptanceDependencyObservationProfile(candidateIdentity);
  if (liveProfile
    && isStrictCurrentAcceptanceDependencyProfile(liveProfile.identity)
    && (
      (runtime["disposition"] === "safe"
        && !liveProfile.runtimeVersionIsValid(runtime["version"] as string))
      || (packageManager["disposition"] === "safe"
        && !liveProfile.packageManagerVersionIsValid(packageManager["version"] as string))
      || !liveProfile.manifestPathIsValid(manifest["path"] as string)
      || !liveProfile.lockfilePathIsValid(lockfile["path"] as string)
      || !liveProfile.securityIsValid(
        security as RecordAcceptanceDependencyObservationInput["security"],
        candidate as RecordAcceptanceDependencyObservationInput["candidate"],
      )
    )) return null;

  return {
    workspaceId: (input["workspaceId"] as string).toLowerCase(),
    recordId: (input["recordId"] as string).toLowerCase(),
    compiledPackId: (input["compiledPackId"] as string).toLowerCase(),
    candidate: {
      identity: candidateIdentity,
      package: candidate["package"] as string,
      dependencyKind: candidate["dependencyKind"] as string,
      specifier: candidate["specifier"] as string,
      currentVersion: candidate["currentVersion"] as string,
      targetVersion: candidate["targetVersion"] as string,
    },
    runtime: {
      identity: runtimeIdentity,
      disposition: runtime["disposition"] as AcceptanceDependencyRuntimeEvidence["disposition"],
      version: runtime["version"] as string | null,
      evidenceSha256: (runtime["evidenceSha256"] as string).toLowerCase(),
    },
    packageManager: {
      disposition: packageManager["disposition"] as AcceptanceDependencyPackageManagerEvidence["disposition"],
      name: packageManager["name"] as string,
      version: packageManager["version"] as string | null,
      profile: packageManager["profile"] as string,
      updateArgv: [...packageManager["updateArgv"] as string[]],
      evidenceSha256: (packageManager["evidenceSha256"] as string).toLowerCase(),
    },
    manifest: {
      path: manifest["path"] as string,
      blobSha: (manifest["blobSha"] as string).toLowerCase(),
    },
    lockfile: {
      disposition: lockfile["disposition"] as AcceptanceDependencyLockfileEvidence["disposition"],
      path: lockfile["path"] as string,
      blobSha: lockfile["blobSha"] === null
        ? null : (lockfile["blobSha"] as string).toLowerCase(),
      evidenceSha256: (lockfile["evidenceSha256"] as string).toLowerCase(),
    },
    baseline: { headSha: (baseline["headSha"] as string).toLowerCase() },
    security: {
      identity: securityIdentity,
      disposition: security["disposition"] as AcceptanceDependencySecurityEvidence["disposition"],
      provider: security["provider"] as string,
      reference: security["reference"] as string,
      reportSha256: (security["reportSha256"] as string).toLowerCase(),
    },
  };
}

function acceptanceDependencyCandidateFingerprint(
  candidate: AcceptanceDependencyCandidate,
  manifestPath: string,
): string {
  return `sha256:${acceptanceContextPackCanonicalSha256({
    identity: candidate.identity,
    manifestPath,
    package: candidate.package,
    dependencyKind: candidate.dependencyKind,
    specifier: candidate.specifier,
    currentVersion: candidate.currentVersion,
    targetVersion: candidate.targetVersion,
  })}`;
}

function legacyAcceptanceDependencyCandidateFingerprint(
  candidate: AcceptanceDependencyCandidate,
  manifestPath: string,
): string {
  return `sha256:${acceptanceContextPackCanonicalSha256({
    ecosystem: "node",
    manifestPath,
    package: candidate.package,
    dependencyKind: candidate.dependencyKind,
    specifier: candidate.specifier,
    currentVersion: candidate.currentVersion,
    targetVersion: candidate.targetVersion,
  })}`;
}

function acceptanceDependencyObservationEventKey(
  headCycleId: string,
  candidateFingerprint: string
): string {
  return `acceptance-dependency-observation:v${ACCEPTANCE_DEPENDENCY_OBSERVATION_VERSION}:${headCycleId}:${candidateFingerprint.slice("sha256:".length)}`;
}

function legacyAcceptanceDependencyObservationEventKey(
  headCycleId: string,
  candidateFingerprint: string,
): string {
  return `acceptance-dependency-observation:${headCycleId}:${candidateFingerprint.slice("sha256:".length)}`;
}

function compiledPackDependencyTreeMetadataMatches(pack: ParsedCompiledPack): boolean {
  const expected = (pack.manifest["sources"] as Record<string, unknown>[])
    .filter((source) => isExactPackSource(source) && source["kind"] === "exact_head_dependency")
    .map((source) => `${source["path"]}\u0000${source["blobSha"]}`)
    .sort(compareUtf8Text);
  const actual = pack.exactHeadDependencyTreeProofs
    .map((proof) => `${proof.path}\u0000${proof.blobSha}`)
    .sort(compareUtf8Text);
  return isDeepStrictEqual(actual, expected);
}

function compiledPackExactSourceMatches(
  pack: ParsedCompiledPack,
  source: { path: string; blobSha: string }
): boolean {
  const matched = (pack.manifest["sources"] as Record<string, unknown>[]).find((candidate) =>
    isExactPackSource(candidate)
    && candidate["path"] === source.path
    && candidate["blobSha"] === source.blobSha
  );
  if (!matched) return false;
  return matched["kind"] === "exact_head_overlay"
    || pack.exactHeadDependencyTreeProofs.some((proof) =>
      proof.path === source.path && proof.blobSha === source.blobSha
    );
}

function compiledPackExactPathExists(pack: ParsedCompiledPack, path: string): boolean {
  return (pack.manifest["sources"] as Record<string, unknown>[]).some((source) =>
    isExactPackSource(source) && source["path"] === path
  ) || (pack.sourceCustodyReceipt["directReadReceipts"] as Record<string, unknown>[]).some((read) =>
    read["requestedPath"] === path && read["outcome"] === "record"
  );
}

function compiledPackLockfilePathCustodyMatches(
  pack: ParsedCompiledPack,
  lockfile: AcceptanceDependencyLockfileEvidence,
): boolean {
  if (lockfile.disposition === "present") {
    return lockfile.blobSha !== null && compiledPackExactSourceMatches(pack, {
      path: lockfile.path,
      blobSha: lockfile.blobSha,
    });
  }
  if (lockfile.disposition === "uncommitted") {
    return compiledPackExactPathExists(pack, lockfile.path);
  }
  const read = (pack.sourceCustodyReceipt["directReadReceipts"] as Record<string, unknown>[])
    .find((candidate) => candidate["requestedPath"] === lockfile.path
      && candidate["outcome"] === "not_proven");
  if (!read) return false;
  return lockfile.disposition === "missing"
    ? read["reason"] === "path_not_found"
    : true;
}

type AcceptanceDependencyYarnConfigurationCustody =
  | "absent"
  | "present"
  | "not_proven";

function compiledPackYarnConfigurationCustody(
  pack: ParsedCompiledPack,
): AcceptanceDependencyYarnConfigurationCustody {
  const requestedPath = ".yarnrc.yml";
  const exactOverlayRecord = (pack.sourceCustodyReceipt["records"] as Record<string, unknown>[])
    .find((candidate) => candidate["path"] === requestedPath
      && candidate["source"] === "exact_head_overlay"
      && candidate["reason"] === "exact_base_to_head_compare");
  if (exactOverlayRecord) return "present";
  const read = (pack.sourceCustodyReceipt["directReadReceipts"] as Record<string, unknown>[])
    .find((candidate) => candidate["requestedPath"] === requestedPath);
  if (!read) return "not_proven";
  if (read["outcome"] === "record") {
    return isRecord(read["record"])
      && read["record"]["path"] === requestedPath
      ? "present"
      : "not_proven";
  }
  if (read["outcome"] !== "not_proven") return "not_proven";
  if (read["reason"] === "path_not_found") return "absent";
  if (read["reason"] === "unsafe_content" && isRecord(read["exclusion"])
    && read["exclusion"]["path"] === requestedPath
    && read["exclusion"]["source"] === "exact_head_tree_fallback"
    && read["exclusion"]["reason"] === "secret_content_policy"
    && typeof read["exclusion"]["blobSha"] === "string"
    && isSha1(read["exclusion"]["blobSha"])) {
    return "present";
  }
  return "not_proven";
}

function acceptanceDependencyObservationDisposition(input: {
  evidence: RecordAcceptanceDependencyObservationInput;
  currentHeadSha: string;
  manifestSourceProven: boolean;
  lockfileSourceProven: boolean;
  yarnConfigurationCustody?: AcceptanceDependencyYarnConfigurationCustody;
  freezeUnsupportedProfile?: boolean;
}): {
  status: AcceptanceDependencyObservationStatus;
  reasons: AcceptanceDependencyObservationReason[];
} {
  const { evidence } = input;
  const reasons: AcceptanceDependencyObservationReason[] = [];
  const add = (reason: AcceptanceDependencyObservationReason) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  const profile = input.freezeUnsupportedProfile
    ? null
    : acceptanceDependencyObservationProfile(evidence.candidate.identity);
  const supportedProfile = profile !== null
    && sameAcceptanceDependencyProfile(evidence.runtime.identity, evidence.candidate.identity)
    && sameAcceptanceDependencyProfile(evidence.security.identity, evidence.candidate.identity);
  if (!supportedProfile) add("unsupported_manager_profile");

  if (evidence.baseline.headSha !== input.currentHeadSha) add("baseline_head_mismatch");
  if (!input.manifestSourceProven) add("manifest_source_not_proven");
  if (!input.lockfileSourceProven) {
    add("lockfile_source_not_proven");
  }

  if (evidence.runtime.disposition === "unsafe") add("unsafe_runtime");
  if (evidence.runtime.disposition === "unavailable") add("runtime_evidence_unavailable");
  if (evidence.runtime.disposition === "ambiguous") add("runtime_evidence_ambiguous");

  if (evidence.packageManager.disposition === "unsafe") add("unsafe_package_manager");
  if (evidence.packageManager.disposition === "unavailable") {
    add("package_manager_evidence_unavailable");
  }
  if (evidence.packageManager.disposition === "ambiguous") {
    add("package_manager_evidence_ambiguous");
  }
  if (supportedProfile && evidence.packageManager.disposition === "safe") {
    if (evidence.packageManager.name !== profile.identity.manager) add("unsafe_package_manager");
    if (evidence.packageManager.profile !== profile.identity.profile) {
      add("unsafe_package_manager_profile");
    }
    if (!isDeepStrictEqual(evidence.packageManager.updateArgv, profile.expectedArgv(evidence.candidate))) {
      add("unsafe_package_manager_argv");
    }
  }
  if (supportedProfile && (
    evidence.packageManager.name !== profile.identity.manager
    || evidence.packageManager.profile !== profile.identity.profile
    || (evidence.packageManager.disposition === "safe"
      && (!evidence.packageManager.version
        || !profile.packageManagerVersionIsValid(evidence.packageManager.version)))
    || (evidence.runtime.disposition === "safe" && (!evidence.runtime.version || !profile.runtimeVersionIsValid(evidence.runtime.version)))
    || !profile.manifestPathIsValid(evidence.manifest.path)
    || !profile.lockfilePathIsValid(evidence.lockfile.path)
    || !profile.securityIsValid(evidence.security, evidence.candidate)
  )) add("unsafe_package_manager_profile");

  if (supportedProfile
    && sameAcceptanceDependencyProfile(profile.identity, ACCEPTANCE_DEPENDENCY_YARN_IDENTITY)) {
    if (input.yarnConfigurationCustody === "present") {
      add("unsafe_yarn_configuration_present");
    } else if (input.yarnConfigurationCustody !== "absent") {
      add("yarn_configuration_absence_not_proven");
    }
  }

  if (evidence.lockfile.disposition === "missing") add("lockfile_missing");
  if (evidence.lockfile.disposition === "uncommitted") add("lockfile_uncommitted");
  if (evidence.lockfile.disposition === "unavailable") add("lockfile_evidence_unavailable");
  if (evidence.lockfile.disposition === "ambiguous") add("lockfile_evidence_ambiguous");

  if (evidence.security.disposition === "affected") add("security_affected");
  if (evidence.security.disposition === "unavailable") add("security_evidence_unavailable");
  if (evidence.security.disposition === "ambiguous") add("security_evidence_ambiguous");

  if (reasons.includes("baseline_head_mismatch")) {
    return { status: "refused_baseline", reasons };
  }
  if (reasons.includes("unsupported_manager_profile")) {
    return { status: "refused_unsupported_profile", reasons };
  }
  if (reasons.includes("manifest_source_not_proven")
    || reasons.includes("lockfile_source_not_proven")
    || reasons.includes("yarn_configuration_absence_not_proven")) {
    return { status: "not_proven", reasons };
  }
  if (reasons.some((reason) => reason === "unsafe_runtime"
    || reason === "unsafe_package_manager"
    || reason === "unsafe_package_manager_profile"
    || reason === "unsafe_package_manager_argv"
    || reason === "unsafe_yarn_configuration_present")) {
    return { status: "refused_unsafe_runtime", reasons };
  }
  if (evidence.lockfile.disposition !== "present") {
    return { status: "refused_lockfile", reasons };
  }
  if (evidence.security.disposition !== "clear") {
    return { status: "refused_security", reasons };
  }
  if (evidence.runtime.disposition !== "safe"
    || evidence.packageManager.disposition !== "safe") {
    return { status: "not_proven", reasons };
  }
  return { status: "observed", reasons };
}

function acceptanceDependencyObservationPayload(input: {
  binding: AcceptanceDependencyObservationBinding;
  evidence: RecordAcceptanceDependencyObservationInput;
  candidateFingerprint: string;
  status: AcceptanceDependencyObservationStatus;
  reasons: AcceptanceDependencyObservationReason[];
}): Record<string, unknown> {
  return {
    kind: ACCEPTANCE_DEPENDENCY_OBSERVATION_KIND,
    version: ACCEPTANCE_DEPENDENCY_OBSERVATION_VERSION,
    binding: input.binding,
    candidateFingerprint: input.candidateFingerprint,
    candidate: input.evidence.candidate,
    runtime: input.evidence.runtime,
    packageManager: input.evidence.packageManager,
    manifest: input.evidence.manifest,
    lockfile: input.evidence.lockfile,
    baseline: input.evidence.baseline,
    security: input.evidence.security,
    status: input.status,
    reasons: input.reasons,
  };
}

function legacyAcceptanceDependencyObservationPayload(input: {
  binding: AcceptanceDependencyObservationBinding;
  evidence: RecordAcceptanceDependencyObservationInput;
  candidateFingerprint: string;
  status: AcceptanceDependencyObservationStatus;
  reasons: AcceptanceDependencyObservationReason[];
}): Record<string, unknown> {
  const { identity: _candidateIdentity, ...candidate } = input.evidence.candidate;
  const { identity: _runtimeIdentity, version, ...runtime } = input.evidence.runtime;
  const { identity: _securityIdentity, ...security } = input.evidence.security;
  return {
    kind: ACCEPTANCE_DEPENDENCY_OBSERVATION_KIND,
    version: ACCEPTANCE_DEPENDENCY_OBSERVATION_LEGACY_VERSION,
    binding: input.binding,
    candidateFingerprint: input.candidateFingerprint,
    candidate,
    runtime: { ...runtime, nodeVersion: version },
    packageManager: input.evidence.packageManager,
    manifest: input.evidence.manifest,
    lockfile: input.evidence.lockfile,
    baseline: input.evidence.baseline,
    security,
    status: input.status,
    reasons: input.reasons.map((reason) => reason === "unsafe_runtime" ? "unsafe_node_runtime" : reason),
  };
}

function acceptanceDependencyObservationFromEvent(input: {
  event: ChangeRecordEventRow;
  eventKey: string;
  payload: Record<string, unknown>;
  evidence: RecordAcceptanceDependencyObservationInput;
  candidateFingerprint: string;
  status: AcceptanceDependencyObservationStatus;
  reasons: AcceptanceDependencyObservationReason[];
}): AcceptanceDependencyObservation | null {
  const { event } = input;
  if (event.id !== changeRecordEventId({ recordId: input.evidence.recordId, eventKey: input.eventKey })
    || event.recordId !== input.evidence.recordId || event.eventKey !== input.eventKey
    || event.stage !== ACCEPTANCE_DEPENDENCY_OBSERVATION_STAGE
    || event.actor !== ACCEPTANCE_DEPENDENCY_OBSERVATION_ACTOR
    || !isDeepStrictEqual(event.payloadRef, input.payload)
    || !(event.at instanceof Date) || Number.isNaN(event.at.valueOf())) return null;
  return {
    eventId: event.id,
    eventKey: event.eventKey,
    status: input.status,
    reasons: [...input.reasons],
    candidateFingerprint: input.candidateFingerprint,
    candidate: structuredClone(input.evidence.candidate),
    runtime: structuredClone(input.evidence.runtime),
    packageManager: structuredClone(input.evidence.packageManager),
    manifest: structuredClone(input.evidence.manifest),
    lockfile: structuredClone(input.evidence.lockfile),
    baseline: structuredClone(input.evidence.baseline),
    security: structuredClone(input.evidence.security),
    observedAt: event.at,
  };
}

/**
 * Records one immutable dependency observation for the current exact PR-head
 * occurrence. This API observes or refuses only; it never queues work,
 * approves a proposal, installs a package, creates an issue, or selects a
 * builder route.
 */
export async function recordAcceptanceDependencyObservation(
  input: RecordAcceptanceDependencyObservationInput
): Promise<RecordAcceptanceDependencyObservationResult> {
  const currentProfileParsed = parseRecordAcceptanceDependencyObservationInput(input);
  const parsed = currentProfileParsed
    ?? parseRecordAcceptanceDependencyObservationInput(input, { freezeUnsupportedProfile: true });
  if (!parsed) {
    throw new AcceptanceDependencyObservationInvalidEvidenceError();
  }
  const frozenUnsupportedReplayOnly = currentProfileParsed === null;
  if (frozenUnsupportedReplayOnly && (
    !isFrozenReplayEligibleAcceptanceDependencyProfile(parsed.candidate.identity)
    || !sameAcceptanceDependencyProfile(parsed.runtime.identity, parsed.candidate.identity)
    || !sameAcceptanceDependencyProfile(parsed.security.identity, parsed.candidate.identity)
  )) {
    throw new AcceptanceDependencyObservationInvalidEvidenceError();
  }

  const candidateRecord = (await db.select({
    repo: changeRecords.repo,
    prNumber: changeRecords.prNumber,
  }).from(changeRecords).where(and(
    eq(changeRecords.id, parsed.recordId),
    eq(changeRecords.workspaceId, parsed.workspaceId),
  )).limit(1))[0];
  if (!candidateRecord || candidateRecord.prNumber == null) {
    if (frozenUnsupportedReplayOnly) {
      throw new AcceptanceDependencyObservationInvalidEvidenceError();
    }
    return candidateRecord ? { kind: "not_current" } : { kind: "not_found" };
  }

  const lockKey = acceptanceRecordPullRequestLockKey({
    workspaceId: parsed.workspaceId,
    recordId: parsed.recordId,
    repo: candidateRecord.repo,
    prNumber: candidateRecord.prNumber,
  });
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

    const record = (await tx.select().from(changeRecords).where(and(
      eq(changeRecords.id, parsed.recordId),
      eq(changeRecords.workspaceId, parsed.workspaceId),
    )).limit(1))[0];
    if (!record) return { kind: "not_found" as const };
    if (record.repo !== candidateRecord.repo || record.prNumber !== candidateRecord.prNumber
      || record.prNumber == null || record.state !== "open" || record.mergedSha !== null
      || !record.currentPrHeadAuthoritative || !isSha1(record.currentPrHeadSha)
      || !isUuid(record.currentPrHeadCycleId)
      || !record.headShas.includes(record.currentPrHeadSha)
      || !Number.isSafeInteger(record.currentPrHeadAuthorityGeneration)
      || record.currentPrHeadAuthorityGeneration < 0) {
      return { kind: "not_current" as const };
    }

    const confirmedRows = await tx.select().from(acceptanceContracts).where(and(
      eq(acceptanceContracts.recordId, record.id),
      eq(acceptanceContracts.status, "confirmed"),
    )).orderBy(asc(acceptanceContracts.version));
    if (confirmedRows.length !== 1) {
      return { kind: "not_ready" as const, reason: "confirmed_contract_unavailable" as const };
    }
    const confirmed = confirmedRows[0]!;
    if (!isNonBlankString(confirmed.confirmedBy) || !(confirmed.confirmedAt instanceof Date)
      || Number.isNaN(confirmed.confirmedAt.valueOf())
      || !projectConfirmedAcceptanceContract(confirmed.contract)) {
      return { kind: "not_ready" as const, reason: "confirmed_contract_unavailable" as const };
    }
    let acceptanceContractSha: string;
    try {
      acceptanceContractSha = acceptanceContractSha256({
        acceptanceContractId: confirmed.id,
        acceptanceContractVersion: confirmed.version,
        contract: confirmed.contract,
      });
    } catch {
      return { kind: "not_ready" as const, reason: "confirmed_contract_unavailable" as const };
    }

    const pack = (await tx.select().from(acceptanceCompiledContextPacks).where(and(
      eq(acceptanceCompiledContextPacks.id, parsed.compiledPackId),
      eq(acceptanceCompiledContextPacks.workspaceId, parsed.workspaceId),
    )).limit(1))[0];
    if (!pack) {
      return { kind: "not_ready" as const, reason: "compiled_pack_unavailable" as const };
    }
    const sourceSnapshot = (await tx.select().from(acceptanceContextPackSnapshots).where(and(
      eq(acceptanceContextPackSnapshots.id, pack.sourceSnapshotId),
      eq(acceptanceContextPackSnapshots.workspaceId, parsed.workspaceId),
    )).limit(1))[0];
    if (!sourceSnapshot) {
      return { kind: "not_ready" as const, reason: "invalid_compiled_pack_custody" as const };
    }
    if (sourceSnapshot.recordId !== record.id || sourceSnapshot.repo !== record.repo
      || sourceSnapshot.prNumber !== record.prNumber
      || sourceSnapshot.expectedHeadSha !== record.currentPrHeadSha
      || sourceSnapshot.reviewJobId !== record.currentPrHeadCycleId) {
      return { kind: "not_current" as const };
    }
    if (sourceSnapshot.acceptanceContractId !== confirmed.id
      || sourceSnapshot.acceptanceContractVersion !== confirmed.version
      || sourceSnapshot.acceptanceContractSha256 !== acceptanceContractSha) {
      return { kind: "not_ready" as const, reason: "invalid_compiled_pack_custody" as const };
    }

    let custody: AcceptanceContextPackCustodyResolution;
    try {
      custody = await resolveAcceptanceContextPackCustodyInTransaction(tx, {
        workspaceId: parsed.workspaceId,
        sourceSnapshotId: pack.sourceSnapshotId,
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Context Pack custody ")) {
        return { kind: "not_ready" as const, reason: "invalid_compiled_pack_custody" as const };
      }
      throw error;
    }

    const reconstructed = parseCompiledAcceptanceContextPack({
      kind: "compiled_acceptance_context_pack",
      version: 1,
      binding: pack.binding,
      compiler: {
        version: pack.compilerVersion,
        policyVersion: pack.policyVersion,
        byteCounter: "utf8_byte_upper_bound_v1",
        byteBudget: COMPILED_PACK_BYTE_BUDGET,
      },
      manifest: pack.manifest,
      sourceCustodyReceipt: pack.sourceCustodyReceipt,
      exactHeadDependencyTreeProofs: pack.exactHeadDependencyTreeProofs,
      representations: {
        jsonSha256: pack.jsonSha256,
        markdownSha256: pack.markdownSha256,
      },
      renderedByteCount: pack.renderedByteCount,
      packSha256: pack.packSha256,
    });
    if (!reconstructed
      || pack.id !== acceptanceCompiledContextPackId({
        sourceSnapshotId: pack.sourceSnapshotId,
        compilerVersion: pack.compilerVersion,
        policyVersion: pack.policyVersion,
      })
      || compiledPackIdentity(reconstructed) !== pack.packSha256
      || reconstructed.sourceCustodyReceipt["identitySha256"] !== pack.sourceCustodyIdentitySha256
      || !bindingMatchesCustody(reconstructed.binding, custody)
      || !receiptMatchesCustody(reconstructed.sourceCustodyReceipt, custody)
      || !manifestMatchesCustody(reconstructed, custody)
      || !compiledPackDependencyTreeMetadataMatches(reconstructed)
      || custody.acceptanceContractSha256 !== acceptanceContractSha) {
      return { kind: "not_ready" as const, reason: "invalid_compiled_pack_custody" as const };
    }

    const manifestSourceProven = compiledPackExactSourceMatches(reconstructed, parsed.manifest);
    const lockfileSourceProven = compiledPackLockfilePathCustodyMatches(
      reconstructed,
      parsed.lockfile,
    );
    const disposition = acceptanceDependencyObservationDisposition({
      evidence: parsed,
      currentHeadSha: record.currentPrHeadSha,
      manifestSourceProven,
      lockfileSourceProven,
      yarnConfigurationCustody: compiledPackYarnConfigurationCustody(reconstructed),
      freezeUnsupportedProfile: frozenUnsupportedReplayOnly,
    });
    const candidateFingerprint = acceptanceDependencyCandidateFingerprint(
      parsed.candidate,
      parsed.manifest.path,
    );
    const binding: AcceptanceDependencyObservationBinding = {
      workspaceId: record.workspaceId,
      recordId: record.id,
      repo: record.repo,
      prNumber: record.prNumber,
      headSha: record.currentPrHeadSha,
      headCycleId: record.currentPrHeadCycleId,
      authorityGeneration: record.currentPrHeadAuthorityGeneration,
      reviewJobId: sourceSnapshot.reviewJobId,
      acceptanceContract: {
        id: confirmed.id,
        version: confirmed.version,
        sha256: acceptanceContractSha,
      },
      compiledPack: {
        id: pack.id,
        sha256: pack.packSha256,
        sourceSnapshotId: pack.sourceSnapshotId,
        sourceCustodyIdentitySha256: pack.sourceCustodyIdentitySha256,
        compilerVersion: pack.compilerVersion,
        policyVersion: pack.policyVersion,
        exactHeadDependencyTreeProofsSha256: acceptanceContextPackCanonicalSha256({
          kind: "acceptance_dependency_tree_proof_set",
          version: 1,
          proofs: pack.exactHeadDependencyTreeProofs,
        }),
      },
    };
    const eventKey = acceptanceDependencyObservationEventKey(
      record.currentPrHeadCycleId,
      candidateFingerprint,
    );
    const payload = acceptanceDependencyObservationPayload({
      binding,
      evidence: parsed,
      candidateFingerprint,
      status: disposition.status,
      reasons: disposition.reasons,
    });

    const legacyCompatible = sameAcceptanceDependencyProfile(
      parsed.candidate.identity,
      ACCEPTANCE_DEPENDENCY_PNPM_IDENTITY,
    ) && sameAcceptanceDependencyProfile(parsed.runtime.identity, ACCEPTANCE_DEPENDENCY_PNPM_IDENTITY)
      && sameAcceptanceDependencyProfile(parsed.security.identity, ACCEPTANCE_DEPENDENCY_PNPM_IDENTITY);
    const legacyCandidateFingerprint = legacyCompatible
      ? legacyAcceptanceDependencyCandidateFingerprint(parsed.candidate, parsed.manifest.path)
      : null;
    const legacyEventKey = legacyCandidateFingerprint
      ? legacyAcceptanceDependencyObservationEventKey(record.currentPrHeadCycleId, legacyCandidateFingerprint)
      : null;
    const legacyPayload = legacyCandidateFingerprint ? legacyAcceptanceDependencyObservationPayload({
      binding,
      evidence: parsed,
      candidateFingerprint: legacyCandidateFingerprint,
      status: disposition.status,
      reasons: disposition.reasons,
    }) : null;

    const existing = (await tx.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, record.id),
      eq(changeRecordEvents.eventKey, eventKey),
    )).limit(1))[0] as ChangeRecordEventRow | undefined;
    const legacyExisting = legacyEventKey ? (await tx.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, record.id),
      eq(changeRecordEvents.eventKey, legacyEventKey),
    )).limit(1))[0] as ChangeRecordEventRow | undefined : undefined;
    if (existing && legacyExisting) throw new AcceptanceDependencyObservationConflictError();
    if (existing) {
      const stored = parseStoredAcceptanceDependencyObservationEvent(existing);
      const frozenDisposition = stored && acceptanceDependencyObservationDisposition({
        evidence: stored.evidence,
        currentHeadSha: record.currentPrHeadSha,
        manifestSourceProven,
        lockfileSourceProven,
        yarnConfigurationCustody: compiledPackYarnConfigurationCustody(reconstructed),
        freezeUnsupportedProfile: stored.observation.reasons.includes(
          "unsupported_manager_profile",
        ),
      });
      if (!stored || stored.payloadVersion !== ACCEPTANCE_DEPENDENCY_OBSERVATION_VERSION
        || !isDeepStrictEqual(stored.binding, binding)
        || !isDeepStrictEqual(stored.evidence, parsed)
        || !frozenDisposition
        || frozenDisposition.status !== stored.observation.status
        || !isDeepStrictEqual(frozenDisposition.reasons, stored.observation.reasons)) {
        throw new AcceptanceDependencyObservationConflictError();
      }
      return { kind: "replayed" as const, binding, observation: stored.observation };
    }
    if (frozenUnsupportedReplayOnly) {
      throw new AcceptanceDependencyObservationInvalidEvidenceError();
    }
    if (legacyExisting && legacyEventKey && legacyPayload && legacyCandidateFingerprint) {
      const observation = acceptanceDependencyObservationFromEvent({
        event: legacyExisting,
        eventKey: legacyEventKey,
        payload: legacyPayload,
        evidence: parsed,
        candidateFingerprint: legacyCandidateFingerprint,
        status: disposition.status,
        reasons: disposition.reasons,
      });
      if (!observation) throw new AcceptanceDependencyObservationConflictError();
      return { kind: "replayed" as const, binding, observation };
    }

    let appended: AppendChangeRecordEventsAtomicallyResult;
    try {
      appended = await appendChangeRecordEventsAtomicallyInTransaction(tx, [{
        recordId: record.id,
        eventKey,
        stage: ACCEPTANCE_DEPENDENCY_OBSERVATION_STAGE,
        actor: ACCEPTANCE_DEPENDENCY_OBSERVATION_ACTOR,
        payloadRef: payload,
      }]);
    } catch (error) {
      if (error instanceof Error
        && error.message.startsWith("appendChangeRecordEventsAtomically: event key is already bound")) {
        throw new AcceptanceDependencyObservationConflictError();
      }
      throw error;
    }
    const event = appended.events[0]?.event;
    const observation = event && acceptanceDependencyObservationFromEvent({
      event,
      eventKey,
      payload,
      evidence: parsed,
      candidateFingerprint,
      status: disposition.status,
      reasons: disposition.reasons,
    });
    if (!observation) throw new AcceptanceDependencyObservationConflictError();
    return { kind: "recorded" as const, binding, observation };
  });
}

export type AcceptanceDependencyApprovalRole = "owner" | "admin";

export type AcceptanceDependencyApproval = {
  eventId: string;
  eventKey: string;
  observationEventId: string;
  candidateFingerprint: string;
  approvedBy: string;
  approvedRole: AcceptanceDependencyApprovalRole;
  approvedAt: Date;
};

export type AcceptanceDependencyExternalBuilderRoute = {
  selectionEventId: string;
  id: string;
  adapter: GithubNativeAcceptanceBuilderRouteAdapter;
  configurationVersion: number;
  snapshot: AcceptanceBuilderRouteSnapshot;
  snapshotSha256: string;
};

export type AcceptanceDependencyExternalBuilderPack = {
  packId: string;
  eventId: string;
  eventKey: string;
  observationEventId: string;
  approvalEventId: string;
  candidateFingerprint: string;
  binding: AcceptanceDependencyObservationBinding;
  candidate: AcceptanceDependencyCandidate;
  runtime: AcceptanceDependencyRuntimeEvidence;
  packageManager: AcceptanceDependencyPackageManagerEvidence;
  manifest: AcceptanceDependencyManifestEvidence;
  lockfile: AcceptanceDependencyLockfileEvidence;
  baseline: AcceptanceDependencyBaselineEvidence;
  security: AcceptanceDependencySecurityEvidence;
  route: AcceptanceDependencyExternalBuilderRoute;
  deliveryAuthority: "not_granted";
  scopeBoundary: "dependency_external_builder_pack_only";
  reviewRequirement: "exact_head_r7_reentry";
  mintedAt: Date;
};

export type CurrentAcceptanceDependencyObservationsBinding = {
  workspaceId: string;
  recordId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  headCycleId: string;
  authorityGeneration: number;
  acceptanceContract: { id: string; version: number; sha256: string };
};

export type CurrentAcceptanceDependencyObservationItem = {
  payloadVersion: 1 | 2;
  binding: AcceptanceDependencyObservationBinding;
  observation: AcceptanceDependencyObservation;
  approval: AcceptanceDependencyApproval | null;
  externalBuilderPack: AcceptanceDependencyExternalBuilderPack | null;
};

export type AcceptanceDependencyExternalBuilderNotReadyReason =
  | "confirmed_contract_unavailable"
  | "compiled_pack_unavailable"
  | "invalid_observation_custody"
  | "invalid_compiled_pack_custody"
  | "selected_route_unavailable"
  | "selected_route_not_external_builder"
  | "invalid_approval_pack_custody";

export type ReadCurrentAcceptanceDependencyObservationsInput = {
  workspaceId: string;
  recordId: string;
};

export type ReadCurrentAcceptanceDependencyObservationsResult =
  | {
      kind: "current";
      binding: CurrentAcceptanceDependencyObservationsBinding;
      observations: CurrentAcceptanceDependencyObservationItem[];
    }
  | { kind: "not_found" | "not_current" }
  | { kind: "not_ready"; reason: AcceptanceDependencyExternalBuilderNotReadyReason };

export type ApproveAcceptanceDependencyObservationAndMintExternalBuilderPackInput = {
  workspaceId: string;
  recordId: string;
  observationEventId: string;
  approvedBy: string;
};

export type ApproveAcceptanceDependencyObservationAndMintExternalBuilderPackResult =
  | {
      kind: "approved" | "replayed";
      binding: AcceptanceDependencyObservationBinding;
      observation: AcceptanceDependencyObservation;
      approval: AcceptanceDependencyApproval;
      externalBuilderPack: AcceptanceDependencyExternalBuilderPack;
    }
  | { kind: "not_found" | "not_current" | "not_authorized" | "observation_not_found" }
  | { kind: "observation_not_eligible"; reason: "observation_not_observed" }
  | { kind: "not_ready"; reason: AcceptanceDependencyExternalBuilderNotReadyReason };

export class AcceptanceDependencyExternalBuilderPackConflictError extends Error {
  readonly code = "ACCEPTANCE_DEPENDENCY_EXTERNAL_BUILDER_PACK_CONFLICT" as const;

  constructor() {
    super("The dependency observation approval and external Builder Pack custody conflicts");
    this.name = "AcceptanceDependencyExternalBuilderPackConflictError";
  }
}

const ACCEPTANCE_DEPENDENCY_APPROVAL_KIND = "acceptance_dependency_approval";
const ACCEPTANCE_DEPENDENCY_APPROVAL_VERSION = 1;
const ACCEPTANCE_DEPENDENCY_APPROVAL_STAGE = "human_dependency_approval";
const ACCEPTANCE_DEPENDENCY_EXTERNAL_BUILDER_PACK_KIND =
  "acceptance_dependency_external_builder_pack";
const ACCEPTANCE_DEPENDENCY_EXTERNAL_BUILDER_PACK_LEGACY_VERSION = 1;
const ACCEPTANCE_DEPENDENCY_EXTERNAL_BUILDER_PACK_VERSION = 2;
const ACCEPTANCE_DEPENDENCY_EXTERNAL_BUILDER_PACK_STAGE = "external_builder_pack";
const ACCEPTANCE_DEPENDENCY_EXTERNAL_BUILDER_PACK_ACTOR =
  "server:dependency-external-builder-pack";
const ACCEPTANCE_DEPENDENCY_OBSERVATION_READ_LIMIT = 100;

type CurrentAcceptanceDependencyContext = {
  record: ChangeRecordRow;
  contract: AcceptanceContractRow;
  binding: CurrentAcceptanceDependencyObservationsBinding;
};

type StoredAcceptanceDependencyObservation = {
  event: ChangeRecordEventRow;
  payloadVersion: 1 | 2;
  binding: AcceptanceDependencyObservationBinding;
  evidence: RecordAcceptanceDependencyObservationInput;
  observation: AcceptanceDependencyObservation;
  identitySha256: string;
};

function isAcceptanceDependencyObservationStatus(
  value: unknown,
): value is AcceptanceDependencyObservationStatus {
  return value === "observed" || value === "refused_unsafe_runtime"
    || value === "refused_unsupported_profile"
    || value === "refused_lockfile" || value === "refused_baseline"
    || value === "refused_security" || value === "not_proven";
}

function isAcceptanceDependencyObservationReason(
  value: unknown,
): value is AcceptanceDependencyObservationReason {
  return value === "unsupported_manager_profile" || value === "baseline_head_mismatch"
    || value === "manifest_source_not_proven"
    || value === "lockfile_source_not_proven" || value === "unsafe_runtime"
    || value === "unsafe_package_manager" || value === "unsafe_package_manager_profile"
    || value === "unsafe_package_manager_argv"
    || value === "unsafe_yarn_configuration_present"
    || value === "yarn_configuration_absence_not_proven"
    || value === "runtime_evidence_unavailable"
    || value === "runtime_evidence_ambiguous"
    || value === "package_manager_evidence_unavailable"
    || value === "package_manager_evidence_ambiguous" || value === "lockfile_missing"
    || value === "lockfile_uncommitted" || value === "lockfile_evidence_unavailable"
    || value === "lockfile_evidence_ambiguous" || value === "security_affected"
    || value === "security_evidence_unavailable" || value === "security_evidence_ambiguous";
}

function normalizeLegacyAcceptanceDependencyObservationReason(
  value: unknown,
): AcceptanceDependencyObservationReason | null {
  if (value === "unsafe_node_runtime") return "unsafe_runtime";
  if (value === "unsupported_manager_profile" || value === "unsafe_runtime") return null;
  return isAcceptanceDependencyObservationReason(value) ? value : null;
}

function parseAcceptanceDependencyObservationBinding(
  value: unknown,
): AcceptanceDependencyObservationBinding | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "workspaceId", "recordId", "repo", "prNumber", "headSha", "headCycleId",
    "authorityGeneration", "reviewJobId", "acceptanceContract", "compiledPack",
  ]) || !isUuid(value["workspaceId"]) || value["workspaceId"] !== value["workspaceId"].toLowerCase()
    || !isUuid(value["recordId"]) || value["recordId"] !== value["recordId"].toLowerCase()
    || !safeRepo(value["repo"]) || !Number.isSafeInteger(value["prNumber"])
    || (value["prNumber"] as number) <= 0 || !isSha1(value["headSha"])
    || value["headSha"] !== value["headSha"].toLowerCase()
    || !isUuid(value["headCycleId"]) || value["headCycleId"] !== value["headCycleId"].toLowerCase()
    || !Number.isSafeInteger(value["authorityGeneration"])
    || (value["authorityGeneration"] as number) < 0
    || !isUuid(value["reviewJobId"]) || value["reviewJobId"] !== value["reviewJobId"].toLowerCase()
    || !isRecord(value["acceptanceContract"]) || !hasExactKeys(
      value["acceptanceContract"], ["id", "version", "sha256"],
    ) || !isUuid(value["acceptanceContract"]["id"])
    || value["acceptanceContract"]["id"] !== value["acceptanceContract"]["id"].toLowerCase()
    || !Number.isSafeInteger(value["acceptanceContract"]["version"])
    || (value["acceptanceContract"]["version"] as number) <= 0
    || typeof value["acceptanceContract"]["sha256"] !== "string"
    || !LOWER_SHA256.test(value["acceptanceContract"]["sha256"])
    || !isRecord(value["compiledPack"]) || !hasExactKeys(value["compiledPack"], [
      "id", "sha256", "sourceSnapshotId", "sourceCustodyIdentitySha256",
      "compilerVersion", "policyVersion", "exactHeadDependencyTreeProofsSha256",
    ]) || !isUuid(value["compiledPack"]["id"])
    || value["compiledPack"]["id"] !== value["compiledPack"]["id"].toLowerCase()
    || typeof value["compiledPack"]["sha256"] !== "string"
    || !LOWER_SHA256.test(value["compiledPack"]["sha256"])
    || !isUuid(value["compiledPack"]["sourceSnapshotId"])
    || value["compiledPack"]["sourceSnapshotId"]
      !== value["compiledPack"]["sourceSnapshotId"].toLowerCase()
    || typeof value["compiledPack"]["sourceCustodyIdentitySha256"] !== "string"
    || !LOWER_SHA256.test(value["compiledPack"]["sourceCustodyIdentitySha256"])
    || !safeSnapshotText(value["compiledPack"]["compilerVersion"], 128)
    || !safeSnapshotText(value["compiledPack"]["policyVersion"], 128)
    || typeof value["compiledPack"]["exactHeadDependencyTreeProofsSha256"] !== "string"
    || !LOWER_SHA256.test(value["compiledPack"]["exactHeadDependencyTreeProofsSha256"])) {
    return null;
  }
  return structuredClone(value) as AcceptanceDependencyObservationBinding;
}

function storedAcceptanceDependencyObservationIdentitySha256(
  event: ChangeRecordEventRow,
): string {
  return acceptanceContextPackCanonicalSha256({
    kind: "acceptance_dependency_observation_event_identity",
    version: 1,
    eventId: event.id,
    eventKey: event.eventKey,
    stage: event.stage,
    actor: event.actor,
    payloadRef: event.payloadRef,
  });
}

function parseStoredAcceptanceDependencyObservationEvent(
  event: ChangeRecordEventRow,
): StoredAcceptanceDependencyObservation | null {
  const payload = event.payloadRef;
  if (!isRecord(payload) || !hasExactKeys(payload, [
    "kind", "version", "binding", "candidateFingerprint", "candidate", "runtime",
    "packageManager", "manifest", "lockfile", "baseline", "security", "status", "reasons",
  ]) || payload["kind"] !== ACCEPTANCE_DEPENDENCY_OBSERVATION_KIND
    || (payload["version"] !== ACCEPTANCE_DEPENDENCY_OBSERVATION_LEGACY_VERSION
      && payload["version"] !== ACCEPTANCE_DEPENDENCY_OBSERVATION_VERSION)
    || !isAcceptanceDependencyObservationStatus(payload["status"])
    || (payload["version"] === ACCEPTANCE_DEPENDENCY_OBSERVATION_LEGACY_VERSION
      && payload["status"] === "refused_unsupported_profile")
    || !Array.isArray(payload["reasons"]) || payload["reasons"].length > 21
    || new Set(payload["reasons"]).size !== payload["reasons"].length) return null;
  const binding = parseAcceptanceDependencyObservationBinding(payload["binding"]);
  if (!binding || typeof payload["candidateFingerprint"] !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(payload["candidateFingerprint"])) return null;

  const payloadVersion = payload["version"] as 1 | 2;
  let candidate: unknown = payload["candidate"];
  let runtime: unknown = payload["runtime"];
  let security: unknown = payload["security"];
  let reasons: AcceptanceDependencyObservationReason[];
  if (payloadVersion === ACCEPTANCE_DEPENDENCY_OBSERVATION_LEGACY_VERSION) {
    if (!isRecord(candidate) || !hasExactKeys(candidate, [
      "package", "dependencyKind", "specifier", "currentVersion", "targetVersion",
    ]) || !isRecord(runtime) || !hasExactKeys(runtime, [
      "disposition", "nodeVersion", "evidenceSha256",
    ]) || !isRecord(security) || !hasExactKeys(security, [
      "disposition", "provider", "reference", "reportSha256",
    ])) return null;
    const normalizedReasons = payload["reasons"].map(
      normalizeLegacyAcceptanceDependencyObservationReason,
    );
    if (normalizedReasons.some((reason) => reason === null)) return null;
    reasons = normalizedReasons as AcceptanceDependencyObservationReason[];
    candidate = { identity: ACCEPTANCE_DEPENDENCY_PNPM_IDENTITY, ...candidate };
    runtime = {
      identity: ACCEPTANCE_DEPENDENCY_PNPM_IDENTITY,
      disposition: runtime["disposition"],
      version: runtime["nodeVersion"],
      evidenceSha256: runtime["evidenceSha256"],
    };
    security = { identity: ACCEPTANCE_DEPENDENCY_PNPM_IDENTITY, ...security };
  } else {
    if (!payload["reasons"].every(isAcceptanceDependencyObservationReason)) return null;
    reasons = payload["reasons"] as AcceptanceDependencyObservationReason[];
  }

  const freezeUnsupportedProfile = reasons.includes("unsupported_manager_profile");
  const evidence = parseRecordAcceptanceDependencyObservationInput({
    workspaceId: binding.workspaceId,
    recordId: binding.recordId,
    compiledPackId: binding.compiledPack.id,
    candidate,
    runtime,
    packageManager: payload["packageManager"],
    manifest: payload["manifest"],
    lockfile: payload["lockfile"],
    baseline: payload["baseline"],
    security,
  }, { freezeUnsupportedProfile });
  if (!evidence) return null;
  const candidateFingerprint = payloadVersion === ACCEPTANCE_DEPENDENCY_OBSERVATION_LEGACY_VERSION
    ? legacyAcceptanceDependencyCandidateFingerprint(evidence.candidate, evidence.manifest.path)
    : acceptanceDependencyCandidateFingerprint(evidence.candidate, evidence.manifest.path);
  if (candidateFingerprint !== payload["candidateFingerprint"]) return null;
  const eventKey = payloadVersion === ACCEPTANCE_DEPENDENCY_OBSERVATION_LEGACY_VERSION
    ? legacyAcceptanceDependencyObservationEventKey(binding.headCycleId, candidateFingerprint)
    : acceptanceDependencyObservationEventKey(binding.headCycleId, candidateFingerprint);
  const expectedPayload = payloadVersion === ACCEPTANCE_DEPENDENCY_OBSERVATION_LEGACY_VERSION
    ? legacyAcceptanceDependencyObservationPayload({
        binding,
        evidence,
        candidateFingerprint,
        status: payload["status"],
        reasons,
      })
    : acceptanceDependencyObservationPayload({
        binding,
        evidence,
        candidateFingerprint,
        status: payload["status"],
        reasons,
      });
  const observation = acceptanceDependencyObservationFromEvent({
    event,
    eventKey,
    payload: expectedPayload,
    evidence,
    candidateFingerprint,
    status: payload["status"],
    reasons,
  });
  return observation ? {
    event,
    payloadVersion,
    binding,
    evidence,
    observation,
    identitySha256: storedAcceptanceDependencyObservationIdentitySha256(event),
  } : null;
}

async function currentAcceptanceDependencyCandidate(input: {
  workspaceId: string;
  recordId: string;
}): Promise<{ repo: string; prNumber: number } | null | "not_current"> {
  const candidate = (await db.select({
    repo: changeRecords.repo,
    prNumber: changeRecords.prNumber,
  }).from(changeRecords).where(and(
    eq(changeRecords.id, input.recordId),
    eq(changeRecords.workspaceId, input.workspaceId),
  )).limit(1))[0];
  if (!candidate) return null;
  return candidate.prNumber == null
    ? "not_current"
    : { repo: candidate.repo, prNumber: candidate.prNumber };
}

async function resolveCurrentAcceptanceDependencyContextInTransaction(
  tx: DbTransaction,
  input: { workspaceId: string; recordId: string },
  candidate: { repo: string; prNumber: number },
): Promise<
  | { kind: "current"; context: CurrentAcceptanceDependencyContext }
  | { kind: "not_found" | "not_current" }
  | { kind: "not_ready"; reason: "confirmed_contract_unavailable" }
> {
  const record = (await tx.select().from(changeRecords).where(and(
    eq(changeRecords.id, input.recordId),
    eq(changeRecords.workspaceId, input.workspaceId),
  )).limit(1))[0];
  if (!record) return { kind: "not_found" };
  if (record.repo !== candidate.repo || record.prNumber !== candidate.prNumber
    || record.prNumber == null || record.state !== "open" || record.mergedSha !== null
    || !record.currentPrHeadAuthoritative || !isSha1(record.currentPrHeadSha)
    || record.currentPrHeadSha !== record.currentPrHeadSha.toLowerCase()
    || !isUuid(record.currentPrHeadCycleId)
    || !record.headShas.includes(record.currentPrHeadSha)
    || !Number.isSafeInteger(record.currentPrHeadAuthorityGeneration)
    || record.currentPrHeadAuthorityGeneration < 0) return { kind: "not_current" };
  const contracts = await tx.select().from(acceptanceContracts).where(and(
    eq(acceptanceContracts.recordId, record.id),
    eq(acceptanceContracts.status, "confirmed"),
  )).orderBy(asc(acceptanceContracts.version));
  if (contracts.length !== 1) {
    return { kind: "not_ready", reason: "confirmed_contract_unavailable" };
  }
  const contract = contracts[0]!;
  if (!isNonBlankString(contract.confirmedBy) || !(contract.confirmedAt instanceof Date)
    || Number.isNaN(contract.confirmedAt.valueOf())
    || !projectConfirmedAcceptanceContract(contract.contract)) {
    return { kind: "not_ready", reason: "confirmed_contract_unavailable" };
  }
  let contractSha256: string;
  try {
    contractSha256 = acceptanceContractSha256({
      acceptanceContractId: contract.id,
      acceptanceContractVersion: contract.version,
      contract: contract.contract,
    });
  } catch {
    return { kind: "not_ready", reason: "confirmed_contract_unavailable" };
  }
  return {
    kind: "current",
    context: {
      record,
      contract,
      binding: {
        workspaceId: record.workspaceId,
        recordId: record.id,
        repo: record.repo,
        prNumber: record.prNumber,
        headSha: record.currentPrHeadSha,
        headCycleId: record.currentPrHeadCycleId,
        authorityGeneration: record.currentPrHeadAuthorityGeneration,
        acceptanceContract: {
          id: contract.id,
          version: contract.version,
          sha256: contractSha256,
        },
      },
    },
  };
}

function observationBindingMatchesCurrentContext(input: {
  binding: AcceptanceDependencyObservationBinding;
  context: CurrentAcceptanceDependencyContext;
}): boolean {
  const { binding, context } = input;
  return binding.workspaceId === context.binding.workspaceId
    && binding.recordId === context.binding.recordId
    && binding.repo === context.binding.repo
    && binding.prNumber === context.binding.prNumber
    && binding.headSha === context.binding.headSha
    && binding.headCycleId === context.binding.headCycleId
    && binding.authorityGeneration === context.binding.authorityGeneration
    && binding.reviewJobId === context.binding.headCycleId
    && isDeepStrictEqual(binding.acceptanceContract, context.binding.acceptanceContract);
}

async function revalidateStoredAcceptanceDependencyObservationInTransaction(
  tx: DbTransaction,
  input: {
    stored: StoredAcceptanceDependencyObservation;
    context: CurrentAcceptanceDependencyContext;
  },
): Promise<
  | { kind: "valid"; stored: StoredAcceptanceDependencyObservation }
  | { kind: "not_ready"; reason: "compiled_pack_unavailable" | "invalid_compiled_pack_custody" }
> {
  const { stored, context } = input;
  const pack = (await tx.select().from(acceptanceCompiledContextPacks).where(and(
    eq(acceptanceCompiledContextPacks.id, stored.binding.compiledPack.id),
    eq(acceptanceCompiledContextPacks.workspaceId, context.binding.workspaceId),
  )).limit(1))[0];
  if (!pack) return { kind: "not_ready", reason: "compiled_pack_unavailable" };
  const proofSetSha256 = acceptanceContextPackCanonicalSha256({
    kind: "acceptance_dependency_tree_proof_set",
    version: 1,
    proofs: pack.exactHeadDependencyTreeProofs,
  });
  if (pack.id !== stored.binding.compiledPack.id
    || pack.packSha256 !== stored.binding.compiledPack.sha256
    || pack.sourceSnapshotId !== stored.binding.compiledPack.sourceSnapshotId
    || pack.sourceCustodyIdentitySha256
      !== stored.binding.compiledPack.sourceCustodyIdentitySha256
    || pack.compilerVersion !== stored.binding.compiledPack.compilerVersion
    || pack.policyVersion !== stored.binding.compiledPack.policyVersion
    || proofSetSha256 !== stored.binding.compiledPack.exactHeadDependencyTreeProofsSha256) {
    return { kind: "not_ready", reason: "invalid_compiled_pack_custody" };
  }
  let custody: AcceptanceContextPackCustodyResolution;
  try {
    custody = await resolveAcceptanceContextPackCustodyInTransaction(tx, {
      workspaceId: context.binding.workspaceId,
      sourceSnapshotId: pack.sourceSnapshotId,
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Context Pack custody ")) {
      return { kind: "not_ready", reason: "invalid_compiled_pack_custody" };
    }
    throw error;
  }
  const source = custody.sourceSnapshot;
  if (source.recordId !== context.binding.recordId || source.repo !== context.binding.repo
    || source.prNumber !== context.binding.prNumber || source.expectedHeadSha !== context.binding.headSha
    || source.reviewJobId !== context.binding.headCycleId
    || source.acceptanceContractId !== context.binding.acceptanceContract.id
    || source.acceptanceContractVersion !== context.binding.acceptanceContract.version
    || custody.acceptanceContractSha256 !== context.binding.acceptanceContract.sha256) {
    return { kind: "not_ready", reason: "invalid_compiled_pack_custody" };
  }
  const reconstructed = parseCompiledAcceptanceContextPack({
    kind: "compiled_acceptance_context_pack",
    version: 1,
    binding: pack.binding,
    compiler: {
      version: pack.compilerVersion,
      policyVersion: pack.policyVersion,
      byteCounter: "utf8_byte_upper_bound_v1",
      byteBudget: COMPILED_PACK_BYTE_BUDGET,
    },
    manifest: pack.manifest,
    sourceCustodyReceipt: pack.sourceCustodyReceipt,
    exactHeadDependencyTreeProofs: pack.exactHeadDependencyTreeProofs,
    representations: { jsonSha256: pack.jsonSha256, markdownSha256: pack.markdownSha256 },
    renderedByteCount: pack.renderedByteCount,
    packSha256: pack.packSha256,
  });
  if (!reconstructed || pack.id !== acceptanceCompiledContextPackId({
    sourceSnapshotId: pack.sourceSnapshotId,
    compilerVersion: pack.compilerVersion,
    policyVersion: pack.policyVersion,
  }) || compiledPackIdentity(reconstructed) !== pack.packSha256
    || reconstructed.sourceCustodyReceipt["identitySha256"]
      !== pack.sourceCustodyIdentitySha256
    || !bindingMatchesCustody(reconstructed.binding, custody)
    || !receiptMatchesCustody(reconstructed.sourceCustodyReceipt, custody)
    || !manifestMatchesCustody(reconstructed, custody)
    || !compiledPackDependencyTreeMetadataMatches(reconstructed)) {
    return { kind: "not_ready", reason: "invalid_compiled_pack_custody" };
  }
  const disposition = acceptanceDependencyObservationDisposition({
    evidence: stored.evidence,
    currentHeadSha: context.binding.headSha,
    manifestSourceProven: compiledPackExactSourceMatches(reconstructed, stored.evidence.manifest),
    lockfileSourceProven: compiledPackLockfilePathCustodyMatches(
      reconstructed,
      stored.evidence.lockfile,
    ),
    yarnConfigurationCustody: compiledPackYarnConfigurationCustody(reconstructed),
    freezeUnsupportedProfile: stored.observation.reasons.includes(
      "unsupported_manager_profile",
    ),
  });
  if (disposition.status !== stored.observation.status
    || !isDeepStrictEqual(disposition.reasons, stored.observation.reasons)) {
    return { kind: "not_ready", reason: "invalid_compiled_pack_custody" };
  }
  return { kind: "valid", stored };
}

function acceptanceDependencyApprovalEventKey(
  headCycleId: string,
  candidateFingerprint: string,
): string {
  return `acceptance-dependency-approval:${headCycleId}:${candidateFingerprint.slice("sha256:".length)}`;
}

function acceptanceDependencyExternalBuilderPackEventKey(
  headCycleId: string,
  candidateFingerprint: string,
): string {
  return `acceptance-dependency-external-builder-pack:${headCycleId}:${candidateFingerprint.slice("sha256:".length)}`;
}

function acceptanceDependencyExternalBuilderPackId(input: {
  observationEventId: string;
  approvalEventId: string;
  routeId: string;
  routeConfigurationVersion: number;
}): string {
  return uuid5Url([
    "acceptance-dependency-external-builder-pack",
    input.observationEventId,
    input.approvalEventId,
    input.routeId,
    input.routeConfigurationVersion,
  ].join(":"));
}

function acceptanceDependencyApprovalPayload(input: {
  stored: StoredAcceptanceDependencyObservation;
  approvedBy: string;
  approvedRole: AcceptanceDependencyApprovalRole;
}): Record<string, unknown> {
  return {
    kind: ACCEPTANCE_DEPENDENCY_APPROVAL_KIND,
    version: ACCEPTANCE_DEPENDENCY_APPROVAL_VERSION,
    binding: input.stored.binding,
    observation: {
      eventId: input.stored.event.id,
      eventKey: input.stored.event.eventKey,
      identitySha256: input.stored.identitySha256,
      candidateFingerprint: input.stored.observation.candidateFingerprint,
      status: "observed",
    },
    approvedBy: input.approvedBy,
    approvedRole: input.approvedRole,
  };
}

function acceptanceDependencyApprovalIdentitySha256(
  event: Pick<ChangeRecordEventRow, "id" | "eventKey" | "stage" | "actor" | "payloadRef">,
): string {
  return acceptanceContextPackCanonicalSha256({
    kind: "acceptance_dependency_approval_event_identity",
    version: 1,
    eventId: event.id,
    eventKey: event.eventKey,
    stage: event.stage,
    actor: event.actor,
    payloadRef: event.payloadRef,
  });
}

function parseAcceptanceDependencyApprovalEvent(input: {
  event: ChangeRecordEventRow;
  stored: StoredAcceptanceDependencyObservation;
}): AcceptanceDependencyApproval | null {
  const { event, stored } = input;
  const payload = event.payloadRef;
  const eventKey = acceptanceDependencyApprovalEventKey(
    stored.binding.headCycleId,
    stored.observation.candidateFingerprint,
  );
  if (event.id !== changeRecordEventId({ recordId: stored.binding.recordId, eventKey })
    || event.recordId !== stored.binding.recordId || event.eventKey !== eventKey
    || event.stage !== ACCEPTANCE_DEPENDENCY_APPROVAL_STAGE
    || !isRecord(payload) || !hasExactKeys(payload, [
      "kind", "version", "binding", "observation", "approvedBy", "approvedRole",
    ]) || payload["kind"] !== ACCEPTANCE_DEPENDENCY_APPROVAL_KIND
    || payload["version"] !== ACCEPTANCE_DEPENDENCY_APPROVAL_VERSION
    || !isDeepStrictEqual(payload["binding"], stored.binding)
    || !isRecord(payload["observation"]) || !hasExactKeys(payload["observation"], [
      "eventId", "eventKey", "identitySha256", "candidateFingerprint", "status",
    ]) || payload["observation"]["eventId"] !== stored.event.id
    || payload["observation"]["eventKey"] !== stored.event.eventKey
    || payload["observation"]["identitySha256"] !== stored.identitySha256
    || payload["observation"]["candidateFingerprint"]
      !== stored.observation.candidateFingerprint
    || payload["observation"]["status"] !== "observed"
    || typeof payload["approvedBy"] !== "string" || !HUMAN_DECISION_ACTOR.test(payload["approvedBy"])
    || event.actor !== payload["approvedBy"]
    || (payload["approvedRole"] !== "owner" && payload["approvedRole"] !== "admin")
    || !(event.at instanceof Date) || Number.isNaN(event.at.valueOf())) return null;
  return {
    eventId: event.id,
    eventKey: event.eventKey,
    observationEventId: stored.event.id,
    candidateFingerprint: stored.observation.candidateFingerprint,
    approvedBy: payload["approvedBy"],
    approvedRole: payload["approvedRole"],
    approvedAt: event.at,
  };
}

function externalBuilderRouteFromResolution(
  resolution: AcceptanceBuilderRouteSelectionResolution,
): AcceptanceDependencyExternalBuilderRoute | null {
  if (!isGithubNativeBuilderRouteAdapter(resolution.route.adapter)
    || resolution.snapshot.builder.adapter !== resolution.route.adapter
    || resolution.snapshot.builder.routeId !== resolution.route.id
    || resolution.snapshot.protocol !== "github_comment") return null;
  return {
    selectionEventId: resolution.event.id,
    id: resolution.route.id,
    adapter: resolution.route.adapter,
    configurationVersion: resolution.route.configurationVersion,
    snapshot: structuredClone(resolution.snapshot),
    snapshotSha256: acceptanceContextPackCanonicalSha256(resolution.snapshot),
  };
}

function acceptanceDependencyExternalBuilderPackPayload(input: {
  packId: string;
  stored: StoredAcceptanceDependencyObservation;
  approval: AcceptanceDependencyApproval;
  approvalIdentitySha256: string;
  route: AcceptanceDependencyExternalBuilderRoute;
}): Record<string, unknown> {
  return {
    kind: ACCEPTANCE_DEPENDENCY_EXTERNAL_BUILDER_PACK_KIND,
    version: ACCEPTANCE_DEPENDENCY_EXTERNAL_BUILDER_PACK_VERSION,
    packId: input.packId,
    binding: input.stored.binding,
    observation: {
      eventId: input.stored.event.id,
      eventKey: input.stored.event.eventKey,
      identitySha256: input.stored.identitySha256,
      candidateFingerprint: input.stored.observation.candidateFingerprint,
    },
    approval: {
      eventId: input.approval.eventId,
      eventKey: input.approval.eventKey,
      identitySha256: input.approvalIdentitySha256,
      approvedBy: input.approval.approvedBy,
      approvedRole: input.approval.approvedRole,
    },
    candidate: input.stored.evidence.candidate,
    runtime: input.stored.evidence.runtime,
    packageManager: input.stored.evidence.packageManager,
    manifest: input.stored.evidence.manifest,
    lockfile: input.stored.evidence.lockfile,
    baseline: input.stored.evidence.baseline,
    security: input.stored.evidence.security,
    route: input.route,
    deliveryAuthority: "not_granted",
    scopeBoundary: "dependency_external_builder_pack_only",
    reviewRequirement: "exact_head_r7_reentry",
  };
}

function legacyAcceptanceDependencyExternalBuilderPackPayload(input: {
  packId: string;
  stored: StoredAcceptanceDependencyObservation;
  approval: AcceptanceDependencyApproval;
  approvalIdentitySha256: string;
  route: AcceptanceDependencyExternalBuilderRoute;
}): Record<string, unknown> {
  const current = acceptanceDependencyExternalBuilderPackPayload(input);
  const { identity: _candidateIdentity, ...candidate } = input.stored.evidence.candidate;
  const { identity: _runtimeIdentity, version, ...runtime } = input.stored.evidence.runtime;
  const { identity: _securityIdentity, ...security } = input.stored.evidence.security;
  return {
    ...current,
    version: ACCEPTANCE_DEPENDENCY_EXTERNAL_BUILDER_PACK_LEGACY_VERSION,
    candidate,
    runtime: { ...runtime, nodeVersion: version },
    security,
  };
}

async function parseAcceptanceDependencyExternalBuilderPackEventInTransaction(
  tx: DbTransaction,
  input: {
    event: ChangeRecordEventRow;
    stored: StoredAcceptanceDependencyObservation;
    approvalEvent: ChangeRecordEventRow;
    approval: AcceptanceDependencyApproval;
    context: CurrentAcceptanceDependencyContext;
  },
): Promise<AcceptanceDependencyExternalBuilderPack | null> {
  const { event, stored, approvalEvent, approval, context } = input;
  const payload = event.payloadRef;
  const eventKey = acceptanceDependencyExternalBuilderPackEventKey(
    stored.binding.headCycleId,
    stored.observation.candidateFingerprint,
  );
  if (event.id !== changeRecordEventId({ recordId: stored.binding.recordId, eventKey })
    || event.recordId !== stored.binding.recordId || event.eventKey !== eventKey
    || event.stage !== ACCEPTANCE_DEPENDENCY_EXTERNAL_BUILDER_PACK_STAGE
    || event.actor !== ACCEPTANCE_DEPENDENCY_EXTERNAL_BUILDER_PACK_ACTOR
    || !isRecord(payload) || !hasExactKeys(payload, [
      "kind", "version", "packId", "binding", "observation", "approval", "candidate",
      "runtime", "packageManager", "manifest", "lockfile", "baseline", "security", "route",
      "deliveryAuthority", "scopeBoundary", "reviewRequirement",
    ]) || payload["kind"] !== ACCEPTANCE_DEPENDENCY_EXTERNAL_BUILDER_PACK_KIND
    || (payload["version"] !== ACCEPTANCE_DEPENDENCY_EXTERNAL_BUILDER_PACK_LEGACY_VERSION
      && payload["version"] !== ACCEPTANCE_DEPENDENCY_EXTERNAL_BUILDER_PACK_VERSION)
    || (payload["version"] === ACCEPTANCE_DEPENDENCY_EXTERNAL_BUILDER_PACK_LEGACY_VERSION
      && stored.payloadVersion !== ACCEPTANCE_DEPENDENCY_OBSERVATION_LEGACY_VERSION)
    || !isUuid(payload["packId"]) || payload["packId"] !== payload["packId"].toLowerCase()
    || !isRecord(payload["route"]) || !hasExactKeys(payload["route"], [
      "selectionEventId", "id", "adapter", "configurationVersion", "snapshot", "snapshotSha256",
    ]) || !isUuid(payload["route"]["selectionEventId"])
    || !isUuid(payload["route"]["id"])
    || !isGithubNativeBuilderRouteAdapter(payload["route"]["adapter"])
    || !Number.isSafeInteger(payload["route"]["configurationVersion"])
    || (payload["route"]["configurationVersion"] as number) <= 0
    || !isRecord(payload["route"]["snapshot"])
    || typeof payload["route"]["snapshotSha256"] !== "string"
    || !LOWER_SHA256.test(payload["route"]["snapshotSha256"])) return null;

  const selectionEvent = (await tx.select().from(changeRecordEvents).where(and(
    eq(changeRecordEvents.recordId, context.binding.recordId),
    eq(changeRecordEvents.eventKey, ACCEPTANCE_BUILDER_ROUTE_EVENT_KEY),
  )).limit(1))[0] as ChangeRecordEventRow | undefined;
  const selection = selectionEvent && parseAcceptanceBuilderRoutePayload(selectionEvent.payloadRef);
  if (!selectionEvent || !selection || selectionEvent.id !== payload["route"]["selectionEventId"]
    || selectionEvent.id !== changeRecordEventId({
      recordId: context.binding.recordId,
      eventKey: ACCEPTANCE_BUILDER_ROUTE_EVENT_KEY,
    }) || selectionEvent.stage !== "builder_handoff"
    || !isBuilderRouteActor(selectionEvent.actor, true)
    || selection.workspaceId !== context.binding.workspaceId
    || selection.recordId !== context.binding.recordId
    || selection.repository !== context.binding.repo
    || selection.contractId !== context.binding.acceptanceContract.id
    || selection.contractVersion !== context.binding.acceptanceContract.version
    || selection.routeId !== payload["route"]["id"]
    || selection.routeAdapter !== payload["route"]["adapter"]
    || selection.routeConfigurationVersion !== payload["route"]["configurationVersion"]
    || !isDeepStrictEqual(selection.snapshot, payload["route"]["snapshot"])
    || acceptanceContextPackCanonicalSha256(selection.snapshot)
      !== payload["route"]["snapshotSha256"]) return null;
  const route: AcceptanceDependencyExternalBuilderRoute = {
    selectionEventId: selectionEvent.id,
    id: selection.routeId,
    adapter: selection.routeAdapter as GithubNativeAcceptanceBuilderRouteAdapter,
    configurationVersion: selection.routeConfigurationVersion,
    snapshot: structuredClone(selection.snapshot),
    snapshotSha256: payload["route"]["snapshotSha256"],
  };
  const packId = acceptanceDependencyExternalBuilderPackId({
    observationEventId: stored.event.id,
    approvalEventId: approval.eventId,
    routeId: route.id,
    routeConfigurationVersion: route.configurationVersion,
  });
  if (payload["packId"] !== packId) return null;
  const payloadInput = {
    packId,
    stored,
    approval,
    approvalIdentitySha256: acceptanceDependencyApprovalIdentitySha256(approvalEvent),
    route,
  };
  const expected = payload["version"] === ACCEPTANCE_DEPENDENCY_EXTERNAL_BUILDER_PACK_LEGACY_VERSION
    ? legacyAcceptanceDependencyExternalBuilderPackPayload(payloadInput)
    : acceptanceDependencyExternalBuilderPackPayload(payloadInput);
  if (!isDeepStrictEqual(payload, expected)
    || !(event.at instanceof Date) || Number.isNaN(event.at.valueOf())) return null;
  return {
    packId,
    eventId: event.id,
    eventKey: event.eventKey,
    observationEventId: stored.event.id,
    approvalEventId: approval.eventId,
    candidateFingerprint: stored.observation.candidateFingerprint,
    binding: structuredClone(stored.binding),
    candidate: structuredClone(stored.evidence.candidate),
    runtime: structuredClone(stored.evidence.runtime),
    packageManager: structuredClone(stored.evidence.packageManager),
    manifest: structuredClone(stored.evidence.manifest),
    lockfile: structuredClone(stored.evidence.lockfile),
    baseline: structuredClone(stored.evidence.baseline),
    security: structuredClone(stored.evidence.security),
    route,
    deliveryAuthority: "not_granted",
    scopeBoundary: "dependency_external_builder_pack_only",
    reviewRequirement: "exact_head_r7_reentry",
    mintedAt: event.at,
  };
}

async function readAcceptanceDependencyApprovalPackPairInTransaction(
  tx: DbTransaction,
  input: {
    stored: StoredAcceptanceDependencyObservation;
    context: CurrentAcceptanceDependencyContext;
  },
): Promise<
  | { kind: "absent" }
  | {
      kind: "present";
      approval: AcceptanceDependencyApproval;
      externalBuilderPack: AcceptanceDependencyExternalBuilderPack;
    }
  | { kind: "invalid" }
> {
  const approvalEventKey = acceptanceDependencyApprovalEventKey(
    input.stored.binding.headCycleId,
    input.stored.observation.candidateFingerprint,
  );
  const packEventKey = acceptanceDependencyExternalBuilderPackEventKey(
    input.stored.binding.headCycleId,
    input.stored.observation.candidateFingerprint,
  );
  const events = await tx.select().from(changeRecordEvents).where(and(
    eq(changeRecordEvents.recordId, input.stored.binding.recordId),
    inArray(changeRecordEvents.eventKey, [approvalEventKey, packEventKey]),
  ));
  const approvalEvent = events.find((event) => event.eventKey === approvalEventKey);
  const packEvent = events.find((event) => event.eventKey === packEventKey);
  if (!approvalEvent && !packEvent) return { kind: "absent" };
  if (!approvalEvent || !packEvent || input.stored.observation.status !== "observed") {
    return { kind: "invalid" };
  }
  const approval = parseAcceptanceDependencyApprovalEvent({
    event: approvalEvent,
    stored: input.stored,
  });
  if (!approval) return { kind: "invalid" };
  const externalBuilderPack = await parseAcceptanceDependencyExternalBuilderPackEventInTransaction(
    tx,
    {
      event: packEvent,
      stored: input.stored,
      approvalEvent,
      approval,
      context: input.context,
    },
  );
  return externalBuilderPack
    ? { kind: "present", approval, externalBuilderPack }
    : { kind: "invalid" };
}

function parseApproveAcceptanceDependencyObservationInput(
  input: unknown,
): (ApproveAcceptanceDependencyObservationAndMintExternalBuilderPackInput & {
  approvedByUserId: string;
}) | null {
  if (!isRecord(input) || !hasExactKeys(input, [
    "workspaceId", "recordId", "observationEventId", "approvedBy",
  ]) || !isUuid(input["workspaceId"]) || !isUuid(input["recordId"])
    || !isUuid(input["observationEventId"]) || typeof input["approvedBy"] !== "string") return null;
  const match = HUMAN_DECISION_ACTOR.exec(input["approvedBy"]);
  if (!match) return null;
  return {
    workspaceId: input["workspaceId"].toLowerCase(),
    recordId: input["recordId"].toLowerCase(),
    observationEventId: input["observationEventId"].toLowerCase(),
    approvedBy: `user:${match[1]!.toLowerCase()}`,
    approvedByUserId: match[1]!.toLowerCase(),
  };
}

function assertReadCurrentAcceptanceDependencyObservationsInput(
  input: unknown,
): asserts input is ReadCurrentAcceptanceDependencyObservationsInput {
  if (!isRecord(input) || !hasExactKeys(input, ["workspaceId", "recordId"])
    || !isUuid(input["workspaceId"]) || !isUuid(input["recordId"])) {
    throw new Error("Current dependency observations read requires only workspace and Record");
  }
}

/**
 * Reads only the current authoritative head occurrence. Historical dependency
 * observations remain in the Record timeline but are never returned as
 * current approval targets, including a later revisit of the same SHA.
 */
export async function readCurrentAcceptanceDependencyObservations(
  input: ReadCurrentAcceptanceDependencyObservationsInput,
): Promise<ReadCurrentAcceptanceDependencyObservationsResult> {
  assertReadCurrentAcceptanceDependencyObservationsInput(input);
  const parsed = {
    workspaceId: input.workspaceId.toLowerCase(),
    recordId: input.recordId.toLowerCase(),
  };
  const candidate = await currentAcceptanceDependencyCandidate(parsed);
  if (candidate === null) return { kind: "not_found" };
  if (candidate === "not_current") return { kind: "not_current" };
  const lockKey = acceptanceRecordPullRequestLockKey({ ...parsed, ...candidate });
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const current = await resolveCurrentAcceptanceDependencyContextInTransaction(
      tx,
      parsed,
      candidate,
    );
    if (current.kind !== "current") return current;
    const { context } = current;
    const legacyEventPrefix = `acceptance-dependency-observation:${context.binding.headCycleId}:%`;
    const currentEventPrefix = `acceptance-dependency-observation:v${ACCEPTANCE_DEPENDENCY_OBSERVATION_VERSION}:${context.binding.headCycleId}:%`;
    const events = await tx.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, context.binding.recordId),
      sql`(
        ${changeRecordEvents.eventKey} LIKE ${legacyEventPrefix}
        OR ${changeRecordEvents.eventKey} LIKE ${currentEventPrefix}
        OR (
          ${changeRecordEvents.stage} = ${ACCEPTANCE_DEPENDENCY_OBSERVATION_STAGE}
          AND ${changeRecordEvents.payloadRef}->'binding'->>'headCycleId'
            = ${context.binding.headCycleId}
        )
      )`,
    )).orderBy(asc(changeRecordEvents.eventKey)).limit(
      ACCEPTANCE_DEPENDENCY_OBSERVATION_READ_LIMIT + 1,
    );
    if (events.length > ACCEPTANCE_DEPENDENCY_OBSERVATION_READ_LIMIT) {
      return { kind: "not_ready" as const, reason: "invalid_observation_custody" as const };
    }
    const observations: CurrentAcceptanceDependencyObservationItem[] = [];
    const fingerprints = new Set<string>();
    const canonicalFingerprints = new Set<string>();
    for (const event of events) {
      const stored = parseStoredAcceptanceDependencyObservationEvent(event as ChangeRecordEventRow);
      const canonicalFingerprint = stored
        ? acceptanceDependencyCandidateFingerprint(
            stored.evidence.candidate,
            stored.evidence.manifest.path,
          )
        : null;
      if (!stored || !observationBindingMatchesCurrentContext({
        binding: stored.binding,
        context,
      }) || fingerprints.has(stored.observation.candidateFingerprint)
        || canonicalFingerprint === null || canonicalFingerprints.has(canonicalFingerprint)) {
        return { kind: "not_ready" as const, reason: "invalid_observation_custody" as const };
      }
      fingerprints.add(stored.observation.candidateFingerprint);
      canonicalFingerprints.add(canonicalFingerprint);
      const validated = await revalidateStoredAcceptanceDependencyObservationInTransaction(
        tx,
        { stored, context },
      );
      if (validated.kind !== "valid") return validated;
      const pair = await readAcceptanceDependencyApprovalPackPairInTransaction(
        tx,
        { stored, context },
      );
      if (pair.kind === "invalid") {
        return {
          kind: "not_ready" as const,
          reason: "invalid_approval_pack_custody" as const,
        };
      }
      observations.push({
        payloadVersion: stored.payloadVersion,
        binding: structuredClone(stored.binding),
        observation: stored.observation,
        approval: pair.kind === "present" ? pair.approval : null,
        externalBuilderPack: pair.kind === "present" ? pair.externalBuilderPack : null,
      });
    }
    return {
      kind: "current" as const,
      binding: context.binding,
      observations,
    };
  });
}

function selectedBuilderRouteUnavailableError(error: unknown): boolean {
  return error instanceof Error && (
    error.message === "Acceptance Builder route selection is missing or invalid"
    || error.message === "Acceptance Builder route selection is not bound to the current Record and Contract"
    || error.message === "Acceptance Builder route is unavailable for this Record"
    || error.message === "Acceptance Builder route configuration no longer matches its selection"
  );
}

/**
 * Records a human candidate-bound approval and mints its metadata-only external
 * Builder Pack in one transaction. It grants no delivery or execution
 * authority and performs no dispatch, install, issue, pull-request, or merge.
 */
export async function approveAcceptanceDependencyObservationAndMintExternalBuilderPack(
  input: ApproveAcceptanceDependencyObservationAndMintExternalBuilderPackInput,
): Promise<ApproveAcceptanceDependencyObservationAndMintExternalBuilderPackResult> {
  const parsed = parseApproveAcceptanceDependencyObservationInput(input);
  if (!parsed) {
    throw new Error("Dependency observation approval requires exact workspace, Record, observation, and user actor");
  }
  const candidate = await currentAcceptanceDependencyCandidate(parsed);
  if (candidate === null) return { kind: "not_found" };
  if (candidate === "not_current") return { kind: "not_current" };
  const lockKey = acceptanceRecordPullRequestLockKey({
    workspaceId: parsed.workspaceId,
    recordId: parsed.recordId,
    ...candidate,
  });
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const membership = (Array.from(await tx.execute(sql`
      SELECT role
      FROM workspace_memberships
      WHERE user_id = ${parsed.approvedByUserId}
        AND workspace_id = ${parsed.workspaceId}
      FOR SHARE
    `)) as Array<{ role: string }>)[0];
    if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
      return { kind: "not_authorized" as const };
    }
    const current = await resolveCurrentAcceptanceDependencyContextInTransaction(
      tx,
      parsed,
      candidate,
    );
    if (current.kind !== "current") return current;
    const { context } = current;
    const observationEvent = (await tx.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.id, parsed.observationEventId),
      eq(changeRecordEvents.recordId, parsed.recordId),
    )).limit(1))[0] as ChangeRecordEventRow | undefined;
    if (!observationEvent) return { kind: "observation_not_found" as const };
    const stored = parseStoredAcceptanceDependencyObservationEvent(observationEvent);
    if (!stored) {
      return { kind: "not_ready" as const, reason: "invalid_observation_custody" as const };
    }
    if (!observationBindingMatchesCurrentContext({ binding: stored.binding, context })) {
      return { kind: "not_current" as const };
    }
    const validated = await revalidateStoredAcceptanceDependencyObservationInTransaction(
      tx,
      { stored, context },
    );
    if (validated.kind !== "valid") return validated;

    const existingPair = await readAcceptanceDependencyApprovalPackPairInTransaction(
      tx,
      { stored, context },
    );
    if (existingPair.kind === "invalid") {
      throw new AcceptanceDependencyExternalBuilderPackConflictError();
    }
    if (existingPair.kind === "present") {
      if (existingPair.approval.approvedBy !== parsed.approvedBy) {
        throw new AcceptanceDependencyExternalBuilderPackConflictError();
      }
      return {
        kind: "replayed" as const,
        binding: stored.binding,
        observation: stored.observation,
        approval: existingPair.approval,
        externalBuilderPack: existingPair.externalBuilderPack,
      };
    }
    if (stored.observation.status !== "observed") {
      return {
        kind: "observation_not_eligible" as const,
        reason: "observation_not_observed" as const,
      };
    }

    let routeResolution: AcceptanceBuilderRouteSelectionResolution;
    try {
      routeResolution = await resolveSelectedAcceptanceBuilderRouteInTransaction(tx, {
        workspaceId: parsed.workspaceId,
        record: context.record,
        contract: context.contract,
      });
    } catch (error) {
      if (selectedBuilderRouteUnavailableError(error)) {
        return { kind: "not_ready" as const, reason: "selected_route_unavailable" as const };
      }
      throw error;
    }
    const route = externalBuilderRouteFromResolution(routeResolution);
    if (!route) {
      return {
        kind: "not_ready" as const,
        reason: "selected_route_not_external_builder" as const,
      };
    }

    const approvalEventKey = acceptanceDependencyApprovalEventKey(
      stored.binding.headCycleId,
      stored.observation.candidateFingerprint,
    );
    const approvalEventId = changeRecordEventId({
      recordId: parsed.recordId,
      eventKey: approvalEventKey,
    });
    const at = new Date();
    const approvalPayload = acceptanceDependencyApprovalPayload({
      stored,
      approvedBy: parsed.approvedBy,
      approvedRole: membership.role,
    });
    const approval: AcceptanceDependencyApproval = {
      eventId: approvalEventId,
      eventKey: approvalEventKey,
      observationEventId: stored.event.id,
      candidateFingerprint: stored.observation.candidateFingerprint,
      approvedBy: parsed.approvedBy,
      approvedRole: membership.role,
      approvedAt: at,
    };
    const approvalIdentitySha256 = acceptanceDependencyApprovalIdentitySha256({
      id: approvalEventId,
      eventKey: approvalEventKey,
      stage: ACCEPTANCE_DEPENDENCY_APPROVAL_STAGE,
      actor: parsed.approvedBy,
      payloadRef: approvalPayload,
    });
    const packEventKey = acceptanceDependencyExternalBuilderPackEventKey(
      stored.binding.headCycleId,
      stored.observation.candidateFingerprint,
    );
    const packId = acceptanceDependencyExternalBuilderPackId({
      observationEventId: stored.event.id,
      approvalEventId,
      routeId: route.id,
      routeConfigurationVersion: route.configurationVersion,
    });
    const packPayload = acceptanceDependencyExternalBuilderPackPayload({
      packId,
      stored,
      approval,
      approvalIdentitySha256,
      route,
    });
    let appended: AppendChangeRecordEventsAtomicallyResult;
    try {
      appended = await appendChangeRecordEventsAtomicallyInTransaction(tx, [
        {
          recordId: parsed.recordId,
          eventKey: approvalEventKey,
          stage: ACCEPTANCE_DEPENDENCY_APPROVAL_STAGE,
          actor: parsed.approvedBy,
          payloadRef: approvalPayload,
          at,
        },
        {
          recordId: parsed.recordId,
          eventKey: packEventKey,
          stage: ACCEPTANCE_DEPENDENCY_EXTERNAL_BUILDER_PACK_STAGE,
          actor: ACCEPTANCE_DEPENDENCY_EXTERNAL_BUILDER_PACK_ACTOR,
          payloadRef: packPayload,
          at,
        },
      ]);
    } catch (error) {
      if (error instanceof Error
        && error.message.startsWith("appendChangeRecordEventsAtomically: event key is already bound")) {
        throw new AcceptanceDependencyExternalBuilderPackConflictError();
      }
      throw error;
    }
    if (appended.events[0]?.inserted !== appended.events[1]?.inserted) {
      throw new AcceptanceDependencyExternalBuilderPackConflictError();
    }
    const pair = await readAcceptanceDependencyApprovalPackPairInTransaction(
      tx,
      { stored, context },
    );
    if (pair.kind !== "present" || pair.approval.approvedBy !== parsed.approvedBy) {
      throw new AcceptanceDependencyExternalBuilderPackConflictError();
    }
    return {
      kind: appended.events[0]!.inserted ? "approved" as const : "replayed" as const,
      binding: stored.binding,
      observation: stored.observation,
      approval: pair.approval,
      externalBuilderPack: pair.externalBuilderPack,
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
    if (!record
      || !record.currentPrHeadAuthoritative
      || record.currentPrHeadSha !== input.expectedHeadSha
      || record.currentPrHeadCycleId !== input.reviewJobId
      || !record.headShas.includes(input.expectedHeadSha)) {
      throw new Error("Context Pack snapshot Record head is not current");
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

function builderRouteCapabilityProfileSnapshot(input: {
  route: AcceptanceBuilderRouteRow;
  githubInstallationIdentitySha256: string;
}): AcceptanceBuilderRouteCapabilityProfileSnapshot {
  if (!isGithubNativeBuilderRouteAdapter(input.route.adapter)) {
    throw new Error("Acceptance Builder capability supports GitHub-native routes only");
  }
  return {
    kind: "acceptance_builder_route_capability_profile",
    version: 1,
    workspaceId: input.route.workspaceId,
    repo: input.route.repo,
    routeId: input.route.id,
    adapter: input.route.adapter,
    routeConfigurationVersion: input.route.configurationVersion,
    carrier: "github_issue_comment",
    carrierIdentity: "workspace_github_app_installation",
    findingPublication: "individual_no_vendor_mentions",
    activation: "single_final_vendor_mention",
    recipient: input.route.adapter === "github_codex" ? "codex" : "claude",
    configuration: "configuration_bound",
    preflight: "required",
    vendorAvailability: "not_asserted",
    vendorActivity: "required",
    repairHead: "github_synchronize",
    scopeBoundary: "correction_delivery_only",
    githubInstallationIdentitySha256: input.githubInstallationIdentitySha256,
  };
}

function builderRouteCapabilityProfileComparable(
  row: AcceptanceBuilderRouteCapabilityProfileRow
) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    routeId: row.routeId,
    repo: row.repo,
    adapter: row.adapter,
    routeConfigurationVersion: row.routeConfigurationVersion,
    githubInstallationIdentitySha256: row.githubInstallationIdentitySha256,
    snapshot: row.snapshot,
    snapshotSha256: row.snapshotSha256,
    recordedBy: row.recordedBy,
  };
}

function builderRouteCapabilityProfileValues(input: {
  route: AcceptanceBuilderRouteRow;
  githubInstallationIdentitySha256: string;
  recordedBy: string;
}) {
  const snapshot = builderRouteCapabilityProfileSnapshot(input);
  return {
    id: acceptanceBuilderRouteCapabilityProfileId({
      routeId: input.route.id,
      routeConfigurationVersion: input.route.configurationVersion,
    }),
    workspaceId: input.route.workspaceId,
    routeId: input.route.id,
    repo: input.route.repo,
    adapter: input.route.adapter,
    routeConfigurationVersion: input.route.configurationVersion,
    githubInstallationIdentitySha256: input.githubInstallationIdentitySha256,
    snapshot,
    snapshotSha256: acceptanceContextPackCanonicalSha256(snapshot),
    recordedBy: input.recordedBy,
  };
}

/** One profile exists for one immutable server route configuration revision. */
export function acceptanceBuilderRouteCapabilityProfileId(input: {
  routeId: string;
  routeConfigurationVersion: number;
}): string {
  return uuid5Url(
    `acceptance-builder-route-capability-profile:${input.routeId}:${input.routeConfigurationVersion}`
  );
}

function githubInstallationIdentitySha256(input: {
  workspaceId: string;
  installationId: unknown;
  accountLogin: unknown;
  accountType: unknown;
}): string | null {
  if (typeof input.installationId !== "string" || !input.installationId.trim()
    || input.installationId.trim() !== input.installationId || input.installationId.length > 128
    || /[\u0000-\u001f\u007f]/.test(input.installationId)
    || typeof input.accountLogin !== "string" || !input.accountLogin.trim()
    || input.accountLogin.trim() !== input.accountLogin || input.accountLogin.length > 256
    || /[\u0000-\u001f\u007f]/.test(input.accountLogin)
    || (input.accountType !== "User" && input.accountType !== "Organization")) return null;
  return acceptanceContextPackCanonicalSha256({
    kind: "workspace_github_installation_identity",
    version: 1,
    workspaceId: input.workspaceId,
    installationId: input.installationId,
    accountLogin: input.accountLogin,
    accountType: input.accountType,
  });
}

async function resolveAcceptanceBuilderRouteCapabilityProfileInTransaction(
  tx: DbTransaction,
  input: { workspaceId: string; route: AcceptanceBuilderRouteRow }
): Promise<AcceptanceBuilderRouteCapabilityProfileRow | null> {
  if (!isGithubNativeBuilderRouteAdapter(input.route.adapter)
    || input.route.workspaceId !== input.workspaceId
    || input.route.status !== "active") return null;
  const installation = (await tx.select({
    installationId: workspaces.githubInstallationId,
    accountLogin: workspaces.githubInstallationAccountLogin,
    accountType: workspaces.githubInstallationAccountType,
  }).from(workspaces).where(eq(workspaces.id, input.workspaceId)).limit(1))[0];
  const installationIdentitySha256 = installation && githubInstallationIdentitySha256({
    workspaceId: input.workspaceId,
    installationId: installation.installationId,
    accountLogin: installation.accountLogin,
    accountType: installation.accountType,
  });
  if (!installationIdentitySha256) return null;
  const profile = (await tx.select().from(acceptanceBuilderRouteCapabilityProfiles).where(and(
    eq(acceptanceBuilderRouteCapabilityProfiles.routeId, input.route.id),
    eq(acceptanceBuilderRouteCapabilityProfiles.workspaceId, input.workspaceId),
    eq(acceptanceBuilderRouteCapabilityProfiles.routeConfigurationVersion, input.route.configurationVersion),
  )).limit(1))[0];
  if (!profile) return null;
  const expected = builderRouteCapabilityProfileValues({
    route: input.route,
    githubInstallationIdentitySha256: installationIdentitySha256,
    recordedBy: profile.recordedBy,
  });
  return isDeepStrictEqual(builderRouteCapabilityProfileComparable(profile), expected)
    ? profile
    : null;
}

/**
 * Persist only the capability configuration derived from the active route and
 * workspace's existing GitHub installation identity. No token is minted and
 * no GitHub, vendor, or carrier request occurs here.
 */
export async function recordAcceptanceBuilderRouteCapabilityProfile(
  input: RecordAcceptanceBuilderRouteCapabilityProfileInput
): Promise<{ profile: AcceptanceBuilderRouteCapabilityProfileRow; inserted: boolean }> {
  if (!isRecord(input) || !hasExactKeys(input, ["workspaceId", "routeId", "recordedBy"])
    || !isUuid(input.workspaceId) || !isUuid(input.routeId)
    || !isServerBuilderRouteActor(input.recordedBy)) {
    throw new Error("Acceptance Builder capability profile requires only workspace, route, and server actor");
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`acceptance-builder-route-capability:${input.routeId}`}))`);
    const route = (await tx.select().from(acceptanceBuilderRoutes).where(and(
      eq(acceptanceBuilderRoutes.id, input.routeId),
      eq(acceptanceBuilderRoutes.workspaceId, input.workspaceId),
      eq(acceptanceBuilderRoutes.status, "active"),
    )).limit(1))[0];
    if (!route) throw new Error("Acceptance Builder route is unavailable for capability configuration");
    if (!isGithubNativeBuilderRouteAdapter(route.adapter)) {
      throw new Error("Acceptance Builder capability supports GitHub-native routes only");
    }
    const workspace = (await tx.select({
      installationId: workspaces.githubInstallationId,
      accountLogin: workspaces.githubInstallationAccountLogin,
      accountType: workspaces.githubInstallationAccountType,
    }).from(workspaces).where(eq(workspaces.id, input.workspaceId)).limit(1))[0];
    const installationIdentitySha256 = workspace && githubInstallationIdentitySha256({
      workspaceId: input.workspaceId,
      installationId: workspace.installationId,
      accountLogin: workspace.accountLogin,
      accountType: workspace.accountType,
    });
    if (!installationIdentitySha256) {
      throw new Error("Acceptance Builder capability requires a current workspace GitHub installation");
    }
    const values = builderRouteCapabilityProfileValues({
      route,
      githubInstallationIdentitySha256: installationIdentitySha256,
      recordedBy: input.recordedBy,
    });
    const existing = (await tx.select().from(acceptanceBuilderRouteCapabilityProfiles).where(and(
      eq(acceptanceBuilderRouteCapabilityProfiles.routeId, route.id),
      eq(acceptanceBuilderRouteCapabilityProfiles.routeConfigurationVersion, route.configurationVersion),
    )).limit(1))[0];
    if (existing) {
      if (!isDeepStrictEqual(builderRouteCapabilityProfileComparable(existing), values)) {
        throw new Error("Acceptance Builder capability profile is already bound to different configuration");
      }
      return { profile: existing, inserted: false };
    }
    const rows = await tx.insert(acceptanceBuilderRouteCapabilityProfiles).values(values).returning();
    return { profile: rows[0]!, inserted: true };
  });
}

/** Resolves only a profile that still exactly matches active server configuration. */
export async function resolveAcceptanceBuilderRouteCapabilityProfile(input: {
  workspaceId: string;
  routeId: string;
}): Promise<AcceptanceBuilderRouteCapabilityProfileRow | null> {
  if (!isRecord(input) || !hasExactKeys(input, ["workspaceId", "routeId"])
    || !isUuid(input.workspaceId) || !isUuid(input.routeId)) return null;
  return db.transaction(async (tx) => {
    const route = (await tx.select().from(acceptanceBuilderRoutes).where(and(
      eq(acceptanceBuilderRoutes.id, input.routeId),
      eq(acceptanceBuilderRoutes.workspaceId, input.workspaceId),
      eq(acceptanceBuilderRoutes.status, "active"),
    )).limit(1))[0];
    return route
      ? resolveAcceptanceBuilderRouteCapabilityProfileInTransaction(tx, { workspaceId: input.workspaceId, route })
      : null;
  });
}

export function acceptanceBuilderRouteGithubClaudeAckProfileId(input: {
  routeId: string;
  routeConfigurationVersion: number;
}): string {
  return uuid5Url(
    `acceptance-builder-route-github-claude-ack-profile:${input.routeId}:${input.routeConfigurationVersion}`
  );
}

function githubClaudeAckProfileSnapshot(input: {
  route: AcceptanceBuilderRouteRow;
  capabilityProfile: AcceptanceBuilderRouteCapabilityProfileRow;
  githubRepositoryId: string;
  githubRepositoryOwnerId: string;
  githubAppBotUserId: string;
  githubAppBotLogin: string;
  callerWorkflowRef: string;
  jobWorkflowRef: string;
  jobWorkflowSha: string;
  claudeActionSha: string;
}): AcceptanceBuilderRouteGithubClaudeAckProfileSnapshot {
  return {
    kind: "acceptance_builder_route_github_claude_ack_profile",
    version: 1,
    workspaceId: input.route.workspaceId,
    repo: input.route.repo,
    routeId: input.route.id,
    adapter: "github_claude",
    routeConfigurationVersion: input.route.configurationVersion,
    capabilityProfile: {
      id: input.capabilityProfile.id,
      snapshotSha256: input.capabilityProfile.snapshotSha256,
    },
    provider: "anthropic_claude_code_action",
    acknowledgement: "action_success_with_session",
    githubRepository: {
      id: input.githubRepositoryId,
      ownerId: input.githubRepositoryOwnerId,
    },
    triggerActor: { id: input.githubAppBotUserId, login: input.githubAppBotLogin },
    oidc: {
      issuer: GITHUB_CLAUDE_ACK_OIDC_ISSUER,
      audienceContract: GITHUB_CLAUDE_ACK_OIDC_AUDIENCE_CONTRACT,
      subjectContract: GITHUB_CLAUDE_ACK_OIDC_SUBJECT_CONTRACT,
      eventName: "issue_comment",
      callerWorkflowRef: input.callerWorkflowRef,
      jobWorkflowRef: input.jobWorkflowRef,
      jobWorkflowSha: input.jobWorkflowSha,
    },
    claudeActionSha: input.claudeActionSha,
    workflowContract: GITHUB_CLAUDE_ACK_WORKFLOW_CONTRACT,
    scopeBoundary: "agent_acknowledgement_only",
  };
}

function githubClaudeAckProfileValues(input: {
  route: AcceptanceBuilderRouteRow;
  capabilityProfile: AcceptanceBuilderRouteCapabilityProfileRow;
  githubRepositoryId: string;
  githubRepositoryOwnerId: string;
  githubAppBotUserId: string;
  githubAppBotLogin: string;
  callerWorkflowRef: string;
  jobWorkflowRef: string;
  jobWorkflowSha: string;
  claudeActionSha: string;
  recordedBy: string;
}) {
  const snapshot = githubClaudeAckProfileSnapshot(input);
  return {
    id: acceptanceBuilderRouteGithubClaudeAckProfileId({
      routeId: input.route.id,
      routeConfigurationVersion: input.route.configurationVersion,
    }),
    workspaceId: input.route.workspaceId,
    routeId: input.route.id,
    capabilityProfileId: input.capabilityProfile.id,
    capabilityProfileSnapshotSha256: input.capabilityProfile.snapshotSha256,
    repo: input.route.repo,
    routeConfigurationVersion: input.route.configurationVersion,
    githubRepositoryId: input.githubRepositoryId,
    githubRepositoryOwnerId: input.githubRepositoryOwnerId,
    githubAppBotUserId: input.githubAppBotUserId,
    githubAppBotLogin: input.githubAppBotLogin,
    oidcIssuer: GITHUB_CLAUDE_ACK_OIDC_ISSUER,
    oidcAudienceContract: GITHUB_CLAUDE_ACK_OIDC_AUDIENCE_CONTRACT,
    oidcSubjectContract: GITHUB_CLAUDE_ACK_OIDC_SUBJECT_CONTRACT,
    callerWorkflowRef: input.callerWorkflowRef,
    jobWorkflowRef: input.jobWorkflowRef,
    jobWorkflowSha: input.jobWorkflowSha,
    claudeActionSha: input.claudeActionSha,
    workflowContract: GITHUB_CLAUDE_ACK_WORKFLOW_CONTRACT,
    snapshot,
    snapshotSha256: acceptanceContextPackCanonicalSha256(snapshot),
    recordedBy: input.recordedBy,
  };
}

function githubClaudeAckProfileComparable(row: AcceptanceBuilderRouteGithubClaudeAckProfileRow) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    routeId: row.routeId,
    capabilityProfileId: row.capabilityProfileId,
    capabilityProfileSnapshotSha256: row.capabilityProfileSnapshotSha256,
    repo: row.repo,
    routeConfigurationVersion: row.routeConfigurationVersion,
    githubRepositoryId: row.githubRepositoryId,
    githubRepositoryOwnerId: row.githubRepositoryOwnerId,
    githubAppBotUserId: row.githubAppBotUserId,
    githubAppBotLogin: row.githubAppBotLogin,
    oidcIssuer: row.oidcIssuer,
    oidcAudienceContract: row.oidcAudienceContract,
    oidcSubjectContract: row.oidcSubjectContract,
    callerWorkflowRef: row.callerWorkflowRef,
    jobWorkflowRef: row.jobWorkflowRef,
    jobWorkflowSha: row.jobWorkflowSha,
    claudeActionSha: row.claudeActionSha,
    workflowContract: row.workflowContract,
    snapshot: row.snapshot,
    snapshotSha256: row.snapshotSha256,
    recordedBy: row.recordedBy,
  };
}

function isGithubClaudeAckProfileInput(
  input: RecordAcceptanceBuilderRouteGithubClaudeAckProfileInput
): boolean {
  const decimal = /^[1-9][0-9]{0,39}$/;
  const sha = /^[a-f0-9]{40}$/i;
  return isRecord(input)
    && hasExactKeys(input, [
      "workspaceId", "routeId", "githubRepositoryId", "githubRepositoryOwnerId",
      "githubAppBotUserId", "githubAppBotLogin", "callerWorkflowRef",
      "jobWorkflowRef", "jobWorkflowSha", "claudeActionSha", "recordedBy",
    ])
    && isUuid(input.workspaceId) && isUuid(input.routeId)
    && decimal.test(input.githubRepositoryId)
    && decimal.test(input.githubRepositoryOwnerId)
    && decimal.test(input.githubAppBotUserId)
    && input.githubAppBotLogin === "jace[bot]"
    && safeSnapshotText(input.callerWorkflowRef, 1_024)
    && safeSnapshotText(input.jobWorkflowRef, 1_024)
    && sha.test(input.jobWorkflowSha)
    && input.jobWorkflowRef.toLowerCase().endsWith(`@${input.jobWorkflowSha.toLowerCase()}`)
    && input.claudeActionSha.toLowerCase() === GITHUB_CLAUDE_ACK_APPROVED_ACTION_SHA
    && isServerBuilderRouteActor(input.recordedBy);
}

async function resolveAcceptanceBuilderRouteGithubClaudeAckProfileInTransaction(
  tx: DbTransaction,
  input: {
    workspaceId: string;
    route: AcceptanceBuilderRouteRow;
    capabilityProfile?: AcceptanceBuilderRouteCapabilityProfileRow;
  }
): Promise<AcceptanceBuilderRouteGithubClaudeAckProfileRow | null> {
  if (input.route.adapter !== "github_claude" || input.route.status !== "active"
    || input.route.workspaceId !== input.workspaceId) return null;
  const capabilityProfile = input.capabilityProfile
    ?? await resolveAcceptanceBuilderRouteCapabilityProfileInTransaction(tx, {
      workspaceId: input.workspaceId,
      route: input.route,
    });
  if (!capabilityProfile) return null;
  const repositoryRows = await tx.select({ defaultBranch: repositories.defaultBranch })
    .from(repositories).where(and(
      eq(repositories.workspaceId, input.workspaceId),
      eq(repositories.name, input.route.repo),
    )).limit(2);
  if (repositoryRows.length !== 1 || !safeSnapshotText(repositoryRows[0]!.defaultBranch, 255)) {
    return null;
  }
  const profile = (await tx.select().from(acceptanceBuilderRouteGithubClaudeAckProfiles).where(and(
    eq(acceptanceBuilderRouteGithubClaudeAckProfiles.workspaceId, input.workspaceId),
    eq(acceptanceBuilderRouteGithubClaudeAckProfiles.routeId, input.route.id),
    eq(acceptanceBuilderRouteGithubClaudeAckProfiles.routeConfigurationVersion,
      input.route.configurationVersion),
  )).limit(1))[0];
  if (!profile || profile.capabilityProfileId !== capabilityProfile.id
    || profile.capabilityProfileSnapshotSha256 !== capabilityProfile.snapshotSha256) return null;
  if (!profile.callerWorkflowRef.endsWith(
    `@refs/heads/${repositoryRows[0]!.defaultBranch}`
  )) return null;
  const expected = githubClaudeAckProfileValues({
    route: input.route,
    capabilityProfile,
    githubRepositoryId: profile.githubRepositoryId,
    githubRepositoryOwnerId: profile.githubRepositoryOwnerId,
    githubAppBotUserId: profile.githubAppBotUserId,
    githubAppBotLogin: profile.githubAppBotLogin,
    callerWorkflowRef: profile.callerWorkflowRef,
    jobWorkflowRef: profile.jobWorkflowRef,
    jobWorkflowSha: profile.jobWorkflowSha,
    claudeActionSha: profile.claudeActionSha,
    recordedBy: profile.recordedBy,
  });
  return isDeepStrictEqual(githubClaudeAckProfileComparable(profile), expected) ? profile : null;
}

/** Records one immutable trusted-workflow policy for an active github_claude route revision. */
export async function recordAcceptanceBuilderRouteGithubClaudeAckProfile(
  input: RecordAcceptanceBuilderRouteGithubClaudeAckProfileInput
): Promise<{ profile: AcceptanceBuilderRouteGithubClaudeAckProfileRow; inserted: boolean }> {
  if (!isGithubClaudeAckProfileInput(input)) {
    throw new Error("GitHub Claude acknowledgement profile input is invalid");
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`acceptance-builder-route-claude-ack:${input.routeId}`}))`);
    const route = (await tx.select().from(acceptanceBuilderRoutes).where(and(
      eq(acceptanceBuilderRoutes.id, input.routeId),
      eq(acceptanceBuilderRoutes.workspaceId, input.workspaceId),
      eq(acceptanceBuilderRoutes.status, "active"),
      eq(acceptanceBuilderRoutes.adapter, "github_claude"),
    )).limit(1))[0];
    if (!route) throw new Error("GitHub Claude acknowledgement route is unavailable");
    const repositoryRows = await tx.select({ defaultBranch: repositories.defaultBranch })
      .from(repositories).where(and(
        eq(repositories.workspaceId, input.workspaceId),
        eq(repositories.name, route.repo),
      )).limit(2);
    if (repositoryRows.length !== 1
      || !safeSnapshotText(repositoryRows[0]!.defaultBranch, 255)) {
      throw new Error("GitHub Claude acknowledgement requires one workspace repository identity");
    }
    if (!input.callerWorkflowRef.startsWith(`${route.repo}/.github/workflows/`)
      || !input.callerWorkflowRef.endsWith(`@refs/heads/${repositoryRows[0]!.defaultBranch}`)) {
      throw new Error("GitHub Claude acknowledgement caller workflow does not match the route repository");
    }
    const capabilityProfile = await resolveAcceptanceBuilderRouteCapabilityProfileInTransaction(tx, {
      workspaceId: input.workspaceId,
      route,
    });
    if (!capabilityProfile) {
      throw new Error("GitHub Claude acknowledgement requires the exact current capability profile");
    }
    const values = githubClaudeAckProfileValues({
      route,
      capabilityProfile,
      githubRepositoryId: input.githubRepositoryId,
      githubRepositoryOwnerId: input.githubRepositoryOwnerId,
      githubAppBotUserId: input.githubAppBotUserId,
      githubAppBotLogin: input.githubAppBotLogin,
      callerWorkflowRef: input.callerWorkflowRef,
      jobWorkflowRef: input.jobWorkflowRef,
      jobWorkflowSha: input.jobWorkflowSha.toLowerCase(),
      claudeActionSha: input.claudeActionSha.toLowerCase(),
      recordedBy: input.recordedBy,
    });
    const existing = (await tx.select().from(acceptanceBuilderRouteGithubClaudeAckProfiles).where(and(
      eq(acceptanceBuilderRouteGithubClaudeAckProfiles.routeId, route.id),
      eq(acceptanceBuilderRouteGithubClaudeAckProfiles.routeConfigurationVersion,
        route.configurationVersion),
    )).limit(1))[0];
    if (existing) {
      if (!isDeepStrictEqual(githubClaudeAckProfileComparable(existing), values)) {
        throw new Error("GitHub Claude acknowledgement profile is already bound to different policy");
      }
      return { profile: existing, inserted: false };
    }
    const rows = await tx.insert(acceptanceBuilderRouteGithubClaudeAckProfiles)
      .values(values).returning();
    return { profile: rows[0]!, inserted: true };
  });
}

export async function resolveAcceptanceBuilderRouteGithubClaudeAckProfile(input: {
  workspaceId: string;
  routeId: string;
}): Promise<AcceptanceBuilderRouteGithubClaudeAckProfileRow | null> {
  if (!isRecord(input) || !hasExactKeys(input, ["workspaceId", "routeId"])
    || !isUuid(input.workspaceId) || !isUuid(input.routeId)) return null;
  return db.transaction(async (tx) => {
    const route = (await tx.select().from(acceptanceBuilderRoutes).where(and(
      eq(acceptanceBuilderRoutes.id, input.routeId),
      eq(acceptanceBuilderRoutes.workspaceId, input.workspaceId),
      eq(acceptanceBuilderRoutes.status, "active"),
      eq(acceptanceBuilderRoutes.adapter, "github_claude"),
    )).limit(1))[0];
    return route
      ? resolveAcceptanceBuilderRouteGithubClaudeAckProfileInTransaction(tx, {
        workspaceId: input.workspaceId, route,
      })
      : null;
  });
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

export type QueueSelectedCorrectionDispatchInput = {
  workspaceId: string;
  compiledPackId: string;
};

export type AcceptanceCorrectionDispatchInvalidationReason =
  | "head_advanced"
  | "authority_blocked"
  | "terminal"
  | "reconciled";

/** Stable identity for one aggregate, never one historical SHA alone. */
export function acceptanceCorrectionDispatchId(input: {
  recordId: string;
  headCycleId: string;
}): string {
  return uuid5Url(`acceptance-correction-dispatch:${input.recordId}:${input.headCycleId}`);
}

export const GITHUB_CORRECTION_CARRIER_PREFLIGHT_PERMISSION_CONTRACT =
  "issues_write_and_pull_requests_write_v1" as const;
const GITHUB_CORRECTION_CARRIER_PREFLIGHT_PROTOCOL_VERSION = 1 as const;
const MAX_GITHUB_CORRECTION_CARRIER_PREFLIGHT_ATTEMPTS = 8;

export type GithubCorrectionCarrierPreflightOutcome =
  | { kind: "ready"; headSha: string; baseSha: string }
  | { kind: "installation_or_permission_denied" }
  | { kind: "remote_pr_not_active"; headSha: string; baseSha: string }
  | { kind: "remote_head_mismatch"; expectedHeadSha: string; observedHeadSha: string }
  | { kind: "remote_base_mismatch"; expectedBaseSha: string; observedBaseSha: string }
  | { kind: "github_unavailable" }
  | { kind: "invalid_github_response" }
  /** Storage failed after reservation; terminally project it so retry is bounded. */
  | { kind: "storage_unavailable" };

export type ReserveGithubCorrectionCarrierPreflightInput = {
  workspaceId: string;
  dispatchId: string;
};

export type ReportGithubCorrectionCarrierPreflightInput = {
  workspaceId: string;
  preflightId: string;
  outcome: GithubCorrectionCarrierPreflightOutcome;
};

export type ReserveGithubCorrectionCarrierPreflightResult =
  | { kind: "reserved"; preflight: AcceptanceCorrectionDispatchGithubPreflightRow; inserted: true }
  | { kind: "held"; preflight: AcceptanceCorrectionDispatchGithubPreflightRow; reason: "reserved" | "attempts_exhausted" }
  | { kind: "terminal"; preflight: AcceptanceCorrectionDispatchGithubPreflightRow }
  | { kind: "not_current" };

export type ReportGithubCorrectionCarrierPreflightResult =
  | { kind: "reported"; preflight: AcceptanceCorrectionDispatchGithubPreflightRow }
  | { kind: "replayed"; preflight: AcceptanceCorrectionDispatchGithubPreflightRow }
  | { kind: "not_current" };

/** Stable per-attempt ID; an A→B→A revisit has a different dispatch ID. */
export function acceptanceCorrectionDispatchGithubPreflightId(input: {
  dispatchId: string;
  attempt: number;
}): string {
  return uuid5Url(`acceptance-correction-dispatch-github-preflight:${input.dispatchId}:${input.attempt}`);
}

function isGithubCorrectionCarrierPreflightOutcome(
  value: unknown
): value is GithubCorrectionCarrierPreflightOutcome {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "installation_or_permission_denied"
    || value.kind === "github_unavailable" || value.kind === "invalid_github_response"
    || value.kind === "storage_unavailable") {
    return hasExactKeys(value, ["kind"]);
  }
  if (value.kind === "ready" || value.kind === "remote_pr_not_active") {
    return hasExactKeys(value, ["kind", "headSha", "baseSha"])
      && isSha1(value.headSha) && isSha1(value.baseSha);
  }
  if (value.kind === "remote_head_mismatch") {
    return hasExactKeys(value, ["kind", "expectedHeadSha", "observedHeadSha"])
      && isSha1(value.expectedHeadSha) && isSha1(value.observedHeadSha);
  }
  return value.kind === "remote_base_mismatch"
    && hasExactKeys(value, ["kind", "expectedBaseSha", "observedBaseSha"])
    && isSha1(value.expectedBaseSha) && isSha1(value.observedBaseSha);
}

function githubCorrectionCarrierPreflightStatus(
  outcome: GithubCorrectionCarrierPreflightOutcome
): "ready" | "unavailable" | "indeterminate" {
  if (outcome.kind === "ready") return "ready";
  if (outcome.kind === "github_unavailable" || outcome.kind === "invalid_github_response"
    || outcome.kind === "storage_unavailable") {
    return "indeterminate";
  }
  return "unavailable";
}

function githubCorrectionCarrierPreflightComparable(
  row: AcceptanceCorrectionDispatchGithubPreflightRow
) {
  return {
    id: row.id, workspaceId: row.workspaceId, dispatchId: row.dispatchId,
    recordId: row.recordId, repo: row.repo, prNumber: row.prNumber,
    headSha: row.headSha, baseSha: row.baseSha, headCycleId: row.headCycleId,
    authorityGeneration: row.authorityGeneration,
    dispatchIdentitySha256: row.dispatchIdentitySha256,
    routeId: row.routeId, routeAdapter: row.routeAdapter,
    routeConfigurationVersion: row.routeConfigurationVersion,
    capabilityProfileId: row.capabilityProfileId,
    capabilityProfileSnapshotSha256: row.capabilityProfileSnapshotSha256,
    githubInstallationIdentitySha256: row.githubInstallationIdentitySha256,
    preflightProtocolVersion: row.preflightProtocolVersion,
    permissionContract: row.permissionContract, attempt: row.attempt,
    preflightIdentitySha256: row.preflightIdentitySha256,
    status: row.status, result: row.result,
  };
}

function hasValidGithubCorrectionCarrierPreflightResult(
  row: AcceptanceCorrectionDispatchGithubPreflightRow
): boolean {
  if (row.status === "reserved") return row.result == null && row.completedAt == null;
  return row.completedAt != null && isGithubCorrectionCarrierPreflightOutcome(row.result)
    && githubCorrectionCarrierPreflightStatus(row.result) === row.status;
}

function githubCorrectionCarrierPreflightIdentity(values: Record<string, unknown>): string {
  const {
    id: _id, status: _status, result: _result, reservedAt: _reservedAt,
    completedAt: _completedAt, createdAt: _createdAt, updatedAt: _updatedAt,
    preflightIdentitySha256: _identity, ...identity
  } = values;
  return acceptanceContextPackCanonicalSha256({
    kind: "acceptance_correction_dispatch_github_preflight", version: 1, ...identity,
  });
}

function githubCorrectionCarrierPreflightValues(input: {
  dispatch: AcceptanceCorrectionDispatchRow;
  profile: AcceptanceBuilderRouteCapabilityProfileRow;
  baseSha: string;
  attempt: number;
}) {
  if (!isGithubNativeBuilderRouteAdapter(input.dispatch.routeAdapter)
    || input.dispatch.capabilityProfileId == null
    || input.dispatch.capabilityProfileSnapshotSha256 == null) {
    throw new Error("GitHub correction preflight requires a profiled GitHub-native dispatch");
  }
  const unsigned = {
    id: acceptanceCorrectionDispatchGithubPreflightId({ dispatchId: input.dispatch.id, attempt: input.attempt }),
    workspaceId: input.dispatch.workspaceId, dispatchId: input.dispatch.id,
    recordId: input.dispatch.recordId, repo: input.dispatch.repo,
    prNumber: input.dispatch.prNumber, headSha: input.dispatch.headSha, baseSha: input.baseSha,
    headCycleId: input.dispatch.headCycleId,
    authorityGeneration: input.dispatch.authorityGeneration,
    dispatchIdentitySha256: input.dispatch.dispatchIdentitySha256,
    routeId: input.dispatch.routeId, routeAdapter: input.dispatch.routeAdapter,
    routeConfigurationVersion: input.dispatch.routeConfigurationVersion,
    capabilityProfileId: input.dispatch.capabilityProfileId,
    capabilityProfileSnapshotSha256: input.dispatch.capabilityProfileSnapshotSha256,
    githubInstallationIdentitySha256: input.profile.githubInstallationIdentitySha256,
    preflightProtocolVersion: GITHUB_CORRECTION_CARRIER_PREFLIGHT_PROTOCOL_VERSION,
    permissionContract: GITHUB_CORRECTION_CARRIER_PREFLIGHT_PERMISSION_CONTRACT,
    attempt: input.attempt, status: "reserved" as const, result: null,
  };
  return { ...unsigned, preflightIdentitySha256: githubCorrectionCarrierPreflightIdentity(unsigned) };
}

function githubCorrectionCarrierPreflightEventPayload(input: {
  preflight: AcceptanceCorrectionDispatchGithubPreflightRow;
  kind: "reserved" | "result";
  outcome?: GithubCorrectionCarrierPreflightOutcome;
}): Record<string, unknown> {
  const p = input.preflight;
  return {
    kind: input.kind === "reserved"
      ? "acceptance_correction_dispatch_github_preflight_reserved"
      : "acceptance_correction_dispatch_github_preflight_result",
    version: 1, preflightId: p.id, preflightIdentitySha256: p.preflightIdentitySha256,
    dispatch: { id: p.dispatchId, identitySha256: p.dispatchIdentitySha256 },
    recordId: p.recordId, repository: p.repo, prNumber: p.prNumber,
    headSha: p.headSha, baseSha: p.baseSha, headCycleId: p.headCycleId,
    authorityGeneration: p.authorityGeneration,
    route: { id: p.routeId, adapter: p.routeAdapter, configurationVersion: p.routeConfigurationVersion },
    capabilityProfile: {
      id: p.capabilityProfileId, snapshotSha256: p.capabilityProfileSnapshotSha256,
      githubInstallationIdentitySha256: p.githubInstallationIdentitySha256,
    },
    protocolVersion: p.preflightProtocolVersion,
    permissionContract: p.permissionContract, attempt: p.attempt,
    ...(input.outcome ? { outcome: input.outcome } : {}),
  };
}

async function hasVerifiedGithubCorrectionCarrierPreflightEventsInTransaction(
  tx: DbTransaction,
  row: AcceptanceCorrectionDispatchGithubPreflightRow
): Promise<boolean> {
  const reserved = (await tx.select().from(changeRecordEvents).where(and(
    eq(changeRecordEvents.recordId, row.recordId),
    eq(changeRecordEvents.eventKey,
      `acceptance-correction-dispatch:github-preflight:reserved:${row.headCycleId}:${row.attempt}`),
  )).limit(1))[0];
  if (!reserved || reserved.stage !== "builder_handoff" || reserved.actor !== "server:github-carrier-preflight"
    || !isDeepStrictEqual(reserved.payloadRef,
      githubCorrectionCarrierPreflightEventPayload({ preflight: row, kind: "reserved" }))) return false;
  if (row.status === "reserved") return true;
  if (!isGithubCorrectionCarrierPreflightOutcome(row.result)) return false;
  const result = (await tx.select().from(changeRecordEvents).where(and(
    eq(changeRecordEvents.recordId, row.recordId),
    eq(changeRecordEvents.eventKey,
      `acceptance-correction-dispatch:github-preflight:result:${row.headCycleId}:${row.attempt}`),
  )).limit(1))[0];
  return !!result && result.stage === "builder_handoff" && result.actor === "server:github-carrier-preflight"
    && isDeepStrictEqual(result.payloadRef,
      githubCorrectionCarrierPreflightEventPayload({ preflight: row, kind: "result", outcome: row.result }));
}

type CurrentGithubCorrectionCarrierPreflightBinding = {
  dispatch: AcceptanceCorrectionDispatchRow;
  record: ChangeRecordRow;
  route: AcceptanceBuilderRouteRow;
  profile: AcceptanceBuilderRouteCapabilityProfileRow;
  sourceSnapshot: AcceptanceContextPackSnapshotRow;
};

async function resolveCurrentGithubCorrectionCarrierPreflightBindingInTransaction(
  tx: DbTransaction,
  input: { workspaceId: string; dispatchId: string }
): Promise<CurrentGithubCorrectionCarrierPreflightBinding | null> {
  const dispatch = (await tx.select().from(acceptanceCorrectionDispatches).where(and(
    eq(acceptanceCorrectionDispatches.id, input.dispatchId),
    eq(acceptanceCorrectionDispatches.workspaceId, input.workspaceId),
    isNull(acceptanceCorrectionDispatches.invalidatedAt),
    eq(acceptanceCorrectionDispatches.deliveryState, "queued"),
    eq(acceptanceCorrectionDispatches.agentState, "not_observed"),
    eq(acceptanceCorrectionDispatches.findingsState, "not_started"),
    eq(acceptanceCorrectionDispatches.activationState, "not_started"),
    eq(acceptanceCorrectionDispatches.carrier, "github_comment"),
  )).limit(1))[0];
  if (!dispatch || !isGithubNativeBuilderRouteAdapter(dispatch.routeAdapter)
    || dispatch.capabilityProfileId == null || dispatch.capabilityProfileSnapshot == null
    || dispatch.capabilityProfileSnapshotSha256 == null) return null;
  const dispatchComparable = correctionDispatchComparable(dispatch);
  if (correctionDispatchIdentity(dispatchComparable) !== dispatch.dispatchIdentitySha256) return null;
  const queued = (await tx.select().from(changeRecordEvents).where(and(
    eq(changeRecordEvents.recordId, dispatch.recordId),
    eq(changeRecordEvents.eventKey, `acceptance-correction-dispatch:queued:${dispatch.headCycleId}`),
  )).limit(1))[0];
  if (!queued || queued.stage !== "builder_handoff" || queued.actor !== "server:dispatch-preparation"
    || !isDeepStrictEqual(queued.payloadRef, correctionDispatchQueuedEventPayload(dispatchComparable))) return null;
  const record = (await tx.select().from(changeRecords).where(and(
    eq(changeRecords.id, dispatch.recordId),
    eq(changeRecords.workspaceId, input.workspaceId),
    eq(changeRecords.repo, dispatch.repo), eq(changeRecords.prNumber, dispatch.prNumber),
  )).limit(1))[0];
  if (!record || !record.currentPrHeadAuthoritative
    || record.currentPrHeadSha !== dispatch.headSha
    || record.currentPrHeadCycleId !== dispatch.headCycleId
    || record.currentPrHeadAuthorityGeneration !== dispatch.authorityGeneration) return null;
  const sourceSnapshot = (await tx.select().from(acceptanceContextPackSnapshots).where(and(
    eq(acceptanceContextPackSnapshots.id, dispatch.sourceSnapshotId),
    eq(acceptanceContextPackSnapshots.workspaceId, input.workspaceId),
    eq(acceptanceContextPackSnapshots.recordId, dispatch.recordId),
    eq(acceptanceContextPackSnapshots.reviewJobId, dispatch.reviewJobId),
    eq(acceptanceContextPackSnapshots.repo, dispatch.repo),
    eq(acceptanceContextPackSnapshots.prNumber, dispatch.prNumber),
    eq(acceptanceContextPackSnapshots.expectedHeadSha, dispatch.headSha),
    eq(acceptanceContextPackSnapshots.status, "admitted"),
  )).limit(1))[0];
  if (!sourceSnapshot || sourceSnapshot.reviewJobId !== dispatch.headCycleId
    || !sourceSnapshot.baseSha || !isSha1(sourceSnapshot.baseSha)) return null;
  const route = (await tx.select().from(acceptanceBuilderRoutes).where(and(
    eq(acceptanceBuilderRoutes.id, dispatch.routeId),
    eq(acceptanceBuilderRoutes.workspaceId, input.workspaceId),
    eq(acceptanceBuilderRoutes.repo, dispatch.repo),
    eq(acceptanceBuilderRoutes.status, "active"),
    eq(acceptanceBuilderRoutes.adapter, dispatch.routeAdapter),
    eq(acceptanceBuilderRoutes.configurationVersion, dispatch.routeConfigurationVersion),
  )).limit(1))[0];
  if (!route) return null;
  const profile = await resolveAcceptanceBuilderRouteCapabilityProfileInTransaction(tx, {
    workspaceId: input.workspaceId, route,
  });
  if (!profile || profile.id !== dispatch.capabilityProfileId
    || profile.snapshotSha256 !== dispatch.capabilityProfileSnapshotSha256
    || !isDeepStrictEqual(profile.snapshot, dispatch.capabilityProfileSnapshot)) return null;
  return { dispatch, record, route, profile, sourceSnapshot };
}

function preflightMatchesValues(
  row: AcceptanceCorrectionDispatchGithubPreflightRow,
  values: ReturnType<typeof githubCorrectionCarrierPreflightValues>
): boolean {
  return isDeepStrictEqual(
    { ...githubCorrectionCarrierPreflightComparable(row), status: "reserved", result: null },
    githubCorrectionCarrierPreflightComparable(values as AcceptanceCorrectionDispatchGithubPreflightRow)
  );
}

/**
 * Reserves exactly one carrier-inert GitHub App authorization/PR preflight.
 * This DB package mints no token and performs no network action.
 */
export async function reserveGithubCorrectionCarrierPreflight(
  input: ReserveGithubCorrectionCarrierPreflightInput
): Promise<ReserveGithubCorrectionCarrierPreflightResult> {
  if (!isRecord(input) || !hasExactKeys(input, ["workspaceId", "dispatchId"])
    || !isUuid(input.workspaceId) || !isUuid(input.dispatchId)) {
    throw new Error("GitHub correction carrier preflight requires only workspace and dispatch");
  }
  const candidate = (await db.select({ dispatch: acceptanceCorrectionDispatches }).from(acceptanceCorrectionDispatches)
    .where(and(eq(acceptanceCorrectionDispatches.id, input.dispatchId),
      eq(acceptanceCorrectionDispatches.workspaceId, input.workspaceId))).limit(1))[0];
  if (!candidate) return { kind: "not_current" };
  const lockKey = acceptanceRecordPullRequestLockKey({
    workspaceId: input.workspaceId, recordId: candidate.dispatch.recordId,
    repo: candidate.dispatch.repo, prNumber: candidate.dispatch.prNumber,
  });
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const current = await resolveCurrentGithubCorrectionCarrierPreflightBindingInTransaction(tx, input);
    if (!current) {
      // Once finding publication has started, the strict initial preflight
      // resolver intentionally no longer admits another attempt. A worker
      // restart may nevertheless replay the already-terminal ready preflight
      // through the broader exact-current carrier resolver. It never probes,
      // retries, or creates a new preflight after delivery progress exists.
      const progressed = await resolveCurrentGithubCorrectionCarrierBindingInTransaction(tx, input);
      if (progressed) {
        return { kind: "terminal", preflight: progressed.readyPreflight };
      }
      return { kind: "not_current" };
    }
    const latest = (await tx.select().from(acceptanceCorrectionDispatchGithubPreflights).where(and(
      eq(acceptanceCorrectionDispatchGithubPreflights.workspaceId, input.workspaceId),
      eq(acceptanceCorrectionDispatchGithubPreflights.dispatchId, current.dispatch.id),
    )).orderBy(desc(acceptanceCorrectionDispatchGithubPreflights.attempt)).limit(1))[0];
    if (latest) {
      if (!hasValidGithubCorrectionCarrierPreflightResult(latest)) {
        throw new Error("GitHub correction carrier preflight terminal result is invalid");
      }
      const expected = githubCorrectionCarrierPreflightValues({
        dispatch: current.dispatch, profile: current.profile, baseSha: current.sourceSnapshot.baseSha!, attempt: latest.attempt,
      });
      if (!preflightMatchesValues(latest, expected)) {
        throw new Error("GitHub correction carrier preflight replay is bound to different dispatch provenance");
      }
      if (!await hasVerifiedGithubCorrectionCarrierPreflightEventsInTransaction(tx, latest)) {
        throw new Error("GitHub correction carrier preflight event custody is missing or does not match its attempt");
      }
      if (latest.status === "reserved") return { kind: "held", preflight: latest, reason: "reserved" };
      if (latest.status === "ready" || latest.status === "unavailable") {
        return { kind: "terminal", preflight: latest };
      }
      if (latest.status !== "indeterminate") {
        throw new Error("GitHub correction carrier preflight has invalid status");
      }
      if (latest.attempt >= MAX_GITHUB_CORRECTION_CARRIER_PREFLIGHT_ATTEMPTS) {
        return { kind: "held", preflight: latest, reason: "attempts_exhausted" };
      }
    }
    const values = githubCorrectionCarrierPreflightValues({
      dispatch: current.dispatch, profile: current.profile, baseSha: current.sourceSnapshot.baseSha!, attempt: (latest?.attempt ?? 0) + 1,
    });
    const event = await appendChangeRecordEventsAtomicallyInTransaction(tx, [{
      recordId: current.record.id,
      eventKey: `acceptance-correction-dispatch:github-preflight:reserved:${current.dispatch.headCycleId}:${values.attempt}`,
      stage: "builder_handoff", actor: "server:github-carrier-preflight",
      payloadRef: githubCorrectionCarrierPreflightEventPayload({
        preflight: values as AcceptanceCorrectionDispatchGithubPreflightRow, kind: "reserved",
      }),
    }]);
    if (!event.events[0]!.inserted) {
      throw new Error("GitHub correction carrier preflight reservation event unexpectedly replayed");
    }
    const rows = await tx.insert(acceptanceCorrectionDispatchGithubPreflights).values(values).returning();
    return { kind: "reserved", preflight: rows[0]!, inserted: true };
  });
}

/**
 * Reports a closed carrier-preflight result after the Console's carrier-inert
 * GitHub authorization/PR probe. A stale head/profile never receives a result
 * projection.
 */
export async function reportGithubCorrectionCarrierPreflight(
  input: ReportGithubCorrectionCarrierPreflightInput
): Promise<ReportGithubCorrectionCarrierPreflightResult> {
  if (!isRecord(input) || !hasExactKeys(input, ["workspaceId", "preflightId", "outcome"])
    || !isUuid(input.workspaceId) || !isUuid(input.preflightId)
    || !isGithubCorrectionCarrierPreflightOutcome(input.outcome)) {
    throw new Error("GitHub correction carrier preflight report requires only workspace, preflight, and closed outcome");
  }
  const candidate = (await db.select({ preflight: acceptanceCorrectionDispatchGithubPreflights }).from(acceptanceCorrectionDispatchGithubPreflights)
    .where(and(eq(acceptanceCorrectionDispatchGithubPreflights.id, input.preflightId),
      eq(acceptanceCorrectionDispatchGithubPreflights.workspaceId, input.workspaceId))).limit(1))[0];
  if (!candidate) return { kind: "not_current" };
  const lockKey = acceptanceRecordPullRequestLockKey({
    workspaceId: input.workspaceId, recordId: candidate.preflight.recordId,
    repo: candidate.preflight.repo, prNumber: candidate.preflight.prNumber,
  });
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const preflight = (await tx.select().from(acceptanceCorrectionDispatchGithubPreflights).where(and(
      eq(acceptanceCorrectionDispatchGithubPreflights.id, input.preflightId),
      eq(acceptanceCorrectionDispatchGithubPreflights.workspaceId, input.workspaceId),
    )).limit(1))[0];
    if (!preflight) return { kind: "not_current" };
    const current = await resolveCurrentGithubCorrectionCarrierPreflightBindingInTransaction(tx, {
      workspaceId: input.workspaceId, dispatchId: preflight.dispatchId,
    });
    if (!current) return { kind: "not_current" };
    const expected = githubCorrectionCarrierPreflightValues({
      dispatch: current.dispatch, profile: current.profile, baseSha: current.sourceSnapshot.baseSha!, attempt: preflight.attempt,
    });
    if (!preflightMatchesValues(preflight, expected)) return { kind: "not_current" };
    if (!hasValidGithubCorrectionCarrierPreflightResult(preflight)) {
      throw new Error("GitHub correction carrier preflight terminal result is invalid");
    }
    if (!await hasVerifiedGithubCorrectionCarrierPreflightEventsInTransaction(tx, preflight)) {
      throw new Error("GitHub correction carrier preflight event custody is missing or does not match its attempt");
    }
    if (input.outcome.kind === "ready" && (input.outcome.headSha !== current.dispatch.headSha
      || input.outcome.baseSha !== current.sourceSnapshot.baseSha)) {
      return { kind: "not_current" };
    }
    if (input.outcome.kind === "remote_head_mismatch"
      && (input.outcome.expectedHeadSha !== current.dispatch.headSha
        || input.outcome.expectedHeadSha === input.outcome.observedHeadSha)) {
      return { kind: "not_current" };
    }
    if (input.outcome.kind === "remote_base_mismatch"
      && (input.outcome.expectedBaseSha !== current.sourceSnapshot.baseSha
        || input.outcome.expectedBaseSha === input.outcome.observedBaseSha)) {
      return { kind: "not_current" };
    }
    if (preflight.status !== "reserved") {
      if (isDeepStrictEqual(preflight.result, input.outcome)) return { kind: "replayed", preflight };
      throw new Error("GitHub correction carrier preflight outcome is already terminal");
    }
    const status = githubCorrectionCarrierPreflightStatus(input.outcome);
    const projected = { ...preflight, status, result: input.outcome, completedAt: new Date() } as AcceptanceCorrectionDispatchGithubPreflightRow;
    const event = await appendChangeRecordEventsAtomicallyInTransaction(tx, [{
      recordId: current.record.id,
      eventKey: `acceptance-correction-dispatch:github-preflight:result:${current.dispatch.headCycleId}:${preflight.attempt}`,
      stage: "builder_handoff", actor: "server:github-carrier-preflight",
      payloadRef: githubCorrectionCarrierPreflightEventPayload({ preflight: projected, kind: "result", outcome: input.outcome }),
    }]);
    if (!event.events[0]!.inserted) {
      throw new Error("GitHub correction carrier preflight result event unexpectedly replayed");
    }
    const rows = await tx.update(acceptanceCorrectionDispatchGithubPreflights).set({
      status, result: input.outcome, completedAt: new Date(), updatedAt: new Date(),
    }).where(and(eq(acceptanceCorrectionDispatchGithubPreflights.id, preflight.id),
      eq(acceptanceCorrectionDispatchGithubPreflights.status, "reserved"))).returning();
    if (rows.length !== 1) {
      throw new Error("GitHub correction carrier preflight result lost its reserved precondition");
    }
    return { kind: "reported", preflight: rows[0]! };
  });
}

const GITHUB_CORRECTION_FINDING_PUBLICATION_PROTOCOL_VERSION = 1 as const;
const GITHUB_CORRECTION_ACTIVATION_PROTOCOL_VERSION = 1 as const;
const MAX_GITHUB_CORRECTION_COMMENT_ID_DIGITS = 40;

export type GithubCorrectionFindingPublicationOutcome =
  | { kind: "published"; githubCommentId: string; githubCommentUrl: string }
  | { kind: "bounded_failed"; reason: "github_rejected" | "invalid_db_issued_body" }
  | { kind: "unknown_post_outcome"; reason: "github_unavailable" | "ambiguous_response" };

export type GithubCorrectionActivationOutcome =
  | { kind: "carrier_accepted"; githubCommentId: string; githubCommentUrl: string }
  | { kind: "bounded_failed"; reason: "github_rejected" | "invalid_db_issued_body" }
  | { kind: "unknown_post_outcome"; reason: "github_unavailable" | "ambiguous_response" };

export type ReserveNextGithubCorrectionFindingPublicationInput = {
  workspaceId: string;
  dispatchId: string;
};

export type ReserveNextGithubCorrectionFindingPublicationResult =
  | { kind: "reserved"; publication: AcceptanceCorrectionDispatchGithubFindingPublicationRow; body: string }
  | { kind: "complete"; expected: number; published: number; boundedFailed: number }
  | { kind: "held"; reason: "reserved" | "ambiguous_hold" }
  | { kind: "not_current" };

export type ReportGithubCorrectionFindingPublicationInput = {
  workspaceId: string;
  publicationId: string;
  outcome: GithubCorrectionFindingPublicationOutcome;
};

export type ReportGithubCorrectionFindingPublicationResult =
  | { kind: "reported"; publication: AcceptanceCorrectionDispatchGithubFindingPublicationRow }
  | { kind: "replayed"; publication: AcceptanceCorrectionDispatchGithubFindingPublicationRow }
  | { kind: "not_current" };

export type ReserveGithubCorrectionActivationInput = {
  workspaceId: string;
  dispatchId: string;
};

export type ReserveGithubCorrectionActivationResult =
  | {
    kind: "reserved";
    activation: AcceptanceCorrectionDispatchGithubActivationRow;
    body: string;
    packetBundleBase64url: string;
    packetBundleSha256: string;
    recipient: "codex" | "claude";
  }
  | {
    kind: "bounded_failed";
    activationId: string;
    reason: "github_rejected" | "activation_body_too_large" | "invalid_db_issued_body";
  }
  | {
    kind: "carrier_accepted";
    activationId: string;
    githubCommentId: string;
    githubCommentUrl: string;
  }
  | { kind: "not_ready" }
  | { kind: "held"; reason: "reserved" | "ambiguous_hold" }
  | { kind: "not_current" };

export type ReportGithubCorrectionActivationInput = {
  workspaceId: string;
  activationId: string;
  outcome: GithubCorrectionActivationOutcome;
};

export type ReportGithubCorrectionActivationResult =
  | { kind: "reported"; activation: AcceptanceCorrectionDispatchGithubActivationRow }
  | { kind: "replayed"; activation: AcceptanceCorrectionDispatchGithubActivationRow }
  | { kind: "not_current" };

export type DurableCorrectionDispatchFallbackLane =
  | "github_findings_and_jace"
  | "jace_only";

export type DurableCorrectionDispatchFallbackTrigger =
  | {
    stage: "github_preflight";
    preflightId: string;
    preflightIdentitySha256: string;
    attempt: number;
    reason: "installation_or_permission_denied" | "github_unavailable"
      | "invalid_github_response";
  }
  | {
    stage: "github_finding";
    publicationId: string;
    publicationIdentitySha256: string;
    packetId: string;
    reason: "github_unavailable" | "ambiguous_response";
  }
  | {
    stage: "github_activation";
    activationId: string;
    activationIdentitySha256: string;
    reason: "github_rejected" | "activation_body_too_large"
      | "invalid_db_issued_body" | "github_unavailable" | "ambiguous_response";
  }
  | {
    stage: "server_observation";
    readyPreflightId: string;
    readyPreflightIdentitySha256: string;
    reason: "selected_github_carrier_not_accepted";
  };

export type DurableCorrectionDispatchFallback = {
  kind: "acceptance_correction_dispatch_durable_fallback";
  version: 1;
  id: string;
  workspaceId: string;
  recordId: string;
  repo: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  headCycleId: string;
  authorityGeneration: number;
  dispatch: { id: string; identitySha256: string };
  route: {
    id: string;
    adapter: "github_codex" | "github_claude";
    configurationVersion: number;
    capabilityProfileId: string;
    capabilityProfileSnapshotSha256: string;
  };
  contextPack: {
    id: string;
    sha256: string;
    sourceSnapshotId: string;
    sourceCustodyIdentitySha256: string;
  };
  packets: { ids: string[]; setSha256: string; payloadSetSha256: string };
  trigger: DurableCorrectionDispatchFallbackTrigger;
  priorAggregate: {
    deliveryState: "queued" | "ambiguous_hold" | "failed";
    agentState: "not_observed";
    findingsState: "not_started" | "reserved" | "terminal" | "ambiguous_hold";
    activationState: "not_started" | "reserved" | "ambiguous_hold" | "failed";
  };
  lane: DurableCorrectionDispatchFallbackLane;
  findingCoverageSha256: string;
  publishedFindings: Array<{
    publicationId: string;
    publicationIdentitySha256: string;
    packetId: string;
    githubCommentId: string;
    githubCommentUrl: string;
  }>;
  notice: { carrier: "durable_notice"; body: string; bodySha256: string };
  truthBoundary: {
    vendorActivation: "not_proven";
    agentStarted: "not_proven";
    agentAcknowledged: "not_proven";
    repairHead: "not_proven";
  };
  fallbackIdentitySha256: string;
};

export type RecordDurableCorrectionDispatchFallbackInput = {
  workspaceId: string;
  dispatchId: string;
};

export type RecordDurableCorrectionDispatchFallbackResult =
  | { kind: "recorded"; fallback: DurableCorrectionDispatchFallback }
  | { kind: "replayed"; fallback: DurableCorrectionDispatchFallback }
  | { kind: "not_eligible" }
  | { kind: "not_current" };

export type ReadDurableCorrectionDispatchFallbackResult =
  | { kind: "found"; fallback: DurableCorrectionDispatchFallback }
  | { kind: "absent" }
  | { kind: "not_current" };

function isPositiveGithubCommentId(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= MAX_GITHUB_CORRECTION_COMMENT_ID_DIGITS
    && /^[1-9][0-9]*$/.test(value);
}

function canonicalGithubCorrectionCommentUrl(input: {
  repo: string;
  prNumber: number;
  githubCommentId: string;
}): string {
  return `https://github.com/${input.repo}/pull/${input.prNumber}#issuecomment-${input.githubCommentId}`;
}

function isGithubCorrectionFindingPublicationOutcome(
  value: unknown
): value is GithubCorrectionFindingPublicationOutcome {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "published") {
    return hasExactKeys(value, ["kind", "githubCommentId", "githubCommentUrl"])
      && isPositiveGithubCommentId(value.githubCommentId)
      && typeof value.githubCommentUrl === "string";
  }
  if (value.kind === "bounded_failed") {
    return hasExactKeys(value, ["kind", "reason"])
      && (value.reason === "github_rejected" || value.reason === "invalid_db_issued_body");
  }
  return value.kind === "unknown_post_outcome"
    && hasExactKeys(value, ["kind", "reason"])
    && (value.reason === "github_unavailable" || value.reason === "ambiguous_response");
}

function isGithubCorrectionActivationOutcome(
  value: unknown
): value is GithubCorrectionActivationOutcome {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "carrier_accepted") {
    return hasExactKeys(value, ["kind", "githubCommentId", "githubCommentUrl"])
      && isPositiveGithubCommentId(value.githubCommentId)
      && typeof value.githubCommentUrl === "string";
  }
  if (value.kind === "bounded_failed") {
    return hasExactKeys(value, ["kind", "reason"])
      && (value.reason === "github_rejected" || value.reason === "invalid_db_issued_body");
  }
  return value.kind === "unknown_post_outcome"
    && hasExactKeys(value, ["kind", "reason"])
    && (value.reason === "github_unavailable" || value.reason === "ambiguous_response");
}

/** Stable IDs bind an A-B-A head revisit to its new dispatch/head-cycle ID. */
export function acceptanceCorrectionDispatchGithubFindingPublicationId(input: {
  dispatchId: string;
  packetId: string;
}): string {
  return uuid5Url(`acceptance-correction-dispatch-github-finding:${input.dispatchId}:${input.packetId}`);
}

export function acceptanceCorrectionDispatchGithubActivationId(input: {
  dispatchId: string;
}): string {
  return uuid5Url(`acceptance-correction-dispatch-github-activation:${input.dispatchId}`);
}

type CurrentGithubCorrectionCarrierBinding = {
  dispatch: AcceptanceCorrectionDispatchRow;
  record: ChangeRecordRow;
  route: AcceptanceBuilderRouteRow;
  profile: AcceptanceBuilderRouteCapabilityProfileRow;
  sourceSnapshot: AcceptanceContextPackSnapshotRow;
  custody: AcceptanceContextPackCustodyResolution;
  readyPreflight: AcceptanceCorrectionDispatchGithubPreflightRow;
};

function correctionDispatchOriginalComparable(
  dispatch: AcceptanceCorrectionDispatchRow
): ReturnType<typeof correctionDispatchComparable> {
  return {
    ...correctionDispatchComparable(dispatch),
    deliveryState: "queued",
    agentState: "not_observed",
    findingsState: "not_started",
    activationState: "not_started",
  };
}

/**
 * Resolves immutable custody independently from the preflight reservation
 * resolver: aggregate findings/activation state is allowed to advance while
 * the original queued identity and event remain frozen at their initial values.
 */
async function resolveCurrentGithubCorrectionCarrierBindingInTransaction(
  tx: DbTransaction,
  input: { workspaceId: string; dispatchId: string }
): Promise<CurrentGithubCorrectionCarrierBinding | null> {
  const dispatch = (await tx.select().from(acceptanceCorrectionDispatches).where(and(
    eq(acceptanceCorrectionDispatches.id, input.dispatchId),
    eq(acceptanceCorrectionDispatches.workspaceId, input.workspaceId),
    isNull(acceptanceCorrectionDispatches.invalidatedAt),
    eq(acceptanceCorrectionDispatches.carrier, "github_comment"),
  )).limit(1))[0];
  if (!dispatch || !isGithubNativeBuilderRouteAdapter(dispatch.routeAdapter)
    || dispatch.capabilityProfileId == null || dispatch.capabilityProfileSnapshot == null
    || dispatch.capabilityProfileSnapshotSha256 == null) return null;
  const original = correctionDispatchOriginalComparable(dispatch);
  if (correctionDispatchIdentity(original) !== dispatch.dispatchIdentitySha256) return null;
  const queued = (await tx.select().from(changeRecordEvents).where(and(
    eq(changeRecordEvents.recordId, dispatch.recordId),
    eq(changeRecordEvents.eventKey, `acceptance-correction-dispatch:queued:${dispatch.headCycleId}`),
  )).limit(1))[0];
  if (!queued || queued.stage !== "builder_handoff" || queued.actor !== "server:dispatch-preparation"
    || !isDeepStrictEqual(queued.payloadRef, correctionDispatchQueuedEventPayload(original))) return null;
  const record = (await tx.select().from(changeRecords).where(and(
    eq(changeRecords.id, dispatch.recordId),
    eq(changeRecords.workspaceId, input.workspaceId),
    eq(changeRecords.repo, dispatch.repo),
    eq(changeRecords.prNumber, dispatch.prNumber),
  )).limit(1))[0];
  if (!record || !record.currentPrHeadAuthoritative
    || record.currentPrHeadSha !== dispatch.headSha
    || record.currentPrHeadCycleId !== dispatch.headCycleId
    || record.currentPrHeadAuthorityGeneration !== dispatch.authorityGeneration) return null;
  const sourceSnapshot = (await tx.select().from(acceptanceContextPackSnapshots).where(and(
    eq(acceptanceContextPackSnapshots.id, dispatch.sourceSnapshotId),
    eq(acceptanceContextPackSnapshots.workspaceId, input.workspaceId),
    eq(acceptanceContextPackSnapshots.recordId, dispatch.recordId),
    eq(acceptanceContextPackSnapshots.reviewJobId, dispatch.reviewJobId),
    eq(acceptanceContextPackSnapshots.repo, dispatch.repo),
    eq(acceptanceContextPackSnapshots.prNumber, dispatch.prNumber),
    eq(acceptanceContextPackSnapshots.expectedHeadSha, dispatch.headSha),
    eq(acceptanceContextPackSnapshots.status, "admitted"),
  )).limit(1))[0];
  if (!sourceSnapshot || sourceSnapshot.reviewJobId !== dispatch.headCycleId
    || !sourceSnapshot.baseSha || !isSha1(sourceSnapshot.baseSha)) return null;
  const route = (await tx.select().from(acceptanceBuilderRoutes).where(and(
    eq(acceptanceBuilderRoutes.id, dispatch.routeId),
    eq(acceptanceBuilderRoutes.workspaceId, input.workspaceId),
    eq(acceptanceBuilderRoutes.repo, dispatch.repo),
    eq(acceptanceBuilderRoutes.status, "active"),
    eq(acceptanceBuilderRoutes.adapter, dispatch.routeAdapter),
    eq(acceptanceBuilderRoutes.configurationVersion, dispatch.routeConfigurationVersion),
  )).limit(1))[0];
  if (!route) return null;
  const profile = await resolveAcceptanceBuilderRouteCapabilityProfileInTransaction(tx, {
    workspaceId: input.workspaceId, route,
  });
  if (!profile || profile.id !== dispatch.capabilityProfileId
    || profile.snapshotSha256 !== dispatch.capabilityProfileSnapshotSha256
    || !isDeepStrictEqual(profile.snapshot, dispatch.capabilityProfileSnapshot)) return null;
  const custody = await resolveAcceptanceContextPackCustodyInTransaction(tx, {
    workspaceId: input.workspaceId,
    sourceSnapshotId: dispatch.sourceSnapshotId,
  });
  if (custody.sourceSnapshot.baseSha !== sourceSnapshot.baseSha
    || custody.sourceSnapshot.expectedHeadSha !== dispatch.headSha
    || custody.sourceSnapshot.reviewJobId !== dispatch.headCycleId
    || custody.sourceSnapshot.acceptanceContractId !== dispatch.acceptanceContractId
    || custody.sourceSnapshot.acceptanceContractVersion !== dispatch.acceptanceContractVersion
    || custody.acceptanceContractSha256 !== dispatch.acceptanceContractSha256
    || !isDeepStrictEqual(custody.sourceSnapshot.packetIds, dispatch.packetIds)
    || custody.sourceSnapshot.packetSetSha256 !== dispatch.packetSetSha256
    || custody.sourceSnapshot.correctionPacketPayloadSetSha256 !== dispatch.correctionPacketPayloadSetSha256
    || custody.correctionPacketPayloadSetSha256 !== dispatch.correctionPacketPayloadSetSha256) return null;
  const compiledPack = (await tx.select().from(acceptanceCompiledContextPacks).where(and(
    eq(acceptanceCompiledContextPacks.id, dispatch.compiledPackId),
    eq(acceptanceCompiledContextPacks.workspaceId, input.workspaceId),
    eq(acceptanceCompiledContextPacks.sourceSnapshotId, dispatch.sourceSnapshotId),
  )).limit(1))[0];
  if (!compiledPack || compiledPack.packSha256 !== dispatch.compiledPackSha256
    || compiledPack.compilerVersion !== dispatch.compilerVersion
    || compiledPack.policyVersion !== dispatch.policyVersion
    || compiledPack.jsonSha256 !== dispatch.jsonSha256
    || compiledPack.markdownSha256 !== dispatch.markdownSha256
    || compiledPack.sourceCustodyIdentitySha256 !== dispatch.sourceCustodyIdentitySha256) return null;
  const reconstructedPack = parseCompiledAcceptanceContextPack({
    kind: "compiled_acceptance_context_pack", version: 1,
    binding: compiledPack.binding,
    compiler: {
      version: compiledPack.compilerVersion, policyVersion: compiledPack.policyVersion,
      byteCounter: "utf8_byte_upper_bound_v1", byteBudget: COMPILED_PACK_BYTE_BUDGET,
    },
    manifest: compiledPack.manifest,
    sourceCustodyReceipt: compiledPack.sourceCustodyReceipt,
    exactHeadDependencyTreeProofs: compiledPack.exactHeadDependencyTreeProofs,
    representations: {
      jsonSha256: compiledPack.jsonSha256,
      markdownSha256: compiledPack.markdownSha256,
    },
    renderedByteCount: compiledPack.renderedByteCount,
    packSha256: compiledPack.packSha256,
  });
  if (!reconstructedPack || compiledPackIdentity(reconstructedPack) !== compiledPack.packSha256
    || !bindingMatchesCustody(compiledPack.binding, custody)
    || !receiptMatchesCustody(compiledPack.sourceCustodyReceipt, custody)) return null;
  const readyPreflight = (await tx.select().from(acceptanceCorrectionDispatchGithubPreflights).where(and(
    eq(acceptanceCorrectionDispatchGithubPreflights.workspaceId, input.workspaceId),
    eq(acceptanceCorrectionDispatchGithubPreflights.dispatchId, dispatch.id),
  )).orderBy(desc(acceptanceCorrectionDispatchGithubPreflights.attempt)).limit(1))[0];
  if (!readyPreflight || readyPreflight.status !== "ready"
    || !isGithubCorrectionCarrierPreflightOutcome(readyPreflight.result)
    || readyPreflight.result.kind !== "ready"
    || readyPreflight.result.headSha !== dispatch.headSha
    || readyPreflight.result.baseSha !== sourceSnapshot.baseSha
    || !preflightMatchesValues(readyPreflight, githubCorrectionCarrierPreflightValues({
      dispatch, profile, baseSha: sourceSnapshot.baseSha, attempt: readyPreflight.attempt,
    }))
    || !await hasVerifiedGithubCorrectionCarrierPreflightEventsInTransaction(tx, readyPreflight)) return null;
  return { dispatch, record, route, profile, sourceSnapshot, custody, readyPreflight };
}

function githubCorrectionFindingPublicationIdentity(values: Record<string, unknown>): string {
  const {
    id: _id, publicationIdentitySha256: _identity, body: _body,
    status: _status, githubCommentId: _commentId, githubCommentUrl: _commentUrl,
    resultReason: _reason, reservedAt: _reservedAt, completedAt: _completedAt,
    createdAt: _createdAt, updatedAt: _updatedAt, ...identity
  } = values;
  return acceptanceContextPackCanonicalSha256({
    kind: "acceptance_correction_dispatch_github_finding_publication",
    version: 1,
    ...identity,
  });
}

function githubCorrectionActivationIdentity(values: Record<string, unknown>): string {
  const {
    id: _id, activationIdentitySha256: _identity, body: _body,
    status: _status, githubCommentId: _commentId, githubCommentUrl: _commentUrl,
    resultReason: _reason, reservedAt: _reservedAt, completedAt: _completedAt,
    createdAt: _createdAt, updatedAt: _updatedAt, ...identity
  } = values;
  return acceptanceContextPackCanonicalSha256({
    kind: "acceptance_correction_dispatch_github_activation",
    version: 1,
    ...identity,
  });
}

function githubCorrectionFindingPublicationComparable(
  row: AcceptanceCorrectionDispatchGithubFindingPublicationRow
) {
  return {
    id: row.id, workspaceId: row.workspaceId, dispatchId: row.dispatchId,
    recordId: row.recordId, packetId: row.packetId, criterionId: row.criterionId,
    repo: row.repo, prNumber: row.prNumber, headSha: row.headSha, baseSha: row.baseSha,
    headCycleId: row.headCycleId, authorityGeneration: row.authorityGeneration,
    dispatchIdentitySha256: row.dispatchIdentitySha256,
    routeId: row.routeId, routeAdapter: row.routeAdapter,
    routeConfigurationVersion: row.routeConfigurationVersion,
    capabilityProfileId: row.capabilityProfileId,
    capabilityProfileSnapshotSha256: row.capabilityProfileSnapshotSha256,
    githubInstallationIdentitySha256: row.githubInstallationIdentitySha256,
    readyPreflightId: row.readyPreflightId,
    readyPreflightIdentitySha256: row.readyPreflightIdentitySha256,
    publicationProtocolVersion: row.publicationProtocolVersion,
    publicationIdentitySha256: row.publicationIdentitySha256,
    carrier: row.carrier, packetPayloadSha256: row.packetPayloadSha256,
    body: row.body, bodySha256: row.bodySha256,
  };
}

function githubCorrectionActivationComparable(
  row: AcceptanceCorrectionDispatchGithubActivationRow
) {
  return {
    id: row.id, workspaceId: row.workspaceId, dispatchId: row.dispatchId,
    recordId: row.recordId, repo: row.repo, prNumber: row.prNumber,
    headSha: row.headSha, baseSha: row.baseSha, headCycleId: row.headCycleId,
    authorityGeneration: row.authorityGeneration,
    dispatchIdentitySha256: row.dispatchIdentitySha256,
    routeId: row.routeId, routeAdapter: row.routeAdapter,
    routeConfigurationVersion: row.routeConfigurationVersion,
    capabilityProfileId: row.capabilityProfileId,
    capabilityProfileSnapshotSha256: row.capabilityProfileSnapshotSha256,
    githubInstallationIdentitySha256: row.githubInstallationIdentitySha256,
    readyPreflightId: row.readyPreflightId,
    readyPreflightIdentitySha256: row.readyPreflightIdentitySha256,
    carrier: row.carrier, recipient: row.recipient,
    findingCoverageSha256: row.findingCoverageSha256,
    packetSetSha256: row.packetSetSha256,
    correctionPacketPayloadSetSha256: row.correctionPacketPayloadSetSha256,
    packetBundleSha256: row.packetBundleSha256,
    body: row.body, bodySha256: row.bodySha256,
    activationProtocolVersion: row.activationProtocolVersion,
    activationIdentitySha256: row.activationIdentitySha256,
  };
}

function githubCorrectionFindingEventPayload(input: {
  publication: AcceptanceCorrectionDispatchGithubFindingPublicationRow;
  kind: "reserved" | "result";
}): Record<string, unknown> {
  const row = input.publication;
  return {
    kind: input.kind === "reserved"
      ? "acceptance_correction_dispatch_github_finding_reserved"
      : "acceptance_correction_dispatch_github_finding_result",
    version: 1,
    publicationId: row.id,
    publicationIdentitySha256: row.publicationIdentitySha256,
    dispatch: { id: row.dispatchId, identitySha256: row.dispatchIdentitySha256 },
    recordId: row.recordId, packetId: row.packetId, criterionId: row.criterionId,
    repository: row.repo, prNumber: row.prNumber,
    headSha: row.headSha, baseSha: row.baseSha, headCycleId: row.headCycleId,
    authorityGeneration: row.authorityGeneration,
    route: { id: row.routeId, adapter: row.routeAdapter, configurationVersion: row.routeConfigurationVersion },
    capabilityProfile: {
      id: row.capabilityProfileId,
      snapshotSha256: row.capabilityProfileSnapshotSha256,
      githubInstallationIdentitySha256: row.githubInstallationIdentitySha256,
    },
    readyPreflight: { id: row.readyPreflightId, identitySha256: row.readyPreflightIdentitySha256 },
    carrier: row.carrier, protocolVersion: row.publicationProtocolVersion,
    packetPayloadSha256: row.packetPayloadSha256, bodySha256: row.bodySha256,
    ...(input.kind === "result" ? {
      result: {
        status: row.status,
        githubCommentId: row.githubCommentId,
        githubCommentUrl: row.githubCommentUrl,
        reason: row.resultReason,
      },
    } : {}),
  };
}

function githubCorrectionActivationEventPayload(input: {
  activation: AcceptanceCorrectionDispatchGithubActivationRow;
  kind: "reserved" | "result";
}): Record<string, unknown> {
  const row = input.activation;
  return {
    kind: input.kind === "reserved"
      ? "acceptance_correction_dispatch_github_activation_reserved"
      : "acceptance_correction_dispatch_github_activation_result",
    version: 1,
    activationId: row.id,
    activationIdentitySha256: row.activationIdentitySha256,
    dispatch: { id: row.dispatchId, identitySha256: row.dispatchIdentitySha256 },
    recordId: row.recordId, repository: row.repo, prNumber: row.prNumber,
    headSha: row.headSha, baseSha: row.baseSha, headCycleId: row.headCycleId,
    authorityGeneration: row.authorityGeneration,
    route: {
      id: row.routeId, adapter: row.routeAdapter,
      configurationVersion: row.routeConfigurationVersion, recipient: row.recipient,
    },
    capabilityProfile: {
      id: row.capabilityProfileId,
      snapshotSha256: row.capabilityProfileSnapshotSha256,
      githubInstallationIdentitySha256: row.githubInstallationIdentitySha256,
    },
    readyPreflight: { id: row.readyPreflightId, identitySha256: row.readyPreflightIdentitySha256 },
    carrier: row.carrier, protocolVersion: row.activationProtocolVersion,
    findingCoverageSha256: row.findingCoverageSha256,
    packetSetSha256: row.packetSetSha256,
    correctionPacketPayloadSetSha256: row.correctionPacketPayloadSetSha256,
    packetBundleSha256: row.packetBundleSha256, bodySha256: row.bodySha256,
    ...(input.kind === "result" ? {
      result: {
        status: row.status,
        githubCommentId: row.githubCommentId,
        githubCommentUrl: row.githubCommentUrl,
        reason: row.resultReason,
      },
    } : {}),
  };
}

async function hasVerifiedGithubCorrectionFindingEventsInTransaction(
  tx: DbTransaction,
  row: AcceptanceCorrectionDispatchGithubFindingPublicationRow
): Promise<boolean> {
  const reserved = (await tx.select().from(changeRecordEvents).where(and(
    eq(changeRecordEvents.recordId, row.recordId),
    eq(changeRecordEvents.eventKey,
      `acceptance-correction-dispatch:github-finding:reserved:${row.headCycleId}:${row.packetId}`),
  )).limit(1))[0];
  if (!reserved || reserved.stage !== "builder_handoff" || reserved.actor !== "server:github-correction-carrier"
    || !isDeepStrictEqual(reserved.payloadRef,
      githubCorrectionFindingEventPayload({ publication: row, kind: "reserved" }))) return false;
  if (row.status === "reserved") return row.completedAt == null
    && row.githubCommentId == null && row.githubCommentUrl == null && row.resultReason == null;
  const result = (await tx.select().from(changeRecordEvents).where(and(
    eq(changeRecordEvents.recordId, row.recordId),
    eq(changeRecordEvents.eventKey,
      `acceptance-correction-dispatch:github-finding:result:${row.headCycleId}:${row.packetId}`),
  )).limit(1))[0];
  return row.completedAt != null && !!result && result.stage === "builder_handoff"
    && result.actor === "server:github-correction-carrier"
    && isDeepStrictEqual(result.payloadRef,
      githubCorrectionFindingEventPayload({ publication: row, kind: "result" }));
}

async function hasVerifiedGithubCorrectionActivationEventsInTransaction(
  tx: DbTransaction,
  row: AcceptanceCorrectionDispatchGithubActivationRow
): Promise<boolean> {
  const reserved = (await tx.select().from(changeRecordEvents).where(and(
    eq(changeRecordEvents.recordId, row.recordId),
    eq(changeRecordEvents.eventKey,
      `acceptance-correction-dispatch:github-activation:reserved:${row.headCycleId}`),
  )).limit(1))[0];
  if (!reserved || reserved.stage !== "builder_handoff" || reserved.actor !== "server:github-correction-carrier"
    || !isDeepStrictEqual(reserved.payloadRef,
      githubCorrectionActivationEventPayload({ activation: row, kind: "reserved" }))) return false;
  if (row.status === "reserved") return row.completedAt == null
    && row.githubCommentId == null && row.githubCommentUrl == null && row.resultReason == null;
  const result = (await tx.select().from(changeRecordEvents).where(and(
    eq(changeRecordEvents.recordId, row.recordId),
    eq(changeRecordEvents.eventKey,
      `acceptance-correction-dispatch:github-activation:result:${row.headCycleId}`),
  )).limit(1))[0];
  return row.completedAt != null && !!result && result.stage === "builder_handoff"
    && result.actor === "server:github-correction-carrier"
    && isDeepStrictEqual(result.payloadRef,
      githubCorrectionActivationEventPayload({ activation: row, kind: "result" }));
}

async function assertUnusedGithubCorrectionCommentReceiptInTransaction(
  tx: DbTransaction,
  input: { githubCommentId: string; ownFindingId?: string; ownActivationId?: string }
): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`github-correction-comment-receipt:${input.githubCommentId}`}))`);
  const findings = await tx.select({ id: acceptanceCorrectionDispatchGithubFindingPublications.id })
    .from(acceptanceCorrectionDispatchGithubFindingPublications)
    .where(eq(acceptanceCorrectionDispatchGithubFindingPublications.githubCommentId, input.githubCommentId));
  const activations = await tx.select({ id: acceptanceCorrectionDispatchGithubActivations.id })
    .from(acceptanceCorrectionDispatchGithubActivations)
    .where(eq(acceptanceCorrectionDispatchGithubActivations.githubCommentId, input.githubCommentId));
  if (findings.some((row) => row.id !== input.ownFindingId)
    || activations.some((row) => row.id !== input.ownActivationId)) {
    throw new Error("GitHub correction comment receipt is already bound to another finding or activation");
  }
}

function packetPayloadSha256(packet: Record<string, unknown>): string {
  return acceptanceContextPackCanonicalSha256(packet);
}

function correctionPacketById(
  current: CurrentGithubCorrectionCarrierBinding,
  packetId: string
): Record<string, unknown> | null {
  const packet = current.custody.correctionPackets.find((candidate) => candidate["packetId"] === packetId);
  return packet && validateReviewJobCorrectionPacketPayload(packet) ? packet : null;
}

function githubCorrectionFindingRenderBinding(input: {
  current: CurrentGithubCorrectionCarrierBinding;
  packet: Record<string, unknown>;
}): GitHubCorrectionDispatchBinding {
  const { current, packet } = input;
  return {
    kind: GITHUB_CORRECTION_DISPATCH_BINDING_KIND,
    version: GITHUB_CORRECTION_DISPATCH_BINDING_VERSION,
    workspaceId: current.dispatch.workspaceId,
    dispatchId: current.dispatch.id,
    dispatchIdentitySha256: current.dispatch.dispatchIdentitySha256,
    recordId: current.dispatch.recordId,
    reviewJobId: current.dispatch.reviewJobId,
    repo: current.dispatch.repo,
    prNumber: current.dispatch.prNumber,
    baseSha: current.sourceSnapshot.baseSha!,
    headSha: current.dispatch.headSha,
    headCycleId: current.dispatch.headCycleId,
    authorityGeneration: current.dispatch.authorityGeneration,
    packetId: packet["packetId"] as string,
    packetPayloadSha256: packetPayloadSha256(packet),
    acceptanceContract: {
      id: current.dispatch.acceptanceContractId,
      version: current.dispatch.acceptanceContractVersion,
      sha256: current.dispatch.acceptanceContractSha256,
    },
    packetSetSha256: current.dispatch.packetSetSha256,
    correctionPacketPayloadSetSha256: current.dispatch.correctionPacketPayloadSetSha256,
    contextPack: {
      id: current.dispatch.compiledPackId,
      sha256: current.dispatch.compiledPackSha256,
      sourceSnapshotId: current.dispatch.sourceSnapshotId,
      sourceCustodyIdentitySha256: current.dispatch.sourceCustodyIdentitySha256,
    },
    route: {
      id: current.dispatch.routeId,
      adapter: current.dispatch.routeAdapter as "github_codex" | "github_claude",
      configurationVersion: current.dispatch.routeConfigurationVersion,
    },
    capabilityProfile: {
      id: current.profile.id,
      snapshotSha256: current.profile.snapshotSha256,
      githubInstallationIdentitySha256: current.profile.githubInstallationIdentitySha256,
    },
    readyPreflight: {
      id: current.readyPreflight.id,
      identitySha256: current.readyPreflight.preflightIdentitySha256,
    },
  };
}

function renderCurrentGithubCorrectionFinding(input: {
  current: CurrentGithubCorrectionCarrierBinding;
  packet: Record<string, unknown>;
}) {
  return renderGitHubCorrectionFinding({
    packet: input.packet as GitHubCorrectionPacketPayload,
    binding: githubCorrectionFindingRenderBinding(input),
  });
}

function publicationHasExactCurrentBinding(input: {
  publication: AcceptanceCorrectionDispatchGithubFindingPublicationRow;
  current: CurrentGithubCorrectionCarrierBinding;
  packet: Record<string, unknown>;
}): boolean {
  const { publication: row, current, packet } = input;
  const criterion = packet["criterion"];
  if (!isRecord(criterion)) return false;
  const expected = {
    id: acceptanceCorrectionDispatchGithubFindingPublicationId({
      dispatchId: current.dispatch.id, packetId: packet["packetId"] as string,
    }),
    workspaceId: current.dispatch.workspaceId, dispatchId: current.dispatch.id,
    recordId: current.dispatch.recordId, packetId: packet["packetId"] as string,
    criterionId: criterion["id"] as string,
    repo: current.dispatch.repo, prNumber: current.dispatch.prNumber,
    headSha: current.dispatch.headSha, baseSha: current.sourceSnapshot.baseSha!,
    headCycleId: current.dispatch.headCycleId,
    authorityGeneration: current.dispatch.authorityGeneration,
    dispatchIdentitySha256: current.dispatch.dispatchIdentitySha256,
    routeId: current.dispatch.routeId, routeAdapter: current.dispatch.routeAdapter,
    routeConfigurationVersion: current.dispatch.routeConfigurationVersion,
    capabilityProfileId: current.profile.id,
    capabilityProfileSnapshotSha256: current.profile.snapshotSha256,
    githubInstallationIdentitySha256: current.profile.githubInstallationIdentitySha256,
    readyPreflightId: current.readyPreflight.id,
    readyPreflightIdentitySha256: current.readyPreflight.preflightIdentitySha256,
    publicationProtocolVersion: GITHUB_CORRECTION_FINDING_PUBLICATION_PROTOCOL_VERSION,
    publicationIdentitySha256: row.publicationIdentitySha256,
    carrier: "github_issue_comment",
    packetPayloadSha256: packetPayloadSha256(packet),
    body: row.body,
    bodySha256: row.bodySha256,
  };
  const rendered = renderCurrentGithubCorrectionFinding({ current, packet });
  return isDeepStrictEqual(githubCorrectionFindingPublicationComparable(row), expected)
    && githubCorrectionFindingPublicationIdentity(expected) === row.publicationIdentitySha256
    && (row.body === null
      ? rendered === null && row.bodySha256 === null
        && row.status === "bounded_failed" && row.resultReason === "invalid_db_issued_body"
      : rendered !== null && row.body === rendered.comment
        && createHash("sha256").update(row.body, "utf8").digest("hex") === row.bodySha256);
}

function outcomeMatchesFindingPublication(
  row: AcceptanceCorrectionDispatchGithubFindingPublicationRow,
  outcome: GithubCorrectionFindingPublicationOutcome
): boolean {
  if (outcome.kind === "published") {
    return row.status === "published" && row.githubCommentId === outcome.githubCommentId
      && row.githubCommentUrl === outcome.githubCommentUrl && row.resultReason == null;
  }
  if (outcome.kind === "bounded_failed") {
    return row.status === "bounded_failed" && row.resultReason === outcome.reason
      && row.githubCommentId == null && row.githubCommentUrl == null;
  }
  return row.status === "ambiguous_hold" && row.resultReason === outcome.reason
    && row.githubCommentId == null && row.githubCommentUrl == null;
}

function githubCorrectionFindingPublicationValues(input: {
  current: CurrentGithubCorrectionCarrierBinding;
  packet: Record<string, unknown>;
}) {
  const { current, packet } = input;
  const criterion = packet["criterion"];
  if (!isRecord(criterion) || typeof criterion["id"] !== "string") {
    throw new Error("GitHub correction finding packet criterion is invalid");
  }
  const rendered = renderCurrentGithubCorrectionFinding(input);
  const unsigned = {
    id: acceptanceCorrectionDispatchGithubFindingPublicationId({
      dispatchId: current.dispatch.id, packetId: packet["packetId"] as string,
    }),
    workspaceId: current.dispatch.workspaceId, dispatchId: current.dispatch.id,
    recordId: current.dispatch.recordId, packetId: packet["packetId"] as string,
    criterionId: criterion["id"], repo: current.dispatch.repo,
    prNumber: current.dispatch.prNumber, headSha: current.dispatch.headSha,
    baseSha: current.sourceSnapshot.baseSha!, headCycleId: current.dispatch.headCycleId,
    authorityGeneration: current.dispatch.authorityGeneration,
    dispatchIdentitySha256: current.dispatch.dispatchIdentitySha256,
    routeId: current.dispatch.routeId, routeAdapter: current.dispatch.routeAdapter,
    routeConfigurationVersion: current.dispatch.routeConfigurationVersion,
    capabilityProfileId: current.profile.id,
    capabilityProfileSnapshotSha256: current.profile.snapshotSha256,
    githubInstallationIdentitySha256: current.profile.githubInstallationIdentitySha256,
    readyPreflightId: current.readyPreflight.id,
    readyPreflightIdentitySha256: current.readyPreflight.preflightIdentitySha256,
    publicationProtocolVersion: GITHUB_CORRECTION_FINDING_PUBLICATION_PROTOCOL_VERSION,
    carrier: "github_issue_comment" as const,
    packetPayloadSha256: packetPayloadSha256(packet),
    body: rendered?.comment ?? null,
    bodySha256: rendered
      ? createHash("sha256").update(rendered.comment, "utf8").digest("hex")
      : null,
    status: rendered ? "reserved" as const : "bounded_failed" as const,
    githubCommentId: null,
    githubCommentUrl: null,
    resultReason: rendered ? null : "invalid_db_issued_body" as const,
    completedAt: rendered ? null : new Date(),
  };
  return {
    ...unsigned,
    publicationIdentitySha256: githubCorrectionFindingPublicationIdentity(unsigned),
  };
}

/**
 * Reserves the next sorted packet's inert finding body. Existing reserved or
 * ambiguous rows hold without retry; renderer failures close locally and the
 * same transaction advances to the next packet without a GitHub write.
 */
export async function reserveNextGithubCorrectionFindingPublication(
  input: ReserveNextGithubCorrectionFindingPublicationInput
): Promise<ReserveNextGithubCorrectionFindingPublicationResult> {
  if (!isRecord(input) || !hasExactKeys(input, ["workspaceId", "dispatchId"])
    || !isUuid(input.workspaceId) || !isUuid(input.dispatchId)) {
    throw new Error("GitHub correction finding reservation requires only workspace and dispatch");
  }
  const candidate = (await db.select().from(acceptanceCorrectionDispatches).where(and(
    eq(acceptanceCorrectionDispatches.id, input.dispatchId),
    eq(acceptanceCorrectionDispatches.workspaceId, input.workspaceId),
  )).limit(1))[0];
  if (!candidate) return { kind: "not_current" };
  const lockKey = acceptanceRecordPullRequestLockKey({
    workspaceId: input.workspaceId, recordId: candidate.recordId,
    repo: candidate.repo, prNumber: candidate.prNumber,
  });
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const current = await resolveCurrentGithubCorrectionCarrierBindingInTransaction(tx, input);
    if (!current) return { kind: "not_current" };

    // The carrier always re-enters through the findings phase. Once the sole
    // activation has progressed, revalidate the complete finding aggregate and
    // expose only its closed summary. This makes a whole-worker restart reach
    // the activation replay without ever reserving another finding or exposing
    // a second postable activation body.
    if (current.dispatch.activationState !== "not_started") {
      const activationAggregateMatches =
        (current.dispatch.activationState === "reserved"
          && current.dispatch.deliveryState === "queued"
          && current.dispatch.agentState === "not_observed")
        || (current.dispatch.activationState === "carrier_accepted"
          && current.dispatch.deliveryState === "carrier_accepted")
        || (current.dispatch.activationState === "failed"
          && current.dispatch.deliveryState === "failed"
          && current.dispatch.agentState === "not_observed")
        || (current.dispatch.activationState === "ambiguous_hold"
          && current.dispatch.deliveryState === "ambiguous_hold"
          && current.dispatch.agentState === "not_observed");
      if (!activationAggregateMatches || current.dispatch.findingsState !== "terminal") {
        return { kind: "not_current" };
      }
      const aggregate = await projectGithubCorrectionFindingAggregateInTransaction(tx, current);
      if (aggregate.state !== "terminal") {
        throw new Error("GitHub correction activation progressed without exact terminal finding custody");
      }
      return {
        kind: "complete",
        expected: current.dispatch.packetIds.length,
        published: aggregate.rows.filter((row) => row.status === "published").length,
        boundedFailed: aggregate.rows.filter((row) => row.status === "bounded_failed").length,
      };
    }

    if (current.dispatch.agentState !== "not_observed"
      || (current.dispatch.deliveryState !== "queued" && current.dispatch.deliveryState !== "ambiguous_hold")
      || (current.dispatch.findingsState !== "not_started"
        && current.dispatch.findingsState !== "reserved"
        && current.dispatch.findingsState !== "terminal"
        && current.dispatch.findingsState !== "ambiguous_hold")) return { kind: "not_current" };
    if (current.dispatch.deliveryState === "ambiguous_hold"
      || current.dispatch.findingsState === "ambiguous_hold") {
      return { kind: "held", reason: "ambiguous_hold" };
    }

    for (let index = 0; index <= current.dispatch.packetIds.length; index += 1) {
      const aggregate = await projectGithubCorrectionFindingAggregateInTransaction(tx, current);
      if (aggregate.state === "ambiguous_hold") return { kind: "held", reason: "ambiguous_hold" };
      const reserved = aggregate.rows.find((row) => row.status === "reserved");
      if (reserved) return { kind: "held", reason: "reserved" };
      const missingPacketId = current.dispatch.packetIds.find(
        (packetId) => !aggregate.rows.some((row) => row.packetId === packetId)
      );
      if (!missingPacketId) {
        if (aggregate.state !== "terminal") {
          throw new Error("GitHub correction finding aggregate has no reservable packet but is not terminal");
        }
        return {
          kind: "complete",
          expected: current.dispatch.packetIds.length,
          published: aggregate.rows.filter((row) => row.status === "published").length,
          boundedFailed: aggregate.rows.filter((row) => row.status === "bounded_failed").length,
        };
      }
      const packet = correctionPacketById(current, missingPacketId);
      if (!packet) throw new Error("GitHub correction finding packet is missing from exact custody");
      const values = githubCorrectionFindingPublicationValues({ current, packet });
      const projected = values as AcceptanceCorrectionDispatchGithubFindingPublicationRow;
      const eventInputs: AppendChangeRecordEventInput[] = [{
        recordId: current.record.id,
        eventKey: `acceptance-correction-dispatch:github-finding:reserved:${current.dispatch.headCycleId}:${missingPacketId}`,
        stage: "builder_handoff", actor: "server:github-correction-carrier",
        payloadRef: githubCorrectionFindingEventPayload({ publication: projected, kind: "reserved" }),
      }];
      if (values.status === "bounded_failed") {
        eventInputs.push({
          recordId: current.record.id,
          eventKey: `acceptance-correction-dispatch:github-finding:result:${current.dispatch.headCycleId}:${missingPacketId}`,
          stage: "builder_handoff", actor: "server:github-correction-carrier",
          payloadRef: githubCorrectionFindingEventPayload({ publication: projected, kind: "result" }),
        });
      }
      const events = await appendChangeRecordEventsAtomicallyInTransaction(tx, eventInputs);
      if (events.events.some((event) => !event.inserted)) {
        throw new Error("GitHub correction finding reservation event unexpectedly replayed");
      }
      const inserted = await tx.insert(acceptanceCorrectionDispatchGithubFindingPublications)
        .values(values).returning();
      if (inserted.length !== 1) throw new Error("GitHub correction finding reservation was not inserted");
      if (values.status === "reserved") {
        await projectGithubCorrectionFindingAggregateInTransaction(tx, current);
        return { kind: "reserved", publication: inserted[0]!, body: values.body! };
      }
      // A local renderer rejection is terminal and never leaves a body for
      // Console to post. Continue to persist the rest of the sorted findings.
    }
    throw new Error("GitHub correction finding reservation exceeded its exact packet bound");
  });
}

async function projectGithubCorrectionFindingAggregateInTransaction(
  tx: DbTransaction,
  current: CurrentGithubCorrectionCarrierBinding
): Promise<{ state: "reserved" | "terminal" | "ambiguous_hold"; rows: AcceptanceCorrectionDispatchGithubFindingPublicationRow[] }> {
  const rows = await tx.select().from(acceptanceCorrectionDispatchGithubFindingPublications).where(and(
    eq(acceptanceCorrectionDispatchGithubFindingPublications.workspaceId, current.dispatch.workspaceId),
    eq(acceptanceCorrectionDispatchGithubFindingPublications.dispatchId, current.dispatch.id),
  )).orderBy(asc(acceptanceCorrectionDispatchGithubFindingPublications.packetId));
  if (rows.length > current.dispatch.packetIds.length
    || rows.some((row) => !current.dispatch.packetIds.includes(row.packetId))) {
    throw new Error("GitHub correction finding aggregate contains an unexpected packet");
  }
  for (const row of rows) {
    const packet = correctionPacketById(current, row.packetId);
    if (!packet || !publicationHasExactCurrentBinding({ publication: row, current, packet })
      || !await hasVerifiedGithubCorrectionFindingEventsInTransaction(tx, row)) {
      throw new Error("GitHub correction finding aggregate custody is invalid");
    }
  }
  const state = rows.some((row) => row.status === "ambiguous_hold")
    ? "ambiguous_hold" as const
    : rows.length === current.dispatch.packetIds.length
      && rows.every((row) => row.status === "published" || row.status === "bounded_failed")
      ? "terminal" as const
      : "reserved" as const;
  const needsProjection = current.dispatch.findingsState !== state
    || (state === "ambiguous_hold" && current.dispatch.deliveryState !== "ambiguous_hold");
  if (!needsProjection) return { state, rows };
  const projected = await tx.update(acceptanceCorrectionDispatches).set({
    findingsState: state,
    ...(state === "ambiguous_hold" ? { deliveryState: "ambiguous_hold" as const } : {}),
    updatedAt: new Date(),
  }).where(and(
    eq(acceptanceCorrectionDispatches.id, current.dispatch.id),
    isNull(acceptanceCorrectionDispatches.invalidatedAt),
    eq(acceptanceCorrectionDispatches.headSha, current.dispatch.headSha),
    eq(acceptanceCorrectionDispatches.headCycleId, current.dispatch.headCycleId),
    eq(acceptanceCorrectionDispatches.authorityGeneration, current.dispatch.authorityGeneration),
    eq(acceptanceCorrectionDispatches.agentState, "not_observed"),
    inArray(acceptanceCorrectionDispatches.findingsState,
      ["not_started", "reserved", "terminal", "ambiguous_hold"]),
    inArray(acceptanceCorrectionDispatches.deliveryState,
      ["queued", "ambiguous_hold", "carrier_accepted", "failed"]),
  )).returning({ id: acceptanceCorrectionDispatches.id });
  if (projected.length !== 1) {
    throw new Error("GitHub correction finding aggregate lost its current dispatch precondition");
  }
  return { state, rows };
}

/**
 * Closes one exact finding reservation. An unknown POST outcome is a durable
 * hold, never a retry signal. Comment publication does not change agent state.
 */
export async function reportGithubCorrectionFindingPublication(
  input: ReportGithubCorrectionFindingPublicationInput
): Promise<ReportGithubCorrectionFindingPublicationResult> {
  if (!isRecord(input) || !hasExactKeys(input, ["workspaceId", "publicationId", "outcome"])
    || !isUuid(input.workspaceId) || !isUuid(input.publicationId)
    || !isGithubCorrectionFindingPublicationOutcome(input.outcome)) {
    throw new Error("GitHub correction finding report requires only workspace, publication, and closed outcome");
  }
  const candidate = (await db.select().from(acceptanceCorrectionDispatchGithubFindingPublications).where(and(
    eq(acceptanceCorrectionDispatchGithubFindingPublications.id, input.publicationId),
    eq(acceptanceCorrectionDispatchGithubFindingPublications.workspaceId, input.workspaceId),
  )).limit(1))[0];
  if (!candidate) return { kind: "not_current" };
  const lockKey = acceptanceRecordPullRequestLockKey({
    workspaceId: input.workspaceId, recordId: candidate.recordId,
    repo: candidate.repo, prNumber: candidate.prNumber,
  });
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const publication = (await tx.select().from(acceptanceCorrectionDispatchGithubFindingPublications).where(and(
      eq(acceptanceCorrectionDispatchGithubFindingPublications.id, input.publicationId),
      eq(acceptanceCorrectionDispatchGithubFindingPublications.workspaceId, input.workspaceId),
    )).limit(1))[0];
    if (!publication) return { kind: "not_current" };
    const current = await resolveCurrentGithubCorrectionCarrierBindingInTransaction(tx, {
      workspaceId: input.workspaceId, dispatchId: publication.dispatchId,
    });
    const packet = current && correctionPacketById(current, publication.packetId);
    if (!current || !packet || !publicationHasExactCurrentBinding({ publication, current, packet })
      || !await hasVerifiedGithubCorrectionFindingEventsInTransaction(tx, publication)) {
      return { kind: "not_current" };
    }
    if (input.outcome.kind === "published") {
      if (input.outcome.githubCommentUrl !== canonicalGithubCorrectionCommentUrl({
        repo: current.dispatch.repo, prNumber: current.dispatch.prNumber,
        githubCommentId: input.outcome.githubCommentId,
      })) return { kind: "not_current" };
      await assertUnusedGithubCorrectionCommentReceiptInTransaction(tx, {
        githubCommentId: input.outcome.githubCommentId, ownFindingId: publication.id,
      });
    }
    if (publication.status !== "reserved") {
      if (!outcomeMatchesFindingPublication(publication, input.outcome)) {
        throw new Error("GitHub correction finding publication already has a different terminal outcome");
      }
      return { kind: "replayed", publication };
    }
    if (current.dispatch.deliveryState !== "queued"
      || current.dispatch.agentState !== "not_observed"
      || current.dispatch.activationState !== "not_started"
      || (current.dispatch.findingsState !== "reserved" && current.dispatch.findingsState !== "not_started")) {
      return { kind: "not_current" };
    }
    const status = input.outcome.kind === "published" ? "published" as const
      : input.outcome.kind === "bounded_failed" ? "bounded_failed" as const
        : "ambiguous_hold" as const;
    const projected = {
      ...publication, status,
      githubCommentId: input.outcome.kind === "published" ? input.outcome.githubCommentId : null,
      githubCommentUrl: input.outcome.kind === "published" ? input.outcome.githubCommentUrl : null,
      resultReason: input.outcome.kind === "published" ? null : input.outcome.reason,
      completedAt: new Date(), updatedAt: new Date(),
    } as AcceptanceCorrectionDispatchGithubFindingPublicationRow;
    const event = await appendChangeRecordEventsAtomicallyInTransaction(tx, [{
      recordId: current.record.id,
      eventKey: `acceptance-correction-dispatch:github-finding:result:${publication.headCycleId}:${publication.packetId}`,
      stage: "builder_handoff", actor: "server:github-correction-carrier",
      payloadRef: githubCorrectionFindingEventPayload({ publication: projected, kind: "result" }),
    }]);
    if (!event.events[0]!.inserted) throw new Error("GitHub correction finding result event unexpectedly replayed");
    const updated = await tx.update(acceptanceCorrectionDispatchGithubFindingPublications).set({
      status, githubCommentId: projected.githubCommentId,
      githubCommentUrl: projected.githubCommentUrl,
      resultReason: projected.resultReason,
      completedAt: projected.completedAt, updatedAt: projected.updatedAt,
    }).where(and(
      eq(acceptanceCorrectionDispatchGithubFindingPublications.id, publication.id),
      eq(acceptanceCorrectionDispatchGithubFindingPublications.status, "reserved"),
    )).returning();
    if (updated.length !== 1) throw new Error("GitHub correction finding report lost its reserved precondition");
    await projectGithubCorrectionFindingAggregateInTransaction(tx, current);
    return { kind: "reported", publication: updated[0]! };
  });
}

function githubCorrectionFindingCoverageSha256(
  rows: readonly AcceptanceCorrectionDispatchGithubFindingPublicationRow[]
): string {
  return acceptanceContextPackCanonicalSha256({
    kind: "acceptance_correction_dispatch_github_finding_coverage",
    version: 1,
    findings: rows.map((row) => ({
      publicationId: row.id,
      publicationIdentitySha256: row.publicationIdentitySha256,
      packetId: row.packetId,
      criterionId: row.criterionId,
      packetPayloadSha256: row.packetPayloadSha256,
      bodySha256: row.bodySha256,
      status: row.status,
      githubCommentId: row.githubCommentId,
      githubCommentUrl: row.githubCommentUrl,
      reason: row.resultReason,
    })),
  });
}

function githubCorrectionActivationRenderBinding(input: {
  current: CurrentGithubCorrectionCarrierBinding;
  findingCoverageSha256: string;
}): GitHubCorrectionActivationBinding {
  const { current } = input;
  return {
    kind: GITHUB_CORRECTION_ACTIVATION_BINDING_KIND,
    version: GITHUB_CORRECTION_ACTIVATION_BINDING_VERSION,
    workspaceId: current.dispatch.workspaceId,
    dispatchId: current.dispatch.id,
    dispatchIdentitySha256: current.dispatch.dispatchIdentitySha256,
    recordId: current.dispatch.recordId,
    reviewJobId: current.dispatch.reviewJobId,
    repo: current.dispatch.repo,
    prNumber: current.dispatch.prNumber,
    baseSha: current.sourceSnapshot.baseSha!,
    headSha: current.dispatch.headSha,
    headCycleId: current.dispatch.headCycleId,
    authorityGeneration: current.dispatch.authorityGeneration,
    acceptanceContract: {
      id: current.dispatch.acceptanceContractId,
      version: current.dispatch.acceptanceContractVersion,
      sha256: current.dispatch.acceptanceContractSha256,
    },
    contextPack: {
      id: current.dispatch.compiledPackId,
      sha256: current.dispatch.compiledPackSha256,
      sourceSnapshotId: current.dispatch.sourceSnapshotId,
      sourceCustodyIdentitySha256: current.dispatch.sourceCustodyIdentitySha256,
    },
    packetIds: [...current.dispatch.packetIds],
    packetSetSha256: current.dispatch.packetSetSha256,
    correctionPacketPayloadSetSha256: current.dispatch.correctionPacketPayloadSetSha256,
    route: {
      id: current.dispatch.routeId,
      adapter: current.dispatch.routeAdapter as "github_codex" | "github_claude",
      configurationVersion: current.dispatch.routeConfigurationVersion,
    },
    capabilityProfile: {
      id: current.profile.id,
      snapshotSha256: current.profile.snapshotSha256,
      githubInstallationIdentitySha256: current.profile.githubInstallationIdentitySha256,
    },
    readyPreflight: {
      id: current.readyPreflight.id,
      identitySha256: current.readyPreflight.preflightIdentitySha256,
    },
    findingCoverageSha256: input.findingCoverageSha256,
    recipient: current.dispatch.routeAdapter === "github_codex" ? "codex" : "claude",
  };
}

function renderCurrentGithubCorrectionActivation(input: {
  current: CurrentGithubCorrectionCarrierBinding;
  findingCoverageSha256: string;
}) {
  return renderGitHubCorrectionActivation({
    binding: githubCorrectionActivationRenderBinding(input),
    packets: input.current.custody.correctionPackets as GitHubCorrectionPacketPayload[],
  });
}

async function resolveTerminalGithubCorrectionFindingCoverageInTransaction(
  tx: DbTransaction,
  current: CurrentGithubCorrectionCarrierBinding
): Promise<{
  rows: AcceptanceCorrectionDispatchGithubFindingPublicationRow[];
  findingCoverageSha256: string;
  hasUnsafeFinding: boolean;
} | null> {
  const aggregate = await projectGithubCorrectionFindingAggregateInTransaction(tx, current);
  if (aggregate.state !== "terminal"
    || aggregate.rows.length !== current.dispatch.packetIds.length
    || !aggregate.rows.every((row, index) => row.packetId === current.dispatch.packetIds[index]
      && (row.status === "published" || row.status === "bounded_failed"))) return null;
  return {
    rows: aggregate.rows,
    findingCoverageSha256: githubCorrectionFindingCoverageSha256(aggregate.rows),
    hasUnsafeFinding: aggregate.rows.some((row) => row.body === null
      || row.resultReason === "invalid_db_issued_body"),
  };
}

function activationHasExactCurrentBinding(input: {
  activation: AcceptanceCorrectionDispatchGithubActivationRow;
  current: CurrentGithubCorrectionCarrierBinding;
  findingCoverageSha256: string;
  hasUnsafeFinding: boolean;
}): boolean {
  const { activation: row, current } = input;
  const expected = {
    id: acceptanceCorrectionDispatchGithubActivationId({ dispatchId: current.dispatch.id }),
    workspaceId: current.dispatch.workspaceId, dispatchId: current.dispatch.id,
    recordId: current.dispatch.recordId, repo: current.dispatch.repo,
    prNumber: current.dispatch.prNumber, headSha: current.dispatch.headSha,
    baseSha: current.sourceSnapshot.baseSha!, headCycleId: current.dispatch.headCycleId,
    authorityGeneration: current.dispatch.authorityGeneration,
    dispatchIdentitySha256: current.dispatch.dispatchIdentitySha256,
    routeId: current.dispatch.routeId, routeAdapter: current.dispatch.routeAdapter,
    routeConfigurationVersion: current.dispatch.routeConfigurationVersion,
    capabilityProfileId: current.profile.id,
    capabilityProfileSnapshotSha256: current.profile.snapshotSha256,
    githubInstallationIdentitySha256: current.profile.githubInstallationIdentitySha256,
    readyPreflightId: current.readyPreflight.id,
    readyPreflightIdentitySha256: current.readyPreflight.preflightIdentitySha256,
    carrier: "github_issue_comment",
    recipient: current.dispatch.routeAdapter === "github_codex" ? "codex" : "claude",
    findingCoverageSha256: input.findingCoverageSha256,
    packetSetSha256: current.dispatch.packetSetSha256,
    correctionPacketPayloadSetSha256: current.dispatch.correctionPacketPayloadSetSha256,
    packetBundleSha256: row.packetBundleSha256,
    body: row.body, bodySha256: row.bodySha256,
    activationProtocolVersion: GITHUB_CORRECTION_ACTIVATION_PROTOCOL_VERSION,
    activationIdentitySha256: row.activationIdentitySha256,
  };
  const rendering = input.hasUnsafeFinding ? null : renderCurrentGithubCorrectionActivation({
    current, findingCoverageSha256: input.findingCoverageSha256,
  });
  const exactRendering = row.body === null
    ? row.bodySha256 === null
      && row.status === "bounded_failed"
      && ((input.hasUnsafeFinding && row.resultReason === "invalid_db_issued_body")
        || (!input.hasUnsafeFinding && rendering !== null && !rendering.ok
          && row.resultReason === (rendering.reason === "activation_body_too_large"
            ? "activation_body_too_large" : "invalid_db_issued_body")
          && row.packetBundleSha256 === (rendering.reason === "activation_body_too_large"
            ? rendering.packetBundleSha256 : null)))
    : rendering !== null && rendering.ok
      && row.body === rendering.body && row.bodySha256 === rendering.bodySha256
      && row.packetBundleSha256 === rendering.packetBundleSha256;
  return isDeepStrictEqual(githubCorrectionActivationComparable(row), expected)
    && githubCorrectionActivationIdentity(expected) === row.activationIdentitySha256
    && exactRendering
    && (row.body === null || createHash("sha256").update(row.body, "utf8").digest("hex") === row.bodySha256);
}

function outcomeMatchesActivation(
  row: AcceptanceCorrectionDispatchGithubActivationRow,
  outcome: GithubCorrectionActivationOutcome
): boolean {
  if (outcome.kind === "carrier_accepted") {
    return row.status === "carrier_accepted" && row.githubCommentId === outcome.githubCommentId
      && row.githubCommentUrl === outcome.githubCommentUrl && row.resultReason == null;
  }
  if (outcome.kind === "bounded_failed") {
    return row.status === "bounded_failed" && row.resultReason === outcome.reason
      && row.githubCommentId == null && row.githubCommentUrl == null;
  }
  return row.status === "ambiguous_hold" && row.resultReason === outcome.reason
    && row.githubCommentId == null && row.githubCommentUrl == null;
}

function activationMatchesDispatchAggregate(
  activation: AcceptanceCorrectionDispatchGithubActivationRow,
  dispatch: AcceptanceCorrectionDispatchRow
): boolean {
  if (dispatch.findingsState !== "terminal") return false;
  if (activation.status === "reserved") {
    return dispatch.activationState === "reserved"
      && dispatch.deliveryState === "queued"
      && dispatch.agentState === "not_observed";
  }
  if (activation.status === "carrier_accepted") {
    return dispatch.activationState === "carrier_accepted"
      && dispatch.deliveryState === "carrier_accepted";
  }
  if (activation.status === "bounded_failed") {
    return dispatch.activationState === "failed"
      && dispatch.deliveryState === "failed"
      && dispatch.agentState === "not_observed";
  }
  return activation.status === "ambiguous_hold"
    && dispatch.activationState === "ambiguous_hold"
    && dispatch.deliveryState === "ambiguous_hold"
    && dispatch.agentState === "not_observed";
}

function githubCorrectionActivationValues(input: {
  current: CurrentGithubCorrectionCarrierBinding;
  findingCoverageSha256: string;
  hasUnsafeFinding: boolean;
}) {
  const rendering = input.hasUnsafeFinding ? null : renderCurrentGithubCorrectionActivation({
    current: input.current,
    findingCoverageSha256: input.findingCoverageSha256,
  });
  const renderFailure = input.hasUnsafeFinding || (rendering !== null && !rendering.ok);
  const resultReason = !renderFailure ? null
    : !input.hasUnsafeFinding && rendering !== null && !rendering.ok
      && rendering.reason === "activation_body_too_large"
      ? "activation_body_too_large" as const
      : "invalid_db_issued_body" as const;
  const unsigned = {
    id: acceptanceCorrectionDispatchGithubActivationId({ dispatchId: input.current.dispatch.id }),
    workspaceId: input.current.dispatch.workspaceId,
    dispatchId: input.current.dispatch.id,
    recordId: input.current.dispatch.recordId,
    repo: input.current.dispatch.repo,
    prNumber: input.current.dispatch.prNumber,
    headSha: input.current.dispatch.headSha,
    baseSha: input.current.sourceSnapshot.baseSha!,
    headCycleId: input.current.dispatch.headCycleId,
    authorityGeneration: input.current.dispatch.authorityGeneration,
    dispatchIdentitySha256: input.current.dispatch.dispatchIdentitySha256,
    routeId: input.current.dispatch.routeId,
    routeAdapter: input.current.dispatch.routeAdapter,
    routeConfigurationVersion: input.current.dispatch.routeConfigurationVersion,
    capabilityProfileId: input.current.profile.id,
    capabilityProfileSnapshotSha256: input.current.profile.snapshotSha256,
    githubInstallationIdentitySha256: input.current.profile.githubInstallationIdentitySha256,
    readyPreflightId: input.current.readyPreflight.id,
    readyPreflightIdentitySha256: input.current.readyPreflight.preflightIdentitySha256,
    carrier: "github_issue_comment" as const,
    recipient: input.current.dispatch.routeAdapter === "github_codex" ? "codex" as const : "claude" as const,
    findingCoverageSha256: input.findingCoverageSha256,
    packetSetSha256: input.current.dispatch.packetSetSha256,
    correctionPacketPayloadSetSha256: input.current.dispatch.correctionPacketPayloadSetSha256,
    packetBundleSha256: rendering?.ok
      ? rendering.packetBundleSha256
      : rendering?.reason === "activation_body_too_large"
        ? rendering.packetBundleSha256
        : null,
    body: rendering?.ok ? rendering.body : null,
    bodySha256: rendering?.ok ? rendering.bodySha256 : null,
    activationProtocolVersion: GITHUB_CORRECTION_ACTIVATION_PROTOCOL_VERSION,
    status: renderFailure ? "bounded_failed" as const : "reserved" as const,
    githubCommentId: null,
    githubCommentUrl: null,
    resultReason,
    completedAt: renderFailure ? new Date() : null,
  };
  return {
    values: {
      ...unsigned,
      activationIdentitySha256: githubCorrectionActivationIdentity(unsigned),
    },
    rendering,
  };
}

/**
 * Reserves the singleton selected-recipient activation only after the exact
 * finding set is terminal. The full canonical packet bundle is rendered here,
 * persisted inside the body, and never supplied by Console.
 */
export async function reserveGithubCorrectionActivation(
  input: ReserveGithubCorrectionActivationInput
): Promise<ReserveGithubCorrectionActivationResult> {
  if (!isRecord(input) || !hasExactKeys(input, ["workspaceId", "dispatchId"])
    || !isUuid(input.workspaceId) || !isUuid(input.dispatchId)) {
    throw new Error("GitHub correction activation reservation requires only workspace and dispatch");
  }
  const candidate = (await db.select().from(acceptanceCorrectionDispatches).where(and(
    eq(acceptanceCorrectionDispatches.id, input.dispatchId),
    eq(acceptanceCorrectionDispatches.workspaceId, input.workspaceId),
  )).limit(1))[0];
  if (!candidate) return { kind: "not_current" };
  const lockKey = acceptanceRecordPullRequestLockKey({
    workspaceId: input.workspaceId, recordId: candidate.recordId,
    repo: candidate.repo, prNumber: candidate.prNumber,
  });
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const current = await resolveCurrentGithubCorrectionCarrierBindingInTransaction(tx, input);
    if (!current) return { kind: "not_current" };
    const coverage = await resolveTerminalGithubCorrectionFindingCoverageInTransaction(tx, current);
    if (!coverage) {
      return current.dispatch.findingsState === "ambiguous_hold"
        || current.dispatch.deliveryState === "ambiguous_hold"
        ? { kind: "held", reason: "ambiguous_hold" }
        : { kind: "not_ready" };
    }
    const existing = (await tx.select().from(acceptanceCorrectionDispatchGithubActivations).where(and(
      eq(acceptanceCorrectionDispatchGithubActivations.workspaceId, input.workspaceId),
      eq(acceptanceCorrectionDispatchGithubActivations.dispatchId, current.dispatch.id),
    )).limit(1))[0];
    if (existing) {
      if (!activationHasExactCurrentBinding({
        activation: existing, current,
        findingCoverageSha256: coverage.findingCoverageSha256,
        hasUnsafeFinding: coverage.hasUnsafeFinding,
      }) || !await hasVerifiedGithubCorrectionActivationEventsInTransaction(tx, existing)
        || !activationMatchesDispatchAggregate(existing, current.dispatch)) {
        throw new Error("GitHub correction activation replay custody is invalid");
      }
      if (existing.status === "reserved") return { kind: "held", reason: "reserved" };
      if (existing.status === "ambiguous_hold") return { kind: "held", reason: "ambiguous_hold" };
      if (existing.status === "bounded_failed") {
        if (existing.resultReason !== "github_rejected"
          && existing.resultReason !== "activation_body_too_large"
          && existing.resultReason !== "invalid_db_issued_body") {
          throw new Error("GitHub correction activation has an invalid bounded failure reason");
        }
        return { kind: "bounded_failed", activationId: existing.id, reason: existing.resultReason };
      }
      if (existing.status !== "carrier_accepted" || !existing.githubCommentId || !existing.githubCommentUrl) {
        throw new Error("GitHub correction activation has an invalid terminal receipt");
      }
      return {
        kind: "carrier_accepted",
        activationId: existing.id,
        githubCommentId: existing.githubCommentId,
        githubCommentUrl: existing.githubCommentUrl,
      };
    }
    if (current.dispatch.agentState !== "not_observed"
      || current.dispatch.deliveryState !== "queued"
      || current.dispatch.findingsState !== "terminal"
      || current.dispatch.activationState !== "not_started") return { kind: "not_current" };
    const derived = githubCorrectionActivationValues({
      current,
      findingCoverageSha256: coverage.findingCoverageSha256,
      hasUnsafeFinding: coverage.hasUnsafeFinding,
    });
    const projected = derived.values as AcceptanceCorrectionDispatchGithubActivationRow;
    const eventInputs: AppendChangeRecordEventInput[] = [{
      recordId: current.record.id,
      eventKey: `acceptance-correction-dispatch:github-activation:reserved:${current.dispatch.headCycleId}`,
      stage: "builder_handoff", actor: "server:github-correction-carrier",
      payloadRef: githubCorrectionActivationEventPayload({ activation: projected, kind: "reserved" }),
    }];
    if (derived.values.status === "bounded_failed") {
      eventInputs.push({
        recordId: current.record.id,
        eventKey: `acceptance-correction-dispatch:github-activation:result:${current.dispatch.headCycleId}`,
        stage: "builder_handoff", actor: "server:github-correction-carrier",
        payloadRef: githubCorrectionActivationEventPayload({ activation: projected, kind: "result" }),
      });
    }
    const events = await appendChangeRecordEventsAtomicallyInTransaction(tx, eventInputs);
    if (events.events.some((event) => !event.inserted)) {
      throw new Error("GitHub correction activation reservation event unexpectedly replayed");
    }
    const inserted = await tx.insert(acceptanceCorrectionDispatchGithubActivations)
      .values(derived.values).returning();
    if (inserted.length !== 1) throw new Error("GitHub correction activation reservation was not inserted");
    if (derived.values.status === "bounded_failed") {
      const failed = await tx.update(acceptanceCorrectionDispatches).set({
        activationState: "failed", deliveryState: "failed", updatedAt: new Date(),
      }).where(and(
        eq(acceptanceCorrectionDispatches.id, current.dispatch.id),
        isNull(acceptanceCorrectionDispatches.invalidatedAt),
        eq(acceptanceCorrectionDispatches.headCycleId, current.dispatch.headCycleId),
        eq(acceptanceCorrectionDispatches.authorityGeneration, current.dispatch.authorityGeneration),
        eq(acceptanceCorrectionDispatches.deliveryState, "queued"),
        eq(acceptanceCorrectionDispatches.findingsState, "terminal"),
        eq(acceptanceCorrectionDispatches.activationState, "not_started"),
        eq(acceptanceCorrectionDispatches.agentState, "not_observed"),
      )).returning({ id: acceptanceCorrectionDispatches.id });
      if (failed.length !== 1) {
        throw new Error("GitHub correction activation failure lost its dispatch precondition");
      }
      return {
        kind: "bounded_failed", activationId: inserted[0]!.id,
        reason: derived.values.resultReason!,
      };
    }
    if (!derived.rendering || !derived.rendering.ok || !derived.values.body) {
      throw new Error("GitHub correction activation reserved without an exact rendered body");
    }
    const reserved = await tx.update(acceptanceCorrectionDispatches).set({
      activationState: "reserved", updatedAt: new Date(),
    }).where(and(
      eq(acceptanceCorrectionDispatches.id, current.dispatch.id),
      isNull(acceptanceCorrectionDispatches.invalidatedAt),
      eq(acceptanceCorrectionDispatches.headCycleId, current.dispatch.headCycleId),
      eq(acceptanceCorrectionDispatches.authorityGeneration, current.dispatch.authorityGeneration),
      eq(acceptanceCorrectionDispatches.deliveryState, "queued"),
      eq(acceptanceCorrectionDispatches.findingsState, "terminal"),
      eq(acceptanceCorrectionDispatches.activationState, "not_started"),
      eq(acceptanceCorrectionDispatches.agentState, "not_observed"),
    )).returning({ id: acceptanceCorrectionDispatches.id });
    if (reserved.length !== 1) {
      throw new Error("GitHub correction activation reservation lost its dispatch precondition");
    }
    return {
      kind: "reserved", activation: inserted[0]!, body: derived.values.body,
      packetBundleBase64url: derived.rendering.packetBundleBase64url,
      packetBundleSha256: derived.rendering.packetBundleSha256,
      recipient: derived.values.recipient,
    };
  });
}

/**
 * Closes the sole activation receipt. Carrier acceptance is projected without
 * changing the separately observed agent acknowledgement or repair state.
 */
export async function reportGithubCorrectionActivation(
  input: ReportGithubCorrectionActivationInput
): Promise<ReportGithubCorrectionActivationResult> {
  if (!isRecord(input) || !hasExactKeys(input, ["workspaceId", "activationId", "outcome"])
    || !isUuid(input.workspaceId) || !isUuid(input.activationId)
    || !isGithubCorrectionActivationOutcome(input.outcome)) {
    throw new Error("GitHub correction activation report requires only workspace, activation, and closed outcome");
  }
  const candidate = (await db.select().from(acceptanceCorrectionDispatchGithubActivations).where(and(
    eq(acceptanceCorrectionDispatchGithubActivations.id, input.activationId),
    eq(acceptanceCorrectionDispatchGithubActivations.workspaceId, input.workspaceId),
  )).limit(1))[0];
  if (!candidate) return { kind: "not_current" };
  const lockKey = acceptanceRecordPullRequestLockKey({
    workspaceId: input.workspaceId, recordId: candidate.recordId,
    repo: candidate.repo, prNumber: candidate.prNumber,
  });
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const activation = (await tx.select().from(acceptanceCorrectionDispatchGithubActivations).where(and(
      eq(acceptanceCorrectionDispatchGithubActivations.id, input.activationId),
      eq(acceptanceCorrectionDispatchGithubActivations.workspaceId, input.workspaceId),
    )).limit(1))[0];
    if (!activation) return { kind: "not_current" };
    const current = await resolveCurrentGithubCorrectionCarrierBindingInTransaction(tx, {
      workspaceId: input.workspaceId, dispatchId: activation.dispatchId,
    });
    const coverage = current && await resolveTerminalGithubCorrectionFindingCoverageInTransaction(tx, current);
    if (!current || !coverage
      || !activationHasExactCurrentBinding({
        activation, current, findingCoverageSha256: coverage.findingCoverageSha256,
        hasUnsafeFinding: coverage.hasUnsafeFinding,
      })
      || !await hasVerifiedGithubCorrectionActivationEventsInTransaction(tx, activation)
      || !activationMatchesDispatchAggregate(activation, current.dispatch)) {
      return { kind: "not_current" };
    }
    if (input.outcome.kind === "carrier_accepted") {
      if (input.outcome.githubCommentUrl !== canonicalGithubCorrectionCommentUrl({
        repo: current.dispatch.repo, prNumber: current.dispatch.prNumber,
        githubCommentId: input.outcome.githubCommentId,
      })) return { kind: "not_current" };
      await assertUnusedGithubCorrectionCommentReceiptInTransaction(tx, {
        githubCommentId: input.outcome.githubCommentId, ownActivationId: activation.id,
      });
    }
    if (activation.status !== "reserved") {
      if (!outcomeMatchesActivation(activation, input.outcome)) {
        throw new Error("GitHub correction activation already has a different terminal outcome");
      }
      return { kind: "replayed", activation };
    }
    if (coverage.hasUnsafeFinding || current.dispatch.deliveryState !== "queued"
      || current.dispatch.agentState !== "not_observed"
      || current.dispatch.findingsState !== "terminal"
      || current.dispatch.activationState !== "reserved") return { kind: "not_current" };
    const status = input.outcome.kind === "carrier_accepted" ? "carrier_accepted" as const
      : input.outcome.kind === "bounded_failed" ? "bounded_failed" as const
        : "ambiguous_hold" as const;
    const projected = {
      ...activation, status,
      githubCommentId: input.outcome.kind === "carrier_accepted" ? input.outcome.githubCommentId : null,
      githubCommentUrl: input.outcome.kind === "carrier_accepted" ? input.outcome.githubCommentUrl : null,
      resultReason: input.outcome.kind === "carrier_accepted" ? null : input.outcome.reason,
      completedAt: new Date(), updatedAt: new Date(),
    } as AcceptanceCorrectionDispatchGithubActivationRow;
    const event = await appendChangeRecordEventsAtomicallyInTransaction(tx, [{
      recordId: current.record.id,
      eventKey: `acceptance-correction-dispatch:github-activation:result:${activation.headCycleId}`,
      stage: "builder_handoff", actor: "server:github-correction-carrier",
      payloadRef: githubCorrectionActivationEventPayload({ activation: projected, kind: "result" }),
    }]);
    if (!event.events[0]!.inserted) throw new Error("GitHub correction activation result event unexpectedly replayed");
    const updated = await tx.update(acceptanceCorrectionDispatchGithubActivations).set({
      status, githubCommentId: projected.githubCommentId,
      githubCommentUrl: projected.githubCommentUrl,
      resultReason: projected.resultReason,
      completedAt: projected.completedAt, updatedAt: projected.updatedAt,
    }).where(and(
      eq(acceptanceCorrectionDispatchGithubActivations.id, activation.id),
      eq(acceptanceCorrectionDispatchGithubActivations.status, "reserved"),
    )).returning();
    if (updated.length !== 1) throw new Error("GitHub correction activation report lost its reserved precondition");
    const activationState = status === "carrier_accepted" ? "carrier_accepted" as const
      : status === "bounded_failed" ? "failed" as const : "ambiguous_hold" as const;
    const deliveryState = status === "carrier_accepted" ? "carrier_accepted" as const
      : status === "bounded_failed" ? "failed" as const : "ambiguous_hold" as const;
    const dispatchUpdated = await tx.update(acceptanceCorrectionDispatches).set({
      activationState, deliveryState, updatedAt: new Date(),
    }).where(and(
      eq(acceptanceCorrectionDispatches.id, current.dispatch.id),
      isNull(acceptanceCorrectionDispatches.invalidatedAt),
      eq(acceptanceCorrectionDispatches.headCycleId, current.dispatch.headCycleId),
      eq(acceptanceCorrectionDispatches.authorityGeneration, current.dispatch.authorityGeneration),
      eq(acceptanceCorrectionDispatches.deliveryState, "queued"),
      eq(acceptanceCorrectionDispatches.findingsState, "terminal"),
      eq(acceptanceCorrectionDispatches.activationState, "reserved"),
      eq(acceptanceCorrectionDispatches.agentState, "not_observed"),
    )).returning({ id: acceptanceCorrectionDispatches.id });
    if (dispatchUpdated.length !== 1) {
      throw new Error("GitHub correction activation report lost its dispatch precondition");
    }
    return { kind: "reported", activation: updated[0]! };
  });
}

const DURABLE_CORRECTION_FALLBACK_PROTOCOL_VERSION = 1 as const;
const MAX_DURABLE_CORRECTION_FALLBACK_NOTICE_BYTES = 12_288;

export function acceptanceCorrectionDispatchDurableFallbackId(input: {
  dispatchId: string;
}): string {
  return uuid5Url(`acceptance-correction-dispatch-durable-fallback:${input.dispatchId}`);
}

type StoredGithubCorrectionFallbackBinding = {
  dispatch: AcceptanceCorrectionDispatchRow;
  record: ChangeRecordRow;
  sourceSnapshot: AcceptanceContextPackSnapshotRow;
  custody: AcceptanceContextPackCustodyResolution;
  githubInstallationIdentitySha256: string;
};

function hasValidStoredGithubCorrectionProfile(
  dispatch: AcceptanceCorrectionDispatchRow
): dispatch is AcceptanceCorrectionDispatchRow & {
  routeAdapter: "github_codex" | "github_claude";
  capabilityProfileId: string;
  capabilityProfileSnapshot: Record<string, unknown>;
  capabilityProfileSnapshotSha256: string;
} {
  if (!isGithubNativeBuilderRouteAdapter(dispatch.routeAdapter)
    || dispatch.capabilityProfileId == null
    || dispatch.capabilityProfileSnapshot == null
    || dispatch.capabilityProfileSnapshotSha256 == null
    || acceptanceContextPackCanonicalSha256(dispatch.routeSnapshot) !== dispatch.routeSnapshotSha256
    || acceptanceContextPackCanonicalSha256(dispatch.capabilityProfileSnapshot)
      !== dispatch.capabilityProfileSnapshotSha256) return false;
  const expectedRouteSnapshot: AcceptanceBuilderRouteSnapshot = {
    builder: { adapter: dispatch.routeAdapter, routeId: dispatch.routeId },
    protocol: "github_comment",
    capability: {
      availability: "unverified", activation: "github_mention",
      acknowledgement: "vendor_activity", repairHead: "github_synchronize",
    },
    scopeBoundary: ACCEPTANCE_BUILDER_ROUTE_SCOPE,
  };
  const profile = dispatch.capabilityProfileSnapshot;
  const installation = profile["githubInstallationIdentitySha256"];
  const expectedProfile: AcceptanceBuilderRouteCapabilityProfileSnapshot = {
    kind: "acceptance_builder_route_capability_profile", version: 1,
    workspaceId: dispatch.workspaceId, repo: dispatch.repo,
    routeId: dispatch.routeId, adapter: dispatch.routeAdapter,
    routeConfigurationVersion: dispatch.routeConfigurationVersion,
    carrier: "github_issue_comment",
    carrierIdentity: "workspace_github_app_installation",
    findingPublication: "individual_no_vendor_mentions",
    activation: "single_final_vendor_mention",
    recipient: dispatch.routeAdapter === "github_codex" ? "codex" : "claude",
    configuration: "configuration_bound", preflight: "required",
    vendorAvailability: "not_asserted", vendorActivity: "required",
    repairHead: "github_synchronize", scopeBoundary: "correction_delivery_only",
    githubInstallationIdentitySha256: typeof installation === "string" ? installation : "",
  };
  return typeof installation === "string" && EXACT_SHA256.test(installation)
    && isDeepStrictEqual(dispatch.routeSnapshot, expectedRouteSnapshot)
    && isDeepStrictEqual(profile, expectedProfile);
}

/** Resolve durable stored custody without requiring today's installation/profile. */
async function resolveStoredGithubCorrectionFallbackBindingInTransaction(
  tx: DbTransaction,
  input: { workspaceId: string; dispatchId: string }
): Promise<StoredGithubCorrectionFallbackBinding | null> {
  const dispatch = (await tx.select().from(acceptanceCorrectionDispatches).where(and(
    eq(acceptanceCorrectionDispatches.id, input.dispatchId),
    eq(acceptanceCorrectionDispatches.workspaceId, input.workspaceId),
    isNull(acceptanceCorrectionDispatches.invalidatedAt),
    eq(acceptanceCorrectionDispatches.carrier, "github_comment"),
  )).limit(1))[0];
  if (!dispatch || !hasValidStoredGithubCorrectionProfile(dispatch)) return null;
  if (dispatch.id !== acceptanceCorrectionDispatchId({
    recordId: dispatch.recordId, headCycleId: dispatch.headCycleId,
  }) || dispatch.capabilityProfileId !== acceptanceBuilderRouteCapabilityProfileId({
    routeId: dispatch.routeId,
    routeConfigurationVersion: dispatch.routeConfigurationVersion,
  })) return null;
  const original = correctionDispatchOriginalComparable(dispatch);
  if (correctionDispatchIdentity(original) !== dispatch.dispatchIdentitySha256) return null;
  const queued = (await tx.select().from(changeRecordEvents).where(and(
    eq(changeRecordEvents.recordId, dispatch.recordId),
    eq(changeRecordEvents.eventKey,
      `acceptance-correction-dispatch:queued:${dispatch.headCycleId}`),
  )).limit(1))[0];
  if (!queued || queued.stage !== "builder_handoff"
    || queued.actor !== "server:dispatch-preparation"
    || !isDeepStrictEqual(queued.payloadRef,
      correctionDispatchQueuedEventPayload(original))) return null;
  const record = (await tx.select().from(changeRecords).where(and(
    eq(changeRecords.id, dispatch.recordId),
    eq(changeRecords.workspaceId, input.workspaceId),
    eq(changeRecords.repo, dispatch.repo),
    eq(changeRecords.prNumber, dispatch.prNumber),
  )).limit(1))[0];
  if (!record || !record.currentPrHeadAuthoritative
    || record.currentPrHeadSha !== dispatch.headSha
    || record.currentPrHeadCycleId !== dispatch.headCycleId
    || record.currentPrHeadAuthorityGeneration !== dispatch.authorityGeneration) return null;
  const sourceSnapshot = (await tx.select().from(acceptanceContextPackSnapshots).where(and(
    eq(acceptanceContextPackSnapshots.id, dispatch.sourceSnapshotId),
    eq(acceptanceContextPackSnapshots.workspaceId, input.workspaceId),
    eq(acceptanceContextPackSnapshots.recordId, dispatch.recordId),
    eq(acceptanceContextPackSnapshots.reviewJobId, dispatch.reviewJobId),
    eq(acceptanceContextPackSnapshots.repo, dispatch.repo),
    eq(acceptanceContextPackSnapshots.prNumber, dispatch.prNumber),
    eq(acceptanceContextPackSnapshots.expectedHeadSha, dispatch.headSha),
    eq(acceptanceContextPackSnapshots.status, "admitted"),
  )).limit(1))[0];
  if (!sourceSnapshot || sourceSnapshot.reviewJobId !== dispatch.headCycleId
    || !sourceSnapshot.baseSha || !isSha1(sourceSnapshot.baseSha)) return null;
  const custody = await resolveAcceptanceContextPackCustodyInTransaction(tx, {
    workspaceId: input.workspaceId, sourceSnapshotId: dispatch.sourceSnapshotId,
  });
  if (custody.sourceSnapshot.baseSha !== sourceSnapshot.baseSha
    || custody.sourceSnapshot.expectedHeadSha !== dispatch.headSha
    || custody.sourceSnapshot.reviewJobId !== dispatch.headCycleId
    || custody.sourceSnapshot.acceptanceContractId !== dispatch.acceptanceContractId
    || custody.sourceSnapshot.acceptanceContractVersion !== dispatch.acceptanceContractVersion
    || custody.acceptanceContractSha256 !== dispatch.acceptanceContractSha256
    || !isDeepStrictEqual(custody.sourceSnapshot.packetIds, dispatch.packetIds)
    || custody.sourceSnapshot.packetSetSha256 !== dispatch.packetSetSha256
    || custody.sourceSnapshot.correctionPacketPayloadSetSha256
      !== dispatch.correctionPacketPayloadSetSha256
    || custody.correctionPacketPayloadSetSha256
      !== dispatch.correctionPacketPayloadSetSha256) return null;
  const compiledPack = (await tx.select().from(acceptanceCompiledContextPacks).where(and(
    eq(acceptanceCompiledContextPacks.id, dispatch.compiledPackId),
    eq(acceptanceCompiledContextPacks.workspaceId, input.workspaceId),
    eq(acceptanceCompiledContextPacks.sourceSnapshotId, dispatch.sourceSnapshotId),
  )).limit(1))[0];
  if (!compiledPack || compiledPack.packSha256 !== dispatch.compiledPackSha256
    || compiledPack.compilerVersion !== dispatch.compilerVersion
    || compiledPack.policyVersion !== dispatch.policyVersion
    || compiledPack.jsonSha256 !== dispatch.jsonSha256
    || compiledPack.markdownSha256 !== dispatch.markdownSha256
    || compiledPack.sourceCustodyIdentitySha256
      !== dispatch.sourceCustodyIdentitySha256) return null;
  const reconstructed = parseCompiledAcceptanceContextPack({
    kind: "compiled_acceptance_context_pack", version: 1,
    binding: compiledPack.binding,
    compiler: { version: compiledPack.compilerVersion,
      policyVersion: compiledPack.policyVersion,
      byteCounter: "utf8_byte_upper_bound_v1", byteBudget: COMPILED_PACK_BYTE_BUDGET },
    manifest: compiledPack.manifest,
    sourceCustodyReceipt: compiledPack.sourceCustodyReceipt,
    exactHeadDependencyTreeProofs: compiledPack.exactHeadDependencyTreeProofs,
    representations: { jsonSha256: compiledPack.jsonSha256,
      markdownSha256: compiledPack.markdownSha256 },
    renderedByteCount: compiledPack.renderedByteCount,
    packSha256: compiledPack.packSha256,
  });
  if (!reconstructed || compiledPackIdentity(reconstructed) !== compiledPack.packSha256
    || !bindingMatchesCustody(compiledPack.binding, custody)
    || !receiptMatchesCustody(compiledPack.sourceCustodyReceipt, custody)) return null;
  return {
    dispatch, record, sourceSnapshot, custody,
    githubInstallationIdentitySha256:
      dispatch.capabilityProfileSnapshot["githubInstallationIdentitySha256"] as string,
  };
}

function preflightHasExactStoredFallbackBinding(
  row: AcceptanceCorrectionDispatchGithubPreflightRow,
  current: StoredGithubCorrectionFallbackBinding
): boolean {
  const d = current.dispatch;
  return row.id === acceptanceCorrectionDispatchGithubPreflightId({
    dispatchId: d.id, attempt: row.attempt,
  })
    && row.workspaceId === d.workspaceId && row.dispatchId === d.id
    && row.recordId === d.recordId && row.repo === d.repo
    && row.prNumber === d.prNumber && row.headSha === d.headSha
    && row.baseSha === current.sourceSnapshot.baseSha
    && row.headCycleId === d.headCycleId
    && row.authorityGeneration === d.authorityGeneration
    && row.dispatchIdentitySha256 === d.dispatchIdentitySha256
    && row.routeId === d.routeId && row.routeAdapter === d.routeAdapter
    && row.routeConfigurationVersion === d.routeConfigurationVersion
    && row.capabilityProfileId === d.capabilityProfileId
    && row.capabilityProfileSnapshotSha256 === d.capabilityProfileSnapshotSha256
    && row.githubInstallationIdentitySha256 === current.githubInstallationIdentitySha256
    && row.preflightProtocolVersion === GITHUB_CORRECTION_CARRIER_PREFLIGHT_PROTOCOL_VERSION
    && row.permissionContract === GITHUB_CORRECTION_CARRIER_PREFLIGHT_PERMISSION_CONTRACT
    && row.preflightIdentitySha256 === githubCorrectionCarrierPreflightIdentity(row)
    && hasValidGithubCorrectionCarrierPreflightResult(row);
}

function storedFallbackCarrierBinding(
  current: StoredGithubCorrectionFallbackBinding,
  readyPreflight: AcceptanceCorrectionDispatchGithubPreflightRow
): CurrentGithubCorrectionCarrierBinding {
  const d = current.dispatch;
  return {
    ...current,
    // Fallback replays from the immutable dispatch snapshots. These placeholder
    // row shapes are never used for mutable route/installation resolution.
    route: { id: d.routeId } as AcceptanceBuilderRouteRow,
    profile: {
      id: d.capabilityProfileId!,
      snapshot: d.capabilityProfileSnapshot!,
      snapshotSha256: d.capabilityProfileSnapshotSha256!,
      githubInstallationIdentitySha256: current.githubInstallationIdentitySha256,
    } as AcceptanceBuilderRouteCapabilityProfileRow,
    readyPreflight,
  };
}

type DurableCorrectionFallbackPriorAggregate =
  DurableCorrectionDispatchFallback["priorAggregate"];

type DurableCorrectionFallbackCandidate = {
  current: StoredGithubCorrectionFallbackBinding;
  trigger: DurableCorrectionDispatchFallbackTrigger;
  priorAggregate: DurableCorrectionFallbackPriorAggregate;
  findingCoverageSha256: string;
  publishedFindings: DurableCorrectionDispatchFallback["publishedFindings"];
};

type DurableCorrectionFallbackCandidateResolution =
  | { kind: "candidate"; candidate: DurableCorrectionFallbackCandidate }
  | { kind: "not_eligible" }
  | { kind: "not_current" };

async function resolveDurableCorrectionFallbackCandidateInTransaction(
  tx: DbTransaction,
  input: { workspaceId: string; dispatchId: string }
): Promise<DurableCorrectionFallbackCandidateResolution> {
  const current = await resolveStoredGithubCorrectionFallbackBindingInTransaction(tx, input);
  if (!current) return { kind: "not_current" };
  const d = current.dispatch;
  if (d.agentState !== "not_observed") return { kind: "not_eligible" };
  const acknowledgement = (await tx.select({ id: acceptanceCorrectionDispatchGithubClaudeAckReceipts.id })
    .from(acceptanceCorrectionDispatchGithubClaudeAckReceipts)
    .where(eq(acceptanceCorrectionDispatchGithubClaudeAckReceipts.dispatchId, d.id)).limit(1))[0];
  const repairObservation = (await tx.select({ id: acceptanceCorrectionDispatchGithubClaudeRepairObservations.id })
    .from(acceptanceCorrectionDispatchGithubClaudeRepairObservations)
    .where(eq(acceptanceCorrectionDispatchGithubClaudeRepairObservations.dispatchId, d.id)).limit(1))[0];
  if (acknowledgement || repairObservation) return { kind: "not_eligible" };

  const preflights = await tx.select().from(acceptanceCorrectionDispatchGithubPreflights)
    .where(and(
      eq(acceptanceCorrectionDispatchGithubPreflights.workspaceId, input.workspaceId),
      eq(acceptanceCorrectionDispatchGithubPreflights.dispatchId, d.id),
    )).orderBy(asc(acceptanceCorrectionDispatchGithubPreflights.attempt));
  for (let index = 0; index < preflights.length; index += 1) {
    const row = preflights[index]!;
    if (row.attempt !== index + 1
      || !preflightHasExactStoredFallbackBinding(row, current)
      || !await hasVerifiedGithubCorrectionCarrierPreflightEventsInTransaction(tx, row)) {
      throw new Error("Durable correction fallback preflight custody is invalid");
    }
  }
  const latest = preflights.at(-1);
  if (!latest || latest.status === "reserved") return { kind: "not_eligible" };

  const findingRows = await tx.select().from(acceptanceCorrectionDispatchGithubFindingPublications)
    .where(and(
      eq(acceptanceCorrectionDispatchGithubFindingPublications.workspaceId, input.workspaceId),
      eq(acceptanceCorrectionDispatchGithubFindingPublications.dispatchId, d.id),
    )).orderBy(asc(acceptanceCorrectionDispatchGithubFindingPublications.packetId));
  const activationRows = await tx.select().from(acceptanceCorrectionDispatchGithubActivations)
    .where(and(
      eq(acceptanceCorrectionDispatchGithubActivations.workspaceId, input.workspaceId),
      eq(acceptanceCorrectionDispatchGithubActivations.dispatchId, d.id),
    ));

  let trigger: DurableCorrectionDispatchFallbackTrigger;
  let priorAggregate: DurableCorrectionFallbackPriorAggregate;
  if (latest.status !== "ready") {
    if (findingRows.length || activationRows.length) {
      throw new Error("Durable correction fallback has carrier work without a ready preflight");
    }
    if (!isGithubCorrectionCarrierPreflightOutcome(latest.result)) {
      throw new Error("Durable correction fallback preflight result is invalid");
    }
    if (latest.result.kind === "remote_pr_not_active"
      || latest.result.kind === "remote_head_mismatch"
      || latest.result.kind === "remote_base_mismatch") return { kind: "not_current" };
    if (latest.result.kind === "ready") return { kind: "not_current" };
    if (latest.result.kind !== "installation_or_permission_denied"
      && latest.result.kind !== "github_unavailable"
      && latest.result.kind !== "invalid_github_response") return { kind: "not_eligible" };
    trigger = {
      stage: "github_preflight", preflightId: latest.id,
      preflightIdentitySha256: latest.preflightIdentitySha256,
      attempt: latest.attempt, reason: latest.result.kind,
    };
    priorAggregate = {
      deliveryState: "queued", agentState: "not_observed",
      findingsState: "not_started", activationState: "not_started",
    };
  } else {
    if (!isGithubCorrectionCarrierPreflightOutcome(latest.result)
      || latest.result.kind !== "ready"
      || latest.result.headSha !== d.headSha
      || latest.result.baseSha !== current.sourceSnapshot.baseSha) return { kind: "not_current" };
    const carrier = storedFallbackCarrierBinding(current, latest);
    if (findingRows.length > d.packetIds.length
      || findingRows.some((row) => !d.packetIds.includes(row.packetId))) {
      throw new Error("Durable correction fallback finding set is invalid");
    }
    for (const row of findingRows) {
      const packet = correctionPacketById(carrier, row.packetId);
      if (!packet || !publicationHasExactCurrentBinding({ publication: row, current: carrier, packet })
        || !await hasVerifiedGithubCorrectionFindingEventsInTransaction(tx, row)) {
        throw new Error("Durable correction fallback finding custody is invalid");
      }
    }
    const findingState = findingRows.some((row) => row.status === "ambiguous_hold")
      ? "ambiguous_hold" as const
      : findingRows.length === d.packetIds.length
        && findingRows.every((row) => row.status === "published" || row.status === "bounded_failed")
        ? "terminal" as const : findingRows.length ? "reserved" as const : "not_started" as const;
    if (activationRows.length > 1) throw new Error("Durable correction fallback activation is not singular");
    const activation = activationRows[0];
    if (activation) {
      if (findingState !== "terminal") {
        throw new Error("Durable correction fallback activation lacks terminal finding custody");
      }
      const findingCoverageSha256 = githubCorrectionFindingCoverageSha256(findingRows);
      const hasUnsafeFinding = findingRows.some((row) => row.body === null
        || row.resultReason === "invalid_db_issued_body");
      if (!activationHasExactCurrentBinding({ activation, current: carrier,
        findingCoverageSha256, hasUnsafeFinding })
        || !await hasVerifiedGithubCorrectionActivationEventsInTransaction(tx, activation)) {
        throw new Error("Durable correction fallback activation custody is invalid");
      }
      if (activation.status === "carrier_accepted") return { kind: "not_eligible" };
      const activationReason = activation.resultReason;
      priorAggregate = {
        deliveryState: activation.status === "ambiguous_hold" ? "ambiguous_hold"
          : activation.status === "bounded_failed" ? "failed" : "queued",
        agentState: "not_observed", findingsState: "terminal",
        activationState: activation.status === "ambiguous_hold" ? "ambiguous_hold"
          : activation.status === "bounded_failed" ? "failed" : "reserved",
      };
      if (activation.status === "ambiguous_hold") {
        if (activationReason !== "github_unavailable"
          && activationReason !== "ambiguous_response") {
          throw new Error("Durable correction fallback activation ambiguity is invalid");
        }
        trigger = {
          stage: "github_activation", activationId: activation.id,
          activationIdentitySha256: activation.activationIdentitySha256,
          reason: activationReason,
        };
      } else if (activation.status === "bounded_failed") {
        if (activationReason !== "github_rejected"
          && activationReason !== "activation_body_too_large"
          && activationReason !== "invalid_db_issued_body") {
          throw new Error("Durable correction fallback activation failure is invalid");
        }
        trigger = { stage: "github_activation", activationId: activation.id,
          activationIdentitySha256: activation.activationIdentitySha256,
          reason: activationReason };
      } else {
        trigger = { stage: "server_observation", readyPreflightId: latest.id,
          readyPreflightIdentitySha256: latest.preflightIdentitySha256,
          reason: "selected_github_carrier_not_accepted" };
      }
    } else {
      const ambiguous = findingRows.find((row) => row.status === "ambiguous_hold");
      priorAggregate = {
        deliveryState: ambiguous ? "ambiguous_hold" : "queued",
        agentState: "not_observed", findingsState: findingState,
        activationState: "not_started",
      };
      if (ambiguous) {
        const findingReason = ambiguous.resultReason;
        if (findingReason !== "github_unavailable"
          && findingReason !== "ambiguous_response") {
          throw new Error("Durable correction fallback finding ambiguity is invalid");
        }
        trigger = { stage: "github_finding", publicationId: ambiguous.id,
          publicationIdentitySha256: ambiguous.publicationIdentitySha256,
          packetId: ambiguous.packetId, reason: findingReason };
      } else {
        trigger = { stage: "server_observation", readyPreflightId: latest.id,
          readyPreflightIdentitySha256: latest.preflightIdentitySha256,
          reason: "selected_github_carrier_not_accepted" };
      }
    }
  }

  if (d.deliveryState === "fallback" && d.activationState === "fallback") {
    if (d.findingsState !== priorAggregate.findingsState) return { kind: "not_current" };
  } else {
    if (d.deliveryState !== priorAggregate.deliveryState
      || d.agentState !== priorAggregate.agentState
      || d.findingsState !== priorAggregate.findingsState
      || d.activationState !== priorAggregate.activationState) return { kind: "not_current" };
  }
  const publishedFindings = findingRows.filter((row) => row.status === "published").map((row) => ({
    publicationId: row.id, publicationIdentitySha256: row.publicationIdentitySha256,
    packetId: row.packetId,
    githubCommentId: row.githubCommentId!, githubCommentUrl: row.githubCommentUrl!,
  }));
  return { kind: "candidate", candidate: {
    current, trigger, priorAggregate,
    findingCoverageSha256: githubCorrectionFindingCoverageSha256(findingRows),
    publishedFindings,
  } };
}

function durableCorrectionFallbackValues(
  candidate: DurableCorrectionFallbackCandidate
): DurableCorrectionDispatchFallback {
  const { current, trigger, priorAggregate, findingCoverageSha256, publishedFindings } = candidate;
  const d = current.dispatch;
  const lane: DurableCorrectionDispatchFallbackLane = publishedFindings.length
    ? "github_findings_and_jace" : "jace_only";
  const reason = trigger.reason;
  const body = [
    "## AgentRail correction fallback",
    "",
    `Jace recorded durable correction custody for ${d.repo} PR #${d.prNumber} at exact head ${d.headSha}.`,
    `Dispatch: ${d.id}`,
    `Context Pack: ${d.compiledPackId} (${d.compiledPackSha256})`,
    `Correction packets: ${d.packetIds.length} (${d.packetSetSha256})`,
    `Fallback reason: ${reason}`,
    `Existing verified GitHub finding comments: ${publishedFindings.length}/${d.packetIds.length}.`,
    "",
    "This fallback does not prove vendor activation, agent start or acknowledgement, or a repair head.",
    "Any new PR head must re-enter exact-head review.",
  ].join("\n");
  if (Buffer.byteLength(body, "utf8") > MAX_DURABLE_CORRECTION_FALLBACK_NOTICE_BYTES
    || body.includes("@")) {
    throw new Error("Durable correction fallback notice is invalid");
  }
  const withoutIdentity = {
    kind: "acceptance_correction_dispatch_durable_fallback" as const,
    version: DURABLE_CORRECTION_FALLBACK_PROTOCOL_VERSION,
    id: acceptanceCorrectionDispatchDurableFallbackId({ dispatchId: d.id }),
    workspaceId: d.workspaceId, recordId: d.recordId, repo: d.repo,
    prNumber: d.prNumber, baseSha: current.sourceSnapshot.baseSha!,
    headSha: d.headSha, headCycleId: d.headCycleId,
    authorityGeneration: d.authorityGeneration,
    dispatch: { id: d.id, identitySha256: d.dispatchIdentitySha256 },
    route: { id: d.routeId,
      adapter: d.routeAdapter as "github_codex" | "github_claude",
      configurationVersion: d.routeConfigurationVersion,
      capabilityProfileId: d.capabilityProfileId!,
      capabilityProfileSnapshotSha256: d.capabilityProfileSnapshotSha256! },
    contextPack: { id: d.compiledPackId, sha256: d.compiledPackSha256,
      sourceSnapshotId: d.sourceSnapshotId,
      sourceCustodyIdentitySha256: d.sourceCustodyIdentitySha256 },
    packets: { ids: [...d.packetIds], setSha256: d.packetSetSha256,
      payloadSetSha256: d.correctionPacketPayloadSetSha256 },
    trigger, priorAggregate, lane, findingCoverageSha256, publishedFindings,
    notice: { carrier: "durable_notice" as const, body,
      bodySha256: createHash("sha256").update(body, "utf8").digest("hex") },
    truthBoundary: { vendorActivation: "not_proven" as const,
      agentStarted: "not_proven" as const, agentAcknowledged: "not_proven" as const,
      repairHead: "not_proven" as const },
  };
  return {
    ...withoutIdentity,
    fallbackIdentitySha256: acceptanceContextPackCanonicalSha256(withoutIdentity),
  };
}

function durableCorrectionFallbackEventPayload(input: {
  fallback: DurableCorrectionDispatchFallback;
  kind: "reserved" | "recorded";
}): Record<string, unknown> {
  return {
    kind: input.kind === "reserved"
      ? "acceptance_correction_dispatch_durable_fallback_reserved"
      : "acceptance_correction_dispatch_durable_fallback_recorded",
    version: DURABLE_CORRECTION_FALLBACK_PROTOCOL_VERSION,
    fallback: input.fallback,
  };
}

async function readDurableCorrectionDispatchFallbackInTransaction(
  tx: DbTransaction,
  input: { workspaceId: string; dispatchId: string }
): Promise<ReadDurableCorrectionDispatchFallbackResult> {
  const existing = (await tx.select({ id: acceptanceCorrectionDispatches.id })
    .from(acceptanceCorrectionDispatches).where(and(
      eq(acceptanceCorrectionDispatches.id, input.dispatchId),
      eq(acceptanceCorrectionDispatches.workspaceId, input.workspaceId),
    )).limit(1))[0];
  if (!existing) return { kind: "absent" };
  const current = await resolveStoredGithubCorrectionFallbackBindingInTransaction(tx, input);
  if (!current) return { kind: "not_current" };
  const reservedKey = `acceptance-correction-dispatch:durable-fallback:reserved:${current.dispatch.headCycleId}`;
  const recordedKey = `acceptance-correction-dispatch:durable-fallback:recorded:${current.dispatch.headCycleId}`;
  const events = await tx.select().from(changeRecordEvents).where(and(
    eq(changeRecordEvents.recordId, current.dispatch.recordId),
    inArray(changeRecordEvents.eventKey, [reservedKey, recordedKey]),
  ));
  if (events.length === 0) {
    if (current.dispatch.deliveryState === "fallback"
      || current.dispatch.activationState === "fallback") {
      throw new Error("Durable correction fallback projection has no event custody");
    }
    return { kind: "absent" };
  }
  if (events.length !== 2) throw new Error("Durable correction fallback event custody is incomplete");
  const candidate = await resolveDurableCorrectionFallbackCandidateInTransaction(tx, input);
  if (candidate.kind !== "candidate") {
    throw new Error("Durable correction fallback event no longer matches its source custody");
  }
  const fallback = durableCorrectionFallbackValues(candidate.candidate);
  const reserved = events.find((event) => event.eventKey === reservedKey);
  const recorded = events.find((event) => event.eventKey === recordedKey);
  if (!reserved || !recorded
    || reserved.stage !== "builder_handoff" || recorded.stage !== "builder_handoff"
    || reserved.actor !== "server:durable-correction-fallback"
    || recorded.actor !== "server:durable-correction-fallback"
    || !isDeepStrictEqual(reserved.payloadRef,
      durableCorrectionFallbackEventPayload({ fallback, kind: "reserved" }))
    || !isDeepStrictEqual(recorded.payloadRef,
      durableCorrectionFallbackEventPayload({ fallback, kind: "recorded" }))
    || current.dispatch.deliveryState !== "fallback"
    || current.dispatch.activationState !== "fallback"
    || current.dispatch.agentState !== "not_observed") {
    throw new Error("Durable correction fallback event custody is invalid");
  }
  return { kind: "found", fallback };
}

/** Replay-only lookup; absence never creates a fallback or changes dispatch state. */
export async function readDurableCorrectionDispatchFallback(
  input: RecordDurableCorrectionDispatchFallbackInput
): Promise<ReadDurableCorrectionDispatchFallbackResult> {
  if (!isRecord(input) || !hasExactKeys(input, ["workspaceId", "dispatchId"])
    || !isUuid(input.workspaceId) || !isUuid(input.dispatchId)) {
    throw new Error("Durable correction fallback read requires only workspace and dispatch");
  }
  const candidate = (await db.select().from(acceptanceCorrectionDispatches).where(and(
    eq(acceptanceCorrectionDispatches.id, input.dispatchId),
    eq(acceptanceCorrectionDispatches.workspaceId, input.workspaceId),
  )).limit(1))[0];
  if (!candidate) return { kind: "absent" };
  const lockKey = acceptanceRecordPullRequestLockKey({
    workspaceId: input.workspaceId, recordId: candidate.recordId,
    repo: candidate.repo, prNumber: candidate.prNumber,
  });
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    return readDurableCorrectionDispatchFallbackInTransaction(tx, input);
  });
}

/**
 * Atomically records the selected dispatch's same-head durable Jace custody.
 * The trusted production caller invokes this only after its selected GitHub
 * carrier did not produce an accepted activation; no caller body or route is admitted.
 */
export async function recordDurableCorrectionDispatchFallback(
  input: RecordDurableCorrectionDispatchFallbackInput
): Promise<RecordDurableCorrectionDispatchFallbackResult> {
  if (!isRecord(input) || !hasExactKeys(input, ["workspaceId", "dispatchId"])
    || !isUuid(input.workspaceId) || !isUuid(input.dispatchId)) {
    throw new Error("Durable correction fallback record requires only workspace and dispatch");
  }
  const candidate = (await db.select().from(acceptanceCorrectionDispatches).where(and(
    eq(acceptanceCorrectionDispatches.id, input.dispatchId),
    eq(acceptanceCorrectionDispatches.workspaceId, input.workspaceId),
  )).limit(1))[0];
  if (!candidate) return { kind: "not_current" };
  const lockKey = acceptanceRecordPullRequestLockKey({
    workspaceId: input.workspaceId, recordId: candidate.recordId,
    repo: candidate.repo, prNumber: candidate.prNumber,
  });
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const replay = await readDurableCorrectionDispatchFallbackInTransaction(tx, input);
    if (replay.kind === "found") return { kind: "replayed", fallback: replay.fallback };
    if (replay.kind === "not_current") return replay;
    const resolved = await resolveDurableCorrectionFallbackCandidateInTransaction(tx, input);
    if (resolved.kind !== "candidate") return resolved;
    const fallback = durableCorrectionFallbackValues(resolved.candidate);
    const eventInputs: AppendChangeRecordEventInput[] = ["reserved", "recorded"].map((kind) => ({
      recordId: resolved.candidate.current.record.id,
      eventKey: `acceptance-correction-dispatch:durable-fallback:${kind}:${resolved.candidate.current.dispatch.headCycleId}`,
      stage: "builder_handoff", actor: "server:durable-correction-fallback",
      payloadRef: durableCorrectionFallbackEventPayload({
        fallback, kind: kind as "reserved" | "recorded",
      }),
    }));
    const events = await appendChangeRecordEventsAtomicallyInTransaction(tx, eventInputs);
    if (events.events.some((event) => !event.inserted)) {
      throw new Error("Durable correction fallback event unexpectedly replayed");
    }
    const prior = resolved.candidate.priorAggregate;
    const updated = await tx.update(acceptanceCorrectionDispatches).set({
      deliveryState: "fallback", activationState: "fallback", updatedAt: new Date(),
    }).where(and(
      eq(acceptanceCorrectionDispatches.id, input.dispatchId),
      eq(acceptanceCorrectionDispatches.workspaceId, input.workspaceId),
      isNull(acceptanceCorrectionDispatches.invalidatedAt),
      eq(acceptanceCorrectionDispatches.headSha, resolved.candidate.current.dispatch.headSha),
      eq(acceptanceCorrectionDispatches.headCycleId, resolved.candidate.current.dispatch.headCycleId),
      eq(acceptanceCorrectionDispatches.authorityGeneration,
        resolved.candidate.current.dispatch.authorityGeneration),
      eq(acceptanceCorrectionDispatches.deliveryState, prior.deliveryState),
      eq(acceptanceCorrectionDispatches.agentState, "not_observed"),
      eq(acceptanceCorrectionDispatches.findingsState, prior.findingsState),
      eq(acceptanceCorrectionDispatches.activationState, prior.activationState),
      eq(acceptanceCorrectionDispatches.carrier, "github_comment"),
    )).returning({ id: acceptanceCorrectionDispatches.id });
    if (updated.length !== 1) {
      throw new Error("Durable correction fallback lost its exact dispatch precondition");
    }
    return { kind: "recorded", fallback };
  });
}

type GithubClaudeAcknowledgementBinding = {
  activation: AcceptanceCorrectionDispatchGithubActivationRow;
  dispatch: AcceptanceCorrectionDispatchRow;
  route: AcceptanceBuilderRouteRow;
  capabilityProfile: AcceptanceBuilderRouteCapabilityProfileRow;
  ackProfile: AcceptanceBuilderRouteGithubClaudeAckProfileRow;
};

export function acceptanceCorrectionDispatchGithubClaudeAckReceiptId(input: {
  dispatchId: string;
}): string {
  return uuid5Url(`acceptance-correction-dispatch-github-claude-ack:${input.dispatchId}`);
}

export function acceptanceCorrectionDispatchGithubClaudeRepairObservationId(input: {
  dispatchId: string;
}): string {
  return uuid5Url(`acceptance-correction-dispatch-github-claude-repair-observation:${input.dispatchId}`);
}

function githubClaudeOidcJtiLockKey(jtiSha256: string): string {
  return `github-claude-oidc-jti:${jtiSha256.toLowerCase()}`;
}

function githubClaudeAckReceiptCore(values: {
  id: string;
  workspaceId: string;
  dispatchId: string;
  activationId: string;
  recordId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  headCycleId: string;
  authorityGeneration: number;
  dispatchIdentitySha256: string;
  activationIdentitySha256: string;
  activationGithubCommentId: string;
  activationBodySha256: string;
  routeId: string;
  routeConfigurationVersion: number;
  capabilityProfileId: string;
  ackProfileId: string;
  ackProfileSnapshotSha256: string;
  acknowledgementProtocolVersion: number;
  provider: string;
  providerConclusion: string;
  providerSessionIdSha256: string;
  oidcIssuer: string;
  oidcAudience: string;
  oidcSubjectSha256: string;
  oidcRepository: string;
  oidcRepositoryId: string;
  oidcRepositoryOwner: string;
  oidcRepositoryOwnerId: string;
  oidcActorId: string;
  oidcActor: string;
  oidcEventName: string;
  oidcRef: string;
  oidcWorkflowRef: string;
  oidcWorkflowSha: string;
  oidcJobWorkflowRef: string;
  oidcJobWorkflowSha: string;
  oidcRunId: string;
  oidcRunAttempt: number;
  oidcCheckRunId: string;
}) {
  return {
    id: values.id,
    workspaceId: values.workspaceId,
    dispatchId: values.dispatchId,
    activationId: values.activationId,
    recordId: values.recordId,
    repo: values.repo,
    prNumber: values.prNumber,
    headSha: values.headSha,
    headCycleId: values.headCycleId,
    authorityGeneration: values.authorityGeneration,
    dispatchIdentitySha256: values.dispatchIdentitySha256,
    activationIdentitySha256: values.activationIdentitySha256,
    activationGithubCommentId: values.activationGithubCommentId,
    activationBodySha256: values.activationBodySha256,
    routeId: values.routeId,
    routeConfigurationVersion: values.routeConfigurationVersion,
    capabilityProfileId: values.capabilityProfileId,
    ackProfileId: values.ackProfileId,
    ackProfileSnapshotSha256: values.ackProfileSnapshotSha256,
    acknowledgementProtocolVersion: values.acknowledgementProtocolVersion,
    provider: values.provider,
    providerConclusion: values.providerConclusion,
    providerSessionIdSha256: values.providerSessionIdSha256,
    oidcIssuer: values.oidcIssuer,
    oidcAudience: values.oidcAudience,
    oidcSubjectSha256: values.oidcSubjectSha256,
    oidcRepository: values.oidcRepository,
    oidcRepositoryId: values.oidcRepositoryId,
    oidcRepositoryOwner: values.oidcRepositoryOwner,
    oidcRepositoryOwnerId: values.oidcRepositoryOwnerId,
    oidcActorId: values.oidcActorId,
    oidcActor: values.oidcActor,
    oidcEventName: values.oidcEventName,
    oidcRef: values.oidcRef,
    oidcWorkflowRef: values.oidcWorkflowRef,
    oidcWorkflowSha: values.oidcWorkflowSha,
    oidcJobWorkflowRef: values.oidcJobWorkflowRef,
    oidcJobWorkflowSha: values.oidcJobWorkflowSha,
    oidcRunId: values.oidcRunId,
    oidcRunAttempt: values.oidcRunAttempt,
    oidcCheckRunId: values.oidcCheckRunId,
  };
}

function githubClaudeAckReceiptIdentity(
  values: Parameters<typeof githubClaudeAckReceiptCore>[0]
): string {
  const { id: _id, ...identity } = githubClaudeAckReceiptCore(values);
  return acceptanceContextPackCanonicalSha256({
    kind: "acceptance_correction_dispatch_github_claude_ack_receipt",
    version: 1,
    ...identity,
  });
}

function githubClaudeAckReceiptComparable(
  row: AcceptanceCorrectionDispatchGithubClaudeAckReceiptRow
) {
  return githubClaudeAckReceiptCore(row);
}

function githubClaudeAckReceiptEventPayload(
  row: AcceptanceCorrectionDispatchGithubClaudeAckReceiptRow
): Record<string, unknown> {
  return {
    kind: "acceptance_correction_dispatch_github_claude_acknowledged",
    version: 1,
    receiptId: row.id,
    receiptIdentitySha256: row.receiptIdentitySha256,
    dispatch: { id: row.dispatchId, identitySha256: row.dispatchIdentitySha256 },
    activation: {
      id: row.activationId,
      identitySha256: row.activationIdentitySha256,
      githubCommentId: row.activationGithubCommentId,
      bodySha256: row.activationBodySha256,
    },
    recordId: row.recordId,
    repository: row.repo,
    prNumber: row.prNumber,
    headSha: row.headSha,
    headCycleId: row.headCycleId,
    authorityGeneration: row.authorityGeneration,
    route: {
      id: row.routeId,
      adapter: "github_claude",
      configurationVersion: row.routeConfigurationVersion,
    },
    capabilityProfileId: row.capabilityProfileId,
    acknowledgementProfile: {
      id: row.ackProfileId,
      snapshotSha256: row.ackProfileSnapshotSha256,
    },
    provider: row.provider,
    conclusion: row.providerConclusion,
    providerSessionIdSha256: row.providerSessionIdSha256,
    oidc: {
      issuer: row.oidcIssuer,
      audience: row.oidcAudience,
      subjectSha256: row.oidcSubjectSha256,
      repositoryId: row.oidcRepositoryId,
      repositoryOwnerId: row.oidcRepositoryOwnerId,
      actorId: row.oidcActorId,
      workflowRef: row.oidcWorkflowRef,
      workflowSha: row.oidcWorkflowSha,
      jobWorkflowRef: row.oidcJobWorkflowRef,
      jobWorkflowSha: row.oidcJobWorkflowSha,
      runId: row.oidcRunId,
      runAttempt: row.oidcRunAttempt,
      checkRunId: row.oidcCheckRunId,
      jtiSha256: row.oidcJtiSha256,
      issuedAt: Math.floor(row.oidcTokenIssuedAt.getTime() / 1_000),
      notBefore: Math.floor(row.oidcTokenNotBefore.getTime() / 1_000),
      expiresAt: Math.floor(row.oidcTokenExpiresAt.getTime() / 1_000),
    },
    protocolVersion: row.acknowledgementProtocolVersion,
    scopeBoundary: "agent_acknowledgement_only",
  };
}

async function hasVerifiedGithubClaudeAckReceiptEventInTransaction(
  tx: DbTransaction,
  row: AcceptanceCorrectionDispatchGithubClaudeAckReceiptRow
): Promise<boolean> {
  const event = (await tx.select().from(changeRecordEvents).where(and(
    eq(changeRecordEvents.recordId, row.recordId),
    eq(changeRecordEvents.eventKey,
      `acceptance-correction-dispatch:github-claude-ack:${row.headCycleId}`),
  )).limit(1))[0];
  return !!event && event.stage === "builder_handoff"
    && event.actor === "server:github-claude-ack"
    && event.at.getTime() === row.acknowledgedAt.getTime()
    && isDeepStrictEqual(event.payloadRef, githubClaudeAckReceiptEventPayload(row));
}

function hasExactFrozenCapabilityProfile(input: {
  route: AcceptanceBuilderRouteRow;
  profile: AcceptanceBuilderRouteCapabilityProfileRow;
  dispatch: AcceptanceCorrectionDispatchRow;
}): boolean {
  const expected = builderRouteCapabilityProfileValues({
    route: input.route,
    githubInstallationIdentitySha256: input.profile.githubInstallationIdentitySha256,
    recordedBy: input.profile.recordedBy,
  });
  return input.profile.id === input.dispatch.capabilityProfileId
    && input.profile.snapshotSha256 === input.dispatch.capabilityProfileSnapshotSha256
    && isDeepStrictEqual(input.profile.snapshot, input.dispatch.capabilityProfileSnapshot)
    && isDeepStrictEqual(builderRouteCapabilityProfileComparable(input.profile), expected);
}

async function hasVerifiedCorrectionDispatchInvalidationInTransaction(
  tx: DbTransaction,
  dispatch: AcceptanceCorrectionDispatchRow
): Promise<boolean> {
  if (!dispatch.invalidatedAt
    || (dispatch.invalidationReason !== "head_advanced"
      && dispatch.invalidationReason !== "reconciled")
    || dispatch.successorHeadSha == null
    || dispatch.successorHeadCycleId == null) return false;
  const invalidated = (await tx.select().from(changeRecordEvents).where(and(
    eq(changeRecordEvents.recordId, dispatch.recordId),
    eq(changeRecordEvents.eventKey,
      `acceptance-correction-dispatch:invalidated:${dispatch.headCycleId}`),
  )).limit(1))[0];
  if (!invalidated || invalidated.stage !== "builder_handoff"
    || invalidated.actor !== "server:dispatch-preparation"
    || !isRecord(invalidated.payloadRef)
    || !hasExactKeys(invalidated.payloadRef, [
      "kind", "version", "dispatchId", "dispatchIdentitySha256", "reason",
      "headSha", "headCycleId", "successorHeadSha", "successorHeadCycleId",
    ])
    || invalidated.payloadRef["kind"] !== "acceptance_correction_dispatch_invalidated"
    || invalidated.payloadRef["version"] !== 1
    || invalidated.payloadRef["dispatchId"] !== dispatch.id
    || invalidated.payloadRef["dispatchIdentitySha256"] !== dispatch.dispatchIdentitySha256
    || invalidated.payloadRef["reason"] !== dispatch.invalidationReason
    || invalidated.payloadRef["headSha"] !== dispatch.headSha
    || invalidated.payloadRef["headCycleId"] !== dispatch.headCycleId) return false;
  const eventSuccessorHeadSha = invalidated.payloadRef["successorHeadSha"];
  const eventSuccessorHeadCycleId = invalidated.payloadRef["successorHeadCycleId"];
  if (eventSuccessorHeadSha === dispatch.successorHeadSha
    && eventSuccessorHeadCycleId === dispatch.successorHeadCycleId) return true;
  if (eventSuccessorHeadSha !== null || eventSuccessorHeadCycleId !== null
    || dispatch.successorHeadSha == null || dispatch.successorHeadCycleId == null) return false;
  const successor = (await tx.select().from(changeRecordEvents).where(and(
    eq(changeRecordEvents.recordId, dispatch.recordId),
    eq(changeRecordEvents.eventKey,
      `acceptance-correction-dispatch:successor:${dispatch.headCycleId}:${dispatch.successorHeadCycleId}`),
  )).limit(1))[0];
  return !!successor && successor.stage === "builder_handoff"
    && successor.actor === "server:dispatch-preparation"
    && isDeepStrictEqual(successor.payloadRef, {
      kind: "acceptance_correction_dispatch_successor_recorded",
      version: 1,
      dispatchId: dispatch.id,
      dispatchIdentitySha256: dispatch.dispatchIdentitySha256,
      invalidationReason: dispatch.invalidationReason,
      successorHeadSha: dispatch.successorHeadSha,
      successorHeadCycleId: dispatch.successorHeadCycleId,
    });
}

async function resolveFrozenGithubClaudeAcknowledgementBindingInTransaction(
  tx: DbTransaction,
  activation: AcceptanceCorrectionDispatchGithubActivationRow
): Promise<GithubClaudeAcknowledgementBinding | null> {
  const dispatch = (await tx.select().from(acceptanceCorrectionDispatches).where(and(
    eq(acceptanceCorrectionDispatches.id, activation.dispatchId),
    eq(acceptanceCorrectionDispatches.workspaceId, activation.workspaceId),
  )).limit(1))[0];
  if (!dispatch || dispatch.routeAdapter !== "github_claude"
    || dispatch.carrier !== "github_comment" || dispatch.capabilityProfileId == null
    || dispatch.capabilityProfileSnapshot == null
    || dispatch.capabilityProfileSnapshotSha256 == null
    || dispatch.deliveryState !== "carrier_accepted"
    || dispatch.findingsState !== "terminal"
    || dispatch.activationState !== "carrier_accepted"
    || (dispatch.agentState !== "not_observed" && dispatch.agentState !== "acknowledged")) return null;
  const original = correctionDispatchOriginalComparable(dispatch);
  if (correctionDispatchIdentity(original) !== dispatch.dispatchIdentitySha256) return null;
  const queued = (await tx.select().from(changeRecordEvents).where(and(
    eq(changeRecordEvents.recordId, dispatch.recordId),
    eq(changeRecordEvents.eventKey,
      `acceptance-correction-dispatch:queued:${dispatch.headCycleId}`),
  )).limit(1))[0];
  if (!queued || queued.stage !== "builder_handoff"
    || queued.actor !== "server:dispatch-preparation"
    || !isDeepStrictEqual(queued.payloadRef, correctionDispatchQueuedEventPayload(original))) return null;
  const route = (await tx.select().from(acceptanceBuilderRoutes).where(and(
    eq(acceptanceBuilderRoutes.id, dispatch.routeId),
    eq(acceptanceBuilderRoutes.workspaceId, dispatch.workspaceId),
    eq(acceptanceBuilderRoutes.repo, dispatch.repo),
    eq(acceptanceBuilderRoutes.adapter, "github_claude"),
  )).limit(1))[0];
  const frozenRoute = route && {
    ...route,
    configurationVersion: dispatch.routeConfigurationVersion,
  };
  const capabilityProfile = route && (await tx.select()
    .from(acceptanceBuilderRouteCapabilityProfiles).where(and(
      eq(acceptanceBuilderRouteCapabilityProfiles.id, dispatch.capabilityProfileId),
      eq(acceptanceBuilderRouteCapabilityProfiles.workspaceId, dispatch.workspaceId),
      eq(acceptanceBuilderRouteCapabilityProfiles.routeId, dispatch.routeId),
      eq(acceptanceBuilderRouteCapabilityProfiles.routeConfigurationVersion,
        dispatch.routeConfigurationVersion),
    )).limit(1))[0];
  if (!frozenRoute || !capabilityProfile || !hasExactFrozenCapabilityProfile({
    route: frozenRoute, profile: capabilityProfile, dispatch,
  })) return null;
  const ackProfile = (await tx.select().from(acceptanceBuilderRouteGithubClaudeAckProfiles).where(and(
    eq(acceptanceBuilderRouteGithubClaudeAckProfiles.workspaceId, dispatch.workspaceId),
    eq(acceptanceBuilderRouteGithubClaudeAckProfiles.routeId, dispatch.routeId),
    eq(acceptanceBuilderRouteGithubClaudeAckProfiles.routeConfigurationVersion,
      dispatch.routeConfigurationVersion),
  )).limit(1))[0];
  if (!ackProfile || ackProfile.capabilityProfileId !== capabilityProfile.id
    || ackProfile.capabilityProfileSnapshotSha256 !== capabilityProfile.snapshotSha256
    || !isDeepStrictEqual(githubClaudeAckProfileComparable(ackProfile), githubClaudeAckProfileValues({
      route: frozenRoute,
      capabilityProfile,
      githubRepositoryId: ackProfile.githubRepositoryId,
      githubRepositoryOwnerId: ackProfile.githubRepositoryOwnerId,
      githubAppBotUserId: ackProfile.githubAppBotUserId,
      githubAppBotLogin: ackProfile.githubAppBotLogin,
      callerWorkflowRef: ackProfile.callerWorkflowRef,
      jobWorkflowRef: ackProfile.jobWorkflowRef,
      jobWorkflowSha: ackProfile.jobWorkflowSha,
      claudeActionSha: ackProfile.claudeActionSha,
      recordedBy: ackProfile.recordedBy,
    }))) return null;
  const preflight = (await tx.select().from(acceptanceCorrectionDispatchGithubPreflights).where(and(
    eq(acceptanceCorrectionDispatchGithubPreflights.id, activation.readyPreflightId),
    eq(acceptanceCorrectionDispatchGithubPreflights.workspaceId, dispatch.workspaceId),
    eq(acceptanceCorrectionDispatchGithubPreflights.dispatchId, dispatch.id),
  )).limit(1))[0];
  if (!preflight || preflight.status !== "ready"
    || preflight.preflightIdentitySha256 !== activation.readyPreflightIdentitySha256
    || !isGithubCorrectionCarrierPreflightOutcome(preflight.result)
    || preflight.result.kind !== "ready"
    || preflight.result.headSha !== dispatch.headSha
    || preflight.result.baseSha !== activation.baseSha
    || !preflightMatchesValues(preflight, githubCorrectionCarrierPreflightValues({
      dispatch, profile: capabilityProfile, baseSha: activation.baseSha,
      attempt: preflight.attempt,
    }))
    || !await hasVerifiedGithubCorrectionCarrierPreflightEventsInTransaction(tx, preflight)) return null;
  const exactActivation = activation.id === acceptanceCorrectionDispatchGithubActivationId({
    dispatchId: dispatch.id,
  })
    && activation.workspaceId === dispatch.workspaceId
    && activation.recordId === dispatch.recordId
    && activation.repo === dispatch.repo
    && activation.prNumber === dispatch.prNumber
    && activation.headSha === dispatch.headSha
    && activation.headCycleId === dispatch.headCycleId
    && activation.authorityGeneration === dispatch.authorityGeneration
    && activation.dispatchIdentitySha256 === dispatch.dispatchIdentitySha256
    && activation.routeId === dispatch.routeId
    && activation.routeAdapter === "github_claude"
    && activation.routeConfigurationVersion === dispatch.routeConfigurationVersion
    && activation.capabilityProfileId === capabilityProfile.id
    && activation.capabilityProfileSnapshotSha256 === capabilityProfile.snapshotSha256
    && activation.githubInstallationIdentitySha256 === capabilityProfile.githubInstallationIdentitySha256
    && activation.carrier === "github_issue_comment"
    && activation.recipient === "claude"
    && activation.packetSetSha256 === dispatch.packetSetSha256
    && activation.correctionPacketPayloadSetSha256 === dispatch.correctionPacketPayloadSetSha256
    && activation.status === "carrier_accepted"
    && activation.resultReason == null
    && activation.body != null
    && activation.bodySha256 != null
    && createHash("sha256").update(activation.body, "utf8").digest("hex") === activation.bodySha256
    && activation.githubCommentId != null
    && activation.githubCommentUrl === canonicalGithubCorrectionCommentUrl({
      repo: activation.repo,
      prNumber: activation.prNumber,
      githubCommentId: activation.githubCommentId,
    })
    && githubCorrectionActivationIdentity(githubCorrectionActivationComparable(activation))
      === activation.activationIdentitySha256
    && activationMatchesDispatchAggregate(activation, dispatch)
    && await hasVerifiedGithubCorrectionActivationEventsInTransaction(tx, activation);
  return exactActivation
    ? { activation, dispatch, route: frozenRoute, capabilityProfile, ackProfile }
    : null;
}

async function resolveGithubClaudeAcknowledgementBindingInTransaction(
  tx: DbTransaction,
  activation: AcceptanceCorrectionDispatchGithubActivationRow
): Promise<{ binding: GithubClaudeAcknowledgementBinding; historical: boolean } | null> {
  const frozen = await resolveFrozenGithubClaudeAcknowledgementBindingInTransaction(tx, activation);
  if (!frozen) return null;
  if (frozen.dispatch.invalidatedAt) {
    return await hasVerifiedCorrectionDispatchInvalidationInTransaction(tx, frozen.dispatch)
      ? { binding: frozen, historical: true }
      : null;
  }
  const current = await resolveCurrentGithubCorrectionCarrierBindingInTransaction(tx, {
    workspaceId: activation.workspaceId,
    dispatchId: activation.dispatchId,
  });
  const coverage = current
    && await resolveTerminalGithubCorrectionFindingCoverageInTransaction(tx, current);
  if (!current || !coverage
    || current.dispatch.routeAdapter !== "github_claude"
    || current.dispatch.id !== frozen.dispatch.id
    || current.profile.id !== frozen.capabilityProfile.id
    || !activationHasExactCurrentBinding({
      activation,
      current,
      findingCoverageSha256: coverage.findingCoverageSha256,
      hasUnsafeFinding: coverage.hasUnsafeFinding,
    })
    || !activationMatchesDispatchAggregate(activation, current.dispatch)) return null;
  const activeAckProfile = await resolveAcceptanceBuilderRouteGithubClaudeAckProfileInTransaction(tx, {
    workspaceId: current.dispatch.workspaceId,
    route: current.route,
    capabilityProfile: current.profile,
  });
  return activeAckProfile?.id === frozen.ackProfile.id
    && activeAckProfile.snapshotSha256 === frozen.ackProfile.snapshotSha256
    ? { binding: frozen, historical: false }
    : null;
}

function isGithubClaudeNormalizedOidcClaims(input: unknown, expectedAudience: string | null):
  input is GithubClaudeAckNormalizedOidcClaims {
  if (!expectedAudience || !isRecord(input) || !hasExactKeys(input, [
      "issuer", "audience", "subject", "subjectSha256", "jtiSha256",
      "issuedAt", "notBefore", "expiresAt", "repository", "repositoryId",
      "repositoryOwner", "repositoryOwnerId", "actor", "actorId", "eventName", "ref",
      "workflowRef", "workflowSha", "jobWorkflowRef", "jobWorkflowSha",
      "runId", "runAttempt", "checkRunId",
    ])) return false;
  const claims = input as unknown as GithubClaudeAckNormalizedOidcClaims;
  const decimal = /^[1-9][0-9]{0,39}$/;
  const now = Math.floor(Date.now() / 1_000);
  return claims.issuer === GITHUB_CLAUDE_ACK_OIDC_ISSUER
    && claims.audience === expectedAudience
    && safeSnapshotText(claims.subject, 512)
    && EXACT_SHA256.test(claims.subjectSha256)
    && createHash("sha256").update(claims.subject, "utf8").digest("hex")
      === claims.subjectSha256.toLowerCase()
    && EXACT_SHA256.test(claims.jtiSha256)
    && Number.isSafeInteger(claims.issuedAt) && claims.issuedAt > 0
    && Number.isSafeInteger(claims.notBefore) && claims.notBefore > 0
    && Number.isSafeInteger(claims.expiresAt) && claims.expiresAt > 0
    && claims.notBefore <= claims.issuedAt && claims.issuedAt < claims.expiresAt
    && claims.expiresAt - claims.issuedAt <= 600
    && claims.issuedAt <= now + 60 && claims.expiresAt >= now - 60
    && safeRepo(claims.repository)
    && decimal.test(claims.repositoryId)
    && safeSnapshotText(claims.repositoryOwner, 100)
    && /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(claims.repositoryOwner)
    && decimal.test(claims.repositoryOwnerId)
    && safeSnapshotText(claims.actor, 106)
    && /^[A-Za-z0-9][A-Za-z0-9-]*\[bot\]$/.test(claims.actor)
    && decimal.test(claims.actorId)
    && claims.eventName === "issue_comment"
    && safeSnapshotText(claims.ref, 512) && claims.ref.startsWith("refs/heads/")
    && safeSnapshotText(claims.workflowRef, 1_024)
    && isSha1(claims.workflowSha)
    && safeSnapshotText(claims.jobWorkflowRef, 1_024)
    && isSha1(claims.jobWorkflowSha)
    && decimal.test(claims.runId)
    && claims.runAttempt === 1
    && decimal.test(claims.checkRunId);
}

function isGithubClaudeAcknowledgementInput(
  input: RecordGithubClaudeAgentAcknowledgementInput
): boolean {
  if (!isRecord(input) || !hasExactKeys(input, [
    "activationCommentId", "activationBodySha256", "conclusion", "providerSessionId", "oidc",
  ]) || !isPositiveGithubCommentId(input.activationCommentId)
    || !EXACT_SHA256.test(input.activationBodySha256)
    || input.conclusion !== "success"
    || !safeSnapshotText(input.providerSessionId, 256)
    || !isRecord(input.oidc)) return false;
  return isGithubClaudeNormalizedOidcClaims(input.oidc, githubClaudeAcknowledgementAudience({
    activationCommentId: input.activationCommentId,
    runId: input.oidc.runId as string,
    runAttempt: input.oidc.runAttempt as number,
  }));
}

function isGithubClaudeRepairObservationInput(
  input: RecordGithubClaudeRepairObservationInput
): boolean {
  if (!isRecord(input) || !hasExactKeys(input, [
    "activationCommentId", "activationBodySha256", "beforeHeadSha", "afterHeadSha",
    "providerSessionId", "oidc",
  ]) || !isPositiveGithubCommentId(input.activationCommentId)
    || !EXACT_SHA256.test(input.activationBodySha256)
    || !EXACT_GITHUB_HEAD_SHA.test(input.beforeHeadSha)
    || !EXACT_GITHUB_HEAD_SHA.test(input.afterHeadSha)
    || input.beforeHeadSha.toLowerCase() === input.afterHeadSha.toLowerCase()
    || !safeSnapshotText(input.providerSessionId, 256)
    || !isRecord(input.oidc)) return false;
  return isGithubClaudeNormalizedOidcClaims(input.oidc, githubClaudeRepairObservationAudience({
    activationCommentId: input.activationCommentId,
    activationBodySha256: input.activationBodySha256,
    beforeHeadSha: input.beforeHeadSha,
    afterHeadSha: input.afterHeadSha,
    runId: input.oidc.runId as string,
    runAttempt: input.oidc.runAttempt as number,
  }));
}

function githubClaudeAckReceiptValues(input: {
  binding: GithubClaudeAcknowledgementBinding;
  request: RecordGithubClaudeAgentAcknowledgementInput;
}) {
  const { activation, dispatch, ackProfile } = input.binding;
  const claims = input.request.oidc;
  const core = {
    id: acceptanceCorrectionDispatchGithubClaudeAckReceiptId({ dispatchId: dispatch.id }),
    workspaceId: dispatch.workspaceId,
    dispatchId: dispatch.id,
    activationId: activation.id,
    recordId: dispatch.recordId,
    repo: dispatch.repo,
    prNumber: dispatch.prNumber,
    headSha: dispatch.headSha.toLowerCase(),
    headCycleId: dispatch.headCycleId,
    authorityGeneration: dispatch.authorityGeneration,
    dispatchIdentitySha256: dispatch.dispatchIdentitySha256.toLowerCase(),
    activationIdentitySha256: activation.activationIdentitySha256.toLowerCase(),
    activationGithubCommentId: activation.githubCommentId!,
    activationBodySha256: activation.bodySha256!.toLowerCase(),
    routeId: dispatch.routeId,
    routeConfigurationVersion: dispatch.routeConfigurationVersion,
    capabilityProfileId: input.binding.capabilityProfile.id,
    ackProfileId: ackProfile.id,
    ackProfileSnapshotSha256: ackProfile.snapshotSha256.toLowerCase(),
    acknowledgementProtocolVersion: GITHUB_CLAUDE_ACK_PROTOCOL_VERSION,
    provider: "anthropic_claude_code_action" as const,
    providerConclusion: "success" as const,
    providerSessionIdSha256: createHash("sha256")
      .update(input.request.providerSessionId, "utf8").digest("hex"),
    oidcIssuer: claims.issuer,
    oidcAudience: claims.audience,
    oidcSubjectSha256: claims.subjectSha256.toLowerCase(),
    oidcRepository: claims.repository,
    oidcRepositoryId: claims.repositoryId,
    oidcRepositoryOwner: claims.repositoryOwner,
    oidcRepositoryOwnerId: claims.repositoryOwnerId,
    oidcActorId: claims.actorId,
    oidcActor: claims.actor,
    oidcEventName: claims.eventName,
    oidcRef: claims.ref,
    oidcWorkflowRef: claims.workflowRef,
    oidcWorkflowSha: claims.workflowSha.toLowerCase(),
    oidcJobWorkflowRef: claims.jobWorkflowRef,
    oidcJobWorkflowSha: claims.jobWorkflowSha.toLowerCase(),
    oidcRunId: claims.runId,
    oidcRunAttempt: claims.runAttempt,
    oidcCheckRunId: claims.checkRunId,
  };
  return {
    ...core,
    oidcTokenIssuedAt: new Date(claims.issuedAt * 1_000),
    oidcTokenNotBefore: new Date(claims.notBefore * 1_000),
    oidcTokenExpiresAt: new Date(claims.expiresAt * 1_000),
    oidcJtiSha256: claims.jtiSha256.toLowerCase(),
    receiptIdentitySha256: githubClaudeAckReceiptIdentity(core),
  };
}

function claimsMatchGithubClaudeAcknowledgementProfile(input: {
  request: Pick<RecordGithubClaudeAgentAcknowledgementInput,
    "activationCommentId" | "activationBodySha256" | "oidc">;
  binding: GithubClaudeAcknowledgementBinding;
}): boolean {
  const { request, binding } = input;
  const claims = request.oidc;
  const profile = binding.ackProfile;
  const workflowRefSuffix = profile.callerWorkflowRef.slice(
    profile.callerWorkflowRef.lastIndexOf("@") + 1
  );
  const [repositoryOwner, repositoryName] = binding.dispatch.repo.split("/");
  if (!repositoryOwner || !repositoryName) return false;
  const acceptedSubjects = new Set([
    `repo:${repositoryOwner}/${repositoryName}:ref:${claims.ref}`,
    `repo:${repositoryOwner}@${profile.githubRepositoryOwnerId}/${repositoryName}@${profile.githubRepositoryId}:ref:${claims.ref}`,
  ]);
  return request.activationCommentId === binding.activation.githubCommentId
    && request.activationBodySha256.toLowerCase() === binding.activation.bodySha256?.toLowerCase()
    && claims.repository === binding.dispatch.repo
    && claims.repositoryOwner === binding.dispatch.repo.split("/")[0]
    && claims.repositoryId === profile.githubRepositoryId
    && claims.repositoryOwnerId === profile.githubRepositoryOwnerId
    && claims.actor === profile.githubAppBotLogin
    && claims.actorId === profile.githubAppBotUserId
    && claims.workflowRef === profile.callerWorkflowRef
    && claims.jobWorkflowRef === profile.jobWorkflowRef
    && claims.jobWorkflowSha.toLowerCase() === profile.jobWorkflowSha.toLowerCase()
    && claims.ref === workflowRefSuffix
    && acceptedSubjects.has(claims.subject);
}

function receiptMatchesValues(
  receipt: AcceptanceCorrectionDispatchGithubClaudeAckReceiptRow,
  values: ReturnType<typeof githubClaudeAckReceiptValues>
): boolean {
  return isDeepStrictEqual(githubClaudeAckReceiptComparable(receipt), githubClaudeAckReceiptCore(values))
    && receipt.receiptIdentitySha256 === values.receiptIdentitySha256;
}

/**
 * Records one successful Claude Action session after a carrier-accepted final
 * activation. Carrier acceptance is revalidated, but this writes no repair or
 * successor projection and changes only the original dispatch's agent state.
 */
export async function recordGithubClaudeAgentAcknowledgement(
  input: RecordGithubClaudeAgentAcknowledgementInput
): Promise<RecordGithubClaudeAgentAcknowledgementResult> {
  if (!isGithubClaudeAcknowledgementInput(input)) {
    throw new Error("GitHub Claude acknowledgement input is invalid");
  }
  const candidate = (await db.select().from(acceptanceCorrectionDispatchGithubActivations).where(and(
    eq(acceptanceCorrectionDispatchGithubActivations.githubCommentId, input.activationCommentId),
    eq(acceptanceCorrectionDispatchGithubActivations.status, "carrier_accepted"),
  )).limit(1))[0];
  if (!candidate) return { kind: "not_admitted" };
  const lockKey = acceptanceRecordPullRequestLockKey({
    workspaceId: candidate.workspaceId,
    recordId: candidate.recordId,
    repo: candidate.repo,
    prNumber: candidate.prNumber,
  });
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${githubClaudeOidcJtiLockKey(
      input.oidc.jtiSha256
    )}))`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`github-claude-ack-run:${input.oidc.repositoryId}:${input.oidc.runId}`}))`);
    const activation = (await tx.select().from(acceptanceCorrectionDispatchGithubActivations).where(and(
      eq(acceptanceCorrectionDispatchGithubActivations.id, candidate.id),
      eq(acceptanceCorrectionDispatchGithubActivations.githubCommentId, input.activationCommentId),
      eq(acceptanceCorrectionDispatchGithubActivations.status, "carrier_accepted"),
    )).limit(1))[0];
    if (!activation) return { kind: "not_admitted" };
    const resolved = await resolveGithubClaudeAcknowledgementBindingInTransaction(tx, activation);
    if (!resolved || !claimsMatchGithubClaudeAcknowledgementProfile({
      request: input,
      binding: resolved.binding,
    })) return { kind: "not_admitted" };
    const values = githubClaudeAckReceiptValues({ binding: resolved.binding, request: input });
    const byJti = (await tx.select().from(acceptanceCorrectionDispatchGithubClaudeAckReceipts).where(
      eq(acceptanceCorrectionDispatchGithubClaudeAckReceipts.oidcJtiSha256,
        input.oidc.jtiSha256.toLowerCase())
    ).limit(1))[0];
    if (byJti && byJti.dispatchId !== resolved.binding.dispatch.id) {
      throw new GithubClaudeAgentAcknowledgementConflictError();
    }
    const byRepairJti = (await tx.select({
      id: acceptanceCorrectionDispatchGithubClaudeRepairObservations.id,
    }).from(acceptanceCorrectionDispatchGithubClaudeRepairObservations).where(
      eq(acceptanceCorrectionDispatchGithubClaudeRepairObservations.oidcJtiSha256,
        input.oidc.jtiSha256.toLowerCase())
    ).limit(1))[0];
    if (byRepairJti) throw new GithubClaudeAgentAcknowledgementConflictError();
    const byRun = (await tx.select().from(acceptanceCorrectionDispatchGithubClaudeAckReceipts).where(and(
      eq(acceptanceCorrectionDispatchGithubClaudeAckReceipts.oidcRepositoryId,
        input.oidc.repositoryId),
      eq(acceptanceCorrectionDispatchGithubClaudeAckReceipts.oidcRunId, input.oidc.runId),
    )).limit(1))[0];
    if (byRun && byRun.dispatchId !== resolved.binding.dispatch.id) {
      throw new GithubClaudeAgentAcknowledgementConflictError();
    }
    const existing = (await tx.select().from(acceptanceCorrectionDispatchGithubClaudeAckReceipts).where(
      eq(acceptanceCorrectionDispatchGithubClaudeAckReceipts.dispatchId,
        resolved.binding.dispatch.id)
    ).limit(1))[0];
    if (existing) {
      if (!receiptMatchesValues(existing, values)
        || (resolved.historical
          ? resolved.binding.dispatch.agentState !== "not_observed"
            && resolved.binding.dispatch.agentState !== "acknowledged"
          : resolved.binding.dispatch.agentState !== "acknowledged")
        || !await hasVerifiedGithubClaudeAckReceiptEventInTransaction(tx, existing)) {
        throw new GithubClaudeAgentAcknowledgementConflictError();
      }
      return { kind: "replayed", receipt: existing };
    }
    if (resolved.binding.dispatch.agentState !== "not_observed") {
      throw new GithubClaudeAgentAcknowledgementConflictError();
    }
    const projected = {
      ...values,
      acknowledgedAt: new Date(),
      createdAt: new Date(),
    } as AcceptanceCorrectionDispatchGithubClaudeAckReceiptRow;
    const event = await appendChangeRecordEventsAtomicallyInTransaction(tx, [{
      recordId: resolved.binding.dispatch.recordId,
      eventKey: `acceptance-correction-dispatch:github-claude-ack:${resolved.binding.dispatch.headCycleId}`,
      stage: "builder_handoff",
      actor: "server:github-claude-ack",
      payloadRef: githubClaudeAckReceiptEventPayload(projected),
      at: projected.acknowledgedAt,
    }]);
    if (!event.events[0]!.inserted) {
      throw new GithubClaudeAgentAcknowledgementConflictError();
    }
    const inserted = await tx.insert(acceptanceCorrectionDispatchGithubClaudeAckReceipts)
      .values(projected).returning();
    if (inserted.length !== 1) throw new Error("GitHub Claude acknowledgement receipt was not inserted");
    if (!resolved.historical) {
      const updated = await tx.update(acceptanceCorrectionDispatches).set({
        agentState: "acknowledged",
        updatedAt: new Date(),
      }).where(and(
        eq(acceptanceCorrectionDispatches.id, resolved.binding.dispatch.id),
        eq(acceptanceCorrectionDispatches.workspaceId, resolved.binding.dispatch.workspaceId),
        eq(acceptanceCorrectionDispatches.headCycleId, resolved.binding.dispatch.headCycleId),
        eq(acceptanceCorrectionDispatches.dispatchIdentitySha256,
          resolved.binding.dispatch.dispatchIdentitySha256),
        eq(acceptanceCorrectionDispatches.deliveryState, "carrier_accepted"),
        eq(acceptanceCorrectionDispatches.findingsState, "terminal"),
        eq(acceptanceCorrectionDispatches.activationState, "carrier_accepted"),
        eq(acceptanceCorrectionDispatches.agentState, "not_observed"),
      )).returning({ id: acceptanceCorrectionDispatches.id });
      if (updated.length !== 1) {
        throw new Error("GitHub Claude acknowledgement lost its dispatch agent-state precondition");
      }
    }
    return { kind: "recorded", receipt: inserted[0]! };
  });
}

export async function readGithubClaudeAgentAcknowledgement(input: {
  workspaceId: string;
  dispatchId: string;
}): Promise<AcceptanceCorrectionDispatchGithubClaudeAckReceiptRow | null> {
  if (!isRecord(input) || !hasExactKeys(input, ["workspaceId", "dispatchId"])
    || !isUuid(input.workspaceId) || !isUuid(input.dispatchId)) return null;
  return db.transaction(async (tx) => {
    const receipt = (await tx.select().from(acceptanceCorrectionDispatchGithubClaudeAckReceipts).where(and(
      eq(acceptanceCorrectionDispatchGithubClaudeAckReceipts.workspaceId, input.workspaceId),
      eq(acceptanceCorrectionDispatchGithubClaudeAckReceipts.dispatchId, input.dispatchId),
    )).limit(1))[0];
    if (!receipt || githubClaudeAckReceiptIdentity(receipt) !== receipt.receiptIdentitySha256
      || !await hasVerifiedGithubClaudeAckReceiptEventInTransaction(tx, receipt)) return null;
    const dispatch = (await tx.select().from(acceptanceCorrectionDispatches).where(and(
      eq(acceptanceCorrectionDispatches.id, receipt.dispatchId),
      eq(acceptanceCorrectionDispatches.workspaceId, receipt.workspaceId),
    )).limit(1))[0];
    const activation = dispatch && (await tx.select()
      .from(acceptanceCorrectionDispatchGithubActivations).where(and(
        eq(acceptanceCorrectionDispatchGithubActivations.id, receipt.activationId),
        eq(acceptanceCorrectionDispatchGithubActivations.dispatchId, dispatch.id),
      )).limit(1))[0];
    const resolved = activation
      && await resolveGithubClaudeAcknowledgementBindingInTransaction(tx, activation);
    if (!dispatch || !resolved || resolved.binding.dispatch.id !== dispatch.id) return null;
    return resolved.historical
      ? dispatch.agentState === "not_observed" || dispatch.agentState === "acknowledged"
        ? receipt : null
      : dispatch.agentState === "acknowledged" ? receipt : null;
  });
}

type GithubClaudeRepairObservationCoreInput = {
  id: string;
  workspaceId: string;
  dispatchId: string;
  activationId: string;
  acknowledgementReceiptId: string;
  acknowledgementReceiptIdentitySha256: string;
  recordId: string;
  repo: string;
  prNumber: number;
  originalHeadSha: string;
  originalHeadCycleId: string;
  authorityGeneration: number;
  dispatchIdentitySha256: string;
  activationIdentitySha256: string;
  activationGithubCommentId: string;
  activationBodySha256: string;
  routeId: string;
  routeConfigurationVersion: number;
  capabilityProfileId: string;
  acknowledgementProfileId: string;
  acknowledgementProfileSnapshotSha256: string;
  observationProtocolVersion: number;
  provider: string;
  providerSessionIdSha256: string;
  beforeHeadSha: string;
  afterHeadSha: string;
  oidcIssuer: string;
  oidcAudience: string;
  oidcSubjectSha256: string;
  oidcRepository: string;
  oidcRepositoryId: string;
  oidcRepositoryOwner: string;
  oidcRepositoryOwnerId: string;
  oidcActorId: string;
  oidcActor: string;
  oidcEventName: string;
  oidcRef: string;
  oidcWorkflowRef: string;
  oidcWorkflowSha: string;
  oidcJobWorkflowRef: string;
  oidcJobWorkflowSha: string;
  oidcRunId: string;
  oidcRunAttempt: number;
  oidcCheckRunId: string;
  oidcTokenIssuedAt: Date;
  oidcTokenNotBefore: Date;
  oidcTokenExpiresAt: Date;
  oidcJtiSha256: string;
};

function githubClaudeRepairObservationCore(values: GithubClaudeRepairObservationCoreInput) {
  return {
    id: values.id,
    workspaceId: values.workspaceId,
    dispatchId: values.dispatchId,
    activationId: values.activationId,
    acknowledgementReceiptId: values.acknowledgementReceiptId,
    acknowledgementReceiptIdentitySha256: values.acknowledgementReceiptIdentitySha256,
    recordId: values.recordId,
    repo: values.repo,
    prNumber: values.prNumber,
    originalHeadSha: values.originalHeadSha,
    originalHeadCycleId: values.originalHeadCycleId,
    authorityGeneration: values.authorityGeneration,
    dispatchIdentitySha256: values.dispatchIdentitySha256,
    activationIdentitySha256: values.activationIdentitySha256,
    activationGithubCommentId: values.activationGithubCommentId,
    activationBodySha256: values.activationBodySha256,
    routeId: values.routeId,
    routeConfigurationVersion: values.routeConfigurationVersion,
    capabilityProfileId: values.capabilityProfileId,
    acknowledgementProfileId: values.acknowledgementProfileId,
    acknowledgementProfileSnapshotSha256: values.acknowledgementProfileSnapshotSha256,
    observationProtocolVersion: values.observationProtocolVersion,
    provider: values.provider,
    providerSessionIdSha256: values.providerSessionIdSha256,
    beforeHeadSha: values.beforeHeadSha,
    afterHeadSha: values.afterHeadSha,
    oidcIssuer: values.oidcIssuer,
    oidcAudience: values.oidcAudience,
    oidcSubjectSha256: values.oidcSubjectSha256,
    oidcRepository: values.oidcRepository,
    oidcRepositoryId: values.oidcRepositoryId,
    oidcRepositoryOwner: values.oidcRepositoryOwner,
    oidcRepositoryOwnerId: values.oidcRepositoryOwnerId,
    oidcActorId: values.oidcActorId,
    oidcActor: values.oidcActor,
    oidcEventName: values.oidcEventName,
    oidcRef: values.oidcRef,
    oidcWorkflowRef: values.oidcWorkflowRef,
    oidcWorkflowSha: values.oidcWorkflowSha,
    oidcJobWorkflowRef: values.oidcJobWorkflowRef,
    oidcJobWorkflowSha: values.oidcJobWorkflowSha,
    oidcRunId: values.oidcRunId,
    oidcRunAttempt: values.oidcRunAttempt,
    oidcCheckRunId: values.oidcCheckRunId,
    oidcTokenIssuedAt: Math.floor(values.oidcTokenIssuedAt.getTime() / 1_000),
    oidcTokenNotBefore: Math.floor(values.oidcTokenNotBefore.getTime() / 1_000),
    oidcTokenExpiresAt: Math.floor(values.oidcTokenExpiresAt.getTime() / 1_000),
    oidcJtiSha256: values.oidcJtiSha256,
  };
}

function githubClaudeRepairObservationIdentity(values: GithubClaudeRepairObservationCoreInput): string {
  const { id: _id, ...identity } = githubClaudeRepairObservationCore(values);
  return acceptanceContextPackCanonicalSha256({
    kind: "acceptance_correction_dispatch_github_claude_repair_observation",
    version: 1,
    ...identity,
  });
}

function githubClaudeRepairObservationEventPayload(
  row: AcceptanceCorrectionDispatchGithubClaudeRepairObservationRow
): Record<string, unknown> {
  return {
    kind: "acceptance_correction_dispatch_github_claude_repair_observed",
    version: 1,
    observationId: row.id,
    observationIdentitySha256: row.observationIdentitySha256,
    acknowledgement: {
      receiptId: row.acknowledgementReceiptId,
      receiptIdentitySha256: row.acknowledgementReceiptIdentitySha256,
    },
    dispatch: { id: row.dispatchId, identitySha256: row.dispatchIdentitySha256 },
    activation: {
      id: row.activationId,
      identitySha256: row.activationIdentitySha256,
      githubCommentId: row.activationGithubCommentId,
      bodySha256: row.activationBodySha256,
    },
    recordId: row.recordId,
    repository: row.repo,
    prNumber: row.prNumber,
    originalHeadSha: row.originalHeadSha,
    originalHeadCycleId: row.originalHeadCycleId,
    authorityGeneration: row.authorityGeneration,
    observedTransition: { beforeHeadSha: row.beforeHeadSha, afterHeadSha: row.afterHeadSha },
    route: {
      id: row.routeId,
      adapter: "github_claude",
      configurationVersion: row.routeConfigurationVersion,
    },
    capabilityProfileId: row.capabilityProfileId,
    acknowledgementProfile: {
      id: row.acknowledgementProfileId,
      snapshotSha256: row.acknowledgementProfileSnapshotSha256,
    },
    provider: row.provider,
    providerSessionIdSha256: row.providerSessionIdSha256,
    oidc: {
      issuer: row.oidcIssuer,
      audience: row.oidcAudience,
      subjectSha256: row.oidcSubjectSha256,
      repositoryId: row.oidcRepositoryId,
      repositoryOwnerId: row.oidcRepositoryOwnerId,
      actorId: row.oidcActorId,
      workflowRef: row.oidcWorkflowRef,
      workflowSha: row.oidcWorkflowSha,
      jobWorkflowRef: row.oidcJobWorkflowRef,
      jobWorkflowSha: row.oidcJobWorkflowSha,
      runId: row.oidcRunId,
      runAttempt: row.oidcRunAttempt,
      checkRunId: row.oidcCheckRunId,
      jtiSha256: row.oidcJtiSha256,
      issuedAt: Math.floor(row.oidcTokenIssuedAt.getTime() / 1_000),
      notBefore: Math.floor(row.oidcTokenNotBefore.getTime() / 1_000),
      expiresAt: Math.floor(row.oidcTokenExpiresAt.getTime() / 1_000),
    },
    protocolVersion: row.observationProtocolVersion,
    attribution: "selected_run_observed_successor",
    authorship: "not_independently_proven",
    scopeBoundary: "repair_head_observation_only",
  };
}

async function hasVerifiedGithubClaudeRepairObservationEventInTransaction(
  tx: DbTransaction,
  row: AcceptanceCorrectionDispatchGithubClaudeRepairObservationRow
): Promise<boolean> {
  const event = (await tx.select().from(changeRecordEvents).where(and(
    eq(changeRecordEvents.recordId, row.recordId),
    eq(changeRecordEvents.eventKey,
      `acceptance-correction-dispatch:github-claude-repair-observation:${row.originalHeadCycleId}`),
  )).limit(1))[0];
  return !!event && event.stage === "builder_handoff"
    && event.actor === "server:github-claude-repair-observation"
    && event.at.getTime() === row.observedAt.getTime()
    && isDeepStrictEqual(event.payloadRef, githubClaudeRepairObservationEventPayload(row));
}

function githubClaudeRepairObservationValues(input: {
  binding: GithubClaudeAcknowledgementBinding;
  acknowledgement: AcceptanceCorrectionDispatchGithubClaudeAckReceiptRow;
  request: RecordGithubClaudeRepairObservationInput;
}) {
  const { dispatch, activation, capabilityProfile, ackProfile } = input.binding;
  const claims = input.request.oidc;
  const core = {
    id: acceptanceCorrectionDispatchGithubClaudeRepairObservationId({ dispatchId: dispatch.id }),
    workspaceId: dispatch.workspaceId,
    dispatchId: dispatch.id,
    activationId: activation.id,
    acknowledgementReceiptId: input.acknowledgement.id,
    acknowledgementReceiptIdentitySha256: input.acknowledgement.receiptIdentitySha256.toLowerCase(),
    recordId: dispatch.recordId,
    repo: dispatch.repo,
    prNumber: dispatch.prNumber,
    originalHeadSha: dispatch.headSha.toLowerCase(),
    originalHeadCycleId: dispatch.headCycleId,
    authorityGeneration: dispatch.authorityGeneration,
    dispatchIdentitySha256: dispatch.dispatchIdentitySha256.toLowerCase(),
    activationIdentitySha256: activation.activationIdentitySha256.toLowerCase(),
    activationGithubCommentId: activation.githubCommentId!,
    activationBodySha256: activation.bodySha256!.toLowerCase(),
    routeId: dispatch.routeId,
    routeConfigurationVersion: dispatch.routeConfigurationVersion,
    capabilityProfileId: capabilityProfile.id,
    acknowledgementProfileId: ackProfile.id,
    acknowledgementProfileSnapshotSha256: ackProfile.snapshotSha256.toLowerCase(),
    observationProtocolVersion: GITHUB_CLAUDE_REPAIR_OBSERVATION_PROTOCOL_VERSION,
    provider: "anthropic_claude_code_action" as const,
    providerSessionIdSha256: createHash("sha256")
      .update(input.request.providerSessionId, "utf8").digest("hex"),
    beforeHeadSha: input.request.beforeHeadSha.toLowerCase(),
    afterHeadSha: input.request.afterHeadSha.toLowerCase(),
    oidcIssuer: claims.issuer,
    oidcAudience: claims.audience,
    oidcSubjectSha256: claims.subjectSha256.toLowerCase(),
    oidcRepository: claims.repository,
    oidcRepositoryId: claims.repositoryId,
    oidcRepositoryOwner: claims.repositoryOwner,
    oidcRepositoryOwnerId: claims.repositoryOwnerId,
    oidcActorId: claims.actorId,
    oidcActor: claims.actor,
    oidcEventName: claims.eventName,
    oidcRef: claims.ref,
    oidcWorkflowRef: claims.workflowRef,
    oidcWorkflowSha: claims.workflowSha.toLowerCase(),
    oidcJobWorkflowRef: claims.jobWorkflowRef,
    oidcJobWorkflowSha: claims.jobWorkflowSha.toLowerCase(),
    oidcRunId: claims.runId,
    oidcRunAttempt: claims.runAttempt,
    oidcCheckRunId: claims.checkRunId,
    oidcTokenIssuedAt: new Date(claims.issuedAt * 1_000),
    oidcTokenNotBefore: new Date(claims.notBefore * 1_000),
    oidcTokenExpiresAt: new Date(claims.expiresAt * 1_000),
    oidcJtiSha256: claims.jtiSha256.toLowerCase(),
  };
  return { ...core, observationIdentitySha256: githubClaudeRepairObservationIdentity(core) };
}

function githubClaudeRepairObservationMatchesValues(
  row: AcceptanceCorrectionDispatchGithubClaudeRepairObservationRow,
  values: ReturnType<typeof githubClaudeRepairObservationValues>
): boolean {
  return isDeepStrictEqual(githubClaudeRepairObservationCore(row), githubClaudeRepairObservationCore(values))
    && row.observationIdentitySha256 === values.observationIdentitySha256;
}

function githubClaudeRepairClaimsMatchAcknowledgement(input: {
  claims: GithubClaudeAckNormalizedOidcClaims;
  acknowledgement: AcceptanceCorrectionDispatchGithubClaudeAckReceiptRow;
}): boolean {
  const { claims, acknowledgement } = input;
  return claims.issuer === acknowledgement.oidcIssuer
    && claims.subjectSha256.toLowerCase() === acknowledgement.oidcSubjectSha256.toLowerCase()
    && claims.repository === acknowledgement.oidcRepository
    && claims.repositoryId === acknowledgement.oidcRepositoryId
    && claims.repositoryOwner === acknowledgement.oidcRepositoryOwner
    && claims.repositoryOwnerId === acknowledgement.oidcRepositoryOwnerId
    && claims.actor === acknowledgement.oidcActor
    && claims.actorId === acknowledgement.oidcActorId
    && claims.eventName === acknowledgement.oidcEventName
    && claims.ref === acknowledgement.oidcRef
    && claims.workflowRef === acknowledgement.oidcWorkflowRef
    && claims.workflowSha.toLowerCase() === acknowledgement.oidcWorkflowSha.toLowerCase()
    && claims.jobWorkflowRef === acknowledgement.oidcJobWorkflowRef
    && claims.jobWorkflowSha.toLowerCase() === acknowledgement.oidcJobWorkflowSha.toLowerCase()
    && claims.runId === acknowledgement.oidcRunId
    && claims.runAttempt === acknowledgement.oidcRunAttempt
    && claims.checkRunId === acknowledgement.oidcCheckRunId;
}

function hasDurableGithubClaudeOidcTokenWindow(input: {
  oidcTokenIssuedAt: Date;
  oidcTokenNotBefore: Date;
  oidcTokenExpiresAt: Date;
}): boolean {
  const issuedAt = input.oidcTokenIssuedAt.getTime();
  const notBefore = input.oidcTokenNotBefore.getTime();
  const expiresAt = input.oidcTokenExpiresAt.getTime();
  return Number.isFinite(issuedAt) && Number.isFinite(notBefore) && Number.isFinite(expiresAt)
    && issuedAt > 0 && notBefore > 0 && expiresAt > 0
    && issuedAt % 1_000 === 0 && notBefore % 1_000 === 0 && expiresAt % 1_000 === 0
    && notBefore <= issuedAt && issuedAt < expiresAt
    && expiresAt - issuedAt <= 600_000;
}

function githubClaudeAcknowledgementMatchesResolvedBinding(input: {
  acknowledgement: AcceptanceCorrectionDispatchGithubClaudeAckReceiptRow;
  binding: GithubClaudeAcknowledgementBinding;
}): boolean {
  const { acknowledgement, binding } = input;
  const { dispatch, activation, capabilityProfile, ackProfile } = binding;
  const [repositoryOwner, repositoryName] = dispatch.repo.split("/");
  const ref = ackProfile.callerWorkflowRef.slice(ackProfile.callerWorkflowRef.lastIndexOf("@") + 1);
  if (!repositoryOwner || !repositoryName || !ref.startsWith("refs/heads/")) return false;
  const acceptedSubjectHashes = new Set([
    `repo:${repositoryOwner}/${repositoryName}:ref:${ref}`,
    `repo:${repositoryOwner}@${ackProfile.githubRepositoryOwnerId}/${repositoryName}@${ackProfile.githubRepositoryId}:ref:${ref}`,
  ].map((subject) => createHash("sha256").update(subject, "utf8").digest("hex")));
  return acknowledgement.id === acceptanceCorrectionDispatchGithubClaudeAckReceiptId({
    dispatchId: dispatch.id,
  })
    && acknowledgement.workspaceId === dispatch.workspaceId
    && acknowledgement.dispatchId === dispatch.id
    && acknowledgement.activationId === activation.id
    && acknowledgement.recordId === dispatch.recordId
    && acknowledgement.repo === dispatch.repo
    && acknowledgement.prNumber === dispatch.prNumber
    && acknowledgement.headSha.toLowerCase() === dispatch.headSha.toLowerCase()
    && acknowledgement.headCycleId === dispatch.headCycleId
    && acknowledgement.authorityGeneration === dispatch.authorityGeneration
    && acknowledgement.dispatchIdentitySha256.toLowerCase()
      === dispatch.dispatchIdentitySha256.toLowerCase()
    && acknowledgement.activationIdentitySha256.toLowerCase()
      === activation.activationIdentitySha256.toLowerCase()
    && acknowledgement.activationGithubCommentId === activation.githubCommentId
    && acknowledgement.activationBodySha256.toLowerCase()
      === activation.bodySha256?.toLowerCase()
    && acknowledgement.routeId === dispatch.routeId
    && acknowledgement.routeConfigurationVersion === dispatch.routeConfigurationVersion
    && acknowledgement.capabilityProfileId === capabilityProfile.id
    && acknowledgement.ackProfileId === ackProfile.id
    && acknowledgement.ackProfileSnapshotSha256.toLowerCase()
      === ackProfile.snapshotSha256.toLowerCase()
    && acknowledgement.acknowledgementProtocolVersion === GITHUB_CLAUDE_ACK_PROTOCOL_VERSION
    && acknowledgement.provider === "anthropic_claude_code_action"
    && acknowledgement.providerConclusion === "success"
    && EXACT_SHA256.test(acknowledgement.providerSessionIdSha256)
    && acknowledgement.oidcIssuer === GITHUB_CLAUDE_ACK_OIDC_ISSUER
    && acknowledgement.oidcAudience === githubClaudeAcknowledgementAudience({
      activationCommentId: acknowledgement.activationGithubCommentId,
      runId: acknowledgement.oidcRunId,
      runAttempt: acknowledgement.oidcRunAttempt,
    })
    && acceptedSubjectHashes.has(acknowledgement.oidcSubjectSha256.toLowerCase())
    && acknowledgement.oidcRepository === dispatch.repo
    && acknowledgement.oidcRepositoryId === ackProfile.githubRepositoryId
    && acknowledgement.oidcRepositoryOwner === repositoryOwner
    && acknowledgement.oidcRepositoryOwnerId === ackProfile.githubRepositoryOwnerId
    && acknowledgement.oidcActor === ackProfile.githubAppBotLogin
    && acknowledgement.oidcActorId === ackProfile.githubAppBotUserId
    && acknowledgement.oidcEventName === "issue_comment"
    && acknowledgement.oidcRef === ref
    && acknowledgement.oidcWorkflowRef === ackProfile.callerWorkflowRef
    && EXACT_GITHUB_HEAD_SHA.test(acknowledgement.oidcWorkflowSha)
    && acknowledgement.oidcJobWorkflowRef === ackProfile.jobWorkflowRef
    && acknowledgement.oidcJobWorkflowSha.toLowerCase() === ackProfile.jobWorkflowSha.toLowerCase()
    && acknowledgement.oidcRunAttempt === 1
    && hasDurableGithubClaudeOidcTokenWindow(acknowledgement);
}

function githubClaudeRepairObservationMatchesResolvedBinding(input: {
  observation: AcceptanceCorrectionDispatchGithubClaudeRepairObservationRow;
  acknowledgement: AcceptanceCorrectionDispatchGithubClaudeAckReceiptRow;
  binding: GithubClaudeAcknowledgementBinding;
}): boolean {
  const { observation, acknowledgement, binding } = input;
  const { dispatch, activation, capabilityProfile, ackProfile } = binding;
  return observation.id === acceptanceCorrectionDispatchGithubClaudeRepairObservationId({
    dispatchId: dispatch.id,
  })
    && observation.workspaceId === dispatch.workspaceId
    && observation.dispatchId === dispatch.id
    && observation.activationId === activation.id
    && observation.acknowledgementReceiptId === acknowledgement.id
    && observation.acknowledgementReceiptIdentitySha256.toLowerCase()
      === acknowledgement.receiptIdentitySha256.toLowerCase()
    && observation.recordId === dispatch.recordId
    && observation.repo === dispatch.repo
    && observation.prNumber === dispatch.prNumber
    && observation.originalHeadSha.toLowerCase() === dispatch.headSha.toLowerCase()
    && observation.originalHeadCycleId === dispatch.headCycleId
    && observation.authorityGeneration === dispatch.authorityGeneration
    && observation.dispatchIdentitySha256.toLowerCase()
      === dispatch.dispatchIdentitySha256.toLowerCase()
    && observation.activationIdentitySha256.toLowerCase()
      === activation.activationIdentitySha256.toLowerCase()
    && observation.activationGithubCommentId === activation.githubCommentId
    && observation.activationBodySha256.toLowerCase() === activation.bodySha256?.toLowerCase()
    && observation.routeId === dispatch.routeId
    && observation.routeConfigurationVersion === dispatch.routeConfigurationVersion
    && observation.capabilityProfileId === capabilityProfile.id
    && observation.acknowledgementProfileId === ackProfile.id
    && observation.acknowledgementProfileSnapshotSha256.toLowerCase()
      === ackProfile.snapshotSha256.toLowerCase()
    && observation.observationProtocolVersion === GITHUB_CLAUDE_REPAIR_OBSERVATION_PROTOCOL_VERSION
    && observation.provider === "anthropic_claude_code_action"
    && observation.providerSessionIdSha256 === acknowledgement.providerSessionIdSha256
    && observation.beforeHeadSha.toLowerCase() === dispatch.headSha.toLowerCase()
    && observation.oidcIssuer === acknowledgement.oidcIssuer
    && observation.oidcAudience === githubClaudeRepairObservationAudience({
      activationCommentId: observation.activationGithubCommentId,
      activationBodySha256: observation.activationBodySha256,
      beforeHeadSha: observation.beforeHeadSha,
      afterHeadSha: observation.afterHeadSha,
      runId: observation.oidcRunId,
      runAttempt: observation.oidcRunAttempt,
    })
    && observation.oidcSubjectSha256.toLowerCase()
      === acknowledgement.oidcSubjectSha256.toLowerCase()
    && observation.oidcRepository === acknowledgement.oidcRepository
    && observation.oidcRepositoryId === acknowledgement.oidcRepositoryId
    && observation.oidcRepositoryOwner === acknowledgement.oidcRepositoryOwner
    && observation.oidcRepositoryOwnerId === acknowledgement.oidcRepositoryOwnerId
    && observation.oidcActor === acknowledgement.oidcActor
    && observation.oidcActorId === acknowledgement.oidcActorId
    && observation.oidcEventName === acknowledgement.oidcEventName
    && observation.oidcRef === acknowledgement.oidcRef
    && observation.oidcWorkflowRef === acknowledgement.oidcWorkflowRef
    && observation.oidcWorkflowSha.toLowerCase() === acknowledgement.oidcWorkflowSha.toLowerCase()
    && observation.oidcJobWorkflowRef === acknowledgement.oidcJobWorkflowRef
    && observation.oidcJobWorkflowSha.toLowerCase()
      === acknowledgement.oidcJobWorkflowSha.toLowerCase()
    && observation.oidcRunId === acknowledgement.oidcRunId
    && observation.oidcRunAttempt === acknowledgement.oidcRunAttempt
    && observation.oidcCheckRunId === acknowledgement.oidcCheckRunId
    && observation.oidcJtiSha256 !== acknowledgement.oidcJtiSha256
    && observation.oidcTokenIssuedAt.getTime() >= acknowledgement.oidcTokenIssuedAt.getTime()
    && observation.observedAt.getTime() >= acknowledgement.acknowledgedAt.getTime()
    && hasDurableGithubClaudeOidcTokenWindow(observation);
}

/**
 * Records the one repair-specific observation made by the already verified
 * acknowledgement run. This does not mutate the dispatch or assert authorship.
 */
export async function recordGithubClaudeRepairHeadObservation(
  input: RecordGithubClaudeRepairObservationInput
): Promise<RecordGithubClaudeRepairObservationResult> {
  if (!isGithubClaudeRepairObservationInput(input)) {
    throw new Error("GitHub Claude repair observation input is invalid");
  }
  const candidate = (await db.select().from(acceptanceCorrectionDispatchGithubActivations).where(and(
    eq(acceptanceCorrectionDispatchGithubActivations.githubCommentId, input.activationCommentId),
    eq(acceptanceCorrectionDispatchGithubActivations.status, "carrier_accepted"),
  )).limit(1))[0];
  if (!candidate) return { kind: "not_admitted" };
  const lockKey = acceptanceRecordPullRequestLockKey({
    workspaceId: candidate.workspaceId,
    recordId: candidate.recordId,
    repo: candidate.repo,
    prNumber: candidate.prNumber,
  });
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${githubClaudeOidcJtiLockKey(
      input.oidc.jtiSha256
    )}))`);
    const activation = (await tx.select().from(acceptanceCorrectionDispatchGithubActivations).where(and(
      eq(acceptanceCorrectionDispatchGithubActivations.id, candidate.id),
      eq(acceptanceCorrectionDispatchGithubActivations.githubCommentId, input.activationCommentId),
      eq(acceptanceCorrectionDispatchGithubActivations.status, "carrier_accepted"),
    )).limit(1))[0];
    if (!activation) return { kind: "not_admitted" };
    const resolved = await resolveGithubClaudeAcknowledgementBindingInTransaction(tx, activation);
    if (!resolved || !claimsMatchGithubClaudeAcknowledgementProfile({
      request: input,
      binding: resolved.binding,
    })) return { kind: "not_admitted" };
    const dispatch = resolved.binding.dispatch;
    const acknowledgement = (await tx.select()
      .from(acceptanceCorrectionDispatchGithubClaudeAckReceipts).where(and(
        eq(acceptanceCorrectionDispatchGithubClaudeAckReceipts.dispatchId, dispatch.id),
        eq(acceptanceCorrectionDispatchGithubClaudeAckReceipts.activationId, activation.id),
      )).limit(1))[0];
    const providerSessionIdSha256 = createHash("sha256")
      .update(input.providerSessionId, "utf8").digest("hex");
    if (!acknowledgement
      || githubClaudeAckReceiptIdentity(acknowledgement) !== acknowledgement.receiptIdentitySha256
      || !await hasVerifiedGithubClaudeAckReceiptEventInTransaction(tx, acknowledgement)
      || !githubClaudeAcknowledgementMatchesResolvedBinding({
        acknowledgement,
        binding: resolved.binding,
      })
      || acknowledgement.providerSessionIdSha256 !== providerSessionIdSha256
      || acknowledgement.activationBodySha256 !== input.activationBodySha256.toLowerCase()
      || acknowledgement.oidcJtiSha256 === input.oidc.jtiSha256.toLowerCase()
      || input.oidc.issuedAt * 1_000 < acknowledgement.oidcTokenIssuedAt.getTime()
      || !githubClaudeRepairClaimsMatchAcknowledgement({ claims: input.oidc, acknowledgement })
      || input.beforeHeadSha.toLowerCase() !== dispatch.headSha.toLowerCase()
      || (resolved.historical && dispatch.successorHeadSha?.toLowerCase()
        !== input.afterHeadSha.toLowerCase())) return { kind: "not_admitted" };

    const acknowledgementJtiCollision = (await tx.select({
      id: acceptanceCorrectionDispatchGithubClaudeAckReceipts.id,
    }).from(acceptanceCorrectionDispatchGithubClaudeAckReceipts).where(
      eq(acceptanceCorrectionDispatchGithubClaudeAckReceipts.oidcJtiSha256,
        input.oidc.jtiSha256.toLowerCase())
    ).limit(1))[0];
    if (acknowledgementJtiCollision) return { kind: "not_admitted" };

    const values = githubClaudeRepairObservationValues({
      binding: resolved.binding,
      acknowledgement,
      request: input,
    });
    const byJti = (await tx.select().from(acceptanceCorrectionDispatchGithubClaudeRepairObservations)
      .where(eq(acceptanceCorrectionDispatchGithubClaudeRepairObservations.oidcJtiSha256,
        input.oidc.jtiSha256.toLowerCase())).limit(1))[0];
    if (byJti && byJti.dispatchId !== dispatch.id) {
      throw new GithubClaudeRepairObservationConflictError();
    }
    const existing = (await tx.select().from(acceptanceCorrectionDispatchGithubClaudeRepairObservations)
      .where(eq(acceptanceCorrectionDispatchGithubClaudeRepairObservations.dispatchId, dispatch.id))
      .limit(1))[0];
    if (existing) {
      if (!githubClaudeRepairObservationMatchesValues(existing, values)
        || !await hasVerifiedGithubClaudeRepairObservationEventInTransaction(tx, existing)) {
        throw new GithubClaudeRepairObservationConflictError();
      }
      return { kind: "replayed", observation: existing };
    }
    const projected = {
      ...values,
      observedAt: new Date(),
      createdAt: new Date(),
    } as AcceptanceCorrectionDispatchGithubClaudeRepairObservationRow;
    const event = await appendChangeRecordEventsAtomicallyInTransaction(tx, [{
      recordId: dispatch.recordId,
      eventKey: `acceptance-correction-dispatch:github-claude-repair-observation:${dispatch.headCycleId}`,
      stage: "builder_handoff",
      actor: "server:github-claude-repair-observation",
      payloadRef: githubClaudeRepairObservationEventPayload(projected),
      at: projected.observedAt,
    }]);
    if (!event.events[0]!.inserted) throw new GithubClaudeRepairObservationConflictError();
    const inserted = await tx.insert(acceptanceCorrectionDispatchGithubClaudeRepairObservations)
      .values(projected).returning();
    if (inserted.length !== 1) throw new Error("GitHub Claude repair observation was not inserted");
    return { kind: "recorded", observation: inserted[0]! };
  });
}

type VerifiedGithubSynchronizeSuccessor = {
  deliveryId: string;
  deliveryEventId: string;
  headAdvanceEventId: string;
  repairHeadSha: string;
  repairHeadCycleId: string;
  reviewJobId: string;
};

async function resolveVerifiedGithubSynchronizeSuccessorInTransaction(
  tx: DbTransaction,
  dispatch: AcceptanceCorrectionDispatchRow
): Promise<VerifiedGithubSynchronizeSuccessor | null> {
  if (dispatch.invalidationReason !== "head_advanced"
    || !dispatch.successorHeadSha || !dispatch.successorHeadCycleId
    || !await hasVerifiedCorrectionDispatchInvalidationInTransaction(tx, dispatch)) return null;
  const authority = (await tx.select().from(changeRecordEvents).where(and(
    eq(changeRecordEvents.recordId, dispatch.recordId),
    eq(changeRecordEvents.eventKey,
      `external-pr:head-advanced:${dispatch.prNumber}:${dispatch.successorHeadCycleId}`),
  )).limit(1))[0];
  if (!authority || authority.stage !== "external_pr" || authority.actor !== "github_webhook"
    || !isRecord(authority.payloadRef) || !hasExactKeys(authority.payloadRef, [
      "kind", "repo", "prNumber", "previousHeadSha", "headSha", "headCycleId",
      "event", "deliveryId", "headTransition", "prUrl", "acceptanceContractVersion",
    ])) return null;
  const transition = authority.payloadRef["headTransition"];
  const deliveryId = authority.payloadRef["deliveryId"];
  const expectedPrUrl = `https://github.com/${dispatch.repo}/pull/${dispatch.prNumber}`;
  if (authority.payloadRef["kind"] !== "external_pr_head_advanced"
    || authority.payloadRef["repo"] !== dispatch.repo
    || authority.payloadRef["prNumber"] !== dispatch.prNumber
    || authority.payloadRef["previousHeadSha"] !== dispatch.headSha
    || authority.payloadRef["headSha"] !== dispatch.successorHeadSha
    || authority.payloadRef["headCycleId"] !== dispatch.successorHeadCycleId
    || authority.payloadRef["event"] !== "synchronize"
    || typeof deliveryId !== "string" || !boundedPullRequestProvenanceText(deliveryId, 256)
    || !isRecord(transition) || !hasExactKeys(transition, ["beforeHeadSha", "afterHeadSha"])
    || transition["beforeHeadSha"] !== dispatch.headSha
    || transition["afterHeadSha"] !== dispatch.successorHeadSha
    || (authority.payloadRef["prUrl"] !== null
      && authority.payloadRef["prUrl"] !== expectedPrUrl)
    || authority.payloadRef["acceptanceContractVersion"]
      !== dispatch.acceptanceContractVersion) return null;
  const delivery = (await tx.select().from(changeRecordEvents).where(and(
    eq(changeRecordEvents.recordId, dispatch.recordId),
    eq(changeRecordEvents.eventKey, `external-pr:delivery:${dispatch.prNumber}:${deliveryId}`),
  )).limit(1))[0];
  if (!delivery || delivery.stage !== "external_pr" || delivery.actor !== "github_webhook"
    || !isRecord(delivery.payloadRef) || !hasExactKeys(delivery.payloadRef, [
      "kind", "repo", "prNumber", "headSha", "event", "deliveryId", "headTransition",
      "admitReviewJob", "prUrl",
    ])
    || delivery.payloadRef["kind"] !== "external_pr_delivery"
    || delivery.payloadRef["repo"] !== dispatch.repo
    || delivery.payloadRef["prNumber"] !== dispatch.prNumber
    || delivery.payloadRef["headSha"] !== dispatch.successorHeadSha
    || delivery.payloadRef["event"] !== "synchronize"
    || delivery.payloadRef["deliveryId"] !== deliveryId
    || !isDeepStrictEqual(delivery.payloadRef["headTransition"], transition)
    || delivery.payloadRef["admitReviewJob"] !== true
    || (delivery.payloadRef["prUrl"] !== null
      && delivery.payloadRef["prUrl"] !== expectedPrUrl)) return null;
  const reviewJob = (await tx.select().from(reviewJobs).where(and(
    eq(reviewJobs.id, dispatch.successorHeadCycleId),
    eq(reviewJobs.workspaceId, dispatch.workspaceId),
    eq(reviewJobs.repo, dispatch.repo),
    eq(reviewJobs.prNumber, dispatch.prNumber),
    eq(reviewJobs.headSha, dispatch.successorHeadSha),
    eq(reviewJobs.event, "synchronize"),
  )).limit(1))[0];
  if (!reviewJob) return null;
  // A SHA does not identify one occurrence: A→B₁→A₂→B₃ can reuse the exact
  // same A and B commits. Without a caller-trusted cycle coordinate, only a
  // unique signed A→B synchronize can be attributed to this observation.
  const matchingOccurrences = await tx.select({ id: changeRecordEvents.id })
    .from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, dispatch.recordId),
      sql`${changeRecordEvents.payloadRef}->>'kind' = 'external_pr_head_advanced'`,
      sql`${changeRecordEvents.payloadRef}->>'repo' = ${dispatch.repo}`,
      sql`${changeRecordEvents.payloadRef}->>'prNumber' = ${String(dispatch.prNumber)}`,
      sql`${changeRecordEvents.payloadRef}->>'event' = 'synchronize'`,
      sql`lower(${changeRecordEvents.payloadRef}->>'previousHeadSha') = ${dispatch.headSha.toLowerCase()}`,
      sql`lower(${changeRecordEvents.payloadRef}->>'headSha') = ${dispatch.successorHeadSha.toLowerCase()}`,
      sql`lower(${changeRecordEvents.payloadRef}->'headTransition'->>'beforeHeadSha') = ${dispatch.headSha.toLowerCase()}`,
      sql`lower(${changeRecordEvents.payloadRef}->'headTransition'->>'afterHeadSha') = ${dispatch.successorHeadSha.toLowerCase()}`,
    )).limit(2);
  if (matchingOccurrences.length !== 1 || matchingOccurrences[0]!.id !== authority.id) return null;
  return {
    deliveryId,
    deliveryEventId: delivery.id,
    headAdvanceEventId: authority.id,
    repairHeadSha: dispatch.successorHeadSha,
    repairHeadCycleId: dispatch.successorHeadCycleId,
    reviewJobId: reviewJob.id,
  };
}

/**
 * Derives exact repair-head evidence from immutable independent receipts. It
 * returns no actor attribution and explicitly preserves the authorship limit.
 */
export async function readGithubClaudeRepairHeadEvidence(input: {
  workspaceId: string;
  dispatchId: string;
}): Promise<GithubClaudeRepairHeadEvidence | null> {
  if (!isRecord(input) || !hasExactKeys(input, ["workspaceId", "dispatchId"])
    || !isUuid(input.workspaceId) || !isUuid(input.dispatchId)) return null;
  return db.transaction(async (tx) => {
    const observation = (await tx.select()
      .from(acceptanceCorrectionDispatchGithubClaudeRepairObservations).where(and(
        eq(acceptanceCorrectionDispatchGithubClaudeRepairObservations.workspaceId, input.workspaceId),
        eq(acceptanceCorrectionDispatchGithubClaudeRepairObservations.dispatchId, input.dispatchId),
      )).limit(1))[0];
    if (!observation
      || githubClaudeRepairObservationIdentity(observation)
        !== observation.observationIdentitySha256) return null;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${acceptanceRecordPullRequestLockKey({
      workspaceId: observation.workspaceId,
      recordId: observation.recordId,
      repo: observation.repo,
      prNumber: observation.prNumber,
    })}))`);
    if (!await hasVerifiedGithubClaudeRepairObservationEventInTransaction(tx, observation)) return null;
    const activation = (await tx.select()
      .from(acceptanceCorrectionDispatchGithubActivations).where(and(
        eq(acceptanceCorrectionDispatchGithubActivations.id, observation.activationId),
        eq(acceptanceCorrectionDispatchGithubActivations.workspaceId, input.workspaceId),
        eq(acceptanceCorrectionDispatchGithubActivations.dispatchId, input.dispatchId),
      )).limit(1))[0];
    const resolved = activation
      && await resolveGithubClaudeAcknowledgementBindingInTransaction(tx, activation);
    if (!resolved || !resolved.historical) return null;
    const dispatch = resolved.binding.dispatch;
    const acknowledgement = (await tx.select()
      .from(acceptanceCorrectionDispatchGithubClaudeAckReceipts).where(and(
        eq(acceptanceCorrectionDispatchGithubClaudeAckReceipts.id,
          observation.acknowledgementReceiptId),
        eq(acceptanceCorrectionDispatchGithubClaudeAckReceipts.workspaceId, input.workspaceId),
        eq(acceptanceCorrectionDispatchGithubClaudeAckReceipts.dispatchId, input.dispatchId),
      )).limit(1))[0];
    if (!acknowledgement
      || githubClaudeAckReceiptIdentity(acknowledgement) !== acknowledgement.receiptIdentitySha256
      || !await hasVerifiedGithubClaudeAckReceiptEventInTransaction(tx, acknowledgement)
      || !githubClaudeAcknowledgementMatchesResolvedBinding({
        acknowledgement,
        binding: resolved.binding,
      })
      || !githubClaudeRepairObservationMatchesResolvedBinding({
        observation,
        acknowledgement,
        binding: resolved.binding,
      })
      || observation.afterHeadSha.toLowerCase()
        !== dispatch.successorHeadSha?.toLowerCase()) return null;
    const successor = await resolveVerifiedGithubSynchronizeSuccessorInTransaction(tx, dispatch);
    if (!successor || successor.repairHeadSha.toLowerCase()
        !== observation.afterHeadSha.toLowerCase()
      || successor.repairHeadCycleId !== dispatch.successorHeadCycleId) return null;
    const evidenceWithoutIdentity = {
      kind: "github_claude_repair_head_evidence" as const,
      version: 1 as const,
      workspaceId: dispatch.workspaceId,
      recordId: dispatch.recordId,
      repo: dispatch.repo,
      prNumber: dispatch.prNumber,
      dispatchId: dispatch.id,
      dispatchIdentitySha256: dispatch.dispatchIdentitySha256,
      activationId: activation.id,
      activationIdentitySha256: activation.activationIdentitySha256,
      acknowledgementReceiptId: acknowledgement.id,
      acknowledgementReceiptIdentitySha256: acknowledgement.receiptIdentitySha256,
      observationId: observation.id,
      observationIdentitySha256: observation.observationIdentitySha256,
      originalHeadSha: dispatch.headSha,
      originalHeadCycleId: dispatch.headCycleId,
      repairHeadSha: successor.repairHeadSha,
      repairHeadCycleId: successor.repairHeadCycleId,
      githubDeliveryId: successor.deliveryId,
      githubDeliveryEventId: successor.deliveryEventId,
      githubHeadAdvanceEventId: successor.headAdvanceEventId,
      reviewJobId: successor.reviewJobId,
      providerSessionIdSha256: observation.providerSessionIdSha256,
      oidcRunId: observation.oidcRunId,
      oidcRunAttempt: 1 as const,
      oidcCheckRunId: observation.oidcCheckRunId,
      attribution: "selected_run_observed_successor" as const,
      authorship: "not_independently_proven" as const,
      reviewRequirement: "exact_head_r7_reentry" as const,
    };
    return {
      ...evidenceWithoutIdentity,
      evidenceIdentitySha256: acceptanceContextPackCanonicalSha256(evidenceWithoutIdentity),
    };
  });
}

function correctionDispatchComparable(row: AcceptanceCorrectionDispatchRow) {
  return {
    id: row.id, workspaceId: row.workspaceId, recordId: row.recordId, repo: row.repo, prNumber: row.prNumber, headSha: row.headSha,
    headCycleId: row.headCycleId, authorityGeneration: row.authorityGeneration,
    sourceSnapshotId: row.sourceSnapshotId, reviewJobId: row.reviewJobId,
    acceptanceContractId: row.acceptanceContractId,
    acceptanceContractVersion: row.acceptanceContractVersion,
    acceptanceContractSha256: row.acceptanceContractSha256,
    packetIds: row.packetIds, packetSetSha256: row.packetSetSha256,
    correctionPacketPayloadSetSha256: row.correctionPacketPayloadSetSha256,
    compiledPackId: row.compiledPackId, compiledPackSha256: row.compiledPackSha256,
    compilerVersion: row.compilerVersion, policyVersion: row.policyVersion,
    jsonSha256: row.jsonSha256, markdownSha256: row.markdownSha256,
    sourceCustodyIdentitySha256: row.sourceCustodyIdentitySha256,
    routeId: row.routeId, routeAdapter: row.routeAdapter,
    routeConfigurationVersion: row.routeConfigurationVersion, routeSnapshot: row.routeSnapshot,
    routeSnapshotSha256: row.routeSnapshotSha256,
    capabilityProfileId: row.capabilityProfileId,
    capabilityProfileSnapshot: row.capabilityProfileSnapshot,
    capabilityProfileSnapshotSha256: row.capabilityProfileSnapshotSha256,
    dispatchProtocolVersion: row.dispatchProtocolVersion, dispatchIdentitySha256: row.dispatchIdentitySha256,
    deliveryState: row.deliveryState, agentState: row.agentState,
    findingsState: row.findingsState, activationState: row.activationState, carrier: row.carrier,
  };
}

function correctionDispatchIdentity(values: Record<string, unknown>): string {
  const { id: _id, dispatchIdentitySha256: _identity, ...identity } = values;
  return acceptanceContextPackCanonicalSha256({
    kind: "acceptance_correction_dispatch", version: 1, ...identity,
  });
}

function correctionDispatchQueuedEventPayload(
  values: ReturnType<typeof correctionDispatchComparable>
): Record<string, unknown> {
  return {
    kind: "acceptance_correction_dispatch_queued", version: 1,
    dispatchId: values.id, repository: values.repo, prNumber: values.prNumber,
    dispatchProtocolVersion: values.dispatchProtocolVersion, dispatchIdentitySha256: values.dispatchIdentitySha256,
    headSha: values.headSha, headCycleId: values.headCycleId,
    authorityGeneration: values.authorityGeneration, sourceSnapshotId: values.sourceSnapshotId,
    acceptanceContract: { id: values.acceptanceContractId, version: values.acceptanceContractVersion, sha256: values.acceptanceContractSha256 },
    packets: { ids: values.packetIds, setSha256: values.packetSetSha256, payloadSetSha256: values.correctionPacketPayloadSetSha256 },
    compiledPack: { id: values.compiledPackId, sha256: values.compiledPackSha256, compilerVersion: values.compilerVersion, policyVersion: values.policyVersion, jsonSha256: values.jsonSha256, markdownSha256: values.markdownSha256, sourceCustodyIdentitySha256: values.sourceCustodyIdentitySha256 },
    route: { id: values.routeId, adapter: values.routeAdapter, configurationVersion: values.routeConfigurationVersion, snapshot: values.routeSnapshot, snapshotSha256: values.routeSnapshotSha256 },
    capabilityProfile: values.capabilityProfileId === null ? null : {
      id: values.capabilityProfileId,
      snapshot: values.capabilityProfileSnapshot,
      snapshotSha256: values.capabilityProfileSnapshotSha256,
    },
    deliveryState: values.deliveryState, agentState: values.agentState, findingsState: values.findingsState,
    activationState: values.activationState, carrier: values.carrier,
  };
}

async function resolveSelectedAcceptanceBuilderRouteInTransaction(
  tx: DbTransaction,
  input: { workspaceId: string; record: ChangeRecordRow; contract: AcceptanceContractRow }
): Promise<AcceptanceBuilderRouteSelectionResolution> {
  const events = await tx.select().from(changeRecordEvents).where(and(
    eq(changeRecordEvents.recordId, input.record.id),
    eq(changeRecordEvents.eventKey, ACCEPTANCE_BUILDER_ROUTE_EVENT_KEY),
  )).limit(1);
  const event = events[0];
  if (!event || event.stage !== "builder_handoff" || !isBuilderRouteActor(event.actor, true)) {
    throw new Error("Acceptance Builder route selection is missing or invalid");
  }
  const parsed = parseAcceptanceBuilderRoutePayload(event.payloadRef);
  if (!parsed || parsed.workspaceId !== input.workspaceId || parsed.repository !== input.record.repo
    || parsed.recordId !== input.record.id || parsed.contractId !== input.contract.id
    || parsed.contractVersion !== input.contract.version) {
    throw new Error("Acceptance Builder route selection is not bound to the current Record and Contract");
  }
  const rows = Array.from(await tx.execute(sql`
    SELECT * FROM acceptance_builder_routes
    WHERE id = ${parsed.routeId} AND workspace_id = ${input.workspaceId}
      AND repo = ${input.record.repo} AND status = 'active'
    FOR SHARE
  `)) as Array<Record<string, unknown>>;
  if (rows.length !== 1) throw new Error("Acceptance Builder route is unavailable for this Record");
  const route = mapAcceptanceBuilderRouteRow(rows[0]!);
  if (!isBuilderRouteAdapter(route.adapter) || route.adapter !== parsed.routeAdapter
    || route.configurationVersion !== parsed.routeConfigurationVersion
    || !isDeepStrictEqual(builderRouteSnapshot(route), parsed.snapshot)) {
    throw new Error("Acceptance Builder route configuration no longer matches its selection");
  }
  return { selection: parsed.selection, route, snapshot: parsed.snapshot, event };
}

/**
 * Server-only dispatch preparation. Its public shape admits only a workspace
 * and already-persisted Pack UUID; every other delivery coordinate is derived
 * and revalidated under the same per-PR lock used by head authority changes.
 */
export async function queueSelectedCorrectionDispatch(
  input: QueueSelectedCorrectionDispatchInput
): Promise<{ dispatch: AcceptanceCorrectionDispatchRow; inserted: boolean }> {
  if (!isRecord(input) || !hasExactKeys(input, ["workspaceId", "compiledPackId"])
    || !isUuid(input.workspaceId) || !isUuid(input.compiledPackId)) {
    throw new Error("Selected correction dispatch requires a workspace and compiled Pack");
  }
  const candidate = (await db.select({
    pack: acceptanceCompiledContextPacks,
    snapshot: acceptanceContextPackSnapshots,
    record: changeRecords,
  }).from(acceptanceCompiledContextPacks)
    .innerJoin(acceptanceContextPackSnapshots, eq(acceptanceCompiledContextPacks.sourceSnapshotId, acceptanceContextPackSnapshots.id))
    .innerJoin(changeRecords, eq(acceptanceContextPackSnapshots.recordId, changeRecords.id))
    .where(and(
      eq(acceptanceCompiledContextPacks.id, input.compiledPackId),
      eq(acceptanceCompiledContextPacks.workspaceId, input.workspaceId),
      eq(acceptanceContextPackSnapshots.workspaceId, input.workspaceId),
      eq(changeRecords.workspaceId, input.workspaceId),
    )).limit(1))[0];
  if (!candidate) throw new Error("Compiled Context Pack is missing or outside this workspace");
  const lockKey = acceptanceRecordPullRequestLockKey({
    workspaceId: input.workspaceId, recordId: candidate.record.id,
    repo: candidate.record.repo, prNumber: candidate.record.prNumber ?? 0,
  });
  if (candidate.record.prNumber == null) throw new Error("Compiled Context Pack Record is not attached to a pull request");

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const pack = (await tx.select().from(acceptanceCompiledContextPacks).where(and(
      eq(acceptanceCompiledContextPacks.id, input.compiledPackId),
      eq(acceptanceCompiledContextPacks.workspaceId, input.workspaceId),
    )).limit(1))[0];
    if (!pack) throw new Error("Compiled Context Pack is missing or outside this workspace");
    const custody = await resolveAcceptanceContextPackCustodyInTransaction(tx, {
      workspaceId: input.workspaceId, sourceSnapshotId: pack.sourceSnapshotId,
    });
    const source = custody.sourceSnapshot;
    if (source.packetIds.length < 1 || source.packetIds.length > 100
      || !source.packetIds.every((packetId, index) => index === 0 || source.packetIds[index - 1]! < packetId)) {
      throw new Error("Selected correction dispatch admitted packet set is not canonical");
    }
    const record = (await tx.select().from(changeRecords).where(and(
      eq(changeRecords.id, source.recordId), eq(changeRecords.workspaceId, input.workspaceId),
      eq(changeRecords.repo, source.repo), eq(changeRecords.prNumber, source.prNumber),
    )).limit(1))[0];
    if (!record || !record.currentPrHeadAuthoritative || record.currentPrHeadSha !== source.expectedHeadSha
      || record.currentPrHeadCycleId !== source.reviewJobId) {
      throw new Error("Selected correction dispatch Record head is no longer current");
    }
    const confirmed = (await tx.select().from(acceptanceContracts).where(and(
      eq(acceptanceContracts.id, source.acceptanceContractId),
      eq(acceptanceContracts.recordId, source.recordId),
      eq(acceptanceContracts.status, "confirmed"),
    )).limit(1))[0];
    if (!confirmed || confirmed.version !== source.acceptanceContractVersion
      || custody.acceptanceContractSha256 !== acceptanceContractSha256({
        acceptanceContractId: confirmed.id,
        acceptanceContractVersion: confirmed.version,
        contract: confirmed.contract,
      })) {
      throw new Error("Selected correction dispatch Contract is no longer the admitted confirmed Contract");
    }
    const reconstructedPack = parseCompiledAcceptanceContextPack({
      kind: "compiled_acceptance_context_pack", version: 1, binding: pack.binding,
      compiler: {
        version: pack.compilerVersion, policyVersion: pack.policyVersion,
        byteCounter: "utf8_byte_upper_bound_v1", byteBudget: COMPILED_PACK_BYTE_BUDGET,
      }, manifest: pack.manifest, sourceCustodyReceipt: pack.sourceCustodyReceipt,
      exactHeadDependencyTreeProofs: pack.exactHeadDependencyTreeProofs,
      representations: { jsonSha256: pack.jsonSha256, markdownSha256: pack.markdownSha256 },
      renderedByteCount: pack.renderedByteCount, packSha256: pack.packSha256,
    });
    if (!reconstructedPack || compiledPackIdentity(reconstructedPack) !== pack.packSha256
      || !bindingMatchesCustody(pack.binding, custody) || !receiptMatchesCustody(pack.sourceCustodyReceipt, custody)) {
      throw new Error("Selected correction dispatch compiled Pack no longer matches the admitted custody");
    }
    const route = await resolveSelectedAcceptanceBuilderRouteInTransaction(tx, {
      workspaceId: input.workspaceId, record, contract: confirmed,
    });
    let capabilityProfile: AcceptanceBuilderRouteCapabilityProfileRow | null = null;
    if (isGithubNativeBuilderRouteAdapter(route.route.adapter)) {
      capabilityProfile = await resolveAcceptanceBuilderRouteCapabilityProfileInTransaction(tx, {
        workspaceId: input.workspaceId,
        route: route.route,
      });
      if (!capabilityProfile) {
        throw new Error("Selected correction dispatch requires an exact current GitHub capability profile");
      }
    }
    const carrier = route.snapshot.protocol;
    const routeSnapshotSha256 = acceptanceContextPackCanonicalSha256(route.snapshot);
    const unsignedValues = {
      id: acceptanceCorrectionDispatchId({ recordId: record.id, headCycleId: source.reviewJobId }),
      workspaceId: input.workspaceId, recordId: record.id, repo: source.repo, prNumber: source.prNumber, headSha: source.expectedHeadSha,
      headCycleId: source.reviewJobId, authorityGeneration: record.currentPrHeadAuthorityGeneration,
      sourceSnapshotId: source.id, reviewJobId: source.reviewJobId,
      acceptanceContractId: source.acceptanceContractId,
      acceptanceContractVersion: source.acceptanceContractVersion,
      acceptanceContractSha256: custody.acceptanceContractSha256,
      packetIds: source.packetIds, packetSetSha256: source.packetSetSha256,
      correctionPacketPayloadSetSha256: custody.correctionPacketPayloadSetSha256,
      compiledPackId: pack.id, compiledPackSha256: pack.packSha256,
      compilerVersion: pack.compilerVersion, policyVersion: pack.policyVersion,
      jsonSha256: pack.jsonSha256, markdownSha256: pack.markdownSha256,
      sourceCustodyIdentitySha256: pack.sourceCustodyIdentitySha256,
      routeId: route.route.id, routeAdapter: route.route.adapter,
      routeConfigurationVersion: route.route.configurationVersion, routeSnapshot: route.snapshot,
      routeSnapshotSha256, dispatchProtocolVersion: 1,
      capabilityProfileId: capabilityProfile?.id ?? null,
      capabilityProfileSnapshot: capabilityProfile?.snapshot ?? null,
      capabilityProfileSnapshotSha256: capabilityProfile?.snapshotSha256 ?? null,
      deliveryState: "queued" as const, agentState: "not_observed" as const,
      findingsState: "not_started" as const, activationState: "not_started" as const,
      carrier,
    };
    const values = { ...unsignedValues, dispatchIdentitySha256: correctionDispatchIdentity(unsignedValues) };
    const existing = (await tx.select().from(acceptanceCorrectionDispatches).where(and(
      eq(acceptanceCorrectionDispatches.recordId, record.id),
      eq(acceptanceCorrectionDispatches.headCycleId, source.reviewJobId),
    )).limit(1))[0];
    const eventKey = `acceptance-correction-dispatch:queued:${source.reviewJobId}`;
    const eventPayload = correctionDispatchQueuedEventPayload(values);
    if (existing) {
      if (isGithubNativeBuilderRouteAdapter(route.route.adapter)
        && (existing.capabilityProfileId == null
        || existing.capabilityProfileSnapshot == null
        || existing.capabilityProfileSnapshotSha256 == null)) {
        throw new Error("Existing unprofiled selected correction dispatch is held pending a new head cycle");
      }
      if (!isDeepStrictEqual(correctionDispatchComparable(existing), values)) {
        throw new Error("Selected correction dispatch replay is already bound to different Pack or route provenance");
      }
      const queued = (await tx.select().from(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, record.id), eq(changeRecordEvents.eventKey, eventKey),
      )).limit(1))[0];
      if (!queued || queued.stage !== "builder_handoff" || queued.actor !== "server:dispatch-preparation"
        || !isDeepStrictEqual(queued.payloadRef, eventPayload)) {
        throw new Error("Selected correction dispatch queued event is missing or does not match its aggregate");
      }
      return { dispatch: existing, inserted: false };
    }
    const event = await appendChangeRecordEventsAtomicallyInTransaction(tx, [{
      recordId: record.id, eventKey, stage: "builder_handoff", actor: "server:dispatch-preparation", payloadRef: eventPayload,
    }]);
    if (!event.events[0]!.inserted) throw new Error("Selected correction dispatch queued event unexpectedly replayed");
    const rows = await tx.insert(acceptanceCorrectionDispatches).values(values).returning();
    return { dispatch: rows[0]!, inserted: true };
  });
}

/**
 * Called only inside the shared PR advisory-lock transaction. It tombstones a
 * cycle once. A later reconciliation appends a successor event and projects
 * only a previously unknown successor through a null-CAS.
 */
async function invalidateAcceptanceCorrectionDispatchForHeadInTransaction(
  tx: DbTransaction,
  input: {
    workspaceId: string; recordId: string; headSha: string | null; headCycleId: string | null;
    reason: AcceptanceCorrectionDispatchInvalidationReason;
    successorHeadSha?: string | null; successorHeadCycleId?: string | null;
  }
): Promise<number> {
  if (!input.headSha || !input.headCycleId) return 0;
  if ((input.successorHeadSha == null) !== (input.successorHeadCycleId == null)) {
    throw new Error("Correction dispatch successor must include both head and cycle");
  }
  const active = (await tx.select().from(acceptanceCorrectionDispatches).where(and(
    eq(acceptanceCorrectionDispatches.workspaceId, input.workspaceId),
    eq(acceptanceCorrectionDispatches.recordId, input.recordId),
    eq(acceptanceCorrectionDispatches.headSha, input.headSha),
    eq(acceptanceCorrectionDispatches.headCycleId, input.headCycleId),
    isNull(acceptanceCorrectionDispatches.invalidatedAt),
  )).limit(1))[0];
  if (!active) {
    if (input.successorHeadSha != null && input.successorHeadCycleId != null) {
      const tombstone = (await tx.select().from(acceptanceCorrectionDispatches).where(and(
        eq(acceptanceCorrectionDispatches.workspaceId, input.workspaceId),
        eq(acceptanceCorrectionDispatches.recordId, input.recordId),
        eq(acceptanceCorrectionDispatches.headSha, input.headSha),
        eq(acceptanceCorrectionDispatches.headCycleId, input.headCycleId),
      )).limit(1))[0];
      if (tombstone?.invalidatedAt != null) {
        await appendChangeRecordEventsAtomicallyInTransaction(tx, [{
          recordId: input.recordId,
          eventKey: `acceptance-correction-dispatch:successor:${input.headCycleId}:${input.successorHeadCycleId}`,
          stage: "builder_handoff", actor: "server:dispatch-preparation",
          payloadRef: {
            kind: "acceptance_correction_dispatch_successor_recorded", version: 1,
            dispatchId: tombstone.id, dispatchIdentitySha256: tombstone.dispatchIdentitySha256,
            invalidationReason: tombstone.invalidationReason,
            successorHeadSha: input.successorHeadSha, successorHeadCycleId: input.successorHeadCycleId,
          },
        }]);
        // The immutable successor event is the authority for this late
        // knowledge.  Project it once with a null-CAS; no dispatch identity,
        // invalidation reason, or delivery state is ever changed.
        await tx.update(acceptanceCorrectionDispatches).set({
          successorHeadSha: input.successorHeadSha,
          successorHeadCycleId: input.successorHeadCycleId,
          updatedAt: new Date(),
        }).where(and(
          eq(acceptanceCorrectionDispatches.id, tombstone.id),
          isNull(acceptanceCorrectionDispatches.successorHeadSha),
          isNull(acceptanceCorrectionDispatches.successorHeadCycleId),
        ));
      }
    }
    return 0;
  }
  const eventKey = `acceptance-correction-dispatch:invalidated:${input.headCycleId}`;
  const payloadRef = {
    kind: "acceptance_correction_dispatch_invalidated", version: 1,
    dispatchId: active.id, dispatchIdentitySha256: active.dispatchIdentitySha256,
    reason: input.reason, headSha: input.headSha, headCycleId: input.headCycleId,
    successorHeadSha: input.successorHeadSha ?? null,
    successorHeadCycleId: input.successorHeadCycleId ?? null,
  };
  const event = await appendChangeRecordEventsAtomicallyInTransaction(tx, [{
    recordId: input.recordId, eventKey, stage: "builder_handoff",
    actor: "server:dispatch-preparation", payloadRef,
  }]);
  if (!event.events[0]!.inserted) {
    throw new Error("Correction dispatch invalidation event unexpectedly replayed before its row update");
  }
  const rows = await tx.update(acceptanceCorrectionDispatches).set({
    invalidatedAt: new Date(), invalidationReason: input.reason,
    successorHeadSha: input.successorHeadSha ?? null,
    successorHeadCycleId: input.successorHeadCycleId ?? null, updatedAt: new Date(),
  }).where(and(
    eq(acceptanceCorrectionDispatches.id, active.id),
    isNull(acceptanceCorrectionDispatches.invalidatedAt),
  )).returning({ id: acceptanceCorrectionDispatches.id });
  if (rows.length !== 1) throw new Error("Correction dispatch invalidation lost its locked precondition");
  return 1;
}

const ACCEPTANCE_RECORD_SUMMARY_DEFAULT_LIMIT = 100;
const ACCEPTANCE_RECORD_SUMMARY_MAX_LIMIT = 200;
const ACCEPTANCE_RECORD_SUMMARY_EVENT_LIMIT = 256;
const ACCEPTANCE_RECORD_SUMMARY_CONTEXT_IDENTITY_LIMIT = 2;

type AcceptanceRecordSummaryConfirmedContract = {
  row: AcceptanceContractRow;
  projection: AcceptanceConfirmedContractProjection;
  identity: AcceptanceRecordSummaryContractIdentity;
};

type AcceptanceRecordSummaryFocus = {
  kind: "current" | "merged";
  headSha: string;
  headCycleId: string;
  authorityGeneration: number;
};

type AcceptanceRecordSummaryStoredMerge = {
  event: ChangeRecordEventRow;
  payload: SignedAcceptanceRecordMergePayload;
};

function parseReadAcceptanceRecordSummariesInput(
  input: unknown,
): { workspaceId: string; repo: string | null; limit: number } {
  if (!isRecord(input)
    || !Object.keys(input).every((key) => key === "workspaceId" || key === "repo" || key === "limit")
    || !hasOwn(input, "workspaceId") || !isUuid(input["workspaceId"])
    || (hasOwn(input, "repo") && input["repo"] !== null
      && (typeof input["repo"] !== "string" || !safeRepo(input["repo"])))
    || (hasOwn(input, "limit")
      && (!Number.isSafeInteger(input["limit"])
        || (input["limit"] as number) < 1
        || (input["limit"] as number) > ACCEPTANCE_RECORD_SUMMARY_MAX_LIMIT))) {
    throw new Error("Acceptance Record summaries require only workspace, optional repository, and bounded limit");
  }
  return {
    workspaceId: input["workspaceId"],
    repo: (input["repo"] as string | null | undefined) ?? null,
    limit: (input["limit"] as number | undefined) ?? ACCEPTANCE_RECORD_SUMMARY_DEFAULT_LIMIT,
  };
}

function acceptanceRecordSummaryConfirmedContract(
  rows: readonly AcceptanceContractRow[],
): AcceptanceRecordSummaryConfirmedContract | null | "invalid" {
  if (rows.length === 0) return null;
  if (rows.length !== 1) return "invalid";
  const row = rows[0]!;
  const projection = projectConfirmedAcceptanceContract(row.contract);
  if (row.status !== "confirmed" || !isNonBlankString(row.confirmedBy)
    || !(row.confirmedAt instanceof Date) || Number.isNaN(row.confirmedAt.valueOf())
    || !projection) return "invalid";
  try {
    return {
      row,
      projection,
      identity: {
        id: row.id,
        version: row.version,
        sha256: acceptanceContractSha256({
          acceptanceContractId: row.id,
          acceptanceContractVersion: row.version,
          contract: row.contract,
        }),
      },
    };
  } catch {
    return "invalid";
  }
}

function acceptanceRecordSummaryRelevantMergeEvents(
  events: readonly ChangeRecordEventRow[],
): ChangeRecordEventRow[] {
  return events.filter((event) => event.eventKey.startsWith("acceptance-pr:signed-merge:")
    || event.payloadRef["kind"] === SIGNED_ACCEPTANCE_RECORD_MERGE_KIND);
}

function acceptanceRecordSummaryRelevantPostMergeEvents(
  events: readonly ChangeRecordEventRow[],
): ChangeRecordEventRow[] {
  return events.filter((event) => event.eventKey.startsWith("acceptance-post-merge:")
    || event.stage === "post_merge_outcome"
    || event.payloadRef["kind"] === "acceptance_post_merge_outcome");
}

function acceptanceRecordSummaryMergeBeforeLineage(
  record: ChangeRecordRow,
  events: readonly ChangeRecordEventRow[],
): AcceptanceRecordSummaryStoredMerge | null | "invalid" {
  const candidates = acceptanceRecordSummaryRelevantMergeEvents(events);
  const deliveries = events.filter((event) => event.eventKey.startsWith("external-pr:signed-merge:")
    || event.payloadRef["kind"] === SIGNED_ACCEPTANCE_RECORD_MERGE_DELIVERY_KIND);
  const mergeScoped = events.filter((event) => event.stage === SIGNED_ACCEPTANCE_RECORD_MERGE_STAGE
    || event.eventKey.startsWith("acceptance-pr:signed-merge:")
    || event.eventKey.startsWith("external-pr:signed-merge:")
    || event.payloadRef["kind"] === SIGNED_ACCEPTANCE_RECORD_MERGE_KIND
    || event.payloadRef["kind"] === SIGNED_ACCEPTANCE_RECORD_MERGE_DELIVERY_KIND);
  if (record.mergedSha == null) {
    return candidates.length === 0 && deliveries.length === 0 && mergeScoped.length === 0
      ? null : "invalid";
  }
  if (!EXACT_LOWER_GITHUB_SHA.test(record.mergedSha)
    || record.currentPrHeadAuthoritative
    || (record.state !== "merged" && record.state !== "reverted")
    || candidates.length !== 1 || deliveries.length !== 1
    || new Set([...candidates, ...deliveries]).size !== mergeScoped.length) return "invalid";
  const event = candidates[0]!;
  const payload = parseSignedAcceptanceRecordMergePayload(event, record);
  if (!payload || payload.mergeSha !== record.mergedSha
    || record.currentPrHeadAuthorityGeneration < payload.authorityGenerationAfter) return "invalid";
  const deliveryEventKey = signedAcceptanceRecordMergeDeliveryEventKey({
    prNumber: payload.prNumber,
    deliveryId: payload.deliveryId,
  });
  const delivery = events.find((candidate) => candidate.id === payload.deliveryEventId
    && candidate.eventKey === deliveryEventKey);
  const deliveryPayload = signedAcceptanceRecordMergeDeliveryPayload({
    workspaceId: payload.workspaceId,
    recordId: payload.recordId,
    repo: payload.repo,
    prNumber: payload.prNumber,
    deliveryId: payload.deliveryId,
    headSha: payload.headSha,
    baseSha: payload.baseSha,
    mergeSha: payload.mergeSha,
    mergedAt: payload.mergedAt,
    prUrl: payload.prUrl,
    githubActor: payload.githubActor,
    source: payload.source,
  });
  if (!delivery
    || delivery.id !== changeRecordEventId({ recordId: record.id, eventKey: deliveryEventKey })
    || delivery.stage !== SIGNED_ACCEPTANCE_RECORD_MERGE_STAGE
    || delivery.actor !== SIGNED_ACCEPTANCE_RECORD_MERGE_ACTOR
    || !isDeepStrictEqual(delivery.payloadRef, deliveryPayload)) return "invalid";
  return { event, payload };
}

function acceptanceRecordSummaryFocusFromRecord(
  record: ChangeRecordRow,
  merge: AcceptanceRecordSummaryStoredMerge | null | "invalid",
): AcceptanceRecordSummaryFocus | null | "invalid" {
  if (record.prNumber == null) {
    return record.currentPrHeadSha == null && record.currentPrHeadCycleId == null
      && !record.currentPrHeadAuthoritative ? null : "invalid";
  }
  if (!safeRepo(record.repo) || !Number.isSafeInteger(record.prNumber) || record.prNumber <= 0
    || !Number.isSafeInteger(record.currentPrHeadAuthorityGeneration)
    || record.currentPrHeadAuthorityGeneration < 0
    || ((record.currentPrHeadSha == null) !== (record.currentPrHeadCycleId == null))
    || (record.currentPrHeadSha != null && !EXACT_SHA1.test(record.currentPrHeadSha))
    || (record.currentPrHeadCycleId != null && !isUuid(record.currentPrHeadCycleId))) return "invalid";
  if (record.currentPrHeadAuthoritative) {
    return record.state === "open" && record.mergedSha == null
      && record.currentPrHeadSha != null && record.currentPrHeadCycleId != null
      && record.headShas.includes(record.currentPrHeadSha)
      ? {
          kind: "current",
          headSha: record.currentPrHeadSha.toLowerCase(),
          headCycleId: record.currentPrHeadCycleId,
          authorityGeneration: record.currentPrHeadAuthorityGeneration,
        }
      : "invalid";
  }
  if (merge === "invalid") return "invalid";
  if (merge) {
    const alignment = merge.payload.decisionAlignment;
    if (alignment.kind === "aligned" || alignment.kind === "decision_conflicts_merge"
      || alignment.kind === "not_recorded") {
      return {
        kind: "merged",
        headSha: alignment.binding.headSha,
        headCycleId: alignment.binding.headCycleId,
        authorityGeneration: alignment.binding.authorityGeneration,
      };
    }
  }
  return null;
}

function acceptanceRecordSummarySnapshotInput(
  snapshot: AcceptanceContextPackSnapshotRow,
): AcceptanceContextPackSnapshotInput {
  return {
    workspaceId: snapshot.workspaceId,
    recordId: snapshot.recordId,
    reviewJobId: snapshot.reviewJobId,
    acceptanceContractId: snapshot.acceptanceContractId,
    acceptanceContractVersion: snapshot.acceptanceContractVersion,
    acceptanceContractSha256: snapshot.acceptanceContractSha256!,
    repo: snapshot.repo,
    prNumber: snapshot.prNumber,
    expectedHeadSha: snapshot.expectedHeadSha,
    baseSha: snapshot.baseSha,
    mergeBaseSha: snapshot.mergeBaseSha,
    headTreeSha: snapshot.headTreeSha,
    packetIds: snapshot.packetIds,
    packetSetSha256: snapshot.packetSetSha256,
    correctionPacketPayloadSetSha256: snapshot.correctionPacketPayloadSetSha256!,
    compilerVersion: snapshot.compilerVersion,
    baseIndex: snapshot.baseIndex as AcceptanceContextPackCustodyBaseIndexIdentity | null,
    overlay: snapshot.overlay as AcceptanceContextPackCustodyOverlayManifestIdentity | null,
    provenance: snapshot.provenance as AcceptanceContextInclusionExclusionProvenance,
    status: snapshot.status as AcceptanceContextPackSnapshotStatus,
    reason: snapshot.reason,
  };
}

function acceptanceRecordSummarySourceSnapshotIdentity(
  snapshot: AcceptanceContextPackSnapshotRow,
): AcceptanceRecordSummarySourceSnapshotIdentity {
  return {
    id: snapshot.id,
    headSha: snapshot.expectedHeadSha,
    headCycleId: snapshot.reviewJobId,
    compilerVersion: snapshot.compilerVersion,
    packetSetSha256: snapshot.packetSetSha256,
  };
}

function acceptanceRecordSummaryUnknownReasons(
  reasons: Iterable<AcceptanceRecordSummaryUnknownReason>,
): AcceptanceRecordSummaryUnknownReason[] {
  return [...new Set(reasons)].sort((left, right) => left.localeCompare(right));
}

function acceptanceRecordSummaryCycleBinding(input: {
  record: ChangeRecordRow;
  focus: AcceptanceRecordSummaryFocus;
  contract: AcceptanceRecordSummaryConfirmedContract;
  events: readonly ChangeRecordEventRow[];
  jobsById: ReadonlyMap<string, ReviewJobRow>;
  expectedBinding?: CurrentAcceptancePrDecisionBinding;
}): CurrentAcceptancePrDecisionBinding | null | "invalid" {
  const attestationEventKey = reviewJobPostedAttestationEventKey(input.focus.headCycleId);
  const candidates = input.events.filter((event) => event.eventKey === attestationEventKey
    || (event.payloadRef["kind"] === REVIEW_JOB_POSTED_ATTESTATION_KIND
      && event.payloadRef["jobId"] === input.focus.headCycleId));
  if (candidates.length === 0) return null;
  if (candidates.length !== 1) return "invalid";
  const event = candidates[0]!;
  const job = input.jobsById.get(input.focus.headCycleId);
  const parsed = parseAcceptancePrReviewMetricsCycle({
    event,
    job,
    record: input.record,
    acceptanceContract: input.contract.identity,
  });
  if (!parsed || parsed.binding.headSha !== input.focus.headSha
    || parsed.binding.headCycleId !== input.focus.headCycleId
    || parsed.binding.reviewJobId !== input.focus.headCycleId
    || !job || job.createdAt > event.at
    || input.contract.row.confirmedAt == null
    || input.contract.row.confirmedAt > event.at) return "invalid";
  const base: Omit<CurrentAcceptancePrDecisionBinding, "bindingId"> = {
    ...parsed.binding,
    authorityGeneration: input.focus.authorityGeneration,
  };
  const binding: CurrentAcceptancePrDecisionBinding = {
    bindingId: acceptancePrDecisionBindingId(base),
    ...base,
  };
  if (input.expectedBinding
    && (!historicalMetricsBindingMatchesCurrentBinding(parsed.binding, input.expectedBinding)
      || input.expectedBinding.authorityGeneration !== input.focus.authorityGeneration
      || input.expectedBinding.bindingId !== binding.bindingId)) return "invalid";
  return input.expectedBinding ?? binding;
}

function acceptanceRecordSummaryDecisionForBinding(
  events: readonly ChangeRecordEventRow[],
  binding: CurrentAcceptancePrDecisionBinding,
): CurrentAcceptancePrDecision | null | "invalid" {
  const eventKey = acceptancePrDecisionEventKey(binding.headCycleId);
  const candidates = events.filter((event) => event.eventKey === eventKey
    || ((event.stage === ACCEPTANCE_PR_DECISION_STAGE
      || event.payloadRef["kind"] === ACCEPTANCE_PR_DECISION_KIND)
      && (event.payloadRef["headCycleId"] === binding.headCycleId
        || event.payloadRef["reviewJobId"] === binding.reviewJobId)));
  if (candidates.length === 0) return null;
  if (candidates.length !== 1) return "invalid";
  return parseCurrentAcceptancePrDecisionEvent({ event: candidates[0]!, binding }) ?? "invalid";
}

function acceptanceRecordSummaryMergeLineageValid(input: {
  merge: AcceptanceRecordSummaryStoredMerge;
  record: ChangeRecordRow;
  contract: AcceptanceRecordSummaryConfirmedContract | null | "invalid";
  events: readonly ChangeRecordEventRow[];
  jobsById: ReadonlyMap<string, ReviewJobRow>;
}): boolean {
  const alignment = input.merge.payload.decisionAlignment;
  if (alignment.kind === "custody_unavailable") return true;
  if (alignment.kind === "not_current" && alignment.currentBinding == null) return true;
  if (!input.contract || input.contract === "invalid") return false;
  const binding = alignment.kind === "not_current"
    ? alignment.currentBinding!
    : alignment.binding;
  const focus: AcceptanceRecordSummaryFocus = {
    kind: "merged",
    headSha: binding.headSha,
    headCycleId: binding.headCycleId,
    authorityGeneration: binding.authorityGeneration,
  };
  const exactBinding = acceptanceRecordSummaryCycleBinding({
    record: input.record,
    focus,
    contract: input.contract,
    events: input.events,
    jobsById: input.jobsById,
    expectedBinding: binding,
  });
  if (!exactBinding || exactBinding === "invalid") return false;
  const decision = acceptanceRecordSummaryDecisionForBinding(input.events, exactBinding);
  if (decision === "invalid") return false;
  if (alignment.kind === "not_recorded") return decision === null;
  if (alignment.kind === "not_current") {
    return (decision?.decision ?? null) === alignment.currentDecision
      && (decision?.eventId ?? null) === alignment.currentDecisionEventId;
  }
  return decision != null
    && decision.decision === alignment.decision
    && decision.eventId === alignment.decisionEventId;
}

function acceptanceRecordSummaryPostMerge(input: {
  record: ChangeRecordRow;
  merge: AcceptanceRecordSummaryStoredMerge;
  events: readonly ChangeRecordEventRow[];
}): AcceptanceRecordSummaryOutcome | "invalid" {
  const candidates = acceptanceRecordSummaryRelevantPostMergeEvents(input.events);
  const outcomes = candidates.map((event) => historicalPostMergeOutcome(
    event,
    input.record,
    input.merge,
  ));
  if (outcomes.some((outcome) => outcome === null)) return "invalid";
  const exact = outcomes as HumanAcceptancePostMergeOutcome[];
  const reverted = exact.some((outcome) => outcome.kind === "reverted");
  if ((input.record.state === "reverted") !== reverted) return "invalid";
  return {
    kind: "signed_merge",
    mergeEventId: input.merge.event.id,
    mergeSha: input.merge.payload.mergeSha,
    mergedAt: new Date(input.merge.payload.mergedAt),
    decisionAlignment: input.merge.payload.decisionAlignment.kind,
    postMerge: {
      deployment: exact.some((outcome) => outcome.kind === "deployed")
        ? "recorded" : "not_recorded",
      incident: exact.some((outcome) => outcome.kind === "incident")
        ? "recorded" : "not_recorded",
      revert: reverted ? "recorded" : "not_recorded",
    },
  };
}

function acceptanceRecordSummaryContextCustody(input: {
  snapshot: AcceptanceContextPackSnapshotRow;
  record: ChangeRecordRow;
  focus: Pick<AcceptanceRecordSummaryFocus, "headSha" | "headCycleId">;
  contract: AcceptanceRecordSummaryConfirmedContract;
  job: ReviewJobRow | undefined;
  events: readonly ChangeRecordEventRow[];
  repositoryRows: readonly (typeof repositories.$inferSelect)[];
  wikiPagesById: ReadonlyMap<string, typeof wikiPages.$inferSelect>;
}): AcceptanceContextPackCustodyResolution | null {
  const snapshotInput = acceptanceRecordSummarySnapshotInput(input.snapshot);
  if (!validateAcceptanceContextPackSnapshotInput(snapshotInput)
    || input.snapshot.id !== acceptanceContextPackSnapshotId(snapshotInput)
    || input.snapshot.workspaceId !== input.record.workspaceId
    || input.snapshot.recordId !== input.record.id
    || input.snapshot.repo !== input.record.repo
    || input.snapshot.prNumber !== input.record.prNumber
    || input.snapshot.expectedHeadSha !== input.focus.headSha
    || input.snapshot.reviewJobId !== input.focus.headCycleId
    || input.snapshot.acceptanceContractId !== input.contract.identity.id
    || input.snapshot.acceptanceContractVersion !== input.contract.identity.version
    || input.snapshot.acceptanceContractSha256 !== input.contract.identity.sha256
    || !input.job || input.job.id !== input.focus.headCycleId
    || input.job.workspaceId !== input.record.workspaceId
    || input.job.repo !== input.record.repo
    || input.job.prNumber !== input.record.prNumber
    || input.job.headSha !== input.focus.headSha) return null;
  const criteria = new Map(input.contract.projection.acceptanceCriteria.map((criterion) => [
    criterion.id,
    criterion.text,
  ]));
  const correctionEvents = input.events.filter((event) =>
    event.eventKey.startsWith(`review:correction:${input.focus.headCycleId}:`));
  const packets = correctionPacketPayloadsForSnapshotEvents(
    correctionEvents,
    snapshotInput,
    criteria,
  );
  if (!packets
    || !isDeepStrictEqual(packets.packetIds, input.snapshot.packetIds)
    || input.snapshot.packetSetSha256 !== acceptanceContextPacketSetSha256({
      packetIds: packets.packetIds,
    })
    || input.snapshot.correctionPacketPayloadSetSha256
      !== acceptanceCorrectionPacketPayloadSetSha256({ packets: packets.packets })) return null;
  const wikiRows: AcceptanceContextPackCustodyResolution["wikiPages"] = [];
  if (snapshotInput.status === "admitted") {
    const baseIndex = snapshotInput.baseIndex!;
    const repositoryIds = [...new Set(baseIndex.pages.map((page) => page.repositoryId))];
    const repository = input.repositoryRows.length === 1 ? input.repositoryRows[0] : undefined;
    if (repositoryIds.length > 1
      || (repositoryIds.length === 1
        && (!repository || repository.id !== repositoryIds[0]))) return null;
    let totalBodyBytes = 0;
    for (const page of baseIndex.pages) {
      const actual = input.wikiPagesById.get(page.id);
      const bodyBytes = actual ? Buffer.byteLength(actual.bodyMd, "utf8") : 0;
      totalBodyBytes += bodyBytes;
      if (!actual || bodyBytes === 0 || bodyBytes > MAX_CONTEXT_CUSTODY_WIKI_PAGE_BYTES
        || totalBodyBytes > MAX_CONTEXT_CUSTODY_WIKI_TOTAL_BYTES
        || actual.workspaceId !== input.record.workspaceId
        || actual.repositoryId !== page.repositoryId || actual.slug !== page.slug
        || actual.commitSha.toLowerCase() !== page.commitSha.toLowerCase()
        || actual.inputsHash.toLowerCase() !== page.inputsHashSha256.toLowerCase()
        || wikiPageBodySha256(actual.bodyMd) !== page.pageBodySha256.toLowerCase()
        || actual.stale !== page.stale) return null;
      wikiRows.push({
        id: actual.id,
        repositoryId: actual.repositoryId,
        slug: actual.slug,
        commitSha: actual.commitSha,
        inputsHashSha256: actual.inputsHash,
        pageBodySha256: wikiPageBodySha256(actual.bodyMd),
        stale: actual.stale,
        bodyMd: actual.bodyMd,
      });
    }
  }
  return {
    sourceSnapshot: { id: input.snapshot.id, ...snapshotInput },
    contract: input.contract.projection,
    acceptanceContractSha256: input.contract.identity.sha256,
    correctionPackets: packets.packets,
    correctionPacketPayloadSetSha256: input.snapshot.correctionPacketPayloadSetSha256!,
    wikiPages: wikiRows,
  };
}

function acceptanceRecordSummaryCompiledPack(input: {
  row: AcceptanceCompiledContextPackRow;
  custody: AcceptanceContextPackCustodyResolution;
}): AcceptanceRecordSummaryCompiledPackIdentity | null {
  const pack = parseCompiledAcceptanceContextPack({
    kind: "compiled_acceptance_context_pack",
    version: 1,
    binding: input.row.binding,
    compiler: {
      version: input.row.compilerVersion,
      policyVersion: input.row.policyVersion,
      byteCounter: "utf8_byte_upper_bound_v1",
      byteBudget: COMPILED_PACK_BYTE_BUDGET,
    },
    manifest: input.row.manifest,
    sourceCustodyReceipt: input.row.sourceCustodyReceipt,
    exactHeadDependencyTreeProofs: input.row.exactHeadDependencyTreeProofs,
    representations: {
      jsonSha256: input.row.jsonSha256,
      markdownSha256: input.row.markdownSha256,
    },
    renderedByteCount: input.row.renderedByteCount,
    packSha256: input.row.packSha256,
  });
  if (!pack
    || input.row.id !== acceptanceCompiledContextPackId({
      sourceSnapshotId: input.row.sourceSnapshotId,
      compilerVersion: input.row.compilerVersion,
      policyVersion: input.row.policyVersion,
    })
    || input.row.workspaceId !== input.custody.sourceSnapshot.workspaceId
    || input.row.sourceSnapshotId !== input.custody.sourceSnapshot.id
    || compiledPackIdentity(pack) !== input.row.packSha256
    || pack.sourceCustodyReceipt["identitySha256"] !== input.row.sourceCustodyIdentitySha256
    || !bindingMatchesCustody(pack.binding, input.custody)
    || !receiptMatchesCustody(pack.sourceCustodyReceipt, input.custody)
    || !manifestMatchesCustody(pack, input.custody)
    || !compiledPackDependencyTreeMetadataMatches(pack)) return null;
  return {
    id: input.row.id,
    sha256: input.row.packSha256,
    sourceCustodyIdentitySha256: input.row.sourceCustodyIdentitySha256,
    compilerVersion: input.row.compilerVersion,
    policyVersion: input.row.policyVersion,
  };
}

function mapAcceptanceRecordSummarySnapshotRow(
  row: Record<string, unknown>,
): AcceptanceContextPackSnapshotRow {
  return {
    id: row["id"] as string,
    workspaceId: row["workspace_id"] as string,
    recordId: row["record_id"] as string,
    reviewJobId: row["review_job_id"] as string,
    acceptanceContractId: row["acceptance_contract_id"] as string,
    acceptanceContractVersion: row["acceptance_contract_version"] as number,
    acceptanceContractSha256: (row["acceptance_contract_sha256"] as string | null) ?? null,
    repo: row["repo"] as string,
    prNumber: row["pr_number"] as number,
    expectedHeadSha: row["expected_head_sha"] as string,
    baseSha: (row["base_sha"] as string | null) ?? null,
    mergeBaseSha: (row["merge_base_sha"] as string | null) ?? null,
    headTreeSha: (row["head_tree_sha"] as string | null) ?? null,
    packetIds: row["packet_ids"] as string[],
    packetSetSha256: row["packet_set_sha256"] as string,
    correctionPacketPayloadSetSha256:
      (row["correction_packet_payload_set_sha256"] as string | null) ?? null,
    compilerVersion: row["compiler_version"] as string,
    baseIndex: (row["base_index"] as Record<string, unknown> | null) ?? null,
    overlay: (row["overlay"] as Record<string, unknown> | null) ?? null,
    provenance: row["provenance"] as Record<string, unknown>,
    status: row["status"] as string,
    reason: (row["reason"] as string | null) ?? null,
    createdAt: toDate(row["created_at"]),
    updatedAt: toDate(row["updated_at"]),
  };
}

function mapAcceptanceRecordSummaryCompiledPackRow(
  row: Record<string, unknown>,
): AcceptanceCompiledContextPackRow {
  const exactHeadDependencyTreeProofs = row["exact_head_dependency_tree_proofs"] as AcceptanceCompiledContextPackRow["exactHeadDependencyTreeProofs"];
  return {
    id: row["id"] as string,
    workspaceId: row["workspace_id"] as string,
    sourceSnapshotId: row["source_snapshot_id"] as string,
    compilerVersion: row["compiler_version"] as string,
    policyVersion: row["policy_version"] as string,
    packSha256: row["pack_sha256"] as string,
    sourceCustodyIdentitySha256: row["source_custody_identity_sha256"] as string,
    jsonSha256: row["json_sha256"] as string,
    markdownSha256: row["markdown_sha256"] as string,
    renderedByteCount: row["rendered_byte_count"] as number,
    binding: row["binding"] as Record<string, unknown>,
    manifest: row["manifest"] as Record<string, unknown>,
    sourceCustodyReceipt: row["source_custody_receipt"] as Record<string, unknown>,
    exactHeadDependencyTreeProofs,
    createdAt: toDate(row["created_at"]),
  };
}

function mapAcceptanceRecordSummaryRepositoryRow(
  row: Record<string, unknown>,
): typeof repositories.$inferSelect {
  return {
    id: row["id"] as string,
    workspaceId: row["workspace_id"] as string,
    name: row["name"] as string,
    url: row["url"] as string,
    defaultBranch: row["default_branch"] as string,
    createdAt: toDate(row["created_at"]),
    updatedAt: toDate(row["updated_at"]),
  };
}

const ACCEPTANCE_RECORD_SUMMARY_ALL_DECISIONS: AcceptancePrDecision[] = [
  "approved",
  "changes_requested",
  "rejected",
  "approved_with_exception",
];

const ACCEPTANCE_RECORD_SUMMARY_NON_PROVEN_DECISIONS: AcceptancePrDecision[] = [
  "changes_requested",
  "rejected",
  "approved_with_exception",
];

/**
 * Bounded list projection for Acceptance Records. The reader acquires every
 * attached PR lock in deterministic order, then resolves all custody with
 * set-based reads. A 257th relevant event is detected explicitly; no Record
 * can silently project a partial view of its first 256 custody events.
 */
type ParsedReadAcceptanceRecordSummariesInput = ReturnType<
  typeof parseReadAcceptanceRecordSummariesInput
> & { recordId?: string };

async function readAcceptanceRecordSummariesInTransaction(
  tx: DbTransaction,
  parsed: ParsedReadAcceptanceRecordSummariesInput,
): Promise<ReadAcceptanceRecordSummariesResult> {
    const candidatePredicates = [eq(changeRecords.workspaceId, parsed.workspaceId)];
    if (parsed.repo != null) candidatePredicates.push(eq(changeRecords.repo, parsed.repo));
    if (parsed.recordId != null) candidatePredicates.push(eq(changeRecords.id, parsed.recordId));
    const candidates = await tx.select().from(changeRecords).where(and(...candidatePredicates))
      .orderBy(desc(changeRecords.updatedAt), desc(changeRecords.createdAt), desc(changeRecords.id))
      .limit(parsed.limit);
    if (candidates.length === 0) return { kind: "records", records: [] };

    const candidateById = new Map(candidates.map((record) => [record.id, record]));
    const lockKeys = [...new Set(candidates.flatMap((record) =>
      record.prNumber != null && safeRepo(record.repo)
        && Number.isSafeInteger(record.prNumber) && record.prNumber > 0
        ? [acceptanceRecordPullRequestLockKey({
            workspaceId: record.workspaceId,
            recordId: record.id,
            repo: record.repo,
            prNumber: record.prNumber,
          })]
        : []
    ))].sort((left, right) => left.localeCompare(right));
    if (lockKeys.length > 0) {
      await tx.execute(sql`
        WITH ordered_locks AS MATERIALIZED (
          SELECT lock_key
          FROM unnest(${textArraySql(lockKeys)}) AS summary_locks(lock_key)
          ORDER BY lock_key
        )
        SELECT pg_advisory_xact_lock(hashtext(lock_key))
        FROM ordered_locks
        ORDER BY lock_key
      `);
    }

    const recordIds = candidates.map((record) => record.id);
    const records = await tx.select().from(changeRecords).where(and(
      eq(changeRecords.workspaceId, parsed.workspaceId),
      inArray(changeRecords.id, recordIds),
      ...(parsed.repo == null ? [] : [eq(changeRecords.repo, parsed.repo)]),
    )).orderBy(desc(changeRecords.updatedAt), desc(changeRecords.createdAt), desc(changeRecords.id));
    if (records.length === 0) return { kind: "records", records: [] };
    const stableRecordIds = records.map((record) => record.id);
    const stableRecordIdSql = sql.join(
      stableRecordIds.map((recordId) => sql`${recordId}::uuid`),
      sql`, `,
    );
    const unlockedRecords = new Set(records.flatMap((record) => {
      const candidate = candidateById.get(record.id);
      return candidate && candidate.repo === record.repo && candidate.prNumber === record.prNumber
        ? [] : [record.id];
    }));

    const confirmedRows = await tx.select().from(acceptanceContracts).where(and(
      inArray(acceptanceContracts.recordId, stableRecordIds),
      eq(acceptanceContracts.status, "confirmed"),
    )).orderBy(asc(acceptanceContracts.recordId), asc(acceptanceContracts.version));
    const confirmedByRecord = new Map<string, AcceptanceContractRow[]>();
    for (const contract of confirmedRows) {
      const rows = confirmedByRecord.get(contract.recordId) ?? [];
      rows.push(contract);
      confirmedByRecord.set(contract.recordId, rows);
    }
    const contractByRecord = new Map(records.map((record) => [
      record.id,
      acceptanceRecordSummaryConfirmedContract(confirmedByRecord.get(record.id) ?? []),
    ]));

    const rawEventRows = Array.from(await tx.execute(sql`
      WITH ranked_events AS (
        SELECT events.*,
          row_number() OVER (
            PARTITION BY events.record_id
            ORDER BY events.at ASC, events.id ASC
          ) AS summary_rank
        FROM change_record_events AS events
        WHERE events.record_id IN (${stableRecordIdSql})
          AND (
            events.event_key LIKE 'review:github-posted:%'
            OR events.event_key LIKE 'review:correction:%'
            OR events.event_key LIKE 'acceptance-pr-decision:%'
            OR events.event_key LIKE 'acceptance-pr:signed-merge:%'
            OR events.event_key LIKE 'external-pr:signed-merge:%'
            OR events.event_key LIKE 'acceptance-post-merge:%'
            OR events.stage = ${REVIEW_JOB_POSTED_ATTESTATION_STAGE}
            OR events.stage = ${ACCEPTANCE_PR_DECISION_STAGE}
            OR events.stage = ${SIGNED_ACCEPTANCE_RECORD_MERGE_STAGE}
            OR events.stage = 'post_merge_outcome'
            OR events.payload_ref->>'kind' = ${REVIEW_JOB_POSTED_ATTESTATION_KIND}
            OR events.payload_ref->>'kind' = ${ACCEPTANCE_PR_DECISION_KIND}
            OR events.payload_ref->>'kind' = ${SIGNED_ACCEPTANCE_RECORD_MERGE_KIND}
            OR events.payload_ref->>'kind' = ${SIGNED_ACCEPTANCE_RECORD_MERGE_DELIVERY_KIND}
            OR events.payload_ref->>'kind' = 'acceptance_post_merge_outcome'
          )
      )
      SELECT * FROM ranked_events
      WHERE summary_rank <= ${ACCEPTANCE_RECORD_SUMMARY_EVENT_LIMIT + 1}
      ORDER BY record_id ASC, at ASC, id ASC
    `)) as Array<Record<string, unknown>>;
    const eventRowsByRecord = new Map<string, ChangeRecordEventRow[]>();
    for (const row of rawEventRows) {
      const event = mapChangeRecordEventRow(row);
      const rows = eventRowsByRecord.get(event.recordId) ?? [];
      rows.push(event);
      eventRowsByRecord.set(event.recordId, rows);
    }
    const eventOverflow = new Set(stableRecordIds.filter((recordId) =>
      (eventRowsByRecord.get(recordId)?.length ?? 0) > ACCEPTANCE_RECORD_SUMMARY_EVENT_LIMIT
    ));
    const eventsByRecord = new Map(stableRecordIds.map((recordId) => [
      recordId,
      eventOverflow.has(recordId)
        ? []
        : (eventRowsByRecord.get(recordId) ?? []).slice(0, ACCEPTANCE_RECORD_SUMMARY_EVENT_LIMIT),
    ]));

    const mergeBeforeLineageByRecord = new Map(records.map((record) => [
      record.id,
      acceptanceRecordSummaryMergeBeforeLineage(record, eventsByRecord.get(record.id) ?? []),
    ]));
    const preliminaryFocusByRecord = new Map(records.map((record) => [
      record.id,
      unlockedRecords.has(record.id)
        ? "invalid" as const
        : acceptanceRecordSummaryFocusFromRecord(
            record,
            mergeBeforeLineageByRecord.get(record.id) ?? null,
          ),
    ]));
    const reviewJobIds = [...new Set(records.flatMap((record) => {
      const ids: string[] = [];
      const focus = preliminaryFocusByRecord.get(record.id);
      if (focus && focus !== "invalid") ids.push(focus.headCycleId);
      const merge = mergeBeforeLineageByRecord.get(record.id);
      if (merge && merge !== "invalid") {
        const alignment = merge.payload.decisionAlignment;
        if (alignment.kind === "aligned" || alignment.kind === "decision_conflicts_merge"
          || alignment.kind === "not_recorded") ids.push(alignment.binding.reviewJobId);
        if (alignment.kind === "not_current" && alignment.currentBinding != null) {
          ids.push(alignment.currentBinding.reviewJobId);
        }
      }
      return ids;
    }))];
    const jobs = reviewJobIds.length === 0 ? [] : await tx.select().from(reviewJobs).where(and(
      eq(reviewJobs.workspaceId, parsed.workspaceId),
      inArray(reviewJobs.id, reviewJobIds),
    ));
    const jobsById = new Map(jobs.map((job) => [job.id, job]));

    const mergeByRecord = new Map<string, AcceptanceRecordSummaryStoredMerge | null | "invalid">();
    const focusByRecord = new Map<string, AcceptanceRecordSummaryFocus | null | "invalid">();
    for (const record of records) {
      const events = eventsByRecord.get(record.id) ?? [];
      const contract = contractByRecord.get(record.id) ?? null;
      let merge = mergeBeforeLineageByRecord.get(record.id) ?? null;
      if (merge && merge !== "invalid" && !acceptanceRecordSummaryMergeLineageValid({
        merge,
        record,
        contract,
        events,
        jobsById,
      })) merge = "invalid";
      mergeByRecord.set(record.id, merge);
      focusByRecord.set(record.id, unlockedRecords.has(record.id)
        ? "invalid"
        : acceptanceRecordSummaryFocusFromRecord(record, merge));
    }

    const focusJobIds = [...new Set([...focusByRecord.values()].flatMap((focus) =>
      focus && focus !== "invalid" ? [focus.headCycleId] : []
    ))];
    const rawSnapshotRows = focusJobIds.length === 0 ? [] : Array.from(await tx.execute(sql`
      WITH ranked_snapshots AS (
        SELECT snapshots.*,
          row_number() OVER (
            PARTITION BY snapshots.record_id, snapshots.review_job_id
            ORDER BY snapshots.created_at ASC, snapshots.id ASC
          ) AS summary_rank
        FROM acceptance_context_pack_snapshots AS snapshots
        WHERE snapshots.workspace_id = ${parsed.workspaceId}::uuid
          AND snapshots.record_id IN (${stableRecordIdSql})
          AND snapshots.review_job_id IN (${sql.join(
            focusJobIds.map((jobId) => sql`${jobId}::uuid`),
            sql`, `,
          )})
      )
      SELECT * FROM ranked_snapshots
      WHERE summary_rank <= ${ACCEPTANCE_RECORD_SUMMARY_CONTEXT_IDENTITY_LIMIT}
      ORDER BY record_id ASC, review_job_id ASC, created_at ASC, id ASC
    `)) as Array<Record<string, unknown>>;
    const snapshotsByFocus = new Map<string, AcceptanceContextPackSnapshotRow[]>();
    for (const row of rawSnapshotRows) {
      const snapshot = mapAcceptanceRecordSummarySnapshotRow(row);
      const key = `${snapshot.recordId}:${snapshot.reviewJobId}`;
      const rows = snapshotsByFocus.get(key) ?? [];
      rows.push(snapshot);
      snapshotsByFocus.set(key, rows);
    }
    const selectedSnapshots = records.flatMap((record) => {
      const focus = focusByRecord.get(record.id);
      if (!focus || focus === "invalid") return [];
      const rows = snapshotsByFocus.get(`${record.id}:${focus.headCycleId}`) ?? [];
      return rows.length === 1 ? rows : [];
    });
    const snapshotIds = selectedSnapshots.map((snapshot) => snapshot.id);
    const rawCompiledPackRows = snapshotIds.length === 0 ? [] : Array.from(await tx.execute(sql`
      WITH ranked_packs AS (
        SELECT packs.*,
          row_number() OVER (
            PARTITION BY packs.source_snapshot_id
            ORDER BY packs.created_at ASC, packs.id ASC
          ) AS summary_rank
        FROM acceptance_compiled_context_packs AS packs
        WHERE packs.workspace_id = ${parsed.workspaceId}::uuid
          AND packs.source_snapshot_id IN (${sql.join(
            snapshotIds.map((snapshotId) => sql`${snapshotId}::uuid`),
            sql`, `,
          )})
      )
      SELECT * FROM ranked_packs
      WHERE summary_rank <= ${ACCEPTANCE_RECORD_SUMMARY_CONTEXT_IDENTITY_LIMIT}
      ORDER BY source_snapshot_id ASC, created_at ASC, id ASC
    `)) as Array<Record<string, unknown>>;
    const compiledPacksBySnapshot = new Map<string, AcceptanceCompiledContextPackRow[]>();
    for (const row of rawCompiledPackRows) {
      const pack = mapAcceptanceRecordSummaryCompiledPackRow(row);
      const rows = compiledPacksBySnapshot.get(pack.sourceSnapshotId) ?? [];
      rows.push(pack);
      compiledPacksBySnapshot.set(pack.sourceSnapshotId, rows);
    }

    const wikiPageIds = new Set<string>();
    const wikiRepositoryNames = new Set<string>();
    for (const snapshot of selectedSnapshots) {
      const snapshotInput = acceptanceRecordSummarySnapshotInput(snapshot);
      if (!validateAcceptanceContextPackSnapshotInput(snapshotInput)
        || snapshotInput.status !== "admitted" || !snapshotInput.baseIndex) continue;
      wikiRepositoryNames.add(snapshot.repo);
      for (const page of snapshotInput.baseIndex.pages) wikiPageIds.add(page.id);
    }
    const repositoryNames = [...wikiRepositoryNames];
    const rawRepositoryRows = repositoryNames.length === 0 ? [] : Array.from(await tx.execute(sql`
      WITH ranked_repositories AS (
        SELECT repository_rows.*,
          row_number() OVER (
            PARTITION BY repository_rows.name
            ORDER BY repository_rows.created_at ASC, repository_rows.id ASC
          ) AS summary_rank
        FROM repositories AS repository_rows
        WHERE repository_rows.workspace_id = ${parsed.workspaceId}::uuid
          AND repository_rows.name IN (${sql.join(
            repositoryNames.map((name) => sql`${name}`),
            sql`, `,
          )})
      )
      SELECT * FROM ranked_repositories
      WHERE summary_rank <= ${ACCEPTANCE_RECORD_SUMMARY_CONTEXT_IDENTITY_LIMIT}
      ORDER BY name ASC, created_at ASC, id ASC
    `)) as Array<Record<string, unknown>>;
    const repositoriesByName = new Map<string, Array<typeof repositories.$inferSelect>>();
    for (const row of rawRepositoryRows) {
      const repository = mapAcceptanceRecordSummaryRepositoryRow(row);
      const rows = repositoriesByName.get(repository.name) ?? [];
      rows.push(repository);
      repositoriesByName.set(repository.name, rows);
    }
    const wikiRows = wikiPageIds.size === 0 ? [] : await tx.select().from(wikiPages).where(and(
      eq(wikiPages.workspaceId, parsed.workspaceId),
      inArray(wikiPages.id, [...wikiPageIds]),
    ));
    const wikiPagesById = new Map(wikiRows.map((page) => [page.id, page]));

    const summaries = records.map((record): AcceptanceRecordSummary => {
      const reasons = new Set<AcceptanceRecordSummaryUnknownReason>();
      const overflow = eventOverflow.has(record.id);
      if (overflow) reasons.add("summary_custody_limit");
      const events = eventsByRecord.get(record.id) ?? [];
      const contract = contractByRecord.get(record.id) ?? null;
      const requestedWork: AcceptanceRecordSummaryRequestedWork = contract && contract !== "invalid"
        ? {
            kind: "confirmed",
            originalRequest: contract.projection.originalRequest,
            acceptanceContract: contract.identity,
          }
        : { kind: "unknown" };
      if (contract === null) reasons.add("requested_work_not_confirmed");
      if (contract === "invalid") reasons.add("invalid_contract_custody");

      const focus = focusByRecord.get(record.id) ?? null;
      let pullRequest: AcceptanceRecordSummaryPullRequest;
      if (record.prNumber == null) {
        pullRequest = { kind: "not_attached" };
        if (focus === "invalid") reasons.add("invalid_head_custody");
      } else if (focus && focus !== "invalid") {
        pullRequest = {
          kind: "attached",
          prNumber: record.prNumber,
          head: {
            kind: focus.kind,
            sha: focus.headSha,
            headCycleId: focus.headCycleId,
            authorityGeneration: focus.authorityGeneration,
          },
        };
      } else {
        pullRequest = { kind: "attached", prNumber: record.prNumber, head: { kind: "unknown" } };
        reasons.add(focus === "invalid" ? "invalid_head_custody" : "head_occurrence_not_authoritative");
      }

      let binding: CurrentAcceptancePrDecisionBinding | null | "invalid" = null;
      if (!overflow && focus && focus !== "invalid" && contract && contract !== "invalid") {
        binding = acceptanceRecordSummaryCycleBinding({
          record,
          focus,
          contract,
          events,
          jobsById,
        });
      }
      let proof: AcceptanceRecordSummaryProof = { kind: "unknown" };
      if (binding && binding !== "invalid") {
        proof = {
          kind: "recorded",
          reviewJobId: binding.reviewJobId,
          verdict: binding.reviewVerdict,
          postedReviewUrl: binding.postedReviewUrl,
          postedAttestationEventId: binding.postedAttestationEventId,
        };
      } else if (!overflow) {
        reasons.add(binding === "invalid" ? "invalid_review_custody" : "proof_not_recorded");
      }

      let suppliedContext: AcceptanceRecordSummarySuppliedContext = { kind: "unknown" };
      if (!overflow && focus && focus !== "invalid" && contract && contract !== "invalid") {
        const snapshots = snapshotsByFocus.get(`${record.id}:${focus.headCycleId}`) ?? [];
        if (snapshots.length === 0) {
          reasons.add("context_not_recorded");
        } else if (snapshots.length !== 1) {
          reasons.add("ambiguous_context_custody");
        } else {
          const snapshot = snapshots[0]!;
          const custody = acceptanceRecordSummaryContextCustody({
            snapshot,
            record,
            focus,
            contract,
            job: jobsById.get(focus.headCycleId),
            events,
            repositoryRows: repositoriesByName.get(record.repo) ?? [],
            wikiPagesById,
          });
          const packs = compiledPacksBySnapshot.get(snapshot.id) ?? [];
          if (!custody || (snapshot.status === "not_proven" && packs.length !== 0)) {
            reasons.add("invalid_context_custody");
          } else if (snapshot.status === "not_proven") {
            suppliedContext = {
              kind: "not_proven",
              sourceSnapshot: acceptanceRecordSummarySourceSnapshotIdentity(snapshot),
            };
          } else if (packs.length === 0) {
            suppliedContext = {
              kind: "admitted",
              sourceSnapshot: acceptanceRecordSummarySourceSnapshotIdentity(snapshot),
            };
          } else if (packs.length !== 1) {
            reasons.add("ambiguous_context_custody");
          } else {
            const compiledPack = acceptanceRecordSummaryCompiledPack({ row: packs[0]!, custody });
            if (!compiledPack) {
              reasons.add("invalid_context_custody");
            } else {
              suppliedContext = {
                kind: "compiled",
                sourceSnapshot: acceptanceRecordSummarySourceSnapshotIdentity(snapshot),
                compiledPack,
              };
            }
          }
        }
      } else if (!overflow) {
        reasons.add("context_not_recorded");
      }

      const merge = mergeByRecord.get(record.id) ?? null;
      let outcome: AcceptanceRecordSummaryOutcome;
      if (overflow) {
        outcome = { kind: "unknown" };
      } else if (merge === "invalid") {
        outcome = { kind: "unknown" };
        reasons.add("invalid_merge_custody");
      } else if (merge) {
        const projected = acceptanceRecordSummaryPostMerge({ record, merge, events });
        if (projected === "invalid") {
          outcome = { kind: "unknown" };
          reasons.add("invalid_post_merge_custody");
        } else {
          outcome = projected;
        }
      } else if (acceptanceRecordSummaryRelevantPostMergeEvents(events).length > 0) {
        outcome = { kind: "unknown" };
        reasons.add("invalid_post_merge_custody");
      } else {
        outcome = { kind: "not_recorded" };
        reasons.add("outcome_not_recorded");
      }

      let neededDecision: AcceptanceRecordSummaryNeededDecision;
      if (record.prNumber == null) {
        neededDecision = { kind: "not_required", reason: "pr_not_attached" };
      } else if (outcome.kind === "signed_merge") {
        neededDecision = {
          kind: "not_required",
          reason: record.state === "reverted" ? "reverted" : "merged",
        };
      } else if (binding && binding !== "invalid") {
        const decision = acceptanceRecordSummaryDecisionForBinding(events, binding);
        if (decision === "invalid") {
          neededDecision = { kind: "unknown" };
          reasons.add("invalid_decision_custody");
        } else if (decision) {
          neededDecision = {
            kind: "recorded",
            eventId: decision.eventId,
            decision: decision.decision,
            decidedAt: decision.decidedAt,
          };
        } else {
          neededDecision = {
            kind: "required",
            choices: binding.reviewVerdict === "proven"
              ? [...ACCEPTANCE_RECORD_SUMMARY_ALL_DECISIONS]
              : [...ACCEPTANCE_RECORD_SUMMARY_NON_PROVEN_DECISIONS],
          };
          reasons.add("decision_not_recorded");
        }
      } else {
        neededDecision = { kind: "unknown" };
        if (!overflow) {
          reasons.add(binding === "invalid" ? "invalid_decision_custody" : "decision_not_recorded");
        }
      }

      return {
        recordId: record.id,
        workspaceId: record.workspaceId,
        repo: record.repo,
        issueNumber: record.issueNumber,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        requestedWork,
        suppliedContext,
        pullRequest,
        proof,
        unknownReasons: acceptanceRecordSummaryUnknownReasons(reasons),
        neededDecision,
        outcome,
      };
    });
    return { kind: "records", records: summaries };
}

export async function readAcceptanceRecordSummaries(
  input: ReadAcceptanceRecordSummariesInput,
): Promise<ReadAcceptanceRecordSummariesResult> {
  const parsed = parseReadAcceptanceRecordSummariesInput(input);
  return db.transaction((tx) => readAcceptanceRecordSummariesInTransaction(tx, parsed));
}

const ACCEPTANCE_RECORD_DETAIL_EVENT_LIMIT = 256;
const ACCEPTANCE_RECORD_DETAIL_SNAPSHOT_LIMIT = 128;
const ACCEPTANCE_RECORD_DETAIL_COMPILED_PACKS_PER_SNAPSHOT_LIMIT = 8;
const ACCEPTANCE_RECORD_DETAIL_COMPILED_PACK_LIMIT = 64;
const ACCEPTANCE_RECORD_DETAIL_OCCURRENCE_LIMIT = 128;
const ACCEPTANCE_RECORD_DETAIL_MAX_SERIALIZED_BYTES = 2 * 1024 * 1024;

function parseReadAcceptanceRecordDetailInput(
  input: unknown,
): ReadAcceptanceRecordDetailInput {
  if (!isRecord(input) || !hasExactKeys(input, ["workspaceId", "recordId"])
    || !isUuid(input["workspaceId"]) || !isUuid(input["recordId"])) {
    throw new Error("Acceptance Record detail requires only workspace and Record");
  }
  return { workspaceId: input["workspaceId"], recordId: input["recordId"] };
}

function acceptanceRecordDetailSerializedBytes(detail: AcceptanceRecordDetail): number {
  const transportValue = (value: unknown): unknown => {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(transportValue);
    if (isRecord(value)) return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, transportValue(nested)]),
    );
    return value;
  };
  return Buffer.byteLength(
    acceptanceContextPackCanonicalJson(transportValue(detail)),
    "utf8",
  );
}

function acceptanceRecordDetailRecordCustodyValid(record: ChangeRecordRow): boolean {
  if (!isUuid(record.id) || !isUuid(record.workspaceId) || !safeRepo(record.repo)
    || (record.issueNumber !== null
      && (!Number.isSafeInteger(record.issueNumber) || record.issueNumber <= 0))
    || (record.prNumber !== null
      && (!Number.isSafeInteger(record.prNumber) || record.prNumber <= 0))
    || (record.state !== "open" && record.state !== "merged" && record.state !== "reverted")
    || !Number.isSafeInteger(record.currentPrHeadAuthorityGeneration)
    || record.currentPrHeadAuthorityGeneration < 0
    || !Array.isArray(record.headShas) || record.headShas.length > 512
    || !record.headShas.every((headSha) => typeof headSha === "string" && EXACT_SHA1.test(headSha))
    || new Set(record.headShas).size !== record.headShas.length
    || ((record.currentPrHeadSha === null) !== (record.currentPrHeadCycleId === null))
    || (record.currentPrHeadSha !== null && !EXACT_SHA1.test(record.currentPrHeadSha))
    || (record.currentPrHeadCycleId !== null && !isUuid(record.currentPrHeadCycleId))
    || (record.mergedSha !== null && !EXACT_SHA1.test(record.mergedSha))
    || !(record.createdAt instanceof Date) || Number.isNaN(record.createdAt.valueOf())
    || !(record.updatedAt instanceof Date) || Number.isNaN(record.updatedAt.valueOf())) return false;
  if (record.prNumber === null) {
    return record.currentPrHeadSha === null && record.currentPrHeadCycleId === null
      && !record.currentPrHeadAuthoritative && record.mergedSha === null
      && record.state === "open";
  }
  if (record.currentPrHeadAuthoritative) {
    return record.state === "open" && record.mergedSha === null
      && record.currentPrHeadSha !== null && record.currentPrHeadCycleId !== null
      && record.headShas.includes(record.currentPrHeadSha);
  }
  if (record.state === "merged" || record.state === "reverted") {
    return record.mergedSha !== null;
  }
  return record.state === "open" && record.mergedSha === null;
}

function isAcceptanceRecordDetailReviewJobState(
  value: unknown,
): value is AcceptanceRecordDetailReviewJobState {
  return value === "queued" || value === "running" || value === "posted"
    || value === "failed" || value === "superseded" || value === "skipped";
}

function acceptanceRecordDetailReviewJob(
  job: ReviewJobRow | undefined,
): AcceptanceRecordDetailReviewJob | null {
  if (!job) return { kind: "not_recorded" };
  if (!isUuid(job.id) || !isUuid(job.workspaceId) || !safeRepo(job.repo)
    || !Number.isSafeInteger(job.prNumber) || job.prNumber <= 0
    || !EXACT_SHA1.test(job.headSha) || !isAcceptanceRecordDetailReviewJobState(job.state)
    || !(job.createdAt instanceof Date) || Number.isNaN(job.createdAt.valueOf())
    || !(job.updatedAt instanceof Date) || Number.isNaN(job.updatedAt.valueOf())) return null;
  return {
    kind: "recorded",
    id: job.id,
    state: job.state,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function acceptanceRecordDetailOccurrenceIdentity(
  occurrence: AcceptanceRecordDetailOccurrence,
): AcceptanceRecordDetailOccurrenceIdentity & {
  kind: "current" | "merged" | "historical";
} {
  return {
    kind: occurrence.kind,
    repo: occurrence.repo,
    prNumber: occurrence.prNumber,
    headSha: occurrence.headSha,
    headCycleId: occurrence.headCycleId,
  };
}

function acceptanceRecordDetailSnapshot(
  snapshot: AcceptanceContextPackSnapshotRow,
  occurrence: AcceptanceRecordDetailOccurrence,
  contract: AcceptanceRecordDetailContract,
): AcceptanceRecordDetailSourceSnapshot {
  return {
    id: snapshot.id,
    occurrence: acceptanceRecordDetailOccurrenceIdentity(occurrence),
    binding: {
      workspaceId: snapshot.workspaceId,
      recordId: snapshot.recordId,
      reviewJobId: snapshot.reviewJobId,
      acceptanceContract: { ...contract.identity },
      repo: snapshot.repo,
      prNumber: snapshot.prNumber,
      expectedHeadSha: snapshot.expectedHeadSha,
    },
    baseSha: snapshot.baseSha,
    mergeBaseSha: snapshot.mergeBaseSha,
    headTreeSha: snapshot.headTreeSha,
    packetIds: [...snapshot.packetIds],
    packetSetSha256: snapshot.packetSetSha256,
    correctionPacketPayloadSetSha256: snapshot.correctionPacketPayloadSetSha256!,
    compilerVersion: snapshot.compilerVersion,
    baseIndex: structuredClone(
      snapshot.baseIndex as AcceptanceContextPackCustodyBaseIndexIdentity | null,
    ),
    overlay: structuredClone(
      snapshot.overlay as AcceptanceContextPackCustodyOverlayManifestIdentity | null,
    ),
    provenance: structuredClone(
      snapshot.provenance as AcceptanceContextInclusionExclusionProvenance,
    ),
    status: snapshot.status as AcceptanceContextPackSnapshotStatus,
    reason: snapshot.reason,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
  };
}

function acceptanceRecordDetailCompiledPack(input: {
  row: AcceptanceCompiledContextPackRow;
  custody: AcceptanceContextPackCustodyResolution;
}): AcceptanceRecordDetailCompiledPack | null {
  if (!acceptanceRecordSummaryCompiledPack(input)) return null;
  const parsed = parseCompiledAcceptanceContextPack({
    kind: "compiled_acceptance_context_pack",
    version: 1,
    binding: input.row.binding,
    compiler: {
      version: input.row.compilerVersion,
      policyVersion: input.row.policyVersion,
      byteCounter: "utf8_byte_upper_bound_v1",
      byteBudget: COMPILED_PACK_BYTE_BUDGET,
    },
    manifest: input.row.manifest,
    sourceCustodyReceipt: input.row.sourceCustodyReceipt,
    exactHeadDependencyTreeProofs: input.row.exactHeadDependencyTreeProofs,
    representations: {
      jsonSha256: input.row.jsonSha256,
      markdownSha256: input.row.markdownSha256,
    },
    renderedByteCount: input.row.renderedByteCount,
    packSha256: input.row.packSha256,
  });
  if (!parsed) return null;
  const manifest = parsed.manifest;
  const receipt = parsed.sourceCustodyReceipt;
  const sources = structuredClone(
    manifest["sources"],
  ) as AcceptanceRecordDetailCompiledPackSource[];
  const manifestExclusions = structuredClone(
    manifest["exclusions"],
  ) as AcceptanceRecordDetailCompiledPackExclusion[];
  const changedManifest = structuredClone(
    receipt["changedManifest"],
  ) as AcceptanceRecordDetailCompiledPack["sourceCustody"]["changedManifest"];
  const records = structuredClone(
    receipt["records"],
  ) as AcceptanceRecordDetailSourceCustodyFile[];
  const exclusions = structuredClone(
    receipt["exclusions"],
  ) as AcceptanceRecordDetailSourceCustodyExclusion[];
  const directReadReceipts = structuredClone(
    receipt["directReadReceipts"],
  ) as AcceptanceRecordDetailDirectReadReceipt[];
  const selectedExactRanges = structuredClone(
    receipt["selectedExactRanges"],
  ) as AcceptanceRecordDetailSelectedExactRange[];
  return {
    id: input.row.id,
    sourceSnapshotId: input.row.sourceSnapshotId,
    compilerVersion: input.row.compilerVersion,
    policyVersion: input.row.policyVersion,
    packSha256: input.row.packSha256,
    sourceCustodyIdentitySha256: input.row.sourceCustodyIdentitySha256,
    representations: {
      jsonSha256: input.row.jsonSha256,
      markdownSha256: input.row.markdownSha256,
      renderedByteCount: input.row.renderedByteCount,
    },
    binding: structuredClone(parsed.binding) as AcceptanceRecordDetailCompiledPackBinding,
    manifest: {
      acceptanceCriterionIds: [...manifest["acceptanceCriterionIds"] as string[]],
      unresolvedQuestionIds: [...manifest["unresolvedQuestionIds"] as string[]],
      packetIds: [...manifest["packetIds"] as string[]],
      sources,
      exclusions: manifestExclusions,
      sourceCount: sources.length,
      exclusionCount: manifestExclusions.length,
      architectureBoundaries: [...manifest["architectureBoundaries"] as string[]],
      tests: [...manifest["tests"] as string[]],
      decisions: [...manifest["decisions"] as string[]],
      custody: {
        fullSourceUploadAllowed: false,
        rawSourcePersisted: false,
        snippetsPersisted: false,
      },
    },
    sourceCustody: {
      kind: "exact_head_source_custody",
      schemaVersion: 2,
      repo: receipt["repo"] as string,
      prNumber: receipt["prNumber"] as number,
      baseSha: receipt["baseSha"] as string,
      mergeBaseSha: receipt["mergeBaseSha"] as string,
      headSha: receipt["headSha"] as string,
      headTreeSha: receipt["headTreeSha"] as string,
      manifestSha256: receipt["manifestSha256"] as string,
      identitySha256: receipt["identitySha256"] as string,
      changedManifest,
      records,
      exclusions,
      directReadReceipts,
      selectedExactRanges,
      changedFileCount: changedManifest.length,
      recordCount: records.length,
      exclusionCount: exclusions.length,
      directReadReceiptCount: directReadReceipts.length,
      selectedExactRangeCount: selectedExactRanges.length,
    },
    exactHeadDependencyTreeProofs: structuredClone(input.row.exactHeadDependencyTreeProofs),
    createdAt: input.row.createdAt,
  };
}

type AcceptanceRecordDetailOccurrenceSeed = {
  headShas: Set<string>;
  requiresReviewJob: boolean;
};

function acceptanceRecordDetailAuthorityOccurrence(input: {
  event: ChangeRecordEventRow;
  record: ChangeRecordRow;
  acceptanceContractVersion: number;
}): { headCycleId: string; headSha: string; requiresReviewJob: boolean }
  | null | "audit_only" | "invalid" {
  const { event, record } = input;
  const payload = event.payloadRef;
  const kind = payload["kind"];
  if (kind === "external_pr_attachment" && hasExactKeys(payload, [
    "kind", "repo", "prNumber", "headSha", "prUrl", "acceptanceContractVersion",
  ])) {
    const eventKey = `external-pr:attached:${record.prNumber}:${payload["headSha"]}`;
    return payload["repo"] === record.repo && payload["prNumber"] === record.prNumber
      && typeof payload["headSha"] === "string" && GIT_SHA.test(payload["headSha"])
      && (payload["prUrl"] === null || safeSnapshotText(payload["prUrl"], 2_048))
      && payload["acceptanceContractVersion"] === input.acceptanceContractVersion
      && event.eventKey === eventKey
      && event.id === changeRecordEventId({ recordId: record.id, eventKey })
      && event.stage === "external_pr"
      && (event.actor === "github_webhook" || event.actor === "manual" || event.actor === "mcp")
      ? "audit_only"
      : "invalid";
  }
  if (kind === "external_pr_attachment" || kind === "external_pr_head_advanced") {
    if (!hasExactKeys(payload, [
      "kind", "repo", "prNumber", "previousHeadSha", "headSha", "headCycleId",
      "event", "deliveryId", "headTransition", "prUrl", "acceptanceContractVersion",
    ]) || payload["repo"] !== record.repo || payload["prNumber"] !== record.prNumber
      || !EXACT_SHA1.test(payload["headSha"] as string) || !isUuid(payload["headCycleId"])
      || !safeSnapshotText(payload["event"], 128) || !safeSnapshotText(payload["deliveryId"], 512)
      || (payload["prUrl"] !== null && !safeSnapshotText(payload["prUrl"], 2_048))
      || payload["acceptanceContractVersion"] !== input.acceptanceContractVersion
      || (event.actor !== "github_webhook" && event.actor !== "manual" && event.actor !== "mcp")
      || event.stage !== "external_pr") return "invalid";
    const previousHeadSha = payload["previousHeadSha"];
    const transition = payload["headTransition"];
    if (kind === "external_pr_attachment") {
      if (previousHeadSha !== null) return "invalid";
    } else if (typeof previousHeadSha !== "string" || !EXACT_SHA1.test(previousHeadSha)
      || !isRecord(transition) || !hasExactKeys(transition, ["beforeHeadSha", "afterHeadSha"])
      || transition["beforeHeadSha"] !== previousHeadSha
      || transition["afterHeadSha"] !== payload["headSha"]) return "invalid";
    if (transition !== null && (!isRecord(transition)
      || !hasExactKeys(transition, ["beforeHeadSha", "afterHeadSha"])
      || !EXACT_SHA1.test(transition["beforeHeadSha"] as string)
      || !EXACT_SHA1.test(transition["afterHeadSha"] as string))) return "invalid";
    const headTransition = transition === null ? null : {
      beforeHeadSha: transition["beforeHeadSha"] as string,
      afterHeadSha: transition["afterHeadSha"] as string,
    };
    const headCycleId = acceptanceRecordPullRequestHeadCycleId({
      workspaceId: record.workspaceId,
      recordId: record.id,
      repo: record.repo,
      prNumber: record.prNumber!,
      headSha: payload["headSha"] as string,
      event: payload["event"] as string,
      deliveryId: payload["deliveryId"] as string,
      headTransition,
    });
    const eventKey = kind === "external_pr_attachment"
      ? `external-pr:attached:${record.prNumber}:${headCycleId}`
      : `external-pr:head-advanced:${record.prNumber}:${headCycleId}`;
    if (payload["headCycleId"] !== headCycleId || event.eventKey !== eventKey
      || event.id !== changeRecordEventId({ recordId: record.id, eventKey })) return "invalid";
    return { headCycleId, headSha: payload["headSha"] as string, requiresReviewJob: false };
  }
  if (kind === "external_pr_head_reconciled") {
    if (!hasExactKeys(payload, [
      "kind", "repo", "prNumber", "expectedBlockedHeadSha", "expectedBlockedCycleId",
      "expectedBlockedAuthorityGeneration", "observedHeadSha", "observedBaseSha",
      "observedState", "observedDraft", "observedMerged", "headCycleId",
      "acceptanceContractVersion",
    ]) || payload["repo"] !== record.repo || payload["prNumber"] !== record.prNumber
      || !EXACT_SHA1.test(payload["expectedBlockedHeadSha"] as string)
      || !isUuid(payload["expectedBlockedCycleId"])
      || !Number.isSafeInteger(payload["expectedBlockedAuthorityGeneration"])
      || (payload["expectedBlockedAuthorityGeneration"] as number) < 0
      || !EXACT_SHA1.test(payload["observedHeadSha"] as string)
      || !EXACT_SHA1.test(payload["observedBaseSha"] as string)
      || payload["observedState"] !== "open" || typeof payload["observedDraft"] !== "boolean"
      || payload["observedMerged"] !== false || !isUuid(payload["headCycleId"])
      || payload["acceptanceContractVersion"] !== input.acceptanceContractVersion
      || event.stage !== "external_pr" || event.actor !== "github_app_api") return "invalid";
    const headCycleId = acceptanceRecordPullRequestReconciliationCycleId({
      workspaceId: record.workspaceId,
      recordId: record.id,
      repo: record.repo,
      prNumber: record.prNumber!,
      expectedBlockedHeadSha: payload["expectedBlockedHeadSha"] as string,
      expectedBlockedCycleId: payload["expectedBlockedCycleId"] as string,
      expectedBlockedAuthorityGeneration: payload["expectedBlockedAuthorityGeneration"] as number,
      observedHeadSha: payload["observedHeadSha"] as string,
      observedBaseSha: payload["observedBaseSha"] as string,
    });
    const eventKey = `external-pr:head-reconciled:${record.prNumber}:${headCycleId}`;
    if (payload["headCycleId"] !== headCycleId || event.eventKey !== eventKey
      || event.id !== changeRecordEventId({ recordId: record.id, eventKey })) return "invalid";
    return {
      headCycleId,
      headSha: payload["observedHeadSha"] as string,
      requiresReviewJob: payload["observedDraft"] === false,
    };
  }
  return null;
}

function acceptanceRecordDetailOccurrenceRank(
  kind: AcceptanceRecordDetailOccurrence["kind"],
): number {
  return kind === "current" ? 0 : kind === "merged" ? 1 : 2;
}

/**
 * Read one strict Acceptance Record detail from canonical Record-owned
 * custody. Review jobs only enrich cycles already owned by the Record header,
 * signed merge, deterministic events, or fully bound Context snapshots.
 */
export async function readAcceptanceRecordDetail(
  input: ReadAcceptanceRecordDetailInput,
): Promise<ReadAcceptanceRecordDetailResult> {
  const parsed = parseReadAcceptanceRecordDetailInput(input);
  const candidate = (await db.select({
    repo: changeRecords.repo,
    prNumber: changeRecords.prNumber,
  }).from(changeRecords).where(and(
    eq(changeRecords.id, parsed.recordId),
    eq(changeRecords.workspaceId, parsed.workspaceId),
  )).limit(1))[0];
  if (!candidate) return { kind: "not_found" };

  return db.transaction(async (tx): Promise<ReadAcceptanceRecordDetailResult> => {
    if (candidate.prNumber !== null && safeRepo(candidate.repo)
      && Number.isSafeInteger(candidate.prNumber) && candidate.prNumber > 0) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${acceptanceRecordPullRequestLockKey({
        workspaceId: parsed.workspaceId,
        recordId: parsed.recordId,
        repo: candidate.repo,
        prNumber: candidate.prNumber,
      })}))`);
    } else {
      // An unattached Record has no PR advisory-key coordinate yet. A row
      // share lock keeps an attach transaction from changing that coordinate
      // midway through this detail read.
      await tx.execute(sql`
        SELECT id FROM change_records
        WHERE id = ${parsed.recordId}::uuid
          AND workspace_id = ${parsed.workspaceId}::uuid
        FOR SHARE
      `);
    }
    const record = (await tx.select().from(changeRecords).where(and(
      eq(changeRecords.id, parsed.recordId),
      eq(changeRecords.workspaceId, parsed.workspaceId),
    )).limit(1))[0];
    if (!record) return { kind: "not_found" };
    if (record.repo !== candidate.repo || record.prNumber !== candidate.prNumber
      || !acceptanceRecordDetailRecordCustodyValid(record)) {
      return { kind: "unavailable", reason: "invalid_record_custody" };
    }

    const summaryResult = await readAcceptanceRecordSummariesInTransaction(tx, {
      workspaceId: parsed.workspaceId,
      repo: null,
      limit: 1,
      recordId: parsed.recordId,
    });
    const summary = summaryResult.records[0];
    if (summaryResult.records.length !== 1 || !summary
      || summary.recordId !== record.id || summary.workspaceId !== record.workspaceId
      || summary.repo !== record.repo) {
      return { kind: "unavailable", reason: "invalid_record_custody" };
    }

    const confirmedRows = await tx.select().from(acceptanceContracts).where(and(
      eq(acceptanceContracts.recordId, record.id),
      eq(acceptanceContracts.status, "confirmed"),
    )).orderBy(asc(acceptanceContracts.version));
    const confirmed = acceptanceRecordSummaryConfirmedContract(confirmedRows);
    if (!confirmed || confirmed === "invalid"
      || !safeSnapshotText(confirmed.row.confirmedBy, 512)
      || !(confirmed.row.confirmedAt instanceof Date)
      || Number.isNaN(confirmed.row.confirmedAt.valueOf())) {
      return { kind: "unavailable", reason: "confirmed_contract_unavailable" };
    }
    const contract: AcceptanceRecordDetailContract = {
      identity: { ...confirmed.identity },
      confirmedBy: confirmed.row.confirmedBy,
      confirmedAt: confirmed.row.confirmedAt,
      contract: structuredClone(confirmed.projection),
    };

    const rawEvents = Array.from(await tx.execute(sql`
      SELECT *
      FROM change_record_events AS events
      WHERE events.record_id = ${record.id}::uuid
        AND (
          events.event_key LIKE 'review:github-posted:%'
          OR events.event_key LIKE 'review:correction:%'
          OR events.event_key LIKE 'external-pr:attached:%'
          OR events.event_key LIKE 'external-pr:head-advanced:%'
          OR events.event_key LIKE 'external-pr:head-reconciled:%'
          OR events.event_key LIKE 'acceptance-pr-decision:%'
          OR events.event_key LIKE 'acceptance-pr:signed-merge:%'
          OR events.event_key LIKE 'external-pr:signed-merge:%'
          OR events.event_key LIKE 'acceptance-post-merge:%'
          OR events.stage = ${REVIEW_JOB_POSTED_ATTESTATION_STAGE}
          OR events.stage = ${ACCEPTANCE_PR_DECISION_STAGE}
          OR events.stage = ${SIGNED_ACCEPTANCE_RECORD_MERGE_STAGE}
          OR events.stage = 'post_merge_outcome'
          OR events.payload_ref->>'kind' = ${REVIEW_JOB_POSTED_ATTESTATION_KIND}
          OR events.payload_ref->>'kind' = 'review_job_correction_packet'
          OR events.payload_ref->>'kind' = 'external_pr_attachment'
          OR events.payload_ref->>'kind' = 'external_pr_head_advanced'
          OR events.payload_ref->>'kind' = 'external_pr_head_reconciled'
          OR events.payload_ref->>'kind' = ${ACCEPTANCE_PR_DECISION_KIND}
          OR events.payload_ref->>'kind' = ${SIGNED_ACCEPTANCE_RECORD_MERGE_KIND}
          OR events.payload_ref->>'kind' = ${SIGNED_ACCEPTANCE_RECORD_MERGE_DELIVERY_KIND}
          OR events.payload_ref->>'kind' = 'acceptance_post_merge_outcome'
        )
      ORDER BY events.at ASC, events.id ASC
      LIMIT ${ACCEPTANCE_RECORD_DETAIL_EVENT_LIMIT + 1}
    `)) as Array<Record<string, unknown>>;
    if (rawEvents.length > ACCEPTANCE_RECORD_DETAIL_EVENT_LIMIT) {
      return { kind: "unavailable", reason: "event_custody_limit" };
    }
    const events = rawEvents.map(mapChangeRecordEventRow);

    const rawSnapshots = Array.from(await tx.execute(sql`
      SELECT *
      FROM acceptance_context_pack_snapshots AS snapshots
      WHERE snapshots.workspace_id = ${record.workspaceId}::uuid
        AND snapshots.record_id = ${record.id}::uuid
      ORDER BY snapshots.created_at ASC, snapshots.id ASC
      LIMIT ${ACCEPTANCE_RECORD_DETAIL_SNAPSHOT_LIMIT + 1}
    `)) as Array<Record<string, unknown>>;
    if (rawSnapshots.length > ACCEPTANCE_RECORD_DETAIL_SNAPSHOT_LIMIT) {
      return { kind: "unavailable", reason: "snapshot_custody_limit" };
    }
    const snapshots = rawSnapshots.map(mapAcceptanceRecordSummarySnapshotRow);
    for (const snapshot of snapshots) {
      const snapshotInput = acceptanceRecordSummarySnapshotInput(snapshot);
      if (!validateAcceptanceContextPackSnapshotInput(snapshotInput)
        || snapshot.id !== acceptanceContextPackSnapshotId(snapshotInput)
        || snapshot.workspaceId !== record.workspaceId
        || snapshot.recordId !== record.id
        || snapshot.acceptanceContractId !== confirmed.identity.id
        || snapshot.acceptanceContractVersion !== confirmed.identity.version
        || snapshot.acceptanceContractSha256 !== confirmed.identity.sha256
        || snapshot.repo !== record.repo || snapshot.prNumber !== record.prNumber
        || !(snapshot.createdAt instanceof Date) || Number.isNaN(snapshot.createdAt.valueOf())
        || !(snapshot.updatedAt instanceof Date) || Number.isNaN(snapshot.updatedAt.valueOf())) {
        return { kind: "unavailable", reason: "invalid_context_custody" };
      }
    }

    const occurrenceSeeds = new Map<string, AcceptanceRecordDetailOccurrenceSeed>();
    const addOccurrenceSeed = (
      headCycleId: unknown,
      headSha: unknown,
      requiresReviewJob: boolean,
    ): boolean => {
      if (!isUuid(headCycleId) || typeof headSha !== "string" || !EXACT_SHA1.test(headSha)) return false;
      const seed = occurrenceSeeds.get(headCycleId) ?? {
        headShas: new Set<string>(),
        requiresReviewJob: false,
      };
      seed.headShas.add(headSha.toLowerCase());
      seed.requiresReviewJob ||= requiresReviewJob;
      occurrenceSeeds.set(headCycleId, seed);
      return true;
    };

    let summaryFocus: AcceptanceRecordSummaryHeadOccurrence | null = null;
    if (summary.pullRequest.kind === "attached" && summary.pullRequest.head.kind !== "unknown") {
      summaryFocus = summary.pullRequest.head;
      if (!addOccurrenceSeed(summaryFocus.headCycleId, summaryFocus.sha, summaryFocus.kind === "merged")) {
        return { kind: "unavailable", reason: "invalid_occurrence_custody" };
      }
    }
    if (record.currentPrHeadAuthoritative
      && (!summaryFocus || summaryFocus.kind !== "current"
        || summaryFocus.headCycleId !== record.currentPrHeadCycleId
        || summaryFocus.sha !== record.currentPrHeadSha?.toLowerCase()
        || summaryFocus.authorityGeneration !== record.currentPrHeadAuthorityGeneration)) {
      return { kind: "unavailable", reason: "invalid_occurrence_custody" };
    }
    if ((record.state === "merged" || record.state === "reverted")
      && (!summaryFocus || summaryFocus.kind !== "merged")) {
      return { kind: "unavailable", reason: "invalid_occurrence_custody" };
    }

    for (const snapshot of snapshots) {
      if (!addOccurrenceSeed(snapshot.reviewJobId, snapshot.expectedHeadSha, true)) {
        return { kind: "unavailable", reason: "invalid_occurrence_custody" };
      }
    }

    const postedEventsByCycle = new Map<string, ChangeRecordEventRow[]>();
    const correctionPacketsByCycle = new Map<
      string,
      Map<string, AcceptanceRecordDetailCorrectionPacket>
    >();
    const contractCriteria = new Map(confirmed.projection.acceptanceCriteria.map((criterion) => [
      criterion.id,
      criterion.text,
    ]));
    for (const event of events) {
      const payload = event.payloadRef;
      const authorityLike = event.eventKey.startsWith("external-pr:attached:")
        || event.eventKey.startsWith("external-pr:head-advanced:")
        || event.eventKey.startsWith("external-pr:head-reconciled:")
        || payload["kind"] === "external_pr_attachment"
        || payload["kind"] === "external_pr_head_advanced"
        || payload["kind"] === "external_pr_head_reconciled";
      if (authorityLike) {
        const occurrence = acceptanceRecordDetailAuthorityOccurrence({
          event,
          record,
          acceptanceContractVersion: confirmed.identity.version,
        });
        if (occurrence === "audit_only") continue;
        if (!occurrence || occurrence === "invalid"
          || !addOccurrenceSeed(
            occurrence.headCycleId,
            occurrence.headSha,
            occurrence.requiresReviewJob,
          )) {
          return { kind: "unavailable", reason: "invalid_occurrence_custody" };
        }
      }
      const postedLike = event.eventKey.startsWith("review:github-posted:")
        || event.stage === REVIEW_JOB_POSTED_ATTESTATION_STAGE
          && payload["kind"] === REVIEW_JOB_POSTED_ATTESTATION_KIND
        || payload["kind"] === REVIEW_JOB_POSTED_ATTESTATION_KIND;
      if (postedLike) {
        if (!postedReviewAttestationShape(payload)
          || !isUuid(payload["jobId"]) || !EXACT_SHA1.test(payload["headSha"] as string)
          || payload["workspaceId"] !== record.workspaceId
          || payload["recordId"] !== record.id || payload["repo"] !== record.repo
          || payload["prNumber"] !== record.prNumber
          || payload["acceptanceContractId"] !== confirmed.identity.id
          || payload["acceptanceContractVersion"] !== confirmed.identity.version
          || event.eventKey !== reviewJobPostedAttestationEventKey(payload["jobId"] as string)
          || event.id !== changeRecordEventId({
            recordId: record.id,
            eventKey: reviewJobPostedAttestationEventKey(payload["jobId"] as string),
          })
          || event.stage !== REVIEW_JOB_POSTED_ATTESTATION_STAGE
          || event.actor !== REVIEW_JOB_POSTED_ATTESTATION_ACTOR
          || !isCanonicalGithubReviewUrl(payload["postedReviewUrl"], record.repo, record.prNumber!)) {
          return { kind: "unavailable", reason: "invalid_review_custody" };
        }
        const cycleId = payload["jobId"] as string;
        if (!addOccurrenceSeed(cycleId, payload["headSha"], true)) {
          return { kind: "unavailable", reason: "invalid_occurrence_custody" };
        }
        const rows = postedEventsByCycle.get(cycleId) ?? [];
        rows.push(event);
        postedEventsByCycle.set(cycleId, rows);
      }

      const correctionLike = event.eventKey.startsWith("review:correction:")
        || payload["kind"] === "review_job_correction_packet";
      if (correctionLike) {
        if (!validateReviewJobCorrectionPacketPayload(payload)
          || !isRecord(payload["criterion"]) || !isRecord(payload["acceptanceContract"])) {
          return { kind: "unavailable", reason: "invalid_review_custody" };
        }
        const packetId = correctionPacketIdForSnapshotEvent(event, {
          workspaceId: record.workspaceId,
          recordId: record.id,
          reviewJobId: payload["jobId"] as string,
          acceptanceContractId: confirmed.identity.id,
          acceptanceContractVersion: confirmed.identity.version,
          repo: record.repo,
          prNumber: record.prNumber!,
          expectedHeadSha: payload["headSha"] as string,
        }, contractCriteria);
        const cycleId = payload["jobId"] as string;
        const criterionId = payload["criterion"]["id"] as string;
        if (!packetId || payload["packetId"] !== packetId
          || payload["acceptanceContract"]["id"] !== confirmed.identity.id
          || payload["acceptanceContract"]["version"] !== confirmed.identity.version
          || !addOccurrenceSeed(cycleId, payload["headSha"], true)) {
          return { kind: "unavailable", reason: "invalid_review_custody" };
        }
        const packets = correctionPacketsByCycle.get(cycleId) ?? new Map();
        if (packets.has(criterionId)) {
          return { kind: "unavailable", reason: "invalid_review_custody" };
        }
        packets.set(
          criterionId,
          structuredClone(payload) as AcceptanceRecordDetailCorrectionPacket,
        );
        correctionPacketsByCycle.set(cycleId, packets);
      }
    }
    if (occurrenceSeeds.size > ACCEPTANCE_RECORD_DETAIL_OCCURRENCE_LIMIT) {
      return { kind: "unavailable", reason: "invalid_occurrence_custody" };
    }

    const occurrenceCycleIds = [...occurrenceSeeds.keys()];
    const jobs = occurrenceCycleIds.length === 0 ? [] : await tx.select().from(reviewJobs).where(and(
      eq(reviewJobs.workspaceId, record.workspaceId),
      inArray(reviewJobs.id, occurrenceCycleIds),
    ));
    const jobsById = new Map(jobs.map((job) => [job.id, job]));

    let storedMerge: AcceptanceRecordSummaryStoredMerge | null = null;
    if (summaryFocus?.kind === "merged") {
      const merge = acceptanceRecordSummaryMergeBeforeLineage(record, events);
      if (!merge || merge === "invalid" || !acceptanceRecordSummaryMergeLineageValid({
        merge,
        record,
        contract: confirmed,
        events,
        jobsById,
      })) return { kind: "unavailable", reason: "invalid_occurrence_custody" };
      storedMerge = merge;
    }

    const occurrences: AcceptanceRecordDetailOccurrence[] = [];
    for (const [headCycleId, seed] of occurrenceSeeds) {
      if (seed.headShas.size !== 1) {
        return { kind: "unavailable", reason: "invalid_occurrence_custody" };
      }
      const headSha = [...seed.headShas][0]!;
      const job = jobsById.get(headCycleId);
      const reviewJob = acceptanceRecordDetailReviewJob(job);
      if (!reviewJob || (seed.requiresReviewJob && reviewJob.kind !== "recorded")
        || (job && (job.workspaceId !== record.workspaceId || job.repo !== record.repo
          || job.prNumber !== record.prNumber || job.headSha.toLowerCase() !== headSha))) {
        return { kind: "unavailable", reason: "invalid_occurrence_custody" };
      }
      if (summaryFocus?.kind === "current" && summaryFocus.headCycleId === headCycleId) {
        if (summaryFocus.sha !== headSha) {
          return { kind: "unavailable", reason: "invalid_occurrence_custody" };
        }
        occurrences.push({
          kind: "current",
          repo: record.repo,
          prNumber: record.prNumber!,
          headSha,
          headCycleId,
          authorityGeneration: summaryFocus.authorityGeneration,
          reviewJob,
        });
      } else if (summaryFocus?.kind === "merged" && summaryFocus.headCycleId === headCycleId) {
        if (summaryFocus.sha !== headSha || !storedMerge
          || storedMerge.payload.mergeSha !== record.mergedSha) {
          return { kind: "unavailable", reason: "invalid_occurrence_custody" };
        }
        occurrences.push({
          kind: "merged",
          repo: record.repo,
          prNumber: record.prNumber!,
          headSha,
          headCycleId,
          authorityGeneration: summaryFocus.authorityGeneration,
          mergeEventId: storedMerge.event.id,
          mergeSha: storedMerge.payload.mergeSha,
          mergedAt: new Date(storedMerge.payload.mergedAt),
          reviewJob,
        });
      } else {
        occurrences.push({
          kind: "historical",
          repo: record.repo,
          prNumber: record.prNumber!,
          headSha,
          headCycleId,
          reviewJob,
        });
      }
    }
    occurrences.sort((left, right) => {
      const rank = acceptanceRecordDetailOccurrenceRank(left.kind)
        - acceptanceRecordDetailOccurrenceRank(right.kind);
      if (rank !== 0) return rank;
      const leftAt = left.reviewJob.kind === "recorded" ? left.reviewJob.createdAt.valueOf() : 0;
      const rightAt = right.reviewJob.kind === "recorded" ? right.reviewJob.createdAt.valueOf() : 0;
      return rightAt - leftAt || left.headCycleId.localeCompare(right.headCycleId);
    });
    const occurrenceByCycle = new Map(occurrences.map((occurrence) => [
      occurrence.headCycleId,
      occurrence,
    ]));
    const current = occurrences.find((occurrence) => occurrence.kind === "current") as AcceptanceRecordDetailCurrentOccurrence | undefined;
    const merged = occurrences.find((occurrence) => occurrence.kind === "merged") as AcceptanceRecordDetailMergedOccurrence | undefined;
    if (occurrences.filter((occurrence) => occurrence.kind === "current").length > 1
      || occurrences.filter((occurrence) => occurrence.kind === "merged").length > 1) {
      return { kind: "unavailable", reason: "invalid_occurrence_custody" };
    }
    let pullRequest: AcceptanceRecordDetailPullRequest;
    if (record.prNumber === null) {
      if (occurrences.length !== 0) {
        return { kind: "unavailable", reason: "invalid_occurrence_custody" };
      }
      pullRequest = { kind: "not_attached", occurrences: [] };
    } else {
      pullRequest = {
        kind: "attached",
        prNumber: record.prNumber,
        current: current ?? null,
        merged: merged ?? null,
        occurrences,
      };
    }

    const wikiPageIds = new Set<string>();
    for (const snapshot of snapshots) {
      const snapshotInput = acceptanceRecordSummarySnapshotInput(snapshot);
      if (snapshotInput.status === "admitted" && snapshotInput.baseIndex) {
        for (const page of snapshotInput.baseIndex.pages) wikiPageIds.add(page.id);
      }
    }
    const repositoryRows = record.prNumber === null ? [] : await tx.select().from(repositories).where(and(
      eq(repositories.workspaceId, record.workspaceId),
      eq(repositories.name, record.repo),
    )).orderBy(asc(repositories.createdAt), asc(repositories.id));
    const wikiRows = wikiPageIds.size === 0 ? [] : await tx.select().from(wikiPages).where(and(
      eq(wikiPages.workspaceId, record.workspaceId),
      inArray(wikiPages.id, [...wikiPageIds]),
    ));
    const wikiPagesById = new Map(wikiRows.map((page) => [page.id, page]));

    const snapshotIds = snapshots.map((snapshot) => snapshot.id);
    const rawPacks = snapshotIds.length === 0 ? [] : Array.from(await tx.execute(sql`
      SELECT packs.*
      FROM acceptance_compiled_context_packs AS packs
      WHERE packs.source_snapshot_id IN (${sql.join(
        snapshotIds.map((snapshotId) => sql`${snapshotId}::uuid`),
        sql`, `,
      )})
      ORDER BY packs.source_snapshot_id ASC, packs.created_at ASC, packs.id ASC
      LIMIT ${ACCEPTANCE_RECORD_DETAIL_COMPILED_PACK_LIMIT + 1}
    `)) as Array<Record<string, unknown>>;
    if (rawPacks.length > ACCEPTANCE_RECORD_DETAIL_COMPILED_PACK_LIMIT) {
      return { kind: "unavailable", reason: "detail_output_limit" };
    }
    const packsBySnapshot = new Map<string, AcceptanceCompiledContextPackRow[]>();
    for (const rawPack of rawPacks) {
      const pack = mapAcceptanceRecordSummaryCompiledPackRow(rawPack);
      const rows = packsBySnapshot.get(pack.sourceSnapshotId) ?? [];
      rows.push(pack);
      packsBySnapshot.set(pack.sourceSnapshotId, rows);
    }
    if ([...packsBySnapshot.values()].some((packs) =>
      packs.length > ACCEPTANCE_RECORD_DETAIL_COMPILED_PACKS_PER_SNAPSHOT_LIMIT
    )) return { kind: "unavailable", reason: "compiled_pack_custody_limit" };

    const contextPacks: AcceptanceRecordDetailContextPack[] = [];
    for (const snapshot of snapshots) {
      const occurrence = occurrenceByCycle.get(snapshot.reviewJobId);
      const job = jobsById.get(snapshot.reviewJobId);
      if (!occurrence || !job || occurrence.headSha !== snapshot.expectedHeadSha.toLowerCase()) {
        return { kind: "unavailable", reason: "invalid_occurrence_custody" };
      }
      const custody = acceptanceRecordSummaryContextCustody({
        snapshot,
        record,
        focus: { headSha: occurrence.headSha, headCycleId: occurrence.headCycleId },
        contract: confirmed,
        job,
        events,
        repositoryRows,
        wikiPagesById,
      });
      if (!custody) return { kind: "unavailable", reason: "invalid_context_custody" };
      const storedPacks = packsBySnapshot.get(snapshot.id) ?? [];
      if (snapshot.status === "not_proven" && storedPacks.length !== 0) {
        return { kind: "unavailable", reason: "invalid_compiled_pack_custody" };
      }
      const compiledPacks: AcceptanceRecordDetailCompiledPack[] = [];
      for (const storedPack of storedPacks) {
        const projected = acceptanceRecordDetailCompiledPack({ row: storedPack, custody });
        if (!projected) {
          return { kind: "unavailable", reason: "invalid_compiled_pack_custody" };
        }
        compiledPacks.push(projected);
      }
      contextPacks.push({
        occurrence: acceptanceRecordDetailOccurrenceIdentity(occurrence),
        sourceSnapshot: acceptanceRecordDetailSnapshot(snapshot, occurrence, contract),
        compiledPacks,
      });
    }
    contextPacks.sort((left, right) => {
      const rank = acceptanceRecordDetailOccurrenceRank(left.occurrence.kind)
        - acceptanceRecordDetailOccurrenceRank(right.occurrence.kind);
      return rank || left.sourceSnapshot.createdAt.valueOf() - right.sourceSnapshot.createdAt.valueOf()
        || left.sourceSnapshot.id.localeCompare(right.sourceSnapshot.id);
    });

    const proofMatrix: AcceptanceRecordDetailProofCycle[] = [];
    for (const occurrence of occurrences) {
      const job = jobsById.get(occurrence.headCycleId);
      const postedEvents = postedEventsByCycle.get(occurrence.headCycleId) ?? [];
      let review: AcceptanceRecordDetailReview;
      if (!job) {
        if (postedEvents.length !== 0) {
          return { kind: "unavailable", reason: "invalid_review_custody" };
        }
        review = { kind: "not_recorded" };
      } else if (job.state === "posted") {
        if (postedEvents.length !== 1) {
          return { kind: "unavailable", reason: "invalid_review_custody" };
        }
        const posted = parseAcceptancePrReviewMetricsCycle({
          event: postedEvents[0]!,
          job,
          record,
          acceptanceContract: confirmed.identity,
        });
        if (!posted || posted.binding.headCycleId !== occurrence.headCycleId
          || posted.binding.headSha !== occurrence.headSha
          || job.createdAt > posted.reviewedAt || confirmed.row.confirmedAt! > posted.reviewedAt) {
          return { kind: "unavailable", reason: "invalid_review_custody" };
        }
        review = {
          kind: "posted",
          reviewJobId: job.id,
          verdict: posted.binding.reviewVerdict,
          postedReviewUrl: posted.binding.postedReviewUrl,
          postedAttestationEventId: posted.binding.postedAttestationEventId,
          reviewedAt: posted.reviewedAt,
        };
      } else {
        if (!isAcceptanceRecordDetailReviewJobState(job.state) || postedEvents.length !== 0) {
          return { kind: "unavailable", reason: "invalid_review_custody" };
        }
        review = {
          kind: "not_posted",
          reviewJobId: job.id,
          state: job.state as Exclude<AcceptanceRecordDetailReviewJobState, "posted">,
        };
      }
      const packets = correctionPacketsByCycle.get(occurrence.headCycleId) ?? new Map();
      if (review.kind === "posted"
        && ((review.verdict === "proven" || review.verdict === "not_testable")
          && packets.size !== 0
          || (review.verdict === "failed" || review.verdict === "not_proven")
            && packets.size === 0
          || review.verdict === "not_proven"
            && [...packets.values()].some((packet) => packet.state !== "not_proven")
          || review.verdict === "failed"
            && packets.size > 0
            && ![...packets.values()].some((packet) => packet.state === "failed"))) {
        return { kind: "unavailable", reason: "invalid_review_custody" };
      }
      proofMatrix.push({
        occurrence: acceptanceRecordDetailOccurrenceIdentity(occurrence),
        review,
        criteria: confirmed.projection.acceptanceCriteria.map((criterion) => {
          const packet = packets.get(criterion.id);
          if (packet) {
            return {
              criterion: structuredClone(criterion),
              proof: {
                kind: "correction_packet" as const,
                state: packet.state,
                packet: structuredClone(packet),
              },
            };
          }
          const reason: AcceptanceRecordDetailCriterionUnknownReason = review.kind === "not_recorded"
            ? "review_not_recorded"
            : review.kind === "not_posted"
              ? "review_not_posted"
              : "criterion_result_not_durably_rederivable";
          return {
            criterion: structuredClone(criterion),
            proof: { kind: "unknown" as const, reason },
          };
        }),
      });
    }

    const detail: AcceptanceRecordDetail = {
      summary,
      contract,
      pullRequest,
      contextPacks,
      proofMatrix,
      artifactCustody: {
        kind: "unknown",
        reason: "artifact_custody_not_available",
      },
      gatedIssue: {
        kind: "unknown",
        reason: "gated_issue_custody_not_available",
      },
    };
    if (acceptanceRecordDetailSerializedBytes(detail)
      > ACCEPTANCE_RECORD_DETAIL_MAX_SERIALIZED_BYTES) {
      return { kind: "unavailable", reason: "detail_output_limit" };
    }
    return { kind: "record", detail };
  });
}
