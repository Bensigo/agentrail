import { createHash } from "node:crypto";
import { z } from "zod";

export const ACCEPTANCE_CORRECTION_PACKETS_PATH = "/api/v1/agent/acceptance-correction-packets";
export const ACCEPTANCE_CORRECTION_TIMEOUT_MS = 8_000;
export const MAX_ACCEPTANCE_CORRECTION_RESPONSE_BYTES = 12 * 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA1 = /^[0-9a-f]{40}$/iu;
const SHA256 = /^[0-9a-f]{64}$/iu;
const CORRECTION_PACKET_ID = /^correction-[0-9a-f]{48}$/iu;
const SAFE_REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;
const SECRET_LIKE = /(?:\b(?:bearer|token|authorization)\s+|\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+))/iu;

export type CorrectionClientFailureReason =
  | "invalid_record"
  | "config_missing"
  | "unreachable"
  | "unauthorized"
  | "server_unavailable"
  | "invalid_response";

export type AcceptanceCorrectionPacketRead =
  | { kind: "not_found" }
  | { kind: "not_current" }
  | {
      kind: "not_ready";
      reason:
        | "review_job_unavailable"
        | "confirmed_contract_unavailable"
        | "no_correction_packets"
        | "invalid_packet_custody";
    }
  | {
      kind: "current";
      binding: {
        workspaceId: string;
        recordId: string;
        reviewJobId: string;
        repo: string;
        prNumber: number;
        headSha: string;
        headCycleId: string;
        authorityGeneration: number;
        acceptanceContract: { id: string; version: number; sha256: string };
      };
      packetIds: string[];
      packetSetSha256: string;
      correctionPacketPayloadSetSha256: string;
      packets: Record<string, unknown>[];
    };

export type FetchAcceptanceCorrectionPacketsResult =
  | { ok: true; correctionPackets: AcceptanceCorrectionPacketRead }
  | { ok: false; reason: CorrectionClientFailureReason };

type FetchResponse = {
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
};

type FetchImplementation = (
  url: string,
  init: RequestInit,
) => Promise<FetchResponse>;

type CorrectionClientEnvironment = {
  AGENTRAIL_SERVER_BASE_URL?: string;
  AGENTRAIL_MCP_CORRECTION_API_KEY?: string;
};

