import { createHash } from "node:crypto";

// Pure core for the read-only Change Record chat tool. The console resolves
// the tenant from the root Eve session; repo and PR are only lookup keys.

export const CHANGE_RECORD_PR_PATH = "/api/v1/runner/change-record/pr";
export const CHANGE_RECORD_TIMEOUT_MS = 8_000;
export const MAX_CHANGE_RECORD_RESPONSE_BYTES = 12 * 1024 * 1024;

const DEGRADED_NOTES = {
  config_missing:
    "The Change Record endpoint is not configured for this Jace deployment; no trust record could be fetched.",
  bad_request:
    "The Change Record request was malformed; no trust record could be fetched.",
  unreachable:
    "The Change Record endpoint could not be reached; no trust record could be fetched. Do not retry from here.",
  unauthorized:
    "The console rejected the Change Record request; the workspace connection may be stale or revoked.",
  not_found:
    "No Change Record was found for this PR in the connected workspace.",
  conflict:
    "The conversation or GitHub connection is not fully set up yet; no Change Record could be fetched.",
  rate_limited: "The console rate limit was hit; no Change Record could be fetched right now.",
  upstream_error: "The console errored while loading the Change Record.",
  unexpected_status: "The console returned an unexpected status while loading the Change Record.",
  bad_body: "The console response was not valid Change Record data.",
};

export function resolveConsoleConfig(env = {}) {
  const baseUrl = String(env.JACE_CONSOLE_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const token = String(env.JACE_CONSOLE_TOKEN ?? "").trim();
  const missing = [];
  if (!baseUrl) missing.push("JACE_CONSOLE_BASE_URL");
  if (!token) missing.push("JACE_CONSOLE_TOKEN");
  if (missing.length) return { ok: false, missing };
  return { ok: true, baseUrl, token };
}

export function buildChangeRecordUrl(baseUrl, eveSessionId, repo, prNumber) {
  const params = new URLSearchParams();
  params.set("eveSessionId", eveSessionId);
  params.set("repo", repo);
  params.set("prNumber", String(prNumber));
  return `${baseUrl}${CHANGE_RECORD_PR_PATH}?${params.toString()}`;
}

export function classifyStatus(status) {
  if (status >= 200 && status < 300) return { ok: true };
  if (status === 400) return { ok: false, reason: "bad_request" };
  if (status === 401 || status === 403) return { ok: false, reason: "unauthorized" };
  if (status === 404) return { ok: false, reason: "not_found" };
  if (status === 409) return { ok: false, reason: "conflict" };
  if (status === 429) return { ok: false, reason: "rate_limited" };
  if (status >= 500) return { ok: false, reason: "upstream_error" };
  return { ok: false, reason: "unexpected_status" };
}

export function degraded(reason, extra = {}) {
  return {
    ok: false,
    degraded: true,
    reason,
    note: DEGRADED_NOTES[reason] ?? DEGRADED_NOTES.unexpected_status,
    ...extra,
  };
}

async function readBoundedResponseJson(response, maxBytes) {
  const declared = response.headers?.get?.("content-length") ?? null;
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    try { await response.body?.cancel(); } catch { /* bounded failure */ }
    throw new Error("invalid response");
  }
  if (!response.body) throw new Error("invalid response");
  const reader = response.body.getReader();
  const chunks = [];
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

/** Keep timeout and byte bounds active through the complete response body. */
export function createChangeRecordTransport({
  fetchImpl = fetch,
  timeoutMs = CHANGE_RECORD_TIMEOUT_MS,
  maxResponseBytes = MAX_CHANGE_RECORD_RESPONSE_BYTES,
} = {}) {
  return async (url, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        ...init,
        redirect: "error",
        signal: controller.signal,
      });
      if (response.status < 200 || response.status >= 300) {
        if (response.body) void response.body.cancel().catch(() => { /* sanitized discard */ });
        return { status: response.status, json: async () => null };
      }
      const body = await readBoundedResponseJson(response, maxResponseBytes);
      return { status: response.status, json: async () => body };
    } finally {
      clearTimeout(timer);
    }
  };
}

function projectRecord(value) {
  if (!value || typeof value !== "object") return null;
  const record = value;
  if (typeof record.id !== "string" || typeof record.workspaceId !== "string") return null;
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    repo: typeof record.repo === "string" ? record.repo : "",
    issueNumber: Number.isInteger(record.issueNumber) ? record.issueNumber : null,
    prNumber: Number.isInteger(record.prNumber) ? record.prNumber : null,
    state: typeof record.state === "string" ? record.state : "",
  };
}

