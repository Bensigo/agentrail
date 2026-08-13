import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../src/db.js";
import { sessions, users } from "../src/schema/auth.js";
import {
  acceptanceContracts,
  acceptanceGatedGithubIssuePublications,
  acceptanceGatedGithubIssueRequests,
  changeRecordEvents,
  changeRecords,
} from "../src/schema/change_records.js";
import { jaceApprovals } from "../src/schema/jace_sessions.js";
import { previewBoots } from "../src/schema/preview_boots.js";
import { reviewJobs } from "../src/schema/review_jobs.js";
import { repositories } from "../src/schema/repositories.js";
import { workspaceMemberships } from "../src/schema/workspace_memberships.js";
import { workspaces } from "../src/schema/workspaces.js";
import {
  advanceConfirmedAcceptanceRecordPullRequestHead,
  appendChangeRecordEvent,
  appendCurrentReviewJobEventsAtomically,
  acceptanceContextOverlayHeadRangeCoordinateSha256,
  acceptanceContextOverlayManifestSha256,
  acceptanceContextPackCanonicalSha256,
  acceptanceContextPackCustodyBaseIndexRevisionSha256,
  acceptanceContextPackCustodyOverlayManifestSha256,
  acceptanceContextPacketSetSha256,
  acceptanceContractSha256,
  acceptanceCorrectionPacketPayloadSetSha256,
  createDraftAcceptanceRecord,
  readCurrentAcceptanceCorrectionPackets,
  readCurrentAcceptanceCriterionOutcomeBundle,
  readCurrentAcceptanceGatedGithubIssue,
  recordPostedAcceptanceCriterionOutcomeBundle,
  recordAcceptanceCompiledContextPack,
  recordAcceptanceContextPackSnapshot,
  reviewJobCorrectionPacketId,
} from "../src/queries/change_records.js";
import { previewBootId } from "../src/queries/preview_boots.js";

const REPO = "agentrail/r112-browser-proof";
const CRITERION_ID = "AC-1";
const CRITERION_TEXT = "A saved filter remains visible after reload";
const SECOND_CRITERION_ID = "AC-2";
const SECOND_CRITERION_TEXT = "The saved-filter summary remains after the retained entry";
const MAX_STDIN_BYTES = 128 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA1 = /^[a-f0-9]{40}$/u;
const SESSION_TOKEN = /^[a-f0-9]{64}$/u;
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const ARTIFACT_BYTES = Buffer.from(PNG_BASE64, "base64");
const ARTIFACT_SHA256 = createHash("sha256").update(ARTIFACT_BYTES).digest("hex");

type ProofState = {
  workspaceId: string;
  recordId: string;
  ownerUserId: string;
  memberUserId: string;
  foreignUserId: string;
  ownerSessionToken: string;
  memberSessionToken: string;
  foreignSessionToken: string;
  repo: string;
  prNumber: number;
  headA: string;
  headB: string;
  originalHeadCycleId: string;
  currentHeadCycleId: string;
  artifactId: string;
  artifactKey: string;
  artifactSha256: string;
  artifactBytesBase64: string;
  evidenceRef: string;
  executionId: string;
  previewBootId: string;
  observedFailure: string;
  contextPackId: string;
};