function record(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

function canonicalJson(value: unknown): string | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : null;
  if (Array.isArray(value)) {
    const items = value.map(canonicalJson);
    return items.some((item) => item === null) ? null : `[${items.join(",")}]`;
  }
  if (!record(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const entries: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const nested = canonicalJson(value[key]);
    if (nested === null) return null;
    entries.push(`${JSON.stringify(key)}:${nested}`);
  }
  return `{${entries.join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const boundedText = (max: number) => z.string().min(1).max(max).refine((value) =>
  value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value) && !SECRET_LIKE.test(value));
const safeRepo = z.string().regex(SAFE_REPO).refine((value) =>
  value.split("/").every((segment) => segment !== "." && segment !== ".."));
const positiveStatus = z.number().int().min(100).max(599);
const acceptanceContractRef = z.object({
  id: boundedText(512),
  version: z.number().int().positive(),
}).strict();
const criterion = z.object({
  id: boundedText(512),
  snapshot: boundedText(2_000),
}).strict();
const apiRequest = z.object({
  method: z.literal("GET"),
  path: boundedText(2_048),
  expectedStatus: positiveStatus,
}).strict();
const expectedJsonAssertion = z.object({
  pointer: boundedText(1_024),
  equalsType: z.enum(["null", "boolean", "number", "string"]),
  equalsHmacSha256: z.string().regex(SHA256),
}).strict();
const dataRequest = z.object({
  method: z.literal("GET"),
  path: boundedText(2_048),
  expectedStatus: positiveStatus,
  digestAlgorithm: z.literal("hmac-sha256-v1"),
  digestKeyId: boundedText(64),
  digestContext: z.string().regex(SHA256),
  expectedJson: z.array(expectedJsonAssertion).min(1).max(12),
}).strict();
const uiStep = z.union([
  z.object({ action: z.literal("open"), path: boundedText(2_048) }).strict(),
  z.object({ action: z.literal("click"), selector: boundedText(2_048) }).strict(),
  z.object({
    action: z.literal("fill"),
    selector: boundedText(2_048),
    value: z.literal("[REDACTED_FILL]"),
  }).strict(),
  z.object({ action: z.literal("press"), key: boundedText(128) }).strict(),
  z.object({ action: z.literal("expect_text"), text: boundedText(2_048) }).strict(),
  z.object({ action: z.literal("screenshot"), label: boundedText(512) }).strict(),
]);
const environmentKind = z.union([z.literal("isolated_preview"), z.null()]);
const flow = boundedText(2_000);
const affectedContext = z.discriminatedUnion("modality", [
  z.object({
    modality: z.literal("ui"),
    environmentKind,
    flow,
    reproduction: z.object({
      modality: z.literal("ui"),
      steps: z.array(uiStep).min(1).max(12),
    }).strict(),
  }).strict(),
  z.object({
    modality: z.literal("api"),
    environmentKind,
    flow,
    reproduction: z.object({ modality: z.literal("api"), request: apiRequest }).strict(),
  }).strict(),
  z.object({
    modality: z.literal("data"),
    environmentKind,
    flow,
    reproduction: z.object({ modality: z.literal("data"), request: dataRequest }).strict(),
  }).strict(),
  z.object({
    modality: z.literal("job"),
    environmentKind,
    flow,
    reproduction: z.object({
      modality: z.literal("job"),
      request: z.object({
        trigger: z.object({
          method: z.literal("POST"),
          path: boundedText(2_048),
          expectedStatus: positiveStatus,
        }).strict(),
        readback: dataRequest,
      }).strict(),
    }).strict(),
  }).strict(),
]);
const evidence = z.object({
  evidenceRef: boundedText(2_000),
  artifactKey: boundedText(2_000).optional(),
  executionId: boundedText(512).optional(),
  previewBootId: boundedText(512),
}).strict();

function deterministicCorrectionPacketId(packet: {
  jobId: string;
  criterion: { id: string };
  headSha: string;
  recordId: string;
  acceptanceContract: { id: string; version: number };
}): string {
  return `correction-${sha256(JSON.stringify({
    jobId: packet.jobId,
    criterionId: packet.criterion.id,
    headSha: packet.headSha,
    recordId: packet.recordId,
    acceptanceContractId: packet.acceptanceContract.id,
    acceptanceContractVersion: packet.acceptanceContract.version,
  })).slice(0, 48)}`;
}

const correctionPacket = z.object({
  kind: z.literal("review_job_correction_packet"),
  version: z.literal(1),
  packetId: z.string().regex(CORRECTION_PACKET_ID),
  workspaceId: boundedText(512),
  repo: safeRepo,
  prNumber: z.number().int().positive(),
  headSha: z.string().regex(SHA1),
  recordId: boundedText(512),
  jobId: boundedText(512),
  acceptanceContract: acceptanceContractRef,
  criterion,
  basis: z.literal("acceptance_contract"),
  state: z.enum(["failed", "not_proven"]),
  expected: boundedText(2_000),
  observed: boundedText(2_000),
  affectedContext,
  evidence,
  scopeBoundary: boundedText(2_000),
  impact: boundedText(2_000),
  requiredCorrection: boundedText(2_000),
  reverification: boundedText(2_000),
}).strict().superRefine((packet, ctx) => {
  if (packet.expected !== packet.criterion.snapshot) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "expected criterion mismatch" });
  }
  if (packet.packetId !== deterministicCorrectionPacketId(packet)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "packet identity mismatch" });
  }
});

const currentCorrectionPackets = z.object({
  kind: z.literal("current"),
  binding: z.object({
    workspaceId: boundedText(512),
    recordId: boundedText(512),
    reviewJobId: boundedText(512),
    repo: safeRepo,
    prNumber: z.number().int().positive(),
    headSha: z.string().regex(SHA1),
    headCycleId: boundedText(512),
    authorityGeneration: z.number().int().nonnegative(),
    acceptanceContract: z.object({
      id: boundedText(512),
      version: z.number().int().positive(),
      sha256: z.string().regex(SHA256),
    }).strict(),
  }).strict(),
  packetIds: z.array(boundedText(512)).min(1).max(100),
  packetSetSha256: z.string().regex(SHA256),
  correctionPacketPayloadSetSha256: z.string().regex(SHA256),
  packets: z.array(correctionPacket).min(1).max(100),
}).strict();

const NOT_READY_REASONS = new Set([
  "review_job_unavailable",
  "confirmed_contract_unavailable",
  "no_correction_packets",
  "invalid_packet_custody",
]);

function projectCorrectionPackets(value: unknown, expectedRecordId: string): AcceptanceCorrectionPacketRead | null {
  if (!record(value) || typeof value.kind !== "string") return null;
  if (value.kind === "not_found" || value.kind === "not_current") {
    return exactKeys(value, ["kind"]) ? { kind: value.kind } : null;
  }
  if (value.kind === "not_ready") {
    return exactKeys(value, ["kind", "reason"]) && typeof value.reason === "string"
      && NOT_READY_REASONS.has(value.reason)
      ? value as AcceptanceCorrectionPacketRead
      : null;
  }
  const parsed = currentCorrectionPackets.safeParse(value);
  if (!parsed.success) return null;
  const current = parsed.data;
  const binding = current.binding;
  if (binding.recordId !== expectedRecordId || binding.headCycleId !== binding.reviewJobId
    || current.packetIds.length !== current.packets.length
    || new Set(current.packetIds).size !== current.packetIds.length) return null;
  const orderedIds = [...current.packetIds].sort((left, right) => left.localeCompare(right));
  if (current.packetIds.some((packetId, index) => packetId !== orderedIds[index])) return null;

  for (let index = 0; index < current.packets.length; index += 1) {
    const packet = current.packets[index]!;
    if (packet.packetId !== current.packetIds[index]
      || packet.workspaceId !== binding.workspaceId || packet.recordId !== binding.recordId
      || packet.jobId !== binding.reviewJobId || packet.repo !== binding.repo
      || packet.prNumber !== binding.prNumber || packet.headSha !== binding.headSha
      || packet.acceptanceContract.id !== binding.acceptanceContract.id
      || packet.acceptanceContract.version !== binding.acceptanceContract.version) return null;
  }

  const packetSetSha256 = sha256(JSON.stringify({
    kind: "acceptance_context_packet_set",
    version: 1,
    packetIds: current.packetIds,
  }));
  const canonicalPayloadSet = canonicalJson({
    kind: "acceptance_correction_packet_payload_set",
    version: 1,
    packets: [...current.packets].sort((left, right) => left.packetId.localeCompare(right.packetId)),
  });
  if (current.packetSetSha256 !== packetSetSha256 || canonicalPayloadSet === null
    || current.correctionPacketPayloadSetSha256 !== sha256(canonicalPayloadSet)) return null;
  return current as AcceptanceCorrectionPacketRead;
}

function resolveConfig(env: CorrectionClientEnvironment): { baseUrl: string; apiKey: string } | null {
  const rawBaseUrl = String(env.AGENTRAIL_SERVER_BASE_URL ?? "").trim();
  const apiKey = String(env.AGENTRAIL_MCP_CORRECTION_API_KEY ?? "").trim();
  if (!rawBaseUrl || !apiKey) return null;
  try {
    const parsed = new URL(rawBaseUrl);
    const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"
      || parsed.hostname === "::1" || parsed.hostname === "[::1]";
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) return null;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return { baseUrl: `${parsed.origin}${pathname}`, apiKey };
  } catch {
    return null;
  }
}

async function readBoundedJson(response: FetchResponse, maxBytes: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    try { await response.body?.cancel(); } catch { /* bounded failure */ }
    throw new Error("invalid response");
  }
  if (!response.body) throw new Error("invalid response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* bounded failure */ }
        throw new Error("invalid response");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function cancelResponseBody(response: FetchResponse): void {
  if (!response.body) return;
  void response.body.cancel().catch(() => { /* sanitized bounded discard */ });
}

export async function fetchAcceptanceCorrectionPackets(input: {
  recordId: string;
  env?: CorrectionClientEnvironment;
  fetchImpl?: FetchImplementation;
  timeoutMs?: number;
  maxResponseBytes?: number;
}): Promise<FetchAcceptanceCorrectionPacketsResult> {
  const recordId = input.recordId.trim().toLowerCase();
  if (!UUID.test(recordId)) return { ok: false, reason: "invalid_record" };
  const config = resolveConfig(input.env ?? process.env);
  if (!config) return { ok: false, reason: "config_missing" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? ACCEPTANCE_CORRECTION_TIMEOUT_MS);
  let response: FetchResponse;
  let raw: unknown;
  try {
    try {
      response = await (input.fetchImpl ?? fetch)(
        `${config.baseUrl}${ACCEPTANCE_CORRECTION_PACKETS_PATH}`,
        {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ recordId }),
        },
      );
    } catch {
      return { ok: false, reason: "unreachable" };
    }
    if (response.status === 401 || response.status === 403) {
      cancelResponseBody(response);
      return { ok: false, reason: "unauthorized" };
    }
    if (response.status >= 500) {
      cancelResponseBody(response);
      return { ok: false, reason: "server_unavailable" };
    }
    if (response.status < 200 || response.status >= 300) {
      cancelResponseBody(response);
      return { ok: false, reason: "invalid_response" };
    }
    try {
      raw = await readBoundedJson(response, input.maxResponseBytes ?? MAX_ACCEPTANCE_CORRECTION_RESPONSE_BYTES);
    } catch {
      return { ok: false, reason: controller.signal.aborted ? "unreachable" : "invalid_response" };
    }
  } finally {
    clearTimeout(timer);
  }

  if (!record(raw) || !exactKeys(raw, ["schemaVersion", "correctionPackets"]) || raw.schemaVersion !== 1) {
    return { ok: false, reason: "invalid_response" };
  }
  const correctionPackets = projectCorrectionPackets(raw.correctionPackets, recordId);
  return correctionPackets
    ? { ok: true, correctionPackets }
    : { ok: false, reason: "invalid_response" };
}
