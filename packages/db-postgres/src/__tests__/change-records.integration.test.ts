import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db } from "../db.js";
import { workspaces } from "../schema/workspaces.js";
import { briefs } from "../schema/briefs.js";
import { changeRecordEvents } from "../schema/change_records.js";
import {
  appendChangeRecordEvent,
  changeRecordId,
  confirmAcceptanceContract,
  createDraftAcceptanceContract,
  createDraftAcceptanceRecord,
  findOrCreateChangeRecord,
  linkAcceptanceBriefToRecord,
  readAcceptanceContracts,
  readAcceptanceBriefBinding,
  readChangeRecordTimeline,
} from "../queries/change_records.js";

const DB_AVAILABLE: boolean = await (async () => {
  try {
    const rows = Array.from(
      await db.execute(sql`
        SELECT to_regclass('public.change_records') AS change_records,
               to_regclass('public.change_record_events') AS change_record_events,
               to_regclass('public.acceptance_contracts') AS acceptance_contracts,
               to_regclass('public.acceptance_brief_bindings') AS acceptance_brief_bindings
      `)
    ) as Array<{
      change_records: string | null;
      change_record_events: string | null;
      acceptance_contracts: string | null;
      acceptance_brief_bindings: string | null;
    }>;
    return (
      rows[0]?.change_records === "change_records" &&
      rows[0]?.change_record_events === "change_record_events" &&
      rows[0]?.acceptance_contracts === "acceptance_contracts" &&
      rows[0]?.acceptance_brief_bindings === "acceptance_brief_bindings"
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

    it("creates a retry-safe manual Acceptance Record and confirms one immutable contract version", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        workKey: "manual-trust-loop-1",
        originChannel: "codex_mcp",
        sourceReferences: [{ kind: "codex_thread", id: "thread-1" }],
        contract: {
          originalRequest: "Add a red save button",
          acceptanceCriteria: [{ id: "AC-1", text: "Save button is red" }],
          unresolvedQuestions: [],
        },
        createdBy: "user:lead",
      });
      expect(draft.record.issueNumber).toBeNull();
      expect(draft.record.prNumber).toBeNull();
      expect(draft.record.workKey).toBe("manual-trust-loop-1");
      expect(draft.record.originChannel).toBe("codex_mcp");
      expect(draft.contract.version).toBe(1);
      expect(draft.contract.status).toBe("draft");

      const retried = await createDraftAcceptanceRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        workKey: "manual-trust-loop-1",
        originChannel: "codex_mcp",
        contract: { originalRequest: "This retry must not replace the draft" },
        createdBy: "user:lead",
      });
      expect(retried.record.id).toBe(draft.record.id);
      expect(retried.contract.id).toBe(draft.contract.id);
      expect(retried.contract.contract).toEqual(draft.contract.contract);

      const secondDraft = await createDraftAcceptanceContract({
        recordId: draft.record.id,
        contract: {
          originalRequest: "Add a red save button",
          acceptanceCriteria: [{ id: "AC-1", text: "Save button is red" }],
          openQuestions: [{ id: "Q-1", text: "Which theme token?", status: "open" }],
        },
        createdBy: "user:lead",
      });
      expect(secondDraft.version).toBe(2);
      await expect(confirmAcceptanceContract({
        workspaceId: wsId,
        recordId: draft.record.id,
        version: secondDraft.version,
        confirmedBy: "user:lead",
      })).rejects.toThrow("open questions remain");

      const resolvedDraft = await createDraftAcceptanceContract({
        recordId: draft.record.id,
        contract: {
          originalUserWording: "Add a red save button",
          goal: "Save button is red",
          acceptanceCriteria: [{ id: "AC-1", text: "Save button is red" }],
          openQuestions: [{ id: "Q-1", text: "Which theme token?", status: "resolved", resolution: "danger" }],
        },
        createdBy: "user:lead",
      });
      const confirmed = await confirmAcceptanceContract({
        workspaceId: wsId,
        recordId: draft.record.id,
        version: resolvedDraft.version,
        confirmedBy: "user:lead",
      });
      expect(confirmed.status).toBe("confirmed");
      expect(confirmed.confirmedBy).toBe("user:lead");
      expect(confirmed.confirmedAt).not.toBeNull();
      await expect(createDraftAcceptanceContract({
        recordId: draft.record.id,
        contract: { originalUserWording: "A later edit", goal: "Must be rejected" },
        createdBy: "user:lead",
      })).rejects.toThrow("immutable");

      const contracts = await readAcceptanceContracts({
        workspaceId: wsId,
        recordId: draft.record.id,
      });
      expect(contracts?.map((contract) => [contract.version, contract.status])).toEqual([
        [1, "draft"],
        [2, "draft"],
        [3, "confirmed"],
      ]);
    });
    it("binds a brief to a record with an immutable snapshot and reads current state separately", async () => {
      const [brief] = await db
        .insert(briefs)
        .values({
          workspaceId: wsId,
          slug: `brief-${randomUUID()}`,
          title: "Initial brief title",
          repositoryId: null,
          openQuestion: "Which exact task is this?",
          grounding: { wikiPageSlugs: [], memoryItemIds: [], commitSha: null },
          jaceSessionIds: [],
        })
        .returning();
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        workKey: `brief-binding-${randomUUID()}`,
        originChannel: "slack",
        sourceReferences: [{ kind: "slack_thread", id: "thread-1" }],
        contract: {
          originalRequest: "Add a better trust record",
          acceptanceCriteria: [{ id: "AC-1", text: "Track immutable brief provenance" }],
          unresolvedQuestions: [],
        },
        createdBy: "user:lead",
      });

      const binding = await linkAcceptanceBriefToRecord({
        workspaceId: wsId,
        recordId: draft.record.id,
        briefId: brief.id,
        linkedBy: "user:lead",
      });
      expect(binding.recordId).toBe(draft.record.id);
      expect(binding.briefId).toBe(brief.id);
      expect(binding.briefSnapshot).toMatchObject({
        briefId: brief.id,
        title: "Initial brief title",
        slug: brief.slug,
        status: "draft",
      });
      expect(binding.provenance).toMatchObject({
        boundBy: "user:lead",
        recordSourceReferences: [{ kind: "slack_thread", id: "thread-1" }],
      });

      await db.update(briefs).set({ title: "Updated brief title" }).where(eq(briefs.id, brief.id));

      const readback = await readAcceptanceBriefBinding({
        workspaceId: wsId,
        recordId: draft.record.id,
      });
      expect(readback).not.toBeNull();
      expect(readback?.binding.id).toBe(binding.id);
      expect(readback?.binding.briefSnapshot).toMatchObject({
        title: "Initial brief title",
        status: "draft",
      });
      expect(readback?.brief.title).toBe("Updated brief title");
      expect(readback?.record.id).toBe(draft.record.id);
      expect(readback?.record.state).toBe("open");

      const briefReadback = await readAcceptanceBriefBinding({
        workspaceId: wsId,
        briefId: brief.id,
      });
      expect(briefReadback?.binding.id).toBe(binding.id);
      expect(briefReadback?.brief.id).toBe(brief.id);
      expect(briefReadback?.record.id).toBe(draft.record.id);

      const samePair = await linkAcceptanceBriefToRecord({
        workspaceId: wsId,
        recordId: draft.record.id,
        briefId: brief.id,
        linkedBy: "user:lead",
      });
      expect(samePair.id).toBe(binding.id);
    });

    it("rejects foreign-workspace brief links and conflicting rebinds", async () => {
      const [brief] = await db
        .insert(briefs)
        .values({
          workspaceId: wsId,
          slug: `linked-brief-${randomUUID()}`,
          title: "Workspace-bound brief",
          repositoryId: null,
          openQuestion: "",
          grounding: { wikiPageSlugs: [], memoryItemIds: [], commitSha: null },
          jaceSessionIds: [],
        })
        .returning();
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        workKey: `linked-record-${randomUUID()}`,
        originChannel: "codex_mcp",
        contract: { originalRequest: "Bind me", acceptanceCriteria: [], unresolvedQuestions: [] },
        createdBy: "user:lead",
      });
      const otherWorkspace = await db
        .insert(workspaces)
        .values({
          name: "foreign workspace",
          slug: `foreign-${randomUUID()}`,
        })
        .returning({ id: workspaces.id });
      try {
        await expect(
          linkAcceptanceBriefToRecord({
            workspaceId: otherWorkspace[0]!.id,
            recordId: draft.record.id,
            briefId: brief.id,
            linkedBy: "user:lead",
          })
        ).rejects.toThrow("not found in workspace");

        const otherDraft = await createDraftAcceptanceRecord({
          workspaceId: wsId,
          repo: "acme/widgets",
          workKey: `other-record-${randomUUID()}`,
          originChannel: "slack",
          contract: { originalRequest: "Different record", acceptanceCriteria: [], unresolvedQuestions: [] },
          createdBy: "user:lead",
        });
        await linkAcceptanceBriefToRecord({
          workspaceId: wsId,
          recordId: draft.record.id,
          briefId: brief.id,
          linkedBy: "user:lead",
        });
        await expect(
          linkAcceptanceBriefToRecord({
            workspaceId: wsId,
            recordId: otherDraft.record.id,
            briefId: brief.id,
            linkedBy: "user:lead",
          })
        ).rejects.toThrow("already linked to an Acceptance Record");
      } finally {
        await db.delete(workspaces).where(eq(workspaces.id, otherWorkspace[0]!.id));
      }
    });
  }
);
