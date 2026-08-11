import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createHash, randomUUID } from "crypto";
import { readFile } from "node:fs/promises";
import { db } from "../db.js";
import { workspaces } from "../schema/workspaces.js";
import { repositories } from "../schema/repositories.js";
import { wikiPages } from "../schema/wiki_pages.js";
import {
  acceptanceIntakeMessages,
  acceptanceIntakes,
  acceptanceBuilderRouteCapabilityProfiles,
  acceptanceBuilderRouteGithubClaudeAckProfiles,
  acceptanceBuilderRoutes,
  acceptanceCompiledContextPacks,
  acceptanceCorrectionDispatchGithubActivations,
  acceptanceCorrectionDispatchGithubClaudeAckReceipts,
  acceptanceCorrectionDispatchGithubClaudeRepairObservations,
  acceptanceCorrectionDispatchGithubFindingPublications,
  acceptanceCorrectionDispatches,
  acceptanceCorrectionDispatchGithubPreflights,
  acceptanceContextPackSnapshots,
  acceptanceContracts,
  changeRecordEvents,
  changeRecords,
} from "../schema/change_records.js";
import { reviewJobs } from "../schema/review_jobs.js";
import { previewBoots } from "../schema/preview_boots.js";
import { jaceApprovals, jaceSessions } from "../schema/jace_sessions.js";
import {
  appendChangeRecordEvent,
  appendChangeRecordEventsAtomically,
  appendCurrentReviewJobEventsAtomically,
  acceptanceRecordPullRequestHeadCycleId,
  acceptanceContextPackCustodyBaseIndexRevisionSha256,
  acceptanceContextPackCustodyOverlayManifestSha256,
  acceptanceContextOverlayHeadRangeCoordinateSha256,
  acceptanceContextOverlayManifestSha256,
  acceptanceContextPackCanonicalSha256,
  acceptanceContextPacketSetSha256,
  acceptanceContractSha256,
  acceptanceCorrectionPacketPayloadSetSha256,
  reviewJobCorrectionPacketId,
  wikiPageBodySha256,
  attachConfirmedAcceptanceRecordToExternalPullRequest,
  advanceConfirmedAcceptanceRecordPullRequestHead,
  invalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEvent,
  reconcileConfirmedAcceptanceRecordPullRequestHead,
  enqueueCurrentReviewJobPreviewBoot,
  changeRecordId,
  createDraftAcceptanceContract,
  createDraftAcceptanceRecord,
  createDraftAcceptanceRecordFromIntake,
  findOrCreateChangeRecord,
  recordAcceptancePostMergeOutcome,
  recordAcceptanceBuilderRouteSelection,
  recordAcceptanceContextPackSnapshot,
  resolveAcceptanceContextPackCustody,
  recordAcceptanceCompiledContextPack,
  resolveAcceptanceCompiledContextPack,
  registerAcceptanceBuilderRoute,
  recordAcceptanceBuilderRouteCapabilityProfile,
  recordAcceptanceBuilderRouteGithubClaudeAckProfile,
  recordGithubClaudeAgentAcknowledgement,
  readGithubClaudeAgentAcknowledgement,
  githubClaudeAcknowledgementAudience,
  recordGithubClaudeRepairHeadObservation,
  readGithubClaudeRepairHeadEvidence,
  githubClaudeRepairObservationAudience,
  GithubClaudeAgentAcknowledgementConflictError,
  GithubClaudeRepairObservationConflictError,
  readCurrentAcceptanceCorrectionPackets,
  recordAcceptanceInboundIntake,
  readAcceptanceBuilderRouteSelection,
  resolveAcceptanceBuilderRouteCapabilityProfile,
  readAcceptanceContracts,
  readChangeRecordByPr,
  readChangeRecordTimeline,
  queueSelectedCorrectionDispatch,
  reserveGithubCorrectionCarrierPreflight,
  reportGithubCorrectionCarrierPreflight,
  reserveNextGithubCorrectionFindingPublication,
  reportGithubCorrectionFindingPublication,
  reserveGithubCorrectionActivation,
  reportGithubCorrectionActivation,
  readDurableCorrectionDispatchFallback,
  recordDurableCorrectionDispatchFallback,
} from "../queries/change_records.js";
import { exactGitTreeInclusionProofIdentity, type ExactGitTreeInclusionProof } from "../exact-git-tree-path-proof.js";
import { previewBootId } from "../queries/preview_boots.js";
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
               to_regclass('public.acceptance_builder_routes') AS acceptance_builder_routes,
               to_regclass('public.acceptance_builder_route_capability_profiles') AS acceptance_builder_route_capability_profiles,
               to_regclass('public.acceptance_builder_route_github_claude_ack_profiles') AS acceptance_builder_route_github_claude_ack_profiles,
               to_regclass('public.acceptance_context_pack_snapshots') AS acceptance_context_pack_snapshots,
               to_regclass('public.acceptance_compiled_context_packs') AS acceptance_compiled_context_packs,
               to_regclass('public.acceptance_correction_dispatches') AS acceptance_correction_dispatches,
               to_regclass('public.acceptance_correction_dispatch_github_preflights') AS acceptance_correction_dispatch_github_preflights,
               to_regclass('public.acceptance_correction_dispatch_github_finding_publications') AS acceptance_correction_dispatch_github_finding_publications,
               to_regclass('public.acceptance_correction_dispatch_github_activations') AS acceptance_correction_dispatch_github_activations,
               to_regclass('public.acceptance_correction_dispatch_github_claude_ack_receipts') AS acceptance_correction_dispatch_github_claude_ack_receipts,
               to_regclass('public.acceptance_correction_dispatch_github_claude_repair_obs') AS github_claude_repair_observations,
               EXISTS (
                 SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'acceptance_context_pack_snapshots'
                   AND column_name = 'acceptance_contract_sha256'
               ) AND EXISTS (
                 SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'acceptance_context_pack_snapshots'
                   AND column_name = 'correction_packet_payload_set_sha256'
               ) AS acceptance_context_pack_custody,
               EXISTS (
                 SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'acceptance_compiled_context_packs'
                   AND column_name = 'exact_head_dependency_tree_proofs'
               ) AS acceptance_compiled_context_pack_tree_proofs,
               EXISTS (
                 SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'change_records'
                   AND column_name = 'current_pr_head_sha'
               ) AND EXISTS (
                 SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'change_records'
                   AND column_name = 'current_pr_head_authoritative'
               ) AND EXISTS (
                 SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'change_records'
                   AND column_name = 'current_pr_head_cycle_id'
               ) AND EXISTS (
                 SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'change_records'
                   AND column_name = 'current_pr_head_authority_generation'
               ) AS change_record_current_pr_head,
               to_regclass('public.acceptance_intakes') AS acceptance_intakes,
               to_regclass('public.acceptance_intake_messages') AS acceptance_intake_messages
      `)
    ) as Array<{
      change_records: string | null;
      change_record_events: string | null;
      acceptance_contracts: string | null;
      acceptance_builder_routes: string | null;
      acceptance_builder_route_capability_profiles: string | null;
      acceptance_builder_route_github_claude_ack_profiles: string | null;
      acceptance_context_pack_snapshots: string | null;
      acceptance_compiled_context_packs: string | null;
      acceptance_correction_dispatches: string | null;
      acceptance_correction_dispatch_github_preflights: string | null;
      acceptance_correction_dispatch_github_finding_publications: string | null;
      acceptance_correction_dispatch_github_activations: string | null;
      acceptance_correction_dispatch_github_claude_ack_receipts: string | null;
      github_claude_repair_observations: string | null;
      acceptance_context_pack_custody: boolean;
      acceptance_compiled_context_pack_tree_proofs: boolean;
      change_record_current_pr_head: boolean;
      acceptance_intakes: string | null;
      acceptance_intake_messages: string | null;
    }>;
    return (
      rows[0]?.change_records === "change_records" &&
      rows[0]?.change_record_events === "change_record_events" &&
      rows[0]?.acceptance_contracts === "acceptance_contracts" &&
      rows[0]?.acceptance_builder_routes === "acceptance_builder_routes" &&
      rows[0]?.acceptance_builder_route_capability_profiles === "acceptance_builder_route_capability_profiles" &&
      rows[0]?.acceptance_builder_route_github_claude_ack_profiles === "acceptance_builder_route_github_claude_ack_profiles" &&
      rows[0]?.acceptance_context_pack_snapshots === "acceptance_context_pack_snapshots" &&
      rows[0]?.acceptance_compiled_context_packs === "acceptance_compiled_context_packs" &&
      rows[0]?.acceptance_correction_dispatches === "acceptance_correction_dispatches" &&
      rows[0]?.acceptance_correction_dispatch_github_preflights === "acceptance_correction_dispatch_github_preflights" &&
      rows[0]?.acceptance_correction_dispatch_github_finding_publications === "acceptance_correction_dispatch_github_finding_publications" &&
      rows[0]?.acceptance_correction_dispatch_github_activations === "acceptance_correction_dispatch_github_activations" &&
      rows[0]?.acceptance_correction_dispatch_github_claude_ack_receipts === "acceptance_correction_dispatch_github_claude_ack_receipts" &&
      rows[0]?.github_claude_repair_observations === "acceptance_correction_dispatch_github_claude_repair_obs" &&
      rows[0]?.acceptance_context_pack_custody === true &&
      rows[0]?.acceptance_compiled_context_pack_tree_proofs === true &&
      rows[0]?.change_record_current_pr_head === true &&
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

function exactCorrectionPacket(input: {
  workspaceId: string;
  recordId: string;
  jobId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  acceptanceContractId: string;
  acceptanceContractVersion?: number;
  observed?: string;
}) {
  const acceptanceContractVersion = input.acceptanceContractVersion ?? 1;
  const packetId = reviewJobCorrectionPacketId({
    jobId: input.jobId,
    criterionId: "AC-1",
    headSha: input.headSha,
    recordId: input.recordId,
    acceptanceContractId: input.acceptanceContractId,
    acceptanceContractVersion,
  });
  return {
    kind: "review_job_correction_packet",
    version: 1,
    packetId,
    workspaceId: input.workspaceId,
    repo: input.repo,
    prNumber: input.prNumber,
    headSha: input.headSha,
    recordId: input.recordId,
    jobId: input.jobId,
    acceptanceContract: { id: input.acceptanceContractId, version: acceptanceContractVersion },
    criterion: { id: "AC-1", snapshot: "A user can save a filter" },
    basis: "acceptance_contract",
    state: "failed",
    expected: "A user can save a filter",
    observed: input.observed ?? "The saved filter was not retained.",
    affectedContext: {
      modality: "ui",
      environmentKind: "isolated_preview",
      flow: "Save a filter, reload, and inspect it.",
      reproduction: {
        modality: "ui",
        steps: [
          { action: "open", path: "/filters" },
          { action: "expect_text", text: "Saved filters" },
          { action: "screenshot", label: "saved-filter" },
        ],
      },
    },
    evidence: {
      evidenceRef: "ui-execution:execution-1",
      artifactKey: "review/ui/execution-1.png",
      executionId: "execution-1",
      previewBootId: "preview-boot-1",
    },
    scopeBoundary: `Only AC-1 for ${input.repo}#${input.prNumber} at ${input.headSha}.`,
    impact: "The server-attested UI receipt shows this confirmed criterion failed on the exact head.",
    requiredCorrection: "Make the persisted UI flow retain the saved filter.",
    reverification: "Rerun the persisted UI plan against the next exact head.",
  };
}