function sha(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function contract(): Record<string, unknown> {
  return {
    originalRequest: "Keep saved filters after reload",
    normalizedRequirements: ["The saved filter remains visible after reload"],
    acceptanceCriteria: [
      {
        id: CRITERION_ID,
        text: CRITERION_TEXT,
        userVisible: true,
        modality: "ui",
      },
      {
        id: SECOND_CRITERION_ID,
        text: SECOND_CRITERION_TEXT,
        userVisible: true,
        modality: "ui",
      },
    ],
    nonGoals: [],
    risks: [],
    environment: { kind: "existing_preview" },
    stops: [],
    unresolvedQuestions: [],
  };
}

function isProofState(value: unknown): value is ProofState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return [
    state["workspaceId"],
    state["recordId"],
    state["ownerUserId"],
    state["memberUserId"],
    state["foreignUserId"],
    state["originalHeadCycleId"],
    state["currentHeadCycleId"],
    state["artifactId"],
  ].every((item) => typeof item === "string" && UUID.test(item))
    && [state["ownerSessionToken"], state["memberSessionToken"], state["foreignSessionToken"]]
      .every((item) => typeof item === "string" && SESSION_TOKEN.test(item))
    && state["repo"] === REPO
    && Number.isSafeInteger(state["prNumber"])
    && (state["prNumber"] as number) > 0
    && typeof state["headA"] === "string" && SHA1.test(state["headA"])
    && typeof state["headB"] === "string" && SHA1.test(state["headB"])
    && state["headA"] !== state["headB"]
    && typeof state["artifactKey"] === "string"
    && state["artifactKey"].startsWith(`review-evidence/${state["workspaceId"]}/`)
    && state["artifactKey"].length <= 1_024
    && state["artifactSha256"] === ARTIFACT_SHA256
    && state["artifactBytesBase64"] === PNG_BASE64
    && typeof state["evidenceRef"] === "string"
    && state["evidenceRef"].startsWith("review-ui-execution:ui-")
    && typeof state["executionId"] === "string"
    && state["executionId"].startsWith("ui-")
    && typeof state["previewBootId"] === "string" && UUID.test(state["previewBootId"])
    && typeof state["observedFailure"] === "string"
    && state["observedFailure"].length > 0
    && state["observedFailure"].length <= 2_000
    && typeof state["contextPackId"] === "string" && UUID.test(state["contextPackId"]);
}

async function readInput(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_STDIN_BYTES) throw new Error("fixture input exceeds 128 KiB");
    chunks.push(bytes);
  }
  if (total === 0) throw new Error("fixture command requires JSON input");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function exactCleanup(input: Pick<ProofState, "workspaceId" | "ownerUserId" | "memberUserId" | "foreignUserId">) {
  await db.delete(workspaces).where(eq(workspaces.id, input.workspaceId));
  await db.delete(users).where(inArray(users.id, [
    input.ownerUserId,
    input.memberUserId,
    input.foreignUserId,
  ]));
}

