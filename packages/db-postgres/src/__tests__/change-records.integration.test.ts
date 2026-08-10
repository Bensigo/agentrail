import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db } from "../db.js";
import { workspaces } from "../schema/workspaces.js";
import {
  acceptanceIntakeMessages,
  acceptanceIntakes,
  acceptanceContracts,
  changeRecordEvents,
} from "../schema/change_records.js";
import { jaceApprovals, jaceSessions } from "../schema/jace_sessions.js";
import {
  appendChangeRecordEvent,
  appendChangeRecordEventsAtomically,
  attachConfirmedAcceptanceRecordToExternalPullRequest,
  changeRecordId,
  createDraftAcceptanceContract,
  createDraftAcceptanceRecord,
  createDraftAcceptanceRecordFromIntake,
  findOrCreateChangeRecord,
  recordAcceptancePostMergeOutcome,
  recordAcceptanceInboundIntake,
  readAcceptanceContracts,
  readChangeRecordTimeline,
} from "../queries/change_records.js";
import {
  recordApprovalRequest,
  resolveAcceptanceContractApproval,
} from "../queries/jace_sessions.js";

const DB_AVAILABLE: boolean = await (async () => {
  try {
    const rows = Array.from(
      await db.execute(sql`
        SELECT to_regclass('public.change_records') AS change_records,
               to_regclass('public.change_record_events') AS change_record_events,
               to_regclass('public.acceptance_contracts') AS acceptance_contracts,
               to_regclass('public.acceptance_intakes') AS acceptance_intakes,
               to_regclass('public.acceptance_intake_messages') AS acceptance_intake_messages
      `)
    ) as Array<{
      change_records: string | null;
      change_record_events: string | null;
      acceptance_contracts: string | null;
      acceptance_intakes: string | null;
      acceptance_intake_messages: string | null;
    }>;
    return (
      rows[0]?.change_records === "change_records" &&
      rows[0]?.change_record_events === "change_record_events" &&
      rows[0]?.acceptance_contracts === "acceptance_contracts" &&
      rows[0]?.acceptance_intakes === "acceptance_intakes" &&
      rows[0]?.acceptance_intake_messages === "acceptance_intake_messages"
    );
  } catch {
    return false;
  }
})();

