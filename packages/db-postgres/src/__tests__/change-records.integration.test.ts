import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createHash, randomUUID } from "crypto";
import { db } from "../db.js";
import { workspaces } from "../schema/workspaces.js";
import { repositories } from "../schema/repositories.js";
import { wikiPages } from "../schema/wiki_pages.js";
import {
  acceptanceIntakeMessages,
  acceptanceIntakes,
  acceptanceBuilderRoutes,
  acceptanceCompiledContextPacks,
  acceptanceContextPackSnapshots,
  acceptanceContracts,
  changeRecordEvents,
} from "../schema/change_records.js";
import { jaceApprovals, jaceSessions } from "../schema/jace_sessions.js";
import {
  appendChangeRecordEvent,
  appendChangeRecordEventsAtomically,
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
  recordAcceptanceInboundIntake,
  readAcceptanceBuilderRouteSelection,
  readAcceptanceContracts,
  readChangeRecordTimeline,
} from "../queries/change_records.js";
import { exactGitTreeInclusionProofIdentity, type ExactGitTreeInclusionProof } from "../exact-git-tree-path-proof.js";
import { enqueueReviewJob } from "../queries/review_jobs.js";
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
               to_regclass('public.acceptance_context_pack_snapshots') AS acceptance_context_pack_snapshots,
               to_regclass('public.acceptance_compiled_context_packs') AS acceptance_compiled_context_packs,
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
               to_regclass('public.acceptance_intakes') AS acceptance_intakes,
               to_regclass('public.acceptance_intake_messages') AS acceptance_intake_messages
      `)
    ) as Array<{
      change_records: string | null;
      change_record_events: string | null;
      acceptance_contracts: string | null;
      acceptance_builder_routes: string | null;
      acceptance_context_pack_snapshots: string | null;
      acceptance_compiled_context_packs: string | null;
      acceptance_context_pack_custody: boolean;
      acceptance_compiled_context_pack_tree_proofs: boolean;
      acceptance_intakes: string | null;
      acceptance_intake_messages: string | null;
    }>;
    return (
      rows[0]?.change_records === "change_records" &&
      rows[0]?.change_record_events === "change_record_events" &&
      rows[0]?.acceptance_contracts === "acceptance_contracts" &&
      rows[0]?.acceptance_builder_routes === "acceptance_builder_routes" &&
      rows[0]?.acceptance_context_pack_snapshots === "acceptance_context_pack_snapshots" &&
      rows[0]?.acceptance_compiled_context_packs === "acceptance_compiled_context_packs" &&
      rows[0]?.acceptance_context_pack_custody === true &&
      rows[0]?.acceptance_compiled_context_pack_tree_proofs === true &&
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
      const registered = await registerAcceptanceBuilderRoute({
        workspaceId: wsId, repo: "acme/widgets", adapter: "github_codex",
        configurationVersion: 2, registeredBy: "server:environment",
      });
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

      await db.update(acceptanceBuilderRoutes).set({ configurationVersion: 3 })
        .where(eq(acceptanceBuilderRoutes.id, registered.route.id));
      await expect(readAcceptanceBuilderRouteSelection({
        workspaceId: wsId, recordId: draft.record.id,
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
      await attachConfirmedAcceptanceRecordToExternalPullRequest({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 42,
        headSha, source: "github_webhook",
      });
      const job = await enqueueReviewJob({
        workspaceId: wsId, repo: "acme/widgets", prNumber: 42, headSha, event: "synchronize",
      });
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
      const headSha = "a".repeat(40);
      await attachConfirmedAcceptanceRecordToExternalPullRequest({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 43, headSha,
      });
      const job = await enqueueReviewJob({ workspaceId: wsId, repo: "acme/widgets", prNumber: 43, headSha });
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
      const repo = await db.insert(repositories).values({ workspaceId: wsId, name: "acme/widgets" }).returning();
      const wiki = await db.insert(wikiPages).values({
        workspaceId: wsId, repositoryId: repo[0]!.id, slug: "overview", commitSha: "d".repeat(40), inputsHash: "e".repeat(64), bodyMd: "Background",
      }).returning();
      const baseIndexCore = { schemaVersion: 2 as const, backgroundOnly: true as const, pages: [{
        id: wiki[0]!.id, repositoryId: repo[0]!.id, slug: "overview", commitSha: "d".repeat(40), inputsHashSha256: "e".repeat(64), pageBodySha256: wikiPageBodySha256("Background"), stale: false,
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
        provenance: { schemaVersion: 1, included: [{ path: "overview", source: "base_index", reason: "Background" }, { path: "apps/filter.ts", source: "overlay", reason: "Changed" }], excluded: [] }, status: "admitted", reason: null,
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
