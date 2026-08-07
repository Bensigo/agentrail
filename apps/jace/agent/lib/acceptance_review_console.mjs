import { resolveConsoleConfig } from "../subagents/qa/lib/upload_evidence_image.core.mjs";
const claimPath = "/api/v1/runner/acceptance-evidence-review-requests/claim";
const completePath = "/api/v1/runner/evidence-reviews/complete";
async function transport(url, init) { const response = await fetch(url, init); return { status: response.status, json: () => response.json() }; }
export function createAcceptanceReviewConsole({ env = process.env, transport: send = transport } = {}) {
  const cfg = resolveConsoleConfig(env); if (!cfg.ok) throw new Error(`missing console config: ${cfg.missing.join(", ")}`);
  const post = async (path, body) => { const response = await send(`${cfg.baseUrl}${path}`, { method: "POST", headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }); if (response.status === 204) return null; const value = await response.json(); if (response.status < 200 || response.status >= 300) throw new Error(value?.error || "console request failed"); return value; };
  return { claim: async (workerId) => { const item = await post(claimPath, { workerId }); return item ? { ...item, workerId } : null; }, complete: (input) => post(completePath, input) };
}
