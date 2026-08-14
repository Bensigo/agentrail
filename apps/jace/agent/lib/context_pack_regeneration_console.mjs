const REQUEST_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 2 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LEASE_TOKEN = /^[A-Za-z0-9_-]{43}$/u;
export const CLAIM_PATH = "/api/v1/runner/context-pack-regenerations/claim";
export const EXECUTE_PATH = "/api/v1/runner/context-pack-regenerations/execute";

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

async function readBoundedJson(response) {
  const declared = response.headers?.get?.("content-length") ?? null;
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    throw new Error("Context Pack regeneration response exceeded the byte limit");
  }
  if (!response.body?.getReader) throw new Error("Context Pack regeneration response body is unavailable");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* bounded refusal */ }
        throw new Error("Context Pack regeneration response exceeded the byte limit");
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("Context Pack regeneration response was invalid"); }
}

function exactClaim(body, expectedWorkerId) {
  if (!exactKeys(body, ["claim"])) return null;
  const claim = body.claim;
  if (!exactKeys(claim, ["executionId", "workerId", "leaseToken", "attemptCount", "leaseExpiresAt"])
    || typeof claim.executionId !== "string" || !UUID.test(claim.executionId)
    || claim.workerId !== expectedWorkerId || typeof claim.workerId !== "string"
    || claim.workerId.length < 1 || claim.workerId.length > 128 || claim.workerId !== claim.workerId.trim()
    || /[\u0000-\u001f\u007f]/u.test(claim.workerId)
    || typeof claim.leaseToken !== "string" || !LEASE_TOKEN.test(claim.leaseToken)
    || !Number.isInteger(claim.attemptCount) || claim.attemptCount !== 1
    || typeof claim.leaseExpiresAt !== "string" || claim.leaseExpiresAt.length > 64
    || !Number.isFinite(Date.parse(claim.leaseExpiresAt))) return null;
  return claim;
}

function exactExecutionResult(body) {
  if (!exactKeys(body, ["result"]) || !body.result || typeof body.result !== "object") return null;
  const result = body.result;
  if ((result.kind === "not_current" || result.kind === "not_proven")
    && exactKeys(result, ["kind"])) return result;
  if (result.kind === "completed" && exactKeys(result, ["kind", "status"])
    && ["replaced", "unchanged", "not_current", "not_proven", "held"].includes(result.status)) return result;
  return null;
}

function config(env) {
  const rawBaseUrl = String(env.JACE_CONSOLE_BASE_URL ?? "").trim();
  const token = String(env.JACE_CONTEXT_PACK_REGENERATION_WORKER_TOKEN ?? "").trim();
  let parsed;
  try { parsed = new URL(rawBaseUrl); } catch { throw new Error("Context Pack regeneration console is not configured"); }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username || parsed.password || parsed.search || parsed.hash
    || token.length < 1 || token.length > 4096 || /[\u0000-\u001f\u007f]/u.test(token)) {
    throw new Error("Context Pack regeneration console is not configured");
  }
  return { baseUrl: parsed.href.replace(/\/+$/, ""), token };
}

async function request(path, body, env, transport = fetch) {
  const { baseUrl, token } = config(env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await transport(`${baseUrl}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: controller.signal,
    });
  } finally { clearTimeout(timer); }
}

export async function claimContextPackRegeneration({ workerId, env = process.env, transport = fetch }) {
  const response = await request(CLAIM_PATH, { workerId }, env, transport);
  if (response.status === 204) return null;
  if (!response.ok) throw new Error(`Context Pack regeneration claim failed (${response.status})`);
  const claim = exactClaim(await readBoundedJson(response), workerId);
  if (!claim) throw new Error("Context Pack regeneration claim response was invalid");
  return claim;
}

export async function executeContextPackRegeneration({ claim, env = process.env, transport = fetch }) {
  const response = await request(EXECUTE_PATH, {
    executionId: claim.executionId,
    workerId: claim.workerId,
    leaseToken: claim.leaseToken,
  }, env, transport);
  if (!response.ok) throw new Error(`Context Pack regeneration execution failed (${response.status})`);
  const result = exactExecutionResult(await readBoundedJson(response));
  if (!result) throw new Error("Context Pack regeneration execution response was invalid");
  return result;
}