async function appendExactCurrentCorrectionPacket(input: Parameters<typeof exactCorrectionPacket>[0]) {
  await db.update(reviewJobs).set({ state: "running" }).where(eq(reviewJobs.id, input.jobId));
  const packet = exactCorrectionPacket(input);
  await appendCurrentReviewJobEventsAtomically({
    workspaceId: input.workspaceId,
    recordId: input.recordId,
    jobId: input.jobId,
    repo: input.repo,
    prNumber: input.prNumber,
    headSha: input.headSha,
    events: [{
      eventKey: `review:correction:${input.jobId}:AC-1`,
      stage: "review",
      actor: "reviewer-of-record",
      payloadRef: packet,
    }],
  });
  return packet;
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

    it("returns absent for a deterministic fallback lookup before its dispatch exists", async () => {
      await expect(readDurableCorrectionDispatchFallback({
        workspaceId: wsId, dispatchId: randomUUID(),
      })).resolves.toEqual({ kind: "absent" });
    });

    afterEach(async () => {
      await db.delete(workspaces).where(eq(workspaces.id, wsId));
    });

    it("executes the exact 0088 legacy-preview teardown statement against Postgres", async () => {
      const migration = await readFile(new URL(
        "../../drizzle/migrations/0088_change_records_current_pr_head.sql",
        import.meta.url
      ), "utf8");
      const start = migration.indexOf('UPDATE "preview_boots"');
      const end = migration.indexOf(";", start);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      const teardownStatement = migration.slice(start, end + 1);

      await db.transaction(async (tx) => {
        await tx.execute(sql`
          CREATE TEMP TABLE "preview_boots" (
            id text PRIMARY KEY,
            status text NOT NULL,
            reason text,
            updated_at timestamptz NOT NULL DEFAULT now()
          ) ON COMMIT DROP
        `);
        await tx.execute(sql`
          INSERT INTO "preview_boots" (id, status) VALUES
            ('pending', 'pending'),
            ('claimed', 'claimed'),
            ('booting', 'booting'),
            ('ready', 'ready'),
            ('failed', 'failed')
        `);
        await tx.execute(sql.raw(teardownStatement));
        const rows = Array.from(await tx.execute(sql`
          SELECT id, status, reason FROM "preview_boots" ORDER BY id
        `)) as Array<{ id: string; status: string; reason: string | null }>;
        const activeBeforeMigration = rows.filter((row) => row.id !== "failed");
        expect(activeBeforeMigration).toHaveLength(4);
        expect(activeBeforeMigration.every((row) =>
          row.status === "torn_down"
          && row.reason === "current Acceptance Record cycle unavailable after migration"
        )).toBe(true);
        expect(rows.find((row) => row.id === "failed")).toMatchObject({
          status: "failed", reason: null,
        });
      });
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
        record: {
          id: draft.record.id,
          prNumber: 42,
          currentPrHeadSha: null,
          currentPrHeadAuthoritative: false,
          headShas: ["abc123def4567890"],
        },
      });
      await expect(attachConfirmedAcceptanceRecordToExternalPullRequest(input)).resolves.toMatchObject({
        kind: "attached",
        inserted: false,
      });
      await expect(readChangeRecordByPr({
        workspaceId: wsId, repo: "acme/widgets", prNumber: 42,
      })).resolves.toMatchObject({ id: draft.record.id, prNumber: 42 });
      await expect(readChangeRecordByPr({
        workspaceId: randomUUID(), repo: "acme/widgets", prNumber: 42,
      })).resolves.toBeNull();
      await expect(attachConfirmedAcceptanceRecordToExternalPullRequest({
        ...input,
        headSha: "def456abc1237890",
      })).resolves.toEqual({ kind: "head_advance_required" });

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

    it("advances one confirmed PR head atomically and invalidates queued and running older heads", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        workKey: "atomic-pr-head-advance",
        originChannel: "codex_mcp",
        contract: completeContract(),
        createdBy: "user:lead",
      });
      await db.update(acceptanceContracts).set({
        status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date(),
      }).where(eq(acceptanceContracts.id, draft.contract.id));

      const firstHead = "a".repeat(40);
      const secondHead = "b".repeat(40);
      const first = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 44,
        headSha: firstHead, event: "opened", deliveryId: "delivery-head-a",
        admitReviewJob: true,
        headTransition: null,
        source: "github_webhook", prUrl: "https://github.com/acme/widgets/pull/44",
      });
      expect(first).toMatchObject({
        kind: "advanced", jobAdmitted: true, deduped: false, superseded: 0,
        previousHeadSha: null, headChanged: true,
        record: {
          currentPrHeadSha: firstHead,
          currentPrHeadAuthoritative: true,
          headShas: [firstHead],
        },
      });
      if (first.kind !== "advanced") throw new Error("expected first head advance");
      await db.update(reviewJobs).set({ state: "running", claimedBy: "worker:one", claimedAt: new Date() })
        .where(eq(reviewJobs.id, first.jobId));

      const secondInput = {
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 44,
        headSha: secondHead, event: "synchronize" as const, deliveryId: "delivery-head-b",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: firstHead, afterHeadSha: secondHead },
        source: "github_webhook" as const, prUrl: "https://github.com/acme/widgets/pull/44",
      };
      const second = await advanceConfirmedAcceptanceRecordPullRequestHead(secondInput);
      expect(second).toMatchObject({
        kind: "advanced", jobAdmitted: true, deduped: false, superseded: 1,
        previousHeadSha: firstHead, headChanged: true,
        record: { currentPrHeadSha: secondHead, headShas: [firstHead, secondHead] },
      });
      expect((await db.select().from(reviewJobs).where(eq(reviewJobs.id, first.jobId)))[0]?.state)
        .toBe("superseded");

      const replay = await advanceConfirmedAcceptanceRecordPullRequestHead(secondInput);
      expect(replay).toMatchObject({
        kind: "delivery_replayed", currentHeadSha: secondHead,
        currentHeadCycleId: second.kind === "advanced" ? second.jobId : "missing",
        currentAuthoritative: true, authorityGeneration: 2,
      });
      const provenance = await db.select().from(changeRecordEvents)
        .where(eq(changeRecordEvents.recordId, draft.record.id));
      expect(provenance).toEqual(expect.arrayContaining([
        expect.objectContaining({
          eventKey: `external-pr:attached:44:${first.jobId}`,
          payloadRef: expect.objectContaining({
            kind: "external_pr_attachment", previousHeadSha: null,
            event: "opened", deliveryId: "delivery-head-a",
          }),
        }),
        expect.objectContaining({
          eventKey: `external-pr:head-advanced:44:${second.kind === "advanced" ? second.jobId : "missing"}`,
          payloadRef: expect.objectContaining({
            kind: "external_pr_head_advanced", previousHeadSha: firstHead,
            event: "synchronize", deliveryId: "delivery-head-b",
          }),
        }),
      ]));
      expect(provenance.filter((event) =>
        event.eventKey === `external-pr:head-advanced:44:${second.kind === "advanced" ? second.jobId : "missing"}`
      )).toHaveLength(1);

      const delayedOldHead = await advanceConfirmedAcceptanceRecordPullRequestHead({
        ...secondInput,
        headSha: firstHead,
        deliveryId: "delivery-delayed-old-head",
        headTransition: { beforeHeadSha: "9".repeat(40), afterHeadSha: firstHead },
      });
      expect(delayedOldHead).toMatchObject({
        kind: "stale_delivery", superseded: 1, previewBootsTornDown: 0,
      });
      expect((await db.select().from(changeRecords).where(eq(changeRecords.id, draft.record.id)))[0])
        .toMatchObject({
          currentPrHeadSha: secondHead,
          currentPrHeadAuthoritative: false,
          headShas: [firstHead, secondHead],
        });
      if (second.kind !== "advanced") throw new Error("expected second head advance");
      expect((await db.select().from(reviewJobs).where(eq(reviewJobs.id, second.jobId)))[0]?.state)
        .toBe("superseded");
      const heldEvents = await db.select().from(changeRecordEvents).where(
        eq(changeRecordEvents.recordId, draft.record.id)
      );
      expect(heldEvents).toEqual(expect.arrayContaining([expect.objectContaining({
        eventKey: "external-pr:head-transition-held:44:delivery-delayed-old-head",
        payloadRef: {
          kind: "external_pr_head_transition_held",
          currentHeadSha: secondHead,
          currentHeadCycleId: second.jobId,
          authorityGenerationBefore: 2,
          authorityGenerationAfter: 3,
          observedHeadSha: firstHead,
          event: "synchronize",
          deliveryId: "delivery-delayed-old-head",
          headTransition: { beforeHeadSha: "9".repeat(40), afterHeadSha: firstHead },
          acceptanceContractVersion: 1,
        },
      })]));
      await expect(advanceConfirmedAcceptanceRecordPullRequestHead({
        ...secondInput,
        event: "ready_for_review",
        deliveryId: "delivery-blocked-same-head-ready",
        headTransition: null,
      })).resolves.toMatchObject({
        kind: "stale_delivery", superseded: 0, previewBootsTornDown: 0,
      });
      expect((await db.select().from(changeRecords).where(eq(changeRecords.id, draft.record.id)))[0])
        .toMatchObject({ currentPrHeadSha: secondHead, currentPrHeadAuthoritative: false });
    });

    it("reconciles only its blocked authority generation and never replays an old delivery over the new head", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId, repo: "acme/widgets", workKey: "reconcile-authority-generation",
        originChannel: "codex_mcp", contract: completeContract(), createdBy: "user:lead",
      });
      await db.update(acceptanceContracts).set({
        status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date(),
      }).where(eq(acceptanceContracts.id, draft.contract.id));
      const headA = "a".repeat(40);
      const headB = "b".repeat(40);
      const headC = "c".repeat(40);
      const initial = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 145,
        headSha: headA, event: "opened", deliveryId: "reconcile-open-a", admitReviewJob: true,
        headTransition: null, source: "github_webhook",
      });
      if (initial.kind !== "advanced") throw new Error("expected initial head");
      const heldInput = {
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 145,
        headSha: headB, event: "synchronize" as const, deliveryId: "reconcile-held-b", admitReviewJob: true,
        headTransition: { beforeHeadSha: "d".repeat(40), afterHeadSha: headB }, source: "github_webhook" as const,
      };
      const held = await advanceConfirmedAcceptanceRecordPullRequestHead(heldInput);
      expect(held).toMatchObject({
        kind: "stale_delivery", blockedHeadSha: headA, blockedCycleId: initial.jobId,
        authorityGeneration: 2, replayed: false,
      });
      if (held.kind !== "stale_delivery") throw new Error("expected held delivery");
      await expect(advanceConfirmedAcceptanceRecordPullRequestHead(heldInput)).resolves.toMatchObject({
        kind: "stale_delivery", replayed: true, blockedHeadSha: headA,
        authorityGeneration: 2, superseded: 0, previewBootsTornDown: 0,
      });
      await db.update(changeRecordEvents).set({ actor: "corrupt:out-of-band" }).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey, "external-pr:head-transition-held:145:reconcile-held-b"),
      ));
      await expect(advanceConfirmedAcceptanceRecordPullRequestHead(heldInput)).resolves.toMatchObject({
        kind: "delivery_replayed", currentHeadSha: headA,
        currentHeadCycleId: initial.jobId, currentAuthoritative: false, authorityGeneration: 2,
      });
      await db.update(changeRecordEvents).set({ actor: "github_webhook" }).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey, "external-pr:head-transition-held:145:reconcile-held-b"),
      ));

      const reconciled = await reconcileConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 145,
        expectedBlockedHeadSha: held.blockedHeadSha,
        expectedBlockedCycleId: held.blockedCycleId!,
        expectedBlockedAuthorityGeneration: held.authorityGeneration,
        observedHeadSha: headC, observedBaseSha: "e".repeat(40), observedState: "open",
        observedDraft: false, observedMerged: false, source: "github_app_api",
      });
      expect(reconciled).toMatchObject({
        kind: "reconciled", observedHeadSha: headC, jobAdmitted: true,
        authorityGeneration: 3, record: { currentPrHeadSha: headC, currentPrHeadAuthoritative: true },
      });
      await expect(reconcileConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 145,
        expectedBlockedHeadSha: held.blockedHeadSha,
        expectedBlockedCycleId: held.blockedCycleId!,
        expectedBlockedAuthorityGeneration: held.authorityGeneration,
        observedHeadSha: headC, observedBaseSha: "e".repeat(40), observedState: "open",
        observedDraft: false, observedMerged: false, source: "github_app_api",
      })).resolves.toMatchObject({ kind: "already_current", jobAdmitted: true, authorityGeneration: 3 });
      const replay = await advanceConfirmedAcceptanceRecordPullRequestHead(heldInput);
      expect(replay).toMatchObject({
        kind: "delivery_replayed", currentHeadSha: headC, currentAuthoritative: true, authorityGeneration: 3,
      });
    });

    it("does not let a replayed terminal delivery revoke a later reconciled head", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId, repo: "acme/widgets", workKey: "terminal-delivery-replay",
        originChannel: "codex_mcp", contract: completeContract(), createdBy: "user:lead",
      });
      await db.update(acceptanceContracts).set({
        status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date(),
      }).where(eq(acceptanceContracts.id, draft.contract.id));
      const headA = "1".repeat(40);
      const headC = "3".repeat(40);
      const initial = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 146,
        headSha: headA, event: "opened", deliveryId: "terminal-open-a", admitReviewJob: true,
        headTransition: null, source: "github_webhook",
      });
      if (initial.kind !== "advanced") throw new Error("expected initial head");
      const terminalInput = {
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 146,
        headSha: headA, event: "closed" as const, deliveryId: "terminal-close-a", source: "github_webhook" as const,
      };
      const terminal = await invalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEvent(terminalInput);
      expect(terminal).toMatchObject({ kind: "invalidated", inserted: true, authorityGeneration: 2 });
      const reconciled = await reconcileConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 146,
        expectedBlockedHeadSha: headA, expectedBlockedCycleId: initial.jobId,
        expectedBlockedAuthorityGeneration: 2,
        observedHeadSha: headC, observedBaseSha: "4".repeat(40), observedState: "open",
        observedDraft: false, observedMerged: false, source: "github_app_api",
      });
      expect(reconciled).toMatchObject({ kind: "reconciled", authorityGeneration: 3 });
      await expect(invalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEvent(terminalInput))
        .resolves.toMatchObject({
          kind: "invalidated", inserted: false, currentHeadSha: headC,
          currentAuthoritative: true, authorityGeneration: 3,
        });
    });

    it("accepts a draft reconciliation retry after a signed ready event admits its same cycle", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId, repo: "acme/widgets", workKey: "reconcile-draft-ready-retry",
        originChannel: "codex_mcp", contract: completeContract(), createdBy: "user:lead",
      });
      await db.update(acceptanceContracts).set({
        status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date(),
      }).where(eq(acceptanceContracts.id, draft.contract.id));
      const headA = "a".repeat(40);
      const headC = "c".repeat(40);
      const initial = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 149,
        headSha: headA, event: "opened", deliveryId: "draft-reconcile-open", admitReviewJob: true,
        headTransition: null, source: "github_webhook",
      });
      if (initial.kind !== "advanced") throw new Error("expected initial head");
      const held = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 149,
        headSha: "b".repeat(40), event: "synchronize", deliveryId: "draft-reconcile-held", admitReviewJob: false,
        headTransition: { beforeHeadSha: "d".repeat(40), afterHeadSha: "b".repeat(40) }, source: "github_webhook",
      });
      if (held.kind !== "stale_delivery") throw new Error("expected held delivery");
      const reconcileInput = {
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 149,
        expectedBlockedHeadSha: held.blockedHeadSha,
        expectedBlockedCycleId: held.blockedCycleId!,
        expectedBlockedAuthorityGeneration: held.authorityGeneration,
        observedHeadSha: headC, observedBaseSha: "e".repeat(40), observedState: "open" as const,
        observedDraft: true, observedMerged: false, source: "github_app_api" as const,
      };
      const reconciled = await reconcileConfirmedAcceptanceRecordPullRequestHead(reconcileInput);
      expect(reconciled).toMatchObject({ kind: "reconciled", jobAdmitted: false });
      const ready = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 149,
        headSha: headC, event: "ready_for_review", deliveryId: "draft-reconcile-ready", admitReviewJob: true,
        headTransition: null, source: "github_webhook",
      });
      expect(ready).toMatchObject({ kind: "advanced", jobAdmitted: true, headChanged: false });
      await expect(reconcileConfirmedAcceptanceRecordPullRequestHead(reconcileInput)).resolves.toMatchObject({
        kind: "already_current", jobAdmitted: true, authorityGeneration: 3,
      });
    });

    it("rejects an API reconciliation when a later signed delivery advanced the blocked generation", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId, repo: "acme/widgets", workKey: "reconcile-generation-race",
        originChannel: "codex_mcp", contract: completeContract(), createdBy: "user:lead",
      });
      await db.update(acceptanceContracts).set({
        status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date(),
      }).where(eq(acceptanceContracts.id, draft.contract.id));
      const headA = "5".repeat(40);
      const initial = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 147,
        headSha: headA, event: "opened", deliveryId: "race-open-a", admitReviewJob: true,
        headTransition: null, source: "github_webhook",
      });
      if (initial.kind !== "advanced") throw new Error("expected initial head");
      const firstHeld = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 147,
        headSha: "6".repeat(40), event: "synchronize", deliveryId: "race-held-b", admitReviewJob: true,
        headTransition: { beforeHeadSha: "7".repeat(40), afterHeadSha: "6".repeat(40) }, source: "github_webhook",
      });
      if (firstHeld.kind !== "stale_delivery") throw new Error("expected first held delivery");
      await expect(advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 147,
        headSha: "8".repeat(40), event: "synchronize", deliveryId: "race-later-held-c", admitReviewJob: true,
        headTransition: { beforeHeadSha: "9".repeat(40), afterHeadSha: "8".repeat(40) }, source: "github_webhook",
      })).resolves.toMatchObject({ kind: "stale_delivery", authorityGeneration: 3 });
      await expect(reconcileConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 147,
        expectedBlockedHeadSha: firstHeld.blockedHeadSha,
        expectedBlockedCycleId: firstHeld.blockedCycleId!,
        expectedBlockedAuthorityGeneration: firstHeld.authorityGeneration,
        observedHeadSha: "a".repeat(40), observedBaseSha: "b".repeat(40), observedState: "open",
        observedDraft: false, observedMerged: false, source: "github_app_api",
      })).resolves.toMatchObject({
        kind: "blocked_precondition_changed", currentHeadSha: headA,
        currentAuthoritative: false, authorityGeneration: 3,
      });
      expect((await db.select().from(changeRecords).where(eq(changeRecords.id, draft.record.id)))[0])
        .toMatchObject({ currentPrHeadSha: headA, currentPrHeadAuthoritative: false, currentPrHeadAuthorityGeneration: 3 });
    });

    it("persists a closed GitHub reconciliation once and keeps its authority revoked on replay", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId, repo: "acme/widgets", workKey: "reconcile-closed-replay",
        originChannel: "codex_mcp", contract: completeContract(), createdBy: "user:lead",
      });
      await db.update(acceptanceContracts).set({
        status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date(),
      }).where(eq(acceptanceContracts.id, draft.contract.id));
      const headA = "a".repeat(40);
      const initial = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 148,
        headSha: headA, event: "opened", deliveryId: "closed-reconcile-open", admitReviewJob: true,
        headTransition: null, source: "github_webhook",
      });
      if (initial.kind !== "advanced") throw new Error("expected initial head");
      const held = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 148,
        headSha: "b".repeat(40), event: "synchronize", deliveryId: "closed-reconcile-held", admitReviewJob: true,
        headTransition: { beforeHeadSha: "c".repeat(40), afterHeadSha: "b".repeat(40) }, source: "github_webhook",
      });
      if (held.kind !== "stale_delivery") throw new Error("expected held delivery");
      const closedInput = {
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 148,
        expectedBlockedHeadSha: held.blockedHeadSha,
        expectedBlockedCycleId: held.blockedCycleId!,
        expectedBlockedAuthorityGeneration: held.authorityGeneration,
        observedHeadSha: "d".repeat(40), observedBaseSha: "e".repeat(40), observedState: "closed" as const,
        observedDraft: false, observedMerged: true, source: "github_app_api" as const,
      };
      await expect(reconcileConfirmedAcceptanceRecordPullRequestHead(closedInput)).resolves.toMatchObject({
        kind: "closed", currentHeadSha: headA, currentAuthoritative: false, authorityGeneration: 3,
      });
      await expect(reconcileConfirmedAcceptanceRecordPullRequestHead(closedInput)).resolves.toMatchObject({
        kind: "closed", currentHeadSha: headA, currentAuthoritative: false,
        authorityGeneration: 3, superseded: 0, previewBootsTornDown: 0,
      });
      const events = await db.select().from(changeRecordEvents).where(eq(changeRecordEvents.recordId, draft.record.id));
      expect(events.filter((event) => event.payloadRef.kind === "external_pr_head_reconciliation_closed")).toHaveLength(1);
    });

    it("invalidates a draft synchronize without admitting work, then admits the same head when ready", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId, repo: "acme/widgets", workKey: "draft-head-invalidation",
        originChannel: "codex_mcp", contract: completeContract(), createdBy: "user:lead",
      });
      await db.update(acceptanceContracts).set({
        status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date(),
      }).where(eq(acceptanceContracts.id, draft.contract.id));
      const firstHead = "1".repeat(40);
      const draftHead = "2".repeat(40);
      const first = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 46,
        headSha: firstHead, event: "opened", deliveryId: "delivery-before-draft",
        admitReviewJob: true, headTransition: null, source: "github_webhook",
      });
      if (first.kind !== "advanced") throw new Error("expected initial review admission");
      await db.update(reviewJobs).set({ state: "running", claimedBy: "worker:draft", claimedAt: new Date() })
        .where(eq(reviewJobs.id, first.jobId));

      const draftInput = {
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 46,
        headSha: draftHead, event: "synchronize" as const, deliveryId: "delivery-draft-head",
        admitReviewJob: false,
        headTransition: { beforeHeadSha: firstHead, afterHeadSha: draftHead },
        source: "github_webhook" as const,
      };
      const advancedDraft = await advanceConfirmedAcceptanceRecordPullRequestHead(draftInput);
      expect(advancedDraft).toMatchObject({
        kind: "advanced", jobAdmitted: false, deduped: false, superseded: 1,
        previousHeadSha: firstHead, headChanged: true,
        record: { currentPrHeadSha: draftHead, currentPrHeadAuthoritative: true },
      });
      if (advancedDraft.kind !== "advanced") throw new Error("expected draft head advance");
      expect(await db.select().from(reviewJobs).where(eq(reviewJobs.id, advancedDraft.jobId)))
        .toHaveLength(0);
      await expect(advanceConfirmedAcceptanceRecordPullRequestHead(draftInput)).resolves.toMatchObject({
        kind: "delivery_replayed", currentHeadSha: draftHead,
        currentHeadCycleId: advancedDraft.jobId,
        currentAuthoritative: true, authorityGeneration: 2,
      });

      const readyInput = {
        ...draftInput,
        event: "ready_for_review" as const,
        deliveryId: "delivery-ready-head",
        admitReviewJob: true,
        headTransition: null,
      };
      const ready = await advanceConfirmedAcceptanceRecordPullRequestHead(readyInput);
      expect(ready).toMatchObject({
        kind: "advanced", jobAdmitted: true, deduped: false, superseded: 0,
        previousHeadSha: draftHead, headChanged: false,
      });
      if (ready.kind !== "advanced") throw new Error("expected ready review admission");
      expect((await db.select().from(reviewJobs).where(eq(reviewJobs.id, ready.jobId)))[0])
        .toMatchObject({ headSha: draftHead, event: "ready_for_review", state: "queued" });
      await expect(advanceConfirmedAcceptanceRecordPullRequestHead(readyInput)).resolves.toMatchObject({
        kind: "delivery_replayed", currentHeadSha: draftHead,
        currentHeadCycleId: advancedDraft.jobId,
        currentAuthoritative: true, authorityGeneration: 2,
      });
    });

    it("atomically revokes exact-head authority and active work on a signed merged delivery", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId, repo: "acme/widgets", workKey: "terminal-head-invalidation",
        originChannel: "codex_mcp", contract: completeContract(), createdBy: "user:lead",
      });
      await db.update(acceptanceContracts).set({
        status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date(),
      }).where(eq(acceptanceContracts.id, draft.contract.id));
      const currentHead = "d".repeat(40);
      const observedMergeHead = "e".repeat(40);
      const advanced = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 43,
        headSha: currentHead, event: "opened", deliveryId: "terminal-before-merge",
        admitReviewJob: true, headTransition: null, source: "github_webhook",
      });
      if (advanced.kind !== "advanced") throw new Error("expected terminal test head admission");
      await db.update(reviewJobs).set({ state: "running" }).where(eq(reviewJobs.id, advanced.jobId));
      const boot = await enqueueCurrentReviewJobPreviewBoot({
        workspaceId: wsId, recordId: draft.record.id, jobId: advanced.jobId,
        repo: "acme/widgets", prNumber: 43, headSha: currentHead, ref: "refs/pull/43/head",
      });
      await db.update(previewBoots).set({
        status: "ready", url: "http://terminal-preview.test", port: 3100,
      }).where(eq(previewBoots.id, boot.id));

      const input = {
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 43,
        headSha: observedMergeHead, event: "merged" as const,
        deliveryId: "terminal-merged-delivery", source: "github_webhook" as const,
      };
      const invalidated = await invalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEvent(input);
      expect(invalidated).toMatchObject({
        kind: "invalidated", inserted: true, superseded: 1, previewBootsTornDown: 1,
        currentHeadSha: currentHead, currentHeadCycleId: advanced.jobId,
      });
      expect((await db.select().from(changeRecords).where(eq(changeRecords.id, draft.record.id)))[0])
        .toMatchObject({
          currentPrHeadSha: currentHead,
          currentPrHeadCycleId: advanced.jobId,
          currentPrHeadAuthoritative: false,
          headShas: [currentHead],
        });
      expect((await db.select().from(reviewJobs).where(eq(reviewJobs.id, advanced.jobId)))[0]?.state)
        .toBe("superseded");
      expect((await db.select().from(previewBoots).where(eq(previewBoots.id, boot.id)))[0])
        .toMatchObject({ status: "torn_down", reason: "acceptance record PR closed or merged" });
      expect((await db.select().from(changeRecordEvents).where(
        eq(changeRecordEvents.id, invalidated.kind === "invalidated" ? invalidated.provenanceEventId : randomUUID())
      ))[0]).toMatchObject({
        eventKey: "external-pr:head-invalidated:43:terminal-merged-delivery",
        payloadRef: {
          kind: "external_pr_head_invalidated_terminal",
          repo: "acme/widgets",
          prNumber: 43,
          currentHeadSha: currentHead,
          currentHeadCycleId: advanced.jobId,
          observedHeadSha: observedMergeHead,
          event: "merged",
          deliveryId: "terminal-merged-delivery",
          acceptanceContractVersion: 1,
        },
      });
      await expect(invalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEvent(input))
        .resolves.toMatchObject({
          kind: "invalidated", inserted: false, superseded: 0, previewBootsTornDown: 0,
          currentHeadSha: currentHead, currentHeadCycleId: advanced.jobId,
        });
    });

    it("creates a fresh cycle, event, and job for every repeated-SHA transition", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId, repo: "acme/widgets", workKey: "repeated-sha-cycles",
        originChannel: "codex_mcp", contract: completeContract(), createdBy: "user:lead",
      });
      await db.update(acceptanceContracts).set({
        status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date(),
      }).where(eq(acceptanceContracts.id, draft.contract.id));
      const headA = "a".repeat(40);
      const headB = "b".repeat(40);
      const headC = "c".repeat(40);
      const advance = async (input: {
        headSha: string;
        event: "opened" | "synchronize";
        deliveryId: string;
        beforeHeadSha: string | null;
      }) => {
        const headTransition = input.beforeHeadSha === null ? null : {
          beforeHeadSha: input.beforeHeadSha,
          afterHeadSha: input.headSha,
        };
        const result = await advanceConfirmedAcceptanceRecordPullRequestHead({
          workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 48,
          headSha: input.headSha, event: input.event, deliveryId: input.deliveryId,
          admitReviewJob: true, headTransition, source: "github_webhook",
        });
        if (result.kind !== "advanced") throw new Error(`expected ${input.deliveryId} advance`);
        expect(result.jobId).toBe(acceptanceRecordPullRequestHeadCycleId({
          workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 48,
          headSha: input.headSha, event: input.event, deliveryId: input.deliveryId, headTransition,
        }));
        return result;
      };

      const a1 = await advance({ headSha: headA, event: "opened", deliveryId: "cycle-a-1", beforeHeadSha: null });
      const b = await advance({ headSha: headB, event: "synchronize", deliveryId: "cycle-b", beforeHeadSha: headA });
      const a2 = await advance({ headSha: headA, event: "synchronize", deliveryId: "cycle-a-2", beforeHeadSha: headB });
      const c = await advance({ headSha: headC, event: "synchronize", deliveryId: "cycle-c", beforeHeadSha: headA });
      const a3 = await advance({ headSha: headA, event: "synchronize", deliveryId: "cycle-a-3", beforeHeadSha: headC });

      expect(new Set([a1.jobId, a2.jobId, a3.jobId]).size).toBe(3);
      const aJobs = await db.select().from(reviewJobs).where(eq(reviewJobs.headSha, headA));
      expect(aJobs).toHaveLength(3);
      expect(aJobs.map((job) => job.id).sort()).toEqual([a1.jobId, a2.jobId, a3.jobId].sort());
      expect((await db.select().from(changeRecords).where(eq(changeRecords.id, draft.record.id)))[0])
        .toMatchObject({
          currentPrHeadSha: headA,
          currentPrHeadCycleId: a3.jobId,
          currentPrHeadAuthoritative: true,
          headShas: [headA, headB, headC],
        });
      const events = await db.select().from(changeRecordEvents).where(
        eq(changeRecordEvents.recordId, draft.record.id)
      );
      expect(events.filter((event) =>
        event.eventKey.startsWith("external-pr:head-advanced:48:")
        || event.eventKey.startsWith("external-pr:attached:48:")
      )).toHaveLength(5);
      expect([a1, b, a2, c].every((cycle) => cycle.jobId !== a3.jobId)).toBe(true);

      await db.update(reviewJobs).set({ state: "running" }).where(eq(reviewJobs.id, a1.jobId));
      await expect(appendCurrentReviewJobEventsAtomically({
        workspaceId: wsId, recordId: draft.record.id, jobId: a1.jobId,
        repo: "acme/widgets", prNumber: 48, headSha: headA,
        events: [{ eventKey: "cycle:stale-a1", stage: "review", actor: "reviewer-of-record", payloadRef: { cycle: a1.jobId } }],
      })).rejects.toMatchObject({
        code: "CURRENT_REVIEW_JOB_NOT_CURRENT", reason: "record_not_current",
      });
    });

    it("cycle-binds preview boots and tears them down across draft, revisit, and route races", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId, repo: "acme/widgets", workKey: "cycle-preview-boots",
        originChannel: "codex_mcp", contract: completeContract(), createdBy: "user:lead",
      });
      await db.update(acceptanceContracts).set({
        status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date(),
      }).where(eq(acceptanceContracts.id, draft.contract.id));
      const headA = "5".repeat(40);
      const headB = "6".repeat(40);
      const headC = "7".repeat(40);
      const a1 = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 49,
        headSha: headA, event: "opened", deliveryId: "preview-cycle-a1",
        admitReviewJob: true, headTransition: null, source: "github_webhook",
      });
      if (a1.kind !== "advanced") throw new Error("expected preview A1 cycle");
      await db.update(reviewJobs).set({ state: "running" }).where(eq(reviewJobs.id, a1.jobId));
      const bootInput = (jobId: string, headSha: string) => ({
        workspaceId: wsId, recordId: draft.record.id, jobId,
        repo: "acme/widgets", prNumber: 49, headSha, ref: `refs/pull/49/head`,
      });
      const bootA1 = await enqueueCurrentReviewJobPreviewBoot(bootInput(a1.jobId, headA));
      expect(bootA1).toEqual({
        id: previewBootId({ workspaceId: wsId, repo: "acme/widgets", prNumber: 49, headSha: headA, cycleId: a1.jobId }),
        deduped: false,
        superseded: 0,
      });
      await expect(enqueueCurrentReviewJobPreviewBoot(bootInput(a1.jobId, headA)))
        .resolves.toMatchObject({ id: bootA1.id, deduped: true, superseded: 0 });
      await db.update(previewBoots).set({ status: "ready", url: "http://preview-a1.test", port: 3100 })
        .where(eq(previewBoots.id, bootA1.id));

      const bDraft = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 49,
        headSha: headB, event: "synchronize", deliveryId: "preview-cycle-b-draft",
        admitReviewJob: false,
        headTransition: { beforeHeadSha: headA, afterHeadSha: headB },
        source: "github_webhook",
      });
      expect(bDraft).toMatchObject({
        kind: "advanced", jobAdmitted: false, previewBootsTornDown: 1,
      });
      if (bDraft.kind !== "advanced") throw new Error("expected draft B cycle");
      expect((await db.select().from(previewBoots).where(eq(previewBoots.id, bootA1.id)))[0])
        .toMatchObject({ status: "torn_down", reason: "acceptance record head advanced" });

      const bReady = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 49,
        headSha: headB, event: "ready_for_review", deliveryId: "preview-cycle-b-ready",
        admitReviewJob: true, headTransition: null, source: "github_webhook",
      });
      if (bReady.kind !== "advanced") throw new Error("expected ready B cycle");
      expect(bReady.jobId).toBe(bDraft.jobId);
      await db.update(reviewJobs).set({ state: "running" }).where(eq(reviewJobs.id, bReady.jobId));
      const bootB = await enqueueCurrentReviewJobPreviewBoot(bootInput(bReady.jobId, headB));

      const a2 = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 49,
        headSha: headA, event: "synchronize", deliveryId: "preview-cycle-a2",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: headB, afterHeadSha: headA },
        source: "github_webhook",
      });
      expect(a2).toMatchObject({ kind: "advanced", previewBootsTornDown: 1 });
      if (a2.kind !== "advanced") throw new Error("expected preview A2 cycle");
      expect(a2.jobId).not.toBe(a1.jobId);
      expect((await db.select().from(previewBoots).where(eq(previewBoots.id, bootB.id)))[0]?.status)
        .toBe("torn_down");
      await db.update(reviewJobs).set({ state: "running" }).where(eq(reviewJobs.id, a2.jobId));
      const bootA2 = await enqueueCurrentReviewJobPreviewBoot(bootInput(a2.jobId, headA));
      expect(bootA2.id).not.toBe(bootA1.id);
      await expect(enqueueCurrentReviewJobPreviewBoot(bootInput(a1.jobId, headA)))
        .rejects.toMatchObject({
          code: "CURRENT_REVIEW_JOB_NOT_CURRENT", reason: "record_not_current",
        });

      const [racingBoot, racingHead] = await Promise.allSettled([
        enqueueCurrentReviewJobPreviewBoot(bootInput(a2.jobId, headA)),
        advanceConfirmedAcceptanceRecordPullRequestHead({
          workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 49,
          headSha: headC, event: "synchronize", deliveryId: "preview-cycle-c-draft",
          admitReviewJob: false,
          headTransition: { beforeHeadSha: headA, afterHeadSha: headC },
          source: "github_webhook",
        }),
      ]);
      expect(racingHead.status).toBe("fulfilled");
      if (racingBoot.status === "rejected") {
        expect(racingBoot.reason).toMatchObject({ code: "CURRENT_REVIEW_JOB_NOT_CURRENT" });
      }
      expect((await db.select().from(previewBoots).where(eq(previewBoots.id, bootA2.id)))[0]?.status)
        .toBe("torn_down");
      const activeBoots = await db.select().from(previewBoots).where(sql`
        ${previewBoots.workspaceId} = ${wsId}
        AND ${previewBoots.repo} = 'acme/widgets'
        AND ${previewBoots.prNumber} = 49
        AND ${previewBoots.status} IN ('pending', 'claimed', 'booting', 'ready')
      `);
      expect(activeBoots).toHaveLength(0);
    });

    it("appends post-review events only for the locked current running head", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId, repo: "acme/widgets", workKey: "guarded-current-head-events",
        originChannel: "codex_mcp", contract: completeContract(), createdBy: "user:lead",
      });
      await db.update(acceptanceContracts).set({
        status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date(),
      }).where(eq(acceptanceContracts.id, draft.contract.id));
      const headSha = "c".repeat(40);
      const advance = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 45,
        headSha, event: "opened", deliveryId: "delivery-current-head",
        admitReviewJob: true,
        headTransition: null,
        source: "github_webhook",
      });
      if (advance.kind !== "advanced") throw new Error("expected head advance");
      const guardedInput = {
        workspaceId: wsId, recordId: draft.record.id, jobId: advance.jobId,
        repo: "acme/widgets", prNumber: 45, headSha,
        events: [{
          eventKey: `review:reservation:${advance.jobId}`,
          stage: "review", actor: "reviewer-of-record",
          payloadRef: { kind: "correction_reservation", headSha },
        }],
      };
      await expect(appendCurrentReviewJobEventsAtomically(guardedInput))
        .rejects.toThrow("running review job");
      await db.update(reviewJobs).set({ state: "running", claimedBy: "worker:two", claimedAt: new Date() })
        .where(eq(reviewJobs.id, advance.jobId));
      const first = await appendCurrentReviewJobEventsAtomically(guardedInput);
      const replay = await appendCurrentReviewJobEventsAtomically(guardedInput);
      expect(first.events).toEqual([expect.objectContaining({ inserted: true })]);
      expect(replay.events).toEqual([expect.objectContaining({ inserted: false })]);

      const nextHead = "d".repeat(40);
      await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 45,
        headSha: nextHead, event: "synchronize", deliveryId: "delivery-next-head",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: headSha, afterHeadSha: nextHead },
        source: "github_webhook",
      });
      await expect(appendCurrentReviewJobEventsAtomically(guardedInput))
        .rejects.toThrow("current PR head");
      expect((await db.select().from(changeRecords).where(eq(changeRecords.id, draft.record.id)))[0])
        .toMatchObject({ currentPrHeadSha: nextHead, headShas: [headSha, nextHead] });
    });

    it("reads only the complete current correction packet custody and fails closed for foreign or malformed rows", async () => {
      const repo = "acme/widgets";
      const prNumber = 145;
      const headSha = "1".repeat(40);
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId, repo, workKey: "current-correction-packet-read",
        originChannel: "codex_mcp", contract: completeContract(), createdBy: "user:lead",
      });
      await db.update(acceptanceContracts).set({
        status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date(),
      }).where(eq(acceptanceContracts.id, draft.contract.id));
      const current = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo, prNumber, headSha,
        event: "opened", deliveryId: "current-correction-packet-open", admitReviewJob: true,
        headTransition: null, source: "github_webhook",
      });
      if (current.kind !== "advanced") throw new Error("expected current correction packet head");

      await expect(readCurrentAcceptanceCorrectionPackets({
        workspaceId: wsId, recordId: draft.record.id,
      })).resolves.toEqual({ kind: "not_ready", reason: "no_correction_packets" });

      const packet = await appendExactCurrentCorrectionPacket({
        workspaceId: wsId, recordId: draft.record.id, jobId: current.jobId,
        repo, prNumber, headSha, acceptanceContractId: draft.contract.id,
      });
      const expectedContractSha256 = acceptanceContractSha256({
        acceptanceContractId: draft.contract.id,
        acceptanceContractVersion: draft.contract.version,
        contract: draft.contract.contract,
      });
      const result = await readCurrentAcceptanceCorrectionPackets({
        workspaceId: wsId, recordId: draft.record.id,
      });
      expect(result).toEqual({
        kind: "current",
        binding: {
          workspaceId: wsId,
          recordId: draft.record.id,
          reviewJobId: current.jobId,
          repo,
          prNumber,
          headSha,
          headCycleId: current.jobId,
          authorityGeneration: 1,
          acceptanceContract: {
            id: draft.contract.id,
            version: draft.contract.version,
            sha256: expectedContractSha256,
          },
        },
        packetIds: [packet.packetId],
        packetSetSha256: acceptanceContextPacketSetSha256({ packetIds: [packet.packetId] }),
        correctionPacketPayloadSetSha256: acceptanceCorrectionPacketPayloadSetSha256({ packets: [packet] }),
        packets: [packet],
      });

      const foreignWorkspace = (await db.insert(workspaces).values({
        name: "foreign current packet workspace",
        slug: `foreign-current-packets-${randomUUID()}`,
      }).returning({ id: workspaces.id }))[0]!;
      try {
        await expect(readCurrentAcceptanceCorrectionPackets({
          workspaceId: foreignWorkspace.id,
          recordId: draft.record.id,
        })).resolves.toEqual({ kind: "not_found" });
      } finally {
        await db.delete(workspaces).where(eq(workspaces.id, foreignWorkspace.id));
      }

      await db.update(acceptanceContracts).set({ status: "draft" })
        .where(eq(acceptanceContracts.id, draft.contract.id));
      await expect(readCurrentAcceptanceCorrectionPackets({
        workspaceId: wsId, recordId: draft.record.id,
      })).resolves.toEqual({ kind: "not_ready", reason: "confirmed_contract_unavailable" });
      await db.update(acceptanceContracts).set({ status: "confirmed" })
        .where(eq(acceptanceContracts.id, draft.contract.id));

      const packetEventWhere = and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey, `review:correction:${current.jobId}:AC-1`),
      );
      await db.update(changeRecordEvents).set({ actor: "server:forged-packet" }).where(packetEventWhere);
      await expect(readCurrentAcceptanceCorrectionPackets({
        workspaceId: wsId, recordId: draft.record.id,
      })).resolves.toEqual({ kind: "not_ready", reason: "invalid_packet_custody" });
      await db.update(changeRecordEvents).set({ actor: "reviewer-of-record", stage: "builder_handoff" })
        .where(packetEventWhere);
      await expect(readCurrentAcceptanceCorrectionPackets({
        workspaceId: wsId, recordId: draft.record.id,
      })).resolves.toEqual({ kind: "not_ready", reason: "invalid_packet_custody" });
      await db.update(changeRecordEvents).set({
        stage: "review",
        payloadRef: {
          ...packet,
          criterion: { id: "AC-1", snapshot: "A drifted criterion snapshot" },
          expected: "A drifted criterion snapshot",
        },
      }).where(packetEventWhere);
      await expect(readCurrentAcceptanceCorrectionPackets({
        workspaceId: wsId, recordId: draft.record.id,
      })).resolves.toEqual({ kind: "not_ready", reason: "invalid_packet_custody" });
      await db.update(changeRecordEvents).set({ payloadRef: packet }).where(packetEventWhere);

      await appendChangeRecordEvent({
        recordId: draft.record.id,
        eventKey: `review:correction:${current.jobId}:AC-FORGED`,
        stage: "review",
        actor: "reviewer-of-record",
        payloadRef: { ...packet, packetId: `correction-${"f".repeat(48)}` },
      });
      const partial = await readCurrentAcceptanceCorrectionPackets({
        workspaceId: wsId, recordId: draft.record.id,
      });
      expect(partial).toEqual({ kind: "not_ready", reason: "invalid_packet_custody" });
      expect(partial).not.toMatchObject({ kind: "current", packetIds: [packet.packetId] });
    });

    it("does not inherit or revive historical correction packets across A-to-B-to-A head cycles", async () => {
      const repo = "acme/widgets";
      const prNumber = 146;
      const headA = "a".repeat(40);
      const headB = "b".repeat(40);
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId, repo, workKey: "correction-packet-cycle-revisit",
        originChannel: "codex_mcp", contract: completeContract(), createdBy: "user:lead",
      });
      await db.update(acceptanceContracts).set({
        status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date(),
      }).where(eq(acceptanceContracts.id, draft.contract.id));
      const a1 = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo, prNumber, headSha: headA,
        event: "opened", deliveryId: "correction-packet-cycle-a1", admitReviewJob: true,
        headTransition: null, source: "github_webhook",
      });
      if (a1.kind !== "advanced") throw new Error("expected A1 correction packet cycle");
      const packetA1 = await appendExactCurrentCorrectionPacket({
        workspaceId: wsId, recordId: draft.record.id, jobId: a1.jobId,
        repo, prNumber, headSha: headA, acceptanceContractId: draft.contract.id,
        observed: "A1 did not retain the filter.",
      });
      await expect(readCurrentAcceptanceCorrectionPackets({
        workspaceId: wsId, recordId: draft.record.id,
      })).resolves.toMatchObject({
        kind: "current", binding: { headSha: headA, headCycleId: a1.jobId },
        packetIds: [packetA1.packetId],
      });

      const [racingRead, b] = await Promise.all([
        readCurrentAcceptanceCorrectionPackets({ workspaceId: wsId, recordId: draft.record.id }),
        advanceConfirmedAcceptanceRecordPullRequestHead({
          workspaceId: wsId, recordId: draft.record.id, repo, prNumber, headSha: headB,
          event: "synchronize", deliveryId: "correction-packet-cycle-b", admitReviewJob: true,
          headTransition: { beforeHeadSha: headA, afterHeadSha: headB }, source: "github_webhook",
        }),
      ]);
      if (b.kind !== "advanced") throw new Error("expected B correction packet cycle");
      if (racingRead.kind === "current") {
        expect(racingRead).toMatchObject({
          binding: { headSha: headA, headCycleId: a1.jobId },
          packetIds: [packetA1.packetId],
        });
      } else {
        expect(racingRead).toEqual({ kind: "not_ready", reason: "no_correction_packets" });
      }
      await expect(readCurrentAcceptanceCorrectionPackets({
        workspaceId: wsId, recordId: draft.record.id,
      })).resolves.toEqual({ kind: "not_ready", reason: "no_correction_packets" });

      const a2 = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo, prNumber, headSha: headA,
        event: "synchronize", deliveryId: "correction-packet-cycle-a2", admitReviewJob: true,
        headTransition: { beforeHeadSha: headB, afterHeadSha: headA }, source: "github_webhook",
      });
      if (a2.kind !== "advanced") throw new Error("expected A2 correction packet cycle");
      expect(a2.jobId).not.toBe(a1.jobId);
      await expect(readCurrentAcceptanceCorrectionPackets({
        workspaceId: wsId, recordId: draft.record.id,
      })).resolves.toEqual({ kind: "not_ready", reason: "no_correction_packets" });

      const packetA2 = await appendExactCurrentCorrectionPacket({
        workspaceId: wsId, recordId: draft.record.id, jobId: a2.jobId,
        repo, prNumber, headSha: headA, acceptanceContractId: draft.contract.id,
        observed: "A2 still did not retain the filter.",
      });
      expect(packetA2.packetId).not.toBe(packetA1.packetId);
      await expect(readCurrentAcceptanceCorrectionPackets({
        workspaceId: wsId, recordId: draft.record.id,
      })).resolves.toMatchObject({
        kind: "current",
        binding: { headSha: headA, headCycleId: a2.jobId, reviewJobId: a2.jobId },
        packetIds: [packetA2.packetId],
        packets: [expect.objectContaining({ jobId: a2.jobId, observed: "A2 still did not retain the filter." })],
      });

      await invalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEvent({
        workspaceId: wsId, recordId: draft.record.id, repo, prNumber,
        headSha: headA, event: "closed", deliveryId: "correction-packet-cycle-closed",
        source: "github_webhook",
      });
      await expect(readCurrentAcceptanceCorrectionPackets({
        workspaceId: wsId, recordId: draft.record.id,
      })).resolves.toEqual({ kind: "not_current" });
    });

    it("keeps draft opened/reopened heads jobless and fail-closes a non-synchronize head change", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId, repo: "acme/widgets", workKey: "draft-opened-reopened",
        originChannel: "codex_mcp", contract: completeContract(), createdBy: "user:lead",
      });
      await db.update(acceptanceContracts).set({
        status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date(),
      }).where(eq(acceptanceContracts.id, draft.contract.id));
      const openedHead = "3".repeat(40);
      const reopenedHead = "4".repeat(40);
      const openedInput = {
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 47,
        headSha: openedHead, event: "opened" as const, deliveryId: "delivery-draft-opened",
        admitReviewJob: false, headTransition: null, source: "github_webhook" as const,
      };
      const opened = await advanceConfirmedAcceptanceRecordPullRequestHead(openedInput);
      expect(opened).toMatchObject({
        kind: "advanced", jobAdmitted: false, deduped: false,
        record: { currentPrHeadSha: openedHead, currentPrHeadAuthoritative: true },
      });
      if (opened.kind !== "advanced") throw new Error("expected draft opened head");
      expect(await db.select().from(reviewJobs).where(eq(reviewJobs.id, opened.jobId)))
        .toHaveLength(0);

      const ready = await advanceConfirmedAcceptanceRecordPullRequestHead({
        ...openedInput,
        event: "ready_for_review",
        deliveryId: "delivery-opened-ready",
        admitReviewJob: true,
      });
      if (ready.kind !== "advanced") throw new Error("expected current-head job admission");
      const reopened = await advanceConfirmedAcceptanceRecordPullRequestHead({
        ...openedInput,
        headSha: reopenedHead,
        event: "reopened",
        deliveryId: "delivery-draft-reopened",
        admitReviewJob: false,
      });
      expect(reopened).toMatchObject({
        kind: "stale_delivery", superseded: 1, previewBootsTornDown: 0,
      });
      expect((await db.select().from(changeRecords).where(eq(changeRecords.id, draft.record.id)))[0])
        .toMatchObject({
          currentPrHeadSha: openedHead,
          currentPrHeadAuthoritative: false,
          headShas: [openedHead],
        });
      expect((await db.select().from(reviewJobs).where(eq(reviewJobs.id, ready.jobId)))[0]?.state)
        .toBe("superseded");
      expect(await db.select().from(reviewJobs).where(eq(reviewJobs.headSha, reopenedHead)))
        .toHaveLength(0);
    });

    it("records one server-registered Builder route against exactly one confirmed Contract", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        workKey: "builder-route-selection",
        originChannel: "codex_mcp",
        contract: completeContract(),
        createdBy: "user:lead",
      });
      await expect(recordAcceptanceBuilderRouteSelection({
        workspaceId: wsId,
        recordId: draft.record.id,
        selectedBy: "user:lead",
        routeId: randomUUID(),
      })).rejects.toThrow("exactly one confirmed Contract");

      await db.update(acceptanceContracts).set({
        status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date(),
      }).where(eq(acceptanceContracts.id, draft.contract.id));
      await db.update(workspaces).set({
        githubInstallationId: "installation-builder-route-1",
        githubInstallationAccountLogin: "acme",
        githubInstallationAccountType: "Organization",
      })
        .where(eq(workspaces.id, wsId));
      const registered = await registerAcceptanceBuilderRoute({
        workspaceId: wsId, repo: "acme/widgets", adapter: "github_codex",
        configurationVersion: 2, registeredBy: "server:environment",
      });
      const profileInput = {
        workspaceId: wsId,
        routeId: registered.route.id,
        recordedBy: "server:route-capability-profile",
      };
      const profile = await recordAcceptanceBuilderRouteCapabilityProfile(profileInput);
      const profileReplay = await recordAcceptanceBuilderRouteCapabilityProfile(profileInput);
      expect(profile).toMatchObject({ inserted: true, profile: {
        routeId: registered.route.id,
        workspaceId: wsId,
        repo: "acme/widgets",
        adapter: "github_codex",
        routeConfigurationVersion: 2,
        githubInstallationIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        snapshot: {
          kind: "acceptance_builder_route_capability_profile",
          version: 1,
          workspaceId: wsId,
          repo: "acme/widgets",
          routeId: registered.route.id,
          adapter: "github_codex",
          routeConfigurationVersion: 2,
          carrier: "github_issue_comment",
          recipient: "codex",
          findingPublication: "individual_no_vendor_mentions",
          activation: "single_final_vendor_mention",
          vendorAvailability: "not_asserted",
          scopeBoundary: "correction_delivery_only",
          githubInstallationIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      } });
      expect(profileReplay).toMatchObject({ inserted: false, profile: { id: profile.profile.id } });
      await expect(resolveAcceptanceBuilderRouteCapabilityProfile({
        workspaceId: wsId, routeId: registered.route.id,
      })).resolves.toMatchObject({ id: profile.profile.id });
      const input = {
        workspaceId: wsId,
        recordId: draft.record.id,
        selectedBy: "user:lead",
        routeId: registered.route.id,
      };
      const first = await recordAcceptanceBuilderRouteSelection(input);
      const replay = await recordAcceptanceBuilderRouteSelection(input);
      expect(first).toMatchObject({ inserted: true, event: {
        eventKey: "acceptance-builder-route:selected", stage: "builder_handoff",
      } });
      expect(replay).toMatchObject({ inserted: false, event: { id: first.event.id } });
      const otherRoute = await registerAcceptanceBuilderRoute({
        workspaceId: wsId, repo: "acme/widgets", adapter: "github_claude",
        configurationVersion: 1, registeredBy: "server:environment",
      });
      await expect(recordAcceptanceBuilderRouteSelection({
        ...input, routeId: otherRoute.route.id,
      })).rejects.toThrow("already bound to different stage, actor, or payloadRef");
      await expect(readAcceptanceBuilderRouteSelection({
        workspaceId: wsId, recordId: draft.record.id,
      })).resolves.toMatchObject({ selection: { routeId: registered.route.id }, route: {
        id: registered.route.id, adapter: "github_codex", configurationVersion: 2,
      }, snapshot: {
        capability: { availability: "unverified", activation: "github_mention", acknowledgement: "vendor_activity", repairHead: "github_synchronize" }, scopeBoundary: "correction_delivery_only",
      } });

      const routeHeadA = "8".repeat(40);
      const routeHeadB = "9".repeat(40);
      await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 41,
        headSha: routeHeadA, event: "opened", deliveryId: "builder-route-head-a",
        admitReviewJob: true, headTransition: null, source: "github_webhook",
      });
      await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 41,
        headSha: routeHeadB, event: "synchronize", deliveryId: "builder-route-head-b",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: routeHeadA, afterHeadSha: routeHeadB },
        source: "github_webhook",
      });
      await expect(readAcceptanceBuilderRouteSelection({
        workspaceId: wsId, recordId: draft.record.id,
      })).resolves.toMatchObject({
        selection: { routeId: registered.route.id },
        event: { eventKey: "acceptance-builder-route:selected" },
      });

      await db.update(acceptanceBuilderRoutes).set({ configurationVersion: 3 })
        .where(eq(acceptanceBuilderRoutes.id, registered.route.id));
      await expect(readAcceptanceBuilderRouteSelection({
        workspaceId: wsId, recordId: draft.record.id,
      })).resolves.toBeNull();
      await expect(resolveAcceptanceBuilderRouteCapabilityProfile({
        workspaceId: wsId, routeId: registered.route.id,
      })).resolves.toBeNull();
    });

    it("records an immutable exact-head Context Pack source snapshot and rejects conflicting replay", async () => {
      const headSha = "a".repeat(40);
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId, repo: "acme/widgets", workKey: "exact-head-snapshot",
        originChannel: "codex_mcp", contract: completeContract(), createdBy: "user:lead",
      });
      await db.update(acceptanceContracts).set({
        status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date(),
      }).where(eq(acceptanceContracts.id, draft.contract.id));
      const admittedJob = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 42,
        headSha, event: "opened", deliveryId: "delivery-snapshot-head",
        admitReviewJob: true, headTransition: null, source: "github_webhook",
      });
      if (admittedJob.kind !== "advanced") throw new Error("expected snapshot review admission");
      const job = { id: admittedJob.jobId };
      const packetId = reviewJobCorrectionPacketId({
        jobId: job.id, criterionId: "AC-1", headSha, recordId: draft.record.id,
        acceptanceContractId: draft.contract.id, acceptanceContractVersion: 1,
      });
      const packetIds = [packetId];
      const packetPayload = {
        kind: "review_job_correction_packet", version: 1, packetId, workspaceId: wsId,
        repo: "acme/widgets", prNumber: 42, headSha, recordId: draft.record.id, jobId: job.id,
        acceptanceContract: { id: draft.contract.id, version: 1 },
        criterion: { id: "AC-1", snapshot: "A user can save a filter" },
        basis: "acceptance_contract" as const, state: "failed" as const,
        expected: "A user can save a filter", observed: "The saved filter was not retained.",
        affectedContext: {
          modality: "ui", environmentKind: "isolated_preview", flow: "Save a filter, reload, and inspect it.",
          reproduction: { modality: "ui", steps: [
            { action: "open", path: "/filters" },
            { action: "expect_text", text: "Saved filters" },
            { action: "screenshot", label: "saved-filter" },
          ] },
        },
        evidence: {
          evidenceRef: "ui-execution:execution-1", artifactKey: "review/ui/execution-1.png",
          executionId: "execution-1", previewBootId: "preview-boot-1",
        },
        scopeBoundary: `Only AC-1 for acme/widgets#42 at ${headSha}.`,
        impact: "The server-attested UI receipt shows this confirmed criterion failed on the exact head.",
        requiredCorrection: "Make the persisted UI flow retain the saved filter.",
        reverification: "Rerun the persisted UI plan against the next exact head.",
      };
      await appendChangeRecordEvent({
        recordId: draft.record.id, eventKey: `review:correction:${job.id}:AC-1`, stage: "review",
        actor: "reviewer-of-record", payloadRef: packetPayload,
      });
      const repository = (await db.insert(repositories).values({
        workspaceId: wsId, name: "acme/widgets", url: "https://github.com/acme/widgets",
      }).returning())[0]!;
      const wikiBody = "# Widgets\n\nThe saved-filter boundary.";
      const wiki = (await db.insert(wikiPages).values({
        workspaceId: wsId, repositoryId: repository.id, slug: "wiki/overview", title: "Widgets",
        kind: "overview", bodyMd: wikiBody, commitSha: "1".repeat(40), inputsHash: "2".repeat(64),
        generatedAt: new Date(),
      }).returning())[0]!;
      await db.insert(wikiPages).values({
        workspaceId: wsId, repositoryId: repository.id, slug: "wiki/not-admitted", title: "Not admitted",
        kind: "overview", bodyMd: "This page is not part of the source snapshot.",
        commitSha: "1".repeat(40), inputsHash: "3".repeat(64), generatedAt: new Date(),
      });
      const baseIndexCore = {
        schemaVersion: 2 as const, backgroundOnly: true as const,
        pages: [{ id: wiki.id, repositoryId: repository.id, slug: "wiki/overview", commitSha: "1".repeat(40), inputsHashSha256: "2".repeat(64), pageBodySha256: wikiPageBodySha256(wikiBody), stale: false }], gaps: [],
      };
      const overlayCore = {
        schemaVersion: 2 as const, baseSha: "b".repeat(40), mergeBaseSha: "8".repeat(40), headSha,
        files: [{ path: "apps/console/page.tsx", status: "modified" as const, blobSha: "3".repeat(40), previousPath: null, patchSha256: "4".repeat(64), patchByteCount: 100, headRanges: [{ startLine: 4, endLine: 28, coordinateSha256: acceptanceContextOverlayHeadRangeCoordinateSha256({ path: "apps/console/page.tsx", patchSha256: "4".repeat(64), startLine: 4, endLine: 28 }) }]}],
      };
      const input = {
        workspaceId: wsId, recordId: draft.record.id, reviewJobId: job.id,
        acceptanceContractId: draft.contract.id, acceptanceContractVersion: 1,
        acceptanceContractSha256: acceptanceContractSha256({ acceptanceContractId: draft.contract.id, acceptanceContractVersion: 1, contract: draft.contract.contract }),
        repo: "acme/widgets", prNumber: 42, expectedHeadSha: headSha,
        baseSha: "b".repeat(40), mergeBaseSha: "8".repeat(40), headTreeSha: "c".repeat(40),
        packetIds, packetSetSha256: acceptanceContextPacketSetSha256({ packetIds }),
        correctionPacketPayloadSetSha256: acceptanceCorrectionPacketPayloadSetSha256({ packets: [packetPayload] }),
        compilerVersion: "exact-head-overlay-v1",
        baseIndex: { ...baseIndexCore, revisionSha256: acceptanceContextPackCustodyBaseIndexRevisionSha256(baseIndexCore) },
        overlay: { ...overlayCore, manifestSha256: acceptanceContextPackCustodyOverlayManifestSha256(overlayCore) },
        provenance: { schemaVersion: 1 as const, included: [
          { path: "wiki/overview", source: "base_index" as const, reason: "Background Wiki page" },
          { path: "apps/console/page.tsx", source: "overlay" as const, reason: "PR changed file" },
        ], excluded: [] },
        status: "admitted" as const, reason: null,
      };
      const first = await recordAcceptanceContextPackSnapshot(input);
      const replay = await recordAcceptanceContextPackSnapshot(input);
      expect(first).toMatchObject({ inserted: true, snapshot: { expectedHeadSha: headSha, status: "admitted" } });
      expect(replay).toMatchObject({ inserted: false, snapshot: { id: first.snapshot.id } });
      const custody = await resolveAcceptanceContextPackCustody({
        workspaceId: wsId,
        sourceSnapshotId: first.snapshot.id,
      });
      expect(custody.sourceSnapshot).toMatchObject({
        id: first.snapshot.id,
        workspaceId: wsId,
        repo: "acme/widgets",
      });
      expect(custody.wikiPages).toEqual([expect.objectContaining({ id: wiki.id, bodyMd: wikiBody })]);
      await expect(resolveAcceptanceContextPackCustody({
        workspaceId: wsId,
        sourceSnapshotId: randomUUID(),
      })).rejects.toThrow("snapshot is missing, legacy, or not admitted");
      await db.update(wikiPages).set({ bodyMd: "x".repeat(512 * 1024 + 1) }).where(eq(wikiPages.id, wiki.id));
      await expect(resolveAcceptanceContextPackCustody({
        workspaceId: wsId,
        sourceSnapshotId: first.snapshot.id,
      })).rejects.toThrow("body bounds no longer match");
      await db.update(wikiPages).set({ bodyMd: wikiBody }).where(eq(wikiPages.id, wiki.id));
      await expect(recordAcceptanceContextPackSnapshot({ ...input, baseSha: "9".repeat(40) }))
        .rejects.toThrow("Invalid exact-head Context Pack snapshot");
      await expect(recordAcceptanceContextPackSnapshot({
        ...input, packetIds: ["correction-" + "e".repeat(48)],
        packetSetSha256: acceptanceContextPacketSetSha256({ packetIds: ["correction-" + "e".repeat(48)] }),
      })).rejects.toThrow("not the complete exact R8.1 payload set");
      await appendChangeRecordEvent({
        recordId: draft.record.id,
        eventKey: `review:correction:${job.id}:AC-FORGED`,
        stage: "review",
        actor: "reviewer-of-record",
        payloadRef: {
          kind: "review_job_correction_packet",
          version: 1,
          packetId: "correction-" + "f".repeat(48),
          workspaceId: wsId,
          repo: "acme/widgets",
        },
      });
      await expect(recordAcceptanceContextPackSnapshot(input))
        .rejects.toThrow("not the complete exact R8.1 payload set");
      const nextHeadSha = "f".repeat(40);
      await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 42,
        headSha: nextHeadSha, event: "synchronize", deliveryId: "delivery-snapshot-next-head",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: headSha, afterHeadSha: nextHeadSha },
        source: "github_webhook",
      });
      const revisitedHead = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 42,
        headSha, event: "synchronize", deliveryId: "delivery-snapshot-revisited-head",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: nextHeadSha, afterHeadSha: headSha },
        source: "github_webhook",
      });
      expect(revisitedHead).toMatchObject({
        kind: "advanced", record: { currentPrHeadSha: headSha },
      });
      if (revisitedHead.kind !== "advanced") throw new Error("expected snapshot head revisit");
      expect(revisitedHead.jobId).not.toBe(job.id);
      await expect(recordAcceptanceContextPackSnapshot(input))
        .rejects.toThrow("Record head is not current");
      await expect(resolveAcceptanceContextPackCustody({
        workspaceId: wsId,
        sourceSnapshotId: first.snapshot.id,
      })).rejects.toThrow("Record head is no longer current");
      const rows = await db.select().from(acceptanceContextPackSnapshots)
        .where(eq(acceptanceContextPackSnapshots.id, first.snapshot.id));
      expect(rows).toHaveLength(1);
    });

    it("persists only a revalidated metadata-only compiled Pack and rejects divergent replay", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId, repo: "acme/widgets", workKey: "compiled-pack-custody", originChannel: "codex_mcp",
        contract: completeContract(), createdBy: "user:lead",
      });
      await db.update(acceptanceContracts).set({
        status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date(),
      }).where(eq(acceptanceContracts.id, draft.contract.id));
      await db.update(workspaces).set({
        githubInstallationId: "installation-dispatch-profile",
        githubInstallationAccountLogin: "acme",
        githubInstallationAccountType: "Organization",
      })
        .where(eq(workspaces.id, wsId));
      const selectedRoute = await registerAcceptanceBuilderRoute({
        workspaceId: wsId, repo: "acme/widgets", adapter: "github_claude",
        configurationVersion: 1, registeredBy: "server:environment",
      });
      const routeSelection = await recordAcceptanceBuilderRouteSelection({
        workspaceId: wsId, recordId: draft.record.id, selectedBy: "user:lead", routeId: selectedRoute.route.id,
      });
      const headSha = "a".repeat(40);
      const admittedJob = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 43,
        headSha, event: "opened", deliveryId: "delivery-compiled-head",
        admitReviewJob: true, headTransition: null, source: "github_webhook",
      });
      if (admittedJob.kind !== "advanced") throw new Error("expected compiled Pack review admission");
      const job = { id: admittedJob.jobId };
      const packetId = reviewJobCorrectionPacketId({
        jobId: job.id, criterionId: "AC-1", headSha, recordId: draft.record.id,
        acceptanceContractId: draft.contract.id, acceptanceContractVersion: 1,
      });
      const packet = {
        kind: "review_job_correction_packet", version: 1, packetId, workspaceId: wsId, repo: "acme/widgets", prNumber: 43,
        headSha, recordId: draft.record.id, jobId: job.id, acceptanceContract: { id: draft.contract.id, version: 1 },
        criterion: { id: "AC-1", snapshot: "A user can save a filter" }, basis: "acceptance_contract", state: "failed",
        expected: "A user can save a filter", observed: "Not implemented", affectedContext: {
          modality: "ui", environmentKind: null, flow: "Save a filter", reproduction: { modality: "ui", steps: [{ action: "open", path: "/filters" }] },
        }, evidence: { evidenceRef: "review:AC-1", previewBootId: "boot-1" }, scopeBoundary: "Filter save flow", impact: "Users cannot save", requiredCorrection: "Implement save", reverification: "Repeat flow",
      };
      await appendChangeRecordEvent({ recordId: draft.record.id, eventKey: `review:correction:${job.id}:AC-1`, stage: "review", actor: "reviewer-of-record", payloadRef: packet });
      const repo = await db.insert(repositories).values({
        workspaceId: wsId, name: "acme/widgets", url: "https://github.com/acme/widgets",
      }).returning();
      const wiki = await db.insert(wikiPages).values({
        workspaceId: wsId, repositoryId: repo[0]!.id, slug: "wiki/overview", title: "Widgets",
        kind: "overview", commitSha: "d".repeat(40), inputsHash: "e".repeat(64),
        bodyMd: "Background", generatedAt: new Date(),
      }).returning();
      const baseIndexCore = { schemaVersion: 2 as const, backgroundOnly: true as const, pages: [{
        id: wiki[0]!.id, repositoryId: repo[0]!.id, slug: "wiki/overview", commitSha: "d".repeat(40), inputsHashSha256: "e".repeat(64), pageBodySha256: wikiPageBodySha256("Background"), stale: false,
      }], gaps: [] };
      const patchSha256 = "4".repeat(64);
      const dependencyContent = "export const helper = true;";
      const dependencyBytes = Buffer.from(dependencyContent, "utf8");
      const dependencyBlobSha = createHash("sha1")
        .update(`blob ${dependencyBytes.length}\0`, "utf8").update(dependencyBytes).digest("hex");
      const treeBody = Buffer.concat([Buffer.from("100644 helper.ts\0", "utf8"), Buffer.from(dependencyBlobSha, "hex")]);
      const headTreeSha = createHash("sha1").update(`tree ${treeBody.length}\0`, "utf8").update(treeBody).digest("hex");
      const dependencyTreeProof: ExactGitTreeInclusionProof = {
        kind: "exact_git_tree_inclusion_batch", version: 1, headTreeSha,
        trees: [{ sha1: headTreeSha, bodyBase64: treeBody.toString("base64") }],
        paths: [{ path: "helper.ts", blobSha: dependencyBlobSha }],
      };
      const exactSourceContent = Array.from({ length: 28 }, (_, index) => `line-${index + 1}`).join("\n");
      const exactSourceBytes = Buffer.from(exactSourceContent, "utf8");
      const exactBlobSha = createHash("sha1")
        .update(`blob ${exactSourceBytes.length}\0`, "utf8").update(exactSourceBytes).digest("hex");
      const exactFullContentSha256 = createHash("sha256").update(exactSourceBytes).digest("hex");
      const exactRangeContent = exactSourceContent.split("\n").slice(3, 28).join("\n");
      const exactRangeSha256 = createHash("sha256").update(exactRangeContent, "utf8").digest("hex");
      const exactRangeByteCount = Buffer.byteLength(exactRangeContent, "utf8");
      const range = { startLine: 4, endLine: 28, coordinateSha256: acceptanceContextOverlayHeadRangeCoordinateSha256({ path: "apps/filter.ts", patchSha256, startLine: 4, endLine: 28 }) };
      const overlayCore = { schemaVersion: 2 as const, baseSha: "b".repeat(40), mergeBaseSha: "8".repeat(40), headSha, files: [{
        path: "apps/filter.ts", status: "modified" as const, blobSha: exactBlobSha, previousPath: null, patchSha256, patchByteCount: 100, headRanges: [range],
      }] };
      const snapshot = await recordAcceptanceContextPackSnapshot({
        workspaceId: wsId, recordId: draft.record.id, reviewJobId: job.id, acceptanceContractId: draft.contract.id, acceptanceContractVersion: 1,
        acceptanceContractSha256: acceptanceContractSha256({ acceptanceContractId: draft.contract.id, acceptanceContractVersion: 1, contract: draft.contract.contract }),
        repo: "acme/widgets", prNumber: 43, expectedHeadSha: headSha, baseSha: "b".repeat(40), mergeBaseSha: "8".repeat(40), headTreeSha,
        packetIds: [packetId], packetSetSha256: acceptanceContextPacketSetSha256({ packetIds: [packetId] }), correctionPacketPayloadSetSha256: acceptanceCorrectionPacketPayloadSetSha256({ packets: [packet] }),
        compilerVersion: "exact-head-overlay-v1", baseIndex: { ...baseIndexCore, revisionSha256: acceptanceContextPackCustodyBaseIndexRevisionSha256(baseIndexCore) },
        overlay: { ...overlayCore, manifestSha256: acceptanceContextPackCustodyOverlayManifestSha256(overlayCore) },
        provenance: { schemaVersion: 1, included: [{ path: "wiki/overview", source: "base_index", reason: "Background" }, { path: "apps/filter.ts", source: "overlay", reason: "Changed" }], excluded: [] }, status: "admitted", reason: null,
      });
      const source = { kind: "exact_head_overlay" as const, path: "apps/filter.ts", blobSha: exactBlobSha, fullContentSha256: exactFullContentSha256, startLine: 4, endLine: 28, rangeSha256: exactRangeSha256, byteCount: exactRangeByteCount, reason: "exact_patch_head_range", citation: `apps/filter.ts@${exactBlobSha}#L4-L28` };
      const dependencySource = {
        kind: "exact_head_dependency" as const, path: "helper.ts", blobSha: dependencyBlobSha,
        fullContentSha256: createHash("sha256").update(dependencyBytes).digest("hex"), startLine: 1, endLine: 1,
        rangeSha256: createHash("sha256").update(dependencyBytes).digest("hex"), byteCount: dependencyBytes.length,
        reason: "static_relative_import", citation: `helper.ts@${dependencyBlobSha}#L1-L1`,
      };
      const receiptCore = {
        kind: "exact_head_source_custody" as const, schemaVersion: 2 as const, repo: "acme/widgets", prNumber: 43, baseSha: "b".repeat(40), mergeBaseSha: "8".repeat(40), headSha, headTreeSha,
        manifestSha256: acceptanceContextOverlayManifestSha256({ schemaVersion: 1, baseSha: "b".repeat(40), mergeBaseSha: "8".repeat(40), headSha, files: [{ path: "apps/filter.ts", status: "modified" as const, blobSha: exactBlobSha, previousPath: null }] }),
        changedManifest: [{ path: "apps/filter.ts", status: "modified", blobSha: exactBlobSha, previousPath: null, headRanges: [{ startLine: 4, endLine: 28 }], patchSha256, patchByteCount: 100 }],
        records: [{ path: "apps/filter.ts", blobSha: exactBlobSha, previousPath: null, contentSha256: exactFullContentSha256, byteCount: exactSourceBytes.length, lineCount: 28, source: "exact_head_overlay", reason: "exact_base_to_head_compare" }],
        exclusions: [],
        directReadReceipts: [{
          requestedPath: dependencySource.path, headSha, headTreeSha, outcome: "record" as const,
          record: { path: dependencySource.path, blobSha: dependencyBlobSha, previousPath: null, contentSha256: dependencySource.fullContentSha256, byteCount: dependencyBytes.length, lineCount: 1, source: "exact_head_tree_fallback", reason: "exact_head_tree_path" },
        }],
        selectedExactRanges: [
          (({ reason: _reason, citation: _citation, ...rangeIdentity }) => rangeIdentity)(dependencySource),
          (({ reason: _reason, citation: _citation, ...rangeIdentity }) => rangeIdentity)(source),
        ],
      };
      const receipt = { ...receiptCore, identitySha256: acceptanceContextPackCanonicalSha256(receiptCore) };
      const binding = {
        sourceSnapshotId: snapshot.snapshot.id, workspaceId: wsId, recordId: draft.record.id, reviewJobId: job.id, acceptanceContractId: draft.contract.id, acceptanceContractVersion: 1,
        acceptanceContractSha256: acceptanceContractSha256({ acceptanceContractId: draft.contract.id, acceptanceContractVersion: 1, contract: draft.contract.contract }), repo: "acme/widgets", prNumber: 43,
        baseSha: "b".repeat(40), mergeBaseSha: "8".repeat(40), headSha, headTreeSha, packetSetSha256: acceptanceContextPacketSetSha256({ packetIds: [packetId] }),
        correctionPacketPayloadSetSha256: acceptanceCorrectionPacketPayloadSetSha256({ packets: [packet] }), sourceSnapshotCompilerVersion: "exact-head-overlay-v1",
        baseIndexRevisionSha256: acceptanceContextPackCustodyBaseIndexRevisionSha256(baseIndexCore), overlayManifestSha256: acceptanceContextPackCustodyOverlayManifestSha256(overlayCore),
      };
      const compiler = { version: "exact-head-correction-pack-v4", policyVersion: "bounded-exact-ranges-v2", byteCounter: "utf8_byte_upper_bound_v1", byteBudget: 65536 };
      const manifest = { version: 1, acceptanceCriterionIds: ["AC-1"], unresolvedQuestionIds: [], packetIds: [packetId], sources: [dependencySource, source], architectureBoundaries: [], tests: [], decisions: [], exclusions: [], sourceCustody: { kind: "exact_head_source_custody", schemaVersion: 2, identitySha256: receipt.identitySha256 }, budget: { counter: "utf8_byte_upper_bound_v1", limitBytes: 65536 }, custody: { fullSourceUploadAllowed: false, rawSourcePersisted: false, snippetsPersisted: false } };
      const representations = { jsonSha256: "7".repeat(64), markdownSha256: "9".repeat(64) };
      const core = { kind: "compiled_acceptance_context_pack" as const, version: 1 as const, binding, compiler, manifest, sourceCustodyReceipt: { kind: receipt.kind, schemaVersion: receipt.schemaVersion, identitySha256: receipt.identitySha256 }, exactHeadDependencyTreeProofs: [{ path: dependencySource.path, blobSha: dependencyBlobSha, proofIdentitySha256: exactGitTreeInclusionProofIdentity(dependencyTreeProof) }], representations, renderedByteCount: 100 };
      const compiled = { ...core, sourceCustodyReceipt: receipt, packSha256: acceptanceContextPackCanonicalSha256(core) };
      const exactSourceProofs = [{ kind: "exact_head_overlay" as const, path: "apps/filter.ts", content: exactSourceContent }, { kind: "exact_head_dependency" as const, path: dependencySource.path, content: dependencyContent }];
      const persist = (value: typeof compiled) => recordAcceptanceCompiledContextPack({
        workspaceId: wsId, sourceSnapshotId: snapshot.snapshot.id, compiled: value, exactSourceProofs, exactGitTreeInclusionProofs: [dependencyTreeProof],
      });
      const first = await persist(compiled);
      const replay = await persist(compiled);
      expect(first).toMatchObject({ inserted: true, pack: { packSha256: compiled.packSha256 } });
      expect(replay).toMatchObject({ inserted: false, pack: { id: first.pack.id } });
      expect(first.pack.exactHeadDependencyTreeProofs).toEqual(core.exactHeadDependencyTreeProofs);
      expect(JSON.stringify(first.pack)).not.toContain("bodyBase64");
      await expect(queueSelectedCorrectionDispatch({ workspaceId: wsId, compiledPackId: first.pack.id }))
        .rejects.toThrow("capability profile");
      const capability = await recordAcceptanceBuilderRouteCapabilityProfile({
        workspaceId: wsId,
        routeId: selectedRoute.route.id,
        recordedBy: "server:route-capability-profile",
      });
      const acknowledgementProfile = await recordAcceptanceBuilderRouteGithubClaudeAckProfile({
        workspaceId: wsId,
        routeId: selectedRoute.route.id,
        githubRepositoryId: "1001",
        githubRepositoryOwnerId: "1002",
        githubAppBotUserId: "1003",
        githubAppBotLogin: "jace[bot]",
        callerWorkflowRef:
          "acme/widgets/.github/workflows/agentrail-claude-correction.yml@refs/heads/main",
        jobWorkflowRef: `agentrail/jace/.github/workflows/github-claude-correction-ack.yml@${"1".repeat(40)}`,
        jobWorkflowSha: "1".repeat(40),
        claudeActionSha: "6b082c41935b4c8a3b8b0ef85ba4ba4d9eeb8975",
        recordedBy: "server:github-claude-ack-profile",
      });
      expect(acknowledgementProfile).toMatchObject({
        inserted: true,
        profile: {
          routeId: selectedRoute.route.id,
          capabilityProfileId: capability.profile.id,
          oidcAudienceContract: "activation_comment_run_attempt_sha256_v1",
          oidcSubjectContract: "default_repo_ref_legacy_or_immutable_v1",
        },
      });
      const githubQueued = await queueSelectedCorrectionDispatch({ workspaceId: wsId, compiledPackId: first.pack.id });
      const githubQueuedReplay = await queueSelectedCorrectionDispatch({ workspaceId: wsId, compiledPackId: first.pack.id });
      expect(githubQueued).toMatchObject({
        inserted: true,
        dispatch: {
          recordId: draft.record.id, headSha, headCycleId: job.id,
          authorityGeneration: 1, sourceSnapshotId: snapshot.snapshot.id,
          acceptanceContractId: draft.contract.id, acceptanceContractVersion: 1,
          compiledPackId: first.pack.id, compiledPackSha256: compiled.packSha256,
          jsonSha256: representations.jsonSha256, markdownSha256: representations.markdownSha256,
          routeId: selectedRoute.route.id, routeConfigurationVersion: 1,
          capabilityProfileId: capability.profile.id,
          capabilityProfileSnapshot: capability.profile.snapshot,
          capabilityProfileSnapshotSha256: capability.profile.snapshotSha256,
          activationState: "not_started", deliveryState: "queued",
        },
      });
      expect(githubQueuedReplay).toMatchObject({ inserted: false, dispatch: { id: githubQueued.dispatch.id } });
      // The DB custody lane reserves/reports only a carrier-inert
      // authentication/read preflight. It must not project carrier acceptance
      // or agent activity.
      const parallelPreflights = await Promise.all([
        reserveGithubCorrectionCarrierPreflight({ workspaceId: wsId, dispatchId: githubQueued.dispatch.id }),
        reserveGithubCorrectionCarrierPreflight({ workspaceId: wsId, dispatchId: githubQueued.dispatch.id }),
      ]);
      expect(parallelPreflights.map((result) => result.kind).sort()).toEqual(["held", "reserved"]);
      const preflight = parallelPreflights.find((result) => result.kind === "reserved");
      expect(preflight).toMatchObject({
        kind: "reserved", inserted: true,
        preflight: {
          dispatchId: githubQueued.dispatch.id, recordId: draft.record.id,
          headSha, baseSha: "b".repeat(40), headCycleId: job.id, authorityGeneration: 1,
          capabilityProfileId: capability.profile.id,
          githubInstallationIdentitySha256: capability.profile.githubInstallationIdentitySha256,
          permissionContract: "issues_write_and_pull_requests_write_v1",
          attempt: 1, status: "reserved", result: null,
        },
      });
      if (!preflight || preflight.kind !== "reserved") throw new Error("expected preflight reservation");
      // A retargeted base with the identical PR head invalidates this Context
      // Pack binding before a carrier result can be accepted.
      await db.update(acceptanceContextPackSnapshots).set({ baseSha: "e".repeat(40) })
        .where(eq(acceptanceContextPackSnapshots.id, snapshot.snapshot.id));
      await expect(reportGithubCorrectionCarrierPreflight({
        workspaceId: wsId, preflightId: preflight.preflight.id,
        outcome: { kind: "ready", headSha, baseSha: "b".repeat(40) },
      })).resolves.toEqual({ kind: "not_current" });
      await db.update(acceptanceContextPackSnapshots).set({ baseSha: "b".repeat(40) })
        .where(eq(acceptanceContextPackSnapshots.id, snapshot.snapshot.id));
      await expect(reserveGithubCorrectionCarrierPreflight({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toMatchObject({ kind: "held", reason: "reserved", preflight: { id: preflight.preflight.id } });
      const preflightResult = await reportGithubCorrectionCarrierPreflight({
        workspaceId: wsId, preflightId: preflight.preflight.id,
        outcome: { kind: "storage_unavailable" },
      });
      expect(preflightResult).toMatchObject({
        kind: "reported", preflight: { id: preflight.preflight.id, status: "indeterminate", result: { kind: "storage_unavailable" } },
      });
      await expect(recordDurableCorrectionDispatchFallback({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toEqual({ kind: "not_eligible" });
      const unavailableAttempt = await reserveGithubCorrectionCarrierPreflight({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      });
      expect(unavailableAttempt).toMatchObject({ kind: "reserved", preflight: { attempt: 2 } });
      if (unavailableAttempt.kind !== "reserved") throw new Error("expected unavailable preflight attempt");
      await expect(reportGithubCorrectionCarrierPreflight({
        workspaceId: wsId, preflightId: unavailableAttempt.preflight.id,
        outcome: { kind: "github_unavailable" },
      })).resolves.toMatchObject({ kind: "reported", preflight: { status: "indeterminate" } });
      await expect(readDurableCorrectionDispatchFallback({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toEqual({ kind: "absent" });
      const preflightFallback = await recordDurableCorrectionDispatchFallback({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      });
      expect(preflightFallback).toMatchObject({ kind: "recorded", fallback: {
        dispatch: { id: githubQueued.dispatch.id }, headSha, headCycleId: job.id,
        lane: "jace_only", trigger: { stage: "github_preflight", attempt: 2,
          reason: "github_unavailable" }, publishedFindings: [],
        truthBoundary: { vendorActivation: "not_proven", agentStarted: "not_proven",
          agentAcknowledged: "not_proven", repairHead: "not_proven" },
      } });
      if (preflightFallback.kind !== "recorded") throw new Error("expected preflight fallback");
      expect(preflightFallback.fallback.notice.body).not.toContain("@");
      await expect(recordDurableCorrectionDispatchFallback({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toMatchObject({ kind: "replayed", fallback: { id: preflightFallback.fallback.id } });
      await db.update(workspaces).set({
        githubInstallationId: "installation-fallback-replay-drift",
        githubInstallationAccountLogin: "different-owner",
        githubInstallationAccountType: "Organization",
      }).where(eq(workspaces.id, wsId));
      await db.update(acceptanceBuilderRoutes).set({ status: "disabled" })
        .where(eq(acceptanceBuilderRoutes.id, selectedRoute.route.id));
      await expect(readDurableCorrectionDispatchFallback({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toMatchObject({ kind: "found", fallback: { id: preflightFallback.fallback.id,
        lane: "jace_only" } });
      await db.update(workspaces).set({
        githubInstallationId: "installation-dispatch-profile",
        githubInstallationAccountLogin: "acme",
        githubInstallationAccountType: "Organization",
      }).where(eq(workspaces.id, wsId));
      await db.update(acceptanceBuilderRoutes).set({ status: "active" })
        .where(eq(acceptanceBuilderRoutes.id, selectedRoute.route.id));
      const fallbackStaleHeadSha = "0".repeat(40);
      const fallbackAdvance = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 43,
        headSha: fallbackStaleHeadSha, event: "synchronize",
        deliveryId: "delivery-fallback-stale-head", admitReviewJob: true,
        headTransition: { beforeHeadSha: headSha, afterHeadSha: fallbackStaleHeadSha },
        source: "github_webhook",
      });
      if (fallbackAdvance.kind !== "advanced") throw new Error("expected fallback head advance");
      await expect(readDurableCorrectionDispatchFallback({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toEqual({ kind: "not_current" });
      const fallbackRevisit = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 43,
        headSha, event: "synchronize", deliveryId: "delivery-fallback-revisited-head",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: fallbackStaleHeadSha, afterHeadSha: headSha },
        source: "github_webhook",
      });
      if (fallbackRevisit.kind !== "advanced") throw new Error("expected fallback head revisit");
      expect(fallbackRevisit.jobId).not.toBe(job.id);
      await expect(readDurableCorrectionDispatchFallback({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toEqual({ kind: "not_current" });
      await expect(recordDurableCorrectionDispatchFallback({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toEqual({ kind: "not_current" });
      // Test-only restore: production keeps the A2 cycle authoritative. This
      // broad fixture restores A1 only to continue unrelated carrier proofs.
      await db.delete(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey,
          `acceptance-correction-dispatch:invalidated:${job.id}`),
      ));
      await db.update(acceptanceCorrectionDispatches).set({
        invalidatedAt: null, invalidationReason: null,
        successorHeadSha: null, successorHeadCycleId: null,
      }).where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id));
      await db.update(changeRecords).set({
        currentPrHeadSha: headSha, currentPrHeadCycleId: job.id,
        currentPrHeadAuthoritative: true, currentPrHeadAuthorityGeneration: 1,
      })
        .where(eq(changeRecords.id, draft.record.id));
      // Test-only rewind: fallback itself has no retry API; this broad fixture
      // removes both exact events and its projection to continue the carrier path.
      await db.delete(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        sql`${changeRecordEvents.eventKey} IN (
          ${`acceptance-correction-dispatch:durable-fallback:reserved:${job.id}`},
          ${`acceptance-correction-dispatch:durable-fallback:recorded:${job.id}`}
        )`,
      ));
      await expect(readDurableCorrectionDispatchFallback({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).rejects.toThrow("projection has no event custody");
      await db.update(acceptanceCorrectionDispatches).set({
        deliveryState: "queued", activationState: "not_started",
      }).where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id));
      const retry = await reserveGithubCorrectionCarrierPreflight({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      });
      expect(retry).toMatchObject({ kind: "reserved", inserted: true, preflight: { attempt: 3, status: "reserved" } });
      if (retry.kind !== "reserved") throw new Error("expected bounded preflight retry");
      await expect(reportGithubCorrectionCarrierPreflight({
        workspaceId: wsId, preflightId: retry.preflight.id,
        outcome: { kind: "ready", headSha, baseSha: "b".repeat(40) },
      })).resolves.toMatchObject({ kind: "reported", preflight: { status: "ready" } });
      await expect(reportGithubCorrectionCarrierPreflight({
        workspaceId: wsId, preflightId: retry.preflight.id,
        outcome: { kind: "ready", headSha, baseSha: "b".repeat(40) },
      })).resolves.toMatchObject({ kind: "replayed", preflight: { id: retry.preflight.id, status: "ready" } });
      await expect(reportGithubCorrectionCarrierPreflight({
        workspaceId: wsId, preflightId: retry.preflight.id,
        outcome: { kind: "remote_head_mismatch", expectedHeadSha: "c".repeat(40), observedHeadSha: "d".repeat(40) },
      })).resolves.toEqual({ kind: "not_current" });
      await expect(reportGithubCorrectionCarrierPreflight({
        workspaceId: wsId, preflightId: retry.preflight.id,
        outcome: { kind: "installation_or_permission_denied" },
      })).rejects.toThrow("already terminal");
      await expect(reserveGithubCorrectionCarrierPreflight({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toMatchObject({ kind: "terminal", preflight: { id: retry.preflight.id, status: "ready" } });
      expect((await db.select().from(acceptanceCorrectionDispatches)
        .where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id)))[0]).toMatchObject({
        deliveryState: "queued", agentState: "not_observed",
        findingsState: "not_started", activationState: "not_started",
      });
      expect(await db.select().from(acceptanceCorrectionDispatchGithubPreflights).where(and(
        eq(acceptanceCorrectionDispatchGithubPreflights.dispatchId, githubQueued.dispatch.id),
        eq(acceptanceCorrectionDispatchGithubPreflights.workspaceId, wsId),
      ))).toHaveLength(3);
      await db.update(workspaces).set({
        githubInstallationId: "installation-preflight-drift",
        githubInstallationAccountLogin: "acme",
        githubInstallationAccountType: "Organization",
      }).where(eq(workspaces.id, wsId));
      await expect(reserveGithubCorrectionCarrierPreflight({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toEqual({ kind: "not_current" });
      await db.update(workspaces).set({
        githubInstallationId: "installation-dispatch-profile",
        githubInstallationAccountLogin: "acme",
        githubInstallationAccountType: "Organization",
      }).where(eq(workspaces.id, wsId));
      const originalDispatchIdentity = githubQueued.dispatch.dispatchIdentitySha256;
      await db.update(acceptanceCorrectionDispatches).set({
        dispatchIdentitySha256: "f".repeat(64),
      }).where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id));
      await expect(reserveGithubCorrectionCarrierPreflight({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toEqual({ kind: "not_current" });
      await db.update(acceptanceCorrectionDispatches).set({
        dispatchIdentitySha256: originalDispatchIdentity,
      }).where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id));
      const preflightResultEvent = (await db.select().from(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey,
          `acceptance-correction-dispatch:github-preflight:result:${job.id}:${retry.preflight.attempt}`),
      )).limit(1))[0]!;
      await db.update(changeRecordEvents).set({ payloadRef: { forged: true } }).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey,
          `acceptance-correction-dispatch:github-preflight:result:${job.id}:${retry.preflight.attempt}`),
      ));
      await expect(reserveGithubCorrectionCarrierPreflight({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).rejects.toThrow("event custody");
      // Migration 0091 deliberately leaves pre-profile rows nullable. A retry
      // must hold that historical aggregate; it may not silently bless or
      // rewrite it with today's capability configuration.
      await db.update(acceptanceCorrectionDispatches).set({
        capabilityProfileId: null,
        capabilityProfileSnapshot: null,
        capabilityProfileSnapshotSha256: null,
      }).where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id));
      await expect(queueSelectedCorrectionDispatch({ workspaceId: wsId, compiledPackId: first.pack.id }))
        .rejects.toThrow("unprofiled selected correction dispatch");
      await db.update(acceptanceCorrectionDispatches).set({
        capabilityProfileId: githubQueued.dispatch.capabilityProfileId,
        capabilityProfileSnapshot: githubQueued.dispatch.capabilityProfileSnapshot,
        capabilityProfileSnapshotSha256: githubQueued.dispatch.capabilityProfileSnapshotSha256,
      }).where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id));
      await db.update(changeRecordEvents).set({ payloadRef: preflightResultEvent.payloadRef }).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey,
          `acceptance-correction-dispatch:github-preflight:result:${job.id}:${retry.preflight.attempt}`),
      ));

      // Two-stage publication: one ordinary finding reservation wins, all
      // findings reach a durable terminal result, then exactly one activation
      // reservation contains the complete immutable packet bundle.
      const findingReservations = await Promise.all([
        reserveNextGithubCorrectionFindingPublication({ workspaceId: wsId, dispatchId: githubQueued.dispatch.id }),
        reserveNextGithubCorrectionFindingPublication({ workspaceId: wsId, dispatchId: githubQueued.dispatch.id }),
      ]);
      expect(findingReservations.map((result) => result.kind).sort()).toEqual(["held", "reserved"]);
      const findingReservation = findingReservations.find((result) => result.kind === "reserved");
      if (!findingReservation || findingReservation.kind !== "reserved") throw new Error("expected finding reservation");
      expect(findingReservation.publication).toMatchObject({
        dispatchId: githubQueued.dispatch.id, packetId, criterionId: "AC-1",
        headSha, baseSha: "b".repeat(40), headCycleId: job.id,
        authorityGeneration: 1, routeId: selectedRoute.route.id,
        capabilityProfileId: capability.profile.id,
        readyPreflightId: retry.preflight.id,
        status: "reserved", githubCommentId: null,
      });
      expect(findingReservation.body).not.toContain("@codex");
      expect(findingReservation.body).not.toContain("@claude");
      await expect(reserveGithubCorrectionCarrierPreflight({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toMatchObject({
        kind: "terminal", preflight: { id: retry.preflight.id, status: "ready", attempt: 3 },
      });
      await expect(reportGithubCorrectionFindingPublication({
        workspaceId: wsId, publicationId: findingReservation.publication.id,
        outcome: { kind: "unknown_post_outcome", reason: "github_unavailable" },
      })).resolves.toMatchObject({ kind: "reported", publication: {
        status: "ambiguous_hold", resultReason: "github_unavailable",
      } });
      await expect(reserveNextGithubCorrectionFindingPublication({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toEqual({ kind: "held", reason: "ambiguous_hold" });
      // Test-only rewind: the production API deliberately provides no retry.
      // Removing the exact result event and projection lets this same fixture
      // continue through the independent accepted-receipt branch.
      await db.delete(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey,
          `acceptance-correction-dispatch:github-finding:result:${job.id}:${packetId}`),
      ));
      await db.update(acceptanceCorrectionDispatchGithubFindingPublications).set({
        status: "reserved", resultReason: null, completedAt: null,
        githubCommentId: null, githubCommentUrl: null,
      }).where(eq(acceptanceCorrectionDispatchGithubFindingPublications.id, findingReservation.publication.id));
      await db.update(acceptanceCorrectionDispatches).set({
        deliveryState: "queued", findingsState: "reserved",
      }).where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id));
      const findingUrl = "https://github.com/acme/widgets/pull/43#issuecomment-91001";
      await expect(reportGithubCorrectionFindingPublication({
        workspaceId: wsId, publicationId: findingReservation.publication.id,
        outcome: { kind: "published", githubCommentId: "91001", githubCommentUrl: findingUrl },
      })).resolves.toMatchObject({ kind: "reported", publication: {
        status: "published", githubCommentId: "91001", githubCommentUrl: findingUrl,
      } });
      await expect(reportGithubCorrectionFindingPublication({
        workspaceId: wsId, publicationId: findingReservation.publication.id,
        outcome: { kind: "published", githubCommentId: "91001", githubCommentUrl: findingUrl },
      })).resolves.toMatchObject({ kind: "replayed" });
      await expect(reserveNextGithubCorrectionFindingPublication({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toMatchObject({ kind: "complete", expected: 1, published: 1, boundedFailed: 0 });
      await expect(reserveGithubCorrectionCarrierPreflight({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toMatchObject({
        kind: "terminal", preflight: { id: retry.preflight.id, status: "ready", attempt: 3 },
      });

      const activationReservations = await Promise.all([
        reserveGithubCorrectionActivation({ workspaceId: wsId, dispatchId: githubQueued.dispatch.id }),
        reserveGithubCorrectionActivation({ workspaceId: wsId, dispatchId: githubQueued.dispatch.id }),
      ]);
      expect(activationReservations.map((result) => result.kind).sort()).toEqual(["held", "reserved"]);
      const activationReservation = activationReservations.find((result) => result.kind === "reserved");
      if (!activationReservation || activationReservation.kind !== "reserved") throw new Error("expected activation reservation");
      expect((activationReservation.body.match(/@claude/g) ?? [])).toHaveLength(1);
      expect(activationReservation.body).not.toContain("@codex");
      expect(activationReservation.body.split(activationReservation.packetBundleBase64url)).toHaveLength(2);
      expect(activationReservation.body.split(activationReservation.packetBundleSha256)).toHaveLength(2);
      const decodedBundle = JSON.parse(Buffer.from(
        activationReservation.packetBundleBase64url, "base64url"
      ).toString("utf8"));
      expect(decodedBundle).toMatchObject({ packets: [{ packetId }], binding: {
        dispatchId: githubQueued.dispatch.id, headSha, baseSha: "b".repeat(40),
        readyPreflight: { id: retry.preflight.id }, recipient: "claude",
      } });
      // Whole-worker restart after activation reservation: the finding phase
      // replays only its terminal summary and activation exposes no second body.
      await expect(reserveNextGithubCorrectionFindingPublication({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toMatchObject({ kind: "complete", expected: 1, published: 1, boundedFailed: 0 });
      await expect(reserveGithubCorrectionActivation({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toEqual({ kind: "held", reason: "reserved" });
      await expect(reportGithubCorrectionActivation({
        workspaceId: wsId, activationId: activationReservation.activation.id,
        outcome: { kind: "unknown_post_outcome", reason: "ambiguous_response" },
      })).resolves.toMatchObject({ kind: "reported", activation: {
        status: "ambiguous_hold", resultReason: "ambiguous_response",
      } });
      await expect(reserveGithubCorrectionActivation({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toEqual({ kind: "held", reason: "ambiguous_hold" });
      const activationFallback = await recordDurableCorrectionDispatchFallback({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      });
      expect(activationFallback).toMatchObject({ kind: "recorded", fallback: {
        lane: "github_findings_and_jace",
        trigger: { stage: "github_activation", activationId: activationReservation.activation.id,
          reason: "ambiguous_response" },
        publishedFindings: [{ packetId, githubCommentId: "91001", githubCommentUrl: findingUrl }],
      } });
      if (activationFallback.kind !== "recorded") throw new Error("expected activation fallback");
      expect(activationFallback.fallback.notice.body).not.toContain("@");
      await expect(readDurableCorrectionDispatchFallback({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toMatchObject({ kind: "found", fallback: {
        id: activationFallback.fallback.id, lane: "github_findings_and_jace",
      } });
      await db.update(acceptanceCorrectionDispatches).set({ findingsState: "not_started" })
        .where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id));
      await expect(readDurableCorrectionDispatchFallback({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).rejects.toThrow("source custody");
      await db.update(acceptanceCorrectionDispatches).set({ findingsState: "terminal" })
        .where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id));
      await db.delete(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        sql`${changeRecordEvents.eventKey} IN (
          ${`acceptance-correction-dispatch:durable-fallback:reserved:${job.id}`},
          ${`acceptance-correction-dispatch:durable-fallback:recorded:${job.id}`}
        )`,
      ));
      await db.update(acceptanceCorrectionDispatches).set({
        deliveryState: "ambiguous_hold", activationState: "ambiguous_hold",
      }).where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id));
      await db.delete(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey,
          `acceptance-correction-dispatch:github-activation:result:${job.id}`),
      ));
      await db.update(acceptanceCorrectionDispatchGithubActivations).set({
        status: "reserved", resultReason: null, completedAt: null,
        githubCommentId: null, githubCommentUrl: null,
      }).where(eq(acceptanceCorrectionDispatchGithubActivations.id, activationReservation.activation.id));
      await db.update(acceptanceCorrectionDispatches).set({
        deliveryState: "queued", activationState: "reserved",
      }).where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id));
      // A known GitHub rejection is terminal and replayed as a bodyless closed
      // result. The worker can restart without creating or exposing a second
      // activation reservation.
      await expect(reportGithubCorrectionActivation({
        workspaceId: wsId, activationId: activationReservation.activation.id,
        outcome: { kind: "bounded_failed", reason: "github_rejected" },
      })).resolves.toMatchObject({ kind: "reported", activation: {
        status: "bounded_failed", resultReason: "github_rejected",
      } });
      await expect(reserveNextGithubCorrectionFindingPublication({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toMatchObject({ kind: "complete", expected: 1, published: 1, boundedFailed: 0 });
      await expect(reserveGithubCorrectionActivation({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toEqual({
        kind: "bounded_failed",
        activationId: activationReservation.activation.id,
        reason: "github_rejected",
      });
      expect((await db.select().from(acceptanceCorrectionDispatches)
        .where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id)))[0]).toMatchObject({
        findingsState: "terminal", activationState: "failed",
        deliveryState: "failed", agentState: "not_observed",
      });
      // Test-only rewind so this fixture can continue through the independent
      // accepted-receipt and cross-table receipt-uniqueness branches.
      await db.delete(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey,
          `acceptance-correction-dispatch:github-activation:result:${job.id}`),
      ));
      await db.update(acceptanceCorrectionDispatchGithubActivations).set({
        status: "reserved", resultReason: null, completedAt: null,
        githubCommentId: null, githubCommentUrl: null,
      }).where(eq(acceptanceCorrectionDispatchGithubActivations.id, activationReservation.activation.id));
      await db.update(acceptanceCorrectionDispatches).set({
        deliveryState: "queued", activationState: "reserved",
      }).where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id));
      await expect(reportGithubCorrectionActivation({
        workspaceId: wsId, activationId: activationReservation.activation.id,
        outcome: { kind: "carrier_accepted", githubCommentId: "91001", githubCommentUrl: findingUrl },
      })).rejects.toThrow("already bound to another finding or activation");
      const activationUrl = "https://github.com/acme/widgets/pull/43#issuecomment-91002";
      await expect(reportGithubCorrectionActivation({
        workspaceId: wsId, activationId: activationReservation.activation.id,
        outcome: { kind: "carrier_accepted", githubCommentId: "91002", githubCommentUrl: activationUrl },
      })).resolves.toMatchObject({ kind: "reported", activation: {
        status: "carrier_accepted", githubCommentId: "91002", githubCommentUrl: activationUrl,
      } });
      await expect(reportGithubCorrectionActivation({
        workspaceId: wsId, activationId: activationReservation.activation.id,
        outcome: { kind: "carrier_accepted", githubCommentId: "91002", githubCommentUrl: activationUrl },
      })).resolves.toMatchObject({ kind: "replayed" });
      expect((await db.select().from(acceptanceCorrectionDispatches)
        .where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id)))[0]).toMatchObject({
        findingsState: "terminal", activationState: "carrier_accepted",
        deliveryState: "carrier_accepted", agentState: "not_observed",
      });
      // A terminal whole-worker retry returns the persisted receipt as truth.
      // It cannot reach a new activation POST because no body is returned.
      await expect(reserveNextGithubCorrectionFindingPublication({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toMatchObject({ kind: "complete", expected: 1, published: 1, boundedFailed: 0 });
      await expect(reserveGithubCorrectionActivation({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toMatchObject({
        kind: "carrier_accepted",
        activationId: activationReservation.activation.id,
        githubCommentId: "91002",
        githubCommentUrl: activationUrl,
      });
      expect((await db.select().from(acceptanceCorrectionDispatches)
        .where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id)))[0]).toMatchObject({
        findingsState: "terminal", activationState: "carrier_accepted",
        deliveryState: "carrier_accepted", agentState: "not_observed",
      });

      const tokenNow = Math.floor(Date.now() / 1_000);
      const oidcSubject = "repo:acme/widgets:ref:refs/heads/main";
      const oidc = {
        issuer: "https://token.actions.githubusercontent.com" as const,
        audience: githubClaudeAcknowledgementAudience({
          activationCommentId: "91002", runId: "44001", runAttempt: 1,
        })!,
        subject: oidcSubject,
        subjectSha256: createHash("sha256").update(oidcSubject).digest("hex"),
        jtiSha256: "2".repeat(64),
        issuedAt: tokenNow - 5,
        notBefore: tokenNow - 5,
        expiresAt: tokenNow + 120,
        repository: "acme/widgets",
        repositoryId: "1001",
        repositoryOwner: "acme",
        repositoryOwnerId: "1002",
        actor: "jace[bot]",
        actorId: "1003",
        eventName: "issue_comment" as const,
        ref: "refs/heads/main",
        workflowRef:
          "acme/widgets/.github/workflows/agentrail-claude-correction.yml@refs/heads/main",
        workflowSha: "3".repeat(40),
        jobWorkflowRef: `agentrail/jace/.github/workflows/github-claude-correction-ack.yml@${"1".repeat(40)}`,
        jobWorkflowSha: "1".repeat(40),
        runId: "44001",
        runAttempt: 1 as const,
        checkRunId: "55001",
      };
      const acknowledgementInput = {
        activationCommentId: "91002",
        activationBodySha256: activationReservation.activation.bodySha256!,
        conclusion: "success" as const,
        providerSessionId: "claude-session-opaque-1",
        oidc,
      };
      const makeRepairObservationInput = (input: {
        afterHeadSha: string;
        beforeHeadSha?: string;
        activationBodySha256?: string;
        providerSessionId?: string;
        oidc?: Partial<typeof oidc>;
        jtiSha256?: string;
      }) => {
        const claims = { ...oidc, ...input.oidc };
        const activationBodySha256 = input.activationBodySha256
          ?? activationReservation.activation.bodySha256!;
        const beforeHeadSha = input.beforeHeadSha ?? headSha;
        return {
          activationCommentId: "91002",
          activationBodySha256,
          beforeHeadSha,
          afterHeadSha: input.afterHeadSha,
          providerSessionId: input.providerSessionId ?? "claude-session-opaque-1",
          oidc: {
            ...claims,
            audience: githubClaudeRepairObservationAudience({
              activationCommentId: "91002",
              activationBodySha256,
              beforeHeadSha,
              afterHeadSha: input.afterHeadSha,
              runId: claims.runId,
              runAttempt: claims.runAttempt,
            })!,
            jtiSha256: input.jtiSha256 ?? "6".repeat(64),
          },
        };
      };

      // A signed synchronize may win the race after GitHub accepts the
      // activation but before the provider posts its receipt. The receipt is
      // retained as historical evidence and must not project acknowledgement
      // onto either the obsolete cycle or its successor.
      const historicalHeadSha = "5".repeat(40);
      const historicalAdvance = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId,
        recordId: draft.record.id,
        repo: "acme/widgets",
        prNumber: 43,
        headSha: historicalHeadSha,
        event: "synchronize",
        deliveryId: "delivery-ack-historical-successor",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: headSha, afterHeadSha: historicalHeadSha },
        source: "github_webhook",
      });
      if (historicalAdvance.kind !== "advanced") throw new Error("expected acknowledgement successor");
      const historicalRepairInput = makeRepairObservationInput({
        afterHeadSha: historicalHeadSha,
      });
      await expect(recordGithubClaudeRepairHeadObservation(historicalRepairInput))
        .resolves.toEqual({ kind: "not_admitted" });
      const beforeHistoricalAck = (await db.select().from(acceptanceCorrectionDispatches)
        .where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id)))[0]!;
      expect(beforeHistoricalAck).toMatchObject({
        invalidationReason: "head_advanced",
        successorHeadSha: historicalHeadSha,
        successorHeadCycleId: historicalAdvance.jobId,
        agentState: "not_observed",
      });
      const historicalAcknowledged = await recordGithubClaudeAgentAcknowledgement(acknowledgementInput);
      expect(historicalAcknowledged).toMatchObject({
        kind: "recorded",
        receipt: { dispatchId: githubQueued.dispatch.id, headSha },
      });
      const afterHistoricalAck = (await db.select().from(acceptanceCorrectionDispatches)
        .where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id)))[0]!;
      expect(afterHistoricalAck).toMatchObject({
        invalidationReason: "head_advanced",
        successorHeadSha: historicalHeadSha,
        successorHeadCycleId: historicalAdvance.jobId,
        agentState: "not_observed",
      });
      expect(await db.select().from(acceptanceCorrectionDispatches).where(and(
        eq(acceptanceCorrectionDispatches.recordId, draft.record.id),
        eq(acceptanceCorrectionDispatches.headCycleId, historicalAdvance.jobId),
      ))).toHaveLength(0);
      await expect(readGithubClaudeAgentAcknowledgement({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toMatchObject({ id: historicalAcknowledged.kind === "recorded"
        ? historicalAcknowledged.receipt.id : "unreachable" });
      await expect(recordGithubClaudeAgentAcknowledgement(acknowledgementInput))
        .resolves.toMatchObject({ kind: "replayed" });

      await expect(recordGithubClaudeRepairHeadObservation({
        ...historicalRepairInput,
        providerSessionId: "wrong-session",
      })).resolves.toEqual({ kind: "not_admitted" });
      await expect(recordGithubClaudeRepairHeadObservation(makeRepairObservationInput({
        afterHeadSha: historicalHeadSha,
        activationBodySha256: "4".repeat(64),
      }))).resolves.toEqual({ kind: "not_admitted" });
      await expect(recordGithubClaudeRepairHeadObservation(makeRepairObservationInput({
        afterHeadSha: historicalHeadSha,
        beforeHeadSha: "7".repeat(40),
      }))).resolves.toEqual({ kind: "not_admitted" });
      await expect(recordGithubClaudeRepairHeadObservation(makeRepairObservationInput({
        afterHeadSha: "8".repeat(40),
      }))).resolves.toEqual({ kind: "not_admitted" });
      await expect(recordGithubClaudeRepairHeadObservation(makeRepairObservationInput({
        afterHeadSha: historicalHeadSha,
        oidc: { runId: "44002" },
      }))).resolves.toEqual({ kind: "not_admitted" });
      await expect(recordGithubClaudeRepairHeadObservation(makeRepairObservationInput({
        afterHeadSha: historicalHeadSha,
        oidc: { checkRunId: "55002" },
      }))).resolves.toEqual({ kind: "not_admitted" });
      await expect(recordGithubClaudeRepairHeadObservation(makeRepairObservationInput({
        afterHeadSha: historicalHeadSha,
        oidc: { issuedAt: oidc.issuedAt - 1, notBefore: oidc.notBefore - 1 },
      }))).resolves.toEqual({ kind: "not_admitted" });
      await expect(recordGithubClaudeRepairHeadObservation(makeRepairObservationInput({
        afterHeadSha: historicalHeadSha,
        oidc: { repositoryId: "9999" },
      }))).resolves.toEqual({ kind: "not_admitted" });
      await expect(recordGithubClaudeRepairHeadObservation(makeRepairObservationInput({
        afterHeadSha: historicalHeadSha,
        jtiSha256: oidc.jtiSha256,
      }))).resolves.toEqual({ kind: "not_admitted" });

      const historicalRepairObserved = await recordGithubClaudeRepairHeadObservation(
        historicalRepairInput
      );
      expect(historicalRepairObserved).toMatchObject({
        kind: "recorded",
        observation: {
          dispatchId: githubQueued.dispatch.id,
          acknowledgementReceiptId: historicalAcknowledged.kind === "recorded"
            ? historicalAcknowledged.receipt.id : "unreachable",
          beforeHeadSha: headSha,
          afterHeadSha: historicalHeadSha,
          oidcRunId: oidc.runId,
          oidcCheckRunId: oidc.checkRunId,
        },
      });
      if (historicalRepairObserved.kind !== "recorded") {
        throw new Error("expected historical repair observation");
      }
      expect(JSON.stringify(historicalRepairObserved.observation))
        .not.toContain("claude-session-opaque-1");
      expect(JSON.stringify(historicalRepairObserved.observation)).not.toContain(oidcSubject);
      await expect(recordGithubClaudeAgentAcknowledgement({
        ...acknowledgementInput,
        oidc: { ...oidc, jtiSha256: historicalRepairInput.oidc.jtiSha256 },
      })).rejects.toBeInstanceOf(GithubClaudeAgentAcknowledgementConflictError);
      await expect(recordGithubClaudeRepairHeadObservation(historicalRepairInput))
        .resolves.toMatchObject({
          kind: "replayed",
          observation: { id: historicalRepairObserved.observation.id },
        });
      await expect(recordGithubClaudeRepairHeadObservation(makeRepairObservationInput({
        afterHeadSha: historicalHeadSha,
        jtiSha256: "7".repeat(64),
      }))).rejects.toBeInstanceOf(GithubClaudeRepairObservationConflictError);
      await expect(readGithubClaudeRepairHeadEvidence({
        workspaceId: randomUUID(), dispatchId: githubQueued.dispatch.id,
      })).resolves.toBeNull();
      const historicalRepairEvidence = await readGithubClaudeRepairHeadEvidence({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      });
      expect(historicalRepairEvidence).toMatchObject({
        kind: "github_claude_repair_head_evidence",
        version: 1,
        dispatchId: githubQueued.dispatch.id,
        acknowledgementReceiptId: historicalAcknowledged.kind === "recorded"
          ? historicalAcknowledged.receipt.id : "unreachable",
        observationId: historicalRepairObserved.observation.id,
        originalHeadSha: headSha,
        repairHeadSha: historicalHeadSha,
        repairHeadCycleId: historicalAdvance.jobId,
        githubDeliveryId: "delivery-ack-historical-successor",
        reviewJobId: historicalAdvance.jobId,
        attribution: "selected_run_observed_successor",
        authorship: "not_independently_proven",
        reviewRequirement: "exact_head_r7_reentry",
        evidenceIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });

      const invalidationEvent = (await db.select().from(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey,
          `acceptance-correction-dispatch:invalidated:${job.id}`),
      )).limit(1))[0]!;
      await db.update(acceptanceCorrectionDispatches).set({
        invalidationReason: "reconciled",
      }).where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id));
      await db.update(changeRecordEvents).set({
        payloadRef: { ...invalidationEvent.payloadRef, reason: "reconciled" },
      }).where(eq(changeRecordEvents.id, invalidationEvent.id));
      await expect(readGithubClaudeRepairHeadEvidence({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toBeNull();
      await db.update(acceptanceCorrectionDispatches).set({
        invalidationReason: "head_advanced",
      }).where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id));
      await db.update(changeRecordEvents).set({ payloadRef: invalidationEvent.payloadRef })
        .where(eq(changeRecordEvents.id, invalidationEvent.id));

      const signedDeliveryEvent = (await db.select().from(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey,
          "external-pr:delivery:43:delivery-ack-historical-successor"),
      )).limit(1))[0]!;
      await db.update(changeRecordEvents).set({ actor: "server:test" })
        .where(eq(changeRecordEvents.id, signedDeliveryEvent.id));
      await expect(readGithubClaudeRepairHeadEvidence({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toBeNull();
      await db.update(changeRecordEvents).set({ actor: "github_webhook" })
        .where(eq(changeRecordEvents.id, signedDeliveryEvent.id));

      const revisitedOriginal = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId,
        recordId: draft.record.id,
        repo: "acme/widgets",
        prNumber: 43,
        headSha,
        event: "synchronize",
        deliveryId: "delivery-repair-a-b-a",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: historicalHeadSha, afterHeadSha: headSha },
        source: "github_webhook",
      });
      if (revisitedOriginal.kind !== "advanced") throw new Error("expected A-B-A revisit");
      expect(revisitedOriginal.jobId).not.toBe(job.id);
      await expect(readGithubClaudeRepairHeadEvidence({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toMatchObject({
        repairHeadSha: historicalHeadSha,
        repairHeadCycleId: historicalAdvance.jobId,
        originalHeadCycleId: job.id,
      });

      const repeatedObservedHead = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId,
        recordId: draft.record.id,
        repo: "acme/widgets",
        prNumber: 43,
        headSha: historicalHeadSha,
        event: "synchronize",
        deliveryId: "delivery-repair-a-b-a-b",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: headSha, afterHeadSha: historicalHeadSha },
        source: "github_webhook",
      });
      if (repeatedObservedHead.kind !== "advanced") throw new Error("expected A-B-A-B repeat");
      expect(repeatedObservedHead.jobId).not.toBe(historicalAdvance.jobId);
      await expect(readGithubClaudeRepairHeadEvidence({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toBeNull();
      await db.delete(acceptanceCorrectionDispatchGithubClaudeRepairObservations)
        .where(eq(acceptanceCorrectionDispatchGithubClaudeRepairObservations.dispatchId,
          githubQueued.dispatch.id));
      await db.delete(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey,
          `acceptance-correction-dispatch:github-claude-repair-observation:${job.id}`),
      ));
      const repeatedOccurrenceObservation = await recordGithubClaudeRepairHeadObservation(
        makeRepairObservationInput({
          afterHeadSha: historicalHeadSha,
          jtiSha256: "7".repeat(64),
        })
      );
      expect(repeatedOccurrenceObservation).toMatchObject({ kind: "recorded" });
      await expect(readGithubClaudeRepairHeadEvidence({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toBeNull();

      // Test-only rewind preserves the existing current-cycle carrier proof in
      // this broad fixture so the same API is also exercised on its current
      // agentState CAS path below.
      await db.delete(acceptanceCorrectionDispatchGithubClaudeRepairObservations)
        .where(eq(acceptanceCorrectionDispatchGithubClaudeRepairObservations.dispatchId,
          githubQueued.dispatch.id));
      await db.delete(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey,
          `acceptance-correction-dispatch:github-claude-repair-observation:${job.id}`),
      ));
      await db.delete(acceptanceCorrectionDispatchGithubClaudeAckReceipts)
        .where(eq(acceptanceCorrectionDispatchGithubClaudeAckReceipts.dispatchId,
          githubQueued.dispatch.id));
      await db.delete(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey,
          `acceptance-correction-dispatch:github-claude-ack:${job.id}`),
      ));
      await db.delete(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey,
          `acceptance-correction-dispatch:invalidated:${job.id}`),
      ));
      await db.update(acceptanceCorrectionDispatches).set({
        invalidatedAt: null,
        invalidationReason: null,
        successorHeadSha: null,
        successorHeadCycleId: null,
      }).where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id));
      await db.update(changeRecords).set({
        currentPrHeadSha: headSha,
        currentPrHeadCycleId: job.id,
        currentPrHeadAuthoritative: true,
        currentPrHeadAuthorityGeneration: 1,
      }).where(eq(changeRecords.id, draft.record.id));

      const immutableSubject =
        "repo:acme@1002/widgets@1001:ref:refs/heads/main";
      const immutableAcknowledgementInput = {
        ...acknowledgementInput,
        oidc: {
          ...oidc,
          subject: immutableSubject,
          subjectSha256: createHash("sha256").update(immutableSubject).digest("hex"),
        },
      };
      for (const rejectedSubject of [
        "repo:acme@9999/widgets@1001:ref:refs/heads/main",
        "repo:acme@1002/widgets@9999:ref:refs/heads/main",
        "repo:acme@1002/widgets@1001:ref:refs/heads/other",
        "repo:acme/widgets:environment:production",
      ]) {
        await expect(recordGithubClaudeAgentAcknowledgement({
          ...immutableAcknowledgementInput,
          oidc: {
            ...immutableAcknowledgementInput.oidc,
            subject: rejectedSubject,
            subjectSha256: createHash("sha256").update(rejectedSubject).digest("hex"),
          },
        })).resolves.toEqual({ kind: "not_admitted" });
      }
      const wrongSignedRepositoryId = "9999";
      const wrongIdSubject =
        `repo:acme@1002/widgets@${wrongSignedRepositoryId}:ref:refs/heads/main`;
      await expect(recordGithubClaudeAgentAcknowledgement({
        ...immutableAcknowledgementInput,
        oidc: {
          ...immutableAcknowledgementInput.oidc,
          repositoryId: wrongSignedRepositoryId,
          subject: wrongIdSubject,
          subjectSha256: createHash("sha256").update(wrongIdSubject).digest("hex"),
        },
      })).resolves.toEqual({ kind: "not_admitted" });

      await expect(recordGithubClaudeAgentAcknowledgement({
        ...immutableAcknowledgementInput,
        activationBodySha256: "4".repeat(64),
      })).resolves.toEqual({ kind: "not_admitted" });
      const acknowledged = await recordGithubClaudeAgentAcknowledgement(
        immutableAcknowledgementInput
      );
      expect(acknowledged).toMatchObject({
        kind: "recorded",
        receipt: {
          dispatchId: githubQueued.dispatch.id,
          activationId: activationReservation.activation.id,
          activationGithubCommentId: "91002",
          ackProfileId: acknowledgementProfile.profile.id,
          provider: "anthropic_claude_code_action",
          providerConclusion: "success",
          oidcRunAttempt: 1,
        },
      });
      if (acknowledged.kind !== "recorded") throw new Error("expected Claude acknowledgement");
      expect(JSON.stringify(acknowledged.receipt)).not.toContain("claude-session-opaque-1");
      expect(JSON.stringify(acknowledged.receipt)).not.toContain(oidcSubject);
      expect(JSON.stringify(acknowledged.receipt)).not.toContain(immutableSubject);
      await expect(recordGithubClaudeAgentAcknowledgement(immutableAcknowledgementInput))
        .resolves.toMatchObject({ kind: "replayed", receipt: { id: acknowledged.receipt.id } });
      await expect(recordGithubClaudeAgentAcknowledgement({
        ...immutableAcknowledgementInput,
        providerSessionId: "different-session",
      })).rejects.toBeInstanceOf(GithubClaudeAgentAcknowledgementConflictError);
      await expect(readGithubClaudeAgentAcknowledgement({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toMatchObject({ id: acknowledged.receipt.id });
      expect((await db.select().from(acceptanceCorrectionDispatches)
        .where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id)))[0]).toMatchObject({
        findingsState: "terminal", activationState: "carrier_accepted",
        deliveryState: "carrier_accepted", agentState: "acknowledged",
        successorHeadSha: null, successorHeadCycleId: null,
      });

      // A second-purpose repair token may not reuse a JTI already consumed by
      // any acknowledgement, including a different dispatch. The synthetic
      // foreign row needs no trusted event because admission must stop at the
      // global cross-table anti-replay lookup.
      const crossDispatchJti = "9".repeat(64);
      const crossDispatchId = randomUUID();
      const crossPreflightId = randomUUID();
      const crossActivationId = randomUUID();
      const crossAckReceiptId = randomUUID();
      const crossDispatchIdentity = "c".repeat(64);
      const crossPreflightIdentity = "d".repeat(64);
      const crossActivationIdentity = "e".repeat(64);
      const currentDispatchRow = (await db.select().from(acceptanceCorrectionDispatches)
        .where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id)))[0]!;
      const currentPreflightRow = (await db.select()
        .from(acceptanceCorrectionDispatchGithubPreflights).where(and(
          eq(acceptanceCorrectionDispatchGithubPreflights.dispatchId, githubQueued.dispatch.id),
          eq(acceptanceCorrectionDispatchGithubPreflights.status, "ready"),
        )).limit(1))[0]!;
      const currentActivationRow = (await db.select()
        .from(acceptanceCorrectionDispatchGithubActivations).where(
          eq(acceptanceCorrectionDispatchGithubActivations.id, activationReservation.activation.id)
        ).limit(1))[0]!;
      await db.insert(acceptanceCorrectionDispatches).values({
        ...currentDispatchRow,
        id: crossDispatchId,
        headSha: historicalHeadSha,
        headCycleId: historicalAdvance.jobId,
        reviewJobId: historicalAdvance.jobId,
        dispatchIdentitySha256: crossDispatchIdentity,
        invalidatedAt: null,
        invalidationReason: null,
        successorHeadSha: null,
        successorHeadCycleId: null,
      });
      await db.insert(acceptanceCorrectionDispatchGithubPreflights).values({
        ...currentPreflightRow,
        id: crossPreflightId,
        dispatchId: crossDispatchId,
        headSha: historicalHeadSha,
        headCycleId: historicalAdvance.jobId,
        dispatchIdentitySha256: crossDispatchIdentity,
        preflightIdentitySha256: crossPreflightIdentity,
      });
      await db.insert(acceptanceCorrectionDispatchGithubActivations).values({
        ...currentActivationRow,
        id: crossActivationId,
        dispatchId: crossDispatchId,
        headSha: historicalHeadSha,
        headCycleId: historicalAdvance.jobId,
        dispatchIdentitySha256: crossDispatchIdentity,
        readyPreflightId: crossPreflightId,
        readyPreflightIdentitySha256: crossPreflightIdentity,
        activationIdentitySha256: crossActivationIdentity,
        githubCommentId: "91999",
        githubCommentUrl: "https://github.com/acme/widgets/pull/43#issuecomment-91999",
      });
      await db.insert(acceptanceCorrectionDispatchGithubClaudeAckReceipts).values({
        ...acknowledged.receipt,
        id: crossAckReceiptId,
        dispatchId: crossDispatchId,
        activationId: crossActivationId,
        headSha: historicalHeadSha,
        headCycleId: historicalAdvance.jobId,
        dispatchIdentitySha256: crossDispatchIdentity,
        activationIdentitySha256: crossActivationIdentity,
        activationGithubCommentId: "91999",
        oidcAudience: githubClaudeAcknowledgementAudience({
          activationCommentId: "91999", runId: "44999", runAttempt: 1,
        })!,
        oidcRunId: "44999",
        oidcJtiSha256: crossDispatchJti,
        receiptIdentitySha256: "f".repeat(64),
      });
      await expect(recordGithubClaudeRepairHeadObservation(makeRepairObservationInput({
        afterHeadSha: "6".repeat(40),
        oidc: immutableAcknowledgementInput.oidc,
        jtiSha256: crossDispatchJti,
      }))).resolves.toEqual({ kind: "not_admitted" });
      await db.delete(acceptanceCorrectionDispatchGithubClaudeAckReceipts)
        .where(eq(acceptanceCorrectionDispatchGithubClaudeAckReceipts.id, crossAckReceiptId));
      await db.delete(acceptanceCorrectionDispatchGithubActivations)
        .where(eq(acceptanceCorrectionDispatchGithubActivations.id, crossActivationId));
      await db.delete(acceptanceCorrectionDispatchGithubPreflights)
        .where(eq(acceptanceCorrectionDispatchGithubPreflights.id, crossPreflightId));
      await db.delete(acceptanceCorrectionDispatches)
        .where(eq(acceptanceCorrectionDispatches.id, crossDispatchId));

      // The provider observation may arrive before GitHub's independently
      // signed synchronize delivery. It is retained without projecting repair;
      // the same immutable row becomes evidence only after the exact A-to-B
      // delivery advances the PR and admits B back into R7.
      const observedBeforeWebhookHeadSha = "6".repeat(40);
      const observedBeforeWebhookInput = makeRepairObservationInput({
        afterHeadSha: observedBeforeWebhookHeadSha,
        oidc: immutableAcknowledgementInput.oidc,
        jtiSha256: "8".repeat(64),
      });
      const observedBeforeWebhook = await recordGithubClaudeRepairHeadObservation(
        observedBeforeWebhookInput
      );
      expect(observedBeforeWebhook).toMatchObject({
        kind: "recorded",
        observation: {
          dispatchId: githubQueued.dispatch.id,
          acknowledgementReceiptId: acknowledged.receipt.id,
          beforeHeadSha: headSha,
          afterHeadSha: observedBeforeWebhookHeadSha,
        },
      });
      if (observedBeforeWebhook.kind !== "recorded") {
        throw new Error("expected pre-synchronize repair observation");
      }
      await expect(readGithubClaudeRepairHeadEvidence({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toBeNull();
      const observedSuccessor = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId,
        recordId: draft.record.id,
        repo: "acme/widgets",
        prNumber: 43,
        headSha: observedBeforeWebhookHeadSha,
        event: "synchronize",
        deliveryId: "delivery-repair-observation-after-receipt",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: headSha, afterHeadSha: observedBeforeWebhookHeadSha },
        source: "github_webhook",
      });
      if (observedSuccessor.kind !== "advanced") throw new Error("expected observed successor");
      await expect(readGithubClaudeRepairHeadEvidence({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toMatchObject({
        observationId: observedBeforeWebhook.observation.id,
        originalHeadSha: headSha,
        repairHeadSha: observedBeforeWebhookHeadSha,
        repairHeadCycleId: observedSuccessor.jobId,
        githubDeliveryId: "delivery-repair-observation-after-receipt",
        reviewJobId: observedSuccessor.jobId,
        attribution: "selected_run_observed_successor",
        authorship: "not_independently_proven",
        reviewRequirement: "exact_head_r7_reentry",
      });
      expect((await db.select().from(acceptanceCorrectionDispatches)
        .where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id)))[0])
        .toMatchObject({ agentState: "acknowledged", successorHeadSha: observedBeforeWebhookHeadSha });
      expect(await db.select().from(acceptanceCorrectionDispatches).where(and(
        eq(acceptanceCorrectionDispatches.recordId, draft.record.id),
        eq(acceptanceCorrectionDispatches.headCycleId, observedSuccessor.jobId),
      ))).toHaveLength(0);

      // Test-only restore: the broad fixture next exercises the unrelated
      // fallback lane against the original compiled exact-head pack.
      await db.delete(acceptanceCorrectionDispatchGithubClaudeRepairObservations)
        .where(eq(acceptanceCorrectionDispatchGithubClaudeRepairObservations.dispatchId,
          githubQueued.dispatch.id));
      await db.delete(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey,
          `acceptance-correction-dispatch:github-claude-repair-observation:${job.id}`),
      ));
      await db.delete(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey,
          `acceptance-correction-dispatch:invalidated:${job.id}`),
      ));
      await db.update(acceptanceCorrectionDispatches).set({
        invalidatedAt: null,
        invalidationReason: null,
        successorHeadSha: null,
        successorHeadCycleId: null,
      }).where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id));
      await db.update(changeRecords).set({
        currentPrHeadSha: headSha,
        currentPrHeadCycleId: job.id,
        currentPrHeadAuthoritative: true,
        currentPrHeadAuthorityGeneration: 1,
      }).where(eq(changeRecords.id, draft.record.id));

      // Durable fallback remains queueable, but deliberately has no GitHub
      // vendor capability profile and still performs no carrier action.
      await db.delete(acceptanceCorrectionDispatchGithubClaudeAckReceipts)
        .where(eq(acceptanceCorrectionDispatchGithubClaudeAckReceipts.dispatchId,
          githubQueued.dispatch.id));
      await db.delete(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey,
          `acceptance-correction-dispatch:github-claude-ack:${job.id}`),
      ));
      await db.delete(acceptanceCorrectionDispatchGithubActivations)
        .where(eq(acceptanceCorrectionDispatchGithubActivations.dispatchId, githubQueued.dispatch.id));
      await db.delete(acceptanceCorrectionDispatchGithubFindingPublications)
        .where(eq(acceptanceCorrectionDispatchGithubFindingPublications.dispatchId, githubQueued.dispatch.id));
      await db.delete(acceptanceCorrectionDispatchGithubPreflights)
        .where(eq(acceptanceCorrectionDispatchGithubPreflights.dispatchId, githubQueued.dispatch.id));
      await db.delete(acceptanceCorrectionDispatches)
        .where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id));
      await db.delete(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey, `acceptance-correction-dispatch:queued:${job.id}`),
      ));
      await db.update(acceptanceBuilderRoutes).set({ adapter: "durable_jace_fallback" })
        .where(eq(acceptanceBuilderRoutes.id, selectedRoute.route.id));
      const selectionPayload = routeSelection.event.payloadRef as Record<string, unknown>;
      await db.update(changeRecordEvents).set({ payloadRef: {
        ...selectionPayload,
        route: {
          id: selectedRoute.route.id,
          adapter: "durable_jace_fallback",
          configurationVersion: 1,
          status: "active",
        },
        snapshot: {
          builder: { adapter: "durable_jace_fallback", routeId: selectedRoute.route.id },
          protocol: "durable_notice",
          capability: {
            availability: "unverified",
            activation: "none",
            acknowledgement: "human_ack",
            repairHead: "github_synchronize",
          },
          scopeBoundary: "correction_delivery_only",
        },
      } }).where(eq(changeRecordEvents.id, routeSelection.event.id));
      const queued = await queueSelectedCorrectionDispatch({ workspaceId: wsId, compiledPackId: first.pack.id });
      const queuedReplay = await queueSelectedCorrectionDispatch({ workspaceId: wsId, compiledPackId: first.pack.id });
      expect(queued).toMatchObject({ inserted: true, dispatch: {
        routeAdapter: "durable_jace_fallback",
        carrier: "durable_notice",
        capabilityProfileId: null,
        capabilityProfileSnapshot: null,
        capabilityProfileSnapshotSha256: null,
        deliveryState: "queued",
        agentState: "not_observed",
        activationState: "not_started",
      } });
      expect(queuedReplay).toMatchObject({ inserted: false, dispatch: { id: queued.dispatch.id } });
      await expect(persist({
        ...compiled, manifest: { ...compiled.manifest, exclusions: [{ source: "exact_head_overlay", path: "apps/filter.ts", reason: "Excluded", content: "raw source" }] },
      })).rejects.toThrow("Invalid compiled Context Pack");
      await expect(persist({
        ...compiled, sourceCustodyReceipt: { ...compiled.sourceCustodyReceipt, directReadReceipts: [{ requestedPath: "lib/unsafe.ts", headSha, headTreeSha: "c".repeat(40), outcome: "not_proven", reason: "secret", exclusion: { arbitrary: "untrusted" } }] },
      })).rejects.toThrow("Invalid compiled Context Pack");
      await expect(persist({
        ...compiled, manifest: { ...compiled.manifest, decisions: ["self-attested decision"] },
      })).rejects.toThrow("does not match");
      await expect(persist({ ...compiled, renderedByteCount: 101 })).rejects.toThrow("does not match");
      await expect(resolveAcceptanceCompiledContextPack({ workspaceId: randomUUID(), sourceSnapshotId: snapshot.snapshot.id, compilerVersion: compiler.version, policyVersion: compiler.policyVersion })).resolves.toBeNull();
      const nextHeadSha = "f".repeat(40);
      await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 43,
        headSha: nextHeadSha, event: "synchronize", deliveryId: "delivery-compiled-next-head",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: headSha, afterHeadSha: nextHeadSha },
        source: "github_webhook",
      });
      expect((await db.select().from(acceptanceCorrectionDispatches)
        .where(eq(acceptanceCorrectionDispatches.id, queued.dispatch.id)))[0]).toMatchObject({
        invalidationReason: "head_advanced", successorHeadSha: nextHeadSha,
      });
      const revisitedHead = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 43,
        headSha, event: "synchronize", deliveryId: "delivery-compiled-revisited-head",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: nextHeadSha, afterHeadSha: headSha },
        source: "github_webhook",
      });
      if (revisitedHead.kind !== "advanced") throw new Error("expected compiled head revisit");
      expect(revisitedHead.jobId).not.toBe(job.id);
      await expect(reserveNextGithubCorrectionFindingPublication({
        workspaceId: wsId, dispatchId: queued.dispatch.id,
      })).resolves.toEqual({ kind: "not_current" });
      await expect(reserveGithubCorrectionActivation({
        workspaceId: wsId, dispatchId: queued.dispatch.id,
      })).resolves.toEqual({ kind: "not_current" });
      await expect(resolveAcceptanceCompiledContextPack({
        workspaceId: wsId, sourceSnapshotId: snapshot.snapshot.id,
        compilerVersion: compiler.version, policyVersion: compiler.policyVersion,
      })).resolves.toBeNull();
      await expect(queueSelectedCorrectionDispatch({ workspaceId: wsId, compiledPackId: first.pack.id }))
        .rejects.toThrow("current");
      await expect(persist(compiled)).rejects.toThrow("Record head is no longer current");
      expect(await db.select().from(acceptanceCompiledContextPacks).where(eq(acceptanceCompiledContextPacks.id, first.pack.id))).toHaveLength(1);
    });

    it("rejects unknown, disabled, cross-workspace, cross-repository, and unsupported Builder routes", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId, repo: "acme/widgets", workKey: "builder-route-boundaries",
        originChannel: "codex_mcp", contract: completeContract(), createdBy: "user:lead",
      });
      await db.update(acceptanceContracts).set({
        status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date(),
      }).where(eq(acceptanceContracts.id, draft.contract.id));
      const select = (routeId: string) => recordAcceptanceBuilderRouteSelection({
        workspaceId: wsId, recordId: draft.record.id, selectedBy: "user:lead", routeId,
      });

      await expect(select(randomUUID())).rejects.toThrow("unavailable for this Record");
      const disabled = await registerAcceptanceBuilderRoute({
        workspaceId: wsId, repo: "acme/widgets", adapter: "durable_jace_fallback",
        status: "disabled", configurationVersion: 1, registeredBy: "server:environment",
      });
      await expect(select(disabled.route.id)).rejects.toThrow("unavailable for this Record");
      const otherRepo = await registerAcceptanceBuilderRoute({
        workspaceId: wsId, repo: "acme/other", adapter: "durable_github_fallback",
        configurationVersion: 1, registeredBy: "server:environment",
      });
      await expect(select(otherRepo.route.id)).rejects.toThrow("unavailable for this Record");

      const otherWorkspace = (await db.insert(workspaces).values({
        name: "other builder route workspace", slug: `other-builder-route-${randomUUID()}`,
      }).returning({ id: workspaces.id }))[0]!;
      const foreign = await registerAcceptanceBuilderRoute({
        workspaceId: otherWorkspace.id, repo: "acme/widgets", adapter: "github_claude",
        configurationVersion: 1, registeredBy: "server:environment",
      });
      await expect(select(foreign.route.id)).rejects.toThrow("unavailable for this Record");
      await db.delete(workspaces).where(eq(workspaces.id, otherWorkspace.id));

      for (const adapter of ["codex_app_server", "mcp_correction_inbox"] as const) {
        await expect(registerAcceptanceBuilderRoute({
          workspaceId: wsId, repo: "acme/widgets", adapter: adapter as never,
          configurationVersion: 1, registeredBy: "server:environment",
        })).rejects.toThrow("Invalid Acceptance Builder route registration");
      }
    });

    it("fails capability profiles closed on installation, route scope, and revision drift", async () => {
      const route = await registerAcceptanceBuilderRoute({
        workspaceId: wsId, repo: "acme/widgets", adapter: "github_codex",
        configurationVersion: 1, registeredBy: "server:environment",
      });
      const input = {
        workspaceId: wsId, routeId: route.route.id,
        recordedBy: "server:route-capability-profile",
      };
      await expect(recordAcceptanceBuilderRouteCapabilityProfile(input))
        .rejects.toThrow();

      await db.update(workspaces).set({
        githubInstallationId: "installation-capability-a",
        githubInstallationAccountLogin: "acme",
        githubInstallationAccountType: "Organization",
      })
        .where(eq(workspaces.id, wsId));
      const first = await recordAcceptanceBuilderRouteCapabilityProfile(input);
      expect(first.inserted).toBe(true);

      await db.update(workspaces).set({
        githubInstallationId: "installation-capability-b",
        githubInstallationAccountLogin: "acme",
        githubInstallationAccountType: "Organization",
      })
        .where(eq(workspaces.id, wsId));
      await expect(resolveAcceptanceBuilderRouteCapabilityProfile({
        workspaceId: wsId, routeId: route.route.id,
      })).resolves.toBeNull();
      await db.update(workspaces).set({
        githubInstallationId: "installation-capability-a",
        githubInstallationAccountLogin: "acme",
        githubInstallationAccountType: "Organization",
      })
        .where(eq(workspaces.id, wsId));
      await expect(resolveAcceptanceBuilderRouteCapabilityProfile({
        workspaceId: wsId, routeId: route.route.id,
      })).resolves.toMatchObject({ id: first.profile.id });

      const fallback = await registerAcceptanceBuilderRoute({
        workspaceId: wsId, repo: "acme/widgets", adapter: "durable_github_fallback",
        configurationVersion: 1, registeredBy: "server:environment",
      });
      await expect(recordAcceptanceBuilderRouteCapabilityProfile({
        ...input, routeId: fallback.route.id,
      })).rejects.toThrow();
      const disabled = await registerAcceptanceBuilderRoute({
        workspaceId: wsId, repo: "acme/widgets", adapter: "github_claude",
        status: "disabled", configurationVersion: 1, registeredBy: "server:environment",
      });
      await expect(recordAcceptanceBuilderRouteCapabilityProfile({
        ...input, routeId: disabled.route.id,
      })).rejects.toThrow();
      const otherRepo = await registerAcceptanceBuilderRoute({
        workspaceId: wsId, repo: "acme/other", adapter: "github_claude",
        configurationVersion: 1, registeredBy: "server:environment",
      });
      const otherRepoProfile = await recordAcceptanceBuilderRouteCapabilityProfile({
        ...input, routeId: otherRepo.route.id,
      });
      expect(otherRepoProfile).toMatchObject({ profile: {
        repo: "acme/other", adapter: "github_claude",
        snapshot: expect.objectContaining({ workspaceId: wsId, repo: "acme/other", routeId: otherRepo.route.id, adapter: "github_claude", routeConfigurationVersion: 1 }),
      } });
      expect(otherRepoProfile.profile.snapshotSha256).not.toBe(first.profile.snapshotSha256);

      const sameRepoDifferentRoute = await registerAcceptanceBuilderRoute({
        workspaceId: wsId, repo: "acme/widgets", adapter: "github_codex",
        configurationVersion: 1, registeredBy: "server:environment",
      });
      const sameRepoDifferentRouteProfile = await recordAcceptanceBuilderRouteCapabilityProfile({
        ...input, routeId: sameRepoDifferentRoute.route.id,
      });
      expect(sameRepoDifferentRouteProfile.profile.snapshotSha256).not.toBe(first.profile.snapshotSha256);

      // A syntactically valid snapshot copied from another route is not an
      // authorization profile for this route: every bound identity must match.
      await db.update(acceptanceBuilderRouteCapabilityProfiles).set({
        snapshot: otherRepoProfile.profile.snapshot,
        snapshotSha256: otherRepoProfile.profile.snapshotSha256,
      }).where(eq(acceptanceBuilderRouteCapabilityProfiles.id, first.profile.id));
      await expect(resolveAcceptanceBuilderRouteCapabilityProfile({
        workspaceId: wsId, routeId: route.route.id,
      })).resolves.toBeNull();

      await db.update(acceptanceBuilderRoutes).set({ configurationVersion: 2 })
        .where(eq(acceptanceBuilderRoutes.id, route.route.id));
      await expect(resolveAcceptanceBuilderRouteCapabilityProfile({
        workspaceId: wsId, routeId: route.route.id,
      })).resolves.toBeNull();
      const versionTwo = await recordAcceptanceBuilderRouteCapabilityProfile(input);
      expect(versionTwo).toMatchObject({ profile: {
        routeConfigurationVersion: 2,
        snapshot: expect.objectContaining({ routeConfigurationVersion: 2 }),
      } });
      expect(versionTwo.profile.snapshotSha256).not.toBe(first.profile.snapshotSha256);

      const otherWorkspace = (await db.insert(workspaces).values({
        name: "builder profile foreign workspace", slug: `builder-profile-${randomUUID()}`,
        githubInstallationId: "installation-foreign",
        githubInstallationAccountLogin: "foreign",
        githubInstallationAccountType: "Organization",
      }).returning({ id: workspaces.id }))[0]!;
      const foreign = await registerAcceptanceBuilderRoute({
        workspaceId: otherWorkspace.id, repo: "acme/widgets", adapter: "github_claude",
        configurationVersion: 1, registeredBy: "server:environment",
      });
      const foreignProfile = await recordAcceptanceBuilderRouteCapabilityProfile({
        workspaceId: otherWorkspace.id,
        routeId: foreign.route.id,
        recordedBy: "server:route-capability-profile",
      });
      expect(foreignProfile.profile.snapshotSha256).not.toBe(first.profile.snapshotSha256);
      await expect(recordAcceptanceBuilderRouteCapabilityProfile({
        ...input, routeId: foreign.route.id,
      })).rejects.toThrow();
      await db.delete(workspaces).where(eq(workspaces.id, otherWorkspace.id));
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
      const currentHead = "f".repeat(40);
      const currentCycleId = randomUUID();
      await db.update(changeRecords).set({
        currentPrHeadSha: currentHead,
        currentPrHeadCycleId: currentCycleId,
        currentPrHeadAuthoritative: false,
        currentPrHeadAuthorityGeneration: 7,
        headShas: [currentHead],
      }).where(eq(changeRecords.id, prRecord.id));

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
      expect(unified.headShas).toEqual([currentHead, "sha-1"]);
      expect(unified).toMatchObject({
        currentPrHeadSha: currentHead,
        currentPrHeadCycleId: currentCycleId,
        currentPrHeadAuthoritative: false,
        currentPrHeadAuthorityGeneration: 7,
      });

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
