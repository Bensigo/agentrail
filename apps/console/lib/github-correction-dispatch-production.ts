import {
  acceptanceCorrectionDispatchId,
  acceptanceContractSha256,
  acceptanceCorrectionPacketPayloadSetSha256,
  acceptanceContextOverlayManifestSha256,
  acceptanceContextPacketSetSha256,
  acceptanceContextPackSnapshotId,
  getInstallationToken,
  getRepositoryByName,
  getReviewJobById,
  listWikiPages,
  projectConfirmedAcceptanceContract,
  queueSelectedCorrectionDispatch,
  readDurableCorrectionDispatchFallback,
  recordDurableCorrectionDispatchFallback,
  readAcceptanceBuilderRouteSelection,
  readAcceptanceContracts,
  readChangeRecordTimelineByPr,
  recordAcceptanceContextPackSnapshot,
  resolveActiveAcceptanceCompiledContextPackForRecord,
  resolveAcceptanceBuilderRouteCapabilityProfile,
  resolveAcceptanceContextPackCustody,
  validateReviewJobCorrectionPacketPayload,
  type AcceptanceContextPackCustodyResolution,
} from "@agentrail/db-postgres";
import {
  ACCEPTANCE_CONTEXT_PACK_COMPILER_VERSION,
  ACCEPTANCE_CONTEXT_PACK_POLICY_VERSION,
  compileAndRecordAcceptanceContextPack,
} from "./acceptance-context-pack-compiler";
import { buildAcceptanceContextPackWikiBaseIndex } from "./acceptance-context-pack-wiki-base-index";
import { materializeExactHeadGithubContent } from "./github-exact-head-content";
import {
  exactHeadContextCustodyOverlay,
  readExactHeadGithubContext,
  type ExactHeadGithubContextSnapshot,
} from "./github-exact-head-context";
import {
  runGithubCorrectionCarrier,
  type GithubCorrectionCarrierResult,
} from "./github-correction-carrier";