function completeContract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    originalRequest: "Add saved filters",
    normalizedRequirements: ["Users can save and reuse a filter"],
    acceptanceCriteria: [
      { id: "AC-1", text: "A user can save a filter", userVisible: true },
    ],
    nonGoals: [],
    risks: [],
    environment: { kind: "existing_preview" },
    stops: [],
    unresolvedQuestions: [],
    ...overrides,
  };
}

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

    it("attaches only a confirmed Acceptance Record to one exact external PR head", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        workKey: "external-pr-attachment",
        originChannel: "codex_mcp",
        contract: completeContract(),
        createdBy: "user:lead",
      });
      const input = {
        workspaceId: wsId,
        recordId: draft.record.id,
        repo: "acme/widgets",
        prNumber: 42,
        headSha: "abc123def4567890",
        source: "github_webhook" as const,
        prUrl: "https://github.com/acme/widgets/pull/42",
      };
      await expect(attachConfirmedAcceptanceRecordToExternalPullRequest(input)).resolves.toEqual({
        kind: "not_confirmed",
      });

      await db
        .update(acceptanceContracts)
        .set({ status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date() })
        .where(eq(acceptanceContracts.id, draft.contract.id));

      const attached = await attachConfirmedAcceptanceRecordToExternalPullRequest(input);
      expect(attached).toMatchObject({
        kind: "attached",
        inserted: true,
        record: { id: draft.record.id, prNumber: 42, headShas: ["abc123def4567890"] },
      });
      await expect(attachConfirmedAcceptanceRecordToExternalPullRequest(input)).resolves.toMatchObject({
        kind: "attached",
        inserted: false,
      });

      const other = await createDraftAcceptanceRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        workKey: "other-external-pr-attachment",
        originChannel: "codex_mcp",
        contract: completeContract(),
        createdBy: "user:lead",
      });
      await db
        .update(acceptanceContracts)
        .set({ status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date() })
        .where(eq(acceptanceContracts.id, other.contract.id));
      await expect(
        attachConfirmedAcceptanceRecordToExternalPullRequest({ ...input, recordId: other.record.id })
      ).resolves.toEqual({ kind: "already_attached" });
    });

    it("persists one canonical Intake message idempotently and refuses source-key collisions", async () => {
      const first = await recordAcceptanceInboundIntake({
        workspaceId: wsId,
        originChannel: "Slack",
        conversationKey: "thread-7",
        sourceKey: "event-1",
        text: "Add saved filters",
        sourceReferences: [{ kind: "channel_message", id: "event-1" }],
      });
      expect(first.inserted).toBe(true);
      expect(first.intake.originChannel).toBe("slack");

      const replay = await recordAcceptanceInboundIntake({
        workspaceId: wsId,
        originChannel: "slack",
        conversationKey: "thread-7",
        sourceKey: "event-1",
        text: "Add saved filters",
      });
      expect(replay.inserted).toBe(false);
      expect(replay.intake.id).toBe(first.intake.id);
      expect(replay.message.id).toBe(first.message.id);

      await expect(
        recordAcceptanceInboundIntake({
          workspaceId: wsId,
          originChannel: "slack",
          conversationKey: "thread-7",
          sourceKey: "event-1",
          text: "Different content",
        })
      ).rejects.toThrow("source key is already bound to different content");

      expect(
        await db
          .select()
          .from(acceptanceIntakes)
          .where(eq(acceptanceIntakes.id, first.intake.id))
      ).toHaveLength(1);
      expect(
        await db
          .select()
          .from(acceptanceIntakeMessages)
          .where(eq(acceptanceIntakeMessages.intakeId, first.intake.id))
      ).toHaveLength(1);
    });

    it("binds an Intake to one provenance-preserving draft and refuses changed re-drafts", async () => {
      const intake = await recordAcceptanceInboundIntake({
        workspaceId: wsId,
        originChannel: "discord",
        conversationKey: "thread-8",
        sourceKey: "message-1",
        text: "Add saved filters",
        sourceReferences: [{ kind: "channel_message", id: "message-1" }],
      });
      const contract = completeContract();
      const drafted = await createDraftAcceptanceRecordFromIntake({
        workspaceId: wsId,
        intakeId: intake.intake.id,
        repo: "acme/widgets",
        contract,
        createdBy: "jace:acceptance-intake",
      });
      expect(drafted.created).toBe(true);
      expect(drafted.intake.status).toBe("drafted");
      expect(drafted.intake.recordId).toBe(drafted.record.id);
      expect(drafted.record.workKey).toBe(`acceptance-intake:${intake.intake.id}`);
      expect(drafted.record.originChannel).toBe("discord");
      expect(drafted.record.sourceReferences).toEqual(intake.intake.sourceReferences);
      expect(drafted.contract.contract).toEqual(contract);

      const replay = await createDraftAcceptanceRecordFromIntake({
        workspaceId: wsId,
        intakeId: intake.intake.id,
        repo: "acme/widgets",
        contract,
        createdBy: "jace:acceptance-intake",
      });
      expect(replay).toMatchObject({
        created: false,
        intake: { id: intake.intake.id, recordId: drafted.record.id },
        record: { id: drafted.record.id },
        contract: { id: drafted.contract.id },
      });

      await expect(
        createDraftAcceptanceRecordFromIntake({
          workspaceId: wsId,
          intakeId: intake.intake.id,
          repo: "acme/widgets",
          contract: completeContract({ originalRequest: "A different request" }),
          createdBy: "jace:acceptance-intake",
        })
      ).rejects.toMatchObject({ code: "conflict" });

      const timeline = await readChangeRecordTimeline({
        workspaceId: wsId,
        recordId: drafted.record.id,
      });
      expect(timeline?.events.some((event) => event.eventKey ===
        `acceptance-intake:${intake.intake.id}:drafted`)).toBe(true);
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

    it("atomically appends an ordered batch and allows an exact replay", async () => {
      const record = await findOrCreateChangeRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        prNumber: 10,
      });
      const events = [
        {
          recordId: record.id,
          eventKey: "batch:contract",
          stage: "contract",
          actor: "console_user:user-1",
          payloadRef: { version: 1, kind: "acceptance_contract" },
          at: new Date("2026-08-10T09:00:00.000Z"),
        },
        {
          recordId: record.id,
          eventKey: "batch:evidence",
          stage: "evidence",
          actor: "console_user:user-1",
          payloadRef: { artifactKey: "evidence/run-1.json", kind: "criterion_evidence" },
          at: new Date("2026-08-10T09:01:00.000Z"),
        },
      ];

      const first = await appendChangeRecordEventsAtomically(events);
      expect(first.events.map((result) => result.inserted)).toEqual([true, true]);
      expect(first.events.map((result) => result.event.eventKey)).toEqual([
        "batch:contract",
        "batch:evidence",
      ]);

      const replay = await appendChangeRecordEventsAtomically(events.map((event) => ({
        ...event,
        at: new Date("2026-08-10T10:00:00.000Z"),
      })));
      expect(replay.events.map((result) => result.inserted)).toEqual([false, false]);
      expect(replay.events.map((result) => result.event.id)).toEqual(
        first.events.map((result) => result.event.id)
      );
    });

    it("rolls back new batch events when a reused event key has different provenance", async () => {
      const record = await findOrCreateChangeRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        prNumber: 11,
      });
      await appendChangeRecordEvent({
        recordId: record.id,
        eventKey: "batch:already-recorded",
        stage: "contract",
        actor: "console_user:user-1",
        payloadRef: { version: 1 },
      });

      await expect(appendChangeRecordEventsAtomically([
        {
          recordId: record.id,
          eventKey: "batch:must-roll-back",
          stage: "evidence",
          actor: "console_user:user-1",
          payloadRef: { artifactKey: "evidence/new.json" },
        },
        {
          recordId: record.id,
          eventKey: "batch:already-recorded",
          stage: "evidence",
          actor: "console_user:user-1",
          payloadRef: { version: 1 },
        },
      ])).rejects.toThrow("already bound to different stage, actor, or payloadRef");

      const persisted = await db
        .select()
        .from(changeRecordEvents)
        .where(eq(changeRecordEvents.recordId, record.id));
      expect(persisted.map((event) => event.eventKey).sort()).toEqual(["batch:already-recorded"]);
    });

    it("keeps exact preexisting events and atomically appends only the new remainder", async () => {
      const record = await findOrCreateChangeRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        prNumber: 12,
      });
      const preexisting = {
        recordId: record.id,
        eventKey: "batch:preexisting",
        stage: "contract",
        actor: "console_user:user-1",
        payloadRef: { version: 1 },
      };
      await appendChangeRecordEvent(preexisting);

      const appended = await appendChangeRecordEventsAtomically([
        { ...preexisting, at: new Date("2026-08-10T10:00:00.000Z") },
        {
          recordId: record.id,
          eventKey: "batch:new",
          stage: "evidence",
          actor: "console_user:user-1",
          payloadRef: { artifactKey: "evidence/new.json" },
        },
      ]);
      expect(appended.events.map((result) => result.inserted)).toEqual([false, true]);
      expect(appended.events.map((result) => result.event.eventKey)).toEqual([
        "batch:preexisting",
        "batch:new",
      ]);
    });

    it("records post-merge outcomes append-only, carries merge provenance forward, and stays replay-safe after later state changes", async () => {
      const record = await findOrCreateChangeRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        issueNumber: 310,
        prNumber: 310,
        headShas: ["a1b2c3d"],
      });

      const mergedOutcome = {
        kind: "merged",
        prNumber: 310,
        baseSha: "c3d4e5f",
        headSha: "a1b2c3d",
        mergeSha: "b2c3d4e",
        mergeReference: "gh/pr/310#merge",
      } as const;
      const merged = await recordAcceptancePostMergeOutcome({
        workspaceId: wsId,
        recordId: record.id,
        recordedBy: "user:lead",
        outcome: mergedOutcome,
        occurredAt: new Date("2026-08-03T14:00:00.000Z"),
      });
      expect(merged.inserted).toBe(true);
      expect(merged.event.eventKey).toBe("acceptance-post-merge:merged:b2c3d4e");
      expect(merged.event.stage).toBe("post_merge_outcome");
      expect(merged.event.payloadRef).toEqual({
        kind: "acceptance_post_merge_outcome",
        repository: "acme/widgets",
        outcome: mergedOutcome,
      });

      const mergedReplayBeforeLaterOutcomes = await recordAcceptancePostMergeOutcome({
        workspaceId: wsId,
        recordId: record.id,
        recordedBy: "user:lead",
        outcome: mergedOutcome,
        occurredAt: new Date("2026-08-03T14:05:00.000Z"),
      });
      expect(mergedReplayBeforeLaterOutcomes.inserted).toBe(false);
      expect(mergedReplayBeforeLaterOutcomes.event.id).toBe(merged.event.id);

      const deployedOutcome = {
        kind: "deployed",
        revisionSha: "b2c3d4e",
        environment: "production",
        deploymentReference: "railway:deploy:42",
      } as const;
      const incidentOutcome = {
        kind: "incident",
        revisionSha: "b2c3d4e",
        incidentReference: "incidents:inc-9",
      } as const;
      const revertedOutcome = {
        kind: "reverted",
        revertedSha: "b2c3d4e",
        revertSha: "c3d4e5f",
        revertReference: "gh/revert/99",
      } as const;

      const deployed = await recordAcceptancePostMergeOutcome({
        workspaceId: wsId,
        recordId: record.id,
        recordedBy: "user:lead",
        outcome: deployedOutcome,
        occurredAt: new Date("2026-08-03T15:00:00.000Z"),
      });
      const incident = await recordAcceptancePostMergeOutcome({
        workspaceId: wsId,
        recordId: record.id,
        recordedBy: "user:lead",
        outcome: incidentOutcome,
        occurredAt: new Date("2026-08-03T16:00:00.000Z"),
      });
      const reverted = await recordAcceptancePostMergeOutcome({
        workspaceId: wsId,
        recordId: record.id,
        recordedBy: "user:lead",
        outcome: revertedOutcome,
        occurredAt: new Date("2026-08-03T17:00:00.000Z"),
      });

      expect(deployed.inserted).toBe(true);
      expect(incident.inserted).toBe(true);
      expect(reverted.inserted).toBe(true);

      const timeline = await readChangeRecordTimeline({
        workspaceId: wsId,
        recordId: record.id,
      });
      expect(timeline?.record.mergedSha).toBe("b2c3d4e");
      expect(timeline?.record.state).toBe("reverted");
      expect(timeline?.events.map((event) => event.eventKey)).toEqual([
        "acceptance-post-merge:merged:b2c3d4e",
        "acceptance-post-merge:deployed:railway:deploy:42",
        "acceptance-post-merge:incident:incidents:inc-9",
        "acceptance-post-merge:reverted:c3d4e5f",
      ]);
      expect(timeline?.events[0]?.payloadRef).toEqual({
        kind: "acceptance_post_merge_outcome",
        repository: "acme/widgets",
        outcome: mergedOutcome,
      });
      expect(timeline?.events[1]?.payloadRef).toEqual({
        kind: "acceptance_post_merge_outcome",
        repository: "acme/widgets",
        outcome: deployedOutcome,
      });
      expect(timeline?.events[2]?.payloadRef).toEqual({
        kind: "acceptance_post_merge_outcome",
        repository: "acme/widgets",
        outcome: incidentOutcome,
      });
      expect(timeline?.events[3]?.payloadRef).toEqual({
        kind: "acceptance_post_merge_outcome",
        repository: "acme/widgets",
        outcome: revertedOutcome,
      });

      // This should stay replay-safe even after later outcomes have changed
      // the record's summary state; the recorded merge event is the canonical
      // provenance and must still be returned, not rejected.
      const mergedReplayAfterLaterOutcomes = await recordAcceptancePostMergeOutcome({
        workspaceId: wsId,
        recordId: record.id,
        recordedBy: "user:lead",
        outcome: mergedOutcome,
        occurredAt: new Date("2026-08-03T18:00:00.000Z"),
      });
      expect(mergedReplayAfterLaterOutcomes.inserted).toBe(false);
      expect(mergedReplayAfterLaterOutcomes.event.id).toBe(merged.event.id);
      expect(mergedReplayAfterLaterOutcomes.event.payloadRef).toEqual(merged.event.payloadRef);
    });

    it("rejects foreign-workspace, stale-head, and unmatched merge references", async () => {
      const record = await findOrCreateChangeRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        issueNumber: 410,
        prNumber: 410,
        headShas: ["d4e5f6a"],
      });

      await expect(
        recordAcceptancePostMergeOutcome({
          workspaceId: wsId,
          recordId: record.id,
          recordedBy: "user:lead",
          outcome: {
            kind: "merged",
            prNumber: 410,
            baseSha: "e5f6a7b",
            headSha: "deadbee",
            mergeSha: "0410abc",
            mergeReference: "gh/pr/410#merge",
          },
        })
      ).rejects.toThrow("Merge outcome does not match this Acceptance Record PR and exact head");

      const merged = await recordAcceptancePostMergeOutcome({
        workspaceId: wsId,
        recordId: record.id,
        recordedBy: "user:lead",
          outcome: {
            kind: "merged",
            prNumber: 410,
            baseSha: "e5f6a7b",
            headSha: "d4e5f6a",
            mergeSha: "0410abc",
            mergeReference: "gh/pr/410#merge",
          },
        });
      expect(merged.inserted).toBe(true);

      const otherWorkspace = await db
        .insert(workspaces)
        .values({
          name: "other workspace",
          slug: `other-change-records-${randomUUID()}`,
        })
        .returning({ id: workspaces.id });
      try {
        await expect(
          recordAcceptancePostMergeOutcome({
            workspaceId: otherWorkspace[0]!.id,
            recordId: record.id,
            recordedBy: "user:lead",
            outcome: {
              kind: "deployed",
              revisionSha: "0410abc",
              environment: "production",
              deploymentReference: "railway:deploy:foreign",
            },
          })
        ).rejects.toThrow("Acceptance Record is missing or outside this workspace");
      } finally {
        await db
          .delete(workspaces)
          .where(eq(workspaces.id, otherWorkspace[0]!.id));
      }

      await expect(
        recordAcceptancePostMergeOutcome({
          workspaceId: wsId,
          recordId: record.id,
          recordedBy: "user:lead",
          outcome: {
            kind: "incident",
            revisionSha: "ffffeee",
            incidentReference: "incidents:foreign-revision",
          },
        })
      ).rejects.toThrow(
        "Post-merge outcome does not reference this Acceptance Record merge SHA"
      );
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

    it("creates a retry-safe manual Acceptance Record with immutable draft versions", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        workKey: "manual-trust-loop-1",
        originChannel: "codex_mcp",
        sourceReferences: [{ kind: "codex_thread", id: "thread-1" }],
        contract: completeContract({
          originalRequest: "Add a red save button",
          acceptanceCriteria: [
            { id: "AC-1", text: "Save button is red", userVisible: true },
          ],
        }),
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
        contract: completeContract({
          originalRequest: "This retry must not replace the draft",
        }),
        createdBy: "user:lead",
      });
      expect(retried.record.id).toBe(draft.record.id);
      expect(retried.contract.id).toBe(draft.contract.id);
      expect(retried.contract.contract).toEqual(draft.contract.contract);

      const secondDraft = await createDraftAcceptanceContract({
        recordId: draft.record.id,
        contract: completeContract({
          originalRequest: "Add a red save button",
          acceptanceCriteria: [
            { id: "AC-1", text: "Save button is red", userVisible: true },
          ],
          unresolvedQuestions: [{ id: "Q-1", text: "Which theme token?" }],
        }),
        createdBy: "user:lead",
      });
      expect(secondDraft.version).toBe(2);
      const contracts = await readAcceptanceContracts({
        workspaceId: wsId,
        recordId: draft.record.id,
      });
      expect(contracts?.map((contract) => [contract.version, contract.status])).toEqual([
        [1, "draft"],
        [2, "draft"],
      ]);
    });

    it("confirms only the approval-bound draft before exposing the approval as approved", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        workKey: "approval-bound-contract",
        originChannel: "codex_mcp",
        contract: completeContract(),
        createdBy: "user:lead",
      });
      const [session] = await db
        .insert(jaceSessions)
        .values({
          workspaceId: wsId,
          channel: "codex_mcp",
          conversationKey: `approval-contract-${randomUUID()}`,
          eveSessionId: `eve-${randomUUID()}`,
        })
        .returning();
      const request = await recordApprovalRequest({
        workspaceId: wsId,
        sessionId: session!.id,
        eveSessionId: session!.eveSessionId!,
        requestId: `confirm-${randomUUID()}`,
        toolName: "confirm_acceptance_contract",
        toolInput: { acceptanceContractId: "untrusted-payload-value" },
        approveOptionId: "approve",
        denyOptionId: "deny",
        acceptanceContractId: draft.contract.id,
      });

      await expect(
        resolveAcceptanceContractApproval({
          workspaceId: wsId,
          approvalId: request.approval.id,
          decision: "approved",
          confirmedBy: "console_user:user-1",
        })
      ).resolves.toMatchObject({
        resolved: true,
        contract: { id: draft.contract.id, status: "confirmed" },
      });

      const [approval] = await db
        .select()
        .from(jaceApprovals)
        .where(eq(jaceApprovals.id, request.approval.id));
      expect(approval?.status).toBe("approved");
      const timeline = await readChangeRecordTimeline({
        workspaceId: wsId,
        recordId: draft.record.id,
      });
      expect(
        timeline?.events.some(
          (event) => event.eventKey === "acceptance-contract:confirmed:1"
        )
      ).toBe(true);
    });

    it("leaves unsafe or incomplete Contract confirmations pending", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        workKey: "rejected-contract-confirmations",
        originChannel: "codex_mcp",
        contract: completeContract({
          unresolvedQuestions: [{ id: "Q-1", text: "Which filters?" }],
        }),
        createdBy: "user:lead",
      });
      const [session] = await db
        .insert(jaceSessions)
        .values({
          workspaceId: wsId,
          channel: "codex_mcp",
          conversationKey: `rejected-contract-${randomUUID()}`,
          eveSessionId: `eve-${randomUUID()}`,
        })
        .returning();
      const openQuestionApproval = await recordApprovalRequest({
        workspaceId: wsId,
        sessionId: session!.id,
        eveSessionId: session!.eveSessionId!,
        requestId: `open-question-${randomUUID()}`,
        toolName: "confirm_acceptance_contract",
        toolInput: {},
        approveOptionId: "approve",
        denyOptionId: "deny",
        acceptanceContractId: draft.contract.id,
      });
      await expect(
        resolveAcceptanceContractApproval({
          workspaceId: wsId,
          approvalId: openQuestionApproval.approval.id,
          decision: "approved",
          confirmedBy: "console_user:user-1",
        })
      ).resolves.toEqual({ resolved: false, reason: "open_questions" });

      const [approval] = await db
        .select()
        .from(jaceApprovals)
        .where(eq(jaceApprovals.id, openQuestionApproval.approval.id));
      expect(approval?.status).toBe("pending");

      await expect(
        createDraftAcceptanceRecord({
          workspaceId: wsId,
          repo: "acme/widgets",
          workKey: "missing-contract-criteria",
          originChannel: "codex_mcp",
          contract: { originalRequest: "No criterion", unresolvedQuestions: [] },
          createdBy: "user:lead",
        })
      ).rejects.toThrow(/Acceptance Contract is incomplete/);

      const wrongToolApproval = await recordApprovalRequest({
        workspaceId: wsId,
        sessionId: session!.id,
        eveSessionId: session!.eveSessionId!,
        requestId: `wrong-tool-${randomUUID()}`,
        toolName: "create_issue",
        toolInput: {},
        approveOptionId: "approve",
        denyOptionId: "deny",
        acceptanceContractId: draft.contract.id,
      });
      await expect(
        resolveAcceptanceContractApproval({
          workspaceId: wsId,
          approvalId: wrongToolApproval.approval.id,
          decision: "approved",
          confirmedBy: "console_user:user-1",
        })
      ).resolves.toEqual({ resolved: false, reason: "wrong_tool_name" });
      await expect(
        resolveAcceptanceContractApproval({
          workspaceId: "foreign-workspace",
          approvalId: wrongToolApproval.approval.id,
          decision: "approved",
          confirmedBy: "console_user:user-1",
        })
      ).resolves.toEqual({ resolved: false, reason: "wrong_workspace" });
    });
  }
);
