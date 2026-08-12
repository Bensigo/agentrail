export const ACCEPTANCE_INTAKE_PATH = "/api/v1/runner/acceptance-intakes";

/**
 * Record an attributed hosted-channel message before Jace asks questions or
 * drafts a Contract. An unbound conversation is intentionally skipped; a
 * bound conversation without durable event identity fails closed.
 */
export async function recordHostedAcceptanceIntake({ inbound, env = {}, transport }) {
  const baseUrl = String(env.JACE_CONSOLE_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const token = String(env.JACE_CONSOLE_TOKEN ?? "").trim();
  const workspaceId = String(
    inbound?.auth?.attributes?.workspaceId ?? inbound?.target?.workspaceId ?? ""
  ).trim();
  if (!workspaceId) return { ok: true, skipped: "unbound_workspace" };
  if (!baseUrl || !token) return { ok: false, reason: "console_not_configured" };
  if (!inbound?.sourceKey) return { ok: false, reason: "missing_source_key" };
  const conversationKey = String(
    inbound?.auth?.attributes?.conversationKey ??
      inbound?.target?.conversationId ??
      inbound?.target?.conversationKey ??
      ""
  ).trim();
  if (!conversationKey) return { ok: false, reason: "missing_conversation_key" };

  const response = await transport(`${baseUrl}${ACCEPTANCE_INTAKE_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      workspaceId,
      originChannel: inbound.channel,
      conversationKey,
      sourceKey: inbound.sourceKey,
      text: inbound.message,
      sourceReferences: [
        {
          kind: "hosted_channel_message",
          channel: inbound.channel,
          conversationKey,
          sourceKey: inbound.sourceKey,
        },
      ],
      metadata: { target: inbound.target },
    }),
  });
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, reason: `console_${response.status}` };
  }
  const payload = await response.json().catch(() => null);
  const intakeId = String(payload?.intake?.id ?? "").trim();
  if (!intakeId) return { ok: false, reason: "console_invalid_response" };
  return { ok: true, intakeId };
}
