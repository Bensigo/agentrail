import { createHash, randomUUID } from "crypto";
import { isDeepStrictEqual } from "util";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  changeRecordEvents,
  changeRecords,
  acceptanceBuilderRouteCapabilityProfiles,
  acceptanceBuilderRoutes,
  acceptanceCompiledContextPacks,
  acceptanceCorrectionDispatches,
  acceptanceCorrectionDispatchGithubPreflights,
  acceptanceCorrectionDispatchGithubFindingPublications,
  acceptanceCorrectionDispatchGithubActivations,
  acceptanceContextPackSnapshots,
  acceptanceContracts,
  acceptanceIntakes,
  acceptanceIntakeMessages,
  type AcceptanceContractRow,
  type AcceptanceBuilderRouteCapabilityProfileRow,
  type AcceptanceBuilderRouteRow,
  type AcceptanceCompiledContextPackRow,
  type AcceptanceCorrectionDispatchRow,
  type AcceptanceCorrectionDispatchGithubPreflightRow,
  type AcceptanceCorrectionDispatchGithubFindingPublicationRow,
  type AcceptanceCorrectionDispatchGithubActivationRow,
  type AcceptanceContextPackSnapshotRow,
  type AcceptanceIntakeMessageRow,
  type AcceptanceIntakeRow,
  type ChangeRecordEventRow,
  type ChangeRecordRow,
} from "../schema/change_records.js";
import { workspaces } from "../schema/workspaces.js";
import { reviewJobs } from "../schema/review_jobs.js";
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
