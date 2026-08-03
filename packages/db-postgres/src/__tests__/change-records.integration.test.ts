import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db } from "../db.js";
import { workspaces } from "../schema/workspaces.js";
import { changeRecordEvents } from "../schema/change_records.js";
import {
  appendChangeRecordEvent,
  changeRecordId,
  findOrCreateChangeRecord,
  readChangeRecordTimeline,
} from "../queries/change_records.js";

const DB_AVAILABLE: boolean = await (async () => {
  try {
    const rows = Array.from(
      await db.execute(sql`
        SELECT to_regclass('public.change_records') AS change_records,
               to_regclass('public.change_record_events') AS change_record_events
      `)
    ) as Array<{ change_records: string | null; change_record_events: string | null }>;
    return (
      rows[0]?.change_records === "change_records" &&
      rows[0]?.change_record_events === "change_record_events"
    );
  } catch {
    return false;
  }
})();

describe.skipIf(!DB_AVAILABLE)(
  "change_records queries — real Postgres integration (Arc D storage)",
  () => {
    let wsId: string;

    beforeEach(async () => {
      const rows = await db
        .insert(workspaces)
        .values({
          name: "change-records test workspace",
          slug: `test-change-records-${randomUUID()}`,
        })
        .returning({ id: workspaces.id });
      wsId = rows[0]!.id;
    });

    afterEach(async () => {
      await db.delete(workspaces).where(eq(workspaces.id, wsId));
    });

    it("find-or-create is deterministic and idempotent for an issue anchor", async () => {
      const first = await findOrCreateChangeRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        issueNumber: 123,
        headShas: ["sha-b", "sha-a", "sha-a"],
      });
      expect(first.id).toBe(
        changeRecordId({
          workspaceId: wsId,
          repo: "acme/widgets",
          issueNumber: 123,
        })
      );
      expect(first.issueNumber).toBe(123);
      expect(first.prNumber).toBeNull();
      expect(first.headShas).toEqual(["sha-a", "sha-b"]);

      const second = await findOrCreateChangeRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        issueNumber: 123,
        headShas: ["sha-c"],
      });
      expect(second.id).toBe(first.id);
      expect(second.headShas).toEqual(["sha-a", "sha-b", "sha-c"]);
    });

    it("unifies issue-only and PR-only records, moving PR events to the issue record", async () => {
      const issueRecord = await findOrCreateChangeRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        issueNumber: 77,
      });
      const prRecord = await findOrCreateChangeRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        prNumber: 456,
      });
      expect(prRecord.id).not.toBe(issueRecord.id);

      await appendChangeRecordEvent({
        recordId: prRecord.id,
        eventKey: "review:456:sha-1",
        stage: "review",
        actor: "reviewer-of-record",
        payloadRef: { kind: "review", prNumber: 456, headSha: "sha-1" },
        at: new Date("2026-08-03T10:00:00.000Z"),
      });

      const unified = await findOrCreateChangeRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        issueNumber: 77,
        prNumber: 456,
        headShas: ["sha-1"],
      });
      expect(unified.id).toBe(issueRecord.id);
      expect(unified.prNumber).toBe(456);
      expect(unified.headShas).toEqual(["sha-1"]);

      const timeline = await readChangeRecordTimeline({
        workspaceId: wsId,
        recordId: unified.id,
      });
      expect(timeline?.events.map((e) => e.eventKey)).toEqual([
        "review:456:sha-1",
      ]);

      const oldEvents = await db
        .select()
        .from(changeRecordEvents)
        .where(eq(changeRecordEvents.recordId, prRecord.id));
      expect(oldEvents).toHaveLength(0);
    });

    it("appendChangeRecordEvent is append-only and idempotent by eventKey", async () => {
      const record = await findOrCreateChangeRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        prNumber: 9,
      });
      const first = await appendChangeRecordEvent({
        recordId: record.id,
        eventKey: "ac-proof:run-1",
        stage: "verification",
        actor: "arc-c",
        payloadRef: { artifact: "ac_evidence.json", runId: "run-1" },
      });
      const second = await appendChangeRecordEvent({
        recordId: record.id,
        eventKey: "ac-proof:run-1",
        stage: "verification",
        actor: "arc-c",
        payloadRef: { artifact: "different.json", runId: "run-1" },
      });

      expect(first.inserted).toBe(true);
      expect(second.inserted).toBe(false);
      expect(second.event.id).toBe(first.event.id);
      expect(second.event.payloadRef).toEqual({
        artifact: "ac_evidence.json",
        runId: "run-1",
      });
    });

    it("reads timelines scoped by workspace and ordered by event time", async () => {
      const record = await findOrCreateChangeRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        issueNumber: 88,
        prNumber: 12,
      });
      await appendChangeRecordEvent({
        recordId: record.id,
        eventKey: "later",
        stage: "review",
        actor: "reviewer",
        payloadRef: { kind: "review" },
        at: new Date("2026-08-03T12:00:00.000Z"),
      });
      await appendChangeRecordEvent({
        recordId: record.id,
        eventKey: "earlier",
        stage: "planning",
        actor: "jace",
        payloadRef: { kind: "issue" },
        at: new Date("2026-08-03T09:00:00.000Z"),
      });

      const timeline = await readChangeRecordTimeline({
        workspaceId: wsId,
        recordId: record.id,
      });
      expect(timeline?.record.id).toBe(record.id);
      expect(timeline?.events.map((e) => e.eventKey)).toEqual([
        "earlier",
        "later",
      ]);

      const otherWorkspace = await db
        .insert(workspaces)
        .values({
          name: "other workspace",
          slug: `other-change-records-${randomUUID()}`,
        })
        .returning({ id: workspaces.id });
      try {
        await expect(
          readChangeRecordTimeline({
            workspaceId: otherWorkspace[0]!.id,
            recordId: record.id,
          })
        ).resolves.toBeNull();
      } finally {
        await db
          .delete(workspaces)
          .where(eq(workspaces.id, otherWorkspace[0]!.id));
      }
    });
  }
);