function projectEvidence(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object")
    .slice(0, 6)
    .map((item) => ({
      stage: typeof item.stage === "string" ? item.stage : "",
      label: typeof item.label === "string" ? item.label : "",
      url: typeof item.url === "string" ? item.url : null,
    }))
    .filter((item) => item.stage && item.label);
}

function projectAcceptanceContract(value) {
  if (!value || typeof value !== "object" || !Number.isInteger(value.version) || !Array.isArray(value.criteria)) return null;
  const criteria = value.criteria.map((item) => ({
    id: typeof item?.id === "string" ? item.id.trim() : "",
    text: typeof item?.text === "string" ? item.text.trim() : "",
    userVisible: typeof item?.userVisible === "boolean" ? item.userVisible : null,
  })).filter((item) => item.id && item.text && item.userVisible !== null);
  return criteria.length === value.criteria.length && criteria.length > 0
    ? { version: value.version, criteria }
    : null;
}

const CORRECTION_NOT_READY_REASONS = new Set([
  "review_job_unavailable",
  "confirmed_contract_unavailable",
  "no_correction_packets",
  "invalid_packet_custody",
]);
const SHA1 = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const SAFE_REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SECRET_LIKE = /(?:\b(?:bearer|token|authorization)\s+|\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+))/i;
const PACKET_KEYS = [
  "acceptanceContract", "affectedContext", "basis", "criterion", "evidence", "expected",
  "headSha", "impact", "jobId", "kind", "observed", "packetId", "prNumber", "recordId",
  "repo", "requiredCorrection", "reverification", "scopeBoundary", "state", "version", "workspaceId",
];

function exactObject(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function safeText(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max
    && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value) && !SECRET_LIKE.test(value);
}

