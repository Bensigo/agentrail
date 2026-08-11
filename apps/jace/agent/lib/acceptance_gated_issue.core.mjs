// Packet-bound correction issue bridge. Console owns canonical custody and
// reservation; Jace's existing human-approved create_issue tool remains the
// only process allowed to perform the external write.

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  consoleGatedApproval,
  deriveIdempotencyKey,
  INFRA_FAILURE_REASON,
  resolveConsoleConfig,
} from "./console_gated_approval.core.mjs";

export const GATED_ISSUE_REQUESTS_PATH =
  "/api/v1/runner/acceptance-gated-github-issue-requests";
export const GATED_ISSUE_NOT_READY_REASON =
  "the correction issue is not ready under the current Acceptance Record — refresh the record and ask again";
const REQUEST_TIMEOUT_MS = 8000;
const RECEIPT_PREFIX = "AGENTRAIL_GATED_ISSUE_RECEIPT ";
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256_RE = /^[a-f0-9]{64}$/;
const REPO_RE = /^[a-z0-9][a-z0-9._-]{0,99}\/[a-z0-9][a-z0-9._-]{0,99}$/;

function denied(reason = INFRA_FAILURE_REASON) {
  return { type: "denied", reason };
}

export function isExactAcceptanceGatedIssueInput(value) {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 1 && UUID_RE.test(String(value.recordId ?? ""));
}

export function buildAcceptanceGatedIssueArgv({ repo, title, body } = {}) {
  return [
    "issue", "create", "--connector", "github", "--unlabeled",
    "--repo", repo, "--title", title, "--body", body,
  ];
}

function buildUrl(baseUrl, requestId, suffix = "") {
  return `${baseUrl}${GATED_ISSUE_REQUESTS_PATH}/${encodeURIComponent(requestId)}${suffix}`;
}

async function realTransport(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return { status: response.status, json: () => response.json() };
  } finally {
    clearTimeout(timer);
  }
}

async function postJson({ url, token, body, transport }) {
  let response;
  try {
    response = await transport(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, body: null };
  }
  const status = Number(response?.status);
  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    // A malformed body is never a successful custody transition.
  }
  return {
    ok: Number.isFinite(status) && status >= 200 && status < 300,
    status: Number.isFinite(status) ? status : 0,
    body: parsed,
  };
}

async function mintRequest({ baseUrl, token, eveSessionId, recordId, transport }) {
  const response = await postJson({
    url: `${baseUrl}${GATED_ISSUE_REQUESTS_PATH}`,
    token,
    body: { eveSessionId, recordId },
    transport,
  });
  const request = response.body?.request;
  if (!response.ok || response.body?.kind !== "ready" || !request
    || !UUID_RE.test(String(request.id ?? ""))
    || !["draft", "reserved", "published", "manual_reconciliation"].includes(request.status)) {
    return null;
  }
  return { id: request.id, status: request.status };
}

function validRequest(request, requestId, allowedStatuses) {
  if (!request || typeof request !== "object" || request.id !== requestId
    || !allowedStatuses.includes(request.status) || !UUID_RE.test(request.id)
    || !UUID_RE.test(String(request.workspaceId ?? ""))
    || !UUID_RE.test(String(request.recordId ?? ""))
    || !REPO_RE.test(String(request.repoNormalized ?? ""))
    || String(request.repo ?? "").toLowerCase() !== request.repoNormalized
    || !Number.isSafeInteger(request.prNumber) || request.prNumber <= 0
    || !/^[a-f0-9]{40}$/.test(String(request.headSha ?? ""))
    || !UUID_RE.test(String(request.headCycleId ?? ""))
    || !UUID_RE.test(String(request.bindingId ?? ""))
    || !SHA256_RE.test(String(request.requestIdentitySha256 ?? ""))
    || typeof request.title !== "string" || Buffer.byteLength(request.title, "utf8") < 1
    || Buffer.byteLength(request.title, "utf8") > 256
    || typeof request.body !== "string" || Buffer.byteLength(request.body, "utf8") < 1
    || Buffer.byteLength(request.body, "utf8") > 24576
    || createHash("sha256").update(request.title, "utf8").digest("hex") !== request.titleSha256
    || createHash("sha256").update(request.body, "utf8").digest("hex") !== request.bodySha256
    || !Array.isArray(request.packets) || request.packets.length < 1
    || request.packets.length > 100 || !SHA256_RE.test(String(request.packetSetSha256 ?? ""))
    || !SHA256_RE.test(String(request.correctionPacketPayloadSetSha256 ?? ""))) return false;
  return request.packets.every((packet, index) => packet && typeof packet === "object"
    && typeof packet.packetId === "string" && packet.packetId.length > 0
    && SHA256_RE.test(String(packet.sha256 ?? ""))
    && (index === 0 || request.packets[index - 1].packetId < packet.packetId));
}

