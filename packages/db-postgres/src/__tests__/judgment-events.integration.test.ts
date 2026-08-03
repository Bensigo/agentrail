import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db } from "../db.js";
import { workspaces } from "../schema/workspaces.js";
import {
  appendJudgmentEvent,
  judgmentEventId,
  listJudgmentEvents,
} from "../queries/judgment_events.js";

const DB_AVAILABLE: boolean = await (async () => {
  try {
    const rows = Array.from(
      await db.execute(sql`
        SELECT to_regclass('public.judgment_events') AS judgment_events
      `)
    ) as Array<{ judgment_events: string | null }>;
    return rows[0]?.judgment_events === "judgment_events";
  } catch {
    return false;
  }
})();

describe.skipIf(!DB_AVAILABLE)(
  "judgment_events queries — real Postgres integration (Arc E storage)",
  () => {
    let wsId: string;

    beforeEach(async () => {
      const rows = await db
        .insert(workspaces)
        .values({
          name: "judgment-events test workspace",
          slug: `test-judgment-events-${randomUUID()}`,
        })
        .returning({ id: workspaces.id });
      wsId = rows[0]!.id;
    });

    afterEach(async () => {
      await db.delete(workspaces).where(eq(workspaces.id, wsId));
    });

    it("appendJudgmentEvent is deterministic and idempotent by workspace/repo/eventKey", async () => {
      const input = {
        workspaceId: wsId,
        repo: "acme/widgets",
        eventKey: "review-outcome:finding-1:dismissed",
        type: "review_outcome" as const,
        refs: { findingId: "finding-1", changeRecordId: randomUUID() },
        payload: { disposition: "dismissed", reason: "not a bug" },
        actorRef: { kind: "user", id: "user-1" },
        sourceRef: { kind: "console_review", id: "review-1" },
        occurredAt: new Date("2026-08-03T09:00:00.000Z"),
      };
      const first = await appendJudgmentEvent(input);
      const second = await appendJudgmentEvent({
        ...input,
        payload: { disposition: "accepted" },
      });

      expect(first.inserted).toBe(true);
      expect(first.event.id).toBe(judgmentEventId(input));
      expect(second.inserted).toBe(false);
      expect(second.event.id).toBe(first.event.id);
      expect(second.event.payload).toEqual({
        disposition: "dismissed",
        reason: "not a bug",
      });
    });

    it("reads only the requested workspace/repo and can filter by type", async () => {
      await appendJudgmentEvent({
        workspaceId: wsId,
        repo: "acme/widgets",
        eventKey: "later",
        type: "missed_check",
        refs: { runId: "run-1" },
        payload: { check: "migration rollback" },
        actorRef: { kind: "user", id: "user-1" },
        sourceRef: { kind: "incident", id: "incident-1" },
        occurredAt: new Date("2026-08-03T12:00:00.000Z"),
      });
      await appendJudgmentEvent({
        workspaceId: wsId,
        repo: "acme/widgets",
        eventKey: "earlier",
        type: "rejected_approach",
        refs: { acId: "ac-1" },
        payload: { approach: "rewrite the service", reason: "too broad" },
        actorRef: { kind: "user", id: "user-1" },
        sourceRef: { kind: "chat", id: "message-1" },
        occurredAt: new Date("2026-08-03T09:00:00.000Z"),
      });
      await appendJudgmentEvent({
        workspaceId: wsId,
        repo: "acme/other",
        eventKey: "other-repo",
        type: "rejected_approach",
        refs: {},
        payload: { approach: "unrelated" },
        actorRef: { kind: "user", id: "user-1" },
        sourceRef: { kind: "chat", id: "message-2" },
      });

      const all = await listJudgmentEvents({
        workspaceId: wsId,
        repo: "acme/widgets",
      });
      expect(all.map((event) => event.eventKey)).toEqual(["earlier", "later"]);

      const rejected = await listJudgmentEvents({
        workspaceId: wsId,
        repo: "acme/widgets",
        type: "rejected_approach",
      });
      expect(rejected.map((event) => event.eventKey)).toEqual(["earlier"]);

      const otherWorkspace = await db
        .insert(workspaces)
        .values({
          name: "other judgment workspace",
          slug: `other-judgment-events-${randomUUID()}`,
        })
        .returning({ id: workspaces.id });
      try {
        const leaked = await listJudgmentEvents({
          workspaceId: otherWorkspace[0]!.id,
          repo: "acme/widgets",
        });
        expect(leaked).toEqual([]);
      } finally {
        await db
          .delete(workspaces)
          .where(eq(workspaces.id, otherWorkspace[0]!.id));
      }
    });
  }
);
