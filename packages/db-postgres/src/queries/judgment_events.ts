import { createHash } from "crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  JUDGMENT_EVENT_TYPES,
  judgmentEvents,
  type JudgmentEventRef,
  type JudgmentEventRefs,
  type JudgmentEventRow,
  type JudgmentEventType,
} from "../schema/judgment_events.js";

const NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
const judgmentEventTypes = new Set<string>(JUDGMENT_EVENT_TYPES);

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

function assertJudgmentEventType(type: string): asserts type is JudgmentEventType {
  if (!judgmentEventTypes.has(type)) {
    throw new Error(`Unsupported judgment event type: ${type}`);
  }
}

function mapJudgmentEventRow(row: Record<string, unknown>): JudgmentEventRow {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    repo: row.repo as string,
    eventKey: row.event_key as string,
    type: row.type as JudgmentEventType,
    refs: row.refs as JudgmentEventRefs,
    payload: row.payload as Record<string, unknown>,
    actorRef: row.actor_ref as JudgmentEventRef,
    sourceRef: row.source_ref as JudgmentEventRef,
    occurredAt: toDate(row.occurred_at),
    createdAt: toDate(row.created_at),
  };
}

export function judgmentEventId(input: {
  workspaceId: string;
  repo: string;
  eventKey: string;
}): string {
  return uuid5Url(
    `judgment-event:${input.workspaceId}:${input.repo}:${input.eventKey}`
  );
}

export type AppendJudgmentEventInput = {
  workspaceId: string;
  repo: string;
  eventKey: string;
  type: JudgmentEventType;
  refs: JudgmentEventRefs;
  payload: Record<string, unknown>;
  actorRef: JudgmentEventRef;
  sourceRef: JudgmentEventRef;
  occurredAt?: Date;
};

export async function appendJudgmentEvent(
  input: AppendJudgmentEventInput
): Promise<{ event: JudgmentEventRow; inserted: boolean }> {
  assertJudgmentEventType(input.type);

  const id = judgmentEventId(input);
  const refsJson = JSON.stringify(input.refs);
  const payloadJson = JSON.stringify(input.payload);
  const actorRefJson = JSON.stringify(input.actorRef);
  const sourceRefJson = JSON.stringify(input.sourceRef);

  const inserted = Array.from(
    await db.execute(sql`
      INSERT INTO judgment_events (
        id, workspace_id, repo, event_key, type, refs, payload, actor_ref,
        source_ref, occurred_at
      )
      VALUES (
        ${id},
        ${input.workspaceId},
        ${input.repo},
        ${input.eventKey},
        ${input.type},
        ${refsJson}::jsonb,
        ${payloadJson}::jsonb,
        ${actorRefJson}::jsonb,
        ${sourceRefJson}::jsonb,
        ${input.occurredAt ?? new Date()}
      )
      ON CONFLICT (workspace_id, repo, event_key) DO NOTHING
      RETURNING *
    `)
  ) as Array<Record<string, unknown>>;

  const raw =
    inserted[0] ??
    (
      await db
        .select()
        .from(judgmentEvents)
        .where(
          and(
            eq(judgmentEvents.workspaceId, input.workspaceId),
            eq(judgmentEvents.repo, input.repo),
            eq(judgmentEvents.eventKey, input.eventKey)
          )
        )
        .limit(1)
    )[0];
  if (!raw) {
    throw new Error("appendJudgmentEvent: event was not inserted or found");
  }

  return {
    event:
      inserted[0] != null
        ? mapJudgmentEventRow(inserted[0])
        : (raw as JudgmentEventRow),
    inserted: inserted[0] != null,
  };
}

export type ListJudgmentEventsInput = {
  workspaceId: string;
  repo: string;
  type?: JudgmentEventType;
  limit?: number;
  order?: "asc" | "desc";
};

export async function listJudgmentEvents(
  input: ListJudgmentEventsInput
): Promise<JudgmentEventRow[]> {
  if (input.type != null) {
    assertJudgmentEventType(input.type);
  }

  const predicates = [
    eq(judgmentEvents.workspaceId, input.workspaceId),
    eq(judgmentEvents.repo, input.repo),
  ];
  if (input.type != null) {
    predicates.push(eq(judgmentEvents.type, input.type));
  }

  return db
    .select()
    .from(judgmentEvents)
    .where(and(...predicates))
    .orderBy(
      input.order === "desc"
        ? desc(judgmentEvents.occurredAt)
        : asc(judgmentEvents.occurredAt),
      input.order === "desc"
        ? desc(judgmentEvents.createdAt)
        : asc(judgmentEvents.createdAt)
    )
    .limit(input.limit ?? 100);
}