function safeRepo(value) {
  return typeof value === "string" && SAFE_REPO.test(value)
    && value.split("/").every((segment) => segment !== "." && segment !== "..");
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : null;
  if (Array.isArray(value)) {
    const items = value.map(canonicalJson);
    return items.some((item) => item === null) ? null : `[${items.join(",")}]`;
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const entries = [];
  for (const key of Object.keys(value).sort()) {
    const nested = canonicalJson(value[key]);
    if (nested === null) return null;
    entries.push(`${JSON.stringify(key)}:${nested}`);
  }
  return `{${entries.join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function correctionPacketId(packet) {
  return `correction-${sha256(JSON.stringify({
    jobId: packet.jobId,
    criterionId: packet.criterion.id,
    headSha: packet.headSha,
    recordId: packet.recordId,
    acceptanceContractId: packet.acceptanceContract.id,
    acceptanceContractVersion: packet.acceptanceContract.version,
  })).slice(0, 48)}`;
}

function validStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599;
}

function validApiRequest(value) {
  return exactObject(value, ["method", "path", "expectedStatus"])
    && value.method === "GET" && safeText(value.path, 2_048) && validStatus(value.expectedStatus);
}

function validDataRequest(value) {
  return exactObject(value, [
    "method", "path", "expectedStatus", "digestAlgorithm", "digestKeyId", "digestContext", "expectedJson",
  ]) && value.method === "GET" && safeText(value.path, 2_048) && validStatus(value.expectedStatus)
    && value.digestAlgorithm === "hmac-sha256-v1" && safeText(value.digestKeyId, 64)
    && SHA256.test(value.digestContext) && Array.isArray(value.expectedJson)
    && value.expectedJson.length > 0 && value.expectedJson.length <= 12
    && value.expectedJson.every((assertion) => exactObject(assertion, ["pointer", "equalsType", "equalsHmacSha256"])
      && safeText(assertion.pointer, 1_024)
      && ["null", "boolean", "number", "string"].includes(assertion.equalsType)
      && SHA256.test(assertion.equalsHmacSha256));
}

function validReproduction(value, modality) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.modality !== modality) return false;
  if (modality === "api") return exactObject(value, ["modality", "request"]) && validApiRequest(value.request);
  if (modality === "data") return exactObject(value, ["modality", "request"]) && validDataRequest(value.request);
  if (modality === "job") {
    return exactObject(value, ["modality", "request"])
      && exactObject(value.request, ["trigger", "readback"])
      && exactObject(value.request.trigger, ["method", "path", "expectedStatus"])
      && value.request.trigger.method === "POST" && safeText(value.request.trigger.path, 2_048)
      && validStatus(value.request.trigger.expectedStatus) && validDataRequest(value.request.readback);
  }
  return modality === "ui" && exactObject(value, ["modality", "steps"])
    && Array.isArray(value.steps) && value.steps.length > 0 && value.steps.length <= 12
    && value.steps.every((step) => {
      if (!step || typeof step !== "object" || Array.isArray(step)) return false;
      if (step.action === "open") return exactObject(step, ["action", "path"]) && safeText(step.path, 2_048);
      if (step.action === "click") return exactObject(step, ["action", "selector"]) && safeText(step.selector, 2_048);
      if (step.action === "fill") return exactObject(step, ["action", "selector", "value"])
        && safeText(step.selector, 2_048) && step.value === "[REDACTED_FILL]";
      if (step.action === "press") return exactObject(step, ["action", "key"]) && safeText(step.key, 128);
      if (step.action === "expect_text") return exactObject(step, ["action", "text"]) && safeText(step.text, 2_048);
      return step.action === "screenshot" && exactObject(step, ["action", "label"])
        && safeText(step.label, 512);
    });
}

function validEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (!keys.every((key) => ["evidenceRef", "artifactKey", "executionId", "previewBootId"].includes(key))
    || !Object.hasOwn(value, "evidenceRef") || !Object.hasOwn(value, "previewBootId")
    || !safeText(value.evidenceRef, 2_000) || !safeText(value.previewBootId, 512)) return false;
  return (!Object.hasOwn(value, "artifactKey") || safeText(value.artifactKey, 2_000))
    && (!Object.hasOwn(value, "executionId") || safeText(value.executionId, 512));
}

function validCorrectionPacket(packet) {
  if (!exactObject(packet, PACKET_KEYS) || packet.kind !== "review_job_correction_packet" || packet.version !== 1
    || !safeText(packet.workspaceId, 512) || !safeRepo(packet.repo)
    || !Number.isInteger(packet.prNumber) || packet.prNumber <= 0 || !SHA1.test(packet.headSha)
    || !safeText(packet.recordId, 512) || !safeText(packet.jobId, 512)
    || !exactObject(packet.acceptanceContract, ["id", "version"])
    || !safeText(packet.acceptanceContract.id, 512)
    || !Number.isInteger(packet.acceptanceContract.version) || packet.acceptanceContract.version <= 0
    || !exactObject(packet.criterion, ["id", "snapshot"]) || !safeText(packet.criterion.id, 512)
    || !safeText(packet.criterion.snapshot, 2_000) || packet.basis !== "acceptance_contract"
    || !["failed", "not_proven"].includes(packet.state)
    || packet.expected !== packet.criterion.snapshot || !safeText(packet.expected, 2_000)
    || !safeText(packet.observed, 2_000)
    || !exactObject(packet.affectedContext, ["modality", "environmentKind", "flow", "reproduction"])
    || !["ui", "api", "data", "job"].includes(packet.affectedContext.modality)
    || ![null, "isolated_preview"].includes(packet.affectedContext.environmentKind)
    || !safeText(packet.affectedContext.flow, 2_000)
    || !validReproduction(packet.affectedContext.reproduction, packet.affectedContext.modality)
    || !validEvidence(packet.evidence) || !safeText(packet.scopeBoundary, 2_000)
    || !safeText(packet.impact, 2_000) || !safeText(packet.requiredCorrection, 2_000)
    || !safeText(packet.reverification, 2_000)) return false;
  return packet.packetId === correctionPacketId(packet);
}

function projectCorrectionPackets(value, record) {
  if (!value || typeof value !== "object") return null;
  if (value.kind === "not_found" || value.kind === "not_current") {
    return Object.keys(value).length === 1 ? { kind: value.kind } : null;
  }
  if (value.kind === "not_ready") {
    return Object.keys(value).length === 2 && CORRECTION_NOT_READY_REASONS.has(value.reason)
      ? { kind: "not_ready", reason: value.reason }
      : null;
  }
  if (value.kind !== "current" || !exactObject(value, [
    "kind", "binding", "packetIds", "packetSetSha256", "correctionPacketPayloadSetSha256", "packets",
  ]) || !exactObject(value.binding, [
    "workspaceId", "recordId", "reviewJobId", "repo", "prNumber", "headSha", "headCycleId",
    "authorityGeneration", "acceptanceContract",
  ])
    || !Array.isArray(value.packetIds) || !Array.isArray(value.packets)
    || value.packetIds.length === 0 || value.packetIds.length > 100
    || value.packetIds.length !== value.packets.length
    || !SHA256.test(value.packetSetSha256)
    || !SHA256.test(value.correctionPacketPayloadSetSha256)) return null;

  const binding = value.binding;
  const contract = binding.acceptanceContract;
  if (!exactObject(contract, ["id", "version", "sha256"])
    || !safeText(binding.workspaceId, 512) || binding.workspaceId !== record.workspaceId
    || !safeText(binding.recordId, 512) || binding.recordId !== record.id
    || !safeText(binding.reviewJobId, 512) || binding.headCycleId !== binding.reviewJobId
    || !safeRepo(binding.repo) || binding.repo !== record.repo
    || !Number.isInteger(binding.prNumber) || binding.prNumber !== record.prNumber
    || !SHA1.test(binding.headSha)
    || !Number.isInteger(binding.authorityGeneration) || binding.authorityGeneration < 0
    || !safeText(contract.id, 512) || !Number.isInteger(contract.version) || contract.version < 1
    || !SHA256.test(contract.sha256)) return null;

  const packetIds = value.packetIds.map((packetId) => safeText(packetId, 512) ? packetId : null);
  if (packetIds.some((packetId) => packetId === null)
    || new Set(packetIds).size !== packetIds.length
    || packetIds.some((packetId, index) => packetId !== [...packetIds].sort((a, b) => a.localeCompare(b))[index])) return null;
  for (let index = 0; index < value.packets.length; index += 1) {
    const packet = value.packets[index];
    if (!validCorrectionPacket(packet)
      || packet.packetId !== packetIds[index]
      || packet.workspaceId !== binding.workspaceId || packet.recordId !== binding.recordId
      || packet.jobId !== binding.reviewJobId || packet.repo !== binding.repo
      || packet.prNumber !== binding.prNumber || packet.headSha !== binding.headSha
      || !packet.acceptanceContract || typeof packet.acceptanceContract !== "object"
      || packet.acceptanceContract.id !== contract.id
      || packet.acceptanceContract.version !== contract.version) return null;
  }
  const expectedPacketSetSha256 = sha256(JSON.stringify({
    kind: "acceptance_context_packet_set", version: 1, packetIds,
  }));
  const canonicalPayloadSet = canonicalJson({
    kind: "acceptance_correction_packet_payload_set", version: 1, packets: value.packets,
  });
  if (value.packetSetSha256 !== expectedPacketSetSha256 || canonicalPayloadSet === null
    || value.correctionPacketPayloadSetSha256 !== sha256(canonicalPayloadSet)) return null;

  return {
    kind: "current",
    binding: {
      workspaceId: binding.workspaceId,
      recordId: binding.recordId,
      reviewJobId: binding.reviewJobId,
      repo: binding.repo,
      prNumber: binding.prNumber,
      headSha: binding.headSha,
      headCycleId: binding.headCycleId,
      authorityGeneration: binding.authorityGeneration,
      acceptanceContract: {
        id: contract.id,
        version: contract.version,
        sha256: contract.sha256,
      },
    },
    packetIds,
    packetSetSha256: value.packetSetSha256,
    correctionPacketPayloadSetSha256: value.correctionPacketPayloadSetSha256,
    packets: value.packets,
  };
}

/** Fetch a PR Change Record once, returning a usable no-record result. */
export async function fetchChangeRecord({
  env = {},
  eveSessionId,
  repo,
  prNumber,
  transport,
}) {
  const sessionId = String(eveSessionId ?? "").trim();
  const repoName = String(repo ?? "").trim();
  const number = Number(prNumber);
  if (!sessionId || !repoName || !Number.isInteger(number) || number <= 0) {
    return degraded("bad_request");
  }

  const cfg = resolveConsoleConfig(env);
  if (!cfg.ok) return degraded("config_missing", { missing: cfg.missing });

  let response;
  try {
    response = await transport(buildChangeRecordUrl(cfg.baseUrl, sessionId, repoName, number), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ eveSessionId: sessionId, repo: repoName, prNumber: number }),
    });
  } catch {
    return degraded("unreachable");
  }

  const status = Number(response && response.status);
  const classification = classifyStatus(status);
  if (!classification.ok) return degraded(classification.reason, { status });

  let body;
  try {
    body = await response.json();
  } catch {
    return degraded("bad_body", { status });
  }
  if (!body || typeof body !== "object") return degraded("bad_body", { status });

  if (body.found !== true) {
    return {
      ok: true,
      found: false,
      repo: repoName,
      prNumber: number,
      note: DEGRADED_NOTES.not_found,
    };
  }

  const record = projectRecord(body.record);
  if (!record) return degraded("bad_body", { status });
  const correctionPackets = projectCorrectionPackets(body.correctionPackets, record);
  if (!correctionPackets) return degraded("bad_body", { status });
  return {
    ok: true,
    found: true,
    repo: repoName,
    prNumber: number,
    record,
    stageEvidence: projectEvidence(body.stageEvidence),
    acceptanceContract: projectAcceptanceContract(body.acceptanceContract),
    correctionPackets,
    contentIsUntrusted: true,
  };
}