/**
 * Trusted R8.2 production seam. The caller supplies only the running review
 * job identity; every repository, head, Contract, packet, source, route,
 * recipient, body, and dispatch coordinate is re-derived server-side.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SOURCE_SNAPSHOT_COMPILER_VERSION = "exact-head-overlay-v2";

export type GithubCorrectionDispatchProductionInput = {
  workspaceId: string;
  jobId: string;
};

export type GithubCorrectionDispatchProductionResult =
  | ({ dispatchId: string } & GithubCorrectionCarrierResult)
  | {
      kind: "durable_fallback_recorded";
      dispatchId: string;
      fallbackId: string;
      lane: "github_findings_and_jace" | "jace_only";
    }
  | { kind: "invalid_input" | "not_current" }
  | {
      kind: "not_ready";
      reason:
        | "job_not_posted"
        | "missing_correction_packets"
        | "missing_selected_github_route"
        | "github_credential_unavailable";
    }
  | { kind: "not_proven"; stage: "exact_context" | "exact_content" | "pack_compilation" }
  | { kind: "held"; reason: "storage_unavailable" };

function isInput(value: unknown): value is GithubCorrectionDispatchProductionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return Object.keys(input).length === 2
    && typeof input.workspaceId === "string" && UUID.test(input.workspaceId)
    && typeof input.jobId === "string" && UUID.test(input.jobId);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactPacketSet(input: {
  workspaceId: string;
  jobId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  recordId: string;
  contractId: string;
  contractVersion: number;
  criteria: ReadonlyMap<string, string>;
  events: Array<{ eventKey: string; stage: string; actor: string; payloadRef: unknown }>;
}): Record<string, unknown>[] | null {
  const prefix = `review:correction:${input.jobId}:`;
  const events = input.events.filter(({ eventKey }) => eventKey.startsWith(prefix));
  if (events.length < 1 || events.length > 100) return null;
  const packets: Record<string, unknown>[] = [];
  for (const event of events) {
    const packet = event.payloadRef;
    if (!validateReviewJobCorrectionPacketPayload(packet)
      || event.stage !== "review" || event.actor !== "reviewer-of-record"
      || packet["workspaceId"] !== input.workspaceId
      || packet["jobId"] !== input.jobId
      || packet["repo"] !== input.repo
      || packet["prNumber"] !== input.prNumber
      || packet["headSha"] !== input.headSha
      || packet["recordId"] !== input.recordId) return null;
    const acceptanceContract = packet["acceptanceContract"] as Record<string, unknown>;
    const criterion = packet["criterion"] as Record<string, unknown>;
    if (acceptanceContract["id"] !== input.contractId
      || acceptanceContract["version"] !== input.contractVersion
      || input.criteria.get(String(criterion["id"])) !== criterion["snapshot"]
      || event.eventKey !== `${prefix}${String(criterion["id"])}`) return null;
    packets.push(packet);
  }
  packets.sort((left, right) => compareText(String(left["packetId"]), String(right["packetId"])));
  return new Set(packets.map((packet) => packet["packetId"])).size === packets.length
    ? packets
    : null;
}

function mappedCarrierResult(
  dispatchId: string,
  result: GithubCorrectionCarrierResult,
): GithubCorrectionDispatchProductionResult {
  return { ...result, dispatchId };
}

function exactSnapshotFromCustody(
  custody: AcceptanceContextPackCustodyResolution,
): ExactHeadGithubContextSnapshot | null {
  const source = custody.sourceSnapshot;
  if (!source.baseSha || !source.mergeBaseSha || !source.headTreeSha || !source.overlay) return null;
  const changedFiles = source.overlay.files.map((file) => ({
    path: file.path,
    status: file.status,
    blobSha: file.blobSha,
    previousPath: file.previousPath,
    patchSha256: file.patchSha256,
    patchByteCount: file.patchByteCount,
    headRanges: file.headRanges.length > 0
      ? file.headRanges.map(({ startLine, endLine }) => ({ startLine, endLine }))
      : null,
  }));
  const manifestSha256 = acceptanceContextOverlayManifestSha256({
    schemaVersion: 1,
    baseSha: source.baseSha,
    mergeBaseSha: source.mergeBaseSha,
    headSha: source.expectedHeadSha,
    files: changedFiles.map(({ path, status, blobSha, previousPath }) => ({
      path,
      status,
      blobSha,
      previousPath,
    })),
  });
  return {
    repo: source.repo,
    prNumber: source.prNumber,
    baseSha: source.baseSha,
    mergeBaseSha: source.mergeBaseSha,
    headSha: source.expectedHeadSha,
    headTreeSha: source.headTreeSha,
    changedFiles,
    manifestSha256,
    provenance: {
      schemaVersion: 1,
      included: changedFiles.map(({ path }) => ({
        path,
        source: "overlay" as const,
        reason: "exact_base_to_head_compare" as const,
      })),
      excluded: [],
    },
  };
}

async function queueAndRunCarrier(input: {
  workspaceId: string;
  compiledPackId: string;
  selectedAdapter: "github_codex" | "github_claude";
  expectedDispatchId: string;
}): Promise<GithubCorrectionDispatchProductionResult> {
  const queued = await queueSelectedCorrectionDispatch({
    workspaceId: input.workspaceId,
    compiledPackId: input.compiledPackId,
  });
  if (queued.dispatch.id !== input.expectedDispatchId
    || queued.dispatch.routeAdapter !== input.selectedAdapter) return { kind: "not_current" };
  const carrier = await runGithubCorrectionCarrier({
    workspaceId: input.workspaceId,
    dispatchId: queued.dispatch.id,
  });
  if (carrier.kind === "carrier_accepted"
    || carrier.kind === "not_current"
    || carrier.kind === "not_ready"
    || carrier.kind === "invalid_input"
    || (carrier.kind === "held" && carrier.reason === "storage_unavailable")) {
    return mappedCarrierResult(queued.dispatch.id, carrier);
  }

  let fallback: Awaited<ReturnType<typeof recordDurableCorrectionDispatchFallback>>;
  try {
    fallback = await recordDurableCorrectionDispatchFallback({
      workspaceId: input.workspaceId,
      dispatchId: queued.dispatch.id,
    });
  } catch {
    return {
      kind: "held",
      reason: "storage_unavailable",
      dispatchId: queued.dispatch.id,
    };
  }
  if (fallback.kind === "recorded" || fallback.kind === "replayed") {
    return {
      kind: "durable_fallback_recorded",
      dispatchId: queued.dispatch.id,
      fallbackId: fallback.fallback.id,
      lane: fallback.fallback.lane,
    };
  }
  if (fallback.kind === "not_current") return { kind: "not_current" };
  return mappedCarrierResult(queued.dispatch.id, carrier);
}

async function materializeCompileQueueAndRun(input: {
  workspaceId: string;
  selectedAdapter: "github_codex" | "github_claude";
  expectedDispatchId: string;
  token: string;
  snapshot: ExactHeadGithubContextSnapshot;
  custody: AcceptanceContextPackCustodyResolution;
}): Promise<GithubCorrectionDispatchProductionResult> {
  const materialization = await materializeExactHeadGithubContent({
    token: input.token,
    snapshot: input.snapshot,
  });
  if (!materialization.ok) return { kind: "not_proven", stage: "exact_content" };
  const compiled = await compileAndRecordAcceptanceContextPack({
    custody: input.custody,
    snapshot: input.snapshot,
    materialization: materialization.materialization,
  });
  if (!compiled.ok) return { kind: "not_proven", stage: "pack_compilation" };
  return queueAndRunCarrier({
    workspaceId: input.workspaceId,
    compiledPackId: compiled.persistence.pack.id,
    selectedAdapter: input.selectedAdapter,
    expectedDispatchId: input.expectedDispatchId,
  });
}

/**
 * Produce, queue, and run one exact-current selected GitHub correction.
 * Every failure before a DB reservation is fail-closed and produces no
 * carrier write. Existing immutable snapshot/Pack/dispatch rows replay.
 */