async function seed(): Promise<ProofState> {
  const workspaceId = randomUUID();
  const ownerUserId = randomUUID();
  const memberUserId = randomUUID();
  const foreignUserId = randomUUID();
  const ownerSessionToken = randomBytes(32).toString("hex");
  const memberSessionToken = randomBytes(32).toString("hex");
  const foreignSessionToken = randomBytes(32).toString("hex");
  let createdWorkspace = false;
  let createdUsers = false;

  try {
    await db.insert(users).values([
      { id: ownerUserId, name: "R11.2 browser owner", email: `${ownerUserId}@example.test` },
      { id: memberUserId, name: "R11.2 browser member", email: `${memberUserId}@example.test` },
      { id: foreignUserId, name: "R11.2 browser outsider", email: `${foreignUserId}@example.test` },
    ]);
    createdUsers = true;
    await db.insert(workspaces).values({
      id: workspaceId,
      name: "R11.2 authenticated browser proof",
      slug: `r112-browser-${workspaceId}`,
    });
    createdWorkspace = true;
    await db.insert(workspaceMemberships).values([
      { workspaceId, userId: ownerUserId, role: "owner" },
      { workspaceId, userId: memberUserId, role: "member" },
    ]);
    await db.insert(repositories).values({
      workspaceId,
      name: REPO,
      url: `https://github.com/${REPO}`,
    });
    const expires = new Date(Date.now() + 2 * 60 * 60 * 1_000);
    await db.insert(sessions).values([
      { sessionToken: ownerSessionToken, userId: ownerUserId, expires },
      { sessionToken: memberSessionToken, userId: memberUserId, expires },
      { sessionToken: foreignSessionToken, userId: foreignUserId, expires },
    ]);

    const draft = await createDraftAcceptanceRecord({
      workspaceId,
      repo: REPO,
      workKey: `r112-browser-${randomUUID()}`,
      originChannel: "codex_mcp",
      contract: contract(),
      createdBy: `user:${ownerUserId}`,
    });
    await db.update(acceptanceContracts).set({
      status: "confirmed",
      confirmedBy: `console_user:${ownerUserId}`,
      confirmedAt: new Date(),
    }).where(eq(acceptanceContracts.id, draft.contract.id));

    const headA = randomBytes(20).toString("hex");
    let headB = randomBytes(20).toString("hex");
    while (headB === headA) headB = randomBytes(20).toString("hex");
    const prNumber = randomInt(10_000, 999_999);
    const advanced = await advanceConfirmedAcceptanceRecordPullRequestHead({
      workspaceId,
      recordId: draft.record.id,
      repo: REPO,
      prNumber,
      headSha: headA,
      event: "opened",
      deliveryId: `r112-browser:${draft.record.id}:a1`,
      admitReviewJob: true,
      headTransition: null,
      source: "github_webhook",
    });
    if (advanced.kind !== "advanced") throw new Error("fixture could not create A1 head occurrence");
    await db.update(reviewJobs).set({
      state: "running",
      claimedBy: "worker:r112-browser-proof",
      claimedAt: new Date(),
    }).where(eq(reviewJobs.id, advanced.jobId));
    const reviewJob = (await db.select().from(reviewJobs).where(eq(reviewJobs.id, advanced.jobId)))[0];
    if (!reviewJob) throw new Error("fixture review job is missing");
    let chronologyBase = reviewJob.createdAt.valueOf() + 10;

    const plan = {
      criterionId: CRITERION_ID,
      criterionTextSnapshot: CRITERION_TEXT,
      modality: "ui",
      environmentKind: "isolated_preview",
      flow: "Open saved filters, reload, and verify the retained entry.",
      uiSteps: [
        { action: "open", path: "/filters?state=saved" },
        { action: "expect_text", text: "Saved filters" },
        { action: "screenshot", label: "saved-filter-after-reload" },
      ],
      apiRequest: null,
      dataRequest: null,
      status: "planned",
      notTestableReason: null,
    };
    const secondaryPlan = {
      criterionId: SECOND_CRITERION_ID,
      criterionTextSnapshot: SECOND_CRITERION_TEXT,
      modality: "ui",
      environmentKind: null,
      flow: null,
      uiSteps: null,
      apiRequest: null,
      dataRequest: null,
      status: "not_testable",
      notTestableReason: "No bounded exact-head browser flow exists for the secondary ordering criterion.",
    };
    const planPayload = {
      kind: "review_job_verification_plan",
      jobId: advanced.jobId,
      workspaceId,
      repo: REPO,
      prNumber,
      headSha: headA,
      recordId: draft.record.id,
      acceptanceContractId: draft.contract.id,
      acceptanceContractVersion: draft.contract.version,
      plannedBy: "jace:r112-browser-proof",
      plans: [plan, secondaryPlan],
    };
    const bootId = previewBootId({
      workspaceId,
      repo: REPO,
      prNumber,
      headSha: headA,
      cycleId: advanced.jobId,
    });
    const previewUrl = `http://preview-${prNumber}.r112-browser.test/`;
    const boot = (await db.insert(previewBoots).values({
      id: bootId,
      workspaceId,
      repo: REPO,
      prNumber,
      headSha: headA,
      ref: `refs/pull/${prNumber}/head`,
      status: "ready",
      url: previewUrl,
      port: 3100,
    }).returning())[0];
    if (!boot) throw new Error("fixture preview boot was not recorded");
    chronologyBase = Math.max(chronologyBase, boot.createdAt.valueOf() + 1);
    const coordinate = sha({
      jobId: advanced.jobId,
      recordId: draft.record.id,
      headSha: headA,
      acceptanceContractId: draft.contract.id,
      acceptanceContractVersion: draft.contract.version,
      criterionId: CRITERION_ID,
    });
    const planDigest = sha({
      criterionId: CRITERION_ID,
      criterionTextSnapshot: CRITERION_TEXT,
      modality: "ui",
      environmentKind: "isolated_preview",
      flow: plan.flow,
      status: "planned",
      uiSteps: plan.uiSteps,
    });
    const executionId = `ui-${sha({ coordinate, planDigest, previewBootId: bootId }).slice(0, 48)}`;
    const attemptEventKey = `verification:ui-attempt:${advanced.jobId}:${coordinate.slice(0, 24)}`;
    const reservationEventKey = `verification:ui-screenshot:${advanced.jobId}:${coordinate.slice(0, 24)}`;
    const resultEventKey = `verification:ui-result:${advanced.jobId}:${coordinate.slice(0, 24)}`;
    const artifactKey = [
      "review-evidence",
      workspaceId,
      "agentrail__r112-browser-proof",
      String(prNumber),
      headA,
      `${executionId}-${ARTIFACT_SHA256.slice(0, 16)}`,
      "1.png",
    ].join("/");
    const attempt = {
      kind: "review_job_ui_execution_attempt",
      executionId,
      jobId: advanced.jobId,
      workspaceId,
      repo: REPO,
      prNumber,
      headSha: headA,
      recordId: draft.record.id,
      acceptanceContractId: draft.contract.id,
      acceptanceContractVersion: draft.contract.version,
      criterionId: CRITERION_ID,
      criterionTextSnapshot: CRITERION_TEXT,
      planDigest,
      previewBootId: bootId,
      previewUrl,
      uiSteps: plan.uiSteps,
    };
    const observedFailure = "The deterministic browser did not observe the planned text \"Saved filters\" on the exact-head preview; the failing state was retained as the decisive screenshot.";
    const result = {
      ...attempt,
      kind: "review_job_ui_execution_result",
      state: "failed",
      expected: CRITERION_TEXT,
      observed: observedFailure,
      evidenceRef: `review-ui-execution:${executionId}`,
      artifactKey,
      contentType: "image/png",
      contentSha256: ARTIFACT_SHA256,
      observedUrl: `${previewUrl}filters?state=saved`,
    };
    await appendCurrentReviewJobEventsAtomically({
      workspaceId,
      recordId: draft.record.id,
      jobId: advanced.jobId,
      repo: REPO,
      prNumber,
      headSha: headA,
      events: [
        {
          eventKey: `verification:plan:${advanced.jobId}`,
          stage: "verification",
          actor: "jace:review-verification-planner",
          payloadRef: planPayload,
          at: new Date(chronologyBase),
        },
        {
          eventKey: attemptEventKey,
          stage: "verification",
          actor: "jace:review-ui-executor",
          payloadRef: attempt,
          at: new Date(chronologyBase + 1),
        },
        {
          eventKey: reservationEventKey,
          stage: "verification",
          actor: "jace:review-ui-executor",
          payloadRef: { kind: "review_job_ui_screenshot_upload_reservation", result },
          at: new Date(chronologyBase + 2),
        },
        {
          eventKey: resultEventKey,
          stage: "verification",
          actor: "jace:review-ui-executor",
          payloadRef: result,
          at: new Date(chronologyBase + 3),
        },
        {
          eventKey: `review:github-attempt:${advanced.jobId}`,
          stage: "review",
          actor: "reviewer-of-record",
          payloadRef: {
            kind: "review_job_github_post_attempt",
            jobId: advanced.jobId,
            workspaceId,
            repo: REPO,
            prNumber,
            headSha: headA,
            recordId: draft.record.id,
            acceptanceContractId: draft.contract.id,
            acceptanceContractVersion: draft.contract.version,
            outcomeDigest: "a".repeat(64),
            postPayloadDigest: "b".repeat(64),
          },
          at: new Date(chronologyBase + 4),
        },
      ],
    });
    const packetId = reviewJobCorrectionPacketId({
      jobId: advanced.jobId,
      criterionId: CRITERION_ID,
      headSha: headA,
      recordId: draft.record.id,
      acceptanceContractId: draft.contract.id,
      acceptanceContractVersion: draft.contract.version,
    });
    const correctionPacket = {
      kind: "review_job_correction_packet" as const,
      version: 1 as const,
      packetId,
      workspaceId,
      repo: REPO,
      prNumber,
      headSha: headA,
      recordId: draft.record.id,
      jobId: advanced.jobId,
      acceptanceContract: { id: draft.contract.id, version: draft.contract.version },
      criterion: { id: CRITERION_ID, snapshot: CRITERION_TEXT },
      basis: "acceptance_contract" as const,
      state: "failed" as const,
      expected: CRITERION_TEXT,
      observed: observedFailure,
      affectedContext: {
        modality: "ui" as const,
        environmentKind: "isolated_preview" as const,
        flow: plan.flow,
        reproduction: { modality: "ui" as const, steps: plan.uiSteps },
      },
      evidence: {
        evidenceRef: result.evidenceRef,
        artifactKey,
        executionId,
        previewBootId: bootId,
      },
      scopeBoundary: `Only ${CRITERION_ID} for ${REPO}#${prNumber} at ${headA}.`,
      impact: "The server-attested receipt does not prove the confirmed criterion on the exact head.",
      requiredCorrection: "Keep the saved filter visible after reload and retain new exact-head evidence.",
      reverification: "Rerun the persisted verification plan against the next exact head.",
    };
    await appendChangeRecordEvent({
      recordId: draft.record.id,
      eventKey: `review:correction:${advanced.jobId}:${CRITERION_ID}`,
      stage: "review",
      actor: "reviewer-of-record",
      at: new Date(chronologyBase + 4),
      payloadRef: correctionPacket,
    });

    const sourcePath = "apps/console/saved-filter.ts";
    const sourceContent = "export const savedFilterPersists = true;";
    const sourceBytes = Buffer.from(sourceContent, "utf8");
    const sourceBlobSha = createHash("sha1")
      .update(`blob ${sourceBytes.length}\0`, "utf8").update(sourceBytes).digest("hex");
    const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
    const patchSha256 = createHash("sha256").update(`patch:${sourcePath}`, "utf8").digest("hex");
    const baseSha = "b".repeat(40);
    const mergeBaseSha = "8".repeat(40);
    const headTreeSha = "c".repeat(40);
    const range = {
      startLine: 1,
      endLine: 1,
      coordinateSha256: acceptanceContextOverlayHeadRangeCoordinateSha256({
        path: sourcePath,
        patchSha256,
        startLine: 1,
        endLine: 1,
      }),
    };
    const baseIndexCore = {
      schemaVersion: 2 as const,
      backgroundOnly: true as const,
      pages: [],
      gaps: ["base_index_gap"],
    };
    const overlayCore = {
      schemaVersion: 2 as const,
      baseSha,
      mergeBaseSha,
      headSha: headA,
      files: [{
        path: sourcePath,
        status: "modified" as const,
        blobSha: sourceBlobSha,
        previousPath: null,
        patchSha256,
        patchByteCount: sourceBytes.length,
        headRanges: [range],
      }],
    };
    const packetIds = [packetId];
    const packetSetSha256 = acceptanceContextPacketSetSha256({ packetIds });
    const correctionPacketPayloadSetSha256 = acceptanceCorrectionPacketPayloadSetSha256({
      packets: [correctionPacket],
    });
    const contractSha256 = acceptanceContractSha256({
      acceptanceContractId: draft.contract.id,
      acceptanceContractVersion: draft.contract.version,
      contract: draft.contract.contract,
    });
    const baseIndex = {
      ...baseIndexCore,
      revisionSha256: acceptanceContextPackCustodyBaseIndexRevisionSha256(baseIndexCore),
    };
    const overlay = {
      ...overlayCore,
      manifestSha256: acceptanceContextPackCustodyOverlayManifestSha256(overlayCore),
    };
    const snapshot = await recordAcceptanceContextPackSnapshot({
      workspaceId,
      recordId: draft.record.id,
      reviewJobId: advanced.jobId,
      acceptanceContractId: draft.contract.id,
      acceptanceContractVersion: draft.contract.version,
      acceptanceContractSha256: contractSha256,
      repo: REPO,
      prNumber,
      expectedHeadSha: headA,
      baseSha,
      mergeBaseSha,
      headTreeSha,
      packetIds,
      packetSetSha256,
      correctionPacketPayloadSetSha256,
      compilerVersion: "r112-reviewer-source-v1",
      baseIndex,
      overlay,
      provenance: {
        schemaVersion: 1,
        included: [{ path: sourcePath, source: "overlay", reason: "Exact saved-filter implementation context" }],
        excluded: [{ path: null, source: "base_index", reason: "base_index_gap" }],
      },
      status: "admitted",
      reason: null,
    });
    const source = {
      kind: "exact_head_overlay" as const,
      path: sourcePath,
      blobSha: sourceBlobSha,
      fullContentSha256: sourceSha256,
      startLine: 1,
      endLine: 1,
      rangeSha256: sourceSha256,
      byteCount: sourceBytes.length,
      reason: "exact_patch_head_range",
      citation: `${sourcePath}@${sourceBlobSha}#L1-L1`,
    };
    const receiptCore = {
      kind: "exact_head_source_custody" as const,
      schemaVersion: 2 as const,
      repo: REPO,
      prNumber,
      baseSha,
      mergeBaseSha,
      headSha: headA,
      headTreeSha,
      manifestSha256: acceptanceContextOverlayManifestSha256({
        schemaVersion: 1,
        baseSha,
        mergeBaseSha,
        headSha: headA,
        files: [{ path: sourcePath, status: "modified" as const, blobSha: sourceBlobSha, previousPath: null }],
      }),
      changedManifest: [{
        path: sourcePath,
        status: "modified",
        blobSha: sourceBlobSha,
        previousPath: null,
        headRanges: [{ startLine: 1, endLine: 1 }],
        patchSha256,
        patchByteCount: sourceBytes.length,
      }],
      records: [{
        path: sourcePath,
        blobSha: sourceBlobSha,
        previousPath: null,
        contentSha256: sourceSha256,
        byteCount: sourceBytes.length,
        lineCount: 1,
        source: "exact_head_overlay",
        reason: "exact_base_to_head_compare",
      }],
      exclusions: [],
      directReadReceipts: [],
      selectedExactRanges: [{
        kind: source.kind,
        path: source.path,
        blobSha: source.blobSha,
        fullContentSha256: source.fullContentSha256,
        startLine: source.startLine,
        endLine: source.endLine,
        rangeSha256: source.rangeSha256,
        byteCount: source.byteCount,
      }],
    };
    const sourceCustodyReceipt = {
      ...receiptCore,
      identitySha256: acceptanceContextPackCanonicalSha256(receiptCore),
    };
    const binding = {
      sourceSnapshotId: snapshot.snapshot.id,
      workspaceId,
      recordId: draft.record.id,
      reviewJobId: advanced.jobId,
      acceptanceContractId: draft.contract.id,
      acceptanceContractVersion: draft.contract.version,
      acceptanceContractSha256: contractSha256,
      repo: REPO,
      prNumber,
      baseSha,
      mergeBaseSha,
      headSha: headA,
      headTreeSha,
      packetSetSha256,
      correctionPacketPayloadSetSha256,
      sourceSnapshotCompilerVersion: "r112-reviewer-source-v1",
      baseIndexRevisionSha256: baseIndex.revisionSha256,
      overlayManifestSha256: overlay.manifestSha256,
    };
    const manifest = {
      version: 1,
      acceptanceCriterionIds: [CRITERION_ID, SECOND_CRITERION_ID],
      unresolvedQuestionIds: [],
      packetIds,
      sources: [source],
      architectureBoundaries: [],
      tests: [],
      decisions: [],
      exclusions: [{
        source: "base_index_background",
        path: null,
        reason: "base_index_gap",
        identitySha256: createHash("sha256").update("base_index_gap", "utf8").digest("hex"),
      }],
      sourceCustody: {
        kind: "exact_head_source_custody",
        schemaVersion: 2,
        identitySha256: sourceCustodyReceipt.identitySha256,
      },
      budget: { counter: "utf8_byte_upper_bound_v1", limitBytes: 65_536 },
      custody: { fullSourceUploadAllowed: false, rawSourcePersisted: false, snippetsPersisted: false },
    };
    const compiler = {
      version: "r112-reviewer-pack-v1",
      policyVersion: "r112-reviewer-policy-v1",
      byteCounter: "utf8_byte_upper_bound_v1",
      byteBudget: 65_536,
    };
    const representations = {
      jsonSha256: createHash("sha256").update("reviewer-json", "utf8").digest("hex"),
      markdownSha256: createHash("sha256").update("reviewer-markdown", "utf8").digest("hex"),
    };
    const compiledCore = {
      kind: "compiled_acceptance_context_pack" as const,
      version: 1 as const,
      binding,
      compiler,
      manifest,
      sourceCustodyReceipt: {
        kind: sourceCustodyReceipt.kind,
        schemaVersion: sourceCustodyReceipt.schemaVersion,
        identitySha256: sourceCustodyReceipt.identitySha256,
      },
      exactHeadDependencyTreeProofs: [],
      representations,
      renderedByteCount: sourceBytes.length,
    };
    const compiled = {
      ...compiledCore,
      sourceCustodyReceipt,
      packSha256: acceptanceContextPackCanonicalSha256(compiledCore),
    };
    const persistedPack = await recordAcceptanceCompiledContextPack({
      workspaceId,
      sourceSnapshotId: snapshot.snapshot.id,
      compiled,
      exactSourceProofs: [{ kind: "exact_head_overlay", path: sourcePath, content: sourceContent }],
      exactGitTreeInclusionProofs: [],
    });
    const recorded = await recordPostedAcceptanceCriterionOutcomeBundle({
      workspaceId,
      recordId: draft.record.id,
      reviewJobId: advanced.jobId,
      postedReviewUrl: `https://github.com/${REPO}/pull/${prNumber}#pullrequestreview-${prNumber}`,
      inlineCommentsPosted: 0,
      commentsFolded: false,
    });
    if (recorded.kind !== "recorded" || !recorded.current) {
      throw new Error(`fixture could not record a current criterion outcome bundle: ${JSON.stringify(recorded)}`);
    }
    await db.update(reviewJobs).set({
      state: "posted",
      verdict: "failed",
      postedReviewUrl: `https://github.com/${REPO}/pull/${prNumber}#pullrequestreview-${prNumber}`,
    }).where(eq(reviewJobs.id, advanced.jobId));
    const current = await readCurrentAcceptanceCriterionOutcomeBundle({
      workspaceId,
      recordId: draft.record.id,
    });
    if (current.kind !== "current") throw new Error("fixture current bundle is unavailable");
    const evidence = current.bundle.outcomes[0]?.evidence;
    const artifactId = evidence?.kind === "execution_receipt"
      ? evidence.artifact?.artifactId ?? null
      : null;
    if (!artifactId) throw new Error("fixture opaque artifact id is unavailable");
    const gated = await readCurrentAcceptanceGatedGithubIssue({ workspaceId, recordId: draft.record.id });
    if (gated.kind !== "current" || gated.issue !== null) {
      throw new Error("fixture did not reach eligible, unpublished gated-issue custody");
    }
    return {
      workspaceId,
      recordId: draft.record.id,
      ownerUserId,
      memberUserId,
      foreignUserId,
      ownerSessionToken,
      memberSessionToken,
      foreignSessionToken,
      repo: REPO,
      prNumber,
      headA,
      headB,
      originalHeadCycleId: advanced.jobId,
      currentHeadCycleId: advanced.jobId,
      artifactId,
      artifactKey,
      artifactSha256: ARTIFACT_SHA256,
      artifactBytesBase64: PNG_BASE64,
      evidenceRef: result.evidenceRef,
      executionId,
      previewBootId: bootId,
      observedFailure,
      contextPackId: persistedPack.pack.id,
    };
  } catch (error) {
    if (createdWorkspace) await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    if (createdUsers) await db.delete(users).where(inArray(users.id, [ownerUserId, memberUserId, foreignUserId]));
    throw error;
  }
}