async function resolveRequest({ baseUrl, token, eveSessionId, requestId, transport }) {
  const response = await postJson({
    url: buildUrl(baseUrl, requestId),
    token,
    body: { eveSessionId },
    transport,
  });
  return response.ok && response.body?.kind === "ready"
    && validRequest(response.body.request, requestId, ["draft", "reserved", "published", "manual_reconciliation"])
    ? response.body.request : null;
}

async function relearnApproval({
  baseUrl, token, eveSessionId, turnId, requestId, transport,
}) {
  const toolInput = { acceptanceGatedIssueRequestId: requestId };
  const idempotencyKey = deriveIdempotencyKey({
    eveSessionId,
    turnId,
    toolName: "create_issue",
    toolInput,
  });
  const response = await postJson({
    url: `${baseUrl}/api/v1/runner/approvals`,
    token,
    body: { eveSessionId, toolName: "create_issue", toolInput, idempotencyKey },
    transport,
  });
  return response.ok && UUID_RE.test(String(response.body?.approvalId ?? ""))
    && response.body?.status === "approved" ? response.body.approvalId : null;
}

async function reserveRequest({
  baseUrl, token, eveSessionId, requestId, approvalId, transport,
}) {
  const response = await postJson({
    url: buildUrl(baseUrl, requestId, "/reserve"),
    token,
    body: { eveSessionId, approvalId },
    transport,
  });
  return response.status === 201 && response.body?.kind === "reserved"
    && validRequest(response.body.request, requestId, ["reserved"])
    ? response.body.request : null;
}

function canonicalIssueUrl(value) {
  try {
    const parsed = new URL(String(value ?? ""));
    if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com"
      || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    const match = parsed.pathname.match(/^\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/issues\/([1-9][0-9]*)$/);
    if (!match) return null;
    return {
      url: `https://github.com/${match[1].toLowerCase()}/${match[2].toLowerCase()}/issues/${match[3]}`,
      repo: `${match[1]}/${match[2]}`.toLowerCase(),
    };
  } catch {
    return null;
  }
}

export function parseAcceptanceGatedIssueReceipt(stdout, request) {
  const line = String(stdout ?? "").split(/\r?\n/)
    .find((value) => value.startsWith(RECEIPT_PREFIX));
  if (!line) return null;
  let receipt;
  try {
    receipt = JSON.parse(line.slice(RECEIPT_PREFIX.length));
  } catch {
    return null;
  }
  const exactKeys = [
    "githubApiUrl", "githubIssueId", "githubIssueNumber", "githubIssueUrl",
    "githubRequestId", "httpStatus", "kind", "responseBodySha256",
    "responseTitleSha256", "state",
  ];
  if (!receipt || typeof receipt !== "object"
    || !isDeepStrictEqual(Object.keys(receipt).sort(), exactKeys)
    || receipt.kind !== "github_201" || receipt.httpStatus !== 201 || receipt.state !== "open"
    || !/^[1-9][0-9]{0,39}$/.test(String(receipt.githubIssueId ?? ""))
    || !Number.isSafeInteger(receipt.githubIssueNumber) || receipt.githubIssueNumber <= 0
    || !/^[A-Za-z0-9:-]{1,128}$/.test(String(receipt.githubRequestId ?? ""))
    || receipt.responseTitleSha256 !== request.titleSha256
    || receipt.responseBodySha256 !== request.bodySha256) return null;
  const canonical = canonicalIssueUrl(receipt.githubIssueUrl);
  return canonical ? { receipt, canonical } : null;
}

async function reconcile({
  baseUrl, token, eveSessionId, requestId, approvalId, reason, observedIssueUrl, transport,
}) {
  const response = await postJson({
    url: buildUrl(baseUrl, requestId, "/reconciliation"),
    token,
    body: {
      eveSessionId,
      approvalId,
      reason,
      ...(observedIssueUrl ? { observedIssueUrl } : {}),
    },
    transport,
  });
  return response.ok && ["recorded", "replayed"].includes(response.body?.kind);
}

function unattestedResult({ requestId, reconciled, reason }) {
  return {
    blocked: true,
    unattested: true,
    requestId,
    state: reconciled ? "manual_reconciliation" : "reserved_unattested",
    reason,
    message: "The external issue result is not attested. Manual reconciliation is required; do not retry this request.",
  };
}

/**
 * @param {{
 *   execFileFn: Function,
 *   env?: Record<string, string | undefined>,
 *   recordId?: string,
 *   eveSessionId?: string,
 *   turnId?: string,
 *   transport?: Function,
 * }} [input]
 */
