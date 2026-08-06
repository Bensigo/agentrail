import { resolveConsoleConfig } from "../subagents/qa/lib/upload_evidence_image.core.mjs";

const CLAIM_PATH = "/api/v1/runner/evidence-verification-executions/claim";
const completePath = (id) => `/api/v1/runner/evidence-verification-executions/${encodeURIComponent(id)}/complete`;
const REQUEST_TIMEOUT_MS = 8_000;

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

async function post(cfg, path, body, transport) {
  const response = await transport(`${cfg.baseUrl}${path}`, { method: "POST", headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (response.status === 204) return null;
  const value = await response.json();
  if (response.status < 200 || response.status >= 300) throw new Error(typeof value?.error === "string" ? value.error : "console request failed");
  return value;
}

export function createVerificationExecutionConsole({ env = process.env, transport = realTransport } = {}) {
  const cfg = resolveConsoleConfig(env);
  if (!cfg.ok) throw new Error(`missing console config: ${cfg.missing.join(", ")}`);
  return {
    async claim(workerId) { const value = await post(cfg, CLAIM_PATH, { workerId }, transport); return value ? { ...value, workerId } : null; },
    async complete(input) { return post(cfg, completePath(input.executionId), { workerId: input.workerId, status: input.status, observedBehavior: input.observedBehavior, artifactIds: input.artifactIds, resultReason: input.resultReason }, transport); },
  };
}