async function advance(state: ProofState): Promise<ProofState> {
  const advancedB = await advanceConfirmedAcceptanceRecordPullRequestHead({
    workspaceId: state.workspaceId,
    recordId: state.recordId,
    repo: state.repo,
    prNumber: state.prNumber,
    headSha: state.headB,
    event: "synchronize",
    deliveryId: `r112-browser:${state.recordId}:b`,
    admitReviewJob: true,
    headTransition: { beforeHeadSha: state.headA, afterHeadSha: state.headB },
    source: "github_webhook",
  });
  if (advancedB.kind !== "advanced") throw new Error("fixture could not advance to B");
  const advancedA2 = await advanceConfirmedAcceptanceRecordPullRequestHead({
    workspaceId: state.workspaceId,
    recordId: state.recordId,
    repo: state.repo,
    prNumber: state.prNumber,
    headSha: state.headA,
    event: "synchronize",
    deliveryId: `r112-browser:${state.recordId}:a2`,
    admitReviewJob: true,
    headTransition: { beforeHeadSha: state.headB, afterHeadSha: state.headA },
    source: "github_webhook",
  });
  if (advancedA2.kind !== "advanced" || advancedA2.jobId === state.originalHeadCycleId) {
    throw new Error("fixture could not create a distinct A2 occurrence");
  }
  return { ...state, currentHeadCycleId: advancedA2.jobId };
}