export async function runAcceptanceGatedIssue({
  execFileFn,
  env = {},
  recordId,
  eveSessionId,
  turnId,
  transport = realTransport,
} = {}) {
  const cfg = resolveConsoleConfig(env);
  const sessionId = String(eveSessionId ?? "").trim();
  if (!cfg.ok || !sessionId || !UUID_RE.test(String(recordId ?? ""))) {
    return { blocked: true, message: INFRA_FAILURE_REASON };
  }
  const minted = await mintRequest({
    baseUrl: cfg.baseUrl, token: cfg.token, eveSessionId: sessionId,
    recordId, transport,
  });
  if (!minted || minted.status !== "draft") {
    return { blocked: true, message: GATED_ISSUE_NOT_READY_REASON };
  }
  const resolved = await resolveRequest({
    baseUrl: cfg.baseUrl, token: cfg.token, eveSessionId: sessionId,
    requestId: minted.id, transport,
  });
  if (!resolved || resolved.status !== "draft") {
    return { blocked: true, message: GATED_ISSUE_NOT_READY_REASON };
  }
  const approvalId = await relearnApproval({
    baseUrl: cfg.baseUrl, token: cfg.token, eveSessionId: sessionId,
    turnId, requestId: minted.id, transport,
  });
  if (!approvalId) return { blocked: true, message: GATED_ISSUE_NOT_READY_REASON };
  const reserved = await reserveRequest({
    baseUrl: cfg.baseUrl, token: cfg.token, eveSessionId: sessionId,
    requestId: minted.id, approvalId, transport,
  });
  if (!reserved || !isDeepStrictEqual(
    { ...resolved, status: "reserved" },
    reserved,
  )) {
    return { blocked: true, message: GATED_ISSUE_NOT_READY_REASON };
  }

  const bin = env.JACE_AGENTRAIL_BIN || "agentrail";
  let result;
  try {
    result = await execFileFn(bin, buildAcceptanceGatedIssueArgv({
      repo: reserved.repoNormalized,
      title: reserved.title,
      body: reserved.body,
    }), { env });
  } catch {
    const reconciled = await reconcile({
      baseUrl: cfg.baseUrl, token: cfg.token, eveSessionId: sessionId,
      requestId: minted.id, approvalId, reason: "external_write_indeterminate", transport,
    });
    return unattestedResult({
      requestId: minted.id, reconciled, reason: "external_write_indeterminate",
    });
  }

  const parsed = parseAcceptanceGatedIssueReceipt(result?.stdout, reserved);
  if (!parsed) {
    const reconciled = await reconcile({
      baseUrl: cfg.baseUrl, token: cfg.token, eveSessionId: sessionId,
      requestId: minted.id, approvalId, reason: "publication_receipt_failed", transport,
    });
    return unattestedResult({
      requestId: minted.id, reconciled, reason: "publication_receipt_failed",
    });
  }
  if (parsed.canonical.repo !== reserved.repoNormalized) {
    const reconciled = await reconcile({
      baseUrl: cfg.baseUrl, token: cfg.token, eveSessionId: sessionId,
      requestId: minted.id, approvalId, reason: "external_issue_wrong_repo",
      observedIssueUrl: parsed.canonical.url, transport,
    });
    return unattestedResult({
      requestId: minted.id, reconciled, reason: "external_issue_wrong_repo",
    });
  }
  const published = await postJson({
    url: buildUrl(cfg.baseUrl, minted.id, "/published"),
    token: cfg.token,
    body: { eveSessionId: sessionId, approvalId, receipt: parsed.receipt },
    transport,
  });
  if (!published.ok || !["published", "replayed"].includes(published.body?.kind)) {
    const reconciled = await reconcile({
      baseUrl: cfg.baseUrl, token: cfg.token, eveSessionId: sessionId,
      requestId: minted.id, approvalId, reason: "publication_receipt_failed",
      observedIssueUrl: parsed.canonical.url, transport,
    });
    return unattestedResult({
      requestId: minted.id, reconciled, reason: "publication_receipt_failed",
    });
  }
  return {
    repo: reserved.repoNormalized,
    number: parsed.receipt.githubIssueNumber,
    url: parsed.canonical.url,
    requestId: minted.id,
    approvalId,
    attested: true,
  };
}

/**
 * @returns {Promise<
 *   { type: "approved"; reason?: string } | { type: "denied"; reason?: string }
 * >}
 */
export async function runCreateIssueApproval({
  ctx,
  env = {},
  transport = realTransport,
  approve = consoleGatedApproval,
} = {}) {
  if (!isExactAcceptanceGatedIssueInput(ctx?.toolInput)) {
    return approve(ctx);
  }
  try {
    const cfg = resolveConsoleConfig(env);
    const eveSessionId = String(ctx?.session?.id ?? "").trim();
    if (!cfg.ok || !eveSessionId) return denied();
    const minted = await mintRequest({
      baseUrl: cfg.baseUrl,
      token: cfg.token,
      eveSessionId,
      recordId: ctx.toolInput.recordId,
      transport,
    });
    if (!minted || minted.status !== "draft") return denied(GATED_ISSUE_NOT_READY_REASON);
    return approve({
      ...ctx,
      toolInput: { acceptanceGatedIssueRequestId: minted.id },
    });
  } catch {
    return denied();
  }
}

/**
 * @returns {Promise<
 *   { type: "approved"; reason?: string } | { type: "denied"; reason?: string }
 * >}
 */
export async function createIssueApproval(ctx) {
  return runCreateIssueApproval({ ctx, env: process.env });
}
