export const ACCEPTANCE_INTAKE_PATH = "/api/v1/runner/acceptance-intakes";

export async function recordHostedAcceptanceIntake({ inbound, env = {}, transport }) {
  const baseUrl = String(env.JACE_CONSOLE_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const token = String(env.JACE_CONSOLE_TOKEN ?? "").trim();
  const workspaceId = String(inbound?.auth?.attributes?.workspaceId ?? inbound?.target?.workspaceId ?? "").trim();
  if (!workspaceId) return { ok: true, skipped: "unbound_workspace" };
  if (!baseUrl || !token) return { ok: false, reason: "console_not_configured" };
  if (!inbound?.sourceKey) return { ok: false, reason: "missing_source_key" };
  const conversationKey = String(inbound?.auth?.attributes?.conversationKey ?? inbound?.target?.conversationId ?? inbound?.target?.conversationKey ?? "").trim();
  if (!conversationKey) return { ok: false, reason: "missing_conversation_key" };
  const response = await transport(`${baseUrl}${ACCEPTANCE_INTAKE_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ workspaceId, originChannel: inbound.channel, conversationKey, sourceKey: inbound.sourceKey, text: inbound.message, sourceReferences: [{ kind: "hosted_channel_message", channel: inbound.channel, conversationKey, sourceKey: inbound.sourceKey }], metadata: { target: inbound.target } }),
  });
  if (response.status < 200 || response.status >= 300) return { ok: false, reason: `console_${response.status}` };
  const payload = typeof response.json === "function" ? await response.json().catch(() => null) : null;
  const intakeId = String(payload?.intake?.id ?? "").trim();
  return intakeId ? { ok: true, intakeId } : { ok: false, reason: "console_missing_intake_id" };
}