export async function produceAndRunGithubCorrectionDispatch(
  input: GithubCorrectionDispatchProductionInput,
): Promise<GithubCorrectionDispatchProductionResult> {
  if (!isInput(input)) return { kind: "invalid_input" };
  try {
    const job = await getReviewJobById(input.jobId);
    if (!job || job.workspaceId !== input.workspaceId || job.state !== "running") {
      return { kind: "not_ready", reason: "job_not_posted" };
    }
    const timeline = await readChangeRecordTimelineByPr({
      workspaceId: input.workspaceId,
      repo: job.repo,
      prNumber: job.prNumber,
    });
    if (!timeline || !timeline.record.currentPrHeadAuthoritative
      || timeline.record.currentPrHeadSha !== job.headSha
      || timeline.record.currentPrHeadCycleId !== job.id) return { kind: "not_current" };

    // Durable fallback replay belongs to the immutable dispatch aggregate,
    // not the mutable current route/profile. Resolve it before those lookups
    // so later configuration drift cannot strand an already-recorded fallback.
    const existingDispatchId = acceptanceCorrectionDispatchId({
      recordId: timeline.record.id,
      headCycleId: timeline.record.currentPrHeadCycleId,
    });
    const existingFallback = await readDurableCorrectionDispatchFallback({
      workspaceId: input.workspaceId,
      dispatchId: existingDispatchId,
    });
    if (existingFallback.kind === "found") {
      return {
        kind: "durable_fallback_recorded",
        dispatchId: existingDispatchId,
        fallbackId: existingFallback.fallback.id,
        lane: existingFallback.fallback.lane,
      };
    }
    if (existingFallback.kind === "not_current") return { kind: "not_current" };

    const selection = await readAcceptanceBuilderRouteSelection({
      workspaceId: input.workspaceId,
      recordId: timeline.record.id,
    });
    if (!selection
      || (selection.route.adapter !== "github_codex" && selection.route.adapter !== "github_claude")) {
      return { kind: "not_ready", reason: "missing_selected_github_route" };
    }
    const selectedAdapter = selection.route.adapter;
    const capability = await resolveAcceptanceBuilderRouteCapabilityProfile({
      workspaceId: input.workspaceId,
      routeId: selection.route.id,
    });
    if (!capability) return { kind: "not_ready", reason: "missing_selected_github_route" };

    const contracts = await readAcceptanceContracts({
      workspaceId: input.workspaceId,
      recordId: timeline.record.id,
    });
    const confirmed = contracts?.filter(({ status }) => status === "confirmed") ?? [];
    const contract = confirmed.length === 1
      ? projectConfirmedAcceptanceContract(confirmed[0]!.contract)
      : null;
    if (!contract) return { kind: "not_ready", reason: "missing_correction_packets" };
    const criteria = new Map(contract.acceptanceCriteria.map(({ id, text }) => [id, text]));
    const postedAttestation = timeline.events.find(({ eventKey }) =>
      eventKey === `review:github-posted:${job.id}`);
    const postedPayload = postedAttestation?.payloadRef;
    if (!postedAttestation || postedAttestation.stage !== "review"
      || postedAttestation.actor !== "reviewer-of-record"
      || !postedPayload || typeof postedPayload !== "object" || Array.isArray(postedPayload)
      || (postedPayload as Record<string, unknown>)["kind"] !== "review_job_github_posted"
      || (postedPayload as Record<string, unknown>)["jobId"] !== job.id
      || (postedPayload as Record<string, unknown>)["workspaceId"] !== input.workspaceId
      || (postedPayload as Record<string, unknown>)["repo"] !== job.repo
      || (postedPayload as Record<string, unknown>)["prNumber"] !== job.prNumber
      || (postedPayload as Record<string, unknown>)["headSha"] !== job.headSha
      || (postedPayload as Record<string, unknown>)["recordId"] !== timeline.record.id
      || (postedPayload as Record<string, unknown>)["acceptanceContractId"] !== confirmed[0]!.id
      || (postedPayload as Record<string, unknown>)["acceptanceContractVersion"] !== confirmed[0]!.version) {
      return { kind: "not_ready", reason: "job_not_posted" };
    }
    const packets = exactPacketSet({
      workspaceId: input.workspaceId,
      jobId: job.id,
      repo: job.repo,
      prNumber: job.prNumber,
      headSha: job.headSha,
      recordId: timeline.record.id,
      contractId: confirmed[0]!.id,
      contractVersion: confirmed[0]!.version,
      criteria,
      events: timeline.events,
    });
    if (!packets) return { kind: "not_ready", reason: "missing_correction_packets" };

    const packetIds = packets.map((packet) => String(packet["packetId"]));
    const packetSetSha256 = acceptanceContextPacketSetSha256({ packetIds });
    const sourceSnapshotId = acceptanceContextPackSnapshotId({
      reviewJobId: job.id,
      compilerVersion: SOURCE_SNAPSHOT_COMPILER_VERSION,
      packetSetSha256,
    });
    const existingPack = await resolveActiveAcceptanceCompiledContextPackForRecord({
      workspaceId: input.workspaceId,
      recordId: timeline.record.id,
      reviewJobId: job.id,
      compilerVersion: ACCEPTANCE_CONTEXT_PACK_COMPILER_VERSION,
      policyVersion: ACCEPTANCE_CONTEXT_PACK_POLICY_VERSION,
    });
    if (existingPack) {
      return queueAndRunCarrier({
        workspaceId: input.workspaceId,
        compiledPackId: existingPack.id,
        selectedAdapter,
        expectedDispatchId: existingDispatchId,
      });
    }

    let existingCustody: AcceptanceContextPackCustodyResolution | null = null;
    try {
      existingCustody = await resolveAcceptanceContextPackCustody({
        workspaceId: input.workspaceId,
        sourceSnapshotId,
      });
    } catch {
      // No admitted snapshot is the normal first-run case. The fresh path
      // below will perform the authoritative insert; a storage failure still
      // fails closed when that insert is attempted.
    }
    if (existingCustody) {
      const existingSnapshot = exactSnapshotFromCustody(existingCustody);
      if (!existingSnapshot) return { kind: "not_proven", stage: "exact_context" };
      const token = await getInstallationToken(input.workspaceId);
      if (!token) return { kind: "not_ready", reason: "github_credential_unavailable" };
      return materializeCompileQueueAndRun({
        workspaceId: input.workspaceId,
        selectedAdapter,
        expectedDispatchId: existingDispatchId,
        token,
        snapshot: existingSnapshot,
        custody: existingCustody,
      });
    }

    const repository = await getRepositoryByName(input.workspaceId, job.repo);
    if (!repository) return { kind: "not_ready", reason: "missing_correction_packets" };
    const token = await getInstallationToken(input.workspaceId);
    if (!token) return { kind: "not_ready", reason: "github_credential_unavailable" };

    const exact = await readExactHeadGithubContext({
      token,
      repo: job.repo,
      prNumber: job.prNumber,
      expectedHeadSha: job.headSha,
    });
    if (!exact.ok) {
      return exact.reason === "head_mismatch"
        ? { kind: "not_current" }
        : { kind: "not_proven", stage: "exact_context" };
    }
    const overlay = exactHeadContextCustodyOverlay(exact.snapshot);
    if (!overlay) return { kind: "not_proven", stage: "exact_context" };

    const wikiPages = await listWikiPages(input.workspaceId, repository.id);
    const baseIndex = buildAcceptanceContextPackWikiBaseIndex({
      workspaceId: input.workspaceId,
      repositoryId: repository.id,
      pages: wikiPages,
    });
    const contractSha256 = acceptanceContractSha256({
      acceptanceContractId: confirmed[0]!.id,
      acceptanceContractVersion: confirmed[0]!.version,
      contract: confirmed[0]!.contract,
    });
    const packetPayloadSetSha256 = acceptanceCorrectionPacketPayloadSetSha256({ packets });
    const provenance = {
      schemaVersion: 1 as const,
      included: [
        ...baseIndex.pages.map(({ slug }) => ({
          path: slug,
          source: "base_index" as const,
          reason: "server_wiki_background",
        })),
        ...overlay.files.map(({ path }) => ({
          path,
          source: "overlay" as const,
          reason: "exact_base_to_head_compare",
        })),
      ],
      excluded: baseIndex.gaps.map((reason) => ({
        path: null,
        source: "base_index" as const,
        reason,
      })),
    };
    const persistedSnapshot = await recordAcceptanceContextPackSnapshot({
      workspaceId: input.workspaceId,
      recordId: timeline.record.id,
      reviewJobId: job.id,
      acceptanceContractId: confirmed[0]!.id,
      acceptanceContractVersion: confirmed[0]!.version,
      acceptanceContractSha256: contractSha256,
      repo: job.repo,
      prNumber: job.prNumber,
      expectedHeadSha: job.headSha,
      baseSha: exact.snapshot.baseSha,
      mergeBaseSha: exact.snapshot.mergeBaseSha,
      headTreeSha: exact.snapshot.headTreeSha,
      packetIds,
      packetSetSha256,
      correctionPacketPayloadSetSha256: packetPayloadSetSha256,
      compilerVersion: SOURCE_SNAPSHOT_COMPILER_VERSION,
      baseIndex,
      overlay,
      provenance,
      status: "admitted",
      reason: null,
    });
    const custody = await resolveAcceptanceContextPackCustody({
      workspaceId: input.workspaceId,
      sourceSnapshotId: persistedSnapshot.snapshot.id,
    });
    return materializeCompileQueueAndRun({
      workspaceId: input.workspaceId,
      selectedAdapter,
      expectedDispatchId: existingDispatchId,
      token,
      snapshot: exact.snapshot,
      custody,
    });
  } catch {
    return { kind: "held", reason: "storage_unavailable" };
  }
}
