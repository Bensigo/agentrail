function string(value) {
  return typeof value === "string" ? value.trim() : "";
}

const CONSOLE_TIMEOUT_MS = 10_000;

export async function recordMcpAcceptanceReply({
  session,
  text,
  env = {},
  transport,
}) {
  const attributes = session?.auth?.current?.attributes
    ?? session?.auth?.initiator?.attributes;
  const workspaceId = string(attributes?.workspaceId);
  const intakeId = string(attributes?.acceptanceIntakeId);
  const sessionId = string(session?.id);
  const turnId = string(session?.turn?.id);
  const message = string(text);
  if (!workspaceId) return { ok: false, reason: "missing_workspace_binding" };
  if (!intakeId) return { ok: false, reason: "missing_intake_binding" };
  if (!sessionId || !turnId) return { ok: false, reason: "missing_turn_binding" };
  if (!message) return { ok: false, reason: "missing_reply_text" };
  const baseUrl = string(env.JACE_CONSOLE_BASE_URL).replace(/\/+$/, "");
  const token = string(env.JACE_CONSOLE_TOKEN);
  if (!baseUrl || !token) return { ok: false, reason: "console_not_configured" };

  let response;
  try {
    response = await transport(
      `${baseUrl}/api/v1/runner/acceptance-intakes/${encodeURIComponent(intakeId)}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          workspaceId,
          sourceKey: `jace-mcp-reply:${sessionId}:${turnId}`,
          text: message,
          metadata: { kind: "jace_mcp_reply", channel: "mcp" },
        }),
        signal: AbortSignal.timeout(CONSOLE_TIMEOUT_MS),
      },
    );
  } catch {
    return { ok: false, reason: "console_unreachable" };
  }
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, reason: `console_${response.status}` };
  }
  const payload = await response.json().catch(() => null);
  const messageId = string(payload?.message?.id);
  return messageId
    ? { ok: true, messageId }
    : { ok: false, reason: "console_invalid_response" };
}
