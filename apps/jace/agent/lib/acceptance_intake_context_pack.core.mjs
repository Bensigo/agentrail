import { resolveBoundAcceptanceIntake } from "./acceptance_intake_draft.core.mjs";
export async function requestAcceptanceContextPackFromBoundIntake({ sessionAuth, env = {}, transport }) {
  const binding = resolveBoundAcceptanceIntake(sessionAuth);
  if (!binding.ok) return { ok: false, degraded: true, reason: binding.reason };
  const baseUrl = String(env.JACE_CONSOLE_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const token = String(env.JACE_CONSOLE_TOKEN ?? "").trim();
  if (!baseUrl || !token) return { ok: false, degraded: true, reason: "console_not_configured" };
  let response;
  try { response = await transport(`${baseUrl}/api/v1/runner/acceptance-intakes/${encodeURIComponent(binding.intakeId)}/context-pack-compilations`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ workspaceId: binding.workspaceId }) }); }
  catch { return { ok: false, degraded: true, reason: "console_unreachable" }; }
  if (response.status < 200 || response.status >= 300) return { ok: false, degraded: true, reason: response.status === 409 ? "contract_not_confirmed" : "compilation_not_admitted", status: response.status };
  const payload = await response.json().catch(() => null);
  const id = String(payload?.compilation?.id ?? "").trim();
  if (!id) return { ok: false, degraded: true, reason: "console_invalid_response" };
  return { ok: true, intakeId: binding.intakeId, compilation: { id, status: payload.compilation.status, phase: payload.compilation.phase }, inserted: payload.inserted === true, note: "Bounded Context Pack compilation was admitted; do not claim a pack exists until its worker reports compiled." };
}