async function inspect(state: ProofState) {
  const [requestRows, publicationRows, approvalRows, recordRows, corrections, outcome, gated] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` })
      .from(acceptanceGatedGithubIssueRequests)
      .where(eq(acceptanceGatedGithubIssueRequests.recordId, state.recordId)),
    db.select({ count: sql<number>`count(*)::int` })
      .from(acceptanceGatedGithubIssuePublications)
      .where(eq(acceptanceGatedGithubIssuePublications.recordId, state.recordId)),
    db.select({ count: sql<number>`count(*)::int` })
      .from(jaceApprovals)
      .where(eq(jaceApprovals.workspaceId, state.workspaceId)),
    db.select({ currentPrHeadSha: changeRecords.currentPrHeadSha, currentPrHeadCycleId: changeRecords.currentPrHeadCycleId })
      .from(changeRecords)
      .where(and(eq(changeRecords.workspaceId, state.workspaceId), eq(changeRecords.id, state.recordId))),
    readCurrentAcceptanceCorrectionPackets({ workspaceId: state.workspaceId, recordId: state.recordId }),
    readCurrentAcceptanceCriterionOutcomeBundle({ workspaceId: state.workspaceId, recordId: state.recordId }),
    readCurrentAcceptanceGatedGithubIssue({ workspaceId: state.workspaceId, recordId: state.recordId }),
  ]);
  return {
    requests: requestRows[0]?.count ?? -1,
    publications: publicationRows[0]?.count ?? -1,
    approvals: approvalRows[0]?.count ?? -1,
    currentHeadSha: recordRows[0]?.currentPrHeadSha ?? null,
    currentHeadCycleId: recordRows[0]?.currentPrHeadCycleId ?? null,
    correctionPackets: corrections.kind,
    correctionPacketReason: corrections.kind === "not_ready" ? corrections.reason : null,
    criterionOutcomes: outcome.kind,
    criterionOutcomeReason: outcome.kind === "not_ready" ? outcome.reason : null,
    gatedIssue: gated.kind,
    gatedIssueReason: gated.kind === "not_ready" ? gated.reason : null,
  };
}

async function main(): Promise<unknown> {
  const command = process.argv[2];
  if (command === "seed") return seed();
  if (command !== "advance" && command !== "inspect" && command !== "cleanup") {
    throw new Error("usage: proof-r112-console-record.ts seed|advance|inspect|cleanup");
  }
  const input = await readInput();
  if (!isProofState(input)) throw new Error("fixture input is not an exact R11.2 proof state");
  if (command === "advance") return advance(input);
  if (command === "inspect") return inspect(input);
  await exactCleanup(input);
  return { cleaned: true };
}

try {
  const result = await main();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  await new Promise<void>((resolve) => setImmediate(resolve));
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown fixture error";
  process.stderr.write(`R11.2 browser fixture failed: ${message}\n`);
  await new Promise<void>((resolve) => setImmediate(resolve));
  process.exit(1);
}
